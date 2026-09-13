/** Native Interactions state is conversation data, never display text. */
import type { ChatMessage, ContentPart } from './types';
import type { NormalizedUsage } from './cache-usage';
import { canReplayProviderOutputState } from './provider-state.ts';

export type GeminiStep = Record<string, unknown> & { type: string };
export interface GeminiInteractionGroup {
  schemaVersion: 1;
  /** Local group identity; use the opaque provider ID when present, otherwise a local UUID. */
  responseId: string;
  origin: { baseUrl: string; model: string };
  steps: GeminiStep[];
  /** False means retained for recovery, but unsafe to replay automatically. */
  complete: boolean;
  usage?: Record<string, unknown>;
  /** Response-local usage applies to this entire ordered thought-step group. */
  thoughtStepIndexes?: number[];
  /** Unresolved fragments from an interrupted stream; retained, never replayed. */
  incompleteDeltas?: Array<Record<string, unknown>>;
}

export const GEMINI_MAX_GROUPS = 256;
export const GEMINI_MAX_STEPS = 2048;
export const GEMINI_MAX_CHARS = 16 * 1024 * 1024;

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reject over-limit or malformed state explicitly; never silently truncate signatures. */
export function validateGeminiGroups(value: unknown): GeminiInteractionGroup[] {
  if (!Array.isArray(value) || value.length > GEMINI_MAX_GROUPS) {
    throw new Error('Gemini replay state exceeds its response limit or is malformed.');
  }
  const ids = new Set<string>();
  let chars = 0;
  for (const group of value) {
    if (!record(group) || group.schemaVersion !== 1 || typeof group.responseId !== 'string'
      || !group.responseId || ids.has(group.responseId)
      || !record(group.origin) || typeof group.origin.baseUrl !== 'string'
      || group.origin.baseUrl.length > 4096 || typeof group.origin.model !== 'string'
      || group.origin.model.length > 1024 || typeof group.complete !== 'boolean'
      || !Array.isArray(group.steps) || group.steps.length > GEMINI_MAX_STEPS
      || group.steps.some((step) => !record(step) || typeof step.type !== 'string')
      || (group.thoughtStepIndexes !== undefined && (!Array.isArray(group.thoughtStepIndexes)
        || group.thoughtStepIndexes.length > GEMINI_MAX_STEPS
        || group.thoughtStepIndexes.some((index) => !Number.isInteger(index) || index < 0 || index >= GEMINI_MAX_STEPS)))
      || (group.incompleteDeltas !== undefined && (!Array.isArray(group.incompleteDeltas)
        || group.incompleteDeltas.some((delta) => !record(delta))))
      || (group.usage !== undefined && !record(group.usage))) {
      throw new Error('Invalid Gemini replay state; original conversation must be retained.');
    }
    ids.add(group.responseId);
    chars += JSON.stringify(group).length;
    if (chars > GEMINI_MAX_CHARS) throw new Error('Gemini replay state exceeds its size limit.');
  }
  return value as GeminiInteractionGroup[];
}

export function geminiCounter(usage: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = usage?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function normalizeGeminiUsage(usage: Record<string, unknown> | undefined): NormalizedUsage | undefined {
  const input = geminiCounter(usage, 'total_input_tokens');
  const output = geminiCounter(usage, 'total_output_tokens');
  const thought = geminiCounter(usage, 'total_thought_tokens');
  const total = geminiCounter(usage, 'total_tokens');
  const cached = geminiCounter(usage, 'total_cached_tokens');
  if ([input, output, thought, total, cached].every((value) => value === undefined)) return undefined;
  return {
    // Missing components are a lower bound in LC's numeric ledger; retain raw
    // counters on the response group and explicitly mark partial coverage.
    prompt_tokens: input ?? 0,
    completion_tokens: (output ?? 0) + (thought ?? 0),
    total_tokens: total ?? ((input ?? 0) + (output ?? 0) + (thought ?? 0)),
    source: 'provider',
    tokenCoverage: {
      input: input === undefined ? 'unreported' : 'reported',
      output: output === undefined && thought === undefined ? 'unreported'
        : output === undefined || thought === undefined ? 'partial' : 'reported',
      total: total !== undefined ? 'reported'
        : input === undefined && output === undefined && thought === undefined ? 'unreported' : 'partial',
    },
    terminalCoverage: input === undefined || output === undefined || thought === undefined || total === undefined
      ? 'partial' : 'complete',
    reasoning: thought === undefined ? { status: 'not-reported' }
      : { status: 'reported', tokens: thought, measurement: 'provider-counter' },
    cache: cached === undefined ? { status: 'not-reported' }
      : { status: 'reported', readTokens: cached, reportedBy: 'provider' },
  };
}

export function geminiText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => record(part) && part.type === 'text' && typeof part.text === 'string'
    ? [part.text] : []).join('');
}

export function geminiContent(content: string | ContentPart[]): Record<string, unknown>[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    const url = part.image_url.url;
    const data = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
    return data ? { type: 'image', mime_type: data[1], data: data[2] }
      : { type: 'image', uri: url };
  });
}

export function selectGeminiGroups(message: ChatMessage, target: {
  baseUrl?: string; model: string; allowModelSwitch?: boolean;
}): GeminiInteractionGroup[] {
  // In-memory groups were validated at the storage/adapter boundary. Do not
  // serialize all retained signatures again on every TokenMeter render.
  return (message.gemini_interactions ?? []).filter((group) => canReplayProviderOutputState({
    origin: group.origin, targetBaseUrl: target.baseUrl, targetModel: target.model,
    allowModelSwitch: target.allowModelSwitch,
  }));
}

/** Re-expand merged LC bubbles into whole model responses followed by their results. */
export function geminiInput(messages: ChatMessage[], target: {
  baseUrl?: string; model: string; allowModelSwitch?: boolean;
}): GeminiStep[] {
  const input: GeminiStep[] = [];
  const consumed = new Set<ChatMessage>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.gemini_interactions) validateGeminiGroups(message.gemini_interactions);
    if (consumed.has(message) || message.role === 'system' || message.role === 'developer') continue;
    if (message.role === 'tool') throw new Error('Gemini history contains an unpaired function result.');
    const groups = message.role === 'assistant' ? selectGeminiGroups(message, target) : [];
    const nextUser = messages.findIndex((entry, i) => i > index
      && (entry.role === 'assistant' || (entry.role === 'user' && entry.name !== 'lc-tool-images')));
    const end = nextUser < 0 ? messages.length : nextUser;
    const results = messages.slice(index + 1, end).filter((entry) => entry.role === 'tool');
    const appendResults = (calls: GeminiStep[]) => {
      let lastResultIndex = index;
      for (const call of calls) {
        if (typeof call.id !== 'string' || !call.id) throw new Error('Gemini function call is missing its ID.');
        const matching = results.filter((entry) => entry.tool_call_id === call.id && !consumed.has(entry));
        if (matching.length !== 1) throw new Error('Gemini continuation requires exactly one result per function call.');
        const result = matching[0];
        input.push({ type: 'function_result', call_id: call.id, name: call.name,
          result: typeof result.content === 'string' ? result.content : geminiContent(result.content),
          ...(result.tool_is_error ? { is_error: true } : {}),
        });
        consumed.add(result);
        lastResultIndex = Math.max(lastResultIndex, messages.indexOf(result));
      }
      // Synthetic tool images belong after their sibling result batch and
      // before the next native response, even inside one merged LC bubble.
      for (let imageIndex = lastResultIndex + 1; calls.length && imageIndex < end; imageIndex++) {
        const image = messages[imageIndex];
        if (image.role !== 'user' || image.name !== 'lc-tool-images') break;
        input.push({ type: 'user_input', content: geminiContent(image.content) });
        consumed.add(image);
      }
    };
    if (groups.length) {
      for (const group of groups) {
        if (!group.complete) throw new Error('Gemini response is incomplete; retry or edit the interrupted turn before continuing.');
        if (group.steps.some((step) => step.type === 'thought'
          && (typeof step.signature !== 'string' || !step.signature))) {
          throw new Error('Gemini thought signature is missing; retry or edit the affected turn before continuing.');
        }
        input.push(...group.steps);
        appendResults(group.steps.filter((step) => step.type === 'function_call'));
      }
    } else {
      if (geminiText(message.content)) input.push({
        type: message.role === 'assistant' ? 'model_output' : 'user_input',
        content: geminiContent(message.content),
      });
      else if (Array.isArray(message.content) && message.content.length) input.push({ type: 'user_input', content: geminiContent(message.content) });
      if (message.role === 'assistant' && message.tool_calls?.length) {
        const calls = message.tool_calls.map((call) => ({ type: 'function_call', id: call.id,
          name: call.function.name, arguments: JSON.parse(call.function.arguments) }));
        input.push(...calls);
        appendResults(calls);
      }
    }
  }
  return input;
}
