# OpenAI Responses — Historical Integration Note

This document records the OpenAI Responses integration history around storage,
streaming, and state management. The normative cross-provider contract is
[reasoning-and-token-accounting.md](./reasoning-and-token-accounting.md). If this
note conflicts with that contract, the canonical contract wins.

> **Implementation update (2026-07-26):** Section 4's original design note is
> superseded by the current implementation. LC now persists each completed
> Responses `output` item array, replays message/function-call items, and
> replays reasoning items carrying either `encrypted_content` or provider-returned
> plaintext `reasoning_text` on later `store: false` requests. This preserves the
> local-first privacy decision while following OpenAI's current
> reasoning-continuity guidance.
>
> Historical bug descriptions do not authorize model-name capability gates,
> effort remapping, reasoning pruning, or event-name carrier inference.

---

## 1. `store: false` — No server-side persistence

### Decision
LC sets `"store": false` on every Responses API request.

### Why
LC is a **local-first client** that manages all conversation state in IndexedDB.
Enabling `store: true` would:

1. Contradict LC's privacy model by asking OpenAI to retain response state.
2. Enable `previous_response_id` for reasoning continuity, but at the
   cost of server-side state that LC does not control.

### Official reference
- Responses API `store` parameter: `POST /v1/responses` body param
  — "Whether to store the generated model response for later retrieval
  via API."
- https://developers.openai.com/api/reference/resources/responses/methods/create

### Continuity
LC now keeps `store: false` and provides manual reasoning continuity. It
persists completed output items locally. On the next request, it replays eligible
reasoning, message, and function-call items. LC does not intentionally make the
model reconstruct missing reasoning and does not use Tool History as a
substitute for provider continuation state.

Section 4 describes the implemented reasoning-item replay. LC keeps `store:
false` and achieves continuity without server-side state.

---

## 2. `reasoning.summary: "auto"` — OpenAI reasoning summaries

### OpenAI behavior and LC policy
On official OpenAI Responses requests, LC may set
`"reasoning": { "effort": "...", "summary": "auto" }` to request readable
summary output. This display option is provider-specific. It must not be sent to
every Responses-compatible server merely because the endpoint has the same
path, and it must not be used to classify the provider's reasoning carrier.

### Why
OpenAI Responses can return opaque reasoning state in `encrypted_content`.
Readable reasoning summaries are separate `summary` parts and require an
explicit summary request. A missing summary is not evidence that the model used
zero reasoning, and a readable summary is not the encrypted carrier.

This OpenAI display option says nothing about another provider's output.
LM Studio, DeepSeek, MiniMax, OpenRouter, Z.AI, and Alibaba-compatible Responses
surfaces each require their own documented or fixture-backed carrier handling;
the verified distinctions live in the canonical provider matrix.

### Official reference
- Reasoning summaries: https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries
  — "Reasoning summary output is part of the `summary` array in the
    `reasoning` output item. This output will not be included unless
    you explicitly opt in to including reasoning summaries."
  — "To access the most detailed summarizer available for a model, set
    the value of this parameter to `auto`."
- Streaming events: https://developers.openai.com/api/reference/resources/responses/streaming-events
  — `response.reasoning_text.delta`, `response.reasoning_summary_text.delta`,
    `response.reasoning_summary_part.added`, `response.reasoning_summary_part.done`

The provider validates supported summary values. LC does not assume an
unsupported field will be silently ignored. DeepSeek accepts the top-level
`reasoning.summary` option but generates no summary; separately, it does not
support `summary` inside a replayed reasoning input item. Alibaba uses a
similarly named reasoning stream event for summary output. Those contracts are
not interchangeable with OpenAI's.

---

## 3. `reasoning_effort` vs `reasoning` field — CC vs Responses

### Problem
The Chat Completions API (`/v1/chat/completions`) does not accept a
top-level `reasoning` object — it uses `reasoning_effort` (a string).

The Responses API (`/v1/responses`) accepts `reasoning: { effort, summary }`
as an object.

The orchestrator builds one `ChatRequest` that can flow to both
paths, depending on the adapter.

### Bug discovered (2026-07-13)
The orchestrator was setting `req.reasoning = { effort: "medium" }`.
When this `ChatRequest` was sent to `/v1/chat/completions`, the API
returned:
```json
{
  "error": {
    "message": "Unknown parameter: 'reasoning'.",
    "type": "invalid_request_error",
    "param": "reasoning",
    "code": "unknown_parameter"
  }
}
```

### Fix
Orchestrator now sets `req.reasoning_effort = "medium"` (a string)
instead of `req.reasoning = { effort: "medium" }` (an object).

- **Chat Completions** receives `"reasoning_effort": "medium"` → valid.
- **Responses adapter** selection, in `orchestrator.ts`, reads
  `req.reasoning_effort ?? req.reasoning?.effort` → picks up
  `"medium"` → `buildRequest()` converts the effort to
  `"reasoning": { "effort": "medium" }`. A supported provider-specific
  summary option may be added independently.

### Official reference
- Chat Completions `reasoning_effort`: https://platform.openai.com/docs/api-reference/chat/create#chat-create-reasoning_effort
- Responses `reasoning`: https://developers.openai.com/api/reference/resources/responses/methods/create
  (body param `reasoning` → `{ effort, summary, mode, ... }`)

---

## 4. Responses reasoning-item replay

### Decision
LC now persists the complete Responses `output` item array on each assistant
message and replays eligible reasoning items on later `store: false` calls.
OpenAI items carry opaque `encrypted_content`; compatible Responses servers may
instead return plaintext `content[].reasoning_text`. The local-first state model
is preserved while OpenAI's recommended reasoning-continuity path is used.

### Why
1. **Reasoning is canonical conversation data.** LC stores the provider's
   complete reasoning items and does not prune them during normal history
   construction.
2. **OpenAI recommends replay for continuity and efficiency.** With locally
   managed `store: false` state, LC inserts eligible output items into the next
   request's `input` array.
3. **Compatible servers define their own replay contracts.** DeepSeek Chat
   requires all prior plaintext reasoning when a request contains `tools`;
   DeepSeek Responses defines a plaintext reasoning item but does not publish
   that same history-filtering rule. See §8.

### Official recommendation
OpenAI **recommends** passing reasoning items back for tool-call rounds
to avoid re-thinking and save tokens:
- https://developers.openai.com/api/docs/guides/reasoning#keeping-reasoning-items-in-context

> "When doing function calling with a reasoning model in the Responses
>  API, we highly recommend you pass back any reasoning items returned
>  with the last function call ... This allows the model to continue
>  its reasoning process to produce better results in the most
>  token-efficient manner."

### Trade-off
Encrypted reasoning remains opaque to the UI. LC displays only the optional
human-readable reasoning summary and never renders the raw encrypted value.
TokenMeter cannot tokenize that carrier locally. LC therefore normalizes
`usage.output_tokens_details.reasoning_tokens` and binds the response-level
count to the exact replay group containing the encrypted item IDs. The active
request projection adds the count once while the encrypted carrier survives;
Tool History may replace the paired function call without removing the carrier.
The readable summary is the display form of that state and is not counted a
second time. A carrier without a usable count makes the meter an explicitly
unknown lower bound; it never reads as zero.

### Current implementation flow
The implementation uses this flow:

1. **Stash** — `parseStream()` retains the complete terminal output item array,
   including message, reasoning, and function-call items.
2. **Bind** — response-local reasoning usage and the actual carrier shape form
   one `opaque_replay_accounting` group. Multiple encrypted items share the
   response count; LC never fabricates a per-item split. Plaintext items are
   marked as locally countable instead.
3. **Append** — later tool-loop responses append items and accounting groups to
   the same assistant bubble instead of replacing earlier state.
4. **Project and replay** — request construction and TokenMeter share
   `provider-history-projection.ts`. The Responses adapter retains reasoning
   and message items, then rebuilds Tool History's synthetic function call in
   provider order. Accounting follows the retained carrier instead of being
   discarded with the original function-call item.

The `ResponsesInputItem` type includes:
```typescript
interface ResponsesInputReasoningItem {
  type: 'reasoning';
  id?: string;
  encrypted_content?: string;
  content?: Array<{ type: 'reasoning_text'; text: string }>;
}
```

Encryption classification is structural: a non-empty OpenAI
`encrypted_content` is opaque evidence even beside a summary. A model name,
`/responses` endpoint, empty display field, or generic reasoning event is not
evidence. A non-empty `content[].reasoning_text` is locally tokenizable only
when the provider defines it as plaintext chain-of-thought; a provider can use
similar reasoning labels for summary output. Completed-response usage still
describes footer cost. It becomes next-request accounting only when bound to a
carrier the next request actually sends.

---

## 5. Reasoning effort dispatch

LC translates the field shape required by the configured endpoint and forwards
the selected semantic effort unchanged. It does not maintain GPT model-name
ranges, fold a new value into an older one, or omit `none` to avoid a server
error. The server owns mapping and validation.

When an endpoint returns current reasoning capability metadata, LC may use it
to present valid controls. Missing capability metadata does not authorize a
model-name fallback. LM Studio's `allowed_options` is one endpoint extension;
it is not an OpenAI `/v1/models` contract and must not be generalized to cloud
model IDs.

The earlier model-name remapping described here was a mistake and is deliberately
not retained as historical guidance. The normative rule and current code
deviations are tracked in
[reasoning-and-token-accounting.md](./reasoning-and-token-accounting.md#10-current-implementation-deviations).

---

## 6. Reasoning delivery methods — streaming vs batched

Official OpenAI Responses can deliver reasoning-related display output through
streaming events and completed reasoning items:

| Method | Wire shape | Classification |
|---|---|---|
| Reasoning-text stream | `response.reasoning_text.delta` | Preserve the event subtype; classification remains provider-scoped. |
| Summary-text stream | `response.reasoning_summary_text.delta` | Readable summary/display text, not an encrypted carrier. |
| Completed output item | `response.output_item.done` with `item.type === "reasoning"` | The final structured item is authoritative for summary and encrypted carrier fields. |

The adapter must handle streaming, item completion, and the terminal response
without displaying the same text twice. It must also retain the event subtype
until the final item resolves carrier provenance. Compatible providers do not
assign identical semantics to the generic event names: DeepSeek documents
reasoning text as plaintext chain-of-thought, Alibaba documents its similarly
named Responses delta as a summary, and OpenRouter requires the completed item
structure for precise classification.

### Official reference
- Streaming events: https://developers.openai.com/api/reference/resources/responses/streaming-events
- Response object `output` array: https://developers.openai.com/api/reference/resources/responses/object

---

## 6a. `response.incomplete` carries two different outcomes

`incomplete_details.reason` is `max_output_tokens` or `content_filter`. These
values have different meanings. The first identifies a limit that the user can
increase. The second does not. Therefore, the adapter maps `content_filter` to
`finish_reason: "content_filter"`, which renders as `⦸ filtered`.

It maps other
values to `"length"`, which renders as `✂ truncated`. This includes an
unrecognized future value. `provider_finish_reason` always keeps the raw
`response.incomplete (<reason>)` string.

Official reference: https://developers.openai.com/api/docs/guides/reasoning

---

## 6b. The `error` event is flat

A Responses stream error arrives as a top-level object:

```json
{ "type": "error", "code": "ERR_SOMETHING", "message": "Something went wrong", "param": null, "sequence_number": 1 }
```

`code`, `message`, and `param` are **not** nested under an `error` key. Reading
only nested `error.message` caused LC to show `JSON.stringify` of the complete
event. This buried the provider's message in a data object. The adapter now
reads the top-level `message` first.

It then falls back to a nested `error.message`. **That fallback is
undocumented legacy tolerance. No provider publishes this wire shape.** No
official reference consulted here defines it: OpenAI's Chat Completions
streaming reference documents `chat.completion.chunk`. Its optional `moderation`
object carries `input` and `output`. Each is either a moderation-results object
or a `{ type: "error", code, message }` object.

It defines neither a top-level
`chunk.error` nor a global nested SSE error event. LC's Chat Completions path
carries the same tolerance, also without a cited source, and no captured
provider event has been produced for either. LC keeps the fallback because a
regression test covers it and it adds no material cost. Do not attribute it to
a provider.

Anthropic's Messages stream *does* document a nested error event, and stays that
way:

```
event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
```

The two envelopes have different documented shapes. Do not change one adapter
to match the other.
[Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) ·
[Chat Completions streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)

Official reference: https://developers.openai.com/api/reference/resources/responses/streaming-events

---

## 7. Summary of all design decisions

| Decision | Rationale | Doc ref |
|---|---|---|
| `store: false` | Local-first privacy. LC manages state client-side. | §1 |
| OpenAI `summary: "auto"` only on a supported surface | A readable summary is provider-specific display output, separate from opaque state. | §2 |
| `reasoning_effort` (string) not `reasoning` (object) in ChatRequest | Chat Completions compatibility. The Responses adapter converts internally. | §3 |
| Local Responses reasoning-item replay | Preserves encrypted or provider-returned plaintext reasoning continuity without server-side storage. | §4 |
| Exact effort pass-through | Field shape changes by protocol; the selected value does not. | §5 |
| Preserve streaming subtype and reconcile final items | Delivery and carrier meaning are provider-dependent. | §6 |
| `content_filter` kept distinct from `length` on `response.incomplete` | The two reasons mean opposite things to a user | §6a |
| Error message read from the top level, nested form as fallback | The Responses `error` event is flat. The nested form is undocumented legacy tolerance. | §6b |
| DeepSeek plaintext replay | Chat with `tools` requires all prior reasoning; Responses supports plaintext reasoning items but documents no equivalent history filter. | §8 |

---

## 8. DeepSeek reasoning pass-back (2026-07-31)

### Chat Completions contract
DeepSeek's thinking mode returns plaintext chain-of-thought alongside the
answer. The history rule depends on the next request shape, not on which earlier
assistant messages happened to call a tool:

> "for requests carrying the `tools` parameter, the `reasoning_content` must
> be fully passed back to the API in all subsequent requests. If your code
> does not correctly pass back `reasoning_content`, the API will return a
> 400 error."
> — https://api-docs.deepseek.com/guides/thinking_mode#tool-calls

Therefore, when the next Chat Completions request carries `tools`, LC must pass
reasoning from **all previous assistant turns**, including turns without tool
calls. Without `tools`, DeepSeek documents that historical reasoning is ignored
even if sent. LC still archives it; the request projection and TokenMeter may
exclude it only for that documented no-tools shape.

### Responses contract

On the Responses API, chain-of-thought is a `reasoning` **item**, not a message
field. DeepSeek's input-item table specifies the accepted replay shape:

> `reasoning` — "Supported. Plain-text `content` is merged into the adjacent
> assistant message; `summary` and `encrypted_content` are not supported"
> — https://api-docs.deepseek.com/guides/responses_api

The two providers use different carriers on the same item type:

| | OpenAI | DeepSeek |
|---|---|---|
| Carrier | `encrypted_content` (opaque) | `content: [{ type: "reasoning_text", text }]` |
| `summary` | supported (§2) | Top-level option accepted but no summary generated; unsupported inside a reasoning input item. |
| Replay | Recommended for continuity and efficiency. | Plaintext input items are supported. The Responses page does not state Chat's tools-dependent history filter. |

### The bug
§4's replay logic kept an item only when it carried `encrypted_content`:

```typescript
return item.encrypted_content ? [ /* replay */ ] : [];
```

DeepSeek never sets that field. Therefore, LC removed **every** reasoning item.
Each affected tool round was replayed without its chain-of-thought. Earlier live
testing associated this with a 400, but the deleted scratch capture is not
durable evidence for a Responses-wide history rule. The committed tests prove
LC's parser/projection shape, not current live-provider acceptance.

### Required implementation
`OpenAIResponsesAdapter.buildRequest()` preserves provider-returned plaintext
`reasoning_text` items by their structural shape. For DeepSeek Responses it
must omit unsupported `summary` and `encrypted_content` fields **from the
replayed input item**. Tool History may rebuild a paired function call, but it
cannot discard the adjacent reasoning item. The separate top-level
`reasoning.summary` request option is accepted and simply produces no summary.

For other Responses-compatible servers, encrypted and plaintext items replay
unchanged only after their carrier semantics are established by provider
documentation or a durable fixture. LC never invents plaintext reasoning from
an untyped generic SSE event.

`parseStream` also reads `reasoning_text` parts off completed reasoning items,
so the chain-of-thought reaches the UI when it arrives batched rather than as
`response.reasoning_text.delta` events.

### Effort and request options
LC forwards the selected effort unchanged on both DeepSeek API styles. DeepSeek
publishes its own requested-effort mapping; LC does not reproduce that mapping.
DeepSeek Responses documents `summary` and `encrypted_content` as unsupported
inside reasoning input items. Its top-level `reasoning.summary` option is
accepted but produces no summary. The readable chain-of-thought arrives as
plaintext `reasoning_text` content.

The resolved DeepSeek Chat contract selects all prior canonical reasoning when
the next request contains tools. The distinct Responses contract replays every
eligible plaintext reasoning item, including non-tool assistant turns; it does
not borrow Chat's no-tools rule. Request assembly and TokenMeter use the same
provider-history projection. Direct adapter unit fixtures that omit
`LLMClient`'s resolution marker retain a legacy compatibility branch only to
test the adapter boundary; production requests do not use it.

---

## References

| Topic | URL |
|---|---|
| Responses API reference | https://developers.openai.com/api/reference/resources/responses |
| Responses create | https://developers.openai.com/api/reference/resources/responses/methods/create |
| Responses streaming events | https://developers.openai.com/api/reference/resources/responses/streaming-events |
| Reasoning guide | https://developers.openai.com/api/docs/guides/reasoning |
| Reasoning summaries | https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries |
| Keeping reasoning in context | https://developers.openai.com/api/docs/guides/reasoning#keeping-reasoning-items-in-context |
| Migrate to Responses | https://developers.openai.com/api/docs/guides/migrate-to-responses |
| Conversation state | https://developers.openai.com/api/docs/guides/conversation-state |
| Chat Completions reasoning_effort | https://platform.openai.com/docs/api-reference/chat/create#chat-create-reasoning_effort |
| DeepSeek thinking mode (tool calls) | https://api-docs.deepseek.com/guides/thinking_mode#tool-calls |
| DeepSeek Responses API compatibility | https://api-docs.deepseek.com/guides/responses_api |
| DeepSeek create response reference | https://api-docs.deepseek.com/api/create-response |
