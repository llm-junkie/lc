# Concurrent conversations

This document is the durable product and engineering contract for running model
responses in more than one conversation. It describes the implemented state,
not a rollout plan.

## Product behavior

LC keeps one foreground chat pane and can continue response generation in
background conversations. The default admission limit is two concurrent chats.
**Settings → Chat → Concurrent chats** can select one, two, or three.
The hard application maximum is three.

Changing the setting does not cancel work that already owns a slot. Lowering
the limit prevents later admission until the number of owners is below the new
limit. If the limit changes while asynchronous preflight is holding a
provisional admission, a final synchronous commit immediately before transcript
mutation rechecks the limit. Refusal retires that admission before it can alter
the user message, branch, assistant placeholder, or generation journal. Once
that commit succeeds, a later settings reduction cannot strand the accepted
work; runtime registration still enforces the hard maximum of three. A
conversation can own at most one admission or running generation.

At capacity, an additional conversation keeps an editable draft and staged
attachments. Only Send is disabled, with the exact admission reason. It becomes
available again without clearing the draft when a slot opens.

Switching conversations and creating a new chat never cancel background work.
An idle conversation can be drafted and changed while a sibling runs. Rename,
Archive, Delete, Clone, Export, Retry, and Edit-and-resend use target-specific
guards. LC refuses an action when its target owns incompatible lifecycle work.
Activity in another conversation does not cause this refusal.

## Ownership model

LC does not clone the application, database, or complete Settings state for
each response. It separates ownership into these domains:

| Domain | Lifetime and owner |
|---|---|
| Durable conversation configuration | One stored conversation. Target and application guards control changes. |
| Conversation UI state | Restart-ephemeral state keyed by conversation ID |
| Generation execution state | Immutable snapshot plus adjacent runtime secrets, keyed by conversation and generation |
| Generation recovery journal | Minimal Dexie row keyed by conversation. The row contains ownership only. |
| Application arbitration | Identity-aware interaction, filesystem, shell, and mutation coordinators |

`GenerationExecutionSnapshot` freezes the conversation configuration, model and
profile facts, structured tool exposure, Workspace/system prompt, helper routes,
and execution limits immediately before the durable send boundary. API, search,
and helper credentials remain in adjacent runtime-only state. Later tool rounds
and helper calls do not reread mutable Settings. A permission approved by the
running generation can update only its deletion-fenced authorization overlay.

`ConversationUiState` owns draft text, staged attachment metadata and blob
ownership, edit state, scroll/follow mode, side-panel and Workspace disclosure,
and preview presentation. It is not persisted across application restart. A
bounded LRU retains at most 24 nonresident entries and cannot evict selected or
lifecycle-resident conversations. Sending transfers attachment ownership to the
durable message. Removal, discard, deletion, eligible eviction, and restart
orphan collection release it.

Deletion drains attachment work, retires its UI lifetime token, and clears its
unread terminal projection. LC retains only the 256 most recent callback
tombstones for UI mutations that cannot carry a UI lifetime token. A corpus wipe
clears every tombstone and unread terminal projection.

## Admission and session lifecycle

Send, Retry, and Edit-and-resend follow the same ownership boundary:

1. Reserve a provisional capacity slot synchronously, before any `await`.
2. Resolve credentials, model details, helper routes, and other preflight data.
3. Revalidate the conversation and freeze its execution snapshot.
4. Recheck current application and profile capacity, then commit the exact
   admission before transcript mutation.
5. Write the user-send or branch change, assistant placeholder, and generation
   journal ownership at their durable boundaries.
6. Hand the committed owner to the runtime session without an ownership gap.
7. Address every delta, tool result, phase update, error, cancellation, and
   terminal write by `{ conversationId, generationId, assistantMessageId }`.
8. Settle the terminal persistence barrier and compare-delete the matching
   journal row before releasing the capacity slot.

The process-local generation manager owns one controller, phase, TPS value, and
safe UI projection per running conversation. A stale generation cannot append
to, finalize, cancel, or release a newer owner. Capacity and per-profile limits
are enforced again at the pre-mutation commit. Runtime registration retains the
hard maximum of three for already committed work. The per-profile limiter has
no limit inside the application cap. An external provider may still execute,
queue, or reject simultaneous requests.

Stop is targeted to one conversation. Navigating away or unmounting its
`ChatView` does not abort it. On `pagehide` or `beforeunload`, an
application-owned handler snapshots every live session. The handler aborts and
terminalizes each owner. Journal-based recovery handles durable writes that
IndexedDB cannot finish during a hard exit.

## Foreground and Sidebar state

Only the selected conversation mounts a `ChatView`. LC does not retain hidden
chat component trees. Resident transcripts include the selected conversation
and every conversation with admission, generation, load, branch, deletion, or
terminal persistence work in flight. Only complete, clean, nonresident
transcripts are eligible for eviction.

Sidebar rows and the selected `ChatView` use conversation-scoped generation
subscriptions. TPS or phase changes do not notify unrelated row or transcript
subscribers. Application aggregates still subscribe to all sessions. A running
row reports thinking, writing, tool use, permission or user attention,
stopping, final response persistence, and failure. Stop is disabled once the
provider turn is terminal and only persistence remains. Background completion,
generation failure, persistence failure, and interaction attention remain
attributed to the owning conversation until viewed.

If the terminal storage write fails, that row's status control retries the
write. It does not run a second abort against the completed response.

The status indicator and idle 2-by-2 action grid share one fixed-width row
slot, so status never overlaps the title or metadata. Timestamp and model
metadata remain on one line. Completion replaces the live indicator in the
same slot. An idle sibling retains Rename, Archive, Clone, and Export while
another row generates.

When the Sidebar is collapsed on Inbox, its compact Inbox/Archive switch displays
the active-bubble border animation only when a background conversation is
generating. The ring is 1.5 px. It is absent when
only the foreground chat is active, when no background chat is active, and
while the Archive list is selected.

## Interaction ownership

Permission and `lc_ask_user` prompts from every conversation share one strict
FIFO application queue. Each entry carries conversation, generation,
assistant, and tool-call identity. Ownership is checked before enqueue, when
the entry becomes visible, and immediately before its result is delivered.
Cancelling or replacing a generation removes its queued prompt and prevents a
late visible answer from reaching the replacement.

Time spent queued behind another visible prompt is excluded from the owning
tool's operational deadline. For permission prompts, time after that prompt
becomes visible still counts. `lc_ask_user` has no ordinary operational
deadline while the user decides, but every queued or visible interaction has a
separate 30-minute absolute attention cap. The single React modal host is only
a presentation surface. A five-second host-registration bound and the retained
`ask_user_ui_busy` result are defensive fail-closed fallbacks, not the normal
concurrent-conversation scheduling path.

## Shared tools and resources

Every generation keeps independent tool-loop identity, but operations with
application-wide side effects share explicit coordinators:

- Filesystem mutations serialize on canonical targets. Broad reads and patch
  reservations use the application mutation coordinator, and every JavaScript
  wait accepts the generation's abort signal before entering a native lock.
- Shell calls serialize application-wide and exclude all file activity because
  a shell command can touch paths that are not declared in its arguments.
- Permission decisions are revalidated against current ownership and grants
  before execution. A queued allow-once result never authorizes a sibling.
- Image delivery mappings and analysis batches are generation-scoped. Bounded
  global admission is fair, and terminal cleanup disposes only the matching
  generation's mappings and cache entries.

  Ordinary image delivery retains at most three batches and 32 MiB per generation.
  Under global pressure, LC removes the oldest batch from an owner with multiple batches.
  If every owner has one batch, LC rejects the newest admission.
  This protects each admitted owner's last batch from competing generations.

  Expiry and that owner's own limits can still remove its last batch.
  A cancelled native image read cannot restore cache entries after terminal cleanup.
  Request assembly matches image results to the owning assistant before using a provider call ID.
  An older turn that reuses that ID cannot receive current images or delivery warnings.
- Model-detail discovery uses a bounded 32-entry, 60-second successful-result
  cache with shared in-flight work. Callers can cancel independently. The
  shared request is aborted only after its final waiter leaves.

See [security.md](./security.md#concurrent-write-serialization) for filesystem
and shell ordering and [streaming.md](./streaming.md) for tool-loop details.

## Persistence and recovery

Concurrent conversations continue to use one Dexie database. All message and
metadata writes pass through a per-conversation persistence lane. Different
conversations can write independently. Streaming checkpoints run every five
seconds and coalesce to the newest pending value. Checkpoint rows keep ordinary
text uncompressed to avoid synchronous compression during generation. Text
that starts with the reserved `Z:` prefix remains encoded. Terminal writes
retain the normal compression policy.

Generation ID, transcript
revision, terminal barriers, and deletion tombstones prevent queued or stale
writes from replacing a branch. They prevent resurrection of a deleted
conversation. They also prevent retirement of another generation's journal row.

The Dexie v3 `generationRuns` journal contains only conversation, generation,
assistant ownership, state, and start time. It never contains prompts, message
content, parameters, paths, endpoints, credentials, or the execution snapshot.
Startup discovers every remaining row without assuming the current capacity,
marks it interrupted, and lets lazy conversation loading perform idempotent
transcript, tool-result, and Whiteboard repair. Unknown tool side effects are
never replayed automatically.

See [data-model.md](./data-model.md#multi-conversation-runtime-and-recovery-state)
for the schema and [troubleshooting.md](./troubleshooting.md#conversation-crash-recovery)
for the user-visible recovery behavior.

## Configuration boundaries

The generating conversation's model, Parameters, Workspace, exposure, and
ordinary execution-affecting controls are locked. Another idle conversation
remains navigable and editable because its later generation will capture a new
snapshot.

Target-scoped guards separately refuse export or structural mutation of a
generating conversation. Application-wide mutations that could invalidate any
live snapshot remain blocked while at least one chat admission or generation
exists. These include profile routing and credentials, model
load/unload/refresh, global Workspace/security configuration, portable settings
or conversation import, reset/migration, and corpus-wide operations. Display
and Appearance remain editable. The Concurrent chats setting remains live so
the owner can lower the next-admission policy without terminating accepted
sessions.

## Diagnostics and privacy

Support reports expose bounded, identity-free concurrency facts: active count,
phase counts, up to 12 recent request projections, and aggregate image-cache
batch, byte, and generation counts. They do not contain conversation IDs,
generation IDs, tool-call IDs, prompts, paths, pixels, endpoints, or secrets.
Reading diagnostics does not allocate or clear runtime caches.

## Release evidence still required

The implementation has automated source coverage, and the packaged build has a
startup smoke result. These environment-dependent observations remain release
gates:

1. A 30-minute three-conversation tool/image soak with forced-GC start/end heap,
   resident-count, image-cache byte, and Dexie write-latency measurements.
2. Three conversations against the same real LM Studio or other local profile,
   recording whether that server executes, queues, or rejects them.
3. A final packaged-UI pass that exercises simultaneous generation, targeted
   cancellation, capacity refusal with draft retention, Sidebar ownership, and
   recovery—not only packaged startup.

The applicable reusable evidence matrices live in audit templates A02, A04,
A05, A06, A07, A08, A09, A10, A12, A14, A15, and A16 under
[`audits/templates/`](./audits/templates/).
