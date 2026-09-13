/**
 * Custom-theme token resolution — focused on the native-material floor
 * (`--native-floor`), the `.app` background under a confirmed native
 * material (Mica/Acrylic/vibrancy).
 *
 * Regression: the floor used to be gated on `[data-theme='dark']` in
 * index.css, which never matches a custom theme (`data-theme="custom"`),
 * so every dark-base custom theme rendered the LIGHT floor under Mica —
 * a bright chat background. The fix has two halves, both asserted here:
 *   1. index.css gates its built-in floor constants on `[data-base]`
 *      (covered by the CSS parsing in this file's guard assertions).
 *   2. The resolver derives a per-theme floor from the theme's own
 *      `--bg` at 90% alpha, so the tint follows the theme's palette.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// resolver.ts imports the settings store; zustand persist touches
// localStorage during store creation. Seed a memory storage before the
// import executes (static imports would hoist above the assignment, so
// the module is imported dynamically after the global exists — same
// pattern as settings-material-migration.test.ts).
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

const { resolveThemeTokens } = await import('./resolver.ts');
import type { ThemeFile } from './types';

const themesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'theme');

function loadShippedTheme(file: string): ThemeFile {
  return JSON.parse(readFileSync(join(themesDir, file), 'utf8')) as ThemeFile;
}

describe('resolveThemeTokens — native floor', () => {
  it('derives the floor from --bg for every shipped dark-base theme', () => {
    for (const file of readdirSync(themesDir).filter((f) => f.endsWith('.spine.theme.json'))) {
      const theme = loadShippedTheme(file);
      if (theme.base !== 'dark') continue;
      const resolved = resolveThemeTokens(theme);
      if (!resolved) throw new Error(`${file}: theme must resolve`);
      const bg = theme.spine?.['--bg'];
      if (!bg) throw new Error(`${file}: spine must carry --bg`);
      const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(bg);
      if (!m) throw new Error(`${file}: --bg must be 6-digit hex for floor derivation`);
      const red = m[1];
      const green = m[2];
      const blue = m[3];
      if (!red || !green || !blue) {
        throw new Error(`${file}: --bg must contain complete RGB channels`);
      }
      const expected = `rgba(${parseInt(red, 16)}, ${parseInt(green, 16)}, ${parseInt(blue, 16)}, 0.9)`;
      assert.equal(
        resolved.glass['--native-floor'],
        expected,
        `${file}: dark-base theme must carry a floor derived from its own --bg, not a bright one`,
      );
    }
  });

  it('derives the floor for the shipped light-base theme too', () => {
    const resolved = resolveThemeTokens(loadShippedTheme('vs_light.spine.theme.json'));
    if (!resolved) throw new Error('vs_light.spine.theme.json must resolve');
    // vs_light --bg is #e4e4e8 — same value the built-in light floor
    // constant in index.css is tuned from.
    assert.equal(resolved.glass['--native-floor'], 'rgba(228, 228, 232, 0.9)');
  });

  it('full mode with a hex --bg also derives the floor', () => {
    const resolved = resolveThemeTokens({
      name: 't',
      version: 1,
      mode: 'full',
      base: 'dark',
      glass: { '--bg': '#0f0905' },
      solid: {},
    });
    if (!resolved) throw new Error('full dark theme must resolve');
    assert.equal(resolved.glass['--native-floor'], 'rgba(15, 9, 5, 0.9)');
  });

  it('a non-hex --bg emits no floor so the [data-base] constant stays in force', () => {
    const resolved = resolveThemeTokens({
      name: 't',
      version: 1,
      mode: 'full',
      base: 'dark',
      glass: { '--bg': 'var(--x)' },
      solid: {},
    });
    if (!resolved) throw new Error('full theme with non-hex background must resolve');
    assert.equal('--native-floor' in resolved.glass, false);
  });

  it('an unresolvable theme returns null untouched', () => {
    assert.equal(resolveThemeTokens({ name: 't', version: 1, mode: 'spine' } as ThemeFile), null);
  });
});

describe('index.css — floor gating', () => {
  // Strip comments so the comment text explaining the bug cannot match.
  const css = readFileSync(join(themesDir, '..', 'src', 'index.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  it('gates the built-in floor constants on data-base, not data-theme', () => {
    // The whole bug: `[data-theme='dark']` never matches a custom
    // theme. Both built-in floor constants must select on data-base.
    assert.match(
      css,
      /:root\[data-base='light'\]\s*\{\s*--native-floor:/,
      "light floor must be gated on [data-base='light']",
    );
    assert.match(
      css,
      /:root\[data-base='dark'\]\s*\{\s*--native-floor:/,
      "dark floor must be gated on [data-base='dark']",
    );
  });

  it('never gates --native-floor on data-theme', () => {
    // Catches the old form creeping back — a floor under
    // `[data-theme='dark'|'light']` is dead for custom themes.
    const gated = css.match(/\[data-theme='(?:dark|light)'\][^{]*\{[^}]*--native-floor/g);
    assert.equal(gated, null, `--native-floor must not be gated on data-theme (found ${gated?.length})`);
  });
});
