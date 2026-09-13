import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPLETED_REASONING_INITIAL_WINDOW_CHARS,
  LIVE_MARKDOWN_TAIL_LIMIT_CHARS,
  LIVE_MARKDOWN_WINDOW_CHARS,
  buildReasoningChunkStarts,
  selectCompletedReasoningPreview,
  selectCompletedReasoningWindow,
  selectLiveMarkdownChunkWindow,
} from './reasoningPreview.ts';

test('a long structured stream keeps settled and growing Markdown chunks', () => {
  assert.equal(LIVE_MARKDOWN_TAIL_LIMIT_CHARS, 4_096);
  const chunks = ['a'.repeat(3_000), 'b'.repeat(3_000), 'c'.repeat(1_000)];
  const preview = selectLiveMarkdownChunkWindow(chunks);

  assert.deepEqual(preview.chunks.map((chunk) => chunk.mode), [
    'markdown',
    'markdown',
    'markdown',
  ]);
  assert.equal(preview.omittedEarlierChunks, 0);
});

test('only an oversized growing chunk falls back to plain text', () => {
  const settled = 'settled **Markdown**';
  const growing = 'x'.repeat(LIVE_MARKDOWN_TAIL_LIMIT_CHARS + 1);
  const preview = selectLiveMarkdownChunkWindow([settled, growing]);

  assert.deepEqual(preview.chunks.map((chunk) => chunk.mode), [
    'markdown',
    'plain-tail',
  ]);
  assert.equal(preview.chunks[0].text, settled);
  assert.equal(preview.chunks[1].text, growing);
});

test('the live chunk window stays bounded and retains absolute chunk indexes', () => {
  const chunks = Array.from({ length: 10 }, (_, index) => String(index).repeat(4_000));
  const preview = selectLiveMarkdownChunkWindow(chunks);

  assert.equal(preview.omittedEarlierChunks, 2);
  assert.deepEqual(
    preview.chunks.map((chunk) => chunk.chunkIndex),
    [2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.ok(
    preview.chunks.reduce((total, chunk) => total + chunk.text.length, 0)
      <= LIVE_MARKDOWN_WINDOW_CHARS,
  );
});

test('one unbounded growing chunk becomes an exact bounded plain-text tail', () => {
  const growing = 'x'.repeat(LIVE_MARKDOWN_WINDOW_CHARS * 3);
  const preview = selectLiveMarkdownChunkWindow([growing]);

  assert.equal(preview.chunks[0].mode, 'plain-tail');
  assert.equal(preview.chunks[0].text.length, LIVE_MARKDOWN_WINDOW_CHARS);
  assert.equal(
    preview.omittedGrowingTailChars,
    growing.length - LIVE_MARKDOWN_WINDOW_CHARS,
  );
});

test('finished reasoning within budget keeps the complete Markdown value', () => {
  const text = 'x'.repeat(COMPLETED_REASONING_INITIAL_WINDOW_CHARS);
  assert.deepEqual(selectCompletedReasoningPreview(text), {
    mode: 'markdown',
    text,
    omittedLeadingChars: 0,
  });
});

test('a 55K completed turn starts inside the bounded progressive window', () => {
  const text = Array.from(
    { length: 520 },
    (_, index) => `paragraph ${index} ${'word '.repeat(18)}`,
  ).join('\n\n');
  assert.ok(text.length > 55_000);

  const preview = selectCompletedReasoningPreview(text);
  assert.equal(preview.mode, 'markdown');
  assert.ok(preview.omittedLeadingChars > 0);
  assert.ok(preview.text.length <= COMPLETED_REASONING_INITIAL_WINDOW_CHARS);
  assert.equal(text.slice(preview.omittedLeadingChars), preview.text);
});

test('completed window expands to the complete Markdown source', () => {
  const text = `${'oldest paragraph '.repeat(600)}\n\nlatest paragraph`;
  const chunkStarts = buildReasoningChunkStarts(text);
  assert.deepEqual(
    selectCompletedReasoningWindow(text, text.length, chunkStarts),
    {
      mode: 'markdown',
      text,
      omittedLeadingChars: 0,
    },
  );
});

test('completed window skips the older atomic chunk instead of cutting it', () => {
  const oldest = `${'old '.repeat(700)}\n\n`;
  const fence = `\`\`\`ts\n${'const value = 1;\n'.repeat(200)}\`\`\``;
  const latest = `\n\n${'latest '.repeat(200)}`;
  const text = oldest + fence + latest;
  const targetInsideFence = latest.length + Math.floor(fence.length / 2);
  const preview = selectCompletedReasoningWindow(text, targetInsideFence);

  assert.equal(preview.mode, 'markdown');
  assert.equal(preview.omittedLeadingChars, text.indexOf('latest'));
  assert.ok(preview.text.startsWith('latest'));
  assert.ok(!preview.text.includes(fence));
});

test('a large atomic completed tail uses an exact bounded plain-text fallback', () => {
  const text = `\`\`\`txt\n${'x'.repeat(20_000)}\n\`\`\``;
  const preview = selectCompletedReasoningWindow(
    text,
    COMPLETED_REASONING_INITIAL_WINDOW_CHARS,
  );

  assert.equal(preview.mode, 'plain-tail');
  assert.equal(preview.text.length, COMPLETED_REASONING_INITIAL_WINDOW_CHARS);
  assert.equal(
    preview.omittedLeadingChars,
    text.length - COMPLETED_REASONING_INITIAL_WINDOW_CHARS,
  );
  assert.equal(text.slice(preview.omittedLeadingChars), preview.text);
});
