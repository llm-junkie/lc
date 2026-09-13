/**
 * Manual models.dev refresh — the runtime twin of
 * `scripts/fetch-models-dev.mjs` + `scripts/build-models-cache.mjs`.
 *
 * Two steps, deliberately separate so the Manage-models button can toast
 * each one's outcome:
 *   1. `downloadModelsDev()`  — fetch https://models.dev/api.json (the full
 *      multi-MB catalogue).
 *   2. `rebuildModelsCache()` — reduce it to the compact provider-scoped
 *      cache and make it the cache enrichment actually reads.
 *
 * Desktop delegates both to the Rust commands, which persist
 * `models-dev.json` / `models-cache.json` in the app data dir and swap the
 * Rust-side lookup cache. The browser has no writable bundle asset, so it
 * holds the raw snapshot in memory and installs the rebuilt compact cache
 * as the runtime override of the bundled static copy.
 *
 * The reduction in `buildCompactCache()` must stay byte-equivalent in
 * spirit to the Rust `full_to_compact()` and the build script: same fields,
 * same drop rules, same defaults.
 */

import { isTauri } from '../../utils/saveBlob.ts';
import { setRuntimeModelsCache, type CompactCache } from '../llm-client/models/enrich.ts';
import {
  MODELS_DEV_MAX_MODELS,
  MODELS_DEV_MAX_PROVIDERS,
  readBoundedResponseText,
} from '../llm-client/models/limits.ts';

export interface ModelsDevSummary {
  providers: number;
  models: number;
}

/** Full models.dev `api.json` shapes — only the fields the reduction reads. */
interface FullModel {
  id?: string;
  name?: string;
  limit?: { context?: number };
  modalities?: { input?: string[] };
  reasoning?: boolean;
  tool_call?: boolean;
}
type FullProvider = { api?: string; models?: Record<string, FullModel> };
type FullCatalogue = Record<string, FullProvider>;

/** Browser only: the raw snapshot step 1 downloaded, held for step 2. */
let _rawSnapshot: FullCatalogue | null = null;

function tauriInvokeFn(): ((cmd: string, args?: unknown) => Promise<unknown>) | undefined {
  return (window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
  }).__TAURI_INTERNALS__?.invoke;
}

/**
 * Reduce the full models.dev catalogue to the compact provider-scoped
 * cache. Mirrors `full_to_compact()` in `src-tauri/src/models_dev.rs` and
 * `scripts/build-models-cache.mjs`: providers need an http `api`, models
 * need at least one usable field, first entry per id wins.
 */
export function buildCompactCache(raw: FullCatalogue): CompactCache {
  assertCatalogueBounds(countFull(raw));
  const cache: CompactCache = {};
  for (const [providerId, provider] of Object.entries(raw)) {
    if (!provider || typeof provider !== 'object' || !provider.models || !provider.api) continue;
    const api = provider.api;
    if (!api.startsWith('http')) continue;

    const compact: CompactCache[string]['m'] = {};
    for (const m of Object.values(provider.models)) {
      if (!m || typeof m !== 'object') continue;
      const ctx = m.limit?.context;
      const name = typeof m.name === 'string' ? m.name : undefined;
      const hasVision = Array.isArray(m.modalities?.input) && m.modalities.input.includes('image');
      const reasoning = m.reasoning === true;
      if (!ctx && !name && !hasVision && !reasoning) continue;

      const key = typeof m.id === 'string' && m.id ? m.id : 'unknown';
      if (!compact[key]) {
        compact[key] = {
          ...(ctx ? { c: ctx } : {}),
          ...(name ? { n: name } : {}),
          v: hasVision,
          r: reasoning,
          t: m.tool_call !== false,
        };
      }
    }
    if (Object.keys(compact).length > 0) cache[providerId] = { api, m: compact };
  }
  return cache;
}

function countFull(raw: FullCatalogue): ModelsDevSummary {
  return {
    providers: Object.keys(raw).length,
    models: Object.values(raw).reduce((n, p) => n + Object.keys(p?.models ?? {}).length, 0),
  };
}

function assertCatalogueBounds(summary: ModelsDevSummary): void {
  if (summary.providers > MODELS_DEV_MAX_PROVIDERS) {
    throw new Error(`models.dev exceeds ${MODELS_DEV_MAX_PROVIDERS} providers`);
  }
  if (summary.models > MODELS_DEV_MAX_MODELS) {
    throw new Error(`models.dev exceeds ${MODELS_DEV_MAX_MODELS} models`);
  }
}

function countCompact(cache: CompactCache): ModelsDevSummary {
  return {
    providers: Object.keys(cache).length,
    models: Object.values(cache).reduce((n, p) => n + Object.keys(p.m).length, 0),
  };
}

/**
 * Step 1 — download the full models.dev catalogue. Desktop persists the raw
 * snapshot to the app data dir (`models-dev.json`) via the Rust command;
 * the browser keeps it in memory for `rebuildModelsCache()`.
 */
export async function downloadModelsDev(): Promise<ModelsDevSummary> {
  if (isTauri) {
    const invoke = tauriInvokeFn();
    if (!invoke) throw new Error('models.dev: Tauri invoke unavailable');
    return invoke('download_models_dev') as Promise<ModelsDevSummary>;
  }

  // models.dev serves `Access-Control-Allow-Origin: *`, so the browser can
  // fetch the catalogue directly.
  const resp = await fetch('https://models.dev/api.json', { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const raw = JSON.parse(await readBoundedResponseText(resp)) as FullCatalogue;
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
    throw new Error('models.dev: empty catalogue');
  }
  const summary = countFull(raw);
  assertCatalogueBounds(summary);
  _rawSnapshot = raw;
  return summary;
}

/**
 * Step 2 — rebuild the compact cache from the snapshot step 1 produced.
 * Desktop reads the persisted snapshot, rewrites `models-cache.json`, and
 * swaps the Rust lookup cache; the browser installs the rebuilt cache as
 * the runtime override of the bundled static asset.
 */
export async function rebuildModelsCache(): Promise<ModelsDevSummary> {
  if (isTauri) {
    const invoke = tauriInvokeFn();
    if (!invoke) throw new Error('models.dev: Tauri invoke unavailable');
    return invoke('rebuild_models_dev_cache') as Promise<ModelsDevSummary>;
  }

  if (!_rawSnapshot) throw new Error('models.dev: no snapshot — download first');
  assertCatalogueBounds(countFull(_rawSnapshot));
  const cache = buildCompactCache(_rawSnapshot);
  setRuntimeModelsCache(cache);
  return countCompact(cache);
}
