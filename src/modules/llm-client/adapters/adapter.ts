import type {
  AnthropicBlockOrderEntry, AnthropicReplayBlock, ChatMessage, ToolDefinition, ToolCallWire, LMChatStats,
  ResponsesOutputItem,
} from '../types';
import type { ToolCallAccumulator } from '../tool-accumulator';
import type { NormalizedUsage } from '../cache-usage';
import type { PrefixDiagnostic } from '../prefix-diagnostics';
import type { ResolvedProviderContract } from '../provider-contracts';

/**
 * The contract every protocol adapter implements.
 */
export interface ChatStreamAdapter {
  readonly protocol: 'openai' | 'anthropic' | 'lmstudio-rest' | 'gemini-rest';
  readonly streamEndpoint: string;

  buildRequest(params: AdapterRequestParams): unknown;
  buildHeaders(apiKey: string): Record<string, string>;

  parseStream(
    body: ReadableStream<Uint8Array>,
    callbacks: StreamCallbacks,
    timeoutMs: number,
    toolAcc: ToolCallAccumulator,
  ): Promise<StreamResult>;
}

export interface AdapterRequestParams {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  baseUrl?: string;           // for provider detection (MiniMax vs Claude)
  /** The user's max-tokens override. Absent when the toggle is off. */
  maxTokens?: number;
  /**
   * The model's own completion ceiling, as reported by the server's model
   * list. Not a user override: it is the value an adapter uses when its API
   * *requires* a limit and the user has not set one. Adapters whose API
   * treats the limit as optional must ignore it and send nothing.
   */
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  stopSequences?: string[];
  tools?: ToolDefinition[];
  reasoningEnabled: boolean;
  reasoningEffort?: string;
  streamOptions?: { include_usage?: boolean };
  /** Native Gemini structured JSON output; no implicit schema generation. */
  responseFormat?: { type: 'text'; mime_type: 'application/json'; schema?: Record<string, unknown> };
  /** Exact origin/protocol contract resolved once for this request. */
  providerContract?: ResolvedProviderContract;
  /** Present on real LLMClient requests; direct adapter tests may omit it. */
  providerContractStatus?: 'matched' | 'unmatched';
}

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onReasoning?: (reasoning: string) => void;
  /** Called when the provider begins emitting a tool/function call. */
  onToolCall?: () => void;
  onRefusal?: (refusal: string) => void;
}

export interface StreamResult {
  gemini_interactions?: import('../gemini-state.ts').GeminiInteractionGroup[];
  content: string;
  /**
   * Normalized token usage. `usage.cache` carries provider-native cache
   * counters when the provider reported any; it is absent when the provider
   * returned no usable usage at all.
   */
  usage?: NormalizedUsage;
  finish_reason?: string;
  /** Provider-native terminal signal, retained for the finish-reason detail overlay. */
  provider_finish_reason?: string;
  /** Server-side error message (e.g. from Anthropic SSE `error` event). */
  error_message?: string;
  /** Refusal text emitted by the model, kept separate from answer content. */
  refusal?: string;
  tool_calls?: ToolCallWire[];
  /** Complete Responses output items for stateless history replay. */
  responses_output_items?: ResponsesOutputItem[];
  /** Complete signed/redacted Anthropic blocks for exact tool-loop replay. */
  anthropic_output_blocks?: AnthropicReplayBlock[];
  /**
   * Provider content-block kind order for the blocks above. Recorded by the
   * Anthropic adapter; the orchestrator persists it onto the message so a
   * later request can serialize thinking, text, and tool_use in the exact
   * returned sequence instead of the legacy reasoning-text-tools layout.
   */
  anthropic_block_order?: AnthropicBlockOrderEntry[];
  /** Complete MiniMax reasoning details for exact tool-loop replay. */
  reasoning_details?: Array<Record<string, unknown>>;
  /** Native LM Studio state handle for the next turn. */
  lmstudio_response_id?: string;
  stats?: LMChatStats;
  /**
   * Bounded LC-side explanation of what changed in the cache-relevant part of
   * this request relative to the previous comparable one. Attached by
   * `LLMClient.chatStream`, not by the protocol adapters — it describes LC's
   * request, not the provider's response.
   */
  prefix?: PrefixDiagnostic;
  /**
   * Ephemeral ring-local number that pairs this stream with its own provider
   * request inside the bounded diagnostic ring. Never persisted on a message,
   * never exported, and not any provider or LC identifier.
   */
  diagnosticSequence?: number;
}
