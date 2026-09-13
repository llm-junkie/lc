import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  migrateSolidTheme,
  resolveMaterial,
} from './material-resolver.ts';

const themeProviderSource = readFileSync(
  new URL('../ui/shared/ThemeProvider.tsx', import.meta.url),
  'utf8',
);

describe('resolveMaterial', () => {
  it('solid wins on every platform without consulting native material', () => {
    for (const platform of ['windows', 'macos', 'linux', 'web'] as const) {
      const r = resolveMaterial({ platform, request: 'solid', native: { backend: 'mica', active: true } });
      assert.equal(r.active, 'matte');
      assert.equal(r.nativeActive, false);
      assert.equal(r.solidSurfaces, true);
      assert.equal(r.fallbackReason, 'user-solid');
    }
  });

  it('web keeps CSS glass and never uses Tauri state', () => {
    for (const request of ['auto', 'glass'] as const) {
      const r = resolveMaterial({ platform: 'web', request, native: null });
      assert.equal(r.active, 'css-glass');
      assert.equal(r.nativeActive, false);
      assert.equal(r.solidSurfaces, false);
    }
  });

  it('confirmed native activation wins on Windows and macOS', () => {
    for (const backend of ['mica', 'acrylic', 'vibrancy'] as const) {
      const r = resolveMaterial({
        platform: backend === 'vibrancy' ? 'macos' : 'windows',
        request: 'auto',
        native: { backend, active: true },
      });
      assert.equal(r.active, backend);
      assert.equal(r.nativeActive, true);
      assert.equal(r.solidSurfaces, false);
      assert.equal(r.fallbackReason, null);
    }
  });

  it('failed native activation resolves to matte with the backend reason', () => {
    const r = resolveMaterial({
      platform: 'windows',
      request: 'auto',
      native: { backend: 'matte', active: false, reason: 'mica activation failed: denied' },
    });
    assert.equal(r.active, 'matte');
    assert.equal(r.solidSurfaces, true);
    assert.equal(r.fallbackReason, 'mica activation failed: denied');
  });

  it('missing activation on windows/macos auto resolves to matte', () => {
    const r = resolveMaterial({ platform: 'windows', request: 'auto', native: null });
    assert.equal(r.active, 'matte');
    assert.equal(r.solidSurfaces, true);
    assert.equal(r.fallbackReason, 'native-unavailable');
  });

  it('linux auto is deliberate matte', () => {
    const r = resolveMaterial({ platform: 'linux', request: 'auto' });
    assert.equal(r.active, 'matte');
    assert.equal(r.solidSurfaces, true);
    assert.equal(r.fallbackReason, 'linux-auto-matte');
  });

  it('linux forced glass stays css-glass (readable over the opaque window)', () => {
    const r = resolveMaterial({ platform: 'linux', request: 'glass' });
    assert.equal(r.active, 'css-glass');
    assert.equal(r.nativeActive, false);
    assert.equal(r.solidSurfaces, false);
    assert.equal(r.fallbackReason, null);
  });

  it('an unknown native backend string never becomes the active material', () => {
    const r = resolveMaterial({
      platform: 'macos',
      request: 'glass',
      native: { backend: 'liquid-glass', active: true },
    });
    assert.equal(r.active, 'matte');
    assert.equal(r.nativeActive, false);
    assert.equal(r.fallbackReason, 'native-unavailable');
  });
});

describe('migrateSolidTheme', () => {
  it('maps the legacy values without changing the effective preference', () => {
    assert.equal(migrateSolidTheme('auto'), 'auto');
    assert.equal(migrateSolidTheme('off'), 'glass');
    assert.equal(migrateSolidTheme('on'), 'solid');
  });

  it('rejects anything else', () => {
    assert.equal(migrateSolidTheme(undefined), null);
    assert.equal(migrateSolidTheme('glass'), null);
    assert.equal(migrateSolidTheme(42), null);
  });
});

describe('native window theme', () => {
  it('uses Tauri window.setTheme so Linux receives the resolved theme value', () => {
    assert.match(themeProviderSource, /getCurrentWindow\(\)\.setTheme\(base\)/);
    assert.doesNotMatch(themeProviderSource, /plugin:window\|set_theme/);
  });
});
