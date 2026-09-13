# Modules

This document describes the four bounded modules that form the application
core.

---

## `llm-client/` — Protocol Adapters

**One adapter handles each API protocol.** Each adapter implements the
`ChatStreamAdapter` interface:

```typescript
interface ChatStreamAdapter {
  readonly protocol: 'openai' | 'anthropic' | 'lmstudio-rest' | 'gemini-rest';
  readonly streamEndpoint: string;
  buildRequest(params: AdapterRequestParams): unknown;
  buildHeaders(apiKey: string): Record<string, string>;
  parseStream(body, callbacks, timeoutMs, toolAcc): Promise<StreamResult>;
}
```

### Adapters

| Adapter | File | Protocol | Relative endpoint |
|---|---|---|---|
| `OpenAIAdapter` | `adapters/openai.ts` | OpenAI-compatible (OpenAI, LM Studio, DeepSeek, MiniMax, Qwen) | `/chat/completions` |
| `OpenAIResponsesAdapter` | `adapters/openai-responses.ts` | OpenAI Responses API | `/responses` |
| `AnthropicAdapter` | `adapters/anthropic.ts` | Anthropic Messages API (Claude, LM Studio Anthropic-compat, DeepSeek, MiniMax, Alibaba MaaS) | `/v1/messages` (or `/messages` if base URL already ends with `/vN`) |
| `LMStudioRestAdapter` | `adapters/lmstudio-rest.ts` | LM Studio native REST | `/chat` |
| `GeminiRestAdapter` | `adapters/gemini-rest.ts` | Google native Interactions | `/interactions` |

Native Gemini replay, usage, discovery, and fixture-only verification are
documented in [Google Gemini native REST](./note-gemini-rest.md).

### Base URL Contract and Request URLs

A server profile stores an **API base URL**, not a complete operation endpoint.
Include the provider's API version or base path, such as `/v1`, `/v4`, or
`/api/v1`, or `/v1beta` for Gemini. Omit terminal operations such as
`/chat/completions`, `/responses`, `/messages`, `/interactions`, and `/chat`.
`LLMClient` removes whitespace and trailing slashes.
It applies proxy routing when configured. Then it appends the selected adapter's
relative endpoint.

For the Anthropic adapter, `LLMClient` detects whether the base URL ends with a
version prefix (`/vN`):
- Base URL ends with `/vN` → appends `/messages` (the version prefix is preserved)
- Base URL does not end with `/vN` → appends `/v1/messages` (the canonical Anthropic version is supplied)

Thus, `https://api.anthropic.com/v1` and
`https://api.minimax.io/anthropic` both produce the correct `/v1/messages`
endpoint.

| Profile type | Configured Base URL | Resulting generation URL |
|---|---|---|
| OpenAI Chat Completions | `https://api.openai.com/v1` | `https://api.openai.com/v1/chat/completions` |
| OpenAI Responses | `https://api.openai.com/v1` | `https://api.openai.com/v1/responses` |
| Anthropic Messages (with /vN) | `https://api.anthropic.com/v1` | `https://api.anthropic.com/v1/messages` |
| Anthropic Messages (bare) | `https://api.minimax.io/anthropic` | `https://api.minimax.io/anthropic/v1/messages` |
| LM Studio OpenAI-compatible | `http://127.0.0.1:1234/v1` | `http://127.0.0.1:1234/v1/chat/completions` |
| LM Studio native REST | `http://127.0.0.1:1234/api/v1` | `http://127.0.0.1:1234/api/v1/chat` |
| Gemini native REST | `https://generativelanguage.googleapis.com/v1beta` | `https://generativelanguage.googleapis.com/v1beta/interactions` |

Do not paste a complete operation endpoint into Base URL. This duplicates its
final segment. For example, `/v1/messages` would produce
`/v1/messages/messages` for Anthropic generation.

### Anthropic's own API

`api.anthropic.com` rejects requests that omit the `anthropic-version` header.
This applies to `/v1/models` and `/v1/messages`. It is an Anthropic requirement,
not part of the compatible wire format. DeepSeek, MiniMax, Qwen, Z.ai,
OpenCode, and local LM Studio use the same protocol without this header.

LC sends the header only when the Base URL belongs to Anthropic.
`isAnthropicOwnApi()` in `anthropic-version.ts` makes this decision.
`requiresAnthropicVersion()` is the header-specific alias that calls it. The
chat adapter's `buildHeaders()` and model discovery use this predicate. Base URL
keying also controls other provider-specific behavior. Examples are the Z.ai
model-list merge and the MiniMax and DeepSeek request shapes.

Two first-party request fields are currently keyed on the same endpoint
predicate. A compatible server has no reason to accept either field unless its
own contract says so:

| Field | Why |
|---|---|
| `cache_control: { type: 'ephemeral' }` at the request root | Anthropic caching is opt-in. Without this field, nothing is cached and each counter returns `0`. The top-level form lets the server place and advance the breakpoint. LC does not insert one. See [cache-observability.md §3.1](./cache-observability.md#31-anthropic-caching-is-opt-in). |
| `thinking.display: 'summarized'` | Anthropic-specific presentation control. Current LC chooses it through model-name logic; that is a [known implementation deviation](./reasoning-and-token-accounting.md#10-current-implementation-deviations), not an approved capability rule. Display controls readable summary versus omission. It neither proves zero reasoning nor changes the opaque replay signature. |

The version value is pinned as `ANTHROPIC_API_VERSION`. `anthropic-version` is
a dated API contract with two historical values: `2023-01-01` and
`2023-06-01`. It has no `latest` alias. Therefore, an unrecognized value is an
error, not a newer contract. Within a version, Anthropic guarantees that
existing request and response parameters continue to work.

It permits only
additive changes. New models and features use model IDs and the separate
`anthropic-beta` header. They do not use a version change. Keep the value
pinned.

### Provider-Specific Reasoning

Provider reasoning behavior is owned by the
[normative reasoning contract](./reasoning-and-token-accounting.md). The short
module rule is:

1. select the documented endpoint dialect;
2. translate only the wire shape;
3. forward the selected effort unchanged;
4. use live model capability metadata when a server exposes it;
5. preserve returned reasoning structurally and let the server map or reject
   unsupported values.

Base-URL predicates can select a provider dialect whose field names genuinely
differ. They must not select an effort value. Model-name allowlists, effort
folding, and silent omission are prohibited. The existing adapters still
contain several such branches; they are explicitly listed as
[current implementation deviations](./reasoning-and-token-accounting.md#10-current-implementation-deviations),
not documented here as correct behavior.

The Anthropic Models API reports supported thinking types and effort levels.
That response is the source of truth for first-party Claude models. A
name-parsing table is not an acceptable long-term fallback. Compatible Messages
servers that expose no capability metadata use their documented protocol shape
and return their own validation errors.

#### `max_tokens` and the thinking budget

The Messages API **requires** `max_tokens`. Therefore, LC cannot honor an off
toggle by sending nothing on this endpoint. See
[data-model.md](./data-model.md#the-override-contract). LC resolves the value
in this order:

| Source | When |
|---|---|
| The user's max-tokens override | The toggle is on |
| The model's reported `max_output_tokens` | Toggle off, and `GET /v1/models` reported a ceiling |
| `4096` | The toggle is off, and no ceiling was reported. This floor is an LC default, not a reported fact. |

For capability-selected legacy `budget_tokens` mode, the limit and budget are dependent. The
budget comes from `max_tokens`, so the API requires a strictly smaller budget.
LC previously selected the two values from unrelated fallbacks without
comparing them. A server without a reported ceiling kept `max_tokens` at 4,096.
At the same time, `max` effort requested 16,384.

Each request at medium effort
or higher failed with `max_completion_tokens [4096] must be greater than
thinking_budget [16384]`. Four of the six effort levels did not work. This
failure was observed on QwenCloud with `qwen3.8-max`.

`resolveThinkingBudget()` ties them at a 2.5× ratio. Which value moves depends on
whether the limit is a fact or LC's own invention:

| LC knows | `max_tokens` | Thinking budget |
|---|---|---|
| A user override | the override, verbatim | clamped to fit under it |
| A reported ceiling | the ceiling, verbatim | clamped to fit under it |
| Neither | `budget × 2.5` | as requested |

The toggle contract prohibits increasing `max_tokens` above the user's override.
Increasing it above the model's ceiling causes a different rejection. A real
limit is a hard cap, so LC reduces the budget. Without a real limit,
`max_tokens` is only a placeholder. The user selected the effort level, so LC
increases `max_tokens`.

The clamp applies only below `budget × 2.5`. The threshold is 61,440 for `max`
and 5,120 for `low`. Above the threshold, the full budget passes through. Thus,
the UI default of 96,000 does not change any effort level. Below the threshold,
the clamp progressively dominates the effort selection.

Budgets are `low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 24576`.
Anthropic documents a minimum `budget_tokens` value of 1,024. A cap at or below
that value satisfies neither constraint. A 1,024-token limit has no room for a
legal budget at any effort level. LC lets the provider report the error instead
of silently disabling thinking.

Adaptive models are unaffected because they have no `budget_tokens`. LC does
not clamp or increase their values. MiniMax is also unaffected. Its override
replaces `thinking` after conversion and removes the budget. Therefore,
`buildRequest()` restores the independent limit.

A low limit silently reduces the selected effort. Therefore, the Parameters
panel keeps **Max output tokens** in the expanded-by-default Primary group with
Thinking and Temperature, rather than in Additional parameters. Its exact order
is Thinking, Temperature, Max output tokens, then System prompt.

Anthropic-shaped `thinking` signatures and `redacted_thinking` payloads are
provider-native continuation state. The stored Base URL and model record their
origin, but Anthropic explicitly documents replay across Claude model switches:
LC must preserve the unchanged blocks on the same verified provider surface and
let Anthropic filter compatibility. Matched contracts do this; unmatched
compatible relays keep the exact-model safety gate.
Tool History does not change provenance and cannot remove a reasoning block.
On Anthropic's own API, a signature carries encrypted full thinking. MiniMax's
documented Anthropic-compatible block instead exposes complete plaintext
`thinking` beside a fixed-size 64-hex replay signature. LC recognizes that
shape through compatible relays, counts the text locally, and preserves the
signature unchanged.

**Verification status: fixture-only.** The failure has live evidence. On
2026-08-06, QwenCloud's Anthropic Messages endpoint rejected `qwen3.8-max` with
`max_completion_tokens [4096] must be greater than thinking_budget [16384]`.
The reasoning override was `max`, and every other toggle was off.

Only adapter unit tests cover the fix. The corrected request has not run against
that endpoint or another live endpoint. As
[streaming.md](./streaming.md#adapter-constraints-proven-against-live-endpoints)
explains, unit tests verify the emitted shape. They do not verify server
acceptance. A protocol-shape change requires a live endpoint. Until then, treat
the precedence table as LC's intent, not as a provider contract.

### SSE Parsing

- **OpenAI:** Shared SSE decoding handles CRLF and split-chunk events. It also
  handles delta merging, refusals, usage, and tool calls. The parser extracts
  `reasoning_content`, `reasoning`, and `reasoning_details`. It removes duplicate
  suffixes from MiniMax cumulative fields. It retains final structured details
  for tool-loop replay.
- **OpenAI Responses:** Shared SSE decoding accepts the documented Responses
  family carriers `response.output_text.delta`,
  `response.reasoning_text.delta`, `response.reasoning_summary_text.delta`,
  `response.completed`, `response.content_part.delta`,
  `response.reasoning.delta`, and `response.done`. That union is parser
  tolerance, not a claim that every compatible provider emits the same subset
  or gives a familiar event name the same meaning. The parser handles refusals,
  reasoning display text, and function-call arguments. It persists completed
  output items as the structural authority for replay and classification.
- **Anthropic:** The parser handles named SSE events with LF, CRLF, or CR
  framing. The event names are `message_start`, `content_block_start`,
  `content_block_delta`, `message_delta`, and `message_stop`. The content-block
  state machine tracks `thinking_delta`, `signature_delta`, `text_delta`, and
  `input_json_delta`. It retains complete signed or redacted thinking blocks
  for replay within the verified provider boundary. The current exact-model
  gate is a documented deviation; Anthropic owns same-provider model-switch
  filtering. First-party Anthropic signatures are opaque; MiniMax signatures
  accompany locally countable plaintext thinking.
  `convertToAnthropicRequest()`
  maps OpenAI messages to Anthropic format.

  It moves the system message to the
  top level and converts tool calls and results to content blocks. It also
  normalizes adjacent messages with the same role.
- **`LMStudioRestAdapter`:** LM Studio native named events from `chat.start` to
  `chat.end` use the shared decoder. The adapter processes `message.delta`,
  `reasoning.delta`, and `error`. It ignores other events. A request contains
  only the latest user input. Text items use `type: 'text'`. If the server
  rejects that value, LC retries with documented `type: 'message'`.

  LC persists the `response_id` from `chat.end`. The next native turn uses it
  as `previous_response_id`. This behavior targets the current native API.
  Older LM Studio builds might not support these fields. A response ID can
  become stale after server restart or eviction. LC has no automatic transcript
  fallback for a stale ID.

  The native endpoint strictly validates the body. `client.ts` handles two
  routine rejections: input item type and unsupported `reasoning` value. It
  makes at most two corrected retries for each turn. Diagnostics record them as
  `input-shape-retry` and `reasoning-retry`. See
  [streaming.md](./streaming.md#lm-studio-rest-lmstudio-restts). Non-standard
  statistics include `tokens_per_second` and `total_output_tokens`.

### Transport Layer

- **`transport/fetch.ts`** — Tauri `invoke('proxy_request')` for non-streaming, `fetch` for web.
- **`transport/stream-fetch.ts`** — Tauri `invoke('proxy_stream')` relay for SSE
  over a pre-registered IPC `Channel`. It enforces a 16 MiB JS queue budget and
  passes the response-header timeout to Rust. It propagates abort, cancel, and
  error teardown to the native relay.
- **`transport/read-timeout.ts`** — Per-chunk idle watchdog with `Promise.race`.
  Rust separately limits response establishment. After headers, native reads
  remain cancellation-aware, and JS owns the idle deadline.

### Model Discovery

- **`models/list.ts`** — Fetches server models with the deterministic rules
  below for OpenAI, Anthropic, and LM Studio. Among these variants, chat
  `apiVariant` does not select the model-list URL. LM Studio's
  metadata-rich native REST endpoint remains useful when chat uses OpenAI or
  Anthropic format. One provider adds a header. See
  [Anthropic's own API](#anthropics-own-api).
- **`models/gemini.ts`** — Native Gemini `models.list`, selected by the Gemini
  adapter before the shared LM Studio/OpenAI discovery path. Uses
  `x-goog-api-key`, bounded pagination, exact IDs with only the initial `models/`
  resource prefix removed, server input/output limits, and exact registered
  capabilities. It does not probe LM Studio endpoints.
- **`models/url.ts`** — Classifies local/LAN profiles, computes the automatic URL shown in Settings, and resolves optional URL/path overrides.
- **`models/enrich.ts`** — Merges model lists with the compact `models.dev`
  cache. Enrichment adds display names, context windows, and capabilities.
  `lookupInProviders()` has a prefix-removal fallback. If exact and
  case-insensitive lookup fail for `publisher/model`, it removes the publisher
  prefix and tries again. Thus, publisher-prefixed LM Studio keys can match
  unprefixed `models-cache.json` entries.

  Native server capabilities and
  context limits have priority. Enrichment fills missing fields. This module
  also owns `loadCompactModelsCache()`, the only compact-cache loader. The
  loader memoizes the bundled asset. A manual browser refresh can install an
  optional runtime override.
- **`models/lmstudio-native.ts`** — LM Studio native model discovery and model
  load/unload requests. Model management uses the owning server profile's API
  key, including credentials stored through `apiKeyRef`.
- **`provider-contracts.ts`** — Strict schema, embedded registry accessor, and
  exact resolver for `provider-contracts.v1.json`. The registry is validated,
  deep-frozen, and retained in memory when the module loads; the compatibility
  async loader performs no fetch. Resolution uses declared
  origins, declared exact paths or path prefixes, configured protocols, and
  optional exact model IDs. `match.path_match` defaults to `prefix`; Google
  native Interactions explicitly selects `exact` for `/v1beta`.
  It never identifies a provider from a model name. Generation snapshots,
  `LLMClient`, Chat/Responses request controls, provider-history projection,
  and TokenMeter consume the resolved contract. Separately sold products
  sharing an exact wire boundary use `additional_products` instead of duplicate
  matches; credentials and account identity remain separate. Exact-registration
  unknown models use only surface facts. Unmatched providers receive a
  protocol-core request with no guessed reasoning controls or vendor
  extensions. Provider-returned continuation state replays only to the exact
  source Base URL/model; any unresolved occupancy remains unknown.

#### Model-list URL resolution

Model discovery starts from the configured Base URL. First, LC applies proxy
rewriting and removes the trailing slash. It does not derive a URL from the
model ID or `models.dev` metadata.

**Gemini REST** uses `<configured-base>/models`, or the resolved explicit
override, and parses Google's `{ "models": [...], "nextPageToken": ... }`.
Each subsequent request appends an encoded `pageToken` to that same URL.
Discovery stops at 128 pages or 16,384 distinct models; repeated/invalid tokens
and excessive lists fail explicitly. It has no LM Studio fallback or Z.ai
merge. Entries retain `source: 'gemini-rest'`, display names, and server limits.

**OpenAI, Anthropic, and LM Studio** use the following resolution sequence:

1. **Explicit override.** If `ServerProfile.modelFetchUrl` is not empty, LC
   resolves and requests that URL once. It does not use an automatic fallback
   or Z.ai merge. LC uses an absolute HTTP(S) URL unchanged. It resolves
   `/path` from the Base URL origin. It appends `path` to the Base URL.
2. **Local/LAN default.** Local profiles include localhost, loopback, private or
   link-local IPv4, `.local`, and single-label hosts. LC preserves an explicit
   native REST base that ends in `/api/vN`. It requests
   `<configured-base>/models`, such as `/api/v10/models`. For OpenAI or
   Anthropic local bases that end in `/vN`, LC removes the version. It then
   requests `<server-root>/api/v1/models`.

   This native LM Studio endpoint
   provides load state, instances, context length, reasoning configuration,
   and capabilities. It remains useful when chat uses a compatible endpoint.
   If it returns no usable models, LC requests `<configured-base>/models` once.
   LC skips this fallback if it already tried that URL.
3. **Remote default.** Every other profile makes one request to `<configured-base>/models`. There are no parent-path or origin guesses.
4. **Z.ai merge.** For Base URLs containing `api.z.ai`, LC additionally requests `<configured-base>/v1/models` and merges missing model IDs. This covers models exposed under paths such as `/v4/v1/models` but omitted from `/v4/models`.

LC does not scan speculative native REST versions. It honors an explicit
`/api/vN` Base URL. Otherwise, it uses the known `/api/v1` native default.
An OpenAI or Anthropic `/vN` does not identify the native REST version. Use the
optional override for another endpoint.

In this shared non-Gemini path, LC detects successful JSON as LM Studio REST
format (`{ "models": [...] }`) or
OpenAI-compatible format (`{ "data": [...] }`). It filters embedding and other
known non-chat models. It removes duplicate LM Studio keys. Native entries carry
an internal provenance marker. Later enrichment can therefore preserve the
complete server identifier and native capability report.

The later `models.dev` lookup provides **metadata enrichment only**. It adds
display names, context limits, and capability flags after the server returns
model IDs. It does not select an endpoint or replace a native LM Studio
capability report. For native and local LM Studio entries, Workspace and
visibility settings show the complete server ID. Thus, publisher and repository
variants remain distinct.

The models.dev catalogue also contains richer fields that LC's compact cache
does not currently retain: `reasoning_options`, coarse provider `shape`, static
provider body/header hints, and `interleaved` reasoning field hints. These can
inform future capability enrichment, but they do not encode replay, carrier,
SSE, or usage-accounting contracts. LC therefore keeps
`models-cache.json` unchanged and stores verified wire behavior separately in
`provider-contracts.v1.json`. The exact accepted/not-authoritative boundary and
reviewed upstream commit are recorded in that file and explained in the
[normative reasoning contract](./reasoning-and-token-accounting.md#11-machine-readable-provider-contracts).

### Key Types

```typescript
// Wire types — what goes over HTTP
interface ChatMessage { role, content, tool_calls?, tool_call_id?, reasoning_content?, reasoning_details?, refusal?, responses_output_items?, anthropic_output_blocks?, anthropic_output_origin?, lmstudio_response_id? }
interface ChatRequest { model, messages, tools?, reasoning?, thinking?, reasoning_effort?, max_completion_tokens? }
interface ToolDefinition { type: 'function', function: { name, description, parameters } }
interface StreamChunk { choices: [{ delta: { content?, refusal?, reasoning_content?, tool_calls? } }], usage? }

// Adapter contract
interface AdapterRequestParams { model, messages, stream, tools?, reasoningEnabled, reasoningEffort? }
interface StreamCallbacks { onDelta(text), onReasoning?(reasoning), onToolCall?(), onRefusal?(refusal) }
interface StreamResult { content, refusal?, usage?, finish_reason?, tool_calls?, responses_output_items? }
```

`onToolCall()` is an immediate control callback used by the orchestrator's
[reasoning-only loop detector](./reasoning-loop-detection.md). It is emitted
when a provider begins a function/tool call, before the complete argument
payload is necessarily available.

---

## `server-profiles/` — Profile Lifecycle & Model Data

**Profiles use a standalone Zustand store** (`lc:profile-store`). They are not
a settings field.

### Key Files

| File | Role |
|---|---|
| `profile-store.ts` | Zustand store: profiles array, CRUD, `active` toggle |
| `profile-manager.ts` | Single gatekeeper for all profile mutations (validate, test connection, add/update/remove) |
| `model-store.ts` | Global `useAppModels`, the source of truth for all available models. `buildLiveEntries()` preserves native LM Studio capabilities. Tool defaults are `true` unless explicitly disabled. Settings pickers show complete IDs for native/local LM Studio models. |
| `model-cache.ts` | Persistent localStorage cache (`lc:server-model-cache`) with a TTL for each profile. Cache-first bootstrap prevents a "No models" flash. Enrichment runs at **write time**, so offline reads get complete metadata. Reads validate the cache root, server entries, and model entries. Malformed data cannot swallow the next valid write. Versioned writes prevent an older probe from replacing a newer list after profile or server changes. Reset settings calls `clearAll()` to clear the cache. |
| `model-enricher.ts` | Loads the compact `models-cache.json` through the shared `enrich.ts` loader. Matches profile `baseUrl` values to provider `api` fields. Merges display name, context window, vision, reasoning, and tool metadata. Uses the `models/enrich.ts` prefix-stripping fallback for local LM Studio. Retains native source/ID information. |
| `models-dev-sync.ts` | Manual models.dev refresh behind the Manage-models ⭳ button. `downloadModelsDev()` fetches the complete catalogue. `rebuildModelsCache()` creates the compact cache. Desktop uses the Rust `download_models_dev` and `rebuild_models_dev_cache` commands and persists data in the app data directory. The browser keeps the snapshot in memory and installs the cache as the `enrich.ts` runtime override. `buildCompactCache()` mirrors Rust `full_to_compact()` and `scripts/build-models-cache.mjs`. |
| `cross-server.ts` | Derives models from all active profiles for the unified picker. Excludes hidden models. |
| `../../store/modelVisibility.ts` | Persistent store (`lc_hidden_models` and backup `lc_hidden_models_bak`) for the model visibility filter. `ModelPicker.tsx` and `cross-server.ts` use it. A subscription-based layer keeps side effects out of Zustand `set` callbacks. Only the `resetAll()` gatekeeper can clear the hidden set. Reset settings calls this gatekeeper. Model refresh, profile edit, and bootstrap cannot clear it. A valid empty primary array is authoritative. `loadHidden()` recovers from backup only when the primary key is missing or malformed. |

`profile-manager.ts` also owns the active-generation mutation boundary.
Add/update/remove reject while any streaming owner exists, so a stale caller
cannot change routing or authentication after the UI has been disabled. Settings
also disables Add, Manage models, Fetch models, profile toggles, and Edit for
that interval. User-triggered model-picker refresh/load/unload actions are
locked by the same generation state. View and search remain available.

### models.dev Enrichment Pipeline

This pipeline gives each model a display name, context window, and capability
badges:

```
models.dev API (https://models.dev/api.json)
        │  Full JSON — multi-MB, all providers & models
        ▼
scripts/build-models-cache.mjs   ← build-time (or manual node run)
        │  Strips to 5 fields: c, n, v, r, t  (see below)
        │  Organises by provider → { api, m: { modelId: {…} } }
        │  Outputs to TWO locations:
        ▼
    ┌── public/models-cache.json          ← ~470 KB (473,266 bytes at
    │                                        2026-08-15; grows as models.dev
    │                                        grows), web/dev fetch target
    │
    └── src-tauri/resources/models-cache.json  ← Tauri bundle.resources copy
        │
        ├── Browser:  fetch('/models-cache.json') at runtime — bundled static
        │             copy, frozen at build; after a manual ⭳ refresh the
        │             in-memory runtime override from models-dev-sync.ts
        │             is served instead (browsers cannot write the asset)
        │
        └── Tauri (desktop):
              ├── Bundled resources/models-cache.json (fallback, gitignored build artifact)
              ├── %APPDATA%/lc/models-cache.json (background refresh every 24 h,
              │        or rebuilt on demand by the Manage-models ⭳ button)
              ├── %APPDATA%/lc/models-dev.json (raw snapshot, written by the
              │        ⭳ download step, read back by the rebuild step)
              ├── Rust sync_models_dev() — fetches models.dev directly,
              │        converts to compact, saves to app data dir
              └── Rust download_models_dev() + rebuild_models_dev_cache()
                   — the manual two-step equivalent, same conversion
        │
        ▼
models/enrich.ts loadCompactModelsCache()  ← the one loader; memoized;
        │                                   runtime override when installed
        ▼
model-enricher.ts  ← provider matching: domain root of baseUrl vs provider.api
        │  Falls back to all providers if no domain match (local servers)
        ▼
model-cache.ts  ← enrichment runs at WRITE time (modelCache.set)
        │  Incoming raw API models → enrichAll() → persist to localStorage
        ▼
localStorage  (key: lc:server-model-cache)
        │  TTL: 5 min for LM Studio REST, 60 min for cloud APIs
        ▼
model-store.ts  ← cache-first bootstrap → live fetch in background
        │
        ▼
ModelPicker / TokenMeter / SettingsPage  ← consumers
```

**Compact format** — single-letter keys for size:

| Key | Field | Source in models.dev |
|-----|-------|---------------------|
| `c` | context window | `limit.context` |
| `n` | display name | `name` |
| `v` | vision | `modalities.input` includes `"image"` |
| `r` | reasoning | `reasoning === true` |
| `t` | tools | `tool_call !== false` (defaults true) |

**Provider matching:** LC extracts the domain root from a profile's `baseUrl`.
For example, `https://api.openai.com/v1` becomes `https://api.openai.com`. It
finds the provider whose `api` field contains the root. Model ID lookup within
matched providers is case-insensitive. If no provider matches a local or LAN
server, LC searches all providers.

A prefix-removal fallback handles LM Studio
REST keys such as `qwen/qwen3.6-35b-a3b`. LC removes the `qwen/` publisher
prefix and retries with `qwen3.6-35b-a3b`.

**Tauri `lookup_models_dev` fallback:** If Rust returns `null` for a model, JS
loads `models-cache.json` and applies prefix-removal lookup. This commonly
occurs for publisher-prefixed keys from local LM Studio servers. The fallback
lets local-server models receive models.dev metadata.

**Tauri background refresh** (`sync_models_dev` command):
- If `models-cache.json` in the app data directory is less than 24 h old, skip
  the refresh.
- Otherwise, fetch `https://models.dev/api.json`. Use a 10 s connection timeout
  and a 30 s total timeout.
- Convert the complete format to compact. Save it to
  `%APPDATA%/lc/models-cache.json`.
- `lookup_models_dev` prefers a fresh downloaded copy. Otherwise, it uses the
  bundled copy. If a fresh copy is malformed, oversized, or over its entry
  limit, lookup also uses the bundled copy.

**Tauri manual refresh** (`download_models_dev` + `rebuild_models_dev_cache`
commands, driven by Manage models ⭳ via `models-dev-sync.ts`):
- `download_models_dev` fetches the full catalogue and stores it verbatim as
  `%APPDATA%/lc/models-dev.json` with an atomic temporary-file rename. It
  returns provider and model counts for the step-1 toast.
- `rebuild_models_dev_cache` reads that snapshot, reduces it with the same
  `full_to_compact()` the background refresh uses, writes
  `%APPDATA%/lc/models-cache.json`. Then it replaces the in-memory `CACHE`.
  The next `lookup_models_dev` uses the new cache.
- The split mirrors `scripts/fetch-models-dev.mjs` → `scripts/build-models-cache.mjs`
  and lets the UI show each step's outcome separately. The browser build has
  no writable asset. Therefore, its rebuild installs the compact cache as the
  `enrich.ts` runtime override.

**Cache invalidation** (`clear_models_dev_cache` command):
- Deletes `%APPDATA%/lc/models-cache.json` (the downloaded copy) and the raw
  `%APPDATA%/lc/models-dev.json` snapshot when one exists
- Set the in-memory `CACHE` to `None`. The next `ensure_loaded()` reads from
  disk again.
- The JS Reset settings flow calls this command. After reset, the bundled copy
  is the fallback until the next `sync_models_dev` refresh.

**Key design decision:** Enrichment occurs at write time. `modelCache.set()`
runs `modelEnricher.enrichAll()` **before** persistence to localStorage. Thus,
the next cold boot reads complete metadata without a network dependency.

Each persistent entry records the profile base URL, optional model-fetch URL,
and API variant that produced it. Cache-first bootstrap and failed-refresh
fallback reject an entry when any of these resource-identity fields differs
from the current profile. A legacy entry without `modelFetchUrl` is compatible
only when the current profile also uses its default model-list route.

Model discovery reads at most 64 MiB from one response and accepts at most
16,384 entries in one profile list. Write-time models.dev enrichment uses at
most 16 concurrent workers. Therefore, the persistent detected cache also has
at most 16,384 entries per profile.

Manual and background models.dev refresh accepts at most 64 MiB, 1,024
providers, and 65,536 models. Desktop compact-cache reads and writes have a
16 MiB file limit. LC checks the serialized bytes before it writes the file or
replaces the in-memory cache. The browser and desktop use the same provider and
model-count limits.

### Cache Update Paths

Models are fetched over HTTP during the app's background bootstrap, after
connection-affecting profile changes, and when the user explicitly triggers
a refresh. Opening the Settings panel does not fetch models again. It reads the
in-memory Zustand store populated by the cache-first bootstrap and subsequent
live refresh.

All user-triggered refresh paths below are disabled during an active generation.
Their handlers re-check generation state so a stale click or open overlay cannot
bypass the rendered disabled state.

There are two layers of cache, and the UI buttons hit them differently:

| Layer | Storage | Updated by |
|---|---|---|
| **localStorage** (persistent) | `lc:server-model-cache` | All refresh paths below write via `modelCache.set()`. Cleared by `modelCache.clearAll()` on Reset settings. |
| **Zustand store** (in-memory) | `useAppModels.models` | All refresh paths update the state consumed by ModelPicker and TokenMeter. Also feeds the Agentic tools sub-agent model pickers. |

**Path 0 — App startup (automatic, all active profiles)**

```
normal startup records ready
  → useModelBootstrap(normalReady) → useAppModels.bootstrap()
  → cacheGroups() → commitDetected()              ✅ immediate Zustand population, no network
  → useAppModels.refresh()
  → for each active profile (parallel LLMClient.listModels() probe sequences)
  → modelCache.set() per reachable profile       ✅ localStorage cache
  → set({ models, serverHealth })                 ✅ Zustand store
```

**Path 1 — Settings "Fetch models" (per-profile)**

```
testServer(p)
  → LLMClient.testConnection() → LLMClient.listModels() probe sequence
  → modelCache.set(profileId, raw, profile)     ✅ localStorage cache
  → buildLiveEntries(p, r.models)               ✅ Zustand store
  → useAppModels.setState({ models, serverHealth })
  → toast.success("reachable, N models")
```

**Path 2 — ModelPicker global refresh icon (🔄)**

```
storeRefresh() → useAppModels.getState().refresh()
  → for each active profile (parallel LLMClient.listModels() probe sequences)
  → modelCache.set() per profile                 ✅ localStorage cache
  → set({ models, serverHealth })                ✅ Zustand store
  → toast.success/error verdict read back from the store
```

The Settings "Reload" button that used this path was removed. The picker's 🔄
already reaches every active profile. Manage-models ⭳ in Path 5 also refreshes
the models.dev catalogue and inactive profiles.

**Path 3 — ModelPicker per-profile "Refresh" (unreachable rows)**

```
onRefreshProfile(profileId) → refreshServer(profileId)
  → guard: profile must exist AND be active
  → LLMClient.listModels() — one profile only
  → modelCache.set()                                ✅ localStorage cache
  → set({ models: [...filtered, ...live] })         ✅ Zustand store
```

**Summary matrix:**

| Trigger | Scope | HTTP | localStorage | Zustand store |
|---|---|---|---|---|
| App startup | all active | ✅ × N, background | ✅ | ✅ |
| Settings "Fetch models" | 1 profile | ✅ | ✅ | ✅ |
| ModelPicker 🔄 icon | all active | ✅ × N | ✅ | ✅ |
| ModelPicker "Refresh" | 1 profile | ✅ | ✅ | ✅ |
| Manage models "Fetch models" | 1 profile (active or inactive) | ✅ | ✅ | ✅ (active projection only) |
| Manage models ⭳ (step 3) | every profile (active and inactive) | ✅ × N | ✅ | ✅ (active projection only) |
| Profile add/edit/active toggle | affected profile plus active set | ✅, automatic | ✅ | ✅ (active only) |

**Path 4 — Manage models "Fetch models" (one profile)**

```
ModelVisibilityPanel.fetchProfileModels(profileId)
  → LLMClient.listModels() for the selected profile (active or inactive)
  → useAppModels.replaceProfileModels()           ✅ live registry
  → modelCache.set()                              ✅ persistent detected cache
```

Manage models shows every profile, including profiles without fetched models.
You can add a manual model before discovery succeeds. Its customization layer
is separate from the detected cache. Fetch models preserves manual additions
and deletion tombstones. Restore defaults clears additions, deletions, metadata
overrides, and visibility choices for that profile. Then it fetches the server
list again.

**Path 5 — Manage models ⭳ (catalogue + cache + every profile)**

```
ModelVisibilityPanel.runCatalogueSync()
  → downloadModelsDev()                           ✅ models.dev → snapshot (toast 1)
  → rebuildModelsCache()                          ✅ compact cache swapped in (toast 2)
  → fetchProfileModelsCore() × every profile      ✅ registry + persistent cache (toast 3)
```

The header ⭳ performs the same work as the two refresh scripts. It downloads
`models-dev.json` and rebuilds `models-cache.json`. Then it fetches models from
each active and inactive server profile. It uses the same core as the
per-profile Fetch button. The UI shows one notification for each step.

Step 3
still runs when the catalogue steps fail. The server refresh then enriches from
the available cache. Per-profile actions are disabled during this step. Thus,
the two fetch paths cannot interleave cache writes.

**Path 6 — Profile add/edit/active-state changes (automatic)**

`profileManager` invalidates stale entries when connection details change and
schedules `syncSingleProfile()` for the affected profile. The profile-store
subscription also calls `useAppModels.bootstrap()`, which immediately rebuilds
from cache and refreshes all currently active profiles. The model store's
in-flight guard combines overlapping `refresh()` calls. The focused
`syncSingleProfile()` cache write is independent.

All refresh paths update the persistent cache and relevant in-memory state. The
ModelPicker shows changes immediately for every refresh path.

**Agentic tools sub-agent pickers:** `loadCrossServerModels()` is a pure,
synchronous read from the in-memory Zustand store. It has no network side
effects. The Settings "Fetch models" button calls
`refresh()` explicitly. It then reads the state through
`loadCrossServerModels()`. This process keeps the image-analyze and web-research
model pickers synchronized with the main ModelPicker.

### Reset Settings — Model Cache Clearing

`resetSettings()` (Settings → Reset settings) clears the following model
metadata caches. The next bootstrap starts with no prior data:

| Cache | Storage | Cleared by |
|---|---|---|
| `lc:server-model-cache` | localStorage | `modelCache.clearAll()` (JS) |
| `lc_hidden_models` | localStorage | `localStorage.removeItem()` (JS) |
| `lc_filter_counts` | localStorage | `localStorage.removeItem()` (JS) |
| `%APPDATA%/lc/models-cache.json` | Disk (Tauri only) | `clear_models_dev_cache` (Rust command) |
| `%APPDATA%/lc/models-dev.json` | Disk (Tauri only, raw ⭳ snapshot) | `clear_models_dev_cache` (Rust command) |
| In-memory `CACHE` (Rust) | RAM | `clear_models_dev_cache` sets to `None` |

After reset and reload:

- `model-store.ts` bootstrap reads empty localStorage. No stale model lists
  remain.
- `useModelVisibility` hydrates from empty localStorage. No stale hidden-model
  entries remain.
- `ensure_loaded()` finds no downloaded cache. It uses the **bundled**
  `models-cache.json`.
- `sync_models_dev()` detects the missing file. It fetches
  `https://models.dev/api.json` within 24 h.

### Multi-Server Support

Any profile with `active: true` is active. Multiple profiles can be active at
the same time:

- Models merge into one picker, grouped by server
- Sub-agent model pickers (image analyze, web research) filter from all active profiles
- Each profile has its own API variant, API key, and routing mode

---

## `chat-pipeline/` — Streaming & Tool Loop

`ChatView` calls `runStreamWithTools()` and handles only the UI. The
chat-pipeline module owns orchestration.

### Key Files

| File | Role |
|---|---|
| `orchestrator.ts` | `runStreamWithTools()`: full send → stream → tool-loop → finalize lifecycle |
| `turn-usage-accumulator.ts` | Constant-work response-boundary sums for footer input/output/reasoning/cache coverage and terminal completeness |
| `provider-history-projection.ts` | Shared pure next-request selection for canonical fields, provider replay state, opaque accounting, retention, Tool History, and unknown occupancy |
| `generation-session-manager.ts` | Application capacity (default two, hard maximum three), per-conversation controller/phase/TPS ownership, targeted cancellation, per-profile limiter seam, and unread terminal projection |
| `generation-snapshot.ts` | Deep-frozen send-time conversation/provider/model/Workspace/helper-route state. Keeps API/search/helper secrets in adjacent runtime-only storage. Its bounded model-detail cache is keyed by exact profile and route ownership. |
| `generation-model-detail-config.ts` | Dependency-free configuration generation. Connection-affecting profile mutations advance it so older model-detail cache entries cannot address a new profile configuration. |
| `interaction-coordinator.ts` | Strict FIFO permission + ask-user arbitration with enqueue/display/delivery generation fences and bounded attention |
| `mutation-coordinator.ts` | Application-wide fair read/write/broad-read/apply-patch/shell reservation domain |
| `whiteboard-turn-runtime.ts` | Admits a generation, binds the typed Whiteboard service to its storage row, publishes references, and delegates terminal repair |
| `whiteboard-lifecycle.ts` | Serialized model-write/terminal queue. Suppresses ordinary results after closure and permits idempotent settlement retry. |
| `system-prompt.ts` | Dynamic system prompt builder: environment, tool usage instructions, shell binary section, exposed tool definitions |
| `phase-tracker.ts` | Thinking → text response → tool use phase state for UI progress indicators |
| `token-counter.ts` | TPS metering during streaming |
| `shortcuts.ts` | Keyboard shortcut installation |
| `zoom.ts` | Tauri webview zoom lifecycle |

### Orchestrator Flow

```
runStreamWithTools(convId, signal, streamOpts)
  ├─ create TurnUsageAccumulator            // One owner for the whole bubble
  ├─ runStream()                          // One HTTP request → one response
  │   ├─ buildSystemPrompt(conv)          // Dynamic prompt with tool defs
  │   ├─ build reqMessages from conv      // Tool History stubs and todo projection
  │   ├─ LLMClient.chatStream()            // Routes to correct adapter
  │   ├─ rAF-batched store updates        // exact assistant ID + generation guard
  │   ├─ finalizeStreamingOwner()         // single terminal compare-and-set
  │   ├─ add response-local usage once    // Provider report or local delta-only estimate
  │   └─ return tool_calls (if any)
  │
  ├─ wireToRecord(tool_calls) → finalizeMessage(owned assistant)
  └─ runToolLoop(records, signal, ...)
      ├─ validateToolCalls → Zod schemas
      ├─ resolveHandler → resolved Workspace/category exposure
      ├─ canonical scope + policy check → modal if needed
      ├─ runWithPool → concurrent execution bounded by Max tool calls per batch
      ├─ append tool results only while owner + signal remain active
      └─ runStream() again (re-stream) → loop or done
```

Each adapter normalizes only its own provider response. Chat Completions reads
`completion_tokens_details.reasoning_tokens`; Responses reads
`output_tokens_details.reasoning_tokens`; Anthropic retains the final
`message_delta.usage.output_tokens_details.thinking_tokens` with its exact
provider provenance; native LM Studio retains `reasoning_output_tokens`. The
user-facing label for any provider-supplied reasoning figure is
`Reasoning (reported)`. The accumulator
sums these response objects without reinterpreting provider-specific cache
composition. A fallback estimate uses only deltas emitted by that `runStream()`
instance, so a re-stream cannot count earlier bubble text again.

Responses output items and Anthropic-shaped signed/redacted blocks are appended with
one accounting group per provider response. Their adapters re-expand a merged
bubble into response/tool-result order. First-party Anthropic non-empty
signatures and all redacted payloads are opaque. MiniMax's documented signature
is fixed-size replay state beside complete plaintext `thinking`; LC recognizes
that shape through relays and TokenMeter counts the text locally. Provider
provenance prevents opaque state from leaking to an unverified surface, while
documented same-provider model portability remains server-owned. LC retains and
serializes every eligible block; it does not infer keep-all versus last-turn-only
behavior from a model name. Provider-side filtering remains unknown unless the
provider reports an authoritative current-input count.

When `lc_whiteboard` is exposed, admission also calls
`admitWhiteboardGeneration()` before the first request. The returned lifecycle
injects its typed service into every tool round and is settled from every
terminal path. Changed model-board calls and terminal settlement share one
serialized queue.

A committed mutation receipt remains authoritative if abort
or timeout races result publication. Settlement persists or repairs the compact
tool result. It then removes the generation-owned working row. Without
Whiteboard exposure, the orchestrator instead awaits durable creation of the
ordinary streaming assistant placeholder.

The generation address `{conversationId, generationId, assistantMessageId}`
crosses each stream, permission, execution, result, terminal, and cleanup
boundary. It also crosses re-stream boundaries. During that lifetime, LC
uses its immutable execution snapshot for routing, authentication-adjacent
facts, helper routes/model metadata, parameters, Workspace, tool exposure, and
round limits. Only its deletion-fenced authorization overlay can change.

The owning conversation's controls remain locked. Unrelated chats remain
editable.
Application-wide profile/credential/model, import/reset/migration, and global
security operations stay blocked because they could invalidate one or more
snapshots.

One foreground `ChatView` projects the selected conversation while up to three
sessions run. `conversation-ui.ts` restores drafts, attachments, edit state,
scroll/follow, side-panel/Workspace disclosures, and preview presentation per
chat. Resident transcripts include every lifecycle owner. Clean nonresident
transcripts and UI entries are bounded and evictable. The Sidebar subscribes to
lightweight session phases and targeted attention rather than background token
deltas.

### DeepSeek Thinking Mode

DeepSeek Chat Completions requires all previous assistant
`reasoning_content` when the next request carries `tools`, including turns that
did not call a tool. Without `tools`, the server ignores it. LC resolves this
from the DeepSeek Chat contract and uses the same projection for requests and
TokenMeter accounting. See the
[DeepSeek documentation](https://api-docs.deepseek.com/guides/thinking_mode#tool-calls)
and the [normative contract](./reasoning-and-token-accounting.md#53-deepseek).

Each DeepSeek protocol uses its own carrier and must be verified separately:

| API | Adapter | Carrier |
|---|---|---|
| Chat Completions | `adapters/openai.ts` | `reasoning_content` on the assistant message |
| Anthropic Messages | `adapters/anthropic.ts` | a `thinking` content block on the assistant message |
| Responses | `adapters/openai-responses.ts` | a `reasoning` input item with plain-text `reasoning_text` parts |

On the Responses path, `summary` and `encrypted_content` are unsupported inside
input reasoning items, while the separate top-level `reasoning.summary` option
is accepted but produces no summary. DeepSeek's Responses page does not publish
Chat's tools-dependent history filtering rule. LC currently excludes Responses
reasoning on turns without `tool_calls`; that behavior is unverified and listed
as a deviation. See [note-openai-responses.md §8](note-openai-responses.md).

---

## `tool-engine/` — Tool System

**Tools moved from `src/tools/` to `src/modules/tool-engine/`.** The main
addition is **SandboxBridge**, a typed interface for all Tauri tool commands.

### Key Files

| File | Role |
|---|---|
| `registry.ts` | `BUILTIN_TOOLS` (21 handlers and canonical registry order), `HANDLERS_BY_NAME` (Map), category-list re-exports, `materialize()` (→ wire format) |
| `runner.ts` | Validation, handler resolution, result envelopes, execution, and mutation-lock coordination |
| `tool-guidance.ts` | Typed pilot catalogs, declared error codes, recovery mappings, and triggered guidance |
| `tool-help.ts` | One-tool deterministic guidance lookup and bounded help result construction |
| `tool-help-governor.ts` | Batch-ordered duplicate suppression and per-turn help limits |
| `tool-name-resolution.ts` | Shared bounded name correction for help and unknown operational calls |
| `todo-state.ts` | Strict todo schema, bounded snapshot selection, request projection, and UI state |
| `ask-user.ts` | Strict interactive-question schemas, bounds, result types, and mixed-batch issue |
| `whiteboard.ts` | Pure strict schema plus read/replace/exact-edit behavior and bounded stable diagnostics for `lc_whiteboard` |
| `whiteboard-governor.ts` | Batch-ordered admission of at most one Whiteboard call before execution |
| `tool-round-lifecycle.ts` | Parent abort and ordinary tool-round deadlines. Ask User omits that deadline while the interaction coordinator supplies the absolute attention cap. |
| `tool-result-content.ts` | Authoritative orchestration-notice builders and strict decoder for recognized LC result framing |
| `argument-normalization.ts` | Shared schema-aware optional-absence normalization |
| `run-with-pool.ts` | Bounded parallel execution with per-completion callbacks |
| `policy.ts` | Canonical category metadata plus pure exposure/authorization resolution |
| `grant-state.ts` | Safe updates for visible Web Access and per-root File I/O grants |
| `sandbox-bridge.ts` | Typed interface for all Tauri tool commands — compile-time checked, mockable in tests |
| `registry-names.ts` | Dependency-free canonical category membership lists |
| `clean-path.ts` | Pure path sanitization and normalization |
| `path-safety.ts` | Native path checks, resolution, permission-scope lookup, and canonical lock-target resolution |
| `file-lock.ts` | Per-file serialization of mutating calls by canonical identity, plus the global patch reservation |
| `types.ts` | `ToolHandler`, `ToolHandlerContext`, `ToolCallRecord`, `ToolConfig`, and `ToolResultEnvelope` |
| `builtin/` | 20 conventional tool handlers, with one file per tool. `lc_whiteboard` remains at the tool-engine root because storage is an injected capability. |

### Whiteboard capability boundary

`whiteboard.ts` imports neither React nor IndexedDB. Its input is one strict,
flat object with `action: 'read' | 'replace' | 'edit'`. Read accepts no mutation
fields. Replace requires the complete `content`. An empty string clears the
model board.

Edit requires one non-empty `old_string` and a `new_string`. It
matches exact whitespace and succeeds only when the old string occurs exactly
once. Only the model board is mutable, and the resulting document must remain
within 32 KiB of UTF-8.

Persistence arrives through the optional generation-scoped
`WhiteboardToolService` on `ToolHandlerContext`. The capability exposes only a
pinned read and full-model replacement. The pure handler computes exact edits
before asking the service to replace. Service failures and edit diagnostics map
to stable issue codes plus the shared recovery catalog. The Whiteboard governor
admits one exact Whiteboard call in a batch. If a surviving declared batch has
two or more, it rejects every exact Whiteboard call before service access or
other side effects.

### SandboxBridge

```typescript
interface SandboxBridge {
  readFile(args: ReadFileArgs): Promise<ReadFileResult>;
  readImage(args: ReadImageArgs): Promise<ReadImageResult>;
  readPdf(args: ReadPdfArgs): Promise<ReadPdfResult>;
  analyzeImages(args: AnalyzeImagesArgs): Promise<AnalyzeImagesResult>;
  writeFile(args: WriteFileArgs): Promise<WriteFileResult>;
  listDir(args: ListDirArgs): Promise<ListDirResult>;
  stat(args: StatArgs): Promise<StatResult>;
  runShell(args: RunShellArgs): Promise<RunShellResult>;
  grep(args: GrepArgs): Promise<GrepResult>;
  edit(args: EditArgs): Promise<EditResult>;
  webFetch(args: WebFetchArgs): Promise<WebFetchResult>;
  webSearch(args: WebSearchArgs): Promise<WebSearchResult>;
  globFiles(args: GlobFilesArgs): Promise<GlobFilesResult>;
  applyPatch(args: ApplyPatchArgs): Promise<ApplyPatchResult>;
  applyPatchTargets(args: ApplyPatchTargetsArgs): Promise<ApplyPatchTargetsResult>;
  applyPatchPreflight(args: ApplyPatchPreflightArgs): Promise<ApplyPatchPreflightResult>;
  abortToolCalls(args: { callIds: string[] }): Promise<number>;
  abortGroup(args: { groupId: string }): Promise<number>;
}
```

**Why it matters:**

- TypeScript checks argument shapes at compile time without magic strings.
- Tests can use `createMockBridge()` without a Rust runtime.
- To add a tool command, add one method and one Rust implementation.

### Tool Handler Contract

```typescript
interface ToolHandler<I, O> {
  name: string;                                    // e.g. "lc_read_file"
  description: string | (() => string);            // Sent to model
  uiDescription?: string;                          // For UI checkboxes
  input: z.ZodType<I>;                             // Zod schema → validation + JSON Schema
  run: (input: I, ctx: ToolHandlerContext) => Promise<O>;
  toJsonSchema(): JsonSchema;                      // Cached at module load
}
```

### Registry

`BUILTIN_TOOLS` is the canonical full registry and tool order. `FOUNDATION_NAMES`,
`FILE_IO_NAMES`, `WEB_ACCESS_NAMES`, `TOOL_HELP_NAMES`,
`SKILLS_NAMES`, and `WHITEBOARD_NAMES` are the canonical membership lists,
defined dependency-free in `registry-names.ts` and re-exported by the registry.
Tool History is the singleton `lc_tool_history` in policy code. UI views can
select a presentation order. Exposure materialization uses the canonical
registry order and authorization uses the policy helpers.

Workspace exposes `FOUNDATION_NAMES` before it evaluates optional category
toggles. The foundation tools are `lc_todo_write`, `lc_ask_user`, and
`lc_get_current_time`. They use no prompt or grant and do not create settings
rows. The resolved exposure set
also drives provider prompt enablement and the orchestrator's tool-call
expectation.

`lc_ask_user` receives a typed interaction capability through
`ToolHandlerContext`. Permission and ask-user prompts share the application
interaction coordinator's strict FIFO and generation-identity fences. A sole
admitted Ask User call omits the ordinary operational deadline while the modal
waits, but the coordinator applies its independent 30-minute attention cap.
Parent generation abort still settles the call. A model-declared batch that
contains `lc_ask_user` and any other call is suppressed before a handler, grant
check, or permission prompt runs. The suppressed results retain specific
admission errors and otherwise use `interactive_tool_must_run_alone` in declared
call order.

`lc_tool_help` has derived exposure. It is present when at least one operational
File I/O, Shell, Web Access, or Whiteboard tool is exposed. Tool
History or Skills alone do not expose it. The orchestrator applies its
duplicate and turn limits before concurrent execution, in validated batch
order.

Successful todo calls are immutable conversation snapshots. Tool History keeps
its generic stubs. When a stub hides the current todo call arguments, the
orchestrator adds one derived incomplete-list projection. It adds the projection
to the request-only copy of the latest real user message. `ChatView` uses the
same bounded selector for the controlled Preview Overlay To do list tab. It
resolves the latest state of each logical list in the selected user turn. The
persisted **Settings → Chat → To-do list preview** preference then presents only
the final resolved list by default (**latest only**) or the complete ordered
multi-list set (**all updates**). A selected turn without an accepted update
shows the empty state rather than inherited prior-turn task state. Copy follows
the same presentation filter; stored snapshots and request projection do not.

A complete stable-ID set and a strict majority of unchanged titles identify
ordinary list updates. Forward-growing replacements may also match when an
ordered majority of earlier titles survives and covers at least half of the new
list. This handles inserted tasks even if the model renumbers later IDs.
Minority title, status, note, and order changes do not create duplicate
sections. The growth rule never folds a shorter sub-list into its parent, and
unrelated lists that reuse IDs remain separate. This UI grouping does not
otherwise infer parent-child relationships and does not change the latest-
snapshot model projection.

Todo snapshots remain optional model-maintained bookkeeping. Acceptance proves
the stored shape and counts, not that later tool work still agrees with the
snapshot. LC does not infer completion, add list lifecycle state, gate final
responses, or issue another model call to reconcile an incomplete list. The UI
and request projection preserve the latest accepted state without presenting it
as authoritative execution evidence.

Ask-user answers remain ordinary tool results. They stay in full during the
active turn and receive the same generic Tool History stub after the turn.
There is no automatic answer projection or synthetic user message.

`resolveExposure()` and `authorizeCall()` in `policy.ts` control model
visibility and popup behavior. Declarative `TOOL_POLICY` metadata defines the
category, grant scope, and prompt behavior. Handler implementations do not have
a second permission flag.

---

## Whiteboard Storage, Archive, and UI Ownership

Whiteboard deliberately crosses layers without giving the tool handler direct
access to persistence or presentation:

| File | Ownership |
|---|---|
| `src/store/db.ts` | Current Dexie schema v3, compressed row types, and the four content-table conversation transaction seam |
| `src/store/whiteboard.ts` | Retained/working domain mapping, ID collision retry, initialization, ordered queries, pending/provisional operations, consistent UI snapshots, change subscription, and empty-board package insertion |
| `src/store/whiteboard-conversation.ts` | Atomic message/reference boundaries for user send, model admission/mutation/settlement, terminal result repair, lazy recovery, branch truncation, and clone persistence |
| `src/store/conversations.ts` | Zustand publication, conversation-operation serialization, generation-blocking leases, deletion/full-wipe entry points, and public overlay/package store APIs |
| `src/utils/exportArchive.ts`, `src/utils/import.ts` | Conversation archive v1 carrier/validation and atomic retained-row replacement. Working rows are excluded. |
| `src/ui/tools/WhiteboardOverlay.tsx` | Responsive, accessible overlay composition and live storage refresh |
| `src/ui/tools/whiteboard-state.ts` | Pure owner/history selection and dirty-draft transitions. A `null` selection means the current visible head. |
| `src/ui/tools/whiteboard-package.ts` | Separate two-Markdown ZIP creation and bounded strict parsing |
| `src/ui/tools/whiteboard-file-picker.ts` | Web/native file selection. The native path uses the metadata-first bounded reader. |
| `src/ui/tools/whiteboard-overlay-guard.ts` | One registered dirty-close guard used by close, Escape, preview switch, navigation, and other overlay exits |

`Composer.tsx` renders the Whiteboard action immediately after Attach and
`WhiteboardIcon.tsx` embeds the source `board.svg` geometry so the UI has no
runtime SVG-file dependency. Chat-container queries keep Workspace and preset
labels below 600 px while Attach and Whiteboard become circular icon-only
actions. Below 470 px, every composer action becomes icon-only.

`SidePanel.tsx` places Whiteboard after Web Access and before Skills
as a standard collapsed Workspace section. Expansion reveals the shared
description and an `Open whiteboard` action. During generation the section,
disclosure, and launch action remain visually active, while its exposure toggle
is disabled with other execution-affecting configuration.

The overlay header owns centered Model/User tabs and the title tooltip. One
full-width active board uses a centered previous/date/next group. Only the User
tab adds compact Edit or Cancel/Save actions on the right. Save returns directly
to rendered Markdown. Import and Export use icon-and-label footer actions, and
the footer notice names the exact Model and User versions selected for export.

The store snapshot returns ordered `modelVersions` and `userVersions`, retained
heads, the pending user row, the provisional model row, and transaction-derived
import eligibility. A storage invalidation subscription lets the overlay reload
after committed changes. During generation the model's working document,
history, export, and User editing remain available. Administrative package
import stays blocked, and the overlay guard prevents any history or exit action
from silently discarding a dirty User draft.

Conversation archive and standalone package operations are separate contracts.
Archive v1 preserves every decompressed immutable retained row plus message
references in mandatory `whiteboard.json`. Import atomically replaces
conversation metadata, messages, retained rows, and working-row state. The
standalone package exports only the two visible Markdown documents and imports
them as fresh model/user retained versions into an untouched empty board.

Clone preserves conversation-scoped retained IDs and remaps source-message links.
Retry/edit truncation removes only discarded-branch versions. Delete and full
wipe remove both retained and working rows in the owning transaction.
