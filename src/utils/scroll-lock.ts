/**
 * Body scroll lock — one owner, a depth counter, no LIFO assumption.
 *
 * The problem this replaces
 * ------------------------
 * Six overlays each did this independently:
 *
 *   const prev = document.body.style.overflow;
 *   document.body.style.overflow = 'hidden';
 *   return () => { document.body.style.overflow = prev; };
 *
 * Each one is correct alone. Together they are correct only while overlays
 * unmount in strict LIFO order, because each captures `prev` at ITS mount and
 * writes it back at ITS unmount:
 *
 *   - an outer overlay unmounting while an inner one is still open restores
 *     `''` and unlocks the page behind a modal that is still up;
 *   - an inner overlay unmounting after an outer one restores the outer's
 *     `'hidden'` and leaves the page locked with nothing open.
 *
 * Every reachable nesting in LC happens to resolve LIFO today, which is why
 * this is a risk rather than a defect today. It is upheld by call-site
 * ordering, not by the mechanism — one new overlay or
 * one reordered state update breaks it silently, and nothing reports it.
 *
 * The rule
 * --------
 * The first lock captures the page's own `overflow` and sets `hidden`. The
 * last release puts the captured value back. Locks in between do nothing.
 * Order of release is irrelevant, which is the whole point.
 *
 * Why this is not folded into `overlay-stack.ts`
 * ----------------------------------------------
 * The overlay stack assigns Escape ownership, including to dropdowns such
 * as `ModelPicker` that must not freeze the page. Six viewer call sites use
 * scroll locks. Other stack entries do not request a lock. Keep these
 * memberships separate; see docs/keyboard-and-overlays.md for their inventory.
 */

import { useEffect } from 'react';

let depth = 0;
/** The page's own `overflow`, captured at the 0 → 1 transition. */
let saved = '';

/**
 * Lock body scroll. Returns the release function.
 *
 * The returned function is idempotent: calling it twice releases once. React
 * 18's StrictMode double-invokes effects in development, and a release that
 * decremented twice would unlock the page while an overlay was still open.
 */
export function lockBodyScroll(): () => void {
  if (depth === 0) saved = document.body.style.overflow;
  depth++;
  document.body.style.overflow = 'hidden';

  let released = false;
  return () => {
    if (released) return;
    released = true;
    depth--;
    if (depth === 0) document.body.style.overflow = saved;
  };
}

/**
 * Lock body scroll for as long as this component is mounted.
 *
 * @param active whether the lock should be held — the ONLY dependency, so a
 *               parent re-render never releases and re-takes the lock
 */
export function useScrollLock(active = true): void {
  useEffect(() => {
    if (!active) return;
    return lockBodyScroll();
  }, [active]);
}

/** Current lock depth. Exported for tests and debugging only. */
export function scrollLockDepth(): number {
  return depth;
}
