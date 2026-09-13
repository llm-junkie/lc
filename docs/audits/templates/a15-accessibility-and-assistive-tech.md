# A15 — Accessibility and assistive technology

**Template code:** `A15` · **Version:** 1.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A15 v1.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

**Siblings:** [`a09-theme-and-visual-parity.md`](./a09-theme-and-visual-parity.md)
for visual treatment.
[`a10-overlay-and-input-ownership.md`](./a10-overlay-and-input-ownership.md) for
overlay ownership and modal mechanics.

---

## Scope

**In.** Semantic HTML, and ARIA roles, names, and states. Keyboard-only
operation, visible focus, focus order, and focus restoration. Modal and
non-modal dialogs. Screen-reader announcements, and live and status regions.
Errors, contrast, forced-colors and high-contrast mode, reduced motion, zoom and
text scaling, reflow, touch targets, and assistive-technology behavior across
the app. It includes the Whiteboard launch action, dialog, labelled owner tabs
and active board panel, independent history state, editor, byte-limit feedback, package actions,
live model updates, and nested discard confirmation.
It includes per-chat Sidebar streaming/attention/terminal status, targeted Stop
controls, the collapsed Inbox/Archive activity switch, capacity-disabled Send
with an intact draft, and prompts raised by background conversations.

**Out.** Pixel-level visual parity
([`a09-theme-and-visual-parity.md`](./a09-theme-and-visual-parity.md)). The
overlay stack's ownership of Escape, pointer input, and the scroll lock
([`a10-overlay-and-input-ownership.md`](./a10-overlay-and-input-ownership.md)).

## Invariants

1. **Every control has a usable name and state.** Buttons, inputs, tabs,
   comboboxes, disclosures, status controls, and custom widgets expose their
   purpose and value. They also expose their expanded, selected, and disabled
   state, and their relationship to the accessible tree.
2. **Every core task works by keyboard.** Chat, settings, profile and model
   selection, permissions, structured ask-user questions, reasoning/tool/to-do
   previews, exports, and recovery all have a visible focus path. None of them
   contains an accidental keyboard trap.
3. **Modality is truthful.** A modal dialog traps focus and restores it. A
   non-modal viewer declares its focus policy. Focus never disappears into an
   unmounted or hidden element.
4. **Dynamic state is announced appropriately.** Streaming status, tool
   permission requests, errors, completion, preview failures, and Safe Start
   transitions all use semantic status and live behavior. Color or motion alone
   is not enough.

   A live region announces meaningful phase changes. It does not announce
   per-token content, a rapidly changing counter, or every auto-scroll and
   render tick.
5. **Meaning survives visual modes.** Contrast, borders, icons, text, focus
   indicators, and error and success states stay distinguishable. This holds in
   light and dark, in solid, under reduced motion, and in forced-colors and
   high-contrast modes.
6. **Zoom and text scaling preserve tasks.** At 200% and 400% zoom, and with
   enlarged text, content reflows without hidden controls, clipped dialogs,
   unusable horizontal scrolling, or loss of the composer.
7. **Motion and timing are respectful.** Reduced motion removes non-essential
   animation. No task depends on a transient visual, a hover-only state, or a
   time limit, unless an accessible alternative exists.
8. **Errors are recoverable and understandable.** Validation, network, tool,
   preview, and startup errors identify the problem. They preserve user input
   where that is possible, and they expose a reachable next action.
9. **The complete Whiteboard task is keyboard-owned.** The composer launch
   action follows Attach in its action row and opens with Enter or Space. The
   Workspace disclosure, exposure toggle, and `Open whiteboard` action have
   distinct names and states. The labelled modal traps focus, its nested
   discard confirmation has an isolated trap, and every close route restores
   focus to a connected invoker. Owner tabs, Edit, Save, Cancel, history,
   Import, Export, and guarded links need no pointer. Icon-only composer states
   below 600 px and 470 px retain their accessible names.
10. **Whiteboard live changes do not create announcement or focus churn.** A
    model update never moves focus. It preserves a historical selection and
    announces one bounded newer-version state instead of the document on every
    update. The byte counter is described by the editor; live output announces
    threshold or validation changes, not every keystroke.
11. **Concurrent chat status is attributable and operable.** Each running chat
    exposes its own status and targeted Stop action. Background completion,
    failure, and interaction attention have usable non-color names. Idle
    sibling Rename, Archive, Clone, and Export actions remain keyboard
    reachable while another chat runs.
12. **Capacity refusal preserves the task.** When all configured slots are in
    use, Send exposes the specific reason, keeps the composer and draft usable,
    and becomes available when a slot reopens. The default of two and opt-in
    setting of three are conveyed as one labelled Conversations setting, not as
    unlabeled numeric controls.

## Check matrix

| Axis | Required variations |
|---|---|
| Core surfaces | Chat composer, per-chat Sidebar status and actions, collapsed Inbox/Archive switch, concurrent-chat capacity setting, message actions, settings, profile and model controls, tool permissions, ask-user questions, the Reasoning, Tools, and To do list previews, Whiteboard, exports, Safe Start |
| Keyboard | Tab and Shift-Tab order, Enter and Space, arrows in composite widgets, Escape, the three preview shortcuts during generation, cycling ask-user questions, submitting and skipping, Whiteboard launch/edit/save/cancel/history/import/export/discard, and completing a task with no mouse |
| Focus | First focus, the visible indicator, the modal trap, the nested Whiteboard discard trap, the non-modal viewer, close and route change, live model updates, and restoration after an error and after an async unmount |
| Semantics | Names, roles, values, labels, descriptions, headings, landmarks, table and list structure, selected choices, question position, per-list completion summaries, task status text, task notes and completion evidence, and the disabled and busy states |
| Announcements | Foreground and background streaming start and finish, queued interaction attention, targeted cancellation, capacity refusal and reopening, a long-reasoning preview mode change, an ask-user prompt and question change, a tool request, a denial, an error, completion, to-do status changes without repeated snapshot chatter, Whiteboard newer-version and byte-limit transitions without per-update or per-keystroke chatter, preview load and failure, Safe Start phase and retry, and no per-delta/TPS chatter |
| Visual modes | Light and dark, glass and solid, reduced motion, forced colors and high contrast, keyboard focus, and the error, success, and warning states |
| Scale | 200% and 400% zoom, large text, a narrow viewport, long conversation titles, long model and profile names, the Sidebar status/action slot, compact switch label/count, large dialogs, and the Whiteboard tabbed board with reachable owner and version controls |
| Input | Mouse, keyboard, touch and trackpad, screen reader, browser zoom, packaged desktop webview |

## Domain-specific evidence rules

- **Use a real assistive technology pass.** An automated DOM check can find a
  missing name. It cannot prove focus order or announcement timing, and it
  cannot show whether a screen reader conveys the workflow.
- **Test the task, not the element.** A correctly labelled button is not enough
  when the surrounding workflow needs a pointer to complete.
- **Check async transitions.** Streaming and dynamic imports can move focus, or
  replace status text, after the initial assertion.
- **Use several live chats in the screen-reader pass.** Verify that the current
  chat, each background owner, the requesting conversation for a modal, and the
  target of Stop or a structural action are distinguishable without position,
  color, or motion.
- **Measure announcement cadence.** A live region that eventually says the right
  thing can still make the app unusable when it repeats for every stream delta.
  Record what is spoken during a paced long-reasoning fixture, including the
  threshold crossing and the completion.
- **Record the environment.** Name the browser or webview, the OS accessibility
  settings, the zoom level, the forced-colors mode, the screen reader, and the
  keyboard path used.
- **Run Whiteboard with changing content.** Keep focus in the user editor while
  the model board updates, then keep an older model version selected. Record the
  active element, selected version, scroll positions, and spoken output before
  and after each update. Repeat near the byte limit so the static counter and
  live threshold message can be distinguished.

## Known-load-bearing context

- [`keyboard-and-overlays.md`](../../keyboard-and-overlays.md) holds keyboard
  ownership, propagation, and overlay behavior.
- [`theme/theme-system.md`](../../../theme/theme-system.md) holds the theme
  tokens and the resolution order.
- [`troubleshooting.md`](../../troubleshooting.md) holds the Safe Start states
  and the recovery actions that must stay reachable.
- The long-reasoning preview can announce once, when it switches from Markdown
  to a bounded plain-text tail. The changing tail is visual data, not
  live-region content. Any displayed progress count must also stay outside the
  live region.
