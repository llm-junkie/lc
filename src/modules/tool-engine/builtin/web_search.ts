/**
 * web_search — search the web via the user's configured provider.
 *
 * One of Brave Search, a self-hosted SearXNG instance, or Marginalia. The
 * provider is captured from settings at generation admission. The model never
 * chooses it. See `src/modules/tool-engine/search-provider.ts` and
 * `docs/search-providers.md`.
 */
import { z } from 'zod';
import type { ToolHandler } from '../types';
import type { JsonSchema } from '../../llm-client/types';
import { remainingMs } from '../runner.ts';
import { useSettings } from '../../../store/settings.ts';
import {
  NO_PROVIDER_MESSAGE,
  PROVIDER_LABEL,
  ignoredParamsFor,
  resolveSearchProviderQuietly,
} from '../search-provider.ts';
import {
  recordSearchNotConfigured,
  withSearchCallDiagnostics,
} from '../search-diagnostics.ts';

const schema = z.object({
  /** Search query. */
  query: z.string().refine(
    (value) => value.trim().length > 0,
    'query must contain non-whitespace text. Send the topic or question to search for.',
  ),
  /** Maximum results to return. Default 5, hard cap 10. */
  max_results: z.number().int().positive().max(
    10,
    'max_results must be at most 10. Use 10 or a smaller result limit.',
  ).optional(),
  /**
   * Result freshness filter. "pd" = past day, "pw" = past week,
   * "pm" = past month, "py" = past year, or a custom date range
   * like "2024-01-01to2024-06-30". Omit for all time.
   */
  freshness: z
    .string()
    .trim()
    .regex(/^(?:|pd|pw|pm|py|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/)
    .optional(),
  /** Request up to 5 additional alternative excerpts per result. */
  extra_snippets: z.boolean().optional(),
});

export type WebSearchInput = z.infer<typeof schema>;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Up to 5 additional alternative excerpts; empty when unavailable/not requested. */
  extra_snippets: string[];
}

export interface WebSearchOutput {
  results: WebSearchResult[];
  source: string;
  /**
   * Parameters that were supplied but the active provider cannot honour.
   *
   * Empty when every supplied parameter was honoured. This is the difference between "no recent
   * results exist" and "the recency filter was ignored" — without it a model
   * asking for last-week results receives all-time results and reports them
   * as recent.
   */
  ignored_params: string[];
}

const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;

/**
 * Describe the *active* provider, not a matrix of all of them.
 *
 * Generation admission calls `materialize()` and captures the description.
 * Calls and re-streams reuse it. A provider change applies to later generations.
 * A matrix would be worse than useless
 * here: the model has no way to know which provider is active, so it would
 * have to guess which caveats apply.
 */
function describe(): string {
  // Quiet: materializing a description does not execute a search.
  // Recording it would report resolutions that never served a call.
  const resolved = resolveSearchProviderQuietly(useSettings.getState().tools);
  if (!resolved) {
    return 'Search the web.\n' +
      'No search provider is currently configured.\n' +
      'Configure one in Settings before you call lc_web_search.';
  }
  const base =
    'Search the web using ' + PROVIDER_LABEL[resolved.provider] + '.\n' +
    'Each result includes a title, URL, and snippet.\n' +
    'max_results defaults to 5 and has a hard limit of 10.';
  switch (resolved.provider) {
    case 'brave':
      return base +
        '\nUse freshness to filter results by recency.\n' +
        'Accepted values are pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD.\n' +
        'Set extra_snippets=true to request additional excerpts.';
    case 'searxng':
      return base +
        '\nThis self-hosted metasearch instance aggregates mainstream engines.\n' +
        'freshness supports the pd, pw, pm, and py presets.\n' +
        'It does not support a custom YYYY-MM-DDtoYYYY-MM-DD range.\n' +
        'It does not support extra_snippets.\n' +
        'ignored_params reports each unsupported supplied parameter.';
    case 'marginalia':
      return base +
        '\nMarginalia indexes independent, text-oriented sites.\n' +
        'It has limited coverage of commercial and mainstream pages.\n' +
        'An absent result does not mean the information does not exist.\n' +
        'Marginalia does not support freshness or extra_snippets.\n' +
        'If supplied, LC ignores these parameters and reports them in ignored_params.';
  }
}

export const webSearch: ToolHandler<WebSearchInput, WebSearchOutput> = {
  name: 'lc_web_search',
  description: describe,
  uiDescription: 'Search the web via your configured provider.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    const trimmedQuery = input.query.trim();
    const resolved = ctx.config.searchProvider;
    if (!resolved) {
      recordSearchNotConfigured();
      throw new Error(NO_PROVIDER_MESSAGE);
    }

    const freshness = input.freshness?.trim() || undefined;
    const ignored = ignoredParamsFor(resolved.provider, {
      freshness,
      extra_snippets: input.extra_snippets,
    });

    // The normalized boundary lives in `withSearchCallDiagnostics`, so a
    // provider failure records `search-provider-error` instead of reaching the
    // report only as a generic tool error.
    const out = await withSearchCallDiagnostics(
      resolved.provider,
      ignored,
      () => ctx.sandbox.webSearch({
        query: trimmedQuery,
        max_results: input.max_results ?? undefined,
        provider: resolved.provider,
        api_key: resolved.apiKey || undefined,
        base_url: resolved.baseUrl || undefined,
        // Send provider-specific params only where they mean something. The
        // Rust side ignores them anyway; not sending them keeps the wire
        // payload honest about what was actually requested.
        freshness: ignored.includes('freshness') ? undefined : freshness,
        extra_snippets: ignored.includes('extra_snippets')
          ? undefined
          : input.extra_snippets ?? undefined,
        call_id: ctx.identity.operationId,
        group_id: ctx.identity.groupId,
        deadline_ms: remainingMs(ctx.config.deadlineMs, 30_000),
      }),
      (value) => value.results?.length ?? 0,
    );

    return {
      ...out,
      results: (out.results ?? []).map((result) => ({
        ...result,
        extra_snippets: result.extra_snippets ?? [],
      })),
      ignored_params: ignored,
    };
  },
};
