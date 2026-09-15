# `lc_todo_write` foundation and task-list engineering reference

| Field | Value |
|---|---|
| Status | Implemented. Automated gates cover the contract. |
| Updated | 2026-08-31 |
| Scope | Foundation exposure, strict task-state contract, model continuity, and Preview Overlay UI |

## 1. Outcome

`lc_todo_write` is a foundation tool for every active Workspace. It is
always exposed, runs without a permission prompt, and has no settings row or
category toggle. It remains unavailable when the Workspace master switch is
off or the provider cannot use tools.

The tool replaces one complete task list. It uses stable IDs, concurrent active
tasks, a blocked state, optional completion evidence, bounded notes, strict
state validation, and a dedicated task-list view in the Preview Overlay.

LC keeps each successful update as an immutable conversation snapshot. For an
active plan, the model receives exactly one complete current list: the surviving tool-call
arguments when they are still on the wire, or a bounded request-only projection
when Tool History has hidden those arguments. Successful results return counts
instead of echoing the list.

## 2. Prior limitations

Before this design was implemented, LC had these limitations:

- `lc_todo_write` is a member of Web Access.
- Its exposure depends on `web_access_enabled`.
- Policy classifies it as an external-effect tool with a conversation grant or
  permission prompt.
- The settings UI shows it beside Web Access tools.
- The structured tool payload can advertise a foundation-only tool while the
  provider-capability and orchestration gates still discard its calls because
  they independently inspect optional category toggles.
- The tool accepts duplicate IDs, non-sequential IDs, and oversized titles,
  then returns warnings instead of rejecting the invalid task state.
- IDs are expected to follow list position, so inserting or moving a task can
  change its identity.
- A task cannot represent a blocked state or retain one short material note.
- The successful result echoes the complete input list, so the current list is
  duplicated in the same tool exchange.
- The UI shows the update only as an ordinary entry in the Tools tab.
- Tool History keeps complete records in local conversation storage, but its
  request projection hides completed-turn tool arguments and results from the
  model. A later complete-list replacement can therefore lose the prior list
  unless the model retrieves that turn manually.
- Stored tool-result content can have one or more LC notice prefixes before the
  JSON envelope, so a direct `JSON.parse` is not a valid snapshot decoder.

The tool is otherwise intentionally simple. It is pure TypeScript, performs no
filesystem or network operation, and stores no state outside conversation
messages.

## 3. Settled decisions

These decisions define the implemented contract:

1. Workspace off means that `lc_todo_write` is not exposed.
2. Workspace on with a tool-capable provider means that `lc_todo_write` is
   exposed and executable independently of every optional category toggle.
3. Resolved exposure is the single source for the tool payload, prompt gating,
   expected-tool-call handling, and returned tool-call accounting.
4. The tool has `no_prompt` authorization and no persisted grant.
5. The tool has no checkbox, category toggle, or other settings row.
6. The tool remains conversation-local and pure TypeScript.
7. Every call replaces the complete task list. Partial CRUD operations are not
   added.
8. Empty lists remain invalid. A plan with every item completed represents a
   closed plan; a later call can replace it with a new plan.
9. Numeric IDs remain stable while their task remains in the plan. IDs must be
   positive, integral, safe, and unique, but they do not need to be sequential
   or ordered.
10. Zero or more tasks can be `in-progress`.
11. Completion evidence is optional. One successful update warning names all
    completed task IDs that omit it.
12. Completion evidence is a model-reported statement. LC stores and displays
    it but does not verify it.
13. A blocked task must include a short note that explains the blocker.
14. A note can hold a current blocker or one material result. It is not a
    scratchpad or a substitute for the conversation Whiteboard.
15. Successful output contains counts only. The authoritative snapshot list is
    reconstructed from normalized call arguments after a matching successful
    result proves that LC accepted the update.
16. Tool History keeps its normal generic stubs and archive behavior.
17. Current todo state is not placed in the cacheable system prompt. A required
    projection is appended to the request-only copy of the latest real user
    message; LC does not insert a synthetic user message.
18. A completed plan is retained in history and the UI but is not automatically
    projected into later model requests.
19. The Preview Overlay gains a third `To do list` tab and assistant bubbles
    gain a task-list button when that bubble owns a successful update.
20. The todo tab is read-only in this iteration. The model updates it through
    `lc_todo_write`.
21. Todo updates do not automatically select the todo tab. Normal tool activity
    can still auto-select the Tools tab.
22. The direct shortcut is `Ctrl+Alt+P` on Windows and Linux and
    `Cmd+Option+P` on macOS. Shortcut matching uses the physical `KeyP` code and
    platform-specific semantic checks.
23. LC has never been released. Preimplementation todo shapes receive no
    compatibility reader, migration, legacy empty state, or grant migration.
    Invalid stored shapes are ignored by the current selector.
24. This work does not implement `lc_whiteboard`, whiteboard storage, or
    whiteboard history.
25. Todo snapshots are model-maintained progress metadata, not an authoritative
    execution ledger. LC does not add list-level lifecycle values, infer task
    completion from later tool results, block a final response, or request an
    extra model turn to reconcile stale bookkeeping.

## 4. Tool contract

### 4.1 Input and normalization

The model-facing input shape is:

```ts
interface TodoWriteInput {
  todos: Array<{
    id: number;
    title: string;
    status: 'not-started' | 'in-progress' | 'blocked' | 'completed';
    note?: string;
    completion_evidence?: string;
  }>;
}
```

The initial bounds are:

| Field | Bound |
|---|---:|
| `todos` | 1 through 20 items |
| `id` | Positive safe integer |
| `title` | 1 through 120 trimmed characters |
| `note` | 1 through 240 trimmed characters when present |
| `completion_evidence` | 1 through 240 trimmed characters when present |
| `in-progress` items | 0 through 20 |

Twenty items keep the projected current state bounded and distinguish the tool
from a backlog manager. The existing limit of 50 is reduced deliberately. A
model that needs more than 20 active steps must group them into meaningful
phases.

The outer input object and each todo object use explicit strict schemas. Unknown
properties are rejected; they are not silently stripped by the default Zod
object behavior.

One shared schema owns normalization for execution, snapshot reconstruction,
the UI, and tests. String schemas call `.trim()` before their length checks.
The runner's existing recursive optional-absence normalizer removes `null`,
empty, and whitespace-only optional text before the shared schema runs. A
blocked item whose note normalizes away then fails the blocked-note rule.
Invisible-only completion evidence is invalid. No second UI-specific or
projection-specific normalizer is added.

### 4.2 Validation

These conditions return the normal `invalid_arguments` envelope with
`retryable: false`:

- An empty list or a list above the item bound.
- A non-integral, non-positive, unsafe, or duplicate ID.
- An empty or oversized title.
- An unsupported status.
- A `blocked` task without a non-empty note.
- An oversized note.
- Oversized or invisible-only completion evidence.
- An unknown property on the outer or item object.

LC does not silently renumber tasks, truncate material content, change statuses,
or accept an invalid control state with warnings.

### 4.3 Output

A successful result contains:

```ts
interface TodoWriteOutput {
  completed: number;
  blocked: number;
  total: number;
}
```

The successful result does not echo `todos`. Validation issues belong in the
existing `ToolResultEnvelope.issues`. If completed tasks omit
`completion_evidence`, one bounded warning names their IDs. The warning does not
change the successful status or claim that supplied evidence is verified.

The stored normalized call arguments are the list payload. A matching stored
result with `tool_is_error !== true` and envelope status `ok` is the success
proof. The selector never treats unpaired call arguments as accepted state.

### 4.4 Guidance

The essential description states these rules:

- Use the tool for multi-step work, not for a trivial one-step action.
- Send the complete list on every call.
- Preserve an existing task's ID across updates and reordering.
- IDs must be unique positive integers; they do not need to be sequential.
- Mark each active task in progress. Multiple tasks can be active.
- Mark completed work promptly.
- Add `completion_evidence` when a result supports completed work.
- Use `blocked` with a short reason when work cannot continue.
- Do not use notes as general working memory.

Remove the old sequential-ID wording from every description, test fixture,
error remedy, generated reference, and built-in skill copy. The description,
schema descriptions, errors, request projection, and UI-owned strings must
follow the repository's structural STE rules. Model-authored titles and notes
are data and are not rewritten or tested as LC-authored STE text. LC does not
claim official ASD-STE100 compliance.

## 5. Foundation exposure and authorization

### 5.1 One exposure truth

LC defines a canonical foundation-tool membership list and a `foundation`
policy category. `lc_todo_write` is not in `WEB_ACCESS_NAMES`. It is in the
foundation list.

Its policy metadata is:

```ts
{
  name: 'lc_todo_write',
  category: 'foundation',
  grantScope: 'none',
  promptPolicy: 'no_prompt',
  mutability: 'conversation_state',
}
```

`resolveExposure` adds every foundation tool after it accepts the Workspace
master switch. Category toggles do not affect this step. The full registry still
controls serialized tool order.

The resolved exposed-name set, combined with provider tool capability, must
drive all of these paths:

- `structuredToolPayload()` and the serialized definitions.
- Workspace tool-prompt enablement.
- System-prompt tool/workspace sections.
- The orchestrator's `expectsToolCalls` decision.
- Tool-call callbacks, round counting, and returned-call preservation.
- Unknown-name and not-exposed handling.

No path may infer tool availability by independently checking the six optional
category toggles. The Phase 1 integration fixture must send a real
`lc_todo_write` call through a Workspace with every optional category off and
prove that the call is executed and returned, not merely advertised.

`lc_todo_write` remains a callable operational name for correction and unknown-
name handling, but its foundation membership must not expose `lc_tool_help` in
a todo-only Workspace. Detailed help remains limited to tools independently
exposed by the existing help rules.

### 5.2 Grants, settings, and documentation

The Web Access grant allowlist no longer accepts `lc_todo_write`.
Every grant read ignores a stale entry for this tool. The next normal grant
write drops it; no eager database migration is added.

Removing the tool from the optional category membership removes its settings
row. No replacement row or hidden user preference is added.

The LC Tool Cheat Sheet moves its todo workflow sentence to the marker
`<!-- lc-tools-section:core -->`, under `## Operating loop`. It is concise and
cross-tool. It does not duplicate the full tool manual.

Foundation membership must also be reflected in `categoryOf`, `ALL_TOOL_NAMES`,
tool-name entries, prompt deduplication, policy assertions, support reporting,
grant fixtures, and synchronized documentation. Support reports may name the
tool and its policy, but must not invent a user-visible foundation toggle.

## 6. Snapshot and model-continuity contract

### 6.1 Snapshot identity and decoding

Each successful `lc_todo_write` result is an immutable snapshot. The existing
assistant tool call, matching tool-result message, and `tool_call_id` are the
snapshot identity; this iteration does not add a second revision identifier or
database table.

A pure shared selector resolves snapshots from stored conversation messages:

1. Scan backward from the requested conversation position through at most
   `4,096` messages.
2. Match an assistant `lc_todo_write` call with its tool result by
   `tool_call_id`.
3. Decode at most `64 KiB` of stored result content. Strip at most `256`
   leading, recognized `[LC] ...\n\n` notice blocks, then parse the remaining
   content as a `ToolResultEnvelope`. Unknown prefixes or exceeded bounds make
   the candidate invalid instead of triggering an unbounded scan.
4. Require `tool_is_error !== true` and envelope status `ok`. This includes
   synthetic recovery rows and results whose persisted content was later
   patched during replay or repair.
5. Parse the call arguments through the runner's optional-absence normalization
   and the shared strict todo schema. The normalized arguments supply the list;
   the result supplies only success proof and counts.
6. Ignore missing, interrupted, invalid, aborted, malformed, and error results.
7. For the local UI, first match a logical list by its complete set of stable
   task IDs and a strict majority of unchanged titles at those IDs. This permits
   bounded title refinement while keeping unrelated lists that reuse sequential
   IDs separate. Also recognize a forward-growing complete-list replacement
   when the new snapshot is longer and its ordered sequence of unchanged titles
   is a strict majority of the prior list and at least half of the new list.
   This second rule tolerates a model inserting tasks and renumbering later IDs.
   It applies only to growth: a shorter sub-list is retained as a distinct list.
   Status, note, and declared-order changes update the matched list. Retain only
   its latest state in its first-seen slot. Concurrent result completion order
   does not affect the result.
8. The last successful call in one assistant message, and then across assistant
   messages, remains the effective snapshot for model continuity.
9. A failed later update does not replace the last successful snapshot.

Conversation edits, retries, forks, imports, and deletions recompute state from
the current schema and the messages that remain. Preimplementation shapes are
simply invalid candidates.

### 6.2 Exact Tool History boundary

Tool History continues to use its normal generic archive records and wire
stubs. Stored messages and exported archives retain the complete todo call and
counts-only result like other tools.

LC projects the latest successful todo snapshot only when that snapshot's own
full call arguments have been hidden by the finalized Tool History request
projection. The decision is based on the actual post-stubbing request messages,
not on a duplicated estimate of turn boundaries.

The rules are:

- If Tool History is disabled and the source call arguments remain on the wire,
  do not add a projection.
- If the source call is in the active turn and remains on the wire, do not add a
  projection.
- If any successful todo update exists in the active turn, suppress an older
  projected snapshot. Declared call order selects the active snapshot.
- If Tool History stubs the source call arguments, add one projection of the
  latest successful incomplete plan.
- If every item is completed, add no projection. The closed plan remains in
  local history and the UI.
- Never include more than one current list in the serialized request.

This preserves normal generic Tool History behavior and makes the projection a
derived request concern, not a new storage mechanism.

### 6.3 Request-tail projection

The orchestrator appends the projection to the request-only copy of the latest
real user message after Tool History has produced its wire projection and before
provider serialization. It does not mutate stored conversation content, add a
synthetic user message, or change the cacheable system prompt.

A pure formatter owns the LC-authored wrapper. The wrapper clearly labels the
block as saved LC task state and says that it is not a new user request. The
payload includes:

- Every task's ID, status, and exact normalized title in declared list order.
- The note for the first `in-progress` task with a note, when present.
- Notes for the first five blocked tasks in declared list order.
- A bounded notice when additional active or blocked notes remain in Tool
  History.

Notes on completed and not-started tasks are omitted from automatic projection.
Completion evidence is also omitted. Exact values remain in the stored call
arguments. The formatter does not truncate or rewrite model-authored titles or
included notes.

The context token meter must count the request-only injected suffix in `User
input`. Fixtures measure the
complete serialized request rather than adding isolated component counts. The
ordinary maximum-bound projection has a target ceiling of `1,000` tokens. If a
valid adversarial Unicode fixture exceeds that target after nonessential notes
are omitted, retain the lossless titles and record the exact justified
exception; do not silently alter task state. Typical eight-item fixtures should
remain near `250` projection tokens or less.

The system prompt may contain concise stable guidance that the foundation tool
exists, but it never contains the mutable current list.

### 6.4 Model-maintained state and expected staleness

A successful `lc_todo_write` result proves only that LC accepted that snapshot.
It does not prove that the snapshot still matches later work. A model can run
more tools, refine or replace a plan, finish the requested work, and omit a
final todo update. The final answer and subsequent tool evidence can therefore
be newer than the latest accepted todo snapshot. This is an expected property
of optional model-maintained bookkeeping, especially during long tool loops.
Completion evidence is also model-maintained metadata. LC does not verify the
claim against tool results or external state.

LC preserves that snapshot exactly instead of guessing. It does not:

- Mark tasks completed from successful tool results.
- Derive `stalled`, `deferred`, `pass_to_next_turn`, or another list lifecycle
  value.
- Treat an incomplete snapshot as proof that the model must continue working.
- Prevent or delay the final response.
- Start another model call solely to update todo state.
- Add a stale-state warning or another mandatory reconciliation instruction to
  the model-visible prompt or skill.

When Tool History hides the source call, the normal request projection can
carry the latest incomplete model-authored snapshot into a later request. The
projection remains saved task state, not a new user request or a command to
repeat work. The next model can reconcile it against the user request, final
answer, and available tool evidence. `blocked` remains a task-level state with
a required reason; it is not a list-level lifecycle mechanism.

## 7. Preview Overlay contract

### 7.1 Shared snapshot map

One pure shared selector builds the successful snapshot data used by both the
request pipeline and the UI; `ChatView` memoizes its UI map. For any selected
assistant message, the todo tab resolves the latest state of each logical list
from the same user turn at or before that message. Stable-ID updates match when a
strict majority of titles at those IDs remain unchanged. A longer replacement
can also match when unchanged titles retain their relative order, form a strict
majority of the earlier snapshot, and cover at least half of the longer one.
This avoids duplicate sections when a model inserts tasks and renumbers later
IDs. The growth rule is directional, so a shorter nested or sub-task list stays
separate; unrelated lists that reuse IDs also stay separate. Status, note, and
task-order changes do not create a duplicate section. Distinct lists retain
first-seen order. If that turn has no todo update at or before the selected
message, the tab has no snapshot and renders its empty state. It must not show
an inherited snapshot from an earlier turn or a future snapshot from a later
assistant message or user turn.

An assistant bubble receives only an item count and callback for todo
availability; it does not receive the full snapshot object. The snapshot map
remains owned by `ChatView`. A bubble gets a task-list button only when that
assistant message directly owns at least one successful `lc_todo_write`
snapshot. The button uses the shared preview-button badge and shows the item
count from the last directly owned snapshot when it contains at least two
items, like the Tools button. Invalid, failed, interrupted, and merely inherited
state do not create a bubble action.

The `4,096`-message selector bound applies consistently to request and UI
resolution. Reaching the bound degrades to no resolved snapshot; it does not
perform an unbounded render-time scan.

### 7.2 Controlled third tab

Extend the Preview Overlay tab type to:

```ts
type Tab = 'reasoning' | 'tools' | 'todo';
```

`ChatView` owns the single authoritative active-tab state. `PreviewOverlay` is
controlled through `activeTab` and `onTabChange`; it does not retain a second
independent tab state. Direct-shortcut re-presses and `Ctrl+Arrow` navigation
therefore read the displayed tab rather than a stale requested default.

The tab order is Reasoning, Tools, To do list. The overlay receives the ordered
logical-list snapshots resolved at the selected assistant message and renders
them through a dedicated `TodoBody` component. **Settings → Chat → To-do list
preview** selects the presentation. **latest only** is the default and passes
only the final resolved snapshot to the overlay; **all updates** passes the
complete resolved multi-list set. The setting is a display preference: it does
not change the shared snapshot index, stored messages, or model projection.
Each distinct task set in the presented set is a separate list section. LC does
not infer a parent or child relationship between sections. The body shows:

- Completed and total counts.
- A `List n:` prefix on each summary when more than one list is visible.
- Every task in declared list order.
- A clear icon and an accessible status label for not started, in progress,
  blocked, and completed. Status text is not repeated visually below each row.
- An accent-tinted background and border on the in-progress row.
- The bounded note when present in the stored snapshot.
- Completion evidence below its completed task when the model supplied it.
- A concise empty state when no snapshot exists at that conversation point.

The initial view is read-only. It uses semantic list markup, accessible labels,
keyboard focus, and existing overlay scrolling. Copy produces the ordered
plain-text task lists for exactly the snapshots visible under the current
preference.

`showOnlyLatestTodoList` is persisted in the settings store and included in
portable settings exports. New settings, Reset to defaults, persisted settings
that predate the field, and version-1 portable settings without the optional
field all resolve to `true` (**latest only**). An explicitly saved `false`
preserves **all updates**.

The tab is a historical view of accepted model-authored state. It does not
claim that an incomplete item remains unfinished after later tools or final
assistant text.

Phase-driven selection can choose Reasoning or Tools until the user selects a
tab directly. A direct shortcut, bubble action, or tab click then keeps that tab
selected during later tool activity for the same streaming bubble. A new
streaming bubble resets this manual override. Only a todo button, todo shortcut,
or manual tab click selects the todo tab.

### 7.3 Bubble and overlay anchors

Add a checklist icon after the Reasoning and Tools buttons in an assistant
bubble's metadata row. Its label and tooltip are `Show to do list`. Activating
it opens and implicitly pins the shared overlay at the todo tab for that bubble,
using the same close and pin behavior as the existing buttons. Reasoning,
Tools, and To do list use one shared preview-button style for their normal,
bubble-hover, direct-hover, and focus states. Stroke and fill handling remains
specific to each SVG type.

Generalize the overlay anchor selection so it is not conditional on reasoning
content. For each active tab, the floating fallback is the most recent assistant
message with matching reasoning, tool-call, or directly owned todo-snapshot
content. An explicit or pinned anchor remains selected until the existing close,
unpin, or navigation behavior changes it. This also lets the Tools tab work for
models that produced tool calls without reasoning content.

### 7.4 Shortcuts and layouts

The direct shortcuts are:

| Platform | Shortcut | Matching rule |
|---|---|---|
| Windows and Linux | `Ctrl+Alt+P` | Control + Alt, physical `KeyP`, semantic key `p` or `P`, no composition or `AltGraph` |
| macOS | `Cmd+Option+P` | Meta + Alt and physical `KeyP`; accept the Option-produced semantic key such as `π` |

Existing shortcuts remain:

| Shortcut | Result |
|---|---|
| `Ctrl+P` or `Cmd+P` | Open Reasoning for the last matching bubble |
| `Ctrl+Shift+P` or `Cmd+Shift+P` | Open Tools for the last matching bubble |

When the overlay is open, a direct shortcut switches the controlled active tab
without changing an explicitly selected bubble. The todo body then shows the
same-turn snapshots selected by the To-do list preview preference, or the empty
state when the selected turn has no update yet.

The three-tab header follows the chat container rather than the application
viewport. Below `550px`, tab text labels fold away while the icons and count
badges remain. Below `350px`, the Tools and To do list count badges also fold
away. The three tab buttons, their accessible names, active state, and pulse
indicators remain available at both steps. Within the Tools tab, each log row's
localized date and time folds away below `500px`; the tool name, status,
duration, permission summary, arguments, and result remain available.

`Ctrl+ArrowUp` and `Ctrl+ArrowDown` continue to navigate between matching
historical assistant bubbles. The todo tab navigates between bubbles that
directly own successful todo snapshots. Update the shortcut-panel wording to
say previous and next matching bubbles accurately, and show platform-correct
Mac labels.

Shortcut tests cover US English, German, Polish, and French Windows-style key
events plus macOS Option behavior. The implementation may inspect
`getModifierState('AltGraph')` as a guard, but must not rely on that signal alone;
the physical code, semantic key, and composition state form the non-Mac match.

## 8. Implemented phases

Phases 0 through 5 are implemented. The phase order below is retained as the
rollout and maintenance record.

### Phase 0 — baseline, payload, and ownership fixtures

1. Add focused tests for current exposure, authorization, validation, result,
   Tool History, provider gating, and overlay behavior before changing them.
2. Add a pure message fixture with successful, failed, interrupted, batched,
   imported, notice-prefixed, repaired, and archived-turn todo calls.
3. Record the current complete serialized tool payload, system prompt, and full
   request fixtures. Do not infer totals from per-tool counts.
4. Identify every model-visible todo sentence and assign it to the tool
   description, schema, error mapping, request projection, or core cheat sheet.

Exit gate: baseline fixtures cover the provider/orchestrator mismatch, result
prefixes, Tool History boundary, and current UI ownership before behavior moves.

### Phase 1 — foundation policy and end-to-end execution

1. Add the canonical foundation category and membership list.
2. Move `lc_todo_write` out of Web Access.
3. Expose it whenever Workspace is on and the provider supports tools.
4. Make resolved exposure drive provider prompt and orchestration gates.
5. Set `grantScope: 'none'`, `promptPolicy: 'no_prompt'`, and conversation-state
   mutability.
6. Remove it from grant initialization, normalization, and the visible Web
   Access list.
7. Move its cheat-sheet sentence into the exact core Operating loop section.
8. Update policy, exposure, support-report, documentation, and token fixtures.

Exit gate: a Workspace-on/all-optional-categories-off integration fixture sends
a real todo call through a tool-capable provider, executes it without a popup,
and returns it. Workspace-off and tool-incapable-provider fixtures do not expose
or execute it.

### Phase 2 — strict task-state contract

1. Add explicit strict outer and item schemas with stable positive safe integer
   IDs, bounded trimmed titles, `blocked`, and bounded trimmed optional notes.
2. Share normalization and schema parsing across execution, selector, UI, and
   tests.
3. Reduce the list bound to 20.
4. Replace warning-only checks with precise schema-level validation.
5. Require a note for every blocked task.
6. Return `completed`, `blocked`, and `total` counts only.
7. Remove old sequential-ID guidance and update invalid-argument remedies and
   model-visible STE fixtures.

Exit gate: every invalid state returns one precise non-retryable validation
result, unknown keys are rejected, valid sparse IDs survive unchanged, and a
successful wire exchange contains one list copy in call arguments.

### Phase 3 — snapshot resolver and model continuity

1. Add the bounded shared result decoder and stored-message snapshot selector.
2. Define deterministic declared-call order and failure behavior.
3. Reconstruct the list from normalized successful call arguments.
4. Decide projection from the actual finalized Tool History request boundary.
5. Append the bounded projection to the latest real user message's request-only
   copy; do not alter the system prompt or stored message.
6. Suppress duplication for active successful updates and omit closed plans.
7. Count the request suffix in `TokenMeter` as `User input` and keep normal Tool History stubbing
   and retrieval unchanged.
8. Cover reload, export/import, fork, retry, edited history, crash repair, and
   Tool History enabled and disabled.
9. Add exact complete-request fixtures for no snapshot, surviving call
   arguments, ordinary projection, maximum projection, and adversarial Unicode.

Exit gate: a model can perform a later complete-list update without calling
Tool History, every request contains at most one complete current list, mutable
state does not affect the system-prompt cache prefix, and the projection meets
the stated measured budget or records a justified lossless-data exception.

### Phase 4 — task-list UI and shortcuts

1. Add the pure per-bubble snapshot map and typed `TodoBody` renderer.
2. Lift active tab state into `ChatView` and make `PreviewOverlay` controlled.
3. Generalize overlay anchors beyond reasoning messages.
4. Add the third Preview Overlay tab and copy representation.
5. Add the conditional assistant-bubble checklist button with item-count and
   callback props only. Reuse the Tools count badge.
6. Add platform-aware `Ctrl+Alt+P` and `Cmd+Option+P` matching.
7. Extend historical bubble navigation for the todo tab.
8. Update keyboard-shortcut documentation and accessible labels.
9. Add component, resolver, shortcut, focus, copy, and overlay-state tests with a
   jsdom/React `act` harness.

Exit gate: the todo tab never leaks a future snapshot, does not appear as a
bubble action after a failed call, works for tool-only non-reasoning bubbles,
and does not disturb reasoning or tool-tab auto-switch behavior.

### Phase 5 — integration and documentation

1. Update the tool reference, error handling, policy model, module guide, LC
   Tool Cheat Sheet, keyboard/overlay reference, shortcut modal, and synchronized
   generated references.
2. Register new tests in `package.json` and the repository's `check:tests` and
   documentation synchronization checks.
3. Run focused policy, schema, snapshot, request-projection, Tool History, and UI
   tests during implementation.
4. Run the complete test, build, lint, documentation, import, test-registry,
   token, and diff checks.
5. Record complete-payload and complete-request measurements and justify any
   projection-bound exception.
6. Publish this engineering reference only for phases that pass their exit
   gates.

## 9. Test matrix

At minimum, automated tests cover:

- Workspace off, Workspace on with all categories off, provider tool capability
  on and off, and every optional category combination.
- A real foundation-only tool round, including callbacks, round counts, returned
  calls, no grant row, no popup, and direct authorization.
- Stale todo grants ignored on read and removed on the next grant write.
- One through 20 tasks and rejection at 21.
- Strict unknown-key rejection for outer and item objects.
- Stable sparse IDs, reordered IDs, duplicate IDs, fractional IDs, unsafe IDs,
  and non-positive IDs.
- Every status, zero and multiple in-progress tasks, blocked with and without a
  note, completion evidence warnings, invisible evidence, Unicode, and every
  length boundary.
- Successful counts-only output with no duplicated todo list.
- Successful, failed, interrupted, aborted, repeated, and batched calls.
- Zero, one, and many recognized LC notice prefixes; unknown and over-bound
  prefixes; malformed envelopes; `tool_is_error`; and repaired result content.
- Selection of the last successful call in declared batch order rather than
  result completion order.
- Forward-growing complete-list replacements whose inserted tasks renumber
  later IDs, plus a shorter nested list that must remain a separate UI section.
- Tool History enabled and disabled, current and archived turns, exact post-
  stubbing source-call visibility, and bounded retrieval.
- Exactly one current list when call arguments survive, exactly one projection
  when they are stubbed, no stale projection after an active success, and no
  automatic projection for an all-completed plan.
- Persistence across reload, export/import, fork, edit-and-resend, deletion, and
  crash repair under the current schema only.
- No-snapshot, ordinary-snapshot, maximum-snapshot, and adversarial-Unicode
  complete request and token fixtures.
- Bubble-button presence, historical point-in-time resolution, selector bound,
  no future-state leakage, controlled tab selection, copy, focus, pin, close,
  and resize behavior.
- Tool-tab anchoring for an assistant message with tool calls and no reasoning.
- `Ctrl+P`, `Ctrl+Shift+P`, non-Mac `Ctrl+Alt+P`, macOS
  `Cmd+Option+P`, `AltGraph`, composition, international layouts, and
  previous/next matching-bubble navigation.
- Structural STE coverage for every new LC-authored description, validation
  remedy, projection sentence, omitted-note notice, tooltip, label, and empty
  state. Model-authored todo data is excluded from this assertion.

## 10. Non-goals

This work does not add:

- Partial add, edit, delete, reorder, or status-only operations.
- Priorities, due dates, dependencies, assignments, nested tasks, or subtasks.
- A global task database or task state outside the conversation.
- Direct user editing in the todo tab.
- A separate snapshot ID, list mode, or todo-history tool.
- A legacy todo parser, migration, compatibility state, or database migration.
- Automatic claims that a task is complete.
- Automatic execution of the next task.
- List-level lifecycle values such as `stalled`, `deferred`,
  `pass_to_next_turn`, or `closed`.
- Automatic stale-state inference, reconciliation reminders, final-response
  gates, or extra model calls for todo bookkeeping.
- Mutable todo state in the system prompt or a synthetic user message.
- Changes to generic Tool History stubbing or archive formats.
- Whiteboards, shared editing, conflict resolution, or whiteboard history.

## 11. Code ownership

| Area | Expected owner |
|---|---|
| Schema, shared parsing, and handler | `src/modules/tool-engine/builtin/todo_write.ts`, `src/modules/tool-engine/todo-state.ts`, and `src/modules/tool-engine/argument-normalization.ts` |
| Foundation membership and tool-name facts | `src/modules/tool-engine/registry-names.ts` and registry fact checks |
| Exposure and authorization | `src/modules/tool-engine/policy.ts` and policy/grant modules |
| Provider and orchestration gates | `src/modules/chat-pipeline/provider-capability.ts`, tool payload code, and orchestrator |
| Stored-result notice decoder | `src/modules/tool-engine/tool-result-content.ts` |
| Snapshot selection | `src/modules/tool-engine/todo-state.ts` |
| Request-tail projection | `src/modules/tool-engine/todo-state.ts` and `src/modules/chat-pipeline/orchestrator.ts` |
| Token accounting | `TokenMeter` context-projection accounting and complete-request fixtures |
| Bubble integration and controlled tab state | `src/ui/chat/MessageBubble.tsx`, `src/ui/chat/ChatView.tsx`, and `src/ui/chat/preview-shortcuts.ts` |
| Overlay tab | `src/ui/tools/PreviewOverlay.tsx` and `src/ui/tools/TodoBody.tsx` |
| Shortcuts | `src/ui/chat/preview-shortcuts.ts`, `src/ui/chat/ChatView.tsx`, and `src/ui/shared/KeyboardShortcutsModal.tsx` |
| Cross-tool workflow guidance | `skills/lc_skill_lc_tools.md` and generated built-in content |
| Engineering references | `docs/tools/`, `docs/keyboard-and-overlays.md`, `docs/modules.md`, and synchronized reference checks |

The result decoder, schema parser, and snapshot selector must be pure and shared
by model-context and UI consumers. The React layer must not create a second
interpretation of todo results. The orchestrator owns request injection; the
projection formatter owns only deterministic text formatting.

## 12. Implementation disposition

The implementation uses these decisions:

- Adopt strict outer and item schemas, one shared normalizer/schema, counts-only
  results, deterministic declared-batch order, exact Tool History boundary
  detection, bounded result-prefix decoding, concrete cheat-sheet placement,
  controlled tab state, generalized anchors, platform-aware shortcut matching,
  and complete-request token fixtures.
- Reject unknown object properties with `.strict()`. Default Zod objects strip
  unknown properties.
- Keep the existing optional-absence normalizer and add schema-owned trimming;
  do not introduce a competing absence-normalization layer.
- Use a request-tail projection on the latest real user message rather than a
  cache-busting system-prompt projection or a synthetic user message.
- Lift tab state into `ChatView`; a second shortcut nonce is unnecessary once
  the overlay has one controlled tab owner.
- Do not add legacy compatibility because LC has never shipped.

## 13. Implementation measurements

Exact token fixtures use the repository tokenizer and complete serialized
payloads. The current all-category fixed surface is 7,499 tokens. A request
without todo state is 1,402 tokens. A surviving todo call produces 1,637
tokens.

A typical eight-item projection is 183 tokens. Its complete archived request
is 1,712 tokens. The 20-item projection is 927 tokens. Its complete request is
2,494 tokens.

The adversarial Unicode projection is 2,731 tokens. Its complete request is
4,297 tokens. This lossless-data case exceeds the 1,000-token projection target.
LC retains exact titles without truncation or rewriting.

Repository tests own the policy, schema, snapshot, request, token, UI, and
shortcut gates. Documentation, import, build, and lint commands provide the
remaining repository gates.
