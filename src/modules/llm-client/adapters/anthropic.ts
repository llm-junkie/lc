/**
 * Anthropic Messages API adapter. Handles SSE streaming with content-block
 * state machine, message format conversion (OpenAI-compat → Anthropic),
 * and provider-specific thinking format (Claude vs MiniMax).
 */

import type { ChatStreamAdapter, AdapterRequestParams, StreamCallbacks, StreamResult } from './adapter';
import type {
  ChatMessage, AnthropicRequest, AnthropicRequestMessage, AnthropicContentBlock,
  AnthropicToolDef, AnthropicSSEEvent, AnthropicReplayBlock, AnthropicBlockOrderEntry,
} from '../types';
import { MAX_ANTHROPIC_BLOCK_ORDER } from '../types.ts';
import type { ToolCallAccumulator } from '../tool-accumulator';
import { TOOL_CALL_ARGS_MAX_CHARS } from '../tool-accumulator.ts';
import { readWithTimeout } from '../transport/read-timeout.ts';
import { debugLog } from '../../../utils/debug.ts';
import { ANTHROPIC_API_VERSION, isAnthropicOwnApi, requiresAnthropicVersion } from '../anthropic-version.ts';
import { selectAnthropicReplayState } from '../../chat-pipeline/provider-history-projection.ts';
import { isMetaAIEndpoint } from './openai.ts';
import {
  normalizeAnthropicUsage,
  usageReporterForBaseUrl,
  type NormalizedUsage,
} from '../cache-usage.ts';
import type { ResolvedProviderContract } from '../provider-contracts';
import { applyProviderContractControls, effectiveProviderControls } from '../provider-contracts.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AnthropicAdapter implements ChatStreamAdapter {
  readonly protocol = 'anthropic' as const;
  /** Anthropic Messages path fragment. The client prepends /v1/ when the
   *  base URL does not already end with /vN. */
  readonly streamEndpoint = '/messages';

  /**
   * Used to label cache counters as router-reported when the server is
   * OpenRouter, and to decide whether the request needs `anthropic-version`
   * (see `requiresAnthropicVersion`). It is never used to infer an upstream
   * provider or to change how a response is parsed (cache-observability.md §3).
  */
  private readonly baseUrl?: string;
  private activeProviderContract?: AdapterRequestParams['providerContract'];
  private activeProviderContractStatus?: AdapterRequestParams['providerContractStatus'];

  constructor(
    baseUrl?: string,
    providerContract?: AdapterRequestParams['providerContract'],
    providerContractStatus?: AdapterRequestParams['providerContractStatus'],
  ) {
    this.baseUrl = baseUrl;
    this.activeProviderContract = providerContract;
    this.activeProviderContractStatus = providerContractStatus;
  }

  buildRequest(params: AdapterRequestParams): AnthropicRequest {
    this.activeProviderContract = params.providerContract;
    this.activeProviderContractStatus = params.providerContractStatus;
    const providerUnknown = params.providerContractStatus === 'unmatched';
    const legacyDirectAdapter = params.providerContractStatus === undefined;
    const isMiniMax = params.providerContract?.contract.id === 'minimax.messages'
      || (legacyDirectAdapter && params.baseUrl?.toLowerCase().includes('minimax'));
    const isDeepSeek = params.providerContract?.contract.id === 'deepseek.messages'
      || (legacyDirectAdapter && params.baseUrl?.toLowerCase().includes('deepseek'));
    const isMetaAI = params.providerContract?.contract.id === 'meta.messages'
      || (!providerUnknown && isMetaAIEndpoint(params.baseUrl ?? this.baseUrl));
    const isAnthropic = params.providerContract?.contract.id === 'anthropic.messages'
      || (legacyDirectAdapter && isAnthropicOwnApi(params.baseUrl ?? this.baseUrl));

    const req = convertToAnthropicRequest(params.messages, params.model, {
      // `max_tokens` is required by this API, so something must be sent even
      // when the user left the override off. Prefer the model's own reported
      // ceiling: the old hard-coded 4,096 capped a 128k-output model at 3% of
      // its range, and adaptive thinking has to fit its reasoning inside this
      // same budget — which is why max-effort replies came back with none.
      //
      // The two are passed separately rather than pre-resolved here: which one
      // is present decides whether the thinking budget or `max_tokens` yields
      // when they conflict (`resolveThinkingBudget`), and collapsing them to a
      // single number first destroys that distinction.
      maxTokens: params.maxTokens,
      maxOutputTokens: params.maxOutputTokens,
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      stopSequences: params.stopSequences,
      tools: params.tools,
      // No universal reasoning-control shape exists for an arbitrary Messages
      // compatibility relay. Do not infer Claude capabilities from its model ID.
      reasoningEnabled: providerUnknown ? false : params.reasoningEnabled,
      reasoningEffort: params.reasoningEffort,
      isDeepSeek,
      isMetaAI,
      baseUrl: params.baseUrl ?? this.baseUrl,
      isAnthropicOwnApi: isAnthropic,
      providerContract: params.providerContract,
      providerContractStatus: params.providerContractStatus,
    });

    // A contract can explicitly rule out the legacy Anthropic budget form.
    // In that case remove the capability fallback and apply only the declared
    // deterministic controls. Other Messages surfaces retain their existing
    // capability-driven path until model metadata can resolve it safely.
    if (params.providerContract && effectiveProviderControls(params.providerContract).some(
      (control) => control.semantic === 'budget' && control.handling === 'unsupported',
    )) {
      delete req.thinking;
      delete req.output_config;
      applyProviderContractControls(
        req as unknown as Record<string, unknown>,
        params.providerContract,
        {
          reasoningEnabled: params.reasoningEnabled,
          reasoningEffort: params.reasoningEffort,
        },
      );
    }

    // Meta Messages owns its reasoning shape through the resolved exact
    // contract. The legacy hostname branch above already emits the adaptive
    // shape for enabled efforts, but it deliberately omits `disabled` for
    // `none`; the contract replaces both with the documented request. This
    // must not wait on the budget control reading `unsupported`: Meta accepts
    // the budget-shaped compatibility form, yet LC still chooses adaptive
    // semantic effort.
    // https://dev.meta.ai/docs/protocols/messages#reasoning
    if (params.providerContract?.contract.id === 'meta.messages') {
      delete req.thinking;
      delete req.output_config;
      // Meta rejects these fields outright. Imported settings may still carry
      // them, so strip rather than trust the caller to withhold them.
      delete req.top_k;
      delete req.stop_sequences;
      applyProviderContractControls(
        req as unknown as Record<string, unknown>,
        params.providerContract,
        {
          reasoningEnabled: params.reasoningEnabled,
          reasoningEffort: params.reasoningEffort,
        },
      );
    }

    // Override thinking for MiniMax: adaptive/disabled, NOT enabled/budget_tokens
    if (isMiniMax && req.thinking) {
      req.thinking = {
        type: params.reasoningEnabled && params.reasoningEffort !== 'none'
          ? 'adaptive' : 'disabled',
      };
      // This override removes the `budget_tokens` that `max_tokens` was widened
      // to accommodate, so the widening no longer has anything to hold. Restore
      // the untied limit and leave MiniMax exactly as it was.
      req.max_tokens = params.maxTokens ?? params.maxOutputTokens ?? 4096;
    }

    return req;
  }

  buildHeaders(apiKey: string): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    // Anthropic's own API only. Every other server speaking this protocol is
    // sent the plain request — see `requiresAnthropicVersion`. Meta Messages
    // is the Bearer exception: it requires `Authorization: Bearer` and must
    // receive neither `x-api-key` nor `anthropic-version`.
    // https://ai.developer.meta.com/docs/protocols/messages
    const isMetaMessages = this.activeProviderContract?.contract.id === 'meta.messages';
    const isAnthropic = this.activeProviderContract?.contract.id === 'anthropic.messages'
      || (this.activeProviderContractStatus === undefined && requiresAnthropicVersion(this.baseUrl));
    if (isAnthropic) {
      h['anthropic-version'] = ANTHROPIC_API_VERSION;
    }
    if (apiKey) {
      if (isMetaMessages) h.Authorization = `Bearer ${apiKey}`;
      else h['x-api-key'] = apiKey;
    }
    return h;
  }

  async parseStream(
    body: ReadableStream<Uint8Array>,
    callbacks: StreamCallbacks,
    timeoutMs: number,
    toolAcc: ToolCallAccumulator,
  ): Promise<StreamResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const contentChunks: string[] = [];
    // Anthropic splits usage across two events: `message_start` carries
    // `input_tokens` plus every cache counter, `message_delta` carries the
    // final `output_tokens`. Both are held raw and merged once at the end so
    // explicit zeroes survive and the cache fields are normalized together.
    let rawStartUsage: Record<string, unknown> | undefined;
    let rawOutputTokens: unknown;
    let finishReason: string | undefined;
    let errorMessage: string | undefined;
    let gotError = false;
    let timedOut = false;

    // Preserve the complete recognized terminal usage envelope. In
    // particular, `output_tokens_details.thinking_tokens` exists only on the
    // final message_delta and must survive until response-local normalization.
    const captureTerminalUsage = (raw: unknown): void => {
      if (!isRecord(raw)) return;
      if ('output_tokens' in raw && raw.output_tokens !== null) rawOutputTokens = raw.output_tokens;
      const usable = (key: string, value: unknown): boolean => (
        key === 'cache_creation' || key === 'output_tokens_details'
          ? isRecord(value)
          : typeof value === 'number' && Number.isFinite(value)
      );
      for (const key of [
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
        'cache_creation',
        'output_tokens_details',
      ] as const) {
        if (!(key in raw)) continue;
        if (usable(key, raw[key]) || !usable(key, rawStartUsage?.[key])) {
          rawStartUsage = { ...(rawStartUsage ?? {}), [key]: raw[key] };
        }
      }
      const terminalInput = raw.input_tokens;
      if (typeof terminalInput === 'number' && Number.isFinite(terminalInput) && terminalInput > 0) {
        rawStartUsage = { ...(rawStartUsage ?? {}), input_tokens: terminalInput };
      }
    };

    // Tool use accumulator: content_block_start gives us id + name,
    // content_block_delta (input_json_delta) appends JSON fragments,
    // content_block_stop finalizes. Indexed by content block index.
    const toolSlots = new Map<number, { id: string; name: string; argsJson: string; argsCapped?: boolean }>();
    const thinkingSlots = new Map<number, { block: AnthropicReplayBlock; complete: boolean }>();
    // Provider text accumulated per content-block index. The joined message
    // content loses block boundaries, so each text block's exact segment is
    // kept here and attached to its order entry at finalize.
    const textByIndex = new Map<number, string>();

    // Per-index block type tracking — replaces the single global
    // activeBlockType which cannot handle interleaved blocks (e.g.
    // text block at index 0 interleaved with tool_use at index 1).
    const blockTypeByIndex = new Map<number, 'text' | 'thinking' | 'redacted_thinking' | 'tool_use'>();

    // Shared delta handler. The streamed loop and the trailing-buffer flush
    // both feed deltas through this, so a delta that arrives right before
    // EOF is processed identically to one mid-stream.
    const applyDelta = (event: Extract<AnthropicSSEEvent, { type: 'content_block_delta' }>): void => {
      const delta = event.delta;
      const blockType = blockTypeByIndex.get(event.index);

      // Route by delta.type (authoritative).  The blockType
      // fallback exists only for content_block_stop routing
      // and EOF recovery — deltas are self-describing.
      if (delta.type === 'text_delta') {
        if (!blockType) blockTypeByIndex.set(event.index, 'text');
        contentChunks.push(delta.text);
        textByIndex.set(event.index, (textByIndex.get(event.index) ?? '') + delta.text);
        callbacks.onDelta(delta.text);
      } else if (delta.type === 'thinking_delta') {
        if (!blockType) blockTypeByIndex.set(event.index, 'thinking');
        const slot = thinkingSlots.get(event.index);
        if (slot?.block.type === 'thinking') slot.block.thinking += delta.thinking;
        callbacks.onReasoning?.(delta.thinking);
      } else if (delta.type === 'signature_delta') {
        const slot = thinkingSlots.get(event.index);
        if (slot?.block.type === 'thinking') {
          slot.block.signature = (slot.block.signature ?? '') + delta.signature;
        }
      } else if (delta.type === 'input_json_delta') {
        callbacks.onToolCall?.();
        if (!blockType) blockTypeByIndex.set(event.index, 'tool_use');
        const slot = toolSlots.get(event.index);
        if (slot && delta.partial_json) {
          const fragment: string = delta.partial_json;
          if (slot.argsCapped || slot.argsJson.length >= TOOL_CALL_ARGS_MAX_CHARS) {
            slot.argsCapped = true;
          } else {
            const room = TOOL_CALL_ARGS_MAX_CHARS - slot.argsJson.length;
            slot.argsJson += fragment.slice(0, room);
            // Inclusive cap, same rule as ToolCallAccumulator.
            if (fragment.length > room || slot.argsJson.length > TOOL_CALL_ARGS_MAX_CHARS) {
              slot.argsCapped = true;
            }
          }
        }
      }
    };

    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await readWithTimeout(reader, timeoutMs);
      } catch (e) {
        debugLog.warn('[LC] Anthropic SSE read aborted:', (e as Error).message || e);
        timedOut = true;
        break;
      }
      const { value, done } = readResult;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: { index: number; length: number } | undefined;
      while ((boundary = findSSEBoundary(buffer)) !== undefined) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const parsed = parseNamedEvent(raw);
        if (!parsed || !parsed.data) continue;

        try {
          const event = JSON.parse(parsed.data) as AnthropicSSEEvent;

          switch (event.type) {
            case 'message_start':
              if (event.message?.usage) {
                rawStartUsage = event.message.usage as unknown as Record<string, unknown>;
              }
              break;

            case 'content_block_start': {
              const block = event.content_block;
              if (block.type === 'text') {
                blockTypeByIndex.set(event.index, 'text');
                if (block.text) {
                  contentChunks.push(block.text);
                  textByIndex.set(event.index, (textByIndex.get(event.index) ?? '') + block.text);
                  callbacks.onDelta(block.text);
                }
              } else if (block.type === 'thinking') {
                blockTypeByIndex.set(event.index, 'thinking');
                thinkingSlots.set(event.index, {
                  block: { type: 'thinking', thinking: block.thinking ?? '', signature: block.signature },
                  complete: false,
                });
                if (block.thinking) {
                  callbacks.onReasoning?.(block.thinking);
                }
              } else if (block.type === 'redacted_thinking') {
                blockTypeByIndex.set(event.index, 'redacted_thinking');
                thinkingSlots.set(event.index, {
                  block: { type: 'redacted_thinking', data: block.data },
                  complete: false,
                });
              } else if (block.type === 'tool_use') {
                callbacks.onToolCall?.();
                blockTypeByIndex.set(event.index, 'tool_use');
                toolSlots.set(event.index, {
                  id: block.id,
                  name: block.name,
                  argsJson: '',
                });
              }
              break;
            }

            case 'content_block_delta': {
              applyDelta(event);
              break;
            }

            case 'content_block_stop': {
              const blockType = blockTypeByIndex.get(event.index);
              if (blockType === 'thinking' || blockType === 'redacted_thinking') {
                const slot = thinkingSlots.get(event.index);
                if (slot) slot.complete = true;
              }
              if (blockType === 'tool_use') {
                const slot = toolSlots.get(event.index);
                // A slot whose delta stream hit the argument cap must not be
                // ingested. The capped slot is remembered and poisons the
                // whole turn at the end of the stream (see the sweep below),
                // so no tool_use id without a matched tool_result can
                // persist and no sibling executes.
                if (slot?.id && slot?.name && !slot.argsCapped) {
                  toolAcc.ingest({
                    index: event.index,
                    id: slot.id,
                    function: { name: slot.name, arguments: slot.argsJson },
                  });
                } else if (slot?.argsCapped) {
                  debugLog.warn(`[LC] Anthropic tool_use block ${slot.id ?? event.index} exceeded the ${TOOL_CALL_ARGS_MAX_CHARS}-character argument cap — call dropped`);
                }
              }
              blockTypeByIndex.delete(event.index);
              break;
            }

            case 'message_delta':
              if (event.delta?.stop_reason) {
                finishReason = event.delta.stop_reason;
              }
              // `!= null` rather than truthiness: a terminal `output_tokens: 0`
              // is a real provider report, not a missing value.
              captureTerminalUsage(event.usage);
              break;

            case 'message_stop':
              break;

            case 'ping':
              break;

            case 'error':
              debugLog.error('[LC] Anthropic stream error:', event.error);
              gotError = true;
              finishReason = 'error';
              errorMessage = event.error?.message || 'Unknown stream error';
              break;
          }
        } catch {
          // Malformed event payload — skip silently.
        }
      }
    }

    // Flush trailing buffer. A stream may end right after an event without
    // the final blank-line separator — that event is still part of the
    // message and must be processed, not silently dropped. `message_delta`
    // carries the finish reason; every other event type goes through the
    // same switch as streamed events (the delta event before an EOF can be
    // the one that crosses the argument cap).
    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing) {
      const parsed = parseNamedEvent(trailing);
      if (parsed?.data) {
        try {
          const event = JSON.parse(parsed.data) as AnthropicSSEEvent;
          switch (event.type) {
            case 'message_delta':
              if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
              captureTerminalUsage(event.usage);
              break;
            case 'content_block_delta': {
              applyDelta(event);
              break;
            }
            case 'content_block_stop': {
              const blockType = blockTypeByIndex.get(event.index);
              if (blockType === 'thinking' || blockType === 'redacted_thinking') {
                const slot = thinkingSlots.get(event.index);
                if (slot) slot.complete = true;
              }
              if (blockType === 'tool_use') {
                const slot = toolSlots.get(event.index);
                if (slot?.id && slot?.name && !slot.argsCapped) {
                  toolAcc.ingest({
                    index: event.index,
                    id: slot.id,
                    function: { name: slot.name, arguments: slot.argsJson },
                  });
                }
              }
              blockTypeByIndex.delete(event.index);
              break;
            }
            case 'error':
              debugLog.error('[LC] Anthropic stream error:', event.error);
              gotError = true;
              finishReason = 'error';
              errorMessage = event.error?.message || 'Unknown stream error';
              break;
            default:
              // Other trailing events (ping and message_stop) carry no tool
              // state. There is nothing to preserve.
              break;
          }
        } catch { /* ignore */ }
      }
    }

    // A capped tool_use poisons the whole provider turn, whether it hit
    // content_block_stop or the stream ended before that marker.
    const cappedBlock = [...toolSlots.values()].find((slot) => slot.argsCapped);
    if (cappedBlock) {
      errorMessage = `tool_use ${cappedBlock.id ?? 'unknown'} argument stream exceeded ${TOOL_CALL_ARGS_MAX_CHARS} characters — call dropped`;
      finishReason = 'error';
    }

    // Finalize any recoverable complete tool slots that never received
    // a content_block_stop event (e.g. stream disconnected after all
    // tool arguments were streamed but before the stop marker).
    for (const [index, slot] of toolSlots) {
      if (slot.id && slot.name && !slot.argsCapped) {
        // Only ingest if not already finalized (content_block_stop
        // removes the block type entry; if it's still in blockTypeByIndex
        // the stop event was never received).
        if (blockTypeByIndex.has(index)) {
          toolAcc.ingest({
            index,
            id: slot.id,
            function: { name: slot.name, arguments: slot.argsJson },
          });
        }
      }
    }

    const toolCalls = toolAcc.finalize();
    const anthropicOutputBlocks = [...thinkingSlots.entries()]
      .filter(([, slot]) => slot.complete)
      .sort(([left], [right]) => left - right)
      .map(([, slot]) => slot.block);
    // Rebuild the provider block order from authoritative per-index sources
    // so it matches the persisted blocks exactly: only complete thinking
    // slots, only finalized tool calls (matched to slots by call id), and
    // text blocks with their exact segments. Sorted by stream index, this
    // restores the true interleave regardless of delta arrival order. Text-
    // only responses are retained too because their response ordinal can be
    // the only boundary after a tool result. The order is dropped past the
    // bound so an adversarial block count cannot grow persisted state without
    // limit.
    const anthropicBlockOrder = ((): AnthropicBlockOrderEntry[] | undefined => {
      const entries: AnthropicBlockOrderEntry[] = [];
      for (const [index, text] of textByIndex) {
        if (text.length > 0) entries.push({ kind: 'text', index, text });
      }
      for (const [index, slot] of thinkingSlots) {
        if (!slot.complete) continue;
        entries.push({
          kind: slot.block.type === 'redacted_thinking' ? 'redacted_thinking' : 'thinking',
          index,
        });
      }
      const slotIndexByCallId = new Map<string, number>();
      for (const [index, slot] of toolSlots) {
        if (!slot.id || !slot.name || slot.argsCapped) continue;
        const prev = slotIndexByCallId.get(slot.id);
        if (prev === undefined || index < prev) slotIndexByCallId.set(slot.id, index);
      }
      for (const call of toolCalls) {
        const index = slotIndexByCallId.get(call.id);
        if (index !== undefined) entries.push({ kind: 'tool_use', index });
      }
      entries.sort((left, right) => left.index - right.index);
      if (entries.length === 0 || entries.length > MAX_ANTHROPIC_BLOCK_ORDER) return undefined;
      return entries;
    })();
    if (gotError) finishReason = 'error';
    else if (timedOut && !finishReason) finishReason = 'disconnected';

    // A terminal `output_tokens` is a provider report in its own right. Gating
    // the whole envelope on `message_start` having carried usage discarded it
    // on any compatible server that reports only on `message_delta`, and LC
    // then fell back to counting tokens itself — an `lc-estimate` standing in
    // for a figure the provider had actually sent (constraint 4).
    const usage: NormalizedUsage | undefined = (rawStartUsage === undefined && rawOutputTokens === undefined)
      ? undefined
      : normalizeAnthropicUsage(
        { ...(rawStartUsage ?? {}), ...(rawOutputTokens !== undefined ? { output_tokens: rawOutputTokens } : {}) },
        usageReporterForBaseUrl(this.baseUrl),
        { providerContractId: this.activeProviderContract?.contract.id },
      );

    return {
      content: contentChunks.join(''),
      usage,
      finish_reason: finishReason,
      error_message: errorMessage,
      anthropic_output_blocks: anthropicOutputBlocks.length > 0 ? anthropicOutputBlocks : undefined,
      anthropic_block_order: anthropicBlockOrder,
      // A capped turn executes nothing: valid siblings are suppressed too.
      tool_calls: cappedBlock ? undefined : (toolCalls.length > 0 ? [...toolCalls] : undefined),
    };
  }
}

/**
 * `budget_tokens` is carved out of `max_tokens`, so the API rejects any request
 * whose budget is not strictly smaller than the limit. LC picked those two
 * numbers from unrelated fallbacks and never compared them: a server that
 * reports no output ceiling left `max_tokens` at the 4,096 floor while `max`
 * effort asked for a far larger budget, and every request at medium effort or
 * above failed with `max_completion_tokens [4096] must be greater than
 * thinking_budget [16384]` — four of the six effort levels, dead.
 *
 * The ratio below ties them. Which value moves depends on whether the limit is
 * a fact or LC's own invention:
 *
 *   - A user override or a server-reported ceiling is a hard cap. Growing
 *     `max_tokens` past a user's explicit override is exactly what the toggle
 *     contract forbids, and growing it past the model's ceiling is a different
 *     rejection, so the *budget* is clamped to fit underneath instead.
 *   - With neither, `max_tokens` is only a placeholder LC invented, while the
 *     effort level is something the user actually asked for — so `max_tokens`
 *     is the one that grows.
 *
 * A cap at or below `MIN_THINKING_BUDGET` can satisfy neither constraint; that
 * request is unsatisfiable as configured and the provider is left to say so.
 */
const THINKING_HEADROOM_RATIO = 2.5;

/** Anthropic's documented floor for `budget_tokens`. */
const MIN_THINKING_BUDGET = 1024;

/**
 * Reconcile a requested thinking budget with the completion limit.
 * `maxTokens` is returned only when the limit had to grow to hold the budget.
 */
function resolveThinkingBudget(
  desiredBudget: number,
  hardCap: number | undefined,
): { budgetTokens: number; maxTokens?: number } {
  if (hardCap === undefined) {
    return {
      budgetTokens: desiredBudget,
      maxTokens: Math.ceil(desiredBudget * THINKING_HEADROOM_RATIO),
    };
  }
  const affordable = Math.floor(hardCap / THINKING_HEADROOM_RATIO);
  return {
    budgetTokens: Math.max(MIN_THINKING_BUDGET, Math.min(desiredBudget, affordable)),
  };
}

/**
 * Validate an untrusted provider block order (storage row, archive import).
 * Returns copies, or undefined when the value is not a bounded array of
 * well-formed entries. Text segments must be strings; malformed entries
 * invalidate the whole order rather than replaying a reshuffled turn.
 */
export function normalizeAnthropicBlockOrder(value: unknown): AnthropicBlockOrderEntry[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ANTHROPIC_BLOCK_ORDER) {
    return undefined;
  }
  const out: AnthropicBlockOrderEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return undefined;
    const { kind, index, responseIndex, text } = entry as Partial<AnthropicBlockOrderEntry>;
    if (kind !== 'thinking' && kind !== 'redacted_thinking' && kind !== 'text' && kind !== 'tool_use') {
      return undefined;
    }
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return undefined;
    if (responseIndex !== undefined
      && (typeof responseIndex !== 'number'
        || !Number.isInteger(responseIndex)
        || responseIndex < 0
        || responseIndex >= MAX_ANTHROPIC_BLOCK_ORDER)) return undefined;
    if (text !== undefined && typeof text !== 'string') return undefined;
    out.push({
      kind,
      index,
      ...(responseIndex !== undefined ? { responseIndex } : {}),
      ...(text !== undefined ? { text } : {}),
    });
  }
  return out;
}

/**
 * Check recorded text segments against canonical message content. Segments
 * must concatenate to the canonical text exactly; accepting an ordered
 * substring would let auxiliary metadata silently omit a newly inserted
 * prefix, suffix, or gap. Orders without recorded segments have nothing to
 * contradict and pass for backward compatibility.
 *
 * Segments are auxiliary ordering metadata: when they stop matching the
 * canonical text — a malformed import, a stale persisted row, or an edited
 * message — the order must not shadow or replace `content`. Callers fall
 * back to the legacy layout instead of replaying hidden stale text.
 */
export function validateAnthropicBlockOrderText(
  order: readonly AnthropicBlockOrderEntry[] | undefined,
  content: string,
): boolean {
  if (!order?.length) return true;
  const segments = order
    .slice(0, MAX_ANTHROPIC_BLOCK_ORDER)
    .filter((entry) => entry.kind === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text as string);
  return segments.length === 0 || segments.join('') === content;
}

/**
 * Attribute every order entry to the response group that owns it, so text —
 * like every other block kind — stays inside its own provider response when
 * a tool loop re-expands. Thinking/redacted entries map by ordinal onto the
 * message's stored block array (both follow stored block order); tool_use
 * entries map onto the message's tool calls by call ID. Newly captured rows
 * carry an explicit responseIndex on every entry. The proximity walk remains
 * only for a single-group legacy row, where it cannot cross a response
 * boundary. Ambiguous multi-group legacy text falls back to canonical layout.
 */
function assignAnthropicBlockOrderOwners(
  order: readonly AnthropicBlockOrderEntry[],
  toolCalls: NonNullable<ChatMessage['tool_calls']>,
  blockOwnerOfOrdinal: (ordinal: number) => number | undefined,
  callOwnerOfId: (callId: string) => number | undefined,
): Array<number | undefined> {
  if (order.every((entry) => entry.responseIndex !== undefined)) {
    return order.map((entry) => entry.responseIndex);
  }
  const owners: Array<number | undefined> = new Array(order.length);
  let thinkOrdinal = 0;
  let toolOrdinal = 0;
  order.forEach((entry, index) => {
    if (entry.kind === 'thinking' || entry.kind === 'redacted_thinking') {
      owners[index] = blockOwnerOfOrdinal(thinkOrdinal);
      thinkOrdinal += 1;
    } else if (entry.kind === 'tool_use') {
      const callId = toolCalls[toolOrdinal]?.id;
      owners[index] = callId === undefined ? undefined : callOwnerOfId(callId);
      toolOrdinal += 1;
    }
  });
  // Trailing text belongs to the response that produced it, so the preceding
  // owner wins; leading text takes the following owner.
  let lastOwned: number | undefined;
  order.forEach((entry, index) => {
    if (entry.kind !== 'text') {
      if (owners[index] !== undefined) lastOwned = owners[index];
      return;
    }
    owners[index] = lastOwned;
  });
  let nextOwned: number | undefined;
  for (let index = order.length - 1; index >= 0; index -= 1) {
    if (order[index].kind !== 'text') {
      if (owners[index] !== undefined) nextOwned = owners[index];
      continue;
    }
    if (owners[index] === undefined) owners[index] = nextOwned;
  }
  return owners;
}

/**
 * Narrow a turn's recorded provider block order to one response group using
 * precomputed ownership (see `assignAnthropicBlockOrderOwners`). Unowned
 * thinking/tool entries are dropped; unowned text entries travel with the
 * legacy fallback group so older records keep their layout.
 */
function filterAnthropicBlockOrderForGroup(
  order: readonly AnthropicBlockOrderEntry[] | undefined,
  owners: ReadonlyArray<number | undefined>,
  groupIndex: number,
  fallbackGroupIndex: number,
): AnthropicBlockOrderEntry[] {
  if (!order?.length) return [];
  const out: AnthropicBlockOrderEntry[] = [];
  order.slice(0, MAX_ANTHROPIC_BLOCK_ORDER).forEach((entry, index) => {
    const owner = owners[index];
    if (owner === groupIndex) {
      out.push({ ...entry, responseIndex: 0 });
    } else if (owner === undefined && entry.kind === 'text' && groupIndex === fallbackGroupIndex) {
      out.push({ ...entry });
    }
  });
  return out;
}

/**
 * Re-expand LC's one-bubble tool loop into the alternating provider rounds
 * recorded by response-local accounting groups. This keeps every signed or
 * redacted block beside the tool_use calls from the same provider response.
 */
function expandAnthropicToolRounds(
  messages: ChatMessage[],
  model: string,
  baseUrl?: string,
  providerContract?: ResolvedProviderContract,
  providerContractStatus?: AdapterRequestParams['providerContractStatus'],
): ChatMessage[] {
  const expanded: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      expanded.push(message);
      continue;
    }
    const state = selectAnthropicReplayState(message, {
      baseUrl,
      model,
      providerContract,
      providerContractStatus,
    });
    const groups = state.groups ?? [];
    if (groups.length === 0) {
      expanded.push(message);
      continue;
    }
    const groupedCallIds = new Set(groups.flatMap((group) => group.toolCallIds ?? []));
    if (message.tool_calls.some((call) => !groupedCallIds.has(call.id))) {
      // Legacy or partially associated state cannot be safely repartitioned.
      expanded.push(message);
      continue;
    }

    const followingTools: ChatMessage[] = [];
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor].role === 'tool') {
      followingTools.push(messages[cursor]);
      cursor += 1;
    }
    const toolByCallId = new Map(
      followingTools.filter((tool) => tool.tool_call_id).map((tool) => [tool.tool_call_id!, tool]),
    );
    const textGroupIndex = (() => {
      for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
        if ((groups[groupIndex].toolCallIds?.length ?? 0) === 0) return groupIndex;
      }
      return 0;
    })();
    const usedToolIds = new Set<string>();
    // Attribute the turn's recorded order to response groups once, before
    // splitting, so an intermediate response's text never migrates into a
    // later response. Locator indexes are absolute positions into the
    // message's stored block array, matching thinking/redacted entry
    // ordinals; tool calls map onto groups by call ID.
    const fullContent = typeof message.content === 'string' ? message.content : '';
    const wholeOrder = message.anthropic_block_order?.length
      ? message.anthropic_block_order
      : undefined;
    const blockOwner = new Map<number, number>();
    groups.forEach((ownerGroup, ownerIndex) => {
      if (ownerGroup.locator.kind !== 'anthropic-block-indexes') return;
      for (const blockIndex of ownerGroup.locator.blockIndexes) {
        if (!blockOwner.has(blockIndex)) blockOwner.set(blockIndex, ownerIndex);
      }
    });
    const callOwner = new Map<string, number>();
    (message.tool_calls ?? []).forEach((call) => {
      if (callOwner.has(call.id)) return;
      const ownerIndex = groups.findIndex((ownerGroup) => (ownerGroup.toolCallIds ?? []).includes(call.id));
      if (ownerIndex !== -1) callOwner.set(call.id, ownerIndex);
    });
    const explicitOwnershipValid = wholeOrder !== undefined
      && wholeOrder.every((entry) => entry.responseIndex !== undefined
        && entry.responseIndex >= 0
        && entry.responseIndex < groups.length);
    const orderOwners = wholeOrder && (explicitOwnershipValid || groups.length === 1)
      ? assignAnthropicBlockOrderOwners(
        wholeOrder,
        message.tool_calls ?? [],
        (ordinal) => blockOwner.get(ordinal),
        (callId) => callOwner.get(callId),
      )
      : [];
    // Segmented rows carry their own text per response; only segment-less
    // (older) rows use the joined turn text at the legacy fallback group.
    // Whole-order trust is checked here against canonical content; per-group
    // serialization re-validates each slice, so stale segments can neither
    // leak through expansion nor through a direct whole-turn request.
    const orderTrusted = wholeOrder !== undefined
      && validateAnthropicBlockOrderText(wholeOrder, fullContent);
    const segmentedMode = orderTrusted
      && (explicitOwnershipValid || groups.length === 1)
      && !!wholeOrder?.some((entry) => entry.kind === 'text'
        && typeof entry.text === 'string' && entry.text.length > 0);

    groups.forEach((group, groupIndex) => {
      const calls = (group.toolCallIds ?? [])
        .map((id) => message.tool_calls!.find((call) => call.id === id))
        .filter((call): call is NonNullable<ChatMessage['tool_calls']>[number] => !!call);
      const blockIndexes = group.locator.kind === 'anthropic-block-indexes'
        ? group.locator.blockIndexes
        : [];
      const blocks = blockIndexes.map((blockIndex) => state.blocks?.[blockIndex]).filter(
        (block): block is NonNullable<ChatMessage['anthropic_output_blocks']>[number] => !!block,
      );
      const groupOrder = filterAnthropicBlockOrderForGroup(
        orderTrusted ? wholeOrder : undefined,
        orderOwners,
        groupIndex,
        textGroupIndex,
      );
      // In segmented mode the group's owned segments are its text, so the
      // joined turn text must not also appear here. Otherwise the legacy
      // fallback group keeps the joined text exactly as before.
      const ownedText = segmentedMode
        ? groupOrder
          .filter((entry) => entry.kind === 'text' && typeof entry.text === 'string' && entry.text.length > 0)
          .map((entry) => (entry as { text: string }).text)
          .join('')
        : undefined;
      const content = ownedText !== undefined
        ? ownedText
        : (groupIndex === textGroupIndex ? message.content : '');
      const groupHasText = groupOrder.some((entry) => entry.kind === 'text'
        && typeof entry.text === 'string' && entry.text.length > 0);
      if (calls.length > 0 || blocks.length > 0 || groupHasText
        || (typeof content === 'string' && content.length > 0)) {
        const rebasedGroup = {
          ...group,
          locator: {
            kind: 'anthropic-block-indexes' as const,
            blockIndexes: blocks.map((_block, blockIndex) => blockIndex),
          },
        };
        expanded.push({
          ...message,
          content,
          tool_calls: calls.length > 0 ? calls : undefined,
          anthropic_output_blocks: blocks.length > 0 ? blocks : undefined,
          anthropic_block_order: groupOrder.length > 0 ? groupOrder : undefined,
          opaque_replay_accounting: [rebasedGroup],
        });
      }
      for (const call of calls) {
        const tool = toolByCallId.get(call.id);
        if (tool) {
          expanded.push(tool);
          usedToolIds.add(call.id);
        }
      }
    });
    for (const tool of followingTools) {
      if (!tool.tool_call_id || !usedToolIds.has(tool.tool_call_id)) expanded.push(tool);
    }
    index = cursor - 1;
  }
  return expanded;
}

/**
 * Build one `tool_use` block from a normalized tool call, mirroring the
 * legacy serialization below.
 */
function anthropicToolUseBlock(
  call: NonNullable<ChatMessage['tool_calls']>[number],
): AnthropicContentBlock {
  let input: Record<string, unknown> = {};
  try { input = JSON.parse(call.function.arguments); } catch { /* keep empty */ }
  return {
    type: 'tool_use',
    id: call.id,
    name: call.function.name,
    input,
  };
}

/**
 * Serialize one assistant turn in recorded provider block order.
 *
 * Only blocks the replay gate approved are emitted, so a gated-out thinking
 * block shifts later entries forward rather than leaking: origin gating stays
 * authoritative and ordering is best-effort on top of it. Text entries carry
 * their exact provider segments, so several text blocks separated by thinking
 * or tool calls replay in place — but only when those segments validate
 * against canonical content (see `validateAnthropicBlockOrderText`).
 * Untrusted segments are never emitted; entries without segments (older
 * records) share the joined message text once at the first such position.
 * Leftover replay blocks, unemitted text, and unemitted calls are appended so
 * a short or foreign order can never drop state the legacy layout would have
 * sent. Expanded tool-loop groups carry their owned segments as content, so
 * validation there is trivially exact; whole turns validate against the full
 * canonical text.
 */
function serializeOrderedAnthropicBlocks(
  replayBlocks: AnthropicReplayBlock[],
  textContent: string,
  toolCalls: NonNullable<ChatMessage['tool_calls']>,
  order: AnthropicBlockOrderEntry[],
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  let replayCursor = 0;
  let callCursor = 0;
  let segmentedTextEmitted = false;
  let fallbackTextEmitted = false;
  const segmentsTrusted = validateAnthropicBlockOrderText(order, textContent);
  const emitFallbackText = (): void => {
    if (textContent && !fallbackTextEmitted && !segmentedTextEmitted) {
      blocks.push({ type: 'text', text: textContent });
      fallbackTextEmitted = true;
    }
  };
  for (const entry of order.slice(0, MAX_ANTHROPIC_BLOCK_ORDER)) {
    if (entry.kind === 'thinking' || entry.kind === 'redacted_thinking') {
      const next = replayBlocks[replayCursor++];
      if (next) blocks.push({ ...next });
    } else if (entry.kind === 'text') {
      if (segmentsTrusted && typeof entry.text === 'string' && entry.text.length > 0) {
        blocks.push({ type: 'text', text: entry.text });
        segmentedTextEmitted = true;
      } else {
        emitFallbackText();
      }
    } else {
      const call = toolCalls[callCursor++];
      if (call) blocks.push(anthropicToolUseBlock(call));
    }
  }
  for (; replayCursor < replayBlocks.length; replayCursor += 1) {
    blocks.push({ ...replayBlocks[replayCursor] });
  }
  emitFallbackText();
  for (; callCursor < toolCalls.length; callCursor += 1) {
    blocks.push(anthropicToolUseBlock(toolCalls[callCursor]));
  }
  return blocks;
}

/**
 * Convert LC's internal OpenAI-compat messages array into an Anthropic
 * Messages API request. The Anthropic wire format differs in several ways:
 *   - `system` is a top-level field (string), not a `role: "system"` message
 *   - Messages use content-block arrays: `[{type, text}, {type, tool_use}, ...]`
 *   - `tool` role messages become `{role: "user", content: [{type: "tool_result", ...}]}`
 *   - Tool definitions use `{name, description, input_schema}` instead of
 *     `{type: "function", function: {name, description, parameters}}`
 */
export function convertToAnthropicRequest(
  messages: ChatMessage[],
  model: string,
  opts: {
    /** The user's max-tokens override. Absent when the toggle is off. */
    maxTokens?: number;
    /** The model's own reported completion ceiling. Not a user override. */
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
    tools?: import('../types.ts').ToolDefinition[];
    reasoningEnabled?: boolean;
    reasoningEffort?: string;
    /** When true, convert `reasoning_content` on assistant messages
     *  into Anthropic `thinking` content blocks (DeepSeek Anthropic API). */
    isDeepSeek?: boolean;
    /** Current endpoint, used with the message's state origin to prevent
     *  opaque thinking replay across endpoints. Without a resolved provider
     *  contract, replay also requires the exact source model. */
    baseUrl?: string;
    /**
     * When true the endpoint is Meta Model API (`api.meta.ai`), which adapts
     * the Anthropic wire format over its Responses pipeline. Muse Spark uses
     * adaptive thinking (`thinking: {type:'adaptive'}` + `output_config.effort`)
     * and cannot disable reasoning.
     * https://dev.meta.ai/docs/protocols/messages#reasoning
     */
    isMetaAI?: boolean;
    /**
     * When true the endpoint is Anthropic's own API, so Anthropic-only opt-ins
     * (automatic prompt caching, summarized thinking) apply. Compatible servers
     * are sent neither — see `isAnthropicOwnApi`.
     */
    isAnthropicOwnApi?: boolean;
    /** Verified origin/protocol behavior for history projection. */
    providerContract?: ResolvedProviderContract;
    providerContractStatus?: AdapterRequestParams['providerContractStatus'];
  } = {},
): AnthropicRequest {
  // Extract system message(s) — Anthropic puts them at the top level.
  let system: string | undefined;
  const anthropicMessages: AnthropicRequestMessage[] = [];
  const projectedMessages = expandAnthropicToolRounds(
    messages,
    model,
    opts.baseUrl,
    opts.providerContract,
    opts.providerContractStatus,
  );

  for (const msg of projectedMessages) {
    if (msg.role === 'system') {
      system = (system ?? '') + (typeof msg.content === 'string' ? msg.content : '');
      if (system && !system.endsWith('\n')) system += '\n';
      continue;
    }

    // Tool result messages become user messages with tool_result blocks.
    if (msg.role === 'tool') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const isError = !!msg.tool_is_error;
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        // Insert after the last existing tool_result block so
        // all tool_result blocks stay at the front of the array.
        // Anthropic requires "tool_result blocks must come FIRST
        // in content array, before any text or other blocks."
        // Using push() would place this tool_result after any
        // previously-merged text/image blocks (from image
        // injection), violating the ordering invariant.
        let insertAt = last.content.length;
        for (let i = last.content.length - 1; i >= 0; i--) {
          if (last.content[i].type === 'tool_result') {
            insertAt = i + 1;
            break;
          }
        }
        last.content.splice(insertAt, 0, {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id ?? '',
          content,
          is_error: isError,
        });
      } else {
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id ?? '',
            content,
            is_error: isError,
          }],
        });
      }
      continue;
    }

    // Assistant messages with tool_calls.
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const blocks: AnthropicContentBlock[] = [];
      // Unlisted provider thinking blocks stay on the exact endpoint/model
      // that issued them. A verified contract may let the provider own
      // same-surface model compatibility; no state crosses a Base URL.
      const replayState = selectAnthropicReplayState(msg, {
        baseUrl: opts.baseUrl,
        model,
        providerContract: opts.providerContract,
        providerContractStatus: opts.providerContractStatus,
      });
      const replayBlocks = (replayState.blocks ?? []).map((block) => ({ ...block }));
      const textContent = typeof msg.content === 'string' ? msg.content : '';
      const recordedOrder = msg.anthropic_block_order?.length
        ? msg.anthropic_block_order
        : undefined;
      // DeepSeek thinking mode: reasoning_content must be passed back
      // as a thinking block in all subsequent requests for tool-call
      // turns, otherwise the API returns a 400 error.
      // https://api-docs.deepseek.com/guides/thinking_mode#tool-calls
      // https://api-docs.deepseek.com/guides/anthropic_api
      const deepSeekFallback = replayBlocks.length === 0 && opts.isDeepSeek && msg.reasoning_content?.trim()
        ? [{ type: 'thinking', thinking: msg.reasoning_content } as AnthropicContentBlock]
        : [];
      if (recordedOrder) {
        blocks.push(...deepSeekFallback, ...serializeOrderedAnthropicBlocks(
          replayBlocks,
          textContent,
          msg.tool_calls,
          recordedOrder,
        ));
      } else {
        if (replayBlocks.length > 0) blocks.push(...replayBlocks);
        blocks.push(...deepSeekFallback);
        if (textContent) {
          blocks.push({ type: 'text', text: textContent });
        }
        for (const tc of msg.tool_calls) {
          blocks.push(anthropicToolUseBlock(tc));
        }
      }
      anthropicMessages.push({ role: 'assistant', content: blocks });
      continue;
    }

    // A re-expanded final response can contain signed/redacted thinking but no
    // tool_use block of its own. It is still provider output state and must
    // remain in its original response position; treating this as an ordinary
    // text-only assistant message would silently drop the final replay group.
    if (msg.role === 'assistant' && msg.anthropic_output_blocks?.length) {
      const replayState = selectAnthropicReplayState(msg, {
        baseUrl: opts.baseUrl,
        model,
        providerContract: opts.providerContract,
        providerContractStatus: opts.providerContractStatus,
      });
      if (replayState.blocks?.length) {
        const replayBlocks = replayState.blocks
          .map((block) => ({ ...block }));
        const textContent = typeof msg.content === 'string' ? msg.content : '';
        const recordedOrder = msg.anthropic_block_order?.length
          ? msg.anthropic_block_order
          : undefined;
        const content = recordedOrder
          ? serializeOrderedAnthropicBlocks(replayBlocks, textContent, [], recordedOrder)
          : [...replayBlocks, ...(textContent ? [{ type: 'text', text: textContent } as AnthropicContentBlock] : [])];
        anthropicMessages.push({ role: 'assistant', content });
        continue;
      }
    }

    // Plain user/assistant messages.
    if (Array.isArray(msg.content)) {
      const blocks: AnthropicContentBlock[] = [];
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) {
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(part.image_url.url);
          if (m) blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: m[1], data: m[2] },
          } as AnthropicContentBlock);
        }
      }
      // Merge consecutive same-role array-content messages —
      // Anthropic requires alternating user/assistant.  Without
      // this, injected image messages after lc_read_image tool
      // results create back-to-back user messages (the tool
      // result becomes a user message with tool_result blocks,
      // and the injected image payload becomes a second user
      // message), which Anthropic rejects with a 400.
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === msg.role && Array.isArray(last.content)) {
        last.content.push(...blocks);
      } else {
        anthropicMessages.push({ role: msg.role as 'user' | 'assistant', content: blocks });
      }
      continue;
    }

    const textContent = typeof msg.content === 'string' ? msg.content : '';
    if (anthropicMessages.length > 0) {
      const last = anthropicMessages[anthropicMessages.length - 1];
      // Anthropic requires alternating user/assistant. Merge consecutive
      // same-role messages into one (append text).
      if (last.role === msg.role && typeof last.content === 'string' && textContent) {
        last.content = last.content + '\n\n' + textContent;
        continue;
      }
      if (last.role === msg.role && Array.isArray(last.content)) {
        last.content.push({ type: 'text', text: textContent });
        continue;
      }
    }

    anthropicMessages.push({
      role: msg.role as 'user' | 'assistant',
      content: textContent,
    });
  }

  // Ensure the first message is a user message (Anthropic requirement).
  if (anthropicMessages.length > 0 && anthropicMessages[0].role === 'assistant') {
    anthropicMessages.unshift({ role: 'user', content: '_' });
  }

  const req: AnthropicRequest = {
    model,
    messages: anthropicMessages,
    max_tokens: opts.maxTokens ?? opts.maxOutputTokens ?? 4096,
    stream: true,
  };

  if (system?.trim()) req.system = system.trim();
  if (opts.temperature !== undefined) req.temperature = opts.temperature;
  if (opts.topP !== undefined) req.top_p = opts.topP;
  if (opts.topK !== undefined) req.top_k = opts.topK;
  if (opts.stopSequences && opts.stopSequences.length > 0) req.stop_sequences = opts.stopSequences;

  // Convert OpenAI-format tool defs to Anthropic format.
  if (opts.tools && opts.tools.length > 0) {
    req.tools = opts.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as AnthropicToolDef['input_schema'],
    }));
  }

  /**
   * Anthropic Reasoning Effort Configuration
   *
   * This table is a name-parsing stand-in for facts the provider already
   * reports. `GET /v1/models` returns `capabilities.thinking.types.{enabled,
   * adaptive}.supported` and `capabilities.effort.{low..max}.supported` per
   * model; the rows below were reconciled against a live response on
   * 2026-08-05. Any row that drifts from that report is a bug, not a policy.
   *
   * EFFORT SUPPORT BY MODEL:
   *   All 5 levels (low/medium/high/xhigh/max):
   *     Fable 5, Mythos 5, Opus 5, Opus 4.8, Opus 4.7, Sonnet 5
   *   4 levels (no xhigh — max is the ceiling):
   *     Opus 4.6, Sonnet 4.6, Mythos Preview
   *   3 levels (low/medium/high), alongside budget_tokens:
   *     Opus 4.5 — LC does not currently send effort for it
   *   No effort param at all (budget_tokens only):
   *     Haiku 4.5, Sonnet 4.5, older, unknown / non-Claude models
   *
   * THINKING MODE:
   *   Adaptive (`type:'adaptive'`) — decides when/how much to think:
   *     Fable 5, Mythos 5, Mythos Preview, Opus 5, Opus 4.8, 4.7, 4.6,
   *     Sonnet 5, Sonnet 4.6
   *   Extended (`type:'enabled'` + budget_tokens):
   *     Haiku 4.5, Sonnet 4.5, Opus 4.5 and earlier, unknown / non-Claude
   *
   * SPECIAL:
   *   - Fable 5, Mythos 5, Mythos Preview: thinking always on; `disabled`
   *     returns 400. Sonnet 5 is excluded from `disabled` too, but for a
   *     weaker reason — see the disabled branch below.
   *   - Opus 5 and Opus 4.7+: `enabled`/budget_tokens returns 400.
   *   - Opus 4.6, Sonnet 4.6: budget_tokens is still accepted by the API.
   *   - xhigh → max on Opus 4.6, Sonnet 4.6, and Mythos Preview (highest
   *     supported level on each).
   *
   * VISIBILITY (`thinking.display`):
   *   From Opus 4.7 onward this defaults to `omitted` — thinking blocks still
   *   arrive, with an empty `thinking` field — so LC asks for `summarized` on
   *   those models. Opus 4.6 and Sonnet 4.6 predate the field and already
   *   summarize.
   */
  if (opts.reasoningEnabled && opts.reasoningEffort && opts.reasoningEffort !== 'none') {
    if (opts.isMetaAI) {
      // Meta Model API's Messages endpoint is an Anthropic-format adapter
      // over its Responses pipeline. Its documented reasoning shape is
      // `thinking: {type:'adaptive'}` + `output_config.effort` for depth,
      // which is also what returns a summarized (readable) thinking output.
      // The `enabled`/`budget_tokens` form is accepted "for compatibility"
      // but not translated into an effort value, so it silently ignores the
      // selected depth.
      //
      // Meta documents `low`, `medium`, `high`, and `xhigh` as passing
      // through; `max` is not on its ladder. The value still goes out
      // verbatim, exactly as the Chat Completions and Responses branches do —
      // Meta's ladder may grow, and an unsupported level is the provider's own
      // 400 to surface, not LC's to fold.
      // https://dev.meta.ai/docs/protocols/messages#reasoning
      // https://dev.meta.ai/docs/reasoning
      req.thinking = { type: 'adaptive' };
      req.output_config = {
        effort: opts.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
      };
    } else {
      const modelLower = model.toLowerCase();

      // --- Model detection ---
      // Parse versioned models: "claude-opus-4-6", "claude-sonnet-5", "claude-haiku-4-5", etc.
      const verMatch = modelLower.match(
        /claude[ .-]*(opus|sonnet|haiku)[ .-]*(\d+)(?:[.-](\d+))?/i,
      );
      const family = verMatch?.[1] ?? '';
      const major = verMatch ? Number(verMatch[2]) : 0;
      const minor = verMatch ? (verMatch[3] ? Number(verMatch[3]) : 0) : 0;

      // Fable / Mythos don't use the versioned naming convention.
      const isFable5 = modelLower.includes('fable') && modelLower.includes('5');
      const isMythos5 = modelLower.includes('mythos') && modelLower.includes('5');
      const isMythosPreview = modelLower.includes('mythos') && modelLower.includes('preview');

      // Version-based models.
      const isOpus46 = family === 'opus' && major === 4 && minor === 6;
      const isOpus47 = family === 'opus' && major === 4 && minor >= 7;
      const isSonnet46 = family === 'sonnet' && major === 4 && minor === 6;
      // Every Claude on a major version of 5 or later: adaptive thinking, full
      // effort ladder. Written per-family before, which silently excluded
      // `claude-opus-5` and sent it the budget_tokens shape the API rejects.
      const isMajor5Plus = major >= 5;

      // Adaptive thinking models (no budget_tokens).
      const isAdaptive = isFable5 || isMythos5 || isMythosPreview ||
        isMajor5Plus || isOpus46 || isOpus47 || isSonnet46;

      // Models that accept xhigh. `xhigh` is a newer level than `max`, so the
      // set is NOT "everything that takes max" — Mythos Preview and the 4.6
      // pair take `max` and reject `xhigh`, which is why they fold below.
      // https://platform.claude.com/docs/en/build-with-claude/effort#effort-levels
      const supportsXhigh = isFable5 || isMythos5 || isMajor5Plus || isOpus47;

      // Models whose `thinking.display` defaults to `omitted`. Currently the
      // same set as `supportsXhigh`, but tracked separately: these are two
      // independent provider facts and one may move without the other.
      const omitsThinkingByDefault = isFable5 || isMythos5 || isMythosPreview ||
        isMajor5Plus || isOpus47;

      // Budget mapping for models without adaptive thinking. `max` sits above
      // `xhigh` rather than tying with it, so the top of the ladder buys
      // something; the two were identical and `max` was a no-op.
      const BUDGET: Record<string, number> = {
        low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 24576,
      };

      if (isAdaptive) {
        req.thinking = {
          type: 'adaptive',
          ...(opts.isAnthropicOwnApi && omitsThinkingByDefault
            ? { display: 'summarized' as const }
            : {}),
        };
        let effort = opts.reasoningEffort;
        if (!supportsXhigh && effort === 'xhigh') {
          effort = 'max'; // Opus 4.6 / Sonnet 4.6 / Mythos Preview: xhigh → max
        }
        req.output_config = { effort };
      } else {
        // Haiku 4.5, Sonnet 4.5, Opus 4.5 and older, unknown models:
        // budget_tokens only. Haiku 4.5 was previously also sent
        // `output_config.effort`, which its capability report marks unsupported.
        const tied = resolveThinkingBudget(
          BUDGET[opts.reasoningEffort] ?? 4096,
          opts.maxTokens ?? opts.maxOutputTokens,
        );
        req.thinking = { type: 'enabled', budget_tokens: tied.budgetTokens };
        if (tied.maxTokens !== undefined) req.max_tokens = tied.maxTokens;
      }
    }
  } else if (opts.reasoningEnabled && opts.reasoningEffort === 'none') {
    if (opts.isMetaAI) {
      // Muse Spark cannot disable reasoning — `thinking: {type:'disabled'}`
      // returns HTTP 400. Omit the field and let it reason at its default
      // level rather than hard-failing the request.
      // https://dev.meta.ai/docs/protocols/messages#reasoning
    } else {
      // Models where thinking is ALWAYS on reject `disabled` with a 400:
      // Fable 5, Mythos 5, and Mythos Preview. Mythos Preview was missing
      // here while every other branch recognized it, so `none` effort sent it
      // the one value its own capability row rejects.
      // https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting#error-thinking-type-disabled
      //
      // Sonnet 5 is marked `On`, not `Always on`; Anthropic's current
      // "Turning thinking off" example explicitly sends `disabled` to it.
      // https://platform.claude.com/docs/en/build-with-claude/thinking#turning-thinking-off
      const modelLower = model.toLowerCase();
      const isFable5 = modelLower.includes('fable') && modelLower.includes('5');
      const isMythos5 = modelLower.includes('mythos') && modelLower.includes('5');
      const isMythosPreview = modelLower.includes('mythos') && modelLower.includes('preview');
      if (!isFable5 && !isMythos5 && !isMythosPreview) {
        req.thinking = { type: 'disabled' };
      }
    }
  }

  /**
   * Anthropic prompt caching is opt-in: with no `cache_control` the server
   * caches nothing and reports an explicit `0` for every counter. The
   * top-level form is the whole opt-in — the server places the breakpoint and
   * advances it, so LC inserts or moves none of its own (cache-observability.md §1).
   *
   * Anthropic's own API only, so a compatible server behaves exactly as before
   * (constraint 7) and MiniMax's explicit-cache surface stays unreachable
   * (cache-observability.md §3).
   */
  if (opts.isAnthropicOwnApi) {
    req.cache_control = { type: 'ephemeral' };
  }

  return req;
}

/** Parse an Anthropic named SSE event from raw text. */
function parseNamedEvent(raw: string): { event: string; data: string } | null {
  let event = '';
  const data: string[] = [];
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (!event || data.length === 0) return null;
  return { event, data: data.join('\n') };
}

/** Find the next SSE blank-line boundary across LF, CRLF, or CR framing. */
function findSSEBoundary(buffer: string): { index: number; length: number } | undefined {
  const lineEndingLength = (index: number): number => {
    if (buffer[index] === '\r') return buffer[index + 1] === '\n' ? 2 : 1;
    return buffer[index] === '\n' ? 1 : 0;
  };
  for (let index = 0; index < buffer.length; index++) {
    const first = lineEndingLength(index);
    if (!first) continue;
    const second = lineEndingLength(index + first);
    if (second) return { index, length: first + second };
    // Do not revisit the LF half of a CRLF as a separate line ending.
    index += first - 1;
  }
  return undefined;
}
