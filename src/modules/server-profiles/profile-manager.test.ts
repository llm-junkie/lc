import assert from 'node:assert/strict';
import test from 'node:test';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

test('active generation rejects every server-profile mutation at the manager boundary', async () => {
  const [{ markStreaming, unmarkStreaming }, profilesModule] = await Promise.all([
    import('../../store/conversations.ts'),
    import('./index.ts'),
  ]);
  const {
    PROFILE_MUTATION_STREAMING_MESSAGE,
    profileManager,
    useProfileStore,
  } = profilesModule;

  const original = {
    id: 'profile-a',
    name: 'Profile A',
    baseUrl: 'http://127.0.0.1:1234/v1',
    active: true,
  };
  useProfileStore.setState({ profiles: [original] });
  const owner = markStreaming('conversation-a', 'assistant-a', 'generation-a');

  try {
    await assert.rejects(
      profileManager.updateProfile(original.id, { active: false }),
      new RegExp(PROFILE_MUTATION_STREAMING_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    await assert.rejects(
      profileManager.removeProfile(original.id),
      new RegExp(PROFILE_MUTATION_STREAMING_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    await assert.rejects(
      profileManager.addProfile({
        name: 'Profile B',
        baseUrl: 'http://127.0.0.1:5678/v1',
      }),
      new RegExp(PROFILE_MUTATION_STREAMING_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );

    assert.deepEqual(useProfileStore.getState().profiles, [original]);
  } finally {
    unmarkStreaming(owner.conversationId, owner.generationId);
    useProfileStore.setState({ profiles: [] });
  }
});

test('removing a profile releases its in-memory health entry', async () => {
  const profilesModule = await import('./index.ts');
  const { profileManager, useProfileStore } = profilesModule;

  const profile = {
    id: 'profile-health-1',
    name: 'Health Profile',
    // Closed port: the connection attempt fails fast with ECONNREFUSED, so
    // refreshAllHealth records 'offline' without any network mocking.
    baseUrl: 'http://127.0.0.1:1/v1',
    active: true,
  };
  useProfileStore.setState({ profiles: [profile] });

  await profileManager.refreshAllHealth();
  assert.equal(profileManager.getHealth(profile.id), 'offline');

  await profileManager.removeProfile(profile.id);
  assert.equal(profileManager.getHealth(profile.id), 'unknown');

  useProfileStore.setState({ profiles: [] });
});

test('profile request-header validation is generic and rejects unsafe wire values', async () => {
  const { profileManager } = await import('./index.ts');

  assert.deepEqual(profileManager.validateDraft({
    name: 'Header profile',
    baseUrl: 'https://example.test/v1',
    includeLcIdentifierHeader: true,
    lcIdentifierHeader: { name: 'User-Agent', value: 'Header profile/1.0' },
    includeAdditionalRequestHeaders: true,
    requestHeaders: [{ name: 'X-Route', value: 'alpha' }],
  }), { ok: true });

  const invalid = profileManager.validateDraft({
    name: 'Header profile',
    baseUrl: 'https://example.test/v1',
    includeLcIdentifierHeader: true,
    includeAdditionalRequestHeaders: true,
    requestHeaders: [
      { name: 'X-Route', value: 'alpha' },
      { name: 'x-route', value: 'beta' },
      { name: 'Bad Header', value: 'line\r\nbreak' },
    ],
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.ok(invalid.errors.some((error) => error.includes('duplicated')));
    assert.ok(invalid.errors.some((error) => error.includes('invalid name')));
    assert.ok(invalid.errors.some((error) => error.includes('line break')));
  }

  const invalidIdentifier = profileManager.validateDraft({
    name: 'Header profile',
    baseUrl: 'https://example.test/v1',
    includeLcIdentifierHeader: true,
    lcIdentifierHeader: { name: 'Bad Header', value: 'LC\r\nInjected' },
  });
  assert.equal(invalidIdentifier.ok, false);
  if (!invalidIdentifier.ok) {
    assert.ok(invalidIdentifier.errors.some((error) => error.includes('identifier header has an invalid name')));
    assert.ok(invalidIdentifier.errors.some((error) => error.includes('identifier header value')));
  }
});

test('profile validation rejects recognized URL credentials', async () => {
  const { profileManager } = await import('./index.ts');

  for (const draft of [
    {
      name: 'Credentialed base URL',
      baseUrl: 'https://user:secret@example.test/v1',
    },
    {
      name: 'Credentialed model URL',
      baseUrl: 'https://example.test/v1',
      modelFetchUrl: 'https://user:secret@models.example.test/models',
    },
    {
      name: 'Credential query in base URL',
      baseUrl: 'https://example.test/v1?api_key=secret',
    },
    {
      name: 'Credential query in model URL',
      baseUrl: 'https://example.test/v1',
      modelFetchUrl: 'https://models.example.test/models?access_token=secret',
    },
    {
      name: 'Credential fragment in base URL',
      baseUrl: 'https://example.test/v1#access_token=secret',
    },
    {
      name: 'Credential fragment in relative model URL',
      baseUrl: 'https://example.test/v1',
      modelFetchUrl: 'models#token=secret',
    },
  ]) {
    const result = profileManager.validateDraft(draft);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.includes('must not contain URL credentials')));
    }
  }
});
