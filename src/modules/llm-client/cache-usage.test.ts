import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cacheUsageSourceLabel,
  normalizeAnthropicUsage,
  normalizeChatCompletionsUsage,
  normalizeResponsesUsage,
  usageReporterForBaseUrl,
  type NormalizedUsage,
} from './cache-usage.ts';
import {
  CACHE_USAGE_FIXTURES,
  DUPLICATE_ALIAS_FIXTURES,
  EXPLICIT_ZERO_FIXTURES,
  MALFORMED_FIXTURES,
  NO_CACHE_FIELD_FIXTURES,
  type CacheUsageFixture,
} from './cache-usage-fixtures.ts';

function normalize(fixture: CacheUsageFixture): NormalizedUsage | undefined {
  const reporter = fixture.router ? 'router' : 'provider';
  switch (fixture.envelope) {
    case 'chat-completions': return normalizeChatCompletionsUsage(fixture.usage, reporter);
    case 'responses': return normalizeResponsesUsage(fixture.usage, reporter);
    case 'anthropic': return normalizeAnthropicUsage(fixture.usage, reporter);
  }
}

describe('cache usage — every documented provider provider surface is covered', () => {
  it('has a fixture for all thirteen required rows', () => {
    assert.equal(CACHE_USAGE_FIXTURES.length, 13);
    const surfaces = new Set(CACHE_USAGE_FIXTURES.map((f) => f.surface));
    assert.equal(surfaces.size, 13, 'fixture surfaces must be distinct');
  });

  for (const fixture of CACHE_USAGE_FIXTURES) {
    it(`reports cache status for ${fixture.surface}`, () => {
      const usage = normalize(fixture);
      assert.ok(usage, 'usage must normalize');
      assert.equal(usage.cache?.status, 'reported');
      assert.equal(usage.cache?.anomalies, undefined);
      assert.ok(Number.isInteger(usage.prompt_tokens));
      assert.ok(Number.isInteger(usage.completion_tokens));
    });
  }
});

describe('cache usage — OpenAI-compatible totals already include cached input', () => {
  it('does not add cached tokens to the OpenAI prompt total twice', () => {
    const usage = normalizeChatCompletionsUsage(CACHE_USAGE_FIXTURES[0].usage)!;
    assert.equal(usage.prompt_tokens, 18_420);
    assert.equal(usage.cache?.readTokens, 16_384);
    assert.equal(usage.cache?.writeTokens, 1_024);
  });

  it('does not add cached tokens to the Responses input total twice', () => {
    const usage = normalizeResponsesUsage(CACHE_USAGE_FIXTURES[1].usage)!;
    assert.equal(usage.prompt_tokens, 18_420);
    assert.equal(usage.cache?.readTokens, 16_384);
  });

  it('leaves the Qwen OpenAI-compatible prompt total untouched', () => {
    const usage = normalizeChatCompletionsUsage(CACHE_USAGE_FIXTURES[6].usage)!;
    assert.equal(usage.prompt_tokens, 6_000);
    assert.equal(usage.cache?.readTokens, 5_120);
    assert.equal(usage.cache?.writeTokens, 640);
  });

  it('leaves the MiniMax OpenAI-compatible prompt total untouched', () => {
    const usage = normalizeChatCompletionsUsage(CACHE_USAGE_FIXTURES[9].usage)!;
    assert.equal(usage.prompt_tokens, 7_500);
    assert.equal(usage.cache?.readTokens, 6_400);
  });

  it('leaves the Z.AI prompt total untouched', () => {
    const usage = normalizeChatCompletionsUsage(CACHE_USAGE_FIXTURES[12].usage)!;
    assert.equal(usage.prompt_tokens, 5_400);
    assert.equal(usage.cache?.readTokens, 4_096);
  });
});

describe('cache usage — Anthropic-shaped prompt composition', () => {
  it('counts uncached input, reads, and writes exactly once', () => {
    const usage = normalizeAnthropicUsage(CACHE_USAGE_FIXTURES[4].usage)!;
    // 120 uncached + 15000 read + 2500 creation
    assert.equal(usage.prompt_tokens, 17_620);
    assert.equal(usage.completion_tokens, 340);
    assert.equal(usage.total_tokens, 17_960);
  });

  it('treats the TTL breakdown as a detail, never a second write total', () => {
    const usage = normalizeAnthropicUsage(CACHE_USAGE_FIXTURES[4].usage)!;
    assert.equal(usage.cache?.writeTokens, 2_500);
    assert.deepEqual(usage.cache?.writeTokensByTtl, { ephemeral5m: 2_000, ephemeral1h: 500 });
    // 2000 + 500 must not be added on top of 2500.
    assert.equal(usage.prompt_tokens, 120 + 15_000 + 2_500);
  });

  it('composes the Qwen Anthropic-compatible prompt total once', () => {
    const usage = normalizeAnthropicUsage(CACHE_USAGE_FIXTURES[8].usage)!;
    assert.equal(usage.prompt_tokens, 300 + 4_800 + 900);
  });

  it('composes the MiniMax automatic-caching prompt total once', () => {
    const usage = normalizeAnthropicUsage(CACHE_USAGE_FIXTURES[10].usage)!;
    assert.equal(usage.prompt_tokens, 210 + 3_300 + 450);
  });

  it('composes the MiniMax explicit-cache prompt total once and keeps a zero read', () => {
    const usage = normalizeAnthropicUsage(CACHE_USAGE_FIXTURES[11].usage)!;
    assert.equal(usage.prompt_tokens, 64 + 0 + 12_000);
    assert.equal(usage.cache?.readTokens, 0);
    assert.equal(usage.cache?.writeTokens, 12_000);
  });

  it('keeps the Meta Messages seam additive until the composition experiment runs', () => {
    // The deviation row stands: Meta names the same cache fields but its
    // prompt-token composition is unconfirmed. The seam must exist and must
    // not select an unverified formula — today that means byte-identical
    // additive output with and without the contract ID.
    const raw = { input_tokens: 1_000, output_tokens: 50, cache_read_input_tokens: 400 };
    assert.deepEqual(
      normalizeAnthropicUsage(raw, 'provider', { providerContractId: 'meta.messages' }),
      normalizeAnthropicUsage(raw, 'provider'),
    );
    assert.deepEqual(
      normalizeAnthropicUsage(raw, 'provider', { providerContractId: 'meta.messages' })?.prompt_tokens,
      1_400,
    );
  });

  it('records a bounded code when the TTL breakdown disagrees, keeping the authoritative total', () => {
    const usage = normalizeAnthropicUsage(MALFORMED_FIXTURES[3].usage)!;
    assert.equal(usage.cache?.writeTokens, 1_000);
    assert.deepEqual(usage.cache?.anomalies, ['ttl-breakdown-mismatch']);
    assert.equal(usage.prompt_tokens, 10 + 1_000);
  });

  it('falls back to the TTL breakdown only when the write total is absent', () => {
    const usage = normalizeAnthropicUsage({
      input_tokens: 5,
      output_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 70 },
    })!;
    assert.equal(usage.cache?.writeTokens, 100);
    // The documented prompt sum only includes input + read + creation.
    assert.equal(usage.prompt_tokens, 5);
  });
});

describe('cache usage — DeepSeek hit/miss are details of the prompt total', () => {
  it('keeps the provider prompt total authoritative', () => {
    const usage = normalizeChatCompletionsUsage(CACHE_USAGE_FIXTURES[5].usage)!;
    assert.equal(usage.prompt_tokens, 9_000);
    assert.equal(usage.cache?.readTokens, 8_192);
    assert.equal(usage.cache?.missTokens, 808);
    // Hits + misses happen to equal the total here; LC must not compute it.
    assert.equal(usage.total_tokens, 9_400);
  });
});

describe('cache usage — OpenRouter labeling', () => {
  it('retains Chat Completions counters and labels them router-reported', () => {
    const fixture = CACHE_USAGE_FIXTURES[2];
    const usage = normalizeChatCompletionsUsage(fixture.usage, 'router')!;
    assert.equal(usage.cache?.readTokens, 3_072);
    assert.equal(usage.cache?.writeTokens, 512);
    assert.equal(usage.cache?.reportedBy, 'router');
    assert.equal(cacheUsageSourceLabel(usage.cache), 'OpenRouter reported');
  });

  it('retains Responses counters and labels them router-reported', () => {
    const fixture = CACHE_USAGE_FIXTURES[3];
    const usage = normalizeResponsesUsage(fixture.usage, 'router')!;
    assert.equal(usage.cache?.readTokens, 3_072);
    assert.equal(usage.cache?.writeTokens, 512);
    assert.equal(usage.cache?.reportedBy, 'router');
  });

  it('never normalizes cache_discount as token usage', () => {
    for (const fixture of [CACHE_USAGE_FIXTURES[2], CACHE_USAGE_FIXTURES[3]]) {
      const usage = normalize(fixture)!;
      const serialized = JSON.stringify(usage);
      assert.ok(!serialized.includes('0.83'));
      assert.ok(!serialized.includes('discount'));
    }
  });

  it('never names an upstream provider', () => {
    const usage = normalizeChatCompletionsUsage(CACHE_USAGE_FIXTURES[2].usage, 'router')!;
    assert.ok(!('upstream' in (usage.cache ?? {})));
    assert.deepEqual(
      Object.keys(usage.cache ?? {}).sort(),
      ['readTokens', 'reportedBy', 'status', 'writeTokens'],
    );
  });

  it('marks normalized provider usage as provider-sourced, not an LC estimate', () => {
    for (const fixture of CACHE_USAGE_FIXTURES) {
      assert.equal(normalize(fixture)?.source, 'provider', fixture.surface);
    }
  });

  it('classifies only OpenRouter hosts as a router', () => {
    assert.equal(usageReporterForBaseUrl('https://openrouter.ai/api/v1'), 'router');
    assert.equal(usageReporterForBaseUrl('https://api.openrouter.ai/v1'), 'router');
    assert.equal(usageReporterForBaseUrl('https://api.openai.com/v1'), 'provider');
    assert.equal(usageReporterForBaseUrl('https://api.deepseek.com'), 'provider');
    assert.equal(usageReporterForBaseUrl('http://localhost:1234/v1'), 'provider');
    assert.equal(usageReporterForBaseUrl('not a url'), 'provider');
    assert.equal(usageReporterForBaseUrl(undefined), 'provider');
    // A lookalike host must not be treated as the router.
    assert.equal(usageReporterForBaseUrl('https://openrouter.ai.evil.test/v1'), 'provider');
  });
});

describe('cache usage — absent and zero fields', () => {
  for (const fixture of NO_CACHE_FIELD_FIXTURES) {
    it(`marks ${fixture.surface} as not-reported without inventing counters`, () => {
      const usage = normalize(fixture)!;
      assert.equal(usage.cache?.status, 'not-reported');
      assert.equal(usage.cache?.readTokens, undefined);
      assert.equal(usage.cache?.writeTokens, undefined);
      assert.equal(usage.cache?.missTokens, undefined);
      assert.equal(usage.prompt_tokens, 100);
      assert.equal(usage.completion_tokens, 20);
      assert.equal(usage.total_tokens, 120);
    });
  }

  for (const fixture of EXPLICIT_ZERO_FIXTURES) {
    it(`treats an explicit zero as a report for ${fixture.surface}`, () => {
      const usage = normalize(fixture)!;
      assert.equal(usage.cache?.status, 'reported');
      assert.equal(usage.cache?.readTokens, 0);
    });
  }

  /**
   * JSON `null` spells "no value", not a broken payload. OpenRouter's
   * Anthropic-compatible surface sends it for `cache_creation_input_tokens` on
   * every response, which used to flag a `malformed-value` anomaly on healthy
   * turns (cache-observability.md §3.4).
   */
  describe('JSON null reads as absent, not malformed', () => {
    it('reproduces the OpenRouter Anthropic-compatible shape cleanly', () => {
      const usage = normalizeAnthropicUsage({
        input_tokens: 8_441,
        output_tokens: 806,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: null,
      }, 'router')!;
      assert.equal(usage.cache?.status, 'reported');
      assert.equal(usage.cache?.readTokens, 0);
      assert.equal(usage.cache?.writeTokens, undefined);
      assert.equal(usage.cache?.anomalies, undefined);
      assert.equal(usage.prompt_tokens, 8_441);
    });

    it('carries a real read through alongside a null write', () => {
      const usage = normalizeAnthropicUsage({
        input_tokens: 3_091,
        output_tokens: 542,
        cache_read_input_tokens: 8_512,
        cache_creation_input_tokens: null,
      }, 'router')!;
      assert.equal(usage.cache?.readTokens, 8_512);
      assert.equal(usage.cache?.anomalies, undefined);
      assert.equal(usage.prompt_tokens, 3_091 + 8_512);
    });

    it('applies on the Chat Completions and Responses envelopes too', () => {
      const chat = normalizeChatCompletionsUsage({
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 64, cache_write_tokens: null },
      })!;
      assert.equal(chat.cache?.readTokens, 64);
      assert.equal(chat.cache?.writeTokens, undefined);
      assert.equal(chat.cache?.anomalies, undefined);

      const responses = normalizeResponsesUsage({
        input_tokens: 100,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: null },
      })!;
      assert.equal(responses.cache?.status, 'not-reported');
      assert.equal(responses.cache?.anomalies, undefined);
    });

    it('still codes every other unusable type', () => {
      for (const bad of ['lots', true, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
        const usage = normalizeChatCompletionsUsage({
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: bad },
        })!;
        assert.deepEqual(usage.cache?.anomalies, ['malformed-value'], `for ${String(bad)}`);
      }
    });

    it('does not claim a provider report when every counter is null', () => {
      // Better an LC estimate than a provider-attributed 0/0 (constraint 4).
      assert.equal(
        normalizeChatCompletionsUsage({ prompt_tokens: null, completion_tokens: null }),
        undefined,
      );
    });
  });

  it('returns undefined when there is no usable provider usage at all', () => {
    assert.equal(normalizeChatCompletionsUsage(undefined), undefined);
    assert.equal(normalizeChatCompletionsUsage(null), undefined);
    assert.equal(normalizeChatCompletionsUsage({}), undefined);
    assert.equal(normalizeResponsesUsage({}), undefined);
    assert.equal(normalizeAnthropicUsage({}), undefined);
    assert.equal(normalizeChatCompletionsUsage('usage'), undefined);
  });

  it('distinguishes an absent field from an explicit zero', () => {
    const absent = normalizeChatCompletionsUsage({ prompt_tokens: 5, completion_tokens: 1 })!;
    const zero = normalizeChatCompletionsUsage({
      prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 },
    })!;
    assert.equal(absent.cache?.status, 'not-reported');
    assert.equal(zero.cache?.status, 'reported');
    assert.equal(zero.cache?.readTokens, 0);
  });
});

describe('cache usage — malformed values', () => {
  it('ignores a negative counter and records a bounded code', () => {
    const usage = normalizeChatCompletionsUsage(MALFORMED_FIXTURES[0].usage)!;
    assert.equal(usage.cache?.readTokens, undefined);
    assert.deepEqual(usage.cache?.anomalies, ['negative-value']);
    assert.equal(usage.cache?.status, 'reported');
  });

  it('ignores a fractional counter and records a bounded code', () => {
    const usage = normalizeChatCompletionsUsage(MALFORMED_FIXTURES[1].usage)!;
    assert.equal(usage.cache?.readTokens, undefined);
    assert.deepEqual(usage.cache?.anomalies, ['fractional-value']);
  });

  it('ignores a non-numeric counter and never carries the raw value', () => {
    const usage = normalizeChatCompletionsUsage(MALFORMED_FIXTURES[2].usage)!;
    assert.equal(usage.cache?.readTokens, undefined);
    assert.deepEqual(usage.cache?.anomalies, ['malformed-value']);
    assert.ok(!JSON.stringify(usage).includes('lots'));
  });

  it('keeps the prompt total usable when a cache detail is malformed', () => {
    const usage = normalizeChatCompletionsUsage(MALFORMED_FIXTURES[0].usage)!;
    assert.equal(usage.prompt_tokens, 100);
    assert.equal(usage.completion_tokens, 10);
  });
});

describe('cache usage — duplicate aliases are never summed', () => {
  it('takes the envelope-preferred read alias without summing it', () => {
    const usage = normalizeChatCompletionsUsage(DUPLICATE_ALIAS_FIXTURES[0].usage)!;
    assert.equal(usage.cache?.readTokens, 8_000, 'must not be 16000');
    // The two aliases agree, so there is no conflict to report.
    assert.equal(usage.cache?.anomalies, undefined);
  });

  it('takes the envelope-preferred write alias without summing it', () => {
    const usage = normalizeChatCompletionsUsage(DUPLICATE_ALIAS_FIXTURES[1].usage)!;
    assert.equal(usage.cache?.writeTokens, 700, 'must not be 1400');
    assert.equal(usage.cache?.anomalies, undefined);
  });

  it('prefers the details alias over the DeepSeek top-level alias', () => {
    const usage = normalizeChatCompletionsUsage({
      prompt_tokens: 10,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 4 },
      prompt_cache_hit_tokens: 9,
    })!;
    assert.equal(usage.cache?.readTokens, 4);
  });

  /**
   * DeepSeek documents only `prompt_cache_hit_tokens` and
   * `prompt_cache_miss_tokens` (api-docs.deepseek.com/guides/kv_cache), but
   * also emits the OpenAI-compatible `prompt_tokens_details.cached_tokens`
   * carrying the same count. Co-presence alone is not a conflict.
   */
  it('stays silent when both aliases agree', () => {
    const usage = normalizeChatCompletionsUsage({
      prompt_tokens: 7_892,
      completion_tokens: 464,
      total_tokens: 8_356,
      prompt_cache_hit_tokens: 6_784,
      prompt_cache_miss_tokens: 1_108,
      prompt_tokens_details: { cached_tokens: 6_784 },
    })!;
    assert.equal(usage.cache?.readTokens, 6_784);
    assert.equal(usage.cache?.missTokens, 1_108);
    assert.equal(usage.cache?.anomalies, undefined);
  });

  it('still flags a real divergence between the two DeepSeek aliases', () => {
    // The case the anomaly exists for: the undocumented compatibility field
    // drifting from the documented native one. Envelope precedence still wins.
    const usage = normalizeChatCompletionsUsage({
      prompt_tokens: 7_892,
      completion_tokens: 464,
      prompt_cache_hit_tokens: 6_784,
      prompt_tokens_details: { cached_tokens: 4_096 },
    })!;
    assert.equal(usage.cache?.readTokens, 4_096);
    assert.deepEqual(usage.cache?.anomalies, ['conflicting-aliases']);
  });

  it('does not call a single usable value a conflict when its alias is unusable', () => {
    // One alias malformed, the other fine: that is a malformed value, not a
    // disagreement between two counts.
    const usage = normalizeChatCompletionsUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_cache_hit_tokens: 'lots',
      prompt_tokens_details: { cached_tokens: 64 },
    })!;
    assert.equal(usage.cache?.readTokens, 64);
    assert.deepEqual(usage.cache?.anomalies, ['malformed-value']);
  });

  it('falls through to the next alias when the preferred one is unusable', () => {
    const usage = normalizeChatCompletionsUsage({
      prompt_tokens: 10,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: -1 },
      prompt_cache_hit_tokens: 9,
    })!;
    assert.equal(usage.cache?.readTokens, 9);
    assert.ok(usage.cache?.anomalies?.includes('negative-value'));
  });
});

describe('cache usage — provenance wording', () => {
  it('labels provider, router, and absent reports distinctly', () => {
    assert.equal(cacheUsageSourceLabel({ status: 'reported', reportedBy: 'provider' }), 'provider reported');
    assert.equal(cacheUsageSourceLabel({ status: 'reported', reportedBy: 'router' }), 'OpenRouter reported');
    assert.equal(cacheUsageSourceLabel({ status: 'not-reported' }), 'not reported');
    assert.equal(cacheUsageSourceLabel(undefined), '');
  });
});

describe('reasoning usage normalization — missing, zero, malformed, and aliases', () => {
  const cases: Array<{
    name: string;
    value: unknown;
    tokens?: number;
    anomaly?: string;
  }> = [
    { name: 'absent', value: undefined },
    { name: 'explicit zero', value: 0, tokens: 0 },
    { name: 'positive', value: 321, tokens: 321 },
    { name: 'JSON null', value: null },
    { name: 'negative', value: -1, anomaly: 'negative-value' },
    { name: 'fractional', value: 1.5, anomaly: 'fractional-value' },
    { name: 'string', value: '321', anomaly: 'malformed-value' },
  ];

  for (const fixture of cases) {
    it(`normalizes Chat Completions reasoning: ${fixture.name}`, () => {
      const details = fixture.value === undefined ? {} : { reasoning_tokens: fixture.value };
      const usage = normalizeChatCompletionsUsage({
        prompt_tokens: 10,
        completion_tokens: 20,
        completion_tokens_details: details,
      })!;
      assert.equal(usage.reasoning?.tokens, fixture.tokens);
      assert.equal(usage.reasoning?.measurement, fixture.tokens === undefined ? undefined : 'provider-counter');
      assert.equal(usage.cache?.anomalies?.includes(fixture.anomaly as never) ?? false, !!fixture.anomaly);
    });

    it(`normalizes Responses reasoning: ${fixture.name}`, () => {
      const details = fixture.value === undefined ? {} : { reasoning_tokens: fixture.value };
      const usage = normalizeResponsesUsage({
        input_tokens: 10,
        output_tokens: 20,
        output_tokens_details: details,
      })!;
      assert.equal(usage.reasoning?.tokens, fixture.tokens);
      assert.equal(usage.reasoning?.measurement, fixture.tokens === undefined ? undefined : 'provider-counter');
      assert.equal(usage.cache?.anomalies?.includes(fixture.anomaly as never) ?? false, !!fixture.anomaly);
    });

    it(`normalizes Anthropic thinking: ${fixture.name}`, () => {
      const details = fixture.value === undefined ? {} : { thinking_tokens: fixture.value };
      const usage = normalizeAnthropicUsage({
        input_tokens: 10,
        output_tokens: 20,
        output_tokens_details: details,
      })!;
      assert.equal(usage.reasoning?.tokens, fixture.tokens);
      assert.equal(usage.reasoning?.measurement, fixture.tokens === undefined ? undefined : 'provider-estimate');
      assert.equal(usage.completion_tokens, 20, 'thinking is a breakdown of inclusive output');
      assert.equal(usage.total_tokens, 30, 'thinking must not be added twice');
      assert.equal(usage.cache?.anomalies?.includes(fixture.anomaly as never) ?? false, !!fixture.anomaly);
    });
  }

  it('uses the envelope-preferred reasoning alias and flags a real conflict', () => {
    const chat = normalizeChatCompletionsUsage({
      prompt_tokens: 1,
      completion_tokens: 2,
      completion_tokens_details: { reasoning_tokens: 7 },
      reasoning_tokens: 8,
    })!;
    const responses = normalizeResponsesUsage({
      input_tokens: 1,
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 7 },
      reasoning_tokens: 8,
    })!;
    const anthropic = normalizeAnthropicUsage({
      input_tokens: 1,
      output_tokens: 2,
      output_tokens_details: { thinking_tokens: 7 },
      thinking_tokens: 8,
    })!;
    for (const usage of [chat, responses, anthropic]) {
      assert.equal(usage.reasoning?.tokens, 7);
      assert.ok(usage.cache?.anomalies?.includes('conflicting-aliases'));
    }
  });
});
