import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadStartupSurface, validatePersistedSettings } from './startup-bootstrap.ts';
import { STARTUP_STORAGE_KEY } from './startup-state.ts';
import { StartupController, type StartupPersistence } from './startup-runtime.ts';
import { initializeNormalStartup } from './normal-startup.ts';

class MemoryPersistence implements StartupPersistence {
  readonly values = new Map<string, string>();
  readonly touchedKeys: string[] = [];
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.touchedKeys.push(key); this.values.set(key, value); }
}

function controllerAfterTwoFailures(storage: MemoryPersistence): StartupController {
  new StartupController({ persistence: storage, automaticSafeStart: true, newProcess: true });
  new StartupController({ persistence: storage, automaticSafeStart: true, newProcess: true });
  return new StartupController({ persistence: storage, automaticSafeStart: true, newProcess: true });
}

describe('pre-App bootstrap boundary', () => {
  test('Safe Start does not validate settings or invoke the normal App loader', async () => {
    const storage = new MemoryPersistence();
    const startup = controllerAfterTwoFailures(storage);
    let settingsCalls = 0;
    let normalCalls = 0;
    const selected = await loadStartupSurface(startup, {
      validateSettings: () => { settingsCalls++; throw new Error('malformed settings'); },
      loadNormal: async () => { normalCalls++; throw new Error('conversation storage unavailable'); },
      loadSafeStart: async () => 'safe-shell',
      loadStartupFailure: async () => 'failure-shell',
      loadInlineFallback: async () => 'inline-shell',
    });
    assert.equal(selected.mode, 'safe-start');
    assert.equal(settingsCalls, 0);
    assert.equal(normalCalls, 0);
    assert.deepEqual([...new Set(storage.touchedKeys)], [STARTUP_STORAGE_KEY]);
  });

  test('first settings initialization failure remains a normal attempt', async () => {
    const storage = new MemoryPersistence();
    const startup = new StartupController({
      persistence: storage,
      automaticSafeStart: true,
      newProcess: true,
    });
    const selected = await loadStartupSurface(startup, {
      validateSettings: () => validatePersistedSettings({ getItem: () => '{bad-json' }),
      loadNormal: async () => 'normal-app',
      loadSafeStart: async () => 'safe-shell',
      loadStartupFailure: async () => 'failure-shell',
      loadInlineFallback: async () => 'inline-shell',
    });
    if (selected.mode !== 'startup-failure') {
      throw new Error(`expected startup-failure, received ${selected.mode}`);
    }
    assert.equal(selected.code, 'settings-malformed');
    assert.equal(startup.snapshot().incompleteStartCount, 0);
  });

  test('two settings initialization failures make the following launch render Safe Start', async () => {
    const storage = new MemoryPersistence();
    for (let launch = 0; launch < 2; launch++) {
      const startup = new StartupController({
        persistence: storage,
        automaticSafeStart: true,
        newProcess: true,
      });
      const selected = await loadStartupSurface(startup, {
        validateSettings: () => validatePersistedSettings({ getItem: () => '{bad-json' }),
        loadNormal: async () => 'normal-app',
        loadSafeStart: async () => 'safe-shell',
        loadStartupFailure: async () => 'failure-shell',
        loadInlineFallback: async () => 'inline-shell',
      });
      assert.equal(selected.mode, 'startup-failure');
    }
    const recovery = new StartupController({
      persistence: storage,
      automaticSafeStart: true,
      newProcess: true,
    });
    const selected = await loadStartupSurface(recovery, {
      validateSettings: () => assert.fail('Safe Start must not touch malformed settings'),
      loadNormal: async () => assert.fail('Safe Start must not load App'),
      loadSafeStart: async () => 'safe-shell',
      loadStartupFailure: async () => 'failure-shell',
      loadInlineFallback: async () => 'inline-shell',
    });
    assert.deepEqual(selected, { mode: 'safe-start', module: 'safe-shell' });
  });

  test('two conversation-storage failures make the following launch render Safe Start', async () => {
    const storage = new MemoryPersistence();
    for (let launch = 0; launch < 2; launch++) {
      const startup = new StartupController({
        persistence: storage,
        automaticSafeStart: true,
        newProcess: true,
      });
      const selected = await loadStartupSurface(startup, {
        validateSettings: () => {},
        loadNormal: async () => 'normal-app',
        loadSafeStart: async () => 'safe-shell',
        loadStartupFailure: async () => 'failure-shell',
        loadInlineFallback: async () => 'inline-shell',
      });
      assert.equal(selected.mode, 'normal');
      const initialized = await initializeNormalStartup(startup, {
        openStorage: async () => { throw new Error('injected storage failure'); },
        hydrateConversationMetadata: async () => assert.fail('metadata hydration must be skipped'),
      });
      assert.equal(initialized.ok, false);
    }
    const recovery = new StartupController({
      persistence: storage,
      automaticSafeStart: true,
      newProcess: true,
    });
    const selected = await loadStartupSurface(recovery, {
      validateSettings: () => assert.fail('Safe Start must not initialize settings'),
      loadNormal: async () => assert.fail('Safe Start must not load storage or App'),
      loadSafeStart: async () => 'safe-shell',
      loadStartupFailure: async () => 'failure-shell',
      loadInlineFallback: async () => 'inline-shell',
    });
    assert.deepEqual(selected, { mode: 'safe-start', module: 'safe-shell' });
  });

  test('normal loader failures are structured without raw exception text', async () => {
    const storage = new MemoryPersistence();
    const startup = new StartupController({
      persistence: storage,
      automaticSafeStart: true,
      newProcess: true,
    });
    const selected = await loadStartupSurface(startup, {
      validateSettings: () => {},
      loadNormal: async () => { throw new Error('C:\\Users\\Alice\\private.db'); },
      loadSafeStart: async () => 'safe-shell',
      loadStartupFailure: async () => 'failure-shell',
      loadInlineFallback: async () => 'inline-shell',
    });
    if (selected.mode !== 'startup-failure') {
      throw new Error(`expected startup-failure, received ${selected.mode}`);
    }
    assert.equal(selected.code, 'normal-app-import-failed');
    assert.equal([...storage.values.values()].join('').includes('Alice'), false);
  });

  test('a failed Safe Start shell import renders the failure surface with a bounded code', async () => {
    const storage = new MemoryPersistence();
    const startup = controllerAfterTwoFailures(storage);
    const selected = await loadStartupSurface(startup, {
      loadNormal: async () => assert.fail('Safe Start must not load App'),
      loadSafeStart: async () => { throw new Error('safe shell chunk unavailable'); },
      loadStartupFailure: async () => 'failure-shell',
      loadInlineFallback: async () => 'inline-shell',
    });
    assert.deepEqual(selected, {
      mode: 'startup-failure',
      code: 'startup-interface-unavailable',
      module: 'failure-shell',
    });
  });

  test('a total dynamic-import failure still renders the inline entry-chunk fallback', async () => {
    const storage = new MemoryPersistence();
    const startup = controllerAfterTwoFailures(storage);
    const selected = await loadStartupSurface(startup, {
      loadNormal: async () => assert.fail('Safe Start must not load App'),
      loadSafeStart: async () => { throw new Error('safe shell chunk unavailable'); },
      loadStartupFailure: async () => { throw new Error('failure shell chunk unavailable'); },
      loadInlineFallback: async () => 'inline-shell',
    });
    assert.deepEqual(selected, {
      mode: 'startup-failure',
      code: 'startup-interface-unavailable',
      module: 'inline-shell',
    });
  });

  test('a normal-graph failure with a broken failure shell still renders the inline fallback', async () => {
    const storage = new MemoryPersistence();
    const startup = new StartupController({
      persistence: storage,
      automaticSafeStart: true,
      newProcess: true,
    });
    const selected = await loadStartupSurface(startup, {
      validateSettings: () => {},
      loadNormal: async () => { throw new Error('normal app chunk unavailable'); },
      loadSafeStart: async () => 'safe-shell',
      loadStartupFailure: async () => { throw new Error('failure shell chunk unavailable'); },
      loadInlineFallback: async () => 'inline-shell',
    });
    assert.deepEqual(selected, {
      mode: 'startup-failure',
      code: 'normal-app-import-failed',
      module: 'inline-shell',
    });
  });

  test('main has no eager App import and Safe Start collector has no normal-store imports', async () => {
    const [main, collector, native] = await Promise.all([
      readFile(new URL('../main.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../safe-start/safe-start-support-report.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8'),
    ]);
    assert.doesNotMatch(main, /^import\s+.*['"]\.\/App(?:\.tsx)?['"]/m);
    assert.match(main, /import\(['"]\.\/App\.tsx['"]\)/);
    // The production caller must wire the cannot-fail inline fallback; without
    // it the loader chain is not total and a broken chunk graph blanks out.
    assert.match(main, /loadInlineFallback/);
    const importLines = collector.split('\n').filter((line) => /^import\b/.test(line)).join('\n');
    assert.doesNotMatch(importLines, /(?:store\/|support-report-collector|server-profiles|chat-pipeline|tool-engine|skills)/);
    const singleInstance = native.indexOf('.plugin(tauri_plugin_single_instance::init');
    const firstOperationalPlugin = native.indexOf('.plugin(tauri_plugin_http::init');
    assert.ok(singleInstance >= 0, 'the desktop startup must reject a concurrent native instance');
    assert.ok(singleInstance < firstOperationalPlugin, 'single-instance admission must run before other plugins');
  });
});
