/**
 * Verify that every KaTeX delimiter font remains a packaged WOFF2 asset.
 *
 * Tauri's production CSP allows fonts from `self`, but not `data:` URLs.
 * Vite normally inlines assets below 4 KiB. KaTeX_Size3 falls below that
 * threshold, and a blocked inline copy makes matrix brackets use short
 * fallback glyphs. Run this after `vite build`.
 *
 * Usage: npm run check:katex-fonts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'dist', 'assets');
const files = readdirSync(ASSETS);
const css = files
  .filter((name) => name.endsWith('.css'))
  .map((name) => readFileSync(join(ASSETS, name), 'utf8'))
  .join('\n');
const failures = [];

for (const size of [1, 2, 3, 4]) {
  const family = `KaTeX_Size${size}`;
  const assetPrefix = `${family}-Regular-`;
  const asset = files.find((name) => (
    name.startsWith(assetPrefix) && name.endsWith('.woff2')
  ));
  const fontFace = css.match(
    new RegExp(`@font-face\\{[^{}]*font-family:${family}[^{}]*\\}`),
  )?.[0];

  if (!asset) {
    failures.push(`${family}: no emitted WOFF2 asset`);
  }
  if (!fontFace) {
    failures.push(`${family}: no production @font-face rule`);
    continue;
  }
  if (/url\(["']?data:/i.test(fontFace)) {
    failures.push(`${family}: production CSS contains an inline data URL`);
  }
  if (asset && !fontFace.includes(asset)) {
    failures.push(`${family}: production CSS does not reference ${asset}`);
  }
}

if (failures.length > 0) {
  console.error('KaTeX production font audit failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('KaTeX production fonts: OK — Size1 through Size4 are packaged WOFF2 assets.');
