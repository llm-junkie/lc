# A10 — Overlay and input ownership

**Template code:** `A10` · **Version:** 1.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A10 v1.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

**Siblings:** [`a09-theme-and-visual-parity.md`](./a09-theme-and-visual-parity.md)
for appearance.
[`a15-accessibility-and-assistive-tech.md`](./a15-accessibility-and-assistive-tech.md)
for semantic and assistive-technology behavior.
[`a06-cpu-and-responsiveness.md`](./a06-cpu-and-responsiveness.md) for render
cost and auto-scroll cadence cost.

---

## Scope

**In.** The overlay stack, the modal gate, Escape and focus handling, the body
scroll lock, the keybinding layer, the preview and diagram viewers, and every
component that can appear above the chat. It includes the conversation-level
Whiteboard overlay, its Preview Overlay exclusion, its fail-closed unsaved-edit
guard, and its nested discard confirmation. It includes the application FIFO
that presents permission and Ask User prompts from several conversations, the
conversation identity shown by those prompts, and conversation-scoped preview,
side-panel, Workspace, scroll, edit, and draft ownership during navigation.

**Out.** How overlays look (sibling). Rendering and auto-scroll cadence cost
(sibling). Detailed assistive-technology semantics (sibling).

## Invariants

1. **Overlay ownership.** While an overlay is up, it owns Escape *and* pointer
   input. Its declared dismissal policy decides whether Escape or a backdrop
   click closes it. The ask-user modal deliberately ignores both and settles
   only through an explicit answer or skip action. Closing an overlay releases
   exactly what it took, including the body scroll lock. Closing it does not
   release what a still-open overlay took.
2. **Keyboard and pointer are owned together.** Owning one and not the other is
   the partial-ownership defect. The symptom is a modal that blocks clicks while
   a shortcut fires underneath it.
3. **Nesting is a stack, not a boolean.** Opening a second overlay does not
   orphan the handlers of the first. Closing the second restores ownership to
   the first, not to the page.
4. **Focus follows the overlay's declared modality.** A modal dialog traps
   focus, and restores it to the invoker. A non-modal viewer has an explicit
   focus policy, and never strands focus. Detailed semantics and screen-reader
   evidence belong to A15.
5. **Recoverable viewers.** A failed preview, a failed dynamic import, or
   invalid diagram source produces a scoped, retryable error. None of them
   unmounts the application.
6. **Shortcuts obey the addressed scope.** A shortcut cannot mutate the
   conversation or application state guarded by a live owner. Navigation,
   foreground selection, and New chat remain available when only a sibling is
   generating. Application-wide profile, model, import, reset, and corpus
   mutations remain blocked while any owner makes them unsafe.
7. **User scroll intent wins over auto-follow.** A streaming preview follows new
   content only while it is already near the bottom. Scrolling up transfers
   ownership to the user until the user deliberately returns. Tab switches,
   resize, pinning, and raw stream deltas do not take that ownership back
   silently. The transcript restores a saved position once when its conversation
   becomes active; it does not replay active `scrollTop` updates into the DOM.
   Send performs one instant bottom jump. After that, no application code moves
   the transcript for reasoning or visible answer updates; the user owns its
   position. A successfully completed foreground turn performs one smooth
   bottom scroll; cancellation, failure, background completion, and loading an
   already-completed turn do not. Native scroll anchoring remains enabled, with
   a conversation-scoped real-bubble fallback when the bottom spacer fills the
   viewport, so resizing and text reflow keep the same visible content in place.
8. **Preview tab ownership is stable.** Reasoning, Tools, and To do list share
   one docked preview. A tab chosen by the user does not switch because a new
   tool call or to-do update arrives. `Ctrl+P`, `Ctrl+Shift+P`, and
   `Ctrl+Alt+P` select their documented tabs, and bubble actions use the same
   active-message and pin rules.
9. **Whiteboard and Preview never stack.** Opening Whiteboard suppresses
   Preview without clearing Preview pin, message selection, tab, or streaming
   dismissal state. Closing Whiteboard recomputes ordinary Preview visibility:
   a pinned Preview returns immediately, and an unpinned Preview returns only
   when its existing auto-show condition still holds.
10. **Unsaved Whiteboard text fails closed on every exit.** Close, Escape,
    backdrop, conversation switch, new conversation, conversation deletion,
    and Preview or Settings opening route through the in-app discard owner. An
    unavailable, rejected, or failed confirmation denies the controlled exit
    and keeps the editor mounted. Reload uses the platform `beforeunload` guard;
    parent unmount resolves any pending in-app request as denied. The nested
    confirmation owns focus and input until it resolves.
11. **Each Whiteboard pane owns its selection and scroll.** Model and user
    history controls do not move the sibling pane. A live model update follows
    only while the current head is selected and the pane was already anchored
    at the bottom. Historical selection, user scroll intent, focus, and the
    sibling pane remain stable.
12. **Interactive presentation is strict application FIFO.** Permission and
    Ask User prompts from all conversations share one visible owner. The prompt
    names its requesting chat, queued prompts cannot displace it, and enqueue,
    promotion, and answer delivery each revalidate the generation owner.
    Cancelling a queued or visible request cannot deliver its later answer to a
    sibling or successor.
13. **Conversation switching restores presentation state, not modal authority.**
    Draft, edit, scroll/follow, Workspace, side-panel, preview tab, selection,
    and pin state follow their chat. A global interactive prompt remains owned
    by its requesting generation and does not silently become the foreground
    chat's prompt. Deleting an owner fails closed and advances the FIFO safely.

## Check matrix

| Axis | Required variations |
|---|---|
| Single overlay | Each overlay type: permission modal, ask-user modal, settings, preview, Whiteboard, diagram viewer, lightbox, confirmation |
| Nesting | A file-click confirmation into a preview, a diagram viewer opened from inside a text preview, a permission prompt over chat, and three deep |
| Dismissal | Escape, backdrop click, close button, programmatic close, and a close while a sibling is open. For ask-user, prove that Escape and backdrop clicks do not dismiss, while Skip updates only the current question and Done settles exactly once |
| Focus | Modal and non-modal policy, Tab and Shift-Tab to the edges, and focus restoration after each dismissal route |
| Failure | Forced dynamic-import failure, invalid Mermaid or Excalidraw source, an oversized image |
| Interaction | Mouse, trackpad, and keyboard operation of resize handles and scroll containers |
| Preview follow | Near the bottom, user scrolled up, return to the bottom, a Reasoning, Tools, or To do list tab switch, a new tool call while To do list is active, resize, pin and unpin, and the bounded live tail crossing its threshold |
| Preview selection | Each bubble action and shortcut, an empty tab, one and several to-do lists, **latest only** as the new/reset/legacy-import default, explicit **all updates**, Copy under both preferences, a manually selected tab during new tool activity, and next/previous matching-bubble navigation |
| During generation | Every overlay, opened while a response streams |
| Cross-conversation prompt queue | Permission then Ask User, Ask User then permission, three requesting chats, foreground and background requester, switch while visible, abort while queued, abort while visible, owner deletion, replacement generation, host teardown, attention expiry, and stale answer delivery. Verify both modals' captured chat title and exact model ID; also verify the permission modal's displayed tool and path targets, collapsed argument state, focus, FIFO order, and exact settlement |
| Conversation-scoped presentation | Three chats with distinct drafts, attachments, edits, scroll/follow positions, Workspace sections, side-panel state, preview tabs, selected messages, and pin state; switch during streaming, capacity refusal, completion, deletion, and return. Include Send followed by reasoning and visible answer growth; assert one instant bottom jump, no movement during streaming, then one smooth bottom scroll after successful foreground completion. Prove cancellation, failure, background completion, and completed-turn loading do not trigger it. Resize across several wrapping thresholds and assert the same visible content remains anchored. No state crosses owners |
| Whiteboard dismissal | Clean and unsaved editor through close, Escape, backdrop, conversation switch, new conversation, deletion, Preview opening, Settings opening, reload, parent unmount, failed confirmation host, and confirm/keep-editing choices. Assert the in-app guard on controlled exits, `beforeunload` on reload, denied pending requests on unmount, and focus restoration after completed close |
| Whiteboard/Preview exclusion | Preview pinned and unpinned, each selected tab and message, auto-show true and false, new streaming messages while Whiteboard is open, opening Preview with clean and dirty Whiteboard state, and closing each overlay in both orders |
| Whiteboard pane ownership | Independent previous and next controls, current and historical selections, an unavailable version, model live append while anchored and scrolled up, a newer-version notice while history is selected, user editing during generation, and independent scroll positions |

## Domain-specific evidence rules

- **Record the event phase and the surviving handlers.** "Escape worked" is not
  enough. The bug class here is a handler that still exists, not one that never
  ran.
- **Test nesting explicitly.** Single-overlay behavior is almost always correct.
  The defects are in release order.
- **Record prompt ownership at all three fences.** A correctly labelled visible
  modal does not prove that a queued request was valid when promoted or that a
  late answer reached the same generation. Capture enqueue, display, and
  delivery identities separately.
- **A scroll-lock claim needs the body's computed state** before, during, and
  after. Include the case with two overlays open.
- **An auto-follow claim needs scroll positions over time.** Record `scrollTop`,
  `scrollHeight`, and `clientHeight` before the append, and after the
  rendered-cadence tick. Do this near the bottom, and again after the user
  scrolls up. Testing only the final position cannot separate following from a
  yank.
- **Test the nested Whiteboard confirmation as its own modal.** While it is
  present, prove that Tab and Shift-Tab cannot reach the editor, owner tabs, active board, or
  page, and that Escape belongs to the confirmation policy. After keep-editing
  and after discard, inspect the active element and every surviving stack
  registration. A visible prompt alone does not prove fail-closed ownership.

## Known-load-bearing context

- [`keyboard-and-overlays.md`](../../keyboard-and-overlays.md) states which
  surface owns a key press, the overlay stack, and the propagation rules. It
  states its own rules as non-optional. A disagreement is a finding in the code
  or in the document, and the audit must say which.
- Auto-scroll cadence is a performance concern, and A06 owns it. Whether that
  cadence respects the user's position and active tab is interaction ownership,
  and this template owns it.
