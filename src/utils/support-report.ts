/**
 * Current support report, pre-release version 1.
 *
 * LC has not been released, so the complete bounded diagnostic schema is its
 * first public format. `support-report-base.ts` supplies shared allowlists and base
 * section builders; it is not a separately supported historical format.
 *
 * Privacy boundary is unchanged and still three-layered:
 *   1. this builder constructs a fresh object from named fields only;
 *   2. unknown source keys are never copied into it; and
 *   3. `finalRecursiveRedaction` bounds and redacts the result before the one
 *      immutable string used by Preview, Copy, and Save.
 *
 * Collection is side-effect-free: it performs no network request, model
 * refresh, keychain read, conversation load, full storage scan, or repair. It
 * only summarizes facts already captured during normal operation.
 *
 * This module is pure. It imports no store, keychain helper, Tauri API, or
 * network client, which is what lets Safe Start share it verbatim.
 */

import { lcExportFileName } from './exportNames.ts';
import {
  AGE_BUCKETS,
  API_STYLES,
  CACHE_REPORTERS,
  CACHE_STATUSES,
  CACHE_SURFACES,
  CANONICAL_TOOL_NAMES,
  CONFIGURABLE_SEARCH_PROVIDERS,
  COUNT_BUCKETS,
  CREDENTIAL_STATES,
  CREDENTIAL_SURFACES,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_OPERATIONS,
  DIAGNOSTIC_OUTCOMES,
  DIAGNOSTIC_SUBSYSTEMS,
  DURATION_BUCKETS,
  ENDPOINT_CLASSES,
  IGNORED_SEARCH_PARAMS,
  MODEL_METADATA_SOURCES,
  PERMISSION_DISPOSITIONS,
  PROTOCOLS,
  REASONING_EFFORTS,
  REPORT_SURFACES,
  REQUEST_SNAPSHOT_SOURCES,
  ROUTINGS,
  SEARCH_PROVIDERS,
  SEARCH_PROVIDER_SELECTIONS,
  SUPPORT_REPORT_FORMAT,
  SUPPORT_REPORT_MAX_COLLECTION_ITEMS,
  SUPPORT_REPORT_MAX_DEPTH,
  SUPPORT_REPORT_MAX_EVENTS,
  SUPPORT_REPORT_MAX_SERIALIZED_BYTES,
  SUPPORT_REPORT_MAX_STRING_CHARACTERS,
  ageBucket,
  booleanOrUnknown,
  buildSupportReportBase,
  classifyEndpoint,
  durationBucket,
  finalRecursiveRedaction,
  finiteInteger,
  isRecord,
  oneOf,
  oneOfOptional,
  record,
  safeCount,
  sanitizeErrorDescription,
  type AgeBucket,
  type CacheSurface,
  type CanonicalToolName,
  type ConfigurableSearchProvider,
  type CountBucket,
  type CredentialState,
  type CredentialSurface,
  type DiagnosticEventV1,
  type DiagnosticApiStyle,
  type DiagnosticCacheReporter,
  type DiagnosticCacheStatus,
  type DiagnosticProtocol,
  type DiagnosticRouting,
  type DurationBucket,
  type EndpointClass,
  type IgnoredSearchParam,
  type ModelMetadataSource,
  type PermissionDisposition,
  type ReasoningEffortLevel,
  type ReportSurface,
  type RequestSnapshotSource,
  type SearchProviderName,
  type SearchProviderSelection,
  type SupportReportOptions,
  type SupportReportSnapshot,
  type SupportReportSources,
  type SupportReportBase,
} from './support-report-base.ts';
import { PREFIX_CONCLUSIONS, PREFIX_QUALIFIERS } from '../modules/llm-client/prefix-diagnostics.ts';
import type { PrefixConclusion, PrefixQualifier } from '../modules/llm-client/prefix-diagnostics';
import type { DiagnosticEvent } from './diagnostic-events';

export const SUPPORT_REPORT_VERSION_V1 = 1 as const;

/** Sections whose availability is reported individually (support-report.md collection health). */
export const REPORT_SECTIONS = [
  'application', 'runtime', 'startup', 'storage', 'providers', 'models',
  'modelDiscovery', 'authConfiguration', 'search', 'activeRequest', 'providerStream',
  'cacheAndPrefix', 'tools', 'skills', 'ui', 'diagnostics',
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export const COLLECTOR_FAILURE_CODES = ['collector-timeout', 'collector-failed'] as const;
export type CollectorFailureCode = (typeof COLLECTOR_FAILURE_CODES)[number];

export const SECTION_AVAILABILITY = ['available', 'unavailable'] as const;
export type SectionAvailability = (typeof SECTION_AVAILABILITY)[number];

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */

export interface SupportReportV1 {
  format: typeof SUPPORT_REPORT_FORMAT;
  version: typeof SUPPORT_REPORT_VERSION_V1;
  createdAt: string;

  /** Per-section health so a thin report is never mistaken for a healthy one. */
  collection: {
    surface: ReportSurface;
    sections: Record<ReportSection, SectionAvailability>;
    failures: Array<{ section: ReportSection; code: CollectorFailureCode }>;
    eventBufferReadable: boolean;
    eventsDropped: number;
    stringsTruncated: number;
    arraysTruncated: number;
    sizeReduced: boolean;
    /** Names of sections reduced to fit the byte bound. Never their content. */
    omitted: ReportSection[];
  };

  application: SupportReportBase['application'];
  runtime: SupportReportBase['runtime'];
  startup: SupportReportBase['startup'];

  storage: SupportReportBase['storage'] & {
    databaseOpen: OutcomeFact;
    metadataHydrate: OutcomeFact;
    indexedRead: OutcomeFact;
    durableWrite: OutcomeFact;
    lastDurableWriteAgeBucket: AgeBucket;
  };

  providers: SupportReportBase['providers'];
  models: SupportReportBase['models'];

  /**
   * The most recent chat request that actually ran, as observed at the
   * provider boundary. Never its content.
   *
   * `source` is load-bearing. `request` means these are the facts of a request
   * LC really sent; `current-configuration` means no request has run yet and
   * the section describes what is configured right now; `unavailable` means
   * neither was readable. A configuration fallback is never presented as an
   * observed request, and switching conversations or editing a profile after a
   * request cannot rewrite a `request` snapshot.
   */
  activeRequest: {
    available: boolean;
    source: RequestSnapshotSource;
    protocol: DiagnosticProtocol;
    apiStyle: DiagnosticApiStyle;
    routing: DiagnosticRouting;
    endpointClass: EndpointClass;
    cacheSurface: CacheSurface;
    reasoningEnabled: boolean | 'unknown';
    reasoningEffort: ReasoningEffortLevel;
    streamTimeoutBucket: DurationBucket;
    /**
     * Tool definitions in the final structured payload sent to the provider.
     * Absent when no request has run — a configuration fallback cannot know it,
     * and guessing would restate the old bug this field was introduced to fix.
     */
    toolDefinitionCount?: number;
    capabilities: {
      vision: boolean | 'unknown';
      reasoning: boolean | 'unknown';
      tools: boolean | 'unknown';
    };
    /** Whether a context-window size was known for the model (support-report.md). */
    contextWindowKnown: boolean | 'unknown';
  };

  modelDiscovery: {
    available: boolean;
    lastOutcome: OutcomeFact;
    returnedCountBucket: CountBucket;
    endpointClass: EndpointClass;
    metadataSource: ModelMetadataSource;
  };

  /**
   * Credential *configuration state* only. No keychain read is performed for
   * the report, and no reference name, account id, or value is included.
   *
   * The field is deliberately NOT named `credentials`: the final recursive
   * redaction pass blanks any key matching its sensitive-key regex, which
   * would erase this whole section even though it holds only closed enum
   * values. The name avoids that regex; the contents are what make it safe.
   */
  authConfiguration: {
    available: boolean;
    /**
     * Configuration state per surface plus that surface's own last bootstrap
     * outcome. The two are separate facts: a surface can be configured by
     * keychain reference and still have a failed bootstrap, which is exactly
     * the case a report must not round off into "configured, working".
     */
    surfaces: Array<{
      surface: CredentialSurface;
      state: CredentialState;
      bootstrap: OutcomeFact;
    }>;
    bootstrapOutcome: OutcomeFact;
  };

  search: {
    available: boolean;
    /** What the user selected. `auto` is a selection, not an absence. */
    selectedProvider: SearchProviderSelection;
    /**
     * What the resolver actually picked, taken only from real resolver/call
     * events. `none` means the resolver ran and found nothing usable;
     * `unknown` means no resolution has been observed this session. Neither is
     * inferred from configuration — a configured keychain reference is not
     * evidence that a usable key was ever loaded.
     */
    resolvedProvider: SearchProviderName;
    configured: boolean | 'unknown';
    /** Configuration state, deliberately distinct from runtime resolution. */
    configuredProviders: ConfigurableSearchProvider[];
    searxngEndpointClass: EndpointClass | 'not-configured';
    lastOutcome: OutcomeFact;
    resultCountBucket: CountBucket;
    ignoredParams: IgnoredSearchParam[];
  };

  /** The most recent request correlated with its own terminal stream result. */
  providerStream: {
    available: boolean;
    correlated: boolean;
    request: OutcomeFact;
    stream: OutcomeFact;
    finishCode: string;
    cancelled: boolean;
    timedOut: boolean;
    retried: boolean;
    durationBucket: DurationBucket;
    usageReported: boolean;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };

  cacheAndPrefix: {
    available: boolean;
    status: DiagnosticCacheStatus;
    reportedBy: DiagnosticCacheReporter;
    readTokens?: number;
    writeTokens?: number;
    missTokens?: number;
    prefixConclusion: PrefixConclusion | 'unknown';
    prefixQualifiers: PrefixQualifier[];
    conclusionCounts: Array<{ conclusion: PrefixConclusion; count: number }>;
  };

  tools: SupportReportBase['tools'] & {
    recent: {
      available: boolean;
      tool: CanonicalToolName;
      outcome: OutcomeFact;
      permission: PermissionDisposition;
      durationBucket: DurationBucket;
    };
  };

  skills: SupportReportBase['skills'];
  streaming: SupportReportBase['streaming'];

  ui: SupportReportBase['ui'] & {
    reportSurface: ReportSurface;
    safeStartActions: Array<{ code: string; outcome: string }>;
  };

  diagnostics: SupportReportBase['diagnostics'];
  limits: SupportReportBase['limits'];
}

/** A bounded outcome pair. `code` is always a closed LC vocabulary value. */
export interface OutcomeFact {
  outcome: 'ok' | 'cancelled' | 'timeout' | 'rejected' | 'error' | 'unknown';
  code: string;
  httpStatus?: number;
}

export { CREDENTIAL_SURFACES } from './support-report-base.ts';
export type { CredentialSurface } from './support-report-base';

/* ------------------------------------------------------------------ */
/*  Version-1 sources                                                  */
/* ------------------------------------------------------------------ */

export interface SupportReportV1Sources extends SupportReportSources {
  /** `settings` or `safe-start`. */
  reportSurface?: unknown;
  /** Sections the collector could not read, with a bounded reason. */
  collectorFailures?: unknown;
  /** True when a persisted diagnostic buffer existed but could not be parsed. */
  eventBufferReadable?: unknown;
  /** Resolved shape of the most recent chat request. Never its content. */
  activeRequest?: unknown;
  /** Configuration state per surface. Never a value or reference name. */
  credentials?: unknown;
  /** Selected/resolved search provider and configuration presence. */
  search?: unknown;
}

const UNKNOWN_OUTCOME: OutcomeFact = { outcome: 'unknown', code: 'unknown' };

const OUTCOMES = ['ok', 'cancelled', 'timeout', 'rejected', 'error', 'unknown'] as const;

function outcomeFact(event: DiagnosticEvent | undefined): OutcomeFact {
  if (!event) return { ...UNKNOWN_OUTCOME };
  const fact: OutcomeFact = {
    outcome: oneOf(event.outcome, OUTCOMES, 'unknown'),
    // Clamped to the closed LC vocabulary. The builder never trusts its input:
    // an unrecognized code could otherwise carry arbitrary provider text.
    code: oneOf(event.code, DIAGNOSTIC_CODES, 'unknown'),
  };
  const status = finiteInteger(event.httpStatus, 100, 599);
  if (status !== undefined) fact.httpStatus = status;
  return fact;
}

function latest(
  events: readonly DiagnosticEvent[],
  match: (event: DiagnosticEvent) => boolean,
): DiagnosticEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (match(events[i])) return events[i];
  }
  return undefined;
}

/**
 * Project the event ring for the complete version-1 report.
 *
 * Version 1's projection clamps subsystem, operation, and code to the frozen
 * base vocabulary, which omits some operations used by the current schema:
 * reusing it dropped every `model`, `search`, and `credential` event outright
 * and degraded newer operation and code values to `unknown`. A real report showed
 * 52 events of which almost none could be identified.
 *
 * The field set is deliberately identical to the base event projection — subsystem, operation,
 * outcome, code, optional HTTP status, and numeric usage counters. The closed
 * context fields stay out: they are already summarized in the sections above,
 * and repeating them across 64 entries would spend the byte budget restating
 * what the report already says. The correlation number is never copied.
 */
function projectCurrentEvents(
  events: readonly DiagnosticEvent[],
  options: SupportReportOptions,
): DiagnosticEventV1[] {
  const out: DiagnosticEventV1[] = [];
  for (const source of events.slice(-SUPPORT_REPORT_MAX_EVENTS)) {
    const subsystem = oneOfOptional(source.subsystem, DIAGNOSTIC_SUBSYSTEMS);
    const outcome = oneOfOptional(source.outcome, DIAGNOSTIC_OUTCOMES);
    const at = finiteInteger(source.at, 0, Number.MAX_SAFE_INTEGER);
    if (at === undefined || subsystem === undefined || outcome === undefined) continue;

    const event: DiagnosticEventV1 = {
      at,
      subsystem,
      operation: oneOf(source.operation, DIAGNOSTIC_OPERATIONS, 'unknown'),
      outcome,
    };
    if (typeof source.code === 'string') {
      event.code = oneOf(source.code, DIAGNOSTIC_CODES, 'unknown');
    }
    const httpStatus = finiteInteger(source.httpStatus, 100, 599);
    if (httpStatus !== undefined) event.httpStatus = httpStatus;
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens'] as const) {
      const value = finiteInteger(source[key]);
      if (value !== undefined) event[key] = value;
    }
    if (options.includeErrorDescriptions && typeof source.description === 'string') {
      event.description = sanitizeErrorDescription(source.description);
    }
    out.push(event);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Builder                                                            */
/* ------------------------------------------------------------------ */

export function buildSupportReportV1(
  rawSources: SupportReportV1Sources,
  options: SupportReportOptions = {},
  now = new Date(),
): SupportReportV1 {
  // A malformed, absent, or hostile sources object must never make report
  // creation fail (support-report.md). Everything below reads named fields off this record.
  const sources: SupportReportV1Sources = isRecord(rawSources) ? rawSources : {};
  // Version 1 already builds every shared fact from the same allowlist. Reusing
  // it keeps the two schemas from drifting and keeps redaction in one place.
  const base = buildSupportReportBase(sources, options, now);

  // Entries are filtered to records before any field access: the ring is
  // normalized in production, but the builder must not trust its input.
  const events: DiagnosticEvent[] = Array.isArray(sources.diagnosticEvents)
    ? (sources.diagnosticEvents as unknown[])
      .filter((event): event is DiagnosticEvent => isRecord(event))
      .slice(-SUPPORT_REPORT_MAX_EVENTS)
    : [];
  const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : 0;
  const projectedEvents = projectCurrentEvents(events, options);

  const surface = oneOf(sources.reportSurface, REPORT_SURFACES, 'unknown');

  /* ---- storage outcomes ---- */
  const storageEvent = (operationCode: string) =>
    latest(events, (event) => event.subsystem === 'storage' && event.code === operationCode);
  const durableWrite = latest(events, (event) =>
    event.subsystem === 'storage'
    && (event.code === 'storage-write-ok' || event.code === 'storage-write-failed'));
  const lastWriteOkAt = latest(events, (event) => event.code === 'storage-write-ok')?.at;

  /* ---- active request ---- */
  const activeRequestSource = record(sources.activeRequest);
  const activeRequestAvailable = isRecord(sources.activeRequest);
  const capabilities = record(activeRequestSource.capabilities);
  // The collector labels its own payload. An unlabelled one is treated as a
  // configuration description, never as an observed request: claiming a
  // request ran is the one mistake this field exists to prevent.
  const activeRequestSource_: RequestSnapshotSource = !activeRequestAvailable
    ? 'unavailable'
    : oneOf(activeRequestSource.source, REQUEST_SNAPSHOT_SOURCES, 'current-configuration');

  /* ---- model discovery ---- */
  const modelEvent = latest(events, (event) => event.subsystem === 'model');

  /* ---- credentials ---- */
  const credentialSource = Array.isArray(sources.credentials) ? sources.credentials : [];
  const credentialSurfaces: SupportReportV1['authConfiguration']['surfaces'] = [];
  for (const entry of credentialSource.slice(0, CREDENTIAL_SURFACES.length)) {
    const item = record(entry);
    const name = oneOfOptional(item.surface, CREDENTIAL_SURFACES);
    if (!name) continue;
    credentialSurfaces.push({
      surface: name,
      state: oneOf(item.state, CREDENTIAL_STATES, 'unknown'),
      // That surface's own bootstrap, not whichever surface happened to
      // bootstrap most recently.
      bootstrap: outcomeFact(latest(events, (event) =>
        event.subsystem === 'credential' && event.credentialSurface === name)),
    });
  }
  const credentialEvent = latest(events, (event) => event.subsystem === 'credential');

  /* ---- search ---- */
  const searchSource = record(sources.search);
  const searchEvent = latest(events, (event) => event.subsystem === 'search');
  const searchCall = latest(events, (event) => event.subsystem === 'search' && event.operation === 'call');
  // Only a real resolver or call event may name the resolved provider.
  // Configuration presence is not evidence that a usable credential loaded.
  const searchResolution = latest(events, (event) =>
    event.subsystem === 'search' && event.searchResolved !== undefined);
  const configuredProviders = searchEvent?.searchConfiguredProviders
    ?? (Array.isArray(searchSource.configuredProviders)
      ? searchSource.configuredProviders.filter(
        (name): name is ConfigurableSearchProvider =>
          (CONFIGURABLE_SEARCH_PROVIDERS as readonly unknown[]).includes(name),
      )
      : []);

  /* ---- provider / stream correlation ---- */
  // The pairing uses only the ephemeral ring sequence: no provider, request,
  // message, conversation, or profile identifier and no content hash (support-report.md).
  //
  // A streaming request always carries a sequence, so it is preferred over a
  // non-streaming one (`chatOnce`, used for sub-agent and title work). Without
  // that preference a background sub-agent call could become "the most recent
  // request" and silently break correlation for the stream the user is asking
  // about.
  const lastStreamingRequest = latest(events, (event) =>
    event.subsystem === 'provider' && event.operation === 'request' && event.sequence !== undefined);
  const lastRequest = lastStreamingRequest
    ?? latest(events, (event) => event.subsystem === 'provider' && event.operation === 'request');
  const pairedStream = lastRequest?.sequence !== undefined
    ? latest(events, (event) =>
      event.subsystem === 'stream' && event.sequence === lastRequest.sequence)
    : undefined;
  // A stream event is reported only when it belongs to this request. The
  // fallback applies solely when there is no request to mismatch against —
  // after a reload, for instance, where sequences do not survive on purpose.
  const lastStream = pairedStream
    ?? (lastRequest === undefined
      ? latest(events, (event) => event.subsystem === 'stream' && event.operation === 'completion')
      : undefined);
  const correlated = pairedStream !== undefined;

  /* ---- cache and prefix ---- */
  const cacheEvent = latest(events, (event) => event.cacheStatus !== undefined) ?? lastStream;
  const conclusionCounts: Array<{ conclusion: PrefixConclusion; count: number }> = [];
  for (const conclusion of PREFIX_CONCLUSIONS) {
    const count = events.filter((event) => event.prefixConclusion === conclusion).length;
    if (count > 0) conclusionCounts.push({ conclusion, count });
  }
  const prefixEvent = latest(events, (event) => event.prefixConclusion !== undefined);

  /* ---- tools ---- */
  // One event carries the tool, its outcome, and the permission that allowed
  // it. The disposition rides on the execution event rather than being
  // recorded separately, so it always describes this execution; a denied or
  // unavailable flow never executes and is itself the latest tool event.
  const toolEvent = latest(events, (event) => event.subsystem === 'tool');

  /* ---- safe start actions ---- */
  const safeStartActions = events
    .filter((event) => event.operation === 'recovery-action')
    .slice(-SUPPORT_REPORT_MAX_COLLECTION_ITEMS)
    .map((event) => ({
      code: oneOf(event.code, DIAGNOSTIC_CODES, 'unknown'),
      outcome: oneOf(event.outcome, OUTCOMES, 'unknown'),
    }));

  /* ---- collection health ---- */
  const sections = {} as Record<ReportSection, SectionAvailability>;
  const availability: Record<ReportSection, boolean> = {
    application: true,
    runtime: true,
    startup: isRecord(sources.startup),
    storage: base.storage.integrity.settingsReadable || base.storage.integrity.conversationCountReadable
      || base.storage.integrity.estimateReadable,
    providers: base.storage.integrity.profilesReadable,
    models: base.models.count > 0 || base.storage.integrity.profilesReadable,
    modelDiscovery: modelEvent !== undefined,
    authConfiguration: credentialSurfaces.length > 0,
    search: isRecord(sources.search) || searchEvent !== undefined,
    activeRequest: activeRequestAvailable,
    providerStream: lastRequest !== undefined || lastStream !== undefined,
    cacheAndPrefix: cacheEvent !== undefined || prefixEvent !== undefined,
    tools: base.tools.activePolicyAvailable,
    skills: base.skills.activePolicyAvailable,
    ui: base.storage.integrity.settingsReadable,
    diagnostics: true,
  };
  for (const section of REPORT_SECTIONS) {
    sections[section] = availability[section] ? 'available' : 'unavailable';
  }

  const failures: SupportReportV1['collection']['failures'] = [];
  const failureSource = Array.isArray(sources.collectorFailures) ? sources.collectorFailures : [];
  for (const entry of failureSource.slice(0, REPORT_SECTIONS.length)) {
    const item = record(entry);
    const section = oneOfOptional(item.section, REPORT_SECTIONS);
    if (!section) continue;
    failures.push({
      section,
      code: oneOf(item.code, COLLECTOR_FAILURE_CODES, 'collector-failed'),
    });
  }

  return {
    format: SUPPORT_REPORT_FORMAT,
    version: SUPPORT_REPORT_VERSION_V1,
    createdAt: base.createdAt,

    collection: {
      surface,
      sections,
      failures,
      eventBufferReadable: sources.eventBufferReadable !== false,
      eventsDropped: base.limits.eventsDropped,
      stringsTruncated: base.limits.stringsTruncated,
      arraysTruncated: base.limits.arraysTruncated,
      sizeReduced: false,
      omitted: [],
    },

    application: base.application,
    runtime: base.runtime,
    startup: base.startup,

    storage: {
      ...base.storage,
      databaseOpen: outcomeFact(storageEvent('storage-open-ok') ?? storageEvent('storage-open-failed')),
      metadataHydrate: outcomeFact(storageEvent('storage-hydrate-ok') ?? storageEvent('storage-hydrate-failed')),
      indexedRead: outcomeFact(storageEvent('storage-read-ok') ?? storageEvent('storage-read-failed')),
      durableWrite: outcomeFact(durableWrite),
      lastDurableWriteAgeBucket: lastWriteOkAt === undefined
        ? oneOf('never', AGE_BUCKETS, 'unknown')
        : ageBucket(lastWriteOkAt, nowMs),
    },

    providers: base.providers,
    models: base.models,

    activeRequest: {
      available: activeRequestAvailable,
      source: activeRequestSource_,
      protocol: oneOf(activeRequestSource.protocol, PROTOCOLS, 'unknown'),
      apiStyle: oneOf(activeRequestSource.apiStyle, API_STYLES, 'unknown'),
      routing: oneOf(activeRequestSource.routing, ROUTINGS, 'unknown'),
      endpointClass: activeRequestSource.baseUrl !== undefined
        ? classifyEndpoint(activeRequestSource.baseUrl)
        : oneOf(activeRequestSource.endpointClass, ENDPOINT_CLASSES, 'invalid'),
      cacheSurface: oneOf(activeRequestSource.cacheSurface, CACHE_SURFACES, 'unknown'),
      reasoningEnabled: booleanOrUnknown(activeRequestSource.reasoningEnabled),
      reasoningEffort: oneOf(activeRequestSource.reasoningEffort, REASONING_EFFORTS, 'unknown'),
      streamTimeoutBucket: durationBucket(activeRequestSource.streamTimeoutMs),
      // Only a real request knows this. A configuration fallback omits it
      // rather than restating a count of policy keys as a tool count.
      ...(activeRequestSource_ === 'request'
        ? { toolDefinitionCount: safeCount(activeRequestSource.toolDefinitionCount) }
        : {}),
      capabilities: {
        vision: booleanOrUnknown(capabilities.vision),
        reasoning: booleanOrUnknown(capabilities.reasoning),
        tools: booleanOrUnknown(capabilities.tools),
      },
      contextWindowKnown: booleanOrUnknown(activeRequestSource.contextWindowKnown),
    },

    modelDiscovery: {
      available: modelEvent !== undefined,
      lastOutcome: outcomeFact(modelEvent),
      returnedCountBucket: oneOf(modelEvent?.returnedCountBucket, COUNT_BUCKETS, 'unknown'),
      endpointClass: oneOf(modelEvent?.endpointClass, ENDPOINT_CLASSES, 'invalid'),
      metadataSource: oneOf(modelEvent?.metadataSource, MODEL_METADATA_SOURCES, 'unknown'),
    },

    authConfiguration: {
      available: credentialSurfaces.length > 0,
      surfaces: credentialSurfaces,
      bootstrapOutcome: outcomeFact(credentialEvent),
    },

    search: {
      available: isRecord(sources.search) || searchEvent !== undefined,
      // A live event wins over the collector's reading of settings: the
      // resolver is what the tools actually ran.
      selectedProvider: oneOf(
        searchEvent?.searchSelected ?? searchSource.selected,
        SEARCH_PROVIDER_SELECTIONS,
        'unknown',
      ),
      resolvedProvider: oneOf(
        searchResolution?.searchResolved, SEARCH_PROVIDERS, 'unknown',
      ),
      configured: booleanOrUnknown(searchEvent?.searchConfigured ?? searchSource.configured),
      configuredProviders: configuredProviders.slice(0, CONFIGURABLE_SEARCH_PROVIDERS.length),
      searxngEndpointClass: searchSource.searxngBaseUrl !== undefined
        ? classifyEndpoint(searchSource.searxngBaseUrl)
        : 'not-configured',
      lastOutcome: outcomeFact(searchCall ?? searchEvent),
      resultCountBucket: oneOf(searchCall?.resultCountBucket, COUNT_BUCKETS, 'unknown'),
      ignoredParams: (searchCall?.ignoredParams ?? [])
        .filter((name): name is IgnoredSearchParam => IGNORED_SEARCH_PARAMS.includes(name))
        .slice(0, IGNORED_SEARCH_PARAMS.length),
    },

    providerStream: {
      available: lastRequest !== undefined || lastStream !== undefined,
      correlated,
      request: outcomeFact(lastRequest),
      stream: outcomeFact(lastStream),
      finishCode: oneOf(lastStream?.code, DIAGNOSTIC_CODES, 'unknown'),
      cancelled: lastStream?.outcome === 'cancelled' || lastRequest?.outcome === 'cancelled',
      timedOut: lastStream?.outcome === 'timeout' || lastRequest?.outcome === 'timeout',
      retried: lastRequest?.retried === true,
      durationBucket: oneOf(lastStream?.durationBucket, DURATION_BUCKETS, 'unknown'),
      usageReported: lastStream?.usageReported === true,
      ...(lastStream?.promptTokens !== undefined ? { promptTokens: lastStream.promptTokens } : {}),
      ...(lastStream?.completionTokens !== undefined ? { completionTokens: lastStream.completionTokens } : {}),
      ...(lastStream?.totalTokens !== undefined ? { totalTokens: lastStream.totalTokens } : {}),
    },

    cacheAndPrefix: {
      available: cacheEvent !== undefined || prefixEvent !== undefined,
      status: oneOf(cacheEvent?.cacheStatus, CACHE_STATUSES, 'unknown'),
      reportedBy: oneOf(cacheEvent?.cacheReportedBy, CACHE_REPORTERS, 'unknown'),
      ...(cacheEvent?.cacheReadTokens !== undefined ? { readTokens: cacheEvent.cacheReadTokens } : {}),
      ...(cacheEvent?.cacheWriteTokens !== undefined ? { writeTokens: cacheEvent.cacheWriteTokens } : {}),
      ...(cacheEvent?.cacheMissTokens !== undefined ? { missTokens: cacheEvent.cacheMissTokens } : {}),
      prefixConclusion: oneOfOptional(prefixEvent?.prefixConclusion, PREFIX_CONCLUSIONS) ?? 'unknown',
      prefixQualifiers: (prefixEvent?.prefixQualifiers ?? [])
        .filter((name): name is PrefixQualifier => PREFIX_QUALIFIERS.includes(name))
        .slice(0, PREFIX_QUALIFIERS.length),
      conclusionCounts,
    },

    tools: {
      ...base.tools,
      recent: {
        available: toolEvent !== undefined,
        tool: oneOf(toolEvent?.tool, CANONICAL_TOOL_NAMES, 'unknown'),
        outcome: outcomeFact(toolEvent),
        permission: oneOf(toolEvent?.permission, PERMISSION_DISPOSITIONS, 'unknown'),
        durationBucket: oneOf(toolEvent?.durationBucket, DURATION_BUCKETS, 'unknown'),
      },
    },

    skills: base.skills,
    streaming: base.streaming,

    ui: {
      ...base.ui,
      reportSurface: surface,
      safeStartActions,
    },

    diagnostics: {
      descriptionsIncluded: options.includeErrorDescriptions === true,
      eventCount: projectedEvents.length,
      events: projectedEvents,
    },
    limits: base.limits,
  };
}

/* ------------------------------------------------------------------ */
/*  Serialization                                                      */
/* ------------------------------------------------------------------ */

function serializeCandidate(report: SupportReportV1): {
  report: SupportReportV1; serialized: string; bytes: number;
} {
  const redacted = finalRecursiveRedaction(report) as SupportReportV1;
  const serialized = `${JSON.stringify(redacted, null, 2)}\n`;
  return { report: redacted, serialized, bytes: new TextEncoder().encode(serialized).byteLength };
}

/**
 * Apply final redaction and the hard serialized-size fallback.
 *
 * Reduction always records which sections were shortened, so a smaller report
 * never reads as a complete one.
 */
export function finalizeSupportReportV1(report: SupportReportV1): {
  report: SupportReportV1; serialized: string; byteLength: number;
} {
  let candidate = serializeCandidate(report);
  if (candidate.bytes <= SUPPORT_REPORT_MAX_SERIALIZED_BYTES) {
    return { report: candidate.report, serialized: candidate.serialized, byteLength: candidate.bytes };
  }

  const reduced: SupportReportV1 = {
    ...candidate.report,
    providers: {
      ...candidate.report.providers,
      configurations: candidate.report.providers.configurations.slice(0, 8),
      configurationsSampled: Math.min(candidate.report.providers.configurationsSampled, 8),
    },
    models: {
      ...candidate.report.models,
      identifiersTruncated: true,
      ...(candidate.report.models.identifiersIncluded ? { identifiers: [] } : {}),
    },
    diagnostics: {
      ...candidate.report.diagnostics,
      eventCount: Math.min(candidate.report.diagnostics.eventCount, 16),
      events: candidate.report.diagnostics.events.slice(-16)
        .map(({ description: _description, ...event }) => event),
    },
    cacheAndPrefix: { ...candidate.report.cacheAndPrefix, conclusionCounts: [] },
    ui: { ...candidate.report.ui, safeStartActions: [] },
    collection: {
      ...candidate.report.collection,
      sizeReduced: true,
      arraysTruncated: candidate.report.collection.arraysTruncated + 1,
      omitted: ['providers', 'models', 'diagnostics', 'cacheAndPrefix', 'ui'],
    },
    limits: { ...candidate.report.limits, sizeReduced: true },
  };
  candidate = serializeCandidate(reduced);
  if (candidate.bytes <= SUPPORT_REPORT_MAX_SERIALIZED_BYTES) {
    return { report: candidate.report, serialized: candidate.serialized, byteLength: candidate.bytes };
  }

  // A complete schema-shaped fallback rather than a byte slice, so the result
  // stays parseable even if a future addition consumes the primary budget.
  const minimal: SupportReportV1 = {
    ...candidate.report,
    providers: { ...candidate.report.providers, configurationsSampled: 0, configurations: [] },
    models: {
      ...candidate.report.models,
      identifiersTruncated: true,
      ...(candidate.report.models.identifiersIncluded ? { identifiers: [] } : {}),
    },
    diagnostics: { ...candidate.report.diagnostics, eventCount: 0, events: [] },
    cacheAndPrefix: { ...candidate.report.cacheAndPrefix, conclusionCounts: [] },
    ui: { ...candidate.report.ui, safeStartActions: [] },
    authConfiguration: { ...candidate.report.authConfiguration, surfaces: [] },
    collection: {
      ...candidate.report.collection,
      failures: [],
      sizeReduced: true,
      arraysTruncated: candidate.report.collection.arraysTruncated + 1,
      omitted: ['providers', 'models', 'diagnostics', 'cacheAndPrefix', 'ui', 'authConfiguration'],
    },
    limits: { ...candidate.report.limits, sizeReduced: true },
  };
  candidate = serializeCandidate(minimal);
  return { report: candidate.report, serialized: candidate.serialized, byteLength: candidate.bytes };
}

export function supportReportFilenameV1(date: Date): string {
  return lcExportFileName(`support-v${SUPPORT_REPORT_VERSION_V1}`, 'json', date);
}

/**
 * Build and freeze the exact delivery payload. Preview, Copy, and Save all use
 * this one immutable byte sequence, including its trailing newline.
 */
export function createSupportReportSnapshotV1(
  sources: SupportReportV1Sources,
  options: SupportReportOptions = {},
  now = new Date(),
): SupportReportSnapshot {
  const final = finalizeSupportReportV1(buildSupportReportV1(sources, options, now));
  return Object.freeze({
    filename: supportReportFilenameV1(now),
    serialized: final.serialized,
    byteLength: final.byteLength,
  });
}

/* ------------------------------------------------------------------ */
/*  Validation                                                         */
/* ------------------------------------------------------------------ */

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Strict v1 envelope validator used by tests and future import tooling. */
export function isSupportReportV1(value: unknown): value is SupportReportV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'format', 'version', 'createdAt', 'collection', 'application', 'runtime', 'startup',
    'storage', 'providers', 'models', 'activeRequest', 'modelDiscovery', 'authConfiguration',
    'search', 'providerStream', 'cacheAndPrefix', 'tools', 'skills', 'streaming', 'ui',
    'diagnostics', 'limits',
  ])) return false;
  if (value.format !== SUPPORT_REPORT_FORMAT || value.version !== SUPPORT_REPORT_VERSION_V1) return false;
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return false;

  const collection = record(value.collection);
  const sections = record(collection.sections);
  if (!REPORT_SECTIONS.every((section) => SECTION_AVAILABILITY.includes(
    sections[section] as SectionAvailability,
  ))) return false;
  if (!Array.isArray(collection.failures) || typeof collection.eventBufferReadable !== 'boolean') return false;
  if (!Array.isArray(collection.omitted) || typeof collection.sizeReduced !== 'boolean') return false;

  for (const key of [
    'application', 'runtime', 'startup', 'storage', 'providers', 'models', 'activeRequest',
    'modelDiscovery', 'authConfiguration', 'search', 'providerStream', 'cacheAndPrefix', 'tools',
    'skills', 'streaming', 'ui', 'diagnostics', 'limits',
  ]) {
    if (!isRecord(value[key])) return false;
  }

  const limits = record(value.limits);
  return finiteInteger(limits.maxSerializedBytes) !== undefined
    && limits.maxSerializedBytes === SUPPORT_REPORT_MAX_SERIALIZED_BYTES
    && limits.maxStringCharacters === SUPPORT_REPORT_MAX_STRING_CHARACTERS
    && limits.maxEvents === SUPPORT_REPORT_MAX_EVENTS
    && limits.maxDepth === SUPPORT_REPORT_MAX_DEPTH;
}
