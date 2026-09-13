/**
 * Search-provider resolution.
 *
 * The rules that matter here are the ones a user can reach by accident:
 * settings written by an older build that predate these fields, and a
 * selector still pointing at a provider whose credential has since been
 * removed. Both must degrade to "search still works" rather than throwing —
 * the second one crashed the settings panel during development, because
 * TypeScript says `web_search_provider` is always present while persisted
 * localStorage disagreed.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  configuredProviders,
  credentialFor,
  ignoredParamsFor,
  isConfigured,
  resolveSearchProvider,
  type SearchProviderSettings,
} from './search-provider.ts';

/** Settings with nothing configured. */
function base(overrides: Partial<SearchProviderSettings> = {}): SearchProviderSettings {
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

describe('resolveSearchProvider', () => {
  test('returns null when nothing is configured', () => {
    assert.equal(resolveSearchProvider(base()), null);
  });

  test('auto picks the only configured provider', () => {
    const r = resolveSearchProvider(base({ marginalia_api_key: 'public' }));
    assert.equal(r?.provider, 'marginalia');
    assert.equal(r?.apiKey, 'public');
    assert.equal(r?.baseUrl, '');
  });

  test('auto follows brave > searxng > marginalia', () => {
    const all = base({
      brave_search_api_key: 'bsa',
      searxng_base_url: 'http://localhost:8080',
      marginalia_api_key: 'public',
    });
    assert.equal(resolveSearchProvider(all)?.provider, 'brave');

    const noBrave = { ...all, brave_search_api_key: '' };
    assert.equal(resolveSearchProvider(noBrave)?.provider, 'searxng');

    const onlyMarginalia = { ...noBrave, searxng_base_url: '' };
    assert.equal(resolveSearchProvider(onlyMarginalia)?.provider, 'marginalia');
  });

  test('an explicit selection overrides the priority order', () => {
    const r = resolveSearchProvider(base({
      brave_search_api_key: 'bsa',
      marginalia_api_key: 'public',
      web_search_provider: 'marginalia',
    }));
    assert.equal(r?.provider, 'marginalia', 'explicit pin must beat brave');
  });

  test('a pin whose credential was removed falls back instead of failing', () => {
    // The user pinned marginalia, then deleted the key. Search must keep
    // working on what is left rather than erroring on a stale preference.
    const r = resolveSearchProvider(base({
      searxng_base_url: 'http://localhost:8080',
      web_search_provider: 'marginalia',
    }));
    assert.equal(r?.provider, 'searxng');
  });

  test('settings from a build without these fields behave as auto', () => {
    // Zustand's persist merge is shallow, so a stored `tools` object written
    // before this feature has no `web_search_provider` at all.
    const legacy = {
      brave_search_api_key: 'bsa',
      searxng_base_url: undefined,
      marginalia_api_key: undefined,
    } as unknown as SearchProviderSettings;
    assert.doesNotThrow(() => resolveSearchProvider(legacy));
    assert.equal(resolveSearchProvider(legacy)?.provider, 'brave');
  });

  test('an unrecognised stored provider behaves as auto', () => {
    const weird = base({
      brave_search_api_key: 'bsa',
      web_search_provider: 'kagi' as unknown as SearchProviderSettings['web_search_provider'],
    });
    assert.equal(resolveSearchProvider(weird)?.provider, 'brave');
  });

  test('searxng carries a base URL, never an api key', () => {
    const r = resolveSearchProvider(base({ searxng_base_url: '  http://localhost:8080  ' }));
    assert.equal(r?.provider, 'searxng');
    assert.equal(r?.baseUrl, 'http://localhost:8080', 'must be trimmed');
    assert.equal(r?.apiKey, '');
  });

  test('searxng URL user-info is not treated as configuration', () => {
    const settings = base({
      searxng_base_url: 'https://user:password@search.example.test',
    });
    assert.equal(credentialFor('searxng', settings), '');
    assert.equal(isConfigured('searxng', settings), false);
    assert.equal(resolveSearchProvider(settings), null);
  });

  test('searxng credentialed and invalid values are not treated as configuration', () => {
    for (const searxngBaseUrl of [
      'https://search.example.test?token=SEARCH_QUERY_SECRET',
      'https://search.example.test#token=SEARCH_FRAGMENT_SECRET',
      'search.example.test?token=MISSING_SCHEME_SECRET#access_token=FRAGMENT_SECRET',
      'https://[invalid?token=MALFORMED_HOST_SECRET',
      'data:text/plain,api_key=PASTED_SCHEME_SECRET',
      'file:///C:/Users/PRIVATE_SCHEME_USER/search',
      'ftp://search.example.test',
    ]) {
      const settings = base({ searxng_base_url: searxngBaseUrl });
      assert.equal(credentialFor('searxng', settings), '');
      assert.equal(isConfigured('searxng', settings), false);
      assert.equal(resolveSearchProvider(settings), null);
    }
  });

  test('whitespace-only credentials do not count as configured', () => {
    assert.equal(resolveSearchProvider(base({ brave_search_api_key: '   ' })), null);
  });
});

describe('credentialFor / isConfigured', () => {
  test('an unknown provider is simply unconfigured, not an exception', () => {
    const p = 'bing' as unknown as Parameters<typeof credentialFor>[0];
    assert.equal(credentialFor(p, base()), '');
    assert.equal(isConfigured(p, base()), false);
  });

  test('configuredProviders lists in priority order', () => {
    const s = base({ marginalia_api_key: 'public', brave_search_api_key: 'bsa' });
    assert.deepEqual(configuredProviders(s), ['brave', 'marginalia']);
  });
});

describe('ignoredParamsFor', () => {
  test('brave honours everything', () => {
    assert.deepEqual(
      ignoredParamsFor('brave', { freshness: 'pw', extra_snippets: true }),
      [],
    );
  });

  test('marginalia reports both unsupported filters', () => {
    assert.deepEqual(
      ignoredParamsFor('marginalia', { freshness: 'pw', extra_snippets: true }),
      ['freshness', 'extra_snippets'],
    );
  });

  test('searxng honours every freshness preset, including pw', () => {
    // All four map onto SearXNG's time_range. `week` is absent from its
    // published API docs but a live instance accepts it — the docs are
    // incomplete, so do not "correct" this back to reporting pw as ignored.
    for (const preset of ['pd', 'pw', 'pm', 'py']) {
      assert.deepEqual(
        ignoredParamsFor('searxng', { freshness: preset }),
        [],
        `${preset} should be honoured`,
      );
    }
  });

  test('searxng reports a custom date range as ignored', () => {
    // time_range has no equivalent for an arbitrary window.
    assert.deepEqual(
      ignoredParamsFor('searxng', { freshness: '2024-01-01to2024-06-30' }),
      ['freshness'],
    );
  });

  test('searxng still reports extra_snippets', () => {
    assert.deepEqual(
      ignoredParamsFor('searxng', { freshness: 'pd', extra_snippets: true }),
      ['extra_snippets'],
    );
  });

  test('only params the caller actually supplied are reported', () => {
    // Reporting a filter nobody asked for would be noise, and would teach the
    // model that its request was altered when it was not.
    assert.deepEqual(ignoredParamsFor('marginalia', { freshness: 'pw' }), ['freshness']);
    assert.deepEqual(ignoredParamsFor('marginalia', {}), []);
    assert.deepEqual(
      ignoredParamsFor('marginalia', { freshness: undefined, extra_snippets: undefined }),
      [],
    );
  });
});
