/**
 * Presentation for the completed-response usage chip.
 *
 * Three kinds of claim stay separated (docs/cache-observability.md §4):
 * provider counters, LC's local token estimate, and LC's prefix inference.
 * The popover title says which of the first two the figures are.
 *
 * Cache is only ever provider-reported — LC never estimates one — so a missing
 * counter reads `unreported`, never `0`, and never implies the provider did no
 * caching.
 */

import {
  cacheUsageSourceLabel,
  type NormalizedUsage,
} from '../../modules/llm-client/cache-usage.ts';
import {
  prefixConclusionLabel,
  prefixQualifierLabel,
  type PrefixDiagnostic,
} from '../../modules/llm-client/prefix-diagnostics.ts';

/**
 * Shown when a figure was not reported and cannot be derived.
 *
 * One word, matching the internal `status: 'not-reported'`: it attributes the
 * silence to the provider rather than to LC, cannot be read as "not
 * applicable", and never implies zero. No space, so it will not wrap in a
 * narrow value cell.
 */
export const UNREPORTED = 'unreported';

/** One labelled figure in the popover. */
export interface UsageRow {
  label: string;
  value: string;
}

export interface UsageReport {
  /** Whose figures these are. */
  title: string;
  /**
   * Cache segment of the chip — bare, e.g. `11,431` or `unreported`. The chip is
   * unlabelled by design; the popover names each figure.
   */
  cacheValue: string;
  /** Request totals first, then cache counters. */
  groups: UsageRow[][];
}

export interface UsagePresentation {
  /** Attributed detail lines for the chip's hover title. */
  details: string[];
  /** Absent only when the response carried no usage at all. */
  report?: UsageReport;
}

/**
 * Total cache tokens providers reported across a conversation.
 *
 * Deliberately separate from the token breakdown, which predicts the *next*
 * request: the two must never be added together (cache-observability.md §4). Returns `undefined`
 * when nothing reported a counter, so the caller can omit the row rather than
 * show a zero that would read as "no caching".
 */
export function totalProviderCacheTokens(
  messages: ReadonlyArray<{ usage?: NormalizedUsage }>,
): number | undefined {
  let total = 0;
  let reported = false;
  for (const message of messages) {
    if (message.usage?.source === 'lc-estimate') continue;
    const cache = message.usage?.cache;
    if (cache?.status !== 'reported' && cache?.status !== 'partially-reported') continue;
    for (const counter of [cache.readTokens, cache.writeTokens]) {
      if (counter === undefined) continue;
      reported = true;
      total += counter;
    }
  }
  return reported ? total : undefined;
}

/** Deterministic thousands grouping, independent of host locale. */
function group(value: number): string {
  const sign = value < 0 ? '-' : '';
  const digits = Math.abs(Math.trunc(value)).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function presentUsage(
  usage?: NormalizedUsage,
  prefix?: PrefixDiagnostic,
  options: { hasToolCalls?: boolean } = {},
): UsagePresentation {
  const details: string[] = [];
  const cache = usage?.cache;

  if (cache) {
    if (cache.status === 'not-reported') {
      // Explicitly not a claim that no caching happened.
      details.push(usage?.scope === 'assistant-turn'
        ? 'Provider: cache not reported across this turn'
        : 'Provider: cache not reported for this response');
    } else {
      details.push(
        `Provider: cache read ${group(cache.readTokens ?? 0)} tokens (${
          cache.readTokens === undefined ? 'not reported' : cacheUsageSourceLabel(cache)
        })`,
      );
      if (cache.writeTokens !== undefined) {
        details.push(`Provider: cache write ${group(cache.writeTokens)} tokens`);
      }
      if (cache.missTokens !== undefined) {
        details.push(`Provider: cache miss ${group(cache.missTokens)} tokens`);
      }
      const ttl = cache.writeTokensByTtl;
      if (ttl && (ttl.ephemeral5m !== undefined || ttl.ephemeral1h !== undefined)) {
        const breakdown = [
          ttl.ephemeral5m !== undefined ? `5m ${group(ttl.ephemeral5m)}` : '',
          ttl.ephemeral1h !== undefined ? `1h ${group(ttl.ephemeral1h)}` : '',
        ].filter(Boolean).join(' · ');
        details.push(`Provider: cache write by TTL — ${breakdown}`);
      }
    }
    if (cache.status === 'partially-reported' && cache.coverage) {
      details.push(
        `Provider: cache counters reported for ${cache.coverage.reportedResponses} of ${cache.coverage.responseCount} responses`,
      );
    }
    if (cache.anomalies?.length) {
      details.push(`Provider: some cache counters were unusable (${cache.anomalies.join(', ')})`);
    }
  }

  if (usage?.source === 'lc-estimate') {
    details.push('LC: token counts estimated locally; the provider reported none');
  } else if (usage?.source === 'mixed' && usage.coverage) {
    details.push(
      `LC: ${usage.coverage.providerReportedResponses} provider reports and ${usage.coverage.estimatedResponses} local estimates`,
    );
  }

  if (usage?.reasoning) {
    if ('reportedResponses' in usage.reasoning
      && usage.reasoning.status === 'partially-reported') {
      details.push(
        `Provider: reasoning reported for ${usage.reasoning.reportedResponses} of ${usage.reasoning.responseCount} responses`,
      );
    }
    const measurements = 'measurements' in usage.reasoning
      ? usage.reasoning.measurements
      : 'measurement' in usage.reasoning && usage.reasoning.measurement
        ? [usage.reasoning.measurement]
        : undefined;
    if (measurements?.includes('provider-estimate')) {
      details.push(measurements.includes('provider-counter')
        ? 'Provider: reasoning total mixes counters and provider estimates'
        : 'Provider: reasoning tokens are a provider estimate');
    }
  }

  if (usage?.scope === 'assistant-turn' && usage.terminalCoverage === 'partial') {
    details.push('LC: partial turn or usage report; available counts may be lower bounds');
  } else if (usage && !usage.scope && options.hasToolCalls) {
    details.push('LC: legacy tool-loop usage may contain only the final provider response');
  }

  if (prefix) {
    details.push(`LC: ${prefixConclusionLabel(prefix.conclusion)}`);
    for (const qualifier of prefix.qualifiers) {
      details.push(`LC: ${prefixQualifierLabel(qualifier)}`);
    }
  }

  return { details, ...(usage ? { report: buildReport(usage, options) } : {}) };
}

/**
 * An explicit zero is a provider report and stays visible as `0`; an absent
 * counter reads `unreported` and never as zero.
 */
function counter(value: number | undefined): string {
  return value === undefined ? UNREPORTED : group(value);
}

function buildReport(
  usage: NormalizedUsage,
  options: { hasToolCalls?: boolean },
): UsageReport {
  const estimated = usage.source === 'lc-estimate';
  // LC never estimates a cache counter, so an estimate has none to show.
  const cache = !estimated && usage.cache?.status !== 'not-reported' ? usage.cache : undefined;
  const read = cache?.readTokens;
  const write = cache?.writeTokens;

  // The chip totals whatever was actually reported. An absent counter
  // contributes nothing rather than a zero, so a provider that reports reads
  // but not writes is not shown as having written nothing.
  const reported = [read, write].filter((value): value is number => value !== undefined);

  const responseCount = usage.coverage?.responseCount;
  const title = usage.scope === 'assistant-turn'
    ? usage.source === 'mixed'
      ? 'Turn usage · mixed provider report and LC estimate'
      : estimated
        ? `Turn usage · LC estimate · ${responseCount ?? 1} provider response${responseCount === 1 ? '' : 's'}`
        : `Turn usage · ${responseCount ?? 1} reported`
    : options.hasToolCalls
      ? 'Legacy final-response report'
      : estimated ? 'LC estimate' : 'Provider report';
  const reasoning = usage.reasoning;
  const reasoningValue = reasoning?.status === 'reported'
    ? counter(reasoning.tokens)
    : reasoning?.status === 'partially-reported'
      ? `${counter(reasoning.tokens)} (partial)`
      : UNREPORTED;
  const covered = (field: 'input' | 'output', value: number) => usage.tokenCoverage?.[field] === 'unreported'
    ? UNREPORTED : usage.tokenCoverage?.[field] === 'partial' ? `≥${group(value)}` : group(value);

  return {
    title,
    cacheValue: reported.length === 0
      ? UNREPORTED
      : group(reported.reduce((total, value) => total + value, 0)),
    groups: [
      [
        // An estimate has no meaningful prompt total: `prompt_tokens` is 0
        // because the provider reported nothing to count from.
        { label: 'Input', value: estimated ? UNREPORTED : covered('input', usage.prompt_tokens) },
        { label: 'Output', value: covered('output', usage.completion_tokens) },
        ...(reasoning ? [{ label: 'Reasoning', value: reasoningValue }] : []),
      ],
      [
        { label: 'Cache read', value: counter(read) },
        { label: 'Cache write', value: counter(write) },
      ],
    ],
  };
}
