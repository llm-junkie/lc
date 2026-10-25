/**
 * Guess lookup — the provider-scoped/all-provider search over the compact
 * models.dev cache. These are the browser half of the dual path; the desktop
 * half hands the same base URL + model ID to Rust's `lookup_models_dev`,
 * whose `find_providers` / `lookup_in_providers` these mirror.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compactEntryToGuess, findProvidersInCache, guessModelMeta, lookupInProviders } from './model-enricher.ts';
import { setRuntimeModelsCache } from '../llm-client/models/enrich.ts';

const cache = {
  openai: {
    api: 'https://api.openai.com/v1',
    m: { 'gpt-5': { c: 400000, n: 'GPT-5', v: true, r: true, t: true } },
  },
  anthropic: {
    api: 'https://api.anthropic.com/v1',
    m: { 'claude-opus-5': { c: 200000, n: 'Claude Opus 5', v: true, r: true, t: true } },
  },
  qwen: {
    api: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    m: { 'qwen3.6-35b-a3b': { c: 262144, v: false, r: true, t: true } },
  },
  runinfra: {
    api: 'https://api.runinfra.com/v1',
    m: { 'ornith-ai/Ornith-1.5-35B-A3B': { c: 262144, v: true, r: true, t: true } },
  },
};

describe('findProvidersInCache', () => {
  test('narrows to the provider whose api matches the base URL', () => {
    const found = findProvidersInCache(cache, 'https://api.anthropic.com/v1');
    assert.equal(found.length, 1);
    assert.ok(found[0].m['claude-opus-5']);
  });

  test('matches on the domain root, ignoring the path', () => {
    const found = findProvidersInCache(cache, 'https://api.openai.com/v1/some/deep/path');
    assert.equal(found.length, 1);
    assert.ok(found[0].m['gpt-5']);
  });

  test('falls back to every provider when nothing matches', () => {
    // A local server, a LAN address, or a gateway in front of the real API.
    assert.equal(findProvidersInCache(cache, 'http://192.168.1.5:1234/v1').length, 4);
    assert.equal(findProvidersInCache(cache, '').length, 4);
  });
});

describe('lookupInProviders', () => {
  const all = Object.values(cache);

  test('finds an exact model id', () => {
    assert.equal(lookupInProviders(all, 'gpt-5')?.c, 400000);
  });

  test('falls back to a case-insensitive match', () => {
    assert.equal(lookupInProviders(all, 'Claude-Opus-5')?.c, 200000);
  });

  test('returns undefined for an unknown id rather than a near match', () => {
    assert.equal(lookupInProviders(all, 'gpt-5-turbo-preview'), undefined);
  });

  test('matches a publisher-prefixed input to a bare cached id', () => {
    assert.equal(lookupInProviders(all, 'qwen/qwen3.6-35b-a3b')?.c, 262144);
    assert.equal(lookupInProviders(all, 'qwen3.6-35b-a3b')?.c, 262144);
  });

  test('matches a bare input to a publisher-prefixed cached id, ignoring case', () => {
    assert.equal(lookupInProviders(all, 'ornith-1.5-35b-a3b')?.c, 262144);
  });

  test('ignores different and nested prefixes on both sides', () => {
    const providers = [{ api: '', m: { 'gateway/publisher/Model-1': { c: 8192 } } }];
    for (const id of ['model-1', 'local/model-1', 'proxy/local/model-1']) {
      assert.equal(lookupInProviders(providers, id)?.c, 8192, id);
    }
  });

  test('prefers exact full IDs over case-insensitive and final-segment matches', () => {
    const providers: Parameters<typeof lookupInProviders>[0] = [
      { api: '', m: { 'other/model-1': { c: 8192 }, 'Publisher/Model-1': { c: 16384 } } },
      { api: '', m: { 'publisher/model-1': { c: 32768 } } },
    ];
    assert.equal(lookupInProviders(providers, 'publisher/model-1')?.c, 32768);
    assert.equal(lookupInProviders(providers, 'PUBLISHER/MODEL-1')?.c, 16384);
  });

  test('preserves model versions, sizes, and variant suffixes', () => {
    for (const id of [
      'ornith-1.0-35b-a3b',
      'ornith-1.5-122b',
      'ornith-1.5-35b-a3b:thinking',
      'ornith-1.5-35b-a3b-fp8',
    ]) {
      assert.equal(lookupInProviders(all, id), undefined, id);
    }
    const variants = [{ api: '', m: { 'publisher/model-1:thinking': { c: 8192 } } }];
    assert.equal(lookupInProviders(variants, 'model-1'), undefined);
    assert.equal(lookupInProviders(variants, 'other/model-1:thinking')?.c, 8192);
  });

  test('does not match empty final segments', () => {
    const providers = [{ api: '', m: { 'publisher/': { c: 8192 } } }];
    assert.equal(lookupInProviders(providers, ''), undefined);
    assert.equal(lookupInProviders(providers, 'other/'), undefined);
  });

  test('a scoped miss can still be found across all providers', () => {
    const scoped = findProvidersInCache(cache, 'https://api.openai.com/v1');
    assert.equal(lookupInProviders(scoped, 'claude-opus-5'), undefined);
    assert.equal(lookupInProviders(Object.values(cache), 'claude-opus-5')?.c, 200000);
  });

  test('preserves a stored false capability', () => {
    assert.equal(lookupInProviders(all, 'qwen3.6-35b-a3b')?.v, false);
  });
});

describe('guessModelMeta browser lookup', () => {
  test('resolves the bare Ornith ID from a LAN server against a prefixed cache key', async () => {
    setRuntimeModelsCache(cache);
    try {
      assert.deepEqual(await guessModelMeta('http://192.168.1.5:1234/v1', 'ornith-1.5-35b-a3b'), {
        context_window: 262144,
        capabilities: { vision: true, reasoning: true, tools: true },
      });
    } finally {
      setRuntimeModelsCache(null);
    }
  });

  test('retries all providers after a scoped final-segment miss', async () => {
    setRuntimeModelsCache(cache);
    try {
      const meta = await guessModelMeta('https://api.openai.com/v1', 'gateway/local/ornith-1.5-35b-a3b');
      assert.equal(meta?.context_window, 262144);
      assert.equal(await guessModelMeta('', 'local/unknown-model'), null);
    } finally {
      setRuntimeModelsCache(null);
    }
  });

  test('keeps provider-specific metadata ahead of other providers with the same final ID', async () => {
    setRuntimeModelsCache({
      other: { api: 'https://other.example/v1', m: { 'model-1': { c: 32768 } } },
      local: { api: 'https://local.example/v1', m: { 'publisher/model-1': { c: 8192, t: false } } },
    });
    try {
      const meta = await guessModelMeta('https://local.example/v1', 'gateway/model-1');
      assert.equal(meta?.context_window, 8192);
      assert.deepEqual(meta?.capabilities, { tools: false });
    } finally {
      setRuntimeModelsCache(null);
    }
  });
});

describe('compactEntryToGuess', () => {
  test('a sparse entry with context but no flags yields no capabilities', () => {
    // Inherit, not "No". Mapping absent to false would let Guess → Save
    // persist an explicit denial of a capability the server reported.
    const guessed = compactEntryToGuess({ c: 32768, n: 'Sparse' });
    assert.equal(guessed.context_window, 32768);
    assert.equal(guessed.display_name, 'Sparse');
    assert.equal(guessed.capabilities, null);
  });

  test('a partial entry keeps present true and false and omits the rest', () => {
    const guessed = compactEntryToGuess({ c: 8192, v: true, t: false });
    assert.deepEqual(guessed.capabilities, { vision: true, tools: false });
    assert.equal('reasoning' in (guessed.capabilities ?? {}), false);
  });

  test('a complete entry carries all three flags through unchanged', () => {
    const guessed = compactEntryToGuess({ c: 400000, n: 'GPT-5', v: true, r: true, t: true });
    assert.deepEqual(guessed.capabilities, { vision: true, reasoning: true, tools: true });
  });

  test('an all-false entry is preserved as three explicit denials', () => {
    // The generated cache writes known negatives; those are real answers.
    const guessed = compactEntryToGuess({ c: 4096, v: false, r: false, t: false });
    assert.deepEqual(guessed.capabilities, { vision: false, reasoning: false, tools: false });
  });

  test('an entry with no fields at all emits neither context nor capabilities', () => {
    const guessed = compactEntryToGuess({});
    assert.equal(guessed.context_window, undefined);
    assert.equal(guessed.capabilities, null);
  });
});

/**
 * The override editor's Guess handler, extracted verbatim so the
 * absent-preserves-form-value rule is pinned by a test rather than by review.
 */
function applyGuessToForm(
  form: { context: string; vision?: boolean; reasoning?: boolean; tools?: boolean },
  meta: {
    context_window?: number | null;
    capabilities?: { vision?: boolean; reasoning?: boolean; tools?: boolean } | null;
  },
) {
  return {
    context: meta.context_window !== undefined && meta.context_window !== null
      ? String(meta.context_window)
      : form.context,
    vision: meta.capabilities?.vision ?? form.vision,
    reasoning: meta.capabilities?.reasoning ?? form.reasoning,
    tools: meta.capabilities?.tools ?? form.tools,
  };
}

describe('Guess fills the override form', () => {
  const edited = { context: '65536', vision: true as boolean | undefined, reasoning: undefined, tools: false as boolean | undefined };

  test('absent capabilities leave the existing form values untouched', () => {
    const next = applyGuessToForm(edited, compactEntryToGuess({ c: 32768 }));
    assert.equal(next.context, '32768');
    assert.equal(next.vision, true);
    assert.equal(next.reasoning, undefined);
    assert.equal(next.tools, false);
  });

  test('present capabilities overwrite, including an explicit false', () => {
    const next = applyGuessToForm(edited, compactEntryToGuess({ v: false, r: true }));
    assert.equal(next.vision, false);
    assert.equal(next.reasoning, true);
    // Absent from the guess — the user's local `false` survives.
    assert.equal(next.tools, false);
    // No context in the guess — the user's draft survives.
    assert.equal(next.context, '65536');
  });

  test('a null context from the Tauri wire is treated as absent', () => {
    const next = applyGuessToForm(edited, { context_window: null, capabilities: null });
    assert.equal(next.context, '65536');
    assert.equal(next.vision, true);
  });

  test('an Inherit form stays Inherit when the guess says nothing', () => {
    const blank = { context: '', vision: undefined, reasoning: undefined, tools: undefined };
    const next = applyGuessToForm(blank, compactEntryToGuess({ c: 16384, n: 'Only ctx' }));
    assert.equal(next.context, '16384');
    assert.equal(next.vision, undefined);
    assert.equal(next.reasoning, undefined);
    assert.equal(next.tools, undefined);
  });
});
