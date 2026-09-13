import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ASK_USER_INPUT_SCHEMA,
  ASK_USER_OUTPUT_SCHEMA,
  MAX_ASK_USER_CHOICE_DESCRIPTION_CHARS,
  MAX_ASK_USER_CHOICE_TITLE_CHARS,
  MAX_ASK_USER_CUSTOM_ANSWER_CHARS,
  MAX_ASK_USER_QUESTION_CHARS,
  type AskUserInput,
  type AskUserInteraction,
} from './ask-user.ts';
import { askUser } from './builtin/ask_user.ts';
import type { ToolHandlerContext } from './types';

const validInput: AskUserInput = {
  questions: [{
    id: 7,
    question: 'Which format should LC use?',
    choices: [
      { title: 'Markdown', description: 'Keep the result easy to edit.' },
      { title: 'Plain text' },
    ],
  }],
};

function context(askUser?: AskUserInteraction): ToolHandlerContext {
  return { askUser } as ToolHandlerContext;
}

describe('lc_ask_user contract', () => {
  it('normalizes valid model input and omits absent descriptions', () => {
    assert.deepEqual(ASK_USER_INPUT_SCHEMA.parse({
      questions: [{
        id: 7,
        question: '  Which format should LC use?  ',
        choices: [
          { title: '  Markdown  ', description: '  Keep the result easy to edit.  ' },
          { title: '  Plain text  ' },
        ],
      }],
    }), validInput);
  });

  it('accepts the minimum and maximum bounds', () => {
    assert.equal(ASK_USER_INPUT_SCHEMA.safeParse(validInput).success, true);
    assert.equal(ASK_USER_INPUT_SCHEMA.safeParse({
      questions: Array.from({ length: 3 }, (_, questionIndex) => ({
        id: questionIndex + 1,
        question: 'Q'.repeat(MAX_ASK_USER_QUESTION_CHARS),
        choices: Array.from({ length: 5 }, (_, choiceIndex) => ({
          title: `${choiceIndex}${'T'.repeat(MAX_ASK_USER_CHOICE_TITLE_CHARS - 1)}`,
          description: 'D'.repeat(MAX_ASK_USER_CHOICE_DESCRIPTION_CHARS),
        })),
      })),
    }).success, true);
    assert.equal(ASK_USER_OUTPUT_SCHEMA.safeParse({
      answers: [{ id: 1, answer: 'A'.repeat(MAX_ASK_USER_CUSTOM_ANSWER_CHARS) }],
    }).success, true);
  });

  it('rejects strict-key, bound, duplicate-id, and duplicate-title failures', () => {
    const invalid = [
      { ...validInput, extra: true },
      { questions: [] },
      { questions: [...validInput.questions, ...validInput.questions, ...validInput.questions] },
      { questions: [{ ...validInput.questions[0], id: 0 }] },
      { questions: [{ ...validInput.questions[0], question: '' }] },
      { questions: [{ ...validInput.questions[0], choices: [{ title: 'Only one' }] }] },
      { questions: [{ ...validInput.questions[0], choices: [
        { title: 'Same' },
        { title: ' Same ' },
      ] }] },
      { questions: [validInput.questions[0], { ...validInput.questions[0] }] },
      { questions: [{
        ...validInput.questions[0],
        choices: [{ title: 'First', extra: true }, { title: 'Second' }],
      }] },
    ];
    for (const sample of invalid) {
      assert.equal(ASK_USER_INPUT_SCHEMA.safeParse(sample).success, false, JSON.stringify(sample));
    }
  });

  it('returns user answers in the existing envelope', async () => {
    const output = await askUser.run(validInput, context(async () => ({
      decision: 'submitted',
      data: { answers: [{ id: 7, answer: 'Markdown' }] },
    })));
    assert.deepEqual(output, {
      status: 'ok',
      data: { answers: [{ id: 7, answer: 'Markdown' }] },
      issues: [],
      warnings: [],
    });
  });

  it('returns explicit skips as successful answers', async () => {
    const output = await askUser.run(validInput, context(async () => ({
      decision: 'submitted',
      data: { answers: [{ id: 7, skipped: true }] },
    })));
    assert.equal(output.status, 'ok');
    assert.deepEqual(output.data, { answers: [{ id: 7, skipped: true }] });
  });

  it('maps missing, unavailable, busy, and aborted interaction states', async () => {
    const missing = await askUser.run(validInput, context());
    assert.equal(missing.status, 'error');
    assert.equal(missing.issues[0].code, 'ask_user_ui_unavailable');
    assert.equal(missing.issues[0].retryable, true);

    const unavailable = await askUser.run(validInput, context(async () => ({ decision: 'unavailable' })));
    assert.equal(unavailable.issues[0].code, 'ask_user_ui_unavailable');

    const busy = await askUser.run(validInput, context(async () => ({ decision: 'busy' })));
    assert.equal(busy.issues[0].code, 'ask_user_ui_busy');
    assert.equal(busy.issues[0].retryable, false);

    const aborted = await askUser.run(validInput, context(async () => ({ decision: 'aborted' })));
    assert.equal(aborted.status, 'aborted');
    assert.equal(aborted.issues[0].code, 'aborted');
  });
});
