/**
 * Copies build artefacts into `src-tauri/resources/` so Tauri can bundle them.
 *
 * Tauri's `bundle.resources` in tauri.conf.json points to files under
 * `resources/`.  Those files must exist before `tauri build` OR `tauri dev`
 * runs (the Tauri build script validates the resource list in both modes).
 *
 * Run with:
 *   node scripts/copy-tauri-resources.mjs           # after `vite build`
 *   node scripts/copy-tauri-resources.mjs --dev     # from npm run tauri:dev
 *
 * Called automatically by `npm run build` (after vite build) and by
 * `npm run tauri:dev`. In dev mode there is no `dist/`, so spine-builder.html
 * is taken from `theme/` — vite's spineBuilderPlugin emits that exact file to
 * dist/ unchanged (see vite.config.ts), so both modes produce the same bytes.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV_MODE = process.argv.includes('--dev');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const RESOURCES = resolve(ROOT, 'src-tauri', 'resources');

// ---- spine-builder.html ----
// Vite emits this to dist/spine-builder.html (see vite.config.ts spineBuilderPlugin);
// in dev mode (no vite build) the source theme file is used instead.
const SRC_SPINE = DEV_MODE
  ? resolve(ROOT, 'theme', 'spine-builder.html')
  : resolve(ROOT, 'dist', 'spine-builder.html');
const DEST_SPINE = resolve(RESOURCES, 'spine-builder.html');

if (!existsSync(SRC_SPINE)) {
  console.error('✗ spine-builder.html not found at:', SRC_SPINE);
  console.error('  Make sure vite build completed successfully (or theme/spine-builder.html exists).');
  process.exit(1);
}

mkdirSync(RESOURCES, { recursive: true });
cpSync(SRC_SPINE, DEST_SPINE);
console.log('✓ spine-builder.html copied to src-tauri/resources/');

// ---- models cache ----
// public/models-cache.json is tracked, not generated: the build must not depend
// on the network, and two builds of one commit must stage identical bytes.
// Refresh it deliberately with fetch-models-dev.mjs + build-models-cache.mjs.
const SRC_MODELS = resolve(ROOT, 'public', 'models-cache.json');
if (!existsSync(SRC_MODELS)) {
  console.error('✗ models-cache.json not found at:', SRC_MODELS);
  console.error('  It is tracked in git — restore it, or regenerate with:');
  console.error('    node scripts/fetch-models-dev.mjs && node scripts/build-models-cache.mjs');
  process.exit(1);
}
copyFileSync(SRC_MODELS, resolve(RESOURCES, 'models-cache.json'));
console.log('✓ models-cache.json copied to src-tauri/resources/');

// ---- common legal files ----
// `bundle.licenseFile` handles installer metadata; resource copies keep every
// source notice available with the installed application. The dependency
// inventory is generated only by the explicit production release pipeline.
for (const filename of ['LICENSE', 'NOTICE']) {
  const source = resolve(ROOT, filename);
  const destination = resolve(RESOURCES, filename);
  if (!existsSync(source)) {
    console.error(`✗ ${filename} not found at:`, source);
    process.exit(1);
  }
  copyFileSync(source, destination);
}
console.log('✓ common legal files copied to src-tauri/resources/');
