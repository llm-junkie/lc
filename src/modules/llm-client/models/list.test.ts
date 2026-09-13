import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { listModels } from './list.ts';
import { enrichOne, type CompactCache } from './enrich.ts';
import { buildLiveEntries } from '../../server-profiles/model-store.ts';
import type { ModelInfo } from '../types';
import {
  getDefaultModelFetchUrl,
  getLocalNativeModelBaseUrl,
  getLocalNativeModelFetchUrl,
  isLocalNetworkUrl,
  resolveModelFetchUrl,
} from './url.ts';
import {
  MODEL_DISCOVERY_RESPONSE_MAX_BYTES,
  MODEL_LIST_MAX_ENTRIES,
} from './limits.ts';

const emptyCache = {};

function requireAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`missing ${label} at index ${index}`);
  return value;
}

function openAIResponse(ids: string[], status = 200): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('model fetching URL resolution', () => {
  test('remote profiles use Base URL plus /models', () => {
    assert.equal(isLocalNetworkUrl('https://api.openai.com/v1'), false);
    assert.equal(getDefaultModelFetchUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/models');
  });

  test('local profiles preserve explicit native REST versions and default chat bases to native v1', () => {
    assert.equal(isLocalNetworkUrl('http://127.0.0.1:1234/v1'), true);
    assert.equal(getDefaultModelFetchUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/api/v1/models');
    assert.equal(getLocalNativeModelBaseUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/api/v1');
    assert.equal(getLocalNativeModelBaseUrl('http://server.local:1234/api/v4'), 'http://server.local:1234/api/v4');
    assert.equal(getDefaultModelFetchUrl('http://server.local:1234/api/v4'), 'http://server.local:1234/api/v4/models');
    assert.equal(getDefaultModelFetchUrl('http://127.0.0.1:1234/api/v10'), 'http://127.0.0.1:1234/api/v10/models');
    assert.equal(
      getLocalNativeModelFetchUrl('/lc-proxy/http+192.168.1.8:1234/v1'),
      '/lc-proxy/http+192.168.1.8:1234/api/v1/models',
    );
  });

  test('custom URLs and paths resolve predictably', () => {
    const base = 'https://provider.example/v4';
    assert.equal(resolveModelFetchUrl(base, 'https://models.example/catalog'), 'https://models.example/catalog');
    assert.equal(resolveModelFetchUrl(base, '/catalog/models'), 'https://provider.example/catalog/models');
    assert.equal(resolveModelFetchUrl(base, 'catalog/models'), 'https://provider.example/v4/catalog/models');
    assert.equal(resolveModelFetchUrl(base, '  '), undefined);
  });
});

describe('listModels request headers', () => {
  function captureHeaders(): { headers: Record<string, string>[]; fetchImpl: typeof fetch } {
    const headers: Record<string, string>[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers.push({ ...(init?.headers as Record<string, string> | undefined) });
      return openAIResponse(['claude-opus-5']);
    }) as typeof fetch;
    return { headers, fetchImpl };
  }

  test('anthropic-version is sent to Anthropic\'s own API, which rejects requests without it', async () => {
    const { headers, fetchImpl } = captureHeaders();

    await listModels(
      'https://api.anthropic.com/v1',
      'https://api.anthropic.com/v1',
      'sk-ant-test',
      fetchImpl,
      emptyCache,
    );

    const requestHeaders = requireAt(headers, 0, 'captured request headers');
    assert.equal(requestHeaders['anthropic-version'], '2023-06-01');
  });

  test('Anthropic-compatible servers are not sent a header only Anthropic requires', async () => {
    // "Anthropic-compatible" is a wire format, not a vendor. None of these
    // need `anthropic-version`, so LC must not impose it on them.
    const compatible = [
      'https://api.minimax.io/anthropic',
      'https://api.deepseek.com/anthropic',
      'https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy',
      'https://api.z.ai/api/anthropic',
      'http://192.168.1.8:1234/v1',
      'https://api.openai.com/v1',
    ];

    for (const baseUrl of compatible) {
      const { headers, fetchImpl } = captureHeaders();
      await listModels(baseUrl, baseUrl, 'key', fetchImpl, emptyCache);
      const requestHeaders = requireAt(headers, 0, 'captured request headers');
      assert.equal(
        'anthropic-version' in requestHeaders,
        false,
        `${baseUrl} must not be sent anthropic-version`,
      );
    }
  });

  test('profile headers are applied to model discovery', async () => {
    const { headers, fetchImpl } = captureHeaders();
    await listModels(
      'https://provider.example/v1',
      'https://provider.example/v1',
      'key',
      fetchImpl,
      emptyCache,
      undefined,
      undefined,
      {
        includeLcIdentifierHeader: true,
        includeAdditionalRequestHeaders: true,
        requestHeaders: [{ name: 'X-Gateway-Route', value: 'models' }],
      },
    );

    const requestHeaders = requireAt(headers, 0, 'captured request headers');
    assert.equal(requestHeaders['User-Agent'], 'LC/1.0.0');
    assert.equal(requestHeaders['X-Gateway-Route'], 'models');
  });
});

describe('listModels request bounds', () => {
  test('rejects a model-list response whose declared body exceeds 64 MiB', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: 'model' }] }), {
      status: 200,
      headers: { 'content-length': String(MODEL_DISCOVERY_RESPONSE_MAX_BYTES + 1) },
    })) as typeof fetch;

    await assert.rejects(
      listModels('https://provider.example/v1', 'https://provider.example/v1', '', fetchImpl, emptyCache),
      /no models found/,
    );
  });

  test('rejects a model list above the per-profile entry limit', async () => {
    const ids = Array.from({ length: MODEL_LIST_MAX_ENTRIES + 1 }, (_, index) => `model-${index}`);

    await assert.rejects(
      listModels(
        'https://provider.example/v1',
        'https://provider.example/v1',
        '',
        async () => openAIResponse(ids),
        emptyCache,
      ),
      /no models found/,
    );
  });

  test('remote profiles make one default request and do not guess after 404', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return openAIResponse([], 404);
    }) as typeof fetch;

    await assert.rejects(
      listModels('https://provider.example/v1', 'https://provider.example/v1', '', fetchImpl, emptyCache),
      /no models found/,
    );
    assert.deepEqual(calls, ['https://provider.example/v1/models']);
  });

  test('local profiles prefer native metadata and skip the fallback on success', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        models: [{
          key: 'qwen/qwen-test',
          type: 'llm',
          max_context_length: 32768,
          loaded_instances: [{ id: 'instance-1', config: { context_length: 8192 } }],
        }],
      }), { status: 200 });
    }) as typeof fetch;

    const models = await listModels(
      'http://192.168.1.8:1234/v1',
      'http://192.168.1.8:1234/v1',
      '',
      fetchImpl,
      emptyCache,
    );

    assert.deepEqual(calls, ['http://192.168.1.8:1234/api/v1/models']);
    assert.equal(models[0]?.id, 'qwen/qwen-test');
    assert.equal(models[0]?.state, 'loaded');
    assert.equal(models[0]?.loaded_context_length, 8192);
  });

  test('native REST keeps full identifiers and preserves native capabilities', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      models: [
        {
          key: 'qwen/qwen3.6-35b-a3b',
          type: 'llm',
          display_name: 'Qwen/Qwen3.6-35B-A3B',
          capabilities: { vision: true, trained_for_tool_use: true },
        },
      ],
    }), { status: 200 })) as typeof fetch;

    const models = await listModels(
      'http://localhost:1234/v1',
      'http://localhost:1234/v1',
      '',
      fetchImpl,
      emptyCache,
    );

    assert.deepEqual(models.map((model) => model.id), [
      'qwen/qwen3.6-35b-a3b',
    ]);
    assert.equal(models[0]?.source, 'lmstudio-rest');
    assert.equal(models[0]?.display_name, 'Qwen/Qwen3.6-35B-A3B');

    const entries = buildLiveEntries(
      { id: 'p1', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiVariant: 'openai' },
      models,
    );
    assert.deepEqual(entries.map((entry) => entry.displayName), [
      'qwen/qwen3.6-35b-a3b',
    ]);
    assert.equal(entries[0]?.capabilities.vision, true);
    assert.equal(entries[0]?.capabilities.tools, true);
  });

  test('models.dev enrichment fills missing metadata without replacing native capabilities', () => {
    const enriched = enrichOne(
      {
        id: 'qwen/qwen-vl',
        object: 'model',
        source: 'lmstudio-rest',
        max_context_length: 32768,
        capabilities: { vision: true, trained_for_tool_use: true },
      } as ModelInfo & {
        max_context_length?: number;
        capabilities?: Record<string, unknown>;
      },
      {
        context_window: 131072,
        display_name: 'Qwen VL',
        capabilities: { vision: false, reasoning: true, tools: false },
      },
    ) as ModelInfo & {
      max_context_length?: number;
      display_name?: string;
      capabilities?: Record<string, unknown>;
    };

    assert.equal(enriched.max_context_length, 32768);
    assert.equal(enriched.display_name, undefined);
    const capabilities = enriched.capabilities;
    if (!capabilities) throw new Error('enriched model must retain capabilities');
    assert.equal(capabilities.vision, true);
    assert.equal(capabilities.trained_for_tool_use, true);
    assert.equal(capabilities.reasoning, true);
    assert.equal(capabilities.tools, false);
  });

  test('local profiles fall back once to Base URL plus /models', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return url.endsWith('/api/v1/models')
        ? openAIResponse([], 404)
        : openAIResponse(['fallback-model']);
    }) as typeof fetch;

    const models = await listModels(
      'http://localhost:1234/v1',
      'http://localhost:1234/v1',
      '',
      fetchImpl,
      emptyCache,
    );

    assert.deepEqual(calls, [
      'http://localhost:1234/api/v1/models',
      'http://localhost:1234/v1/models',
    ]);
    assert.equal(models[0]?.id, 'fallback-model');
  });

  test('an explicit override is exact and suppresses the Z.ai merge', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return openAIResponse(['custom-model']);
    }) as typeof fetch;

    const models = await listModels(
      'https://api.z.ai/api/paas/v4',
      'https://api.z.ai/api/paas/v4',
      '',
      fetchImpl,
      emptyCache,
      'https://catalog.example/models',
    );

    assert.deepEqual(calls, ['https://catalog.example/models']);
    assert.equal(models[0]?.id, 'custom-model');
  });

  test('Z.ai merges its known secondary model endpoint', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return url.endsWith('/v1/models')
        ? openAIResponse(['primary-model', 'free-model'])
        : openAIResponse(['primary-model']);
    }) as typeof fetch;

    const models = await listModels(
      'https://api.z.ai/api/paas/v4',
      'https://api.z.ai/api/paas/v4',
      '',
      fetchImpl,
      emptyCache,
    );

    assert.deepEqual(calls, [
      'https://api.z.ai/api/paas/v4/models',
      'https://api.z.ai/api/paas/v4/v1/models',
    ]);
    assert.deepEqual(models.map((model) => model.id), ['primary-model', 'free-model']);
  });
});

/**
 * Anthropic describes every model in its `/v1/models` response — `max_tokens`
 * (largest completion), `max_input_tokens` (context window), and
 * `display_name`. LC used to map the entry down to `{id, object}` and throw
 * the rest away, then fall back to a hard-coded 4,096 output ceiling for a
 * model that supports 128,000.
 *
 * The shapes below are taken from a real response captured on 2026-08-05.
 */
describe('OpenAI-compatible model entries that describe themselves', () => {
  const anthropicList = {
    data: [
      {
        type: 'model',
        id: 'claude-sonnet-5',
        display_name: 'Claude Sonnet 5',
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
      },
      {
        type: 'model',
        id: 'claude-haiku-4-5-20251001',
        display_name: 'Claude Haiku 4.5',
        max_input_tokens: 200_000,
        max_tokens: 64_000,
      },
    ],
  };

  it('keeps the reported completion ceiling and context window', async () => {
    const models = await listModels(
      'https://api.anthropic.com', 'https://api.anthropic.com', '',
      async () => new Response(JSON.stringify(anthropicList), { status: 200 }),
      {} as CompactCache,
    );

    const sonnet = requireAt(models, 0, 'Claude Sonnet model');
    const haiku = requireAt(models, 1, 'Claude Haiku model');
    assert.equal(sonnet.id, 'claude-sonnet-5');
    assert.equal(sonnet.max_output_tokens, 128_000);
    assert.equal(sonnet.max_context_length, 1_000_000);
    assert.equal(sonnet.display_name, 'Claude Sonnet 5');
    assert.equal(haiku.max_output_tokens, 64_000);
  });

  it('leaves the fields absent for a server that reports only ids', async () => {
    const models = await listModels(
      'https://api.example.test/v1', 'https://api.example.test/v1', '',
      async () => new Response(JSON.stringify({ data: [{ id: 'plain-model' }] }), { status: 200 }),
      {} as CompactCache,
    );

    const model = requireAt(models, 0, 'plain model');
    assert.equal(model.id, 'plain-model');
    assert.equal(model.max_output_tokens, undefined);
    assert.equal(model.max_context_length, undefined);
  });

  it('ignores a nonsensical reported limit rather than sending it', async () => {
    const models = await listModels(
      'https://api.example.test/v1', 'https://api.example.test/v1', '',
      async () => new Response(JSON.stringify({
        data: [{ id: 'odd-model', max_tokens: 0, max_input_tokens: -5 }],
      }), { status: 200 }),
      {} as CompactCache,
    );

    const model = requireAt(models, 0, 'model with invalid limits');
    assert.equal(model.max_output_tokens, undefined);
    assert.equal(model.max_context_length, undefined);
  });
});
