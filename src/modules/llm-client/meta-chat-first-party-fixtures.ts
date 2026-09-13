/**
 * Post-normalization LC archive fixtures from the direct first-party Meta
 * Model API Chat Completions session (`muse-spark-1.3-contributor` on
 * `https://api.meta.ai/v1`, seven successful xhigh tool-loop turns).
 *
 * These are NOT raw SSE or raw request captures. The LC archive stores
 * normalized usage and LC-side message metadata; raw
 * `prompt_tokens_details` / `completion_tokens_details` and raw SSE framing
 * are not in the archive and are not claimed here. Raw usage envelopes below
 * are reconstructed provider-shape projections consistent with the normalized
 * archive — they exercise LC's normalizer, not Meta's live response.
 *
 * Carrier fact pinned here: archived Chat assistant messages carry content,
 * tool calls, usage, and metadata — and no `reasoning_content` field at all.
 * There is no replayable private-reasoning carrier on this surface; the
 * provider-reported reasoning total is footer history only and contributes
 * zero reasoning to the next request's context.
 *
 * Sanitization: normalized usage numbers only, no user prompts, tool output,
 * local paths, or identifiers.
 */

export const META_CHAT_FIRST_PARTY_BASE_URL = 'https://api.meta.ai/v1';
export const META_CHAT_FIRST_PARTY_MODEL = 'muse-spark-1.3-contributor';
export const META_CHAT_FIRST_PARTY_ENDPOINT = '/chat/completions';

export interface MetaChatFirstPartyTurnUsage {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
}

/**
 * Normalized (prompt, completion, reasoning, cached) tuples from the seven
 * successful first-party turns, in archive order. Reasoning sums to 15,505
 * tokens of historical provider-reported cost.
 */
export const META_CHAT_FIRST_PARTY_TURN_USAGE: MetaChatFirstPartyTurnUsage[] = [
  { prompt_tokens: 30067, completion_tokens: 1488, reasoning_tokens: 960, cached_tokens: 8881 },
  { prompt_tokens: 44774, completion_tokens: 2984, reasoning_tokens: 2197, cached_tokens: 37316 },
  { prompt_tokens: 47995, completion_tokens: 3953, reasoning_tokens: 3106, cached_tokens: 20322 },
  { prompt_tokens: 36273, completion_tokens: 2235, reasoning_tokens: 1690, cached_tokens: 21090 },
  { prompt_tokens: 26492, completion_tokens: 3434, reasoning_tokens: 3321, cached_tokens: 10865 },
  { prompt_tokens: 24309, completion_tokens: 3150, reasoning_tokens: 2938, cached_tokens: 11569 },
  { prompt_tokens: 36893, completion_tokens: 2317, reasoning_tokens: 1293, cached_tokens: 11825 },
];

export const META_CHAT_FIRST_PARTY_REASONING_TOTAL = META_CHAT_FIRST_PARTY_TURN_USAGE
  .reduce((sum, turn) => sum + turn.reasoning_tokens, 0);

/**
 * Reconstructed provider-shape usage envelope for one normalized tuple.
 * Projection only: exercises LC's normalizer, not Meta's live response.
 */
export function metaChatRawUsageEnvelope(turn: MetaChatFirstPartyTurnUsage): Record<string, unknown> {
  return {
    prompt_tokens: turn.prompt_tokens,
    completion_tokens: turn.completion_tokens,
    total_tokens: turn.prompt_tokens + turn.completion_tokens,
    prompt_tokens_details: { cached_tokens: turn.cached_tokens },
    completion_tokens_details: { reasoning_tokens: turn.reasoning_tokens },
  };
}
