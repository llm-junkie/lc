/**
 * Overlay stack — decides which overlay owns Escape.
 *
 * The problem this replaces
 * ------------------------
 * Overlays used to each register their own `window` keydown listener and call
 * `stopPropagation()`, on the assumption that this shielded the ones beneath.
 * It does not. `stopPropagation()` stops an event moving to the next *node*;
 * every listener on the *same* node still runs. All those handlers were on
 * `window`, so they were siblings, and a single Escape ran all of them.
 *
 * That left Escape ownership decided by listener registration order and React
 * re-render timing, which produced two different bugs from one cause:
 *
 *   - Settings → About → F1 → Esc closed **About**, not the F1 sheet on top.
 *     `AboutModal` and `KeyboardShortcutsModal` are siblings in `App.tsx` with
 *     inline `onClose` arrows. About closing re-rendered `App`, which changed
 *     F1's `onClose` identity, re-ran its effect, and called
 *     `removeEventListener` *during the dispatch* — a listener removed mid
 *     dispatch never fires. F1 silently never saw the key.
 *
 *   - Side panel → sys-prompt → F1 → Esc closed **both**. `SysPromptPreview`
 *     lives in `SidePanel`, a different parent, so closing it did not re-render
 *     `App`, F1's listener survived, and both handlers ran.
 *
 * Same code, opposite symptoms, discriminated only by whether two overlays
 * happened to share a parent. No amount of `stopPropagation` fixes that.
 *
 * The rule
 * --------
 * Overlays push on open and pop on close. Escape belongs to whatever is on top
 * — nothing else reacts. Ownership follows stacking order, which is what the
 * user sees, instead of listener order, which is invisible and unstable.
 *
 * `useOverlayEscape` deliberately depends only on `active`, so the listener is
 * registered once per open and a parent re-render cannot deregister it
 * mid-dispatch. The close callback is read through a ref so it stays current
 * without becoming an effect dependency. Both details are load-bearing: making
 * `onClose` a dependency reintroduces the first bug exactly.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, type RefCallback } from 'react';

/** Opaque per-mount token. Identity is the whole point; the object is empty. */
export type OverlayId = { readonly __overlay?: never };

const stack: OverlayId[] = [];

/**
 * Top-tier overlays can be opened from another modal or can arrive
 * asynchronously while one is open. Their static CSS is only a fallback;
 * this ordered layer keeps visual order aligned with open/stack order.
 */
export const ORDERED_OVERLAY_LAYER_BASE = 20_000;
let nextOrderedOverlayLayer = 0;

export function useOrderedOverlayLayer(active = true): RefCallback<HTMLElement> {
  const elementRef = useRef<HTMLElement | null>(null);
  const appliedLayerRef = useRef<string | null>(null);

  const bindLayer = useCallback((element: HTMLElement | null) => {
    const previous = elementRef.current;
    const applied = appliedLayerRef.current;
    if (previous && applied && previous.style.zIndex === applied) {
      previous.style.removeProperty('z-index');
    }
    elementRef.current = element;
    if (element && applied) element.style.zIndex = applied;
  }, []);

  useLayoutEffect(() => {
    if (!active) return;
    const layer = String(ORDERED_OVERLAY_LAYER_BASE + ++nextOrderedOverlayLayer);
    appliedLayerRef.current = layer;
    if (elementRef.current) elementRef.current.style.zIndex = layer;
    return () => {
      const element = elementRef.current;
      if (element && element.style.zIndex === layer) element.style.removeProperty('z-index');
      if (appliedLayerRef.current === layer) appliedLayerRef.current = null;
    };
  }, [active]);

  return bindLayer;
}

/** Push a new overlay onto the stack and return its token. */
export function pushOverlay(): OverlayId {
  const id: OverlayId = {};
  stack.push(id);
  return id;
}

/** Remove an overlay from the stack. Safe to call for an absent id. */
export function popOverlay(id: OverlayId): void {
  const i = stack.lastIndexOf(id);
  if (i !== -1) stack.splice(i, 1);
}

/** Is this overlay the innermost one currently open? */
export function isTopOverlay(id: OverlayId): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** How many overlays are open. Used by the shortcut modal gate. */
export function overlayCount(): number {
  return stack.length;
}

/**
 * Bind keys that only fire while this overlay is the innermost one.
 *
 * Registers in the capture phase so it runs ahead of the global shortcut bus,
 * and stops propagation once it has acted so nothing further down reacts to
 * the same key.
 *
 * @param handlers map of `KeyboardEvent.key` to callback
 * @param active   whether the overlay is currently open — the ONLY dependency
 */
export function useOverlayKeys(
  handlers: Record<string, () => void>,
  active = true,
): void {
  // Held in a ref so a parent re-render never re-runs the registration effect.
  // See the header: `onClose` as a dependency is what deregistered the F1
  // sheet's listener mid-dispatch and made Escape close the wrong modal.
  // Written in an effect rather than during render — refs must not be mutated
  // while rendering.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!active) return;
    const id = pushOverlay();
    const onKey = (e: KeyboardEvent) => {
      const fn = handlersRef.current[e.key];
      if (!fn) return;
      if (!isTopOverlay(id)) return; // something is open above us — not ours
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      popOverlay(id);
    };
  }, [active]);
}

/**
 * Escape-to-close that respects stacking order. The common case of
 * {@link useOverlayKeys}.
 *
 * @param onClose called when Escape is pressed and this overlay is on top
 * @param active  whether the overlay is currently open
 */
export function useOverlayEscape(onClose: () => void, active = true): void {
  useOverlayKeys({ Escape: onClose }, active);
}
