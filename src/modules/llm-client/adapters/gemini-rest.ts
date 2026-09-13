/** Google native Interactions REST. Docs projection; live verification pending. */
import type { AdapterRequestParams, ChatStreamAdapter, StreamCallbacks, StreamResult } from './adapter';
import type { ToolCallAccumulator } from '../tool-accumulator';
import { decodeSSE } from '../transport/sse-decoder.ts';
import { applyProviderContractControls } from '../provider-contracts.ts';
import {
  GEMINI_MAX_CHARS, GEMINI_MAX_STEPS, geminiCounter, geminiInput, geminiText,
  normalizeGeminiUsage, record, validateGeminiGroups,
  type GeminiStep,
} from '../gemini-state.ts';

export function geminiHeaders(apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
}

export function validateGeminiBaseUrl(baseUrl: string): void {
  if (baseUrl.length > 4096) throw new Error('Gemini Base URL is too long.');
  const url = new URL(baseUrl);
  if (url.search || url.hash || /\/(?:interactions|openai)\/?$/.test(url.pathname)
    || /\/models\//.test(url.pathname)) {
    throw new Error('Gemini Base URL must be the versioned API root, e.g. https://generativelanguage.googleapis.com/v1beta.');
  }
  if (url.hostname === 'generativelanguage.googleapis.com'
    && !/^\/v\d+(?:alpha|beta)?\/?$/.test(url.pathname)) {
    throw new Error('Google Gemini Base URL must include the API version without /interactions.');
  }
}

export class GeminiRestAdapter implements ChatStreamAdapter {
  readonly protocol = 'gemini-rest' as const;
  readonly streamEndpoint = '/interactions';
  private readonly baseUrl: string;
  constructor(baseUrl: string) { validateGeminiBaseUrl(baseUrl); this.baseUrl = baseUrl; }

  buildHeaders = geminiHeaders;

  buildRequest(params: AdapterRequestParams): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model, stream: params.stream, store: false,
      input: geminiInput(params.messages, {
        baseUrl: params.baseUrl ?? this.baseUrl, model: params.model,
        allowModelSwitch: params.providerContract?.contract.id === 'google.gemini-interactions',
      }),
    };
    const system = params.messages.filter((message) => message.role === 'system' || message.role === 'developer')
      .map((message) => geminiText(message.content)).join('\n\n');
    if (system) body.system_instruction = system;
    const config: Record<string, unknown> = {};
    if (params.maxTokens !== undefined) config.max_output_tokens = params.maxTokens;
    if (params.stopSequences?.length) config.stop_sequences = params.stopSequences;
    if (Object.keys(config).length) body.generation_config = config;
    if (params.providerContract) applyProviderContractControls(body, params.providerContract, {
      reasoningEnabled: params.reasoningEnabled, reasoningEffort: params.reasoningEffort,
    });
    if (params.tools?.length) body.tools = params.tools.map((tool) => ({
      type: 'function', name: tool.function.name, description: tool.function.description,
      parameters: tool.function.parameters,
    }));
    if (params.responseFormat) body.response_format = structuredClone(params.responseFormat);
    return body;
  }

  async parseStream(body: ReadableStream<Uint8Array>, callbacks: StreamCallbacks,
    timeoutMs: number, toolAcc: ToolCallAccumulator): Promise<StreamResult> {
    const steps = new Map<number, GeminiStep>();
    const argumentParts = new Map<number, string[]>();
    const stopped = new Set<number>();
    const text: string[] = [];
    const reasoningText: string[] = [];
    const incompleteDeltas: Array<Record<string, unknown>> = [];
    let chars = 0;
    let responseId = `local-${crypto.randomUUID()}`;
    let model = '';
    let status = '';
    let terminal = false;
    let usage: Record<string, unknown> | undefined;
    let error: string | undefined;
    let terminalSteps: GeminiStep[] | undefined;
    const emitContent = (content: unknown, reasoning = false) => {
      const value = geminiText(content);
      if (!value) return;
      if (reasoning) { reasoningText.push(value); callbacks.onReasoning?.(value); }
      else { text.push(value); callbacks.onDelta(value); }
    };
    try {
      for await (const item of decodeSSE(body, { idleTimeoutMs: timeoutMs })) {
        if (item.type !== 'event' || !item.event.data) continue;
        chars += item.event.data.length;
        // Reserve space for LC's provenance and incomplete-response envelope.
        if (chars > GEMINI_MAX_CHARS - 8192) throw new Error('Gemini response exceeds its retained-state limit.');
        const event: unknown = JSON.parse(item.event.data);
        if (!record(event)) throw new Error('Malformed Gemini stream event.');
        const type = event.event_type ?? item.event.event;
        const interaction = record(event.interaction) ? event.interaction : undefined;
        if (interaction) {
          // This is metadata, not a required continuation handle: LC uses store:false.
          // Keep the local key for empty/default IDs (or a previously returned ID).
          // Opaque IDs are bounded by the SSE and whole-group budgets, not 1,024 chars.
          if (typeof interaction.id === 'string' && interaction.id.length > 0) {
            responseId = interaction.id;
          }
          if (typeof interaction.model === 'string') {
            if (interaction.model.length > 1024) throw new Error('Invalid Gemini model ID.');
            model = interaction.model;
          }
          if (typeof interaction.status === 'string') status = interaction.status;
          if (record(interaction.usage)) {
            usage ??= {};
            for (const [key, value] of Object.entries(interaction.usage)) {
              if (key.startsWith('total_') && key.endsWith('_tokens')
                && geminiCounter(usage, key) !== undefined && geminiCounter(interaction.usage, key) === undefined) continue;
              usage[key] = value;
            }
          }
        }
        if (typeof event.status === 'string') status = event.status;
        if (type === 'interaction.completed') {
          terminal = true;
          if (Array.isArray(interaction?.steps)) {
            if (interaction.steps.length > GEMINI_MAX_STEPS
              || interaction.steps.some((step) => !record(step) || typeof step.type !== 'string')) {
              throw new Error('Malformed Gemini terminal steps.');
            }
            terminalSteps = interaction.steps as GeminiStep[];
          }
          if (status === 'failed' || status === 'cancelled') throw new Error(`Gemini interaction ${status}.`);
          break;
        }
        if (type === 'error' || type === 'interaction.failed' || type === 'interaction.cancelled') {
          throw new Error(record(event.error) && typeof event.error.message === 'string'
            ? event.error.message : `Gemini interaction ${status || 'failed'}.`);
        }
        if (type !== 'step.start' && type !== 'step.delta' && type !== 'step.stop') continue;
        const index = event.index;
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= GEMINI_MAX_STEPS) {
          throw new Error('Invalid Gemini step index.');
        }
        if (type === 'step.start') {
          if (steps.has(index) || !record(event.step) || typeof event.step.type !== 'string') {
            throw new Error('Duplicate or malformed Gemini step.');
          }
          const step = structuredClone(event.step) as GeminiStep;
          steps.set(index, step);
          if (step.type === 'model_output') emitContent(step.content);
          if (step.type === 'thought') emitContent(step.summary, true);
          if (step.type === 'function_call') callbacks.onToolCall?.();
          continue;
        }
        const step = steps.get(index);
        if (!step || stopped.has(index)) throw new Error('Gemini delta has no open step.');
        if (type === 'step.stop') {
          const args = argumentParts.get(index);
          if (args) step.arguments = JSON.parse(args.join(''));
          stopped.add(index);
          continue;
        }
        const delta = event.delta;
        if (!record(delta)) throw new Error('Malformed Gemini step delta.');
        if (delta.type === 'text' && step.type === 'model_output' && typeof delta.text === 'string') {
          const content = Array.isArray(step.content) ? step.content : [];
          const last = content.at(-1);
          if (record(last) && last.type === 'text' && typeof last.text === 'string') last.text += delta.text;
          else content.push({ type: 'text', text: delta.text });
          step.content = content;
          emitContent(delta.text);
        } else if (delta.type === 'thought_summary' && step.type === 'thought' && record(delta.content)) {
          const summary = Array.isArray(step.summary) ? step.summary : [];
          summary.push(structuredClone(delta.content));
          step.summary = summary;
          emitContent([delta.content], true);
        } else if (delta.type === 'thought_signature' && step.type === 'thought' && typeof delta.signature === 'string') {
          step.signature = delta.signature;
        } else if (delta.type === 'arguments_delta' && step.type === 'function_call' && typeof delta.arguments === 'string') {
          const parts = argumentParts.get(index) ?? [];
          parts.push(delta.arguments);
          argumentParts.set(index, parts);
        } else {
          incompleteDeltas.push(structuredClone(event));
          throw new Error('Unsupported Gemini step delta; continuation is incomplete.');
        }
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Gemini stream failed.';
    }
    const output = terminalSteps ?? [...steps].sort(([a], [b]) => a - b).map(([, step]) => step);
    let complete = terminal && !error && (terminalSteps !== undefined || stopped.size === steps.size)
      && (status === 'completed' || status === 'requires_action');
    if (complete && terminalSteps === undefined
      && [...steps.keys()].sort((a, b) => a - b).some((index, position) => index !== position)) {
      complete = false;
      error = 'Gemini response is missing a step.';
    }
    if (complete && output.some((step) => step.type === 'thought'
      && (typeof step.signature !== 'string' || !step.signature))) {
      complete = false;
      error = 'Gemini thought signature is missing; this response cannot be continued safely.';
    }
    const calls = output.filter((step) => step.type === 'function_call');
    if (complete) {
      const ids = new Set<string>();
      for (const [index, call] of calls.entries()) {
        if (typeof call.id !== 'string' || !call.id || ids.has(call.id)
          || typeof call.name !== 'string' || !call.name || !record(call.arguments)) {
          complete = false;
          error = 'Incomplete or duplicate Gemini function call.';
          break;
        }
        ids.add(call.id);
        toolAcc.ingest({ index, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.arguments) } });
      }
    }
    const content = output.filter((step) => step.type === 'model_output').map((step) => geminiText(step.content)).join('');
    const emitted = text.join('');
    if (content.startsWith(emitted) && content.length > emitted.length) callbacks.onDelta(content.slice(emitted.length));
    if (terminalSteps) {
      const summary = output.filter((step) => step.type === 'thought').map((step) => geminiText(step.summary)).join('');
      const emittedSummary = reasoningText.join('');
      if (summary.startsWith(emittedSummary) && summary.length > emittedSummary.length) callbacks.onReasoning?.(summary.slice(emittedSummary.length));
    }
    if (!complete) {
      for (const [index, parts] of argumentParts) {
        if (!stopped.has(index)) incompleteDeltas.push({ index, delta: { type: 'arguments_delta', arguments: parts.join('') } });
      }
    }
    const groups = validateGeminiGroups([{ schemaVersion: 1, responseId,
      origin: { baseUrl: this.baseUrl, model }, steps: output, complete, ...(usage ? { usage } : {}),
      thoughtStepIndexes: output.flatMap((step, index) => step.type === 'thought' ? [index] : []),
      ...(incompleteDeltas.length ? { incompleteDeltas } : {}),
    }]);
    return {
      content, usage: normalizeGeminiUsage(usage), gemini_interactions: groups,
      finish_reason: complete ? (calls.length ? 'tool_calls' : 'stop') : error ? 'error' : 'disconnected',
      provider_finish_reason: status || undefined,
      error_message: error,
      ...(complete && calls.length ? { tool_calls: [...toolAcc.finalize()] } : {}),
    };
  }
}
