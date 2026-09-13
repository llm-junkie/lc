# Data Model

This document defines domain types persisted in localStorage and IndexedDB.
Optional fields use defaults at read time. LC normalizes current tool grants at
persistence boundaries. It does not read an alternate tool-grant field.

---

## Conversation

```typescript
interface Conversation {
  id: string;                              // UUID
  title: string;                           // Auto-derived from first user message
  serverId?: string;                       // Foreign key → ServerProfile.id
  model?: string;                          // Selected model id
  params: GenerationParams;                // Snapshot at conversation creation
  messages: Message[];                     // Ordered message history (empty until clicked — [] means "not loaded from DB")
  messageCount?: number;                   // Cached count — tracked live, computed when absent
  tools?: ToolsConfig;                     // Per-conversation tool permissions
  custom_skills?: ConversationSkill[];     // Conversation-owned custom Markdown skills
  archived?: boolean;                      // Hidden from Active list
  createdAt: number;                       // Unix ms
  updatedAt: number;                       // Unix ms
}
```

### ConversationSkill

```typescript
interface ConversationSkill {
  id: string;                              // UUID generated when imported into this conversation
  source: 'custom';                        // Built-ins are resolved from LC's registry and are not stored here
  name: string;
  description: string;
  content: string;                         // Markdown body without front matter
  revision?: number;                       // Informational only; no custom-skill comparison is performed
  createdAt: number;                       // Unix ms
  updatedAt: number;                       // Unix ms
}
```

Built-in skills use stable LC-owned IDs such as `lc:builtin:mermaid-diagram` and
are resolved from the bundled registry at runtime. Custom skills are owned by
one conversation and are not stored in Settings.

### ToolsConfig

```typescript
interface ToolsConfig {
  enabled: boolean;                        // Master toggle
  file_io_enabled: boolean;                // File I/O group toggle. Workspace activation sets true.
  shell_enabled: boolean;                  // Shell group toggle
  web_access_enabled: boolean;             // Web Access group toggle. Workspace activation preserves it.
  tool_history_enabled?: boolean;          // Tool History exposure + completed-turn stubbing
  skills_enabled?: boolean;                // Skills category exposure (off by default)
  whiteboard_enabled?: boolean;            // Whiteboard overlay + tool exposure. Workspace activation sets true.
  skills_initialized?: boolean;            // One-time default built-in skills marker
  enabled_skill_ids?: string[];            // Built-in IDs and conversation custom UUIDs available to lc_skill
  tool_grants: string[];                   // Stores conversation-scoped Web Access grants.
  web_access_grants_initialized: boolean;  // Marks completion of the explicit-enable defaults.
  allowed_roots: string[];                 // File I/O sandbox roots; grants live in dir_permissions
  dir_permissions: Record<string, string[]>;  // root → tool names; each grant covers descendants
  max_tool_rounds_per_turn: number;        // Default 128, slider 8–256; one round may contain one call or a batch
  max_tool_calls_per_batch: number;        // Default 16, slider 1–64; batch ceiling and executor pool width
  sse_read_timeout_min: number;            // Default 5, range 1–60; stream idle watchdog + tool-round deadline
  shell_allowlist?: string;                // undefined = inherit global; empty = allow none
}
```

Exposure comes only from `enabled` and the category toggles. `tool_grants` and
`dir_permissions` are the live, visible pre-grant state.
`web_access_grants_initialized` distinguishes an intentional empty grant set from
the defaults applied on first explicit Web Access activation. Workspace activation
does not change this marker. `skills_initialized` records application of the
one-time default built-in selection. LC treats a missing Skills marker as legacy
or already initialized, so upgrades do not override existing skill choices.

Load, import, export, and clone normalize the current fields. Normalization
includes lexical path forms and unknown or duplicate entries. LC ignores
alternate grant fields. The shell has no persistent grant and always prompts.
The hidden grandmaster `*******` allowlist entry is the only exception and
approves automatically.

`sse_read_timeout_min` serves two purposes: it is the stream idle watchdog and
the wall-clock deadline for one round of tool execution. A new configuration
defaults to five minutes. A legacy conversation whose persisted tools config
lacks this field uses a two-minute tool-round fallback until it is saved with a
current value.

Directory grants are additive and directional. A root and tool entry covers the
root and every descendant for that tool. A child entry does not authorize its
parent or siblings. A missing tool on an overlapping child entry does not
override an enclosing grant.

---

## Message

```typescript
interface Message {
  id: string;                              // UUID
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;                         // Always string in domain model
  createdAt: number;                       // Unix ms
  sortOrder?: number;                      // Monotonic per-conversation (1,2,3…) — stable sort even when createdAt collides. See the value-domain invariant under Storage Layout
  streaming?: boolean;                     // Transient UI flag; never persisted or exported
  reasoning?: string;                      // Chain-of-thought (DeepSeek, Qwen, Claude, MiniMax)
  refusal?: string;                        // Provider refusal text (assistant only)
  responses_output_items?: ResponsesOutputItem[]; // OpenAI Responses replay state
  anthropic_output_blocks?: AnthropicReplayBlock[]; // Complete signed/redacted Messages replay state
  gemini_interactions?: GeminiInteractionGroup[]; // Complete native responses, thought locators, source identity, raw usage
  opaque_replay_accounting?: OpaqueReplayAccountingGroup[]; // Response-local counts structurally bound to replay groups
  prefix?: PrefixDiagnostic;                // Prompt-prefix cache diagnostics (persisted, as prefixJson)
  usage?: {                                // Token counts (assistant only) — NormalizedUsage
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache?: CacheUsage;                     // Provider cache counters — see cache-observability.md
    source?: 'provider' | 'lc-estimate' | 'mixed'; // Absent on pre-field messages = provider-reported
    scope?: 'assistant-turn';               // New footer totals sum every provider response in the bubble
    coverage?: { responseCount: number; providerReportedResponses: number; estimatedResponses: number };
    tokenCoverage?: Record<'input' | 'output' | 'total', 'reported' | 'partial' | 'unreported'>;
    terminalCoverage?: 'complete' | 'partial';
    reasoning?: {                          // Response breakdown or assistant-turn coverage aggregate
      status: 'reported' | 'partially-reported' | 'not-reported';
      tokens?: number;
    };
  };
  meta?: {                                 // Display metadata
    model?: string;
    endpoint?: '/chat/completions' | '/responses' | '/messages' | '/interactions' | '/chat';
    serverName?: string;
    baseUrl?: string;                       // Base URL of the profile used for this reply
    presetName?: string;
    params?: GenerationParamsSnapshot;      // Generation controls used for this reply
    avgTps?: number;
    totalTokens?: number;
    durationMs?: number;
    finish_reason?: string;                // OpenAI/LM Studio: "stop" | "length" | "tool_calls" | "content_filter"
                                           // Anthropic: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "pause_turn" | "refusal" | "model_context_window_exceeded"
                                           // LC internal: "error" | "disconnected" | "infinite_reasoning_loop" | "tool_batch_limit" | "tool_round_limit" | "tool_timeout"
    provider_finish_reason?: string;       // Unmodified provider terminal signal for diagnostics
    error_message?: string;                // Error or LC guard detail for a terminal finish reason
  };
  attachments?: Attachment[];              // User messages only
  tool_calls?: ToolCallRecord[];           // Assistant messages only
  tool_call_id?: string;                   // Tool messages only
  tool_is_error?: boolean;                 // Tool messages only
  tool_duration_ms?: number;               // Tool messages only
  tool_permission?: ToolPermissionAudit;   // Durable permission-popup evidence
  tool_lines_added?: number;               // Successful file mutation summary
  tool_lines_removed?: number;
  tool_line_changes?: FileLineChange[];     // Per-file mutation detail
  user_board?: string;                     // User messages only: retained user version pinned at send
  whiteboard_refs?: WhiteboardTurnReferences; // Assistant messages only: turn-owned board pins
}

interface WhiteboardTurnReferences {
  user_board: string;                      // User version exposed to this turn
  model_initial_board: string;             // Retained model head at admission
  model_latest_board: string;              // Initial head or this turn's provisional/retained model ID
}

interface ToolPermissionAudit {
  prompt_id: string;                       // Shared by calls covered by one popup
  requested_at: number;                    // Unix ms: popup requested
  shown_at?: number;                       // Unix ms: dialog committed; absent if never shown
  resolved_at: number;                     // Unix ms: decision/failure settled
  decision: 'allow_once' | 'allow_session' | 'deny' | 'aborted' | 'unavailable';
  displayed_call: {
    tool_call_id: string;                  // Call whose details appeared in the popup
    tool_name: string;
  };
  scopes: string[];                        // Canonical scopes displayed by the popup
}

interface ToolCallRecord {
  id: string;                              // Matches tool_call_id on tool message
  name: string;                            // e.g. "lc_read_file"
  arguments: string;                       // JSON-encoded string (wire format)
  arguments_parsed?: Record<string, unknown>;  // Parsed after validation
  created_at: number;                      // Unix ms
}

// `ToolCallRecord` carries no execution status. A call's outcome lives on its
// tool-result message (`tool_is_error`, `tool_duration_ms`), and in-flight
// state is derived in the UI — a status field on the record would only be a
// stale second copy.
//
// Measured before removal: 127 of 127 persisted calls carried `pending`,
// including the ~124 that succeeded. Exactly one path ever wrote anything
// else, and nothing read the field — the UI derives its icon from `isRunning`
// and `result.is_error`, which is why it looked correct. Removed pre-1.0,
// when there was no shipped data or archive to stay compatible with. Do not
// reintroduce it assuming the absence was an oversight.

interface Attachment {
  id: string;
  name: string;
  mime: string;                            // e.g. "image/png", "text/python"
  isImage: boolean;
  size: number;                            // Raw bytes (not base64)
  dataUrl?: string;                        // Transient — hydrated from IDB on render
  stored?: 'idb' | 'inline';
}
```

Provider adapters produce response-local usage. New `Message.usage` rows with
`scope: "assistant-turn"` are the footer-facing sum of every provider response
merged into the bubble, including tool-loop re-streams. Cache and reasoning
coverage remain explicit; missing fields are not converted to zero. Rows made
before this field existed retain their response-local shape. A legacy row with
tool calls is presented as a possible final-response-only report.

Turn usage is not context occupancy. TokenMeter uses the shared active-provider
projection. Locally visible fields are tokenized locally; a provider reasoning
count supplies only an opaque carrier that is structurally associated, emitted
by the next request, and known retained. Unreported opaque or remote state makes
the numeric meter a lower bound. A Responses `content[].reasoning_text` item is
locally countable only when the provider defines that item as plaintext
chain-of-thought. An SSE event name alone is not enough: compatible providers
use similar reasoning event names for plaintext, summaries, and structurally
unresolved relay data. The canonical rules and verified provider matrix are in
[reasoning-and-token-accounting.md](./reasoning-and-token-accounting.md).

`gemini_interactions` holds complete schema-version-1 native response groups:
response ID, exact Base URL/model provenance, ordered steps, completion flag,
raw usage, thought-step indexes binding that usage, and interrupted fragments.
The response ID identifies the local group: LC retains a nonempty opaque provider
ID, or its per-response local UUID when the metadata ID is absent/empty. It is
not sent as a remote continuation handle. Response IDs share the whole-group
size budget rather than a separate 1,024-character limit.
`MessageRow.geminiInteractionsJson` compresses these groups for persistence,
checkpoints, cloning, and archives. Invalid or excessive state fails explicitly;
missing/stale accounting remains unknown. See [Gemini REST](./note-gemini-rest.md).

`opaque_replay_accounting` holds bounded schema-version-1 groups. Responses
groups locate one response by output item IDs. Anthropic groups locate one
response by ordered block indexes. Internal metadata may retain the provider's
counter semantics, but every provider-supplied reasoning count has the same
user-facing label: `Reasoning (reported)`. Each group is response-level: LC
never divides one provider count among several encrypted items or thinking
blocks. The locators are structural association keys, not content hashes.

The replay array and its accounting are validated and updated together. When a
user-authorized branch edit/retry, archive operation, or provenance check changes
provider state, it performs the same operation on the accounting. A missing
referenced item/block or invalid association makes that accounting unmeasured
rather than guessed. This is integrity handling, not a normal-history reasoning
deletion rule. Tool History rebuilds paired calls but retains provider reasoning
state; Responses accounting is projected onto any encrypted carrier that remains
on the wire, while provider-returned plaintext reasoning remains locally
countable. Accounting metadata never contains encrypted payloads, readable
summaries, request bodies, or stable content digests.

`meta` and all of its fields are optional. A response can be checkpointed before
request metadata, usage, or a terminal finish reason is available. Older
conversation rows can predate newer display fields. The assistant bubble must
treat missing metadata as unknown and render `-` at the UI boundary. It must
not persist those placeholders in the message.

The preset and model details
popovers use the same `-` fallback for each field. Therefore, they can open when
the snapshot is missing.

---

## Whiteboard

Whiteboard is two conversation-owned Markdown documents: one user board and one
model board. It has two storage layers. Retained versions are immutable history.
working rows are mutable state that has not crossed its retention boundary.

```typescript
type WhiteboardOwner = 'user' | 'model';

interface WhiteboardVersion {
  conversationId: string;
  id: string;                              // u_MMDDHHmmssSSS or m_MMDDHHmmssSSS
  owner: WhiteboardOwner;
  content: string;                         // Decompressed Markdown in the domain model
  createdAt: number;                       // Unix ms; UI dates come from this field, not id
  sequence: number;                        // Positive, conversation-wide monotonic order
  sourceMessageId: string | null;
  sourceToolCallId: string | null;
}

interface PendingUserWhiteboard {
  conversationId: string;
  owner: 'user';
  content: string;
  updatedAt: number;
}

interface ModelWhiteboardWorkingCopy {
  conversationId: string;
  owner: 'model';
  content: string;
  updatedAt: number;
  id: string | null;                       // Stable provisional ID after the first change
  createdAt: number | null;
  initialVersionId: string;
  generationId: string;
  assistantMessageId: string;
  latestToolCallId: string | null;         // Durable mutation receipt
}
```

Version IDs use local calendar fields and are unique only within a conversation.
The owner prefix and exact 13-digit shape are validated independently from
`createdAt`, so archives remain portable across time zones. A unique
`[conversationId+sequence]` index provides the canonical interleaved order for
both owners. An ID collision advances the timestamp candidate and retries the
whole transaction.

Retained rows are inserted with IndexedDB `add`. Ordinary
editing never overwrites one. Content is limited to 32 KiB of UTF-8 and is
stored with the shared text encoding only in the IndexedDB row representation.

Initialization creates one empty user baseline and one empty model baseline in
one idempotent transaction. Editing the user board replaces the single pending
user working row. Sending a user message promotes changed pending content to a
retained version. The transaction pins `Message.user_board` and clears the
pending row. It also writes the message and metadata. Unchanged content pins
the current retained head without creating duplicate history.

First visible enable and preserved-state Workspace re-enable share one
conversation initialization promise under the global generation-blocking
lease. LC holds that lease until it publishes the accepted tools configuration.
Therefore, generation admission cannot observe Whiteboard as disabled after
baseline creation. It also cannot bypass promotion of a pending user copy.

An enabled model turn atomically pins the source user version, writes all three
assistant references, and opens one generation-owned model working row. Reads
use the pinned user version and that working row. The first changed
`lc_whiteboard` mutation assigns a provisional model ID. Later changed calls
overwrite the same working row and update its durable `latestToolCallId`
receipt. A no-op does not create a version.

Terminal settlement serializes
behind admitted mutations and either inserts that provisional content once or
removes an unchanged working row. This applies to success, provider error,
abort, timeout, cutoff, and ordinary generation end.

Lazy-load recovery treats the receipt as durable truth. A committed mutation is
retained and any missing or contradictory tool result is repaired with a
compact success and warning before generic interrupted-tool recovery runs. An
uncommitted row is discarded with an explicit no-change result. Recovery is
idempotent. It discards an orphan whose assistant is gone. It fails closed when
the referenced initial version is missing and does not fabricate a retained
version.

---

## Multi-conversation runtime and recovery state

The application still uses one Dexie database and one durable `Conversation`
row per chat. LC does not clone the database or persist a whole-app settings
snapshot for each active response.

`GenerationExecutionSnapshot` is an immutable in-memory value captured after
synchronous admission and asynchronous preflight, immediately before the
durable send boundary. It contains the selected conversation configuration,
profile protocol/routing facts, model registry/detail, system prompt,
Workspace/tool exposure, helper-model routes/details, shell allowlist, search
route, and round/stream limits. The main provider key, search key, and helper
keys are adjacent runtime secrets. They are never fields of the snapshot,
conversation metadata, journal, archive, or support report. A generation may
add only its own deletion-fenced authorization overlay after a user approves a
conversation grant.

The bounded model-detail cache uses the exact profile ID, model ID, model-list
route, protocol, and routing mode as non-secret ownership facts. A profile
configuration generation is also part of the key. A connection-affecting
profile change advances that generation, so an older result cannot enter a new
execution snapshot. Credentials and request implementations are not cache-key
fields.

`ConversationUiState` is restart-ephemeral and keyed by conversation ID. It
owns draft text and staged attachment metadata, edit identity/draft/blob
ownership, scroll/follow mode, side-panel tab/open state, Workspace disclosure
and expanded-directory state, and preview presentation. A bounded LRU retains
at most 24 nonresident entries. Selected and lifecycle-resident chats cannot be
evicted. Draft attachment blobs transfer to a durable message on Send and are
released on removal, discard, deletion, eligible eviction, or restart orphan
collection.

The minimal durable journal is one row per admitted conversation:

```typescript
interface GenerationRunRow {
  conversationId: string;                 // primary key; one live run per chat
  generationId: string;
  assistantMessageId: string;
  state: 'admitted' | 'running' | 'stopping' | 'interrupted';
  startedAt: number;
}
```

The Dexie schema is version 3. Version 2 added `generationRuns` additively to
the four-table v1 database. Version 3 re-declares that store at a newer native
version. Short-lived pre-release v2 databases that opened before the journal
existed then upgrade normally. The upgrade does not depend on Dexie's
same-version repair.
The v1 migration fixture proves that conversation, message, and Whiteboard
rows survive unchanged. The pre-release-v2 fixture proves that conversation
metadata and Whiteboard rows survive the repair to v3.

It contains no prompt, messages, parameters, filesystem paths, endpoints, or
credentials. Terminal finalization compare-deletes only the matching
`generationId`. Startup discovers every row without a three-row assumption. It
marks each row as interrupted. Lazy conversation load repairs the transcript,
tool calls, and Whiteboard without replaying unknown side effects. The repair is
idempotent.

All transcript/metadata writes pass through a per-conversation persistence
lane. Different chats can write independently. Checkpoints carry generation ID
and transcript revision and coalesce to their newest pending value. A terminal
barrier supersedes queued checkpoints, performs a fresh generation/revision
check, retires the journal, and must settle before the capacity slot is
released. Deletion closes its lane so a queued late write cannot recreate
metadata or messages.

The runtime generation manager is not persisted. It holds the controller,
phase, TPS, and identity projection for up to three conversations. Settings may
lower the effective cap to one or two. The per-profile limiter has no limit
within that cap.

---

## GenerationParams

```typescript
interface GenerationParams {
  temperature: number;                     // 0–1, default 0.5
  temperature_enabled?: boolean;
  top_p: number;                           // 0–1, default 0.95
  top_p_enabled?: boolean;
  top_k: number;                           // 0–200, default 40
  top_k_enabled?: boolean;
  max_tokens: number;                      // 1024–512000, default 96000
  max_tokens_enabled?: boolean;
  repeat_penalty: number;                  // 0.5–2, default 1.1
  repeat_penalty_enabled?: boolean;
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';  // default 'medium'
  reasoning_enabled?: boolean;
  stop?: string;                           // Comma/newline-separated
  system_prompt: string;                   // Editable user- or preset-supplied system prompt
}

type GenerationParamsSnapshot = Pick<
  GenerationParams,
  | 'temperature' | 'temperature_enabled'
  | 'top_p' | 'top_p_enabled'
  | 'top_k' | 'top_k_enabled'
  | 'max_tokens' | 'max_tokens_enabled'
  | 'repeat_penalty' | 'repeat_penalty_enabled'
  | 'reasoning_effort' | 'reasoning_enabled'
>;
```

### The override contract

Each numeric parameter has an `*_enabled` flag. The flag controls the panel's
override behavior. **Toggle on means that LC overrides the value. Toggle off
means that LC sends nothing and the server uses its default.**

The orchestrator
enforces "not sent" by not assigning the field. Downstream code uses
`if (x !== undefined)`. Therefore, absence propagates unchanged to the JSON
body.

`detectPresetName()` reports **Server default** when all six flags are off. It
inspects only those flags. Clicking **Server default** clears the System prompt
and preserves stop sequences, but the user can type another System prompt
afterward without enabling a generation override. The label therefore remains
**Server default**, and LC still sends non-empty `stop` and `system_prompt`
values. Neither field has an override toggle.

Two details worth knowing:

- The gate is `!== false`, not `=== true`. A params object that *lacks* the key
  sends the value. `DEFAULT_PARAMS` writes an explicit `false` for all six.
  Therefore, this behavior affects only params without the keys. Examples are
  old archive imports and storage that predates the flags.
- `top_k: 0` is sent as absent. `0` means "off" in the UI, so an enabled top-k of
  zero is indistinguishable from no override.

### Built-in parameter presets

Each built-in preset applies a distinct generation recipe and writes one short
instruction into the existing, user-editable **System prompt** textarea. There
is no hidden or separately injected preset prompt. Selecting another preset
replaces the textarea with that preset's sentence; the user can then edit it
normally. Selection starts from `DEFAULT_PARAMS`, applies the recipe, and
preserves the current stop sequences. Disabled numeric fields therefore return
to their ordinary stored defaults instead of carrying stale values from the
previous selection; because their toggles are off, they are not sent.

`—` means that the preset leaves that override disabled:

| Preset | Temp. | Top-p | Top-k | Max output | Repeat | Reasoning | System prompt |
|---|---:|---:|---:|---:|---:|---:|---|
| Assistant | `0.4` | — | — | — | — | `medium` | Be helpful, clear, and practical, adapting the level of detail to the request. |
| Balanced | `0.7` | — | — | — | — | `medium` | Balance accuracy, clarity, and useful detail without overexplaining. |
| Brainstorm | `0.9` | — | — | — | — | `low` | Generate varied possibilities freely, including unconventional but relevant ideas. |
| Code | `0.2` | — | — | — | — | `high` | Produce correct, maintainable code and explain only what is necessary. |
| Concise | `0.1` | — | — | — | — | `low` | Answer directly and briefly, omitting nonessential detail. |
| Creative | `1.0` | — | — | — | — | `low` | Favor imaginative, distinctive responses while staying coherent and relevant. |
| Precise | `0.1` | — | — | — | — | `high` | Prioritize accuracy, explicit assumptions, and unambiguous wording. |
| Writer | `0.5` | — | — | — | — | `medium` | Write polished, natural prose with strong structure and consistent tone. |

Preset-name detection compares only the generation controls. Editing the System
prompt or stop sequences does not change the selected preset name; changing a
generation control produces **Custom**. **Server default** disables every
generation override and clears the System prompt. It preserves stop sequences.

The Parameters tab initially expands **Primary parameters** and collapses
**Additional parameters**. Primary is ordered Thinking, Temperature, Max output
tokens, then System prompt. Additional is ordered Repeat penalty, Top-p, Top-k,
then Stop sequences. The Temperature info button is a separate control, so it
remains usable while the range input is disabled. Its click-open reference is
sorted A–Z by displayed family name and includes an emphasized fallback
instruction to turn the override off when model- or mode-specific guidance
differs.

#### Sources and decision record

Provider documentation is the source of truth for field meaning and wire
support. The exact named recipes above are LC product defaults: no provider
publishes or endorses these eight names or exact value combinations. They are
intended to provide meaningfully different starting points on endpoints that
honor the corresponding controls.

The recipes deliberately use temperature as their single sampling override.
Top-p and top-k remain disabled instead of combining three sampling filters.
Maximum output tokens remain model-dependent, and repetition penalty remains
available for manual/local tuning, so both overrides are disabled in every
built-in preset.

The temperature slider has a gentle `0.6` magnet (within `0.02` on its `0`–`1`
range) and a compact, click-open provider reference. The reference summarizes
the current primary guidance used during this review: Qwen 3.5–3.6 use `1.0`
for thinking or `0.6` for precise coding, Qwen 3.7 defaults to `0.6` while
thinking and `0.7` while non-thinking, Qwen 3.8 thinking uses `1.0`, and GLM
5.x, Kimi K2.7/K3, and MiniMax M2.x/M3 use `1.0`. DeepSeek V4 ignores
temperature while thinking. Gemini 3.1 Pro and Gemini 3.7 Flash should omit
sampling overrides and retain the default `1.0`; Gemma 4 standardizes
temperature at `1.0` across use cases; GPT-5 support is generation- and
reasoning-mode-dependent; and Claude 5 rejects non-default sampling values. The
reference directs users to disable the override whenever the model's server
default is the safer choice.

The Code recipe uses `high` rather than `xhigh` as a portable quality-first
starting point. Provider semantics still differ: DeepSeek V4 defaults to
`high`; Z.AI's GLM-5.2 and GLM-5.3 accept `high`; Kimi Code recommends `high`
for Kimi K3; and Qwen3.8 maps OpenAI-style `high` to its own `xhigh`. These
presets do not replace model-specific tuning or evaluation.

- [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create)
  defines temperature and top-p and recommends altering one rather than both.
- [Claude Messages API](https://platform.claude.com/docs/en/api/messages/create)
  defines the legacy sampling fields and marks temperature, top-p, and top-k
  deprecated or unsupported on models after Claude Opus 4.6.
- [Gemini prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies)
  explains how temperature, top-p, and top-k affect sampling and recommends
  retaining model defaults for Gemini 3.x.
- [LM Studio's native chat API](https://lmstudio.ai/docs/developer/rest/chat)
  supports temperature, top-p, top-k, repetition penalty, and output limits,
  with temperature constrained to the same `0`–`1` range exposed by LC.
- [QwenCloud's OpenAI-compatible Chat reference](https://docs.qwencloud.com/api-reference/chat/openai-chat)
  documents Qwen3.8 effort mapping, model-dependent output limits, and the
  recommendation to use `max_completion_tokens` for reasoning models.
- [Alibaba Cloud Model Studio's OpenAI-compatible Chat reference](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)
  documents Qwen 3.7's default temperature as `0.6` in thinking mode and `0.7`
  in non-thinking mode.
- Official Qwen model cards document the reviewed sampling values for
  [Qwen3.5](https://huggingface.co/Qwen/Qwen3.5-35B-A3B/blob/main/README.md),
  [Qwen3.6](https://huggingface.co/Qwen/Qwen3.6-27B), and
  [Qwen3.8](https://huggingface.co/Qwen/Qwen3.8-27B-FP8).
- [Z.AI's Chat Completions reference](https://docs.z.ai/api-reference/llm/chat-completion)
  documents GLM-5.x effort levels, temperature defaults, and output limits.
- [Kimi Code model configuration](https://www.kimi.com/code/docs/en/kimi-code/models.html)
  recommends `high` for Kimi K3 coding sessions and documents its effort
  mappings.
- [Kimi K2.7 Code's official model card](https://huggingface.co/moonshotai/Kimi-K2.7-Code)
  documents its thinking-mode sampling recommendation.
- MiniMax's official model cards consistently recommend temperature `1.0` for
  [M2](https://huggingface.co/MiniMaxAI/MiniMax-M2),
  [M2.1](https://huggingface.co/MiniMaxAI/MiniMax-M2.1),
  [M2.5](https://huggingface.co/MiniMaxAI/MiniMax-M2.5),
  [M2.7](https://huggingface.co/MiniMaxAI/MiniMax-M2.7), and
  [M3](https://huggingface.co/MiniMaxAI/MiniMax-M3).
- [DeepSeek V4 thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
  documents the default `high` effort and notes that temperature has no effect
  while thinking is enabled.
- [Google's Gemini 3 developer guide](https://ai.google.dev/gemini-api/docs/gemini-3)
  recommends retaining the default temperature of `1.0` for all Gemini 3 models
  and warns against lower values for complex reasoning. The current
  [Gemini 3.1 Pro model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview)
  and [Gemini 3.7 Flash guide](https://ai.google.dev/gemini-api/docs/latest-model)
  identify the exact models shown in LC and recommend removing explicit
  temperature, top-p, and top-k parameters in favor of their defaults.
- [Google's Gemma 4 model card](https://huggingface.co/google/gemma-4-31B)
  standardizes temperature at `1.0` across use cases for the Gemma 4 family.
- [OpenAI's current model guidance](https://developers.openai.com/api/docs/guides/latest-model)
  uses “GPT-5 models” and “GPT-5 model family” for the versioned generations;
  LC's compact “GPT 5.x” label is UI shorthand. OpenAI's
  [GPT-5.2 compatibility guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)
  documents generation- and reasoning-dependent temperature support, including
  rejection by GPT-5.1/5.2 outside `none` reasoning and by earlier GPT-5 models.
- [Anthropic's Messages API](https://platform.claude.com/docs/en/api/messages/create)
  documents temperature as deprecated for models after Claude Opus 4.6 and
  rejects non-default values on Claude 5 models.

Consequently, these presets are model-agnostic convenience recipes, not a
portability guarantee. A model that rejects or discourages sampling overrides
should use **Server default** or manually disable the affected controls. The
System prompt sentence remains useful and visible in either case.

These references were reconciled on 2026-08-30. If a provider changes its
contract, update adapter behavior, this section, and the preset tests together.

### What each endpoint actually receives

Gemini REST uses native Interactions. Its versioned root is
`https://generativelanguage.googleapis.com/v1beta`, its endpoint is
`/interactions`, and its badge is green `I`. Native LM Studio `/chat` uses purple
`C`; unknown historical endpoints retain `O`.

An enabled toggle does not guarantee that the parameter reaches the provider.
The API must support the parameter. `—` means that the adapter silently removes
it. Reasoning effort is stricter than the other rows: once the selected protocol
defines an effort field, LC translates only the field shape and forwards the
selected value unchanged. LC does not use a model-name gate or silently remap,
promote, demote, or omit the effort. The provider maps or validates it:

| UI parameter | Chat Completions | Responses | Anthropic Messages | Gemini REST | LM Studio native |
|---|---|---|---|---|---|
| Temperature | `temperature` | `temperature` | `temperature` | — (control inactive) | `temperature` |
| Top-p | `top_p` | `top_p` | `top_p` | — (control inactive) | `top_p` |
| Top-k | `top_k`, except `—` on official OpenAI / Azure | — | `top_k` | — (control inactive) | `top_k` |
| Repeat penalty | `repeat_penalty`. OpenRouter uses `repetition_penalty`. Official OpenAI and Azure use `—`. | — | — | — (control inactive) | `repeat_penalty` |
| Max output tokens | `max_completion_tokens` on official OpenAI, else `max_tokens` | `max_output_tokens` | `max_tokens` — **always sent** | `generation_config.max_output_tokens` | `max_output_tokens` |
| Stop (no toggle) | `stop` | — | `stop_sequences` | `generation_config.stop_sequences` | `stop` |
| Thinking effort | `reasoning_effort` / `reasoning` / `thinking`, by provider | `reasoning.effort` | `thinking` + `output_config.effort`, or `thinking.budget_tokens` | `generation_config.thinking_level` | `reasoning` (scalar) |

The table describes fields LC's adapters can emit; it is not a promise that
every model on that endpoint accepts them. In particular, models after Claude
Opus 4.6 reject non-default temperature, top-p, and top-k. A built-in or manual
override can therefore receive the provider's validation error.

For reasoning, a provider validation error is the correct outcome when a
selected semantic effort is unsupported. The one non-pass-through case is a
legacy Messages endpoint that exposes only manual `budget_tokens`: any effort
to budget conversion is an explicit, model-independent LC approximation and
may be used only when live capability metadata selects that mode. See
[reasoning-and-token-accounting.md](./reasoning-and-token-accounting.md#6-effort-dispatch-table).

`top_k` and `repeat_penalty` are compatible-server extensions rather than
Chat Completions fields. Neither OpenAI's nor Azure's request schema defines
these fields. Therefore, the adapter does not send them to those hosts. The
references do not document how either host handles an undefined field. This
behavior has not been measured. Therefore, LC does not honor the toggle for
those hosts.

**Compatible servers do not all use the same repetition control.** Each server
that defines `top_k` uses that spelling. OpenRouter documents
`repetition_penalty`, and its schema has no `repeat_penalty`. llama.cpp, LM
Studio, and vLLM document `repeat_penalty` instead. `isOpenRouterEndpoint()`
selects the spelling. LC never sends both fields together.

Anthropic Messages cannot use "toggle off, send nothing" for `max_tokens`.
This field is required, so LC always sends it. See
[modules.md](./modules.md#max_tokens-and-the-thinking-budget) for which value it
picks and how that interacts with the thinking budget.

### What is recorded per request

`params` is one live object for each conversation. The panel replaces it when
configuration changes. The assistant message also stores `meta.params`. This
field is a snapshot of the generation controls shown in the footer. `meta.presetName`
stores the human-readable preset label.

The snapshot excludes `stop` and
`system_prompt` because the footer popover does not show them. Older or partial
messages can omit either field. The UI shows `-` for a missing value without
writing a replacement to the message.

To capture send-time values, generate a Support Report while the session is
live. `ActiveRequestSnapshot` captures `reasoningEnabled` and `reasoningEffort`
at the request-assembly boundary. Current UI state describes the UI, not the
request. The snapshot exists only in memory and does not enter an archive.

Assistant messages persist provider continuation state outside the visible
reasoning string. `responses_output_items` holds Responses replay items.
`anthropic_output_blocks` holds complete signed or redacted thinking blocks.
The signature is provider-defined replay state: Anthropic documents encrypted
full thinking there, while MiniMax returns complete plaintext `thinking` beside
its fixed-size 64-hex signature, including through compatible relays.
`opaque_replay_accounting.reasoningCarrier` records the resolved meaning
without altering the replay block.
`reasoning_details` holds MiniMax's structured interleaved-thinking state.
`lmstudio_response_id` holds the native LM Studio state handle.

These fields are canonical conversation data. Normal history construction does
not compact, summarize, prune, or delete them. Tool History changes only the
projection of completed calls and results; it cannot remove reasoning or its
continuation state. A provider may ignore or server-filter a preserved carrier,
but LC records that as provider behavior rather than deleting the archive.

The persisted reply fields `meta.baseUrl` and `meta.model` provide provenance
for Anthropic blocks. Request assembly derives `anthropic_output_origin` from
these fields. Provenance prevents opaque state from leaking to an unverified
provider or relay; it is not a model-name retention policy. Anthropic documents
passing blocks unchanged across Claude model switches and letting its API decide
compatibility. A matched provider contract permits that same-provider switch;
an unmatched compatible relay retains the exact-model safety gate.
Tool History is not a provenance change: it may rebuild the paired tool call and
result, but it retains compatible signed, redacted, and plaintext thinking
blocks unchanged. Adapters emit only the fields for their selected provider.
All four state carriers and the reply metadata survive Dexie and
archive round trips.

---

## ServerProfile

```typescript
interface ServerProfile {
  id: string;
  name: string;
  baseUrl: string;                         // Versioned API base; no terminal operation
  modelFetchUrl?: string;                  // Optional exact model-list URL or path
  apiKey?: string;                         // Runtime fallback when keychain access is unavailable
  apiKeyRef?: string;                      // Keychain lookup key ("profile.abc123")
  note?: string;
  sse_read_timeout_min?: number;           // Per-server default (1–10 min), extendable to 60 via Workspace
  apiVariant?: 'lm-studio' | 'openai' | 'anthropic' | 'gemini';
  apiStyle?: 'chat' | 'responses';          // OpenAI only; current editor default is chat
  routing?: 'proxy' | 'direct';             // Tauri proxy vs direct fetch
  active?: boolean;                        // Toggle for multi-server support
}
```

`baseUrl` is the versioned API root, such as `http://localhost:1234/v1`,
`http://localhost:1234/api/v1`, or
`https://generativelanguage.googleapis.com/v1beta`. Omit terminal operations such
as `/chat/completions`, `/responses`, `/messages`, `/interactions`, and `/chat`.
The selected protocol adapter appends the correct relative path. For Anthropic, the adapter
adds `/v1/messages` if the base URL does not end with a version prefix (`/vN`).
Gemini appends `/interactions`, with `?alt=sse` on streaming requests only.
Selecting an API variant in the editor does not change `baseUrl`; all variants
retain the generic `http://127.0.0.1:1234/v1` placeholder. `apiStyle` applies only
to OpenAI, even though every variant has a visible protocol-chip row.

`modelFetchUrl` is optional. Gemini uses native paginated `<baseUrl>/models`, or
the resolved override, without LM Studio probes. For other variants, when the
override is absent, a local or LAN Base URL that
ends in `/api/vN` uses that version's `/models` endpoint. Other local and LAN
profiles try `<server-root>/api/v1/models` and then `<baseUrl>/models`. Remote
profiles use only `<baseUrl>/models`. When `modelFetchUrl` is present, its
resolved URL is authoritative and LC disables automatic fallbacks. Gemini
pagination still applies to that URL. See [Base URL
Contract and Request URLs](./modules.md#base-url-contract-and-request-urls) and
[Model Discovery](./modules.md#model-discovery).

### Active-generation configuration snapshot

An active generation freezes the mutable execution inputs that later tool
rounds and sub-agents can read. While a generation owner exists, LC rejects or
ignores profile changes and user-triggered model refreshes. It also blocks
changes to the conversation model, parameters, Workspace, and tool
configuration. Portable settings and conversation import or reset are
unavailable. LC also blocks destructive conversation reset and archive
creation. The UI reflects these guards.

This is an execution lock, not a presentation lock. Display and Appearance
remain editable. The model picker remains view-only and searchable. Workspace
and Parameters remain visible, but their configuration controls are inert.
**See current system instructions** and **Open Settings > Workspace** remain
available.

Workspace categories and directory rows can expand or collapse. A
permission decision for the owned tool call remains an abort-aware part of that
generation. It is not an out-of-band configuration change.

---

## Model registry (`useAppModels`)

`useAppModels` is the canonical live source of model metadata. Server discovery,
models.dev enrichment, the persistent base cache, and override persistence are
**inputs**. UI and runtime consumers read effective metadata only from this
registry.

```typescript
interface ModelMetaOverride {
  n?: string;   // display name
  c?: number;   // max context tokens — positive safe integer
  v?: boolean;  // vision
  r?: boolean;  // reasoning
  t?: boolean;  // tools
}

interface ModelRegistryRecord {
  key: string;               // hiddenModelKey(profileId, modelId) — "profileId:modelId"
  profileId: string;
  modelId: string;
  profileActive: boolean;
  origin: 'live' | 'cache' | 'manual';
  detected: AppModelEntry;   // server/native metadata + models.dev fallback enrichment
  override?: ModelMetaOverride;
  effective: AppModelEntry;  // detected + override, merged per field
}

interface ModelRegistrySnapshot {
  records: Record<string, ModelRegistryRecord>;  // active AND inactive profiles
  overrides: Record<string, ModelMetaOverride>;
  models: AppModelEntry[];                       // active effective projection
}
```

### Layers and priority

```text
server/native metadata + models.dev fallback enrichment  <  user override
```
models.dev fills fields that the server did not report. It does not replace
authoritative native/server metadata. The override is the final layer and is
applied **per field**. An explicit `false` overrides a detected `true`. A
missing field means "no opinion" and uses the lower layer.

Generic model metadata and verified wire behavior are deliberately separate.
`public/models-cache.json` remains the compact models.dev enrichment source for
name, context, vision, reasoning, and tool flags. It is not extended with
request or replay rules. `src/modules/llm-client/provider-contracts.v1.json`
stores the versioned LC wire-contract source of truth and is statically embedded
into the production application bundle. It is not a user-editable app-data or
public runtime asset. The contracts record exact provider/product boundaries,
configured protocol, request-control paths, reasoning carrier/replay semantics,
streaming mode, usage paths, and dated evidence. `provider-contracts.ts`
validates, deep-freezes, retains, and resolves that in-memory registry.

When separately sold products expose an identical protocol/origin/path—such as
QwenCloud and Alibaba Cloud Model Studio on the international DashScope
endpoints—the shared wire record lists the other name in `additional_products`.
That does not merge accounts, credentials, billing, or product identity. A
distinct wire root gets a distinct contract.

Resolution uses exact URL origins and declared paths plus the configured
protocol. Optional `match.path_match` selects `exact` or `prefix` (the default).
The native Google contract uses exact `/v1beta` matching, excluding the adjacent
OpenAI compatibility path. Exact model records are used only when a surface declares
`model_policy: "exact-registration"`; an unknown model does not receive a
nearby model's contract. The JSON field `documented_values` is descriptive
capability evidence, not an LC allowlist. The server still maps or rejects a
passed-through effort. The bundled database is capped at 2 MiB and checked by
`npm run check:provider-contracts` before every production build.

Generation admission stores the resolved contract, `matched`/`unmatched`
status, and registry schema version in the immutable main-route snapshot; each
frozen helper route carries the same identity. `LLMClient` resolves the same
embedded registry for direct callers. Chat/Responses controls and the shared
request/TokenMeter history projection consume this identity. An unmatched
origin gets protocol-generic compatibility behavior and unknown accounting,
not first-party semantics inferred from its model ID.

`applyOverride()` is
pure. It never mutates `detected`,
`detected.capabilities`, or the stored override.

### Identity

Identity is always `profileId + modelId`. `hiddenModelKey(profileId, modelId)`
creates the same composite key that the visibility filter uses. No code splits
the key into parts. Therefore, a model ID that contains `:` is safe. The same
model ID from two profiles remains isolated. Each profile has separate records,
overrides, and effective metadata.

### Records vs projection

`records` covers every known profile, including inactive profiles restored from
the base cache. Therefore, the visibility panel can list all profiles from one
source. `models` is the derived array of **active** effective entries. Existing
chat and tool consumers subscribe to this array. LC regenerates both values in
one commit. No consumer can observe a partial registry update.

Override changes (`setMetadataOverride`, `removeMetadataOverride`,
`replaceMetadataOverrides`, `resetMetadataOverrides`) recompute effective
metadata and the projection **synchronously**. They do not refresh the server
or use the network.

### Base cache vs overrides

The persistent base cache (`lc:server-model-cache`) stores only the DETECTED
layer. It never stores user overrides. Detected values remain Boolean values,
including `false`. Therefore, a known-negative capability survives a cold start
and applies to inactive profiles without a live probe.

Each cached server entry identifies the base URL, optional model-fetch URL, and
API variant that produced it. Bootstrap, failed-refresh fallback, and Restore
defaults use an entry only when these fields match the current profile. An old
entry that does not contain a model-fetch URL is compatible only with a profile
that also uses the default model-fetch route.

One profile cache contains at most 16,384 detected model entries. Discovery
response bodies are limited to 64 MiB, and enrichment runs at most 16 model
lookups concurrently. A models.dev snapshot contains at most 1,024 providers
and 65,536 models. Its response body is limited to 64 MiB; the desktop compact
cache is limited to 16 MiB when LC reads or writes it. LC also applies the limit
before it replaces the in-memory cache. If a fresh downloaded compact cache
violates these limits, LC uses the bundled cache. It never installs a cache that
the next restart would reject.

LC validates the cache root, each server entry, and each model entry after
JSON parsing. It drops malformed cache data. It rejects a persisted profile
entry that exceeds 16,384 models as a whole; it does not present a truncated
list as complete. The next successful probe writes a plain cache object, so
malformed data cannot swallow a valid update.

Context overrides affect model presentation and the chat token meter only.
They do not alter Rust request limits, sub-agent `max_tokens`, truncation,
provider parameters, or execution policy. The token meter uses `256000` as the
display fallback for an unknown context window. This visual and accounting
default is never persisted as detected metadata.

---

## Storage Layout

LC uses a **two-tier lazy-load architecture** with Dexie (IndexedDB):

| Store | Key/Table | Format |
|---|---|---|
| Conversation metadata | `lc:conversations` / `conversationsMeta` | Dexie table — title, timestamps, model, messageCount, params, tools, and custom skills metadata |
| Messages | `lc:conversations` / `messages` | Dexie table — content, reasoning, refusal, Responses/Anthropic replay state, compressed `opaqueReplayAccountingJson`, native Gemini response groups in compressed `geminiInteractionsJson`, tool calls/results, permission-popup audits, usage/meta, attachment metadata, line-change metadata, and sortOrder. Indexed by `[conversationId+sortOrder]` for stable sort |
| Retained Whiteboard versions | `lc:conversations` / `whiteboardVersions` | Dexie table introduced in schema v1 and preserved in current schema v3. It is keyed by `[conversationId+id]`. Rows are immutable. Content uses the shared text encoding. The table is indexed by conversation, owner, unique conversation sequence, and `[conversationId+owner+sequence]`. |
| Whiteboard working state | `lc:conversations` / `whiteboardWorking` | Dexie table introduced in schema v1 and preserved in current schema v3. It is keyed by `[conversationId+owner]` and holds at most one pending user row and one generation-owned provisional model row per conversation. |

Message and Whiteboard text uses `Z:` to mark compressed row content. Raw text
with that prefix is always compressed, even when compression increases its size.
Replay accounting is an optional, unindexed sibling column, so it requires no
Dexie index-version bump. Row mapping, checkpoint updates, clone, archive, and
legacy import all pass through the same strict validator. It accepts legacy
rows without the field and drops malformed/stale groups. No ciphertext,
summary text, request body, or stable content digest is copied into accounting.

Gemini's separate `geminiInteractionsJson` column is also optional and unindexed.
It retains whole native response groups, including opaque signatures, raw usage,
and thought-step locators. Its strict validator rejects malformed or excessive
native state rather than dropping it. Archive import validates these groups
before restoring any attachments or rows. Missing legacy fields remain valid.

> **`sortOrder` must hold one value domain.** `appendMessage` assigns a small
> sequential counter, such as 1, 2, and 3. Legacy rows can contain timestamp
> values from the `msg.sortOrder ?? msg.createdAt` fallback. `loadMessages`
> detects these rows and reads the mixed transcript by `createdAt`. Lazy load
> then re-sequences all rows and persists the counter domain. Archive import
> also re-sequences messages when a value is absent or outside the counter
> domain. New write paths must set `sortOrder` explicitly.
| Settings | `lc:settings` | Zustand + localStorage. Store schema is version 2; version 2 replaced the `solidTheme` field with `materialMode` (`auto`, `glass`, `solid`), preserving each user's effective preference (`auto`→`auto`, `off`→`glass`, `on`→`solid`) and deleting the legacy key on migration. |
| Profiles | `lc:profile-store` | Zustand + localStorage |
| Model cache | `lc:server-model-cache` | localStorage with TTL |
| Model visibility | `lc_hidden_models` (+ `lc_hidden_models_bak`) | localStorage stores a `Set<string>` of `"profileId:modelId"` keys. `modelId` is the complete server identifier, including LM Studio publisher and repository prefixes. A valid empty primary array is authoritative. LC reads the backup only when the primary is missing or malformed. |
| Model metadata overrides | `lc_model_meta_overrides` (+ `lc_model_meta_overrides_bak`) | localStorage stores `Record<"profileId:modelId", {n?,c?,v?,r?,t?}>`, including an optional display-name override. Both keys are rewritten after each change. A **valid empty** primary object is authoritative. LC reads the backup only when the primary is missing or malformed. It does not store empty or invalid entries. |
| Model-list customizations | `lc_model_customizations` (+ `lc_model_customizations_bak`) | localStorage — manually added model definitions and deleted-server-model tombstones, grouped by profile. The server cache remains unchanged, so Fetch models refreshes detected metadata without erasing additions or resurrecting deletions. Restore defaults clears this layer for one profile. |
| Attachments | IndexedDB `lc/attachments` | Binary blobs use the attachment ID as the key. Delete collects IDs from durable messages. It removes blobs only after the conversation transaction commits. A failed transaction restores the optimistic UI deletion. Clone stages fresh blobs and removes them if clone persistence fails. Branch replacement removes blobs that no surviving message owns. Startup cleanup removes older orphaned blobs. |
| API keys (Tauri desktop) | Platform config directory (`%APPDATA%/lc/keys/`, `~/.config/lc/keys/`, or `~/Library/Application Support/lc/keys/`) | Tauri stores AES-256-GCM encrypted files under collision-free application reference names. Plaintext is limited to 64 KiB and encrypted input to 128 KiB. Each write uses a staged, flushed, synced, and atomic replacement. Browser and development mode has no encrypted keychain backend. Reads miss, deletes have no effect, and writes **reject**. Callers then keep the documented plaintext fallback. |

Each logical mutation records one closed-code storage outcome. This boundary
covers Dexie, attachment blobs, localStorage stores, and desktop key-store
mutations. The diagnostic contains no storage key or stored value.

### Lazy-load lifecycle

1. **App start:** `hydrate()` loads all `conversationsMeta` rows. Zustand `byId`
   then contains only metadata (`messages: []`).
2. **Select a chat:** `loadConversationMessages(id)` fetches all messages from
   Dexie. Counter-domain rows use `sortOrder`. Mixed legacy rows use
   `createdAt`. The load re-sequences mixed rows before other transcript
   repairs. It then persists all required repairs together. Before generic
   tool repair, the load reconciles Whiteboard working state and receipts.
3. **Memory residency:** The selected conversation and every conversation with
   transcript work in flight retain messages in Zustand. The resident set
   includes running/stopping generations, chat admissions, send or
   branch durability boundaries, pending loads, terminal prerequisites, queued
   deletes, and conversation-scoped lifecycle operations. `setActive`, create,
   and clone evict only complete, clean conversations outside that set. An
   incomplete or partially loaded transcript remains pinned rather than being
   treated as authoritative. Selecting an evicted conversation reloads it from
   Dexie.
4. **Lazy-load ownership:** One conversation load token owns each pending read.
   LC applies a resolved snapshot only if it is the latest read and memory has
   no history. An identical retry can reconcile `messageCount` without
   overwriting newer memory content. Each successful read derives and persists
   `messageCount` from the returned Dexie rows. This process repairs stale
   metadata after a split write failure. The composer is disabled while the
   active read is pending or completeness is unproven.
5. **Streaming:** Each generation owns
   `{conversationId, generationId, assistantMessageId}`. Every 5s, Dexie
   bulk-upserts that assistant and all following tool results. At owner release,
   a delete-and-replace transaction writes only if `messages.length` proves
   completeness against `messageCount`. LC upserts an incomplete snapshot
   without deleting rows. Therefore, a failed lazy load cannot delete older
   durable rows.
6. **Persistence failure:** Rejected conversation reads and writes publish a
   throttled notice with a severity. Failed reads have dedicated wording. A
   safe non-deleting fallback is informational. LC consumes notices by
   occurrence token after display.
7. **Export:** Conversation archive creation is unavailable while a generation
   owner exists. The archive builder rejects stale or programmatic attempts.
   Otherwise, it loads messages for one conversation at a time when the live
   array is not proven complete. Export rejects an unproven snapshot when no
   loader is available. It derives `messageCount` from serialized rows and uses
   the canonical Dexie row shape. It excludes transient fields such as

   `streaming` and attachment `dataUrl`. Import removes the same transient
   fields before it publishes state. Import owns `sortOrder` re-sequencing.
   See the Conversation Archive section.

Conversation deletion, full wipe, branch replacement, clone, and archive import
use the owning conversation lane. Their conversation transactions include the
applicable Whiteboard rows and message references. User-send promotion, model
admission, receipts, and terminal settlement use the same transaction boundary.

Clone preserves retained IDs because each ID is conversation-scoped. Clone
copies only required rows and remaps `sourceMessageId`. Clone stages attachment
blobs before the conversation transaction. Failure removes the staged blobs.

Retry and edit remove versions that only the discarded branch owns. They also
remove attachment blobs that no surviving message owns. Working rows are never
cloned or exported.

---

## Export / Import

Settings JSON and conversation ZIP files each have a strict format discriminator
and version. Settings JSON and the conversation archive are both version 1.
Import accepts only a supported discriminator/version pair. An incompatible
future format must bump its version and be rejected until its importer is
implemented.

Every LC-generated export ends with a local 24-hour timestamp in
`YYYY-MM-DD-HHmm` form. The export types use these filenames:

- bulk conversations: `lc-chat-v1-all-YYYY-MM-DD-HHmm.zip`
- one conversation: `lc-chat-v1-<conversation-id-prefix>-YYYY-MM-DD-HHmm.zip`
- settings: `lc-settings-v1-YYYY-MM-DD-HHmm.json`.

### Conversation Archive (`.zip`)

Full lossless round-trip for conversation data, including custom skills:

```
archive.zip
├── conversations.json        // Conversations, messages, tools, and attachment metadata
├── whiteboard.json           // Immutable retained Whiteboard rows grouped by conversation
├── README.txt                // Human-readable export summary
├── skills/
│   ├── manifest.json         // Custom-skill identity and metadata per conversation
│   └── lc_skill_*.md         // Custom Markdown files, without custom IDs
└── attachments/
    └── <id>-<name>           // Raw binary blobs
```

Built-in skills are never included because LC resolves them from its bundled
registry. `conversations.json` intentionally omits `custom_skills`. The
manifest and Markdown files reconstruct them during import. Custom UUIDs,
descriptions, revisions, timestamps, enabled IDs, and Markdown bodies are
preserved. A skill manifest that is present but invalid or references a missing
skill file makes the archive import fail instead of silently losing skills.

Re-importing an existing conversation ID uses one transactional replacement for
metadata, message rows, retained Whiteboard rows, and working-row cleanup. Empty
message and Whiteboard replacements are meaningful, so omitted local history
cannot reappear after reload. `whiteboard.json` is mandatory in version 1 and
contains decompressed retained content. Pending user and provisional model rows
are never archived. An archive with any non-version-1 envelope receives the
specific unsupported-version error, not a generic not-an-LC-archive error.
Message references and retained source-message/tool-call links are validated
against their owning conversation.

Import is bounded and shape-checked. LC checks the file size, zip entry count,
and decompressed size of each entry before decompression. Each conversation
entry must have the conversation shape, including messages and attachments.
After decompression, LC verifies each ZIP entry's CRC-32 and exact size.
Each attachment must also match the byte size in `conversations.json`.
Each message must have a nonempty ID, a supported role, string content, and a
finite creation time. A malformed archive returns an archive error instead of a
raw exception. Export uses the same limits and refuses a ZIP that its importer
would reject. A bulk export can therefore stop at the 1,000-entry or 1 GB limit.
The user can export each conversation from its sidebar action instead. Import
re-sequences messages in archive order when `sortOrder` is absent or outside the
counter domain. Therefore, a legacy archive cannot inject the timestamp fallback
domain into the indexed column.

Archive export loads authoritative message histories sequentially. It still
retains projected messages for every exported conversation. Attachment byte
entries, serialized JSON, and the final ZIP can coexist in memory.
`buildArchive()` uses `zipSync`; the current implementation does not stream
the archive. The size limits above do not imply a one-conversation memory bound.

### Whiteboard Package (`.zip`)

The standalone Whiteboard package is not a conversation archive. It contains
exactly two root entries, `model.md` and `user.md`, captured from the overlay's
currently visible documents. Its filename is
`lc-whiteboard-YYYY-MM-DD-HHmm.zip` (with the platform's numeric duplicate-name
suffix also accepted on import). The compressed input is capped at 128 KiB.
Each UTF-8 entry is capped at 32 KiB. Combined decompressed output is capped at
64 KiB.

Extra, duplicate, missing, invalid-UTF-8, or both-empty entries are rejected.
The native picker performs a bounded read before allocating the selected file.
The web path applies the same compressed-size boundary before ZIP parsing.

Package import is administrative rather than historical replay. It is available
only when all these conditions are true:

- The conversation has exactly two untouched empty baselines: user sequence 1
  and model sequence 2.
- No pending or provisional row exists.
- No generation-blocking operation is active.
- The UI and operation boundary require the independent global
  `isAnyStreaming()` gate to be false.

The write transaction reads eligibility again. One whole-transaction collision
retry then inserts a fresh model version followed by a fresh user version. It
preserves the exact Markdown. At least one document must contain content. Import
never installs source-device IDs or replaces established history.

### Settings Export (`.json`)

The export filename is `lc-settings-v1-YYYY-MM-DD-HHmm.json`. The export
includes profiles, theme, zoom, tools configuration, material-mode preference
(`materialMode`; legacy exports carrying `solidTheme` in place of it remain
importable and map to the equivalent mode), custom themes, the model visibility
filter, auto-archive policy, `maxConcurrentGenerations`, and the
`showOnlyLatestTodoList` presentation preference. It does not include custom
skills, conversation data, runtime sessions, chat admissions,
execution snapshots, or conversation UI state.

Search-provider API keys for Brave and Marginalia are
excluded. Their keychain references and the SearXNG base URL are included. The
SearXNG URL must satisfy the shared
[URL credential rule](./security.md#url-credential-rule). The writer removes
URL user-info and recognized credential parameters from queries and structured
fragments. This rule applies to profile, model-fetch, and SearXNG URLs. It also
applies to model-fetch overrides in the supported `path` and `/path` forms.
Their relative form and ordinary URL components remain portable. Imports reject
URLs that contain these credential forms. Import also rejects a nonempty
SearXNG value that is not a valid HTTP(S) URL. The writer emits an empty
SearXNG value instead of copying invalid text or another URL scheme. The export
also includes the selected search provider.
Profile API keys and user-defined request-header names and values are excluded.
The profile's LC-identifier preference remains portable, but an omitted custom
identifier falls back to LC's built-in identifier. Additional request headers
are disabled in the exported profile and must be re-entered after import.
The importer accepts only `brave-search-key` and `marginalia-search-key` for
those references. A profile reference must equal `profile.<profile-id>`. Profile
IDs use the keychain-safe lowercase ASCII grammar and must be unique in the
file. Import rejects a cross-bound or colliding reference before it changes
settings. When settings are applied, a profile reuses a local reference only
if its ID, reference, base URL, and model-fetch URL match the live profile.
Otherwise, LC imports the profile without a credential reference. Thus, a
portable endpoint cannot select another local credential.

`maxConcurrentGenerations` is the value behind **Settings → Chat →
Concurrent chats**. The writer emits `1`, `2`, or `3`. The validator rejects
every other defined value. It remains optional in the version-1 wire format so
settings files created before concurrent chats remain importable. A missing
field imports as `2`, the current conservative default. Importing or resetting
Settings changes later admission and never persists, restores, or terminates a
runtime generation session.

`showOnlyLatestTodoList` is the Boolean behind **Settings → Chat → To-do list
preview**. `true` selects **latest only** and is the new/reset default; `false`
selects **all updates**. The writer always emits the field, while the version-1
wire format keeps it optional so older exports remain valid. A missing field
imports as `true`. This preference filters only the Preview Overlay body and
Copy output; it does not rewrite stored todo snapshots or their request
projection.

Import replaces these portable fields and keeps transient UI and session state.
An empty hidden-model list clears the local selection. `readSettingsFile`
rejects files larger than 5 MiB before parsing. Import replaces the
`brave_search_api_key` and `marginalia_api_key` fields only when the file has a
key or keychain reference. If the file has neither, import keeps the local
value.

Therefore, the plaintext fallback survives import in a web build or
after a failed keychain write. A profile keeps its local plaintext `apiKey`
fallback only when its ID, keychain reference, base URL, and model-fetch URL
all match the live profile. Otherwise, the imported profile has no local
credential reference or plaintext fallback.

Per-model metadata overrides travel in the optional `modelOverrides` field:

```typescript
modelOverrides?: Record<string, { c?: number; v?: boolean; r?: boolean; t?: boolean }>;
```

The writer always emits a deep copy for each entry. The field is optional on
the wire because some version-1 exports predate it. Those exports must remain
importable. A file without the field imports it as `{}`. Settings import uses
replacement semantics, so this value clears the current overrides. It does not
partially merge them.

The validator requires a plain record of plain records. `c` must be a positive
safe integer. `v`, `r`, and `t` must be Boolean values when present. The
validator rejects arrays, null entries, and invalid context values. Invalid
context values include non-finite, fractional, and non-positive values.

Import also clears `lc:server-model-cache` before a cache-first registry rebuild.
Imported profile IDs can match IDs from the previous installation. Without the
clear operation, they would inherit its detected metadata. **Reset settings**
and the full wipe (`clearAndResetAll`) both clear the in-memory override state.
They also clear both storage keys through the store, not by deleting
localStorage keys.
