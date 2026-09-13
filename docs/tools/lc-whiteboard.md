# `lc_whiteboard` closed implementation contract

| Field | Value |
|---|---|
| Status | Implemented. Automated gates cover the contract. |
| Updated | 2026-08-27 |
| Scope | Two-owner conversation whiteboard, turn-scoped versions, model tool access, and responsive Markdown UI |

## 1. Outcome

`lc_whiteboard` provides two Markdown boards for one conversation.
The model owns one board, and the user owns the other board.
Both parties can read both boards, but each party can change only its own board.

The feature has these primary surfaces:

- A model tool that reads both boards and changes only the model board.
- A user editor that changes only the user board.
- A conversation-level overlay that renders both boards.
- A retained version history for each board.
- Turn references that identify the board state visible during each model turn.

LC does not automatically inject either board into ordinary messages or system prompts.
The model first reads board content through an explicit `lc_whiteboard` call.
That call and its result then follow the same request-history projection as other tools.

## 2. Settled decisions

These decisions are the implementation contract:

1. The tool name is `lc_whiteboard`.
2. The feature has one model board and one user board per conversation.
3. The model can read both boards and change only the model board.
4. The user can read both boards and change only the user board.
5. Each board contains one bounded Markdown document.
6. The model tool supports read, complete replacement, and exact-text edit operations.
7. The feature has its own Workspace category toggle.
8. Workspace off or Whiteboard off disables the Whiteboard UI and does not expose `lc_whiteboard`.
9. Disabling Whiteboard hides its composer action but preserves every board version and pending value.
10. The tool has `no_prompt` authorization and creates no grant.
11. Board content is not injected into the system prompt or ordinary messages.
12. One explicit tool read returns both board contents.
13. A model turn pins the user-board version that existed when the turn started.
14. User edits made during a model turn are not visible to that turn.
15. A model read returns the latest model-board content from the current turn.
16. The user editor saves one pending copy for the next sent message.
17. A user send retains at most one new user-board version.
18. A model turn retains at most one new model-board version.
19. Successful, failed, interrupted, timed-out, and cut-off model turns retain every model-board change that committed before lifecycle settlement.
20. A turn without a board change creates no new board version.
21. The next model turn starts from the prior turn's latest model-board version.
22. Version history does not classify records as snapshots or drafts.
23. Tool History returns board references instead of historical board Markdown.
24. The version IDs use the owner prefixes `u_` and `m_`.
25. Initial empty user and model versions are created when Whiteboard is first enabled.
26. The overlay shows one full-width board at a time, selected by centered Model and User tabs in the header.
27. The same tabbed layout is used at wide and narrow widths; Model is selected when the overlay opens.
28. The user board uses an explicit Edit action. Clicking rendered Markdown does not start editing.
29. Each owner keeps independent version selection and scroll state while sharing the one board panel.
30. Version controls show retained versions only. They do not show pending editor state.
31. Export requests one ZIP filename in the form `lc-whiteboard-YYYY-MM-DD-HHmm.zip`.
32. The ZIP contains exactly `model.md` and `user.md` at its root.
33. Export captures exactly the two board documents represented by the current Model and User tab selections.
34. Export can capture historical selections, live model content, and unsaved user editor content.
35. Export contains no board history or hidden board content.
36. Import accepts the whiteboard export filename or that filename with a bounded browser collision suffix.
37. Import is available only when both boards are empty and have no retained history beyond their initial baselines.
38. Import creates fresh conversation-scoped versions and imports no source IDs or history.
39. Import is an administrative restoration action and the only user action that can initialize both owners' content.
40. The model tool and exact-edit diagnostic remain TypeScript-only. Desktop package selection uses one narrowly scoped native bounded-file reader so the 128 KiB input cap is enforced before an unbounded UI allocation.
41. LC has not been released. The conversation archive remains its initial version-1 contract and has no compatibility reader. The current conversation database is schema v3; its v1 and v2 migrations preserve Whiteboard rows.
42. The composer opens Whiteboard from the standard action row immediately after Attach, using repository-owned inline SVG geometry rather than a runtime SVG file.
43. The Workspace toggle controls both Whiteboard UI availability and model exposure. Its standard collapsible section also contains an `Open whiteboard` action.
44. When Tool History is off, full whiteboard calls and results remain in provider requests like other tool history.
45. Whiteboard has no special per-turn call or read limit. Existing global tool-round limits still apply.
46. Retry and edit-and-resend remove whiteboard versions that belong only to the discarded transcript branch.
47. Retained versions are immutable rows inserted atomically with collision handling and a monotonic conversation sequence.
48. This iteration does not prune retained versions automatically. Storage growth is linear and declared explicitly.
49. Whiteboard uses a separate conversation overlay and never stacks with the Preview Overlay.
50. During model generation, the Workspace Whiteboard section remains visually active and its disclosure and launch action remain usable, but its exposure toggle stays disabled.
51. Below 600 px of chat-container width, Attach and Whiteboard become circular icon-only actions. Below 470 px, every composer action becomes icon-only.

## 3. Terms

Use these terms consistently in code and documentation:

| Term | Meaning |
|---|---|
| Board | One owner's complete Markdown document. |
| Board version | One retained board document with a stable version ID. |
| Pending user copy | User content saved for the next sent message but not present in user version history. |
| Provisional model copy | The one mutable model record for the active turn. It becomes a retained version at the terminal boundary. |
| Mutation receipt | Durable metadata that proves which tool call last changed the provisional model copy. It contains no board Markdown. |
| Turn references | The three version IDs associated with one model turn. |

Snapshot and draft are not public version-history types.
Internal code can use pending or provisional state where the lifecycle requires it.

## 4. Version model

### 4.1 IDs

A board version ID has this form:

```text
u_MMDDHHmmssSSS
m_MMDDHHmmssSSS
```

The timestamp contains month, day, hour, minute, second, and millisecond.
IDs are scoped to one conversation.
Mint and insert each retained ID inside one IndexedDB read-write transaction.
Use an immutable `add`, not `put`, for a retained row.
On a `ConstraintError`, abort and retry the complete transaction with an advanced candidate timestamp.
An existing retained row must never be replaced during collision handling.

Each retained row also receives a monotonic sequence scoped to its conversation.
History ordering uses that sequence, not lexical ID order or wall-clock order.
The ID does not contain a year and the clock can move backwards.
The UI displays the row's full `createdAt` value, including the year, and never derives a date from the ID.
Tests use a controlled clock and force same-millisecond collisions, clock rollback, and insertion at an existing key.

### 4.2 Initial versions

Enabling Whiteboard for the first time creates two empty versions in one transaction.
Initialization is idempotent so concurrent entry paths cannot create duplicate baselines.

```json
{
  "user_board": "u_0822142950012",
  "model_board": "m_0822142950012"
}
```

The empty versions remove nullable and missing-head states from later code.
Disabling Whiteboard does not delete them.
The UI treats these two records as initialization baselines, not prior history.
History controls have no previous entry while only the baselines exist.

### 4.3 User versions

The user pane has one pending copy outside retained version history.

1. Edit starts from the latest visible user content.
2. Save replaces the pending copy and returns immediately to rendered preview.
3. A later Save replaces that same pending copy.
4. Sending a new user message compares the pending content with the current version.
5. If the content differs, LC promotes it under its `u_...` ID.
6. LC stores that ID on the sent user message and clears the pending copy.
7. If the content is unchanged, LC reuses the current user version ID.

An explicitly saved pending copy can persist across app reloads.
Unsaved textarea input can remain component-local and can be discarded.

Each model turn uses the user version stored on its source user message.
Regeneration from the same user message must reuse that version.

Retry of an assistant response does not consume or promote a pending user copy.
Edit-and-resend is a new send boundary for the edited user message.
It promotes changed pending content, re-pins that same message ID, and then clears the pending copy atomically.
If no pending copy exists, edit-and-resend reuses the message's existing pinned version.

### 4.4 Model versions

Each model turn starts with these references:

```json
{
  "model_initial_board": "m_0822143055123",
  "model_latest_board": "m_0822143055123"
}
```

The first successful model mutation that changes content creates one provisional
`m_...` record. `model_latest_board` then points to that record. Later mutations
in the same turn replace the provisional content. They do not append
intermediate versions or delete the immutable initial version.

At every terminal turn outcome, LC retains the latest provisional record if it exists.
This rule applies to success, provider failure, user interruption, timeout, and cutoff.
It also applies when the mutation committed but generation ended before its ordinary tool result was saved.
If no provisional record exists, LC creates no version.

A mutation that produces content equal to the current model content returns `changed: false` and creates no provisional record.
A write that starts after lifecycle settlement cannot create or change a provisional record.

The next turn initializes both model references from the preceding `model_latest_board`.

### 4.5 Turn references

The canonical public shape is:

```ts
interface WhiteboardTurnReferences {
  user_board: string;
  model_initial_board: string;
  model_latest_board: string;
}
```

An assistant message stores these references when Whiteboard was exposed for that turn.
The source user message stores its pinned `user_board` ID separately.

Examples:

```json
{
  "user_board": "u_0822142950012",
  "model_initial_board": "m_0822143055123",
  "model_latest_board": "m_0822143119048"
}
```

```json
{
  "user_board": "u_0822142950012",
  "model_initial_board": "m_0822143055123",
  "model_latest_board": "m_0822143055123"
}
```

The first example records a model-board change.
The second example records no model-board change.
No success, failure, snapshot, or draft field is necessary.

## 5. Storage contract

### 5.1 Durable records

Add a dedicated IndexedDB table for retained versions:

```ts
interface WhiteboardVersionRow {
  conversationId: string;
  id: string;
  owner: 'user' | 'model';
  content: string;
  createdAt: number;
  sequence: number;
  sourceMessageId: string | null;
  sourceToolCallId: string | null;
}
```

Use a composite primary key for `conversationId` and `id`.
Index by conversation, owner, and monotonic sequence.
Board content uses the existing safe text-compression behavior.
Retained rows are immutable and use `add` semantics.

Add a second table for the pending user copy and active provisional model copy.
Each conversation has at most one working row per owner.
Working rows are not returned by version-history queries.
The model working row records its generation ID, assistant message ID, and latest applied tool-call ID.
That bounded metadata is the mutation receipt used for terminal result repair.

### 5.2 Atomic operations

The storage service owns these transactions:

- Create both initial empty versions.
- Save or replace the pending user copy.
- Promote the pending user copy during message send.
- Create or replace the active model provisional record.
- Retain the final model version at turn termination.
- Truncate discarded transcript branches and their owner-only versions.
- Delete every board record with its conversation.
- Clone and archive the board data with its conversation.

A storage failure must not leave message references that point to a missing board version.
The version write and the related message reference update form one logical mutation.
Retained-version insertion, sequence allocation, and related reference changes use one transaction.
Working-row replacement can use `put`; retained-version insertion cannot.

### 5.3 Persistence boundaries

Retained versions and turn references survive:

- App reload.
- Conversation archive export and import.
- Conversation clone.
- Conversation archive and unarchive.
- Interrupted-turn recovery.
- Retry and edit-and-resend branch truncation.

Conversation archive export includes retained versions and turn references.
It omits unsent user textarea input and the saved pending user copy.
The separate whiteboard export in section 10.7 follows the visible overlay instead.

The initial version-1 conversation archive includes one root `whiteboard.json` file.
The file contains retained version rows grouped by conversation and contains no working rows.
Because LC has not been released, this iteration does not add a compatibility reader for a pre-Whiteboard archive shape.
Any non-version-1 LC archive receives a specific unsupported-archive-version error.
Do not report a recognized LC archive with an unsupported version as `not a conversation archive from LLM Client`.
Archive import validates all message references and board rows before it writes.
Importing over an existing conversation replaces that conversation's retained rows instead of merging them.
It clears working rows and replaces messages, metadata, and retained board rows in one transaction.

Cloning copies only retained versions that the cloned messages can reference.
It copies no pending user copy and no active provisional record.
Version IDs remain valid because they are conversation-scoped.
Clone remaps every `sourceMessageId` through the same old-to-new message ID map used by the transcript.
Clone writes metadata, messages, and retained board rows in one transaction.
A failed clone leaves no partial clone and no reference to a missing board version.

Retry and edit-and-resend are destructive branch boundaries.
Their transaction identifies every removed message ID and the prior references replaced on the retained edit target.
It deletes a discarded-branch version unless a final surviving message, a surviving current head, or an initialization baseline still requires it.
It clears any working model row owned by the discarded branch and resets current heads from the last surviving references.
Initial baselines and versions still referenced by surviving messages remain.
Retry reuses the surviving source user message and its pinned user version.
Edit-and-resend applies the user-boundary rules in section 4.3 to the retained, edited user message.

Change the synchronous `replaceFromMessage` boundary to expose an awaited persistence result for Retry and Edit-and-resend.
After generation preflight succeeds, await the complete truncation transaction before `appendMessage`, `markStreaming`, or turn admission can run.
If truncation fails, abort Retry or Edit-and-resend and show the persistence failure; do not start generation on the discarded head.
Extend the existing `chat-generation-order.test.ts` assertions for both paths.

`popLast` has no production caller and remains test-only in this iteration.
Do not add a production caller while whiteboard references live on messages.
If production code needs that operation later, route it through the same awaited truncation service first.

Deleting a conversation deletes its retained and working whiteboard rows in the same transaction.

## 6. Tool contract

### 6.1 Input

Use one flat strict schema to avoid fragile provider support for `anyOf`:

```ts
interface WhiteboardInput {
  action: 'read' | 'replace' | 'edit';
  content?: string;
  old_string?: string;
  new_string?: string;
}
```

The valid forms are:

```ts
lc_whiteboard({ action: 'read' })
```

```ts
lc_whiteboard({ action: 'replace', content: '# Current model notes\n...' })
```

```ts
lc_whiteboard({
  action: 'edit',
  old_string: 'Exact existing text',
  new_string: 'Replacement text',
})
```

Rules:

- `read` accepts no content or edit fields.
- `replace` requires `content` and accepts no edit fields.
- An empty `content` value clears the model board.
- `edit` requires `old_string` and `new_string`.
- `old_string` must be non-empty and must occur exactly once.
- `new_string` can be empty.
- Matching is exact and does not interpret Markdown.
- Unknown input fields are invalid.
- LC rejects an invalid field combination before store access.

The optional-absence normalizer preserves `content`, `old_string`, and
`new_string` exactly when the selected action uses that field. An empty
`content` can clear a board, an empty `new_string` can delete matched text, and
whitespace can be exact board content. A blank field from another action is a
provider placeholder and normalizes to omission. This permits
`{ action: 'read', content: '', old_string: '', new_string: '' }` without
weakening strict validation for nonblank conflicting fields.
`old_string` is non-empty when its string length is greater than zero;
whitespace-only `old_string` values remain valid exact-match inputs.

One board accepts at most 32 KiB of UTF-8 Markdown.
LC checks the final content after replacement or edit.
LC does not truncate board content.

Invalid arguments return the existing error envelope with
`invalid_arguments` and `retryable: false`. The catalog message and remedy stay
stable. The same issue also includes the live schema details, so the caller sees
the rejected field and the exact action-specific rule.

### 6.2 Read output

A read returns the board state visible to the current turn:

```ts
interface WhiteboardReadOutput {
  refs: WhiteboardTurnReferences;
  user_markdown: string;
  model_markdown: string;
}
```

`user_markdown` comes from the user version pinned at turn start.
`model_markdown` comes from the latest model state in the active turn.

The tool does not return the unsent pending user copy.
It does not accept a historical version ID.
Historical navigation belongs to the UI in this iteration.

### 6.3 Mutation output

A successful replace or edit returns compact metadata:

```ts
interface WhiteboardMutationOutput {
  refs: WhiteboardTurnReferences;
  changed: boolean;
  model_bytes: number;
}
```

The mutation result does not echo the complete board.
A later `read` returns the resulting Markdown when the model needs it.
`model_bytes` is the resulting UTF-8 byte count, not a character count or checksum.

Replace compares its requested content with the current model content.
Identical content returns `changed: false` and creates no provisional record.
Edit first enforces the exact one-occurrence rule.
If the valid edit produces identical content, including `old_string === new_string`,
it returns `changed: false` and creates no provisional record.

### 6.4 Stable issues

Add stable codes and catalog-owned recovery guidance:

| Code | Meaning | Retryable |
|---|---|---:|
| `invalid_arguments` | The action and supplied fields do not form one valid operation. | `false` |
| `whiteboard_not_initialized` | The enabled conversation has no valid initial board records. | `true` after LC repairs initialization |
| `whiteboard_version_missing` | A pinned or current version reference has no retained row. | `false` |
| `whiteboard_read_failed` | LC could not read the pinned or current board record. | `true` |
| `whiteboard_write_failed` | LC could not retain the new model content. | `true` |
| `whiteboard_old_string_not_found` | `old_string` does not occur in the current model board. | `false` for the same input |
| `whiteboard_old_string_not_unique` | `old_string` occurs more than once. | `false` for the same input |
| `whiteboard_too_large` | The resulting model board exceeds 32 KiB. | `false` for the same input |
| `whiteboard_batch_conflict` | The model declared more than one whiteboard call in one batch. | `false` for the same batch |
| `aborted` | The owning generation ended before the operation completed. | `false` |

The typed catalog owns these exact recovery rules:

- `whiteboard_not_initialized`: retry once after LC repairs initialization; if it repeats, continue without the board.
- `whiteboard_version_missing`: do not retry the missing ID; report that the retained version is unavailable.
- `whiteboard_old_string_not_found`: return deterministic bounded near-match suggestions from the current model board.
- `whiteboard_old_string_not_unique`: return the bounded occurrence count and deterministic bounded location excerpts.
- `whiteboard_too_large`: report the limit and measured size as UTF-8 bytes, not characters.
- `whiteboard_batch_conflict`: no whiteboard call in that batch ran; send one intended whiteboard call in a later batch and wait for its result.

Implement one small TypeScript-only board diagnostic for not-found edits.
It is not a general fuzzy matcher and does not call the Rust sandbox bridge.
It uses this deterministic line-comparison ladder for suggestions only:

1. Compare the complete block while ignoring trailing whitespace.
2. Compare the complete block while ignoring leading and trailing whitespace.
3. Locate the first requested line while ignoring leading and trailing whitespace.
4. If no comparison matches, return zero suggestions and this distinct remedy: `The first line of old_string did not match a line in the model board. Call lc_whiteboard with action read before you retry the edit.`

Matching for the actual edit remains exact.
The non-unique diagnostic uses plain string scanning.
Return at most three suggestions or excerpts and bound each item to 160 UTF-8 bytes.
Suggestions never include user-board content.

### 6.5 Batch rule

Allow at most one exact `lc_whiteboard` call in a model-declared batch.
The call can run beside non-whiteboard calls.
Two whiteboard calls receive `whiteboard_batch_conflict` before either one runs.

This rule prevents concurrent reads and writes from observing an undefined order.
Ordinary batch order and completion behavior remain unchanged for other tools.

Reuse the existing pre-execution governor pattern used by `lc_tool_help`.
Count admitted and rejected exact-name whiteboard calls in stable batch-index order.
Whiteboard adds no tool-specific per-turn total or read limit.
The existing global tool-round limit remains the outer loop bound.

## 7. Exposure, policy, and guidance

### 7.1 Category and authorization

Add a canonical Whiteboard category with one member:

```ts
export const WHITEBOARD_NAMES = ['lc_whiteboard'] as const;
```

Add `whiteboard_enabled` to the persisted Workspace config.
The inactive default is `false`. The Workspace master transition sets it to
`true`, and the user can disable its category afterward.

The policy entry is:

```ts
{
  name: 'lc_whiteboard',
  category: 'whiteboard',
  grantScope: 'none',
  promptPolicy: 'no_prompt',
  defaultGrantOnRootAdd: false,
  mutability: 'conversation_state',
}
```

The category toggle controls both UI availability and model exposure.
It creates no permission checkbox, directory grant, conversation grant, or popup.
The toggle stays locked with the other execution-affecting controls during generation.
This lock prevents a provisional model copy from being disabled mid-turn, so no mid-turn disable rule is required.
Disabling it hides the composer action and preserves all retained and pending board state.
Re-enabling it restores access to the same state.

### 7.2 Tool Help

Classify `lc_whiteboard` as an operational conversation-state tool.
Enabling Whiteboard can therefore expose `lc_tool_help` through the existing derived rule.

Add a typed guidance catalog for `lc_whiteboard`.
The catalog owns its purpose, essential guidance, help sections, stable codes, and remedies.
Useful help sections include ownership, read visibility, replace, exact edit, size limits, and turn versions.
Essential guidance says to send only one whiteboard call per batch and wait for its result.
It also says that a read is necessary before mutation only when the model does not know the current exact content.

Detailed help remains unavailable when Whiteboard is not exposed.
Name correction never executes a whiteboard operation.

### 7.3 System prompt and built-in skill

When Whiteboard is exposed, add these concise system-prompt rules:

```text
Use lc_whiteboard to read the conversation boards and change only the model board.
The user board is fixed for this turn. User edits made now appear in the next turn.
Model board reads show your latest applied change in the current turn.
```

Do not put board Markdown, board IDs, or version history in the system prompt.

Update the LC Tool Cheat Sheet with one cross-tool workflow sentence.
Do not turn the skill into a whiteboard manual.

Every LC-authored description, schema description, issue, remedy, warning,
system-prompt sentence, UI string, and limit message receives structural STE coverage.
The repository does not claim official ASD-STE100 compliance.

Phase 0 froze the exact model-visible fixtures before implementation.
Constrained-model fixtures must recover from a batch conflict, complete
read-edit-reread, and explain pinned-user versus latest-model visibility from
the schema, prompt rules, and `lc_tool_help` output alone.

## 8. Turn lifecycle

### 8.1 User send boundary

Before LC appends a new user message:

1. Read the current retained user version.
2. Read the pending user copy, if present.
3. Promote changed pending content to one `u_...` version.
4. Store that ID on the new user message.
5. Clear the pending copy after the message and version are durable.

If Whiteboard has never been initialized or is disabled, the user message gets no board reference.
A disabled Whiteboard does not promote its pending user copy at the send boundary.
The preserved pending copy remains available after Whiteboard is re-enabled.
If the user sends other messages while disabled, that older pending copy is still promoted only on the next enabled user send.

### 8.2 Model turn start

When Whiteboard is exposed, turn admission captures:

- The source user message's `user_board` ID.
- The current retained model-board ID.

If the source user message has no `user_board`, LC pins the current retained user head and writes that ID back to the source message in the admission transaction.
This fallback does not promote a pending copy.
Later retries from that message reuse the written-back ID.

LC writes the three initial turn references to the generation-owned assistant message.
Both model fields start with the same ID.
Every tool context for that generation receives the same pinned user reference.

### 8.3 Model mutation

A successful changed replace or edit updates one provisional model row for the active generation.
The transaction patches `model_latest_board` on the generation-owned assistant message and records the tool-call ID in the mutation receipt.
A later read in the same turn resolves that provisional row.

Model mutation and terminal settlement use one generation-owned whiteboard lifecycle queue built with the existing `createSerializedAsyncQueue` primitive.
The mutation checks `isStreamingOwner(conversationId, generationId)` with `includeTerminal` left false before and after its storage transaction.
The transaction also requires an open working row owned by the same generation.
Terminal settlement closes that row before it retains or removes it.
A worker that reaches storage after closure returns `aborted` and performs no write.
A mutation that commits before closure remains an applied change even if generation ends before the normal tool result is saved.
If the post-write ownership check fails after such a commit, the ordinary completion path emits no contradictory result; terminal repair uses the receipt.
The terminal repair rule below makes the persisted tool result agree with that receipt.

### 8.4 Terminal boundary

Every terminal path settles the provisional model row once.
The terminal operation does not depend on `finish_reason` classification.
It retains the latest applied content for success and failure alike.

The covered paths include:

- Natural completion.
- Output-length completion.
- Refusal.
- Provider error.
- Stream disconnect.
- Stream timeout.
- User interruption.
- Tool-round timeout.
- Tool-batch rejection.
- Reasoning-loop termination.
- App crash recovery.

Recovery must preserve the last successful whiteboard mutation from an interrupted turn.
An operation that failed before commit creates no mutation receipt and changes no board state.

If an accepted whiteboard call has no persisted tool result, terminal repair inspects the mutation receipt:

- If that call committed, retain the provisional content and synthesize a compact successful result with `changed`, `model_bytes`, and current references. Add the warning `LC applied this whiteboard change before the generation ended.`
- If that call did not commit, synthesize the terminal `aborted` or timeout error and state that no whiteboard change was applied by that call.

The terminal operation and result repair are idempotent.
A tool worker cannot apply a change after terminal settlement completes.

Crash recovery follows the existing lazy per-conversation load path.
When the conversation opens, LC settles an orphaned provisional row once and repairs its owning assistant message from the mutation receipt.
If the owning assistant message is missing, LC discards the orphaned working row and restores the last retained model head.
Repeated loads produce no additional version or result.

## 9. Tool History and request projection

Keep the existing request-history behavior for all tools, including Whiteboard.

When Tool History is disabled:

- Replay complete historical `lc_whiteboard` tool calls and results in provider requests.
- Keep full `content`, `old_string`, `new_string`, `user_markdown`, and `model_markdown` values.
- Treat this exactly like replay of explicit `lc_read_file` and `lc_write_file` history.

This replay can consume substantial context after repeated full-board reads or replacements.
That cost is an accepted consequence of disabling Tool History, not a separate Whiteboard limit.

When Tool History is enabled, completed whiteboard turns use the existing generic provider-request stubs.
Calls in the active turn remain complete so the model can use their results.

For archived `lc_whiteboard` retrieval through `lc_tool_history`:

- Do not return historical Markdown.
- Do not return historical mutation payloads through raw arguments.
- Return the action and the owning turn's references.
- Keep the original call and result in canonical local storage and conversation archives.
- Keep search indexing bounded and exclude whiteboard Markdown from Tool History search text.

When `lc_tool_history` resolves one owning assistant message, add:

```ts
whiteboard_refs?: WhiteboardTurnReferences;
```

This applies to `message_id` retrieval and exact `tool_call_id` retrieval.
List mode and broad search do not repeat references for every result.
The model can call `lc_whiteboard` to read the current boards.
This iteration does not add historical-version retrieval to the model tool.

Tool History fails closed when it cannot resolve an archived result's owning tool call.
It returns bounded generic metadata with empty arguments and redacted output, and it excludes that result content from search candidates.
A missing owning call can never expose a whiteboard-shaped payload under the name `unknown`.

Tool History does not become a second whiteboard history controller.

## 10. Overlay contract

### 10.1 Entry points

Add one Whiteboard action to `.composer-action-row`, immediately after Attach
in both DOM and visual order. It uses the same button primitive, visibility
states, hover treatment, active treatment, glass treatment, and solid-mode
treatment as Workspace, parameter-preset, and Attach. It has the visible label
`Whiteboard`, the accessible name `Open whiteboard`, visible keyboard focus,
and `aria-pressed` while the overlay is open. Do not use a positive `tabIndex`.
Enter or Space opens it.

Use the supplied `D:/DEV/home/design/board.svg` artwork as the visual source,
but embed its exact path geometry in the repository-owned
`WhiteboardIcon.tsx` React component. Do not ship or request a standalone SVG
file, and do not load the developer-local design path at runtime.

The chat container, rather than the whole window, owns responsive label
visibility. Below 600 px, Attach and Whiteboard become 26 px circular icon-only
buttons while Workspace and the active preset retain their labels. Below
470 px, every composer action becomes the same icon-only circle. Accessible
names and tooltips remain available at both breakpoints.

Render the action only while Workspace and its Whiteboard category are enabled.
Workspace off or Whiteboard off removes the action from the composer layout.
It remains usable during model generation.
Re-enabling Whiteboard restores the action and the prior board state.

Add a Whiteboard section to the Workspace panel.
Place it after Web Access and before Skills. It uses the same compact,
hoverable, collapsed-by-default section style as neighboring Workspace
controls. Expanding it reveals
`Conversation notes shared across model turns.` and an `Open whiteboard`
button styled like the Skills `Import` action.

The toggle remains disabled while Workspace is off. During model generation,
the section is exempt from the panel's muted/disabled presentation so the user
can expand it and open Whiteboard. The toggle itself remains disabled because
changing tool exposure during the active turn is not allowed. The composer and
Workspace launch actions remain usable during generation.

`Ctrl+B` (`Cmd+B` on macOS) opens Whiteboard for the active conversation. The
shortcut is routed through the global modal gate and is a no-op while Workspace
or its Whiteboard category is disabled.

Whiteboard is a separate overlay from `PreviewOverlay`.
Register both with the existing overlay stack and do not show them at the same time.
Derive Preview Overlay visibility as its existing open condition combined with `!whiteboardOpen`.
Opening Whiteboard suppresses Preview Overlay without clearing its pin, selected message, tab, or streaming-dismissal state.
Closing Whiteboard recomputes normal Preview Overlay visibility.
A previously pinned Preview Overlay returns immediately; an unpinned overlay returns only when its ordinary auto-show condition is still true.
New streaming messages cannot make Preview Overlay appear above an open Whiteboard.
Opening another conversation overlay while Whiteboard has unsaved user text first runs the discard guard in section 10.4.

### 10.2 Single-board tabbed layout

The overlay shows one full-width board panel. A centered segmented control in
the modal header contains Model and User tabs and uses the same visual language
as the conversation filter tabs. Model is selected when the overlay opens. The
header shows no persistent description banner; hovering the Whiteboard title
exposes `Conversation notes shared across model turns.` as its native tooltip.

The active board begins with one compact toolbar. Its previous control,
localized version date or current working-state label, and next control form a
centered group. On the User tab, Edit sits at the far right while Markdown is
rendered; editing replaces it with compact Cancel and Save actions. The Model
tab has no action buttons. Saving persists the pending copy and immediately
returns the User board to rendered Markdown. The toolbar is fixed above the
scrolling Markdown. The board uses the dialog body directly, without an inset
border, radius, or padded modal-like shell.

Switching tabs preserves each owner's selected history position, editor state,
and scroll state. Only the selected owner is exposed as the active tab panel.

### 10.3 Narrow layout

Narrow widths keep the same single-board tabbed layout rather than dividing or
stacking the available space. The title tooltip, owner tabs, Close action,
version toolbar, Markdown panel, and footer actions remain reachable.

### 10.4 User editing

The User toolbar provides Edit while Markdown is rendered. Edit changes the
pane to a raw Markdown textarea and focuses it, then the toolbar exposes Cancel
and Save. Cancel restores the last saved pending content or retained user
version. Save validates the UTF-8 byte bound, persists the pending copy, and
automatically returns to the rendered Markdown preview.
The user can Edit and Save during model generation.
Those changes remain pending and are not visible to the active model turn.

Clicking rendered Markdown does not enter edit mode.
This preserves text selection, guarded links, and scrolling.

Use an in-app discard confirmation that fails closed.
Do not use `safeConfirm`, whose fallback permits the requested action.
Protect every exit path: close button, Escape, backdrop, conversation switch,
Preview Overlay opening, conversation deletion, and any parent unmount that LC controls.
If the confirmation UI fails, keep the Whiteboard open and preserve the edit.
Register Escape ownership through `overlay-stack` instead of adding an independent window listener.
Closing after Save loses nothing because the pending copy is persisted.

### 10.5 Version controls

Each pane has independent previous and next controls.
Reuse the horizontal conversation-cycle button design.
Show the selected position and the full localized `createdAt` timestamp, including the year.
History order uses the retained row's monotonic sequence.

History contains:

- Initial empty versions.
- User versions created by changed sends.
- Model versions retained from changed turns.

Pending user content remains the current editable head but is not a history entry.
An active model provisional copy remains the current rendered head but is not counted until the turn terminates.

Label a pending user head `Current · Saved for next send`.
Label an unsaved user editor `Current · Unsaved`.
Label an active model provisional head `Current · Live`.
Do not show a retained-version timestamp as though it belongs to one of these working heads.

Selecting an older version makes that pane read-only.
Returning to the current head restores the pending or live content.
This iteration adds no restore, branch, merge, diff, rename, or delete-version action.

If a referenced retained row is missing, the overlay shows a non-destructive
`Whiteboard version unavailable` notice for that pane.
It does not render fabricated empty content and does not create a replacement version.

### 10.6 Rendering, themes, and accessibility

Use the shared Markdown renderer and guarded-link behavior.
Do not interpret raw HTML outside the renderer's existing policy.

The overlay resembles a light whiteboard in light themes and a dark board in dark themes.
Use opaque or high-contrast surfaces so underlying chat text cannot reduce readability.
Add explicit solid-mode ownership for every new surface.

The overlay must provide:

- A labelled dialog and heading.
- Labelled owner tabs and one selected owner tab panel.
- Visible keyboard focus.
- Accessible Edit, Save, Cancel, and history controls.
- A bounded textarea with a byte counter near the limit.
- Keyboard and screen-reader navigation between the owner tabs and active board.
- Stable focus when a live model-board update arrives.
- Stable model-pane scroll while the user reads older content or is not anchored at the bottom.

When the current model head is selected, successful mutations update it live.
Do not auto-scroll unless the pane was already anchored at the bottom.
When an older version is selected, keep it selected and show `Newer version available` without moving focus or scroll.

Verify light, dark, custom, glass, and solid modes.
Verify narrow width, 200% zoom, 400% zoom, long Markdown, code blocks, tables, and guarded links.

### 10.7 Whiteboard export

Place the Export action in the overlay footer with the same compact icon-and-label
treatment as Settings > Conversations import/export actions.
When the user selects it, capture one immutable copy of both owner-tab selections.
The capture does not wait for the model turn to finish.
The footer dynamically names both captured selections as
`Export model's board (<localized date and time>) and user's board (<localized date and time>).`
Historical and retained versions use their creation time; live Model and saved-pending
User boards use their last update time. While the User board contains an unsaved editor
draft, its parenthetical label is `Unsaved draft` rather than a misleading timestamp.

Export uses these sources:

- The selected historical model version when the Model tab is on history.
- The live provisional model content when the Model tab is on the current head.
- The selected historical user version when the User tab is on history.
- The raw textarea value when the user pane is in Edit mode.
- The saved pending or retained user content when the user pane is rendered.

Write one ZIP file named `lc-whiteboard-YYYY-MM-DD-HHmm.zip`.
Use the user's local date and time when LC creates the filename.
Here `YYYY`, `MM`, `DD`, `HH`, and `mm` mean four, two, two, two, and two decimal digits.
The Tauri build uses the native Save dialog and lets it handle overwrite decisions.
The web build requests that download name, but the browser can append a collision suffix such as ` (1)`.

The ZIP contains exactly `model.md` and `user.md` at its root.
Do not include IDs, turn references, prior versions, hidden current heads, or pending content that is not visible.
The two captured files can come from different turns because tab history is independent.

The Export action remains available during generation.
A model update that arrives after capture does not change the in-progress export.
Export is read-only and does not create a version.

### 10.8 Whiteboard import

Place the Import action beside Export in the overlay footer with the matching
compact import icon.
Render it only when all these conditions are true:

- Both current board contents are empty.
- Each owner has only its initial baseline record.
- No pending user copy exists.
- No provisional model copy exists.
- No model generation is active anywhere in LC.

The two initial baseline records do not count as history for this eligibility rule.
If either board changed and later became empty, retained history exists and import remains unavailable.

Import accepts a ZIP basename in either of these forms:

```text
lc-whiteboard-YYYY-MM-DD-HHmm.zip
lc-whiteboard-YYYY-MM-DD-HHmm (n).zip
```

Validate the lowercase prefix, separators, numeric widths, `.zip` extension,
and a real calendar date and time after file selection.
The optional browser collision suffix uses a decimal integer from 1 through 9999.
Reject other renames and tell the user to restore one of the accepted filename forms.
A matching filename does not make an archive trusted.

Reject a ZIP larger than 128 KiB before decompression.
Use entry-aware streaming extraction rather than `unzipSync` so LC can stop
actual output before a compressed archive allocates an unbounded result.
Create `Unzip`, register `UnzipInflate` before feeding input, and then process each `UnzipFile` through its chunked `ondata` callback.

On desktop, the native picker passes only the path explicitly selected by the
user to the UI-only `read_bounded_file` command. The command rejects a non-file
or oversized metadata result, reads at most the requested bound plus one byte,
and rejects actual post-metadata growth beyond 128 KiB. It creates no Workspace
root or grant and exposes no model-facing path capability. The web picker
applies the same compressed-size bound to its selected `File` before ZIP
parsing.
The streamed local-file entries are authoritative for accepted names and content; the importer does not treat the central directory as a second source of truth.
The extractor must:

- Observe every entry and reject a duplicate name before a map can collapse it.
- Accept the exact key set `model.md` and `user.md` at the root.
- Reject every directory, nested, absolute, traversal, missing, or unexpected entry through that exact key-set rule.
- Stop an entry after 32 KiB of actual uncompressed bytes.
- Stop the package after 64 KiB of combined actual uncompressed bytes.
- Treat defined header `originalSize` only as an early rejection hint, never as proof of the real size; an undefined size remains valid until actual output proves otherwise.
- Decode each completed entry with `TextDecoder('utf-8', { fatal: true })`.
- Reject malformed or unsupported compressed data through one bounded invalid-package error.

LC never extracts ZIP entries to the filesystem.
`UnzipFile` has no per-entry terminate operation.
After an entry or package exceeds a limit, stop accumulating output, mark the complete package invalid, and stop feeding later compressed chunks.
The 128 KiB compressed-input cap bounds the remaining decompression work; the implementation must not claim that it stops an inflate operation at the exact output byte.
The current `fflate` interface does not expose symbolic-link attributes or the encryption flag, so the implementation must not claim that it separately detects them.
Only the exact in-memory filenames, actual output bounds, successful decompression, and fatal UTF-8 decode form the accepted package proof.

At least one imported document must contain content.
Validation completes before any write.

A successful import creates one fresh `m_...` version and one fresh `u_...` version in one transaction.
It does not reuse source IDs, timestamps, or history.
It makes the two imported versions current for the next turn.

Use the repository's generation-blocking operation and global `isAnyStreaming()` convention for import.
This is stricter than the conversation-local data boundary, but it matches existing clone and import behavior and prevents concurrent database replacement.

Import is the one administrative exception to ordinary owner-only editing.
Its empty-and-no-history gate prevents it from overwriting model or user work.

### 10.9 Session handoff

Whiteboard package round-trip is a primary acceptance workflow:

1. In the old conversation, the user asks the model to write a concise progress summary, verified paths, decisions, and next steps to the model board.
2. The user updates the user board with priorities or corrections.
3. Export captures the two board panes that are visible.
4. In a new conversation, the user enables an empty Whiteboard and imports the ZIP.
5. The user enables the required Workspace categories and asks the new model to call `lc_whiteboard`.
6. The new model reads both documents and continues from their recorded state.

The package transfers no workspace files, directory roots, grants, tool history,
model settings, or proof that recorded claims remain true.
The model board should record important paths and the last verification state so
the next model knows what it must inspect again.

## 11. Concurrency, safety, and privacy

- Only the model can mutate the model board through the tool.
- Only the user UI can mutate the user board.
- The tool schema contains no owner selector.
- The current turn reads one pinned user version for its complete lifetime.
- User edits during generation cannot race with model reads.
- Generation identity prevents an old model turn from updating a newer turn.
- One-whiteboard-call-per-batch admission prevents undefined tool-call ordering.
- Board text is untrusted Markdown data at every render and tool-result boundary.
- Whiteboard import validates the complete package before it changes either owner.
- Whiteboard export reads only the two owner-tab values captured at the button click.
- Board content is excluded from support reports by default.
- Diagnostic events can include bounded state values and byte counts, but no board text or version ID.
- Disabling Whiteboard hides its UI action and model tool without deleting or redacting board data.
- Clearing a board creates an empty retained version at the next owner boundary. It does not erase prior history.

This iteration sets no retained-version count or total-byte cap.
Each document remains capped at 32 KiB, but retained storage grows linearly:
1,000 maximum-size versions for one owner are approximately 31.25 MiB before storage overhead and compression.
LC does not silently prune referenced history or reject a valid owner update at an arbitrary count.
Existing conversation-archive limits remain the outer package bound.
Branch truncation removes only versions that belong exclusively to the discarded transcript branch.

No part of this feature weakens provider schemas, authorization, sandboxing,
contention checks, destructive-operation protections, or archive redaction.

## 12. Completed rollout record

The phases were completed in this order. Each exit gate was verified before
the next phase became the implementation focus.
The accepted rollout plan is retired. This closed contract is the canonical
engineering reference for the shipped feature.

### Phase 0 — Contract fixtures (complete)

- Add exact input, output, version-ID, collision, and turn-reference fixtures.
- Add before-change payload, schema-description, system-prompt, and skill-token fixtures.
- Add storage fixtures for initial, pending, provisional, and retained content.
- Add branch-truncation, terminal-repair, and Tool-History-on/off request-projection fixtures.
- Add UI state fixtures for wide, narrow, current, historical, editing, and live-update states.
- Add export fixtures for every visible source and streaming-import fixtures for every eligibility and rejection condition.
- Freeze constrained-model fixtures for batch-conflict recovery, read-edit-reread, and pinned-user comprehension.
Exit gate met: tests express the accepted contract.

### Phase 1 — Storage and pure version engine (complete)

- Add whiteboard row types, tables, compression, and transaction helpers.
- Define the four content tables, including both Whiteboard tables, in schema v1 and update the support-report fixture. Later additive migrations preserve those rows in current schema v3.
- Implement transaction-safe owner-prefixed IDs, immutable retained inserts, and monotonic sequence allocation with a controlled clock.
- Implement initial empty versions.
- Implement pending user promotion.
- Implement one provisional model record per active turn.
- Implement same-content reuse and overwrite the same provisional record within one turn.
- Implement awaited retry and edit-and-resend truncation with surviving-head restoration and generation-order assertions.
- Make clone remap source message IDs and persist metadata, messages, and board rows atomically.
- Add mandatory `whiteboard.json` to conversation archive version 1 and replace imported board rows atomically with imported messages.
- Update `archive-fixtures.test.ts` and `archive-roundtrip.test.ts` for archive version 1 and the distinct unsupported-version error.
- Extend deletion and lazy per-conversation crash recovery.
- Keep conversation archive import separate from the empty-board gate for whiteboard-package import.

Exit gate met: storage tests prove immutable insertion, stable ordering, referential integrity, transactional clone/import/truncation, idempotent recovery, and one retained version per changed owner boundary.

### Phase 2 — Tool, category, and guidance (complete)

- Add the strict `lc_whiteboard` schema and typed handler capability.
- Implement read, replace, and exact edit.
- Add the TypeScript-only whitespace diagnostic and assert that it never invokes the sandbox bridge.
- Add stable codes and the typed guidance catalog.
- Register the tool in canonical order.
- Add the Whiteboard category to both hand-maintained policy tables and assert registry-policy parity.
- Add the toggle, no-prompt policy, exposure tests, and exact optional-string normalization.
- Add conditional system-prompt and LC Tool Cheat Sheet guidance.
- Update complete serialized token fixtures.

Exit gate met: the tool works against a pure version service without React or direct IndexedDB imports.

### Phase 3 — Turn lifecycle and Tool History (complete)

- Pin the sent user-board version at model-turn start.
- Add exact turn references to user and assistant message persistence.
- Connect model mutations to generation-owned provisional state.
- Serialize mutation with terminal settlement and repair unanswered results from mutation receipts.
- Retain the final applied model version on every terminal path and reject workers that arrive after closure.
- Add batch-index-ordered one-per-batch admission through the existing governor pattern.
- Preserve full request replay while Tool History is off and generic request stubbing while it is on.
- Add reference-only Tool History projection, unresolved-name fail-closed behavior, and search exclusion.
- Preserve generic stubbing for every other tool.

Exit gate met: success, failure, interruption, timeout, cutoff, late worker, both Tool History states, and recovery tests preserve exact board/result truth without intermediate-version bloat.

### Phase 4 — Responsive overlay (complete)

- Add the composer-action-row launch action after Attach and the standard collapsible Workspace exposure section with its second launch action.
- Embed the repository-owned Whiteboard icon geometry and reuse the existing composer-action state styles.
- Add the 600 px Attach/Whiteboard icon-only step and the 470 px all-actions icon-only step.
- Implement the full-width tabbed Model/User layout at wide and narrow widths.
- Add one rendered owner panel that preserves independent Model and User state.
- Add compact user Edit, Save, Cancel, immediate rendered preview after Save, and discard protection.
- Add independent version controls and current-head behavior.
- Add footer Import/Export actions with matching icons, a dynamic two-selection export notice, and gated empty-board import with the generation-blocking operation.
- Keep the Workspace Whiteboard section, launch actions, and overlay usable during generation while locking only the exposure toggle and administrative import.
- Add streaming ZIP validation with duplicate detection, actual output bounds, and fatal UTF-8 decode.
- Register `UnzipInflate` and prove round-trip import of LC's deflate-compressed export.
- Add overlay-stack integration, derived Preview Overlay exclusion with preserved pin state, and fail-closed discard handling for every exit path.
- Add theme, solid-surface, keyboard, focus, and assistive-technology coverage.

Exit gate met: ZIP tests pass before component tests. UI tests cover the
supported visual states.

### Phase 5 — Documentation, evaluation, and closure (complete)

- Update tool overview, reference, policy, error handling, Tool History, data model, architecture, module map, security, privacy, and audit templates.
- Update built-in tool and category counts from the canonical registry.
- Run model-visible structural STE checks for every new string.
- Run the frozen representative model-use tests for read, replace, edit, reread, batch recovery, failure continuity, and pinned user visibility.
- Run the complete session-handoff export/import/read-and-continue workflow.
- Run the full TypeScript, build, lint, documentation, import, test-registry, Rust, and whitespace gates, isolating unrelated pre-existing Rust formatting and Clippy baseline failures.
- Retire the rollout plan after the implementation gates pass.

Exit gate met: code, tests, generated content, and documentation describe one
implemented behavior.

## 13. Test matrix

| Area | Required proof |
|---|---|
| IDs | Owner prefixes, exact timestamp shape, controlled time, same-millisecond collision, clock rollback, conversation scoping, monotonic sequence, immutable `add`, collision `ConstraintError`, and unchanged existing content |
| Initialization | Database-version bump, one transaction, two empty versions, repeat initialization, reload, disabled state, support report, and storage failure |
| User boundary | No pending copy, changed copy, unchanged copy, repeated Save, enabled send, disabled sends, preserved old pending copy, next enabled promotion, retry without promotion, edit-and-resend promotion and re-pin, and source message from before enablement |
| Model boundary | No mutation, one mutation, many mutations, unchanged final value, success, refusal, error, abort before commit, abort after commit, timeout, cutoff, late worker after settlement, and compact repaired result truth |
| Read visibility | Pinned user version, user edit during generation, latest model provisional content, reread after replace, reread after edit, next-turn inheritance, and constrained-model comprehension of the two visibility rules |
| Replace | Empty clear, whitespace-only content, ASCII, Unicode, exactly at 32 KiB, above 32 KiB, unchanged content with no provisional row, UTF-8 byte output, and storage failure |
| Edit | One exact match, no match, several matches, TypeScript-only deterministic whitespace suggestions, total-miss remedy with zero suggestions, no sandbox-bridge call, deletion, whitespace-only fields, `old_string === new_string`, Unicode, size overflow, initial-content reversion, and sequential edits in one turn |
| Batch | One whiteboard call, two calls in one batch, read plus write, two writes, unrelated siblings, stable batch-index rejection, zero execution after conflict, no special per-turn limit, and model recovery without repeated conflict |
| Policy | Both policy tables, registry-policy parity, Workspace off, Workspace on and Whiteboard off, Whiteboard on, provider without tools, no grant, no popup, locked mid-generation toggle, Tool Help derivation, and unknown-name correction without execution |
| Tool History | Message retrieval, exact-call retrieval, list, search, raw-content exclusion, argument exclusion, exact turn references, unresolved owning call fail-closed, search-candidate exclusion, and ordinary-tool regression |
| Request projection | Tool History off with complete historical read results and mutation arguments, parity with file-tool replay, Tool History on with generic completed-turn stubs, and complete active-turn calls in both states |
| Persistence | Dexie round trip, compression, deletion, transactional clone with remapped `sourceMessageId`, conversation archive version 1 and `whiteboard.json`, current archive fixtures, distinct unsupported-version error, import over existing board rows, replace-not-merge, and dangling-reference prevention |
| Truncation | Retry and edit-and-resend after changed user and model versions, removed-branch deletion, surviving references, restored model head, pending-copy behavior, awaited commit before append and streaming, existing generation-order assertions, failed-truncation abort, atomic failure, and test-only `popLast` |
| Recovery | Lazy conversation load, applied receipt, unapplied call, missing owning assistant message, repeated-load idempotence, missing retained row, and no automatic replacement version |
| UI | Wide, narrow, both owners, centered header tabs, fixed version toolbar, Model without edit actions, compact Edit/Cancel/Save, immediate preview after Save, editing during generation, fail-closed discard, current head labels, both histories, missing-row notice, independent scroll, anchored and unanchored live update, older selection, footer package actions, dynamic export notice, disable, and re-enable with preserved state |
| Entry point | Composer action immediately after Attach, shared action-row visibility, inline icon geometry with no runtime SVG file, 600 px Attach/Whiteboard icon-only behavior, 470 px all-actions icon-only behavior, circular icon controls, attachment regression, Workspace row after Web Access and before Skills, standard collapse/hover/description/Open behavior, absent while Workspace or Whiteboard is off, normal presentation and launch during active generation, locked exposure toggle during active generation, tab order, Enter, Space, first-enable initialization, and all theme modes |
| Overlay ownership | Overlay-stack Escape ownership, derived exclusion during new streaming messages, preserved Preview pin and selection state, pinned and unpinned behavior after Whiteboard closes, close button, backdrop, conversation switch, conversation deletion, parent unmount, failed confirmation UI, focus restore, and preserved unsaved text |
| Whiteboard export | Exact requested lowercase timestamped name, Tauri overwrite path, web collision suffix, two root Markdown files, two current heads, two historical selections, mixed selections, live provisional model content, raw user editor content, immutable click-time capture, exact visible-state notice, and no history or hidden content |
| Whiteboard import | Exact and browser-suffixed filenames, malformed names, invalid calendar values, initial baselines, changed-then-cleared history, pending user copy, provisional model copy, global active generation, generation-blocking operation, missing and duplicate entries, local-entry authority, exact key set, undefined and understated header sizes, registered deflate decoder, import of LC's own export, streamed per-entry and combined limits, fatal UTF-8, malformed compression, atomic success, and fresh IDs |
| Handoff | Old-model summary, user update, visible export, new empty conversation, import, explicit read, continued work, and clear notice that files, roots, grants, settings, and proof do not transfer |
| Accessibility | Dialog semantics, pane labels, focus entry and restore, keyboard editing and launch, history controls, screen reader, zoom, high contrast, and live-update stability |
| Guidance | Full payload, descriptions, typed catalog, exact remedies, pinned-user wording, batch recovery, conditional system prompt, generated skill, structural STE, constrained-model fixtures, and token budgets |
| Privacy | Support report exclusion, diagnostic exclusion, canonical archive inclusion, explicit full-replay behavior while Tool History is off, unresolved-name redaction inside `lc_tool_history`, user provenance, Markdown sanitization, and no automatic board injection |

## 14. Implemented code ownership

Implementation is owned across these areas:

- `src/types.ts` for board references and the Whiteboard toggle.
- `src/store/db.ts`, `src/store/whiteboard.ts`, and `src/store/whiteboard-conversation.ts` for version rows, working rows, and transactional conversation boundaries.
- `src/store/conversations.ts` for send, terminal, retry, edit-and-resend, deletion, clone, and recovery boundaries.
- `src/utils/exportArchive.ts` and `src/utils/import.ts` for versioned retained-board archive data and atomic replacement.
- `src/modules/tool-engine/whiteboard.ts` and `src/modules/tool-engine/whiteboard-governor.ts` for the handler and one-call-per-batch admission.
- `src/modules/tool-engine/registry-names.ts`, `registry.ts`, and `policy.ts` for category exposure.
- `src/modules/tool-engine/types.ts` for the typed version-service capability.
- `src/modules/tool-engine/tool-guidance.ts` for authoritative guidance and recovery.
- `src/modules/chat-pipeline/orchestrator.ts`, `whiteboard-turn-runtime.ts`, and `whiteboard-lifecycle.ts` for pinned references, batch admission, ordinary Tool History projection, mutation receipts, result repair, and terminal settlement.
- `src/modules/chat-pipeline/serialized-async-queue.ts` as the existing lifecycle serialization primitive.
- `src/modules/chat-pipeline/message-history.ts` and `lc_tool_history` for reference-only historical projection.
- `src/ui/chat/SidePanel.tsx` for the standard collapsible Whiteboard section, exposure toggle, streaming presentation exception, and launch action.
- `src/ui/chat/Composer.tsx` for the Whiteboard launch action immediately after Attach.
- The focused overlay, package, file-picker, state, toggle, text, and exit-guard modules under `src/ui/tools/`.
- `src/App.tsx` and `src/ui/chat/ChatView.tsx` for one conversation-level overlay host and derived Preview Overlay exclusion.
- `src/utils/overlay-stack.ts` for exclusive overlay ownership and guarded close paths.
- The repository-owned inline `src/ui/tools/WhiteboardIcon.tsx` component.
- `src/index.css` for the composer-action breakpoints and circular controls, Workspace-section streaming presentation, compact overlay chrome, and board surfaces.
- `src/themes/solid.css` for the solid board surfaces and composer-action treatment.
- `src/ui/tools/whiteboard-package.ts`, `whiteboard-file-picker.ts`, and `src-tauri/src/lib.rs` for the platform-aware filename, bounded streaming two-file package, and UI-only native bounded read.
- System-prompt, built-in-skill, token, model-visible-text, and explicit test-registry fixtures.
- Tool, data, architecture, security, privacy, audit, and documentation indexes.

Whiteboard adds the narrowly scoped Rust `read_bounded_file` command for a
user-selected desktop package. It enforces a 128 KiB accepted-content cap with
metadata validation and a limit-plus-one read and is owned only by the UI
import path. It creates no
Workspace root or grant, filesystem grant, Web Access grant, shell permission,
provider-specific wire extension, or model-facing path capability. The
`lc_whiteboard` model tool and exact-edit diagnostic remain TypeScript-only.

## 15. Non-goals

This iteration does not add:

- Cross-owner editing.
- Automatic board injection outside normal replay of explicit tool calls and results.
- More than two boards.
- A block editor or canvas drawing system.
- Real-time multi-user collaboration or CRDTs.
- Branches, merges, diffs, labels, or version deletion.
- Automatic retained-version pruning or a retained-version count cap.
- Model-facing historical-version retrieval.
- Whiteboard list or revision modes in `lc_tool_help`.
- A new model call, embedding search, or external storage.
- Whiteboard import from plain Markdown, JSON, or a ZIP outside the accepted filename forms.
- Whiteboard-package import into a non-empty board or a board with retained history.
- Automatic inference that board content is true, complete, or authoritative.
