import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { modelCache } from './model-cache.ts';
import { modelEnricher } from './model-enricher.ts';
import { readDiagnosticEvents, resetDiagnosticEvents } from '../../utils/diagnostic-events.ts';
import {
  MODEL_ENRICHMENT_CONCURRENCY,
  MODEL_LIST_MAX_ENTRIES,
} from '../llm-client/models/limits.ts';
import type { ServerProfile } from '../../types';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('Storage quota exceeded.', 'QuotaExceededError');
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    if (this.failWrites) throw new DOMException('Storage quota exceeded.', 'QuotaExceededError');
    this.values.delete(key);
  }
  clear(): void {
    if (this.failWrites) throw new DOMException('Storage quota exceeded.', 'QuotaExceededError');
    this.values.clear();
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

const profile: ServerProfile = {
  id: 'profile-1',
  name: 'LM Studio',
  baseUrl: 'http://localhost:1234/v1',
  apiVariant: 'lm-studio',
};

const remoteProfile: ServerProfile = {
  id: 'profile-remote',
  name: 'Remote',
  baseUrl: 'https://api.example.test/v1',
  modelFetchUrl: 'https://models.example.test/catalogue',
  apiVariant: 'openai',
};

const originalEnrichAll = modelEnricher.enrichAll;
const originalEnrich = modelEnricher.enrich;

afterEach(() => {
  storage.failWrites = false;
  storage.clear();
  modelEnricher.enrichAll = originalEnrichAll;
  modelEnricher.enrich = originalEnrich;
  resetDiagnosticEvents();
});

function enriched(id: string) {
  return {
    id,
    displayName: id,
    capabilities: { vision: false, reasoning: false, tools: true },
    source: 'lmstudio-rest' as const,
  };
}

describe('model cache write ordering', () => {
  test('enrichment work stays within its concurrency bound', async () => {
    let active = 0;
    let maximum = 0;
    modelEnricher.enrich = async (model) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return enriched(model.id);
    };

    await originalEnrichAll.call(modelEnricher, Array.from(
      { length: MODEL_ENRICHMENT_CONCURRENCY * 3 },
      (_, index) => ({ id: `model-${index}` }),
    ), profile.baseUrl);

    assert.equal(maximum, MODEL_ENRICHMENT_CONCURRENCY);
  });

  test('compatible reads reject cache entries from a different endpoint or protocol', async () => {
    modelEnricher.enrichAll = async (models) => models.map((model) => enriched(model.id));
    await modelCache.set(remoteProfile.id, [{ id: 'remote-model' }], remoteProfile);

    assert.ok(modelCache.getCompatible(remoteProfile));
    assert.equal(modelCache.getCompatible({
      ...remoteProfile,
      baseUrl: 'https://replacement.example.test/v1',
    }), null);
    assert.equal(modelCache.getCompatible({
      ...remoteProfile,
      modelFetchUrl: 'https://replacement.example.test/catalogue',
    }), null);
    assert.equal(modelCache.getCompatible({
      ...remoteProfile,
      apiVariant: 'anthropic',
    }), null);
  });

  test('a malformed non-object cache cannot swallow the next valid write', async () => {
    storage.setItem('lc:server-model-cache', '[]');
    modelEnricher.enrichAll = async (models) => models.map((model) => enriched(model.id));

    await modelCache.set('profile-1', [{ id: 'recovered-model' }], profile);

    assert.deepEqual(
      Object.keys(modelCache.get('profile-1')?.models ?? {}),
      ['recovered-model'],
    );
  });

  test('cache reads drop malformed servers and models', () => {
    storage.setItem('lc:server-model-cache', JSON.stringify({
      broken: [],
      'profile-1': {
        name: 'LM Studio',
        baseUrl: 'http://localhost:1234/v1',
        apiVariant: 'lm-studio',
        updatedAt: 1,
        models: {
          valid: { c: 4096, v: false },
          malformed: { c: 'many' },
        },
      },
    }));

    assert.equal(modelCache.get('broken'), null);
    assert.deepEqual(Object.keys(modelCache.get('profile-1')?.models ?? {}), ['valid']);
  });

  test('upgrade reads reject an oversized detected cache instead of truncating it', () => {
    const models = Object.fromEntries(Array.from(
      { length: MODEL_LIST_MAX_ENTRIES + 1 },
      (_, index) => [`model-${index}`, {}],
    ));
    storage.setItem('lc:server-model-cache', JSON.stringify({
      [profile.id]: {
        name: profile.name,
        baseUrl: profile.baseUrl,
        apiVariant: profile.apiVariant,
        updatedAt: Date.now(),
        models,
      },
    }));

    assert.equal(modelCache.get(profile.id), null);
    assert.equal(modelCache.getCompatible(profile), null);
  });

  test('a newer probe cannot be overwritten by an older async enrichment', async () => {
    let releaseOld!: () => void;
    let releaseNew!: () => void;

    modelEnricher.enrichAll = async (models) => {
      const result = models.map((m) => enriched(m.id));
      await new Promise<void>((resolve) => {
        if (models[0]?.id === 'old-model') releaseOld = resolve;
        else releaseNew = resolve;
      });
      return result;
    };

    const oldWrite = modelCache.set('profile-1', [{ id: 'old-model' }], profile);
    const newWrite = modelCache.set('profile-1', [{ id: 'new-model' }], profile);

    releaseNew();
    await newWrite;
    releaseOld();
    await oldWrite;

    assert.deepEqual(Object.keys(modelCache.get('profile-1')?.models ?? {}), ['new-model']);
  });

  test('deleting a profile invalidates an in-flight cache write', async () => {
    let release!: () => void;
    modelEnricher.enrichAll = async (models) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return models.map((m) => enriched(m.id));
    };

    const pending = modelCache.set('profile-1', [{ id: 'stale-model' }], profile);
    modelCache.delete('profile-1');
    release();
    await pending;

    assert.equal(modelCache.get('profile-1'), null);
  });

  test('prune after delete stays correct when the fresh write overlaps the stale one', async () => {
    const blockers: Array<() => void> = [];
    modelEnricher.enrichAll = async (models) => {
      await new Promise<void>((resolve) => { blockers.push(resolve); });
      return models.map((m) => enriched(m.id));
    };

    // Isolate from earlier tests in this file: the module-level writeVersions
    // map persists across tests, and a pre-existing version for this profile
    // would mask the collision this test exists to catch. Pruning first makes
    // both writes below start from a fresh version space.
    modelCache.prune('profile-1');

    // A stale write is in flight when the profile is permanently removed.
    const staleWrite = modelCache.set('profile-1', [{ id: 'stale-model' }], profile);
    modelCache.delete('profile-1');
    modelCache.prune('profile-1');

    // The fresh write for a re-created profile with the same id STARTS while
    // the stale write is still in flight — the overlap that broke a
    // per-profile write counter (see nextWriteVersion in model-cache.ts).
    const freshWrite = modelCache.set('profile-1', [{ id: 'fresh-model' }], profile);

    // Fresh completes first: it must land.
    blockers[1]();
    await freshWrite;
    assert.deepEqual(Object.keys(modelCache.get('profile-1')?.models ?? {}), ['fresh-model']);

    // The stale write resumes later: it must NOT overwrite the fresh list.
    blockers[0]();
    await staleWrite;
    assert.deepEqual(Object.keys(modelCache.get('profile-1')?.models ?? {}), ['fresh-model']);
  });

  test('persists model metadata from a completed enrichment', async () => {
    modelEnricher.enrichAll = async () => [{
      id: 'qwen/qwen-vl',
      displayName: 'Qwen/Qwen-VL',
      maxContextLength: 131072,
      capabilities: { vision: true, reasoning: true, tools: true },
      source: 'lmstudio-rest' as const,
    }];

    await modelCache.set('profile-1', [{
      id: 'qwen/qwen-vl',
      display_name: 'Qwen/Qwen-VL',
      max_context_length: 131072,
      capabilities: { vision: true, reasoning: true, tools: true },
      source: 'lmstudio-rest',
    }], profile);

    assert.deepEqual(modelCache.get('profile-1')?.models['qwen/qwen-vl'], {
      c: 131072,
      v: true,
      r: true,
      t: true,
      source: 'lmstudio-rest',
    });
  });

  test('a detected false capability survives write and read', async () => {
    // `|| undefined` used to collapse every detected `false` into "unknown",
    // which cost inactive profiles and cold starts their detected layer —
    // exactly where there is no live probe to re-derive it from.
    modelEnricher.enrichAll = async () => [{
      id: 'text-only',
      displayName: 'text-only',
      maxContextLength: 8192,
      capabilities: { vision: false, reasoning: false, tools: false },
    }];

    await modelCache.set('profile-1', [{ id: 'text-only' }], profile);

    assert.deepEqual(modelCache.get('profile-1')?.models['text-only'], {
      c: 8192,
      v: false,
      r: false,
      t: false,
    });
  });

  test('a quota failure emits a storage outcome from the production cache path', () => {
    resetDiagnosticEvents();
    storage.failWrites = true;

    modelCache.clearAll();

    assert.deepEqual(
      readDiagnosticEvents()
        .filter((event) => event.subsystem === 'storage')
        .map((event) => event.code),
      ['storage-write-failed'],
    );
  });
});
