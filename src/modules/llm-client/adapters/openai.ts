/**
 * OpenAI-compatible adapter. Handles SSE parsing, request building
 * with provider-specific reasoning quirks (DeepSeek, MiniMax), and
 * tool-call delta accumulation.
 */

import type { ChatStreamAdapter, AdapterRequestParams, StreamCallbacks, StreamResult } from './adapter';
import { applyProviderContractControls } from '../provider-contracts.ts';
import { canReplayProviderOutputState } from '../provider-state.ts';
import type {
  ChatRequest, ChatMessage, StreamChunk, StreamDelta, ToolCallDeltaWire,
} from '../types';
import type { ToolCallAccumulator } from '../tool-accumulator';
import { decodeSSE } from '../transport/sse-decoder.ts';
import { debugLog } from '../../../utils/debug.ts';
import {
  normalizeChatCompletionsUsage,
  usageReporterForBaseUrl,
  type NormalizedUsage,
} from '../cache-usage.ts';

/** Official OpenAI/Azure endpoints use the current Chat Completions fields. */
export function isOfficialOpenAIEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'api.openai.com' || hostname.endsWith('.openai.azure.com');
  } catch {
    return false;
  }
}

/**
 * OpenRouter (`openrouter.ai`). A routing surface, not a single upstream: it
 * publishes Chat Completions, Responses, and Anthropic Messages endpoints, so
 * it is a compatible server on three of LC's four adapters.
 *
 * Used here only to spell the repetition control the way OpenRouter documents
 * it. Hostname-classified rather than substring-matched, like every other
 * predicate that changes what goes on the wire.
 * https://openrouter.ai/docs/api-reference/parameters
 */
export function isOpenRouterEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

/** Meta Model API (https://api.meta.ai).
 *
 * Legacy direct-call predicate only. Production behavior is selected by the
 * resolved `meta.chat` / `meta.responses` / `meta.messages` contract IDs, so
 * this stays exactly the first-party origin: lookalike hosts such as
 * `foo.meta.ai` remain unmatched and receive generic behavior.
 *  https://dev.meta.ai/docs/reasoning */
export function isMetaAIEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.meta.ai';
  } catch {
    return false;
  }
}

/** Z.AI's first-party OpenAI-compatible Chat Completions endpoint. */
export function isZAIEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.z.ai';
  } catch {
    return false;
  }
}

/** Alibaba Model Studio's official DashScope and workspace MaaS hosts. */
export function isAlibabaModelStudioEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname === 'dashscope.aliyuncs.com'
      || hostname === 'dashscope-intl.aliyuncs.com'
      || hostname === 'dashscope-us.aliyuncs.com'
      || hostname === 'cn-hongkong.dashscope.aliyuncs.com') {
      return true;
    }
    if (!hostname.endsWith('.maas.aliyuncs.com')) return false;
    // Workspace domains are `{workspace}.{region}.maas.aliyuncs.com`.
    const prefix = hostname.slice(0, -'.maas.aliyuncs.com'.length);
    return prefix.split('.').length >= 2 && prefix.split('.').every(Boolean);
  } catch {
    return false;
  }
}

/** Model Studio model families that publish the Chat `enable_thinking` toggle. */
function isAlibabaThinkingToggleModel(model: string): boolean {
  const name = model.toLowerCase();
  const qwen = /(?:^|\/)qwen3(?:[./-]|$)/.test(name);
  const kimi = /(?:^|\/)kimi-k2\.(?:5|6|7)(?:-|$)/.test(name);
  const glm = /(?:^|\/)glm-/.test(name);
  const deepSeekHybrid = /(?:^|\/)deepseek-v(?:3\.(?:1|2)(?:-exp)?|4-(?:pro|flash))(?:-|$)/.test(name);
  return qwen || kimi || glm || deepSeekHybrid;
}

/** Model Studio limits Chat `reasoning_effort` to GLM and DeepSeek V4. */
function isAlibabaEffortModel(model: string): boolean {
  const name = model.toLowerCase();
  return /(?:^|\/)glm-/.test(name)
    || /(?:^|\/)deepseek-v4-(?:pro|flash)(?:-|$)/.test(name);
}

/** Model Studio's documented effort enum is only `high | max`. */
function alibabaReasoningEffort(effort: string): 'high' | 'max' {
  return effort === 'xhigh' || effort === 'max' ? 'max' : 'high';
}

/** Z.AI currently documents Chat `reasoning_effort` for this model only. */
function isZAIReasoningEffortModel(model: string): boolean {
  return model.toLowerCase() === 'glm-5.2';
}

/**
 * Google's OpenAI-compatibility endpoint for the Gemini API
 * (`https://generativelanguage.googleapis.com/v1beta/openai/`).
 *
 * Like official OpenAI and Meta, it takes the FLAT `reasoning_effort` string
 * rather than the nested `reasoning` object. That is what the page documents,
 * and it is the whole reason for this branch.
 *
 * **What this layer does with a parameter it does not recognize is NOT
 * documented for chat completions.** An earlier version of this comment said
 * unsupported parameters are "silently ignored by the compatibility layer" and
 * built an argument on it. That sentence is real but it lives in the page's
 * *Generate an image* section and its subject is that feature's parameter list
 * (`prompt`, `model`, `n`, `size`, `response_format`) — it says nothing about
 * `/chat/completions`. Do not reason from it here; if the silent-drop behavior
 * matters to a future change, establish it against a live endpoint first.
 *
 * The host is matched together with an `/openai` path segment: the same host
 * also serves the native `generateContent` API, which is not OpenAI-compatible
 * and is never reached through this adapter.
 *
 * NOT VERIFIED AGAINST A LIVE ENDPOINT. This mapping was written from the
 * documentation without a Google API key, unlike the DeepSeek, MiniMax, and
 * Meta branches around it. Treat it as unproven until someone runs it.
 * https://ai.google.dev/gemini-api/docs/openai
 */
export function isGeminiCompatEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    if (url.hostname.toLowerCase() !== 'generativelanguage.googleapis.com') return false;
    return url.pathname.toLowerCase().split('/').includes('openai');
  } catch {
    return false;
  }
}

/**
 * LC's effort ladder folded onto Gemini's, which runs
 * `minimal | low | medium | high` (plus `none`, documented for 2.5 models).
 *
 * LC's two highest rungs have nowhere to land, so they collapse to `high`
 * instead of going out verbatim as the Meta branch does. The reason is simply
 * that `xhigh` and `max` are not in Gemini's documented enum, while `high` is:
 * folding sends a value the page defines, and every rung LC offers therefore
 * reaches the model as something it accepts.
 *
 * This deliberately does NOT rest on a claim about what Gemini does with an
 * out-of-enum value — see `isGeminiCompatEndpoint` for why that claim was
 * withdrawn. Folding is right because `high` is documented, not because the
 * alternative was proven to fail silently.
 * https://ai.google.dev/gemini-api/docs/openai#thinking
 */
function geminiReasoningEffort(effort: string): 'low' | 'medium' | 'high' {
  return effort === 'xhigh' || effort === 'max'
    ? 'high'
    : (effort as 'low' | 'medium' | 'high');
}

export class OpenAIAdapter implements ChatStreamAdapter {
  readonly protocol = 'openai' as const;
  readonly streamEndpoint = '/chat/completions';

  /**
   * Retained only to label cache counters as router-reported when the server
   * is OpenRouter. It is never used to infer an upstream provider (cache-observability.md §3).
   */
  private readonly baseUrl?: string;
  private activeProviderContract?: AdapterRequestParams['providerContract'];
  private activeProviderContractStatus?: AdapterRequestParams['providerContractStatus'];

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl;
  }

  buildRequest(params: AdapterRequestParams): ChatRequest {
    this.activeProviderContract = params.providerContract;
    this.activeProviderContractStatus = params.providerContractStatus;
    const unmatchedProvider = params.providerContractStatus === 'unmatched';
    const supportsReasoningDetails = params.providerContract?.contract.carriers.some(
      (carrier) => carrier.response_paths.some((path) => path.includes('reasoning_details')),
    ) ?? false;
    // Strip client-only/provider-specific fields from every message. In
    // particular, Responses output items must never leak into Chat JSON.
    const messages = params.messages.map((m) => {
      const cleanContent = m.role === 'assistant' && m.refusal && !m.content
        ? m.refusal
        : m.content;
      const clean: ChatMessage = { role: m.role, content: cleanContent };
      if (m.role === 'tool' && m.tool_call_id !== undefined) {
        clean.tool_call_id = m.tool_call_id;
      }
      if (m.role === 'assistant' && m.tool_calls !== undefined) {
        clean.tool_calls = m.tool_calls;
      }
      // DeepSeek Chat requires all prior assistant reasoning when the next
      // request carries tools. The shared projection owns that selection;
      // official OpenAI ignores this compatibility field.
      if (m.role === 'assistant' && m.reasoning_content !== undefined
        && (!unmatchedProvider || canReplayProviderOutputState({
          origin: m.provider_output_origin,
          targetBaseUrl: params.baseUrl,
          targetModel: params.model,
        }))) {
        clean.reasoning_content = m.reasoning_content;
      }
      if (m.role === 'assistant' && m.reasoning_details?.length
        && (supportsReasoningDetails
          || (params.providerContractStatus === undefined
            && params.baseUrl?.toLowerCase().includes('minimax')))) {
        clean.reasoning_details = m.reasoning_details.map((detail) => ({ ...detail }));
      }
      return clean;
    });

    const req: ChatRequest = {
      model: params.model,
      messages,
      stream: params.stream,
    };
    if (params.maxTokens !== undefined) {
      if (!unmatchedProvider && isOfficialOpenAIEndpoint(params.baseUrl)) {
        req.max_completion_tokens = params.maxTokens;
      } else {
        // Preserve the broad OpenAI-compatible provider surface. Many local
        // servers still reject max_completion_tokens even though OpenAI has
        // deprecated max_tokens for newer reasoning models.
        req.max_tokens = params.maxTokens;
      }
    }
    if (params.temperature !== undefined) req.temperature = params.temperature;
    if (params.topP !== undefined) req.top_p = params.topP;
    // `top_k` and `repeat_penalty` are compatible-server extensions, not
    // Chat Completions fields: llama.cpp, LM Studio, vLLM, and the local
    // servers built on them accept both, and neither OpenAI's nor Azure's
    // request schema defines either one. LC therefore does not send them to
    // those two hosts as though they were supported parameters. What such a
    // host does with an undefined field — reject it, or ignore it — has not
    // been verified against a live endpoint here; the schema is the reason,
    // and it is reason enough. The same predicate already decides
    // `max_completion_tokens` vs `max_tokens` directly above.
    if (!unmatchedProvider && !isOfficialOpenAIEndpoint(params.baseUrl)) {
      // `top_k` is spelled the same everywhere that defines it, OpenRouter
      // included. The repetition control is not: OpenRouter documents
      // `repetition_penalty` and its schema has no `repeat_penalty`, while
      // llama.cpp, LM Studio, and vLLM document `repeat_penalty`. Sending the
      // local spelling to OpenRouter put an undefined field on the wire and
      // expressed the user's selection nowhere.
      // https://openrouter.ai/docs/api-reference/parameters
      if (params.topK !== undefined) req.top_k = params.topK;
      if (params.repeatPenalty !== undefined) {
        if (isOpenRouterEndpoint(params.baseUrl)) {
          req.repetition_penalty = params.repeatPenalty;
        } else {
          req.repeat_penalty = params.repeatPenalty;
        }
      }
    }
    if (params.stopSequences) req.stop = params.stopSequences;
    if (params.tools) req.tools = params.tools;
    if (params.streamOptions) req.stream_options = params.streamOptions;

    // Verified origins take their reasoning wire shape from the embedded
    // contract. Model IDs never trigger provider behavior, and effort values
    // pass through unchanged for the server to validate or map.
    if (params.providerContract) {
      applyProviderContractControls(
        req as unknown as Record<string, unknown>,
        params.providerContract,
        {
          reasoningEnabled: params.reasoningEnabled,
          reasoningEffort: params.reasoningEffort,
        },
      );
      return req;
    }
    if (params.providerContractStatus === 'unmatched') {
      // There is no reasoning-control field in the base Chat Completions
      // contract. An unlisted relay gets only the protocol request; sending a
      // guessed nested/flat/toggle shape can turn a valid chat into a 400.
      return req;
    }

    // Reasoning mapping — provider-specific logic
    const isDeepSeek = params.baseUrl?.toLowerCase().includes('deepseek');
    const isMiniMax = params.baseUrl?.toLowerCase().includes('minimax');
    const isZAI = isZAIEndpoint(params.baseUrl);
    const isAlibaba = isAlibabaModelStudioEndpoint(params.baseUrl);
    const modelLower = params.model.toLowerCase();
    const isAlibabaMiniMax = isAlibaba && modelLower.includes('minimax');
    const isAlibabaThinkingModel = isAlibaba && isAlibabaThinkingToggleModel(modelLower);
    const isAlibabaEffortCapable = isAlibaba && isAlibabaEffortModel(modelLower);

    if (params.reasoningEnabled && params.reasoningEffort && params.reasoningEffort !== 'none') {
      if (isDeepSeek) {
        req.thinking = { type: 'enabled' };
        // Passed through verbatim. DeepSeek publishes its own effort mapping —
        // low→low, medium→high, high→high, xhigh→high, max→max — so every rung
        // of LC's ladder is an accepted request value and the provider decides
        // where it lands. LC used to rewrite `xhigh` to `max`, which promoted
        // the selection two rungs above what DeepSeek documents and made
        // `xhigh` and `max` indistinguishable — the exact collapse the
        // Anthropic adapter's own budget ladder was fixed to avoid.
        // https://api-docs.deepseek.com/guides/thinking_mode
        req.reasoning_effort = params.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      } else if (isMiniMax) {
        req.thinking = { type: 'adaptive' };
        (req as ChatRequest & { reasoning_split?: boolean }).reasoning_split = true;
      } else if (isOfficialOpenAIEndpoint(params.baseUrl)) {
        req.reasoning_effort = params.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      } else if (isMetaAIEndpoint(params.baseUrl)) {
        // Meta Model API's Chat Completions is strictly OpenAI-compatible:
        // it takes the FLAT `reasoning_effort` string, not the nested
        // `reasoning` object (Responses-API syntax). The nested form returns
        // 400 — "`reasoning`: unknown parameter `reasoning`". The effort
        // level passes through verbatim: LC does not fold `max` down to
        // `xhigh` because Meta's ladder may grow, and an unsupported level is
        // the provider's own 400 to surface, not LC's to guess around.
        // https://dev.meta.ai/docs/protocols/chat-completions#parameters
        // https://dev.meta.ai/docs/reasoning
        req.reasoning_effort = params.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      } else if (isGeminiCompatEndpoint(params.baseUrl)) {
        // Flat field, ladder folded at `high` — Google documents the flat
        // field, and `high` is inside its enum while `xhigh` and `max` are
        // not. Both are explained on `isGeminiCompatEndpoint`, including why
        // no argument here rests on what the layer does with a parameter it
        // does not recognize.
        // https://ai.google.dev/gemini-api/docs/openai#thinking
        req.reasoning_effort = geminiReasoningEffort(params.reasoningEffort);
      } else if (isZAI) {
        // Z.AI Chat Completions uses a top-level thinking toggle plus the
        // flat reasoning_effort field on GLM-5.2. Other documented Z.AI
        // models receive the thinking toggle but not a field the provider
        // says they do not support. The nested Responses-style object is not
        // its published Chat request shape.
        // https://docs.z.ai/api-reference/llm/chat-completion
        req.thinking = { type: 'enabled' };
        if (isZAIReasoningEffortModel(params.model)) {
          req.reasoning_effort = params.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
        }
      } else if (isAlibabaMiniMax) {
        req.thinking = { type: 'adaptive' };
      } else if (isAlibabaThinkingModel) {
        // Model Studio's Chat Completions API controls its documented Qwen,
        // Kimi, GLM, and hybrid DeepSeek families with a top-level boolean.
        // Only GLM and DeepSeek V4 accept `reasoning_effort`, whose published
        // enum is `high | max`; LC folds low/medium/high to high and
        // xhigh/max to max rather than sending an out-of-enum value.
        req.enable_thinking = true;
        if (isAlibabaEffortCapable) {
          req.reasoning_effort = alibabaReasoningEffort(params.reasoningEffort);
        }
      } else if (isAlibaba) {
        // Do not fall through to generic Responses-style reasoning on a
        // first-party Model Studio Chat host. The current Chat page publishes
        // no reasoning control for this model family.
      } else {
        // Known deviation: this generic nested shape and max→xhigh rewrite are
        // not valid for every Chat-compatible provider. Moonshot Kimi K3, for
        // example, documents flat reasoning_effort and owns validation. Select
        // an explicit provider/profile dialect; do not add another model regex.
        req.reasoning = { effort: params.reasoningEffort === 'max' ? 'xhigh' : (params.reasoningEffort as 'none' | 'low' | 'medium' | 'high' | 'xhigh') };
      }
    } else if (params.reasoningEnabled && params.reasoningEffort === 'none') {
      if (isDeepSeek) {
        req.thinking = { type: 'disabled' };
      } else if (isMiniMax) {
        req.thinking = { type: 'disabled' };
      } else if (isMetaAIEndpoint(params.baseUrl)) {
        // Muse Spark always reasons — `reasoning_effort: "none"` returns
        // HTTP 400. Omit the field and let the model reason at its default
        // level rather than hard-failing the request.
        // https://dev.meta.ai/docs/reasoning
      } else if (isZAI || isAlibabaMiniMax) {
        req.thinking = { type: 'disabled' };
      } else if (isAlibabaThinkingModel) {
        req.enable_thinking = false;
      } else if (isAlibaba) {
        // No documented Chat thinking toggle for this Model Studio model.
      } else {
        // The flat field is correct for effort-based Chat dialects. Toggle-only
        // dialects such as Moonshot K2.6 require explicit capability/profile
        // selection instead of model-name guessing.
        // Gemini's compatibility endpoint deliberately has no branch here:
        // this default is already the flat field it documents for `none`, on
        // 2.5 models. Newer Gemini models reportedly cannot disable thinking,
        // and if one rejects the value that is the provider's own error to
        // surface — LC does not infer a model family from its name to guess
        // around it. https://ai.google.dev/gemini-api/docs/openai#thinking
        req.reasoning_effort = 'none';
      }
    }

    return req;
  }

  buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  async parseStream(
    body: ReadableStream<Uint8Array>,
    callbacks: StreamCallbacks,
    timeoutMs: number,
    toolAcc: ToolCallAccumulator,
  ): Promise<StreamResult> {
    // Accumulate content chunks in an array and join at the end
    // to avoid O(n²) string concatenation on large responses.
    const fullChunks: string[] = [];
    // Held raw until the stream ends: streaming Chat Completions delivers
    // terminal usage in the final chunk, and normalizing once keeps explicit
    // zeroes and malformed values from being reinterpreted per event.
    let rawUsage: unknown;
    let finishReason: string | undefined;
    let errorMessage: string | undefined;
    let refusal: string | undefined;
    let timedOut = false;
    const isMiniMax = this.activeProviderContract?.contract.id === 'minimax.chat'
      || (this.activeProviderContract === undefined
        && this.activeProviderContractStatus !== 'unmatched'
        && (this.baseUrl?.toLowerCase().includes('minimax') ?? false));
    const preservesReasoningDetails = this.activeProviderContract?.contract.carriers.some(
      (carrier) => carrier.response_paths.some((path) => path.includes('reasoning_details')),
    ) ?? isMiniMax;
    let miniMaxContent = '';
    let miniMaxReasoning = '';
    let reasoningDetails: Array<Record<string, unknown>> | undefined;

    // Diagnostics: track stream lifecycle (dev-only — stripped in prod)
    let eventCount = 0;
    let payloadChars = 0;
    let contentChars = 0;
    let reasoningChars = 0;
    let streamStart = 0;
    if (import.meta.env?.DEV) streamStart = performance.now();

    try {
      for await (const item of decodeSSE(body, { idleTimeoutMs: timeoutMs })) {
        if (item.type === 'issue') continue;
        const payload = item.event.data?.trim();
        if (!payload || payload === '[DONE]') continue;
        eventCount++;
        payloadChars += payload.length;
        const result = processEvent(payload, toolAcc);
        let content = result.content;
        let reasoning = result.reasoning;
        if (isMiniMax) {
          ({ delta: content, aggregate: miniMaxContent } = cumulativeDelta(miniMaxContent, content));
          if (result.reasoning_details) {
            reasoningDetails = result.reasoning_details.map((detail) => ({ ...detail }));
            const fullReasoning = reasoningDetails.map((detail) => (
              typeof detail.text === 'string' ? detail.text : ''
            )).join('');
            ({ delta: reasoning, aggregate: miniMaxReasoning } = cumulativeDelta(miniMaxReasoning, fullReasoning));
          }
        } else if (preservesReasoningDetails && result.reasoning_details) {
          reasoningDetails = [
            ...(reasoningDetails ?? []),
            ...result.reasoning_details.map((detail) => ({ ...detail })),
          ];
        }
        if (content) {
          fullChunks.push(content);
          if (import.meta.env?.DEV) contentChars += content.length;
          callbacks.onDelta(content);
        }
        if (reasoning && callbacks.onReasoning) {
          if (import.meta.env?.DEV) reasoningChars += reasoning.length;
          callbacks.onReasoning(reasoning);
        }
        if (result.tool_call) callbacks.onToolCall?.();
        if (result.refusal) {
          refusal = (refusal ?? '') + result.refusal;
          callbacks.onRefusal?.(result.refusal);
        }
        if (result.usage !== undefined) {
          // A compatible server may restate usage after an earlier valid
          // report. An empty/null/malformed restatement must not erase the
          // usable provider envelope already retained; explicit zeroes still
          // normalize successfully and remain authoritative.
          if (normalizeChatCompletionsUsage(
            result.usage,
            usageReporterForBaseUrl(this.baseUrl),
          ) !== undefined) rawUsage = result.usage;
        }
        if (result.finish_reason) finishReason = result.finish_reason;
        if (result.error_message && !errorMessage) errorMessage = result.error_message;
      }
    } catch (e) {
      debugLog.warn('[LC] SSE read aborted:', (e as Error).message || e);
      timedOut = true;
    }
    const toolCalls = toolAcc.finalize();
    // An over-cap argument stream is a malformed provider turn, not a
    // callable tool batch. Terminal policy is terminate, don't continue:
    // drop EVERY call from this provider turn (a partial batch must not
    // execute without the capped sibling), surface the issue, and force the
    // finish reason to error even when the provider's own terminal event
    // said `tool_calls`.
    if (toolAcc.issues.length > 0) {
      const issueMessage = toolAcc.issues
        .map((issue) => `tool_call[${issue.index}]: ${issue.message}`)
        .join('; ');
      errorMessage = errorMessage ?? issueMessage;
      finishReason = 'error';
    }

    if (timedOut && !finishReason) finishReason = 'disconnected';
    if (import.meta.env?.DEV) {
      const elapsed = ((performance.now() - streamStart) / 1000).toFixed(1);
      debugLog.log(
        `[LC] SSE stream ended: ${eventCount} events, ${payloadChars} payload chars, ` +
        `${contentChars}c / ${reasoningChars}r chars, ` +
        `finish_reason=${finishReason ?? 'none'}, ` +
        `${elapsed}s elapsed`,
      );
    }

    const usage: NormalizedUsage | undefined = normalizeChatCompletionsUsage(
      rawUsage,
      usageReporterForBaseUrl(this.baseUrl),
    );

    return {
      content: fullChunks.join(''),
      usage,
      finish_reason: finishReason,
      error_message: errorMessage,
      refusal,
      reasoning_details: reasoningDetails,
      // A capped turn executes nothing: even a valid sibling is suppressed so
      // the provider batch never runs partially.
      tool_calls: toolAcc.issues.length > 0 ? undefined : (toolCalls.length > 0 ? [...toolCalls] : undefined),
    };
  }
}

interface EventResult {
  content: string;
  reasoning: string;
  reasoning_details?: Array<Record<string, unknown>>;
  tool_call?: boolean;
  refusal?: string;
  /** Raw provider `usage` object; normalization happens once at stream end. */
  usage?: unknown;
  finish_reason?: string;
  /** Captured from `data: {"error": {"message": "..."}}` SSE lines. */
  error_message?: string;
}

/**
 * Process one SSE event. Feeds tool-call deltas into `toolAcc`.
 */
function processEvent(payload: string, toolAcc: ToolCallAccumulator): EventResult {
  const out: EventResult = { content: '', reasoning: '' };
  try {
      const chunk = JSON.parse(payload) as StreamChunk & { error?: { message?: string } };
      // Some OpenAI-compat servers send error payloads mid-stream
      // (e.g. tool call generation failures). Capture the message so
      // the UI can surface it.
      if (chunk.error?.message && !out.error_message) {
        out.error_message = chunk.error.message;
        out.finish_reason = 'error';
        return out;
      }
      const choice = chunk.choices?.[0];
      if (choice?.delta) {
        const d = extractDelta(choice.delta);
        if (d.content) out.content += d.content;
        if (d.reasoning) out.reasoning += d.reasoning;
        if (Array.isArray(choice.delta.reasoning_details)) {
          out.reasoning_details = choice.delta.reasoning_details;
        }
        const deltaRefusal = (choice.delta as { refusal?: unknown }).refusal;
        if (typeof deltaRefusal === 'string') out.refusal = deltaRefusal;
        // Feed tool_call deltas into the accumulator.
        const tcd = (choice.delta as { tool_calls?: unknown }).tool_calls;
        if (Array.isArray(tcd)) {
          for (const tc of tcd) {
            if (tc && typeof tc === 'object' && 'index' in tc) {
              out.tool_call = true;
              toolAcc.ingest(tc as ToolCallDeltaWire);
            }
          }
        }
      }
      if (choice?.finish_reason) out.finish_reason = choice.finish_reason;
      if (chunk.usage) out.usage = chunk.usage;
  } catch {
    // Ignore malformed event payloads; the shared decoder already handled
    // framing, and a single bad provider event should not lose the stream.
  }
  return out;
}

/** Accept either cumulative MiniMax stream fields or ordinary deltas. */
function cumulativeDelta(previous: string, next: string): { delta: string; aggregate: string } {
  if (!next) return { delta: '', aggregate: previous };
  if (next.startsWith(previous)) {
    return { delta: next.slice(previous.length), aggregate: next };
  }
  return { delta: next, aggregate: previous + next };
}

/**
 * Pull the content + reasoning fields out of a stream delta. The wire
 * format varies slightly across providers: LM Studio uses
 * `reasoning_content`, some forks use `reasoning`, and `content` can be
 * a string or an array of content parts (multimodal).
 */
export function extractDelta(delta: NonNullable<StreamChunk['choices'][number]['delta']>): StreamDelta {
  const out: StreamDelta = { content: '', reasoning: '' };
  if (!delta) return out;

  // Reasoning first — providers send these in a dedicated field.
  const r = (delta as unknown as Record<string, unknown>).reasoning_content
    ?? (delta as unknown as Record<string, unknown>).reasoning;
  if (typeof r === 'string' && r.length > 0) {
    out.reasoning = r;
  }

  // MiniMax reasoning_details: array of {text, type, index} objects.
  // Guarded by `!out.reasoning` so it never overwrites an already-
  // detected reasoning string from the standard fields above.
  const rd = !out.reasoning ? (delta as unknown as Record<string, unknown>).reasoning_details : undefined;
  if (Array.isArray(rd)) {
    const joined = rd.map((d: unknown) => {
      if (!d || typeof d !== 'object') return '';
      const text = (d as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    }).join('');
    if (joined.length > 0) out.reasoning = joined;
  }

  // Content can be a string, an array of parts, or null.
  const c = delta.content;
  if (typeof c === 'string') {
    out.content = c;
  } else if (Array.isArray(c)) {
    for (const part of c) {
      if (part && part.type === 'text') {
        out.content += part.text;
      }
    }
  }
  return out;
}
