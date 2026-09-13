import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ReasoningLoopDetector } from './reasoning-loop-detector.ts';

// Keep the regression fixture deterministic and self-contained. The captured
// log can be replayed manually, but the test must not depend on a disposable
// conversation export remaining in the repository.
const repeatingReasoningBlock = [
  'I have already tested the current tools, but I should systematically test every remaining tool.',
  'The checklist is unchanged, so I will re-evaluate the same filesystem, shell, web, and image steps.',
  'I need to continue the test plan before producing a final response.',
].join('\n');
const generatedLoopFixture = repeatingReasoningBlock.repeat(800);

function replay(
  text: string,
  detector: ReasoningLoopDetector,
  chunkSizes: number[],
  millisecondsPerChar = 0.5,
): ReturnType<ReasoningLoopDetector['state']> {
  let offset = 0;
  let chunkIndex = 0;
  while (offset < text.length && !detector.state().triggered) {
    const size = chunkSizes[chunkIndex % chunkSizes.length];
    const end = Math.min(text.length, offset + size);
    detector.feedReasoning(text.slice(offset, end), end * millisecondsPerChar);
    offset = end;
    chunkIndex++;
  }
  return detector.state();
}

describe('standalone reasoning loop detector', () => {
  test('fires on a generated infinite-reasoning fixture', () => {
    for (const chunkSizes of [[1, 7, 31, 127], [113, 17, 409, 3], [997, 64, 19]]) {
      const detector = new ReasoningLoopDetector();
      const state = replay(generatedLoopFixture, detector, chunkSizes);
      assert.equal(state.triggered, true, `chunk pattern ${chunkSizes.join(',')}`);
      assert.equal(state.finishReason, 'infinite_reasoning_loop');
      assert.equal(state.matchedBlocks, 5);
    }
  });

  test('does not fire on long non-repeating reasoning', () => {
    const unique = Array.from({ length: 12_000 }, (_, i) => `thought-${i}-new-observation-${(i * 7919) % 104729}`).join(' ');
    const detector = new ReasoningLoopDetector({ armAfterMs: 0, blockSize: 64 });
    const state = replay(unique, detector, [1, 23, 97]);
    assert.equal(state.triggered, false);
  });

  test('does not normalize reasoning received before the grace period', () => {
    const detector = new ReasoningLoopDetector();
    const internals = detector as unknown as {
      consumeNormalizedChar: (char: string) => void;
    };
    internals.consumeNormalizedChar = () => {
      throw new Error('pre-arm reasoning must not be normalized');
    };

    const text = 'x'.repeat(8 * 1_024 * 1_024);
    assert.doesNotThrow(() => detector.feedReasoning(text, 0));
    assert.equal(detector.state().reasoningChars, text.length);
    assert.equal(detector.state().armed, false);

    let postArmChars = 0;
    internals.consumeNormalizedChar = () => { postArmChars += 1; };
    detector.feedReasoning('anchor', 60_000);
    assert.equal(detector.state().armed, true);
    assert.equal(postArmChars, 6);
  });

  test('resets when visible content arrives', () => {
    const detector = new ReasoningLoopDetector({ armAfterMs: 100, blockSize: 8 });
    detector.feedReasoning('ABCDEFGH', 0);
    detector.feedContent('partial answer');
    detector.feedReasoning('ABCDEFGHABCDEFGHABCDEFGHABCDEFGHABCDEFGH', 1);
    assert.equal(detector.state().triggered, false);
  });

  test('resets when a tool call arrives', () => {
    const detector = new ReasoningLoopDetector({ armAfterMs: 100, blockSize: 8 });
    detector.feedReasoning('ABCDEFGH', 0);
    detector.feedToolCall();
    detector.feedReasoning('ABCDEFGHABCDEFGHABCDEFGHABCDEFGHABCDEFGH', 1);
    assert.equal(detector.state().triggered, false);
  });

  test('normalizes whitespace across artificial stream boundaries', () => {
    const detector = new ReasoningLoopDetector({ armAfterMs: 0, blockSize: 32, requiredBlocks: 3 });
    const text = 'alpha   beta\n gamma\t'.repeat(40);
    const state = replay(text, detector, [2, 3, 5, 7]);
    assert.equal(state.triggered, true);
    assert.equal(state.matchedBlocks, 3);
  });

  test('confirms the complete five-block sequence before triggering', () => {
    const detector = new ReasoningLoopDetector({ armAfterMs: 0, blockSize: 4, requiredBlocks: 5 });
    const blocks = ['A001', 'B002', 'C003', 'D004', 'E005'];

    // The first five cycles establish 001 through 005. Capturing 005 alone
    // must not terminate the stream.
    let now = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      for (const block of blocks) detector.feedReasoning(block, now++);
    }
    assert.equal(detector.state().matchedBlocks, 5);
    assert.equal(detector.state().triggered, false);

    // Only the next complete 001+002+003+004+005 sequence confirms the loop.
    for (const block of blocks) detector.feedReasoning(block, now++);
    assert.equal(detector.state().triggered, true);
    assert.equal(detector.state().finishReason, 'infinite_reasoning_loop');
  });
});
