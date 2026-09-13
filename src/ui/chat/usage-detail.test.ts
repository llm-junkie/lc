/**
 * Wording rules for the completed-response usage surface
 * (docs/cache-observability.md §4).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { presentUsage, totalProviderCacheTokens } from './usage-detail.ts';
import { finishReasonLabel, finishReasonTone } from './finish-reason-presentation.ts';
import type { NormalizedUsage } from '../../modules/llm-client/cache-usage';

const PROVIDER_WITH_CACHE: NormalizedUsage = {
  prompt_tokens: 18_420,
  completion_tokens: 812,
  total_tokens: 19_232,
  source: 'provider',
  cache: { status: 'reported', readTokens: 16_384, writeTokens: 1_024, reportedBy: 'provider' },
};

describe('reply finish-reason presentation', () => {
  it('presents tool timeout as a user-facing warning instead of a raw token', () => {
    assert.equal(finishReasonLabel('tool_timeout'), '⚠ tool timeout');
    assert.equal(finishReasonTone('tool_timeout'), 'warn');
    assert.equal(finishReasonLabel('future_reason'), 'future_reason');
  });
});

describe('usage chip — cache segment', () => {
  it('totals read and write, and breaks them out in the popover', () => {
    const { report } = presentUsage({
      prompt_tokens: 25_521, completion_tokens: 731, total_tokens: 26_252, source: 'provider',
      cache: { status: 'reported', readTokens: 5_528, writeTokens: 19_990, reportedBy: 'provider' },
    });

    assert.equal(report?.title, 'Provider report');
    assert.equal(report?.cacheValue, '25,518');
    assert.deepEqual(report?.groups, [
      [
        { label: 'Input', value: '25,521' },
        { label: 'Output', value: '731' },
      ],
      [
        { label: 'Cache read', value: '5,528' },
        { label: 'Cache write', value: '19,990' },
      ],
    ]);
  });

  it('totals only what was reported when there is no write counter', () => {
    const { report } = presentUsage({
      prompt_tokens: 8_753, completion_tokens: 981, total_tokens: 9_734, source: 'provider',
      cache: { status: 'reported', readTokens: 7_296, reportedBy: 'provider' },
    });

    assert.equal(report?.cacheValue, '7,296');
    // Absent is not zero: a provider that never reported writes must not be
    // shown as having written nothing.
    assert.deepEqual(report?.groups[1], [
      { label: 'Cache read', value: '7,296' },
      { label: 'Cache write', value: 'unreported' },
    ]);
  });

  it('keeps an explicit zero visible rather than showing it as unreported', () => {
    const { report } = presentUsage({
      prompt_tokens: 7_485, completion_tokens: 471, total_tokens: 7_956, source: 'provider',
      cache: { status: 'reported', readTokens: 0, writeTokens: 7_482, reportedBy: 'provider' },
    });

    assert.equal(report?.cacheValue, '7,482');
    assert.deepEqual(report?.groups[1], [
      { label: 'Cache read', value: '0' },
      { label: 'Cache write', value: '7,482' },
    ]);
  });

  it('reads unreported when the provider sent no cache counter at all', () => {
    const { report } = presentUsage({
      prompt_tokens: 6_833, completion_tokens: 738, total_tokens: 7_571, source: 'provider',
      cache: { status: 'not-reported', reportedBy: 'provider' },
    });

    assert.equal(report?.cacheValue, 'unreported');
    assert.deepEqual(report?.groups[1], [
      { label: 'Cache read', value: 'unreported' },
      { label: 'Cache write', value: 'unreported' },
    ]);
  });
});

describe('usage chip — whose figures they are', () => {
  it('titles provider counters as a provider report', () => {
    assert.equal(presentUsage(PROVIDER_WITH_CACHE).report?.title, 'Provider report');
  });

  it('titles locally counted tokens as an LC estimate, with no cache figure', () => {
    const { report, details } = presentUsage({
      prompt_tokens: 0, completion_tokens: 128, total_tokens: 128, source: 'lc-estimate',
    });

    assert.equal(report?.title, 'LC estimate');
    // LC never estimates a cache counter, so there is none to show.
    assert.equal(report?.cacheValue, 'unreported');
    assert.deepEqual(report?.groups, [
      // An estimate has no meaningful prompt total.
      [
        { label: 'Input', value: 'unreported' },
        { label: 'Output', value: '128' },
      ],
      [
        { label: 'Cache read', value: 'unreported' },
        { label: 'Cache write', value: 'unreported' },
      ],
    ]);
    assert.ok(details.some((line) => line.startsWith('LC: token counts estimated locally')));
  });

  it('offers no report at all when the response carried no usage', () => {
    assert.equal(presentUsage(undefined).report, undefined);
  });

  it('presents an assistant-turn aggregate with response count and reasoning coverage', () => {
    const { report, details } = presentUsage({
      prompt_tokens: 60,
      completion_tokens: 307_605,
      total_tokens: 307_665,
      source: 'provider',
      scope: 'assistant-turn',
      coverage: { responseCount: 3, providerReportedResponses: 3, estimatedResponses: 0 },
      terminalCoverage: 'complete',
      reasoning: {
        status: 'partially-reported',
        tokens: 305_000,
        reportedResponses: 2,
        responseCount: 3,
        measurements: ['provider-estimate'],
      },
      cache: {
        status: 'partially-reported',
        readTokens: 12,
        reportedBy: 'provider',
        coverage: { reportedResponses: 2, responseCount: 3 },
      },
    });
    assert.equal(report?.title, 'Turn usage · 3 reported');
    assert.ok(report?.groups[0].some((row) => row.label === 'Output' && row.value === '307,605'));
    assert.ok(report?.groups[0].some((row) => row.label === 'Reasoning'
      && row.value === '305,000 (partial)'));
    assert.ok(details.includes('Provider: reasoning reported for 2 of 3 responses'));
    assert.ok(details.includes('Provider: reasoning tokens are a provider estimate'));
  });

  it('labels mixed and legacy tool-loop scopes without pretending completeness', () => {
    const mixed = presentUsage({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      source: 'mixed',
      scope: 'assistant-turn',
      coverage: { responseCount: 2, providerReportedResponses: 1, estimatedResponses: 1 },
      terminalCoverage: 'partial',
      reasoning: { status: 'not-reported', reportedResponses: 0, responseCount: 2 },
    });
    assert.equal(mixed.report?.title, 'Turn usage · mixed provider report and LC estimate');
    assert.ok(mixed.details.includes('LC: 1 provider reports and 1 local estimates'));
    assert.ok(mixed.details.includes('LC: partial turn or usage report; available counts may be lower bounds'));

    const legacy = presentUsage(PROVIDER_WITH_CACHE, undefined, { hasToolCalls: true });
    assert.equal(legacy.report?.title, 'Legacy final-response report');
    assert.ok(legacy.details.some((line) => line.includes('legacy tool-loop usage')));
  });
});

describe('usage detail lines', () => {
  it('puts writes, misses, and the TTL breakdown in the detail lines', () => {
    const { details } = presentUsage({
      prompt_tokens: 17_620, completion_tokens: 340, total_tokens: 17_960, source: 'provider',
      cache: {
        status: 'reported', readTokens: 15_000, writeTokens: 2_500, missTokens: 12,
        writeTokensByTtl: { ephemeral5m: 2_000, ephemeral1h: 500 }, reportedBy: 'provider',
      },
    });
    assert.ok(details.includes('Provider: cache write 2,500 tokens'));
    assert.ok(details.includes('Provider: cache miss 12 tokens'));
    assert.ok(details.includes('Provider: cache write by TTL — 5m 2,000 · 1h 500'));
  });

  it('never presents a success ratio or percentage', () => {
    const { report, details } = presentUsage(PROVIDER_WITH_CACHE);
    const texts = [report?.cacheValue ?? '', ...details];
    for (const text of texts) {
      assert.ok(!text.includes('%'), `must not present a ratio: ${text}`);
      assert.ok(!/hit rate|savings|saved/i.test(text), `must not promise savings: ${text}`);
    }
  });

  it('says cache was not reported rather than implying no caching happened', () => {
    const { details } = presentUsage({
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, source: 'provider',
      cache: { status: 'not-reported', reportedBy: 'provider' },
    });
    assert.deepEqual(details, ['Provider: cache not reported for this response']);
  });

  it('surfaces bounded anomaly codes without raw provider values', () => {
    const { details } = presentUsage({
      prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, source: 'provider',
      cache: { status: 'reported', reportedBy: 'provider', anomalies: ['negative-value'] },
    });
    assert.ok(details.some((line) => line.includes('negative-value')));
  });
});

describe('provider report and LC inference stay separate', () => {
  it('attributes the prefix conclusion to LC, not the provider', () => {
    const { details } = presentUsage(
      {
        prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, source: 'provider',
        cache: { status: 'reported', readTokens: 0, reportedBy: 'provider' },
      },
      { conclusion: 'stable-prefix-active-suffix-changed', qualifiers: ['provider-breakpoint-may-exclude-suffix'] },
    );
    assert.ok(details.includes('Provider: cache read 0 tokens (provider reported)'));
    assert.ok(details.includes('LC: stable core prefix; active suffix changed'));
    assert.ok(details.includes('LC: provider may not reuse the stable prefix under the current breakpoint'));
  });

  it('never blames LC for a provider cache miss', () => {
    const { report, details } = presentUsage(
      {
        prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, source: 'provider',
        cache: { status: 'reported', readTokens: 0, reportedBy: 'provider' },
      },
      { conclusion: 'stable-prefix-active-suffix-changed', qualifiers: ['provider-breakpoint-may-exclude-suffix'] },
    );
    for (const text of [report?.cacheValue ?? '', ...details]) {
      assert.ok(!/lc caused/i.test(text), text);
      assert.ok(!/cache miss/i.test(text) || text.startsWith('Provider:'), text);
    }
  });

  it('reports an unknown upstream for a routed request', () => {
    const { details } = presentUsage(
      {
        prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, source: 'provider',
        cache: { status: 'reported', readTokens: 0, reportedBy: 'router' },
      },
      { conclusion: 'stable-prefix', qualifiers: ['router-upstream-unknown'] },
    );
    assert.ok(details.includes('LC: routed request; upstream provider not identified'));
    assert.ok(details.includes('Provider: cache read 0 tokens (OpenRouter reported)'));
  });

  it('still shows the LC conclusion when the provider reported no usage', () => {
    const { report, details } = presentUsage(undefined, {
      conclusion: 'history-prefix-changed', qualifiers: [],
    });
    assert.equal(report, undefined);
    assert.deepEqual(details, ['LC: earlier history changed']);
  });
});

describe('conversation-wide provider cache total', () => {
  it('sums reads and writes across every reply that reported one', () => {
    assert.equal(totalProviderCacheTokens([
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'provider', cache: { status: 'reported', readTokens: 6_016 } } },
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'provider', cache: { status: 'reported', readTokens: 7_296, writeTokens: 512 } } },
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'provider', cache: { status: 'reported', readTokens: 8_448 } } },
    ]), 6_016 + 7_296 + 512 + 8_448);
  });

  it('is absent when nothing reported a cache counter, so no zero is shown', () => {
    assert.equal(totalProviderCacheTokens([
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'provider', cache: { status: 'not-reported' } } },
      { usage: undefined },
    ]), undefined);
  });

  it('keeps a reported zero distinct from nothing reported', () => {
    assert.equal(totalProviderCacheTokens([
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'provider', cache: { status: 'reported', readTokens: 0 } } },
    ]), 0);
  });

  it('never counts a locally estimated response as a provider figure', () => {
    assert.equal(totalProviderCacheTokens([
      { usage: { prompt_tokens: 0, completion_tokens: 9, total_tokens: 9, source: 'lc-estimate' } },
    ]), undefined);
  });
});
