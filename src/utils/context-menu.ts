/**
 * Native context-menu policy.
 *
 * The WebView renders its own right-click menu, and on page content that menu
 * is full of browser affordances LC has no use for: "Print", "Copy link to
 * highlight", "More tools", "Send tab to your devices". (A fifth, "Inspect",
 * is debug-only — Tauri enables the inspector for dev builds and omits it from
 * release unless the `devtools` feature is turned on, so it needs no handling
 * here.)
 *
 * Why this is selective rather than a blanket suppression
 * ------------------------------------------------------
 * Those items only appear on *page content*. Right-clicking inside a text
 * field produces a different menu — undo/redo, cut/copy/paste, select all, and
 * **spelling suggestions**.
 *
 * The spelling suggestions are the reason this file is not simply
 * `preventDefault()` on everything. No web API exposes the spellchecker's
 * suggestions; Chromium surfaces them exclusively through the native menu. A
 * hand-built HTML menu can reproduce cut/copy/paste but can never reproduce
 * "did you mean…", so suppressing the menu inside the composer would trade an
 * irreplaceable feature for a cosmetic one.
 *
 * So: text fields keep the native menu, everything else does not.
 *
 * Known consequence
 * -----------------
 * Right-click → Copy on selected message text is gone along with the rest of
 * the page menu. Selection + Ctrl+C still works, and message bubbles have
 * their own copy buttons. Restoring it would mean drawing a small custom menu
 * — deliberately not done yet; see docs/keyboard-and-overlays.md.
 *
 * Opting out
 * ----------
 * A component that wants the native menu on non-editable content can either
 * call `stopPropagation()` on the event (this listener is on `document` in the
 * bubble phase, so React's own handlers run first) or mark the subtree with
 * `data-native-menu`.
 */

/** Input types whose native menu is a useful text menu. */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
  '', // an <input> with no type attribute defaults to text
]);

/** Should the WebView's own menu be allowed for this event target? */
function nativeMenuAllowed(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;

  // `isContentEditable` is inherited, so this is true for any node inside an
  // editable region and correctly false under `contenteditable="false"`.
  if (target instanceof HTMLElement && target.isContentEditable) return true;

  const field = target.closest('input, textarea, [data-native-menu]');
  if (!field) return false;
  if (field instanceof HTMLTextAreaElement) return true;
  if (field instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(field.type);
  return true; // [data-native-menu] opt-in
}

/**
 * Install the policy. Returns a cleanup function, mirroring
 * `installShortcuts()`.
 */
export function installContextMenuPolicy(): () => void {
  const onContextMenu = (e: MouseEvent) => {
    if (nativeMenuAllowed(e.target)) return;
    e.preventDefault();
  };

  document.addEventListener('contextmenu', onContextMenu);
  return () => document.removeEventListener('contextmenu', onContextMenu);
}
