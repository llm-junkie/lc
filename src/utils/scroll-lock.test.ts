/**
 * Body scroll lock — the property the six independent copies did not have.
 *
 * The overlay contract records scroll-lock ownership as a risk, not a defect:
 * six overlays each saved and restored `document.body.style.overflow` on their
 * own, which is correct only while they unmount in strict LIFO order. Every
 * reachable nesting in LC happens to resolve LIFO, so the failure was never
 * reproduced — it was upheld by call-site ordering rather than by the
 * mechanism, and one new overlay would have broken it silently.
 *
 * That is why this file exists at all. The out-of-order case is the one thing
 * about this module that cannot be checked by hand in the running app: you
 * would have to construct a nesting LC cannot currently produce. Three asserts
 * cover it directly.
 *
 * Run with:
 *   npx tsx --test src/utils/scroll-lock.test.ts
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub the one DOM surface the module touches, before importing it.
const style = { overflow: '' };
(globalThis as unknown as { document: unknown }).document = { body: { style } };

const { lockBodyScroll, scrollLockDepth } = await import('./scroll-lock.ts');

describe('scroll lock', () => {
  beforeEach(() => {
    assert.equal(scrollLockDepth(), 0, 'a previous test leaked a lock');
    style.overflow = '';
  });

  it('locks on the first take and restores on the last release', () => {
    const release = lockBodyScroll();
    assert.equal(style.overflow, 'hidden');
    release();
    assert.equal(style.overflow, '');
  });

  it('restores the page\'s own overflow, not the empty string', () => {
    // The page may already be scroll-locked by something outside this module.
    style.overflow = 'clip';
    const release = lockBodyScroll();
    assert.equal(style.overflow, 'hidden');
    release();
    assert.equal(style.overflow, 'clip');
  });

  it('stays locked while any owner still holds it', () => {
    const outer = lockBodyScroll();
    const inner = lockBodyScroll();
    outer();
    // The failure this test protects against: the outer overlay unmounting
    // first must not unlock the page behind an inner overlay still open.
    assert.equal(style.overflow, 'hidden', 'unlocked while an owner remained');
    inner();
    assert.equal(style.overflow, '');
  });

  it('releases correctly regardless of order', () => {
    const a = lockBodyScroll();
    const b = lockBodyScroll();
    const c = lockBodyScroll();
    // Deliberately not LIFO — this is the arrangement the old scheme could not
    // survive, and the reason the fix is a counter rather than a save/restore.
    b();
    a();
    assert.equal(style.overflow, 'hidden');
    c();
    assert.equal(style.overflow, '');
  });

  it('is idempotent per release, so StrictMode double-invoke is safe', () => {
    const outer = lockBodyScroll();
    const inner = lockBodyScroll();
    inner();
    inner(); // React 18 dev double-invoke would land here
    assert.equal(scrollLockDepth(), 1, 'a repeated release decremented twice');
    assert.equal(style.overflow, 'hidden');
    outer();
    assert.equal(style.overflow, '');
  });
});
