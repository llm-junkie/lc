/**
 * The decrypted Brave Search API key must never reach localStorage.
 *
 * It is held in memory (platform/search-key-cache.ts) while the app runs and
 * encrypted on disk under the `brave-search-key` keychain ref. A plaintext
 * copy in the persisted settings blob would make the encryption pointless —
 * and would survive deleting the keychain file, which is how this was found.
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

const SECRET = 'BSACtestkeydonotuse0123456789ab';

// Stub the Tauri bridge before anything imports platform/keychain: the
// bootstrap path calls into it, and there is no Tauri host under `node --test`.
const keychain = new Map<string, string>();
let keychainWritable = true;
const tauriInternals = {
  invoke: async (cmd: string, args: { key: string; value?: string }) => {
    if (cmd === 'keychain_get') return keychain.get(args.key) ?? null;
    if (cmd === 'keychain_set') {
      if (!keychainWritable) throw new Error('keychain unavailable');
      keychain.set(args.key, args.value!);
      return null;
    }
    if (cmd === 'keychain_delete') { keychain.delete(args.key); return null; }
    return null;
  },
};
// `isTauri` is `'__TAURI_INTERNALS__' in window` — see utils/saveBlob.ts.
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { __TAURI_INTERNALS__: tauriInternals },
});

// Imported after the localStorage stub is installed — the persist middleware
// reads storage at module evaluation time.
const { useSettings } = await import('./settings.ts');
const { getBraveSearchKey, setBraveSearchKey } = await import('../platform/search-key-cache.ts');
const { bootstrapBraveSearchKey } = await import('../platform/search-key-bootstrap.ts');

/** The `tools` slice as actually written to localStorage. */
function persistedTools(): Record<string, unknown> {
  const raw = storage.getItem('lc:settings');
  assert.ok(raw, 'settings were not persisted');
  return JSON.parse(raw).state.tools;
}

beforeEach(() => {
  storage.clear();
  keychain.clear();
  keychainWritable = true;
  setBraveSearchKey(null);
  useSettings.setState({
    tools: {
      shell_allowlist: 'node',
      default_allowed_roots: [],
      web_fetch_rate_per_min: 50,
      brave_search_api_key: '',
      brave_search_api_key_ref: undefined,
      searxng_base_url: '',
      marginalia_api_key: '',
      marginalia_api_key_ref: undefined,
      web_search_provider: 'auto',
      vision_model: '',
      web_research_model: '',
      pdf_summarize_model: '',
    },
  });
});

describe('Brave Search key persistence', () => {
  test('a keychain-backed key is not written to localStorage', () => {
    const s = useSettings.getState();
    s.setTools({
      ...s.tools,
      brave_search_api_key: SECRET,
      brave_search_api_key_ref: 'brave-search-key',
    });

    assert.equal(persistedTools().brave_search_api_key, '');
    assert.equal(persistedTools().brave_search_api_key_ref, 'brave-search-key');
    assert.ok(
      !storage.getItem('lc:settings')!.includes(SECRET),
      'plaintext key found in the persisted settings blob',
    );
  });

  test('without a keychain ref the key is still persisted (web build fallback)', () => {
    // No keychain in the browser build, so localStorage is the only place
    // the key can live — stripping it there would lose it on reload.
    const s = useSettings.getState();
    s.setTools({
      ...s.tools,
      brave_search_api_key: SECRET,
      brave_search_api_key_ref: undefined,
    });

    assert.equal(persistedTools().brave_search_api_key, SECRET);
  });

  test('a plaintext key left by an older build is scrubbed on the next write', () => {
    // Simulate the leaked state: ref set *and* plaintext alongside it.
    const s = useSettings.getState();
    s.setTools({
      ...s.tools,
      brave_search_api_key: SECRET,
      brave_search_api_key_ref: 'brave-search-key',
    });

    // What App.tsx does at startup once it sees a ref plus a stray value.
    const leaked = useSettings.getState();
    assert.equal(leaked.tools.brave_search_api_key, SECRET, 'in-memory value expected before scrub');
    leaked.setTools({ ...leaked.tools, brave_search_api_key: '' });

    assert.equal(useSettings.getState().tools.brave_search_api_key, '');
    assert.ok(
      !storage.getItem('lc:settings')!.includes(SECRET),
      'plaintext key survived the scrub',
    );
  });

  test('startup loads the key from the keychain into memory, not the store', async () => {
    keychain.set('brave-search-key', SECRET);
    const s = useSettings.getState();
    s.setTools({ ...s.tools, brave_search_api_key_ref: 'brave-search-key' });

    assert.equal(await bootstrapBraveSearchKey(), 'loaded');
    assert.equal(getBraveSearchKey(), SECRET);
    assert.equal(useSettings.getState().tools.brave_search_api_key, '');
    assert.ok(!storage.getItem('lc:settings')!.includes(SECRET));
  });

  test('startup re-encrypts a stranded plaintext key instead of losing it', async () => {
    // The state this bug leaves behind: ref present, keychain file gone
    // (deleted by hand), plaintext copy in localStorage the only survivor.
    const s = useSettings.getState();
    s.setTools({
      ...s.tools,
      brave_search_api_key: SECRET,
      brave_search_api_key_ref: 'brave-search-key',
    });
    assert.equal(keychain.get('brave-search-key'), undefined);

    assert.equal(await bootstrapBraveSearchKey(), 'migrated');
    assert.equal(keychain.get('brave-search-key'), SECRET, 'key was not re-encrypted');
    assert.equal(getBraveSearchKey(), SECRET, 'key not available to web_search');
    assert.ok(!storage.getItem('lc:settings')!.includes(SECRET), 'plaintext still on disk');
  });

  test('a failed re-encryption keeps the key rather than discarding it', async () => {
    keychainWritable = false;
    const s = useSettings.getState();
    s.setTools({
      ...s.tools,
      brave_search_api_key: SECRET,
      brave_search_api_key_ref: 'brave-search-key',
    });

    assert.equal(await bootstrapBraveSearchKey(), 'migration-failed');
    assert.equal(getBraveSearchKey(), SECRET);
    // Ref dropped, so the plaintext-in-store fallback persists as before —
    // otherwise `partialize` would strip the only remaining copy.
    assert.equal(useSettings.getState().tools.brave_search_api_key_ref, undefined);
    assert.equal(persistedTools().brave_search_api_key, SECRET);
  });

  test('startup with no ref and no key does nothing', async () => {
    assert.equal(await bootstrapBraveSearchKey(), 'no-ref');
    assert.equal(getBraveSearchKey(), null);
  });

  test('the in-memory cache holds the key instead', () => {
    assert.equal(getBraveSearchKey(), null);
    setBraveSearchKey(SECRET);
    assert.equal(getBraveSearchKey(), SECRET);

    // Holding the key must not put it anywhere near persisted settings.
    assert.equal(persistedTools().brave_search_api_key, '');
    assert.ok(!storage.getItem('lc:settings')!.includes(SECRET));

    setBraveSearchKey(null);
    assert.equal(getBraveSearchKey(), null);
  });
});

describe('Marginalia key persistence', () => {
  // settings.ts `partialize` claims this file catches a keyed provider left
  // out of the scrubbing list. Before these tests it only covered Brave, so
  // dropping `marginalia` from `partialize` would have failed nothing and
  // written a decrypted key to disk.
  test('a keychain-backed key is not written to localStorage', () => {
    const s = useSettings.getState();
    s.setTools({
      ...s.tools,
      marginalia_api_key: SECRET,
      marginalia_api_key_ref: 'marginalia-search-key',
    });
    const tools = persistedTools();
    assert.equal(tools.marginalia_api_key, '', 'plaintext key reached localStorage');
    assert.equal(tools.marginalia_api_key_ref, 'marginalia-search-key');
    assert.ok(
      !JSON.stringify(persistedTools()).includes(SECRET),
      'the secret is recoverable from the persisted blob',
    );
  });

  test('without a keychain ref the key is still persisted (web build fallback)', () => {
    const s = useSettings.getState();
    s.setTools({ ...s.tools, marginalia_api_key: SECRET, marginalia_api_key_ref: undefined });
    assert.equal(
      persistedTools().marginalia_api_key,
      SECRET,
      'a key with nowhere else to live must not be silently discarded',
    );
  });

  test('scrubbing one provider does not scrub the other', () => {
    // The two keys are independent: a Brave key kept as a plaintext fallback
    // must survive while a keychain-backed Marginalia key is scrubbed.
    const s = useSettings.getState();
    s.setTools({
      ...s.tools,
      brave_search_api_key: 'brave-plaintext-fallback',
      brave_search_api_key_ref: undefined,
      marginalia_api_key: SECRET,
      marginalia_api_key_ref: 'marginalia-search-key',
    });
    const tools = persistedTools();
    assert.equal(tools.brave_search_api_key, 'brave-plaintext-fallback');
    assert.equal(tools.marginalia_api_key, '');
  });
});
