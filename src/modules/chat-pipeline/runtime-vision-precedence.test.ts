/**
 * Runtime vision precedence: what the generation pipeline decides about
 * image injection, given server detail, registry metadata, and the user's
 * override — for one exact profile + model.
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

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

const { resolveRuntimeVision } = await import('./orchestrator.ts');
const { useAppModels } = await import('../server-profiles/model-store.ts');
const { useProfileStore } = await import('../server-profiles/profile-store.ts');
const { resolveImageDelivery } = await import('./message-history.ts');
type AppModelEntry = import('../server-profiles/model-store.ts').AppModelEntry;
type ServerProfile = import('../../types.ts').ServerProfile;

function profile(id: string, name: string): ServerProfile {
  return {
    id,
    name,
    baseUrl: `https://${id}.example.test/v1`,
    apiKey: '',
    apiVariant: 'openai',
    apiStyle: 'chat',
    routing: 'proxy',
    active: true,
    sse_read_timeout_min: 5,
  };
}

function entry(profileId: string, id: string, vision: boolean): AppModelEntry {
  return {
    id,
    displayName: id,
    profileId,
    profileName: profileId,
    apiVariant: 'openai',
    apiStyle: 'chat',
    maxContextLength: 8192,
    capabilities: { vision, reasoning: false, tools: true },
  };
}

beforeEach(() => {
  useAppModels.setState({ records: {}, overrides: {}, models: [] });
  useProfileStore.setState({ profiles: [profile('p1', 'Alpha'), profile('p2', 'Beta')] });
});

describe('resolveRuntimeVision', () => {
  test('an explicit false beats a server detail that reports vision', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'model-a', true)]);
    useAppModels.getState().setMetadataOverride('p1', 'model-a', { v: false });

    assert.equal(resolveRuntimeVision(useAppModels.getState(), 'p1', 'model-a', true), false);
  });

  test('an explicit true wins when nothing detected vision', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'model-a', false)]);
    useAppModels.getState().setMetadataOverride('p1', 'model-a', { v: true });

    assert.equal(resolveRuntimeVision(useAppModels.getState(), 'p1', 'model-a', undefined), true);
  });

  test('with no override, server detail decides', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'model-a', false)]);

    assert.equal(resolveRuntimeVision(useAppModels.getState(), 'p1', 'model-a', true), true);
    assert.equal(resolveRuntimeVision(useAppModels.getState(), 'p1', 'model-a', false), false);
  });

  test('with no override and no server detail, registry detected metadata decides', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'model-a', true)]);

    assert.equal(resolveRuntimeVision(useAppModels.getState(), 'p1', 'model-a', undefined), true);
  });

  test('an override on another profile does not reach this one', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'shared', false)]);
    useAppModels.getState().replaceProfileModels('p2', [entry('p2', 'shared', false)]);
    useAppModels.getState().setMetadataOverride('p2', 'shared', { v: true });

    assert.equal(resolveRuntimeVision(useAppModels.getState(), 'p1', 'shared', undefined), false);
    assert.equal(resolveRuntimeVision(useAppModels.getState(), 'p2', 'shared', undefined), true);
  });

  test('a vision-capable duplicate on another profile cannot grant vision here', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'shared', false)]);
    useAppModels.getState().replaceProfileModels('p2', [entry('p2', 'shared', true)]);

    assert.equal(resolveRuntimeVision(useAppModels.getState(), 'p1', 'shared', undefined), false);
  });

  test('an unknown model with no override and no detail is not vision', () => {
    assert.equal(resolveRuntimeVision(useAppModels.getState(), 'p1', 'nowhere', undefined), false);
  });

  test('a missing profile id falls back to server detail alone', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'model-a', true)]);
    assert.equal(resolveRuntimeVision(useAppModels.getState(), undefined, 'model-a', undefined), false);
    assert.equal(resolveRuntimeVision(useAppModels.getState(), undefined, 'model-a', true), true);
  });
});

describe('the resolved capability drives image injection', () => {
  test('an explicit vision=No blocks raw image delivery even with server detail true', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'model-a', true)]);
    useAppModels.getState().setMetadataOverride('p1', 'model-a', { v: false });

    const modelIsVision = resolveRuntimeVision(useAppModels.getState(), 'p1', 'model-a', true);
    assert.equal(
      resolveImageDelivery({ batchId: 'b1', imageCount: 1, modelIsVision, alreadyInjected: undefined }),
      'blocked-no-vision',
    );
  });

  test('clearing the override lets images through again', () => {
    useAppModels.getState().replaceProfileModels('p1', [entry('p1', 'model-a', true)]);
    useAppModels.getState().setMetadataOverride('p1', 'model-a', { v: false });
    useAppModels.getState().removeMetadataOverride('p1', 'model-a');

    const modelIsVision = resolveRuntimeVision(useAppModels.getState(), 'p1', 'model-a', true);
    assert.equal(
      resolveImageDelivery({ batchId: 'b1', imageCount: 1, modelIsVision, alreadyInjected: undefined }),
      'inject',
    );
  });
});
