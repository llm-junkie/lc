/**
 * Domain types persisted by the current stores and export formats.
 */

import type { ChatMessage } from './modules/llm-client/types';
import type { NormalizedUsage } from './modules/llm-client/cache-usage';
import type { PrefixDiagnostic } from './modules/llm-client/prefix-diagnostics';
import type { ToolCallRecord } from './modules/tool-engine/types';
import type { FileLineChange } from './modules/tool-engine/file-line-changes';

/** A reusable, user-authored Markdown guidance document. */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  /** Incremented whenever the Markdown body changes. */
  revision: number;
  /**
   * Global-library digest. Conversation custom-skill import does not
   * compare this value or perform duplicate/redundancy checks.
   */
  contentHash?: string;
}

/**
 * A custom skill owned by a single conversation. Unlike built-in skills
 * (which use stable LC-owned IDs like `lc:builtin:lc-tools`),
 * custom skills receive a conversation-scoped UUID on import. The UUID
 * is not portable across conversations.
 */
export interface ConversationSkill {
  /** UUID generated on custom import — conversation-scoped, not global. */
  id: string;
  /** Discriminator for UI and resolution: always `'custom'`. */
  source: 'custom';
  name: string;
  description: string;
  content: string;
  /** Informational only for custom skills; LC does not use it for
   *  duplicate or version comparison. */
  revision?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProfileRequestHeader {
  name: string;
  value: string;
}

export interface ProfileRequestHeaderSettings {
  /** Send LC's stable client identifier with requests made for this profile. */
  includeLcIdentifierHeader?: boolean;
  /** Optional override for LC's default versioned `User-Agent` identifier. */
  lcIdentifierHeader?: ProfileRequestHeader;
  /** Send the user-defined request headers below. Effective only with the
   *  parent LC identifier setting enabled. */
  includeAdditionalRequestHeaders?: boolean;
  /** Provider-agnostic request-header name/value pairs. */
  requestHeaders?: ProfileRequestHeader[];
}

export interface ServerProfile extends ProfileRequestHeaderSettings {
  id: string;
  name: string;
  baseUrl: string;
  /** Optional exact model-list URL or path. Empty/undefined uses LC's
   *  local/LAN-aware default resolution. */
  modelFetchUrl?: string;
  /** Encrypted-store lookup key (e.g. "profile.abc123"). When set, the actual
   *  API key lives in LC's AES-256-GCM files in the platform config directory.
   *  `apiKey` is kept for
   *  runtime fallback when keychain access is unavailable. Portable exports
   *  omit it, user-defined request headers, URL user-info, and recognized
   *  credential parameters in queries and structured fragments. */
  apiKey?: string;
  apiKeyRef?: string;
  /** Free-form note shown beneath the URL. */
  note?: string;
  /**
   * Per-server default SSE stream idle timeout in minutes (1–10, default 5).
   * Overridable per-conversation via the Workspace tab. If no token arrives
   * from the model within this window, LC assumes the server disconnected.
   */
  sse_read_timeout_min?: number;
  /**
   * Which chat-completion API variant to use for this server.
   *   - "lm-studio": the native REST API (named SSE events,
   *      server-measured stats in `chat.end`).  Set the server URL
   *      to include the API version prefix, e.g. `http://host:1234/api/v1`;
   *      LC appends `/chat`.
   *   - "openai": the OpenAI-compatible API at `/v1/chat/completions`
   *      (raw SSE `data:` lines, local token-counted stats)
   *   - "anthropic": the Anthropic Messages API.  Set the server URL
   *      to include the API version prefix, e.g. `https://api.anthropic.com/v1`;
   *      LC appends `/messages`.  (Named SSE events, content-block
   *      deltas, thinking_delta/text_delta/input_json_delta subtypes.)
   * Default is "lm-studio" since LC is built around LM Studio.
   */
  apiVariant?: 'lm-studio' | 'openai' | 'anthropic' | 'gemini';
  /**
   * When apiVariant is "openai", selects between Chat Completions and
   * the Responses API.
   *   - "responses": POST /v1/responses  (default for new profiles)
   *   - "chat":      POST /v1/chat/completions  (alternative chat style)
   * Ignored when apiVariant is "anthropic" or "lm-studio".
   * The current profile editor defaults this to "chat" when omitted.
   */
  apiStyle?: 'chat' | 'responses';
  /**
   * How requests to this server are routed.
   *   - "proxy": rewrite every URL through the local Vite / Tauri
   *      proxy at `/lc-proxy/*` to dodge browser CORS preflights.
   *      Works for both `127.0.0.1` and LAN IPs as long as the
   *      proxy is reachable.
   *   - "direct": skip the proxy and call the baseUrl as-is. Use
   *      this when LM Studio has CORS enabled (or in a Tauri build
   *      where the proxy isn't needed and adds latency).
   * The current profile editor defaults this to "proxy" when omitted.
   */
  routing?: 'proxy' | 'direct';
  /**
   * Whether this server profile is active. Active profiles'
   * models are available for chat and sub-agent tool calls
   * (e.g. lc_read_image analyze mode, lc_web_research).
   * Default false when omitted; new profiles are created active.
   */
  active?: boolean;
}

export interface GenerationParams {
  temperature: number;
  temperature_enabled?: boolean;
  top_p: number;
  top_p_enabled?: boolean;
  top_k: number;
  top_k_enabled?: boolean;
  max_tokens: number;
  max_tokens_enabled?: boolean;
  repeat_penalty: number;
  repeat_penalty_enabled?: boolean;
  /**
   * Unified thinking / reasoning effort level for all providers.
   * Mapped per-provider at request-build time:
   *   - LM Studio / OpenAI: `reasoning: { effort }` or `reasoning_effort`
   *   - DeepSeek:         `thinking: { type }` + `reasoning_effort`
   *   - MiniMax:          `thinking: { type: 'disabled' | 'adaptive' }`
   *   - Anthropic (future): `thinking` + `output_config.effort`
   *
   * `'none'` disables thinking; all other values enable it with
   * varying effort/budget levels.
   */
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  reasoning_enabled?: boolean;
  /** Comma- or newline-separated stop strings. */
  stop?: string;
  system_prompt: string;
}

/**
 * Generation controls captured with an assistant reply for the metadata
 * footer. Keep this separate from GenerationParams so system instructions and
 * stop strings are not duplicated into every message's display metadata.
 */
export type GenerationParamsSnapshot = Pick<
  GenerationParams,
  | 'temperature'
  | 'temperature_enabled'
  | 'top_p'
  | 'top_p_enabled'
  | 'top_k'
  | 'top_k_enabled'
  | 'max_tokens'
  | 'max_tokens_enabled'
  | 'repeat_penalty'
  | 'repeat_penalty_enabled'
  | 'reasoning_effort'
  | 'reasoning_enabled'
>;

/** API path used for the request that produced an assistant reply. */
export type ReplyEndpoint = '/chat/completions' | '/responses' | '/messages' | '/chat' | '/interactions';

export const DEFAULT_PARAMS: GenerationParams = {
  temperature: 0.5,
  temperature_enabled: false,
  top_p: 0.95,
  top_p_enabled: false,
  top_k: 40,
  top_k_enabled: false,
  max_tokens: 96000,
  max_tokens_enabled: false,
  repeat_penalty: 1.1,
  repeat_penalty_enabled: false,
  reasoning_effort: 'medium',
  reasoning_enabled: false,
  stop: '',
  system_prompt: '',
};

/**
 * A file the user attached to a message. We try to keep the heavy bytes
 * in IndexedDB (keyed by `id`) so the persisted conversation in
 * localStorage stays small; the inline `dataUrl` is a transient field the
 * UI fills in by calling `loadAttachmentDataUrl(id)` before rendering.
 */
export interface Attachment {
  id: string;
  name: string;
  /** MIME type, e.g. "image/png" or "text/python". */
  mime: string;
  /** True for image attachments (sent as image_url parts to the API).
   *  False for text/source-code attachments (inlined as code blocks). */
  isImage: boolean;
  /** Size in bytes (raw, before base64). */
  size: number;
  /**
   * Transient data URL, populated by `loadAttachmentDataUrl(id)`. Not
   * persisted in localStorage — rehydrated on demand from IndexedDB.
   */
  dataUrl?: string;
  /** True if the bytes are currently held in IndexedDB. */
  stored?: 'idb' | 'inline';
}

export type ToolPermissionDecision =
  | 'allow_once'
  | 'allow_session'
  | 'deny'
  | 'aborted'
  | 'unavailable';

/**
 * Durable evidence for one permission popup. A single popup may cover several
 * deduplicated tool calls; those result messages share the same `prompt_id`.
 */
export interface ToolPermissionAudit {
  /** LC-owned correlation id for the popup, unrelated to the model call id. */
  prompt_id: string;
  /** Unix ms when the first covered call requested this popup. */
  requested_at: number;
  /** Unix ms when the modal host committed the popup; absent if never shown. */
  shown_at?: number;
  /** Unix ms when the popup settled. */
  resolved_at: number;
  /** The modal outcome. `allow_session` means "Allow for this conversation". */
  decision: ToolPermissionDecision;
  /** Exact model call whose details the popup displayed. */
  displayed_call: {
    tool_call_id: string;
    tool_name: string;
  };
  /** Canonical directory scopes displayed by the popup, in display order. */
  scopes: string[];
}

/** The owner of one conversation whiteboard document. */
export type WhiteboardOwner = 'user' | 'model';

/** Retained board versions visible to one model turn. */
export interface WhiteboardTurnReferences {
  user_board: string;
  model_initial_board: string;
  model_latest_board: string;
}

export interface Message extends Omit<ChatMessage, 'content' | 'tool_calls' | 'tool_call_id'> {
  /** Always a string in our domain — multimodal content is built at the API boundary. */
  content: string;
  id: string;
  /** Unix ms. */
  createdAt: number;
  /** Monotonic sequence per conversation for stable sort order.
   *  Set at creation time; equals the conversation's messageCount
   *  after the append. Persisted in Dexie. */
  sortOrder?: number;
  /** True while a stream is in flight. */
  streaming?: boolean;
  /**
   * Reasoning / chain-of-thought content for thinking models. Kept on the
   * message itself so we can show it in a collapsible panel.
   */
  reasoning?: string;
  /**
   * Transient append-aware presence bit for `reasoning`.
   *
   * Streaming code updates this from each delta so render paths never need to
   * rescan (and flatten) the complete growing reasoning string just to decide
   * whether the reasoning UI is available. Storage reconstructs it on load;
   * it is deliberately absent from MessageRow, archives, and provider payloads.
   */
  reasoningHasVisibleContent?: boolean;
  /**
   * Optional token usage (assistant only, after stream ends).
   *
   * `usage.cache` carries provider-native cache counters when the provider
   * reported any, and `usage.source` distinguishes a provider report from an
   * LC estimate. Both are optional, so messages persisted before they existed
   * load unchanged.
   */
  usage?: NormalizedUsage;
  /**
   * Bounded LC-side conclusion about what changed in the cache-relevant part
   * of the request that produced this reply. Deliberately separate from
   * `usage`: `usage` is what the provider reported, this is what LC inferred
   * about its own request. Contains only closed enum values — never a digest,
   * key, or any request content.
   */
  prefix?: PrefixDiagnostic;
  /**
   * Display metadata for the assistant's reply. Captured at the end of
   * the stream so it can be shown under the bubble and included in
   * exports. Distinct from `usage` (which is the API-reported token
   * count) — these are UX-facing labels.
   */
  meta?: {
    /** Model id, e.g. "qwen/qwen3.6-27b". */
    model?: string;
    /** Normalized API path used for this reply. */
    endpoint?: ReplyEndpoint;
    /** Server profile name used for this reply. */
    serverName?: string;
    /** Base URL of the server profile used for this reply. Recorded so the
     *  model popover can name the actual host, which the profile name alone
     *  does not — two profiles may be named for the same provider. */
    baseUrl?: string;
    /** Name of the params preset that was active, e.g. "Writer" or
     *  "Server default" when all flags are off. */
    presetName?: string;
    /** Generation controls used for this reply, excluding prompt text. */
    params?: GenerationParamsSnapshot;
    /** Average tokens/second for this reply, rounded to nearest int. */
    avgTps?: number;
    /** Total tokens generated (alias of usage.completion_tokens, but
     *  stored here so exports don't need to look inside usage). */
    totalTokens?: number;
    /** Wall-clock duration of the stream in milliseconds. Shown as
     *  "N.Ns" alongside the token count in the bubble and exports. */
    durationMs?: number;
    /** The model's finish_reason from the final streaming chunk.
     *  "stop" = natural end, "length" = hit output token limit. */
    finish_reason?: string;
    /** Provider-native terminal signal for diagnostics. This stays separate
     *  from `finish_reason`, which LC normalizes for its status chip. */
    provider_finish_reason?: string;
    /** Error message when finish_reason is 'error'.  Stored so the
     *  bubble chip tooltip can show the actual failure reason. */
    error_message?: string;
  };
  /** Optional file attachments. The `content` field stays a string for text. */
  attachments?: Attachment[];
  /**
   * Assistant messages only. The tool calls the model emitted for this
   * turn. Each entry's `id` matches a `role: 'tool'` message's
   * `tool_call_id` in the same conversation. Persisted so re-imports
   * and reloads preserve the tool log in the UI overlay.
   */
  tool_calls?: ToolCallRecord[];
  /**
   * `role: 'tool'` messages only. The id of the `tool_calls` entry
   * this result answers. The ChatMessage parent has a `tool_call_id`
   * too (wire shape); we override with the same field at the domain
   * level so the runtime path doesn't need to translate.
   */
  tool_call_id?: string;
  /** `role: 'tool'` messages only. True if the tool failed. */
  tool_is_error?: boolean;
  /** `role: 'tool'` messages only. Wall-clock duration in ms. */
  tool_duration_ms?: number;
  /** `role: 'tool'` messages only. Durable permission-popup evidence. */
  tool_permission?: ToolPermissionAudit;
  /** `role: 'tool'` messages only. Lines added by a successful file mutation. */
  tool_lines_added?: number;
  /** `role: 'tool'` messages only. Lines removed by a successful file mutation. */
  tool_lines_removed?: number;
  /** `role: 'tool'` messages only. Per-file line changes for the detail card. */
  tool_line_changes?: FileLineChange[];
  /**
   * `role: 'user'` messages only. The retained user-board version pinned at
   * this send boundary. Missing means Whiteboard was not exposed for the send.
   */
  user_board?: string;
  /**
   * `role: 'assistant'` messages only. The user and model board versions that
   * belong to this turn. Missing means Whiteboard was not exposed for it.
   */
  whiteboard_refs?: WhiteboardTurnReferences;
}

export interface Conversation {
  id: string;
  title: string;
  /** ID of the ServerProfile used for this conversation (so we remember context). */
  serverId?: string;
  model?: string;
  params: GenerationParams;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  /** Cached message count. Tracked live during chat; lazy-computed
   *  on first message load when it is not present. */
  messageCount?: number;
  /**
   * When true, the conversation is hidden from the default Active
   * list and only visible when the user switches to the Archive
   * tab. Archiving doesn't delete anything — the conversation
   * can still be sent to, which auto-unarchives it and surfaces
   * a toast. Persisted alongside the rest of the conversation
   * so the archive state survives reloads and EXE restarts.
   */
  archived?: boolean;
  /**
   * Custom skills imported into this conversation. Each entry is a
   * conversation-owned Markdown guidance record with a scoped UUID.
   * Built-in skills (lc:builtin:*) are NOT stored here — they are
   * resolved from the LC built-in registry at runtime.
   */
  custom_skills?: ConversationSkill[];
  /**
   * Tool-calling settings, scoped to this conversation. Lives on
   * `Conversation` (not on `params` which is per-preset) because
   * tools are a long-lived conversation capability, not a transient
   * generation knob.
   *
   * Exposure is determined by Workspace and category toggles (via
   * `resolveExposure()`). Pre-grants (checkmarks) control popup
   * behavior but never hide tools. The authoritative grant fields are:
   *
   *   - `tool_grants` stores conversation-scoped Web Access pre-grants.
   *   - `dir_permissions` — File I/O directory+tool-scoped pre-grants;
   *     each grant covers its root and descendants for that tool.
   *
   * There is NO persistent shell grant. `lc_run_shell` always prompts,
   * except under the hidden grandmaster `*******` allowlist entry,
   * which auto-approves. `lc_tool_history` requires no grant when exposed.
   */
  tools?: {
    /** Master toggle. When false, no tools are sent on the wire. */
    enabled: boolean;
    /**
     * This field stores conversation-scoped Web Access pre-grants.
     * Each entry is a tool name whose checkbox is checked — calling
     * that tool skips the permission popup for this conversation.
     * Does NOT control exposure (Workspace and category membership do that).
     *
     */
    tool_grants: string[];
    /**
     * This field records whether LC applied the first-enable Web Access
     * defaults. This distinguishes a new conversation from a user who
     * deliberately unchecked every Web Access grant.
     */
    web_access_grants_initialized: boolean;
    /** When true, all ten File I/O tools are exposed to the model.
     *  Workspace activation sets this true. Calls still require directory
     *  permission to execute. */
    file_io_enabled: boolean;
    /** When true, shell execution (run_shell) is exposed.
     *  Shell always prompts except under the hidden grandmaster
     *  `*******` allowlist entry, which auto-approves. */
    shell_enabled: boolean;
    /** When true, all three Web Access tools are exposed. */
    web_access_enabled: boolean;
    /** When true, the read-only lc_skill tool is exposed. It is
     *  deliberately not enabled automatically with Workspace. */
    skills_enabled?: boolean;
    /** When true, the conversation Whiteboard UI and lc_whiteboard are exposed.
     *  Workspace activation sets this true. The user can disable it afterward. */
    whiteboard_enabled?: boolean;
    /** False only until the first direct Skills activation applies its
     *  default built-in skill selections. Missing means legacy/already initialized. */
    skills_initialized?: boolean;
    /** Skill IDs that lc_skill may list or retrieve in this conversation. */
    enabled_skill_ids?: string[];
    /** Filesystem roots considered by the File I/O sandbox; per-tool
     *  pre-grants for those roots live in `dir_permissions`. */
    allowed_roots: string[];
    /**
     * Per-directory tool permissions. Keys are directory paths
     * (must also be in `allowed_roots`). Values are lists of
     * BUILTIN_TOOLS names pre-approved for that directory and its
     * descendants. Overlapping roots are additive per tool: a child
     * entry does not broaden authority upward or shadow a matching
     * ancestor grant.
     */
    dir_permissions: Record<string, string[]>;
    /**
     * Maximum tool-call rounds allowed within one complete response turn
     * (8-256, default 128). Each round may contain one call or a batch.
     */
    max_tool_rounds_per_turn: number;
    /**
     * Maximum individual tool calls accepted in one tool-call round and
     * execution-pool width for the accepted batch (1–64, default 16).
     * Configured per conversation in the SidePanel Workspace tab.
     */
    max_tool_calls_per_batch: number;
    /**
     * SSE stream read timeout in minutes (1–60, default 5).  If no
     * token arrives from the model within this window during active
     * streaming, LC assumes the server disconnected.  Raise it for
     * models that pause output during long reasoning or tool-loop
     * processing.
     */
    sse_read_timeout_min: number;
    /**
     * Per-conversation shell binary allowlist. When non-empty,
     * overrides the global settings default. Undefined means
     * "inherit from Settings → Tools → Shell binary"; empty string
     * means "no binaries allowed" for this conversation.
     */
    shell_allowlist?: string;
    /**
     * When true, tool results from completed turns are archived
     * and replaced with compact stubs. The model retrieves past
     * results on demand via lc_tool_history. Defaults to true
     * for new conversations (auto-on when workspace is enabled).
     */
    tool_history_enabled?: boolean;
  };
}

export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Window geometry persisted across app launches (Tauri-only). The web
 * build ignores this — there's no concept of a desktop window there.
 */
export interface WindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}
