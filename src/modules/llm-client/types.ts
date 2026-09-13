/**
 * OpenAPI-compatible chat completion types + Anthropic + LM Studio REST types.
 * Central wire-type definitions for the llm-client module.
 */

export type ChatRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImageUrlPart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export type ContentPart = TextPart | ImageUrlPart;

/**
 * Anthropic-shaped thinking state that must be replayed byte-for-byte on a
 * tool-result follow-up. It is stored separately from the readable reasoning
 * string because signatures and redacted payloads are protocol state, not UI
 * text. Anthropic signatures carry opaque full thinking; MiniMax signatures
 * accompany complete plaintext thinking.
 */
export type AnthropicReplayBlock =
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string };

/**
 * Provider content-block kinds in the order they arrived on one Messages
 * stream. Text entries carry their exact provider segment, so several text
 * blocks separated by thinking or tool calls replay in place; tool calls are
 * recorded by kind and their IDs and arguments live in `tool_calls`.
 */
export type AnthropicBlockOrderKind = 'thinking' | 'redacted_thinking' | 'text' | 'tool_use';

export interface AnthropicBlockOrderEntry {
  kind: AnthropicBlockOrderKind;
  /** Content-block index from the stream; rebased when turns merge. */
  index: number;
  /**
   * Zero-based provider-response ordinal inside LC's merged assistant turn.
   * Present on newly captured rows so text-only responses retain an explicit
   * replay boundary. Absent on older rows, which use the conservative legacy
   * fallback when more than one response group exists.
   */
  responseIndex?: number;
  /**
   * Exact provider text for this block. Present only on text entries parsed
   * from a live stream; entries without it fall back to the joined message
   * content at the first text position.
   */
  text?: string;
}

/** Maximum recorded provider blocks per assistant turn. Past the bound the
 *  order is dropped and serialization falls back to the legacy layout. */
export const MAX_ANTHROPIC_BLOCK_ORDER = 256;

export type OpaqueReplayReasoningCarrier =
  | 'encrypted-content'
  | 'signed-thinking'
  | 'redacted-thinking'
  | 'mixed-anthropic-thinking'
  | 'plaintext'
  | 'none'
  | 'unknown';

/**
 * Response-local reasoning accounting bound to provider replay state.
 * Locators are structural association keys; no provider text or ciphertext is
 * copied into this metadata. `toolCallIds` preserves multi-response tool-loop
 * ordering for Anthropic without storing a second request body.
 */
export interface OpaqueReplayAccountingGroup {
  schemaVersion: 1;
  protocol: 'openai-responses' | 'anthropic-messages';
  reasoningCarrier: OpaqueReplayReasoningCarrier;
  generatedReasoningTokens?: number;
  tokenStatus: 'provider-reported' | 'provider-estimate' | 'unreported';
  locator:
    | { kind: 'responses-item-ids'; itemIds: string[] }
    | { kind: 'anthropic-block-indexes'; blockIndexes: number[] };
  /** Provider call IDs only; bounded and already present in `tool_calls`. */
  toolCallIds?: string[];
}

/** Capability metadata returned by model-list endpoints. */
export interface ModelCapabilities {
  vision?: boolean;
  reasoning?: boolean | Record<string, unknown>;
  trained_for_tool_use?: boolean;
  tools?: boolean;
}

export interface ChatMessage {
  /** Ordered native Gemini responses, with response-local provenance and usage. */
  gemini_interactions?: import('./gemini-state.ts').GeminiInteractionGroup[];
  role: ChatRole;
  /** String for plain text, or a content-part array for multimodal. */
  content: string | ContentPart[];
  /** Optional client-side name; not sent to the server. */
  name?: string;
  /** Assistant messages only. Tool calls the model wants to make. */
  tool_calls?: ToolCallWire[];
  /** Tool messages only. The id of the tool_call this result answers. */
  tool_call_id?: string;
  /** Tool messages only. True when the tool execution failed.
   *  Used by the Anthropic adapter to set `is_error` on tool_result blocks. */
  tool_is_error?: boolean;
  /**
   * Reasoning / chain-of-thought content for thinking models (DeepSeek,
   * Qwen, etc.). Required by DeepSeek's thinking mode — must be passed
   * back in all subsequent requests when the assistant message contains
   * tool_calls, otherwise the API returns a 400 error.
   * https://api-docs.deepseek.com/guides/thinking_mode#tool-calls
   */
  reasoning_content?: string;
  /** MiniMax's structured reasoning state; replay unchanged on tool rounds. */
  reasoning_details?: Array<Record<string, unknown>>;
  /** Assistant refusal text returned by Chat Completions. */
  refusal?: string;
  /**
   * Raw Responses output items from a prior assistant turn. This is retained
   * only for the Responses adapter so stateless reasoning/tool history can be
   * replayed; Chat Completions strips it before serialization.
   */
  responses_output_items?: ResponsesOutputItem[];
  /**
   * Request-time provenance derived from the persisted assistant metadata.
   * An unmatched endpoint may replay returned plaintext or structured output
   * state only to this exact base URL and model.
   */
  provider_output_origin?: AnthropicReplayOrigin;
  /** Complete Anthropic thinking blocks retained for tool-loop replay. */
  anthropic_output_blocks?: AnthropicReplayBlock[];
  /**
   * Provider content-block order for `anthropic_output_blocks` turns: the
   * kind sequence (thinking, redacted, text, tool_use) as streamed. Absent
   * on rows persisted before this field existed, which serialize in the
   * legacy reasoning-text-tools layout. Never authorizes cross-origin replay;
   * the existing origin gates still decide which blocks are emitted.
   */
  anthropic_block_order?: AnthropicBlockOrderEntry[];
  /**
   * Origin of `anthropic_output_blocks`. The adapter replays opaque blocks
   * only to this exact base URL and model; Anthropic ties them to the model
   * that produced them, and compatible providers define no cross-host use.
   */
  anthropic_output_origin?: AnthropicReplayOrigin;
  /** Accounting groups validated against the replay arrays above. */
  opaque_replay_accounting?: OpaqueReplayAccountingGroup[];
  /** LM Studio native state handle used as `previous_response_id`. */
  lmstudio_response_id?: string;
}

/** Request-time provenance for Anthropic-shaped replay state. */
export interface AnthropicReplayOrigin {
  baseUrl: string;
  model: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  /** Current OpenAI field for completion limits; `max_tokens` is deprecated
   * and incompatible with some newer reasoning models. */
  max_completion_tokens?: number;
  min_p?: number;
  /** llama.cpp / LM Studio / vLLM spelling of the repetition control. */
  repeat_penalty?: number;
  /** OpenRouter's documented spelling of the same control. Its schema has no
   *  `repeat_penalty`, so the two are never sent together. */
  repetition_penalty?: number;
  stream?: boolean;
  stop?: string[];
  /**
   * OpenAI-compatible option. When set, the server includes a `usage`
   * block in the final streaming chunk with prompt/completion/total
   * token counts. Without this, no usage data is returned at all.
   */
  stream_options?: { include_usage?: boolean };
  /**
   * Tool definitions the model can call. When set, the server is
   * allowed to emit `tool_calls` in its response. The wire shape is
 * the strict OpenAI spec (no client-only fields or other
   * client-only fields).
   */
  tools?: ToolDefinition[];
  /**
   * Controls tool-call behavior:
   *   - `'auto'` (default): server decides
   *   - `'none'`: forbid tool calls
   *   - `{ type: 'function', function: { name } }`: force a specific call
   */
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  /**
   * Reasoning effort for supported models. The shape follows LM
   * Studio's `/v1/responses` endpoint (`reasoning: { effort: ... }`).
   * The OpenAI-compat `/v1/chat/completions` endpoint doesn't list
   * `reasoning` as a supported parameter in the docs, but LM Studio
   * accepts the same shape on the OpenAI-compat layer (the
   * `/v1/responses` shape is the canonical one). If a particular
   * On the LM Studio native REST path, `LMStudioRestAdapter` maps this to the
   * native request and `client.ts` retries without reasoning after a recognized
   * server rejection.
   */
  reasoning?: { effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  /** Top-level OpenAI-compat reasoning control (used for 'none' to
   *  explicitly disable thinking on models that think by default). */
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Thinking toggle used by DeepSeek (`enabled`/`disabled`)
   *  and MiniMax-M3 (`adaptive`/`disabled`). Providers that don't
   *  use the OpenAI `reasoning` convention send this instead. */
  thinking?: { type: 'enabled' | 'disabled' | 'adaptive' };
  /** Alibaba Model Studio Chat Completions thinking toggle. */
  enable_thinking?: boolean;
  /** MiniMax extension that separates reasoning from visible content. */
  reasoning_split?: boolean;
}

export interface ModelInfo {
  id: string;
  object: 'model';
  created?: number;
  owned_by?: string;
  display_name?: string;
  type?: string;
  architecture?: string;
  max_context_length?: number;
  /**
   * Largest completion the model will produce, when the server reports one.
   *
   * Anthropic returns it as `max_tokens` on every `/v1/models` entry, and its
   * Messages API *requires* `max_tokens` on each request — so this is what LC
   * sends when the user has left the max-tokens override switched off. Servers
   * that do not report it leave this absent, and LC sends nothing.
   */
  max_output_tokens?: number;
  state?: 'loaded' | 'not-loaded' | 'loading' | 'unreachable';
  loaded_context_length?: number;
  loaded_instances?: Array<{ id: string; config?: { context_length?: number } }>;
  reasoning_config?: Record<string, unknown>;
  capabilities?: ModelCapabilities;
  publisher?: string;
  params_string?: string;
  format?: string;
  /** Internal provenance marker for metadata-rich LM Studio model lists. */
  source?: 'lmstudio-rest' | 'gemini-rest';
}

export interface StreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    /**
     * Provider-specific delta. We accept both string content and
     * content-part arrays (multimodal), and the `reasoning_content` /
     * `reasoning` fields that reasoning models emit alongside `content`.
     */
    delta: {
      role?: ChatRole;
      content?: string | ContentPart[] | null;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_details?: Array<Record<string, unknown>>;
      refusal?: string;
      /**
       * Tool-call deltas. Concatenated by `index` in `consumeSSE`
       * via the `ToolCallAccumulator` in this module.
       * Only emitted by the OpenAI-compat path when the server is
       * tool-use-capable; LM Studio's native REST path surfaces its
       * own equivalent. LM Studio REST does not surface tool calls.
       */
      tool_calls?: ToolCallDeltaWire[];
    };
    finish_reason: string | null;
  }>;
  /**
   * Some providers send the final token counts in the last chunk (LM Studio
   * does, OpenAI does not in stream mode). We surface it for the UI.
   */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: { reasoning_tokens?: number | null };
  };
}

/** A pair of content / reasoning deltas we hand to callers of `chatStream`. */
export interface StreamDelta {
  content: string;
  reasoning: string;
}

/* ------------------------------------------------------------------ */
/*  Tool calling                                                       */
/* ------------------------------------------------------------------ */

/** Stable name of an LC built-in tool. */
export type ToolName =
  | 'lc_read_file' | 'lc_write_file' | 'lc_list_dir' | 'lc_read_image'
  | 'lc_read_pdf'
  | 'lc_grep' | 'lc_edit_file' | 'lc_run_shell'
  | 'lc_stat' | 'lc_glob_files' | 'lc_apply_patch'
  | 'lc_web_fetch' | 'lc_web_search' | 'lc_web_research' | 'lc_get_current_time' | 'lc_todo_write' | 'lc_ask_user'
  | 'lc_whiteboard' | 'lc_tool_help' | 'lc_tool_history' | 'lc_skill';

/**
 * Subset of JSON Schema 2020-12 that we actually generate. Zod v4's
 * `z.toJSONSchema()` produces this shape; we pass it on the wire as
 * `tools[].function.parameters`.
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Wire payload — what we actually send to the server. Strict subset
 * of the OpenAI spec: only `type`, `function.{name,description,parameters}`.
 * No extra fields. Strict OpenAI-compat engines reject unknown fields
 * with a 400; we learned this the hard way when the first wire dump
 * showed client-only fields echoed back in the error.
 *
 * Policy metadata lives in the internal tool engine and is never sent on
 * the wire. The registry materializer strips all internal fields before send.
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

/**
 * A tool call as it appears on the wire (assembled from streaming
 * deltas, or present on the final `message.tool_calls` in non-streaming
 * mode). `function.arguments` is a JSON-encoded STRING, not a parsed
 * object — per the OpenAI spec. The runner parses it with the tool's
 * zod schema before invocation.
 */
export interface ToolCallWire {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A single streaming tool-call delta. Concatenated by index in `consumeSSE`. */
export interface ToolCallDeltaWire {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

/* ------------------------------------------------------------------ */
/*  LM Studio native REST API                                       */
/* ------------------------------------------------------------------ */

/**
 * Wire format for the native LM Studio REST chat endpoint. Different
 * from `ChatRequest` (OpenAI-compat) in several ways:
 *   - `input` is a string OR an array of message/text/image items,
 *     not the OpenAI `messages` array
 *   - Streaming uses named SSE events (event: chat.start, etc.),
 *     not raw `data:` lines
 *   - The final `chat.end` event carries authoritative `stats` —
 *     `tokens_per_second`, `time_to_first_token_seconds`, and
 *     exact token counts — which is more accurate than our local
 *     windowed counter
 */
export interface LMChatRequest {
  model: string;
  /**
   * Text items carry `content`, but the discriminator disagrees across LM
   * Studio builds: shipped servers validate `'text' | 'image'` and reject
   * `'message'` with `invalid_union`, while the current native chat page
   * documents `'message'`. Both values are in the type; `LMStudioRestAdapter`
   * sends `text` and switches only when a server names the other one.
   */
  input: string | Array<
    | { type: 'text' | 'message'; content: string }
    | { type: 'image'; data_url: string }
  >;
  previous_response_id?: string;
  system_prompt?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repeat_penalty?: number;
  max_output_tokens?: number;
  reasoning?: 'off' | 'low' | 'medium' | 'high' | 'on';
  stop?: string[];
}

/** Stats block delivered in the `chat.end` event of LM Studio's
 *  native REST stream. This is the source of truth for generation
 *  speed and total tokens — we use it instead of our local
 *  windowed counter when available. */
export interface LMChatStats {
  input_tokens: number;
  total_output_tokens: number;
  reasoning_output_tokens: number;
  tokens_per_second: number;
  time_to_first_token_seconds: number;
  model_load_time_seconds?: number;
}

/* ------------------------------------------------------------------ */
/*  Anthropic Messages API (/v1/messages)                             */
/* ------------------------------------------------------------------ */

/**
 * Anthropic Messages API request body. Different from OpenAI-compat:
 *   - `system` is a top-level field (string or array), not a message role
 *   - Messages use content-block arrays rather than plain strings
 *   - Tool definitions use the Anthropic shape `{name, description, input_schema}`
 *   - Streaming uses named SSE events with content-block deltas
 *
 * Reference: https://docs.anthropic.com/en/api/messages
 */
export interface AnthropicRequest {
  model: string;
  messages: AnthropicRequestMessage[];
  system?: string | Array<{ type: 'text'; text: string }>;
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicToolDef[];
  thinking?: {
    type: 'enabled' | 'disabled' | 'adaptive';
    budget_tokens?: number;
    /**
     * Reasoning visibility. `omitted` still streams `thinking` blocks, with an
     * empty `thinking` field; billing is identical either way.
     */
    display?: 'omitted' | 'summarized';
  };
  /** Anthropic-compatible effort control used by adaptive-thinking models. */
  output_config?: { effort: string };
  /**
   * Anthropic's automatic prompt caching, which is opt-in — without it nothing
   * is cached. The top-level form lets the server place the breakpoint, so LC
   * inserts none of its own (cache-observability.md §1).
   */
  cache_control?: { type: 'ephemeral' };
}

export interface AnthropicRequestMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  // `content` is a plain string. Anthropic-compatible endpoints reject image
  // blocks here — "Only text tool_result blocks are supported when
  // tool_result.content is an array" — so tool-returned images are delivered
  // as a separate user turn instead. See docs/streaming.md, "Adapter
  // constraints proven against live endpoints".
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string };

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/* ------------------------------------------------------------------ */
/*  Anthropic streaming SSE event types                               */
/* ------------------------------------------------------------------ */

/** Possible SSE event types in an Anthropic stream. */
export type AnthropicSSEEvent =
  | { type: 'message_start'; message: AnthropicStreamMessage }
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlockStart }
  | { type: 'content_block_delta'; index: number; delta: AnthropicDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason: string | null; stop_sequence: string | null };
      usage: {
        output_tokens: number;
        input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        cache_creation?: Record<string, unknown> | null;
        output_tokens_details?: { thinking_tokens?: number | null } | null;
      };
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  // Anthropic nests the error and sends no sequence number:
  //   event: error
  //   data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
  // https://platform.claude.com/docs/en/build-with-claude/streaming
  | { type: 'error'; error: { type: string; message: string } };

export interface AnthropicStreamMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    output_tokens_details?: { thinking_tokens?: number | null } | null;
  };
}

/** The content_block field from a content_block_start event. */
export type AnthropicContentBlockStart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

/** The delta field from a content_block_delta event. */
export type AnthropicDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'signature_delta'; signature: string };

/* ------------------------------------------------------------------ */
/*  OpenAI Responses API (/v1/responses)                              */
/* ------------------------------------------------------------------ */

/** A single input item in the Responses API.
 *  Includes function_call for replaying tool calls from prior Chat
 *  Completions turns when the user switches models mid-conversation. */
export type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesInputFunctionCall
  | ResponsesFunctionCallOutput
  | ResponsesInputReasoningItem;

export interface ResponsesInputMessage {
  type: 'message';
  role: 'user' | 'assistant' | 'developer' | 'system';
  content: string | ResponsesContentPart[];
}

/** A prior tool call replayed as a separate input item. Used when
 *  converting Chat Completions assistant messages with embedded
 *  tool_calls into the Responses API's flat item list. */
export interface ResponsesInputFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  /** Plain string only. The spec allows content parts here, but LM Studio's
   *  Responses implementation rejects them with `invalid_union` on `input`,
   *  and LC shares this adapter with such endpoints — so tool-returned images
   *  are delivered as a separate user turn. See docs/streaming.md,
   *  "Adapter constraints proven against live endpoints". */
  output: string;
}

/**
 * Reasoning replayed on a later stateless (`store: false`) request. Exactly
 * one carrier is used, depending on the provider:
 *
 *   - OpenAI  — `encrypted_content` (opaque); plain text is never returned.
 *   - DeepSeek — plain-text `content` parts. `summary` and `encrypted_content`
 *     are not supported there, and the chain-of-thought MUST be replayed on
 *     tool-call rounds or the API returns a 400.
 *     https://api-docs.deepseek.com/guides/responses_api  (Input Items)
 *     https://api-docs.deepseek.com/guides/thinking_mode#tool-calls
 */
export interface ResponsesInputReasoningItem {
  type: 'reasoning';
  /** Omitted for items LC synthesizes from a prior Chat Completions turn. */
  id?: string;
  encrypted_content?: string;
  content?: ResponsesReasoningTextPart[];
  summary?: unknown[];
}

/** Plain-text chain-of-thought part carried on a reasoning item. */
export interface ResponsesReasoningTextPart {
  type: 'reasoning_text';
  text: string;
}

export type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' };

/** Tool definition — internally tagged (Responses API shape). */
export interface ResponsesToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonSchema;
  strict?: boolean;
}

/** Top-level request body for POST /v1/responses. */
export interface ResponsesRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: ResponsesToolDef[];
  tool_choice?: 'auto' | 'none' | 'required';
  reasoning?: {
    effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    summary?: 'auto' | 'concise' | 'detailed';
    mode?: 'standard' | 'pro';
    context?: 'auto' | 'current_turn' | 'all_turns';
  };
  store?: boolean;
  previous_response_id?: string;
  include?: string[];
  parallel_tool_calls?: boolean;
}

/** Output items in the response. */
export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesFunctionCall
  | ResponsesReasoningItem;

export interface ResponsesOutputMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  status: 'completed' | 'in_progress' | 'incomplete';
  content: ResponsesOutputContent[];
}

export type ResponsesOutputContent =
  | { type: 'output_text'; text: string; annotations: unknown[] }
  | { type: 'refusal'; refusal: string };

export interface ResponsesFunctionCall {
  id: string;
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed' | 'in_progress' | 'incomplete';
}

export interface ResponsesReasoningItem {
  id: string;
  type: 'reasoning';
  /** Plain-text chain-of-thought (DeepSeek). OpenAI leaves this empty and
   *  returns `summary` + `encrypted_content` instead. */
  content?: ResponsesReasoningTextPart[];
  summary?: unknown[];
  encrypted_content?: string;
  status?: 'completed' | 'in_progress' | 'incomplete';
}

/** The full non-streaming response. */
export interface ResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  output: ResponsesOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    output_tokens_details?: { reasoning_tokens?: number | null };
  };
  status: 'completed' | 'failed' | 'in_progress' | 'cancelled';
}

// ── Responses Streaming SSE Events ──

/**
 * The Responses streaming events LC parses, in both dialects of the envelope.
 *
 * **This is a projection, not a transcription of either wire.** Each variant
 * carries the fields its provider documents as identifying that event, plus the
 * fields LC reads. It does not mirror every field of every event —
 * `ResponsesResponse` is itself a subset of the response object OpenAI
 * publishes. Read a variant as "these fields are documented and LC uses them",
 * never as "these are the only fields on the wire".
 *
 * `parseStream()` deliberately does **not** narrow incoming events to this
 * union; it reads a separate permissive payload shape, because the compatible
 * servers on this envelope vary and a strict narrow would drop events LC can
 * otherwise handle. That separation is also why this union drifted out of step
 * with the adapter twice without a test going red — the type fixtures in
 * `responses-event-fixtures.ts` are what hold it to the published shapes now.
 *
 * `sequence_number` is on the OpenAI-dialect variants because the streaming
 * reference documents every event as carrying a monotonically increasing
 * sequence number for ordering. OpenRouter's published example shows none, so
 * its three variants do not claim one.
 *
 * @see https://developers.openai.com/api/reference/resources/responses/streaming-events
 * @see https://openrouter.ai/docs/api_reference/responses/basic-usage
 */
export type ResponsesSSEEvent =
  | { type: 'response.created'; sequence_number: number; response: ResponsesResponse }
  | { type: 'response.in_progress'; sequence_number: number; response: ResponsesResponse }
  | { type: 'response.output_text.delta'; sequence_number: number; item_id: string; output_index: number; content_index: number; delta: string }
  | { type: 'response.output_text.done'; sequence_number: number; item_id: string; output_index: number; content_index: number; text: string }
  | { type: 'response.reasoning_text.delta'; sequence_number: number; item_id: string; output_index: number; content_index: number; delta: string }
  | { type: 'response.reasoning_text.done'; sequence_number: number; item_id: string; output_index: number; content_index: number; text: string }
  | { type: 'response.function_call_arguments.delta'; sequence_number: number; item_id: string; output_index: number; delta: string }
  | { type: 'response.function_call_arguments.done'; sequence_number: number; item_id: string; output_index: number; name: string; arguments: string }
  | { type: 'response.refusal.delta'; sequence_number: number; item_id: string; output_index: number; content_index: number; delta: string }
  | { type: 'response.refusal.done'; sequence_number: number; item_id: string; output_index: number; content_index: number; refusal: string }
  | { type: 'response.output_item.added'; sequence_number: number; item: ResponsesOutputItem; output_index: number }
  | { type: 'response.output_item.done'; sequence_number: number; item: ResponsesOutputItem; output_index: number }
  | { type: 'response.reasoning_summary_text.delta'; sequence_number: number; item_id: string; output_index: number; summary_index: number; delta: string }
  | { type: 'response.reasoning_summary_text.done'; sequence_number: number; item_id: string; output_index: number; summary_index: number; text: string }
  | { type: 'response.completed'; sequence_number: number; response: ResponsesResponse }
  | { type: 'response.failed'; sequence_number: number; response: ResponsesResponse }
  | { type: 'response.incomplete'; sequence_number: number; response: ResponsesResponse }
  // OpenAI's Responses error event carries `code`, `message`, and `param` at
  // the TOP LEVEL, not nested under an `error` object — the shape this union
  // claimed until R-28, and the reason `parseStream()` was dumping raw JSON at
  // the user instead of the provider's sentence. The parser also accepts a
  // nested `error.message` as a compatibility fallback — that shape is not
  // documented on this envelope by any provider, so it is not modelled here.
  // https://developers.openai.com/api/reference/resources/responses/streaming-events
  | { type: 'error'; sequence_number: number; code: string | null; message: string; param: string | null }
  // ── OpenRouter's dialect of the same envelope ──────────────────────
  // OpenRouter serves this envelope too and spells three events differently.
  // Each shape below is exactly what its published example prints — the fields
  // are transcribed, not inferred:
  //
  //   data: {"type":"response.content_part.delta","response_id":"resp_…",
  //          "output_index":0,"content_index":0,"delta":"Once"}
  //   data: {"type":"response.done","response":{"id":"resp_…",
  //          "object":"response","status":"completed","usage":{…}}}
  //
  // Note what that means: the content delta is keyed by `response_id`, NOT the
  // `item_id` the OpenAI variants carry, and the terminal `response` object has
  // no `output` array — the text has already arrived as deltas by then.
  // https://openrouter.ai/docs/api_reference/responses/basic-usage
  | { type: 'response.content_part.delta'; response_id: string; output_index: number; content_index: number; delta: string }
  // The reasoning guide establishes this event's name and its `delta`; it
  // publishes no identifying fields, so none are claimed here.
  // https://openrouter.ai/docs/api_reference/responses/reasoning
  | { type: 'response.reasoning.delta'; delta: string }
  | {
      type: 'response.done';
      response: {
        id: string;
        object: 'response';
        status: ResponsesResponse['status'];
        usage?: ResponsesResponse['usage'];
        /**
         * Not in OpenRouter's published example — deliberately permissive.
         * `parseStream()` reads `response.output` on this event so a server
         * that does send it is not ignored, and the adapter works either way.
         * Flagged as an extension of the documented shape rather than part
         * of it.
         */
        output?: ResponsesOutputItem[];
      };
    };
