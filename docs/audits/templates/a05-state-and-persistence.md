# A05 — State and persistence

**Template code:** `A05` · **Version:** 1.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A05 v1.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

**Siblings:** [`a04-streaming-and-turn-lifecycle.md`](./a04-streaming-and-turn-lifecycle.md)
(what produces the state), [`a12-privacy-and-redaction.md`](./a12-privacy-and-redaction.md)
(what may leave the machine).

---

## Scope

**In.** `store/db.ts` and the Dexie schema, `store/conversations.ts`, archive
export and import, settings export and import, clone, crash recovery, the blob
store for attachments, every localStorage-backed store, and the reconstruction
of model-maintained to-do snapshots and interactive tool results from canonical
assistant-call and tool-result pairs.
It includes immutable Whiteboard versions, pending and provisional working
rows, turn references, branch truncation, normal-load crash recovery, the
mandatory conversation-archive `whiteboard.json` carrier, and the separate
two-document Whiteboard package import. It includes the generation journal,
per-conversation persistence lanes, transcript revisions, generation fences,
terminal barriers, delete tombstones, conversation residency, and ephemeral
per-conversation UI state and attachment ownership.

**Out.** What the provider returned, carrier classification, and replay
eligibility (`a03-protocol-adapters.md`). Redaction rules
(`a12-privacy-and-redaction.md`). A05 proves that the canonical carrier and its
response-bound accounting survive; it does not decide what they mean.

## Invariants

1. **Round trip is lossless.** Export followed by import reproduces message
   order, tool pairing, usage and cache fields, line-change metadata, reasoning,
   and attachments. A field added later imports as absent, not as zero.
2. **Archive versions fail or round-trip explicitly.** An optional field absent
   within a supported archive version imports as absent. An unsupported newer
   version fails loudly instead of dropping data. Conversation archive v1
   requires `whiteboard.json`; a non-v1 input receives the specific unsupported-
   version error and is not misreported as an unrelated ZIP.
3. **`sortOrder` holds one value domain.** Sequential counters and timestamp
   fallbacks must never mix in the same indexed column. See
   [`data-model.md`](../../data-model.md).
4. **Identity is stable.** Clone, import, and recovery never collide message ids
   or conversation ids. They also never reassign an id silently.
5. **Recovery changes only documented incomplete state.** Safe Start never
   deletes or rewrites conversations, messages, attachments, Whiteboard rows,
   settings, profiles, keys, grants, skills, or workspace files. Normal lazy
   conversation loading can settle one orphaned provisional Whiteboard row and
   repair its owning assistant call/result from the durable mutation receipt.
   That operation is idempotent and does not replay the tool. See
   [standing constraint 3](../../README.md#standing-product-constraints).
6. **Durable application-state writes are observable.** Each mutation uses its
   durable write boundary and emits one closed-code diagnostic. This includes
   Dexie, attachment blobs, localStorage, and desktop key-store mutations. The
   diagnostic ring does not observe its own persistence.
7. **Transient work and artifacts are bounded.** Every transient scan, buffer,
   string, and serialized artifact has an explicit cap. Retained Whiteboard
   history is durable conversation data, not a cache: it has no automatic count
   cap or pruning in this iteration and grows linearly. Each retained document
   is capped at 32 KiB, and existing conversation-archive limits remain the
   outer serialized bound. See constraint 8.
8. **Derived tool state never replaces canonical history.** To-do views and
   request projections are rebuilt from successful stored call/result pairs.
   Repeated states of one list may collapse in a derived view, but distinct
   lists, modified tasks, original calls, and original results remain available
   to archive and Tool History consumers. Ask-user answers and skips remain
   ordinary paired tool results.
9. **Persisted result framing is exact and bounded.** Recognized `[LC]`
   orchestration notices survive Dexie, archive, clone, recovery, request
   replay, and Tool History as ordinary result content. Derived consumers
   accept only the known bounded prefixes. An unknown prefix cannot expose a
   hidden JSON object as a valid result.
10. **Transient image-delivery identity is not conversation data.** LC can use
    `_image_batch_id` and `images_delivered` while it assembles the current
    request. It removes both before persistence, including when one or more
    orchestration notices precede the image-result JSON.
11. **Retained Whiteboard rows are immutable and ordered by evidence.** Their
    composite conversation/version key is inserted with `add`, never replaced
    on collision. ID minting, collision retry, and monotonic conversation
    sequence allocation share one transaction. History uses the sequence, not
    the owner-prefixed timestamp string or wall-clock order.
12. **Whiteboard references and rows move atomically.** Initialization creates
    both baselines together. Send promotion, model settlement, Retry,
    Edit-and-resend, clone, archive import, and deletion cannot leave a message
    reference without its retained row. Truncation deletes only discarded-
    branch versions that no surviving message, current head, or baseline needs.
13. **Whiteboard package import replaces no existing work.** Eligibility and
    complete filename, ZIP, size, entry, and UTF-8 validation precede one
    transaction that adds fresh user and model versions. A failure writes
    neither owner and preserves baselines and working rows.
14. **Persistence is ordered per conversation, not globally.** Checkpoints may
    coalesce within one generation, but writes for different conversations do
    not share a mutable latest value. Transcript revision and generation
    fences reject stale work from an earlier branch or owner.
15. **Terminal barriers close the lane.** Finalization drains or supersedes
    queued checkpoints before the generation journal retires. Retry,
    Edit-and-resend, import, and branch truncation cannot be overwritten by a
    terminal flush that was queued against the discarded transcript.
16. **Deletion is a tombstone, not a timing assumption.** Once deletion is
    admitted, queued or late writes cannot recreate messages, attachments,
    Whiteboard rows, or a generation journal for that conversation. A later
    explicit import can reopen the lane deliberately.
17. **Generation recovery is journal-discovered and idempotent.** Startup finds
    interrupted owners without loading every transcript, marks only their
    incomplete assistant state, retires each journal row, and can repeat safely.
    Clone and export never copy a live journal. Conversation deletion and
    clear-all include it transactionally. Databases that passed through the
    pre-release v2 schema reopen through the additive v3 repair.
18. **UI snapshots preserve ownership without becoming durable chat data.**
    Drafts, staged attachments, edit state, scroll/follow state, Workspace,
    side-panel, and preview state follow their conversation while navigating.
    Drafts remain restart-ephemeral. Removing or replacing staged attachments
    releases only blobs owned by that conversation and edit submission.

## Check matrix

| Axis | Required variations |
|---|---|
| Round trip | Fresh conversation, with tools, with attachments, with reasoning, with very long reasoning captured while the live preview is windowed, with cache usage, with prefix conclusions, with recognized repeat, duplicate, contention, and round-limit result notices, with submitted and skipped ask-user answers, with several same-turn to-do snapshots, and with retained Whiteboard versions and turn references in the mandatory `whiteboard.json` carrier |
| Legacy input | An optional field absent from the supported v1 archive, an archive with unknown extra fields, an unsupported non-v1 version, and a truncated or corrupt archive |
| Clone | Empty, during a conversation, during generation, with attachments, and with Whiteboard references. Copy only referenced retained versions, remap source message IDs, and copy no pending or provisional row |
| Crash recovery | Interrupted tool round, interrupted stream, more than three simultaneous journal rows, Whiteboard receipt applied and not applied, missing owning assistant message, repeated startup and conversation load, v1 open, pre-release v2 to v3 repair, storage open failure, and quota exhaustion |
| Scale | A conversation large enough to exercise the lazy-load path and the split between meta and messages |
| Storage backends | Dexie, localStorage stores, the blob store, the desktop key store |
| Concurrency | Two writers to one conversation, independent writers to three conversations, checkpoint coalescing, a terminal barrier during a queued checkpoint, a stale generation after replacement, a write during export, and unrelated-chat writes during a target-scoped mutation |
| Destructive races | Delete during checkpoint and final flush; Retry and Edit-and-resend while a terminal flush is queued; import after a tombstone; clear-all with several journal rows; and a failed deletion transaction. No discarded row may reappear |
| Conversation UI ownership | Drafts and attachments in three chats, edit submission during navigation, independent scroll/follow positions, Workspace and side-panel state, pinned and unpinned preview state, capacity refusal, attachment removal, conversation deletion, and reload. Navigation restores in-session state; restart does not persist drafts |
| Derived tool state | One to-do list updated several times, a forward-growing list with inserted tasks and renumbered later IDs, a shorter nested list that remains separate, two distinct lists in one turn, zero and several in-progress tasks, completion evidence present and absent, a task title changed midway, an interrupted final update, an archived source call, and a complete list that needs no next-turn projection |
| Result framing | Plain JSON, each recognized notice, several stacked notices, the 256-notice boundary, a 64 KiB stored result boundary, an unknown `[LC]` prefix, and malformed JSON. Canonical content round-trips while derived decoders fail closed |
| Image-result persistence | An ordinary image result and a repeated prefixed image result, each before and after persistence. The stored form keeps public fields and notices but omits transient batch identity |
| Whiteboard version engine | Idempotent two-owner initialization; same-millisecond collision; existing-key collision; clock rollback; per-conversation sequence; unchanged send; changed send; several model mutations in one turn; terminal settlement; and one 32 KiB document. Existing rows must never change |
| Whiteboard branch boundaries | Retry and Edit-and-resend with changed user and model versions, surviving references, pending promotion and reuse, an active discarded provisional row, awaited truncation before append/streaming, and a forced transactional failure |
| Whiteboard package import | Eligible empty baselines; each ineligibility reason; one or both non-empty documents; malformed filename; malformed ZIP; duplicate, nested, missing, and extra entries; output and UTF-8 failures; fresh IDs; and a forced failure after validation. Success adds both owners once; failure adds neither |

## Domain-specific evidence rules

- **A persistence claim needs the real mapping and a real IndexedDB round
  trip.** A hand-built row is not evidence. `messageToRow` and `rowToMessage`
  are where fields go missing, and a fixture that skips them proves nothing.
- **Force the quota and corruption paths.** Do not reason about them.
- **Delay real lane writes around every structural boundary.** Hold a
  checkpoint or terminal flush, then Retry, Edit, delete, import, or replace the
  transcript through production code. Inspect revisions, tombstones, journal,
  messages, and blobs after every promise drains.
- **Inspect canonical rows and the derived view separately.** A correct latest
  to-do view does not prove that earlier call/result pairs survived. A complete
  archive does not prove that the UI reconstructed the latest state of each
  same-turn list.
- **Inspect a notice-bearing image result before and after persistence.** A
  plain-image fixture does not exercise the parser boundary that strips
  transient fields. Verify both the stored bytes and the next provider request.
- **Force Whiteboard atomic failures at the coupled write.** A passing helper
  test does not prove message/reference integrity. Fail after preparing a new
  retained row but before the transaction completes for send, settlement,
  truncation, clone, conversation-archive import, and Whiteboard-package import.
  Inspect messages, current heads, retained rows, and working rows afterwards.
- **Order history by the stored sequence.** Use a controlled clock with a
  rollback and collision. A lexically sorted fixture can pass for months before
  the calendar or clock exposes that IDs are not the ordering key.
- **Recover from the journal without preloading every conversation.** Evidence
  that starts by hydrating all transcripts bypasses the discovery contract.
  Seed several journal owners, reopen the database, and inspect both recovered
  transcripts and retired rows after a second recovery pass.

## Known-load-bearing context

- [`data-model.md`](../../data-model.md) holds the schema, the storage layout,
  and the `sortOrder` value-domain invariant.
- Conversation archives retain LC's *normalized* result, not the provider
  envelope. An archive cannot tell you which raw provider alias produced a
  counter. See [`cache-observability.md`](../../cache-observability.md).
- Live and completed-reasoning windowing are render projections only. Reopening
  a completed turn starts from the bounded window again; the complete canonical
  field must still survive the Dexie mapping, crash recovery, export, import,
  and clone. See
  [`architecture.md`](../../architecture.md#long-reasoning-streaming-is-bounded).
- [`data-model.md`](../../data-model.md) owns generation journal schema,
  persistence-lane ordering, transcript revisions, tombstones, and the boundary
  between restart-ephemeral UI state and durable conversation data.
