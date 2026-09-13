/**
 * Durable per-profile model-list customizations.
 *
 * The server cache remains an unmodified snapshot of what the server reported.
 * This layer is applied on top of that snapshot by the canonical model store:
 * manually added models are appended, while deleted server models are filtered
 * out. Keeping the layers separate is what lets Fetch models refresh metadata
 * without resurrecting a model the user deliberately removed.
 */

import { runLocalStorageMutation } from '../../store/local-storage.ts';

const STORAGE_KEY = 'lc_model_customizations';
const BACKUP_KEY = 'lc_model_customizations_bak';

export interface CustomModelDefinition {
  /** User-facing model name. */
  n: string;
  /** Context window in tokens. */
  c?: number;
  /** Capability flags. Missing means unknown. */
  v?: boolean;
  r?: boolean;
  t?: boolean;
}

export interface ProfileModelCustomization {
  /** Model ID -> user-authored definition. */
  added: Record<string, CustomModelDefinition>;
  /** Server-returned model IDs suppressed from this profile. */
  deleted: string[];
}

export type ModelCustomizationMap = Record<string, ProfileModelCustomization>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeDefinition(value: unknown): CustomModelDefinition | null {
  if (!isRecord(value) || typeof value.n !== 'string' || !value.n.trim()) return null;
  const out: CustomModelDefinition = { n: value.n.trim() };
  if (value.c !== undefined) {
    if (!(typeof value.c === 'number' && Number.isSafeInteger(value.c) && value.c > 0)) return null;
    out.c = value.c;
  }
  for (const field of ['v', 'r', 't'] as const) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'boolean') return null;
    out[field] = value[field];
  }
  return out;
}

/** Drop malformed and empty profile entries rather than rejecting the batch. */
export function sanitizeModelCustomizations(value: unknown): ModelCustomizationMap {
  if (!isRecord(value)) return {};
  const out: ModelCustomizationMap = {};
  for (const [profileId, rawProfile] of Object.entries(value)) {
    if (!profileId || !isRecord(rawProfile)) continue;
    const added: Record<string, CustomModelDefinition> = {};
    if (isRecord(rawProfile.added)) {
      for (const [modelId, rawDefinition] of Object.entries(rawProfile.added)) {
        if (!modelId.trim()) continue;
        const definition = sanitizeDefinition(rawDefinition);
        if (definition) added[modelId.trim()] = definition;
      }
    }
    const deleted = Array.isArray(rawProfile.deleted)
      ? [...new Set(rawProfile.deleted.filter((id): id is string => typeof id === 'string' && !!id.trim()).map((id) => id.trim()))]
      : [];
    if (Object.keys(added).length > 0 || deleted.length > 0) {
      out[profileId] = { added, deleted };
    }
  }
  return out;
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string): void {
  runLocalStorageMutation(() => localStorage.setItem(key, value));
}

function parse(raw: string | null): ModelCustomizationMap | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return undefined;
    return sanitizeModelCustomizations(value);
  } catch {
    return undefined;
  }
}

export function loadModelCustomizations(): ModelCustomizationMap {
  const primary = parse(read(STORAGE_KEY));
  if (primary) return primary;
  const backup = parse(read(BACKUP_KEY));
  if (backup && Object.keys(backup).length > 0) {
    write(STORAGE_KEY, JSON.stringify(backup));
    return backup;
  }
  return {};
}

export function saveModelCustomizations(value: ModelCustomizationMap): void {
  const raw = JSON.stringify(sanitizeModelCustomizations(value));
  runLocalStorageMutation(() => {
    localStorage.setItem(STORAGE_KEY, raw);
    localStorage.setItem(BACKUP_KEY, raw);
  });
}

export function clearModelCustomizations(): void {
  runLocalStorageMutation(() => {
    localStorage.setItem(STORAGE_KEY, '{}');
    localStorage.setItem(BACKUP_KEY, '{}');
  });
}
