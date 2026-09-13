import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompactCache } from './models-dev-sync.ts';
import { MODELS_DEV_MAX_MODELS, MODELS_DEV_MAX_PROVIDERS } from '../llm-client/models/limits.ts';

describe('buildCompactCache', () => {
  test('rejects a catalogue above its provider or model bound', () => {
    const tooManyProviders = Object.fromEntries(Array.from(
      { length: MODELS_DEV_MAX_PROVIDERS + 1 },
      (_, index) => [`p-${index}`, { api: 'https://p.example', models: {} }],
    ));
    assert.throws(
      () => buildCompactCache(tooManyProviders),
      new RegExp(`${MODELS_DEV_MAX_PROVIDERS} providers`),
    );

    const tooManyModels = {
      p: {
        api: 'https://p.example',
        models: Object.fromEntries(Array.from(
          { length: MODELS_DEV_MAX_MODELS + 1 },
          (_, index) => [`m-${index}`, { id: `m-${index}`, name: `M ${index}` }],
        )),
      },
    };
    assert.throws(
      () => buildCompactCache(tooManyModels),
      new RegExp(`${MODELS_DEV_MAX_MODELS} models`),
    );
  });

  test('reduces the full catalogue the same way the build script does', () => {
    const raw = {
      openai: {
        api: 'https://api.openai.com/v1',
        models: {
          gpt5: {
            id: 'gpt-5', name: 'GPT-5', limit: { context: 400000 },
            modalities: { input: ['image', 'text'] }, reasoning: true, tool_call: false,
          },
          bare: { id: 'bare' }, // no usable field → dropped
        },
      },
      local: { api: 'localhost:1234', models: { m: { id: 'm', name: 'M' } } }, // non-http api → dropped
    };

    const cache = buildCompactCache(raw as Parameters<typeof buildCompactCache>[0]);

    assert.deepEqual(Object.keys(cache), ['openai']);
    assert.deepEqual(Object.keys(cache.openai.m), ['gpt-5']);
    assert.deepEqual(cache.openai.m['gpt-5'], { c: 400000, n: 'GPT-5', v: true, r: true, t: false });
  });

  test('first entry per model id wins and a missing id becomes "unknown"', () => {
    const raw = {
      p: {
        api: 'https://p.example/v1',
        models: {
          alias: { id: 'shared', name: 'Alias', reasoning: true },
          real: { id: 'shared', name: 'Real' },
          anon: { name: 'Anon' },
        },
      },
    };

    const cache = buildCompactCache(raw as Parameters<typeof buildCompactCache>[0]);

    // Object.values order is insertion order for string keys, so "alias"
    // is seen first and "real" must not overwrite it.
    assert.equal(cache.p.m.shared?.n, 'Alias');
    assert.equal(cache.p.m.shared?.r, true);
    assert.ok(cache.p.m.unknown, 'missing id falls back to the "unknown" key');
    assert.equal(cache.p.m.unknown?.n, 'Anon');
  });

  test('name-only models keep tool defaults and omit absent optionals', () => {
    const cache = buildCompactCache({
      p: { api: 'https://p.example', models: { m: { id: 'm', name: 'M', tool_call: false } } },
    } as Parameters<typeof buildCompactCache>[0]);

    assert.deepEqual(cache.p.m.m, { n: 'M', v: false, r: false, t: false });
  });
});
