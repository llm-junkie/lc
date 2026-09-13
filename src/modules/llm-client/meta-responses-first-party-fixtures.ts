/**
 * Post-normalization LC archive fixtures from the direct first-party Meta
 * Model API Responses session (`muse-spark-1.3-contributor` on
 * `https://api.meta.ai/v1`, seven successful medium/high/xhigh turns plus
 * `none` and `max` validation errors, multi-round tool use across files,
 * images, PDF, skills, and whiteboard operations).
 *
 * These are NOT raw SSE or raw request captures. The LC archive stores
 * normalized usage, redacted provider envelopes, and LC-side message metadata;
 * raw `input_tokens_details`, the request `include` field, and raw SSE framing
 * are not in the archive and are not claimed here. Raw usage envelopes below
 * are reconstructed provider-shape projections consistent with the normalized
 * archive — they exercise LC's normalizer, not Meta's live response.
 *
 * Sanitization: synthetic item/call IDs, short non-secret placeholders where
 * the archive held opaque ciphertext, no user prompts, tool output, local
 * paths, or identifiers.
 *
 * A second dataset (`META_RESPONSES_1949_TURN_USAGE`) comes from the later
 * session `log/lc-chat-v1-muse-spark-all-2026-09-03-1949` (six turns, 30
 * reasoning items, 19 groups, 3,888 reasoning tokens).
 */

import type { ResponsesOutputItem, ResponsesReasoningItem } from './types';

export const META_FIRST_PARTY_BASE_URL = 'https://api.meta.ai/v1';
export const META_FIRST_PARTY_MODEL = 'muse-spark-1.3-contributor';
export const META_FIRST_PARTY_ENDPOINT = '/responses';

/** Exact archive error text for `reasoning.effort: "none"` on Muse Spark 1.3. */
export const META_RESPONSES_NONE_400_MESSAGE =
  '"reasoning.effort" does not support "none" with this model.';

/** Exact archive error text for `reasoning.effort: "max"` (protocol enum). */
export const META_RESPONSES_MAX_400_MESSAGE =
  '`reasoning.effort`: unknown variant `max`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`';

/** Archive error envelope shape for effort validation failures. */
export function metaResponsesErrorBody(message: string): string {
  return JSON.stringify({
    error: {
      code: null,
      message,
      param: 'reasoning.effort',
      type: 'invalid_request_error',
    },
  });
}

/** Short non-secret placeholder proving `encrypted_content` was non-empty. */
export function metaEncryptedPlaceholder(n: number): string {
  return `encrypted-content-placeholder-${n}`;
}

export interface MetaFirstPartyTurnUsage {
  effort: string;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
}

/**
 * Normalized (prompt, completion, reasoning, cached) tuples from the seven
 * successful first-party turns, in archive order.
 */
export const META_FIRST_PARTY_TURN_USAGE: MetaFirstPartyTurnUsage[] = [
  { effort: 'medium', prompt_tokens: 31477, completion_tokens: 1284, reasoning_tokens: 697, cached_tokens: 17890 },
  { effort: 'high', prompt_tokens: 38132, completion_tokens: 1423, reasoning_tokens: 718, cached_tokens: 22050 },
  { effort: 'xhigh', prompt_tokens: 54390, completion_tokens: 1564, reasoning_tokens: 705, cached_tokens: 38483 },
  { effort: 'xhigh', prompt_tokens: 13055, completion_tokens: 620, reasoning_tokens: 304, cached_tokens: 12017 },
  { effort: 'xhigh', prompt_tokens: 31235, completion_tokens: 502, reasoning_tokens: 387, cached_tokens: 26722 },
  { effort: 'xhigh', prompt_tokens: 14287, completion_tokens: 324, reasoning_tokens: 258, cached_tokens: 13809 },
  { effort: 'xhigh', prompt_tokens: 45942, completion_tokens: 1549, reasoning_tokens: 619, cached_tokens: 43923 },
];

/**
 * Reconstructed provider-shape usage envelope for one normalized tuple.
 * Projection only: exercises LC's normalizer, not Meta's live response.
 */
export function metaRawUsageEnvelope(turn: MetaFirstPartyTurnUsage): Record<string, unknown> {
  return {
    input_tokens: turn.prompt_tokens,
    output_tokens: turn.completion_tokens,
    total_tokens: turn.prompt_tokens + turn.completion_tokens,
    input_tokens_details: { cached_tokens: turn.cached_tokens },
    output_tokens_details: { reasoning_tokens: turn.reasoning_tokens },
  };
}

export function metaReasoningItem(
  id: string,
  n: number,
  summary: Array<{ type: string; text: string }>,
): ResponsesReasoningItem {
  return {
    id,
    type: 'reasoning',
    status: 'completed',
    summary: summary.map((part) => ({ ...part })),
    encrypted_content: metaEncryptedPlaceholder(n),
  };
}

/**
 * Multi-round tool-loop item sequence mirroring the first-party medium-effort
 * turn: reasoning (populated two-part summary), reasoning (empty), function
 * call, reasoning (empty), reasoning (empty), function call, reasoning
 * (empty), final message. Synthetic IDs preserve ordering and group
 * boundaries only.
 */
export function metaToolLoopItems(): ResponsesOutputItem[] {
  return [
    metaReasoningItem('rs_fixture_1:rs_fixture_1a', 1, [
      { type: 'summary_text', text: 'Checking request shape and file scope.' },
      { type: 'summary_text', text: 'Reading the listed files.' },
    ]),
    metaReasoningItem('rs_fixture_1:rs_fixture_1b', 2, []),
    {
      id: 'fc_fixture_1', type: 'function_call', call_id: 'call_fixture_1',
      name: 'lc_skill', arguments: '{"id":"lc:builtin:lc-tools"}', status: 'completed',
    } as ResponsesOutputItem,
    metaReasoningItem('rs_fixture_2:rs_fixture_2a', 3, []),
    metaReasoningItem('rs_fixture_2:rs_fixture_2b', 4, []),
    {
      id: 'fc_fixture_2', type: 'function_call', call_id: 'call_fixture_2',
      name: 'lc_read_file', arguments: '{"paths":[]}', status: 'completed',
    } as ResponsesOutputItem,
    metaReasoningItem('rs_fixture_3:rs_fixture_3a', 5, []),
    {
      id: 'msg_fixture_3', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
    } as ResponsesOutputItem,
  ];
}

/** Single-response xhigh turn: three empty-summary reasoning items + message. */
export function metaSingleResponseItems(): ResponsesOutputItem[] {
  return [
    metaReasoningItem('rs_fixture_s:rs_fixture_sa', 11, []),
    metaReasoningItem('rs_fixture_s:rs_fixture_sb', 12, []),
    metaReasoningItem('rs_fixture_s:rs_fixture_sc', 13, []),
    {
      id: 'msg_fixture_s', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
    } as ResponsesOutputItem,
  ];
}

/**
 * Normalized (prompt, completion, reasoning, cached) tuples from the second
 * first-party Responses session (`log/lc-chat-v1-muse-spark-all-2026-09-03-1949`,
 * six successful turns, 30 encrypted reasoning items in 19 replay groups).
 * Reasoning sums to 3,888 tokens of provider-bound opaque occupancy.
 */
export const META_RESPONSES_1949_TURN_USAGE: MetaFirstPartyTurnUsage[] = [
  { effort: 'xhigh', prompt_tokens: 30373, completion_tokens: 771, reasoning_tokens: 240, cached_tokens: 0 },
  { effort: 'xhigh', prompt_tokens: 47908, completion_tokens: 1529, reasoning_tokens: 970, cached_tokens: 33299 },
  { effort: 'xhigh', prompt_tokens: 52176, completion_tokens: 1899, reasoning_tokens: 1077, cached_tokens: 33043 },
  { effort: 'xhigh', prompt_tokens: 57496, completion_tokens: 1180, reasoning_tokens: 673, cached_tokens: 27362 },
  { effort: 'xhigh', prompt_tokens: 29299, completion_tokens: 549, reasoning_tokens: 199, cached_tokens: 14001 },
  { effort: 'xhigh', prompt_tokens: 30885, completion_tokens: 1607, reasoning_tokens: 729, cached_tokens: 13361 },
];

export const META_RESPONSES_1949_REASONING_TOTAL = META_RESPONSES_1949_TURN_USAGE
  .reduce((sum, turn) => sum + turn.reasoning_tokens, 0);
