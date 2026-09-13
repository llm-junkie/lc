# A04 — Streaming and turn lifecycle

**Template code:** `A04` · **Version:** 1.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A04 v1.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

**Sibling templates:** [`a02-tool-loop-and-concurrency.md`](./a02-tool-loop-and-concurrency.md)
covers tool pairing and ordering.
[`a03-protocol-adapters.md`](./a03-protocol-adapters.md) owns provider-contract
resolution, carrier/replay semantics, and usage-field normalization.
[`a05-state-and-persistence.md`](./a05-state-and-persistence.md) covers what
survives a reload. [`a06-cpu-and-responsiveness.md`](./a06-cpu-and-responsiveness.md)
covers the cost of rendering a live projection. Keep these domains separate. A prior
combined lifecycle review ran all three at once, and reached 2,000 lines before
closing.

---

## Scope

**In.** `chat-pipeline/orchestrator.ts`, the generation session manager,
admission/handoff lifecycle, phase tracker, `llm-client/client.ts`, the four
adapters' `parseStream`, and `transport/` for fetch, SSE decode, and read
timeout. It also covers the response-status store, the Stop control path, the
boundary where canonical stream state is projected into the reasoning preview
and the Copy action, `TurnUsageAccumulator`, the assistant-turn usage footer,
the next-request TokenMeter, and the active-stream accounting overlay. It covers
the generation pause while a sole valid `lc_ask_user` call waits for the user,
and the fresh provider deadline after that interaction settles. It includes
Whiteboard turn admission, pinned references, provisional model state, terminal
settlement, and result repair. It covers synchronous chat admission in
provisional and committed states, exact-owner handoff, concurrent conversation
sessions, targeted cancellation, background status, and application-owned page
exit.

**Out.** Tool result correctness (sibling). Persistence (sibling). Styling of
status indicators (`a09-theme-and-visual-parity.md`). Projection and rendering
cost (`a06-cpu-and-responsiveness.md`). Provider-specific control fields,
carrier classification, replay eligibility, and usage aliases
(`a03-protocol-adapters.md`).

## Invariants

1. **Generation ownership.** A delta, tool result, phase, TPS value, error, or
   final status can update only the conversation, generation, and assistant
   message that created it. A retired owner cannot update its successor.
2. **Exactly one terminal transition.** Success, refusal, length stop,
   disconnect, user abort, tool limit, and error each finalize exactly once.
3. **No post-abort mutation.** After Stop resolves, late provider chunks,
   deferred callbacks, and tool completions cannot resume the stream. They also
   cannot overwrite its terminal status.
4. **Monotonic canonical content.** Persisted text and reasoning append in
   source order. They never disappear, repeat, or cross between messages. Any
   Copy action that promises the complete value follows the same rule. A bounded
   live projection can show only a tail, but it must never truncate the
   canonical message. A terminal carrier or reported counter may replace its
   matching transient accounting overlay, but it cannot replace, delete, or
   redistribute canonical reasoning, visible reply, or refusal content. Those
   fields remain independently present when they coexist.
5. **One active owner per conversation.** Several conversations may stream at
   once, but each conversation has one exact generation owner. Listeners,
   abort controllers, timers, and
   store callbacks are released or transferred deliberately at every terminal
   path. This includes the paths that fail.
6. **Bounded recovery.** A retryable failure identifies a safe retry boundary. A
   non-retryable failure never triggers blind replay of a mutation.
7. **Visible state agreement.** Response status, phase label, Stop control, and
   tool activity never contradict each other. They also never contradict the
   persisted message.
8. **A user decision is not an operational timeout.** A sole valid and exposed
   `lc_ask_user` call does not spend the ordinary tool-round or stream-read
   deadline while it waits in the application FIFO or while its modal is
   visible. The next provider stream starts with a fresh deadline. A separate
   generous absolute attention cap may terminalize an abandoned prompt.
   Parent abort, conversation teardown, modal-host teardown, attention expiry,
   and app close still settle the interaction exactly once and release the run.
9. **A terminal turn preserves committed Whiteboard truth.** Natural success,
   refusal, length stop, provider failure, disconnect, timeout, user Stop, tool
   limit, and recovery all settle the generation-owned provisional model board
   once. A change committed before settlement is retained even when its normal
   tool result was interrupted. A call that did not commit cannot fabricate a
   change, and a worker that arrives after settlement cannot mutate state.
10. **Admission is reserved before asynchronous preflight and committed before
    mutation.** Send, Retry, and Edit synchronously reserve one provisional slot
    before any credential, model-detail, attachment, or durable-write await.
    Immediately before transcript mutation, that exact owner rechecks current
    application and profile limits and becomes committed. Rejection retires only
    the provisional owner and leaves the transcript unchanged. Handoff transfers
    the committed owner to streaming without a capacity gap or sibling change.
11. **Capacity policy and mechanism stay separate.** The manager can retain the
    product's hard maximum of three while Settings defaults admission to two.
    Lowering a configured limit does not kill running sessions or displace
    committed admissions; it governs new reservations and unresolved
    provisional commits. A committed admission may register under the hard
    maximum. An optional per-profile limiter can refuse one profile without
    consuming or cancelling unrelated work.
12. **Visible lifecycle state is conversation-scoped.** Phase, TPS, Stop,
    attention, completion, and persistence failure belong to the addressed
    chat. Viewing one chat clears only its attention. Navigation neither owns
    nor terminalizes a background session.
13. **Page exit is application-owned.** Window close and reload enumerate and
    settle every live session. A foreground `ChatView` unmount or conversation
    switch cannot silently cancel a background generation.
14. **Turn usage is one historical aggregate.** One assistant generation owns
    one accumulator across the initial response and every provider response in
    its tool loop. Each response contributes at most once. The footer reports
    already-consumed input, output, reasoning, cache, and coverage without
    presenting partial provider coverage as complete. It never becomes the
    next-request context value.
15. **TokenMeter predicts the actual next request.** It uses the same provider-
    history projection the adapter will serialize for the currently selected
    model, endpoint, tools, system prompt, and Tool History setting. It excludes
    a future unsent user message and includes all eligible prior reasoning and
    continuation state independently of Tool History. Locally measurable text
    is counted locally; unmeasured opaque or remote occupancy makes the result
    uncertain rather than zero or falsely exact.
16. **Live accounting reconciles once.** During a stream, append-only plaintext
    reply and reasoning update a bounded transient overlay with their carrier
    provenance. Summary/display text and unresolved compatible events cannot be
    promoted to plaintext reasoning by name. Terminal structure and reported
    accounting atomically replace the matching transient contribution instead
    of adding it again. Abort, disconnect, refusal, error, and tool-use terminal
    paths settle or discard only that generation's overlay; a stale owner cannot
    publish a late count.

## Check matrix

| Axis | Required variations |
|---|---|
| Ordinary response | Text only, reasoning then text, simultaneous reasoning/text/refusal fields, refusal, usage before and after finish, reasoning that crosses the live-preview window threshold |
| Terminal path | Natural stop, length stop, provider error during the stream, transport disconnect, idle-watchdog timeout, user abort |
| Abort timing | During reasoning, during text, during a permission prompt, before native shell or fetch work starts, during a native tool, and between a tool result and the next stream. Pre-start cancellation must be an aborted result, not successful-looking process or fetched content |
| Interactive wait | Submit one choice, submit a custom answer, skip one, skip all, wait past the configured stream timeout, reach the absolute attention cap, parent abort, conversation switch, modal-host teardown, and an unavailable host. Distinguish the bounded host-registration handoff, excluded FIFO wait, and separately attention-capped user-response wait |
| Admission and handoff | Capacity 1, default 2, opt-in 3, refusal of the next admission, two provisional owners racing, provisional-to-committed transition, a committed owner awaiting handoff, durable-send failure, session-registration failure, and lowering 3 to 2 before and after the third preflight commits. Assert exact rollback, committed-work registration under the hard maximum, and no sibling disturbance |
| Concurrent sessions | Two and three real streams with interleaved chunks, cancel the middle owner, a queue-limit failure in one stream, a replacement generation in one chat, and independent completion of every sibling |
| Navigation and background state | Switch among an active chat, an idle draft, and a completed chat; create a new chat at capacity; targeted Sidebar Stop; background completion and failure attention; and return to each chat. No switch owns another session |
| Adapter failure | Before the first normalized callback, after content but before finish, on the disconnect callback |
| Lifecycle exit | Window close and reload with one, two, and three sessions; foreground `ChatView` unmount and conversation switch while a sibling continues; application cleanup after partial terminal failure |
| Limits | Context limit, tool-round limit, repeating-reasoning guard |
| Turn usage | One response; several tool-loop responses; duplicate completion ID; an early reasoning-heavy response; complete, partial, and mixed usage coverage; absent versus explicit-zero reasoning/cache; provider report beside LC estimate. Each response contributes once and the footer stays separate from TokenMeter |
| Next-request projection | Tool History on and off; plaintext, encrypted/signed/redacted, summary, output-item, remote-handle, and unknown state; same-provider model switch; provider/relay switch; selected tools/system prompt changes; empty composer and an unsent draft. Compare the meter projection with the exact adapter request |
| Live meter | Chat, Responses, Messages, and LM Studio streams with plaintext reasoning; Responses summary/display events; unresolved compatible reasoning; encrypted terminal state; append and cumulative deltas; terminal usage present or missing; completion, tool use, refusal, abort, disconnect, and error. Assert no zero flash and no terminal double count |
| Whiteboard turn | Exposure off; exposure on with initial references; user edits during generation; no model mutation; one mutation; several mutations; and a reread after each mutation. The turn keeps one pinned user version and the latest generation-owned model value |
| Whiteboard terminal repair | Every terminal path before commit, after commit but before result persistence, and after ordinary result persistence; repeated settlement; stale worker; crash reload; and a missing owning assistant message. Retained content, turn references, receipt, and paired result must agree |
| Envelope | All four adapters. A lifecycle bug is usually per-adapter |

## Domain-specific evidence rules

- **A terminal-path claim needs a real stream**, not a hand-built message array.
  A prior lifecycle review found `provider-message-integrity.test.ts` asserting
  a conversation shape the runtime never produces. The cause is that
  `finalizeMessage()` merges tool-loop turns into the initiating assistant
  message. Drive the real store and orchestrator instead.
- **A concurrency claim needs simultaneously live transports.** Starting one
  stream after another completes cannot prove decoder isolation, middle-owner
  cancellation, capacity accounting, or application-owned exit.
- **Idle-watchdog and cancellation behavior differ between dev and packaged
  builds.** Record which build you used.
- **Do not test the ask-user wait with a shortened operational timer alone.**
  Prove that the modal remains active beyond that timer, that Stop still aborts
  it, and that the follow-up provider stream receives a new full deadline.
- **Inspect source and projection separately.** During a long-reasoning stream,
  assert that the canonical message and the Copy source keep every append. The
  visible preview intentionally contains only its bounded tail. Then verify that
  the complete value survives finalization.
- **Settle Whiteboard through the production terminal path.** Calling the
  storage helper directly does not prove that refusal, timeout, Stop, and
  provider errors reach it. Delay one real model mutation across each terminal
  boundary and verify both the durable board and the repaired tool result.
- **Instrument the admission boundary on both sides of handoff.** Count the chat
  admission owner and its provisional or committed state, stream marker,
  registered session, placeholder, and journal before and after each injected
  failure. UI state alone cannot prove that capacity was released.
- **Drive a real multi-response tool turn for footer evidence.** A synthetic
  sum does not prove that the orchestrator adds the initial and subsequent
  provider responses once, preserves partial coverage, or persists the
  assistant-turn scope.
- **Compare TokenMeter to the serialized next request.** Use the same completed
  conversation with Tool History on and off, and verify carrier-by-carrier that
  the meter and adapter consume one projection. Do not use previous turn usage
  as a proxy for next-request occupancy.
- **Keep correctness and cost evidence separate.** A04 proves that live deltas
  reconcile to the right terminal carrier exactly once. A06 measures whether
  the bounded overlay remains responsive under long and concurrent streams.

## Known-load-bearing context

Read this before you start, so you do not derive it again:

- [`streaming.md`](../../streaming.md) holds the pipeline, the adapters, the
  timeout architecture, and the adapter constraints proven against live
  endpoints.
- [`reasoning-and-token-accounting.md`](../../reasoning-and-token-accounting.md)
  owns the four-ledger distinction, next-request projection, live overlay, and
  terminal reconciliation rules. A04 tests their lifecycle; A03 owns provider
  semantics and A06 owns their cost.
- The reasoning preview is a derived projection, not the message owner. Its live
  window can omit settled prefix text for responsiveness. Persistence, provider
  replay, export, and Copy continue to use the complete canonical reasoning
  value. See
  [`architecture.md`](../../architecture.md#long-reasoning-streaming-is-bounded).
- Stop must release the native relay (`abort_tool_calls`) as well as the JS
  reader. A stream that cancels only one side leaks.
- [`architecture.md`](../../architecture.md) owns the capacity-two default,
  hard maximum of three, provisional and committed admission states,
  exact-owner handoff, immutable execution snapshot boundary, and
  application-owned exit model.
