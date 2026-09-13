import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeNormalStartup } from './normal-startup.ts';
import type { StartupLifecycle } from './startup-runtime';
import type { StartupDiagnosticSnapshot, StartupFailureCode, StartupPhase } from './startup-state';
import { readFile } from 'node:fs/promises';

function lifecycle(events: string[]): StartupLifecycle {
  return {
    mode: 'normal',
    retryAttempt: false,
    phase(phase: StartupPhase) { events.push(`phase:${phase}`); },
    failure(code: StartupFailureCode) { events.push(`failure:${code}`); },
    ready() { events.push('ready'); },
    requestNormalRetry() {},
    snapshot(): StartupDiagnosticSnapshot {
      return { lastCompletedPhase: 'renderer-created', incompleteStartCount: 0, safeStartState: 'inactive' };
    },
  };
}

describe('normal startup initialization', () => {
  test('storage-open failure remains structured and never attempts metadata hydration', async () => {
    const events: string[] = [];
    let hydrateCalls = 0;
    const result = await initializeNormalStartup(lifecycle(events), {
      openStorage: async () => { throw new Error('private database path'); },
      hydrateConversationMetadata: async () => { hydrateCalls++; },
    });
    if (result.ok !== false) throw new Error('storage failure must return a failure result');
    assert.deepEqual({ ok: result.ok, code: result.code }, {
      ok: false,
      code: 'conversation-storage-unavailable',
    });
    assert.equal(hydrateCalls, 0);
    assert.deepEqual(events, ['failure:conversation-storage-unavailable']);
  });

  test('metadata failure records the last completed storage phase', async () => {
    const events: string[] = [];
    const result = await initializeNormalStartup(lifecycle(events), {
      openStorage: async () => {},
      hydrateConversationMetadata: async () => { throw new Error('corrupt metadata'); },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(events, [
      'phase:storage-opened',
      'failure:conversation-metadata-unavailable',
    ]);
  });

  test('successful initialization records every remaining phase and ready once', async () => {
    const events: string[] = [];
    const result = await initializeNormalStartup(lifecycle(events), {
      openStorage: async () => {},
      hydrateConversationMetadata: async () => {},
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(events, [
      'phase:storage-opened',
      'phase:conversation-metadata-loaded',
      'phase:shell-mounted',
      'ready',
    ]);
  });

  test('optional model and archive work is gated by the normal ready state', async () => {
    const [app, modelBootstrap, archiveSweep] = await Promise.all([
      readFile(new URL('../App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../modules/server-profiles/bootstrap.ts', import.meta.url), 'utf8'),
      readFile(new URL('../modules/server-profiles/archive-sweep.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(app, /useModelBootstrap\(normalReady\)/);
    assert.match(app, /useAutoArchiveSweep\(normalReady\)/);
    assert.match(app, /if \(!normalReady\) return;[\s\S]*setTimeout\([\s\S]*sync_models_dev/);
    assert.match(modelBootstrap, /if \(!normalReady\) return;[\s\S]*\.bootstrap\(\)/);
    assert.match(archiveSweep, /if \(!normalReady\) return;[\s\S]*autoArchiveSweep/);
  });

  test('model bootstrap does not run before the normal ready state', async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost/',
    });
    const names = [
      'window', 'document', 'navigator', 'localStorage', 'sessionStorage',
      'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT',
    ] as const;
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const name of names) previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const installed = {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      localStorage: dom.window.localStorage,
      sessionStorage: dom.window.sessionStorage,
      HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(installed)) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }

    const [{ createElement }, { createRoot }, { act }, bootstrap, stores] = await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('react'),
      import('../modules/server-profiles/bootstrap.ts'),
      import('../modules/server-profiles/index.ts'),
    ]);
    const originalBootstrap = stores.useAppModels.getState().bootstrap;
    let calls = 0;
    stores.useAppModels.setState({ bootstrap: async () => { calls++; } });
    const host = dom.window.document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    function Harness({ ready }: { ready: boolean }) {
      bootstrap.useModelBootstrap(ready);
      return null;
    }

    try {
      await act(async () => root.render(createElement(Harness, { ready: false })));
      assert.equal(calls, 0);
      await act(async () => root.render(createElement(Harness, { ready: true })));
      assert.equal(calls, 1);
      await act(async () => root.unmount());
    } finally {
      stores.useAppModels.setState({ bootstrap: originalBootstrap });
      dom.window.close();
      for (const name of names) {
        const descriptor = previous.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    }
  });
});
