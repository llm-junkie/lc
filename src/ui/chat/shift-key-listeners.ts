interface ShiftKeyEventLike {
  type: string;
  key?: string;
  shiftKey?: boolean;
}

type ShiftKeyEventType = 'keydown' | 'keyup' | 'pointerdown' | 'pointermove' | 'blur';

interface ShiftKeyListenerTarget {
  addEventListener(type: ShiftKeyEventType, listener: (event: ShiftKeyEventLike) => void): void;
  removeEventListener(type: ShiftKeyEventType, listener: (event: ShiftKeyEventLike) => void): void;
}

interface VisibilityChangeTarget {
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface ShiftHeldStore {
  getSnapshot(): boolean;
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

function isShiftKeyEvent(event: ShiftKeyEventLike): boolean {
  return event.key === 'Shift' || event.key === 'ShiftLeft' || event.key === 'ShiftRight';
}

/**
 * Own one balanced listener set for the lifetime of an active surface.
 *
 * Shift's own key events are the one case where the live modifier flag
 * cannot be trusted: WebKitGTK (Linux) still reports `shiftKey === true`
 * on Shift's keyup even though the key was just released, which left the
 * sidebar's shift-to-arm buttons showing Delete forever after one hold
 * (Windows' WebView2 reports `false` there, so the bug was Linux-only).
 * The event type is the only reliable signal for Shift's own events.
 *
 * Every other event re-reads the live modifier state — `shiftKey` is
 * accurate on non-Shift key events and pointer events on every engine — so
 * a keyup that never reaches the page (window unfocused mid-hold, IME grab)
 * self-heals on the next keystroke, pointer press, or pointer move. `blur`
 * clears through the window target; `visibilitychange` clears through its
 * document target because that event is not dispatched on `window`.
 */
export function listenForShiftKey(
  target: ShiftKeyListenerTarget,
  visibilityTarget: VisibilityChangeTarget,
  onChange: (held: boolean) => void,
): () => void {
  let held = false;
  const update = (next: boolean) => {
    if (next === held) return;
    held = next;
    onChange(next);
  };
  const onKey = (event: ShiftKeyEventLike) => {
    if (isShiftKeyEvent(event)) {
      update(event.type === 'keydown');
      return;
    }
    update(event.shiftKey === true);
  };
  const onPointer = (event: ShiftKeyEventLike) => update(event.shiftKey === true);
  const release = () => update(false);
  target.addEventListener('keydown', onKey);
  target.addEventListener('keyup', onKey);
  target.addEventListener('pointerdown', onPointer);
  target.addEventListener('pointermove', onPointer);
  target.addEventListener('blur', release);
  visibilityTarget.addEventListener('visibilitychange', release);
  return () => {
    target.removeEventListener('keydown', onKey);
    target.removeEventListener('keyup', onKey);
    target.removeEventListener('pointerdown', onPointer);
    target.removeEventListener('pointermove', onPointer);
    target.removeEventListener('blur', release);
    visibilityTarget.removeEventListener('visibilitychange', release);
  };
}

/**
 * One external store for any number of React consumers. The DOM listener set
 * belongs to the store, not to each component, so high-frequency pointer
 * recovery remains constant-cost as conversations grow.
 */
export function createShiftHeldStore(
  target: ShiftKeyListenerTarget,
  visibilityTarget: VisibilityChangeTarget,
): ShiftHeldStore {
  let held = false;
  let destroyed = false;
  const subscribers = new Set<() => void>();
  const stop = listenForShiftKey(target, visibilityTarget, (next) => {
    held = next;
    for (const subscriber of [...subscribers]) subscriber();
  });

  return {
    getSnapshot: () => held,
    subscribe: (listener) => {
      if (destroyed) return () => {};
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      subscribers.clear();
      stop();
      held = false;
    },
  };
}
