import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIVE_MARKDOWN_RESCAN_LIMIT_CHARS,
  splitReasoningIntoChunks,
  updateReasoningChunkState,
  type ReasoningChunkState,
} from './reasoningChunks.ts';

const LONG_PROSE = Array.from({ length: 540 }, (_, i) => `word${i}`).join(' ');
const STREAM = [
  `${LONG_PROSE}\n\nA second paragraph settles the prose chunk.`,
  '```ts\nconst value = 42;\nconsole.log(value);\n```',
  '| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n| beta | 2 |',
  '$$\nx^2 + y^2 = z^2\n$$',
  'The final paragraph is still growing.',
].join('\n\n');

test('append-aware reasoning chunks stay equivalent to a full split', () => {
  let state: ReasoningChunkState | undefined;
  for (let end = 1; end <= STREAM.length; end += 73) {
    const prefix = STREAM.slice(0, end);
    state = updateReasoningChunkState(prefix, state);
    assert.deepEqual(state.chunks, splitReasoningIntoChunks(prefix));
  }

  state = updateReasoningChunkState(STREAM, state);
  assert.deepEqual(state.chunks, splitReasoningIntoChunks(STREAM));
});

test('append-aware reasoning chunks reset exactly after replacement', () => {
  const initial = updateReasoningChunkState('first paragraph\n\nsecond');
  const replacement = 'replacement text\n\n```js\nalert(1);\n```';
  const next = updateReasoningChunkState(replacement, initial);
  assert.deepEqual(next.chunks, splitReasoningIntoChunks(replacement));
});

test('settled chunk identities are preserved across tail appends', () => {
  const prefix = `${LONG_PROSE}\n\nnext paragraph`;
  const before = updateReasoningChunkState(prefix);
  assert.ok(before.chunks.length > 1);

  const after = updateReasoningChunkState(`${prefix} keeps growing`, before);
  assert.equal(after.chunks[0], before.chunks[0]);
});

test('live unbroken appends keep the splitter tail within the render window', () => {
  const source = 'x'.repeat(8 * 1_024 * 1_024);
  let state: ReasoningChunkState | undefined;
  for (let end = 4_096; end <= source.length; end += 4_096) {
    state = updateReasoningChunkState(
      source.slice(0, end),
      state,
      LIVE_MARKDOWN_RESCAN_LIMIT_CHARS,
    );
    assert.ok(state.source.length - state.tailStart <= LIVE_MARKDOWN_RESCAN_LIMIT_CHARS);
  }

  if (!state) throw new Error('streaming updates must produce chunk state');
  assert.equal(state.boundedTail, true);
  assert.ok(state.omittedLiveChars > 0);
  assert.equal(state.chunks.at(-1)?.length, LIVE_MARKDOWN_RESCAN_LIMIT_CHARS);
});

test('live unfinished blocks reconcile exactly when streaming ends', () => {
  const source = String.fromCharCode(96).repeat(3)
    + 'text\n'
    + 'unfinished '.repeat(80_000);
  let state = updateReasoningChunkState(
    source.slice(0, 256 * 1_024),
    undefined,
    LIVE_MARKDOWN_RESCAN_LIMIT_CHARS,
  );
  state = updateReasoningChunkState(
    source,
    state,
    LIVE_MARKDOWN_RESCAN_LIMIT_CHARS,
  );

  assert.equal(state.boundedTail, true);
  assert.ok(state.source.length - state.tailStart <= LIVE_MARKDOWN_RESCAN_LIMIT_CHARS);

  const settled = updateReasoningChunkState(source, state);
  assert.equal(settled.boundedTail, false);
  assert.equal(settled.omittedLiveChars, 0);
  assert.deepEqual(settled.chunks, splitReasoningIntoChunks(source));
});
