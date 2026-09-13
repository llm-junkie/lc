/**
 * Per-model metadata overrides — pure validation + persistence adapter.
 *
 * models.dev cannot cover every model from every provider, and a local
 * server may report nothing useful at all. This module is the storage and
 * validation layer for the user's manual corrections; it is deliberately
 * NOT a store. `useAppModels` (model-store.ts) owns the live override state
 * and calls in here to sanitize, load, and persist it.
 *
 * Identity is always the composite `hiddenModelKey(profileId, modelId)`, so
 * two profiles that expose the same model ID never share an override, and a
 * model ID containing `:` stays safe (nothing ever splits the key back apart).
 *
 * Persistence mirrors `store/modelVisibility.ts`: a primary key plus a backup
 * so a corrupted or partially-written value cannot silently lose the user's
 * work. A VALID EMPTY primary object is authoritative — "the user removed
 * every override" must not be undone by promoting a stale backup.
 */

import type { AppModelEntry } from './model-store';
import { runLocalStorageMutation } from '../../store/local-storage.ts';

const STORAGE_KEY = 'lc_model_meta_overrides';
const BACKUP_KEY = 'lc_model_meta_overrides_bak';

/** The user-authored metadata layer. Every field is optional: absent means
 *  "no opinion", so the detected layer shows through for that field alone. */
export interface ModelMetaOverride {
  /** User-facing display name. */
  n?: string;
  /** Max context tokens. Positive safe integer. */
  c?: number;
  /** Vision. */
  v?: boolean;
  /** Reasoning. */
  r?: boolean;
  /** Tools. */
  t?: boolean;
}

export type ModelMetaOverrideMap = Record<string, ModelMetaOverride>;

/** Context overrides are token counts: positive, integral, representable. */
export function isValidContextOverride(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize one override entry.
 *
 * Returns a fresh object containing only the fields that carry a real
 * opinion, or `null` when the entry is malformed or says nothing. Callers
 * treat `null` as "delete this key" — an empty entry is never persisted,
 * so `{}` can't accumulate as invisible debt in storage or in exports.
 */
export function sanitizeOverride(value: unknown): ModelMetaOverride | null {
  if (!isRecord(value)) return null;
  const out: ModelMetaOverride = {};
  if (value.n !== undefined) {
    if (typeof value.n !== 'string' || !value.n.trim()) return null;
    out.n = value.n.trim();
  }
  if (value.c !== undefined) {
    if (!isValidContextOverride(value.c)) return null;
    out.c = value.c;
  }
  for (const field of ['v', 'r', 't'] as const) {
    const raw = value[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'boolean') return null;
    out[field] = raw;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Normalize a whole override map. Invalid and empty entries are dropped
 * rather than rejecting the batch: one corrupt key must not cost the user
 * every other override they set.
 */
export function sanitizeOverrideMap(value: unknown): ModelMetaOverrideMap {
  if (!isRecord(value)) return {};
  const out: ModelMetaOverrideMap = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key) continue;
    const clean = sanitizeOverride(entry);
    if (clean) out[key] = clean;
  }
  return out;
}

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

/**
 * Parse a stored payload. `undefined` means "unreadable" (missing key or
 * malformed JSON/shape) and is the ONLY condition that lets the backup win.
 * A parsed-but-empty object returns `{}`, which is a real, authoritative
 * "no overrides".
 */
function parseStored(raw: string | null): ModelMetaOverrideMap | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    return sanitizeOverrideMap(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Load the persisted overrides. Primary first; the backup is consulted only
 * when the primary is missing or malformed. When the backup has to be used
 * it is promoted to primary so the next cold start is a plain read.
 */
export function loadModelOverrides(): ModelMetaOverrideMap {
  const primary = parseStored(readFromStore(STORAGE_KEY));
  if (primary) return primary;

  const backup = parseStored(readFromStore(BACKUP_KEY));
  if (backup && Object.keys(backup).length > 0) {
    writeToStore(STORAGE_KEY, JSON.stringify(backup));
    return backup;
  }
  return {};
}

/** Persist a fresh snapshot to BOTH keys. Called after every state change. */
export function saveModelOverrides(overrides: ModelMetaOverrideMap): void {
  const raw = JSON.stringify(sanitizeOverrideMap(overrides));
  runLocalStorageMutation(() => {
    localStorage.setItem(STORAGE_KEY, raw);
    localStorage.setItem(BACKUP_KEY, raw);
  });
}

/** Wipe both keys AND write an explicit empty object, so a later load
 *  cannot resurrect anything from a backup that outlived the reset. */
export function clearModelOverrides(): void {
  const empty = JSON.stringify({});
  runLocalStorageMutation(() => {
    localStorage.setItem(STORAGE_KEY, empty);
    localStorage.setItem(BACKUP_KEY, empty);
  });
}

/**
 * Merge the override layer onto detected metadata. Pure and immutable: the
 * result is a new entry with a new `capabilities` object, and neither
 * `detected`, `detected.capabilities`, nor `override` is touched.
 *
 * Each field merges independently, and an explicit `false` is a real
 * opinion that beats a detected `true` — `??` rather than `||`, because
 * "the user said no" and "nobody knows" are different states.
 */
export function applyOverride(
  detected: AppModelEntry,
  override: ModelMetaOverride | undefined,
): AppModelEntry {
  if (!override) {
    return { ...detected, capabilities: { ...detected.capabilities } };
  }
  return {
    ...detected,
    displayName: override.n ?? detected.displayName,
    maxContextLength: override.c ?? detected.maxContextLength,
    capabilities: {
      vision: override.v ?? detected.capabilities.vision,
      reasoning: override.r ?? detected.capabilities.reasoning,
      tools: override.t ?? detected.capabilities.tools,
    },
  };
}
