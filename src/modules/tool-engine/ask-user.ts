import { z } from 'zod';

export const ASK_USER_TOOL_NAME = 'lc_ask_user';
export const ASK_USER_BATCH_ISSUE = Object.freeze({
  code: 'interactive_tool_must_run_alone',
  message: 'lc_ask_user must be the only call in its batch.',
  retryable: false,
  remedy: 'Retry with one lc_ask_user call and no other calls.',
});
export const MIN_ASK_USER_QUESTIONS = 1;
export const MAX_ASK_USER_QUESTIONS = 3;
export const MIN_ASK_USER_CHOICES = 2;
export const MAX_ASK_USER_CHOICES = 5;
export const MAX_ASK_USER_QUESTION_CHARS = 240;
export const MAX_ASK_USER_CHOICE_TITLE_CHARS = 80;
export const MAX_ASK_USER_CHOICE_DESCRIPTION_CHARS = 160;
export const MAX_ASK_USER_CUSTOM_ANSWER_CHARS = 500;

export const ASK_USER_CHOICE_SCHEMA = z.object({
  title: z.string()
    .trim()
    .min(1, 'title must contain text. Add a short choice title.')
    .max(
      MAX_ASK_USER_CHOICE_TITLE_CHARS,
      `title accepts at most ${MAX_ASK_USER_CHOICE_TITLE_CHARS} characters. Shorten the choice title.`,
    )
    .describe('Give the choice a short title. LC trims leading and trailing whitespace.'),
  description: z.string()
    .trim()
    .min(1, 'description must contain text when present. Omit an empty description.')
    .max(
      MAX_ASK_USER_CHOICE_DESCRIPTION_CHARS,
      `description accepts at most ${MAX_ASK_USER_CHOICE_DESCRIPTION_CHARS} characters. Shorten the description.`,
    )
    .optional()
    .describe('Optionally explain the effect of this choice. LC trims leading and trailing whitespace.'),
}).strict();

export const ASK_USER_QUESTION_SCHEMA = z.object({
  id: z.number()
    .int('id must be an integer. Use one unique positive integer for this question.')
    .positive('id must be positive. Use one unique positive integer for this question.')
    .max(Number.MAX_SAFE_INTEGER, 'id must be a safe integer. Use a smaller positive integer.')
    .describe('Use one unique positive safe integer for this question.'),
  question: z.string()
    .trim()
    .min(1, 'question must contain text. Ask one clear question.')
    .max(
      MAX_ASK_USER_QUESTION_CHARS,
      `question accepts at most ${MAX_ASK_USER_QUESTION_CHARS} characters. Shorten the question.`,
    )
    .describe('Ask one clear question. LC trims leading and trailing whitespace.'),
  choices: z.array(ASK_USER_CHOICE_SCHEMA)
    .min(
      MIN_ASK_USER_CHOICES,
      `choices must contain at least ${MIN_ASK_USER_CHOICES} items. Add another choice.`,
    )
    .max(
      MAX_ASK_USER_CHOICES,
      `choices accepts at most ${MAX_ASK_USER_CHOICES} items. Remove extra choices.`,
    )
    .describe('Provide from 2 through 5 single-select choices.'),
}).strict().superRefine((question, context) => {
  const titles = new Map<string, number>();
  for (let index = 0; index < question.choices.length; index += 1) {
    const key = question.choices[index].title;
    const priorIndex = titles.get(key);
    if (priorIndex !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['choices', index, 'title'],
        message: `title duplicates choices.${priorIndex}.title. Use a unique title in this question.`,
      });
    } else {
      titles.set(key, index);
    }
  }
});

export const ASK_USER_INPUT_SCHEMA = z.object({
  questions: z.array(ASK_USER_QUESTION_SCHEMA)
    .min(
      MIN_ASK_USER_QUESTIONS,
      `questions must contain at least ${MIN_ASK_USER_QUESTIONS} item. Add a question.`,
    )
    .max(
      MAX_ASK_USER_QUESTIONS,
      `questions accepts at most ${MAX_ASK_USER_QUESTIONS} items. Remove extra questions.`,
    )
    .describe('Send from 1 through 3 questions. The user answers or skips each question.'),
}).strict().superRefine((input, context) => {
  const ids = new Map<number, number>();
  for (let index = 0; index < input.questions.length; index += 1) {
    const id = input.questions[index].id;
    const priorIndex = ids.get(id);
    if (priorIndex !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['questions', index, 'id'],
        message: `id ${id} duplicates questions.${priorIndex}.id. Use one unique ID for each question.`,
      });
    } else {
      ids.set(id, index);
    }
  }
});

export type AskUserInput = z.infer<typeof ASK_USER_INPUT_SCHEMA>;
export type AskUserQuestion = AskUserInput['questions'][number];
export type AskUserChoice = AskUserQuestion['choices'][number];

export const ASK_USER_ANSWER_SCHEMA = z.union([
  z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    answer: z.string().trim().min(1).max(MAX_ASK_USER_CUSTOM_ANSWER_CHARS),
  }).strict(),
  z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    skipped: z.literal(true),
  }).strict(),
]);

export const ASK_USER_OUTPUT_SCHEMA = z.object({
  answers: z.array(ASK_USER_ANSWER_SCHEMA)
    .min(MIN_ASK_USER_QUESTIONS)
    .max(MAX_ASK_USER_QUESTIONS),
}).strict();

export type AskUserAnswer = z.infer<typeof ASK_USER_ANSWER_SCHEMA>;
export type AskUserOutput = z.infer<typeof ASK_USER_OUTPUT_SCHEMA>;

export type AskUserInteractionResult =
  | { decision: 'submitted'; data: AskUserOutput }
  | { decision: 'aborted' }
  | { decision: 'unavailable' }
  | { decision: 'busy' };

export type AskUserInteraction = (input: AskUserInput) => Promise<AskUserInteractionResult>;
