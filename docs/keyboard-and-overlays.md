# Keyboard shortcuts and overlay input ownership

This document explains how LC assigns a key press to a surface.

Read this document before you add an overlay or shortcut. Each rule addresses a
previous defect.

---

## 1. The principle

**A modal owns the keyboard exactly as completely as it already owns the
pointer.**

A modal backdrop uses `position: fixed; inset: 0`. While it is open, pointer
input cannot reach content behind it. `elementFromPoint` tests at each surface
centre return the backdrop or modal card. Keyboard input did not originally
have the same ownership. `Ctrl+/` and `Ctrl+,` opened the side panel and
Settings behind a modal. These surfaces were visible but unreachable.

Everything below exists to make the keyboard match the pointer.

---

## 2. The two mechanisms

### 2.1 The modal gate — `utils/shortcuts.ts`

While a modal is open, the global shortcut bus suppresses **every** shortcut
except `F1` and `Shift + F1`. Settings has `aria-modal="true"` and activates
this gate. The docked side panel is a plain `aside` and does not activate it.

The gate also controls Escape. Each modal closes through its own handler. The
gate prevents the global handler from also closing the side panel and Settings.
This behavior enforces the `ToolPermissionModal` design. That modal deliberately
registers a no-op Escape owner because a permission prompt has no safe default
answer. Previously, Escape reached the global handler or an overlay behind it.

**`F1` and `Shift + F1` are the exceptions.** `F1` is the shortcut cheat sheet
and `Shift + F1` opens the support report, so both must be reachable from
inside a modal. CSS gives the help surfaces a `z-index: 10100` fallback, above
ordinary overlays such as `.link-open-confirm` (10000). Link guards, help and
support surfaces, Ask User, and permission prompts also call
`useOrderedOverlayLayer`. It assigns a later-opened top-tier surface a higher
inline layer before paint, independent of portal DOM position. This keeps the
visible surface, focused surface, and overlay-stack owner aligned.

### 2.2 The overlay stack — `utils/overlay-stack.ts`

Overlays push on open and pop on close. **Escape belongs to whatever is on
top. No other surface reacts.** Ownership follows the visible stacking order,
not listener registration order.

```tsx
useOverlayEscape(onClose, open);                       // the common case
useOverlayKeys({ Escape: onClose, Enter: onConfirm }); // more than one key
```

### 2.3 The scroll lock — `utils/scroll-lock.ts`

The scroll lock uses a depth counter. The first lock saves the page `overflow`
and sets it to `hidden`. The last release restores the saved value. Intermediate
locks and releases do not change it.

```tsx
useScrollLock();          // hold for as long as this component is mounted
useScrollLock(isOpen);    // or gate it
```

Six full-viewport viewers previously changed
`document.body.style.overflow` independently. Each viewer saved the value at
mount and restored it at unmount. This works only when overlays unmount in LIFO
order. If an outer overlay unmounts first, it restores `''` and unlocks the
page behind an open overlay. Current LC nesting resolves in LIFO order. The
call order, not the earlier mechanism, maintained that behavior.

**The scroll lock and overlay stack have different purposes and membership.**
The stack assigns Escape ownership through 24 registration sites. It includes dropdowns
such as `ModelPicker` that must not lock page scrolling. Only six surfaces lock
scroll. Keep the mechanisms separate.

Derive both counts from call sites. Each
`useOverlayKeys`/`useOverlayEscape` call pushes exactly one stack entry while
active, and each `useScrollLock()` call is one scroll-locking surface.
There are 24 registration sites across 20 files. Four files have two sites
each: `SidePanel`, `QuickPreview`, `ModelVisibilityPanel`, and
`WhiteboardOverlay`. There are 6 scroll locks across 5 files
(`QuickPreview` holds two). Count the call sites, not the files.

### 2.4 Zoom and the native minimum size

On the desktop path, `updateWindowMinSizeForZoom()` requests a minimum
`LogicalSize` of `round(540 * zoom)` by `round(380 * zoom)`. At 80% zoom,
that request is 432 by 304 logical pixels. The helper multiplies by zoom;
it does not divide a fixed visual minimum by zoom.

---

## 3. Rules that are not optional

### 3.1 `stopPropagation()` does not shield sibling listeners

Eight overlays relied on this incorrect assumption.

`stopPropagation()` stops an event reaching the next **node**. Every listener
on the **same** node still runs. These handlers were all on `window`. Therefore,
one Escape ran all sibling handlers. An isolated test used two `window` capture
listeners. The second listener ran after the first called `stopPropagation()`.

Only `stopImmediatePropagation()` stops sibling listeners on the same node. Use
the overlay stack instead.

### 3.2 A modal can vanish mid-dispatch

React flushes discrete-event state updates **between propagation phases**.
Measured across one Escape press with a modal open:

```
window   capture  → modal present = true
document bubble   → modal present = true    ← the modal's own handler runs here
window   bubble   → modal present = FALSE   ← React already unmounted it
```

So a live `document.querySelector('[aria-modal="true"]')` inside a
bubble-phase handler returns the wrong answer during this transition. The gate
therefore reads a snapshot taken by a **capture-phase probe registered at
startup**, before anything can unmount. Registration order there is
load-bearing.

If you need modal state during a bubble-phase handler, use
`modalWasOpenAtKeyDown()`, never a live DOM query.

### 3.3 Effect dependencies are load-bearing

`useOverlayKeys` depends on **`active` only**. Callbacks are read through a ref
updated in an effect.

Do not add `onClose` to the dependency list. `AboutModal` and
`KeyboardShortcutsModal` are siblings in `App.tsx`. Both use inline `onClose`
arrows.

Closing About re-renders `App` and changes F1's `onClose` identity. The
change reruns its effect and calls `removeEventListener` **during the
dispatch**. A listener removed mid-dispatch never fires. Therefore, Escape
closed About and left the F1 sheet open.

The same code with a different parent produced the opposite symptom:
`SysPromptPreview` lives in `SidePanel`. Closing it never re-rendered `App`, so
F1's listener survived. One Escape then closed **both**. The parent relationship
caused the different outcomes.

### 3.4 `aria-modal` is behaviour, not decoration

The gate uses `[aria-modal="true"]`. Any full-viewport blocking surface
**must** declare `role="dialog"` and `aria-modal="true"`. Removing these
attributes lets keyboard input reach content behind the modal.

`.settings-overlay` previously declared neither attribute. It uses
`position: fixed; inset: 0` with a dim background. The CSS comment identifies
it as "Settings page (modal)." Without the attributes,
`Ctrl+/` kept firing behind it.

Docked chrome must **not** declare them. The side panel root is a plain
`<aside>`. It does not block pointer input, so it must not gate the keyboard.

---

## 4. Adding a new overlay

1. Render a full-viewport backdrop.
2. If it blocks pointer input, set `role="dialog"` and `aria-modal="true"`.
3. Call `useOverlayEscape(onClose, open)`. Do not create a separate keydown
   listener.
4. Bind other owned keys through `useOverlayKeys`. This applies the same
   ownership check. An ungated Enter handler in `LinkOpenConfirm` previously
   opened a link behind the F1 sheet.
5. If it should freeze the page behind it, call `useScrollLock()` (§2.3). Do
   not touch `document.body.style.overflow` directly.
6. If it can open from another modal or arrive asynchronously over one, use
   `useOrderedOverlayLayer()` on its backdrop. Keep its overlay-stack registration
   active for exactly the same lifetime.
7. Add a focus trap only if you implement its complete behavior. See
   [§3.4](#34-aria-modal-is-behaviour-not-decoration).
8. If it has a glass surface, add its `solid.css` override. Otherwise,
   `npm run build` fails. See `theme/theme-system.md`.

## 5. Adding a new shortcut

Put it in `utils/shortcuts.ts` so it goes through the modal gate. Shortcuts
registered directly inside a component bypass the gate. They can run while a
modal is open. See the accepted exceptions below.

`Ctrl+B` (or `Cmd+B` on macOS) opens the active conversation's Whiteboard when
Workspace and its Whiteboard category are enabled. Because it uses the global
bus, an already-open modal retains keyboard ownership.

---

## 6. Accepted exceptions

Five shortcut combinations are component-local and bypass the modal gate. They
are accepted as designed. No change is currently planned.

| Shortcut | Owner | Behaviour | Why accepted |
|---|---|---|---|
| `Ctrl+P` / `Cmd+P` | `ChatView.tsx` | Opens or switches to Reasoning for the last matching bubble. | The preview overlay is a docked floating panel (`z-index: 15`), not a modal. It has no `aria-modal` and does not activate the modal gate. While open, it owns Escape through `useOverlayEscape`. |
| `Ctrl+Shift+P` / `Cmd+Shift+P` | `ChatView.tsx` | Opens or switches to Tools for the last matching bubble. | This shortcut uses the same docked preview ownership. |
| `Ctrl+Alt+P` / `Cmd+Option+P` | `ChatView.tsx` | Opens or switches to To do list for the last matching bubble. | The Windows and Linux match requires physical `KeyP`, semantic `p` or `P`, and no composition or `AltGraph`. The macOS match accepts the Option-produced semantic key. |
| `Ctrl+M` | `ModelPicker.tsx` | Toggles the model picker. Fires even with a modal open. | A dropdown, not a modal. Its Escape *is* on the stack, so closing it no longer reaches the global handler. No reported friction. |
| `Ctrl+T` | `TokenMeter.tsx` | Toggles the context-window tooltip | Same class, not raised by the maintainer. The tooltip is `z-index: 100`, so with a modal open it would render beneath the backdrop. It dismisses on Escape and on any other shortcut |

`shortcuts.ts` separately intercepts the primary-modifier P combinations with
`preventDefault()`. This only suppresses the WebView print dialog. It dispatches
no action.

When the preview is open, `Ctrl+ArrowUp` and `Ctrl+ArrowDown` select the
previous or next bubble that matches the active tab. On macOS, use Cmd instead
of Ctrl. The controlled tab order is Reasoning, Tools, and To do list. The To do
list tab's content follows **Settings → Chat → To-do list preview**: **latest
only** by default, or the complete resolved multi-list view with **all
updates**.

Fixing these would mean routing component-local shortcuts through the global
bus, or having the stack rather than `aria-modal` drive the gate. Neither is
planned.

---

## 7. The native right-click menu

`utils/context-menu.ts` decides whether the WebView draws its own context menu.

| Where | Native menu | Why |
|---|---|---|
| Supported text input types, `textarea`, and editable content | **kept** | Spelling suggestions live here and cannot be rebuilt |
| Everything else | suppressed | Removes *Print*, *Copy link to highlight*, *More tools*, *Send tab to your devices* |

Supported input types are `text`, `search`, `url`, `tel`, `email`, `password`,
and `number`. An input without a type defaults to `text`. Other input types,
such as `checkbox`, do not receive the text-field exception.

**Spelling suggestions require selective behavior.** No web API exposes the
spellchecker's suggestions. Chromium shows them only in the native menu. A
custom HTML menu can implement cut, copy, and paste. It cannot provide spelling
suggestions. Therefore, LC keeps the native menu in the composer.

*Inspect* needs no handling. Tauri enables the inspector only in debug builds.
It is absent from release builds unless the `devtools` feature is enabled.

**Known consequence.** Right-click → Copy on selected message text is gone with
the rest of the page menu. Selection with `Ctrl+C` still works, and bubbles
have copy buttons. Restoring the menu requires a custom menu. If added, it must
join the overlay stack (§2.2) so Escape dismisses it.

**Opting out.** A component that wants the native menu on non-editable content
can call `stopPropagation()` on the event. The listener is on `document` in
the bubble phase, so React handlers run first. The component can also mark the subtree with
`data-native-menu`.

---

## 8. Where the reasoning lives

This document contains the reasoning from a removed audit record. Section 3
contains the durable conclusions and evidence.

Measurement found two behaviors that are not visible in the code:

- **Escape ownership was decided by listener order, not stacking order.** Eight
  handlers used a "capture + `stopPropagation()`" convention without an order
  guarantee. They were all siblings on `window`
  (§3.1). One cause produced two opposite symptoms.
- **A live DOM check in the modal gate fails exactly when it matters** (§3.2).
  React flushes the discrete-event state update between the document-bubble and
  window-bubble phases. An overlay that closes itself on document-bubble is
  already unmounted when the global handler runs. This behavior made the first
  fix pass for one overlay and fail for another.

Regression coverage lives in `utils/scroll-lock.test.ts`,
`ui/preview/mermaid-render-boundary.test.ts`, and
`ui/chat/preview-shortcuts.test.ts`. `scripts/check-solid-css.mjs` runs in
`npm run build` and guards the stylesheet half.
