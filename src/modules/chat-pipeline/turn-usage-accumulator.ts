import type {
  AssistantTurnUsage,
  CacheUsage,
  CacheUsageAnomaly,
  NormalizedUsage,
  ReasoningUsageAggregate,
} from '../llm-client/cache-usage';

/** Constant-work, response-boundary aggregation for one assistant bubble. */
export class TurnUsageAccumulator {
  private readonly responseIds = new Set<string>();
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;
  private providerResponses = 0;
  private estimatedResponses = 0;
  private partialResponse = false;
  private hasTokenCoverage = false;
  private readonly tokenReported = { input: 0, output: 0, total: 0 };
  private readonly tokenKnown = { input: 0, output: 0, total: 0 };
  private reasoningTokens = 0;
  private reasoningReportedResponses = 0;
  private readonly reasoningMeasurements = new Set<'provider-counter' | 'provider-estimate'>();
  private cacheReportedResponses = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private cacheMissTokens = 0;
  private cacheReadSeen = false;
  private cacheWriteSeen = false;
  private cacheMissSeen = false;
  private ttl5mTokens = 0;
  private ttl1hTokens = 0;
  private ttl5mSeen = false;
  private ttl1hSeen = false;
  private cacheReportedBy: 'provider' | 'router' | undefined;
  private readonly anomalies = new Set<CacheUsageAnomaly>();

  addResponse(responseId: string, usage: NormalizedUsage): boolean {
    if (this.responseIds.has(responseId)) return false;
    this.responseIds.add(responseId);
    if (usage.terminalCoverage === 'partial') this.partialResponse = true;
    if (usage.tokenCoverage) this.hasTokenCoverage = true;
    for (const field of ['input', 'output', 'total'] as const) {
      const coverage = usage.tokenCoverage?.[field] ?? (field === 'input' && usage.source === 'lc-estimate' ? 'unreported' : 'reported');
      if (coverage === 'reported') this.tokenReported[field]++;
      if (coverage !== 'unreported') this.tokenKnown[field]++;
    }
    this.promptTokens += usage.prompt_tokens;
    this.completionTokens += usage.completion_tokens;
    this.totalTokens += usage.total_tokens;
    if (usage.source === 'lc-estimate') this.estimatedResponses += 1;
    else this.providerResponses += 1;

    const reasoning = usage.reasoning;
    if (reasoning?.status === 'reported' && reasoning.tokens !== undefined) {
      this.reasoningReportedResponses += 1;
      this.reasoningTokens += reasoning.tokens;
      if ('measurement' in reasoning && reasoning.measurement) {
        this.reasoningMeasurements.add(reasoning.measurement);
      }
    }

    const cache = usage.cache;
    if (cache?.status === 'reported' || cache?.status === 'partially-reported') {
      this.cacheReportedResponses += 1;
      if (cache.reportedBy === 'router') this.cacheReportedBy = 'router';
      else this.cacheReportedBy ??= 'provider';
      if (cache.readTokens !== undefined) {
        this.cacheReadSeen = true;
        this.cacheReadTokens += cache.readTokens;
      }
      if (cache.writeTokens !== undefined) {
        this.cacheWriteSeen = true;
        this.cacheWriteTokens += cache.writeTokens;
      }
      if (cache.missTokens !== undefined) {
        this.cacheMissSeen = true;
        this.cacheMissTokens += cache.missTokens;
      }
      if (cache.writeTokensByTtl?.ephemeral5m !== undefined) {
        this.ttl5mSeen = true;
        this.ttl5mTokens += cache.writeTokensByTtl.ephemeral5m;
      }
      if (cache.writeTokensByTtl?.ephemeral1h !== undefined) {
        this.ttl1hSeen = true;
        this.ttl1hTokens += cache.writeTokensByTtl.ephemeral1h;
      }
    }
    for (const anomaly of cache?.anomalies ?? []) this.anomalies.add(anomaly);
    return true;
  }

  get responseCount(): number {
    return this.responseIds.size;
  }

  snapshot(terminalCoverage: 'complete' | 'partial' = 'partial'): AssistantTurnUsage | undefined {
    const responseCount = this.responseIds.size;
    if (responseCount === 0) return undefined;
    const reasoning: ReasoningUsageAggregate = {
      status: this.reasoningReportedResponses === 0
        ? 'not-reported'
        : this.reasoningReportedResponses === responseCount
          ? 'reported'
          : 'partially-reported',
      ...(this.reasoningReportedResponses > 0 ? { tokens: this.reasoningTokens } : {}),
      reportedResponses: this.reasoningReportedResponses,
      responseCount,
      ...(this.reasoningMeasurements.size > 0
        ? { measurements: [...this.reasoningMeasurements].sort() }
        : {}),
    };
    const cache: CacheUsage = {
      status: this.cacheReportedResponses === 0
        ? 'not-reported'
        : this.cacheReportedResponses === responseCount
          ? 'reported'
          : 'partially-reported',
      ...(this.cacheReadSeen ? { readTokens: this.cacheReadTokens } : {}),
      ...(this.cacheWriteSeen ? { writeTokens: this.cacheWriteTokens } : {}),
      ...(this.cacheMissSeen ? { missTokens: this.cacheMissTokens } : {}),
      ...((this.ttl5mSeen || this.ttl1hSeen) ? {
        writeTokensByTtl: {
          ...(this.ttl5mSeen ? { ephemeral5m: this.ttl5mTokens } : {}),
          ...(this.ttl1hSeen ? { ephemeral1h: this.ttl1hTokens } : {}),
        },
      } : {}),
      ...(this.cacheReportedBy ? { reportedBy: this.cacheReportedBy } : {}),
      ...(this.anomalies.size > 0 ? { anomalies: [...this.anomalies].sort() } : {}),
      coverage: { reportedResponses: this.cacheReportedResponses, responseCount },
    };
    return {
      prompt_tokens: this.promptTokens,
      completion_tokens: this.completionTokens,
      total_tokens: this.totalTokens,
      ...(this.hasTokenCoverage ? { tokenCoverage: Object.fromEntries(
        (['input', 'output', 'total'] as const).map((field) => [field,
          this.tokenReported[field] === responseCount ? 'reported' : this.tokenKnown[field] ? 'partial' : 'unreported']),
      ) as NonNullable<NormalizedUsage['tokenCoverage']> } : {}),
      source: this.providerResponses > 0 && this.estimatedResponses > 0
        ? 'mixed'
        : this.estimatedResponses > 0 ? 'lc-estimate' : 'provider',
      scope: 'assistant-turn',
      coverage: {
        responseCount,
        providerReportedResponses: this.providerResponses,
        estimatedResponses: this.estimatedResponses,
      },
      terminalCoverage: this.partialResponse ? 'partial' : terminalCoverage,
      reasoning,
      cache,
    };
  }
}
