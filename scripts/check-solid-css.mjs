/**
 * Solid-mode stylesheet guard.
 *
 * `src/themes/solid.css` re-themes every glassmorphic surface in
 * `src/index.css` for platforms where `backdrop-filter` does not render.
 * Nothing in the type system or the test suite can see that relationship,
 * so when `index.css` renames a class or adds a glass surface, `solid.css`
 * goes stale silently. A hand sweep of the two stylesheets once turned up
 * four such drifts, which is what this script mechanises.
 *
 * This is the mechanical version of that hand check. It is a script, not a
 * test suite: three greps over two stylesheets, no browser,
 * no fixtures, no snapshots.
 *
 *   A. Dead selectors   — a class used in `solid.css` that exists nowhere in
 *                         `index.css` or in any `.ts`/`.tsx` source. Either
 *                         the class was renamed and solid.css missed it, or
 *                         the rule is dead weight.   (catches a renamed class
 *                                                      solid.css did not follow)
 *
 *   B. Unclaimed glass  — a class that carries a real `backdrop-filter` in
 *                         `index.css` and gets no `backdrop-filter: none`
 *                         anywhere in `solid.css`.    (catches a new glass
 *                                                      surface with no override)
 *
 *   C. Partial override — a `solid.css` rule that replaces an element's
 *                         `background` (i.e. paints an opaque fill over the
 *                         glass) without also resetting the blur, on an
 *                         element that carries a blur in `index.css`. The
 *                         result looks correct and still costs a backdrop
 *                         root every composited frame. (catches an opaque fill
 *                                                       that leaves the blur up)
 *
 *   D. Unclaimed          — a translucent SURFACE fill in `index.css` with no
 *      translucent          `background` for that element anywhere in
 *      surface              `solid.css`. This is invariant 2's second clause,
 *                           which checks A–C do not reach: they all key off
 *                           `backdrop-filter`, and a glass surface can be
 *                           translucent without being blurred.
 *
 * Check C is the interesting one and the reason this script is worth having:
 * a coverage check alone cannot see this shape, because `.attachment-thumb` *is*
 * reset in solid.css — just not by the rule that wins in the pinned + light
 * state. C catches the shape of that bug (opaque fill, no blur reset) without
 * needing to reason about specificity or state overlap.
 *
 * Check D is deliberately narrow, and the enumeration behind that choice is
 * spelled out here. LC has 101 low-alpha background declarations across 70
 * classes; 58 classes have no solid.css background and 57 of those are correct
 * that way. They fall into three families that D must NOT flag:
 *
 *   - semantic tints   `--accent-soft`, `--danger-soft`, `--tag-*-bg`,
 *                      `--variant-*-bg`, `--tool-status-*-bg`,
 *                      `color-mix(… var(--accent) N%, transparent)` — a chip
 *                      colour blended over an opaque parent, identical in both
 *                      modes because the parent is opaque in both;
 *   - dim layers       `--overlay-bg` and literal `rgba(0,0,0,α)` scrims —
 *                      these are translucent ON PURPOSE. Making them opaque
 *                      would be the defect;
 *   - gradient shapes  `transparent` colour stops used to draw a grip or a
 *                      border ring, not to fill a surface.
 *
 * So D keys on the SURFACE-fill token family — `--bg-elev-*` and
 * `--glass-bg*`, the tokens that mean "this element is a panel" — and fires
 * only when one of them resolves translucent. That is the family where a
 * missing solid override is a real parity hole, and it is what LC would reach
 * for if someone added a new glass panel tomorrow.
 *
 * Limits, stated plainly: this does not evaluate the cascade. It cannot tell
 * you which rule wins, and it will not catch a reset that exists but loses.
 * For anything cascade-dependent, measure computed style in a real browser.
 *
 * Usage:  npm run check:solid-css
 * Exits 1 if any check fails.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_CSS = join(ROOT, 'src/index.css');
const SOLID_CSS = join(ROOT, 'src/themes/solid.css');
const SRC = join(ROOT, 'src');

/* Classes that legitimately live only in solid.css / only in JS. */
const KNOWN_OK = new Set([
  'solid', // the gate itself, toggled from utils/useApplySolidTheme.ts
]);

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Waiver marker. A comment containing `solid-exempt` on a rule, or on the
 * lines immediately above it, takes that rule out of checks B and C.
 * Convention: `solid-exempt: <reason>`.
 *
 * This exists because the guard gates the build. `solid.css`'s own header
 * documents surfaces that are deliberately NOT overridden — intentionally
 * translucent dim layers, colored status chips — and if one of those ever
 * grows a `backdrop-filter`, check B would be correct to notice it and wrong
 * to block the build over it. Without a waiver the only way out is deleting
 * the guard, which is how guards die. Exemptions are counted in the summary
 * line so they stay visible instead of turning into silent debt.
 */
const EXEMPT = /solid-exempt/;

/**
 * Walk a stylesheet and yield every non-at-rule as { selector, body, lead }.
 * `lead` is the raw text since the previous rule, so a waiver comment sitting
 * above a rule is attributable to it.
 *
 * The walker skips comments rather than pre-stripping them, so a commented-out
 * rule containing braces — `index.css` has two — cannot desynchronize the
 * brace depth. Selector and body are comment-stripped individually on the way
 * out.
 */
function rules(css) {
  const out = [];
  let depth = 0;
  let start = 0;
  let leadStart = 0;
  let prelude = '';
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = (end === -1 ? css.length : end + 1);
      continue;
    }
    const c = css[i];
    if (c === '{') {
      if (depth === 0) {
        prelude = css.slice(start, i);
        start = i + 1;
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        const rawBody = css.slice(start, i);
        const selector = stripComments(prelude).trim();
        if (selector.startsWith('@')) {
          // An at-rule (@media …) wraps nested rules; recurse into it.
          out.push(...rules(rawBody));
        } else if (selector) {
          out.push({
            selector,
            body: stripComments(rawBody),
            lead: css.slice(leadStart, start),
            exempt: EXEMPT.test(css.slice(leadStart, i)),
          });
        }
        start = i + 1;
        leadStart = i + 1;
      }
    }
  }
  return out;
}

/** Remove `:has(...)`, `:is(...)`, `:not(...)` argument contents. */
const stripFnArgs = (sel) => {
  let prev;
  let s = sel;
  do {
    prev = s;
    s = s.replace(/:(?:has|is|not|where)\([^()]*\)/g, '');
  } while (s !== prev);
  return s;
};

const classesIn = (sel) => (sel.match(/\.[A-Za-z_][\w-]*/g) ?? []).map((c) => c.slice(1));

/** The class the selector actually targets — last class of the last compound. */
function leafClass(sel) {
  const parts = stripFnArgs(sel).split(/[\s>+~]+/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const cs = classesIn(parts[i]);
    if (cs.length) return cs[cs.length - 1];
  }
  return null;
}

const selectorsOf = (rule) => rule.selector.split(',').map((s) => s.trim()).filter(Boolean);

/** Index of the `)` matching the `(` at `open`. */
function matchParen(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++;
    else if (s[i] === ')' && --d === 0) return i;
  }
  return s.length;
}

/** Split on commas that are not inside parentheses. */
function splitTop(s) {
  const out = [];
  let d = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') d++;
    else if (s[i] === ')') d--;
    else if (s[i] === ',' && d === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

const cmpSpec = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

/**
 * Specificity as [ids, classes, elements].
 *
 * `:is()`, `:not()` and `:has()` contribute the specificity of their most
 * specific argument and nothing of their own; `:where()` contributes zero.
 * That `:has()` rule is exactly what an earlier hand analysis got wrong
 * (it counted `:has()` as a class on top of its argument), so it is worth
 * computing here rather than trusting anyone's arithmetic.
 */
function specificity(sel) {
  let a = 0;
  let b = 0;
  let c = 0;
  let i = 0;
  while (i < sel.length) {
    const rest = sel.slice(i);
    let m = /^::?(is|not|has|where|matches)\(/i.exec(rest);
    if (m) {
      const open = i + m[0].length - 1;
      const close = matchParen(sel, open);
      if (m[1].toLowerCase() !== 'where') {
        let best = [0, 0, 0];
        for (const arg of splitTop(sel.slice(open + 1, close))) {
          const s = specificity(arg);
          if (cmpSpec(s, best) > 0) best = s;
        }
        a += best[0];
        b += best[1];
        c += best[2];
      }
      i = close + 1;
    } else if ((m = /^::?[\w-]+\(/.exec(rest))) {
      // Other functional pseudo-classes (:nth-child(...) etc.) count as one class.
      b++;
      i = matchParen(sel, i + m[0].length - 1) + 1;
    } else if ((m = /^#[\w-]+/.exec(rest))) {
      a++;
      i += m[0].length;
    } else if ((m = /^\.[\w-]+/.exec(rest))) {
      b++;
      i += m[0].length;
    } else if (rest[0] === '[') {
      b++;
      i = sel.indexOf(']', i) + 1 || sel.length;
    } else if ((m = /^::[\w-]+/.exec(rest))) {
      c++;
      i += m[0].length;
    } else if ((m = /^:[\w-]+/.exec(rest))) {
      b++;
      i += m[0].length;
    } else if ((m = /^[\w-]+/.exec(rest))) {
      c++;
      i += m[0].length;
    } else {
      i++; // combinator, whitespace, `*`
    }
  }
  return [a, b, c];
}

const fmtSpec = (s) => `(${s.join(',')})`;

/** Last value of `prop` declared in a rule body, or null. */
function decl(body, prop) {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;}]+)`, 'g');
  let m;
  let last = null;
  while ((m = re.exec(body))) last = m[1].trim();
  return last;
}

/* ---- token resolution (check D) ----------------------------------------
 * Custom properties are theme-scoped, so "is this fill translucent?" has to be
 * asked per theme. The light block is declared as a selector LIST
 * (`:root, :root[data-theme='light']`), so match per arm, not on the whole
 * prelude.
 */
function tokensFrom(ruleList, wanted) {
  const want = new Set(wanted);
  const map = {};
  for (const r of ruleList) {
    if (!r.selector.split(',').some((s) => want.has(s.trim().replace(/\s+/g, '')))) continue;
    for (const m of r.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) map[m[1]] = m[2].trim();
  }
  return map;
}

/** Substitute `var()` until nothing changes. Depth-capped against token cycles. */
function resolveVars(value, map, depth = 0) {
  if (depth > 12) return value;
  let changed = false;
  const out = value.replace(/var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/g, (whole, name, fallback) => {
    if (map[name] !== undefined) { changed = true; return map[name]; }
    if (fallback !== undefined) { changed = true; return fallback.trim(); }
    return whole;
  });
  return changed ? resolveVars(out, map, depth + 1) : out;
}

/** Lowest alpha in a resolved colour expression; 1 when fully opaque. */
function minAlpha(value) {
  let s = value.toLowerCase();
  let min = 1;
  // Consume color-mix() first: the bare `transparent` inside
  // `color-mix(in srgb, X 8%, transparent)` means 8% opacity, not 0.
  s = s.replace(/color-mix\(([^()]|\([^()]*\))*\)/g, (whole) => {
    if (/\btransparent\b/.test(whole)) {
      const pct = /(\d+(?:\.\d+)?)%/.exec(whole);
      if (pct) min = Math.min(min, parseFloat(pct[1]) / 100);
    }
    return ' ';
  });
  if (/\btransparent\b/.test(s)) return 0;
  for (const m of s.matchAll(/(?:rgba?|hsla?)\(\s*[^)]*?[,/]\s*(0?\.\d+|0|1(?:\.0+)?)\s*\)/g)) {
    min = Math.min(min, parseFloat(m[1]));
  }
  for (const m of s.matchAll(/#[0-9a-f]{6}([0-9a-f]{2})\b/g)) min = Math.min(min, parseInt(m[1], 16) / 255);
  return min;
}

/** The "this element is a panel surface" token family. See the header. */
const SURFACE_TOKEN = /var\(\s*--(?:bg-elev-\d+|glass-bg[\w-]*)\s*[,)]/;

/* ---- gather source tokens (over-broad on purpose: a dead-selector check
       must not produce false positives, or it gets switched off) --------- */
function collectTokens(dir, into) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectTokens(p, into);
    else if (/\.tsx?$/.test(name)) {
      for (const t of readFileSync(p, 'utf8').match(/[A-Za-z_][\w-]*/g) ?? []) into.add(t);
    }
  }
  return into;
}

// Pass the raw text: `rules()` skips comments itself (so a commented-out rule
// containing braces cannot desynchronize brace depth) and needs them intact to
// attribute `solid-exempt` waivers to the rule they sit above.
const indexRules = rules(readFileSync(INDEX_CSS, 'utf8'));
const solidRules = rules(readFileSync(SOLID_CSS, 'utf8'));
const srcTokens = collectTokens(SRC, new Set());
const indexClasses = new Set(indexRules.flatMap((r) => classesIn(r.selector)));

const failures = [];

/* ---- A. dead selectors -------------------------------------------------- */
for (const rule of solidRules) {
  for (const sel of selectorsOf(rule)) {
    for (const cls of new Set(classesIn(sel))) {
      if (KNOWN_OK.has(cls) || indexClasses.has(cls) || srcTokens.has(cls)) continue;
      failures.push(
        `[A] dead selector: .${cls} is used in solid.css but appears in no index.css rule ` +
          `and no .ts/.tsx source\n      ${sel}`,
      );
    }
  }
}

/* ---- B. unclaimed glass ------------------------------------------------- */
const isBlur = (v) => v && v !== 'none';

const resetInSolid = new Set();
for (const rule of solidRules) {
  if (decl(rule.body, 'backdrop-filter') === 'none') {
    for (const sel of selectorsOf(rule)) {
      const leaf = leafClass(sel);
      if (leaf) resetInSolid.add(leaf);
    }
  }
}

let exempted = 0;

const glassInIndex = new Map(); // leaf class -> [{ sel, spec }]
for (const rule of indexRules) {
  if (!isBlur(decl(rule.body, 'backdrop-filter'))) continue;
  if (rule.exempt) {
    exempted++;
    continue;
  }
  for (const sel of selectorsOf(rule)) {
    const leaf = leafClass(sel);
    if (!leaf) continue;
    if (!glassInIndex.has(leaf)) glassInIndex.set(leaf, []);
    glassInIndex.get(leaf).push({ sel, spec: specificity(sel) });
  }
}

for (const [leaf, glass] of glassInIndex) {
  if (resetInSolid.has(leaf)) continue;
  failures.push(
    `[B] unclaimed glass: .${leaf} declares backdrop-filter in index.css but solid.css ` +
      `never resets it\n      ${glass[0].sel}`,
  );
}

/* ---- C. partial override (opaque fill, blur left standing) --------------
 * A solid rule that replaces the fill but not the blur is only a bug when
 * some index.css blur rule on the same element is at least as specific as
 * the solid rule itself — i.e. the solid rule is plainly the intended
 * override for it, yet leaves the filter standing. Where every blur rule is
 * weaker, a lower-specificity reset elsewhere in solid.css already wins and
 * the fill-only rule is fine; flagging those was this check's first draft
 * and produced two false positives on surfaces that measured clean.
 */
for (const rule of solidRules) {
  if (rule.exempt) continue;
  if (!decl(rule.body, 'background') && !decl(rule.body, 'background-color')) continue;
  if (decl(rule.body, 'backdrop-filter')) continue;
  for (const sel of selectorsOf(rule)) {
    const leaf = leafClass(sel);
    if (!leaf || !glassInIndex.has(leaf)) continue;
    const spec = specificity(sel);
    // Report the tightest tie — the closest-specificity blur rule is almost
    // always the counterpart the solid rule was written against.
    const survivor = glassInIndex
      .get(leaf)
      .filter((g) => cmpSpec(g.spec, spec) >= 0)
      .sort((x, y) => cmpSpec(x.spec, y.spec))[0];
    if (!survivor) continue;
    failures.push(
      `[C] partial override: this rule paints an opaque fill over .${leaf} at ${fmtSpec(spec)} ` +
        `but does not reset the blur, so the filter below survives — live, invisible, and ` +
        `still costing a backdrop root every frame\n` +
        `      solid.css  ${sel}\n` +
        `      index.css  ${survivor.sel}  ${fmtSpec(survivor.spec)}`,
    );
  }
}

/* ---- D. unclaimed translucent surface ------------------------------------
 * Invariant 2's second clause. A–C all key off `backdrop-filter`; this is the
 * glass surface that is translucent WITHOUT being blurred, which none of them
 * can see. Narrowed to the surface-fill token family — see the header for the
 * three families it deliberately ignores and why.
 */
const lightTokens = tokensFrom(indexRules, [':root', ":root[data-theme='light']"]);
const darkTokens = { ...lightTokens, ...tokensFrom(indexRules, [":root[data-theme='dark']"]) };

const filledInSolid = new Set();
for (const rule of solidRules) {
  if (!decl(rule.body, 'background') && !decl(rule.body, 'background-color')) continue;
  for (const sel of selectorsOf(rule)) {
    const leaf = leafClass(sel);
    if (leaf) filledInSolid.add(leaf);
  }
}

const reportedD = new Set();
for (const rule of indexRules) {
  // A token-definition block, not a surface rule.
  if (/^:root/.test(rule.selector) && !/[\s>+~]/.test(rule.selector)) continue;
  const bg = decl(rule.body, 'background') ?? decl(rule.body, 'background-color');
  if (!bg || !SURFACE_TOKEN.test(bg)) continue;
  const alpha = Math.min(minAlpha(resolveVars(bg, lightTokens)), minAlpha(resolveVars(bg, darkTokens)));
  if (alpha >= 1) continue;
  if (rule.exempt) {
    exempted++;
    continue;
  }
  for (const sel of selectorsOf(rule)) {
    const leaf = leafClass(sel);
    if (!leaf || filledInSolid.has(leaf) || reportedD.has(leaf)) continue;
    reportedD.add(leaf);
    failures.push(
      `[D] unclaimed translucent surface: .${leaf} is filled with a translucent surface token ` +
        `(alpha ${alpha}) in index.css and solid.css never repaints it, so solid mode inherits ` +
        `the glass fill\n      index.css  ${sel}\n      ${bg}`,
    );
  }
}

/* ---- report ------------------------------------------------------------- */
if (failures.length) {
  console.error(`\nsolid.css guard: ${failures.length} issue(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(
    'Each check guards a token/override invariant in theme/theme-system.md.\n' +
      'If a surface is deliberately left unclaimed, mark its rule with a\n' +
      '`/* solid-exempt: <reason> */` comment rather than removing the check.\n',
  );
  process.exit(1);
}

console.log(
  `solid.css guard: OK — ${solidRules.length} solid rules, ` +
    `${glassInIndex.size} glass surfaces, all claimed` +
    `${exempted ? `, ${exempted} exempt` : ''}.`,
);
