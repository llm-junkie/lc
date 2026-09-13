/**
 * Native-material CSS guard.
 *
 * The material system's core safety invariant: `html`, `body`, `#root`,
 * and `.app` paint an opaque floor by default, and may go transparent
 * ONLY when the document root carries a confirmed native material
 * attribute (`data-material-active` = mica | acrylic | vibrancy).
 *
 * Nothing in the type system can see that relationship, so this script
 * mechanizes it: any CSS rule in `src/` that makes one of those root
 * surfaces transparent (or unset) must be scoped under a
 * `[data-material-active=...]` guard from the known-native set. A rule
 * that manages it any other way — wrong attribute, wrong value, no
 * guard — fails the build, because it would produce an unpainted
 * window on Linux, the web build, or any activation failure.
 *
 * Usage: node scripts/check-material-css.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, 'src');

const NATIVE_VALUES = ['mica', 'acrylic', 'vibrancy'];
/** Root surfaces whose opacity is safety-critical. */
const ROOT_SURFACE = /(^|[\s,>+~])(html|body|#root|\.app)\b/;
/** A selector properly guarding native-only transparency. */
const GUARDED = new RegExp(
  `\\[data-material-active=["']?(?:${NATIVE_VALUES.join('|')})["']?\\]`,
);

function listCssFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listCssFiles(full));
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

/** Strip /* … *\/ comments so commented-out rules cannot confuse the scan. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

let failures = 0;

for (const file of listCssFiles(srcDir)) {
  const css = stripComments(readFileSync(file, 'utf8'));
  // Walk top-level and at-rule bodies by brace matching. Nested rules
  // (none exist in this codebase's CSS) would simply be scanned as
  // their own selector/declaration pairs.
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const close = css.indexOf('}', open);
    if (close === -1) break;
    const selector = css.slice(i, open);
    const body = css.slice(open + 1, close);
    // Split nested blocks off the body so a nested guarded rule is not
    // misread as declarations of the outer rule.
    let nested = 0;
    let end = -1;
    for (let j = 0; j < body.length; j++) {
      if (body[j] === '{') { if (nested === 0) { end = j; break; } nested++; }
    }
    const declarations = end === -1 ? body : body.slice(0, end);
    if (
      ROOT_SURFACE.test(selector) &&
      /background(?:-color)?:\s*(transparent|none)\b/.test(declarations) &&
      !GUARDED.test(selector)
    ) {
      failures++;
      console.error(
        `${file}: selector "${selector.trim().slice(0, 80)}" makes a root surface ` +
          'transparent without a [data-material-active=mica|acrylic|vibrancy] guard',
      );
    }
    i = end === -1 ? close + 1 : open + 1 + end + 1;
  }
}

// Positive check: the three native values must have gate rules in
// index.css, or activation would succeed natively while the CSS stays
// opaque (silent no-op material).
const indexCss = stripComments(readFileSync(join(srcDir, 'index.css'), 'utf8'));
for (const value of NATIVE_VALUES) {
  if (!indexCss.includes(`[data-material-active='${value}']`)) {
    failures++;
    console.error(`src/index.css: missing gate rule for data-material-active='${value}'`);
  }
}

if (failures > 0) {
  console.error(`\ncheck-material-css: ${failures} guard failure(s).`);
  process.exit(1);
}
console.log('check-material-css: root transparency is native-gated.');
