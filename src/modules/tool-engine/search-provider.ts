/**
 * Which search backend serves `lc_web_search` / `lc_web_research`, and with
 * what credential.
 *
 * The user chooses; the model never does. A model that could switch index
 * mid-conversation could quietly change what "the web says" means, so the
 * provider is captured from settings at generation admission and passed down
 * as config. Calls and re-streams reuse it. Callers without a snapshot resolve
 * the current settings separately.
 *
 * There is deliberately **no fallback chain**. Exactly one provider serves a
 * given call. A cascade would let one provider's rate limit drain the next
 * (Marginalia's shared key allows roughly 3 queries/minute, so a Brave 429
 * spilling over would burn it immediately), and would blend results carrying
 * different licences into a single response.
 *
 * See docs/search-providers.md for the measurements behind these rules.
 */
import {
  WEB_SEARCH_PRIORITY,
  type ConcreteWebSearchProvider,
  type WebSearchProvider,
} from '../../store/settings.ts';
import { getSearchKey } from '../../platform/search-key-cache.ts';
import { recordDiagnosticEvent } from '../../utils/diagnostic-events.ts';
import type { SearchProviderSelection } from '../../utils/support-report-base';
import { isHttpUrlCredentialFree } from '../../utils/url-credentials.ts';

/** The settings fields this module reads. Narrowed so callers can pass either
 *  the live store slice or a plain object in tests. */
export interface SearchProviderSettings {
  brave_search_api_key: string;
  brave_search_api_key_ref?: string;
  searxng_base_url: string;
  marginalia_api_key: string;
  marginalia_api_key_ref?: string;
  web_search_provider: WebSearchProvider;
}

/** A resolved provider plus the credential the Rust side needs. */
export interface ResolvedSearchProvider {
  provider: ConcreteWebSearchProvider;
  /** API key for brave/marginalia. Empty for searxng. */
  apiKey: string;
  /** Base URL for searxng. Empty for the others. */
  baseUrl: string;
}

/**
 * The live credential for a provider, or `''` when it has none.
 *
 * Keys prefer the in-memory cache (decrypted from the keychain at startup)
 * and fall back to the settings store, which holds the plaintext only on the
 * web build or after a failed keychain write.
 */
export function credentialFor(
  provider: ConcreteWebSearchProvider,
  tools: SearchProviderSettings,
): string {
  switch (provider) {
    case 'brave':
      return getSearchKey('brave') ?? tools.brave_search_api_key ?? '';
    case 'marginalia':
      return getSearchKey('marginalia') ?? tools.marginalia_api_key ?? '';
    case 'searxng':
      return isHttpUrlCredentialFree(tools.searxng_base_url ?? '')
        ? tools.searxng_base_url ?? ''
        : '';
    // Not dead code despite the type: settings arrive from persisted
    // localStorage written by an older build, where this field may be absent
    // or hold a value this version has never heard of. Returning '' makes
    // such a provider simply "not configured" instead of throwing.
    default:
      return '';
  }
}

/** Whether a provider has everything it needs to run a search. */
export function isConfigured(
  provider: ConcreteWebSearchProvider,
  tools: SearchProviderSettings,
): boolean {
  return credentialFor(provider, tools).trim().length > 0;
}

/** Every provider the user has configured, in priority order. */
export function configuredProviders(
  tools: SearchProviderSettings,
): ConcreteWebSearchProvider[] {
  return WEB_SEARCH_PRIORITY.filter((p) => isConfigured(p, tools));
}

/**
 * The selection/resolution decision, with no knowledge of credentials.
 *
 * `available` says which providers can serve a call; the caller decides what
 * "available" means. The live resolver passes credential-backed availability;
 * the support-report collector passes configuration presence only, because
 * report collection must not read a credential or re-run the resolver. Keeping
 * one algorithm here is what stops the two from drifting apart and reporting a
 * provider as resolved that the real resolver would never have picked.
 */
export function decideSearchProvider(
  selection: WebSearchProvider | undefined,
  available: Readonly<Record<ConcreteWebSearchProvider, boolean>>,
): { selected: SearchProviderSelection; resolved: ConcreteWebSearchProvider | 'none' } {
  const selected = normalizeSelection(selection);
  // Anything that is not a known concrete provider — including `undefined`
  // from settings persisted before this field existed — behaves as `auto`.
  const explicit = WEB_SEARCH_PRIORITY.find((p) => p === selection);
  const pick = explicit && available[explicit]
    ? explicit
    : WEB_SEARCH_PRIORITY.find((p) => available[p]);
  return { selected, resolved: pick ?? 'none' };
}

/** Closed selection vocabulary. `auto` is a real selection, not an absence. */
export function normalizeSelection(value: unknown): SearchProviderSelection {
  if (value === 'brave' || value === 'searxng' || value === 'marginalia') return value;
  // Settings default to `auto`, and settings written before this field existed
  // have no value at all — both mean the same thing to the resolver.
  if (value === 'auto' || value === undefined) return 'auto';
  return 'unknown';
}

/** Per-provider credential-backed availability, in the resolver's terms. */
function availability(
  tools: SearchProviderSettings,
): Record<ConcreteWebSearchProvider, boolean> {
  return {
    brave: isConfigured('brave', tools),
    searxng: isConfigured('searxng', tools),
    marginalia: isConfigured('marginalia', tools),
  };
}

/**
 * Which provider would serve a call, without recording anything.
 *
 * Used where the answer is needed to *phrase* something rather than to run a
 * search. Generation admission captures tool descriptions for reuse. Other
 * callers can also materialize descriptions without starting a search.
 * Recording descriptions as resolutions filled the diagnostic ring. A real
 * report showed 30 of 64 entries as identical search resolutions, none of
 * which corresponded to a search.
 */
export function resolveSearchProviderQuietly(
  tools: SearchProviderSettings,
): ResolvedSearchProvider | null {
  const decision = decideSearchProvider(tools.web_search_provider, availability(tools));
  return decision.resolved === 'none' ? null : toResolved(decision.resolved, tools);
}

/**
 * Resolve the provider for this call, or `null` when none is configured, and
 * record the outcome.
 *
 * An explicit selection wins when it is configured. When it is not — the user
 * removed the credential but left the selector pointing at it — this falls
 * back to auto-resolution rather than failing. The selector is a preference,
 * not a constraint, and a stale preference must not break search.
 *
 * Call this only where a resolution is about to be *used* for a call. For a
 * description or a settings preview, use `resolveSearchProviderQuietly`.
 */
export function resolveSearchProvider(
  tools: SearchProviderSettings,
): ResolvedSearchProvider | null {
  const available = availability(tools);
  const decision = decideSearchProvider(tools.web_search_provider, available);
  const resolved = decision.resolved === 'none'
    ? null
    : toResolved(decision.resolved, tools);

  // Normalized boundary, and the authoritative record of what resolved. No
  // query, result, key, or exact host is recorded.
  recordDiagnosticEvent({
    subsystem: 'search',
    operation: 'resolve',
    outcome: resolved ? 'ok' : 'rejected',
    code: resolved ? 'search-resolved' : 'search-not-configured',
    searchSelected: decision.selected,
    searchResolved: decision.resolved,
    searchConfigured: resolved !== null,
    searchConfiguredProviders: WEB_SEARCH_PRIORITY.filter((p) => available[p]),
  });
  return resolved;
}

function toResolved(
  pick: ConcreteWebSearchProvider,
  tools: SearchProviderSettings,
): ResolvedSearchProvider {
  const credential = credentialFor(pick, tools).trim();
  return {
    provider: pick,
    apiKey: pick === 'searxng' ? '' : credential,
    baseUrl: pick === 'searxng' ? credential : '',
  };
}

/** Human-readable name used in tool descriptions and error messages. */
export const PROVIDER_LABEL: Record<ConcreteWebSearchProvider, string> = {
  brave: 'Brave Search',
  searxng: 'SearXNG',
  marginalia: 'Marginalia',
};

/**
 * Parameters each provider cannot honour.
 *
 * These are reported rather than silently dropped. A model that asks for
 * last-week results and receives all-time results with no signal will present
 * them as recent — silence is a worse failure than an error.
 */
export const UNSUPPORTED_PARAMS: Record<ConcreteWebSearchProvider, readonly string[]> = {
  brave: [],
  // SearXNG honours `freshness` via `time_range` — see FRESHNESS_PRESETS — so
  // it is absent here and handled per-value instead.
  searxng: ['extra_snippets'],
  marginalia: ['freshness', 'extra_snippets'],
};

/**
 * Brave freshness values with a SearXNG `time_range` equivalent.
 *
 * All four presets map 1:1 (`pd`→day, `pw`→week, `pm`→month, `py`→year).
 * `week` is missing from SearXNG's published API docs, which list only
 * `[day, month, year]`, but a live instance accepts it and rejects anything
 * outside `day|week|month|year` with HTTP 400 — the docs are incomplete.
 *
 * Brave also accepts a custom `YYYY-MM-DDtoYYYY-MM-DD` range, which has no
 * SearXNG equivalent and is therefore reported as ignored.
 */
const FRESHNESS_PRESETS = new Set(['pd', 'pw', 'pm', 'py']);

/** Which of the caller's supplied params the active provider will ignore. */
export function ignoredParamsFor(
  provider: ConcreteWebSearchProvider,
  supplied: Record<string, unknown>,
): string[] {
  const ignored = UNSUPPORTED_PARAMS[provider].filter(
    (p) => supplied[p] !== undefined && supplied[p] !== null,
  );
  // SearXNG takes the four presets but has no custom-date-range equivalent, so
  // whether `freshness` survives depends on its value, not just its presence.
  if (
    provider === 'searxng' &&
    typeof supplied.freshness === 'string' &&
    !FRESHNESS_PRESETS.has(supplied.freshness)
  ) {
    ignored.push('freshness');
  }
  return ignored;
}

/** The message shown when a search tool runs with nothing configured. */
export const NO_PROVIDER_MESSAGE =
  'No web search provider is configured. Add a Brave Search API key, a ' +
  'SearXNG base URL, or a Marginalia API key in Settings → Workspace.';
