/**
 * Global keyboard shortcuts:
 *   Ctrl/Cmd + N       — new chat
 *   Ctrl/Cmd + K       — focus composer
 *   Ctrl/Cmd + B       — open Whiteboard
 *   /                  — focus composer (when not already in a field)
 *   Ctrl/Cmd + ,       — open settings
 *   Ctrl/Cmd + /       — toggle side panel (Parameters tab)
 *   Ctrl/Cmd + Shift + / — toggle side panel (Workspace tab)
 *   F1                 — show keyboard shortcuts
 *   Shift + F1         — open support report
 *   F5                 — reload app
 *   F11                — toggle focus mode (chat only, not welcome)
 *   Ctrl/Cmd + F        — blocked (prevents webview find bar)
 *   Esc                 — close any open panel / settings
 *
 * The shortcut bus dispatches CustomEvents on `window` so individual
 * components can opt in. Components listen for "lc:focus-composer",
 * "lc:new-chat", etc. — keeps this module from importing every screen.
 *
 * `/` is the modern convention for "jump to message input" (Slack,
 * Linear, Notion, GitHub all do this) and works without a modifier,
 * which is why we reserve it for focus-composer instead of tying it
 * to Ctrl+/. The Ctrl+/ combo above is for the params panel
 * instead. We only fire `/` when the user isn't already in an
 * editable field, so typing `/` inside a chat message (which is
 * already in the textarea at that point) still types a literal
 * slash.
 *
 * Modal gate
 * ----------
 * While a modal is open, every shortcut here is suppressed except F1
 * and Shift + F1.
 *
 * A modal already owns *pointer* input completely — its backdrop covers
 * the viewport, so the sidebar, side panel and settings are all
 * unreachable by mouse. Keyboard had no such ownership, so Ctrl+/ and
 * Ctrl+, would open panels *behind* the modal that the user could see
 * but not touch, and Escape would close them as collateral while
 * dismissing the modal. The gate makes keyboard match pointer.
 *
 * Escape is gated too, deliberately. Each modal has its own Escape
 * handler, so it still closes; what stops is the global handler firing
 * *as well* and closing the side panel / settings behind it. This also
 * finally makes ToolPermissionModal's design real — it owns Escape with a
 * no-op on purpose (a permission prompt has no safe default answer), so the
 * key cannot leak to the global handler or an overlay behind it.
 *
 * F1 and Shift + F1 are the exceptions, by design: F1 is the shortcut
 * cheat sheet and Shift + F1 opens the support report — both must be
 * reachable from anywhere, including from inside a modal, which is
 * exactly when you are most likely to want them. F1 toggles, so F1
 * also closes the sheet again. Top-tier link guards, help/report surfaces,
 * and execution prompts use `useOrderedOverlayLayer`, so whichever opens
 * later receives the higher visual layer as well as becoming overlay-stack
 * owner. The ordered layer and these exceptions are a pair — changing one
 * without the other can hide the keyboard owner behind another portal.
 *
 * The signal is `[aria-modal="true"]`, which is present on the real
 * modals, including Settings. The docked side panel root is a plain
 * <aside> and does not activate the gate. This makes `aria-modal` load-bearing for
 * input ownership, not merely an accessibility hint. Do not strip it
 * from a modal without giving this gate another signal.
 */

export type ShortcutEvent =
  | 'lc:new-chat'
  | 'lc:focus-composer'
  | 'lc:open-whiteboard'
  | 'lc:open-settings'
  | 'lc:toggle-sidepanel'
  | 'lc:toggle-sidepanel-workspace'
  | 'lc:reload'
  | 'lc:show-keyboard-shortcuts'
  | 'lc:show-support-report'
  | 'lc:toggle-focus-mode';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);
const mod = (e: KeyboardEvent): boolean => (isMac ? e.metaKey : e.ctrlKey);

/**
 * Live DOM check for an open modal. See the "Modal gate" note in the file
 * header for why `aria-modal` is the signal.
 *
 * Do NOT call this from a bubble-phase handler — use
 * `modalWasOpenAtKeyDown()` instead. By the time a `window`-bubble handler
 * runs, the modal it should be gating on may already be gone. Measured
 * during one Escape press with a modal open:
 *
 *     window  capture  → modalIsOpen = true
 *     document bubble  → modalIsOpen = true      ← modal's own handler runs
 *     window  bubble   → modalIsOpen = FALSE     ← React already unmounted it
 *
 * React flushes the discrete-event state update between the document-bubble
 * and window-bubble phases, so an overlay that closes itself on
 * document-bubble is off the DOM before the global handler is reached.
 */
const modalIsOpen = (): boolean =>
  typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]') !== null;

/**
 * Was a modal open when the current keydown started? Snapshotted in the
 * capture phase, before any handler can unmount anything, which makes it
 * the only trustworthy answer for gating.
 *
 * Exported because the global shortcut bus is not the only thing that must
 * respect modal input ownership: any surface with its own `window`-level
 * Escape handler that closes something *behind* a modal needs the same
 * check. `SidePanel` is one — it closes itself on Escape, so without this a
 * modal dismissed above the panel would take the panel down with it.
 */
let modalAtKeyDown = false;
export const modalWasOpenAtKeyDown = (): boolean => modalAtKeyDown;

export function installShortcuts(): () => void {
  const handler = (e: KeyboardEvent) => {
    // Ignore when typing in an input/textarea (except for the global Esc).
    const target = e.target as HTMLElement | null;
    const inField =
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable);

    // Modal gate — a modal owns the keyboard the way it already owns the
    // pointer. F1 (cheat sheet) and Shift + F1 (support report) are the
    // deliberate exceptions. Uses the capture-phase snapshot, not a live
    // check: see modalIsOpen() above.
    if (e.key !== 'F1' && modalAtKeyDown) return;

    // Escape closes any open panel / settings — but only when no modal is
    // up, since a modal closes itself and must not take panels with it.
    if (e.key === 'Escape') {
      window.dispatchEvent(new CustomEvent('lc:escape'));
      return;
    }

    if (mod(e) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('lc:new-chat'));
      return;
    }
    if (mod(e) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('lc:focus-composer'));
      return;
    }
    if (mod(e) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('lc:open-whiteboard'));
      return;
    }
    if (mod(e) && e.key === ',') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('lc:open-settings'));
      return;
    }
    if (mod(e) && e.key === '/') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('lc:toggle-sidepanel'));
      return;
    }
    if (mod(e) && e.key === '?') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('lc:toggle-sidepanel-workspace'));
      return;
    }

    // Shift + F1 — support report. Checked before the plain F1 branch
    // below, since e.key is 'F1' for both.
    if (e.key === 'F1' && e.shiftKey) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('lc:show-support-report'));
      return;
    }

    if (e.key === 'F1') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('lc:show-keyboard-shortcuts'));
      return;
    }

    if (e.key === 'F5') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('lc:reload'));
      return;
    }
    // F11 toggles focus mode — only when a chat is active
    // (.chat-view exists), not on the welcome/empty-state screen.
    if (e.key === 'F11') {
      if (document.querySelector('.chat-view')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('lc:toggle-focus-mode'));
      }
      return;
    }
    if (mod(e) && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      return;
    }

    // Block Ctrl+F / Cmd+F — prevent the Tauri webview's built-in
    // browser find bar from opening. The app has its own search
    // (conversation list filter, tool activity filter, grep tool, etc.).
    if (mod(e) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      return;
    }

    // '/' to focus composer when not in a field.
    if (!inField && e.key === '/' && !mod(e)) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('lc:focus-composer'));
      return;
    }
  };

  // Capture-phase probe. Runs before every other keydown handler in the app
  // — `installShortcuts` is called at startup, so this is the first
  // window-capture listener registered — and records whether a modal was up
  // at the moment the key went down. Everything that gates on modal state
  // reads that snapshot instead of the DOM, because the DOM has already
  // moved on by the bubble phase. Registration order here is load-bearing.
  const captureProbe = (e: KeyboardEvent) => {
    if (e.type === 'keydown') modalAtKeyDown = modalIsOpen();
  };

  window.addEventListener('keydown', captureProbe, true);
  window.addEventListener('keydown', handler);
  return () => {
    window.removeEventListener('keydown', captureProbe, true);
    window.removeEventListener('keydown', handler);
  };
}
