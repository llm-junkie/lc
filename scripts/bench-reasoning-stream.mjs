/**
 * Long-reasoning streaming benchmark.
 *
 * Measures the length-dependent UI-thread work behind a reasoning-heavy turn:
 *
 *   A. TokenMeter's exact production `computeTokenBreakdown` path while one
 *      assistant reasoning field grows append-only. Settled-message counts are
 *      warmed before timing so the result isolates the changing field.
 *   B. A sequential append simulation using one production token-count memo.
 *   C. The production reasoning chunk splitter on growing prefixes.
 *   D. A synchronous SSR proxy for the dangerous single-growing-chunk shape
 *      (one paragraph with no legal chunk boundary). This uses the core
 *      production remark/rehype chain; browser DOM/layout is deliberately out
 *      of scope and must be checked separately.
 *   E. Hostile Markdown shapes at the growing-chunk Markdown limit.
 *   F. Delayed archived tool results that stress ownership lookup.
 *   G. Unbroken and unfinished-block append scaling through the live cap.
 *   H. Whole-transcript TokenMeter scaling past the render memo cap.
 *   I. Pre-arm reasoning-loop detector work on the 8 MiB live fixture.
 *   J. Append-aware reasoning visibility checks on the 8 MiB live fixture.
 *   K. Bounded terminal token counting on unbroken 1 to 8 MiB fields.
 *   L. Tokenizer-guard boundary shapes immediately below, at, and above the
 *      1,024-character sampling threshold.
 *   M. Canonical terminal estimates across provider delta sizes.
 *
 * The fixture is the merged production archive. The benchmark explicitly
 * selects `LC - A13 by Qwen 3.8 Max`, whose two largest reasoning fields are
 * ~549K and ~895K characters. The script reports measurements and asserts the
 * live rescan bound for unbroken and unfinished-block inputs.
 *
 * Run from the repository root:
 *   node --import tsx scripts/bench-reasoning-stream.mjs
 */

import assert from 'node:assert/strict';
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
import { encode } from 'gpt-tokenizer';
import { TokenCounter } from '../src/modules/chat-pipeline/token-counter.ts';
import {
  computeTokenBreakdown,
  createTokenCountMemo,
} from '../src/ui/chat/TokenMeter.tsx';
import { escapeNonMathDollars } from '../src/utils/escapeNonMathDollars.ts';
import {
  LIVE_MARKDOWN_RESCAN_LIMIT_CHARS,
  splitReasoningIntoChunks,
  updateReasoningChunkState,
} from '../src/utils/reasoningChunks.ts';
import { ReasoningLoopDetector } from '../src/utils/reasoning-loop-detector.ts';
import { countTokens } from '../src/utils/tokens.ts';
import {
  appendReasoningDelta,
  messageHasVisibleReasoning,
} from '../src/utils/reasoning-content.ts';
import {
  LIVE_MARKDOWN_TAIL_LIMIT_CHARS,
  selectLiveMarkdownChunkWindow,
} from '../src/utils/reasoningPreview.ts';
import {
  CHAT_ARCHIVE,
  ensureExtracted,
  extractedDir,
} from './fixture-lc-archives.mjs';

const REASONING_CONVERSATION_ID = 'd50a0eb2-075e-4f21-91a6-47189d7891a2';
const PREFIX_SIZES = [32_768, 65_536, 131_072, 262_144, 524_288];
const APPEND_STEP = 4_096;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function fmtMs(ms) {
  return ms >= 10 ? `${ms.toFixed(1)} ms` : `${ms.toFixed(2)} ms`;
}

function sourceLength(message) {
  return typeof message?.reasoning === 'string' ? message.reasoning.length : 0;
}

await ensureExtracted();
const fixturePath = join(extractedDir(CHAT_ARCHIVE), 'conversations.json');
const archive = JSON.parse(readFileSync(fixturePath, 'utf8'));
const conversation = archive.conversations.find(
  (candidate) => candidate.id === REASONING_CONVERSATION_ID,
);
if (!conversation) {
  throw new Error(`Missing reasoning benchmark conversation: ${REASONING_CONVERSATION_ID}`);
}
const reasoningMessages = conversation.messages
  .filter((message) => sourceLength(message) > 0)
  .sort((a, b) => sourceLength(b) - sourceLength(a));
const sourceMessage = reasoningMessages[0];
const sourceIndex = conversation.messages.findIndex((message) => message.id === sourceMessage.id);
const source = sourceMessage.reasoning;
const sizes = [...PREFIX_SIZES.filter((size) => size < source.length), source.length];

const baseMessages = conversation.messages
  .slice(0, sourceIndex + 1)
  .map((message, index) => index === sourceIndex
    ? { ...message, usage: undefined, reasoning: '' }
    : message);
const baseConversation = {
  ...conversation,
  messages: baseMessages,
  messageCount: baseMessages.length,
};

function withReasoning(text) {
  return {
    ...baseConversation,
    messages: baseConversation.messages.map((message, index) => index === sourceIndex
      ? { ...message, reasoning: text }
      : message),
  };
}

function warmSettledCounts(memo) {
  computeTokenBreakdown(baseConversation, 256_000, 200, false, true, 0, memo);
}

function measureTokenMeterPrefix(text, runs = 5) {
  const samples = [];
  let totalUsed = 0;
  for (let pass = 0; pass < runs; pass += 1) {
    const memo = createTokenCountMemo();
    warmSettledCounts(memo);
    const active = withReasoning(text);
    const start = performance.now();
    totalUsed = computeTokenBreakdown(active, 256_000, 200, false, true, 0, memo).totalUsed;
    samples.push(performance.now() - start);
  }
  return { ms: median(samples), totalUsed };
}

function measureSplit(text, runs = 7) {
  const samples = [];
  let chunks = [];
  for (let pass = 0; pass < runs; pass += 1) {
    const start = performance.now();
    chunks = splitReasoningIntoChunks(text);
    samples.push(performance.now() - start);
  }
  return {
    ms: median(samples),
    chunks: chunks.length,
    lastChunkChars: chunks.at(-1)?.length ?? 0,
    maxChunkChars: chunks.reduce((max, chunk) => Math.max(max, chunk.length), 0),
  };
}

console.log('=== LC long-reasoning streaming benchmark ===');
console.log(`node ${process.version} · ${process.platform} ${process.arch}`);
console.log(`fixture: ${conversation.messages.length} messages; reasoning fields: ${reasoningMessages.map(sourceLength).join(', ')} chars`);
console.log(`active source: ${source.length} chars at message index ${sourceIndex}\n`);

console.log('--- A. live TokenMeter production path (settled cache warm; median of 5) ---');
for (const size of sizes) {
  const result = measureTokenMeterPrefix(source.slice(0, size));
  console.log(
    `${String(size).padStart(8)} chars  ${fmtMs(result.ms).padStart(10)}`
    + `  ${(result.ms * 60).toFixed(0).padStart(5)} ms CPU/s at a 60 Hz render ceiling`,
  );
}

console.log(`\n--- B. sequential append simulation (${APPEND_STEP}-char store batches) ---`);
const sequentialMemo = createTokenCountMemo();
warmSettledCounts(sequentialMemo);
let sequentialCalls = 0;
let liveFinalTotal = 0;
const sequentialStart = performance.now();
for (let end = APPEND_STEP; end <= source.length; end += APPEND_STEP) {
  liveFinalTotal = computeTokenBreakdown(
    withReasoning(source.slice(0, end)),
    256_000,
    200,
    false,
    true,
    0,
    sequentialMemo,
  ).totalUsed;
  sequentialCalls += 1;
}
if (source.length % APPEND_STEP !== 0) {
  liveFinalTotal = computeTokenBreakdown(
    withReasoning(source),
    256_000,
    200,
    false,
    true,
    0,
    sequentialMemo,
  ).totalUsed;
  sequentialCalls += 1;
}
const sequentialMs = performance.now() - sequentialStart;
const finalExactStart = performance.now();
const reconciledFinalTotal = computeTokenBreakdown(
  withReasoning(source),
  256_000,
  200,
  false,
  false,
  0,
  sequentialMemo,
).totalUsed;
const finalExactMs = performance.now() - finalExactStart;
console.log(`updates                    ${sequentialCalls}`);
console.log(`total live accounting      ${fmtMs(sequentialMs)}`);
console.log(`mean per update            ${fmtMs(sequentialMs / sequentialCalls)}`);
console.log(`live-vs-final token delta  ${(liveFinalTotal - reconciledFinalTotal).toLocaleString()}`);
console.log(`final bounded reconciliation ${fmtMs(finalExactMs)}`);

console.log('\n--- C. production splitReasoningIntoChunks (median of 7) ---');
for (const size of sizes) {
  const result = measureSplit(source.slice(0, size));
  console.log(
    `${String(size).padStart(8)} chars  ${fmtMs(result.ms).padStart(10)}`
    + `  chunks=${String(result.chunks).padStart(4)}`
    + `  last=${String(result.lastChunkChars).padStart(6)}`
    + `  max=${String(result.maxChunkChars).padStart(6)}`,
  );
}

let fullSplitUpdates = 0;
let fullSplitChunks = [];
const fullSplitStart = performance.now();
for (let end = APPEND_STEP; end <= source.length; end += APPEND_STEP) {
  fullSplitChunks = splitReasoningIntoChunks(source.slice(0, end));
  fullSplitUpdates += 1;
}
if (source.length % APPEND_STEP !== 0) {
  fullSplitChunks = splitReasoningIntoChunks(source);
  fullSplitUpdates += 1;
}
const fullSplitMs = performance.now() - fullSplitStart;

let chunkState;
let incrementalUpdates = 0;
let markdownTailUpdates = 0;
let plainTailUpdates = 0;
let maxVisibleChunks = 0;
let maxVisibleChars = 0;
const incrementalStart = performance.now();
for (let end = APPEND_STEP; end <= source.length; end += APPEND_STEP) {
  chunkState = updateReasoningChunkState(
    source.slice(0, end),
    chunkState,
    LIVE_MARKDOWN_RESCAN_LIMIT_CHARS,
  );
  const preview = selectLiveMarkdownChunkWindow(chunkState.chunks);
  const growingTail = preview.chunks.at(-1);
  if (growingTail?.mode === 'plain-tail') plainTailUpdates += 1;
  else markdownTailUpdates += 1;
  maxVisibleChunks = Math.max(maxVisibleChunks, preview.chunks.length);
  maxVisibleChars = Math.max(
    maxVisibleChars,
    preview.chunks.reduce((total, chunk) => total + chunk.text.length, 0),
  );
  incrementalUpdates += 1;
}
if (source.length % APPEND_STEP !== 0) {
  chunkState = updateReasoningChunkState(
    source,
    chunkState,
    LIVE_MARKDOWN_RESCAN_LIMIT_CHARS,
  );
  const preview = selectLiveMarkdownChunkWindow(chunkState.chunks);
  const growingTail = preview.chunks.at(-1);
  if (growingTail?.mode === 'plain-tail') plainTailUpdates += 1;
  else markdownTailUpdates += 1;
  maxVisibleChunks = Math.max(maxVisibleChunks, preview.chunks.length);
  maxVisibleChars = Math.max(
    maxVisibleChars,
    preview.chunks.reduce((total, chunk) => total + chunk.text.length, 0),
  );
  incrementalUpdates += 1;
}
const incrementalMs = performance.now() - incrementalStart;
console.log('\nsequential splitter + preview policy:');
console.log(`full-prefix resplit         ${fmtMs(fullSplitMs)} (${fullSplitUpdates} updates)`);
console.log(`bounded append-aware path   ${fmtMs(incrementalMs)} (${incrementalUpdates} updates)`);
console.log(`growing-tail modes          Markdown=${markdownTailUpdates}, plain-tail=${plainTailUpdates}`);
console.log(`largest live render window  ${maxVisibleChars.toLocaleString()} chars in ${maxVisibleChunks} chunks`);
console.log(`final full split chunks     ${fullSplitChunks.length}`);

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [
  rehypeRaw,
  [rehypeKatex, { output: 'htmlAndMathml', throwOnError: false }],
  [rehypePrism, { ignoreMissing: true }],
];
function renderMarkdown(text) {
  return renderToStaticMarkup(createElement(
    ReactMarkdown,
    { remarkPlugins, rehypePlugins },
    escapeNonMathDollars(text),
  ));
}
function measureMarkdown(text, runs = 3) {
  renderMarkdown(text.slice(0, Math.min(1_024, text.length)));
  const samples = [];
  let htmlChars = 0;
  for (let pass = 0; pass < runs; pass += 1) {
    const start = performance.now();
    htmlChars = renderMarkdown(text).length;
    samples.push(performance.now() - start);
  }
  return { ms: median(samples), htmlChars };
}

console.log('\n--- D. full settled Markdown risk and bounded live policy ---');
const paragraphSeed = 'Long reasoning continues with **markdown**, `inline code`, a [link](https://example.com), punctuation, and realistic prose. ';
for (const size of sizes.filter((value) => value <= 262_144)) {
  const text = paragraphSeed.repeat(Math.ceil(size / paragraphSeed.length)).slice(0, size);
  const result = measureMarkdown(text);
  const livePreview = selectLiveMarkdownChunkWindow(splitReasoningIntoChunks(text));
  const visibleChars = livePreview.chunks.reduce((total, chunk) => total + chunk.text.length, 0);
  const growingMode = livePreview.chunks.at(-1)?.mode ?? 'none';
  console.log(
    `${String(size).padStart(8)} chars  ${fmtMs(result.ms).padStart(10)}`
    + `  html=${result.htmlChars.toLocaleString()} chars`
    + `  live=${growingMode}:${visibleChars.toLocaleString()}`,
  );
}

function fitSeed(seed, size = LIVE_MARKDOWN_TAIL_LIMIT_CHARS) {
  return seed.repeat(Math.ceil(size / seed.length)).slice(0, size);
}

function fitOpenBlock(open, body, size = LIVE_MARKDOWN_TAIL_LIMIT_CHARS) {
  return (open + fitSeed(body, size)).slice(0, size);
}

const hostileMarkdown = [
  ['prose', fitSeed(paragraphSeed)],
  ['unbroken', 'x'.repeat(LIVE_MARKDOWN_TAIL_LIMIT_CHARS)],
  ['base64-like', fitSeed('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA')],
  ['nested quote', fitSeed('> > > > > > > > nested **reasoning**\n')],
  ['table', fitSeed('| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n')],
  ['unfinished fence', fitOpenBlock('```ts\n', 'const value = { nested: true };\n')],
  ['unfinished math', fitOpenBlock('$$\n', 'x_1 + x_2 + \\frac{a}{b}\n')],
];

console.log(`\n--- E. hostile growing Markdown chunk (${LIVE_MARKDOWN_TAIL_LIMIT_CHARS}-char limit) ---`);
for (const [label, text] of hostileMarkdown) {
  const chunks = splitReasoningIntoChunks(text);
  const preview = selectLiveMarkdownChunkWindow(chunks);
  const growingTail = preview.chunks.at(-1);
  const result = measureMarkdown(growingTail?.text ?? '');
  const beyond = selectLiveMarkdownChunkWindow([
    `${text}x`,
  ]).chunks.at(-1);
  console.log(
    `${label.padEnd(18)} ${fmtMs(result.ms).padStart(10)}`
    + `  html=${result.htmlChars.toLocaleString()} chars`
    + `  live=${growingTail?.mode}:${growingTail?.text.length.toLocaleString()}`
    + `  next=${beyond?.mode}`,
  );
}

function delayedToolHistory(pairCount) {
  const assistants = Array.from({ length: pairCount }, (_, index) => ({
    id: `delayed-assistant-${index}`,
    role: 'assistant',
    content: '',
    createdAt: index,
    tool_calls: [{
      id: `delayed-call-${index}`,
      name: 'lc_read_file',
      arguments: '{}',
    }],
  }));
  const results = Array.from({ length: pairCount }, (_, index) => ({
    id: `delayed-result-${index}`,
    role: 'tool',
    content: 'archived result',
    createdAt: pairCount + index,
    tool_call_id: `delayed-call-${index}`,
  }));
  return {
    ...baseConversation,
    id: `delayed-tool-history-${pairCount}`,
    messages: [...assistants, ...results],
  };
}

console.log('\n--- F. archived Tool History owner index (median of 5) ---');
for (const pairCount of [250, 500, 1_000, 2_000, 4_000]) {
  const delayed = delayedToolHistory(pairCount);
  const memo = createTokenCountMemo();
  const coldStart = performance.now();
  computeTokenBreakdown(delayed, 256_000, 0, true, false, 0, memo);
  const coldMs = performance.now() - coldStart;
  const samples = [];
  for (let pass = 0; pass < 5; pass += 1) {
    const start = performance.now();
    computeTokenBreakdown(delayed, 256_000, 0, true, false, 0, memo);
    samples.push(performance.now() - start);
  }
  console.log(
    `${String(pairCount).padStart(5)} assistant/result pairs`
    + `  cold=${fmtMs(coldMs).padStart(10)}`
    + `  warm=${fmtMs(median(samples)).padStart(10)}`,
  );
}

function measureBoundedAppendShape(text) {
  let state;
  let updates = 0;
  const start = performance.now();
  for (let end = APPEND_STEP; end <= text.length; end += APPEND_STEP) {
    state = updateReasoningChunkState(
      text.slice(0, end),
      state,
      LIVE_MARKDOWN_RESCAN_LIMIT_CHARS,
    );
    updates += 1;
  }
  if (text.length % APPEND_STEP !== 0) {
    state = updateReasoningChunkState(
      text,
      state,
      LIVE_MARKDOWN_RESCAN_LIMIT_CHARS,
    );
    updates += 1;
  }
  const ms = performance.now() - start;
  const rescanChars = state.source.length - state.tailStart;
  assert.ok(
    rescanChars <= LIVE_MARKDOWN_RESCAN_LIMIT_CHARS,
    'live rescan ' + rescanChars + ' exceeds ' + LIVE_MARKDOWN_RESCAN_LIMIT_CHARS,
  );
  return {
    ms,
    updates,
    rescanChars,
    omittedLiveChars: state.omittedLiveChars,
  };
}

console.log('\n--- G. bounded unbroken and unfinished-block append scaling ---');
for (const mebibytes of [1, 2, 4, 8]) {
  const chars = mebibytes * 1_024 * 1_024;
  const unbroken = measureBoundedAppendShape('x'.repeat(chars));
  const fencePrefix = String.fromCharCode(96).repeat(3) + 'text\n';
  const unfinishedFence = measureBoundedAppendShape(
    fencePrefix + 'x'.repeat(chars - fencePrefix.length),
  );
  console.log(
    mebibytes + ' MiB'
    + '  unbroken=' + fmtMs(unbroken.ms)
    + '  fence=' + fmtMs(unfinishedFence.ms)
    + '  updates=' + unbroken.updates
    + '  rescan=' + unbroken.rescanChars.toLocaleString()
    + '  omitted=' + unbroken.omittedLiveChars.toLocaleString(),
  );
}

function highCountConversation(messageCount, contentChars = 60) {
  const messages = Array.from({ length: messageCount }, (_, index) => {
    const prefix = 'message ' + index + ' ';
    return {
      id: 'high-count-' + index,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: prefix + 'x'.repeat(Math.max(0, contentChars - prefix.length)),
      createdAt: index,
      sortOrder: index + 1,
    };
  });
  return {
    id: 'high-count-' + messageCount + '-' + contentChars,
    title: 'High-count TokenMeter fixture',
    createdAt: 0,
    updatedAt: 0,
    params: {},
    messages,
    messageCount,
  };
}

console.log('\n--- H. whole-transcript TokenMeter past the 4,096-entry memo cap ---');
console.log('shape: alternating user/assistant messages, 60 content characters each');
for (const messageCount of [8_000, 16_000, 32_000, 64_000]) {
  const highCount = highCountConversation(messageCount);
  const memo = createTokenCountMemo();
  computeTokenBreakdown(highCount, 256_000, 200, false, false, 0, memo);
  const samples = [];
  for (let passIndex = 0; passIndex < 5; passIndex += 1) {
    const start = performance.now();
    computeTokenBreakdown(highCount, 256_000, 200, false, false, 0, memo);
    samples.push(performance.now() - start);
  }
  console.log(
    String(messageCount).padStart(6) + ' messages'
    + '  warm=' + fmtMs(median(samples))
    + '  memo=' + memo.byMessage.size.toLocaleString(),
  );
}

console.log('\n--- I. pre-arm reasoning-loop detector work ---');
const detectorChunk = 'x'.repeat(APPEND_STEP);
for (const mebibytes of [1, 2, 4, 8]) {
  const detector = new ReasoningLoopDetector();
  const updates = mebibytes * 1_024 * 1_024 / APPEND_STEP;
  const start = performance.now();
  for (let index = 0; index < updates; index += 1) {
    detector.feedReasoning(detectorChunk, index * 8);
  }
  const ms = performance.now() - start;
  assert.equal(detector.state().armed, false);
  assert.equal(detector.state().reasoningChars, mebibytes * 1_024 * 1_024);
  console.log(
    mebibytes + ' MiB'
    + '  pre-arm=' + fmtMs(ms)
    + '  updates=' + updates,
  );
}

console.log('\n--- J. append-aware live reasoning visibility ---');
for (const mebibytes of [1, 2, 4, 8]) {
  let message = {};
  const updates = mebibytes * 1_024 * 1_024 / APPEND_STEP;
  const start = performance.now();
  for (let index = 0; index < updates; index += 1) {
    message = appendReasoningDelta(message, detectorChunk);
    for (let check = 0; check < 4; check += 1) {
      assert.equal(messageHasVisibleReasoning(message), true);
    }
  }
  const ms = performance.now() - start;
  assert.equal(message.reasoning.length, mebibytes * 1_024 * 1_024);
  console.log(
    mebibytes + ' MiB'
    + '  append+presence=' + fmtMs(ms)
    + '  updates=' + updates,
  );
}

console.log('\n--- K. bounded terminal token count for unbroken fields ---');
for (const mebibytes of [1, 2, 4, 8]) {
  const text = 'x'.repeat(mebibytes * 1_024 * 1_024);
  const samples = [];
  let tokens = 0;
  for (let passIndex = 0; passIndex < 5; passIndex += 1) {
    const start = performance.now();
    tokens = countTokens(text);
    samples.push(performance.now() - start);
  }
  assert.ok(tokens > 0);
  console.log(
    mebibytes + ' MiB'
    + '  count=' + fmtMs(median(samples))
    + '  tokens=' + tokens.toLocaleString(),
  );
}

console.log('\n--- L. tokenizer-guard sampling boundary ---');
for (const mebibytes of [1, 2, 4, 8]) {
  const totalChars = mebibytes * 1_024 * 1_024;
  for (const runChars of [1_023, 1_024, 1_025]) {
    const block = `${'x'.repeat(runChars)} `;
    const text = block.repeat(Math.ceil(totalChars / block.length)).slice(0, totalChars);
    const start = performance.now();
    const tokens = countTokens(text);
    const ms = performance.now() - start;
    assert.ok(tokens > 0);
    console.log(
      mebibytes + ' MiB'
      + '  run=' + runChars.toLocaleString()
      + '  count=' + fmtMs(ms)
      + '  tokens=' + tokens.toLocaleString(),
    );
  }
}

console.log('\n--- M. terminal estimate independence from provider delta size ---');
const terminalFixture = 'hello world '
  .repeat(Math.ceil((300 * 1_024) / 12))
  .slice(0, 300 * 1_024);
const terminalExact = encode(
  terminalFixture,
  { disallowedSpecial: new Set() },
).length;
const terminalEstimates = new Set();
for (const deltaChars of [1, 4, 16, 256, 4_096]) {
  const counter = new TokenCounter();
  counter.reset();
  for (let start = 0; start < terminalFixture.length; start += deltaChars) {
    counter.feedContent(terminalFixture.slice(start, start + deltaChars));
  }
  const estimate = counter.terminalTokens(terminalFixture);
  terminalEstimates.add(estimate);
  const errorPercent = Math.abs(estimate - terminalExact) / terminalExact * 100;
  assert.ok(errorPercent < 2);
  console.log(
    'delta=' + deltaChars.toLocaleString().padStart(5)
    + '  live=' + counter.totalTokens().toLocaleString().padStart(7)
    + '  terminal=' + estimate.toLocaleString().padStart(7)
    + '  error=' + errorPercent.toFixed(2) + '%',
  );
}
assert.equal(terminalEstimates.size, 1);

console.log('\nCPU-only benchmark: browser commit, DOM retention, layout, paint, and interaction latency are out of scope.');
console.log('=== end ===');
