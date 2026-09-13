/**
 * CPU hot-path measurement harness — baselines (Node).
 *
 * Measures the exact hot paths that run on the UI thread during streaming,
 * using the real production modules (gpt-tokenizer via `src/utils/tokens.ts`,
 * fflate from node_modules):
 *
 *   Section A — `countTokens` on conversation-shaped text:
 *     prose replies, reasoning, JSON-ish tool output, unbroken base64 runs.
 *   Section B — the TokenMeter per-frame workload: a full-history recount of
 *     a synthetic conversation, once (Tool History off) and twice (on).
 *   Section C — fflate `compressSync` on terminal-write-sized turns. Live
 *     checkpoints deliberately skip this synchronous work.
 *   Section D — the bounded 4,096-message to-do snapshot index.
 *   Section E — V8 parse/compile cost of the production chunks (cold-start
 *     parse proxy), plus chunk composition markers.
 *
 * Usage (from the repo root):
 *   node --experimental-strip-types scripts/bench-hot-paths.mjs
 *
 * This harness measures CPU cost only. Browser frame-time confirmation, heap
 * traces, and interaction latency cannot be obtained from Node and have to be
 * measured separately in a real browser session.
 */

import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTokens } from '../src/utils/tokens.ts';
import { buildTodoSnapshotIndex } from '../src/modules/tool-engine/todo-state.ts';
import { compressSync, strToU8 } from 'fflate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function medianMs(runs, fn) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function fmtMs(ms) {
  return ms >= 10 ? `${ms.toFixed(1)} ms` : `${ms.toFixed(2)} ms`;
}

// ── Fixtures ────────────────────────────────────────────────────────

const PARAGRAPH = [
  'The quick brown fox jumps over the lazy dog while the model streams markdown ',
  'into the bubble. This sentence contains `inline code`, *emphasis*, **strong**,\n',
  'and a [link](https://example.com) so the tokenizer sees realistic prose with\n',
  'punctuation, numbers 12345, and unicode — emoji 🚀 and CJK 测试文本 included.\n\n',
].join('');

const JSON_OUTPUT_LINE = [
  '  {\n',
  '    "id": "res_abc123", "status": "completed", "duration_ms": 842,\n',
  '    "matches": [ { "path": "C:\\work\\src\\app.ts", "lines": [12, 45, 90] } ],\n',
  '    "note": "diagnostic output from a tool result, pretty printed for the model"\n',
  '  },\n',
].join('');

const prose = (kb) => PARAGRAPH.repeat(Math.ceil((kb * 1024) / PARAGRAPH.length)).slice(0, kb * 1024);
const jsonOut = (kb) => JSON_OUTPUT_LINE.repeat(Math.ceil((kb * 1024) / JSON_OUTPUT_LINE.length)).slice(0, kb * 1024);
const unbroken = (kb) => 'A'.repeat(kb * 1024);

// Synthetic conversation (mirrors a tool-heavy real session):
//   60 user messages × 0.2 KB, 60 assistant replies × 2 KB,
//   10 reasoning turns × 3 KB, 30 prose tool results × 8 KB,
//   2 base64 image-ish tool results × 300 KB.
const CONV = {
  users: Array.from({ length: 60 }, () => prose(0.2)),
  replies: Array.from({ length: 60 }, () => prose(2)),
  reasoning: Array.from({ length: 10 }, () => prose(3)),
  toolProse: Array.from({ length: 30 }, () => jsonOut(8)),
  toolBase64: Array.from({ length: 2 }, () => unbroken(300)),
};

console.log('=== LC hot-path benchmark ===');
console.log(`node ${process.version} · ${process.platform} ${process.arch}`);
console.log(`conversation fixture: ${60 * 0.2 + 60 * 2 + 10 * 3 + 30 * 8 + 2 * 300} KB of text across 162 messages\n`);

// ── Section A: countTokens unit costs ───────────────────────────────

console.log('--- A. countTokens unit costs (median of 5) ---');
for (const [label, kb] of [['prose 100 KB', 100], ['prose 1 MB', 1024], ['json-ish tool output 300 KB', 300], ['unbroken run 1 MB (sampling guard)', 1024]]) {
  const text = label.includes('unbroken') ? unbroken(kb) : label.includes('json') ? jsonOut(kb) : prose(kb);
  const ms = medianMs(5, () => countTokens(text));
  console.log(`${label.padEnd(44)} ${fmtMs(ms)}`);
}

// ── Section B: TokenMeter per-frame workload ────────────────────────

console.log('\n--- B. TokenMeter uncached full-history baseline (pre-remediation proxy) ---');

function onePassMs() {
  let total = 0;
  const t0 = performance.now();
  for (const u of CONV.users) total += countTokens(u);
  for (const r of CONV.replies) total += countTokens(r);
  for (const g of CONV.reasoning) total += countTokens(g);
  for (const t of CONV.toolProse) total += countTokens(t);
  for (const b of CONV.toolBase64) total += countTokens(b);
  return { ms: performance.now() - t0, total };
}

const pass = medianMs(3, onePassMs);
console.log(`one uncached recount pass          ${fmtMs(pass)}`);
console.log(`two uncached recount passes        ${fmtMs(pass * 2)}`);
console.log(`legacy projection @ 60 Hz, one    ${(pass * 60).toFixed(1)} ms of CPU per second of streaming`);
console.log(`legacy projection @ 60 Hz, two    ${(pass * 2 * 60).toFixed(1)} ms of CPU per second of streaming`);

const small = { users: Array.from({ length: 5 }, () => prose(0.2)), replies: Array.from({ length: 5 }, () => prose(2)), reasoning: [], toolProse: [], toolBase64: [] };
function smallPassMs() {
  const t0 = performance.now();
  for (const u of small.users) countTokens(u);
  for (const r of small.replies) countTokens(r);
  return performance.now() - t0;
}
const smallMs = medianMs(3, smallPassMs);
console.log(`\ncontrast: 10-message conversation, uncached pass ${fmtMs(smallMs)}`);
console.log('Memoized per-frame behavior is measured separately, against a real archive.');

// ── Section C: terminal compression ─────────────────────────────────

console.log('\n--- C. terminal-write fflate compressSync cost (median of 5) ---');
for (const kb of [300, 1024, 2048]) {
  const text = prose(kb);
  const ms = medianMs(5, () => compressSync(strToU8(text)));
  console.log(`turn content ${String(kb).padStart(4)} KB        ${fmtMs(ms)}`);
}
console.log('live five-second checkpoints store plain rows and skip this synchronous cost');

// ── Section D: to-do snapshot index ─────────────────────────────────

const todoArguments = JSON.stringify({
  todos: Array.from({ length: 20 }, (_, index) => ({
    id: index + 1,
    title: `Task ${index + 1}`,
    status: index === 0 ? 'in-progress' : 'not-started',
  })),
});
const todoMessages = Array.from({ length: 2_048 }, (_, index) => {
  const callId = `todo-call-${index}`;
  return [
    {
      id: `todo-assistant-${index}`,
      role: 'assistant',
      content: '',
      createdAt: index * 2,
      tool_calls: [{ id: callId, name: 'lc_todo_write', arguments: todoArguments }],
    },
    {
      id: `todo-result-${index}`,
      role: 'tool',
      content: JSON.stringify({
        status: 'ok',
        data: { completed: 0, blocked: 0, total: 20 },
        issues: [],
        warnings: [],
      }),
      createdAt: index * 2 + 1,
      tool_call_id: callId,
    },
  ];
}).flat();
const todoIndexMs = medianMs(7, () => buildTodoSnapshotIndex(todoMessages));
console.log('\n--- D. maximum to-do snapshot index (median of 7) ---');
console.log(`${todoMessages.length} messages · 2,048 successful 20-item snapshots  ${fmtMs(todoIndexMs)}`);
console.log('production rebuilds this index on transcript structure changes, not streamed token deltas');

// ── Section E: production chunk parse cost + composition ────────────

console.log('\n--- E. production chunks (dist/assets) ---');
const assetsDir = join(ROOT, 'dist', 'assets');
let files;
try {
  files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
} catch {
  console.log('dist/assets not found — run `npm run build` first; skipping D.');
  files = [];
}

const sizes = files.map((f) => ({ name: f, size: readFileSync(join(assetsDir, f)).length }));
sizes.sort((a, b) => b.size - a.size);
const totalJs = sizes.reduce((n, s) => n + s.size, 0);
console.log(`${sizes.length} JS assets · ${(totalJs / 1048576).toFixed(2)} MiB total (uncompressed on disk)`);
console.log('\ntop 15 chunks:');
for (const s of sizes.slice(0, 15)) console.log(`  ${(s.size / 1048576).toFixed(2).padStart(7)} MiB  ${s.name}`);

// Composition markers — which big chunk holds which heavy library.
const MARKERS = [
  ['gpt-tokenizer', ['cl100k', 'r50k_base']],
  ['wawoff2/Emscripten', ['woff2.wasm', 'Emscripten']],
  ['@shikijs/oniguruma', ['@shikijs', 'oniguruma']],
  ['excalidraw', ['json.excalidraw.com', 'MERMAID_TO_EXCALIDRAW']],
  ['mermaid', ['mermaid']],
  ['dexie', ['indexedDB', 'Dexie']],
  ['refractor', ['refractor']],
  ['highlight.js', ['highlight.js', 'hljs']],
  ['katex', ['katex']],
  ['react-markdown', ['react-markdown']],
  ['tauri', ['__TAURI__']],
];
console.log('\ncomposition (chunks > 100 KB):');
for (const s of sizes.filter((x) => x.size > 100 * 1024)) {
  const body = readFileSync(join(assetsDir, s.name), 'utf8');
  const found = MARKERS.filter(([, needles]) => needles.some((n) => body.includes(n))).map(([label]) => label);
  console.log(`  ${(s.size / 1048576).toFixed(2).padStart(7)} MiB  ${s.name.padEnd(46)} ${found.join(', ') || '(no marker)'}`);
}

// Parse cost proxy: `node --check` compiles (parse + scope analysis) without
// executing. Copy to a .mjs temp file so ESM syntax is accepted.
console.log('\nparse/compile cost proxy (`node --check`, single run):');
const tmpDir = mkdtempSync(join(tmpdir(), 'lc-bench-'));
for (const s of sizes.filter((x) => x.size > 500 * 1024)) {
  const tmp = join(tmpDir, 'chunk.mjs');
  writeFileSync(tmp, readFileSync(join(assetsDir, s.name)));
  const t0 = performance.now();
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'ignore' });
    console.log(`  ${(s.size / 1048576).toFixed(2).padStart(7)} MiB  ${s.name.padEnd(46)} ${fmtMs(performance.now() - t0)}`);
  } catch {
    console.log(`  ${s.name}: --check failed (chunk may not be standalone-parseable)`);
  }
}
rmSync(tmpDir, { recursive: true, force: true });

console.log('\n=== end ===');
