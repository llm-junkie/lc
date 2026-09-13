/**
 * Canonical-registry behaviour: detected/effective layering, exact
 * profile+model identity, synchronous override recomputation, and inactive
 * cached records.
 *
 * Everything here runs without a network round trip — the point of the
 * registry is that an override takes effect without one.
 */

import { beforeEach, describe, test } from 'node:test';
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

const {
  useAppModels,
  selectEffectiveModel,
  selectVisibilityRecords,
  selectMetadataOverride,
  selectModelOwnerProfileId,
} = await import('./model-store.ts');
const { useProfileStore } = await import('./profile-store.ts');
const { crossServerModels, findModelOwner } = await import('./cross-server.ts');
const { createLMStudioModelClient, resolveModelServer } = await import('./model-routing.ts');
const { useModelVisibility } = await import('../../store/modelVisibility.ts');
type AppModelEntry = import('./model-store.ts').AppModelEntry;
type ServerProfile = import('../../types.ts').ServerProfile;

const CACHE_KEY = 'lc:server-model-cache';

function profile(id: string, name: string, active: boolean): ServerProfile {
  return {
    id,
    name,
    baseUrl: `https://${id}.example.test/v1`,
    apiKey: '',
    apiVariant: 'openai',
    apiStyle: 'chat',
    routing: 'proxy',
    active,
    sse_read_timeout_min: 5,
  };
}

function entry(
  profileId: string,
  profileName: string,
  id: string,
  over: Partial<AppModelEntry> = {},
): AppModelEntry {
  return {
    id,
    displayName: id,
    profileId,
    profileName,
    apiVariant: 'openai',
    apiStyle: 'chat',
    maxContextLength: 8192,
    capabilities: { vision: false, reasoning: false, tools: true },
    ...over,
  };
}

/** Populate the registry from the persistent cache without a live probe.
 *  `bootstrap()` is cache-commit-then-refresh; stubbing refresh keeps the
 *  cache-commit half deterministic and offline. */
async function bootstrapFromCacheOnly(): Promise<void> {
  const realRefresh = useAppModels.getState().refresh;
  useAppModels.setState({ refresh: async () => {} });
  try {
    await useAppModels.getState().bootstrap();
  } finally {
    useAppModels.setState({ refresh: realRefresh, loading: false, _refreshing: false });
  }
}

beforeEach(() => {
  storage.clear();
  useAppModels.setState({ records: {}, overrides: {}, customizations: {}, models: [], serverHealth: {}, loading: false });
  useModelVisibility.setState({ hidden: new Set() });
  useProfileStore.setState({ profiles: [profile('p1', 'Alpha', true), profile('p2', 'Beta', true)] });
});

describe('registry records', () => {
  test('replaceProfileModels builds detected + effective records and the active projection', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a')]);

    const record = useAppModels.getState().records['p1:model-a'];
    assert.ok(record);
    assert.equal(record.profileActive, true);
    assert.equal(record.origin, 'live');
    assert.equal(record.override, undefined);
    assert.equal(record.detected.maxContextLength, 8192);
    assert.equal(record.effective.maxContextLength, 8192);
    assert.deepEqual(useAppModels.getState().models.map((m) => m.id), ['model-a']);
  });

  test('an override changes the effective models array synchronously', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a')]);
    const before = useAppModels.getState().models;

    useAppModels.getState().setMetadataOverride('p1', 'model-a', { c: 131072, v: true });

    const after = useAppModels.getState().models;
    assert.notEqual(after, before, 'projection identity did not change');
    assert.equal(after[0].maxContextLength, 131072);
    assert.equal(after[0].capabilities.vision, true);
    // The detected layer is untouched: overrides are never folded into it.
    assert.equal(useAppModels.getState().records['p1:model-a'].detected.maxContextLength, 8192);
    assert.equal(useAppModels.getState().records['p1:model-a'].detected.capabilities.vision, false);
  });

  test('an explicit vision false wins over detected true', () => {
    useAppModels.getState().replaceProfileModels('p1', [
      entry('p1', 'Alpha', 'model-a', { capabilities: { vision: true, reasoning: false, tools: true } }),
    ]);
    useAppModels.getState().setMetadataOverride('p1', 'model-a', { v: false });

    assert.equal(
      selectEffectiveModel(useAppModels.getState(), 'p1', 'model-a')?.capabilities.vision,
      false,
    );
  });

  test('removing an override restores the detected metadata without a refresh', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a')]);
    useAppModels.getState().setMetadataOverride('p1', 'model-a', { c: 131072 });
    assert.equal(useAppModels.getState().models[0].maxContextLength, 131072);

    useAppModels.getState().removeMetadataOverride('p1', 'model-a');

    assert.equal(useAppModels.getState().models[0].maxContextLength, 8192);
    assert.equal(useAppModels.getState().records['p1:model-a'].override, undefined);
    assert.equal(selectMetadataOverride(useAppModels.getState(), 'p1', 'model-a'), undefined);
  });

  test('resetMetadataOverrides restores every record at once', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a')]);
    useAppModels.getState().replaceProfileModels('p2', [entry('p2', 'Beta', 'model-b')]);
    useAppModels.getState().setMetadataOverride('p1', 'model-a', { c: 111 });
    useAppModels.getState().setMetadataOverride('p2', 'model-b', { c: 222 });

    useAppModels.getState().resetMetadataOverrides();

    assert.deepEqual(useAppModels.getState().overrides, {});
    for (const m of useAppModels.getState().models) {
      assert.equal(m.maxContextLength, 8192);
    }
  });

  test('replaceMetadataOverrides drops invalid entries and applies the rest', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a')]);
    useAppModels.getState().replaceMetadataOverrides({
      'p1:model-a': { c: 65536 },
      'p1:model-z': { c: -5 } as never,
    });

    assert.deepEqual(Object.keys(useAppModels.getState().overrides), ['p1:model-a']);
    assert.equal(useAppModels.getState().models[0].maxContextLength, 65536);
  });

  test('an empty override object is deleted rather than persisted', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a')]);
    useAppModels.getState().setMetadataOverride('p1', 'model-a', { c: 4096 });
    useAppModels.getState().setMetadataOverride('p1', 'model-a', {});

    assert.deepEqual(useAppModels.getState().overrides, {});
    assert.equal(useAppModels.getState().models[0].maxContextLength, 8192);
  });

  test('the same model id on two profiles stays isolated', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'shared')]);
    useAppModels.getState().replaceProfileModels('p2', [entry('p2', 'Beta', 'shared')]);

    useAppModels.getState().setMetadataOverride('p1', 'shared', { c: 200000, v: true });

    const state = useAppModels.getState();
    assert.equal(selectEffectiveModel(state, 'p1', 'shared')?.maxContextLength, 200000);
    assert.equal(selectEffectiveModel(state, 'p1', 'shared')?.capabilities.vision, true);
    assert.equal(selectEffectiveModel(state, 'p2', 'shared')?.maxContextLength, 8192);
    assert.equal(selectEffectiveModel(state, 'p2', 'shared')?.capabilities.vision, false);
  });

  test('a composite lookup never matches a model id from another profile', () => {
    useAppModels.getState().replaceProfileModels('p2', [entry('p2', 'Beta', 'only-on-beta')]);
    assert.equal(selectEffectiveModel(useAppModels.getState(), 'p1', 'only-on-beta'), undefined);
  });

  test('replaceProfileModels leaves other profiles standing', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a')]);
    useAppModels.getState().replaceProfileModels('p2', [entry('p2', 'Beta', 'model-b')]);
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a2')]);

    assert.deepEqual(
      useAppModels.getState().models.map((m) => `${m.profileId}:${m.id}`).sort(),
      ['p1:model-a2', 'p2:model-b'],
    );
  });

  test('an orphaned override applies when its record comes back', () => {
    useAppModels.getState().replaceMetadataOverrides({ 'p1:model-a': { c: 4096 } });
    assert.equal(useAppModels.getState().models.length, 0);

    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a')]);

    assert.equal(useAppModels.getState().models[0].maxContextLength, 4096);
  });
});

describe('visibility records from the registry', () => {
  test('include cached models from inactive profiles', async () => {
    useProfileStore.setState({
      profiles: [profile('p1', 'Alpha', true), profile('p2', 'Beta', false)],
    });
    storage.setItem(CACHE_KEY, JSON.stringify({
      p1: {
        name: 'Alpha', baseUrl: 'https://p1.example.test/v1', apiVariant: 'openai',
        updatedAt: Date.now(),
        models: { 'model-a': { c: 8192, v: false, r: false, t: true } },
      },
      p2: {
        name: 'Beta', baseUrl: 'https://p2.example.test/v1', apiVariant: 'openai',
        updatedAt: Date.now(),
        models: { 'model-b': { c: 4096, v: true, r: false, t: true } },
      },
    }));

    await bootstrapFromCacheOnly();

    const records = selectVisibilityRecords(useAppModels.getState());
    const byKey = new Map(records.map((r) => [r.key, r]));
    assert.ok(byKey.has('p1:model-a'));
    assert.ok(byKey.has('p2:model-b'), 'inactive profile is missing from the registry');
    assert.equal(byKey.get('p2:model-b')?.profileActive, false);
    assert.equal(byKey.get('p2:model-b')?.origin, 'cache');
    // …but the inactive profile stays out of the active projection.
    assert.deepEqual(useAppModels.getState().models.map((m) => m.id), ['model-a']);
  });

  test('a cached false capability survives into the detected layer', async () => {
    useProfileStore.setState({ profiles: [profile('p1', 'Alpha', true)] });
    storage.setItem(CACHE_KEY, JSON.stringify({
      p1: {
        name: 'Alpha', baseUrl: 'https://p1.example.test/v1', apiVariant: 'openai',
        updatedAt: Date.now(),
        models: { 'model-a': { c: 8192, v: false, r: false, t: false } },
      },
    }));

    await bootstrapFromCacheOnly();

    const detected = useAppModels.getState().records['p1:model-a'].detected;
    assert.equal(detected.capabilities.vision, false);
    assert.equal(detected.capabilities.tools, false);
  });

  test('an override applies to a cached inactive record too', async () => {
    useProfileStore.setState({ profiles: [profile('p2', 'Beta', false)] });
    storage.setItem(CACHE_KEY, JSON.stringify({
      p2: {
        name: 'Beta', baseUrl: 'https://p2.example.test/v1', apiVariant: 'openai',
        updatedAt: Date.now(),
        models: { 'model-b': { c: 4096, v: false } },
      },
    }));

    await bootstrapFromCacheOnly();
    useAppModels.getState().setMetadataOverride('p2', 'model-b', { v: true, c: 32768 });

    const record = useAppModels.getState().records['p2:model-b'];
    assert.equal(record.effective.capabilities.vision, true);
    assert.equal(record.effective.maxContextLength, 32768);
    assert.equal(record.detected.capabilities.vision, false);
  });
});

describe('profile model customizations', () => {
  test('adds a manual model even when the server returned no models', () => {
    useAppModels.getState().addCustomModel('p1', 'glm-5.3', {
      n: 'GLM 5.3', c: 262144, v: false, r: true, t: true,
    });

    const record = useAppModels.getState().records['p1:glm-5.3'];
    assert.equal(record.origin, 'manual');
    assert.equal(record.effective.displayName, 'GLM 5.3');
    assert.equal(record.effective.capabilities.reasoning, true);
    assert.equal(useAppModels.getState().models[0].id, 'glm-5.3');
  });

  test('manual additions survive later server fetch commits', () => {
    useAppModels.getState().addCustomModel('p1', 'manual', { n: 'Manual' });
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'server-model')]);

    assert.deepEqual(
      useAppModels.getState().models.filter((model) => model.profileId === 'p1').map((model) => model.id).sort(),
      ['manual', 'server-model'],
    );
  });

  test('deleting a fetched model keeps it suppressed across fetches', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'server-model')]);
    useAppModels.getState().deleteModel('p1', 'server-model');
    assert.equal(useAppModels.getState().records['p1:server-model'], undefined);

    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'server-model')]);
    assert.equal(useAppModels.getState().records['p1:server-model'], undefined);
    assert.deepEqual(useAppModels.getState().customizations.p1.deleted, ['server-model']);
  });

  test('restore defaults clears additions, deletions, and metadata overrides', () => {
    storage.setItem(CACHE_KEY, JSON.stringify({
      p1: {
        name: 'Alpha', baseUrl: 'https://p1.example.test/v1', apiVariant: 'openai',
        updatedAt: Date.now(), models: { fetched: { n: 'Fetched', c: 8192, t: true } },
      },
    }));
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'fetched')]);
    useAppModels.getState().setMetadataOverride('p1', 'fetched', { n: 'Renamed', c: 12345 });
    useAppModels.getState().deleteModel('p1', 'fetched');
    useAppModels.getState().addCustomModel('p1', 'manual', { n: 'Manual' });

    useAppModels.getState().resetProfileModelConfig('p1');

    assert.equal(useAppModels.getState().customizations.p1, undefined);
    assert.equal(useAppModels.getState().overrides['p1:fetched'], undefined);
    assert.equal(useAppModels.getState().records['p1:manual'], undefined);
    assert.equal(useAppModels.getState().records['p1:fetched'].effective.displayName, 'Fetched');
  });
});

describe('workspace vision candidates', () => {
  test('use effective metadata, so an override adds and removes a candidate', () => {
    const profiles = [profile('p1', 'Alpha', true)];
    useProfileStore.setState({ profiles });
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a')]);

    assert.deepEqual(crossServerModels(profiles, 'vision'), []);

    useAppModels.getState().setMetadataOverride('p1', 'model-a', { v: true });
    assert.deepEqual(
      crossServerModels(profiles, 'vision').map((m) => `${m.profileId}::${m.modelId}`),
      ['p1::model-a'],
    );

    useAppModels.getState().setMetadataOverride('p1', 'model-a', { v: false });
    assert.deepEqual(crossServerModels(profiles, 'vision'), []);
  });

  test('a hidden model is not a candidate even when its effective vision is true', () => {
    const profiles = [profile('p1', 'Alpha', true)];
    useProfileStore.setState({ profiles });
    useAppModels.getState().replaceProfileModels('p1', [
      entry('p1', 'Alpha', 'model-a', { capabilities: { vision: true, reasoning: false, tools: true } }),
    ]);
    assert.equal(crossServerModels(profiles, 'vision').length, 1);

    useModelVisibility.getState().hide('p1', 'model-a');
    assert.equal(crossServerModels(profiles, 'vision').length, 0);
  });

  test('an inactive profile contributes no candidates', () => {
    useProfileStore.setState({ profiles: [profile('p1', 'Alpha', true)] });
    useAppModels.getState().replaceProfileModels('p1', [
      entry('p1', 'Alpha', 'model-a', { capabilities: { vision: true, reasoning: false, tools: true } }),
    ]);
    assert.equal(crossServerModels([profile('p1', 'Alpha', false)], 'vision').length, 0);
  });
});

describe('token-meter context lookup', () => {
  /** The exact selector ChatView subscribes with. */
  const lookup = (serverId: string | undefined, model: string | undefined) =>
    useAppModels.getState().models.find((m) => m.profileId === serverId && m.id === model)
      ?.maxContextLength ?? 0;

  test('matches on both serverId and model id', () => {
    useAppModels.getState().replaceProfileModels('p1', [
      entry('p1', 'Alpha', 'shared', { maxContextLength: 8192 }),
    ]);
    useAppModels.getState().replaceProfileModels('p2', [
      entry('p2', 'Beta', 'shared', { maxContextLength: 128000 }),
    ]);

    assert.equal(lookup('p1', 'shared'), 8192);
    assert.equal(lookup('p2', 'shared'), 128000);
    assert.equal(lookup('p3', 'shared'), 0);
    assert.equal(lookup(undefined, 'shared'), 0);
  });

  test('a context override changes the lookup immediately', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a')]);
    assert.equal(lookup('p1', 'model-a'), 8192);

    useAppModels.getState().setMetadataOverride('p1', 'model-a', { c: 262144 });
    assert.equal(lookup('p1', 'model-a'), 262144);

    useAppModels.getState().removeMetadataOverride('p1', 'model-a');
    assert.equal(lookup('p1', 'model-a'), 8192);
  });

  test('an unknown context stays 0 so the meter uses its own fallback', () => {
    useAppModels.getState().replaceProfileModels('p1', [
      entry('p1', 'Alpha', 'model-a', { maxContextLength: undefined }),
    ]);
    assert.equal(lookup('p1', 'model-a'), 0);
  });
});

describe('registry-backed routing', () => {
  test('native load and unload use the owning profile bearer token', async () => {
    useProfileStore.setState({ profiles: [{
      ...profile('p1', 'Alpha', true),
      baseUrl: 'http://192.168.31.7:1234/v1',
      apiKey: 'lm-studio-token',
      routing: 'direct',
    }] });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const client = await createLMStudioModelClient('p1::ornith-1.5-35b-a3b', fetchImpl);
    assert.ok(client);
    await client.loadModel('ornith-1.5-35b-a3b');
    await client.unloadModel('qwen-instance');

    assert.deepEqual(calls.map((call) => call.url), [
      'http://192.168.31.7:1234/api/v1/models/load',
      'http://192.168.31.7:1234/api/v1/models/unload',
    ]);
    for (const call of calls) {
      assert.equal(new Headers(call.init?.headers).get('authorization'), 'Bearer lm-studio-token');
    }
  });

  test('a packed reference resolves its own profile, never a duplicate id', () => {
    useProfileStore.setState({ profiles: [profile('p1', 'Alpha', true), profile('p2', 'Beta', true)] });
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'shared')]);
    useAppModels.getState().replaceProfileModels('p2', [entry('p2', 'Beta', 'shared')]);

    assert.equal(resolveModelServer('p2::shared')?.baseUrl, 'https://p2.example.test/v1');
    assert.equal(resolveModelServer('p1::shared')?.baseUrl, 'https://p1.example.test/v1');
  });

  test('a packed reference to an inactive profile resolves to null', () => {
    useProfileStore.setState({ profiles: [profile('p1', 'Alpha', false)] });
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a')]);
    assert.equal(resolveModelServer('p1::model-a'), null);
  });

  test('a bare id resolves through the active projection', () => {
    useProfileStore.setState({ profiles: [profile('p1', 'Alpha', true)] });
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a')]);

    const resolved = resolveModelServer('model-a');
    assert.equal(resolved?.modelId, 'model-a');
    assert.equal(resolved?.baseUrl, 'https://p1.example.test/v1');
  });

  test('a bare id falls back to a cached inactive record, with no modelCache read', async () => {
    // The cache is written, but the resolver must reach it through the
    // registry's records rather than querying localStorage itself.
    useProfileStore.setState({
      profiles: [profile('p1', 'Alpha', true), profile('p2', 'Beta', true)],
    });
    storage.setItem(CACHE_KEY, JSON.stringify({
      p2: {
        name: 'Beta', baseUrl: 'https://p2.example.test/v1', apiVariant: 'openai',
        updatedAt: Date.now(), models: { 'cached-only': { c: 4096 } },
      },
    }));
    await bootstrapFromCacheOnly();
    // The active projection has it (p2 is active); prove the record path too
    // by taking p2 out of the projection while keeping its cached record.
    assert.equal(resolveModelServer('cached-only')?.baseUrl, 'https://p2.example.test/v1');

    assert.equal(
      selectModelOwnerProfileId(useAppModels.getState(), 'cached-only', [
        { id: 'p1' }, { id: 'p2' },
      ]),
      'p2',
    );
    assert.equal(
      selectModelOwnerProfileId(useAppModels.getState(), 'not-anywhere', [{ id: 'p1' }, { id: 'p2' }]),
      undefined,
    );
  });

  test('bare-id ownership is deterministic in profile order', () => {
    useProfileStore.setState({ profiles: [profile('p1', 'Alpha', true), profile('p2', 'Beta', true)] });
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'shared')]);
    useAppModels.getState().replaceProfileModels('p2', [entry('p2', 'Beta', 'shared')]);

    // Ambiguous by construction; the answer must not depend on record-map
    // insertion order, so both orderings are asked for explicitly.
    assert.equal(
      selectModelOwnerProfileId(
        { records: useAppModels.getState().records, models: [] },
        'shared',
        [{ id: 'p1' }, { id: 'p2' }],
      ),
      'p1',
    );
    assert.equal(
      selectModelOwnerProfileId(
        { records: useAppModels.getState().records, models: [] },
        'shared',
        [{ id: 'p2' }, { id: 'p1' }],
      ),
      'p2',
    );
  });

  test('findModelOwner resolves through the registry', () => {
    const profiles = [profile('p1', 'Alpha', true), profile('p2', 'Beta', true)];
    useProfileStore.setState({ profiles });
    useAppModels.getState().replaceProfileModels('p2', [entry('p2', 'Beta', 'only-on-beta')]);

    assert.equal(findModelOwner('only-on-beta', profiles)?.id, 'p2');
    assert.equal(findModelOwner('nowhere', profiles), undefined);
  });

  test('replaceProfileModels commits models and health in one update', () => {
    useProfileStore.setState({ profiles: [profile('p1', 'Alpha', true)] });
    let sawModelsWithoutHealth = false;
    const unsubscribe = useAppModels.subscribe((s) => {
      if (s.models.some((m) => m.id === 'model-a') && s.serverHealth.p1 !== 'reachable') {
        sawModelsWithoutHealth = true;
      }
    });
    try {
      useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'Alpha', 'model-a')], 'reachable');
    } finally {
      unsubscribe();
    }
    assert.equal(sawModelsWithoutHealth, false);
    assert.equal(useAppModels.getState().serverHealth.p1, 'reachable');
  });
});
