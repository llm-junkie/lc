/**
 * Credential-bootstrap diagnostics, through the real bootstrap paths.
 *
 * The reviewed build defined `credential-keychain-*` codes and tested them by
 * injecting events into the report builder; no shipped module recorded one, so
 * `authConfiguration.bootstrapOutcome` was always `unknown` in a real report.
 *
 * These tests run the shipped search, chat, and profile credential resolvers
 * against a stubbed Tauri IPC layer and read the diagnostic ring.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

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

/** Stubbed keychain, reached through the same Tauri IPC hook production uses. */
const keychain = new Map<string, string>();
let keychainAvailable = true;
let proxyAuthorization = '';
let keychainSetGate: Promise<void> | null = null;
let onKeychainSet: (() => void) | null = null;

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: Record<string, unknown>) => {
        if (!keychainAvailable && command.startsWith('keychain_')) {
          throw new Error('keychain unavailable');
        }
        const key = String(args.key ?? '');
        if (command === 'keychain_get') return keychain.get(key) ?? null;
        if (command === 'keychain_set') {
          onKeychainSet?.();
          if (keychainSetGate) await keychainSetGate;
          keychain.set(key, String(args.value ?? ''));
          return null;
        }
        if (command === 'keychain_delete') {
          keychain.delete(key);
          return null;
        }
        if (command === 'proxy_request') {
          const request = args.req as { headers?: Array<[string, string]> };
          proxyAuthorization = request.headers?.find(([name]) => name === 'authorization')?.[1] ?? '';
          return {
            status: 200,
            headers: [['content-type', 'application/json']],
            body: JSON.stringify({ data: [{ id: 'fallback-model' }] }),
          };
        }
        return null;
      },
    },
    isSecureContext: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

const [bootstrapModule, chatModule, cacheModule, settingsModule, diagnosticsModule, keychainModule, profileModule, conversationsModule] = await Promise.all([
  import('./search-key-bootstrap.ts'),
  import('./chat-credential.ts'),
  import('./search-key-cache.ts'),
  import('../store/settings.ts'),
  import('../utils/diagnostic-events.ts'),
  import('./keychain.ts'),
  import('../modules/server-profiles/index.ts'),
  import('../store/conversations.ts'),
]);

const { bootstrapSearchKey } = bootstrapModule;
const { deleteProfileCredentials, resolveChatCredential, resolveProfileCredential } = chatModule;
const { setSearchKey } = cacheModule;
const { useSettings } = settingsModule;
const { readDiagnosticEvents, resetDiagnosticEvents } = diagnosticsModule;
const { keychainSet, keychainDelete } = keychainModule;
const { profileManager, useProfileStore } = profileModule;
const { markGenerationBlockingOperation } = conversationsModule;

function credentialEvents() {
  return readDiagnosticEvents().filter((event) => event.subsystem === 'credential');
}

beforeEach(() => {
  resetDiagnosticEvents();
  keychain.clear();
  keychainAvailable = true;
  proxyAuthorization = '';
  keychainSetGate = null;
  onKeychainSet = null;
  useProfileStore.setState({ profiles: [] });
  setSearchKey('brave', null);
  setSearchKey('marginalia', null);
  useSettings.setState({
    tools: {
      ...useSettings.getState().tools,
      brave_search_api_key: '',
      brave_search_api_key_ref: undefined,
      marginalia_api_key: '',
      marginalia_api_key_ref: undefined,
    },
  });
});

describe('search-key bootstrap records its outcome at the real boundary', () => {
  it('records a successful keychain load, attributed to its surface', async () => {
    keychain.set('lc:brave', 'seeded-secret-brave-key');
    useSettings.setState({
      tools: { ...useSettings.getState().tools, brave_search_api_key_ref: 'lc:brave' },
    });

    assert.equal(await bootstrapSearchKey('brave'), 'loaded');

    const [event] = credentialEvents();
    assert.equal(event.code, 'credential-keychain-ok');
    assert.equal(event.credentialSurface, 'brave');
    assert.equal(event.outcome, 'ok');
  });

  it('records a missing keychain entry as configured-by-reference, bootstrap failed', async () => {
    useSettings.setState({
      tools: { ...useSettings.getState().tools, marginalia_api_key_ref: 'lc:marginalia' },
    });

    assert.equal(await bootstrapSearchKey('marginalia'), 'missing');

    const [event] = credentialEvents();
    assert.equal(event.code, 'credential-missing');
    assert.equal(event.credentialSurface, 'marginalia');
    assert.equal(event.credentialState, 'keychain-ref');
  });

  it('records an unusable keychain when re-encryption fails', async () => {
    useSettings.setState({
      tools: {
        ...useSettings.getState().tools,
        brave_search_api_key_ref: 'lc:brave',
        brave_search_api_key: 'stray-plaintext',
      },
    });
    keychainAvailable = false;

    assert.equal(await bootstrapSearchKey('brave'), 'migration-failed');

    const [event] = credentialEvents();
    assert.equal(event.code, 'credential-keychain-unavailable');
    assert.equal(event.credentialSurface, 'brave');
  });

  it('records nothing when no reference is configured', async () => {
    assert.equal(await bootstrapSearchKey('brave'), 'no-ref');
    // No keychain interaction happened, so inventing an outcome here would
    // report a bootstrap that never ran.
    assert.deepEqual(credentialEvents(), []);
  });
});

describe('chat credential resolution records its outcome at the real boundary', () => {
  it('records a successful load and returns the key', async () => {
    keychain.set('lc:chat', 'sk-proj-SEEDEDSECRETCHATKEY');

    const resolved = await resolveChatCredential({ apiKeyRef: 'lc:chat' });

    assert.equal(resolved, 'sk-proj-SEEDEDSECRETCHATKEY');
    const [event] = credentialEvents();
    assert.equal(event.code, 'credential-keychain-ok');
    assert.equal(event.credentialSurface, 'chat');
  });

  it('records a missing entry and falls back to the plaintext copy', async () => {
    const resolved = await resolveChatCredential({ apiKeyRef: 'lc:chat', apiKey: 'plaintext' });

    assert.equal(resolved, 'plaintext');
    const [event] = credentialEvents();
    assert.equal(event.code, 'credential-missing');
    assert.equal(event.credentialSurface, 'chat');
  });

  it('records an unavailable keychain without failing the request', async () => {
    keychainAvailable = false;

    const resolved = await resolveChatCredential({ apiKeyRef: 'lc:chat', apiKey: 'plaintext' });

    assert.equal(resolved, 'plaintext');
    assert.equal(credentialEvents()[0].code, 'credential-keychain-unavailable');
  });

  it('records nothing for a profile with no keychain reference', async () => {
    // Local servers legitimately need no key; a `credential-missing` here
    // would be a false alarm on every LM Studio launch.
    assert.equal(await resolveChatCredential({ apiKey: '' }), '');
    assert.deepEqual(credentialEvents(), []);
  });

  it('never records a value, a reference name, or an account id', async () => {
    keychain.set('lc:chat-ref-name', 'sk-proj-SEEDEDSECRETCHATKEY');
    await resolveChatCredential({ apiKeyRef: 'lc:chat-ref-name' });
    keychain.set('lc:brave-ref-name', 'BSA-SEEDEDSECRETBRAVEKEY0000');
    useSettings.setState({
      tools: { ...useSettings.getState().tools, brave_search_api_key_ref: 'lc:brave-ref-name' },
    });
    await bootstrapSearchKey('brave');

    const serialized = JSON.stringify(readDiagnosticEvents());
    for (const forbidden of ['SEEDEDSECRET', 'lc:chat-ref-name', 'lc:brave-ref-name', 'sk-proj', 'BSA-']) {
      assert.ok(!serialized.includes(forbidden), `credential diagnostics must not carry ${forbidden}`);
    }
  });
});

describe('profile credential lifecycle uses the same fallback authority', () => {
  it('records a missing encrypted entry on the bounded non-chat profile surface', async () => {
    const resolved = await resolveProfileCredential({
      apiKeyRef: 'lc:missing-profile',
      apiKey: 'plaintext-fallback',
    });

    assert.equal(resolved, 'plaintext-fallback');
    const [event] = credentialEvents();
    assert.equal(event.code, 'credential-missing');
    assert.equal(event.credentialSurface, 'profile');
  });

  it('records an unavailable encrypted store on the bounded non-chat profile surface', async () => {
    keychainAvailable = false;

    const resolved = await resolveProfileCredential({
      apiKeyRef: 'lc:unavailable-profile',
      apiKey: 'plaintext-fallback',
    });

    assert.equal(resolved, 'plaintext-fallback');
    const [event] = credentialEvents();
    assert.equal(event.code, 'credential-keychain-unavailable');
    assert.equal(event.credentialSurface, 'profile');
  });

  it('passes the plaintext fallback into connection requests when the key store is unavailable', async () => {
    keychainAvailable = false;
    await profileManager.testConnection({
      baseUrl: 'https://fallback.example.test/v1',
      apiKeyRef: 'lc:unavailable-profile',
      apiKey: 'plaintext-fallback',
      routing: 'direct',
    });
    assert.equal(proxyAuthorization, 'Bearer plaintext-fallback');
    assert.equal(credentialEvents()[0].credentialSurface, 'profile');
  });

  it('holds one generation lease until encrypted create and profile persistence finish', async () => {
    const plaintextCanary = 'new-profile-plaintext-canary';
    let releaseSet!: () => void;
    keychainSetGate = new Promise<void>((resolve) => { releaseSet = resolve; });
    let enteredSet!: () => void;
    const setStarted = new Promise<void>((resolve) => { enteredSet = resolve; });
    onKeychainSet = enteredSet;

    const before = localStorage.getItem('lc:profile-store');
    assert.ok(!before?.includes(plaintextCanary));

    const creation = profileManager.addProfileWithCredential({
      name: 'Secure create',
      baseUrl: 'https://create.example.test/v1',
      active: false,
    }, plaintextCanary);
    await setStarted;

    assert.deepEqual(useProfileStore.getState().profiles, []);
    assert.ok(!localStorage.getItem('lc:profile-store')?.includes(plaintextCanary));
    assert.throws(
      () => markGenerationBlockingOperation(
        'chat_generation_admission',
        'test generation',
        undefined,
        'conversation-during-create',
      ),
      /Add server profile credential/,
    );

    releaseSet();
    const { profile, stored } = await creation;
    const expectedRef = `profile.${profile.id}`;
    assert.equal(stored, true);
    assert.equal(profile.apiKey, '');
    assert.equal(profile.apiKeyRef, expectedRef);
    assert.equal(keychain.get(expectedRef), plaintextCanary);
    assert.ok(!localStorage.getItem('lc:profile-store')?.includes(plaintextCanary));
  });

  it('deletes a removed profile credential only after the manager admits removal', async () => {
    const profile = {
      id: 'profile-delete-key',
      name: 'Delete key',
      baseUrl: 'https://delete.example.test/v1',
      apiKeyRef: 'lc:profile-delete-key',
      active: false,
    };
    keychain.set(profile.apiKeyRef, 'secret');
    useProfileStore.setState({ profiles: [profile] });

    await profileManager.removeProfile(profile.id);

    assert.equal(keychain.has(profile.apiKeyRef), false);
    assert.equal(useProfileStore.getState().profiles.length, 0);
  });

  it('holds the generation boundary across an encrypted credential rotation', async () => {
    const profile = {
      id: 'profile-rotate-key',
      name: 'Rotate key',
      baseUrl: 'https://rotate.example.test/v1',
      apiKeyRef: 'profile.profile-rotate-key',
      active: false,
    };
    keychain.set(profile.apiKeyRef, 'old-secret');
    useProfileStore.setState({ profiles: [profile] });

    let releaseSet!: () => void;
    keychainSetGate = new Promise<void>((resolve) => { releaseSet = resolve; });
    let enteredSet!: () => void;
    const setStarted = new Promise<void>((resolve) => { enteredSet = resolve; });
    onKeychainSet = enteredSet;

    const rotation = profileManager.updateProfileCredential(profile.id, 'new-secret');
    await setStarted;
    assert.throws(
      () => markGenerationBlockingOperation(
        'chat_generation_admission',
        'test generation',
        undefined,
        'conversation-during-rotation',
        profile.id,
      ),
      /Update server profile/,
    );

    releaseSet();
    assert.equal(await rotation, true);
    const updated = useProfileStore.getState().profiles[0];
    assert.equal(updated.apiKeyRef, profile.apiKeyRef);
    assert.equal(updated.apiKey, '');
    assert.equal(keychain.get(profile.apiKeyRef), 'new-secret');
  });

  it('disconnects a stale encrypted reference when a rotation write fails', async () => {
    const profile = {
      id: 'profile-failed-rotation',
      name: 'Failed rotation',
      baseUrl: 'https://failed-rotation.example.test/v1',
      apiKeyRef: 'profile.profile-failed-rotation',
      active: false,
    };
    keychain.set(profile.apiKeyRef, 'old-secret');
    useProfileStore.setState({ profiles: [profile] });
    keychainAvailable = false;

    assert.equal(await profileManager.updateProfileCredential(profile.id, 'new-fallback'), false);
    const updated = useProfileStore.getState().profiles[0];
    assert.equal(updated.apiKeyRef, undefined);
    assert.equal(updated.apiKey, 'new-fallback');
    assert.equal(await resolveProfileCredential(updated), 'new-fallback');
  });

  it('deletes each distinct profile credential during bulk replacement', async () => {
    keychain.set('lc:bulk-a', 'secret-a');
    keychain.set('lc:bulk-b', 'secret-b');

    await deleteProfileCredentials([
      { apiKeyRef: 'lc:bulk-a' },
      { apiKeyRef: 'lc:bulk-a' },
      { apiKeyRef: 'lc:bulk-b' },
      {},
    ]);

    assert.equal(keychain.has('lc:bulk-a'), false);
    assert.equal(keychain.has('lc:bulk-b'), false);
  });
});

describe('key-store mutations record durable-write outcomes', () => {
  it('records successful set and delete mutations', async () => {
    resetDiagnosticEvents();
    await keychainSet('lc:write-test', 'secret');
    await keychainDelete('lc:write-test');

    assert.deepEqual(
      readDiagnosticEvents()
        .filter((event) => event.subsystem === 'storage')
        .map((event) => event.code),
      ['storage-write-ok'],
    );
  });

  it('records a failed key-store mutation and preserves rejection', async () => {
    keychainAvailable = false;
    resetDiagnosticEvents();

    await assert.rejects(() => keychainSet('lc:write-test', 'secret'), /unavailable/);
    assert.deepEqual(
      readDiagnosticEvents()
        .filter((event) => event.subsystem === 'storage')
        .map((event) => event.code),
      ['storage-write-failed'],
    );
  });
});
