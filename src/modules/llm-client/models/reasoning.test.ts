import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReasoningEffortOpenAI } from './reasoning.ts';

describe('OpenAI reasoning effort resolution', () => {
  test('downgrades max for GPT-5.4 mini when cloud metadata omits options', () => {
    assert.equal(resolveReasoningEffortOpenAI({ id: 'gpt-5.4-mini' }, 'max'), 'xhigh');
  });

  test('preserves max for the GPT-5.6 family', () => {
    for (const id of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      assert.equal(resolveReasoningEffortOpenAI({ id }, 'max'), 'max', id);
    }
  });

  test('downgrades max for earlier GPT-5 families', () => {
    assert.equal(resolveReasoningEffortOpenAI({ id: 'gpt-5.4' }, 'max'), 'xhigh');
    assert.equal(resolveReasoningEffortOpenAI({ id: 'gpt-5.5' }, 'max'), 'xhigh');
    assert.equal(resolveReasoningEffortOpenAI({ id: 'gpt-5.3-codex' }, 'max'), 'xhigh');
    assert.equal(resolveReasoningEffortOpenAI({ id: 'gpt-5.1' }, 'max'), 'high');
    assert.equal(resolveReasoningEffortOpenAI({ id: 'gpt-5' }, 'max'), 'high');
  });

  test('honors explicit provider capability metadata', () => {
    assert.equal(
      resolveReasoningEffortOpenAI(
        { id: 'gpt-5.4-mini', capabilities: { reasoning: { allowed_options: ['low', 'medium', 'high', 'xhigh'] } } },
        'max',
      ),
      'xhigh',
    );
    assert.equal(
      resolveReasoningEffortOpenAI(
        { id: 'gpt-5.6', capabilities: { reasoning: { allowed_options: ['low', 'medium', 'high', 'xhigh', 'max'] } } },
        'max',
      ),
      'max',
    );
  });

  test('keeps unknown and local-compatible models backward compatible', () => {
    assert.equal(resolveReasoningEffortOpenAI({ id: 'deepseek-reasoner' }, 'max'), 'max');
    assert.equal(resolveReasoningEffortOpenAI(undefined, 'max'), 'max');
  });
});
