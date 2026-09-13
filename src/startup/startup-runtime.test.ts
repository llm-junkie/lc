import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STARTUP_INCOMPLETE_LIMIT,
  STARTUP_STORAGE_KEY,
  parseStartupMarker,
} from './startup-state.ts';
import {
  StartupController,
  readPersistedStartupDiagnostics,
  type StartupPersistence,
} from './startup-runtime.ts';

class MemoryPersistence implements StartupPersistence {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ key: string; value: string }> = [];
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
    this.writes.push({ key, value });
  }
}

describe('startup persistence adapter', () => {
  test('controller persists only bounded startup-marker state and repeated ready is idempotent', () => {
    const storage = new MemoryPersistence();
    const controller = new StartupController({
      persistence: storage,
      automaticSafeStart: true,
      newProcess: true,
    });
    controller.phase('settings-validated');
    controller.phase('settings-validated');
    controller.phase('storage-opened');
    controller.ready();
    const writesAtReady = storage.writes.length;
    controller.ready();
    assert.equal(storage.writes.length, writesAtReady);
    assert.deepEqual(readPersistedStartupDiagnostics(storage), {
      lastCompletedPhase: 'ready',
      incompleteStartCount: 0,
      safeStartState: 'inactive',
    });
    assert.deepEqual([...new Set(storage.writes.map((write) => write.key))], [STARTUP_STORAGE_KEY]);
  });

  test('malformed state attempts normal startup and records a structured marker failure', () => {
    const storage = new MemoryPersistence();
    storage.values.set(STARTUP_STORAGE_KEY, '{private exception text');
    const controller = new StartupController({
      persistence: storage,
      automaticSafeStart: true,
      newProcess: true,
    });
    assert.equal(controller.mode, 'normal');
    assert.equal(controller.snapshot().failureCode, 'startup-marker-malformed');
    assert.equal(storage.values.get(STARTUP_STORAGE_KEY)?.includes('private exception text'), false);
    assert.equal(parseStartupMarker(storage.values.get(STARTUP_STORAGE_KEY) ?? null).malformed, false);
  });

  test('unavailable persistence is recoverable and disables automatic counting', () => {
    const broken: StartupPersistence = {
      getItem() { throw new Error('private storage failure'); },
      setItem() { throw new Error('private storage failure'); },
    };
    const controller = new StartupController({
      persistence: broken,
      automaticSafeStart: true,
      newProcess: true,
    });
    assert.equal(controller.mode, 'normal');
    assert.deepEqual(controller.snapshot(), {
      lastCompletedPhase: 'unknown',
      incompleteStartCount: 0,
      safeStartState: 'not-available',
      failureCode: 'startup-marker-unavailable',
    });
  });

  test('concurrent controllers sharing one storage keep the marker bounded and parseable', () => {
    const storage = new MemoryPersistence();
    const first = new StartupController({ persistence: storage, automaticSafeStart: true, newProcess: true });
    const second = new StartupController({ persistence: storage, automaticSafeStart: true, newProcess: true });
    first.phase('settings-validated');
    second.phase('storage-opened');
    first.ready();
    second.ready();
    // The native single-instance gate prevents this production race. Keep the
    // adapter bounded if another same-origin writer still shares the marker.
    const parsed = parseStartupMarker(storage.values.get(STARTUP_STORAGE_KEY) ?? null);
    assert.equal(parsed.malformed, false);
    assert.ok(parsed.marker.incompleteStartCount <= STARTUP_INCOMPLETE_LIMIT);
    assert.ok(['idle', 'starting'].includes(parsed.marker.status));
    assert.ok(['not-available', 'inactive', 'active', 'unknown'].includes(parsed.marker.safeStartState));
  });
});
