// Copyright 2026 LC Contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// check-docs-sync.mjs — A16 docs/code-sync mechanical checker.
//
// Corpus-wide, offline, deterministic. Five check families:
//   1. links        inline and full/collapsed/shortcut reference-style
//                   Markdown links plus <a href> and <img src> in an in-scope
//                   .md resolve case-sensitively. Section anchors resolve
//                   against GitHub-style slugs from the target headings.
//   2. source paths inline-code spans that look like repo paths (incl. brace
//                   lists and * / ? globs) resolve on disk. Documentation
//                   paths in source files also resolve with valid anchors.
//   3. leakage      non-binary files outside docs/audits/logs/ cannot name a
//                   record inside it by run id, F-/R- finding id, or path.
//                   Record-looking filenames must use a standard run code or
//                   one fixed A16 subcode; bare a16 and unknown letters fail.
//                   Standard generated/editor directories and extracted
//                   fixtures are excluded. The gitignored root log/ directory
//                   contains diagnostic exports and is outside the corpus.
//                   Fixture mode also excludes its root expected-output file.
//   4. orphans      in-scope .md files unreachable from the index seeds.
//                   logs/ records are exempt by design (the leaf rule forbids
//                   linking them); skills/ and copied license artifacts are
//                   exempt with a recorded reason.
//   5. contracts    small source/documentation invariants whose drift has
//                   previously made the living docs certify false behavior.
//
// Dated audit records are excluded from link/path/orphan checks because their
// contents are historical evidence. The archive boundary is still checked by
// the leakage pass below.
//
// Headings and links inside fenced code blocks or HTML comments are ignored.
// Duplicate heading slugs get -1, -2 suffixes. External URLs are skipped.
//
// Usage:
//   node scripts/check-docs-sync.mjs              check the real corpus
//   node scripts/check-docs-sync.mjs --fixture    check scripts/fixtures/docs-sync-check/
//                                                 and assert expected.json (known answers)
//
// Exits non-zero when any issue remains (fixture: when the issue set differs
// from expected.json).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');

// ---------------------------------------------------------------------------
// Adjudications: known non-issues, each with its reason, so re-runs stay clean.

// Inline-code spans that are not repo paths.
const PATH_ALLOWLIST = new Map([
  // Excalidraw package-internal directory; the residual row in docs/README.md
  // speaks about the npm package, not this repository.
  ['locales/', 'Excalidraw package-internal directory, not a repo path'],

  // --- Value enumerations and notational forms, not paths ----------------
  ['low/high/max', 'reasoning_effort value enumeration (note-openai-responses.md)'],
  ['none/minimal/low/medium/high/xhigh/max', 'reasoning summary level enumeration (note-openai-responses.md)'],
  ['v/r/t', 'CachedModel field shorthand (upgrade_visibility.md)'],
  ['CachedModel.c/v/r/t', 'CachedModel field shorthand (upgrade_visibility.md)'],
  ['--tag-*-bg/fg', 'CSS token pattern with wildcard (upgrade_visibility.md)'],
  ['a/./b.ts', 'illustrative lock-target example (security.md)'],
  ['a/b.ts', 'illustrative lock-target example (security.md)'],
  ['lc/attachments', 'IndexedDB db/store notation — verified DB_NAME "lc", store "attachments" in src/utils/idb.ts'],
  ['llm-client/1.0', 'User-Agent string — verified in src-tauri/src/models_dev.rs and src-tauri/src/tools/web_search.rs'],
  ['qwen/', 'illustrative publisher prefix (modules.md prefix-stripping example)'],
  ['qwen/qwen3.6-35b-a3b', 'illustrative LM Studio model id (modules.md, cache-observability.md)'],
  ['publisher/model', 'illustrative model-id shape (modules.md)'],
  ['Asia/Kathmandu', 'IANA timezone example (tool-reference.md)'],
  ['Asia/Kolkata', 'IANA timezone example (tool-reference.md)'],
  ['.github/workflows/build.yml', 'hypothetical glob example in lc_glob_files prose — makes no existence claim'],
  ['src/foo.ts', 'illustrative relative-path example in File I/O pre-flight prose (tool-reference.md, tool-error-handling.md) — makes no existence claim'],
  ['katex/dist/katex.min.css', 'npm package subpath imported by src/utils/markdown.tsx, not a repository path'],

  // --- Paths that are intentionally absent --------------------------------
  ['src/tools/', 'historical move note (modules.md): the directory moved to src/modules/tool-engine/'],
  ['scripts/data/models-dev.json', 'untracked by design (gitignored); exists only after a manual fetch'],
  ['resources/', 'shorthand for src-tauri/resources/ inside the same table row (docs/README.md)'],
  ['logs/', 'audit-archive directory named in record prose'],
  ['tools/**', 'scope enumeration glob for docs/tools/** in record prose'],
  ['fixtures/viewer-runtime/', 'removed directory; named only in the prose that records its removal'],
  ['**/viewer-runtime*', 'removed directory; named only in the prose that records its removal'],

  // --- Generated build artifacts (gitignored; absent before a build) -------
  ['dist/', 'generated frontend build output directory (vite build)'],
  ['src-tauri/resources/spine-builder.html', 'generated Tauri copy of the Vite output (scripts/copy-tauri-resources.mjs)'],
  ['src-tauri/resources/THIRD_PARTY_LICENSES.md', 'generated Tauri dependency-license artifact (scripts/generate-third-party-licenses.mjs)'],
  ['src-tauri/resources/models-cache.json', 'gitignored build artifact staged by scripts/copy-tauri-resources.mjs'],
  ['public/excalidraw-assets', 'gitignored directory generated by scripts/copy-excalidraw-assets.mjs'],
  ['public/excalidraw-assets/fonts/', 'gitignored generated font directory (scripts/copy-excalidraw-assets.mjs)'],
  ['public/excalidraw-assets/LICENSES.md', 'generated font-license artifact (scripts/generate-third-party-licenses.mjs --fonts-only)'],
]);

// In-scope .md files exempt from the orphan check, with reasons.
const ORPHAN_EXEMPT = [
  [/^skills[/\\]/, 'embedded into the app by scripts/build-skills-content.mjs, consumed at runtime rather than linked'],
  [/^public[/\\]excalidraw-assets[/\\]LICENSES\.md$/, 'generated production font-license artifact (scripts/generate-third-party-licenses.mjs)'],
];

const FIXTURE_EXPECTED_REL = 'expected.json';

// Standard runs use a two-digit code except bare A16. A16 runs use one fixed
// semantic subcode from a16a through a16m.
const AUDIT_RUN_CODE_SOURCE = '(?:16[a-m]|(?!16)[0-9]{2})';
const AUDIT_RECORD_RE = new RegExp(
  `(?:^|/)a${AUDIT_RUN_CODE_SOURCE}__[0-9]{12}(?:__review__.*)?\\.md$`,
);
const AUDIT_RECORD_CANDIDATE_RE = /(?:^|\/)a[0-9]{2}[a-z]?__[0-9]{12}(?:__review__.*)?\.md$/;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'target', '__pycache__', '.venv', 'venv',
  '.cache', 'build', '.next', '.idea', '.vscode',
]);

// ---------------------------------------------------------------------------

function walk(root, onFile, skipDirPred) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      // A linked Git worktree has a root `.git` pointer file instead of a
      // directory. It is repository metadata in both forms and never corpus.
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory()) {
        if (skipDirPred && skipDirPred(p)) continue;
        stack.push(p);
      } else if (e.isFile()) {
        onFile(p);
      }
    }
  }
}

function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function isProbablyText(bytes) {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  return !sample.includes(0);
}

// Split a document into prose (fenced blocks blanked) and heading texts.
function parseDoc(text) {
  const lines = stripComments(text).split(/\r?\n/);
  let inFence = false;
  const prose = [];
  const headings = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; prose.push(''); continue; }
    if (inFence) { prose.push(''); continue; }
    prose.push(line);
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) headings.push(h[2].trim());
  }
  return { prose: prose.join('\n'), headings };
}

// GitHub-style anchor slug, with -1/-2 suffixes for duplicates. Trim
// happens BEFORE punctuation removal, matching GitHub's slugger: a heading
// ending in a parenthesized group keeps a trailing hyphen
// (`Stars (*****)` -> `stars-`). Trimming afterwards would silently break
// links written against real GitHub slugs (slugger correctness fix).
function slugSet(headings) {
  const seen = new Map();
  const out = new Set();
  for (const h of headings) {
    let t = h
      .replace(/`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/\s+/g, '-');
    const n = seen.get(t) ?? 0;
    seen.set(t, n + 1);
    out.add(n === 0 ? t : `${t}-${n}`);
  }
  return out;
}

function normalizeReferenceLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Return all link/image targets used by a Markdown document. Definitions are
// resolved only when referenced: an unused definition is inert Markdown, while
// a missing definition makes the visible reference itself broken.
function collectLinkTargets(prose) {
  const definitions = new Map();
  for (const m of prose.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/gm)) {
    definitions.set(normalizeReferenceLabel(m[1]), m[2]);
  }

  const targets = [];
  const missingReferences = [];
  for (const m of prose.matchAll(/\[([^\]]*)\]\(\s*<?([^)<>'"\s]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)) {
    targets.push(m[2]);
  }
  for (const m of prose.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const label = normalizeReferenceLabel(m[2] || m[1]);
    const target = definitions.get(label);
    if (target === undefined) missingReferences.push(label);
    else targets.push(target);
  }
  for (const m of prose.matchAll(/\[([^\]]+)\]/g)) {
    const start = m.index ?? 0;
    const previous = start > 0 ? prose[start - 1] : '';
    const next = prose[start + m[0].length] ?? '';
    // Inline, full/collapsed reference, and definition forms are handled
    // above. A bracket immediately following another bracket is the label
    // half of a full reference. `!` is deliberately allowed: shortcut image
    // references use the same definition mechanism.
    if (next === '(' || next === '[' || next === ':' || previous === ']') continue;
    const label = normalizeReferenceLabel(m[1]);
    const target = definitions.get(label);
    if (target !== undefined) targets.push(target);
  }
  for (const m of prose.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi)) targets.push(m[2]);
  for (const m of prose.matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)) targets.push(m[2]);
  return { targets, missingReferences };
}

// Case-sensitive relative resolution (Windows FS is case-insensitive; the
// corpus must still resolve on case-sensitive systems).
function resolveCaseSensitive(fromDir, rel) {
  const segs = rel.split(/[\\/]/).filter(Boolean);
  let cur = fromDir;
  for (const seg of segs) {
    if (seg === '.') continue;
    if (seg === '..') { cur = path.dirname(cur); continue; }
    let entries;
    try { entries = fs.readdirSync(cur); } catch { return { ok: false, missing: path.join(cur, seg) }; }
    if (entries.includes(seg)) { cur = path.join(cur, seg); continue; }
    const ci = entries.find((e) => e.toLowerCase() === seg.toLowerCase());
    return ci
      ? { ok: false, caseMismatch: { wanted: seg, actual: ci } }
      : { ok: false, missing: path.join(cur, seg) };
  }
  return { ok: true, actual: cur };
}

function expandBraces(s) {
  const i = s.indexOf('{');
  if (i < 0) return [s];
  const j = s.indexOf('}', i);
  if (j < 0) return [s];
  const opts = s.slice(i + 1, j).split(',');
  const tails = expandBraces(s.slice(j + 1));
  const out = [];
  for (const o of opts) for (const t of tails) out.push(s.slice(0, i) + o + t);
  return out;
}

function segmentIsGlob(seg) { return /[*?]/.test(seg); }

function globCollect(root, relPattern) {
  const segs = relPattern.split('/').filter(Boolean);
  let dirs = [root];
  const hits = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    const next = [];
    const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    for (const d of dirs) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!re.test(e.name)) continue;
        const p = path.join(d, e.name);
        if (last) hits.push(p);
        else if (e.isDirectory()) next.push(p);
      }
    }
    dirs = [...new Set(next)];
  }
  return hits;
}

function looksLikePath(s) {
  if (!s.includes('/')) return false;
  if (s.startsWith('/')) return false; // endpoint-style paths (/v1, /chat, ...)
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
  // npm package specifiers (@scope/pkg, @scope/pkg@1.2.3) are dependency
  // identifiers, not repo paths.
  if (/^@[a-z0-9][\w.-]*\/[\w.-]+(@[\w.-]+)?$/.test(s)) return false;
  // IPv4 CIDR ranges (10.0.0.0/8, 192.0.0.0/24).
  if (/^[0-9.]+\/[0-9]+$/.test(s)) return false;
  // Domain-rooted paths (html.duckduckgo.com/html/) are endpoint citations.
  if (s.split('/')[0].includes('.')) return false;
  if (!/^[\w@{},*?./-]+$/.test(s)) return false;
  if (s.includes('..')) return false;
  // Placeholder braces ({NN}) that are not comma lists are templates, not paths.
  if (/\{[^,{}]*\}/.test(s) && !/\{[^{}]*,[^{}]*\}/.test(s)) return false;
  return true;
}

const RUN_ID_RE = new RegExp(
  `\\ba(${AUDIT_RUN_CODE_SOURCE})__([0-9]{12})\\b`,
  'g',
);
const FINDING_ID_RE = new RegExp(
  `\\b([FR])-a(${AUDIT_RUN_CODE_SOURCE})-([0-9]{12})-([0-9]{2})\\b`,
  'g',
);
const LOG_PATH_RE = new RegExp(
  `docs/audits/logs/(a${AUDIT_RUN_CODE_SOURCE}__[0-9]{12})`,
  'g',
);

// ---------------------------------------------------------------------------

function runChecks(root, opts) {
  const issues = [];
  const issue = (kind, file, target, extra) => issues.push({
    kind,
    file: path.relative(root, file).split(path.sep).join('/'),
    target,
    ...(extra ? { extra } : {}),
  });

  // --- collect in-scope markdown files -------------------------------------
  const mdFiles = [];
  walk(root, (p) => {
    if (!p.toLowerCase().endsWith('.md')) return;
    const base = path.basename(p);
    if (base === 'THIRD_PARTY_LICENSES.md') return; // generated artifact
    const rel = path.relative(root, p).split(path.sep).join('/');
    if (rel.startsWith(opts.logsRel + '/')) {
      if (AUDIT_RECORD_RE.test(rel)) return;
      if (AUDIT_RECORD_CANDIDATE_RE.test(rel)) {
        issue('invalid-record-name', p, base);
        return;
      }
    }
    if (!opts.fixture) {
      const inCorpus =
        rel === 'README.md' ||
        rel.startsWith('docs/') ||
        rel.startsWith('scripts/') ||
        rel.startsWith('theme/') ||
        rel.startsWith('skills/') ||
        rel.startsWith('legal/') ||
        rel.startsWith('public/');
      if (!inCorpus) return;
    }
    mdFiles.push(p);
  }, opts.skipDir);
  mdFiles.sort();

  const docCache = new Map(); // abs path -> { prose, slugs, headings }
  function docOf(abs) {
    let d = docCache.get(abs);
    if (!d) {
      const text = fs.readFileSync(abs, 'utf8');
      const { prose, headings } = parseDoc(text);
      d = { prose, headings, slugs: slugSet(headings) };
      docCache.set(abs, d);
    }
    return d;
  }

  // --- 1+2. links, anchors, source paths ------------------------------------
  const linkTargets = new Set(); // for the orphan graph: resolved md links

  // Resolution bases for inline-code source paths. Beyond the repo root and
  // each citing document's own directory, the corpus uses three established
  // conventions: src/-relative, module-relative (src/modules/ and each of
  // the four modules), and docs-relative for cross-document names. Fixture
  // trees contain none of these directories, so the extra bases are inert
  // under --fixture.
  const sourceBases = [
    'src',
    path.join('src', 'modules'),
    path.join('src', 'modules', 'llm-client'),
    path.join('src', 'modules', 'chat-pipeline'),
    path.join('src', 'modules', 'tool-engine'),
    path.join('src', 'modules', 'server-profiles'),
    'docs',
    path.join('docs', 'audits'),
  ].map((rel) => path.join(root, rel));

  for (const f of mdFiles) {
    const dir = path.dirname(f);
    const { prose } = docOf(f);

    const { targets, missingReferences } = collectLinkTargets(prose);
    for (const label of missingReferences) issue('broken-reference', f, label);

    for (const raw of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // external
      const hashIdx = raw.indexOf('#');
      const pathPart = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
      const anchor = hashIdx >= 0 ? raw.slice(hashIdx + 1) : null;

      if (!pathPart) {
        // same-file anchor
        if (anchor && !docOf(f).slugs.has(decodeURIComponent(anchor))) {
          issue('broken-anchor', f, raw);
        }
        continue;
      }

      const wantDir = pathPart.endsWith('/');
      const r = resolveCaseSensitive(dir, decodeURIComponent(pathPart));
      if (!r.ok) {
        if (r.caseMismatch) issue('case-mismatch', f, raw, `${r.caseMismatch.wanted} -> ${r.caseMismatch.actual}`);
        else issue('broken-link', f, raw);
        continue;
      }
      let st;
      try { st = fs.statSync(r.actual); } catch { issue('broken-link', f, raw); continue; }
      if (wantDir && !st.isDirectory()) issue('broken-link', f, raw, 'not a directory');
      if (st.isFile() && r.actual.toLowerCase().endsWith('.md')) linkTargets.add(path.resolve(r.actual));

      if (anchor) {
        if (!st.isFile() || !r.actual.toLowerCase().endsWith('.md')) {
          issue('broken-anchor', f, raw, 'anchor on a non-markdown target');
        } else if (!docOf(path.resolve(r.actual)).slugs.has(decodeURIComponent(anchor))) {
          issue('broken-anchor', f, raw);
        }
      }
    }

    // inline-code source paths (prose only; fenced blocks already blanked)
    for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
      const span = m[1];
      if (PATH_ALLOWLIST.has(span)) continue;
      if (!looksLikePath(span)) continue;
      const isGlob = span.split('/').some(segmentIsGlob);
      const tryResolve = (base) => {
        if (isGlob) return globCollect(base, span).length > 0;
        return expandBraces(span).every((p) => {
          const r = resolveCaseSensitive(base, p);
          if (!r.ok) return false;
          try { fs.statSync(r.actual); return true; } catch { return false; }
        });
      };
      if (![root, dir, ...sourceBases].some((b) => tryResolve(b))) {
        issue('broken-path', f, span);
      }
    }
  }

  // Documentation references in source comments. Require a
  // repository-rooted path so prose examples and module imports stay inert.
  const sourceDocFiles = [];
  walk(root, (p) => {
    if (!/\.(?:c|cc|cpp|css|js|jsx|mjs|py|rs|ts|tsx)$/i.test(p)) return;
    sourceDocFiles.push(p);
  }, opts.skipDir);
  sourceDocFiles.sort();

  const sourceDocRe = /\b((?:docs|legal|log|public|scripts|skills|theme|tools)\/[A-Za-z0-9_./-]+\.md)(#[A-Za-z0-9_.%-]+)?/g;
  for (const f of sourceDocFiles) {
    const text = fs.readFileSync(f, 'utf8');
    const isPython = f.toLowerCase().endsWith('.py');
    const comments = isPython
      ? (text.match(/#[^\r\n]*/g) ?? []).join('\n')
      : (text.match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g) ?? []).join('\n');
    const seen = new Set();
    for (const m of comments.matchAll(sourceDocRe)) {
      const pathPart = m[1];
      if (PATH_ALLOWLIST.has(pathPart)) continue;
      const anchor = m[2]?.slice(1).replace(/[.,;:!?]+$/, '') ?? null;
      const target = `${pathPart}${anchor ? `#${anchor}` : ''}`;
      if (seen.has(target)) continue;
      seen.add(target);

      const r = resolveCaseSensitive(root, pathPart);
      if (!r.ok) {
        const extra = r.caseMismatch
          ? `${r.caseMismatch.wanted} -> ${r.caseMismatch.actual}`
          : undefined;
        issue(r.caseMismatch ? 'source-doc-case' : 'broken-source-doc', f, target, extra);
        continue;
      }
      if (anchor && !docOf(path.resolve(r.actual)).slugs.has(decodeURIComponent(anchor))) {
        issue('broken-source-anchor', f, target);
      }
    }
  }

  // --- 3. archive leakage ----------------------------------------------------
  const logsDir = path.join(root, opts.logsRel);
  let records = [];
  try { records = fs.readdirSync(logsDir); } catch { records = []; }
  const recordExists = (runId) => records.some((n) => n.startsWith(runId) && n.endsWith('.md'));

  walk(root, (p) => {
    const rel = path.relative(root, p).split(path.sep).join('/');
    if (opts.fixture && rel === FIXTURE_EXPECTED_REL) return;
    if (rel.startsWith(opts.logsRel + '/')) return;
    const bytes = fs.readFileSync(p);
    if (!isProbablyText(bytes)) return;
    const text = bytes.toString('utf8');
    const seen = new Set();
    const flag = (runId) => {
      if (seen.has(runId)) return;
      seen.add(runId);
      if (recordExists(runId)) issue('leakage', p, runId);
    };
    for (const m of text.matchAll(RUN_ID_RE)) flag(`a${m[1]}__${m[2]}`);
    for (const m of text.matchAll(FINDING_ID_RE)) flag(`a${m[2]}__${m[3]}`);
    for (const m of text.matchAll(LOG_PATH_RE)) flag(m[1]);
  }, opts.leakSkipDir);

  // --- 4. orphans --------------------------------------------------------------
  // A record is a standard code or A16 subcode plus the minute opened. A review
  // adds __review__<reviewer>. logs/README.md never matches, so it stays
  // checkable.
  const recordRe = AUDIT_RECORD_RE;
  const universe = mdFiles.filter((f) => {
    const rel = path.relative(root, f).split(path.sep).join('/');
    return !(rel.startsWith(opts.logsRel + '/') && recordRe.test(rel));
  });
  const seeds = opts.seeds.map((s) => path.resolve(root, s)).filter((s) => fs.existsSync(s));
  const reached = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur.toLowerCase().endsWith('.md')) continue;
    const dir = path.dirname(cur);
    const { prose } = docOf(cur);
    for (const raw of collectLinkTargets(prose).targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      const pathPart = raw.split('#')[0];
      if (!pathPart) continue;
      const r = resolveCaseSensitive(dir, decodeURIComponent(pathPart));
      if (r.ok) {
        const abs = path.resolve(r.actual);
        if (!reached.has(abs) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          reached.add(abs);
          queue.push(abs);
        }
      }
    }
  }
  for (const f of universe) {
    const abs = path.resolve(f);
    if (reached.has(abs)) continue;
    const rel = path.relative(root, f).split(path.sep).join('/');
    const exempt = ORPHAN_EXEMPT.find(([re]) => re.test(rel));
    if (exempt) continue;
    issue('orphan', f, '');
  }

  // --- 5. source/documentation contracts ------------------------------------
  if (!opts.fixture) {
    const tokenMeterPath = path.join(root, 'src', 'ui', 'chat', 'TokenMeter.tsx');
    const tokenMeter = fs.readFileSync(tokenMeterPath, 'utf8');
    if (/\bcompletion_tokens\b/.test(tokenMeter)) {
      issue(
        'token-meter-usage-input',
        tokenMeterPath,
        'completion_tokens',
        'provider response usage must not replace retained conversation fields',
      );
    }

    const requiredRows = [
      'Foundation tools',
      'File I/O &amp; shell',
      'Web Access',
      'Whiteboard',
      'Help, history &amp; skills',
      'Other tools',
    ];
    for (const row of requiredRows) {
      if (!tokenMeter.includes(`label="${row}"`)) {
        issue('token-meter-taxonomy', tokenMeterPath, row);
      }
    }

    const providerProjectionImport = 'provider-history-projection';
    const projectionConsumers = [
      tokenMeterPath,
      path.join(root, 'src', 'modules', 'llm-client', 'adapters', 'openai-responses.ts'),
      path.join(root, 'src', 'modules', 'llm-client', 'adapters', 'anthropic.ts'),
    ];
    for (const consumer of projectionConsumers) {
      const source = fs.readFileSync(consumer, 'utf8');
      if (!source.includes(providerProjectionImport)) {
        issue(
          'provider-history-projection-consumer',
          consumer,
          providerProjectionImport,
          'request adapters and TokenMeter must share provider replay selection',
        );
      }
    }
    const accountingDocs = [
      path.join(root, 'docs', 'architecture.md'),
      path.join(root, 'docs', 'data-model.md'),
      path.join(root, 'docs', 'streaming.md'),
    ];
    for (const doc of accountingDocs) {
      const prose = fs.readFileSync(doc, 'utf8');
      if (!/assistant-turn|provider-history projection|provider-history-projection/i.test(prose)) {
        issue('turn-accounting-doc', doc, 'assistant-turn/provider-history projection');
      }
    }
  }

  issues.sort((a, b) => (a.file + a.kind + a.target).localeCompare(b.file + b.kind + b.target));
  return issues;
}

// ---------------------------------------------------------------------------

function main() {
  const fixture = process.argv.includes('--fixture');
  const fixtureSource = path.join(path.dirname(SELF), 'fixtures', 'docs-sync-check');
  let fixtureTemp = null;
  let root = REPO_ROOT;
  if (fixture) {
    fixtureTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-docs-sync-'));
    root = path.join(fixtureTemp, 'docs-sync-check');
    fs.cpSync(fixtureSource, root, { recursive: true });
    // Reproduce linked-worktree metadata. The existing fixture record makes
    // the run id a leakage finding if the pointer is ever scanned as corpus.
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: C:/tmp/a99__202601010101\n');
  }
  const finish = (code) => {
    if (fixtureTemp) fs.rmSync(fixtureTemp, { recursive: true, force: true });
    process.exit(code);
  };

  const issues = runChecks(root, fixture
    ? {
        fixture: true,
        logsRel: 'logs',
        seeds: ['good.md'],
        skipDir: null,
        leakSkipDir: null,
      }
    : {
        fixture: false,
        logsRel: path.join('docs', 'audits', 'logs').split(path.sep).join('/'),
        seeds: [
          'README.md',
          path.join('docs', 'README.md'),
          path.join('docs', 'audits', 'README.md'),
          path.join('docs', 'audits', 'logs', 'README.md'),
          path.join('scripts', 'README.md'),
        ],
        // Extracted 7z fixture outputs carry a `.extracted-ok` sentinel and
        // are disposable copies of real exports — real conversations that
        // legitimately quote audit ids — so they are not corpus.
        skipDir: (p) =>
          path.basename(p) === 'docs-sync-check' ||
          fs.existsSync(path.join(p, '.extracted-ok')),
        leakSkipDir: (p) =>
          path.resolve(p) === path.join(root, 'log')
          || fs.existsSync(path.join(p, '.extracted-ok')),
      });

  if (fixture) {
    const expected = JSON.parse(fs.readFileSync(path.join(root, 'expected.json'), 'utf8')).issues;
    const norm = (xs) => JSON.stringify(xs.map((x) => [x.kind, x.file, x.target]).sort());
    if (norm(issues) === norm(expected)) {
      console.log(`FIXTURE PASS — ${issues.length} known issues detected, exactly matching expected.json`);
      finish(0);
    }
    console.error('FIXTURE FAIL — issue set differs from expected.json');
    console.error('got:');
    for (const i of issues) console.error(`  ${i.kind}\t${i.file}\t${i.target}${i.extra ? `\t(${i.extra})` : ''}`);
    console.error('expected:');
    for (const i of expected) console.error(`  ${i.kind}\t${i.file}\t${i.target}`);
    finish(1);
  }

  if (issues.length === 0) {
    console.log('docs-sync: clean — links, anchors, source paths, record names, leakage, orphans, and source/docs contracts pass');
    finish(0);
  }
  console.error(`docs-sync: ${issues.length} issue(s)`);
  for (const i of issues) {
    console.error(`  ${i.kind.padEnd(15)} ${i.file}${i.target ? `  ->  ${i.target}` : ''}${i.extra ? `  (${i.extra})` : ''}`);
  }
  finish(1);
}

main();
