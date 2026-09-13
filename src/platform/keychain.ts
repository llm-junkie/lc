/**
 * Encrypted API key storage.
 * Wraps 3 Rust commands: keychain_get, keychain_set, keychain_delete.
 *
 * Keys are stored as AES-256-GCM encrypted files under the OS config directory
 * (for example, %APPDATA%/lc/keys/ on Windows). The store is local to LC and is
 * not an operating-system credential manager.
 *
 * On non-Tauri (web/browser dev), reads return null and deletes/warm-up
 * are no-ops; writes reject so callers keep their documented plaintext
 * fallback.
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../utils/saveBlob.ts';
import { runObservableDurableWrite } from '../store/storage-outcomes.ts';

/**
 * Pre-warm the keychain: triggers PBKDF2 derivation in a background
 * thread so the first real keychain_get/keychain_set doesn't block.
 * Call once at app startup. Best-effort — failures are silent.
 */
export async function keychainWarm(): Promise<void> {
  if (!isTauri) return;
  invoke('keychain_warm').catch(() => {});
}

/**
 * Read a password from the encrypted local key store.
 * Returns `null` if no entry exists or we're not in Tauri.
 */
export async function keychainGet(key: string): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>('keychain_get', { key });
}

/**
 * Write a password to the encrypted local key store.
 *
 * Rejects on non-Tauri (web/browser dev): there is no backend to write to,
 * and every caller decides between the keychain and its plaintext fallback
 * with `.then(() => true, () => false)`. Resolving as a silent no-op would
 * route every caller past that fallback and drop the entered key entirely.
 */
export async function keychainSet(key: string, value: string): Promise<void> {
  if (!isTauri) throw new Error('Web build has no keychain backend.');
  await runObservableDurableWrite(() => invoke('keychain_set', { key, value }));
}

/**
 * Delete a password from the encrypted local key store.
 * No-op on non-Tauri.
 */
export async function keychainDelete(key: string): Promise<void> {
  if (!isTauri) return;
  await runObservableDurableWrite(() => invoke('keychain_delete', { key }));
}
