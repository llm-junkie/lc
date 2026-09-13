/**
 * Copies Excalidraw production fonts from the npm package into the public
 * directory so they are self-hosted (no CDN dependency).
 *
 * The fonts are NOT committed to git — they are materialised at build time
 * from `node_modules/@excalidraw/excalidraw/dist/prod/fonts/`.
 *
 * Run with: node scripts/copy-excalidraw-assets.mjs
 * Called automatically by `npm run build`.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const SRC = resolve(ROOT, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts');
const DEST = resolve(ROOT, 'public', 'excalidraw-assets', 'fonts');

if (!existsSync(SRC)) {
  console.error('✗ Excalidraw fonts not found at:', SRC);
  console.error('  Make sure @excalidraw/excalidraw is installed (npm install).');
  process.exit(1);
}

// Clean and recreate destination
rmSync(resolve(ROOT, 'public', 'excalidraw-assets'), { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

// Copy fonts
cpSync(SRC, DEST, { recursive: true });

console.log('✓ Excalidraw fonts copied to public/excalidraw-assets/');
