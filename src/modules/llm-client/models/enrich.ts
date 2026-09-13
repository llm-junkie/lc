import type { ModelInfo } from '../types';
import { debugLog } from '../../../utils/debug.ts';

/** Module-level helpers for models.dev enrichment (used by both Tauri and browser paths). */

export function enrichOne(m: ModelInfo, meta: { context_window?: number; display_name?: string; capabilities?: Record<string, boolean> | null } | null | undefined): ModelInfo {
  if (!meta) return m;
  const enriched: ModelInfo = { ...m };
  // Native LM Studio metadata is authoritative when it is present. The
  // models.dev entry is a fallback/enrichment layer, not a replacement for
  // the server's capability report or context limit.
  if (meta.context_window && enriched.max_context_length == null) {
    enriched.max_context_length = meta.context_window;
  }
  if (meta.display_name && enriched.source !== 'lmstudio-rest' && !enriched.display_name) {
    enriched.display_name = meta.display_name;
  }
  if (meta.capabilities) {
    enriched.capabilities = { ...meta.capabilities, ...(enriched.capabilities ?? {}) };
  }
  return enriched;
}

/** Exclude non-chat models (embeddings, rerankers) by model ID. */
export function isNonChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.includes('embed') || lower.includes('rerank');
}

export type CompactCache = Record<string, { api: string; m: Record<string, { c?: number; n?: string; v?: boolean; r?: boolean; t?: boolean }> }>;

/* ---- compact-cache loading ------------------------------------------- */

/**
 * Runtime override installed by the browser-side models.dev manual refresh
 * (`models-dev-sync.ts`). Desktop persists the rebuilt cache to disk and
 * swaps the Rust-side `CACHE`, but the browser build has no writable
 * `models-cache.json` — this in-memory copy is the only way a refresh there
 * can reach enrichment before the next app build. `null` (the default)
 * means: keep serving the bundled static asset.
 */
let _runtimeCache: CompactCache | null = null;

/** The bundled `public/models-cache.json`, fetched once and memoized. */
let _bundledCache: CompactCache | null = null;
let _bundledLoading: Promise<CompactCache> | null = null;

export function setRuntimeModelsCache(cache: CompactCache | null): void {
  _runtimeCache = cache;
}

/**
 * The compact models.dev cache enrichment should read right now: the runtime
 * override when a manual refresh installed one, otherwise the bundled static
 * asset (lazy-fetched once). Both `list.ts` and the server-profiles
 * `model-enricher` load through here so they can never disagree about which
 * copy is current.
 */
export async function loadCompactModelsCache(): Promise<CompactCache> {
  if (_runtimeCache) return _runtimeCache;
  if (_bundledCache) return _bundledCache;
  if (!_bundledLoading) {
    _bundledLoading = (async () => {
      try {
        const resp = await fetch('/models-cache.json');
        if (resp.ok) _bundledCache = await resp.json() as CompactCache;
      } catch {
        // Non-critical — enrichment falls back to server-reported metadata.
        debugLog.warn('[LC] models-cache: failed to load models-cache.json');
      }
      return _bundledCache ?? {};
    })();
  }
  return _bundledLoading;
}

/** Extract domain root: "https://api.minimax.io/v1" → "https://api.minimax.io" */
export function domainRoot(url: string): string {
  const m = url.match(/^(https?:\/\/[^/]+)/);
  return m ? m[1] : url;
}

/** Find all provider entries whose `api` field contains the given domain root.
 *  Falls back to all providers if no match (covers local servers and edge cases). */
export function findProvidersInCache(cache: CompactCache, baseUrl: string): CompactCache {
  const root = domainRoot(baseUrl);
  const matched: CompactCache = {};
  for (const [pid, entry] of Object.entries(cache)) {
    if (entry.api.includes(root)) matched[pid] = entry;
  }
  // If no provider matched by URL, fall back to all providers so
  // local/unknown servers still get metadata from the cache.
  if (Object.keys(matched).length === 0) {
    debugLog.warn('[LC] models-cache: no provider matched %s, falling back to all %d providers', root, Object.keys(cache).length);
    return cache;
  }
  return matched;
}

/** Look up a model ID in matched providers (exact match, then case-insensitive,
 *  then with the publisher prefix stripped as a fallback for local LM Studio
 *  servers whose REST API returns keys like "qwen/qwen3.6-35b-a3b" while
 *  models-cache.json stores them as "qwen3.6-35b-a3b" (without prefix). */
export function lookupInProviders(matched: CompactCache, apiId: string): { context_window?: number; display_name?: string; capabilities?: Record<string, boolean> | null } | null {
  const lower = apiId.toLowerCase();
  for (const entry of Object.values(matched)) {
    if (entry.m[apiId]) return compactEntryToMeta(entry.m[apiId]);
    for (const [key, m] of Object.entries(entry.m)) {
      if (key.toLowerCase() === lower) return compactEntryToMeta(m);
    }
  }
  // Fallback: the model ID may have a publisher prefix (e.g. "qwen/qwen3.6-35b-a3b")
  // while the cache stores keys without it (e.g. "qwen3.6-35b-a3b").
  // Strip the prefix and try again.
  const slashIdx = apiId.indexOf('/');
  if (slashIdx > 0) {
    const stripped = apiId.substring(slashIdx + 1);
    const strippedLower = stripped.toLowerCase();
    for (const entry of Object.values(matched)) {
      if (entry.m[stripped]) return compactEntryToMeta(entry.m[stripped]);
      for (const [key, m] of Object.entries(entry.m)) {
        if (key.toLowerCase() === strippedLower) return compactEntryToMeta(m);
      }
    }
  }
  return null;
}

export function compactEntryToMeta(m: { c?: number; n?: string; v?: boolean; r?: boolean; t?: boolean }): { context_window?: number; display_name?: string; capabilities?: Record<string, boolean> | null } {
  return {
    context_window: m.c,
    display_name: m.n,
    capabilities: (m.v !== undefined || m.r !== undefined || m.t !== undefined)
      ? { vision: m.v ?? false, reasoning: m.r ?? false, tools: m.t ?? true }
      : null,
  };
}
