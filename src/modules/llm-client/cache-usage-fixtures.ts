/**
 * Authoritative field-shape fixtures for provider cache usage.
 *
 * These describe the *shape* of each documented usage envelope in release
 * cache-observability.md §3. They deliberately do NOT assert that any particular model
 * will cache: provider documentation and model thresholds change, so mapping
 * tests must exercise field shapes rather than hard-code a claim tied to a
 * model identifier (cache-observability.md §3).
 *
 * `verification` records how each surface was confirmed. `fixture-only` means
 * the shape follows published provider documentation but no dated live
 * evidence exists for it. `live-verified` means repeated real requests against
 * a real account produced the counters this fixture describes, and
 * `liveEvidence` says when and what was observed.
 *
 * See docs/cache-observability.md §3 for the current table and for what each
 * label does and does not claim.
 */

export type CacheEnvelope = 'chat-completions' | 'responses' | 'anthropic';
export type CacheVerification = 'fixture-only' | 'live-verified';

export interface CacheUsageFixture {
  /** Row label from cache-observability.md §3. */
  surface: string;
  envelope: CacheEnvelope;
  /** True when the surface is reached through the OpenRouter router. */
  router?: boolean;
  verification: CacheVerification;
  /**
   * Dated note for a `live-verified` surface: when it was observed and which
   * normalized counters appeared. Absent while a surface is fixture-only.
   *
   * The evidence is a real multi-turn session through LC's own adapter path,
   * so it confirms the normalized end-to-end result rather than naming the raw
   * provider alias that produced it. `scripts/probe-cache-live.mjs` records
   * the raw field names when that distinction matters.
   */
  liveEvidence?: string;
  /** Raw `usage` object exactly as the provider would return it. */
  usage: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  One representative fixture per cache-observability.md §3 row                            */
/* ------------------------------------------------------------------ */

export const CACHE_USAGE_FIXTURES: CacheUsageFixture[] = [
  {
    surface: 'OpenAI — Chat Completions',
    envelope: 'chat-completions',
    verification: 'live-verified',
    liveEvidence:
      '2026-08-05: read counter reported and growing across three growing-prefix turns '
      + '(0 → 5,248 → 5,504) on gpt-4.1-mini; no write counter, as the envelope predicts',
    usage: {
      prompt_tokens: 18_420,
      completion_tokens: 812,
      total_tokens: 19_232,
      prompt_tokens_details: { cached_tokens: 16_384, cache_write_tokens: 1_024 },
    },
  },
  {
    surface: 'OpenAI — Responses',
    envelope: 'responses',
    verification: 'live-verified',
    liveEvidence: '2026-08-04: read and write counters both reported across three repeated requests',
    usage: {
      input_tokens: 18_420,
      output_tokens: 812,
      total_tokens: 19_232,
      input_tokens_details: { cached_tokens: 16_384, cache_write_tokens: 1_024 },
    },
  },
  {
    surface: 'OpenRouter — Chat Completions',
    envelope: 'chat-completions',
    router: true,
    verification: 'live-verified',
    liveEvidence:
      '2026-08-05: router-reported read and explicit-zero write counters across three turns '
      + '(read 0 → 7,936 → 0); the final zero is a route change, not a prefix break',
    usage: {
      prompt_tokens: 4_096,
      completion_tokens: 256,
      total_tokens: 4_352,
      prompt_tokens_details: { cached_tokens: 3_072, cache_write_tokens: 512 },
      // Monetary router metadata. Never normalized as token usage (cache-observability.md §3).
      cache_discount: 0.83,
    },
  },
  {
    surface: 'OpenRouter — Responses',
    envelope: 'responses',
    router: true,
    verification: 'live-verified',
    liveEvidence:
      '2026-08-05: router-reported read counter across three turns (0 → 7,808 → 0); '
      + 'the final zero is a route change, not a prefix break',
    usage: {
      input_tokens: 4_096,
      output_tokens: 256,
      total_tokens: 4_352,
      input_tokens_details: { cached_tokens: 3_072, cache_write_tokens: 512 },
      cache_discount: 0.83,
    },
  },
  {
    surface: 'Anthropic — Messages',
    envelope: 'anthropic',
    verification: 'live-verified',
    liveEvidence:
      '2026-08-05: read and write counters plus the TTL breakdown, across three growing-prefix turns on claude-sonnet-5, once LC opted in to Anthropic caching',
    usage: {
      input_tokens: 120,
      output_tokens: 340,
      cache_read_input_tokens: 15_000,
      cache_creation_input_tokens: 2_500,
      cache_creation: {
        ephemeral_5m_input_tokens: 2_000,
        ephemeral_1h_input_tokens: 500,
      },
    },
  },
  {
    surface: 'DeepSeek — Context Caching',
    envelope: 'chat-completions',
    verification: 'live-verified',
    liveEvidence:
      '2026-08-04/05: exercised against a live account through the packaged desktop build; hit and miss counters reported as documented. Maintainer-confirmed; per-turn figures not retained.',
    usage: {
      prompt_tokens: 9_000,
      completion_tokens: 400,
      total_tokens: 9_400,
      prompt_cache_hit_tokens: 8_192,
      prompt_cache_miss_tokens: 808,
    },
  },
  {
    surface: 'QwenCloud — OpenAI-compatible Chat Completions',
    envelope: 'chat-completions',
    verification: 'live-verified',
    liveEvidence:
      '2026-08-04/05: exercised against a live account through the packaged desktop build; cached-token counter reported as documented. Maintainer-confirmed; per-turn figures not retained.',
    usage: {
      prompt_tokens: 6_000,
      completion_tokens: 220,
      total_tokens: 6_220,
      prompt_tokens_details: { cached_tokens: 5_120, cache_creation_input_tokens: 640 },
    },
  },
  {
    surface: 'QwenCloud — Responses',
    envelope: 'responses',
    verification: 'live-verified',
    liveEvidence: '2026-08-04: read counter reported across three repeated requests',
    usage: {
      input_tokens: 6_000,
      output_tokens: 220,
      total_tokens: 6_220,
      input_tokens_details: { cached_tokens: 5_120 },
    },
  },
  {
    surface: 'QwenCloud — Anthropic-compatible',
    envelope: 'anthropic',
    verification: 'live-verified',
    liveEvidence:
      '2026-08-04/05: exercised against a live account through the packaged desktop build; read counter reported as documented. Maintainer-confirmed; per-turn figures not retained.',
    usage: {
      input_tokens: 300,
      output_tokens: 180,
      cache_read_input_tokens: 4_800,
      cache_creation_input_tokens: 900,
    },
  },
  {
    surface: 'MiniMax — OpenAI-compatible',
    envelope: 'chat-completions',
    verification: 'live-verified',
    liveEvidence:
      '2026-08-04/05: exercised against a live account through the packaged desktop build; cached-token counter reported as documented. Maintainer-confirmed; per-turn figures not retained.',
    usage: {
      prompt_tokens: 7_500,
      completion_tokens: 260,
      total_tokens: 7_760,
      prompt_tokens_details: { cached_tokens: 6_400 },
    },
  },
  {
    surface: 'MiniMax — Anthropic-compatible automatic caching',
    envelope: 'anthropic',
    verification: 'live-verified',
    liveEvidence: '2026-08-05: read counter reported and growing across three repeated requests, with non-zero uncached input; no cache-creation counter',
    usage: {
      input_tokens: 210,
      output_tokens: 95,
      cache_read_input_tokens: 3_300,
      cache_creation_input_tokens: 450,
    },
  },
  {
    surface: 'MiniMax — Anthropic-compatible explicit cache',
    envelope: 'anthropic',
    verification: 'fixture-only',
    usage: {
      input_tokens: 64,
      output_tokens: 128,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 12_000,
    },
  },
  {
    surface: 'Z.AI — Context Caching',
    envelope: 'chat-completions',
    verification: 'live-verified',
    liveEvidence: '2026-08-04: read counter reported and growing across three repeated requests',
    usage: {
      prompt_tokens: 5_400,
      completion_tokens: 310,
      total_tokens: 5_710,
      prompt_tokens_details: { cached_tokens: 4_096 },
    },
  },
];

/* ------------------------------------------------------------------ */
/*  Edge-shape fixtures                                                */
/* ------------------------------------------------------------------ */

/** Compatible servers that omit every cache field must behave as before. */
export const NO_CACHE_FIELD_FIXTURES: CacheUsageFixture[] = [
  {
    surface: 'Compatible server — Chat Completions without cache fields',
    envelope: 'chat-completions',
    verification: 'fixture-only',
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  },
  {
    surface: 'Compatible server — Responses without cache fields',
    envelope: 'responses',
    verification: 'fixture-only',
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  },
  {
    surface: 'Compatible server — Anthropic without cache fields',
    envelope: 'anthropic',
    verification: 'fixture-only',
    usage: { input_tokens: 100, output_tokens: 20 },
  },
];

/** Explicit zeroes are provider reports and must stay distinguishable. */
export const EXPLICIT_ZERO_FIXTURES: CacheUsageFixture[] = [
  {
    surface: 'Chat Completions — explicit zero cached_tokens',
    envelope: 'chat-completions',
    verification: 'fixture-only',
    usage: {
      prompt_tokens: 500,
      completion_tokens: 40,
      total_tokens: 540,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  },
  {
    surface: 'Responses — explicit zero cached_tokens',
    envelope: 'responses',
    verification: 'fixture-only',
    usage: {
      input_tokens: 500,
      output_tokens: 40,
      total_tokens: 540,
      input_tokens_details: { cached_tokens: 0 },
    },
  },
  {
    surface: 'Anthropic — explicit zero cache reads',
    envelope: 'anthropic',
    verification: 'fixture-only',
    usage: {
      input_tokens: 500,
      output_tokens: 40,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
];

/** Malformed values are ignored and produce bounded codes, never raw text. */
export const MALFORMED_FIXTURES: CacheUsageFixture[] = [
  {
    surface: 'Chat Completions — negative cached_tokens',
    envelope: 'chat-completions',
    verification: 'fixture-only',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: -5 },
    },
  },
  {
    surface: 'Chat Completions — fractional cached_tokens',
    envelope: 'chat-completions',
    verification: 'fixture-only',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 12.5 },
    },
  },
  {
    surface: 'Chat Completions — non-numeric cached_tokens',
    envelope: 'chat-completions',
    verification: 'fixture-only',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 'lots' },
    },
  },
  {
    surface: 'Anthropic — TTL breakdown disagreeing with the write total',
    envelope: 'anthropic',
    verification: 'fixture-only',
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation_input_tokens: 1_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 400,
        ephemeral_1h_input_tokens: 400,
      },
    },
  },
];

/** Two aliases that may describe the same tokens are never summed. */
export const DUPLICATE_ALIAS_FIXTURES: CacheUsageFixture[] = [
  {
    surface: 'Chat Completions — cached_tokens and prompt_cache_hit_tokens agreeing',
    envelope: 'chat-completions',
    verification: 'fixture-only',
    usage: {
      prompt_tokens: 9_000,
      completion_tokens: 100,
      total_tokens: 9_100,
      prompt_tokens_details: { cached_tokens: 8_000 },
      prompt_cache_hit_tokens: 8_000,
    },
  },
  {
    surface: 'Chat Completions — cache_write_tokens and cache_creation_input_tokens agreeing',
    envelope: 'chat-completions',
    verification: 'fixture-only',
    usage: {
      prompt_tokens: 9_000,
      completion_tokens: 100,
      total_tokens: 9_100,
      prompt_tokens_details: { cache_write_tokens: 700, cache_creation_input_tokens: 700 },
    },
  },
];
