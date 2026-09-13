/**
 * Web-build keychain semantics. The browser build has no keychain backend, so
 * reads are misses and writes must REJECT: every caller decides between the
 * keychain and the plaintext fallback with `.then(() => true, () => false)`,
 * and a write that resolves as a no-op makes the fallback branch unreachable
 * — the entered key is then dropped entirely instead of being kept in
 * localStorage (the documented web fallback, see settings-brave-key.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Deliberately NO `window` stub: `isTauri` is false, exactly like the
// browser build without the Tauri bridge.
const { keychainGet, keychainSet, keychainDelete, keychainWarm } = await import('./keychain.ts');

test('web build: reads are misses and delete/warm are silent no-ops', async () => {
  assert.equal(await keychainGet('anything'), null);
  await keychainDelete('anything');
  await keychainWarm();
});

test('web build: writes reject so callers keep the plaintext fallback', async () => {
  await assert.rejects(
    () => keychainSet('brave-search-key', 'SECRET'),
    /Web build/,
  );
});
