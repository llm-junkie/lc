/**
 * Observable localStorage mutations.
 *
 * Reads keep their existing fallback behavior. Each write operation records
 * one closed-code durable-write outcome and preserves the current no-throw
 * behavior when storage is unavailable or full.
 */
import { recordStorageOutcome } from './storage-outcomes.ts';

/** Run one logical localStorage mutation and record its outcome. */
export function runLocalStorageMutation(run: () => void): boolean {
  try {
    run();
    recordStorageOutcome('durable-write', true);
    return true;
  } catch {
    recordStorageOutcome('durable-write', false);
    return false;
  }
}

/** Storage adapter for Zustand persistence. */
export const observableLocalStorage: Storage = {
  get length() {
    return localStorage.length;
  },
  clear() {
    runLocalStorageMutation(() => localStorage.clear());
  },
  getItem(key) {
    return localStorage.getItem(key);
  },
  key(index) {
    return localStorage.key(index);
  },
  removeItem(key) {
    runLocalStorageMutation(() => localStorage.removeItem(key));
  },
  setItem(key, value) {
    runLocalStorageMutation(() => localStorage.setItem(key, value));
  },
};
