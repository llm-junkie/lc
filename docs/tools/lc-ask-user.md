# `lc_ask_user` implementation contract

| Field | Value |
|---|---|
| Status | Implemented. Automated gates cover the contract. |
| Updated | 2026-08-31 |
| Scope | Foundation exposure, structured user questions, same-turn continuation, FIFO interaction ownership, and modal UI |

## 1. Outcome

`lc_ask_user` lets the model ask a small set of structured questions when a
missing user choice would materially change the work. LC pauses the current
tool round, shows a modal, returns the user's selections, custom text, or
explicit skips as the tool result, and then lets the model continue the same
turn.

The first version stays deliberately small:

- Each question accepts one listed choice, one custom answer, or Skip.
- A call contains from one through three questions.
- The modal uses visible previous and next controls for multiple questions.
- The result uses the existing `ToolResultEnvelope` and normal tool-message
  storage.
- The tool is available with the Workspace master switch. It has no category
  toggle, settings row, grant, or permission prompt.

### 1.1 Implementation record

The handler uses a typed interaction capability, the app mounts one global
presentation host, and the orchestrator enforces mixed-batch suppression before
execution. Permission and ask-user requests from every conversation enter one
strict FIFO application coordinator before reaching their modal host. A sole
valid and exposed `lc_ask_user` call has no ordinary operational deadline while
the user decides, but the interaction coordinator applies a separate 30-minute
absolute attention cap. The existing result envelope, provider tool-message
protocol, and generic Tool History stubbing remain unchanged.

The current shared fixture records a 552-token two-root system prompt. The
complete fixed prompt and tool surface is 7,499 tokens. The
generated LC Tool Cheat Sheet is 889 tokens. `tool-guidance-token.test.ts` owns
these values.

Automated modal tests cover choice navigation, custom text, Skip, and the Done
gate. They also cover focus, cleanup, and interaction ownership.

## 2. Settled decisions

These decisions are the implementation contract:

1. The tool name is `lc_ask_user`.
2. Workspace off means that the tool is not exposed.
3. Workspace on with a tool-capable provider means that the tool is exposed,
   independently of every optional category toggle.
4. The tool is a foundation tool with `no_prompt` authorization and no
   persisted grant.
5. Each choice has a required `title` and an optional `description`.
6. Choice selection is single-select. This version does not add multi-select.
   The user can express combinations such as `1 and 3` or `all but 1` through
   the custom answer.
7. Custom answer and Skip are always available for the current question.
8. Every question must be answered or explicitly skipped before Done is
   enabled.
9. Previous and next navigation preserves the state of every question.
10. Escape does nothing while the modal is open. A backdrop click does
    nothing. The modal has no close button.
11. The interaction has no ordinary tool-operation response deadline. A
    separate 30-minute absolute attention cap bounds its queued and visible
    lifetime so an abandoned prompt cannot occupy generation capacity forever.
12. A parent generation abort, conversation teardown, modal-host teardown, or
    app close must still settle the pending call. No promise can remain
    unresolved after its owner is gone.
13. `lc_ask_user` must be the only call in its model-declared batch. A mixed
    batch is rejected before any sibling executes.
14. The assistant tool call, one matching tool result, and the next assistant
    request retain the normal provider protocol. LC does not insert a
    synthetic user message or a second user bubble.
15. Selected and entered answers are user-authored input even though provider
    protocol carries them in a `role: 'tool'` result. Model guidance must state
    that provenance.
16. The result is stored, exported, stubbed by Tool History, and displayed in
    the Tools tab like any other tool result. When Tool History hides a
    completed turn, the answer also leaves automatic model context and remains
    retrievable through `lc_tool_history`. `lc_ask_user` is for a decision that
    the model applies in the current turn; its result receives no special
    archive exemption or automatic projection. This version adds no separate
    Q&A tab, database table, revision ID, or history controller.
17. LC renders question text, titles, descriptions, and custom answers as plain
    text. It does not interpret them as HTML or Markdown.
18. One modal host serves every conversation. The modal identifies the owning
    conversation so a question from a background generation is not ambiguous.
    The host presents only the interaction promoted by the application FIFO.
19. Conversation, generation, assistant, and tool-call ownership is checked at
    enqueue, visibility, and result delivery. Cancelling a generation removes
    its queued request. A host-level Busy result remains a defensive fail-closed
    fallback and is not the normal concurrent-request path.

## 3. Tool contract

### 3.1 Input

The model-facing input is:

```ts
interface AskUserInput {
  questions: Array<{
    id: number;
    question: string;
    choices: Array<{
      title: string;
      description?: string;
    }>;
  }>;
}
```

The initial bounds are:

| Field | Bound |
|---|---:|
| `questions` | 1 through 3 |
| question `id` | Positive safe integer, unique in the call |
| `question` | 1 through 240 trimmed characters |
| `choices` | 2 through 5 per question |
| choice `title` | 1 through 80 trimmed characters |
| choice `description` | 1 through 160 trimmed characters when present |
| custom answer | 1 through 500 trimmed characters |

Choice titles must be unique within their question after trimming. They do not
need to be unique across different questions. The outer object, question
objects, and choice objects use strict schemas. Unknown fields are rejected.
Absent optional descriptions are omitted, not serialized as `null`.

The handler shares one typed schema with the modal bridge and tests. It does
not silently renumber IDs, remove choices, truncate text, or choose a default
answer.

Invalid model arguments return the existing error-status envelope with an
`invalid_arguments` issue code and `retryable: false`. `invalid_arguments` is
not a tool-result status. The remedy must identify a correction that can make
the next call valid.

### 3.2 Output

A submitted interaction returns:

```ts
interface AskUserOutput {
  answers: Array<
    | { id: number; answer: string }
    | { id: number; skipped: true }
  >;
}
```

Answers retain input question order. A listed selection returns that choice's
normalized title. A custom answer returns the normalized text entered by the
user. A skip returns only `id` and `skipped: true`. Optional fields are omitted
instead of returned as `null`.

The handler wraps the output in the existing successful
`ToolResultEnvelope`. Skip is a successful user decision, not an error. LC
does not add another status field under `data`.

### 3.3 Stable execution issues

The implementation owns stable issue codes for conditions outside schema
validation:

| Code | Meaning | Retryable |
|---|---|---:|
| `interactive_tool_must_run_alone` | The model declared `lc_ask_user` with another call in the same batch. | `false` for the same batch |
| `ask_user_ui_unavailable` | The modal host was not available after a 5,000 ms registration window or disappeared before display. | `true` |
| `ask_user_ui_busy` | The presentation host unexpectedly received a second request outside normal FIFO arbitration. End this tool round. | `false` |
| `aborted` | The owning generation ended before the user submitted. | `false` |

The existing error-envelope and aborted-envelope helpers remain authoritative.
The implementation must not encode these conditions only in thrown strings.

## 4. Exposure and policy

Add `lc_ask_user` to the canonical foundation membership beside
`lc_todo_write`. `resolveExposure` remains the single source for whether the
tool is serialized and executable. The policy map derives this metadata from
foundation membership; implementation must not add a second hand-written
entry:

```ts
{
  name: 'lc_ask_user',
  category: 'foundation',
  grantScope: 'none',
  promptPolicy: 'no_prompt',
  mutability: 'conversation_state',
  defaultGrantOnRootAdd: false,
}
```

The tool must not appear in File I/O, Shell, Web Access, Skills, Tool
History, or Tool Help settings. Foundation exposure must not cause detailed
`lc_tool_help` exposure by itself. No stale grant is consulted or written for
this tool. Add the canonical tool-name entry with `operational: false`, and do
not add `lc_ask_user` to `OPERATIONAL_TOOL_NAMES` or create a detailed guidance
catalog. These two operational classifications remain distinct. Exact
execution still resolves only through `HANDLERS_BY_NAME`; name correction must
never execute a corrected call.

Insert the handler immediately after `todoWrite` in `BUILTIN_TOOLS`. Registry
order, not foundation-name order, controls serialized payload order. This
preserves every existing tool's relative order and makes the new fixture
deterministic.

Foundation-only fixtures must prove all of the following with every optional
category disabled:

- The foundation-only serialized tool payload contains `lc_get_current_time`,
  `lc_todo_write`, and `lc_ask_user` in registry order.
- A valid `lc_ask_user` call reaches its interaction broker without a
  permission popup.
- Workspace off removes the tool.
- A provider without tool support does not receive it.

## 5. Same-turn interaction lifecycle

### 5.1 Protocol sequence

The provider-visible sequence is:

```text
assistant tool call: lc_ask_user
  -> LC validates the complete batch
  -> LC opens the modal and pauses this tool round
  -> user answers or skips every question and selects Done
  -> matching role: tool result with ToolResultEnvelope
  -> next assistant request in the same turn
```

The user's answer is not inserted into stored user-message content. The normal
tool result is the durable conversation record and preserves provider call/result
pairing.

### 5.2 Interaction broker

The tool engine must not import React UI. Add a typed interaction callback to
`ToolHandlerContext`, backed by an orchestrator-to-UI bridge. The handler:

1. Receives already normalized, validated input.
2. Calls the typed interaction callback. The orchestrator-created callback
   captures the parent generation signal and conversation identity; it does
   not derive them from the ordinary round-scoped `ctx.signal`.
3. Maps a submitted interaction to an `ok` envelope.
4. Maps owner cancellation to the normal `aborted` envelope.
5. Maps unavailable or busy UI to the stable issues in section 3.3.

The callback is optional in non-UI test contexts. Calling the handler without
it returns `ask_user_ui_unavailable`; it does not throw or wait forever.

The orchestrator submits the request to the application-owned interaction
coordinator shared with permission prompts. The queue carries conversation,
generation, assistant, and tool-call identity and validates it before enqueue,
when the request becomes visible, and immediately before result delivery.
Cancellation removes a queued entry and aborts a visible presentation.

`AskUserModal` owns a small module-level presentation bridge independent from
permission decisions, authorization audit records, and permission UI. The app
mounts one global host. The coordinator normally calls that host only after the
prior interaction settles. The host remains single-slot and never replaces an
unresolved request; `ask_user_ui_busy` is a defensive fallback for a call that
bypasses or violates coordinator ownership. The internal bridge request carries
the conversation ID and display title. These fields are UI metadata and are not
added to the model-facing input or tool output.

### 5.3 Timeout and cancellation boundary

The streamed assistant response has already ended when LC waits for the user.
After admission proves that the model-declared batch contains one exact, valid,
exposed `lc_ask_user` call, the round omits its ordinary operational deadline.
The orchestrator-created interaction callback captures the parent generation
signal explicitly rather than deriving ownership from foreground UI state.

Permission and ask-user entries share one strict FIFO. Time spent queued behind
another visible interaction is excluded from operational tool deadlines. A
separate 30-minute absolute attention timer starts when each entry is enqueued
and bounds both queue and presentation time. It settles an abandoned interaction
fail-closed even though Ask User has no ordinary response deadline.

Infrastructure host registration is independently bounded at 5,000 ms, and all
other operational tool calls retain their existing deadlines. After submission,
the next tool round gets a fresh ordinary deadline. The interactive round still
counts toward the configured maximum tool-call rounds for the turn.

On abort or host teardown, the bridge settles once, removes its listeners,
clears modal state, and lets the orchestrator emit the matching terminal tool
result. The normal unanswered-call repair remains a last-resort protocol guard,
not the expected completion path.

## 6. Batch isolation

Batch isolation is an orchestrator admission rule, not a convention that only
appears in the tool description.

After call IDs and names are admitted, but before the execution pool starts,
inspect the model-declared batch. If an exact `lc_ask_user` name appears and
the batch contains any other call, reject the interactive call and execute no
sibling. This also covers two `lc_ask_user` calls in one batch. An unknown name
that merely resembles `lc_ask_user` does not activate the rule and is never
executed under a correction.

Every declared call ID still receives exactly one matching result. Normal
concurrent tool batches continue to persist results in completion order. In
this suppressed-batch path, no handler runs, so LC emits the generated results
in declared call order:

- Otherwise-valid calls receive `interactive_tool_must_run_alone` because LC
  deliberately did not execute them.
- Calls that already failed JSON, schema, duplicate-ID, unknown-name, or
  exposure admission keep their more specific error.
- No grant check, permission prompt, handler, filesystem action, network
  action, or shell action runs for a suppressed sibling.

Tests must use mock handlers that record or fail on invocation to prove that
this rule is a true preflight. Existing completion-order behavior for ordinary
concurrent batches must remain unchanged.

## 7. Modal contract

`AskUserModal` is a purpose-specific global modal. It follows the repository's
overlay and keyboard ownership rules. It must register with the shared overlay
stack instead of adding an independent document-level Escape convention.

### 7.1 Layout and state

The modal contains:

- A `Questions` heading and an `(n/total)` prefix on the current question.
- The owning conversation's display title and the exact model ID, with both
  values highlighted using the accent color.
- The current question.
- Choice cards with a title and an optional muted description.
- A Custom card that reveals a bounded multiline text area. It starts at two
  lines, grows through five lines, and scrolls from line six.
- A left-aligned Skip action for the current question.
- A horizontal paired previous-and-next control in the bottom action row,
  immediately before Done and sized to the same height as the action buttons.
- A Done action that is disabled until each question has an answer or skip.

A listed choice, Custom, and Skip are mutually exclusive for one question.
Selecting one replaces the prior state for that question. Returning to a
question shows its saved state. A selected Custom card with empty text does not
count as answered. When the request has multiple questions, selecting a listed
choice or Skip automatically advances to the next question if one remains.
Custom never advances automatically.

### 7.2 Dismissal and ownership

- The modal has no close icon.
- Escape is captured and prevented while this modal owns the keyboard.
- Backdrop clicks do not dismiss or submit it.
- Skip affects only the current question. It is explicit result data.
- The user submits with Done after answering or skipping every question.
- App or generation teardown aborts the interaction; it does not synthesize a
  skip or submit partial answers.
- The modal is removed immediately after its promise settles.

### 7.3 Accessibility and themes

Use semantic dialog markup with `aria-modal`, a labelled heading, an announced
progress value, accessible choice state, and labelled navigation. Focus moves
to the first actionable control when the modal opens. Tab from the last control
wraps to the first, and Shift+Tab from the first wraps to the last. Focus
returns to the prior focus owner after every settle path. Arrow keys inside the
custom text input continue to edit text; question navigation uses the visible
controls.

Use existing theme tokens for the surface, border, text, muted text, hover,
focus, selected, and disabled states. Do not add hard-coded light or dark
colors. Reuse the existing `.modal-backdrop` and `.modal-card` surface classes.
If implementation introduces a new glass surface class, it must add the
corresponding solid-mode treatment. Verify Solid and Glass material modes,
narrow layout, long bounded text, keyboard-only use, and Windows display
scaling.

## 8. Model-facing guidance

The essential tool description must say, in structurally simple language:

```text
Ask the user when a missing choice can materially change the work.
Send from 1 through 3 questions.
Each question must have from 2 through 5 single-select choices.
The user can select one choice, enter a custom answer, or skip.
Call lc_ask_user alone in a tool-call batch.
Wait for its result before you continue.
```

When the tool is exposed, the system prompt adds this concise provenance rule:

```text
lc_ask_user pauses and returns user input for this turn.
```

The built-in LC Tool Cheat Sheet adds one concise cross-tool workflow sentence
in its core section. It must tell the model to use `lc_ask_user` only when the
missing decision matters and to wait for the result. It must not duplicate the
input schema or become another per-tool manual.

The complete two-root system-prompt fixture must remain at or below `560`
tokens. The generated LC Tool Cheat Sheet must remain from `600` through `900`
tokens. Update the exact full-payload, schema-description, baseline, pilot, and
skill token assertions as deliberate fixture changes. Measure complete
serialized payloads; do not infer totals by adding isolated counts.

Every LC-authored model-visible description, schema description, validation
message, issue message, remedy, system-prompt sentence, and built-in-skill
sentence receives structural STE coverage. The repository does not claim
official ASD-STE100 compliance.

## 9. Implementation record and proof

The following closed phases record the implemented surfaces and the evidence
each phase owns. They are not future work.

### Phase 0 — Contract fixtures and baseline: implemented

- Add exact valid, minimum-bound, maximum-bound, and invalid input fixtures.
- Add exact serialized tool-definition and system-prompt fixtures.
- Add provider-message fixtures for a completed and an aborted interaction.
- Add fixtures that prove `lc_ask_user` requires no permission decision while
  sharing application FIFO ordering and ownership fences with permission
  prompts.
- Update the exact full-payload and skill-token assertions, and record complete
  serialized payload token measurements for the foundation-only and
  representative Workspace configurations. Keep the two-root system prompt at
  or below `500` tokens and the generated skill from `600` through `900`.
- Run the focused existing policy, orchestrator, prompt, and modal tests before
  production changes.

Proof: the fixtures express the accepted contract across schema, provider
messages, prompt payloads, policy, orchestration, and modal behavior.

### Phase 1 — Typed tool and foundation policy: implemented

- Add shared strict input, normalized input, output, and broker-result types.
- Implement the pure handler and stable issue mappings.
- Register the handler and add the canonical foundation name.
- Add its non-operational tool-name entry. Update policy, exposure, exact-name
  execution, payload ordering, grants, canonical support-report names, and
  synchronized tool documentation without adding a detailed help catalog.
- Prove that the tool is exposed and authorized with only Workspace enabled.

Proof: schema, handler, registry, exposure, policy, payload, and grant tests run
without a UI host.

### Phase 2 — Modal and interaction bridge: implemented

- Add the global `AskUserModal` presentation host, typed promise bridge, and
  application interaction coordinator integration.
- Implement selection, Custom, Skip, navigation, Done, chat/model identity,
  complete focus trapping, theme, and teardown behavior.
- Mount the host at the app shell and connect it through
  `ToolHandlerContext`.
- Keep the modal independent from permission authorization and audit state.

Proof: focused component and coordinator tests cover submission,
current-question skip, replacement, navigation persistence, background-chat
and exact-model identity, strict FIFO promotion, ownership fences,
queued cancellation, attention expiry, invalid empty Custom, disabled Done,
Escape, backdrop, host absence, defensive busy host, abort, unmount, initial
focus, forward and reverse Tab wrapping, focus restore, and listener cleanup.

### Phase 3 — Orchestrator isolation and lifecycle: implemented

- Add the before-execution mixed-batch admission rule.
- Omit the ordinary operational deadline only for a sole admitted
  `lc_ask_user` call, retain the coordinator's independent attention timer, and
  plumb the parent generation signal through the typed interaction capability.
- Preserve normal deadlines for every non-interactive call and later round.
- Preserve one result per call ID, completion-order persistence for ordinary
  concurrent batches, declared-order emission for a suppressed mixed batch,
  turn-round counting, generation ownership, and provider message alternation.
- Use deterministic clocks or controlled promises for timeout and reordered
  completion tests. Do not make these tests depend on wall-clock delays.

Proof: integration tests cover same-turn continuation, zero sibling side
effects, ordinary completion-order preservation, declared-order suppressed
results, no ordinary user-response deadline, bounded absolute attention, abort
closure, one round consumed by the interaction, enforcement of
`max_tool_rounds`, and no unanswered call IDs.

### Phase 4 — Guidance, skill, UI polish, and documentation: implemented

- Add the essential tool description and schema descriptions.
- Add the conditional system-prompt provenance text.
- Update `skills/lc_skill_lc_tools.md` and regenerate built-in skill content.
- Extend model-visible structural STE tests.
- Update the tool reference, policy model, tools overview, error handling,
  module map, built-in tool counts, singular foundation-tool wording, and this
  document to match implemented behavior.
- Use the shared theme and solid-background state styles.

Proof: generated artifacts, synchronized documents, structural language checks,
and UI tests cover the settled contract.

### Phase 5 — Closure: implemented and closed

- Run focused tests during each phase.
- Add every new test file to the explicit `npm test` file list in
  `package.json`.
- Run `npm test`, `npm run build`, `npm run check:docs-sync`, `npm run lint`,
  `npm run check:tests`, `npm run check:imports`, and `git diff --check`.
- Run Rust checks only if implementation changes a Rust boundary. This design
  is expected to remain TypeScript-only.
- Report exact payload token measurements and justify any new budget exception.
- Keep the closed contract synchronized with the application interaction
  coordinator and concurrent-conversation ownership model.

Proof: code, tests, generated content, and documentation agree.

## 10. Test matrix

| Area | Required proof |
|---|---|
| Schema | All bounds, trimming, strict keys, unique IDs, unique local titles, and omitted optional descriptions |
| Envelope | Submitted, skipped, invalid, unavailable, defensive non-retryable busy, aborted, and mixed-batch results use stable shapes and codes |
| Exposure | Workspace-only exposure, Workspace-off removal, provider-capability gate, no optional category or Tool Help leak |
| Authorization | No grant read/write and no permission popup |
| Batch | Interactive-only success; mixed, duplicate-interactive, invalid-sibling, and unknown-sibling cases; zero sibling execution |
| Lifecycle | Same-turn continuation, no ordinary response deadline, absolute attention cap, FIFO queue-time accounting, fresh later deadline, owner abort, host teardown, and no dangling promise |
| Protocol | Exact call/result pairing, ordinary completion order, suppressed-batch declared order, no synthetic user message, and valid provider alternation |
| Modal | Choice, Custom, Skip, overwrite, persistence, chat/model identity, navigation, Done gate, Escape, backdrop, complete focus trap, accessibility, and cleanup |
| Storage | Normal stored tool result, export round trip, accepted generic Tool History stubbing and later retrieval, no special projection, and Tools-tab rendering |
| Guidance | Complete payload, conditional system prompt, generated skill, structural STE, and token fixtures |
| Regression | Permission modal, todo foundation tool, operational timeouts, tool limits, unknown names, and name correction remain unchanged |

## 11. Code ownership

The implemented contract is owned by these areas:

- `src/modules/tool-engine/builtin/` for the handler and shared contract.
- `src/modules/tool-engine/registry*.ts`, `policy.ts`, and their tests for
  foundation exposure.
- `src/modules/tool-engine/types.ts` for the typed interaction capability.
- `src/modules/tool-engine/tool-guidance.ts` for the non-operational canonical
  name entry and `src/modules/tool-engine/index.ts` for public exports.
- `src/utils/support-report.ts` for canonical diagnostic naming.
- `src/modules/chat-pipeline/interaction-coordinator.ts`,
  `src/modules/chat-pipeline/orchestrator.ts`, and
  `src/modules/chat-pipeline/tool-round-lifecycle.ts` for FIFO arbitration,
  ownership fences, parent signal, deadline accounting, batch preflight, and
  same-turn continuation.
- `src/ui/tools/AskUserModal.tsx` and focused tests for the global presentation
  host.
- `src/App.tsx` for one host mount and `src/index.css` for modal styling. Reuse
  existing modal surface classes so `src/themes/solid.css` needs no new glass
  override.
- `src/modules/chat-pipeline/system-prompt.ts`, the LC Tool Cheat Sheet source,
  generated skill content, and model-visible tests for guidance.
- `package.json` for the explicit test registry.
- The living tool, policy, error, module, and documentation indexes for the
  completed contract.

No Rust command, sandbox permission, destructive-operation protection, or
provider schema is weakened by this work.
