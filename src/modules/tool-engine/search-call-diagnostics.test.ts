/**
 * Search diagnostics, through the real resolver and the real search tools.
 *
 * The reviewed build only instrumented the success path, so a genuine provider
 * outage reached a support report as a generic tool error and never as a search
 * failure. These tests run the shipped `lc_web_search` and `lc_web_research`
 * handlers against a stub sandbox and read the diagnostic ring; nothing is
 * injected.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSearchProvider,
  resolveSearchProviderQuietly,
  type SearchProviderSettings,
} from './search-provider.ts';
import { webSearch } from './builtin/web_search.ts';
import { webResearch } from './builtin/web_research.ts';
import {
  readDiagnosticEvents,
  resetDiagnosticEvents,
  type DiagnosticEvent,
} from '../../utils/diagnostic-events.ts';
import type { ToolHandlerContext } from './types';

function settings(overrides: Partial<SearchProviderSettings> = {}): SearchProviderSettings {
  return {
    brave_search_api_key: '',
    brave_search_api_key_ref: undefined,
    searxng_base_url: '',
    marginalia_api_key: '',
    marginalia_api_key_ref: undefined,
    web_search_provider: 'auto',
    ...overrides,
  };
}

function searchEvents(operation: 'resolve' | 'call'): DiagnosticEvent[] {
  return readDiagnosticEvents().filter(
    (event) => event.subsystem === 'search' && event.operation === operation,
  );
}

/** A tool context whose sandbox is the only thing the search tools touch. */
function context(
  provider: 'brave' | 'searxng' | 'marginalia' | null,
  webSearchImpl: (input: Record<string, unknown>) => Promise<unknown>,
): ToolHandlerContext {
  return {
    config: {
      searchProvider: provider
        ? { provider, apiKey: provider === 'searxng' ? '' : 'seeded-secret-key', baseUrl: provider === 'searxng' ? 'http://localhost:8888' : '' }
        : null,
      allowedRoots: [],
      shellAllowlist: [],
    },
    identity: { operationId: 'op', groupId: 'group' },
    signal: new AbortController().signal,
    sandbox: { webSearch: webSearchImpl },
  } as unknown as ToolHandlerContext;
}

beforeEach(() => {
  resetDiagnosticEvents();
});

describe('the resolver records selection, resolution, and configuration', () => {
  it('reports `auto` as a selection rather than as unknown', () => {
    resolveSearchProvider(settings({ marginalia_api_key: 'public' }));

    const [event] = searchEvents('resolve');
    assert.equal(event.searchSelected, 'auto');
    assert.equal(event.searchResolved, 'marginalia');
    assert.equal(event.searchConfigured, true);
    assert.deepEqual(event.searchConfiguredProviders, ['marginalia']);
  });

  it('reports a stale explicit selection alongside the provider that resolved', () => {
    resolveSearchProvider(settings({
      searxng_base_url: 'http://localhost:8888',
      web_search_provider: 'marginalia',
    }));

    const [event] = searchEvents('resolve');
    assert.equal(event.searchSelected, 'marginalia');
    assert.equal(event.searchResolved, 'searxng');
  });

  it('reports `none` when nothing is configured', () => {
    assert.equal(resolveSearchProvider(settings({ web_search_provider: 'brave' })), null);

    const [event] = searchEvents('resolve');
    assert.equal(event.code, 'search-not-configured');
    assert.equal(event.searchSelected, 'brave');
    assert.equal(event.searchResolved, 'none');
    assert.equal(event.searchConfigured, false);
    assert.deepEqual(event.searchConfiguredProviders, undefined);
  });

  it('treats a keychain reference with no cached key as not configured', () => {
    // The reference exists in settings but no key was ever loaded into the
    // process. The resolver must not claim the provider resolved.
    assert.equal(
      resolveSearchProvider(settings({ brave_search_api_key_ref: 'lc:brave' })),
      null,
    );

    const [event] = searchEvents('resolve');
    assert.equal(event.searchResolved, 'none');
    assert.equal(event.searchConfigured, false);
  });
});

describe('lc_web_search records every call outcome', () => {
  it('records a success with a bounded result-count bucket', async () => {
    await webSearch.run({ query: 'anything' }, context('brave', async () => ({
      results: [{ title: 't', url: 'https://example.test', snippet: 's' }],
      source: 'brave',
    })));

    const [event] = searchEvents('call');
    assert.equal(event.code, 'search-ok');
    assert.equal(event.searchResolved, 'brave');
    assert.equal(event.resultCountBucket, '1-9');
  });

  it('records no-results separately from a failure', async () => {
    await webSearch.run({ query: 'anything' }, context('brave', async () => ({
      results: [], source: 'brave',
    })));

    const [event] = searchEvents('call');
    assert.equal(event.code, 'search-no-results');
    assert.equal(event.resultCountBucket, 'none');
  });

  it('records a thrown provider failure as search-provider-error', async () => {
    await assert.rejects(() => webSearch.run({ query: 'anything' }, context('searxng', async () => {
      throw new Error('search failed: 503 Service Unavailable');
    })));

    const [event] = searchEvents('call');
    assert.equal(event.code, 'search-provider-error');
    assert.equal(event.outcome, 'error');
    assert.equal(event.searchResolved, 'searxng');
  });

  it('records missing configuration when the tool runs with no provider', async () => {
    await assert.rejects(() => webSearch.run({ query: 'anything' }, context(null, async () => ({}))));

    const [event] = searchEvents('call');
    assert.equal(event.code, 'search-not-configured');
    assert.equal(event.searchResolved, 'none');
  });

  it('records only allowlisted ignored parameter names', async () => {
    await webSearch.run(
      { query: 'anything', freshness: 'pd', extra_snippets: true },
      context('marginalia', async () => ({ results: [], source: 'marginalia' })),
    );

    const [event] = searchEvents('call');
    assert.deepEqual(event.ignoredParams, ['freshness', 'extra_snippets']);
  });

  it('records ignored parameters on a failure too', async () => {
    await assert.rejects(() => webSearch.run(
      { query: 'anything', extra_snippets: true },
      context('searxng', async () => { throw new Error('provider exploded'); }),
    ));

    const [event] = searchEvents('call');
    assert.equal(event.code, 'search-provider-error');
    assert.deepEqual(event.ignoredParams, ['extra_snippets']);
  });

  it('records no query, result, key, or host', async () => {
    await webSearch.run(
      { query: 'SEEDED-SECRET-QUERY' },
      context('brave', async () => ({
        results: [{ title: 'SEEDED-SECRET-TITLE', url: 'https://secret-host.test/p', snippet: 'SEEDED-SECRET-SNIPPET' }],
        source: 'brave',
      })),
    );

    const serialized = JSON.stringify(readDiagnosticEvents());
    for (const forbidden of ['SEEDED-SECRET', 'secret-host', 'seeded-secret-key']) {
      assert.ok(!serialized.includes(forbidden), `search diagnostics must not carry ${forbidden}`);
    }
  });
});

describe('lc_web_research records its own provider calls', () => {
  it('gives Marginalia effective recovery advice after an empty focused search', async () => {
    const queries: unknown[] = [];
    const result = await webResearch.run(
      { query: 'anything', preferred_domains: ['example.test'], cross_check: true },
      context('marginalia', async (input) => {
        queries.push(input.query);
        return { results: [], source: 'marginalia' };
      }),
    );

    assert.deepEqual(queries, ['(site:example.test) anything']);
    assert.equal(result.research_info.search_mode, 'focused');
    assert.equal(result.research_info.search_requests_used, 1);
    assert.ok(result.research_info.ignored_params.includes('cross_check'));
    assert.ok(typeof result.confidence_note === 'string');
    assert.match(result.confidence_note, /Remove preferred_domains/);
    assert.doesNotMatch(result.confidence_note, /cross_check/);
  });

  it('retains cross-check recovery advice for Brave after an empty focused search', async () => {
    const queries: unknown[] = [];
    const result = await webResearch.run(
      { query: 'anything', preferred_domains: ['example.test'] },
      context('brave', async (input) => {
        queries.push(input.query);
        return { results: [], source: 'brave' };
      }),
    );

    assert.deepEqual(queries, ['(site:example.test) anything']);
    assert.equal(result.research_info.search_mode, 'focused');
    assert.equal(result.research_info.search_requests_used, 1);
    assert.deepEqual(result.research_info.ignored_params, []);
    assert.ok(typeof result.confidence_note === 'string');
    assert.match(result.confidence_note, /Remove preferred_domains/);
    assert.match(result.confidence_note, /cross_check=true/);
  });

  it('records a provider failure from the research path', async () => {
    await assert.rejects(() => webResearch.run(
      { query: 'anything' },
      context('brave', async () => { throw new Error('search failed: 429 Too Many Requests'); }),
    ));

    const [event] = searchEvents('call');
    assert.equal(event.code, 'search-provider-error');
    assert.equal(event.searchResolved, 'brave');
  });

  it('records missing configuration from the research path', async () => {
    await assert.rejects(() => webResearch.run({ query: 'anything' }, context(null, async () => ({}))));

    const [event] = searchEvents('call');
    assert.equal(event.code, 'search-not-configured');
  });

  it('records the restricted cross_check parameter as ignored', async () => {
    await assert.rejects(() => webResearch.run(
      { query: 'anything', preferred_domains: ['example.test'], cross_check: true },
      context('marginalia', async () => { throw new Error('provider exploded'); }),
    ));

    const [event] = searchEvents('call');
    assert.ok(event.ignoredParams?.includes('cross_check'));
  });
});

describe('describing a tool is not resolving a provider', () => {
  it('records nothing when the tool description regenerates', () => {
    // `materialize()` can build a description without executing a search. Recording it
    // reported resolutions that never served a call and, in a real report,
    // filled 30 of the 64 ring entries.
    const tools = settings({ searxng_base_url: 'http://localhost:8888' });
    for (let i = 0; i < 20; i++) resolveSearchProviderQuietly(tools);

    assert.deepEqual(searchEvents('resolve'), []);
  });

  it('returns the same provider the recording resolver would', () => {
    const tools = settings({
      searxng_base_url: 'http://localhost:8888',
      web_search_provider: 'marginalia',
    });
    assert.equal(resolveSearchProviderQuietly(tools)?.provider, resolveSearchProvider(tools)?.provider);
  });
});
