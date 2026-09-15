# Streaming Pipeline

This document explains how a user message becomes a streaming model response.
It includes tool-loop integration.

---

## Full Pipeline

```
User sends message
  │
  ├─ ChatView.send()
  │   ├─ synchronously reserve capacity (maximum 3; one per conversation)
  │   ├─ resolve credentials/model metadata/helper routes
  │   ├─ freeze GenerationExecutionSnapshot (secrets kept adjacent)
  │   ├─ recheck and commit the exact admission before transcript mutation
  │   ├─ persist user + assistant placeholder + generation journal
  │   └─ hand committed admission to the runtime session
  │       └─ owner = { conversationId, generationId, assistantMessageId }
  │
  ├─ runStreamWithTools(convId, signal, streamOpts)
  │   │
  │   └─ runStream()
  │       ├─ Build system prompt       // Environment + tools + shell section
  │       ├─ Build reqMessages         // Preserve reasoning; project calls/results separately
  │       ├─ Build ChatRequest         // Model, temperature, tools, reasoning
  │       │
  │       ├─ Protocol dispatch:
  │       │   ├─ OpenAI Chat Completions → openai.ts
  │       │   ├─ OpenAI Responses → openai-responses.ts
  │       │   ├─ Anthropic     → anthropic.ts
  │       │   ├─ Gemini REST   → gemini-rest.ts (Interactions)
  │       │   └─ LM Studio     → lmstudio-rest.ts (no tools)
  │       │
  │       ├─ proxy_stream (Rust relay)
  │       │   ├─ connect_timeout(30s), then UTF-8-safe relay
  │       │   └─ full-lifetime CancellationToken in TOOL_REGISTRY
  │       │
  │       ├─ readWithTimeout (JS watchdog)
  │       │   └─ Per-chunk idle timeout → cancel stream
  │       │
  │       ├─ decodeSSE (incremental line parser)
  │       │   ├─ scan each decoded character once across chunk boundaries
  │       │   └─ reject one event above 4,194,304 decoded characters
  │       │      Current adapters end that read as timed out or disconnected.
  │       │
  │       ├─ Per-delta callbacks:
  │       │   ├─ onDelta(text)    → appendToMessage(owner.assistantMessageId)
  │       │   └─ onReasoning(text) → appendReasoningToMessage(owner.assistantMessageId)
  │       │   └─ rAF-batched to one store update per frame (~60 Hz)
  │       │
  │       ├─ UI throttle (bubble + reasoning overlay):
  │       │   └─ useThrottledWhile(…, 42, streaming) → ~24 Hz
  │       │      Prevents per-token re-parse of Markdown + KaTeX + Prism
  │       │
  │       └─ Stream end:
  │           ├─ normalize the provider finish reason
  │           ├─ tool-use terminal → return admitted tool_calls
  │           └─ other terminal → finalizeStreamingOwner(owner, meta)
  │                                  // Single terminal claim
  │
  ├─ If admitted tool_calls are present:
  │   ├─ wireToRecord → finalizeMessage(owner.assistantMessageId, tool_calls)
  │   │
  │   └─ runToolLoop()
  │       ├─ validateToolCalls      // Zod parse arguments
  │       ├─ resolveHandler         // Workspace/category exposure filtering
  │       ├─ Canonical scope + policy check // Modal if needed
  │       ├─ runWithPool            // Concurrent execution (Workspace batch limit)
  │       ├─ appendMessage(tool result)
  │       ├─ finalizeMessage(owner.assistantMessageId, tool_calls)
  │       ├─ runStream() again      // Re-stream
  │       └─ Loop or done
  │
  └─ terminal persistence barrier (convId, generationId)
      └─ generation/revision-checked persistence lane
           ├─ complete snapshot → transactional full-history replacement
           └─ incomplete snapshot → non-deleting upsert + storage warning
      └─ compare-delete generation journal, then release capacity
```

### Gemini Interactions

`gemini-rest.ts` consumes the shared SSE decoder, then assembles indexed
`step.start`, typed `step.delta`, and `step.stop` events until
`interaction.completed`. Only a complete response with complete function
arguments and signed thought steps can authorize tools or continuation.
Terminal steps, if supplied, are authoritative; an interrupted response keeps
its partial steps/fragments and blocks automatic replay. Thought summaries
are display-only, separate from the signatures and response-local usage used
for context accounting.

The orchestrator retains one `gemini_interactions` group per native response
inside the merged assistant bubble. On the next request, every whole native
response precedes its paired function results. Tool History leaves this native
exchange intact. JSON/SSE helper requests share the adapter and surface provider
errors without retrying or rewriting an effort value. See
[Gemini REST](./note-gemini-rest.md) for bounds, discovery, and evidence status.

### Tool-turn UI and persistence invariants

- Every generation carries a stable conversation ID, generation ID, and
  initiating assistant message ID. Delta, tool, usage, error, and terminal paths
  verify that owner. They target the exact assistant. A stale generation cannot
  change or release a newer generation.
- Each generation receives an immutable execution snapshot containing its
  conversation configuration, provider facts, model metadata, structured tool
  exposure, and Workspace/system prompt. The snapshot also contains round limits
  and resolved helper routes.
  API/search/helper keys are runtime-only secrets outside that serializable
  object. Later tool rounds and sub-agents never re-read mutable Settings or
  profile routing. Only grants approved by that generation form a fenced live
  authorization overlay.
- The generating conversation's execution controls are locked. Other chats can
  be selected, drafted, configured, renamed, or otherwise changed when their
  target-specific guard permits it. Profile/credential/model management,
  import/reset/migration, and other application-exclusive mutations remain
  blocked while any generation or chat admission is active.
- `finalizeMessage()` treats `meta` as a partial nested update. It merges the
  update with existing assistant metadata. Later tool-call rounds preserve
  captured metrics and keep `finish_reason: "tool_calls"`. The status chip
  remains **tooling** until a final outcome replaces it.
- LC appends and merges `tool_calls` across rounds on the same assistant
  message. Matching `role: "tool"` result messages remain separate. The Tools
  overlay joins them by `tool_call_id`.
- Provider adapters keep usage response-local. `runStreamWithTools()` owns one
  `TurnUsageAccumulator` for the assistant generation and adds each initial or
  tool-loop response exactly once. The persisted `Message.usage` value is then
  marked `scope: "assistant-turn"` and sums input, output, reasoning, cache,
  and coverage across every provider response in the bubble. Its terminal
  qualifier is `complete` or `partial`; `meta.totalTokens` mirrors aggregate
  output only as a compatibility field. Legacy rows without `scope` remain
  readable and tool-loop rows are labelled as possible final-response-only
  reports.
- Bubble usage and TokenMeter are separate ledgers. The footer describes work
  already consumed across the complete LC turn. TokenMeter predicts the next
  provider request from the shared provider-history projection; it never copies
  the turn aggregate into context size.
- `finalizeStreamingOwner()` atomically claims the generation's sole terminal transition. Repeated or stale finalizers are no-ops.
- A successful Dexie load derives `messageCount` from the returned rows. It
  persists repaired metadata. A retry for a populated conversation can correct
  the count only when the loaded row IDs match exactly. LC rejects another
  non-empty snapshot as a concurrent or stale load.
- Every five seconds during streaming, LC bulk-upserts the owned assistant and
  following tool-result messages. `unmarkStreaming(convId, generationId)`
  accepts only the matching owner. A full-history replacement requires a live
  `messages.length` that matches a defined cached `messageCount`. A missing or
  different count means that completeness is unproven. Older rows might exist
  only in Dexie.

  Therefore, cleanup uses a non-deleting upsert and shows a
  storage warning. LC reports rejected checkpoint or flush writes to the user.
  An abnormal shutdown can lose work after the last successful checkpoint.
- Five-second checkpoint rows keep ordinary text uncompressed. This avoids
  synchronous `compressSync` work on the UI thread during generation. Text that
  starts with the reserved `Z:` prefix remains encoded, so readers cannot treat
  raw text as compressed bytes. Ordinary and terminal writes retain the normal
  compression policy, and readers accept plain and encoded row forms.
- Conversation persistence is serialized per conversation, while different
  conversations write independently. Pending checkpoints coalesce. Enqueuing a
  terminal barrier discards its superseded queued checkpoint. Both paths carry
  generation and revision fences. These fences prevent a late write from
  resurrecting a deleted chat or overwriting terminal output.
- Assistant footer metadata is best-effort display data. If a checkpoint lacks
  a metadata field, the bubble renders `-` for that chip. Preset and model
  popovers use the same fallback. This fallback applies only to the UI. It does
  not change the message, infer provider usage, or complete a partial checkpoint.
- On the next successful load, `recoverInterruptedToolRounds()` inserts one
  durable unknown-completion result for each unmatched tool call. It never
  replays the tool. The native side effect might have occurred before the crash.
  A deterministic recovery row ID makes repeated loads idempotent.

### Concurrent sessions and UI ownership

The foreground chat and running generations are separate concepts. One
`ChatView` renders the selected conversation. Up to three process-local sessions
continue in the background. Switching does not abort or globally clear state.
Draft text, attachments, editing, scroll/follow mode, side panel/Workspace
disclosures, and preview state are kept per conversation. The fourth composer
remains editable at capacity, but Send is disabled with the exact admission
reason.

Sidebar rows subscribe to lightweight phase state rather than token deltas.
They expose thinking, writing, tool use, permission/user waits, stopping, and
final response persistence, then failure if that write cannot commit. A row's
spinner is a targeted Stop control until the response becomes terminal; while
the final write is pending it is disabled and reports **Saving response**.
Background completion, generation failure, persistence failure, and interaction
attention remain on the owning row until viewed. When a running row needs
interaction attention, the circular exclamation badge is geometrically centered
over its spinner. The badge keeps its selected `11px` glyph size; attention
placement does not move the spinner or row actions.

Background terminal attention uses the persisted outcome. Provider errors and
disconnects are failures even when no `error_message` exists. LC tool limits,
tool timeouts, and the reasoning-loop guard are also failures. A requested Stop
is not a provider failure. Its `stopping` phase distinguishes its deliberate
`disconnected` terminal reason.

If the terminal storage write fails, the status control retries that write.
It does not run a second abort against the completed response.

Permission and `lc_ask_user` use one strict FIFO application queue. Every entry
contains conversation, generation, assistant, and tool-call identity. Those
fences are checked on enqueue, when the modal becomes visible, and immediately
before its answer is delivered. Cancelling a generation removes its queued
entries.

Time behind another visible prompt is added back to a permission call's tool
deadline. Same-scope callers each retain the FIFO wait shared with earlier
callers. A later **Allow once** prompt adds its own FIFO wait to that credit.
Time while a permission prompt is visible still counts. A sole
valid and exposed `lc_ask_user` call has no ordinary tool deadline. Every
interaction has a separate 30-minute attention cap that fails closed if the
prompt is abandoned.

---

## Protocol Adapters

Each adapter endpoint is a relative path appended to the profile's Base URL.
The Base URL must contain the provider's version or API base path. Examples are
`/v1` and `/api/v1`. It must not contain the final operation name. See [Base URL
Contract and Request URLs](./modules.md#base-url-contract-and-request-urls).
Model-list requests use the separate [Model Discovery](./modules.md#model-discovery)
probe sequence.

### OpenAI-Compatible (`openai.ts`)

- **Relative endpoint:** `/chat/completions` (for example, Base URL `/v1` produces `/v1/chat/completions`)
- **SSE format:** Raw `data:` lines, `[DONE]` sentinel
- **Delta extraction:** `content`, `reasoning_content`, `reasoning`, and
  `reasoning_details` for MiniMax. MiniMax repeats cumulative `content` and
  `reasoning_details[].text`. The adapter emits only the new suffix. It retains
  final structured details and replays them unchanged after tool results.
- **Tool calls:** Streaming deltas accumulated by `ToolCallAccumulator` — order-independent merge by `index`
- **Provider dialect:** Endpoint detection selects documented request and event
  field shapes. It must not remap or gate effort by model name. See the
  [normative reasoning contract](./reasoning-and-token-accounting.md#23-protocol-translation-is-allowed-model-correction-is-not).

### OpenAI Responses (`openai-responses.ts`)

- **Relative endpoint:** `/responses` (for example, Base URL `/v1` produces `/v1/responses`)
- **SSE format:** Typed `response.*` events across the Responses family. The
  adapter accepts `response.output_text.delta`,
  `response.reasoning_text.delta`, `response.reasoning_summary_text.delta`, and
  `response.completed`, plus OpenRouter's documented
  `response.content_part.delta`, `response.reasoning.delta`, and
  `response.done` carriers.

  The adapter accepts both documented dialects. This union is parser tolerance,
  not carrier classification; a compatible server may add events, mix relay
  shapes, or assign different meaning to a familiar name. Supporting only the
  OpenAI set caused a documented OpenRouter stream to produce an empty message
  without usage.
- **Input conversion:** Domain messages and tool calls/results become Responses input items
- **Reasoning:** Handles streaming display deltas and completed reasoning items.
  Event names are not carrier classifications: DeepSeek documents
  `response.reasoning_text.delta` as plaintext chain-of-thought, while Alibaba
  documents the same event name as a reasoning summary. OpenRouter's generic
  reasoning delta is likewise unresolved until its structured item is known.
  Preserve subtype and item provenance, then apply the
  [carrier matrix](./reasoning-and-token-accounting.md#4-carrier-classification).
- **Usage and replay groups:** Normalizes terminal
  `output_tokens_details.reasoning_tokens`. Each completed response's output
  items are appended, not overwritten, and one accounting group binds that
  response's opaque reasoning count to its item IDs. Plaintext reasoning is
  counted locally instead. Request conversion preserves either carrier and
  re-expands the single LC bubble so each function call is followed by its own
  result before the next response group.
- **Tool calls:** Accumulates `response.function_call_arguments.*` events into
  `ToolCallWire` records. If a compatible server sends no text deltas, the
  completed response is the fallback. LC retains each `output_text` part from
  every message item.

### Anthropic (`anthropic.ts`)

- **Relative endpoint:** `/v1/messages` (or `/messages` if the base URL already ends with `/vN`)
- **SSE format:** Named events (`event:` + `data:`)
- **Content block state machine:** `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`
- **Delta subtypes:** `thinking_delta`, `signature_delta`, `text_delta`, `input_json_delta`
- **Error terminal:** An `error` event sets `finish_reason: "error"` and keeps
  the provider message. This rule also applies when the event is the final SSE
  record and has no blank-line separator.
- **Tool-loop thinking state:** LC stores complete signed `thinking` and opaque
  `redacted_thinking` blocks separately from display reasoning. It replays them
  unchanged before matching `tool_use` blocks. Anthropic's own signature holds
  opaque full thinking; MiniMax's fixed-size 64-hex signature accompanies
  complete plaintext `thinking`, which LC recognizes through relays and counts
  locally. Reply metadata records the provider origin. It prevents replay to an
  unverified provider or relay. A matched provider contract permits unchanged
  blocks across model switches and lets the API decide compatibility; an
  unmatched relay remains blocked. Tool History never removes the
  blocks: it preserves compatible thinking state while replacing completed tool
  calls and results with the provider-shaped archive marker pair.

  Providers can reject changed, truncated, filtered, or incorrectly ordered
  thinking state after a tool result, so LC never edits retained thinking or
  signature content during that projection.
- **Terminal reasoning usage:** The final `message_delta.usage` object is
  preserved in full. `output_tokens_details.thinking_tokens` is normalized as
  provider-reported data and remains a breakdown of inclusive `output_tokens`, so
  it is never added to output twice. One response-level replay group binds the
  reported value to the ordered signed/redacted block indexes. Multi-response tool
  turns append and re-expand those groups around their matching tool results.
- **A thinking block with no deltas is valid.** From Opus 4.7 onward,
  `thinking.display` defaults to `omitted`. The block opens, receives one
  `signature_delta`, and closes. **The provider sends no `thinking_delta`
  events.**

  The adapter has nothing to accumulate, so the reasoning pane remains empty.
  A parser change cannot add bytes that the provider did not send. Display
  options must be selected from provider capability data or an explicit
  protocol contract, not a model-name table; current deviations are recorded in
  the [reasoning contract](./reasoning-and-token-accounting.md#10-current-implementation-deviations).
- **Message conversion:** `convertToAnthropicRequest()` maps OpenAI-format messages to Anthropic format:
  - System messages → top-level `system` field
  - Tool results → `tool_result` content blocks in `user` messages
  - Assistant tool_calls → `tool_use` content blocks
  - Enforces user/assistant alternation

### LM Studio REST (`lmstudio-rest.ts`)

- **Relative endpoint:** `/chat` (for example, Base URL `/api/v1` produces `/api/v1/chat`)
- **SSE format:** Named events. The stream opens with `chat.start` and closes
  with `chat.end`. The adapter processes `message.delta`, `reasoning.delta`, and
  `error`. It ignores `model_load.*`, `prompt_processing.*`, message boundary,
  reasoning boundary, and `tool_call.*` events.
- **Stats:** Server-measured `tokens_per_second`, `total_output_tokens`,
  `reasoning_output_tokens`, and `input_tokens` in `chat.end`
- **State:** Native chat accepts only the current user input. LC persists
  `chat.end.result.response_id`. The next turn sends it as
  `previous_response_id`. LC sends the system prompt only when it starts a new
  native state chain. A legacy conversation without a response ID starts a new
  chain. It does not send unsupported assistant history.
- **Input items:** Text parts use `{ type: "text", content }`, which shipped
  servers validate. If a server returns `invalid_union` for `input` and names
  `message`, LC adopts that value. It retries the request and uses the value for
  the rest of the client session.
- **No tool support:** REST path does not surface tool calls. Use OpenAI-compat or Anthropic variants for agentic workflows.
- **Error terminal:** An `error` event sets `finish_reason: "error"`, even when
  the provider does not send `chat.end`.

> **The native request body is validated strictly, so keep it close to what the
> server advertises.** The three compatible endpoints accept a less restrictive
> request. `/api/v1/chat` answers `400` with a precise reason instead, and two
> of those reasons are ordinary rather than exceptional.
>
> The first is the input item type above. The current [native chat
> page](https://lmstudio.ai/docs/developer/rest/chat) documents
> `type: "message"`, while the servers LC has been tested against answer
> `Invalid discriminator value. Expected 'text' | 'image'` for every tested
> model. Sending `text` is the current verified default. The
> correction covers a build that changes its mind. LM Studio publishes no
> version endpoint, so LC reads the accepted value from the rejection rather
> than gating on a version.
>
> The second is `reasoning`. Allowed values come from the model's
> `capabilities.reasoning.allowed_options` in `/api/v1/models`, so a model that
> lists only `off` and `on` rejects `medium`. A model without a reasoning
> configuration rejects every value. LC removes the field and retries once. A
> model that reasons by default still streams `reasoning.delta`.
>
> Both retries are automatic and cost one extra round trip on a local server.
> They appear in a support report as `input-shape-retry` and `reasoning-retry`.
> A rejection LC does not recognize is reported to the user unchanged, because
> the server's own text names the field and the accepted values.

### Adapter constraints proven against live endpoints

Defect investigations against live servers established these constraints. A
shipped regression exposed each constraint. Therefore, these constraints are
requirements, not advice.

**One adapter serves a protocol family, not one vendor.** The Anthropic adapter
also serves LM Studio, DeepSeek, MiniMax, Alibaba MaaS, and OpenRouter. The
Responses adapter also serves LM Studio, QwenCloud, and OpenRouter. The Chat
Completions adapter serves most other compatible endpoints.

Other compatible endpoints include OpenRouter and Google's Gemini compatibility
endpoint. Derive verified wire behavior from the embedded
`provider-contracts.v1.json` records and their evidence, not from memory or a
model name. `cache-observability.md` separately owns cache-reporter coverage.

A change is incorrect if it works only with the first-party API.
`api.anthropic.com` acceptance does not prove acceptance by other compatible
servers. Vendor-specific request/history behavior requires an exact resolved
contract. `isAnthropicOwnApi()` remains a narrow header/cache-opt-in predicate.
([cache-observability.md §3.1](./cache-observability.md#31-anthropic-caching-is-opt-in)).

**That rule applies in both directions.** A first-party field needs a predicate
so compatible servers do not receive it. A *compatible-server* extension needs
a predicate so the first party does not receive it. `top_k`
and `repeat_penalty` are accepted by llama.cpp, LM Studio, and vLLM. OpenAI and
Azure do not define these fields in their request schemas.

Therefore,
`isOfficialOpenAIEndpoint()` selects `max_completion_tokens`. It also
removes these fields from requests to those two hosts.
See [data-model.md](./data-model.md#what-each-endpoint-actually-receives).

**A predicate that gates a first-party-only field must match a host, never a
substring of the URL.** `isAnthropicOwnApi()` previously tested
`baseUrl.includes('api.anthropic.com')`. It returned true for
`https://api.anthropic.com.evil.example/v1`, which is a different domain. It
also returned true when the name appeared only in a path segment. Both URLs
would receive the `anthropic-version` header, cache opt-in, and
`thinking.display`.

Test predicates with adversarial inputs. Include malformed and lookalike inputs.
A list
of plausible endpoints will omit lookalikes.

`isAnthropicOwnApi()`, `isOfficialOpenAIEndpoint()`, `isMetaAIEndpoint()`, and
`isGeminiCompatEndpoint()` are all in this class and all classify a parsed
hostname.

**Provider dialect identity is defined.** Production generation resolves the
configured protocol plus exact URL origin/path against
`provider-contracts.v1.json`. A provider word in a relay URL or model ID grants
nothing. An unmatched route receives only the protocol-generic request shape:
no guessed reasoning control, first-party opt-in, or vendor sampling extension.
Provider-returned continuation state may replay unchanged only to its exact
source Base URL and model, which keeps generic tool loops working without
identifying a vendor. Unmeasured occupancy stays unknown. Some old adapter
predicates remain behind the direct-adapter compatibility boundary;
`LLMClient` marks real unmatched requests so those predicates cannot activate.

**Provider mapping and validation replace LC model correction.** Translate the
field shape required by the configured protocol, then forward the selected
effort unchanged. Let the server map, default, normalize, or reject it. LC must
not reproduce provider mappings, maintain model-name effort gates, omit a value
to avoid a provider error, or silently collapse two UI rungs. The complete rule
and current deviations live in
[`reasoning-and-token-accounting.md`](./reasoning-and-token-accounting.md#23-protocol-translation-is-allowed-model-correction-is-not).

**A vendor's documentation can describe an unreleased build.** LM Studio's
native chat page documents `type: "message"` for a text input item. Every
running server LC has been tested against answers `Invalid discriminator value.
Expected 'text' | 'image'` for that value, on models from two publishers. An
audit updated the adapter from that page and broke the native path. Therefore,
`input-shape-retry` exists.

If a version-sensitive rejection names the required
value, use the value accepted by live traffic. Read corrections from the
rejection text.

**Capability facts come from the server when it exposes them.** Anthropic's
Models API and LM Studio's native model records expose per-model reasoning
capabilities. Keep independent facts independent in the cached capability
record, but do not duplicate them as model-name predicates in adapters. When a
server exposes no capability metadata, use the documented protocol field and
surface its validation response.

See the [effort dispatch contract](./reasoning-and-token-accounting.md#6-effort-dispatch-table).

**LC enforces strict user and assistant alternation. This is an LC rule, not an
Anthropic rule.** `convertToAnthropicRequest()` merges array-content messages
into the preceding message with the same role. Without this merge, a tool loop
can produce two consecutive `user` turns after an image result.

Anthropic's API tolerates consecutive roles. Its Messages reference states:
"Consecutive `user` or `assistant` turns in your request will be combined into a
single turn." **Tests against only `api.anthropic.com` can make the LC merge
appear unnecessary.** The adapter also
serves stricter LM Studio, DeepSeek, MiniMax, and Alibaba MaaS endpoints. The
merge keeps `tool_result` blocks at the start of the content array. Before you
remove it, verify a live turn on each endpoint family.

**Images are delivered as their own user turn, exactly once.** `lc_read_image`
with `analyze:false` returns only metadata. Pixels travel separately and are
injected as a synthetic user turn. Two invariants hold:

- `resolveImageDelivery()` in `message-history.ts` decides delivery once per
  batch id. Injecting a batch again during later tool-loop iterations disrupted
  all 7 observed runs. The sample covered 5 models and all 3 adapters. Models
  interpreted the repeated turn as a new user request and stopped prior work.
- `buildImageTurnParts()` prefixes the turn with a text part labelling it as tool
  output, not a new user request. One unlabelled injection disrupted a run.
  Therefore, the label is required.

Image lookup also checks the tool result's owning assistant message.
An older turn that reuses the provider call ID cannot receive current images or delivery warnings.
This applies with Tool History enabled or disabled.

If delivery is blocked by model capability or a cache miss,
`appendImageDeliveryWarning()` updates the persisted result's structured
`warning` field for that model request. It does not append prose after the JSON
or place control text in `description`.

**Do not move images inside tool results without per-endpoint verification.**
This change was implemented, passed unit tests, and was reverted. Two of three live
endpoints rejected it outright:

| Endpoint | Result |
|---|---|
| LM Studio Responses | `400`. Array `output` was not accepted (`invalid_union`). |
| LM Studio Anthropic-compat | `400`. "Only text tool_result blocks are supported when tool_result.content is an array". |
| LM Studio Chat Completions | Passed. Tool messages are string-only, so the adapter used a user turn for images. |

Images in tool results remain the preferred design. The current user turn is a
mitigation, not a structural fix. Any new attempt requires capability detection
for each profile and a string fallback. Verify it against each endpoint family
on the shared adapter.

**Adapter unit tests cannot validate protocol support.** They assert that LC
*emits* a shape, not that a server *accepts* it. The change above passed 14
tests and failed on live endpoints. Protocol-shape changes require live endpoint
verification.

**If a tool run is split, every `tool_call_id` must still be answered
contiguously.** On Chat Completions the image user turn is emitted *after* the
whole run of tool results, never between them.

---

## Timeout Architecture

### Connect Timeout (Rust)

`proxy_stream` in `src-tauri/src/lib.rs` uses a 30-second TCP and TLS connection
timeout. The request's `sse_read_timeout_min` limits the wait for upstream
headers. Its default is 5 minutes. After headers arrive, Rust has no deadline
for the complete stream. The relay remains cancellation-aware. Response
establishment, error-body reads, and stream reads race the registered
`CancellationToken`.

For a non-success response, the native relay's accumulated error-body buffer
retains at most 64 KiB. It stops after the first incoming chunk that proves the
body is larger and adds an explicit truncation marker before it relays the
diagnostic. This bound is independent of the JavaScript stream queue limit.

### Idle Watchdog (JS)

`readWithTimeout` in `transport/read-timeout.ts` is the sole stream-level timeout:

```typescript
async function readWithTimeout(reader, timeoutMs) {
  return Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => {
      reader.cancel('read timeout');
      reject(new Error('timeout'));
    }, timeoutMs))
  ]);
}
```

If response headers or a body chunk exceed `sse_read_timeout_min`, LC cancels
the request. The setting accepts 1–60 min. Its server default is 5 min, and a
conversation can override it. Before headers, Rust emits a terminal timeout
through the registered IPC channel. During body reads, LC cancels the JS reader.

Then `stream-fetch.ts` calls `abort_tool_calls` for the matching
`lc-stream-<id>` relay. The bubble shows `⏻ disconnected`. This is an LC
sentinel, not an API value.

### Tool-execution deadline

The same conversation setting also starts one wall-clock deadline immediately
before a tool-execution round. Every accepted call in that round receives the
same deadline. It is not an idle timer for those calls. A new configuration
uses five minutes, while a legacy tools config with no value falls back to two
minutes. Compound tools use their remaining shared time for native work and
sub-agent requests. See [`lc_read_pdf`](./tools/tool-reference.md#lc_read_pdf)
for its single native deadline covering extraction and summary map/reduce.

### Reasoning-only loop guard

An active stream can still be unproductive when a model repeatedly emits the
same reasoning text. The separate [reasoning-only loop detector](./reasoning-loop-detection.md)
arms after 60 seconds of reasoning-only output, then matches a normalized,
repeating five-block sequence incrementally. It captures blocks `001` through
`005` first and requires the complete five-block sequence to repeat before it
stops. It does not scan the full transcript or call another model.

The orchestrator disables the guard for the provider turn as soon as it sees
non-whitespace answer/refusal text or tool-call activity. Tool activity is
reported by each adapter while the call is still streaming, so a legitimate
reasoning-to-tool transition is not mistaken for a loop. If the guard reaches
its threshold, LC aborts only an internal stream controller and finalizes with
`finish_reason: "infinite_reasoning_loop"`. The external Stop path
continues to finalize with `"disconnected"`.

See [Reasoning-only loop detection](./reasoning-loop-detection.md) for the
block-by-block contract, resource bounds, provider coverage, and test fixture.

### Queue Memory Budget

The Tauri IPC channel pushes data into a JS `ReadableStream`. The stream uses
`ByteLengthQueuingStrategy({ highWaterMark: 16 MiB })`. LC registers the channel
callback before `proxy_stream` starts. Thus, immediate status and error messages
cannot occur before listener setup. `highWaterMark` is advisory, not a hard
limit. Therefore, `stream-fetch.ts` checks `desiredSize` and encoded chunk size
before each enqueue.

If the next chunk would exceed 16 MiB, LC errors the JS stream. It releases the
channel and cancels the Rust relay. LC does not skip the chunk and continue.
Dropped SSE frames can remain valid while losing response text or tool-call
arguments.

The same aggregate byte count includes events that arrive before the
`ReadableStream` controller exists. Crossing the limit rejects response
construction and cancels the exact Rust relay.

---

## rAF Batching

`onToolCall()` is intentionally not rAF-batched: it is a control signal that
must disable the reasoning-only loop detector as soon as the adapter sees tool
activity. Content and reasoning remain rAF-batched for efficient store/UI
updates.

Delta callbacks (`onDelta`, `onReasoning`) accumulate in buffers. They flush
once per animation frame through `requestAnimationFrame`. Zustand updates occur
at most 60 times per second, not for each token. This reduces React rendering
work during streaming.

```
token arrives → contentBuf += text → scheduleFlush()
token arrives → contentBuf += text → (raf already pending)
token arrives → reasoningBuf += text → (raf already pending)
...
raf fires → flush() → store update → React re-render
```

---

## Tool Loop Orchestrator

The orchestrator handles the multi-turn tool loop:

1. **Validate** — `zod` parses each call's `arguments` against the handler's
   schema.
2. **Resolve** — Handler lookup uses the exposure set from Workspace and
   category toggles. LC rejects unknown or unexposed tools before a popup.
3. **Authorize** — File tools compare canonical directory and tool scopes with
   `dir_permissions`. A grant covers descendants. Overlapping roots are additive
   for each tool. Child grants do not extend upward or sideways. Web Access
   uses conversation `tool_grants`.

   The shell always prompts, except
   for the grandmaster `*******` auto-approval. Tool History does not prompt
   when exposed. Parallel non-shell calls with the same scope can share a
   persistent or fail-closed modal decision. **Allow once** applies only to the
   displayed logical call. A queued sibling requires another decision.
4. **Execute** — Before execution, LC checks the Workspace `Max tool calls per
   batch` value. It rejects a round that exceeds the value. No call from an
   oversized batch runs. Accepted batches use `runWithPool`, with the same value
   as the concurrency width. A lock serializes permission modals. Each accepted
   round has one parent-linked absolute deadline.

   LC records item and completion-callback failures. It reports them after
   visiting each accepted index. Before propagating an aggregate failure, it
   repairs missing result rows. Tool-call IDs are admitted once for each turn.
   A duplicate in one batch runs once.

   LC removes an ID already answered in an
   earlier re-stream round. The persistent graph contains at most one call row
   and result row for each ID. This matches the provider's single result slot.

   The surviving result row contains an `[LC]` notice that identifies the
   removed occurrence. A cross-round replay has no survivor in the removed
   round. In this case, LC adds the notice to the stored earlier result. The
   next model request includes that result and notice. An all-removed terminal
   round makes no later model request in that generation. Its notice remains
   visible in storage until the next turn.

   Notice updates stay within the current generation. A same-batch duplicate
   annotates only its surviving result when that call completes. Reusing a
   provider ID from a prior turn does not change that prior turn's result.

   Calls with the same tool name and normalized arguments but different IDs
   still run. Validation removes omitted optional values before comparison.
   Object key order does not affect the comparison. LC assigns occurrence
   numbers in the model-declared round order before concurrent workers run.
   From the second occurrence, LC prefixes the result with a same-call notice.
   The model must inspect that result before another retry. This behavior does
   not weaken the call-ID admission rule above.

   `tool-result-content.ts` owns every orchestration-notice builder and the
   strict recognized-prefix decoder. Notice-aware consumers use that decoder
   before they inspect structured result JSON. They preserve the notice when
   they update or persist the payload. This rule keeps repeated image results
   deliverable and prevents transient image fields from leaking into context.
5. **Persist** — LC appends tool results as `role: 'tool'` messages only while
   the generation and round remain active. After permission and execution
   waits, LC checks abort state, deadline, and ownership again. Only then can it
   persist grants or results. **Interruption always creates a result.** Stop
   creates one `aborted` row for each missing accepted ID. Deadline expiry
   creates one `timeout` row.

   An unexpected worker or persistence failure
   creates a non-replayable `generation_ended` row before error propagation.
   LC abandons a worker that does not settle after cancellation of its native
   execution group. Result ownership applies to one round. A result from an
   earlier round does not answer the current round. Each repair row warns that
   side effects might have occurred.

   The next turn must inspect state before it
   retries.
6. **Re-stream** — LC calls `runStream()` again with previous messages and new
   tool results. DeepSeek keeps each sub-turn's `reasoning_content`. Anthropic
   streams replay complete signed or redacted blocks on the verified provider
   surface; same-provider model compatibility belongs to Anthropic's API.
  Unmatched relays retain blocks only on the exact source endpoint and model.
  On MiniMax's
   Anthropic-compatible endpoint the signed block's `thinking` is complete
   plaintext and is locally countable; MiniMax Chat replays the structured
   `reasoning_details` field.
7. **Loop** — If new `tool_calls` arrive, repeat the loop. Otherwise, end the
   stream.
8. **Archive** — If resolved exposure includes `lc_tool_history`, later API
   requests represent completed calls/results with paired stubs. Reasoning and
   provider continuation state remain complete; Tool History does not remove
   signed/redacted thinking or Responses reasoning items. Adapters rebuild the
   paired provider call/result representation around that retained state. The
   model can retrieve archived tool results when needed.

`lc_apply_patch` has a stricter coordinator within steps 2–4. It validates
arguments and admits the exposed tool. Then it reserves the patch queue and
discovers target metadata. It authorizes the exact canonical parent scopes.
Next, it runs a new native preflight with the approved roots.

It verifies that discovery and preflight found the same target set. Finally, it
runs the native plan ID. Unknown or unexposed patch calls stop before
reservation and discovery.
Denial stops before full preflight and execution.

The default batch limit is 16. LC finalizes a rejected oversized response with
the LC-only `finish_reason: "tool_batch_limit"`.
`max_tool_rounds_per_turn` separately limits the number of tool-call rounds in
one response turn. LC normalizes it to 1–256 at the prompt and execution
boundaries. The UI slider offers 8–256.

### DeepSeek Thinking Mode

DeepSeek Chat Completions makes the **next request's shape** authoritative. If
that request carries `tools`, `reasoning_content` from all previous assistant
turns must be passed, including turns without tool calls. Without `tools`, the
server ignores historical reasoning even if it is sent. Current LC incorrectly
selects only messages that themselves have `tool_calls`; that is listed as a
deviation in the normative contract.

Other DeepSeek protocols expose different carriers and do not inherit that
Chat history rule without protocol-specific evidence:

| API | Verified carrier/history fact |
|---|---|
| Chat Completions | Plaintext `reasoning_content`; tools-present requires all prior turns, no-tools ignores it. |
| Anthropic Messages | `thinking` blocks are supported; public compatibility docs do not define an encrypted carrier. |
| Responses | Plaintext `reasoning_text` input items are supported; the Responses page does not document Chat's tools-dependent history filter. |

Thinking stays **enabled** for all turns, including tool-loop re-streams. Each
sub-turn produces chain-of-thought reasoning. A previous workaround incorrectly
disabled thinking on re-streams because it misdiagnosed the
`reasoning_content` replay defect.

---

## Tool Call Accumulator

`ToolCallAccumulator` in `llm-client/tool-accumulator.ts` merges SSE deltas
independently of their order:

```
Stream emits:  index=0, id="call_abc"
Stream emits:  index=1, id="call_def"
Stream emits:  index=1, function.name="lc_read_file"
Stream emits:  index=0, function.name="lc_list_dir"
Stream emits:  index=0, function.arguments="{"
Stream emits:  index=1, function.arguments="{"
...

finalize() → [
  { id: "call_abc", type: "function", function: { name: "lc_list_dir", arguments: "{...}" } },
  { id: "call_def", type: "function", function: { name: "lc_read_file", arguments: "{...}" } },
]
```

Deltas are ingested by `index` and concatenated. Each slot keeps its first
non-empty ID and tool name. Later deltas can add argument fragments, but they
cannot replace that identity. `finalize()` returns the assembled
`ToolCallWire[]` array in index order.

The orchestrator admits this array only after a provider tool-use terminal.
Accepted terminal reasons are `tool_calls`, `tool_use`, and the legacy
`function_call`. If the stream disconnects or ends before that terminal, LC
does not run the accumulated calls. It does not start a re-stream. It also does
not persist or replay unresolved Responses `function_call` items. Text,
reasoning, and other completed provider state remain available.

Accumulated argument text is capped at `TOOL_CALL_ARGS_MAX_CHARS` (2,097,152
JavaScript UTF-16 code units, as measured by `string.length`) per slot,
inclusive. A stream that reaches the cap exactly is complete and valid. A
stream that continues past the cap is limited. For a limited call, the terminal
policy is **terminate, do not continue**. LC discards the complete provider
turn.

It also suppresses valid siblings in the same batch. Therefore, a
malformed batch cannot run partially. The stream ends with a visible `error`
finish reason, even if the provider reported `tool_calls`.

LC does not persist or replay provider tool-call state for a limited turn. On
Responses, it suppresses raw `responses_output_items`. On Anthropic, it detects
a limited `tool_use` at `content_block_stop` and EOF. A stream that ends before
the stop marker still invalidates the turn. On Chat Completions, accumulator
issues force the error finish.

Responses and Anthropic apply the same inclusive
limit to their accumulators. Thus, the limit applies to every wire family.

---

## Abort / Cancellation

- LC creates an `AbortController` for each admitted generation. The process-local
  generation manager stores it with `{ conversationId, generationId,
  assistantMessageId }`. No selected-view `abortRef` owns application lifetime.
- Normal Sidebar switching and New chat remain available while responses run.
  Navigating away or unmounting `ChatView` does not abort its session. The one
  foreground view projects whichever conversation is selected while the
  application manager retains background owners.
- On normal completion, only the matching generation can terminalize and
  release its streaming owner and capacity slot. A stale `finally` is a no-op.
- On user cancel, the controller aborts. `finalizeStreamingOwner()` synchronously
  claims `finish_reason: "disconnected"`. The owner remains registered until the
  pipeline settles. This blocks late permission, grant, result, re-stream, and
  finalizer changes.
- `pagehide` and `beforeunload` are owned by one application-level listener. It
  snapshots every live session, aborts and terminalizes each exact owner, and
  deregisters the runtime sessions. A hard exit cannot wait for queued IndexedDB
  writes. Unmatched generation journal rows provide restart recovery.
- Permission requests receive the same round-linked signal. Stop dismisses an
  open modal as `aborted`. The round clock includes time spent waiting for user
  approval. Deadline expiry dismisses an unanswered modal and ends the turn as
  `tool_timeout`. LC does not run that call. Barriers after permission and
  execution waits suppress stale decisions from late UI or native results.
- For model streaming, `lc-stream-<id>` remains registered in Rust until
  completion, error, or abort. Blocking reads use `tokio::select!`, so cancel
  wakes an idle socket.
- For tool execution, each call has its own non-empty execution group. This
  remains true when sibling calls share a permission decision. The runner passes
  the round-linked `AbortSignal` to `abort_group(group_id)`. Stop or deadline
  cancels each native child of that model tool call. Focused cleanup can also
  use `abort_tool_calls`.
- Tool sub-agent preflights and `chatOnce` calls receive the same `AbortSignal`.
  In Tauri, model discovery and non-streaming generations use cancellable
  `proxy_stream`. The generation request keeps `stream: false`. Thus, Stop
  terminates the native HTTP or model request. It does not only suppress the
  eventual result.
- The native registry applies to one process. It cancels active relays and tools
  while LC runs. A new process cannot stop work from a crashed process without
  an OS job or process-group mechanism.

See [Concurrent conversations](./concurrent-conversations.md) for admission,
navigation, UI ownership, persistence, and page-exit behavior across sessions.
