/**
 * Meta server token-count preflight tests (mocked transport).
 *
 * These verify LC's routing, body construction, response parsing, failure
 * behavior, aborts, and relay isolation — not Meta's live response. Endpoint
 * shapes come from the saved first-party Token counting page.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderContractQuery } from './provider-contracts';
import {
  buildServerTokenCountBody,
  parseServerTokenCountResponse,
  requestServerTokenCount,
  serverTokenCountRoute,
} from './token-count.ts';

const RESPONSES_QUERY: ProviderContractQuery = {
  baseUrl: 'https://api.meta.ai/v1',
  protocol: 'openai-responses',
  modelId: 'muse-spark-1.3-contributor',
};
const MESSAGES_QUERY: ProviderContractQuery = {
  baseUrl: 'https://api.meta.ai/v1',
  protocol: 'anthropic-messages',
  modelId: 'muse-spark-1.3-contributor',
};

describe('serverTokenCountRoute', () => {
  it('routes only the exact Meta contracts', () => {
    assert.deepEqual(serverTokenCountRoute(RESPONSES_QUERY), {
      contractId: 'meta.responses',
      url: 'https://api.meta.ai/v1/responses/input_tokens',
    });
    assert.deepEqual(serverTokenCountRoute(MESSAGES_QUERY), {
      contractId: 'meta.messages',
      url: 'https://api.meta.ai/v1/messages/count_tokens',
    });
    // The bare origin supplies /v1 for Messages generation joining, so the
    // count route follows the same rule.
    assert.deepEqual(
      serverTokenCountRoute({ ...MESSAGES_QUERY, baseUrl: 'https://api.meta.ai' }),
      { contractId: 'meta.messages', url: 'https://api.meta.ai/v1/messages/count_tokens' },
    );
  });

  it('has no count route for Chat, relays, lookalikes, or anything else', () => {
    const queries: ProviderContractQuery[] = [
      { baseUrl: 'https://api.meta.ai/v1', protocol: 'openai-chat', modelId: 'muse-spark-1.3-contributor' },
      { baseUrl: 'https://api.meta.ai', protocol: 'openai-responses', modelId: 'muse-spark-1.3-contributor' },
      { baseUrl: 'https://opencode.ai/zen/v1', protocol: 'openai-responses', modelId: 'muse-spark-1.3-contributor' },
      { baseUrl: 'https://foo.meta.ai/v1', protocol: 'anthropic-messages', modelId: 'muse-spark-1.3-contributor' },
      { baseUrl: 'not-a-url', protocol: 'openai-responses' },
    ];
    for (const query of queries) {
      assert.equal(serverTokenCountRoute(query), undefined, JSON.stringify(query));
    }
  });
});

describe('buildServerTokenCountBody', () => {
  it('sends the rendered Responses input without transport fields', () => {
    const route = serverTokenCountRoute(RESPONSES_QUERY)!;
    assert.deepEqual(buildServerTokenCountBody(route, {
      model: 'muse-spark-1.3-contributor',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      instructions: 'sys',
      tools: [{ type: 'function', name: 'f' }],
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      stream: true,
      store: false,
      temperature: 0.5,
    }), {
      model: 'muse-spark-1.3-contributor',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      instructions: 'sys',
      tools: [{ type: 'function', name: 'f' }],
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    });
  });

  it('forwards the Anthropic-shaped Messages body minus stream', () => {
    const route = serverTokenCountRoute(MESSAGES_QUERY)!;
    assert.deepEqual(buildServerTokenCountBody(route, {
      model: 'muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
      thinking: { type: 'adaptive' },
      stream: true,
    }), {
      model: 'muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
      thinking: { type: 'adaptive' },
    });
  });
});

describe('parseServerTokenCountResponse', () => {
  it('accepts both documented success shapes', () => {
    const responses = serverTokenCountRoute(RESPONSES_QUERY)!;
    assert.deepEqual(
      parseServerTokenCountResponse(responses, { object: 'response.input_tokens', input_tokens: 77 }),
      { inputTokens: 77 },
    );
    const messages = serverTokenCountRoute(MESSAGES_QUERY)!;
    assert.deepEqual(parseServerTokenCountResponse(messages, { input_tokens: 78 }), { inputTokens: 78 });
  });

  it('rejects wrong markers and non-integer counts', () => {
    const responses = serverTokenCountRoute(RESPONSES_QUERY)!;
    assert.ok('malformed' in parseServerTokenCountResponse(responses, { input_tokens: 77 }));
    assert.ok('malformed' in parseServerTokenCountResponse(responses, { object: 'response.input_tokens' }));
    assert.ok('malformed' in parseServerTokenCountResponse(
      responses, { object: 'response.input_tokens', input_tokens: -1 }));
    assert.ok('malformed' in parseServerTokenCountResponse(
      responses, { object: 'response.input_tokens', input_tokens: 1.5 }));
    assert.ok('malformed' in parseServerTokenCountResponse(responses, null));
  });
});

describe('requestServerTokenCount', () => {
  const generationRequest = { model: 'muse-spark-1.3-contributor', input: 'hi', stream: true };

  function okFetch(expectedUrl: string, expectedAuth: string, payload: unknown) {
    return (async (url: unknown, init: unknown) => {
      assert.equal(String(url), expectedUrl);
      const headers = (init as { headers: Record<string, string> }).headers;
      assert.equal(headers.Authorization, expectedAuth);
      assert.equal(headers['Content-Type'], 'application/json');
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
  }

  it('counts through the Responses endpoint with Bearer auth', async () => {
    const result = await requestServerTokenCount({
      query: RESPONSES_QUERY,
      generationRequest,
      apiKey: 'meta-key',
      fetchImpl: okFetch(
        'https://api.meta.ai/v1/responses/input_tokens',
        'Bearer meta-key',
        { object: 'response.input_tokens', input_tokens: 77 },
      ),
    });
    assert.deepEqual(result, {
      ok: true,
      inputTokens: 77,
      route: { contractId: 'meta.responses', url: 'https://api.meta.ai/v1/responses/input_tokens' },
      model: 'muse-spark-1.3-contributor',
    });
  });

  it('counts through the Messages endpoint with Bearer auth', async () => {
    const result = await requestServerTokenCount({
      query: MESSAGES_QUERY,
      generationRequest: { model: 'muse-spark-1.3-contributor', messages: [], stream: true },
      apiKey: 'meta-key',
      fetchImpl: okFetch(
        'https://api.meta.ai/v1/messages/count_tokens',
        'Bearer meta-key',
        { input_tokens: 78 },
      ),
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.inputTokens, 78);
  });

  it('performs no fetch for unsupported routes or missing credentials', async () => {
    const queries: ProviderContractQuery[] = [
      { baseUrl: 'https://opencode.ai/zen/v1', protocol: 'openai-responses', modelId: 'muse-spark-1.3-contributor' },
      { baseUrl: 'https://api.meta.ai/v1', protocol: 'openai-chat', modelId: 'muse-spark-1.3-contributor' },
      { baseUrl: 'https://api.meta.ai/v1', protocol: 'lmstudio-native-chat' },
    ];
    for (const query of queries) {
      const result = await requestServerTokenCount({
        query,
        generationRequest: {},
        apiKey: 'meta-key',
        fetchImpl: (() => { throw new Error('must not fetch'); }) as unknown as typeof fetch,
      });
      assert.deepEqual(result, { ok: false, error: { kind: 'unsupported' } }, JSON.stringify(query));
    }
    const noKey = await requestServerTokenCount({
      query: RESPONSES_QUERY,
      generationRequest: {},
      apiKey: '',
      fetchImpl: (() => { throw new Error('must not fetch'); }) as unknown as typeof fetch,
    });
    assert.deepEqual(noKey, { ok: false, error: { kind: 'unsupported' } });
  });

  it('surfaces HTTP failures with bounded snippets and no credentials', async () => {
    const result = await requestServerTokenCount({
      query: RESPONSES_QUERY,
      generationRequest: {},
      apiKey: 'super-secret-key',
      fetchImpl: (async () => new Response('x'.repeat(5000), { status: 400 })) as typeof fetch,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.kind, 'http');
      if (result.error.kind === 'http') {
        assert.equal(result.error.status, 400);
        assert.ok(result.error.bodySnippet.length <= 501);
        assert.ok(!JSON.stringify(result.error).includes('super-secret-key'));
      }
    }
  });

  it('reports malformed bodies and transport failures distinctly', async () => {
    const malformed = await requestServerTokenCount({
      query: MESSAGES_QUERY,
      generationRequest: {},
      apiKey: 'k',
      fetchImpl: (async () => new Response('not json', { status: 200 })) as typeof fetch,
    });
    assert.deepEqual(malformed, { ok: false, error: { kind: 'malformed', bodySnippet: 'not json' } });
    const failed = await requestServerTokenCount({
      query: MESSAGES_QUERY,
      generationRequest: {},
      apiKey: 'k',
      fetchImpl: (async () => { throw new Error('boom'); }) as typeof fetch,
    });
    assert.deepEqual(failed, { ok: false, error: { kind: 'transport', message: 'boom' } });
  });

  it('honors caller aborts without mistaking them for transport errors', async () => {
    const controller = new AbortController();
    const pending = requestServerTokenCount({
      query: RESPONSES_QUERY,
      generationRequest: {},
      apiKey: 'k',
      fetchImpl: ((async (_url: unknown, init: unknown) => {
        const signal = (init as { signal?: AbortSignal }).signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
        throw new Error('unreachable');
      }) as unknown) as typeof fetch,
      signal: controller.signal,
    });
    controller.abort();
    assert.deepEqual(await pending, { ok: false, error: { kind: 'aborted' } });
  });

  it('distinguishes timeouts from caller aborts and transport failures', async () => {
    const signalAwareHanging = ((async (_url: unknown, init: unknown) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      await new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('The operation timed out', 'TimeoutError'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new DOMException('The operation timed out', 'TimeoutError')), { once: true });
      });
    }) as unknown) as typeof fetch;
    const timedOut = await requestServerTokenCount({
      query: RESPONSES_QUERY,
      generationRequest: {},
      apiKey: 'k',
      fetchImpl: signalAwareHanging,
      timeoutMs: 1,
    });
    assert.deepEqual(timedOut, { ok: false, error: { kind: 'timeout' } });
    const readTimedOut = await requestServerTokenCount({
      query: MESSAGES_QUERY,
      generationRequest: {},
      apiKey: 'k',
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        async text() {
          throw new DOMException('Timed out', 'TimeoutError');
        },
      })) as unknown as typeof fetch,
    });
    assert.deepEqual(readTimedOut, { ok: false, error: { kind: 'timeout' } });
  });
});
