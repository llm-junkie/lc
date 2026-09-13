/**
 * Normalized, provider-native cache usage.
 *
 * LC only *observes* what a provider reported about cache reads, writes, and
 * misses. It never creates a prompt/KV/response cache, never pre-warms, never
 * infers a hit from latency, and never adds a cache directive to a request
 * (docs/cache-observability.md §1).
 *
 * `not-reported` means only that no recognized counter arrived — never that the
 * provider performed no caching. An explicit numeric `0` is a provider report
 * and stays distinguishable from an absent field.
 *
 * This module is pure and fixture-testable: it takes a raw `usage` object and
 * returns normalized values. Protocol precedence lives here; the adapters pick
 * which envelope applies.
 */

/** Bounded diagnostic codes. Raw provider payloads never leave this module. */
export const CACHE_USAGE_ANOMALIES = [
  'malformed-value',
  'negative-value',
  'fractional-value',
  'conflicting-aliases',
  'ttl-breakdown-mismatch',
] as const;
export type CacheUsageAnomaly = (typeof CACHE_USAGE_ANOMALIES)[number];

const MAX_ANOMALIES = 4;

export interface CacheUsage {
  status: 'reported' | 'partially-reported' | 'not-reported';
  readTokens?: number;
  writeTokens?: number;
  missTokens?: number;
  writeTokensByTtl?: {
    ephemeral5m?: number;
    ephemeral1h?: number;
  };
  /**
   * Who reported the counters. `router` means a routing layer (OpenRouter)
   * returned them and the upstream provider is NOT authoritatively identified.
   * LC never infers the upstream from model name, price, latency, or counters
   * (cache-observability.md §3), so this stays `router` unless the response says otherwise.
   */
  reportedBy?: 'provider' | 'router';
  /** Bounded, sorted, deduplicated. Never a raw provider value. */
  anomalies?: CacheUsageAnomaly[];
  /** Response coverage is present on assistant-turn aggregates only. */
  coverage?: {
    reportedResponses: number;
    responseCount: number;
  };
}

export interface NormalizedReasoningUsage {
  status: 'reported' | 'not-reported';
  tokens?: number;
  measurement?: 'provider-counter' | 'provider-estimate';
}

export interface UsageCoverage {
  responseCount: number;
  providerReportedResponses: number;
  estimatedResponses: number;
}

export interface ReasoningUsageAggregate {
  status: 'reported' | 'partially-reported' | 'not-reported';
  tokens?: number;
  reportedResponses: number;
  responseCount: number;
  measurements?: Array<'provider-counter' | 'provider-estimate'>;
}

export interface NormalizedUsage {
  /** Optional field-level coverage for partial native usage reports. */
  tokenCoverage?: Record<'input' | 'output' | 'total', 'reported' | 'partial' | 'unreported'>;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache?: CacheUsage;
  /** Response-local provider breakdown or assistant-turn aggregate. */
  reasoning?: NormalizedReasoningUsage | ReasoningUsageAggregate;
  /**
   * Where the token counts came from. `provider` means the server reported
   * them; `lc-estimate` means LC counted tokens locally because the server
   * reported none. Absent on messages persisted before this field existed,
   * which are treated as provider-reported (the only source that existed).
   *
   * Required so UI and support-report wording can keep provider reports,
   * LC estimates, and LC inferences distinct (docs/README.md standing constraint 4).
   */
  source?: 'provider' | 'lc-estimate' | 'mixed';
  /** Present only on new footer-facing, multi-response turn aggregates. */
  scope?: 'assistant-turn';
  /** Present together with `scope`. */
  coverage?: UsageCoverage;
  /** Whether the generation reached a clean terminal response. */
  terminalCoverage?: 'complete' | 'partial';
}

export interface NormalizedResponseUsage extends NormalizedUsage {
  scope?: never;
  coverage?: never;
  terminalCoverage?: never;
  source: 'provider' | 'lc-estimate';
  reasoning?: NormalizedReasoningUsage;
}

export interface AssistantTurnUsage extends NormalizedUsage {
  scope: 'assistant-turn';
  coverage: UsageCoverage;
  reasoning: ReasoningUsageAggregate;
  source: 'provider' | 'lc-estimate' | 'mixed';
  terminalCoverage: 'complete' | 'partial';
}

export type UsageReporter = 'provider' | 'router';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Anomalies {
  private readonly seen = new Set<CacheUsageAnomaly>();

  add(code: CacheUsageAnomaly): void {
    if (this.seen.size >= MAX_ANOMALIES) return;
    this.seen.add(code);
  }

  list(): CacheUsageAnomaly[] | undefined {
    if (this.seen.size === 0) return undefined;
    return CACHE_USAGE_ANOMALIES.filter((code) => this.seen.has(code));
  }
}

/**
 * A recognized counter must be a finite, non-negative integer. Anything else
 * is ignored and produces a bounded code (cache-observability.md §2 rule 1). `present` distinguishes
 * "field absent" from "field present but unusable".
 *
 * JSON `null` is the exception: it is how a compatible server spells "no value"
 * for a numeric field rather than a broken payload, so it reads as absent. That
 * keeps `not-reported` meaning "no recognized counter arrived" (§1) instead of
 * flagging an otherwise healthy response. OpenRouter's Anthropic-compatible
 * surface sends it for `cache_creation_input_tokens` on every response, which
 * is what established the distinction. Every other unusable type still codes.
 */
function counter(
  source: Record<string, unknown>,
  key: string,
  anomalies: Anomalies,
): { value?: number; present: boolean } {
  if (!(key in source)) return { present: false };
  const raw = source[key];
  if (raw === null) return { present: false };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    anomalies.add('malformed-value');
    return { present: true };
  }
  if (raw < 0) {
    anomalies.add('negative-value');
    return { present: true };
  }
  if (!Number.isInteger(raw)) {
    anomalies.add('fractional-value');
    return { present: true };
  }
  return { value: raw, present: true };
}

/**
 * Resolve one logical counter from competing aliases. The caller lists aliases
 * in envelope-precedence order; LC takes the first usable one and never sums
 * them, because aliases may describe the same tokens (cache-observability.md §2 rule 7).
 *
 * Only a genuine disagreement is an anomaly. Providers routinely report the
 * same count twice — once under their native name, once under the envelope's
 * standard one. DeepSeek sends `prompt_cache_hit_tokens` alongside the
 * OpenAI-compatible `prompt_tokens_details.cached_tokens` on every Chat
 * Completions response, with the same value. Flagging mere co-presence fired
 * the code permanently on that provider, which buried a real divergence in
 * noise — the one thing the anomaly exists to surface.
 */
function firstAlias(
  candidates: Array<{ value?: number; present: boolean }>,
  anomalies: Anomalies,
): number | undefined {
  const values = candidates
    .filter((candidate) => candidate.present)
    .map((candidate) => candidate.value)
    .filter((value): value is number => value !== undefined);
  if (new Set(values).size > 1) anomalies.add('conflicting-aliases');
  return values[0];
}

function reasoningUsage(
  candidates: Array<{ value?: number; present: boolean }>,
  anomalies: Anomalies,
  measurement: NonNullable<NormalizedReasoningUsage['measurement']>,
): NormalizedReasoningUsage | undefined {
  const tokens = firstAlias(candidates, anomalies);
  // Preserve the pre-accounting response-local shape when no usable provider
  // counter arrived. Assistant-turn aggregation turns absence into the explicit
  // `not-reported` coverage state used by the footer.
  return tokens === undefined ? undefined : { status: 'reported', tokens, measurement };
}

function baseTotals(
  usage: Record<string, unknown>,
  promptKey: string,
  completionKey: string,
  anomalies: Anomalies,
): { prompt: number; completion: number; hasAny: boolean } {
  const prompt = counter(usage, promptKey, anomalies);
  const completion = counter(usage, completionKey, anomalies);
  return {
    prompt: prompt.value ?? 0,
    completion: completion.value ?? 0,
    hasAny: prompt.present || completion.present,
  };
}

function finishCache(
  cache: CacheUsage,
  anomalies: Anomalies,
  reportedBy: UsageReporter,
): CacheUsage {
  const list = anomalies.list();
  return {
    ...cache,
    reportedBy,
    ...(list ? { anomalies: list } : {}),
  };
}

/**
 * OpenAI-compatible Chat Completions envelope.
 *
 * Covers OpenAI, OpenRouter Chat Completions, DeepSeek, QwenCloud
 * OpenAI-compatible, MiniMax OpenAI-compatible, and Z.AI. `prompt_tokens`
 * already includes cached input for every one of them, so reads, writes, and
 * misses are details and are never added to the total (cache-observability.md §2 rules 3 and 6).
 */
export function normalizeChatCompletionsUsage(
  raw: unknown,
  reportedBy: UsageReporter = 'provider',
): NormalizedResponseUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const anomalies = new Anomalies();
  const { prompt, completion, hasAny } = baseTotals(raw, 'prompt_tokens', 'completion_tokens', anomalies);

  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const completionDetails = isRecord(raw.completion_tokens_details)
    ? raw.completion_tokens_details
    : {};
  const reasoning = reasoningUsage([
    counter(completionDetails, 'reasoning_tokens', anomalies),
    counter(raw, 'reasoning_tokens', anomalies),
  ], anomalies, 'provider-counter');

  const cachedDetail = counter(details, 'cached_tokens', anomalies);
  const hitAlias = counter(raw, 'prompt_cache_hit_tokens', anomalies);
  const readTokens = firstAlias([cachedDetail, hitAlias], anomalies);

  const writeDetail = counter(details, 'cache_write_tokens', anomalies);
  const creationDetail = counter(details, 'cache_creation_input_tokens', anomalies);
  const writeTokens = firstAlias([writeDetail, creationDetail], anomalies);

  const missCounter = counter(raw, 'prompt_cache_miss_tokens', anomalies);
  const missTokens = missCounter.value;

  const reported = cachedDetail.present || hitAlias.present || writeDetail.present
    || creationDetail.present || missCounter.present;

  if (!hasAny && !reported) return undefined;

  const totalCounter = counter(raw, 'total_tokens', anomalies);

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: totalCounter.value ?? prompt + completion,
    source: 'provider',
    ...(reasoning ? { reasoning } : {}),
    cache: finishCache({
      status: reported ? 'reported' : 'not-reported',
      ...(readTokens !== undefined ? { readTokens } : {}),
      ...(writeTokens !== undefined ? { writeTokens } : {}),
      ...(missTokens !== undefined ? { missTokens } : {}),
    }, anomalies, reportedBy),
  };
}

/**
 * OpenAI Responses envelope. Same semantics as Chat Completions with the
 * `input_tokens` / `input_tokens_details` naming. Covers OpenAI Responses,
 * OpenRouter Responses, and QwenCloud Responses.
 */
export function normalizeResponsesUsage(
  raw: unknown,
  reportedBy: UsageReporter = 'provider',
): NormalizedResponseUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const anomalies = new Anomalies();
  const { prompt, completion, hasAny } = baseTotals(raw, 'input_tokens', 'output_tokens', anomalies);

  const details = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : {};
  const outputDetails = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {};
  const reasoning = reasoningUsage([
    counter(outputDetails, 'reasoning_tokens', anomalies),
    counter(raw, 'reasoning_tokens', anomalies),
  ], anomalies, 'provider-counter');
  const cachedDetail = counter(details, 'cached_tokens', anomalies);
  const readTokens = cachedDetail.value;
  const writeDetail = counter(details, 'cache_write_tokens', anomalies);
  const creationDetail = counter(details, 'cache_creation_input_tokens', anomalies);
  const writeTokens = firstAlias([writeDetail, creationDetail], anomalies);

  const reported = cachedDetail.present || writeDetail.present || creationDetail.present;
  if (!hasAny && !reported) return undefined;

  const totalCounter = counter(raw, 'total_tokens', anomalies);

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: totalCounter.value ?? prompt + completion,
    source: 'provider',
    ...(reasoning ? { reasoning } : {}),
    cache: finishCache({
      status: reported ? 'reported' : 'not-reported',
      ...(readTokens !== undefined ? { readTokens } : {}),
      ...(writeTokens !== undefined ? { writeTokens } : {}),
    }, anomalies, reportedBy),
  };
}

/**
 * Anthropic Messages envelope, and the Anthropic-compatible surfaces of
 * QwenCloud and MiniMax.
 *
 * Anthropic's `input_tokens` EXCLUDES cache reads and creation tokens, so the
 * normalized prompt total is `input + cache_read + cache_creation` (cache-observability.md §2 rule
 * 4). Missing optional terms contribute zero to that documented sum only;
 * absence still reads as absence inside `cache`.
 *
 * `cache_creation_input_tokens` is the authoritative write total whenever the
 * optional TTL breakdown is also present — the breakdown is a detail of that
 * number and is never added a second time (cache-observability.md §2 rule 5).
 *
 * `providerContractId` is the contract-aware normalization seam: Meta
 * Messages names the same `input_tokens` / `cache_read_input_tokens` fields
 * but its prompt-token composition is unconfirmed (the repeated-prefix
 * experiment has not run), so today every caller normalizes additively while
 * the deviation row stands. Selecting a Meta-specific composition later must
 * happen here, keyed by exact contract ID — never by hostname or model name.
 */
export function normalizeAnthropicUsage(
  raw: unknown,
  reportedBy: UsageReporter = 'provider',
  options?: { providerContractId?: string },
): NormalizedResponseUsage | undefined {
  void options?.providerContractId;
  if (!isRecord(raw)) return undefined;
  const anomalies = new Anomalies();
  const { prompt: input, completion, hasAny } = baseTotals(raw, 'input_tokens', 'output_tokens', anomalies);
  const outputDetails = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {};
  const reasoning = reasoningUsage([
    counter(outputDetails, 'thinking_tokens', anomalies),
    counter(raw, 'thinking_tokens', anomalies),
  ], anomalies, 'provider-estimate');

  const read = counter(raw, 'cache_read_input_tokens', anomalies);
  const creation = counter(raw, 'cache_creation_input_tokens', anomalies);

  const breakdown = isRecord(raw.cache_creation) ? raw.cache_creation : undefined;
  const ephemeral5m = breakdown ? counter(breakdown, 'ephemeral_5m_input_tokens', anomalies) : { present: false, value: undefined };
  const ephemeral1h = breakdown ? counter(breakdown, 'ephemeral_1h_input_tokens', anomalies) : { present: false, value: undefined };
  const hasBreakdown = ephemeral5m.present || ephemeral1h.present;
  const breakdownSum = (ephemeral5m.value ?? 0) + (ephemeral1h.value ?? 0);

  // The authoritative total wins; the breakdown only fills in when the
  // authoritative field is absent, and never contributes twice.
  const writeTokens = creation.value !== undefined
    ? creation.value
    : hasBreakdown
      ? breakdownSum
      : undefined;

  if (creation.value !== undefined && hasBreakdown && breakdownSum !== creation.value) {
    anomalies.add('ttl-breakdown-mismatch');
  }

  const reported = read.present || creation.present || hasBreakdown;
  if (!hasAny && !reported) return undefined;

  // Only the two documented terms enter the sum — never the TTL breakdown.
  const promptTotal = input + (read.value ?? 0) + (creation.value ?? 0);

  return {
    prompt_tokens: promptTotal,
    completion_tokens: completion,
    total_tokens: promptTotal + completion,
    source: 'provider',
    ...(reasoning ? { reasoning } : {}),
    cache: finishCache({
      status: reported ? 'reported' : 'not-reported',
      ...(read.value !== undefined ? { readTokens: read.value } : {}),
      ...(writeTokens !== undefined ? { writeTokens } : {}),
      ...(hasBreakdown
        ? {
          writeTokensByTtl: {
            ...(ephemeral5m.value !== undefined ? { ephemeral5m: ephemeral5m.value } : {}),
            ...(ephemeral1h.value !== undefined ? { ephemeral1h: ephemeral1h.value } : {}),
          },
        }
        : {}),
    }, anomalies, reportedBy),
  };
}

/**
 * OpenRouter is a router/compatibility surface, not a per-upstream adapter.
 * Counters returned through it are labeled router-reported because the sticky
 * route can change for reasons outside LC's request (cache-observability.md §3, §5).
 *
 * Hostname is the only signal LC has here, and it is used only to weaken a
 * claim (provider -> router), never to name an upstream provider.
 */
export function usageReporterForBaseUrl(baseUrl?: string): UsageReporter {
  if (!baseUrl) return 'provider';
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai')
      ? 'router'
      : 'provider';
  } catch {
    return 'provider';
  }
}

/** Human-facing provenance label. Never claims an unidentified upstream. */
export function cacheUsageSourceLabel(cache: CacheUsage | undefined): string {
  if (!cache) return '';
  if (cache.status === 'not-reported') return 'not reported';
  return cache.reportedBy === 'router' ? 'OpenRouter reported' : 'provider reported';
}

function persistedTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Strict, additive validator for usage loaded from IndexedDB or an archive.
 * Legacy three-counter rows remain valid; unknown keys and malformed optional
 * detail fields are dropped instead of becoming trusted UI/accounting facts.
 */
export function normalizePersistedUsage(raw: unknown): NormalizedUsage | undefined {
  if (!isRecord(raw)
    || !persistedTokenCount(raw.prompt_tokens)
    || !persistedTokenCount(raw.completion_tokens)
    || !persistedTokenCount(raw.total_tokens)) return undefined;

  const normalized: NormalizedUsage = {
    prompt_tokens: raw.prompt_tokens,
    completion_tokens: raw.completion_tokens,
    total_tokens: raw.total_tokens,
  };
  if (isRecord(raw.tokenCoverage)) {
    const fields = ['input', 'output', 'total'] as const;
    if (!fields.every((field) => ['reported', 'partial', 'unreported'].includes(String((raw.tokenCoverage as Record<string, unknown>)[field])))) return undefined;
    normalized.tokenCoverage = {
      input: raw.tokenCoverage.input, output: raw.tokenCoverage.output, total: raw.tokenCoverage.total,
    } as NonNullable<NormalizedUsage['tokenCoverage']>;
  }
  if (raw.terminalCoverage === 'complete' || raw.terminalCoverage === 'partial') normalized.terminalCoverage = raw.terminalCoverage;
  if (raw.source === 'provider' || raw.source === 'lc-estimate' || raw.source === 'mixed') {
    normalized.source = raw.source;
  }

  if (isRecord(raw.cache)
    && (raw.cache.status === 'reported'
      || raw.cache.status === 'partially-reported'
      || raw.cache.status === 'not-reported')) {
    const cache: CacheUsage = { status: raw.cache.status };
    if (persistedTokenCount(raw.cache.readTokens)) cache.readTokens = raw.cache.readTokens;
    if (persistedTokenCount(raw.cache.writeTokens)) cache.writeTokens = raw.cache.writeTokens;
    if (persistedTokenCount(raw.cache.missTokens)) cache.missTokens = raw.cache.missTokens;
    if (raw.cache.reportedBy === 'provider' || raw.cache.reportedBy === 'router') {
      cache.reportedBy = raw.cache.reportedBy;
    }
    if (isRecord(raw.cache.writeTokensByTtl)) {
      const ttl: NonNullable<CacheUsage['writeTokensByTtl']> = {};
      if (persistedTokenCount(raw.cache.writeTokensByTtl.ephemeral5m)) {
        ttl.ephemeral5m = raw.cache.writeTokensByTtl.ephemeral5m;
      }
      if (persistedTokenCount(raw.cache.writeTokensByTtl.ephemeral1h)) {
        ttl.ephemeral1h = raw.cache.writeTokensByTtl.ephemeral1h;
      }
      if (Object.keys(ttl).length > 0) cache.writeTokensByTtl = ttl;
    }
    const rawAnomalies = raw.cache.anomalies;
    if (Array.isArray(rawAnomalies)) {
      const anomalies = CACHE_USAGE_ANOMALIES.filter((code) => rawAnomalies.includes(code))
        .slice(0, MAX_ANOMALIES);
      if (anomalies.length > 0) cache.anomalies = anomalies;
    }
    if (isRecord(raw.cache.coverage)
      && persistedTokenCount(raw.cache.coverage.reportedResponses)
      && persistedTokenCount(raw.cache.coverage.responseCount)
      && raw.cache.coverage.reportedResponses <= raw.cache.coverage.responseCount) {
      cache.coverage = {
        reportedResponses: raw.cache.coverage.reportedResponses,
        responseCount: raw.cache.coverage.responseCount,
      };
    }
    normalized.cache = cache;
  }

  if (raw.scope === 'assistant-turn') {
    if (!isRecord(raw.coverage)
      || !persistedTokenCount(raw.coverage.responseCount)
      || raw.coverage.responseCount < 1
      || !persistedTokenCount(raw.coverage.providerReportedResponses)
      || !persistedTokenCount(raw.coverage.estimatedResponses)
      || raw.coverage.providerReportedResponses + raw.coverage.estimatedResponses
        !== raw.coverage.responseCount) return undefined;
    if (raw.source !== 'provider' && raw.source !== 'lc-estimate' && raw.source !== 'mixed') {
      return undefined;
    }
    if ((raw.source === 'provider' && raw.coverage.estimatedResponses !== 0)
      || (raw.source === 'lc-estimate' && raw.coverage.providerReportedResponses !== 0)
      || (raw.source === 'mixed'
        && (raw.coverage.providerReportedResponses === 0 || raw.coverage.estimatedResponses === 0))) {
      return undefined;
    }
    if (raw.terminalCoverage !== 'complete' && raw.terminalCoverage !== 'partial') return undefined;
    normalized.scope = 'assistant-turn';
    normalized.coverage = {
      responseCount: raw.coverage.responseCount,
      providerReportedResponses: raw.coverage.providerReportedResponses,
      estimatedResponses: raw.coverage.estimatedResponses,
    };
    normalized.terminalCoverage = raw.terminalCoverage;
    let reasoningAccepted = false;
    if (isRecord(raw.reasoning)
      && (raw.reasoning.status === 'reported'
        || raw.reasoning.status === 'partially-reported'
        || raw.reasoning.status === 'not-reported')
      && persistedTokenCount(raw.reasoning.reportedResponses)
      && persistedTokenCount(raw.reasoning.responseCount)
      && raw.reasoning.responseCount === raw.coverage.responseCount
      && raw.reasoning.reportedResponses <= raw.reasoning.responseCount) {
      const hasReported = raw.reasoning.reportedResponses > 0;
      const statusMatches = raw.reasoning.status === 'not-reported'
        ? !hasReported
        : raw.reasoning.status === 'reported'
          ? raw.reasoning.reportedResponses === raw.reasoning.responseCount
          : hasReported && raw.reasoning.reportedResponses < raw.reasoning.responseCount;
      if (statusMatches && (!hasReported || persistedTokenCount(raw.reasoning.tokens))) {
        const measurements = Array.isArray(raw.reasoning.measurements)
          ? [...new Set(raw.reasoning.measurements.filter((value): value is
            'provider-counter' | 'provider-estimate' => value === 'provider-counter'
              || value === 'provider-estimate'))].sort()
          : undefined;
        normalized.reasoning = {
          status: raw.reasoning.status,
          ...(hasReported ? { tokens: raw.reasoning.tokens as number } : {}),
          reportedResponses: raw.reasoning.reportedResponses,
          responseCount: raw.reasoning.responseCount,
          ...(measurements?.length ? { measurements } : {}),
        };
        reasoningAccepted = true;
      }
    }
    if (!reasoningAccepted) return undefined;
    if (normalized.cache
      && (!normalized.cache.coverage
        || normalized.cache.coverage.responseCount !== raw.coverage.responseCount)) return undefined;
    return normalized;
  }

  if (isRecord(raw.reasoning)) {
    if (raw.reasoning.status === 'not-reported') {
      normalized.reasoning = { status: 'not-reported' };
    } else if (raw.reasoning.status === 'reported'
      && persistedTokenCount(raw.reasoning.tokens)
      && (raw.reasoning.measurement === 'provider-counter'
        || raw.reasoning.measurement === 'provider-estimate')) {
      normalized.reasoning = {
        status: 'reported',
        tokens: raw.reasoning.tokens,
        measurement: raw.reasoning.measurement,
      };
    }
  }
  return normalized;
}
