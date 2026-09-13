import assert from 'node:assert/strict';
import { it } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useServerTokenCount } from './useServerTokenCount.ts';

function replaceGlobal(name: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete (globalThis as Record<string, unknown>)[name];
  };
}

it('does not refetch when renders recreate the input wrapper', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://localhost/',
  });
  const restore = [
    replaceGlobal('window', dom.window),
    replaceGlobal('document', dom.window.document),
    replaceGlobal('navigator', dom.window.navigator),
    replaceGlobal('IS_REACT_ACT_ENVIRONMENT', true),
  ];
  const host = dom.window.document.getElementById('root');
  assert.ok(host);
  const root = createRoot(host);
  let fetches = 0;
  let renders = 0;
  const fetchImpl: typeof fetch = async () => {
    fetches += 1;
    return new Response(JSON.stringify({
      object: 'response.input_tokens',
      input_tokens: 42,
    }), { status: 200 });
  };

  function Harness() {
    renders += 1;
    // This object is intentionally rebuilt on every render. TokenMeter does
    // the same when it forwards an otherwise stable preflight descriptor.
    const snapshot = useServerTokenCount({
      key: 'stable-request-key',
      query: {
        baseUrl: 'https://api.meta.ai/v1',
        protocol: 'openai-responses',
        modelId: 'muse-spark-1.3-contributor',
      },
      generationRequest: {
        model: 'muse-spark-1.3-contributor',
        input: 'hello',
      },
      apiKey: 'test-key',
      enabled: true,
      debounceMs: 0,
      fetchImpl,
    });
    return createElement('span', null, snapshot.status);
  }

  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(host.textContent, 'ready');
    assert.equal(fetches, 1);
    assert.ok(renders < 10, `unexpected render loop (${renders} renders)`);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    restore.reverse().forEach((restoreOne) => restoreOne());
  }
});
