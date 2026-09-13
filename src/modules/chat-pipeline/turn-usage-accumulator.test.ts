import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TurnUsageAccumulator } from './turn-usage-accumulator.ts';
import type { NormalizedUsage } from '../llm-client/cache-usage';

function provider(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
    source: 'provider',
    ...overrides,
  };
}

describe('TurnUsageAccumulator', () => {
  it('keeps a one-response turn numerically unchanged while marking its scope', () => {
    const accumulator = new TurnUsageAccumulator();
    accumulator.addResponse('one', provider({
      reasoning: { status: 'reported', tokens: 12, measurement: 'provider-counter' },
      cache: { status: 'reported', readTokens: 4, reportedBy: 'provider' },
    }));
    const aggregate = accumulator.snapshot('complete')!;
    assert.equal(aggregate.prompt_tokens, 10);
    assert.equal(aggregate.completion_tokens, 20);
    assert.equal(aggregate.total_tokens, 30);
    assert.equal(aggregate.scope, 'assistant-turn');
    assert.equal(aggregate.coverage.responseCount, 1);
    assert.equal(aggregate.terminalCoverage, 'complete');
  });

  it('sums three provider responses, including a large early reasoning round', () => {
    const accumulator = new TurnUsageAccumulator();
    accumulator.addResponse('round-1', provider({
      prompt_tokens: 1_000,
      completion_tokens: 300_000,
      total_tokens: 301_000,
      reasoning: { status: 'reported', tokens: 299_000, measurement: 'provider-counter' },
    }));
    accumulator.addResponse('round-2', provider({
      prompt_tokens: 2_000,
      completion_tokens: 5_000,
      total_tokens: 7_000,
      reasoning: { status: 'reported', tokens: 4_500, measurement: 'provider-counter' },
    }));
    accumulator.addResponse('round-3', provider({
      prompt_tokens: 3_000,
      completion_tokens: 2_605,
      total_tokens: 5_605,
      reasoning: { status: 'reported', tokens: 2_000, measurement: 'provider-counter' },
    }));
    const aggregate = accumulator.snapshot('complete')!;
    assert.deepEqual(
      [aggregate.prompt_tokens, aggregate.completion_tokens, aggregate.total_tokens],
      [6_000, 307_605, 313_605],
    );
    assert.equal(aggregate.reasoning.tokens, 305_500);
    assert.equal(aggregate.reasoning.reportedResponses, 3);
  });

  it('preserves partial cache/reasoning coverage and mixed attribution', () => {
    const accumulator = new TurnUsageAccumulator();
    accumulator.addResponse('provider', provider({
      reasoning: { status: 'reported', tokens: 0, measurement: 'provider-estimate' },
      cache: {
        status: 'reported',
        readTokens: 0,
        writeTokens: 3,
        writeTokensByTtl: { ephemeral5m: 3 },
        reportedBy: 'router',
        anomalies: ['ttl-breakdown-mismatch'],
      },
    }));
    accumulator.addResponse('estimate', {
      prompt_tokens: 0,
      completion_tokens: 7,
      total_tokens: 7,
      source: 'lc-estimate',
    });
    const aggregate = accumulator.snapshot('partial')!;
    assert.equal(aggregate.source, 'mixed');
    assert.deepEqual(aggregate.coverage, {
      responseCount: 2,
      providerReportedResponses: 1,
      estimatedResponses: 1,
    });
    assert.equal(aggregate.reasoning.status, 'partially-reported');
    assert.equal(aggregate.reasoning.tokens, 0, 'an explicit provider zero remains reported');
    assert.equal(aggregate.cache?.status, 'partially-reported');
    assert.equal(aggregate.cache?.readTokens, 0);
    assert.deepEqual(aggregate.cache?.coverage, { reportedResponses: 1, responseCount: 2 });
    assert.deepEqual(aggregate.cache?.anomalies, ['ttl-breakdown-mismatch']);
  });

  it('adds a completed response id at most once', () => {
    const accumulator = new TurnUsageAccumulator();
    assert.equal(accumulator.addResponse('same', provider()), true);
    assert.equal(accumulator.addResponse('same', provider()), false);
    assert.equal(accumulator.snapshot('complete')?.completion_tokens, 20);
    assert.equal(accumulator.responseCount, 1);
  });
});
