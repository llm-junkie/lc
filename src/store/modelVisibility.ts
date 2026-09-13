/**
 * Model visibility store — lets users hide models from specific servers.
 *
 * Hidden models are excluded from ALL model pickers:
 *   - Chat model picker (ModelPicker.tsx)
 *   - Sub-agent tool model pickers (Settings → Agentic Tools)
 *   - Cross-server model list
 *
 * Persisted in localStorage under key "lc_hidden_models".
 * A backup copy is kept under "lc_hidden_models_bak" to survive
 * storage corruption, webview data loss, or profile-ID churn.
 *
 * IMPORTANT: The hidden set is only ever cleared by an explicit
 * resetAll() call (used by the "Reset settings" flow).  No other
 * code path — model refresh, profile edit, bootstrap — may empty it.
 */

import { create } from 'zustand';
import { runLocalStorageMutation } from './local-storage.ts';

const STORAGE_KEY = 'lc_hidden_models';
const BACKUP_KEY = 'lc_hidden_models_bak';

function readFromStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeToStore(key: string, value: string): void {
  runLocalStorageMutation(() => localStorage.setItem(key, value));
}

function parseHidden(raw: string | null): Set<string> | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.some((value) => typeof value !== 'string')) return null;
    return new Set(arr);
  } catch {
    return null;
  }
}

/**
 * Load the hidden set from localStorage. Try the primary key first.
 * Use the backup only when the primary key is missing or malformed.
 */
export function loadHidden(): Set<string> {
  const primary = readFromStore(STORAGE_KEY);
  const parsed = parseHidden(primary);

  // A valid empty array is an explicit user choice.
  if (parsed !== null) {
    writeToStore(BACKUP_KEY, JSON.stringify([...parsed]));
    return parsed;
  }

  // The primary is unavailable or malformed. Try the backup.
  const backup = readFromStore(BACKUP_KEY);
  const fromBackup = parseHidden(backup);
  if (fromBackup !== null) {
    const arr = [...fromBackup];
    writeToStore(STORAGE_KEY, JSON.stringify(arr));
    console.warn(
      '[modelVisibility] Restored',
      arr.length,
      'hidden model(s) from backup — primary storage was unavailable or malformed.',
    );
    return fromBackup;
  }

  return new Set();
}

/** Persist the hidden set to BOTH primary and backup keys. */
function persistHidden(set: Set<string>): void {
  const raw = JSON.stringify([...set]);
  runLocalStorageMutation(() => {
    localStorage.setItem(STORAGE_KEY, raw);
    localStorage.setItem(BACKUP_KEY, raw);
  });
}

/** Build the composite key used for hidden-model lookups. */
export function hiddenModelKey(profileId: string, modelId: string): string {
  return `${profileId}:${modelId}`;
}

interface ModelVisibilityState {
  /** Set of "${profileId}:${modelId}" keys that are hidden. */
  hidden: Set<string>;

  /** Hide a model. */
  hide: (profileId: string, modelId: string) => void;

  /** Show (un-hide) a model. */
  show: (profileId: string, modelId: string) => void;

  /** Toggle hidden state. Returns the new state (true = hidden). */
  toggle: (profileId: string, modelId: string) => boolean;

  /** Check if a model is hidden. */
  isHidden: (profileId: string, modelId: string) => boolean;

  /** Hide all models for a given profile. */
  hideAllForProfile: (profileId: string, modelIds: string[]) => void;

  /** Show all models for a given profile. */
  showAllForProfile: (profileId: string, modelIds: string[]) => void;

  /** Remove every saved visibility choice for one profile, including stale IDs. */
  clearForProfile: (profileId: string) => void;

  /**
   * Wipe ALL hidden models (in-memory + localStorage).
   * Only called by the "Reset settings" flow — never by
   * model refresh, profile edit, or bootstrap.
   */
  resetAll: () => void;
}

export const useModelVisibility = create<ModelVisibilityState>((set, get) => ({
  hidden: loadHidden(),

  hide(profileId, modelId) {
    set((s) => {
      const next = new Set(s.hidden);
      next.add(hiddenModelKey(profileId, modelId));
      return { hidden: next };
    });
  },

  show(profileId, modelId) {
    set((s) => {
      const next = new Set(s.hidden);
      next.delete(hiddenModelKey(profileId, modelId));
      return { hidden: next };
    });
  },

  toggle(profileId, modelId) {
    const key = hiddenModelKey(profileId, modelId);
    const currentlyHidden = get().hidden.has(key);
    if (currentlyHidden) {
      get().show(profileId, modelId);
    } else {
      get().hide(profileId, modelId);
    }
    return !currentlyHidden;
  },

  isHidden(profileId, modelId) {
    return get().hidden.has(hiddenModelKey(profileId, modelId));
  },

  hideAllForProfile(profileId, modelIds) {
    set((s) => {
      const next = new Set(s.hidden);
      for (const mid of modelIds) {
        next.add(hiddenModelKey(profileId, mid));
      }
      return { hidden: next };
    });
  },

  showAllForProfile(profileId, modelIds) {
    set((s) => {
      const next = new Set(s.hidden);
      for (const mid of modelIds) {
        next.delete(hiddenModelKey(profileId, mid));
      }
      return { hidden: next };
    });
  },

  clearForProfile(profileId) {
    const prefix = hiddenModelKey(profileId, '');
    set((s) => ({
      hidden: new Set([...s.hidden].filter((key) => !key.startsWith(prefix))),
    }));
  },

  /**
   * Wipe ALL hidden models.  Sets the in-memory set to empty;
   * the subscribe below persists the empty array to both
   * localStorage keys so the next cold start is also clean.
   */
  resetAll() {
    set({ hidden: new Set() });
  },
}));

// Persist every hidden-set change to localStorage (BOTH primary
// and backup keys).  The subscribe is registered *after* store
// creation so there's no circular-reference hazard.  We track the
// previous reference to skip no-op updates (e.g. the initial
// bootstrap of an empty store).
let _prevHidden: Set<string> = useModelVisibility.getState().hidden;
useModelVisibility.subscribe((s) => {
  if (s.hidden !== _prevHidden) {
    _prevHidden = s.hidden;
    persistHidden(s.hidden);
  }
});
