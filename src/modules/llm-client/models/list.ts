import type { ModelInfo } from '../types';
import { ANTHROPIC_API_VERSION, requiresAnthropicVersion } from '../anthropic-version.ts';
import { enrichOne, findProvidersInCache, lookupInProviders, isNonChatModel, loadCompactModelsCache, type CompactCache } from './enrich.ts';
import { debugLog } from '../../../utils/debug.ts';
import { getLocalNativeModelFetchUrl, isLocalNetworkUrl } from './url.ts';
import { recordDiagnosticEvent } from '../../../utils/diagnostic-events.ts';
import {
  classifyEndpoint,
  countBucket,
  type ModelMetadataSource,
} from '../../../utils/support-report-base.ts';
import type { ProfileRequestHeaderSettings } from '../../../types';
import { withProfileRequestHeaders } from '../request-headers.ts';
import {
  MODEL_LIST_MAX_ENTRIES,
  readBoundedResponseText,
} from './limits.ts';

/**
 * Consolidated model-listing logic.
 *
 * Strategy:
 * 1. A custom model URL is authoritative and is requested exactly once.
 * 2. Local/LAN profiles try LM Studio REST `/api/v1/models` first, then
 *    fall back to the configured API Base URL plus `/models`.
 * 3. All other profiles request only the configured Base URL plus `/models`.
 * 4. Z.ai additionally merges its known `/v1/models` compatibility list.
 *
 * One provider needs an extra header, in the same spirit as the Z.ai merge
 * below: `api.anthropic.com` rejects any request that omits `anthropic-version`,
 * `/v1/models` included. See the header block for why that is scoped to
 * Anthropic's own host rather than to everything speaking its protocol.
 *
 * Response format is auto-detected:
 *   - LM Studio REST: `{ models: [{ key, ... }] }`
 *   - OpenAI-compat:   `{ data: [{ id, ... }] }`
 */
/** Why a model-list fetch produced nothing usable. Bounded and LC-owned. */
type ListFailure = 'network' | 'http' | 'parse' | 'empty' | 'limit';

class ModelListLimitError extends Error {}

/** One fetch attempt, reduced to the facts that are safe to keep. */
interface FetchAttempt {
  models: ModelInfo[] | null;
  /** Kept when the server answered, so a 401 stays distinct from a DNS failure. */
  status?: number;
  failure?: ListFailure;
}

/**
 * Record the model-discovery outcome at its normalized boundary.
 *
 * Only the endpoint class, a bounded returned-count bucket, the bounded HTTP
 * status when the server answered, and the metadata source are kept — never
 * the model list, exact identifiers, the raw response, or the exact host.
 *
 * The success case is recorded *after* enrichment finishes, so `metadataSource`
 * describes what actually happened rather than what was about to be attempted,
 * and a later enrichment failure cannot leave a `cached` claim behind.
 */
function recordModelDiscovery(
  outcome: 'ok' | 'error',
  baseUrl: string,
  count: number | undefined,
  metadataSource: ModelMetadataSource,
  extra: { status?: number; error?: unknown } = {},
): void {
  recordDiagnosticEvent({
    subsystem: 'model',
    operation: 'model-list',
    outcome,
    code: outcome === 'ok' ? 'model-list-ok' : 'model-list-failed',
    endpointClass: classifyEndpoint(baseUrl),
    returnedCountBucket: countBucket(count),
    metadataSource,
    ...(extra.status !== undefined ? { httpStatus: extra.status } : {}),
    ...(extra.error !== undefined ? { description: extra.error } : {}),
  });
}

export async function listModels(
  serverRoot: string,
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  modelsCache?: CompactCache | null,
  customModelFetchUrl?: string,
  signal?: AbortSignal,
  requestHeaderSettings: ProfileRequestHeaderSettings = {},
): Promise<ModelInfo[]> {
  const headers = withProfileRequestHeaders({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    // Anthropic's own API only; see `requiresAnthropicVersion`.
    ...(requiresAnthropicVersion(baseUrl) ? { 'anthropic-version': ANTHROPIC_API_VERSION } : {}),
  }, requestHeaderSettings);

  let attempt: FetchAttempt;

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (customModelFetchUrl) {
    // Explicit overrides bypass automatic resolution and provider exceptions.
    attempt = await fetchModelsAtUrl(customModelFetchUrl, headers, fetchImpl, signal);
  } else if (isLocalNetworkUrl(baseUrl)) {
    const nativeUrl = getLocalNativeModelFetchUrl(serverRoot);
    attempt = await fetchModelsAtUrl(nativeUrl, headers, fetchImpl, signal);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!attempt.models || attempt.models.length === 0) {
      const fallbackUrl = `${serverRoot}/models`;
      if (fallbackUrl !== nativeUrl) {
        attempt = await fetchModelsAtUrl(fallbackUrl, headers, fetchImpl, signal);
      }
    }
  } else {
    attempt = await fetchModelsAtUrl(`${serverRoot}/models`, headers, fetchImpl, signal);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const models = attempt.models;
  if (models === null) {
    recordModelDiscovery('error', baseUrl, undefined, 'unknown', {
      ...(attempt.status !== undefined ? { status: attempt.status } : {}),
      error: `model list failed: ${attempt.failure ?? 'unknown'}`,
    });
    throw new Error(`listModels: no models found`);
  }

  // ── Z.ai workaround ─────────────────────────────────────────────
  // Z.ai's /v4/models excludes some free-tier models (e.g. glm-4.7-flash)
  // that are listed under /v4/v1/models. Merge both lists.
  if (!customModelFetchUrl && baseUrl.includes('api.z.ai')) {
    try {
      const extra = (await fetchModelsAtUrl(`${serverRoot}/v1/models`, headers, fetchImpl, signal)).models;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (extra && extra.length > 0) {
        const existing = new Set(models.map((m) => m.id));
        for (const m of extra) {
          if (!existing.has(m.id)) {
            if (models.length >= MODEL_LIST_MAX_ENTRIES) {
              throw new ModelListLimitError(`model list exceeds ${MODEL_LIST_MAX_ENTRIES} entries`);
            }
            models.push(m);
            existing.add(m.id);
          }
        }
        debugLog.log('[LC] listModels: merged', extra.length, 'extra models from Z.ai /v1 endpoint, total', models.length);
      }
    } catch (error) {
      if (error instanceof ModelListLimitError) throw error;
      if (signal?.aborted) throw error;
      // Ignore — the extra endpoint is opportunistic.
    }
  }

  // Enrichment first, then the diagnostic: reporting before enrichment would
  // claim a metadata source LC had not yet obtained.
  let enriched: ModelInfo[];
  let enrichment: 'cached' | 'none';
  try {
    const result = await enrichResult(models, baseUrl, modelsCache);
    enriched = result.models;
    enrichment = result.enrichment;
  } catch {
    // Discovery succeeded; only the metadata layer failed. Say exactly that
    // instead of leaving a successful-looking `cached` or `discovered` claim.
    recordModelDiscovery('ok', baseUrl, models.length, 'unknown', {
      ...(attempt.status !== undefined ? { status: attempt.status } : {}),
    });
    return models;
  }

  recordModelDiscovery(
    'ok',
    baseUrl,
    enriched.length,
    metadataSourceFor(Boolean(customModelFetchUrl), enrichment, enriched),
    { ...(attempt.status !== undefined ? { status: attempt.status } : {}) },
  );
  return enriched;
}

/**
 * Which single value describes where the reported model facts came from.
 *
 * Documented precedence (see `MODEL_METADATA_SOURCES`): a custom endpoint
 * override outranks everything, because LC neither resolved the endpoint nor
 * can vouch for the shape of what it returned. Cached enrichment outranks the
 * server's own list. `discovered` means the server described its models by
 * itself. `unknown` means nothing did.
 */
function metadataSourceFor(
  override: boolean,
  enrichment: 'cached' | 'none',
  models: readonly ModelInfo[],
): ModelMetadataSource {
  if (override) return 'override';
  if (enrichment === 'cached') return 'cached';
  const serverDescribed = models.some((m) =>
    m.max_context_length !== undefined || m.capabilities !== undefined
    || m.loaded_context_length !== undefined || m.source === 'lmstudio-rest');
  return serverDescribed ? 'discovered' : 'unknown';
}

/**
 * Fetch and parse models from one exact URL.
 *
 * `models` is `null` when the endpoint is unreachable, refuses the request, or
 * answers with something unparseable. The bounded `failure` class and the HTTP
 * status (when the server answered at all) are returned alongside so the
 * discovery diagnostic can distinguish a 401 from a DNS failure without ever
 * carrying the response body.
 */
async function fetchModelsAtUrl(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<FetchAttempt> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal });
  } catch {
    return { models: null, failure: 'network' };
  }
  if (!res.ok) return { models: null, status: res.status, failure: 'http' };

  let text: string;
  try {
    text = await readBoundedResponseText(res);
  } catch {
    return { models: null, status: res.status, failure: 'limit' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { models: null, status: res.status, failure: 'parse' };
  }

  // Try REST format.
  const parsedRecord = parsed && typeof parsed === 'object'
    ? parsed as Record<string, unknown>
    : null;
  const restModels = Array.isArray(parsedRecord?.models)
    ? parsedRecord.models as Array<Record<string, unknown>>
    : undefined;
  if (restModels && restModels.length > MODEL_LIST_MAX_ENTRIES) {
    return { models: null, status: res.status, failure: 'limit' };
  }
  if (restModels && restModels.length > 0) {
    const filtered = restModels.filter(
      (m) => {
        const id = m.key;
        return id && m.type !== 'embeddings' && !isNonChatModel(String(id));
      },
    );
    if (filtered.length > 0) {
      const seen = new Set<string>();
      return {
        status: res.status,
        models: filtered
          .filter((m) => {
            const k = String(m.key);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .map((m) => restModelToInfo(m)),
      };
    }
  }

  // OpenAI-compat format.
  const data = Array.isArray(parsedRecord?.data)
    ? parsedRecord.data as Array<Record<string, unknown>>
    : undefined;
  if (data && data.length > MODEL_LIST_MAX_ENTRIES) {
    return { models: null, status: res.status, failure: 'limit' };
  }
  if (data && data.length > 0) {
    return {
      status: res.status,
      models: data
        .filter((m) => !isNonChatModel(String(m.id)))
        .map((m) => compatModelToInfo(m)),
    };
  }

  return { models: null, status: res.status, failure: 'empty' };
}

/**
 * Convert an OpenAI-compatible `data[]` entry to the common ModelInfo shape.
 *
 * Most compatible servers return only `id`, but some describe their models in
 * the same response. Anthropic returns `max_tokens` (largest completion),
 * `max_input_tokens` (context window), and `display_name` on every entry —
 * facts LC previously dropped on the floor and then guessed at, which is how
 * a 128k-output model ended up being sent a hard-coded 4,096 ceiling.
 *
 * Only fields the server actually sent are copied. Anything absent stays
 * absent so the models.dev enrichment layer can still fill it in; enrichment
 * never overwrites a value the server reported.
 */
function compatModelToInfo(m: Record<string, unknown>): ModelInfo {
  const positive = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

  const maxOutput = positive(m.max_tokens);
  const maxInput = positive(m.max_input_tokens);
  const displayName = typeof m.display_name === 'string' && m.display_name.trim()
    ? m.display_name
    : undefined;

  return {
    id: String(m.id),
    object: 'model' as const,
    ...(displayName ? { display_name: displayName } : {}),
    ...(maxInput !== undefined ? { max_context_length: maxInput } : {}),
    ...(maxOutput !== undefined ? { max_output_tokens: maxOutput } : {}),
  };
}

/** Convert an LM Studio REST model entry to the common ModelInfo shape. */
function restModelToInfo(m: Record<string, unknown>): ModelInfo {
  const key = m.key as string;
  const rawDisplayName = m.display_name as string | undefined;
  const loaded = (m.loaded_instances as Array<{ id: string; config?: { context_length?: number } }> | undefined) ?? [];
  const state = loaded.length > 0 ? 'loaded' : 'not-loaded';
  const ctx = loaded[0]?.config ? (loaded[0].config as Record<string, unknown>).context_length as number | undefined : undefined;

  return {
    id: key,
    object: 'model' as const,
    // Keep the server's display label intact. Settings surfaces choose the
    // full id for native LM Studio entries; metadata enrichment must never
    // rewrite the stable identifier.
    ...(rawDisplayName ? { display_name: rawDisplayName } : {}),
    ...(m.type ? { type: m.type as string } : {}),
    ...(m.architecture ? { architecture: m.architecture as string } : {}),
    ...(typeof m.max_context_length === 'number' ? { max_context_length: m.max_context_length as number } : {}),
    state,
    ...(typeof ctx === 'number' ? { loaded_context_length: ctx } : {}),
    ...(loaded.length > 0 ? { loaded_instances: loaded } : {}),
    ...(m.reasoning_config ? { reasoning_config: m.reasoning_config as Record<string, unknown> } : {}),
    ...(m.capabilities ? { capabilities: m.capabilities as ModelInfo['capabilities'] } : {}),
    source: 'lmstudio-rest' as const,
  } as ModelInfo;
}

/**
 * Enrich model entries with models.dev metadata (display names,
 * context windows, capabilities). Uses the bundled models-cache.json
 * or a Tauri-side lookup for richer data.
 *
 * Reports whether any entry actually gained cached metadata, so the discovery
 * diagnostic can say `cached` only when that is what happened.
 */
async function enrichResult(
  models: ModelInfo[],
  baseUrl: string,
  modelsCache?: CompactCache | null,
): Promise<{ models: ModelInfo[]; enrichment: 'cached' | 'none' }> {
  if (models.length === 0) return { models, enrichment: 'none' };

  let cache = modelsCache ?? null;
  let tauriEnriched = false;
  if (!cache) {
    // Auto-load: Tauri uses Rust invoke, browser fetches /models-cache.json
    const tauriInternals = typeof window !== 'undefined'
      ? (window as Window & {
        __TAURI_INTERNALS__?: {
          invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
        };
      }).__TAURI_INTERNALS__
      : undefined;
    if (tauriInternals) {
      try {
        const metaList: Array<Record<string, unknown> | null> =
          await tauriInternals.invoke('lookup_models_dev', {
            baseUrl,
            ids: models.map((m) => m.id),
          });
        debugLog.log('[LC] listModels: enriched', models.length, 'models via Tauri lookup_models_dev');
        // If Tauri found metadata for ALL models, return immediately.
        // Otherwise fall through to JS-based enrichment so the
        // prefix-stripping fallback in lookupInProviders can fill
        // gaps for local LM Studio servers.
        if (metaList.every(meta => meta !== null)) {
          return {
            models: models.map((m, i) => enrichOne(m, metaList[i] ?? null)),
            enrichment: 'cached',
          };
        }
        // Partial — enrich what Tauri found, fall through for the rest.
        if (metaList.some((meta) => meta !== null)) tauriEnriched = true;
        models = models.map((m, i) => enrichOne(m, metaList[i] ?? null));
      } catch (err) {
        debugLog.warn('[LC] listModels: Tauri models.dev lookup failed:', err);
      }
    }

    // Browser fallback: bundled (or runtime-overridden, after a manual
    // models.dev refresh) compact provider-scoped cache — shared loader so
    // this path and model-enricher can never disagree about which copy is
    // current. Memoized, unlike the per-call fetch this replaces.
    try {
      const loaded = await loadCompactModelsCache();
      if (Object.keys(loaded).length > 0) {
        cache = loaded;
        debugLog.log('[LC] listModels: loaded models-cache.json —', Object.keys(cache).length, 'providers');
      }
    } catch { /* not available */ }
  }

  if (cache) {
    const matched = findProvidersInCache(cache, baseUrl);
    let matchedAny = false;
    const enriched = models.map((m) => {
      const meta = lookupInProviders(matched, m.id);
      if (meta) matchedAny = true;
      return enrichOne(m, meta);
    });
    return { models: enriched, enrichment: matchedAny || tauriEnriched ? 'cached' : 'none' };
  }

  debugLog.warn('[LC] listModels: no models.dev cache available — cloud models will have sparse metadata');
  return { models, enrichment: tauriEnriched ? 'cached' : 'none' };
}
