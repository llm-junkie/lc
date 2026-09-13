# A07 — Memory and lifetimes

**Template code:** `A07` · **Version:** 1.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A07 v1.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

**Sibling:** [`a06-cpu-and-responsiveness.md`](./a06-cpu-and-responsiveness.md).

---

## Scope

**In.** Every listener, subscription, timer, abort controller, cache, buffer,
and object URL, on both sides of the IPC boundary. The Rust stream relay and its
native event listeners. Attachment blobs. The model cache and the token-count
cache. Reasoning chunk state, preview DOM, and other derived render caches. It
includes ask-user pending resolvers and abort listeners, and the maps used to
derive same-turn to-do snapshots. It includes the Whiteboard overlay's rendered
Markdown and storage subscription, live/pending projections, package export
Blob, and bounded streaming ZIP-import buffers.
It includes generation sessions, chat admissions in both provisional and
committed states, interaction and mutation waiters, conversation residency/UI
snapshots, the shared model-detail single-flight cache, generation-scoped image
mappings and batches, and bounded recent-request diagnostics.

**Out.** Per-frame cost (sibling). Bundle size
([`a08-build-and-runtime-parity.md`](./a08-build-and-runtime-parity.md)).

## Invariants

1. **Every acquisition has a release on every path.** This includes the failure
   path and the abort path. Terminal paths are where leaks live.
2. **One owner per resource.** Transfer ownership deliberately, or release it.
   Never do both, and never do neither.
3. **Every cache is bounded and evicts.** An LRU with no cap is a leak with
   extra steps. Retained Whiteboard history is durable user data, not a cache;
   it deliberately has no automatic count cap or eviction. Measure that linear
   storage separately from heap retention.
4. **Transient streaming state is bounded independently of canonical text.** A
   message can legitimately accumulate a very large reasoning field. Transport
   queues, preview DOM, token samples, chunk caches, and other derived state
   must not duplicate its full growing prefix, and must not retain superseded
   versions. The queue memory budget exists because an earlier change violated
   this distinction.
5. **Object URLs and blobs are revoked** when their component unmounts, or when
   their attachment is removed.
6. **The native relay is torn down with the JS reader.** Cancelling one side
   leaves the other running.
7. **Nothing retains a whole conversation** to render one message.
8. **Large render trees have an explicit lifetime.** Closing a
   completed-reasoning preview releases its Markdown DOM and chunk state, and so
   does switching away from it. Repeated open and close cycles do not retain one
   tree per visit.
9. **Whiteboard projections have one mounted lifetime.** Closing the overlay or
   switching conversations releases its storage subscription, rendered
   Markdown trees, local unsaved editor value, historical selections, scroll
   measurements, confirmation state, and package Blob. A live model update does
   not retain one snapshot or Markdown tree per mutation.
10. **Whiteboard package buffers obey byte bounds.** Desktop metadata rejects
    input above the caller limit and the 128 KiB native ceiling before opening,
    and the limited reader consumes at most that limit plus one proof byte.
    Import retains at most 32 KiB per entry and 64 KiB combined actual output,
    stops feeding compressed chunks after failure, and releases partial chunks
    after settlement when no component reference remains.
11. **Generation cleanup is exact-owner cleanup.** Ending one of several live
    chats releases only its session, timers, waiters, image mappings, image
    batches, phase state, and diagnostics. It cannot globally clear resources a
    sibling still needs, and a stale cleanup cannot release a successor.
12. **Conversation residency is bounded and truthful.** Active generations,
    dirty UI state, and incomplete loads stay resident. Complete inactive
    transcripts can be evicted. An incomplete or failed load is never treated
    as authoritative merely to satisfy a resident-count target.
13. **Shared work releases by waiter count.** Concurrent model-detail captures
    may share one in-flight lookup. Cancelling one waiter leaves the lookup
    alive for siblings; cancelling the final waiter aborts it. Successful cache
    entries obey TTL and count bounds; failures are not retained.
14. **Interaction queues retain no settled presentation.** Queued and visible
    permission/Ask User entries release abort listeners, attention timers,
    modal state, and answer closures after delivery, cancellation, ownership
    loss, host teardown, or attention expiry.
15. **Ephemeral UI ownership has a terminal release.** Conversation deletion,
    attachment removal, edit replacement, and app teardown release staged blobs,
    object URLs, drafts, preview state, and scroll/workspace snapshots owned by
    the addressed chat without clearing siblings.

## Check matrix

| Axis | Required variations |
|---|---|
| Lifecycle | Mount and unmount cycles, conversation switching, window close during generation, reload during a tool round |
| Terminal paths | Natural finish, abort, error, disconnect, timeout. Each must release everything |
| Repetition | The same action 50 to 100 times. Measure retained heap between runs, not once |
| Attachments | Add, preview, remove, and switch away, using large images |
| Long session | A long-running session with many conversations and streams. This shape surfaced the dev-mode leak |
| Three-chat soak | Thirty minutes with three simultaneous conversations, repeated tool rounds and maximum-size image batches. Sample forced-GC start/end heap, resident conversation count, image-cache batches and bytes, request-ring size, session/waiter counts, and Dexie write-latency percentiles |
| Very long reasoning | A 256 KiB live fixture, the real completed fields of about 549K and about 895K, the live window, the completed reopen, and 50 open-close and conversation-switch cycles |
| Interactive and task state | Permission and Ask User queued across three chats; submit, skip, abort while queued, abort while visible, attention expiry, host unmount, ownership replacement, and conversation switch; repeated preview open-close cycles with several to-do lists and repeated list updates |
| Image delivery cache | First delivery, the same batch across many tool rounds, two generations reusing one tool-call ID, a repeated image call that creates a second batch, per-generation floors, global admission pressure, cache eviction, non-vision blocking, middle-generation abort, owner cleanup, and loop teardown. Each batch delivers once and every transient entry is released or evicted |
| Conversation residency and UI state | Navigate repeatedly among three active chats, several complete chats, a failed/incomplete load, drafts with large attachments, edit state, independent scroll positions, Workspace/side-panel state, and pinned preview state. Record resident transcripts, staged blobs, object URLs, subscriptions, and snapshots after eviction and deletion |
| Shared model-detail lookup | Two and three simultaneous waiters, one waiter abort, final waiter abort, success reuse within TTL, expiry, failure and retry, cache clear during configuration change, and the 32-entry bound |
| Whiteboard overlay | Fifty open-close cycles with two maximum-size documents, edit and cancel, edit and save, independent history navigation, live model updates while anchored and unanchored, a discard confirmation, conversation switching, and parent unmount |
| Whiteboard package | Fifty exports and imports at the compressed, per-entry, and combined bounds; malformed compression; duplicate entries; an early entry failure; picker cancellation; and overlay unmount during async work. Revoke or release every Blob, input, callback, and chunk array |
| Retained Whiteboard scale | Increasing retained-version counts with the overlay closed and open. Separate expected IndexedDB growth from heap, DOM, snapshot, and decompressed-string retention |
| Build | Dev and packaged. The dev server's HMR retains objects that packaged builds do not. Do not report dev-only retention as a product leak without saying so |

## Domain-specific evidence rules

- **A leak claim needs two heap measurements and a forced GC between them.** A
  single snapshot is not evidence.
- **Repeat the cycle.** One mount and unmount proves nothing. Retention that
  grows across 50 cycles does.
- **Run the concurrency soak, not three sequential sessions.** The relevant
  leaks are shared waiters, owner-specific cleanup, resident transcript pins,
  image-cache fairness, and overlapping Dexie work. Sequential runs do not
  exercise them.
- **Separate dev-only retention from product leaks explicitly.** The earlier
  memory finding was specific to dev mode. Say so whenever the evidence is.
- **Separate canonical bytes, derived state, and DOM.** Measure each one before
  and after a very long stream, and again after closing the preview. A bounded
  live DOM does not prove the complete source was lost. A released DOM does not
  prove the canonical message was freed.
- **A settled interaction has no live resolver.** After every ask-user exit,
  verify that its resolver, abort listener, focus-restoration target, and draft
  answers are released. Repeat the cycle; one successful close proves little.
- **Do not call retained Whiteboard history a leak.** It grows linearly by
  contract and is not silently pruned. A memory finding needs evidence that
  closing the overlay or releasing a package still leaves derived heap, DOM,
  Blob, callback, or decompression state reachable beyond that durable data.
- **Measure owner counts beside bytes.** A flat heap can conceal a session,
  timer, waiter, resident transcript, or image batch that will grow on the next
  cycle. Record both retained bytes and bounded registry counts.

## Known-load-bearing context

- [`streaming.md`](../../streaming.md) holds the queue memory budget, the
  timeout architecture, and abort and cancellation.
- The live reasoning preview and the initial view of completed reasoning are
  deliberately windowed. Repeated explicit expansion can still create a large
  full-Markdown DOM on demand. A07 owns whether that DOM and its chunk state are
  released. A06 owns how long creating it blocks the main thread. The shared
  contract is
  [`architecture.md`](../../architecture.md#long-reasoning-streaming-is-bounded).
- The prefix-diagnostics HMAC key is deliberately non-extractable and
  session-scoped, and LC never persists it. Do not "fix" its lifetime. See
  [`cache-observability.md`](../../cache-observability.md).
