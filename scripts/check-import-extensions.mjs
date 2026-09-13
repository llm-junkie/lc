/**
 * Relative-import extension guard.
 *
 * Four toolchains resolve this codebase's modules, and only one of them is
 * strict:
 *
 *   node --test --experimental-strip-types   no extension resolution at all
 *   tsx --test                               resolves extensionless
 *   Vite (dev + build)                       resolves extensionless
 *   tsc -b (moduleResolution "bundler",      accepts either
 *           allowImportingTsExtensions)
 *
 * So an extensionless relative import is correct everywhere except under the
 * Node test runner, where it is ERR_MODULE_NOT_FOUND. Extensions therefore used
 * to be added one module at a time, whenever somebody wrote a Node-phase test
 * that happened to reach that module — which left the tree looking arbitrary
 * and left half-finished chains that broke one hop further out than the
 * extension reached.
 *
 * The rule this enforces removes the judgement call:
 *
 *   A. Value imports carry the extension. `import`, `export … from`, dynamic
 *      `import()`, and side-effect `import './x'` all emit a real runtime
 *      resolution, so every relative specifier names its file exactly —
 *      including `/index.ts` for a directory barrel, which Node will not
 *      infer either.
 *
 *   B. Type-only imports do not. `import type` / `export type` are erased
 *      before anything resolves them, so an extension there is noise. Keeping
 *      them bare also makes the extension mean something: if a specifier has
 *      one, that module is loaded at runtime.
 *
 * Not a test: one pass over the source, no fixtures, no compiler. Run it with
 * `npm run check:imports`.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** Extensions a specifier may legitimately already carry. */
const HAS_EXT =
  /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|json|css|scss|svg|png|jpg|md|txt|wasm|woff2?)($|\?)/;

/**
 * Mark every byte that is real code. Comments and template literals are
 * excluded so a specifier quoted in prose or in an example never counts.
 */
function codeMask(src) {
  const mask = new Array(src.length).fill(true);
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') mask[i++] = false;
      continue;
    }
    if (c === '/' && d === '*') {
      mask[i++] = false;
      mask[i++] = false;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) mask[i++] = false;
      if (i < n) { mask[i++] = false; mask[i++] = false; }
      continue;
    }
    if (c === '`') {
      i += 1;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return mask;
}

/** The specifier a value import should have used, or null when it resolves nowhere. */
function expected(file, spec) {
  const q = spec.indexOf('?');
  const bare = q === -1 ? spec : spec.slice(0, q);
  const query = q === -1 ? '' : spec.slice(q);
  const base = resolve(dirname(file), bare);
  for (const candidate of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (existsSync(base + candidate)) return bare + candidate + query;
  }
  return null;
}

const PATTERNS = [
  { re: /(^|\n)[ \t]*(import|export)\b([\s\S]*?)\bfrom\s*(['"])([^'"]+)\4/g, spec: 5, mid: 3 },
  { re: /\bimport\(\s*(['"])([^'"]+)\1/g, spec: 2, mid: null },
  { re: /(^|\n)[ \t]*import\s*(['"])([^'"]+)\2/g, spec: 3, mid: null },
];

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(entry)) files.push(p);
  }
})(SRC);

const problems = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const mask = codeMask(src);
  const lineOf = (offset) => src.slice(0, offset).split('\n').length;

  for (const { re, spec: specGroup, mid: midGroup } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      if (!mask[m.index]) continue;
      const spec = m[specGroup];
      if (!spec.startsWith('.')) continue;
      const where = `${relative(ROOT, file).replace(/\\/g, '/')}:${lineOf(m.index + 1)}`;
      const typeOnly = midGroup !== null && /^\s*type\s/.test(m[midGroup]);

      if (typeOnly) {
        if (/\.(ts|tsx)$/.test(spec)) {
          problems.push(
            `${where}  type-only import carries an extension: '${spec}'\n` +
            `    rule B — drop it: '${spec.replace(/\.(ts|tsx)$/, '')}'`,
          );
        }
      } else if (!HAS_EXT.test(spec)) {
        const want = expected(file, spec);
        problems.push(
          want
            ? `${where}  value import is missing its extension: '${spec}'\n` +
              `    rule A — write: '${want}'`
            : `${where}  value import resolves to no file: '${spec}'`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`check-import-extensions: ${problems.length} problem(s) in ${files.length} files\n`);
  for (const p of problems) console.error('  ' + p);
  console.error(
    '\nRelative value imports name their file exactly; type-only imports stay bare.\n' +
    'See docs/architecture.md "Relative imports carry their own extension".',
  );
  process.exit(1);
}

console.log(`check-import-extensions: clean — ${files.length} files, every relative specifier resolves as written`);
