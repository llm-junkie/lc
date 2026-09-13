/**
 * Persisted-settings material migration (store schema v1 → v2).
 *
 * v1 stored `solidTheme: 'auto' | 'on' | 'off'`. v2 stores
 * `materialMode: 'auto' | 'glass' | 'solid'` with the effective
 * preference preserved. These tests drive the real zustand persist
 * `migrate` path by seeding localStorage with a v1 blob before the
 * store module loads — the same path a real upgrade takes.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

/** Seed a v1 persisted blob with the given `solidTheme` value. */
function seedV1(solidTheme: string) {
  storage.clear();
  storage.setItem('lc:settings', JSON.stringify({
    state: { theme: 'light', solidTheme },
    version: 1,
  }));
}

async function importFreshStore() {
  // The persist middleware reads storage once at module evaluation.
  // Reset the module registry so each case sees its own seed.
  const moduleUrl = new URL('./settings.ts', import.meta.url).href + `?case=${Math.random()}`;
  return import(/* @vite-ignore */ moduleUrl);
}

describe('settings material migration (v1 → v2)', () => {
  test('solidTheme on → materialMode solid', async () => {
    seedV1('on');
    const { useSettings } = await importFreshStore();
    assert.equal(useSettings.getState().materialMode, 'solid');
    assert.equal('solidTheme' in useSettings.getState(), false);
  });

  test('solidTheme off → materialMode glass', async () => {
    seedV1('off');
    const { useSettings } = await importFreshStore();
    assert.equal(useSettings.getState().materialMode, 'glass');
  });

  test('solidTheme auto → materialMode auto', async () => {
    seedV1('auto');
    const { useSettings } = await importFreshStore();
    assert.equal(useSettings.getState().materialMode, 'auto');
  });

  test('legacy solidTheme key is removed from the persisted blob', async () => {
    seedV1('on');
    await importFreshStore();
    // Force a persist write, then read the raw blob.
    const { useSettings } = await importFreshStore();
    useSettings.getState().setAssistantName('Migration Probe');
    const raw = storage.getItem('lc:settings');
    assert.ok(raw, 'settings were not persisted');
    const parsed = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    assert.equal(parsed.version, 2);
    assert.equal(parsed.state.materialMode, 'solid');
    assert.equal('solidTheme' in parsed.state, false);
  });
});
