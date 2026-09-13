/**
 * Type-level fixtures for the public `ResponsesSSEEvent` union.
 *
 * The Responses envelope is served in two dialects. Every event below carries
 * the fields its provider documents for that event, and each array is annotated
 * `satisfies ResponsesSSEEvent`, so **`tsc -b` fails if the exported union
 * stops describing them**.
 *
 * Be precise about what that does and does not claim. `OPENROUTER_RESPONSES_EVENTS`
 * is a literal transcription — its provider publishes complete example lines,
 * and they are pasted below. `OPENAI_RESPONSES_EVENTS` is **not**: OpenAI's
 * events carry more fields than LC reads, and `ResponsesSSEEvent` is a
 * projection rather than a full wire schema (see its own doc comment). These
 * fixtures pin the documented fields the union declares; they do not assert
 * that a union variant lists every field on the wire.
 *
 * An earlier version of this header claimed both arrays were transcriptions.
 * They were not: all three OpenAI events omitted the `sequence_number` the
 * streaming reference documents on every event, so the fixture "proved" a
 * shape narrower than the one it advertised.
 *
 * That check has to live here rather than beside the runtime tests, because
 * `tsconfig.app.json` excludes `src/**\/*.test.ts` — a fixture in a test file
 * is never type-checked and would prove nothing. Nothing in the application
 * imports this module, so it costs nothing at runtime; the streaming tests
 * consume the arrays below so one artifact carries both checks.
 *
 * Why this exists at all: the union originally described only the OpenAI
 * dialect while the adapter parsed both, and the first attempt at adding the
 * OpenRouter variants got every field wrong — an invented `item_id`, a missing
 * `response_id`, optional indices, and a terminal payload claiming an `output`
 * array the provider does not send. The runtime parser reads a separate loose
 * internal shape, so none of that turned a test red. Hence the negative cases
 * at the bottom: they are the only thing standing between this union and the
 * same drift happening again.
 *
 * @see https://openrouter.ai/docs/api_reference/responses/basic-usage
 * @see https://developers.openai.com/api/reference/resources/responses/streaming-events
 */

import type { ResponsesSSEEvent } from './types';

/**
 * OpenRouter's dialect, transcribed field for field from its basic-usage page:
 *
 *   data: {"type":"response.content_part.delta","response_id":"resp_1234567890",
 *          "output_index":0,"content_index":0,"delta":"Once"}
 *   data: {"type":"response.done","response":{"id":"resp_1234567890",
 *          "object":"response","status":"completed","usage":{…}}}
 *
 * Note the two details the first attempt got backwards: the content delta is
 * keyed by `response_id` and not `item_id`, and the terminal `response` object
 * carries no `output` array.
 */
export const OPENROUTER_RESPONSES_EVENTS = [
  {
    type: 'response.content_part.delta',
    response_id: 'resp_1234567890',
    output_index: 0,
    content_index: 0,
    delta: 'Once',
  },
  { type: 'response.reasoning.delta', delta: 'thinking it over' },
  {
    type: 'response.done',
    response: {
      id: 'resp_1234567890',
      object: 'response',
      status: 'completed',
      usage: { input_tokens: 12, output_tokens: 45, total_tokens: 57 },
    },
  },
] as const satisfies readonly ResponsesSSEEvent[];

/**
 * The OpenAI dialect of the same three jobs. `sequence_number` is on every one
 * of them because the streaming reference documents each event as carrying a
 * monotonically increasing sequence number used to order the stream — the field
 * this fixture originally left out (R-27).
 * https://developers.openai.com/api/reference/resources/responses/streaming-events
 */
export const OPENAI_RESPONSES_EVENTS = [
  {
    type: 'response.output_text.delta',
    sequence_number: 1,
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta: 'Hello',
  },
  {
    type: 'response.reasoning_text.delta',
    sequence_number: 2,
    item_id: 'rs_1',
    output_index: 0,
    content_index: 0,
    delta: 'hmm',
  },
  {
    type: 'response.completed',
    sequence_number: 3,
    response: {
      id: 'resp_1',
      object: 'response',
      created_at: 0,
      model: 'gpt-test',
      output: [],
      status: 'completed',
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    },
  },
] as const satisfies readonly ResponsesSSEEvent[];

/**
 * OpenAI's `error` event, kept out of the array above because it terminates a
 * stream rather than appearing in a healthy one. Its fields are TOP-LEVEL —
 * `code`, `message`, `param` — not nested under an `error` object (R-28).
 * https://developers.openai.com/api/reference/resources/responses/streaming-events
 */
export const OPENAI_ERROR_EVENT = {
  type: 'error',
  sequence_number: 1,
  code: 'ERR_SOMETHING',
  message: 'Something went wrong',
  param: null,
} as const satisfies ResponsesSSEEvent;

// ── Negative cases ────────────────────────────────────────────────────
// Each line below is a shape the union must REJECT. If a future edit loosens
// `ResponsesSSEEvent` back toward the original mistakes, the corresponding
// `@ts-expect-error` becomes unused and `tsc -b` fails on it — which is the
// point: these fail loudly when the contract is widened, not when it is kept.

/** `item_id` belongs to the OpenAI variants; OpenRouter sends `response_id`. */
export const REJECTS_INVENTED_ITEM_ID: ResponsesSSEEvent = {
  type: 'response.content_part.delta',
  // @ts-expect-error `item_id` is not a field of OpenRouter's content delta.
  item_id: 'msg_1',
  response_id: 'resp_1',
  output_index: 0,
  content_index: 0,
  delta: 'Once',
};

/** `response_id` is required — the published example always carries it. */
// @ts-expect-error omitting `response_id` must not type-check.
export const REJECTS_MISSING_RESPONSE_ID: ResponsesSSEEvent = {
  type: 'response.content_part.delta',
  output_index: 0,
  content_index: 0,
  delta: 'Once',
};

/** Both indices are required; they were wrongly optional at first. */
// @ts-expect-error omitting `content_index` must not type-check.
export const REJECTS_MISSING_CONTENT_INDEX: ResponsesSSEEvent = {
  type: 'response.content_part.delta',
  response_id: 'resp_1',
  output_index: 0,
  delta: 'Once',
};

/** OpenAI documents `sequence_number` on every streaming event. */
// @ts-expect-error omitting `sequence_number` on an OpenAI event must not type-check.
export const REJECTS_MISSING_SEQUENCE_NUMBER: ResponsesSSEEvent = {
  type: 'response.output_text.delta',
  item_id: 'msg_1',
  output_index: 0,
  content_index: 0,
  delta: 'Hello',
};

/** OpenRouter's example shows no sequence number, so its variants must not require one. */
export const OPENROUTER_NEEDS_NO_SEQUENCE_NUMBER: ResponsesSSEEvent = {
  type: 'response.content_part.delta',
  response_id: 'resp_1',
  output_index: 0,
  content_index: 0,
  delta: 'Once',
};

/** The Responses error event is not nested. The nested form is an
 *  undocumented compatibility shape the parser tolerates; it is not part of
 *  this wire contract and must not satisfy this variant. */
export const REJECTS_NESTED_ERROR: ResponsesSSEEvent = {
  type: 'error',
  sequence_number: 1,
  // @ts-expect-error `error` is not a field of the Responses error event.
  error: { type: 'invalid_request_error', message: 'nope' },
  code: null,
  message: 'nope',
  param: null,
};

/** The terminal payload is not an unconstrained partial: `id` is required. */
export const REJECTS_EMPTY_DONE_RESPONSE: ResponsesSSEEvent = {
  type: 'response.done',
  // @ts-expect-error `response.done` requires `id`, `object`, and `status`.
  response: {},
};
