import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appendReasoningDelta,
  hasVisibleReasoningText,
  messageHasVisibleReasoning,
} from './reasoning-content.ts';

describe('reasoning content presence', () => {
  it('keeps whitespace-only reasoning hidden until a visible delta arrives', () => {
    let message = appendReasoningDelta({}, ' \n\t');
    assert.equal(message.reasoning, ' \n\t');
    assert.equal(message.reasoningHasVisibleContent, false);
    assert.equal(messageHasVisibleReasoning(message), false);

    message = appendReasoningDelta(message, 'thought');
    assert.equal(message.reasoning, ' \n\tthought');
    assert.equal(message.reasoningHasVisibleContent, true);
    assert.equal(messageHasVisibleReasoning(message), true);
  });

  it('trusts the append-aware bit without inspecting the canonical prefix', () => {
    const message = {
      reasoningHasVisibleContent: true,
      get reasoning(): string {
        throw new Error('the canonical prefix must not be inspected');
      },
    };
    assert.doesNotThrow(() => messageHasVisibleReasoning(message));
    assert.equal(messageHasVisibleReasoning(message), true);
  });

  it('derives exact visibility for legacy messages and load boundaries', () => {
    assert.equal(hasVisibleReasoningText(undefined), false);
    assert.equal(hasVisibleReasoningText('  \r\n\t'), false);
    assert.equal(hasVisibleReasoningText('  visible  '), true);
    assert.equal(messageHasVisibleReasoning({ reasoning: '\nlegacy' }), true);
  });
});
