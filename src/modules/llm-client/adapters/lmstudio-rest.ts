/**
 * LM Studio native REST adapter. Uses named SSE events (event: chat.start,
 * event: message.delta, event: chat.end) — fundamentally different from
 * the OpenAI-compat raw `data:` lines.
 *
 * This endpoint validates the request body against the running server's own
 * schema, so it rejects a field the compatible endpoints would have accepted.
 * Two rejections are routine rather than exceptional: the text input item type
 * below, and a `reasoning` value outside the loaded model's
 * `capabilities.reasoning.allowed_options`. `client.ts` answers both by
 * rebuilding the request from what the error names — see `nativeCorrection`.
 *
 * Reference: https://lmstudio.ai/docs/developer/rest
 */

import type { ChatStreamAdapter, AdapterRequestParams, StreamCallbacks, StreamResult } from './adapter';
import type { LMChatRequest, LMChatStats } from '../types';
import type { ToolCallAccumulator } from '../tool-accumulator';
import { decodeSSE } from '../transport/sse-decoder.ts';
import { debugLog } from '../../../utils/debug.ts';

/** Discriminator a LM Studio build accepts on a text input item. */
export type NativeTextItemType = 'text' | 'message';

export class LMStudioRestAdapter implements ChatStreamAdapter {
  readonly protocol = 'lmstudio-rest' as const;
  readonly streamEndpoint = '/chat';

  /**
   * LM Studio builds disagree about this value. Shipped servers validate the
   * input union as `'text' | 'image'` and reject `'message'` with a 400
   * `invalid_union`; the current native chat page documents `'message'`.
   * `text` is therefore the default — it is what a released server accepts —
   * and `useTextItemType` switches after a server names the other value.
   */
  private textItemType: NativeTextItemType = 'text';

  /** The discriminator this adapter currently sends. */
  get inputTextItemType(): NativeTextItemType {
    return this.textItemType;
  }

  /**
   * Adopt the discriminator a server named in an `invalid_union` rejection.
   * Instance state, so it holds for every later request from the same client
   * but never leaks across clients or servers.
   */
  useTextItemType(type: NativeTextItemType): void {
    this.textItemType = type;
  }

  buildRequest(params: AdapterRequestParams): LMChatRequest {
    // System prompt: pull from the first system message (LM Studio REST
    // expects it as a top-level field, not an input item).
    const systemMsg = params.messages.find(m => m.role === 'system');

    // Native REST is stateful. It accepts the current user input, not an
    // OpenAI-style transcript containing assistant and system messages.
    const latestUser = [...params.messages].reverse().find(m => m.role === 'user');
    const previousAssistant = [...params.messages].reverse().find(m => m.role === 'assistant');
    const previousResponseId = previousAssistant?.lmstudio_response_id;

    // LM Studio REST input: one item per current-user content part.
    // Text parts  → { type: <this.textItemType>, content: "..." }
    // Image parts → { type: "image",             data_url: "data:image/...;base64,..." }
    const textType = this.textItemType;
    const inputParts: NonNullable<LMChatRequest['input']> = !latestUser ? [] : (() => {
      if (typeof latestUser.content === 'string') {
        return [{ type: textType, content: latestUser.content }];
      }
      return latestUser.content.map((p): { type: NativeTextItemType; content: string } | { type: 'image'; data_url: string } => {
        if (p.type === 'text') {
          return { type: textType, content: p.text };
        }
        if (p.type === 'image_url') {
          return { type: 'image' as const, data_url: p.image_url.url };
        }
        return { type: textType, content: '' };
      });
    })();

    const req: LMChatRequest = {
      model: params.model,
      input: inputParts,
      stream: params.stream,
    };
    if (previousResponseId) req.previous_response_id = previousResponseId;
    if (!previousResponseId && systemMsg && typeof systemMsg.content === 'string') {
      req.system_prompt = systemMsg.content;
    }
    if (params.maxTokens) req.max_output_tokens = params.maxTokens;
    if (params.temperature !== undefined) req.temperature = params.temperature;
    if (params.topP !== undefined) req.top_p = params.topP;
    if (params.topK !== undefined) req.top_k = params.topK;
    if (params.repeatPenalty !== undefined) req.repeat_penalty = params.repeatPenalty;
    if (params.stopSequences) req.stop = params.stopSequences;
    // No tools — LM Studio REST does not support tool calling

    // Reasoning: scalar string from unified effort.
    // LM Studio REST only guarantees 'off' and 'on' across all models;
    // 'low'/'medium'/'high' are model-specific. Default to 'on' (the
    // safest maximal setting) — if the server rejects it we fall back
    // to omitting reasoning entirely (handled in client.ts).
    if (params.reasoningEnabled && params.reasoningEffort) {
      const map: Record<string, NonNullable<LMChatRequest['reasoning']>> = {
        'none': 'off', 'off': 'off', 'on': 'on', 'low': 'low', 'medium': 'medium',
        'high': 'high', 'xhigh': 'high', 'max': 'on',
      };
      req.reasoning = map[params.reasoningEffort] || 'on';
    }

    return req;
  }

  buildHeaders(apiKey: string): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'http://localhost',
    };
    if (apiKey) h.Authorization = `Bearer ${apiKey}`;
    return h;
  }

  async parseStream(
    body: ReadableStream<Uint8Array>,
    callbacks: StreamCallbacks,
    timeoutMs: number,
    _toolAcc: ToolCallAccumulator,
  ): Promise<StreamResult> {
    const fullChunks: string[] = [];
    let stats: LMChatStats | undefined;
    let finishReason: string | undefined;
    let providerFinishReason: string | undefined;
    let errorMessage: string | undefined;
    let gotError = false;
    let timedOut = false;
    let gotChatEnd = false;
    let responseId: string | undefined;

    const applyEvent = (eventName: string, payload: LMStudioNativeEvent): void => {
      switch (eventName) {
        case 'message.delta':
          if (payload.content) {
            fullChunks.push(payload.content);
            callbacks.onDelta(payload.content);
          }
          break;
        case 'reasoning.delta':
          if (payload.content && callbacks.onReasoning) callbacks.onReasoning(payload.content);
          break;
        case 'error':
          gotError = true;
          errorMessage = payload.error?.message || 'Unknown stream error';
          break;
        case 'chat.end': {
          const s = payload.result?.stats;
          if (s) {
            stats = {
              input_tokens: s.input_tokens ?? 0,
              total_output_tokens: s.total_output_tokens ?? 0,
              reasoning_output_tokens: s.reasoning_output_tokens ?? 0,
              tokens_per_second: s.tokens_per_second ?? 0,
              time_to_first_token_seconds: s.time_to_first_token_seconds ?? 0,
              model_load_time_seconds: s.model_load_time_seconds,
            };
          }
          responseId = payload.result?.response_id ?? responseId;
          gotChatEnd = true;
          providerFinishReason = 'chat.end';
          break;
        }
        default:
          break;
      }
    };

    try {
      for await (const item of decodeSSE(body, { idleTimeoutMs: timeoutMs })) {
        if (item.type !== 'event' || !item.event.data) continue;
        try {
          const payload = JSON.parse(item.event.data) as LMStudioNativeEvent;
          applyEvent(item.event.event ?? payload.type ?? '', payload);
        } catch {
          // Malformed event payload — skip silently.
        }
      }
    } catch (e) {
      debugLog.warn('[LC] SSE read aborted (native):', (e as Error).message || e);
      timedOut = true;
    }
    if (gotError) finishReason = 'error';
    else if (timedOut && !gotChatEnd) finishReason = 'disconnected';
    else if (gotChatEnd) finishReason = 'stop';

    return {
      content: fullChunks.join(''),
      finish_reason: finishReason,
      provider_finish_reason: providerFinishReason,
      error_message: errorMessage,
      lmstudio_response_id: responseId,
      ...(stats ? { stats } : {}),
    };
  }
}

interface LMChatEndResult {
  model_instance_id?: string;
  output?: unknown[];
  stats?: LMRawStats;
  response_id?: string;
}

interface LMStudioNativeEvent {
  type?: string;
  content?: string;
  result?: LMChatEndResult;
  error?: { message?: string };
}

interface LMRawStats {
  input_tokens?: number;
  total_output_tokens?: number;
  reasoning_output_tokens?: number;
  tokens_per_second?: number;
  time_to_first_token_seconds?: number;
  model_load_time_seconds?: number;
}
