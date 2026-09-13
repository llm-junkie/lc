/**
 * Small persisted ring of structured diagnostics. No log messages, request
 * bodies, tool arguments/results, paths, prompts, or arbitrary payload keys
 * are accepted by this module.
 *
 * Every context field is a closed, LC-owned enum or a bounded number
 * (docs/support-report.md). Values that do not match a known enum are
 * dropped rather than carried through as arbitrary provider text.
 *
 * Recording never throws: a diagnostic must never change the outcome of the
 * operation being observed (support-report.md).
 */

import {
  API_STYLES,
  CACHE_REPORTERS,
  CACHE_STATUSES,
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
  ROUTINGS,
  SEARCH_PROVIDERS,
  SEARCH_PROVIDER_SELECTIONS,
  SUPPORT_REPORT_MAX_EVENTS,
  sanitizeErrorDescription,
  type ConfigurableSearchProvider,
  type CredentialSurface,
  type DiagnosticApiStyle,
  type DiagnosticCacheReporter,
  type DiagnosticCacheStatus,
  type CanonicalToolName,
  type CountBucket,
  type CredentialState,
  type DiagnosticCode,
  type DiagnosticOperation,
  type DiagnosticOutcome,
  type DiagnosticSubsystem,
  type DurationBucket,
  type EndpointClass,
  type IgnoredSearchParam,
  type ModelMetadataSource,
  type PermissionDisposition,
  type DiagnosticProtocol,
  type DiagnosticRouting,
  type SearchProviderName,
  type SearchProviderSelection,
} from './support-report-base.ts';
import { PREFIX_CONCLUSIONS, PREFIX_QUALIFIERS } from '../modules/llm-client/prefix-diagnostics.ts';
import type { PrefixConclusion, PrefixQualifier } from '../modules/llm-client/prefix-diagnostics';

const EVENT_STORAGE_KEY = 'lc:diagnostics:v1';
const MAX_PERSISTED_EVENT_CHARACTERS = 64 * 1024;
/** Correlation sequence wraps well below any precision concern. */
const MAX_SEQUENCE = 4_096;
/** Ignored-parameter names retained per event. The vocabulary is only 3 long. */
const MAX_IGNORED_PARAMS = IGNORED_SEARCH_PARAMS.length;
const MAX_PREFIX_QUALIFIERS = PREFIX_QUALIFIERS.length;

/**
 * One recorded diagnostic for the initial version-1 support-report contract.
 * Every optional context field is closed-vocabulary and remains safe to omit.
 */
export interface DiagnosticEvent {
  at: number;
  subsystem: DiagnosticSubsystem;
  operation: DiagnosticOperation;
  outcome: DiagnosticOutcome;
  code?: DiagnosticCode;
  httpStatus?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  description?: string;

  /**
   * Ephemeral, bounded, per-session counter used ONLY to pair a provider
   * request with its terminal stream result inside this ring. It is not a
   * provider, request, message, conversation, or profile identifier, and not
   * a content hash. It never leaves the bounded ring.
   */
  sequence?: number;

  protocol?: DiagnosticProtocol;
  apiStyle?: DiagnosticApiStyle;
  routing?: DiagnosticRouting;
  endpointClass?: EndpointClass;
  durationBucket?: DurationBucket;
  retried?: boolean;
  usageReported?: boolean;

  cacheStatus?: DiagnosticCacheStatus;
  cacheReportedBy?: DiagnosticCacheReporter;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  prefixConclusion?: PrefixConclusion;
  prefixQualifiers?: PrefixQualifier[];

  tool?: CanonicalToolName;
  permission?: PermissionDisposition;

  /** What the user selected. `auto` is a selection, not an absence. */
  searchSelected?: SearchProviderSelection;
  /** What the resolver actually picked, or `none` when nothing was usable. */
  searchResolved?: SearchProviderName;
  searchConfigured?: boolean;
  /** Bounded configuration state, distinct from the runtime resolution. */
  searchConfiguredProviders?: ConfigurableSearchProvider[];
  ignoredParams?: IgnoredSearchParam[];
  resultCountBucket?: CountBucket;

  credentialState?: CredentialState;
  /** Which credential slot an outcome belongs to. Never a reference name. */
  credentialSurface?: CredentialSurface;
  metadataSource?: ModelMetadataSource;
  returnedCountBucket?: CountBucket;
}

export interface DiagnosticEventInput extends Omit<DiagnosticEvent, 'at' | 'description'> {
  at?: number;
  /** Sanitized immediately; the raw value is never persisted. */
  description?: unknown;
}

export interface DiagnosticStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === 'string' && values.includes(value) ? value : undefined;
}

function finiteInteger(value: unknown, min = 0, max = 1_000_000_000): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : undefined;
}

function enumList<const T extends readonly string[]>(
  value: unknown,
  values: T,
  max: number,
): T[number][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[number][] = [];
  for (const entry of value) {
    const match = oneOf(entry, values);
    if (match && !out.includes(match)) out.push(match);
    if (out.length >= max) break;
  }
  return out.length > 0 ? out : undefined;
}

/** Assign only when the normalized value exists, keeping absence meaningful. */
function assign<K extends keyof DiagnosticEvent>(
  event: DiagnosticEvent,
  key: K,
  value: DiagnosticEvent[K] | undefined,
): void {
  if (value !== undefined) event[key] = value;
}

function normalizeEvent(value: unknown, defaultAt = Date.now()): DiagnosticEvent | null {
  if (!isRecord(value)) return null;
  const subsystem = oneOf(value.subsystem, DIAGNOSTIC_SUBSYSTEMS);
  const operation = oneOf(value.operation, DIAGNOSTIC_OPERATIONS);
  const outcome = oneOf(value.outcome, DIAGNOSTIC_OUTCOMES);
  if (!subsystem || !operation || !outcome) return null;

  const event: DiagnosticEvent = {
    at: finiteInteger(value.at, 0, Number.MAX_SAFE_INTEGER) ?? defaultAt,
    subsystem,
    operation,
    outcome,
  };

  assign(event, 'code', oneOf(value.code, DIAGNOSTIC_CODES));
  assign(event, 'httpStatus', finiteInteger(value.httpStatus, 100, 599));
  assign(event, 'promptTokens', finiteInteger(value.promptTokens));
  assign(event, 'completionTokens', finiteInteger(value.completionTokens));
  assign(event, 'totalTokens', finiteInteger(value.totalTokens));
  if (value.description !== undefined) {
    event.description = sanitizeErrorDescription(value.description);
  }

  assign(event, 'sequence', finiteInteger(value.sequence, 0, MAX_SEQUENCE));
  assign(event, 'protocol', oneOf(value.protocol, PROTOCOLS));
  assign(event, 'apiStyle', oneOf(value.apiStyle, API_STYLES));
  assign(event, 'routing', oneOf(value.routing, ROUTINGS));
  assign(event, 'endpointClass', oneOf(value.endpointClass, ENDPOINT_CLASSES));
  assign(event, 'durationBucket', oneOf(value.durationBucket, DURATION_BUCKETS));
  if (typeof value.retried === 'boolean') event.retried = value.retried;
  if (typeof value.usageReported === 'boolean') event.usageReported = value.usageReported;

  assign(event, 'cacheStatus', oneOf(value.cacheStatus, CACHE_STATUSES));
  assign(event, 'cacheReportedBy', oneOf(value.cacheReportedBy, CACHE_REPORTERS));
  assign(event, 'cacheReadTokens', finiteInteger(value.cacheReadTokens));
  assign(event, 'cacheWriteTokens', finiteInteger(value.cacheWriteTokens));
  assign(event, 'cacheMissTokens', finiteInteger(value.cacheMissTokens));
  assign(event, 'prefixConclusion', oneOf(value.prefixConclusion, PREFIX_CONCLUSIONS));
  assign(event, 'prefixQualifiers', enumList(value.prefixQualifiers, PREFIX_QUALIFIERS, MAX_PREFIX_QUALIFIERS));

  assign(event, 'tool', oneOf(value.tool, CANONICAL_TOOL_NAMES));
  assign(event, 'permission', oneOf(value.permission, PERMISSION_DISPOSITIONS));

  assign(event, 'searchSelected', oneOf(value.searchSelected, SEARCH_PROVIDER_SELECTIONS));
  assign(event, 'searchResolved', oneOf(value.searchResolved, SEARCH_PROVIDERS));
  if (typeof value.searchConfigured === 'boolean') event.searchConfigured = value.searchConfigured;
  assign(event, 'searchConfiguredProviders', enumList(
    value.searchConfiguredProviders, CONFIGURABLE_SEARCH_PROVIDERS, CONFIGURABLE_SEARCH_PROVIDERS.length,
  ));
  assign(event, 'ignoredParams', enumList(value.ignoredParams, IGNORED_SEARCH_PARAMS, MAX_IGNORED_PARAMS));
  assign(event, 'resultCountBucket', oneOf(value.resultCountBucket, COUNT_BUCKETS));

  assign(event, 'credentialState', oneOf(value.credentialState, CREDENTIAL_STATES));
  assign(event, 'credentialSurface', oneOf(value.credentialSurface, CREDENTIAL_SURFACES));
  assign(event, 'metadataSource', oneOf(value.metadataSource, MODEL_METADATA_SOURCES));
  assign(event, 'returnedCountBucket', oneOf(value.returnedCountBucket, COUNT_BUCKETS));

  return event;
}

/**
 * Subsystems whose events describe a current status rather than an occurrence,
 * and are therefore safe to collapse when they repeat back to back.
 *
 * Both flood in normal operation. The streaming checkpoint writes conversation
 * metadata and the active turn every five seconds for as long as a generation
 * runs; the per-request tool descriptions ask which search provider is active
 * on every request. Two real reports showed 42 of 52 entries as identical
 * writes, and 30 of 64 as identical search resolutions — in both cases evicting
 * the startup, credential, and model facts the report existed to carry.
 *
 * Provider, stream, and tool events are deliberately excluded. Stream counters
 * are summed across the ring, so collapsing them would undercount, and a
 * repeated tool execution is a second real occurrence rather than a restatement
 * of the same status.
 */
const COALESCING_SUBSYSTEMS: readonly DiagnosticSubsystem[] = ['storage', 'search'];

/**
 * True when `next` restates `previous` exactly.
 *
 * Collapsing loses nothing: the retained entry takes the newest timestamp, so
 * both the last outcome and the last-successful-write age stay correct, and any
 * *different* outcome — a failure, a read, a different provider — is a
 * different event and still appends.
 */
function isRepeatedStatus(previous: DiagnosticEvent, next: DiagnosticEvent): boolean {
  if (previous.subsystem !== next.subsystem) return false;
  if (!COALESCING_SUBSYSTEMS.includes(next.subsystem)) return false;
  const { at: _previousAt, ...previousFacts } = previous;
  const { at: _nextAt, ...nextFacts } = next;
  return JSON.stringify(previousFacts) === JSON.stringify(nextFacts);
}

export class DiagnosticEventBuffer {
  private loaded = false;
  private events: DiagnosticEvent[] = [];
  private readonly storage?: DiagnosticStorage;
  private sequence = 0;
  /** True when a persisted payload could not be read back. */
  private unreadable = false;

  constructor(storage?: DiagnosticStorage) {
    this.storage = storage;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(EVENT_STORAGE_KEY);
      if (!raw) return;
      if (raw.length > MAX_PERSISTED_EVENT_CHARACTERS) {
        this.unreadable = true;
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      const source = isRecord(parsed) && parsed.version === 1 ? parsed.events : undefined;
      if (!Array.isArray(source)) {
        this.unreadable = true;
        return;
      }
      const start = Math.max(0, source.length - SUPPORT_REPORT_MAX_EVENTS);
      for (let i = start; i < source.length; i++) {
        const event = normalizeEvent(source[i], 0);
        if (!event) continue;
        // Correlation numbers are per-session. The in-memory counter restarts
        // at zero on every launch, so a retained number from a previous
        // session could otherwise pair a brand-new request with an old stream
        // event. Dropping it on load makes that impossible: an event carried
        // across a reload simply cannot correlate.
        delete event.sequence;
        this.events.push(event);
      }
    } catch {
      this.events = [];
      this.unreadable = true;
    }
  }

  read(): DiagnosticEvent[] {
    this.load();
    return this.events.map((event) => ({ ...event }));
  }

  /** True when a stored buffer existed but could not be parsed. */
  isUnreadable(): boolean {
    this.load();
    return this.unreadable;
  }

  /**
   * Next ephemeral correlation number. Wraps at a small bound so it can never
   * become a durable identifier, and is meaningful only within this ring.
   *
   * Collision safety: the ring holds 64 events and this counter increments by
   * one per allocation before wrapping at 4096, so two live events can only
   * share a number after 4096 further allocations — by which point the older
   * one has long since been evicted. The number is never persisted, so it also
   * cannot collide across sessions.
   */
  nextSequence(): number {
    this.sequence = (this.sequence + 1) % MAX_SEQUENCE;
    return this.sequence;
  }

  record(input: DiagnosticEventInput): DiagnosticEvent | null {
    this.load();
    const event = normalizeEvent(input);
    if (!event) return null;

    const previous = this.events[this.events.length - 1];
    if (previous && isRepeatedStatus(previous, event)) {
      // Keep the newest timestamp and drop the restatement. See the comment on
      // `COALESCING_SUBSYSTEMS` for why storage and search need this.
      previous.at = event.at;
      this.persist();
      return { ...previous };
    }

    this.events.push(event);
    if (this.events.length > SUPPORT_REPORT_MAX_EVENTS) {
      this.events.splice(0, this.events.length - SUPPORT_REPORT_MAX_EVENTS);
    }
    this.persist();
    return { ...event };
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      // The correlation number is meaningful only within the session that
      // allocated it, so it is never written to disk. Correlation therefore
      // cannot survive a reload — which is the point: it must not be able to.
      const durable = this.events.map(({ sequence: _sequence, ...event }) => event);
      this.storage.setItem(EVENT_STORAGE_KEY, JSON.stringify({ version: 1, events: durable }));
    } catch {
      // Diagnostics must never interfere with the operation being observed.
    }
  }
}

let browserBuffer: DiagnosticEventBuffer | null = null;

function browserStorage(): DiagnosticStorage | undefined {
  try {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
}

function defaultBuffer(): DiagnosticEventBuffer {
  if (!browserBuffer) browserBuffer = new DiagnosticEventBuffer(browserStorage());
  return browserBuffer;
}

/**
 * Test seam. Never used by production code paths.
 *
 * Drops the process-wide buffer so a test can observe exactly the events one
 * production call produced, instead of a tail of a shared 64-entry ring.
 */
export function resetDiagnosticEvents(): void {
  try {
    // Clear the persisted ring too, or reloading the buffer would restore the
    // events this reset was meant to discard.
    browserStorage()?.setItem(EVENT_STORAGE_KEY, JSON.stringify({ version: 1, events: [] }));
  } catch {
    // A reset must be as failure-proof as recording.
  }
  browserBuffer = null;
}

export function readDiagnosticEvents(): DiagnosticEvent[] {
  try {
    return defaultBuffer().read();
  } catch {
    return [];
  }
}

/** True when a persisted diagnostic buffer existed but could not be read. */
export function diagnosticBufferUnreadable(): boolean {
  try {
    return defaultBuffer().isUnreadable();
  } catch {
    return true;
  }
}

/** Allocate the next ephemeral request/stream correlation number. */
export function nextDiagnosticSequence(): number {
  try {
    return defaultBuffer().nextSequence();
  } catch {
    return 0;
  }
}

export function recordDiagnosticEvent(input: DiagnosticEventInput): void {
  try {
    defaultBuffer().record(input);
  } catch {
    // Recording must never change the outcome of the observed operation.
  }
}
