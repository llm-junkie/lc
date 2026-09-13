/**
 * OpenAI Responses API adapter. Handles request building with message→item
 * conversion, tool-call explosion for cross-API-style continuity, and SSE
 * streaming with typed named events.
 */

import type { ChatStreamAdapter, AdapterRequestParams, StreamCallbacks, StreamResult } from './adapter';
import type {
  ChatMessage, ResponsesRequest, ResponsesInputItem, ResponsesToolDef,
  ResponsesFunctionCallOutput, ResponsesInputReasoningItem, ResponsesOutputItem,
  ResponsesReasoningItem,
} from '../types';
import type { ToolCallWire } from '../tool-accumulator';
import { TOOL_CALL_ARGS_MAX_CHARS } from '../tool-accumulator.ts';
import { decodeSSE } from '../transport/sse-decoder.ts';
import { debugLog } from '../../../utils/debug.ts';
import {
  normalizeResponsesUsage,
  usageReporterForBaseUrl,
  type NormalizedUsage,
} from '../cache-usage.ts';
import {
  isDeepSeekEndpoint,
  projectAssistantProviderHistory,
  selectResponsesOutputItems,
} from '../../chat-pipeline/provider-history-projection.ts';
import { normalizeOpaqueReplayAccounting } from '../replay-accounting.ts';
import { applyProviderContractControls } from '../provider-contracts.ts';

/**
 * Re-expand LC's single assistant bubble into the response/tool-result order
 * represented by response-local replay groups. Responses input is a flat item
 * list, so emitting every saved output item before every tool result would
 * break a multi-round chain (`call 1, output 1, call 2, output 2`).
 */
export function expandResponsesToolRounds(
  messages: ChatMessage[],
  baseUrl?: string,
  model = '',
  providerContract?: AdapterRequestParams['providerContract'],
  providerContractStatus?: AdapterRequestParams['providerContractStatus'],
): ChatMessage[] {
  const expanded: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      expanded.push(message);
      continue;
    }
    const selectedItems = selectResponsesOutputItems(message, {
      baseUrl,
      model,
      providerContract,
      providerContractStatus,
    });
    const selectedIds = new Set(selectedItems.map((item) => item.id));
    const groups = (normalizeOpaqueReplayAccounting(message.opaque_replay_accounting, {
      responsesOutputItems: message.responses_output_items,
      responsesBaseUrl: baseUrl,
      responsesProviderContractId: providerContract?.contract.id,
      anthropicOutputBlocks: message.anthropic_output_blocks,
    }) ?? []).filter((group) => group.protocol === 'openai-responses'
      && group.locator.kind === 'responses-item-ids'
      && group.locator.itemIds.every((id) => selectedIds.has(id)));
    if (groups.length === 0) {
      expanded.push(message);
      continue;
    }
    const groupedCallIds = new Set(groups.flatMap((group) => group.toolCallIds ?? []));
    const groupedItemIds = new Set(groups.flatMap((group) => (
      group.locator.kind === 'responses-item-ids' ? group.locator.itemIds : []
    )));
    if (message.tool_calls.some((call) => !groupedCallIds.has(call.id))
      || selectedItems.some((item) => !groupedItemIds.has(item.id))) {
      // A legacy/partial association cannot be safely repartitioned. Keep the
      // established flat replay behavior rather than guessing boundaries.
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
    const itemById = new Map(selectedItems.map((item) => [item.id, item]));
    const hasProviderMessage = selectedItems.some((item) => item.type === 'message');
    const canonicalGroupIndex = hasProviderMessage ? -1 : groups.length - 1;
    const usedToolIds = new Set<string>();

    groups.forEach((group, groupIndex) => {
      const itemIds = group.locator.kind === 'responses-item-ids'
        ? group.locator.itemIds
        : [];
      const responseItems = itemIds
        .map((id) => itemById.get(id))
        .filter((item): item is ResponsesOutputItem => !!item);
      const calls = (group.toolCallIds ?? [])
        .map((id) => message.tool_calls!.find((call) => call.id === id))
        .filter((call): call is NonNullable<ChatMessage['tool_calls']>[number] => !!call);
      const content = groupIndex === canonicalGroupIndex ? message.content : '';
      if (responseItems.length > 0 || calls.length > 0
        || (typeof content === 'string' && content.length > 0)) {
        expanded.push({
          ...message,
          content,
          tool_calls: calls.length > 0 ? calls : undefined,
          responses_output_items: responseItems.length > 0 ? responseItems : undefined,
          opaque_replay_accounting: [{
            ...group,
            locator: {
              kind: 'responses-item-ids',
              itemIds: responseItems.map((item) => item.id),
            },
          }],
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

export class OpenAIResponsesAdapter implements ChatStreamAdapter {
  readonly protocol = 'openai' as const;
  readonly streamEndpoint = '/responses';

  /**
   * Retained only to label cache counters as router-reported when the server
   * is OpenRouter. It is never used to infer an upstream provider (cache-observability.md §3).
   */
  private readonly baseUrl?: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl;
  }

  // ── buildRequest ──────────────────────────────────────────────
  // Converts ChatMessage[] → ResponsesInputItem[].
  //
  // Mapping rules:
  //   system message         → top-level `instructions`
  //   tool message           → function_call_output item
  //   assistant message      → message item + function_call items (for tool_calls)
  //   user message           → message item
  //
  // The tool_calls explosion is critical for cross-API-style
  // conversation continuity (switching Chat Completions ↔ Responses
  // mid-conversation).

  buildRequest(params: AdapterRequestParams): ResponsesRequest {
    const items: ResponsesInputItem[] = [];
    let instructions: string | undefined;
    // Direct adapter callers retain the pre-registry DeepSeek fixture behavior.
    // Real LLMClient requests use exact contract identity and do not apply
    // Chat's tools-only rule to the Responses surface.
    const isDeepSeek = params.providerContract?.contract.id === 'deepseek.responses'
      || (params.providerContractStatus === undefined && isDeepSeekEndpoint(params.baseUrl));
    const legacyDeepSeekToolFilter = isDeepSeek && params.providerContractStatus === undefined;

    const projectedMessages = expandResponsesToolRounds(
      params.messages,
      params.baseUrl,
      params.model,
      params.providerContract,
      params.providerContractStatus,
    );
    for (const m of projectedMessages) {
      if (m.role === 'system' || m.role === 'developer') {
        const text = typeof m.content === 'string' ? m.content : '';
        instructions = instructions ? `${instructions}\n${text}` : text;
        continue;
      }
      if (m.role === 'tool' && m.tool_call_id) {
        items.push({
          type: 'function_call_output',
          call_id: m.tool_call_id,
          output: typeof m.content === 'string' ? m.content : '',
        } as ResponsesFunctionCallOutput);
        continue;
      }
      if (m.role === 'assistant') {
        const hasToolCalls = (m.tool_calls?.length ?? 0) > 0;
        // Prior Responses output items, including encrypted or plaintext
        // reasoning, are replay state when the client manages history itself.
        // Do not synthesize a duplicate message item when the full response
        // is available; preserve the provider's original item order.
        const replay = selectResponsesOutputItems(m, {
          baseUrl: params.baseUrl,
          model: params.model,
          providerContract: params.providerContract,
          providerContractStatus: params.providerContractStatus,
        })
          .flatMap((item): ResponsesInputItem[] => {
          if (item.type === 'reasoning') {
            // The unmatched fallback is deliberately structural: selection
            // above already proved exact source Base URL + model provenance,
            // so replay the provider item without rewriting its schema. Some
            // compatible servers require output fields that OpenAI treats as
            // optional input metadata. The verified LM Studio server, for
            // example, rejects its own item when LC removes `summary: []`.
            if (params.providerContractStatus === 'unmatched') return [item];
            const replayed = replayReasoningItem(
              item,
              isDeepSeek,
              !legacyDeepSeekToolFilter || hasToolCalls,
            );
            return replayed ? [replayed] : [];
          }
          return [item as ResponsesInputItem];
          });
        // Cross-protocol plaintext fallback for cases where no reasoning
        // item survives replay — a turn generated over Chat Completions or the
        // Anthropic Messages API before the profile switched to Responses, or
        // history saved before LC persisted output items. The resolved
        // contract decides whether canonical reasoning belongs in this
        // request. Reasoning precedes the assistant message.
        const providerProjection = projectAssistantProviderHistory(m, {
          protocol: 'openai-responses',
          model: params.model,
          baseUrl: params.baseUrl,
          requestHasTools: (params.tools?.length ?? 0) > 0,
          providerContract: params.providerContract,
          providerContractStatus: params.providerContractStatus,
        });
        if (providerProjection.useCanonicalReasoning && m.reasoning_content?.trim()
            && !replay.some((item) => item.type === 'reasoning')) {
          items.push(plainTextReasoningItem(m.reasoning_content));
        }
        if (replay.length > 0) {
          // The orchestrator may normalize archived tool-call IDs (for
          // example, to `archived_<assistant-id>`). Preserve the saved
          // reasoning/message items, but rebuild function_call items from
          // the current assistant tool_calls when they no longer match.
          // Comparison is by MULTISET, not by set: two raw function_call
          // items sharing one call_id are two items on the wire, and a
          // set-based check would replay both while the normalized calls
          // hold one — the duplicate pairing shape this protocol forbids.
          const replayCallCounts = new Map<string, number>();
          for (const item of replay) {
            if (item.type === 'function_call') {
              replayCallCounts.set(item.call_id, (replayCallCounts.get(item.call_id) ?? 0) + 1);
            }
          }
          const currentToolCalls = m.tool_calls ?? [];
          const currentCounts = new Map<string, number>();
          for (const tc of currentToolCalls) {
            currentCounts.set(tc.id, (currentCounts.get(tc.id) ?? 0) + 1);
          }
          const toolCallsMatch = currentCounts.size === replayCallCounts.size
            && [...currentCounts.entries()].every(([id, count]) => replayCallCounts.get(id) === count);
          if (currentToolCalls.length > 0 && !toolCallsMatch) {
            items.push(
              ...replay.filter((item) => item.type !== 'function_call'),
              ...currentToolCalls.map((tc) => ({
                type: 'function_call' as const,
                call_id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              })),
            );
          } else {
            items.push(...replay);
          }
          continue;
        }
        // Push the message text
        const content = typeof m.content === 'string'
          ? (m.content || m.refusal || '')
          : m.content.map(p => {
              if ('image_url' in p) {
                return { type: 'input_image' as const, image_url: p.image_url.url };
              }
              return { type: 'input_text' as const, text: p.text };
            });
        items.push({ type: 'message', role: 'assistant', content } as ResponsesInputItem);
        // Explode embedded tool_calls into separate function_call items
        for (const tc of (m.tool_calls ?? [])) {
          items.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          } as ResponsesInputItem);
        }
        continue;
      }
      // user message
      const content = typeof m.content === 'string'
        ? m.content
        : m.content.map(p => {
            if ('image_url' in p) {
              return { type: 'input_image' as const, image_url: p.image_url.url };
            }
            return { type: 'input_text' as const, text: p.text };
          });
      items.push({ type: 'message', role: m.role as 'user', content } as ResponsesInputItem);
    }

    // Map tool definitions: externally tagged → internally tagged
    const tools: ResponsesToolDef[] | undefined = params.tools?.map(t => ({
      type: 'function' as const,
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));

    const req: ResponsesRequest = {
      model: params.model,
      input: items.length === 1 && items[0].type === 'message'
        && (items[0] as ResponsesInputItem & { role: string }).role === 'user'
        && typeof (items[0] as ResponsesInputItem & { content: unknown }).content === 'string'
        ? (items[0] as ResponsesInputItem & { content: string }).content  // simple string shortcut
        : items,
      stream: params.stream,
    };

    if (instructions) req.instructions = instructions;
    if (params.maxTokens !== undefined) req.max_output_tokens = params.maxTokens;
    if (params.temperature !== undefined) req.temperature = params.temperature;
    if (params.topP !== undefined) req.top_p = params.topP;
    if (tools?.length) req.tools = tools;
    if (params.providerContract) {
      applyProviderContractControls(
        req as unknown as Record<string, unknown>,
        params.providerContract,
        {
          reasoningEnabled: params.reasoningEnabled,
          reasoningEffort: params.reasoningEffort,
        },
      );
      // A readable summary is a presentation request, not replay state. The
      // contract decides separately whether returned summary/items replay.
      if (params.reasoningEnabled && params.reasoningEffort && req.reasoning) {
        req.reasoning.summary = 'auto';
      }
    } else if (params.providerContractStatus !== 'unmatched'
      && params.reasoningEnabled && params.reasoningEffort) {
      req.reasoning = {
        // The effort level passes through verbatim — including `max`. Meta's
        // current Responses `reasoning.effort` enum tops out at `xhigh`, but
        // LC does not fold the value down: Meta's ladder may grow, and an
        // unsupported level is the provider's own 400 to surface, not LC's to
        // guess around.
        // https://dev.meta.ai/docs/api-reference/responses/schemas  (ReasoningEffort)
        effort: params.reasoningEffort as 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
        // Request reasoning summaries so the server emits response.reasoning_text.delta
        // and response.reasoning_summary_text.delta events.  Without `summary` the
        // OpenAI API does not expose any reasoning content in the stream.
        // https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries
        summary: 'auto',
      };
    } else if (params.providerContractStatus === 'unmatched') {
      // The base Responses request works without `reasoning`. Compatible
      // implementations disagree on the accepted shape and values, so an
      // unlisted endpoint receives no invented reasoning control.
    }
    // Explicitly opt out of server-side storage — LC manages state itself.
    req.store = false;

    return req;
  }

  // ── buildHeaders ──────────────────────────────────────────────

  buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  // ── parseStream ───────────────────────────────────────────────
  // SSE format: typed named events (response.output_text.delta etc.)
  // Key difference from Chat Completions: each event has an explicit
  // `type` field. Tool calls use item_id-based accumulation (not
  // index-based like Chat Completions).

  async parseStream(
    body: ReadableStream<Uint8Array>,
    callbacks: StreamCallbacks,
    timeoutMs: number,
    _toolAcc: unknown,
  ): Promise<StreamResult> {
    const contentChunks: string[] = [];
    const reasoningChunks: string[] = [];
    // Tool-call accumulator with item_id → call_id mapping.
    // call_id is the durable identity used to link function_call_output items
    // across conversation turns. item_id is the transient streaming index.
    // We resolve item_id → call_id via output_item.added events, then
    // accumulate arguments under call_id so the final ToolCallWire.id is
    // always the call_id (not the item_id).
    const itemToCallId = new Map<string, string>();
    const accByCallId = new Map<string, { name: string; args: string; argsCapped?: boolean }>();
    // Held raw so the terminal Responses usage envelope — including explicit
    // zeroes in `input_tokens_details` — is normalized exactly once.
    let rawUsage: unknown;
    let finishReason: string | undefined;
    let providerFinishReason: string | undefined;
    let errorMessage: string | undefined;
    let refusal: string | undefined;
    let completedOutputItems: ResponsesOutputItem[] | undefined;
    const streamedOutputItems = new Map<number, ResponsesOutputItem>();
    let timedOut = false;

    try {
      for await (const item of decodeSSE(body, { idleTimeoutMs: timeoutMs })) {
        if (item.type === 'issue') continue;
        const raw = item.event.data?.trim();
        if (!raw || raw === '[DONE]') continue;

        // Parse the JSON data body. OpenAI puts the event type in `type`, but
        // retain the SSE event field as a fallback for compatible servers.
        const parsed = parseResponsesEvent(raw, item.event.event);
        if (!parsed) continue;

        try {
          const eventType = parsed.event;
          const payload = parsed.data;

          // ── DEBUG: log raw SSE events ──
          if (import.meta.env?.DEV) {
            const reason = eventType.includes('reasoning') ? ' 🧠' : '';
            debugLog.log(`[LC] Responses SSE${reason} type=${eventType}`, JSON.stringify(payload).slice(0, 400));
          }

          switch (eventType) {
            // `response.content_part.delta` is OpenRouter's spelling for a text
            // chunk. OpenAI-compatible implementations commonly use
            // `response.output_text.delta`; accept both documented carrier
            // names without inferring that a provider can emit only one. This
            // keeps the parser structural and makes the adapter serve the whole
            // Responses family rather than one vendor. Without the OpenRouter
            // case a documented OpenRouter stream parsed to an empty assistant
            // message.
            // https://openrouter.ai/docs/api_reference/responses/basic-usage
            case 'response.output_text.delta':
            case 'response.content_part.delta':
              if (typeof payload.delta === 'string' && payload.delta.length > 0) {
                contentChunks.push(payload.delta);
                callbacks.onDelta(payload.delta);
              }
              break;

            // Three spellings of a reasoning chunk across the family: OpenAI's
            // summary and text variants, and OpenRouter's `response.reasoning.delta`.
            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning.delta':
              if (typeof payload.delta === 'string' && payload.delta.length > 0) {
                reasoningChunks.push(payload.delta);
                callbacks.onReasoning?.(payload.delta);
              }
              break;

            case 'response.refusal.delta':
              if (typeof payload.delta === 'string') {
                refusal = (refusal ?? '') + payload.delta;
                callbacks.onRefusal?.(payload.delta);
              }
              break;

            case 'response.refusal.done':
              // The done event repeats the completed refusal after its deltas.
              // Only use it when no delta events were sent.
              if (!refusal && typeof payload.refusal === 'string') {
                refusal = payload.refusal;
                callbacks.onRefusal?.(payload.refusal);
              }
              break;

            case 'response.reasoning_summary_part.added':
              // Inject a blank-line separator between consecutive
              // summary parts so the reasoning tab renders each
              // part as a separate paragraph instead of running
              // them together (e.g. "...contents.**Inspecting...").
              // summary_index is 0-based; skip separator for the
              // very first part of each reasoning item.
              if (
                reasoningChunks.length > 0
                && typeof payload.summary_index === 'number'
                && payload.summary_index > 0
              ) {
                reasoningChunks.push('\n\n');
                callbacks.onReasoning?.('\n\n');
              }
              break;

            case 'response.function_call_arguments.delta': {
              const itemId = payload.item_id;
              if (typeof itemId !== 'string' || itemId.length === 0) break;
              callbacks.onToolCall?.();
              // Resolve item_id → call_id so arguments accumulate under the
              // durable call_id (used by function_call_output for linking).
              const callId = itemToCallId.get(itemId) ?? itemId;
              const slot = accByCallId.get(callId) ?? { name: '', args: '' };
              const fragment: string = payload.delta ?? '';
              if (fragment.length > 0) {
                if (slot.argsCapped || slot.args.length >= TOOL_CALL_ARGS_MAX_CHARS) {
                  slot.argsCapped = true;
                } else {
                  const room = TOOL_CALL_ARGS_MAX_CHARS - slot.args.length;
                  slot.args += fragment.slice(0, room);
                  // Inclusive cap, same rule as ToolCallAccumulator: landing
                  // exactly on it is valid only if nothing further arrived.
                  if (fragment.length > room || slot.args.length > TOOL_CALL_ARGS_MAX_CHARS) {
                    slot.argsCapped = true;
                  }
                }
              }
              accByCallId.set(callId, slot);
              break;
            }

            case 'response.function_call_arguments.done': {
              const itemId = payload.item_id;
              if (typeof itemId !== 'string' || itemId.length === 0) break;
              callbacks.onToolCall?.();
              const callId = itemToCallId.get(itemId) ?? itemId;
              // The terminal `arguments` value is authoritative over any
              // delta accumulation — except when the delta path already hit
              // the cap. A stream that exceeded the bound was truncated, and
              // no later terminal event can be trusted to restore the real
              // input: the slot stays dropped.
              const existing = accByCallId.get(callId);
              if (existing?.argsCapped) break;
              // The terminal value is bounded too: a provider sending a
              // single oversized arguments blob cannot bypass the cap the
              // delta path enforces.
              const args = payload.arguments ?? '';
              const capped = args.length > TOOL_CALL_ARGS_MAX_CHARS;
              accByCallId.set(callId, {
                name: payload.name ?? existing?.name ?? '',
                args: capped ? args.slice(0, TOOL_CALL_ARGS_MAX_CHARS) : args,
                ...(capped ? { argsCapped: true } : {}),
              });
              break;
            }

            // `response.done` is OpenRouter's terminal event and carries the
            // same `response.output` / `response.usage` payload OpenAI puts on
            // `response.completed`. Without it the turn ended with no finish
            // reason and no usage at all.
            // https://openrouter.ai/docs/api_reference/responses/basic-usage
            case 'response.done':
            case 'response.completed':
              providerFinishReason = eventType;
              if (Array.isArray(payload.response?.output)) {
                completedOutputItems = payload.response.output as ResponsesOutputItem[];
              }
              if (payload.response?.usage
                && normalizeResponsesUsage(
                  payload.response.usage,
                  usageReporterForBaseUrl(this.baseUrl),
                ) !== undefined) {
                // Keep a prior usable provider report when a compatible
                // server follows it with an empty or malformed restatement.
                rawUsage = payload.response.usage;
              }
              // Extract tool calls, final text, and reasoning summaries
              // from the completed response's output array. LM Studio
              // returns function_call items here rather than as streaming
              // deltas.  OpenAI also returns reasoning items with summary
              // arrays here (not as streaming deltas).
              if (payload.response?.output) {
                const receivedStreamedText = contentChunks.length > 0;
                for (const item of payload.response.output) {
                  if (item.type === 'function_call' && item.name) {
                    callbacks.onToolCall?.();
                    // Use call_id as the primary identity — it is the durable
                    // identifier that function_call_output items reference.
                    const callId = item.call_id || item.id || `fc_${accByCallId.size}`;
                    if (!accByCallId.has(callId)) {
                      const args = typeof item.arguments === 'string' ? item.arguments : '{}';
                      const capped = args.length > TOOL_CALL_ARGS_MAX_CHARS;
                      accByCallId.set(callId, {
                        name: item.name,
                        args: capped ? args.slice(0, TOOL_CALL_ARGS_MAX_CHARS) : args,
                        ...(capped ? { argsCapped: true } : {}),
                      });
                    }
                  }
                  // Extract final text from message items (for re-stream responses)
                  if (item.type === 'message' && item.content) {
                    for (const part of item.content) {
                      if (part.type === 'output_text' && part.text && !receivedStreamedText) {
                        contentChunks.push(part.text);
                      }
                      if (part.type === 'refusal' && typeof part.refusal === 'string' && !refusal) {
                        refusal = part.refusal;
                        callbacks.onRefusal?.(part.refusal);
                      }
                    }
                  }
                  // Extract reasoning text from reasoning output items.
                  // OpenAI returns summaries in item.summary[] (array of
                  // { type: "summary_text", text: "..." }) when
                  // reasoning.summary is requested; DeepSeek returns the
                  // chain-of-thought in item.content[] as reasoning_text parts.
                  // Only used as a fallback when streaming deltas didn't
                  // populate reasoningChunks (e.g. LM Studio re-stream).
                  if (item.type === 'reasoning' && reasoningChunks.length === 0) {
                    const text = displayReasoningText(item);
                    if (text) {
                      reasoningChunks.push(text);
                      callbacks.onReasoning?.(text);
                    }
                  }
                }
              }
              finishReason = 'stop';
              break;

            case 'response.output_item.done':
              if (typeof payload.output_index === 'number' && payload.item) {
                streamedOutputItems.set(payload.output_index, payload.item as ResponsesOutputItem);
              }
              // LM Studio may emit function_call metadata in output_item.done
              if (payload.item?.type === 'function_call' && payload.item?.name) {
                callbacks.onToolCall?.();
                const callId = payload.item.call_id || payload.item.id || `fc_${accByCallId.size}`;
                const existing = accByCallId.get(callId) ?? { name: '', args: '' };
                existing.name = payload.item.name || existing.name;
                if (typeof payload.item.arguments === 'string') {
                  const args = payload.item.arguments;
                  const capped = args.length > TOOL_CALL_ARGS_MAX_CHARS;
                  existing.args = capped ? args.slice(0, TOOL_CALL_ARGS_MAX_CHARS) : args;
                  if (capped) existing.argsCapped = true;
                }
                accByCallId.set(callId, existing);
              }
              // Extract reasoning text from reasoning items.
              // OpenAI returns { type: "reasoning", summary: [{ type: "summary_text", text: "..." }] }
              // when reasoning.summary is requested; DeepSeek returns
              // { type: "reasoning", content: [{ type: "reasoning_text", text: "..." }] }.
              // Only used as a fallback when streaming deltas didn't
              // populate reasoningChunks (e.g. LM Studio re-stream).
              if (payload.item?.type === 'reasoning' && reasoningChunks.length === 0) {
                const text = displayReasoningText(payload.item);
                if (text) {
                  reasoningChunks.push(text);
                  callbacks.onReasoning?.(text);
                }
              }
              break;

            case 'response.failed':
              providerFinishReason = 'response.failed';
              finishReason = 'error';
              errorMessage = payload.response?.error?.message
                ?? payload.response?.status_details?.error?.message
                ?? payload.error?.message
                ?? 'Response failed (server-side error)';
              break;

            case 'response.incomplete': {
              const reason = payload.response?.incomplete_details?.reason;
              providerFinishReason = reason
                ? `response.incomplete (${reason})`
                : 'response.incomplete';
              // `incomplete_details.reason` is `max_output_tokens` or
              // `content_filter`. Collapsing both to `length` labelled a
              // filtered response "✂ truncated", which tells the user to raise
              // a limit that was never the cause. An unrecognized future
              // reason still falls back to `length` — that is the one this
              // event was introduced for.
              // https://developers.openai.com/api/docs/guides/reasoning
              finishReason = reason === 'content_filter' ? 'content_filter' : 'length';
              break;
            }

            case 'error':
              // OpenAI's `error` event carries its fields at the TOP LEVEL —
              // `{type, code, message, param, sequence_number}` — not nested
              // under `error`. Reading only the nested form meant an OpenAI
              // stream error surfaced as a JSON dump of the whole event instead
              // of the provider's own sentence.
              //
              // The nested form is still accepted second as a COMPATIBILITY
              // fallback, not because a provider documents it on this envelope:
              // OpenAI's Chat Completions streaming reference documents an
              // optional `chunk.moderation`; its `input` and `output` are each
              // a union of moderation results or `{type:'error',code,message}`.
              // It defines no top-level `chunk.error` or global nested SSE error
              // event. LC's Chat Completions path has long carried the same
              // tolerance without a cited source. Treat this branch as
              // undocumented legacy tolerance:
              // cheap to keep, pinned by a regression test, and attributable
              // to no provider's published contract.
              // https://developers.openai.com/api/reference/resources/responses/streaming-events
              // https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events
              throw new Error(
                `Responses API error: ${payload.message ?? payload.error?.message ?? JSON.stringify(payload)}`,
              );

            // informational events — no action needed
            case 'response.created':
            case 'response.in_progress':
            case 'response.output_text.done':
            case 'response.reasoning_text.done':
            case 'response.reasoning_summary_text.done':
            case 'response.reasoning_summary_part.done':
            case 'response.content_part.added':
            case 'response.content_part.done':
              break;

            // Capture function_call item metadata (name, call_id) from
            // response.output_item.added — emitted BEFORE the arguments
            // delta stream begins. The call_id is needed for proper linking
            // with function_call_output items in the re-stream.
            case 'response.output_item.added':
              if (typeof payload.output_index === 'number' && payload.item) {
                streamedOutputItems.set(payload.output_index, payload.item as ResponsesOutputItem);
              }
              if (payload.item?.type === 'function_call' && payload.item?.name) {
                callbacks.onToolCall?.();
                const callId = payload.item.call_id || payload.item.id;
                if (callId) {
                  // Remember the item_id → call_id mapping so streaming
                  // deltas (which reference item_id) resolve to the
                  // correct call_id-keyed accumulator slot.
                  if (payload.item.id) itemToCallId.set(payload.item.id, callId);
                  const existing = accByCallId.get(callId) ?? { name: '', args: '' };
                  existing.name = payload.item.name || existing.name;
                  accByCallId.set(callId, existing);
                }
              }
              break;
          }
        } catch (e) {
          if ((e as Error).message.startsWith('Responses API error:')) throw e;
          // Skip unparseable events
        }
        }
    } catch (e) {
      if ((e as Error).message.startsWith('Responses API error:')) throw e;
      debugLog.warn('[LC] Responses SSE read aborted:', (e as Error).message || e);
      timedOut = true;
    }

    if (timedOut && !finishReason) {
      finishReason = 'disconnected';
    }

    // Finalize tool calls from internal accumulator — keyed by call_id
    // so the resulting ToolCallWire.id matches the call_id that
    // function_call_output items reference.
    const toolCalls: ToolCallWire[] = [];
    let droppedCapped = false;
    for (const [id, slot] of accByCallId) {
      if (slot.name && !slot.argsCapped) {
        toolCalls.push({
          id,
          type: 'function',
          function: { name: slot.name, arguments: slot.args || '{}' },
        });
      } else if (slot.name && slot.argsCapped) {
        // The argument stream exceeded the accumulator cap; the truncated
        // text is not valid JSON and must never be executed. Terminal
        // policy: the whole provider turn terminates in error — no sibling
        // executes, and the provider's raw output items are suppressed so
        // no unresolved function_call is ever replayed without its
        // function_call_output.
        droppedCapped = true;
        errorMessage = errorMessage
          ?? `tool_call ${id} argument stream exceeded ${TOOL_CALL_ARGS_MAX_CHARS} characters — call dropped`;
      }
    }
    if (droppedCapped) {
      finishReason = 'error';
    } else if (toolCalls.length > 0 && finishReason === 'stop') {
      finishReason = 'tool_calls';
    }

    const usage: NormalizedUsage | undefined = normalizeResponsesUsage(
      rawUsage,
      usageReporterForBaseUrl(this.baseUrl),
    );

    return {
      content: contentChunks.join(''),
      usage,
      finish_reason: finishReason,
      provider_finish_reason: providerFinishReason,
      error_message: errorMessage,
      refusal,
      // A capped turn executes nothing: valid siblings are suppressed too.
      tool_calls: droppedCapped ? undefined : (toolCalls.length > 0 ? toolCalls : undefined),
      // A capped turn must not hand the orchestrator raw output items: they
      // would be persisted and replayed as unresolved function_call items.
      responses_output_items: droppedCapped ? undefined : (
        completedOutputItems
          ?? [...streamedOutputItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
      ),
    };
  }
}

/** A reasoning item LC can replay, or null when nothing usable survives.
 *
 *  OpenAI returns opaque `encrypted_content` and only recommends replaying it.
 *  Compatible Responses servers can instead return chain-of-thought as plain
 *  `reasoning_text` parts; LC preserves those provider items without guessing
 *  from the model name or hostname. DeepSeek does not support `summary` or
 *  `encrypted_content` inside an input reasoning item. Its Responses page does
 *  not apply Chat's tools-dependent history rule. Matched contracts therefore
 *  replay these items on every prior turn; the boolean fallback exists only
 *  for direct pre-registry adapter fixtures.
 *  https://api-docs.deepseek.com/guides/responses_api  (Input Items)
 *  https://api-docs.deepseek.com/guides/thinking_mode#tool-calls
 *  https://developers.openai.com/api/docs/guides/reasoning#keeping-reasoning-items-in-context
 */
function replayReasoningItem(
  item: ResponsesReasoningItem,
  isDeepSeek: boolean,
  plaintextReplayAllowed: boolean,
): ResponsesInputReasoningItem | null {
  if (isDeepSeek) {
    if (!plaintextReplayAllowed) return null;
    const text = reasoningItemText(item);
    return text.trim() ? plainTextReasoningItem(text, item.id) : null;
  }
  if (item.encrypted_content) {
    return {
      type: 'reasoning',
      id: item.id,
      encrypted_content: item.encrypted_content,
      ...(item.summary ? { summary: item.summary } : {}),
    };
  }
  const text = reasoningItemText(item);
  return text.trim() ? plainTextReasoningItem(text, item.id) : null;
}

/** Wrap plain-text chain-of-thought in a reasoning input item. `id` is omitted
 *  for text recovered from a non-Responses turn, which has no item ID. */
function plainTextReasoningItem(text: string, id?: string): ResponsesInputReasoningItem {
  return {
    type: 'reasoning',
    ...(id ? { id } : {}),
    content: [{ type: 'reasoning_text', text }],
  };
}

/** Concatenate the `reasoning_text` parts of a reasoning item. Parts arrive
 *  straight off the wire, so each one is shape-checked. */
function reasoningItemText(item: { content?: unknown[] }): string {
  if (!Array.isArray(item.content)) return '';
  return item.content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const { type, text } = part as { type?: unknown; text?: unknown };
      return type === 'reasoning_text' && typeof text === 'string' ? text : '';
    })
    .join('');
}

/** Human-readable reasoning carried on a reasoning item: OpenAI puts it in
 *  `summary[]` as `summary_text` parts; compatible Responses servers may put
 *  full plaintext in `content[]` as `reasoning_text` parts. */
function displayReasoningText(item: { summary?: unknown[]; content?: unknown[] }): string {
  if (Array.isArray(item.summary)) {
    const texts = item.summary
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const { type, text } = part as { type?: unknown; text?: unknown };
        return type === 'summary_text' && typeof text === 'string' ? text : '';
      })
      .filter(Boolean);
    if (texts.length > 0) return texts.join('\n\n');
  }
  return reasoningItemText(item);
}

/** Parse a single SSE event block into its event type + data payload.
 *  The Responses API sends the type inside the JSON data body
 *  (`data: {"type":"response.output_text.delta",...}`), NOT as an
 *  `event:` SSE line. We extract from the data body, falling back
 *  to the `event:` line if present (future-proofing). */
interface ResponsesEventItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
  summary?: Array<{ type?: string; text?: string }>;
}

interface ResponsesEventPayload {
  type?: string;
  delta?: string;
  refusal?: string;
  item_id?: string;
  output_index?: number;
  summary_index?: number;
  name?: string;
  arguments?: string;
  item?: ResponsesEventItem;
  /** OpenAI's top-level `error`-event fields. */
  message?: string;
  code?: string | null;
  param?: string | null;
  /** Undocumented nested form. No provider documents it on this envelope;
   *  it is a legacy compatibility fallback, pinned by a regression test. */
  error?: { message?: string };
  response?: {
    /** Normalized by `normalizeResponsesUsage`, which owns field validation. */
    usage?: Record<string, unknown>;
    output?: ResponsesOutputItem[];
    error?: { message?: string };
    status_details?: { error?: { message?: string } };
    incomplete_details?: { reason?: string };
  };
}

function parseResponsesEvent(dataStr: string, eventFromLine?: string): { event: string; data: ResponsesEventPayload } | null {
  if (!dataStr || dataStr === '[DONE]') return null;
  try {
    const parsed = JSON.parse(dataStr);
    // Prefer the `type` field from the JSON data body (OpenAI format),
    // fall back to the `event:` SSE line.
    const event = (parsed && typeof parsed.type === 'string') ? parsed.type : eventFromLine;
    if (!event) return null;
    return { event, data: parsed as ResponsesEventPayload };
  } catch {
    return null;
  }
}
