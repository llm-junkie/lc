/**
 * Post-normalization LC archive fixtures from the direct first-party Meta
 * Model API Messages session (`muse-spark-1.3-contributor` on
 * `https://api.meta.ai/v1`: eight successful turns plus `none` and `max`
 * validation errors, multi-round tool use across files, images, PDF, skills,
 * and whiteboard operations).
 *
 * These are NOT raw SSE or raw request captures. The LC archive stores
 * normalized usage, redacted provider envelopes, and LC-side message
 * metadata; raw usage details and raw SSE framing are not in the archive and
 * are not claimed here. Raw usage envelopes below are reconstructed
 * provider-shape projections consistent with the normalized archive — they
 * exercise LC's normalizer, not Meta's live response.
 *
 * Carrier facts pinned here: every archived thinking block has exactly the
 * keys `["type", "data"]` with `type: "redacted_thinking"` (pinning the
 * `.data` blob property); no `thinking` summary block appears in this
 * archive, so summary display shape for Messages stays documentation-only.
 * Cache composition is NOT pinned: reads are reported beside input totals,
 * but whether `input_tokens` includes them is still unconfirmed.
 *
 * Sanitization: synthetic IDs, short non-secret placeholders where the
 * archive held opaque blobs, inert placeholder text (never provider or user
 * prose), normalized usage numbers only — no prompts, tool output, local
 * paths, or identifiers.
 */

import type { AnthropicBlockOrderEntry, AnthropicReplayBlock } from './types';

export const META_MESSAGES_FIRST_PARTY_BASE_URL = 'https://api.meta.ai/v1';
export const META_MESSAGES_FIRST_PARTY_MODEL = 'muse-spark-1.3-contributor';
export const META_MESSAGES_FIRST_PARTY_ENDPOINT = '/messages';

/**
 * Exact archive error text for `thinking.type: "disabled"` on Muse Spark.
 * This is the provider message value (plain quotes); the raw HTTP body
 * carries it JSON-escaped, which `metaMessagesErrorBody` reproduces.
 */
export const META_MESSAGES_NONE_400_MESSAGE =
  '`thinking.type: "disabled"` is not supported with this model.';

/** Exact archive error text for `output_config.effort: "max"`. */
export const META_MESSAGES_MAX_400_MESSAGE =
  'unsupported `output_config.effort` value `max`';

/**
 * Archive error envelope shape for Messages validation failures. Unlike the
 * Responses envelope it carries no `code` or `param` fields — only the
 * message, its type, and the outer error marker.
 */
export function metaMessagesErrorBody(message: string): string {
  return JSON.stringify({
    error: { message, type: 'invalid_request_error' },
    type: 'error',
  });
}

/** Short non-secret placeholder proving `redacted_thinking.data` was non-empty. */
export function metaRedactedPlaceholder(n: number): string {
  return `redacted-data-placeholder-${n}`;
}

export function metaRedactedBlock(n: number): AnthropicReplayBlock {
  return { type: 'redacted_thinking', data: metaRedactedPlaceholder(n) };
}

export interface MetaMessagesFirstPartyTurnUsage {
  prompt_tokens: number;
  completion_tokens: number;
  thinking_tokens: number;
  cached_tokens: number;
}

/**
 * Normalized (prompt, completion, thinking, cached) tuples from the eight
 * successful first-party turns, in archive order. Thinking sums to 3,654
 * tokens of provider-bound opaque occupancy.
 */
export const META_MESSAGES_FIRST_PARTY_TURN_USAGE: MetaMessagesFirstPartyTurnUsage[] = [
  { prompt_tokens: 8944, completion_tokens: 461, thinking_tokens: 420, cached_tokens: 0 },
  { prompt_tokens: 32240, completion_tokens: 1317, thinking_tokens: 833, cached_tokens: 18274 },
  { prompt_tokens: 41529, completion_tokens: 1170, thinking_tokens: 420, cached_tokens: 33683 },
  { prompt_tokens: 42646, completion_tokens: 1182, thinking_tokens: 462, cached_tokens: 37267 },
  { prompt_tokens: 27602, completion_tokens: 688, thinking_tokens: 290, cached_tokens: 0 },
  { prompt_tokens: 31316, completion_tokens: 496, thinking_tokens: 382, cached_tokens: 26978 },
  { prompt_tokens: 29877, completion_tokens: 771, thinking_tokens: 633, cached_tokens: 14321 },
  { prompt_tokens: 46656, completion_tokens: 819, thinking_tokens: 214, cached_tokens: 44883 },
];

export const META_MESSAGES_FIRST_PARTY_THINKING_TOTAL = META_MESSAGES_FIRST_PARTY_TURN_USAGE
  .reduce((sum, turn) => sum + turn.thinking_tokens, 0);

/**
 * Per-turn replay-group token splits from the archive (19 groups). Each row
 * sums to its turn's thinking total; the rows sum to 3,654.
 */
export const META_MESSAGES_FIRST_PARTY_GROUP_TOKENS: number[][] = [
  [420],
  [220, 296, 317],
  [139, 190, 91],
  [155, 196, 111],
  [232, 58],
  [64, 318],
  [46, 587],
  [60, 139, 15],
];

/** Redacted block counts per turn from the archive (28 total). */
export const META_MESSAGES_FIRST_PARTY_BLOCK_COUNTS = [1, 5, 5, 4, 3, 3, 3, 4];

/**
 * Reconstructed provider-shape usage envelope for one normalized tuple.
 * Projection only: exercises LC's normalizer, not Meta's live response.
 * The co-presence of `input_tokens` and `cache_read_input_tokens` records
 * what the archive reports; it does not settle whether the input total
 * already includes the reads (repeated-prefix experiment still missing).
 */
export function metaMessagesRawUsageEnvelope(turn: MetaMessagesFirstPartyTurnUsage): Record<string, unknown> {
  return {
    input_tokens: turn.prompt_tokens,
    output_tokens: turn.completion_tokens,
    cache_read_input_tokens: turn.cached_tokens,
    output_tokens_details: { thinking_tokens: turn.thinking_tokens },
  };
}

/**
 * Multi-round tool-loop turn mirroring the archive's five-redacted,
 * two-call shape: [redacted, redacted, tool_use, redacted, redacted,
 * tool_use, redacted, text], with per-response groups (220/296/317) that
 * sum to the turn's thinking total (833). Synthetic IDs, placeholder blobs,
 * and inert text preserve ordering and boundaries only.
 */
export function metaMessagesToolLoopTurn(): {
  blocks: AnthropicReplayBlock[];
  order: AnthropicBlockOrderEntry[];
  callIds: string[];
  groupTokens: number[];
  text: string;
} {
  const text = 'Fixture directory summary.';
  return {
    blocks: [
      metaRedactedBlock(1),
      metaRedactedBlock(2),
      metaRedactedBlock(3),
      metaRedactedBlock(4),
      metaRedactedBlock(5),
    ],
    order: [
      { kind: 'redacted_thinking', index: 0, responseIndex: 0 },
      { kind: 'redacted_thinking', index: 1, responseIndex: 0 },
      { kind: 'tool_use', index: 2, responseIndex: 0 },
      { kind: 'redacted_thinking', index: 3, responseIndex: 1 },
      { kind: 'redacted_thinking', index: 4, responseIndex: 1 },
      { kind: 'tool_use', index: 5, responseIndex: 1 },
      { kind: 'redacted_thinking', index: 6, responseIndex: 2 },
      { kind: 'text', index: 7, responseIndex: 2, text },
    ],
    callIds: ['call_fixture_1', 'call_fixture_2'],
    groupTokens: [220, 296, 317],
    text,
  };
}
