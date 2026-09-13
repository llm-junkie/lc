import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOverride,
  clearModelOverrides,
  isValidContextOverride,
  loadModelOverrides,
  sanitizeOverride,
  sanitizeOverrideMap,
  saveModelOverrides,
} from './model-overrides.ts';
import type { AppModelEntry } from './model-store';
import {
  clearModelCustomizations,
  loadModelCustomizations,
  sanitizeModelCustomizations,
  saveModelCustomizations,
} from './model-customizations.ts';

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

const { loadHidden } = await import('../../store/modelVisibility.ts');

const PRIMARY = 'lc_model_meta_overrides';
const BACKUP = 'lc_model_meta_overrides_bak';

afterEach(() => storage.clear());

function detectedEntry(overrides: Partial<AppModelEntry> = {}): AppModelEntry {
  return {
    id: 'model-a',
    displayName: 'Model A',
    profileId: 'profile-1',
    profileName: 'Cloud',
    apiVariant: 'openai',
    apiStyle: 'chat',
    maxContextLength: 8192,
    capabilities: { vision: true, reasoning: false, tools: true },
    ...overrides,
  };
}

describe('applyOverride', () => {
  test('merges each field independently and leaves the rest detected', () => {
    const detected = detectedEntry();
    const merged = applyOverride(detected, { c: 131072, r: true });

    assert.equal(merged.maxContextLength, 131072);
    assert.equal(merged.capabilities.reasoning, true);
    // Untouched fields still come from the detected layer.
    assert.equal(merged.capabilities.vision, true);
    assert.equal(merged.capabilities.tools, true);
    assert.equal(merged.displayName, 'Model A');
  });

  test('an explicit false beats a detected true', () => {
    const merged = applyOverride(detectedEntry(), { v: false });
    assert.equal(merged.capabilities.vision, false);
  });

  test('a display-name override changes only the effective name', () => {
    const detected = detectedEntry();
    const merged = applyOverride(detected, { n: 'Friendly name' });
    assert.equal(merged.displayName, 'Friendly name');
    assert.equal(detected.displayName, 'Model A');
  });

  test('an absent field means no opinion, not false', () => {
    const merged = applyOverride(detectedEntry(), { c: 4096 });
    assert.equal(merged.capabilities.vision, true);
    assert.equal(merged.capabilities.tools, true);
  });

  test('does not mutate the detected entry, its capabilities, or the override', () => {
    const detected = detectedEntry();
    const caps = detected.capabilities;
    const override = { c: 999, v: false, r: true, t: false };
    const frozenOverride = { ...override };

    const merged = applyOverride(detected, override);

    assert.notEqual(merged, detected);
    assert.notEqual(merged.capabilities, caps);
    assert.equal(detected.maxContextLength, 8192);
    assert.deepEqual(detected.capabilities, { vision: true, reasoning: false, tools: true });
    assert.equal(detected.capabilities, caps, 'detected.capabilities was replaced');
    assert.deepEqual(override, frozenOverride);
  });

  test('with no override still returns a fresh entry and capabilities object', () => {
    const detected = detectedEntry();
    const merged = applyOverride(detected, undefined);

    assert.notEqual(merged, detected);
    assert.notEqual(merged.capabilities, detected.capabilities);
    assert.deepEqual(merged.capabilities, detected.capabilities);
  });
});

describe('override validation', () => {
  test('context must be a positive safe integer', () => {
    assert.equal(isValidContextOverride(1), true);
    assert.equal(isValidContextOverride(131072), true);
    assert.equal(isValidContextOverride(0), false);
    assert.equal(isValidContextOverride(-8), false);
    assert.equal(isValidContextOverride(8192.5), false);
    assert.equal(isValidContextOverride(Number.POSITIVE_INFINITY), false);
    assert.equal(isValidContextOverride(Number.NaN), false);
    assert.equal(isValidContextOverride(Number.MAX_SAFE_INTEGER + 2), false);
    assert.equal(isValidContextOverride('8192'), false);
  });

  test('sanitizeOverride drops empty entries and rejects malformed ones', () => {
    assert.equal(sanitizeOverride({}), null);
    assert.equal(sanitizeOverride(null), null);
    assert.equal(sanitizeOverride([]), null);
    assert.equal(sanitizeOverride('nope'), null);
    assert.equal(sanitizeOverride({ c: 0 }), null);
    assert.equal(sanitizeOverride({ v: 'yes' }), null);
    assert.deepEqual(sanitizeOverride({ v: false }), { v: false });
    assert.deepEqual(sanitizeOverride({ n: ' Friendly ', c: 4096, r: true, extra: 1 }), { n: 'Friendly', c: 4096, r: true });
    assert.equal(sanitizeOverride({ n: '  ' }), null);
  });

  test('sanitizeOverrideMap keeps valid entries and drops the rest', () => {
    const cleaned = sanitizeOverrideMap({
      'p1:model-a': { c: 4096 },
      'p1:model-b': {},
      'p1:model-c': { v: 'no' },
      'p2:model-a': { v: false },
      '': { c: 1 },
    });
    assert.deepEqual(cleaned, {
      'p1:model-a': { c: 4096 },
      'p2:model-a': { v: false },
    });
  });

  test('sanitizeOverrideMap rejects a non-record payload', () => {
    assert.deepEqual(sanitizeOverrideMap([{ c: 1 }]), {});
    assert.deepEqual(sanitizeOverrideMap(null), {});
  });
});

describe('override persistence', () => {
  test('writes both the primary and the backup key', () => {
    saveModelOverrides({ 'p1:model-a': { v: false } });
    assert.equal(storage.getItem(PRIMARY), JSON.stringify({ 'p1:model-a': { v: false } }));
    assert.equal(storage.getItem(BACKUP), storage.getItem(PRIMARY));
  });

  test('a valid empty primary is authoritative and does not restore the backup', () => {
    storage.setItem(PRIMARY, JSON.stringify({}));
    storage.setItem(BACKUP, JSON.stringify({ 'p1:model-a': { c: 4096 } }));
    assert.deepEqual(loadModelOverrides(), {});
  });

  test('a malformed primary falls back to the backup and promotes it', () => {
    storage.setItem(PRIMARY, '{not json');
    storage.setItem(BACKUP, JSON.stringify({ 'p1:model-a': { c: 4096 } }));

    assert.deepEqual(loadModelOverrides(), { 'p1:model-a': { c: 4096 } });
    assert.equal(storage.getItem(PRIMARY), JSON.stringify({ 'p1:model-a': { c: 4096 } }));
  });

  test('a missing primary falls back to the backup', () => {
    storage.setItem(BACKUP, JSON.stringify({ 'p1:model-a': { v: true } }));
    assert.deepEqual(loadModelOverrides(), { 'p1:model-a': { v: true } });
  });

  test('load normalizes what it reads and drops corrupt entries', () => {
    storage.setItem(PRIMARY, JSON.stringify({
      'p1:model-a': { c: 4096 },
      'p1:model-b': { c: -1 },
      'p1:model-c': {},
    }));
    assert.deepEqual(loadModelOverrides(), { 'p1:model-a': { c: 4096 } });
  });

  test('clear leaves an explicit empty object in both keys', () => {
    saveModelOverrides({ 'p1:model-a': { v: false } });
    clearModelOverrides();
    assert.equal(storage.getItem(PRIMARY), '{}');
    assert.equal(storage.getItem(BACKUP), '{}');
    assert.deepEqual(loadModelOverrides(), {});
  });

  test('the same model id on two profiles keeps separate overrides', () => {
    saveModelOverrides({
      'profile-1:shared-model': { v: false },
      'profile-2:shared-model': { c: 200000 },
    });
    const loaded = loadModelOverrides();
    assert.deepEqual(loaded['profile-1:shared-model'], { v: false });
    assert.deepEqual(loaded['profile-2:shared-model'], { c: 200000 });
  });

  test('a model id containing a colon survives a round trip intact', () => {
    // The composite key is never split back apart, so `a:b` in the model id
    // cannot be mistaken for the profile separator.
    saveModelOverrides({ 'profile-1:vendor:model:v2': { c: 32768 } });
    assert.deepEqual(loadModelOverrides()['profile-1:vendor:model:v2'], { c: 32768 });
  });
});

describe('model customization persistence', () => {
  test('round-trips manual models and deleted server IDs through both keys', () => {
    const value = {
      p1: {
        added: { 'glm-5.3': { n: 'GLM 5.3', c: 262144, v: false, r: true, t: true } },
        deleted: ['old-model'],
      },
    };
    saveModelCustomizations(value);
    assert.deepEqual(loadModelCustomizations(), value);
    assert.equal(storage.getItem('lc_model_customizations'), storage.getItem('lc_model_customizations_bak'));
  });

  test('drops malformed definitions and empty profiles', () => {
    assert.deepEqual(sanitizeModelCustomizations({
      empty: { added: {}, deleted: [] },
      p1: {
        added: {
          good: { n: ' Good ', c: 4096, t: false },
          missingName: { c: 4096 },
          badContext: { n: 'Bad', c: 0 },
        },
        deleted: ['gone', 'gone', '', 4],
      },
    }), {
      p1: { added: { good: { n: 'Good', c: 4096, t: false } }, deleted: ['gone'] },
    });
  });

  test('a valid empty primary stays authoritative over a stale backup', () => {
    saveModelCustomizations({ p1: { added: { manual: { n: 'Manual' } }, deleted: [] } });
    clearModelCustomizations();
    assert.deepEqual(loadModelCustomizations(), {});
  });
});

describe('model visibility persistence', () => {
  test('a valid empty primary does not restore a stale backup', () => {
    storage.setItem('lc_hidden_models', '[]');
    storage.setItem('lc_hidden_models_bak', JSON.stringify(['p1:model-a']));

    assert.deepEqual([...loadHidden()], []);
  });

  test('a malformed primary restores a valid backup', () => {
    storage.setItem('lc_hidden_models', '{not json');
    storage.setItem('lc_hidden_models_bak', JSON.stringify(['p1:model-a']));

    assert.deepEqual([...loadHidden()], ['p1:model-a']);
  });
});
