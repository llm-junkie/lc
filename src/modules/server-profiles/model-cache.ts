/**
 * Persistent model cache with TTL freshness and write-time enrichment.
 *
 *   - Write-time enrichment: models.dev metadata is resolved BEFORE writing to
 *     localStorage, so offline reads get full data (fixes Phase 1 Bug 3).
 *   - TTL freshness: 5 min for local LM Studio, 60 min for cloud APIs.
 *   - Clean API: get/set/delete/isFresh with no direct localStorage access.
 */

import type { ServerProfile } from '../../types';
import { modelEnricher, type RawModelEntry } from './model-enricher.ts';
import { debugLog } from '../../utils/debug.ts';
import { runLocalStorageMutation } from '../../store/local-storage.ts';
import { MODEL_LIST_MAX_ENTRIES } from '../llm-client/models/limits.ts';

const STORAGE_KEY = 'lc:server-model-cache';

export interface CachedModel {
  n?: string;  // display name
  c?: number;  // max context length
  v?: boolean; // vision capability
  r?: boolean; // reasoning capability
  t?: boolean; // tools capability
  source?: 'lmstudio-rest' | 'gemini-rest';
}

export interface CachedServer {
  name: string;
  baseUrl: string;
  modelFetchUrl?: string;
  apiVariant: string;
  updatedAt: number;
  models: Record<string, CachedModel>;
}

export type ServerModelCache = Record<string, CachedServer>;

const TTL_LOCAL_MS = 5 * 60 * 1000;   // 5 min for LM Studio REST
const TTL_CLOUD_MS = 60 * 60 * 1000;  // 60 min for cloud APIs

// Model discovery can be triggered by bootstrap, profile edits, Settings,
// and the picker at the same time. Enrichment is async, so without a
// per-profile write version an older response can finish last and overwrite
// a newer model list in localStorage.
const writeVersions = new Map<string, number>();
// Versions are drawn from a single module-level sequence that never resets.
// A per-profile counter made pruning unsafe: deleting the entry restarted the
// sequence at 1, so a stale write that captured version 1 before the removal
// could match a newer write's version 1 and overwrite it. With a global
// counter a pruned profile's next write can never reuse a number an in-flight
// write still holds, so deleting the map entry only ever invalidates older
// writes — never a newer one.
let writeSequence = 0;
let cacheEpoch = 0;

function nextWriteVersion(profileId: string): number {
  const next = ++writeSequence;
  writeVersions.set(profileId, next);
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeCachedModel(value: unknown): CachedModel | null {
  if (!isRecord(value)) return null;
  if (value.n !== undefined && typeof value.n !== 'string') return null;
  if (value.c !== undefined && (typeof value.c !== 'number' || !Number.isFinite(value.c))) return null;
  if (value.v !== undefined && typeof value.v !== 'boolean') return null;
  if (value.r !== undefined && typeof value.r !== 'boolean') return null;
  if (value.t !== undefined && typeof value.t !== 'boolean') return null;
  if (value.source !== undefined && value.source !== 'lmstudio-rest' && value.source !== 'gemini-rest') return null;
  return value as CachedModel;
}

function sanitizeCachedServer(value: unknown): CachedServer | null {
  if (!isRecord(value)
    || typeof value.name !== 'string'
    || typeof value.baseUrl !== 'string'
    || (value.modelFetchUrl !== undefined && typeof value.modelFetchUrl !== 'string')
    || typeof value.apiVariant !== 'string'
    || typeof value.updatedAt !== 'number'
    || !Number.isFinite(value.updatedAt)
    || !isRecord(value.models)) return null;

  const entries = Object.entries(value.models);
  // Reject the whole persisted result. Truncation would make a partial model
  // list appear complete during an upgrade or failed live refresh.
  if (entries.length > MODEL_LIST_MAX_ENTRIES) return null;

  const models: Record<string, CachedModel> = {};
  for (const [modelId, rawModel] of entries) {
    const model = sanitizeCachedModel(rawModel);
    if (model) models[modelId] = model;
  }
  return { ...value, models } as CachedServer;
}

function readCache(): ServerModelCache {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const cache: ServerModelCache = {};
    for (const [profileId, rawServer] of Object.entries(parsed)) {
      const server = sanitizeCachedServer(rawServer);
      if (server) cache[profileId] = server;
    }
    return cache;
  } catch {
    return {};
  }
}

function writeCache(cache: ServerModelCache): void {
  if (!runLocalStorageMutation(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  })) {
    debugLog.warn('[model-cache] Failed to save cache (storage full?)');
  }
}

export const modelCache = {
  get(profileId: string): CachedServer | null {
    return readCache()[profileId] ?? null;
  },

  /**
   * Read only metadata detected through the profile's current model resource.
   * Old entries without a custom model URL remain compatible only when the
   * current profile also uses its default model URL.
   */
  getCompatible(profile: Pick<ServerProfile, 'id' | 'baseUrl' | 'modelFetchUrl' | 'apiVariant'>): CachedServer | null {
    const entry = readCache()[profile.id];
    if (!entry) return null;
    if (entry.baseUrl !== profile.baseUrl) return null;
    if ((entry.modelFetchUrl ?? '') !== (profile.modelFetchUrl ?? '')) return null;
    if (entry.apiVariant !== (profile.apiVariant ?? 'openai')) return null;
    return entry;
  },

  /**
   * Write cache entry. Enriches with models.dev BEFORE persisting.
   * This is the key fix for Phase 1 Bug 3 — offline reads get full metadata.
   */
  async set(profileId: string, rawModels: RawModelEntry[], profile: ServerProfile): Promise<void> {
    const epoch = cacheEpoch;
    const version = nextWriteVersion(profileId);
    const enriched = await modelEnricher.enrichAll(rawModels, profile.baseUrl);
    if (epoch !== cacheEpoch || writeVersions.get(profileId) !== version) return;

    const cache = readCache();
    const models: Record<string, CachedModel> = {};
    for (const m of enriched) {
      models[m.id] = {
        n: m.source === 'lmstudio-rest' ? undefined : (m.displayName !== m.id ? m.displayName : undefined),
        c: m.maxContextLength,
        // Store booleans as booleans. `|| undefined` used to collapse a
        // detected `false` into "unknown", which cost the registry its
        // detected layer across cold starts and for inactive profiles —
        // exactly the case where there is no live probe to re-derive it.
        v: m.capabilities.vision,
        r: m.capabilities.reasoning,
        t: m.capabilities.tools,
        ...(m.source ? { source: m.source } : {}),
      };
    }
    cache[profileId] = {
      name: profile.name,
      baseUrl: profile.baseUrl,
      ...(profile.modelFetchUrl ? { modelFetchUrl: profile.modelFetchUrl } : {}),
      apiVariant: profile.apiVariant ?? 'openai',
      updatedAt: Date.now(),
      models,
    };
    writeCache(cache);
  },

  delete(profileId: string): void {
    nextWriteVersion(profileId);
    const cache = readCache();
    delete cache[profileId];
    writeCache(cache);
  },

  /**
   * Drop the in-memory write-version bookkeeping for a profile that has been
   * permanently removed. Safe because versions come from the module-level
   * `writeSequence`, which never reuses a number: deleting this entry cannot
   * let a later write collide with one still in flight, and a write still in
   * flight for the removed profile fails its version guard. `delete()` keeps
   * the entry only to invalidate in-flight writes on the update path.
   */
  prune(profileId: string): void {
    writeVersions.delete(profileId);
  },

  isFresh(profileId: string): boolean {
    const entry = readCache()[profileId];
    if (!entry) return false;
    const ttl = entry.apiVariant === 'lm-studio' ? TTL_LOCAL_MS : TTL_CLOUD_MS;
    return Date.now() - entry.updatedAt < ttl;
  },

  age(profileId: string): number | null {
    const entry = readCache()[profileId];
    return entry ? Date.now() - entry.updatedAt : null;
  },

  getAll(): ServerModelCache {
    return readCache();
  },

  /** Returns cached models + whether they're stale. Caller decides whether to refresh. */
  getOrRefresh(profileId: string): { models: CachedModel[] | null; stale: boolean } {
    const entry = readCache()[profileId];
    if (!entry) return { models: null, stale: true };
    return { models: Object.values(entry.models), stale: !this.isFresh(profileId) };
  },

  /** Wipe the entire model metadata cache from localStorage. */
  clearAll(): void {
    cacheEpoch++;
    runLocalStorageMutation(() => localStorage.removeItem(STORAGE_KEY));
  },
};
