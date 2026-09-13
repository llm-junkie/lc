/**
 * Startup resolution for search-provider API keys (Brave, Marginalia).
 *
 * Loads each key into the in-memory cache and makes sure no plaintext copy is
 * left in the persisted settings store. Extracted from App.tsx so the
 * migration path below is testable — getting it wrong loses a user's key.
 *
 * Three cases, given a `*_api_key_ref`:
 *
 *   1. Keychain has the key      → cache it, drop any plaintext copy.
 *   2. Keychain entry is missing → an older build left a plaintext copy in
 *      localStorage that is now the only copy (the encrypted file was
 *      deleted, or the original write failed). Re-encrypt it, then drop it.
 *   3. Re-encryption fails       → keep the plaintext and clear the ref, the
 *      same fallback Settings uses on a failed write. A key sitting in
 *      localStorage is bad; a silently discarded key is worse.
 *
 * (Formerly `brave-key-bootstrap.ts`, single-provider. The logic below is
 * unchanged — it is now parameterised by which key it is resolving so
 * Marginalia gets the identical migration path rather than a second copy of
 * it. See docs/search-providers.md.)
 */
import { keychainGet, keychainSet } from './keychain.ts';
import { setSearchKey, type KeyedSearchProvider } from './search-key-cache.ts';
import { useSettings } from '../store/settings.ts';
import { recordCredentialBootstrap } from './credential-diagnostics.ts';

/** Outcome of a bootstrap run. Returned for tests and debug logging. */
export type SearchKeyBootstrapResult =
  | 'no-ref'
  | 'loaded'
  | 'migrated'
  | 'migration-failed'
  | 'missing';

/** Back-compat alias — this type was named for Brave before other providers. */
export type BraveKeyBootstrapResult = SearchKeyBootstrapResult;

/** Which settings fields hold each provider's key and keychain ref. */
const FIELDS = {
  brave: { key: 'brave_search_api_key', ref: 'brave_search_api_key_ref' },
  marginalia: { key: 'marginalia_api_key', ref: 'marginalia_api_key_ref' },
} as const satisfies Record<KeyedSearchProvider, { key: string; ref: string }>;

/** Remove any plaintext copy of the key from the persisted settings store. */
function dropPlaintextCopy(provider: KeyedSearchProvider): void {
  const cur = useSettings.getState();
  const field = FIELDS[provider].key;
  if ((cur.tools as Record<string, unknown>)[field]) {
    cur.setTools({ ...cur.tools, [field]: '' });
  }
}

export async function bootstrapSearchKey(
  provider: KeyedSearchProvider,
): Promise<SearchKeyBootstrapResult> {
  const fields = FIELDS[provider];
  const tools = useSettings.getState().tools as Record<string, unknown>;
  const ref = tools[fields.ref] as string | undefined;
  // No reference means no bootstrap ran. That is configuration state, which
  // the report already carries; recording an outcome here would invent one.
  if (!ref) return 'no-ref';

  const stored = await keychainGet(ref).catch(() => null);
  if (stored) {
    setSearchKey(provider, stored);
    dropPlaintextCopy(provider);
    recordCredentialBootstrap(provider, 'loaded');
    return 'loaded';
  }

  const stray = (useSettings.getState().tools as Record<string, unknown>)[fields.key] as
    | string
    | undefined;
  if (!stray) {
    // Configured by reference, but the keychain entry is gone. The provider is
    // configured and its bootstrap failed — never a usable resolved key.
    recordCredentialBootstrap(provider, 'missing');
    return 'missing';
  }

  const ok = await keychainSet(ref, stray).then(() => true, () => false);
  setSearchKey(provider, stray);
  if (ok) {
    dropPlaintextCopy(provider);
    recordCredentialBootstrap(provider, 'loaded');
    return 'migrated';
  }

  const cur = useSettings.getState();
  cur.setTools({ ...cur.tools, [fields.ref]: undefined });
  recordCredentialBootstrap(provider, 'unavailable');
  return 'migration-failed';
}

/** Resolve the Brave Search key at startup. */
export function bootstrapBraveSearchKey(): Promise<SearchKeyBootstrapResult> {
  return bootstrapSearchKey('brave');
}

/** Resolve the Marginalia key at startup. */
export function bootstrapMarginaliaKey(): Promise<SearchKeyBootstrapResult> {
  return bootstrapSearchKey('marginalia');
}
