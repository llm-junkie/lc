/**
 * Internal base projection and shared support-report vocabulary.
 *
 * Privacy boundary:
 *   1. `buildSupportReportBase` constructs a fresh object from named fields.
 *   2. Unknown source keys are never copied into that object.
 *   3. `finalizeSupportReport` recursively redacts and bounds the allowlisted
 *      object before producing the one immutable string used by the UI.
 *
 * This module is intentionally pure. It does not import application stores,
 * keychain helpers, browser storage, Tauri APIs, or network clients.
 */

import {
  STARTUP_FAILURE_CODES,
  type StartupFailureCode,
} from '../startup/startup-state.ts';
import { lcExportFileName } from './exportNames.ts';
import { getCurrentMaterial } from '../platform/material.ts';

export const SUPPORT_REPORT_FORMAT = 'llm-client:support-report' as const;
/**
 * Shared version-1 support-report limits, allowlists, and base section builder.
 * LC has not been released, so the complete current schema also uses version 1.
 */
export const SUPPORT_REPORT_VERSION = 1 as const;

export const SUPPORT_REPORT_MAX_SERIALIZED_BYTES = 64 * 1024;
export const SUPPORT_REPORT_MAX_STRING_CHARACTERS = 512;
export const SUPPORT_REPORT_MAX_COLLECTION_ITEMS = 64;
export const SUPPORT_REPORT_MAX_PROVIDER_ITEMS = 32;
export const SUPPORT_REPORT_MAX_EVENTS = 64;
export const SUPPORT_REPORT_MAX_RECENT_REQUESTS = 12;
export const SUPPORT_REPORT_MAX_DEPTH = 8;

const MAX_ERROR_DESCRIPTION_CHARACTERS = 240;
const MAX_MODEL_IDENTIFIER_CHARACTERS = 160;
const MAX_SOURCE_STRING_SCAN = 4 * 1024;
const MAX_SAFE_COUNT = 1_000_000_000;

export const ENDPOINT_CLASSES = [
  'loopback',
  'private-network',
  'public-https',
  'public-http',
  'invalid',
] as const;
export type EndpointClass = (typeof ENDPOINT_CLASSES)[number];

/** Narrow base vocabulary used by the shared section builder. */
export const DIAGNOSTIC_SUBSYSTEMS_V1 = [
  'startup',
  'storage',
  'provider',
  'stream',
  'tool',
  'ui',
] as const;

/**
 * Current version-1 vocabulary. It records model discovery, search resolution,
 * and credential bootstrap at their own normalized boundaries.
 */
export const DIAGNOSTIC_SUBSYSTEMS = [
  ...DIAGNOSTIC_SUBSYSTEMS_V1,
  'model',
  'search',
  'credential',
] as const;
export type DiagnosticSubsystem = (typeof DIAGNOSTIC_SUBSYSTEMS)[number];

/** Narrow base operation vocabulary. */
export const DIAGNOSTIC_OPERATIONS_V1 = [
  'phase',
  'hydrate',
  'persistence',
  'request',
  'model-list',
  'completion',
  'execute',
  'support-report',
  'unknown',
] as const;

export const DIAGNOSTIC_OPERATIONS = [
  ...DIAGNOSTIC_OPERATIONS_V1,
  'open',
  'indexed-read',
  'durable-write',
  'sync',
  'resolve',
  'call',
  'bootstrap',
  'permission',
  'recovery-action',
] as const;
export type DiagnosticOperation = (typeof DIAGNOSTIC_OPERATIONS)[number];

export const DIAGNOSTIC_OUTCOMES = [
  'ok',
  'cancelled',
  'timeout',
  'rejected',
  'error',
] as const;
export type DiagnosticOutcome = (typeof DIAGNOSTIC_OUTCOMES)[number];

/** Narrow base diagnostic-code vocabulary. */
export const DIAGNOSTIC_CODES_V1 = [
  'startup-phase',
  'storage-ready',
  'storage-unavailable',
  'persistence-warning',
  'persistence-error',
  'http-error',
  'network-error',
  'missing-response-body',
  'reasoning-retry',
  'finish-stop',
  'finish-length',
  'finish-tool-calls',
  'finish-disconnected',
  'finish-refusal',
  'finish-other',
  'user-cancelled',
  'read-timeout',
  'reasoning-loop',
  'tool-result-ok',
  'tool-result-error',
  'tool-cancelled',
  'report-created',
  'report-copied',
  'report-saved',
  'report-failed',
  ...STARTUP_FAILURE_CODES,
  'unknown',
] as const;

export const DIAGNOSTIC_CODES = [
  ...DIAGNOSTIC_CODES_V1,
  // Storage boundaries
  'storage-open-ok',
  'storage-open-failed',
  'storage-hydrate-ok',
  'storage-hydrate-failed',
  'storage-read-ok',
  'storage-read-failed',
  'storage-write-ok',
  'storage-write-failed',
  // Model discovery
  'model-list-ok',
  'model-list-failed',
  'model-sync-ok',
  'model-sync-failed',
  // Credential configuration
  'credential-keychain-ok',
  'credential-keychain-unavailable',
  'credential-missing',
  // Search
  'search-resolved',
  'search-not-configured',
  'search-ok',
  'search-no-results',
  'search-provider-error',
  // Tools and permissions
  'tool-permission-granted',
  'tool-permission-denied',
  'tool-permission-not-required',
  // The permission surface could not be shown, so the call was blocked
  // without ever executing. Distinct from an explicit user denial.
  'tool-permission-unavailable',
  // Recovery
  'safe-start-retry',
  'safe-start-reset-geometry',
  'safe-start-open-data-dir',
  // A generation-journal row survived the last exit, so the answer it names
  // was marked interrupted. Counts only; no conversation identity or content.
  'generation-recovery-ok',
  'generation-recovery-failed',
  // Collection health
  'collector-timeout',
  'collector-failed',
  // The native LM Studio server rejected the text input-item discriminator and
  // the request was rebuilt with the value it named.
  'input-shape-retry',
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/* ------------------------------------------------------------------ */
/*  Current version-1 closed context vocabularies                      */
/* ------------------------------------------------------------------ */

/** Canonical built-in tool names. LC-owned and finite; never provider text. */
export const CANONICAL_TOOL_NAMES = [
  'lc_read_file', 'lc_write_file', 'lc_list_dir', 'lc_read_image', 'lc_read_pdf',
  'lc_grep', 'lc_edit_file', 'lc_run_shell', 'lc_stat', 'lc_glob_files',
  'lc_apply_patch', 'lc_web_fetch', 'lc_web_search', 'lc_web_research',
  'lc_get_current_time', 'lc_todo_write', 'lc_ask_user', 'lc_tool_history', 'lc_skill',
  'lc_tool_help', 'lc_whiteboard',
  'unknown',
] as const;
export type CanonicalToolName = (typeof CANONICAL_TOOL_NAMES)[number];

export const PERMISSION_DISPOSITIONS = [
  'not-required', 'granted-once', 'granted-conversation', 'denied', 'unknown',
] as const;
export type PermissionDisposition = (typeof PERMISSION_DISPOSITIONS)[number];

/** Documented duration buckets. Exact durations are never serialized. */
export const DURATION_BUCKETS = [
  'under-100ms', '100ms-1s', '1-5s', '5-30s', '30s-2m', 'over-2m', 'unknown',
] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

/** Documented count buckets for result counts and returned-model counts. */
export const COUNT_BUCKETS = ['none', '1-9', '10-49', '50-199', '200+', 'unknown'] as const;
export type CountBucket = (typeof COUNT_BUCKETS)[number];

/** Documented age buckets for the last successful durable write. */
export const AGE_BUCKETS = [
  'under-1m', '1-10m', '10-60m', '1-24h', 'over-24h', 'never', 'unknown',
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

/**
 * Which provider actually served (or would have served) a call.
 *
 * `none` means the resolver ran and found nothing configured; `unknown` means
 * no resolution has been observed. The two are deliberately different facts.
 */
export const SEARCH_PROVIDERS = ['brave', 'searxng', 'marginalia', 'none', 'unknown'] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];

/**
 * What the user *selected*, which is a different question from what resolved.
 * `auto` is a real selection — the default one — so it has its own value
 * rather than collapsing into `unknown` and becoming indistinguishable from
 * "no selection was recorded".
 */
export const SEARCH_PROVIDER_SELECTIONS = [
  'auto', 'brave', 'searxng', 'marginalia', 'unknown',
] as const;
export type SearchProviderSelection = (typeof SEARCH_PROVIDER_SELECTIONS)[number];

/** Concrete providers, used for the bounded configuration-state list. */
export const CONFIGURABLE_SEARCH_PROVIDERS = ['brave', 'searxng', 'marginalia'] as const;
export type ConfigurableSearchProvider = (typeof CONFIGURABLE_SEARCH_PROVIDERS)[number];

/** Allowlisted ignored-parameter names. No other parameter name is serialized. */
export const IGNORED_SEARCH_PARAMS = ['freshness', 'extra_snippets', 'cross_check'] as const;
export type IgnoredSearchParam = (typeof IGNORED_SEARCH_PARAMS)[number];

export const CREDENTIAL_STATES = [
  'keychain-ref', 'plaintext-fallback', 'not-configured', 'unknown',
] as const;
export type CredentialState = (typeof CREDENTIAL_STATES)[number];

/**
 * Which credential slot an outcome belongs to. Closed and LC-owned: this is
 * the *surface*, never a keychain reference name, account id, or value.
 */
export const CREDENTIAL_SURFACES = ['chat', 'profile', 'brave', 'searxng', 'marginalia'] as const;
export type CredentialSurface = (typeof CREDENTIAL_SURFACES)[number];

/**
 * Where the model facts in the last discovery came from. Exactly one value is
 * reported, using this documented precedence:
 *
 *   1. `override`   — the list came from a user-configured custom model
 *                     endpoint, so LC neither resolved the endpoint nor can
 *                     vouch for the shape of what it returned.
 *   2. `cached`     — at least one entry was enriched from LC's bundled
 *                     models.dev cache (or the Tauri-side lookup of it).
 *   3. `discovered` — the server's own list supplied the metadata and no
 *                     cached enrichment applied.
 *   4. `unknown`    — discovery failed, or it returned entries with no
 *                     recognizable metadata and no cache was available.
 *
 * The value is recorded only after enrichment has finished, so a later
 * enrichment failure can never leave a successful-looking `cached` claim.
 */
export const MODEL_METADATA_SOURCES = ['discovered', 'cached', 'override', 'unknown'] as const;
export type ModelMetadataSource = (typeof MODEL_METADATA_SOURCES)[number];

/**
 * Whether `activeRequest` describes a request that actually ran, the current
 * configuration standing in for one, or nothing at all. A configuration
 * fallback is never presented as an observed request.
 */
export const REQUEST_SNAPSHOT_SOURCES = ['request', 'current-configuration', 'unavailable'] as const;
export type RequestSnapshotSource = (typeof REQUEST_SNAPSHOT_SOURCES)[number];

/** Closed reasoning-effort vocabulary shared by the request snapshot. */
export const REASONING_EFFORTS = [
  'none', 'low', 'medium', 'high', 'xhigh', 'max', 'unknown',
] as const;
export type ReasoningEffortLevel = (typeof REASONING_EFFORTS)[number];

/** Which cache surface the request was sent to. */
export const CACHE_SURFACES = ['provider-native', 'router', 'none', 'unknown'] as const;
export type CacheSurface = (typeof CACHE_SURFACES)[number];

export const PROTOCOLS = ['openai', 'anthropic', 'lmstudio-rest', 'gemini-rest', 'unknown'] as const;
export type DiagnosticProtocol = (typeof PROTOCOLS)[number];

export const API_STYLES = ['chat', 'responses', 'not-applicable', 'unknown'] as const;
export type DiagnosticApiStyle = (typeof API_STYLES)[number];

export const ROUTINGS = ['proxy', 'direct', 'unknown'] as const;
export type DiagnosticRouting = (typeof ROUTINGS)[number];

export const CACHE_STATUSES = ['reported', 'partially-reported', 'not-reported', 'unknown'] as const;
export type DiagnosticCacheStatus = (typeof CACHE_STATUSES)[number];

export const CACHE_REPORTERS = ['provider', 'router', 'unknown'] as const;
export type DiagnosticCacheReporter = (typeof CACHE_REPORTERS)[number];

export const REPORT_SURFACES = ['settings', 'safe-start', 'unknown'] as const;
export type ReportSurface = (typeof REPORT_SURFACES)[number];

/** Bucket a millisecond duration. Exact values never leave this boundary. */
export function durationBucket(ms: unknown): DurationBucket {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 100) return 'under-100ms';
  if (ms < 1_000) return '100ms-1s';
  if (ms < 5_000) return '1-5s';
  if (ms < 30_000) return '5-30s';
  if (ms < 120_000) return '30s-2m';
  return 'over-2m';
}

export function countBucket(value: unknown): CountBucket {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'unknown';
  if (value === 0) return 'none';
  if (value < 10) return '1-9';
  if (value < 50) return '10-49';
  if (value < 200) return '50-199';
  return '200+';
}

export function ageBucket(timestamp: unknown, now: number): AgeBucket {
  if (timestamp === null) return 'never';
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return 'unknown';
  const age = now - timestamp;
  if (age < 0) return 'unknown';
  if (age < 60_000) return 'under-1m';
  if (age < 600_000) return '1-10m';
  if (age < 3_600_000) return '10-60m';
  if (age < 86_400_000) return '1-24h';
  return 'over-24h';
}

export interface DiagnosticEventV1 {
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
}

export interface SupportReportBase {
  format: typeof SUPPORT_REPORT_FORMAT;
  version: typeof SUPPORT_REPORT_VERSION;
  createdAt: string;
  application: {
    name: 'LC';
    version: string;
    buildChannel: 'development' | 'release' | 'test' | 'unknown';
  };
  runtime: {
    kind: 'tauri' | 'web' | 'unknown';
    osFamily: 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown';
    osVersion?: string;
    architecture: 'x86_64' | 'x86' | 'arm64' | 'arm' | 'unknown';
    tauriVersion?: string;
    webviewFamily: 'webview2' | 'webkit' | 'webkitgtk' | 'chromium' | 'unknown';
    webviewVersion?: string;
    locale: string;
    timeZone: string;
    secureContext: boolean | 'unknown';
  };
  startup: {
    lastCompletedPhase: string;
    incompleteStartCount: number;
    safeStartState: 'not-available' | 'inactive' | 'active' | 'unknown';
    failureCode?: StartupFailureCode;
  };
  storage: {
    conversationSchemaVersion: number;
    settingsSchemaVersion: number;
    profileSchemaVersion: number;
    conversationCount?: number;
    messageCount?: number;
    approximateBytes?: number;
    quotaUsageBucket: 'empty' | 'under-25%' | '25-49%' | '50-79%' | '80%+' | 'unknown';
    integrity: {
      conversationCountReadable: boolean;
      messageCountReadable: boolean;
      estimateReadable: boolean;
      settingsReadable: boolean;
      profilesReadable: boolean;
    };
  };
  providers: {
    count: number;
    activeCount: number;
    configurationsSampled: number;
    configurations: Array<{
      apiVariant: 'openai' | 'anthropic' | 'lm-studio' | 'gemini' | 'unknown';
      apiStyle: 'chat' | 'responses' | 'not-applicable' | 'unknown';
      routing: 'proxy' | 'direct' | 'unknown';
      active: boolean | 'unknown';
      endpointClass: EndpointClass;
      modelEndpointClass: EndpointClass;
      transport: 'https' | 'http' | 'invalid';
    }>;
  };
  models: {
    count: number;
    capabilitySampleCount: number;
    capabilities: {
      vision: CapabilityCounts;
      reasoning: CapabilityCounts;
      tools: CapabilityCounts;
    };
    identifiersIncluded: boolean;
    identifiersTruncated: boolean;
    identifiers?: string[];
  };
  tools: {
    activePolicyAvailable: boolean;
    policyMode: 'disabled' | 'foundation' | 'prompt' | 'mixed-grants' | 'grandmaster' | 'unknown';
    categories: {
      fileIo: boolean | 'unknown';
      shell: boolean | 'unknown';
      webAccess: boolean | 'unknown';
      skills: boolean | 'unknown';
    };
    grants: {
      webAccessToolCount: number;
      allowedRootCount: number;
      directoryGrantScopeCount: number;
    };
    limits: {
      maxRoundsPerTurn?: number;
      maxCallsPerBatch?: number;
      streamReadTimeoutMinutes?: number;
    };
    globalDefaults: {
      allowedRootCount: number;
      shellAllowlistEntryCount: number;
      webFetchRatePerMinute?: number;
    };
  };
  skills: {
    activePolicyAvailable: boolean;
    enabled: boolean | 'unknown';
    selectedCount: number;
    customCount: number;
  };
  streaming: {
    active: boolean | 'unknown';
    activeCount: number;
    phaseCounts: {
      running: number;
      thinking: number;
      writing: number;
      usingTools: number;
      waitingPermission: number;
      waitingUser: number;
      stopping: number;
      finalizing: number;
      failed: number;
    };
    recentRequests: Array<{
      ageBucket: AgeBucket;
      protocol: DiagnosticProtocol;
      apiStyle: DiagnosticApiStyle;
      routing: DiagnosticRouting;
      endpointClass: EndpointClass;
      cacheSurface: CacheSurface;
      reasoningEnabled: boolean | 'unknown';
      reasoningEffort: ReasoningEffortLevel;
      streamTimeoutBucket: DurationBucket;
      toolDefinitionCount: number;
      capabilities: {
        vision: boolean | 'unknown';
        reasoning: boolean | 'unknown';
        tools: boolean | 'unknown';
      };
      contextWindowKnown: boolean | 'unknown';
    }>;
    imageCache: {
      batches: number;
      bytes: number;
      generations: number;
    };
    recentEventCount: number;
    okCount: number;
    cancelledCount: number;
    timeoutCount: number;
    rejectedCount: number;
    errorCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  ui: {
    themeMode: 'light' | 'dark' | 'system' | 'unknown';
    zoomBucket: '80%' | '90%' | '100%' | '110%' | '125%' | '150%' | 'custom' | 'unknown';
    materialMode: 'auto' | 'glass' | 'solid' | 'unknown';
    /** Runtime material resolution, from the platform material module. */
    material: {
      platform: 'windows' | 'macos' | 'linux' | 'web' | 'unknown';
      active: string;
      nativeActive: boolean | 'unknown';
      fallbackReason: string | null;
    };
    codeThemeMode: 'system' | 'custom' | 'unknown';
    pinComposer: boolean | 'unknown';
    tokenMeterStyle: 'donut' | 'cake' | 'unknown';
    autoPreviewReasoning: boolean | 'unknown';
    customThemeActive: boolean | 'unknown';
    customThemeCount: number;
    sidebarOpen: boolean | 'unknown';
    sidePanelOpen: boolean | 'unknown';
  };
  diagnostics: {
    descriptionsIncluded: boolean;
    eventCount: number;
    events: DiagnosticEventV1[];
  };
  limits: {
    maxSerializedBytes: number;
    maxStringCharacters: number;
    maxCollectionItems: number;
    maxEvents: number;
    maxDepth: number;
    stringsTruncated: number;
    arraysTruncated: number;
    eventsDropped: number;
    sizeReduced: boolean;
  };
}

interface CapabilityCounts {
  supported: number;
  unsupported: number;
  unknown: number;
}

/** Raw source references. The builder reads only explicitly named fields. */
export interface SupportReportSources {
  application?: unknown;
  runtime?: unknown;
  startup?: unknown;
  storage?: unknown;
  profiles?: unknown;
  providerCount?: unknown;
  activeProviderCount?: unknown;
  models?: unknown;
  modelCount?: unknown;
  settings?: unknown;
  activeConversation?: unknown;
  streamingActive?: unknown;
  activeGenerationCount?: unknown;
  generationPhaseCounts?: unknown;
  recentRequestSnapshots?: unknown;
  imageCacheMetrics?: unknown;
  diagnosticEvents?: unknown;
}

export interface SupportReportOptions {
  includeModelIdentifiers?: boolean;
  includeErrorDescriptions?: boolean;
}

export interface SupportReportSnapshot {
  readonly filename: string;
  readonly serialized: string;
  readonly byteLength: number;
}

interface LimitStats {
  stringsTruncated: number;
  arraysTruncated: number;
  eventsDropped: number;
  sizeReduced: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function finiteInteger(value: unknown, min = 0, max = MAX_SAFE_COUNT): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : undefined;
}

export function safeCount(value: unknown, fallback = 0): number {
  return finiteInteger(value) ?? fallback;
}

export function boundedLength(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return Math.min(MAX_SAFE_COUNT, value.length);
}

/** Material resolution snapshot for the support report. Reads the
 *  runtime module state; anything unreadable reports as `unknown`
 *  rather than throwing out of the report builder. */
function materialDiagnostics() {
  const current = getCurrentMaterial();
  return {
    platform: oneOf(
      current?.platform,
      ['windows', 'macos', 'linux', 'web', 'unknown'] as const,
      'unknown',
    ),
    active: typeof current?.active === 'string' ? current.active : 'unknown',
    nativeActive: current ? current.nativeActive === true : ('unknown' as const),
    fallbackReason: typeof current?.fallbackReason === 'string' ? current.fallbackReason : null,
  };
}

export function oneOf<const T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
  return typeof value === 'string' && values.includes(value) ? value : fallback;
}

export function oneOfOptional<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === 'string' && values.includes(value) ? value : undefined;
}

export function booleanOrUnknown(value: unknown): boolean | 'unknown' {
  return typeof value === 'boolean' ? value : 'unknown';
}

function boundedRawString(value: unknown, stats?: LimitStats): string {
  if (typeof value !== 'string') return '';
  if (value.length > MAX_SOURCE_STRING_SCAN) {
    if (stats) stats.stringsTruncated++;
    return value.slice(0, MAX_SOURCE_STRING_SCAN);
  }
  return value;
}

function safeString(
  value: unknown,
  fallback: string,
  stats: LimitStats,
  max = SUPPORT_REPORT_MAX_STRING_CHARACTERS,
): string {
  const raw = boundedRawString(value, stats);
  if (!raw) return fallback;
  const redacted = redactSupportString(raw);
  if (redacted.length > max) {
    stats.stringsTruncated++;
    return `${redacted.slice(0, Math.max(0, max - 1))}…`;
  }
  return redacted;
}

/** Classify a configured endpoint without returning any part of its host. */
export function classifyEndpoint(value: unknown, base?: unknown): EndpointClass {
  const raw = typeof value === 'string' ? value.trim().slice(0, MAX_SOURCE_STRING_SCAN) : '';
  if (!raw) return 'invalid';
  let parsed: URL;
  try {
    const baseUrl = typeof base === 'string' ? base.trim().slice(0, MAX_SOURCE_STRING_SCAN) : undefined;
    parsed = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
  } catch {
    return 'invalid';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'invalid';
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return 'invalid';
  if (isLoopbackHost(host)) return 'loopback';
  if (isPrivateNetworkHost(host)) return 'private-network';
  return parsed.protocol === 'https:' ? 'public-https' : 'public-http';
}

function endpointTransport(value: unknown, base?: unknown): 'https' | 'http' | 'invalid' {
  const raw = typeof value === 'string' ? value.trim().slice(0, MAX_SOURCE_STRING_SCAN) : '';
  if (!raw) return 'invalid';
  try {
    const parsed = typeof base === 'string' && base.trim()
      ? new URL(raw, base.trim().slice(0, MAX_SOURCE_STRING_SCAN))
      : new URL(raw);
    if (parsed.protocol === 'https:') return 'https';
    if (parsed.protocol === 'http:') return 'http';
  } catch {
    // Invalid is the fail-closed classification.
  }
  return 'invalid';
}

function parseIpv4(host: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split('.').map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  const ipv4 = parseIpv4(mapped?.[1] ?? host);
  return ipv4?.[0] === 127;
}

function isPrivateNetworkHost(host: string): boolean {
  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const [a, b] = ipv4;
    return a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && b === 168;
  }
  if (host.includes(':')) {
    const first = host.split(':', 1)[0];
    return first === 'fc' || first === 'fd' || /^f[cd][0-9a-f]{0,2}$/.test(first)
      || /^fe[89ab][0-9a-f]?$/.test(first);
  }
  return !host.includes('.') || /\.(?:local|lan|home|internal|intranet)$/.test(host);
}

/**
 * Defense-in-depth redaction for already-allowlisted strings. URLs are
 * replaced by endpoint class so credentials, hosts, paths, queries, and
 * fragments all disappear together.
 */
export function redactSupportString(value: string): string {
  let out = value.slice(0, MAX_SOURCE_STRING_SCAN);
  out = out.replace(/file:\/\/[^\r\n,;)"'<>]+/gi, '[path]');
  out = out.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => `[url:${classifyEndpoint(url)}]`);
  out = out.replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*[^\r\n,;]+/gi, '[authorization-redacted]');
  out = out.replace(/\b(?:cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, '[cookie-redacted]');
  out = out.replace(/\b(?:x-goog-api-key|x-api-key|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, '[api-key-redacted]');
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[bearer-redacted]');
  out = out.replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}/g, '[api-key-redacted]');
  out = out.replace(/\bBSA[A-Za-z0-9_-]{16,}/g, '[api-key-redacted]');
  out = out.replace(/\b(?:brave|brv)[_-][A-Za-z0-9_-]{16,}/gi, '[api-key-redacted]');
  // Marginalia issues opaque keys with its own prefix.
  out = out.replace(/\bmarginalia[_-][A-Za-z0-9_-]{8,}/gi, '[api-key-redacted]');
  // OpenRouter routing and cache-grouping fields. LC never sets these, but a
  // value echoed back inside an error string must not survive either.
  out = out.replace(/\b(?:x-)?session[_-]?id\s*[:=]\s*[^\s,;]+/gi, '[session-redacted]');
  out = out.replace(/\bprompt[_-]cache[_-]key\s*[:=]\s*[^\s,;]+/gi, '[cache-key-redacted]');
  out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]');
  out = out.replace(/\\\\[^\r\n,;)"']+/g, '[path]');
  out = out.replace(/\b[A-Za-z]:\\[^\r\n,;)"']+/g, '[path]');
  out = out.replace(/(^|[\s(=:'"])(\/(?:[^/\r\n,;)'"]+\/)+[^\r\n,;)'"]*)/g, '$1[path]');
  out = out.replace(/\b[A-Za-z0-9+/]{64,}={0,2}(?=$|[^A-Za-z0-9+/=])/g, '[encoded-data]');
  return out;
}

/**
 * Error text is optional and deliberately conservative. Recognized failure
 * classes retain a useful generic description; arbitrary provider bodies and
 * unknown exception text are not carried into the report.
 */
export function sanitizeErrorDescription(value: unknown): string {
  const raw = boundedRawString(value).replace(/\r/g, '');
  if (!raw) return 'Sanitized details unavailable.';
  const firstLine = raw.split('\n', 1)[0];
  const http = firstLine.match(/(?:chat failed:|http(?: status)?|status)\s*(\d{3})/i);
  if (http) return `Request failed with HTTP status ${http[1]}.`;
  if (/idle timeout|read timed out|timed out/i.test(firstLine)) return 'The operation timed out.';
  if (/abort|cancel/i.test(firstLine)) return 'The operation was cancelled.';
  if (/connection refused|econnrefused/i.test(firstLine)) return 'The connection was refused.';
  if (/dns|name.*resol|enotfound/i.test(firstLine)) return 'The endpoint name could not be resolved.';
  if (/indexeddb|dexie|database|storage/i.test(firstLine)) return 'Local storage reported an error.';
  if (/response has no body|streaming not supported/i.test(firstLine)) return 'The provider response did not include a usable stream.';
  if (/responses api error|provider.*error|response body|^\s*(?:\[|\{)/i.test(firstLine)) {
    return 'The provider returned an error; its response body was omitted.';
  }
  // Unknown exception text may itself be a provider response body, prompt
  // excerpt, tool output, or path-bearing database value. Redaction patterns
  // cannot prove otherwise, so fail closed instead of carrying it forward.
  return 'Sanitized details unavailable.';
}

export function quotaBucket(usage: unknown, quota: unknown): SupportReportBase['storage']['quotaUsageBucket'] {
  const used = finiteInteger(usage);
  const available = finiteInteger(quota);
  if (used === undefined || available === undefined || available <= 0) return 'unknown';
  if (used === 0) return 'empty';
  const pct = used / available * 100;
  if (pct < 25) return 'under-25%';
  if (pct < 50) return '25-49%';
  if (pct < 80) return '50-79%';
  return '80%+';
}

export function roundedApproximateBytes(value: unknown): number | undefined {
  const bytes = finiteInteger(value, 0, Number.MAX_SAFE_INTEGER);
  if (bytes === undefined) return undefined;
  if (bytes === 0) return 0;
  return Math.round(bytes / 1024) * 1024;
}

function providerConfiguration(value: unknown): SupportReportBase['providers']['configurations'][number] {
  const p = record(value);
  const variant = oneOf(p.apiVariant, ['openai', 'anthropic', 'lm-studio', 'gemini', 'unknown'] as const, 'unknown');
  const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl : '';
  const modelUrl = typeof p.modelFetchUrl === 'string' && p.modelFetchUrl.trim()
    ? p.modelFetchUrl
    : baseUrl;
  return {
    apiVariant: variant,
    apiStyle: variant !== 'openai'
      ? 'not-applicable'
      : oneOf(p.apiStyle, ['chat', 'responses', 'unknown'] as const, 'unknown'),
    routing: oneOf(p.routing, ['proxy', 'direct', 'unknown'] as const, 'unknown'),
    active: booleanOrUnknown(p.active),
    endpointClass: classifyEndpoint(baseUrl),
    modelEndpointClass: classifyEndpoint(modelUrl, baseUrl),
    transport: endpointTransport(baseUrl),
  };
}

function freshCapabilityCounts(): CapabilityCounts {
  return { supported: 0, unsupported: 0, unknown: 0 };
}

function addCapability(counts: CapabilityCounts, value: unknown): void {
  if (value === true) counts.supported++;
  else if (value === false) counts.unsupported++;
  else counts.unknown++;
}

function boundedOwnKeyCount(value: unknown, max = MAX_SAFE_COUNT): number {
  if (!isRecord(value)) return 0;
  let count = 0;
  try {
    for (const _key in value) {
      count++;
      if (count >= max) break;
    }
  } catch {
    return 0;
  }
  return count;
}

function shellAllowlistEntryCount(value: unknown, stats: LimitStats): number {
  const raw = boundedRawString(value, stats);
  if (!raw) return 0;
  let count = 0;
  for (const entry of raw.split(/[,\r\n]+/, SUPPORT_REPORT_MAX_COLLECTION_ITEMS + 1)) {
    if (entry.trim()) count++;
    if (count >= SUPPORT_REPORT_MAX_COLLECTION_ITEMS) {
      if (raw.length >= MAX_SOURCE_STRING_SCAN) stats.arraysTruncated++;
      break;
    }
  }
  return count;
}

function normalizeDiagnosticEvents(
  value: unknown,
  options: SupportReportOptions,
  stats: LimitStats,
): DiagnosticEventV1[] {
  if (!Array.isArray(value)) return [];
  if (value.length > SUPPORT_REPORT_MAX_EVENTS) {
    stats.arraysTruncated++;
    stats.eventsDropped += value.length - SUPPORT_REPORT_MAX_EVENTS;
  }
  const start = Math.max(0, value.length - SUPPORT_REPORT_MAX_EVENTS);
  const out: DiagnosticEventV1[] = [];
  for (let i = start; i < value.length; i++) {
    const source = record(value[i]);
    const at = finiteInteger(source.at, 0, Number.MAX_SAFE_INTEGER);
    const subsystem = oneOfOptional(source.subsystem, DIAGNOSTIC_SUBSYSTEMS_V1);
    const outcome = oneOfOptional(source.outcome, DIAGNOSTIC_OUTCOMES);
    if (at === undefined || subsystem === undefined || outcome === undefined) continue;
    const event: DiagnosticEventV1 = {
      at,
      subsystem,
      operation: oneOf(source.operation, DIAGNOSTIC_OPERATIONS_V1, 'unknown'),
      outcome,
    };
    if (typeof source.code === 'string') {
      event.code = oneOf(source.code, DIAGNOSTIC_CODES_V1, 'unknown');
    }
    const httpStatus = finiteInteger(source.httpStatus, 100, 599);
    if (httpStatus !== undefined) event.httpStatus = httpStatus;
    const promptTokens = finiteInteger(source.promptTokens);
    const completionTokens = finiteInteger(source.completionTokens);
    const totalTokens = finiteInteger(source.totalTokens);
    if (promptTokens !== undefined) event.promptTokens = promptTokens;
    if (completionTokens !== undefined) event.completionTokens = completionTokens;
    if (totalTokens !== undefined) event.totalTokens = totalTokens;
    if (options.includeErrorDescriptions && typeof source.description === 'string') {
      event.description = safeString(
        sanitizeErrorDescription(source.description),
        'Sanitized details unavailable.',
        stats,
        MAX_ERROR_DESCRIPTION_CHARACTERS,
      );
    }
    out.push(event);
  }
  return out;
}

function sumEventNumber(events: DiagnosticEventV1[], key: 'promptTokens' | 'completionTokens' | 'totalTokens'): number {
  let total = 0;
  for (const event of events) {
    const value = event[key];
    if (value !== undefined) total = Math.min(MAX_SAFE_COUNT, total + value);
  }
  return total;
}

/** Build a fresh v1 report object from the allowlisted source fields. */
export function buildSupportReportBase(
  sources: SupportReportSources,
  options: SupportReportOptions = {},
  now = new Date(),
): SupportReportBase {
  const stats: LimitStats = {
    stringsTruncated: 0,
    arraysTruncated: 0,
    eventsDropped: 0,
    sizeReduced: false,
  };
  const application = record(sources.application);
  const runtime = record(sources.runtime);
  const startup = record(sources.startup);
  const storage = record(sources.storage);
  const settings = record(sources.settings);
  const ui = record(settings.ui);
  const globalTools = record(settings.tools);
  const activeConversation = record(sources.activeConversation);
  const policy = record(activeConversation.tools);
  const policyAvailable = isRecord(activeConversation.tools);

  const profileSources = Array.isArray(sources.profiles) ? sources.profiles : [];
  const profileLimit = Math.min(profileSources.length, SUPPORT_REPORT_MAX_PROVIDER_ITEMS);
  if (profileSources.length > profileLimit) stats.arraysTruncated++;
  const configurations: SupportReportBase['providers']['configurations'] = [];
  for (let i = 0; i < profileLimit; i++) configurations.push(providerConfiguration(profileSources[i]));

  const modelSources = Array.isArray(sources.models) ? sources.models : [];
  const modelLimit = Math.min(modelSources.length, SUPPORT_REPORT_MAX_COLLECTION_ITEMS);
  if (modelSources.length > modelLimit) stats.arraysTruncated++;
  const vision = freshCapabilityCounts();
  const reasoning = freshCapabilityCounts();
  const tools = freshCapabilityCounts();
  const identifiers: string[] = [];
  for (let i = 0; i < modelLimit; i++) {
    const model = record(modelSources[i]);
    const capabilities = record(model.capabilities);
    addCapability(vision, capabilities.vision);
    addCapability(reasoning, capabilities.reasoning);
    addCapability(tools, capabilities.tools);
    if (options.includeModelIdentifiers && typeof model.id === 'string') {
      identifiers.push(safeString(model.id, 'unknown', stats, MAX_MODEL_IDENTIFIER_CHARACTERS));
    }
  }

  const recentRequestSources = Array.isArray(sources.recentRequestSnapshots)
    ? sources.recentRequestSnapshots
    : [];
  const recentRequestLimit = Math.min(
    recentRequestSources.length,
    SUPPORT_REPORT_MAX_RECENT_REQUESTS,
  );
  if (recentRequestSources.length > recentRequestLimit) stats.arraysTruncated++;
  const recentRequests: SupportReportBase['streaming']['recentRequests'] = [];
  for (let i = Math.max(0, recentRequestSources.length - recentRequestLimit); i < recentRequestSources.length; i++) {
    const request = record(recentRequestSources[i]);
    const capabilities = record(request.capabilities);
    recentRequests.push({
      ageBucket: ageBucket(request.at, now.getTime()),
      protocol: oneOf(request.protocol, PROTOCOLS, 'unknown'),
      apiStyle: oneOf(request.apiStyle, API_STYLES, 'unknown'),
      routing: oneOf(request.routing, ROUTINGS, 'unknown'),
      endpointClass: oneOf(request.endpointClass, ENDPOINT_CLASSES, 'invalid'),
      cacheSurface: oneOf(request.cacheSurface, CACHE_SURFACES, 'unknown'),
      reasoningEnabled: booleanOrUnknown(request.reasoningEnabled),
      reasoningEffort: oneOf(request.reasoningEffort, REASONING_EFFORTS, 'unknown'),
      streamTimeoutBucket: durationBucket(request.streamTimeoutMs),
      toolDefinitionCount: safeCount(request.toolDefinitionCount),
      capabilities: {
        vision: booleanOrUnknown(capabilities.vision),
        reasoning: booleanOrUnknown(capabilities.reasoning),
        tools: booleanOrUnknown(capabilities.tools),
      },
      contextWindowKnown: booleanOrUnknown(request.contextWindowKnown),
    });
  }
  const imageCache = record(sources.imageCacheMetrics);

  const events = normalizeDiagnosticEvents(sources.diagnosticEvents, options, stats);
  const streamEvents = events.filter((event) => event.subsystem === 'stream');
  const created = Number.isFinite(now.getTime()) ? now : new Date(0);
  const allowedRootsCount = boundedLength(policy.allowed_roots);
  const webAccessGrantCount = boundedLength(policy.tool_grants);
  const shellAllowlist = typeof policy.shell_allowlist === 'string'
    ? policy.shell_allowlist
    : globalTools.shell_allowlist;
  const grandmaster = boundedRawString(shellAllowlist).split(/[,\r\n]+/, SUPPORT_REPORT_MAX_COLLECTION_ITEMS + 1)
    .some((entry) => entry.trim() === '*******');
  const hasGrants = webAccessGrantCount > 0 || allowedRootsCount > 0 || boundedOwnKeyCount(policy.dir_permissions, 1) > 0;
  const hasPromptingCategory = policy.file_io_enabled === true
    || policy.shell_enabled === true
    || policy.web_access_enabled === true;
  const enabled = policy.enabled;

  const report: SupportReportBase = {
    format: SUPPORT_REPORT_FORMAT,
    version: SUPPORT_REPORT_VERSION,
    createdAt: created.toISOString(),
    application: {
      name: 'LC',
      version: safeString(application.version, 'unknown', stats, 40),
      buildChannel: oneOf(application.buildChannel, ['development', 'release', 'test', 'unknown'] as const, 'unknown'),
    },
    runtime: {
      kind: oneOf(runtime.kind, ['tauri', 'web', 'unknown'] as const, 'unknown'),
      osFamily: oneOf(runtime.osFamily, ['windows', 'macos', 'linux', 'android', 'ios', 'unknown'] as const, 'unknown'),
      ...(typeof runtime.osVersion === 'string'
        ? { osVersion: safeString(runtime.osVersion, 'unknown', stats, 40) }
        : {}),
      architecture: oneOf(runtime.architecture, ['x86_64', 'x86', 'arm64', 'arm', 'unknown'] as const, 'unknown'),
      ...(typeof runtime.tauriVersion === 'string'
        ? { tauriVersion: safeString(runtime.tauriVersion, 'unknown', stats, 40) }
        : {}),
      webviewFamily: oneOf(runtime.webviewFamily, ['webview2', 'webkit', 'webkitgtk', 'chromium', 'unknown'] as const, 'unknown'),
      ...(typeof runtime.webviewVersion === 'string'
        ? { webviewVersion: safeString(runtime.webviewVersion, 'unknown', stats, 40) }
        : {}),
      locale: safeString(runtime.locale, 'unknown', stats, 48),
      timeZone: safeString(runtime.timeZone, 'unknown', stats, 80),
      secureContext: booleanOrUnknown(runtime.secureContext),
    },
    startup: {
      lastCompletedPhase: safeString(startup.lastCompletedPhase, 'unknown', stats, 64),
      incompleteStartCount: safeCount(startup.incompleteStartCount),
      safeStartState: oneOf(startup.safeStartState, ['not-available', 'inactive', 'active', 'unknown'] as const, 'unknown'),
      ...(oneOfOptional(startup.failureCode, STARTUP_FAILURE_CODES)
        ? { failureCode: oneOfOptional(startup.failureCode, STARTUP_FAILURE_CODES)! }
        : {}),
    },
    storage: {
      conversationSchemaVersion: safeCount(storage.conversationSchemaVersion),
      settingsSchemaVersion: safeCount(storage.settingsSchemaVersion),
      profileSchemaVersion: safeCount(storage.profileSchemaVersion),
      ...(finiteInteger(storage.conversationCount) !== undefined
        ? { conversationCount: finiteInteger(storage.conversationCount)! }
        : {}),
      ...(finiteInteger(storage.messageCount) !== undefined
        ? { messageCount: finiteInteger(storage.messageCount)! }
        : {}),
      ...(roundedApproximateBytes(storage.approximateBytes) !== undefined
        ? { approximateBytes: roundedApproximateBytes(storage.approximateBytes)! }
        : {}),
      quotaUsageBucket: quotaBucket(storage.approximateBytes, storage.quotaBytes),
      integrity: {
        conversationCountReadable: storage.conversationCountReadable === true,
        messageCountReadable: storage.messageCountReadable === true,
        estimateReadable: storage.estimateReadable === true,
        settingsReadable: storage.settingsReadable === true,
        profilesReadable: storage.profilesReadable === true,
      },
    },
    providers: {
      count: safeCount(sources.providerCount, boundedLength(profileSources)),
      activeCount: safeCount(
        sources.activeProviderCount,
        configurations.filter((profile) => profile.active === true).length,
      ),
      configurationsSampled: configurations.length,
      configurations,
    },
    models: {
      count: safeCount(sources.modelCount, boundedLength(modelSources)),
      capabilitySampleCount: modelLimit,
      capabilities: { vision, reasoning, tools },
      identifiersIncluded: options.includeModelIdentifiers === true,
      identifiersTruncated: options.includeModelIdentifiers === true && modelSources.length > modelLimit,
      ...(options.includeModelIdentifiers ? { identifiers } : {}),
    },
    tools: {
      activePolicyAvailable: policyAvailable,
      policyMode: !policyAvailable
        ? 'unknown'
        : enabled === false
          ? 'disabled'
          : enabled !== true
            ? 'unknown'
            : grandmaster
              ? 'grandmaster'
              : hasPromptingCategory
                ? hasGrants ? 'mixed-grants' : 'prompt'
                : 'foundation',
      categories: {
        fileIo: policyAvailable ? booleanOrUnknown(policy.file_io_enabled) : 'unknown',
        shell: policyAvailable ? booleanOrUnknown(policy.shell_enabled) : 'unknown',
        webAccess: policyAvailable ? booleanOrUnknown(policy.web_access_enabled) : 'unknown',
        skills: policyAvailable ? booleanOrUnknown(policy.skills_enabled) : 'unknown',
      },
      grants: {
        webAccessToolCount: webAccessGrantCount,
        allowedRootCount: allowedRootsCount,
        directoryGrantScopeCount: boundedOwnKeyCount(policy.dir_permissions),
      },
      limits: {
        ...(finiteInteger(policy.max_tool_rounds_per_turn) !== undefined
          ? { maxRoundsPerTurn: finiteInteger(policy.max_tool_rounds_per_turn)! }
          : {}),
        ...(finiteInteger(policy.max_tool_calls_per_batch) !== undefined
          ? { maxCallsPerBatch: finiteInteger(policy.max_tool_calls_per_batch)! }
          : {}),
        ...(finiteInteger(policy.sse_read_timeout_min) !== undefined
          ? { streamReadTimeoutMinutes: finiteInteger(policy.sse_read_timeout_min)! }
          : {}),
      },
      globalDefaults: {
        allowedRootCount: boundedLength(globalTools.default_allowed_roots),
        shellAllowlistEntryCount: shellAllowlistEntryCount(globalTools.shell_allowlist, stats),
        ...(finiteInteger(globalTools.web_fetch_rate_per_min) !== undefined
          ? { webFetchRatePerMinute: finiteInteger(globalTools.web_fetch_rate_per_min)! }
          : {}),
      },
    },
    skills: {
      activePolicyAvailable: policyAvailable,
      enabled: policyAvailable ? booleanOrUnknown(policy.skills_enabled) : 'unknown',
      selectedCount: boundedLength(policy.enabled_skill_ids),
      customCount: boundedLength(activeConversation.custom_skills),
    },
    streaming: {
      active: booleanOrUnknown(sources.streamingActive),
      activeCount: safeCount(sources.activeGenerationCount),
      phaseCounts: (() => {
        const phases = record(sources.generationPhaseCounts);
        return {
          running: safeCount(phases.running),
          thinking: safeCount(phases.thinking),
          writing: safeCount(phases.writing),
          usingTools: safeCount(phases['using-tools']),
          waitingPermission: safeCount(phases['waiting-permission']),
          waitingUser: safeCount(phases['waiting-user']),
          stopping: safeCount(phases.stopping),
          finalizing: safeCount(phases.finalizing),
          failed: safeCount(phases.failed),
        };
      })(),
      recentRequests,
      imageCache: {
        batches: safeCount(imageCache.batches),
        bytes: safeCount(imageCache.bytes),
        generations: safeCount(imageCache.generations),
      },
      recentEventCount: streamEvents.length,
      okCount: streamEvents.filter((event) => event.outcome === 'ok').length,
      cancelledCount: streamEvents.filter((event) => event.outcome === 'cancelled').length,
      timeoutCount: streamEvents.filter((event) => event.outcome === 'timeout').length,
      rejectedCount: streamEvents.filter((event) => event.outcome === 'rejected').length,
      errorCount: streamEvents.filter((event) => event.outcome === 'error').length,
      promptTokens: sumEventNumber(streamEvents, 'promptTokens'),
      completionTokens: sumEventNumber(streamEvents, 'completionTokens'),
      totalTokens: sumEventNumber(streamEvents, 'totalTokens'),
    },
    ui: {
      themeMode: oneOf(settings.theme, ['light', 'dark', 'system', 'unknown'] as const, 'unknown'),
      zoomBucket: zoomBucket(settings.zoom),
      materialMode: oneOf(settings.materialMode, ['auto', 'glass', 'solid', 'unknown'] as const, 'unknown'),
      material: materialDiagnostics(),
      codeThemeMode: settings.codeTheme === 'system'
        ? 'system'
        : typeof settings.codeTheme === 'string'
          ? 'custom'
          : 'unknown',
      pinComposer: booleanOrUnknown(settings.pinComposer),
      tokenMeterStyle: oneOf(settings.tokenMeterStyle, ['donut', 'cake', 'unknown'] as const, 'unknown'),
      autoPreviewReasoning: booleanOrUnknown(settings.autoPreviewReasoning),
      customThemeActive: settings.activeCustomThemeId === null
        ? false
        : typeof settings.activeCustomThemeId === 'string'
          ? true
          : 'unknown',
      customThemeCount: boundedLength(settings.customThemes),
      sidebarOpen: booleanOrUnknown(ui.sidebarOpen),
      sidePanelOpen: booleanOrUnknown(ui.sidePanelOpen),
    },
    diagnostics: {
      descriptionsIncluded: options.includeErrorDescriptions === true,
      eventCount: events.length,
      events,
    },
    limits: {
      maxSerializedBytes: SUPPORT_REPORT_MAX_SERIALIZED_BYTES,
      maxStringCharacters: SUPPORT_REPORT_MAX_STRING_CHARACTERS,
      maxCollectionItems: SUPPORT_REPORT_MAX_COLLECTION_ITEMS,
      maxEvents: SUPPORT_REPORT_MAX_EVENTS,
      maxDepth: SUPPORT_REPORT_MAX_DEPTH,
      stringsTruncated: stats.stringsTruncated,
      arraysTruncated: stats.arraysTruncated,
      eventsDropped: stats.eventsDropped,
      sizeReduced: stats.sizeReduced,
    },
  };

  return report;
}

function zoomBucket(value: unknown): SupportReportBase['ui']['zoomBucket'] {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  const known = new Map<number, SupportReportBase['ui']['zoomBucket']>([
    [0.8, '80%'], [0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.25, '125%'], [1.5, '150%'],
  ]);
  return known.get(value) ?? 'custom';
}

const SENSITIVE_KEY = /(?:authorization|cookie|secret|password|api[_-]?key|credential|access[_-]?token|refresh[_-]?token|bearer)/i;

/** Recursive final pass over the already-allowlisted report object. */
export function finalRecursiveRedaction(value: unknown, depth = 0): unknown {
  if (depth > SUPPORT_REPORT_MAX_DEPTH) return '[truncated-depth]';
  if (typeof value === 'string') {
    const redacted = redactSupportString(value);
    return redacted.length > SUPPORT_REPORT_MAX_STRING_CHARACTERS
      ? `${redacted.slice(0, SUPPORT_REPORT_MAX_STRING_CHARACTERS - 1)}…`
      : redacted;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, SUPPORT_REPORT_MAX_COLLECTION_ITEMS)
      .map((item) => finalRecursiveRedaction(item, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key)
        ? '[redacted]'
        : finalRecursiveRedaction(child, depth + 1);
    }
    return out;
  }
  return null;
}

function serializeCandidate(report: SupportReportBase): { report: SupportReportBase; serialized: string; bytes: number } {
  const redacted = finalRecursiveRedaction(report) as SupportReportBase;
  const serialized = `${JSON.stringify(redacted, null, 2)}\n`;
  return { report: redacted, serialized, bytes: new TextEncoder().encode(serialized).byteLength };
}

/** Apply final redaction and the hard serialized-size fallback. */
export function finalizeSupportReport(report: SupportReportBase): { report: SupportReportBase; serialized: string; byteLength: number } {
  let candidate = serializeCandidate(report);
  if (candidate.bytes <= SUPPORT_REPORT_MAX_SERIALIZED_BYTES) {
    return { report: candidate.report, serialized: candidate.serialized, byteLength: candidate.bytes };
  }

  const reduced: SupportReportBase = {
    ...candidate.report,
    providers: {
      ...candidate.report.providers,
      configurations: candidate.report.providers.configurations.slice(0, 8),
      configurationsSampled: Math.min(candidate.report.providers.configurationsSampled, 8),
    },
    models: {
      ...candidate.report.models,
      identifiersTruncated: candidate.report.models.identifiersIncluded || candidate.report.models.identifiersTruncated,
      ...(candidate.report.models.identifiersIncluded ? { identifiers: [] } : {}),
    },
    diagnostics: {
      ...candidate.report.diagnostics,
      eventCount: Math.min(candidate.report.diagnostics.eventCount, 16),
      events: candidate.report.diagnostics.events.slice(-16).map(({ description: _description, ...event }) => event),
    },
    limits: {
      ...candidate.report.limits,
      arraysTruncated: candidate.report.limits.arraysTruncated + 1,
      sizeReduced: true,
    },
  };
  candidate = serializeCandidate(reduced);
  if (candidate.bytes <= SUPPORT_REPORT_MAX_SERIALIZED_BYTES) {
    return { report: candidate.report, serialized: candidate.serialized, byteLength: candidate.bytes };
  }

  // This is intentionally a complete schema-shaped fallback, not a slice of
  // JSON bytes. It remains parseable and useful even if future v1 additions
  // accidentally consume the primary budget.
  const minimal: SupportReportBase = {
    ...candidate.report,
    providers: { ...candidate.report.providers, configurationsSampled: 0, configurations: [] },
    models: {
      ...candidate.report.models,
      identifiersTruncated: candidate.report.models.identifiersIncluded || candidate.report.models.identifiersTruncated,
      ...(candidate.report.models.identifiersIncluded ? { identifiers: [] } : {}),
    },
    diagnostics: { ...candidate.report.diagnostics, eventCount: 0, events: [] },
    limits: { ...candidate.report.limits, arraysTruncated: candidate.report.limits.arraysTruncated + 1, sizeReduced: true },
  };
  candidate = serializeCandidate(minimal);
  return { report: candidate.report, serialized: candidate.serialized, byteLength: candidate.bytes };
}

export function supportReportFilename(date: Date): string {
  return lcExportFileName(`support-v${SUPPORT_REPORT_VERSION}`, 'json', date);
}

/** Build and freeze the exact delivery payload used by preview/copy/save. */
export function createSupportReportSnapshot(
  sources: SupportReportSources,
  options: SupportReportOptions = {},
  now = new Date(),
): SupportReportSnapshot {
  const final = finalizeSupportReport(buildSupportReportBase(sources, options, now));
  return Object.freeze({
    filename: supportReportFilename(now),
    serialized: final.serialized,
    byteLength: final.byteLength,
  });
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isCapabilityCounts(value: unknown): value is CapabilityCounts {
  if (!isRecord(value) || !hasOnlyKeys(value, ['supported', 'unsupported', 'unknown'])) return false;
  return finiteInteger(value.supported) !== undefined
    && finiteInteger(value.unsupported) !== undefined
    && finiteInteger(value.unknown) !== undefined;
}

/** Strict v1 envelope validator used by tests and future import tooling. */
export function isSupportReportBase(value: unknown): value is SupportReportBase {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'format', 'version', 'createdAt', 'application', 'runtime', 'startup', 'storage',
    'providers', 'models', 'tools', 'skills', 'streaming', 'ui', 'diagnostics', 'limits',
  ])) return false;
  if (value.format !== SUPPORT_REPORT_FORMAT || value.version !== SUPPORT_REPORT_VERSION) return false;
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return false;
  const application = record(value.application);
  const runtime = record(value.runtime);
  const startup = record(value.startup);
  const storage = record(value.storage);
  const integrity = record(storage.integrity);
  const providers = record(value.providers);
  const models = record(value.models);
  const capabilities = record(models.capabilities);
  const diagnostics = record(value.diagnostics);
  const limits = record(value.limits);
  if (application.name !== 'LC' || typeof application.version !== 'string' || typeof application.buildChannel !== 'string') return false;
  if (typeof runtime.kind !== 'string' || typeof runtime.osFamily !== 'string' || typeof runtime.architecture !== 'string'
    || typeof runtime.webviewFamily !== 'string' || typeof runtime.locale !== 'string' || typeof runtime.timeZone !== 'string') return false;
  if (typeof startup.lastCompletedPhase !== 'string' || finiteInteger(startup.incompleteStartCount) === undefined
    || typeof startup.safeStartState !== 'string'
    || (startup.failureCode !== undefined && !oneOfOptional(startup.failureCode, STARTUP_FAILURE_CODES))) return false;
  if (finiteInteger(storage.conversationSchemaVersion) === undefined || finiteInteger(storage.settingsSchemaVersion) === undefined
    || finiteInteger(storage.profileSchemaVersion) === undefined) return false;
  if (Object.values(integrity).some((flag) => typeof flag !== 'boolean')) return false;
  if (finiteInteger(providers.count) === undefined || finiteInteger(providers.activeCount) === undefined
    || !Array.isArray(providers.configurations)) return false;
  if (finiteInteger(models.count) === undefined || finiteInteger(models.capabilitySampleCount) === undefined
    || !isCapabilityCounts(capabilities.vision) || !isCapabilityCounts(capabilities.reasoning)
    || !isCapabilityCounts(capabilities.tools) || typeof models.identifiersIncluded !== 'boolean') return false;
  if (!Array.isArray(diagnostics.events) || typeof diagnostics.descriptionsIncluded !== 'boolean'
    || finiteInteger(diagnostics.eventCount) === undefined) return false;
  if (finiteInteger(limits.maxSerializedBytes) === undefined || typeof limits.sizeReduced !== 'boolean') return false;
  return isRecord(value.tools) && isRecord(value.skills) && isRecord(value.streaming) && isRecord(value.ui);
}
