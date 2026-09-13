/**
 * Test-registry guard.
 *
 * `npm test` names every test file explicitly instead of globbing, because the
 * suite runs under two different runners and the split is not derivable from a
 * path:
 *
 *   node --test --experimental-strip-types   local TS only — no transform of
 *                                            anything reached through
 *                                            node_modules
 *   tsx --test                               everything whose import graph
 *                                            pulls in a dependency (react,
 *                                            zod, @tauri-apps/*, …)
 *
 * A file's runner therefore depends on its *transitive* imports, so no glob can
 * place it. The explicit list is correct — but it silently rots: add a new
 * `*.test.ts` and forget the package.json edit, and the file never runs. It
 * still looks green, because nothing ever asked for it.
 *
 * This closes that hole from the other side. It does not decide the runner; it
 * only asserts that the list and the disk agree, in both directions:
 *
 *   A. Every test file on disk appears in the `test` script. A missing entry is
 *      a test that passes by never executing.
 *
 *   B. Every path in the `test` script exists on disk. A stale entry crashes
 *      the runner on a file that moved or was deleted.
 *
 * Not a test: one directory walk and one string scan, no runner, no fixtures.
 * Run it with `npm run check:tests`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** Repo-relative, forward-slashed — the form the `test` script uses. */
const posix = (p) => relative(ROOT, p).replace(/\\/g, '/');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const script = pkg.scripts?.test;

if (typeof script !== 'string') {
  console.error('check-test-registry: package.json has no "test" script to check');
  process.exit(1);
}

/** Which runner a listed path sits under, for the fix-it hint on a miss. */
const NODE_RUNNER = /node --test[^&]*/;
const nodeSegment = script.match(NODE_RUNNER)?.[0] ?? '';

const TEST_PATH = /src\/[^\s'"]+?\.test\.tsx?/g;
const listed = new Set(script.match(TEST_PATH) ?? []);

const onDisk = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.test\.tsx?$/.test(entry)) onDisk.push(posix(p));
  }
})(SRC);

const unlisted = onDisk.filter((f) => !listed.has(f)).sort();
const stale = [...listed].filter((f) => !onDisk.includes(f)).sort();

if (unlisted.length > 0 || stale.length > 0) {
  console.error(
    `check-test-registry: the "test" script and src/ disagree — ` +
    `${onDisk.length} test files on disk, ${listed.size} listed\n`,
  );

  if (unlisted.length > 0) {
    console.error(`  ${unlisted.length} test file(s) on disk that "npm test" never runs:`);
    for (const f of unlisted) console.error(`    ${f}`);
    console.error(
      '\n    Add each one to the "test" script in package.json.\n' +
      '    Put it under `tsx --test` unless its whole import graph stays inside\n' +
      '    local .ts files, in which case it belongs under `node --test`.',
    );
  }

  if (stale.length > 0) {
    if (unlisted.length > 0) console.error('');
    console.error(`  ${stale.length} listed path(s) with no file on disk:`);
    for (const f of stale) console.error(`    ${f}`);
    console.error('\n    Remove each one from the "test" script, or restore the file.');
  }

  process.exit(1);
}

const nodeCount = (nodeSegment.match(TEST_PATH) ?? []).length;
console.log(
  `check-test-registry: clean — all ${onDisk.length} test files are registered ` +
  `(${nodeCount} under node --test, ${onDisk.length - nodeCount} under tsx --test)`,
);
