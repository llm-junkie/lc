/**
 * LC 7z fixtures — extract-on-demand for the test suite.
 *
 * `scripts/fixtures/` carries two committed 7-Zip recompressions of real LC
 * output:
 *
 *   lc-chat-v1-all-2026-08-09.7z   bulk conversation export
 *   lc-support-v1-2026-08-09.7z    default and opted-in support reports
 *
 * The fixture tests and benchmarks call `ensureExtracted()`. On first run each
 * archive is decompressed with the `7z-wasm` devDependency — 7-Zip 24.09
 * compiled to WASM, run IN-PROCESS (no system 7-Zip, no Rust, no subprocess) —
 * into its OWN subdir named after the archive file. A `.extracted-ok` sentinel
 * makes later runs a no-op. The `.7z` files are tracked; extracted subdirs are
 * gitignored (see `.gitignore`).
 *
 * Status report:
 *   node scripts/fixture-lc-archives.mjs
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const CHAT_ARCHIVE = 'lc-chat-v1-all-2026-08-09.7z';
export const SUPPORT_ARCHIVE = 'lc-support-v1-2026-08-09.7z';
export const SUPPORT_DEFAULT_JSON = 'lc-support-v1-2026-08-09-1701.json';
export const SUPPORT_INCLUDED_JSON = 'lc-support-v1-include-2026-08-09-1701.json';

/** Committed 7z fixtures and the entries each must contain once extracted. */
export const ARCHIVE_FIXTURES = [
  {
    archive: CHAT_ARCHIVE,
    expect: ['conversations.json', 'whiteboard.json', 'README.txt', 'attachments'],
  },
  {
    archive: SUPPORT_ARCHIVE,
    expect: [SUPPORT_DEFAULT_JSON, SUPPORT_INCLUDED_JSON],
  },
];

const SENTINEL = '.extracted-ok';

/** The dir an archive extracts to — always its own, named after the archive. */
export function extractedDir(archive) {
  return join(FIXTURES_DIR, archive.replace(/\.7z$/, ''));
}

// The Emscripten virtual mount under which FIXTURES_DIR is made visible to
// the in-process 7-Zip. Paths inside it map 1:1 onto the real fixtures dir.
const MOUNT_ROOT = '/nodefs';

let sevenZipPromise = null;

/**
 * Lazily initialize the 7z-wasm module and mount FIXTURES_DIR for real
 * filesystem access (Emscripten NODEFS — Node only). Idempotent.
 */
async function get7Zip() {
  if (!sevenZipPromise) {
    sevenZipPromise = (async () => {
      const { default: initSevenZip } = await import('7z-wasm');
      const sz = await initSevenZip();
      sz.FS.mkdir(MOUNT_ROOT);
      sz.FS.mount(sz.NODEFS, { root: FIXTURES_DIR }, MOUNT_ROOT);
      sz.FS.chdir(MOUNT_ROOT);
      return sz;
    })();
  }
  return sevenZipPromise;
}

/** Decompress one archive into its own subdir with in-process 7-Zip. */
async function extractWith7Zip(archiveName, outDirName) {
  const sz = await get7Zip();
  sz.FS.chdir(MOUNT_ROOT);
  try {
    sz.callMain(['x', '-y', `-o${MOUNT_ROOT}/${outDirName}`, archiveName]);
  } catch (err) {
    if (err?.status === 0) return; // Emscripten can surface a clean exit as a throw
    throw new Error(
      `7z-wasm failed (${err?.status ?? err?.message ?? err}) extracting ${archiveName}`,
    );
  }
}

/**
 * Extract any not-yet-extracted fixture archive. Idempotent: a dir that
 * already carries `.extracted-ok` is left untouched. Returns a map of archive
 * name → extracted dir.
 */
export async function ensureExtracted() {
  const dirs = {};
  for (const { archive, expect } of ARCHIVE_FIXTURES) {
    const dir = extractedDir(archive);
    dirs[archive] = dir;
    if (existsSync(join(dir, SENTINEL))) continue;

    const archivePath = join(FIXTURES_DIR, archive);
    if (!existsSync(archivePath)) {
      throw new Error(`Missing committed fixture archive: ${archivePath}`);
    }
    mkdirSync(dir, { recursive: true });
    await extractWith7Zip(archive, archive.replace(/\.7z$/, ''));

    for (const entry of expect) {
      if (!existsSync(join(dir, entry))) {
        throw new Error(`Extraction of ${archive} is missing expected entry: ${entry}`);
      }
    }
    writeFileSync(
      join(dir, SENTINEL),
      `${archive} extracted by scripts/fixture-lc-archives.mjs (7z-wasm) on ${new Date().toISOString()}\n`,
    );
  }
  return dirs;
}

/* Direct-run status report. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = await ensureExtracted();
  for (const { archive } of ARCHIVE_FIXTURES) {
    const dir = dirs[archive];
    const entries = readdirSync(dir).filter((entry) => entry !== SENTINEL);
    console.log(`${archive} → ${dir} (${entries.length} entries)`);
  }
}
