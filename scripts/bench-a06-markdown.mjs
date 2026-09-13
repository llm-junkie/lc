/**
 * A06 benchmark — synchronous markdown-pipeline cost on the real
 * merged conversation-archive fixture. It explicitly selects the production
 * `LC - Complete Tests` conversation: 218 messages and ~2.4 MiB of content,
 * including a 30K-character assistant response with current reply metadata.
 *
 * WHAT IT MEASURES
 *   The exact remark+rehype plugin chain that `MessageBubble` /
 *   `ChunkedMarkdown` run per message — remarkGfm, remarkMath, the
 *   app's sanitize/filename plugins (replicated from markdown.tsx),
 *   rehypeRaw, rehypeKatex, rehype-prism-plus — plus the
 *   `escapeNonMathDollars` pre-transform and the `countTokens` render
 *   path. Rendered single-threaded in Node via react-dom/server.
 *
 * WHAT IT DOES NOT MEASURE (deliberately)
 *   Browser commit / DOM / layout, React reconciliation timing, the
 *   CodeBlock / InlineCode / Link component render cost, or the
 *   chunked-memo behavior during streaming. This is a synthetic proxy
 *   for the dominant synchronous per-message work on first mount —
 *   NOT render-path proof (see the A06 evidence rule).
 *
 * RUN
 *   node --experimental-strip-types scripts/bench-a06-markdown.mjs
 *   Extracts the committed fixture on demand.
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import rehypePrism from 'rehype-prism-plus';
import { refractor } from 'refractor';
import { visit } from 'unist-util-visit';
import { countTokens } from '../src/utils/tokens.ts';
import { escapeNonMathDollars } from '../src/utils/escapeNonMathDollars.ts';
import {
  CHAT_ARCHIVE,
  ensureExtracted,
  extractedDir,
} from './fixture-lc-archives.mjs';

// ── App plugins replicated from src/utils/markdown.tsx ────────────
const PASSTHROUGH_LANGS = new Set(['excalidraw']);
function isKnownLang(lang) {
  if (PASSTHROUGH_LANGS.has(lang)) return true;
  if (lang.length === 1) return false;
  if (!/^[a-zA-Z][\w.#+-]{1,19}$/.test(lang)) return false;
  return refractor.registered(lang);
}
function remarkSanitizeLang() {
  return (tree) => {
    visit(tree, 'code', (node) => {
      if (node.lang && !isKnownLang(node.lang)) node.lang = '';
    });
  };
}
function rehypeSanitizeLang() {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'code') return;
      const cls = Array.isArray(node.properties?.className) ? node.properties.className : [];
      const filtered = cls.filter((c) => {
        if (typeof c !== 'string') return true;
        return isKnownLang(c.replace(/^language-/, ''));
      });
      if (filtered.length !== cls.length) {
        node.properties = { ...node.properties, className: filtered };
      }
    });
  };
}
const FILENAME_RE = /\b[\w.-]{1,120}\.(?=[a-z0-9]*[a-z])[a-z0-9]{2,10}\b/gi;
function remarkFilenames() {
  return (tree) => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent) return;
      FILENAME_RE.lastIndex = 0;
      const parts = [];
      let last = 0;
      let m;
      while ((m = FILENAME_RE.exec(node.value)) !== null) {
        if (m.index > last) parts.push({ type: 'text', value: node.value.slice(last, m.index) });
        parts.push({ type: 'inlineCode', value: m[0] });
        last = FILENAME_RE.lastIndex;
      }
      if (parts.length === 0 || index === undefined) return;
      if (last < node.value.length) parts.push({ type: 'text', value: node.value.slice(last) });
      parent.children.splice(index, 1, ...parts.map((p) =>
        p.type === 'inlineCode' ? { type: 'inlineCode', value: p.value } : { type: 'text', value: p.value },
      ));
    });
  };
}

const remarkPlugins = [remarkGfm, remarkMath, remarkSanitizeLang, remarkFilenames];
const rehypePlugins = [
  rehypeRaw,
  [rehypeKatex, { output: 'htmlAndMathml', throwOnError: false }],
  rehypeSanitizeLang,
  [rehypePrism, { ignoreMissing: true }],
];

// ── Fixture load ──────────────────────────────────────────────────
const MARKDOWN_CONVERSATION_ID = '04d18cf8-b665-41d8-b425-c7df12978b41';
await ensureExtracted();
const fixturePath = join(extractedDir(CHAT_ARCHIVE), 'conversations.json');
const data = JSON.parse(readFileSync(fixturePath, 'utf8'));
const conv = data.conversations.find((conversation) => conversation.id === MARKDOWN_CONVERSATION_ID);
if (!conv) throw new Error(`Missing markdown benchmark conversation: ${MARKDOWN_CONVERSATION_ID}`);

function textOf(m) {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' ? (p.text ?? '') : ''))
      .join('\n');
  }
  return '';
}

// What ChatView actually mounts (tool messages are filtered out).
const rendered = conv.messages.filter((m) => m.role !== 'tool').map((m) => textOf(m));
const all = conv.messages.map((m) => textOf(m));

function renderOne(text) {
  renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins, rehypePlugins }, escapeNonMathDollars(text)),
  );
}

const fmt = (ms) => `${ms.toFixed(1)} ms`;
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

// ── 1. Real rendered messages: per-message pipeline cost ──────────
console.log(`fixture: ${conv.messages.length} messages (${rendered.length} rendered, tool filtered out), ${all.join('').length} content chars\n`);

// Warm-up (JIT): render everything once, run the counter once.
for (const t of rendered) renderOne(t);
countTokens(all.join(''));

const samples = [];
for (let pass = 0; pass < 3; pass++) {
  for (const t of rendered) {
    const s = performance.now();
    renderOne(t);
    samples.push(performance.now() - s);
  }
}
const sorted = [...samples].sort((a, b) => a - b);
const totalReal = samples.reduce((a, b) => a + b, 0) / 3;
console.log(`== per-message markdown pipeline, ${rendered.length} real rendered messages (3 passes) ==`);
console.log(`  total per pass      : ${fmt(totalReal)} (one conversation open, first mount)`);
console.log(`  per-message p50     : ${fmt(pct(sorted, 50))}`);
console.log(`  per-message p95     : ${fmt(pct(sorted, 95))}`);
console.log(`  per-message max     : ${fmt(Math.max(...samples))}`);
console.log(`  per-message mean    : ${fmt(samples.reduce((a, b) => a + b, 0) / samples.length)}`);

// Biggest single message, separately.
const biggest = rendered.reduce((a, b) => (b.length > a.length ? b : a), '');
const t0 = performance.now();
renderOne(biggest);
console.log(`  largest message (${biggest.length} chars): ${fmt(performance.now() - t0)}`);

// ── 2. Scaled to F-03's n=50/100/200 question (real content, cycled) ──
console.log('\n== total synchronous pipeline work for n messages (real content, cycled) ==');
for (const n of [50, 100, 200]) {
  const seq = Array.from({ length: n }, (_, i) => rendered[i % rendered.length]);
  const s = performance.now();
  for (const t of seq) renderOne(t);
  const elapsed = performance.now() - s;
  console.log(`  n=${n}: ${fmt(elapsed)} total  (${fmt(elapsed / n)}/msg mean)`);
}

// ── 3. countTokens (render-path token counting) on the real archive ──
console.log('\n== countTokens on real archive content ==');
const sTok = performance.now();
const nTok = countTokens(all.join(''));
console.log(`  all ${all.join('').length} chars (${all.length} msgs): ${fmt(performance.now() - sTok)}, ${nTok} tokens`);
const sTok1 = performance.now();
const nTok1 = countTokens(biggest);
console.log(`  largest message (${biggest.length} chars): ${fmt(performance.now() - sTok1)}, ${nTok1} tokens`);

console.log(`\nbuild: node ${process.version}, single-threaded SSR (react-dom/server), fixture ${CHAT_ARCHIVE}, conversation ${conv.title}`);
