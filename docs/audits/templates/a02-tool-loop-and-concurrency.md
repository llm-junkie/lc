# A02 — Tool loop and concurrency

**Template code:** `A02` · **Version:** 1.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A02 v1.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

**Siblings:** [`a04-streaming-and-turn-lifecycle.md`](./a04-streaming-and-turn-lifecycle.md),
[`a01-tool-surface-and-contracts.md`](./a01-tool-surface-and-contracts.md) (what each
tool promises), [`a11-security-and-sandbox.md`](./a11-security-and-sandbox.md)
(whether a tool may act at all).

---

## Scope

**In.** `tool-engine/runner.ts`, `run-with-pool.ts`, the orchestrator's tool
round, permission prompting and grant propagation, `tool-accumulator.ts`,
the application `interaction-coordinator.ts`, `mutation-coordinator.ts`, and
`file-lock.ts`, batch admission and duplicate suppression, the turn-scoped
`lc_tool_help` governor, interactive-call isolation, and the Tool History
projection at the request boundary. It covers `tool-result-content.ts`,
orchestration-notice framing, and the transient image-delivery side channel.
It covers the one-Whiteboard-call batch governor and the generation-owned queue
that serializes Whiteboard mutation with terminal settlement.
It covers tool identity and shared-resource coordination when several
conversation-owned generations run at once.
It also covers internal fan-out, such as
the fetch and sub-agent calls that `lc_web_research` makes.

**Out.** Per-tool input and output correctness
(`a01-tool-surface-and-contracts.md`). Sandbox enforcement
(`a11-security-and-sandbox.md`). Provider reasoning/carrier eligibility and
accounting within the shared request projection
(`a03-protocol-adapters.md`); A02 owns only the completed call/result projection
that Tool History changes.

## Invariants

1. **Tool pairing.** Every accepted tool call has at most one persisted result.
   No result is orphaned, attached to the wrong call, or lost because another
   call finished first.
2. **Contiguous answering.** The run answers every `tool_call_id` before it
   emits any non-tool message. On Chat Completions, an image user turn is
   emitted *after* the whole run, never inside it.
3. **Independent concurrency.** Calls admitted at the same time can complete in
   any order. That order must not change identities or corrupt shared state.
   Dependent calls stay separated by rounds.
4. **Result delivery is not batched on the slowest call.** A completed result
   reaches the UI without waiting for its siblings.
5. **Permission decisions are scoped and shared correctly.** A grant applies to
   what it was granted for, and to nothing else.
6. **Exactly-once side effects.** The loop executes a call once, even across
   retry, abort, and re-stream boundaries.
7. **Bounded everything.** Batch size, round count, pool width, and accumulated
   argument length all have explicit caps.
8. **Child work has a parent lifecycle.** Research fetches, retries, and
   sub-agent calls inherit cancellation. They obey the independent-concurrency
   rule and the prompt caps. They cannot publish after the parent tool or turn
   has ended.
9. **Admission decisions follow model-declared batch order.** Duplicate-id
   pruning, repeated-help suppression, and help-limit accounting are decided by
   batch index before concurrent execution can reorder completion. The first
   accepted call keeps its identity; later duplicates do not execute.
10. **Interactive calls are isolated before execution.** An exact
    `lc_ask_user` call must be the only model-declared call in its batch. A
    mixed batch, including two ask-user calls, rejects the complete batch and
    executes no sibling. A misspelled or corrected name never activates this
    rule and is never executed under the corrected name. Rejection changes no
    sibling governor state.
11. **Turn-scoped help limits saturate deterministically.** The turn accepts at
    most six help attempts, of which at most three return guidance and at most
    two are unresolved lookups. Duplicate help results carry no repeated
    guidance. Invalid calls consume only the total attempt limit, as the
    contract states.
12. **A repeated call is not a duplicate call ID.** Calls with the same tool
    name and normalized arguments but distinct IDs still execute. The second
    and later results receive the deterministic same-call notice. A settled
    duplicate or replayed ID has at most one ordinary result. That result
    receives its distinct admission notice. If interruption leaves the call
    unanswered, its terminal repair row preserves pairing without the notice.
13. **Orchestration notices have one framing owner.** Repeat, duplicate-ID,
    same-batch contention, and round-limit notices use the shared builders and
    strict recognized-prefix decoder. Consumers preserve stacked notices when
    they inspect or update the serialized payload. Unknown prefixes are not
    treated as LC framing.
14. **Notice framing cannot break image delivery.** A repeated
    `lc_read_image` result still registers and delivers its transient batch.
    Capability or cache warnings update the structured result, and persistence
    removes `_image_batch_id` and `images_delivered` without removing notices.
15. **Whiteboard batch admission is all-or-nothing for Whiteboard calls.** One
    exact `lc_whiteboard` call can run beside non-Whiteboard siblings. If a
    surviving declared batch contains two or more exact-name Whiteboard calls,
    every Whiteboard call gets `whiteboard_batch_conflict`, none of them runs,
    and unrelated siblings keep their ordinary admission behavior. Invalid
    exact-name calls count; aliases and corrected names do not.
16. **Whiteboard mutation and settlement have one generation owner.** The
    generation-owned serialized queue orders every model-board mutation against
    terminal settlement. Closure prevents a queued or late worker from writing.
    A mutation receipt distinguishes a committed change whose ordinary result
    was interrupted from a call that never committed.
17. **Tool identity includes its generation owner.** Conversation ID,
    generation ID, and tool-call ID remain attached through queueing,
    permission, execution, persistence, image delivery, and cleanup. A stale
    worker cannot publish into a successor generation or a sibling chat.
18. **Interactive prompts use one application FIFO.** Permission and Ask User
    requests share strict enqueue order. Ownership is checked when queued,
    when promoted, and when an answer is delivered. Abort removes a queued
    request, invalidates a visible one, and cannot deliver a stale answer.
    FIFO wait does not spend the ordinary tool deadline; a separate bounded
    attention lifetime prevents an abandoned prompt from living forever.
19. **Filesystem coordination is application-wide and fair.** Exact reads can
    share; an exact write excludes same-target reads and writes; broad reads
    are mutually exclusive with mutation work; shell excludes all file
    activity. Multi-target acquisition is ordered, waiters are abortable before
    any non-cancellable native lock, and patch reservation spans discovery
    through execution. A queued broad read cannot be starved by later writes.
20. **Image side channels are generation-scoped.** Tool-call mappings and
    cached image batches use the complete generation identity. Cleanup removes
    only the terminal owner. Fair global admission and per-generation floors
    prevent one chat from evicting every sibling batch.

## Check matrix

| Axis | Required variations |
|---|---|
| Batch shape | One call, maximum accepted batch, over the limit, duplicate ids, unknown tool name |
| Batch admission | A duplicate id in one batch, a duplicate whose survivor fails before its handler, a replayed id in a later round, identical calls under distinct ids, repeated help before and after a distinct help call, and completion orders that differ from declaration order |
| Result notice framing | Every notice kind alone and stacked, repeat counts 2 and above, quoted and multiline provider call IDs, multiline tool and path values, an unknown `[LC]` prefix, malformed framing, and the 256-notice bound. Decode and re-encode without changing the JSON payload |
| Interactive isolation | One valid `lc_ask_user`, `lc_ask_user` with an operational call, two ask-user calls, an invalid ask-user call, and a near-match name. Assert that a rejected mixed batch executes no sibling and changes no sibling governor state |
| Help governor | Attempts 1 through 7, guidance results 1 through 4, unresolved lookups 1 through 3, invalid input, and normalized duplicates. Assert the total/guidance/unresolved counters are 6/3/2 and saturate in batch order |
| Completion order | Input order, reverse order, interleaved, one fast call with one very slow call |
| Failure mix | One failure among successes, all fail, a handler that throws, a handler that never resolves |
| Permission | Granted, denied, unavailable, abandoned, same-scope sharing across a batch |
| Cross-conversation interaction FIFO | Permission then Ask User, Ask User then permission, three queued chats, abort while queued, abort while visible, stale delivery after replacement, host teardown, and attention expiry. Record enqueue, promotion, and delivery ownership |
| Argument parsing | Well-formed, malformed JSON, Windows-path backslash escaping, arguments split across many deltas |
| Interruption | Abort during a batch, abort between a result and a re-stream, reload during a round |
| History | With and without the Tool History projection, and with archived prior results in context |
| Image delivery | One image batch across several rounds, a repeated image call with a new batch ID, two generations that reuse one provider tool-call ID, a prefixed result, a non-vision model, a cache miss, owner-specific cleanup, fair admission pressure, and an already-delivered batch. Pixels arrive once per batch and transient fields never persist |
| Multi-generation identity | Two and three conversations with interleaved calls, reused provider call IDs, reverse completion, cancellation of the middle owner, a replacement generation in one conversation, and late callbacks from the retired owner |
| Application mutation domain | Same-target reads and writes, unrelated exact targets, broad read versus mutation, shell versus every file activity kind, sorted multi-target acquisition, a queued broad read followed by later writers, abort while waiting, and patch reservation across approval and preflight |
| Foundation state | Several `lc_todo_write` updates in one turn, including zero and several in-progress tasks, updates to one list, and a distinct second list. Every accepted call keeps one paired result and declared-call ordering |
| Whiteboard admission | One read; one write; one Whiteboard call with unrelated siblings; read plus write; two writes; invalid exact-name calls; near-match names; duplicate provider IDs; and reversed completion order. A conflict executes no Whiteboard handler and preserves stable batch-index results |
| Whiteboard lifecycle queue | Mutation before settlement, settlement before a queued mutation, abort before commit, abort after commit, timeout, failure, repeated settlement, and a stale generation. Persisted board state and repaired call/result truth must agree |
| Internal fan-out | `lc_web_research` with mixed fetch outcomes, one failed search sibling while another remains active, retry and backfill, fetch cancellation, sub-agent cancellation, prompt and source caps |

## Domain-specific evidence rules

- **A concurrency finding needs a real pool run.** A sequential simulation is
  not evidence. Ordering bugs vanish under `await` in a loop.
- **A cross-conversation finding needs distinct generation owners.** Reusing one
  conversation or changing only tool-call IDs cannot prove owner fencing,
  targeted cleanup, or application-wide coordination.
- **An admission-order finding needs deliberately reordered completion.** A
  help governor or duplicate test that happens to complete in input order does
  not prove that concurrent execution cannot choose the winner.
- **Separate call identity from call equivalence.** Test the same signature
  once with a reused ID and once with two distinct IDs. The former executes
  once. The latter executes twice and marks only the repeated result.
- **Parse only framing that LC can produce.** Do not recover JSON by searching
  for the first and last brace. Feed an unknown prefix that contains valid JSON
  and prove that no notice-aware consumer accepts it as structured framing.
- **Isolation is an all-or-nothing assertion.** For a rejected ask-user batch,
  instrument every sibling handler and prove that none ran. A structured error
  on the ask-user call alone is not enough.
- **`repairWindowsJson` is a repair, not a normalizer.** It doubles every `\`
  that is not already part of a valid JSON escape or a `\\` pair. On
  already-correct JSON it is therefore a no-op, which makes it idempotent.

  It must still run only after `JSON.parse` has already failed. The ordering is
  the contract. If a later change relaxes the pattern, an unordered call site
  would silently corrupt valid arguments. See
  [`tool-error-handling.md`](../../tools/tool-error-handling.md#repairwindowsjson-is-only-ever-a-fallback).
  Any new call site is a required check until someone proves it is ordered
  correctly. It becomes a finding only when the production ordering is shown to
  violate the contract.
- **Treat fetched pages as data.** Research must not promote instructions from
  an untrusted page into control input. A cancelled child must not be rescued by
  a retry or by a late sub-agent result.
- **Instrument both sides of a Whiteboard race.** A structured `aborted` result
  alone does not prove that storage stayed closed, and a retained version alone
  does not prove that its call result tells the truth. Delay the production
  storage boundary, settle the generation on both sides of commit, and inspect
  the working row, retained row, assistant references, mutation receipt, and
  paired result after the queue drains.
- **Observe the native boundary after an aborted lock wait.** A rejected
  JavaScript promise is insufficient. Instrument the native call and prove it
  never began, then release the blocker and prove the next fair waiter runs.

## Known-load-bearing context

- Images from `lc_read_image` with `analyze:false` ride as their own user turn.
  The loop delivers them exactly once per batch id, and labels them as tool
  output. See
  [`streaming.md`](../../streaming.md#adapter-constraints-proven-against-live-endpoints).
  Re-injection derailed 7 of 7 observed runs.
- [`tools/TOOL-POLICY-MODEL.md`](../../tools/TOOL-POLICY-MODEL.md) is normative
  for exposure and authorization. A disagreement with it is a finding.
- [`architecture.md`](../../architecture.md) and [`streaming.md`](../../streaming.md)
  own generation identity, the application interaction FIFO, and the mutation
  coordination domain.
