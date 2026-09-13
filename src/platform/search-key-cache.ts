/**
 * In-memory holder for decrypted search-provider API keys.
 *
 * Referenced desktop entries live encrypted on disk (see platform/keychain.ts).
 * This module keeps a session cache of decrypted values. Send-time capture
 * also retains the resolved search key in GenerationRuntimeSecrets beside
 * the frozen snapshot. These runtime holders are not persisted or exported.
 *
 * Request assembly reads the resolved key synchronously. The generation
 * uses its captured value; the session cache supports provider resolution.
 *
 * Why not the settings store: that store is persisted to localStorage, so
 * anything parked in it is written to disk in plaintext — which is exactly
 * what the keychain exists to prevent. `useSettings.tools.*_api_key` stays the
 * plaintext fallback for the web build and for the case where a keychain write
 * fails; when a matching `*_api_key_ref` exists, the decrypted value belongs
 * here instead.
 *
 * Not persisted, not exported, cleared when the process ends.
 *
 * (Formerly `brave-key-cache.ts` — widened to cover Marginalia when search
 * gained multiple providers. See docs/search-providers.md.)
 */

/** Providers whose keys are held here. SearXNG is absent deliberately. Its
 *  supported setting passes the shared URL credential rule at resolution. */
export type KeyedSearchProvider = 'brave' | 'marginalia';

const keys: Record<KeyedSearchProvider, string | null> = {
  brave: null,
  marginalia: null,
};

/** Park a decrypted key for this process. Pass `null`/`''` to forget it. */
export function setSearchKey(provider: KeyedSearchProvider, value: string | null): void {
  keys[provider] = value ? value : null;
}

/** The decrypted key, or `null` when none has been loaded this session. */
export function getSearchKey(provider: KeyedSearchProvider): string | null {
  return keys[provider];
}

/** Park a decrypted Brave key for this process. Pass `null`/`''` to forget it. */
export function setBraveSearchKey(value: string | null): void {
  setSearchKey('brave', value);
}

/** The decrypted Brave key, or `null` when none has been loaded this session. */
export function getBraveSearchKey(): string | null {
  return getSearchKey('brave');
}

/** Park a decrypted Marginalia key for this process. */
export function setMarginaliaKey(value: string | null): void {
  setSearchKey('marginalia', value);
}

/** The decrypted Marginalia key, or `null` when none has been loaded. */
export function getMarginaliaKey(): string | null {
  return getSearchKey('marginalia');
}
