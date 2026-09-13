/**
 * The model-visible descriptions of `lc_web_search` and `lc_web_research`
 * must name the provider that will actually serve the call.
 *
 * This exists because an external review found `lc_web_research` still
 * announcing "searches the web via Brave Search … Requires Brave Search API
 * key" after the multi-provider change. On a Marginalia install the model was
 * told it was querying Brave — and since this tool feeds a sub-agent that
 * writes the user-facing summary, that falsehood reaches prose the user reads.
 *
 * `materialize()` evaluates function-form descriptions from current settings.
 * Generation admission captures the resulting text for calls and re-streams.
 * The text must reflect settings at materialization, not at module import.
 *
 * Uses the stubbed-storage + dynamic-import pattern from
 * `store/settings-brave-key.test.ts`: the settings store persists through
 * zustand, so writing to it needs `localStorage` to exist before the module
 * graph loads.
 */
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

const { useSettings } = await import('../../store/settings.ts');
const { HANDLERS_BY_NAME } = await import('./registry.ts');

/** Resolve a handler's description the same way `materialize()` does. */
function describeTool(name: string, tools: Record<string, unknown>): string {
  const prev = useSettings.getState().tools;
  useSettings.setState({ tools: { ...prev, ...tools } as typeof prev });
  try {
    const handler = HANDLERS_BY_NAME.get(name)!;
    return typeof handler.description === 'function'
      ? handler.description()
      : handler.description;
  } finally {
    useSettings.setState({ tools: prev });
  }
}

const NO_PROVIDER = {
  brave_search_api_key: '',
  brave_search_api_key_ref: undefined,
  searxng_base_url: '',
  marginalia_api_key: '',
  marginalia_api_key_ref: undefined,
  web_search_provider: 'auto',
};

beforeEach(() => {
  useSettings.setState({
    tools: { ...useSettings.getState().tools, ...NO_PROVIDER } as never,
  });
});

for (const tool of ['lc_web_search', 'lc_web_research']) {
  describe(`${tool} description`, () => {
    test('names Brave when Brave is active', () => {
      const text = describeTool(tool, { ...NO_PROVIDER, brave_search_api_key: 'bsa-key' });
      assert.match(text, /Brave Search/);
      assert.doesNotMatch(text, /Marginalia|SearXNG/);
    });

    test('names SearXNG when SearXNG is active', () => {
      const text = describeTool(tool, { ...NO_PROVIDER, searxng_base_url: 'http://localhost:8080' });
      assert.match(text, /SearXNG/);
      assert.doesNotMatch(text, /Brave|Marginalia/);
    });

    test('names Marginalia when Marginalia is active', () => {
      const text = describeTool(tool, { ...NO_PROVIDER, marginalia_api_key: 'public' });
      assert.match(text, /Marginalia/);
      assert.doesNotMatch(text, /Brave|SearXNG/);
    });

    test('never claims a Brave key is required', () => {
      // The exact regression: this sentence survived the multi-provider
      // change and told every install it needed a Brave key.
      for (const tools of [
        NO_PROVIDER,
        { ...NO_PROVIDER, marginalia_api_key: 'public' },
        { ...NO_PROVIDER, searxng_base_url: 'http://localhost:8080' },
      ]) {
        assert.doesNotMatch(describeTool(tool, tools), /Requires Brave Search API key/i);
      }
    });

    test('says so when nothing is configured', () => {
      const text = describeTool(tool, NO_PROVIDER);
      assert.match(text, /No search provider is currently configured/i);
      assert.doesNotMatch(text, /Brave Search\.|Marginalia\.|SearXNG\./);
    });
  });
}

describe('lc_web_research provider caveats', () => {
  test('warns that Marginalia coverage gaps are not evidence of absence', () => {
    const text = describeTool('lc_web_research', { ...NO_PROVIDER, marginalia_api_key: 'public' });
    assert.match(text, /does not mean the information does not exist/i);
  });

  test('tells the model cross_check is unavailable on Marginalia', () => {
    // Otherwise it spends a parameter that is silently capped, and cannot
    // explain why its second search never happened.
    const text = describeTool('lc_web_research', { ...NO_PROVIDER, marginalia_api_key: 'public' });
    assert.match(text, /cross_check/);
    assert.match(text, /not available|ignored/i);
  });

  test('keeps the cost model visible on providers that support cross_check', () => {
    // Replaces the old hardcoded "1 Brave Search call" assertion in
    // system-prompt.test.ts. The model needs the cost to decide whether the
    // second search is worth it; only the backend name became configurable.
    const text = describeTool('lc_web_research', { ...NO_PROVIDER, brave_search_api_key: 'bsa' });
    assert.match(text, /1 search call/i);
    assert.match(text, /second, broad search/i);
  });
});
