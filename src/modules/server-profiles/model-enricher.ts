/**
 * models.dev enrichment layer. Loads the compact provider-scoped cache
 * (`/models-cache.json` or Tauri's `invoke('lookup_models_dev')`) and
 * enriches raw model entries with context length, display name, and
 * capability flags.
 *
 * Key fix (Phase 1 Bug 3): enrichment runs at cache-WRITE time (in
 * model-cache.set()), not at read time. This means offline cache reads
 * get full models.dev data.
 */

import { isTauri } from '../../utils/saveBlob.ts';
import { debugLog } from '../../utils/debug.ts';
import { loadCompactModelsCache } from '../llm-client/models/enrich.ts';
import type { ModelCapabilities } from '../llm-client/types';
import {
  MODEL_ENRICHMENT_CONCURRENCY,
  MODEL_LIST_MAX_ENTRIES,
} from '../llm-client/models/limits.ts';

export type CompactModelMeta = { c?: number; n?: string; v?: boolean; r?: boolean; t?: boolean };
type CompactProvider = { api: string; m: Record<string, CompactModelMeta> };
type CompactCache = Record<string, CompactProvider>;

/**
 * Load the compact models-cache.json lazily through the shared loader in
 * `llm-client/models/enrich.ts`, so this module and `listModels()` always
 * read the same copy — including the runtime override a manual models.dev
 * refresh installs in the browser build.
 *
 * The static asset is bundled into the frontend for BOTH targets, so one
 * path serves the browser and the desktop app. It used to try
 * `invoke('lookup_models_dev')` first — with none of its required
 * arguments, and casting its `Array<ModelMeta | null>` result to the whole
 * compact cache. That call could only ever reject or produce a nonsense
 * object; the fetch below was silently carrying enrichment the whole time.
 * `guessModelMeta()` below is what actually uses the Tauri command, with
 * its real `{ baseUrl, ids }` contract.
 */
function loadCache(): Promise<CompactCache> {
  return loadCompactModelsCache();
}

function domainRoot(url: string): string {
  const m = url.match(/^(https?:\/\/[^/]+)/);
  return m ? m[1] : url;
}

/**
 * Providers whose `api` field covers this base URL, or every provider when
 * none match. Mirrors the Rust `find_providers()` so the browser and desktop
 * Guess paths agree on which subset to search first.
 */
export function findProvidersInCache(cache: CompactCache, baseUrl: string): CompactProvider[] {
  const root = domainRoot(baseUrl);
  const matched = Object.values(cache).filter((p) => p.api.includes(root));
  return matched.length > 0 ? matched : Object.values(cache);
}

/** Exact match first, then case-insensitive. Mirrors Rust `lookup_in_providers()`. */
export function lookupInProviders(
  providers: readonly CompactProvider[],
  modelId: string,
): CompactModelMeta | undefined {
  const lower = modelId.toLowerCase();
  for (const p of providers) {
    const exact = p.m[modelId];
    if (exact) return exact;
    for (const [key, m] of Object.entries(p.m)) {
      if (key.toLowerCase() === lower) return m;
    }
  }
  return undefined;
}

export interface RawModelEntry {
  id: string;
  display_name?: string;
  max_context_length?: number;
  capabilities?: ModelCapabilities;
  source?: 'lmstudio-rest' | 'gemini-rest';
}

export interface EnrichedModelEntry {
  id: string;
  displayName: string;
  maxContextLength?: number;
  capabilities: { vision: boolean; reasoning: boolean; tools: boolean };
  source?: 'lmstudio-rest' | 'gemini-rest';
}

export const modelEnricher = {
  async enrich(model: RawModelEntry, baseUrl: string): Promise<EnrichedModelEntry> {
    const cache = await loadCache();
    const root = domainRoot(baseUrl);
    let meta: { n?: string; c?: number; v?: boolean; r?: boolean; t?: boolean } | undefined;

    // Helper to search for a model id across provider entries.
    const findMeta = (modelId: string): typeof meta => {
      const lower = modelId.toLowerCase();
      for (const entry of Object.values(cache)) {
        if (entry.m[modelId]) return entry.m[modelId];
        for (const [key, m] of Object.entries(entry.m)) {
          if (key.toLowerCase() === lower) return m;
        }
      }
      return undefined;
    };

    // Provider-scoped lookup: match by domain root first
    for (const entry of Object.values(cache)) {
      if (entry.api.includes(root)) {
        meta = findMeta(model.id);
        if (meta) break;
      }
    }
    // Fallback: search all providers
    if (!meta) {
      meta = findMeta(model.id);
    }
    // Second fallback: the model ID may have a publisher prefix
    // (e.g. "qwen/qwen3.6-35b-a3b" from LM Studio REST) while the
    // cache stores keys without it (e.g. "qwen3.6-35b-a3b").
    if (!meta) {
      const slashIdx = model.id.indexOf('/');
      if (slashIdx > 0) {
        meta = findMeta(model.id.substring(slashIdx + 1));
      }
    }

    const caps = model.capabilities ?? {};
    return {
      id: model.id,
      // Native LM Studio identifiers are the useful human-facing label: the
      // publisher/repository prefix distinguishes otherwise identical models.
      displayName: model.source === 'lmstudio-rest' ? model.id : (model.display_name || meta?.n || model.id),
      maxContextLength: model.max_context_length ?? meta?.c,
      capabilities: {
        vision: caps.vision === true || meta?.v === true,
        // LM Studio REST returns reasoning as an object { allowed_options, default },
        // not a boolean.  Truthy check catches both object and true.
        reasoning: caps.reasoning === true || (typeof caps.reasoning === 'object' && caps.reasoning !== null) || meta?.r === true,
        tools: caps.trained_for_tool_use === true || caps.tools === true ||
          (caps.trained_for_tool_use !== false && caps.tools !== false && meta?.t !== false),
      },
      ...(model.source ? { source: model.source } : {}),
    };
  },

  async enrichAll(models: RawModelEntry[], baseUrl: string): Promise<EnrichedModelEntry[]> {
    if (models.length > MODEL_LIST_MAX_ENTRIES) {
      throw new Error(`model enrichment exceeds ${MODEL_LIST_MAX_ENTRIES} entries`);
    }
    const enriched = new Array<EnrichedModelEntry>(models.length);
    let next = 0;
    const worker = async () => {
      while (next < models.length) {
        const index = next++;
        enriched[index] = await this.enrich(models[index], baseUrl);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(MODEL_ENRICHMENT_CONCURRENCY, models.length) },
      () => worker(),
    ));
    return enriched;
  },
};

/* ------------------------------------------------------------------ */
/*  Guess — one-shot models.dev lookup for the override editor         */
/* ------------------------------------------------------------------ */

/**
 * What the Guess button fills the override form with. Shaped like the Rust
 * `ModelMeta` wire type so both paths return the same thing.
 *
 * Every capability is OPTIONAL, and that is load-bearing. A compact-cache
 * entry that carries a context window but no `v`/`r`/`t` flags says nothing
 * about those capabilities — mapping absent to `false` would let Guess → Save
 * freeze an explicit "No" over a capability the server actually reported, which
 * is exactly what the tri-state Inherit state exists to prevent.
 */
export interface GuessedModelMeta {
  context_window?: number;
  display_name?: string;
  capabilities?: {
    vision?: boolean;
    reasoning?: boolean;
    tools?: boolean;
  } | null;
}

/**
 * Convert one compact-cache entry into the Guess wire shape.
 *
 * Pure, and exported so the sparse-entry behaviour is testable without a
 * fetch or a Tauri host. Present flags are carried through as-is (including
 * `false`, which is a real answer); absent flags are simply not emitted, and
 * an entry with no flags at all yields `capabilities: null`.
 */
export function compactEntryToGuess(meta: CompactModelMeta): GuessedModelMeta {
  const hasAnyCapability = meta.v !== undefined || meta.r !== undefined || meta.t !== undefined;
  return {
    ...(meta.c !== undefined ? { context_window: meta.c } : {}),
    ...(meta.n !== undefined ? { display_name: meta.n } : {}),
    capabilities: hasAnyCapability
      ? {
          ...(meta.v !== undefined ? { vision: meta.v } : {}),
          ...(meta.r !== undefined ? { reasoning: meta.r } : {}),
          ...(meta.t !== undefined ? { tools: meta.t } : {}),
        }
      : null,
  };
}

/** Candidate IDs to try, most specific first. LM Studio REST reports
 *  `publisher/model` while models.dev keys on the bare model name. */
function guessCandidates(modelId: string): string[] {
  const ids = [modelId];
  const slash = modelId.indexOf('/');
  if (slash > 0) {
    const stripped = modelId.substring(slash + 1);
    if (stripped && stripped !== modelId) ids.push(stripped);
  }
  return ids;
}

function tauriInvokeFn(): ((cmd: string, args?: unknown) => Promise<unknown>) | undefined {
  return (window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
  }).__TAURI_INTERNALS__?.invoke;
}

/** First non-null entry of the `Array<ModelMeta | null>` the command returns. */
function firstHit(result: unknown): GuessedModelMeta | null {
  if (!Array.isArray(result)) return null;
  for (const entry of result) {
    if (entry && typeof entry === 'object') return entry as GuessedModelMeta;
  }
  return null;
}

/**
 * Look up one model's metadata in the downloaded/bundled models.dev compact
 * cache. No network request to models.dev ever happens here.
 *
 * Desktop uses the Rust `lookup_models_dev` command with its real
 * `{ baseUrl, ids }` request shape; a provider-scoped miss retries against
 * every provider. The browser searches the static compact cache the same way.
 * Returns `null` on a miss so the caller can say so rather than guessing.
 */
export async function guessModelMeta(
  baseUrl: string,
  modelId: string,
): Promise<GuessedModelMeta | null> {
  const ids = guessCandidates(modelId);

  if (isTauri) {
    const invoke = tauriInvokeFn();
    if (invoke) {
      try {
        const scoped = firstHit(await invoke('lookup_models_dev', { baseUrl, ids }));
        if (scoped) return scoped;
        // Provider-scoped miss: the base URL may not match any models.dev
        // `api` field (a proxy, a gateway, a LAN address). Ask across all
        // providers before giving up.
        if (baseUrl) {
          const all = firstHit(await invoke('lookup_models_dev', { baseUrl: '', ids }));
          if (all) return all;
        }
        return null;
      } catch {
        // Fall through to the bundled JSON below.
        debugLog.warn('[model-enricher] lookup_models_dev failed — using bundled cache');
      }
    }
  }

  const cache = await loadCache();
  const scoped = findProvidersInCache(cache, baseUrl);
  const all = Object.values(cache);
  for (const providers of [scoped, all]) {
    for (const id of ids) {
      const meta = lookupInProviders(providers, id);
      if (!meta) continue;
      return compactEntryToGuess(meta);
    }
  }
  return null;
}
