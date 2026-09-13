# A09 — Theme and visual parity

**Template code:** `A09` · **Version:** 1.0 · **Status:** Active

> Codes are stable identifiers. Never reuse a code, and never reassign one.
> Record `A09 v1.0` in the audit that uses this template. A major version change
> means that the invariants or the matrix changed. Audits that ran against
> different majors are not comparable.

---

## Scope

**In.** `index.css`, `solid.css`, the theme token system, the custom-theme
injection path, and every surface listed in the override table in
`theme/theme-system.md`. It includes the Whiteboard launch action, dialog,
owner tabs and active board, Markdown surfaces, editor, history controls, package actions,
notices, and nested discard confirmation.
It includes per-conversation Sidebar streaming, attention, completion, and
failure presentation; row action grids; the collapsed Inbox/Archive switch;
capacity-disabled composer state; and the assistant writing border.

**Out.** Overlay behavior and input ownership (sibling). Layout performance
([`a06-cpu-and-responsiveness.md`](./a06-cpu-and-responsiveness.md)).

## Invariants

1. **Mode parity.** Every surface renders as a finished design in all four
   built-in modes, and under a custom theme. Neither mode inherits a partial
   treatment from the other.
2. **No orphaned glass.** In solid mode, no element retains `backdrop-filter`.
   No surface whose solid replacement is opaque keeps a low-alpha fill that was
   legible only because of blur.
3. **Single override owner.** Every glass surface in `index.css` has exactly one
   owner in `solid.css`. That owner wins by specificity, not by source order.
4. **Live selectors.** Every rule in `solid.css` matches something the app
   renders. A rule that matches nothing is a renamed class, or dead weight.
5. **Token discipline.** Solid overrides reference `--solid-*` tokens, and never
   hardcode a color. Every declared token is used, and every used token is
   declared.
6. **Semantic status.** Color alone never conveys loading, streaming, tool
   activity, a warning, or an error.
7. **Respectful motion.** Indefinitely repeating animation stops under
   `prefers-reduced-motion: reduce`.
8. **Documented contract.** `theme/theme-system.md` and the load-bearing
   comments in `solid.css` describe what the code does.
9. **Whiteboard content stays visually isolated from chat.** The active owner
   board and its editor use opaque or high-contrast surfaces in glass and solid
   modes. Underlying messages cannot reduce Markdown, code, table, notice, or
   focus-indicator readability. Every new glass surface has an explicit solid
   owner.
10. **Sidebar status and actions share one stable slot.** A row reserves only
    the 2x2 action-grid width. Loading, Stop, completion, and failure occupy
    that slot without covering the title or wrapping timestamp/model metadata.
    Hovering an idle row swaps status for its four actions; only the row that
    owns a live generation suppresses structural actions.
11. **Background activity is contextual.** The collapsed switch animates only
    on Inbox and only while another conversation is active. The foreground
    chat's own active bubble remains its indicator. Archive never shows a live
    generation ring.
12. **Terminal symbols have stable geometry and semantics.** Completion uses a
    true accent-colored circle with a centered vector check. Failure retains
    its distinct danger treatment and non-color cue. Neither state changes row
    height or steals the action slot.

## Check matrix

**Presentation modes.** Glass and dark, glass and light, solid and dark, solid
and light, custom on a dark base, custom on a light base. Exercise `materialMode`
through all three settings: `auto`, `glass`, and `solid`. `auto` resolves per
platform (native Mica/Acrylic on Windows, vibrancy on macOS, matte on Linux,
CSS glass on the web), so audit it against the platform's expected floor.

**Surfaces.** Every entry in the `theme-system.md` override table. Every
`index.css` rule that declares `backdrop-filter` or a low-alpha fill. Every rule
in `solid.css`. Include the Reasoning, Tools, and To do list preview tabs, every
to-do status and multi-list separator, the bubble tab badges, and the ask-user
modal with selected, custom-answer, navigation, skip, and disabled states.
Check from both directions, so a rule with no counterpart is found from either
side. Exercise the preview header above `550px`, between `350px` and `550px`,
and below `350px`: labels fold at the first step, Tools and To do list count
badges fold at the second, and all three tab icons remain usable. Exercise Tools
rows at `499px` and `500px`: localized timestamps fold below the boundary while
tool name, status, duration, and disclosure rows remain.

**Multi-conversation Sidebar.** One foreground stream; one background stream;
two background streams; the foreground active with no sibling; completion,
failure, and queued-interaction attention; long titles and model IDs; hover and
selected idle rows; generating and idle siblings; expanded and collapsed
Sidebar; Inbox and Archive; capacity refusal with an intact draft; and custom
accent colors. The status slot matches the action block, metadata stays on one
line, the `11px` attention glyph is centered over the running spinner, and
hovering the compact switch does not shift its label or count.

**Permission modal.** Long and short chat titles, exact model IDs, every tool
name, one and several directory scopes, direct file tools with one and several
files, directory-capable paths without a file block, collapsed and expanded
arguments, and all three decisions. Confirm accent treatment for chat, model,
and tool context in every theme without bolding the surrounding sentence.

**Whiteboard surfaces.** Composer and Workspace launch actions hidden, visible,
focused, disabled, and active; the standard collapsed/expanded Workspace row;
the visually active row with a locked toggle during generation; Model and User
tabs plus the active full-width board; current, historical, pending, unsaved,
live, and missing-version states; long Markdown, code, tables, and guarded
links; editor byte-limit states; footer import/export busy and error states; and
discard confirmation. Exercise the centered owner tabs, active board toolbar,
the shared tabbed layout at wide and narrow widths, circular Attach/Whiteboard
actions below 600 px, and every circular composer action below 470 px.

**Content and state.** Empty, loading, normal, streaming, stopped, refused, and
error. Composer idle, hover, focused, pinned, and side-panel-open. The pinned
and focused states are where override rules are densest. Attachments present and
absent. One forward-growing to-do list with inserted tasks and renumbered later
IDs, a shorter nested list that remains separate, and several distinct same-turn
lists, with completed, in-progress, blocked, and not-started tasks, with notes
and completion evidence present and absent. One and three ask-user questions,
long labels, selected choices, custom
input from two through more than five lines, skipped questions, and disabled
Done. Markdown with code, tables, Mermaid, Excalidraw,
and invalid diagram source. Reasoning below the live Markdown threshold, the
bounded plain-text tail and its notice above the threshold, and completed full
reasoning.

**Motion.** `prefers-reduced-motion` on and off.

## Domain-specific evidence rules

- **Check both directions.** Most findings here are a rule with no counterpart.
  Scanning one file finds only half of them.
- **A selector claim needs the rendered DOM**, not a grep. A class that exists
  in CSS and never in output is exactly the finding.
- **Measure Sidebar geometry in every state.** Record title, metadata, status
  slot, and action-grid rectangles before streaming, during Stop, after
  completion/failure, and on hover. A screenshot can hide a one-pixel shift or
  wrapped metadata line.
- **No viewport axis.** The former combined visual audit retired that axis
  deliberately, because it multiplied cases without separating code paths. Do
  not reintroduce it without a reason. Whiteboard keeps one tabbed layout across
  widths, so test its narrow fit and zoom behavior without inventing a second layout.

## Known-load-bearing context

- [`theme/theme-system.md`](../../../theme/theme-system.md) holds the token
  format and the resolution order.
- A scoped, retryable viewer error must not unmount the app. That invariant
  lives in the sibling template.
