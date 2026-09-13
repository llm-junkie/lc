/**
 * Tauri window-configuration synchronization guard.
 *
 * Platform-specific config fragments (`tauri.windows.conf.json`,
 * `tauri.macos.conf.json`) REPLACE the base `app.windows` array — Tauri
 * merges platform files at the top level, so a whole-file drift between
 * the three window definitions would silently change window behavior on
 * one platform only (e.g. `visible: false` lost on macOS → startup
 * geometry flash returns there).
 *
 * This script fails the build when any SHARED field (the fields below)
 * differs across the window definitions in the base and platform
 * configs. Platform-specific fields (`transparent`,
 * `macOSPrivateApi`, `windowEffects`, ...) are intentionally exempt:
 * they are the reason the platform files exist.
 *
 * Usage: node scripts/check-tauri-configs.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tauriDir = join(root, 'src-tauri');

/** Window fields that must be identical in every window definition.
 *  Anything not listed here is allowed to be platform-specific —
 *  adding a new shared field to tauri.conf.json means adding it to
 *  this list so it cannot drift. */
const SHARED_FIELDS = [
  'title',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'resizable',
  'fullscreen',
  'center',
  'decorations',
  'dragDropEnabled',
  'visible',
];

const CONFIGS = [
  'tauri.conf.json',
  'tauri.windows.conf.json',
  'tauri.macos.conf.json',
];

function readWindowDefinition(name) {
  const config = JSON.parse(readFileSync(join(tauriDir, name), 'utf8'));
  const windows = config?.app?.windows;
  if (!Array.isArray(windows) || windows.length !== 1) {
    throw new Error(
      `${name}: expected exactly one window in app.windows (platform files replace the base array)`,
    );
  }
  return { name, window: windows[0] };
}

const definitions = CONFIGS.map(readWindowDefinition);
const base = definitions[0];
let failures = 0;

for (const field of SHARED_FIELDS) {
  const values = definitions.map(({ name, window }) => [name, window[field]]);
  const expected = base.window[field];
  for (const [name, value] of values) {
    if (value !== expected) {
      failures++;
      console.error(
        `[${field}] ${name}: ${JSON.stringify(value)} !== base ${JSON.stringify(expected)}`,
      );
    }
  }
}

// The safety invariant the whole material system rests on: only the
// Windows/macOS platform overrides may ask for a transparent native
// window. The base (Linux) window must stay opaque.
if (base.window.transparent !== false) {
  failures++;
  console.error(
    `tauri.conf.json: base window must keep "transparent": false (Linux matte fallback)`,
  );
}
for (const { name, window } of definitions.slice(1)) {
  if (window.transparent !== true) {
    failures++;
    console.error(`${name}: platform window must set "transparent": true for native material`);
  }
}
if (definitions[2].window.macOSPrivateApi !== true) {
  failures++;
  console.error(`tauri.macos.conf.json: vibrancy requires "macOSPrivateApi": true`);
}

if (failures > 0) {
  console.error(`\ncheck-tauri-configs: ${failures} synchronization failure(s).`);
  process.exit(1);
}
console.log('check-tauri-configs: window definitions synchronized.');
