import { useSyncExternalStore } from 'react';
import { createShiftHeldStore, type ShiftHeldStore } from './shift-key-listeners.ts';

let sharedStore: ShiftHeldStore | undefined;

const getFalse = () => false;
const subscribeInactive = () => () => {};

function getSharedStore(): ShiftHeldStore | undefined {
  if (sharedStore) return sharedStore;
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
  sharedStore = createShiftHeldStore(window, document);
  return sharedStore;
}

function subscribeShared(listener: () => void): () => void {
  return getSharedStore()?.subscribe(listener) ?? (() => {});
}

function getSharedSnapshot(): boolean {
  return sharedStore?.getSnapshot() ?? false;
}

/**
 * True while the Shift key is held, sourced from one application-wide store.
 *
 * Pass `active = false` for surfaces that must not track — a rename input
 * whose re-renders would reset the field, a picker that is closed. Inactive
 * consumers read false without subscribing; the shared store keeps tracking
 * so reactivation immediately sees the current application-wide state.
 */
export function useShiftHeld(active = true): boolean {
  return useSyncExternalStore(
    active ? subscribeShared : subscribeInactive,
    active ? getSharedSnapshot : getFalse,
    getFalse,
  );
}
