import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProviderContractQuery } from './provider-contracts';
import { ServerTokenCountTracker } from './server-token-count.ts';

const RESPONSES_QUERY: ProviderContractQuery = {
  baseUrl: 'https://api.meta.ai/v1',
  protocol: 'openai-responses',
  modelId: 'muse-spark-1.3-contributor',
};

function okFetch(inputTokens: number, seen?: { urls: string[] }) {
  return (async (url: unknown) => {
    seen?.urls.push(String(url));
    return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: inputTokens }), { status: 200 });
  }) as typeof fetch;
}

function abortAwareNever(): typeof fetch {
  return ((async (_url: unknown, init: unknown) => {
    const signal = (init as { signal?: AbortSignal }).signal;
    await new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('aborted', signal.reason instanceof DOMException ? signal.reason.name : 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', () => {
        const name = signal.reason instanceof DOMException ? signal.reason.name : 'AbortError';
        reject(new DOMException('aborted', name));
      }, { once: true });
    });
  }) as unknown) as typeof fetch;
}

function manualTimers() {
  let nextId = 1;
  const queued = new Map<number, () => void>();
  return {
    queued,
    setTimeoutFn: ((fn: () => void) => {
      const id = nextId++;
      queued.set(id, fn);
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((id: number) => { queued.delete(id); }) as unknown as typeof clearTimeout,
    flush() {
      const pending = [...queued.entries()].sort(([a], [b]) => a - b);
      queued.clear();
      for (const [, fn] of pending) fn();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ServerTokenCountTracker', () => {
  for (const browserTimer of ['setTimeout', 'clearTimeout'] as const) {
    it(`preserves the browser ${browserTimer} receiver across chat/model changes`, async (t) => {
      const realSetTimeout = globalThis.setTimeout;
      const timers = manualTimers();
      // Node and JSDOM timers accept arbitrary receivers. WebView2's native
      // timers throw when invoked as methods of the tracker instead of Window.
      for (const name of ['setTimeout', 'clearTimeout'] as const) {
        const implementation = name === 'setTimeout' ? timers.setTimeoutFn : timers.clearTimeoutFn;
        t.mock.method(globalThis, name, new Proxy(implementation, {
          apply(target, receiver, args) {
            if (name === browserTimer && receiver !== undefined && receiver !== globalThis) {
              throw new TypeError('Illegal invocation');
            }
            return Reflect.apply(target, globalThis, args);
          },
        }));
      }
      const seen: { urls: string[] } = { urls: [] };
      const tracker = new ServerTokenCountTracker({ fetchImpl: okFetch(17, seen) });
      const desired = { query: RESPONSES_QUERY, generationRequest: {}, apiKey: 'k' };

      tracker.request({ ...desired, key: 'chat-a/model-a' });
      assert.equal(timers.queued.size, 1);
      tracker.request({ ...desired, key: 'chat-a/model-b' });
      assert.equal(timers.queued.size, 1, 'a model change must replace the pending count');
      tracker.cancel();
      assert.equal(timers.queued.size, 0, 'leaving a chat must cancel the pending count');
      assert.deepEqual(tracker.getSnapshot(), { status: 'idle' });

      tracker.request({ ...desired, key: 'chat-b/model-b' });
      timers.flush();
      await new Promise((resolve) => realSetTimeout(resolve, 0));
      assert.equal(seen.urls.length, 1, 'only the new chat should fetch a count');
      assert.deepEqual(tracker.getSnapshot(), {
        status: 'ready', inputTokens: 17, contractId: 'meta.responses',
      });
      tracker.cancel();
      assert.deepEqual(tracker.getSnapshot(), { status: 'idle' });
    });
  }

  it('fetches once per key and reports the measured total', async () => {
    const seen: { urls: string[] } = { urls: [] };
    const tracker = new ServerTokenCountTracker({
      fetchImpl: okFetch(4242, seen),
      debounceMs: 0,
    });
    tracker.request({ key: 'a', query: RESPONSES_QUERY, generationRequest: {}, apiKey: 'k' });
    assert.deepEqual(tracker.getSnapshot(), { status: 'pending' });
    await tick();
    assert.deepEqual(tracker.getSnapshot(), {
      status: 'ready',
      inputTokens: 4242,
      contractId: 'meta.responses',
    });
    assert.deepEqual(seen.urls, ['https://api.meta.ai/v1/responses/input_tokens']);
    tracker.request({ key: 'a', query: RESPONSES_QUERY, generationRequest: {}, apiKey: 'k' });
    await tick();
    assert.equal(seen.urls.length, 1, 'same key must not refetch');
  });

  it('debounces rapid input changes into one fetch for the latest key', async () => {
    const seen: { urls: string[] } = { urls: [] };
    const timers = manualTimers();
    const tracker = new ServerTokenCountTracker({
      fetchImpl: okFetch(7, seen),
      debounceMs: 50,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    tracker.request({ key: 'a', query: RESPONSES_QUERY, generationRequest: {}, apiKey: 'k' });
    tracker.request({ key: 'b', query: RESPONSES_QUERY, generationRequest: {}, apiKey: 'k' });
    tracker.request({ key: 'c', query: RESPONSES_QUERY, generationRequest: {}, apiKey: 'k' });
    assert.equal(seen.urls.length, 0);
    assert.deepEqual(tracker.getSnapshot(), { status: 'pending' });
    timers.flush();
    await tick();
    assert.equal(seen.urls.length, 1);
    assert.deepEqual(tracker.getSnapshot(), { status: 'ready', inputTokens: 7, contractId: 'meta.responses' });
  });

  it('drops a stale response that settles after a newer key', async () => {
    let releaseFirst!: (value: Response) => void;
    const firstGate = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const fetchImpl = ((async () => {
      calls += 1;
      if (calls === 1) return firstGate;
      return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 9 }), { status: 200 });
    }) as unknown) as typeof fetch;
    const tracker = new ServerTokenCountTracker({ fetchImpl, debounceMs: 0 });
    tracker.request({ key: 'old', query: RESPONSES_QUERY, generationRequest: {}, apiKey: 'k' });
    await tick();
    tracker.request({ key: 'new', query: RESPONSES_QUERY, generationRequest: {}, apiKey: 'k' });
    await tick();
    assert.deepEqual(tracker.getSnapshot(), { status: 'ready', inputTokens: 9, contractId: 'meta.responses' });
    releaseFirst(new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 1 }), { status: 200 }));
    await tick();
    assert.deepEqual(
      tracker.getSnapshot(),
      { status: 'ready', inputTokens: 9, contractId: 'meta.responses' },
      'late first response must not overwrite the newer key',
    );
  });

  it('aborts the in-flight attempt when superseded or cancelled', async () => {
    const aborted: string[] = [];
    const fetchImpl = ((async (_url: unknown, init: unknown) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted.push('yes');
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    }) as unknown) as typeof fetch;
    const tracker = new ServerTokenCountTracker({ fetchImpl, debounceMs: 0 });
    tracker.request({ key: 'a', query: RESPONSES_QUERY, generationRequest: {}, apiKey: 'k' });
    await tick();
    tracker.request({ key: 'b', query: RESPONSES_QUERY, generationRequest: {}, apiKey: 'k' });
    await tick();
    assert.deepEqual(aborted, ['yes']);
    tracker.cancel();
    assert.deepEqual(tracker.getSnapshot(), { status: 'idle' });
  });

  it('reports timeouts distinctly and performs no fetch without a route or key', async () => {
    const tracker = new ServerTokenCountTracker({ fetchImpl: abortAwareNever(), debounceMs: 0, timeoutMs: 1 });
    let notified = 0;
    tracker.subscribe(() => { notified += 1; });
    tracker.request({ key: 'slow', query: RESPONSES_QUERY, generationRequest: {}, apiKey: 'k' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(tracker.getSnapshot(), { status: 'idle' });
    assert.ok(notified >= 2, 'pending then idle must notify');
    const zen: ProviderContractQuery = {
      baseUrl: 'https://opencode.ai/zen/v1',
      protocol: 'openai-responses',
      modelId: 'muse-spark-1.3-contributor',
    };
    const relayTracker = new ServerTokenCountTracker({
      fetchImpl: (() => { throw new Error('must not fetch'); }) as unknown as typeof fetch,
      debounceMs: 0,
    });
    relayTracker.request({ key: 'relay', query: zen, generationRequest: {}, apiKey: 'k' });
    await tick();
    assert.deepEqual(relayTracker.getSnapshot(), { status: 'idle' });
  });

  it('retries the same key after a failure and never retains secrets', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 3 }), { status: 200 });
    }) as typeof fetch;
    const tracker = new ServerTokenCountTracker({ fetchImpl, debounceMs: 0 });
    const desired = {
      key: 'k1',
      query: RESPONSES_QUERY,
      generationRequest: { model: 'm', input: 'user text here' },
      apiKey: 'super-secret-key',
    };
    tracker.request(desired);
    await tick();
    assert.deepEqual(tracker.getSnapshot(), { status: 'idle' });
    tracker.request(desired);
    await tick();
    assert.deepEqual(tracker.getSnapshot(), { status: 'ready', inputTokens: 3, contractId: 'meta.responses' });
    const snapshotText = JSON.stringify({ ...tracker.getSnapshot(), key: 'k1' });
    assert.ok(!snapshotText.includes('super-secret-key'));
    assert.ok(!snapshotText.includes('user text here'));
  });
});
