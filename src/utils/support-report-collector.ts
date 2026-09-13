/** Store-aware collection for the pure support-report builder. */

import { LC_VERSION } from '../app-metadata.ts';
import { useAppModels, useProfileStore } from '../modules/server-profiles/index.ts';
import { PROFILE_STORE_VERSION } from '../modules/server-profiles/profile-store.ts';
import { isAnyStreaming, useConversations } from '../store/conversations.ts';
import { activeGenerationSessions } from '../modules/chat-pipeline/generation-session-manager.ts';
import {
  CONVERSATION_DB_VERSION,
  conversationCount,
  messageCount,
} from '../store/db.ts';
import { SETTINGS_STORE_VERSION, useSettings } from '../store/settings.ts';
import { isTauri } from './saveBlob.ts';
import { diagnosticBufferUnreadable, readDiagnosticEvents } from './diagnostic-events.ts';
import { readPersistedStartupDiagnostics } from '../startup/startup-runtime.ts';
import {
  readActiveRequestSnapshot,
  readRecentRequestSnapshots,
} from '../modules/llm-client/request-snapshot.ts';
import { imageBatchCacheMetrics } from '../modules/tool-engine/builtin/read_image.ts';
import { isHttpUrlCredentialFree } from './url-credentials.ts';
import { decideSearchProvider } from '../modules/tool-engine/search-provider.ts';
import type { WebSearchProvider } from '../store/settings';
import {
  CONFIGURABLE_SEARCH_PROVIDERS,
  type ConfigurableSearchProvider,
  type SupportReportOptions,
  type SupportReportSnapshot,
} from './support-report-base.ts';
import {
  createSupportReportSnapshotV1,
  type SupportReportV1Sources,
} from './support-report.ts';

const STORAGE_QUERY_TIMEOUT_MS = 1_500;

interface TimedResult<T> {
  ok: boolean;
  value?: T;
}

async function timed<T>(promise: Promise<T>, timeoutMs: number): Promise<TimedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ ok: true, value })),
      new Promise<TimedResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
      }),
    ]);
  } catch {
    return { ok: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function buildChannel(): 'development' | 'release' | 'test' | 'unknown' {
  const mode = import.meta.env?.MODE;
  if (mode === 'test') return 'test';
  if (import.meta.env?.DEV) return 'development';
  if (import.meta.env?.PROD) return 'release';
  return 'unknown';
}

function runtimeNavigator(): Navigator | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator;
}

function osFamily(platform: string, userAgent: string): 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown' {
  const value = `${platform} ${userAgent}`.toLowerCase();
  if (value.includes('android')) return 'android';
  if (/iphone|ipad|ipod|ios/.test(value)) return 'ios';
  if (value.includes('windows') || value.includes('win32') || value.includes('win64')) return 'windows';
  if (value.includes('mac') || value.includes('darwin')) return 'macos';
  if (value.includes('linux') || value.includes('x11')) return 'linux';
  return 'unknown';
}

function osVersion(family: ReturnType<typeof osFamily>, userAgent: string): string | undefined {
  const match = family === 'windows'
    ? userAgent.match(/Windows NT ([0-9.]+)/i)
    : family === 'macos' || family === 'ios'
      ? userAgent.match(/(?:Mac OS X|OS) ([0-9_]+)/i)
      : family === 'android'
        ? userAgent.match(/Android ([0-9.]+)/i)
        : undefined;
  return match?.[1]?.replaceAll('_', '.').slice(0, 40);
}

function architecture(platform: string, userAgent: string): 'x86_64' | 'x86' | 'arm64' | 'arm' | 'unknown' {
  const value = `${platform} ${userAgent}`.toLowerCase();
  if (/arm64|aarch64/.test(value)) return 'arm64';
  if (/armv?7|\barm\b/.test(value)) return 'arm';
  if (/x86_64|x64|win64|amd64|wow64/.test(value)) return 'x86_64';
  if (/i[3-6]86|x86|win32/.test(value)) return 'x86';
  return 'unknown';
}

function webviewInfo(
  family: ReturnType<typeof osFamily>,
  userAgent: string,
): { webviewFamily: 'webview2' | 'webkit' | 'webkitgtk' | 'chromium' | 'unknown'; webviewVersion?: string } {
  if (isTauri && family === 'windows') {
    const version = userAgent.match(/(?:Edg|Chrome)\/([0-9.]+)/)?.[1];
    return { webviewFamily: 'webview2', ...(version ? { webviewVersion: version.slice(0, 40) } : {}) };
  }
  if (isTauri && family === 'macos') {
    const version = userAgent.match(/Version\/([0-9.]+)/)?.[1];
    return { webviewFamily: 'webkit', ...(version ? { webviewVersion: version.slice(0, 40) } : {}) };
  }
  if (isTauri && family === 'linux') {
    const version = userAgent.match(/AppleWebKit\/([0-9.]+)/)?.[1];
    return { webviewFamily: 'webkitgtk', ...(version ? { webviewVersion: version.slice(0, 40) } : {}) };
  }
  const chromium = userAgent.match(/(?:Chrome|Chromium)\/([0-9.]+)/)?.[1];
  if (chromium) return { webviewFamily: 'chromium', webviewVersion: chromium.slice(0, 40) };
  const webkit = userAgent.match(/AppleWebKit\/([0-9.]+)/)?.[1];
  if (webkit) return { webviewFamily: 'webkit', webviewVersion: webkit.slice(0, 40) };
  return { webviewFamily: 'unknown' };
}

function safeLocale(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,48}$/.test(value) ? value : 'unknown';
}

function safeTimeZone(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_+./-]{1,80}$/.test(value) ? value : 'unknown';
}

async function collectRuntime(): Promise<Record<string, unknown>> {
  const nav = runtimeNavigator();
  const userAgent = nav?.userAgent ?? '';
  const userAgentData = nav as Navigator & { userAgentData?: { platform?: string } };
  const platform = userAgentData.userAgentData?.platform ?? nav?.platform ?? '';
  const family = osFamily(platform, userAgent);
  let applicationVersion = LC_VERSION;
  let tauriVersion: string | undefined;
  if (isTauri) {
    try {
      const app = await import('@tauri-apps/api/app');
      const values = await Promise.allSettled([app.getVersion(), app.getTauriVersion()]);
      if (values[0].status === 'fulfilled') applicationVersion = values[0].value;
      if (values[1].status === 'fulfilled') tauriVersion = values[1].value;
    } catch {
      // The report remains useful when the IPC metadata API is unavailable.
    }
  }
  let resolved: Partial<Intl.ResolvedDateTimeFormatOptions> = {};
  try {
    resolved = Intl.DateTimeFormat().resolvedOptions();
  } catch {
    // Locale and time zone remain unknown.
  }
  return {
    applicationVersion,
    runtime: {
      kind: isTauri ? 'tauri' : typeof window === 'undefined' ? 'unknown' : 'web',
      osFamily: family,
      ...(osVersion(family, userAgent) ? { osVersion: osVersion(family, userAgent) } : {}),
      architecture: architecture(platform, userAgent),
      ...(tauriVersion ? { tauriVersion } : {}),
      ...webviewInfo(family, userAgent),
      locale: safeLocale(resolved.locale),
      timeZone: safeTimeZone(resolved.timeZone),
      secureContext: typeof window === 'undefined' ? 'unknown' : window.isSecureContext,
    },
  };
}

async function browserStorageEstimate(): Promise<{ usage?: number; quota?: number }> {
  const nav = runtimeNavigator();
  if (!nav?.storage?.estimate) throw new Error('Storage estimate unavailable');
  return nav.storage.estimate();
}

function safeStoreRead<T>(read: () => T): TimedResult<T> {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false };
  }
}


/**
 * Which sections the collector could not read. Reported as bounded codes so a
 * thin report is never mistaken for a healthy one.
 */
function collectorFailures(
  conversations: boolean,
  messages: boolean,
  estimate: boolean,
  settings: boolean,
  profiles: boolean,
): Array<{ section: string; code: string }> {
  const failures: Array<{ section: string; code: string }> = [];
  if (!conversations || !messages) failures.push({ section: 'storage', code: 'collector-timeout' });
  if (!estimate) failures.push({ section: 'storage', code: 'collector-failed' });
  if (!settings) failures.push({ section: 'ui', code: 'collector-failed' });
  if (!profiles) failures.push({ section: 'providers', code: 'collector-failed' });
  return failures;
}

/**
 * The most recent chat request.
 *
 * The captured snapshot is authoritative: it was recorded at the provider
 * boundary when the request was actually sent, so switching conversations or
 * editing a profile afterwards cannot rewrite it. Only when no request has run
 * this session does this fall back to describing the current configuration —
 * and it says so, rather than presenting configuration as an observed request.
 */
function describeRequestContext(
  conversation: Record<string, unknown> | undefined,
  profile: Record<string, unknown> | undefined,
  models: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const snapshot = readActiveRequestSnapshot();
  if (snapshot) return { ...snapshot, source: 'request' };
  const fallback = describeCurrentConfiguration(conversation, profile, models);
  return fallback ? { ...fallback, source: 'current-configuration' } : undefined;
}

/**
 * What LC *would* send with the current selection. Reads configuration already
 * in memory; performs no network request and no model refresh.
 *
 * Deliberately omits a tool-definition count: nothing has been assembled, so
 * there is no count to report. The previous implementation counted keys in the
 * persisted tools policy object, which is a count of policy fields, not of
 * tool definitions.
 */
function describeCurrentConfiguration(
  conversation: Record<string, unknown> | undefined,
  profile: Record<string, unknown> | undefined,
  models: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (!conversation || !profile) return undefined;
  const apiVariant = typeof profile.apiVariant === 'string' ? profile.apiVariant : 'openai';
  const apiStyle = apiVariant === 'openai'
    ? (typeof profile.apiStyle === 'string' ? profile.apiStyle : 'chat')
    : 'not-applicable';
  const protocol = apiVariant === 'anthropic'
    ? 'anthropic'
    : apiVariant === 'lm-studio'
      ? 'lmstudio-rest'
      : apiVariant === 'gemini' ? 'gemini-rest' : 'openai';

  const baseUrl = typeof profile.baseUrl === 'string' ? profile.baseUrl : '';
  let cacheSurface: string;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    cacheSurface = hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai')
      ? 'router'
      : protocol === 'lmstudio-rest' ? 'none' : 'provider-native';
  } catch {
    cacheSurface = 'unknown';
  }

  const params = (conversation.params ?? {}) as Record<string, unknown>;
  const tools = (conversation.tools ?? {}) as Record<string, unknown>;
  const modelId = typeof conversation.model === 'string' ? conversation.model : '';
  const model = models.find((entry) => entry?.id === modelId);
  const capabilities = (model?.capabilities ?? {}) as Record<string, unknown>;
  const timeoutMinutes = typeof tools.sse_read_timeout_min === 'number'
    ? tools.sse_read_timeout_min
    : typeof profile.sse_read_timeout_min === 'number' ? profile.sse_read_timeout_min : undefined;

  return {
    protocol,
    apiStyle,
    routing: typeof profile.routing === 'string' ? profile.routing : 'unknown',
    // The builder classifies this into an endpoint class; the host itself
    // never reaches the serialized report.
    baseUrl,
    cacheSurface,
    reasoningEnabled: params.reasoning_enabled,
    reasoningEffort: params.reasoning_effort,
    ...(timeoutMinutes !== undefined ? { streamTimeoutMs: timeoutMinutes * 60_000 } : {}),
    capabilities: {
      vision: capabilities.vision,
      reasoning: typeof capabilities.reasoning === 'boolean' ? capabilities.reasoning : undefined,
      tools: capabilities.tools ?? capabilities.trained_for_tool_use,
    },
    contextWindowKnown: typeof model?.max_context_length === 'number'
      || typeof model?.loaded_context_length === 'number',
  };
}

/**
 * Credential *configuration state*, derived from which storage slot is
 * populated. No keychain read is performed, and no reference name, account id,
 * or credential value is read.
 */
function describeCredentials(
  profile: Record<string, unknown> | undefined,
  tools: Record<string, unknown>,
): Array<{ surface: string; state: string }> {
  const state = (ref: unknown, plaintext: unknown): string => {
    if (typeof ref === 'string' && ref.length > 0) return 'keychain-ref';
    if (typeof plaintext === 'string' && plaintext.length > 0) return 'plaintext-fallback';
    return 'not-configured';
  };
  return [
    { surface: 'chat', state: profile ? state(profile.apiKeyRef, profile.apiKey) : 'unknown' },
    { surface: 'profile', state: profile ? state(profile.apiKeyRef, profile.apiKey) : 'unknown' },
    { surface: 'brave', state: state(tools.brave_search_api_key_ref, tools.brave_search_api_key) },
    // SearXNG is configured by a non-secret base URL and carries no credential.
    { surface: 'searxng', state: 'not-configured' },
    { surface: 'marginalia', state: state(tools.marginalia_api_key_ref, tools.marginalia_api_key) },
  ];
}

/**
 * Search **configuration** state. Never a runtime resolution.
 *
 * This reports which providers are configured and what the user selected. It
 * does not report what resolved: that comes only from the resolver's own
 * events, because a configured keychain reference is not evidence that a
 * usable key was ever loaded. Reporting it as resolved here is exactly how a
 * report could claim a provider served a call that in fact never ran.
 *
 * Presence is judged from settings alone. No keychain read and no in-memory
 * key lookup happens, so collecting a report cannot touch a credential or
 * re-run the resolver.
 */
function describeSearch(tools: Record<string, unknown>): Record<string, unknown> {
  const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;
  const searxngBaseUrl = typeof tools.searxng_base_url === 'string'
    && isHttpUrlCredentialFree(tools.searxng_base_url)
    ? tools.searxng_base_url
    : '';
  const configuredBy: Record<ConfigurableSearchProvider, boolean> = {
    brave: nonEmpty(tools.brave_search_api_key_ref) || nonEmpty(tools.brave_search_api_key),
    searxng: nonEmpty(searxngBaseUrl),
    marginalia: nonEmpty(tools.marginalia_api_key_ref) || nonEmpty(tools.marginalia_api_key),
  };
  // The same pure decision helper the live resolver uses, so the two cannot
  // drift into disagreeing about what `auto` and a stale selection mean.
  const { selected } = decideSearchProvider(
    tools.web_search_provider as WebSearchProvider | undefined,
    configuredBy,
  );

  return {
    selected,
    configured: Object.values(configuredBy).some(Boolean),
    configuredProviders: CONFIGURABLE_SEARCH_PROVIDERS.filter((name) => configuredBy[name]),
    ...(nonEmpty(searxngBaseUrl) ? { searxngBaseUrl } : {}),
  };
}

/**
 * Collect approved facts without model refresh, keychain access, conversation
 * loads, localStorage scans, or network requests.
 */
export async function collectSupportReportSources(
): Promise<SupportReportV1Sources> {
  const runtimePromise = collectRuntime();
  const [conversationResult, messageResult, estimateResult, runtimeResult] = await Promise.all([
    timed(conversationCount(), STORAGE_QUERY_TIMEOUT_MS),
    timed(messageCount(), STORAGE_QUERY_TIMEOUT_MS),
    timed(browserStorageEstimate(), STORAGE_QUERY_TIMEOUT_MS),
    runtimePromise,
  ]);

  const settingsResult = safeStoreRead(() => useSettings.getState());
  const profilesResult = safeStoreRead(() => useProfileStore.getState().profiles);
  const modelsResult = safeStoreRead(() => useAppModels.getState().models);
  const conversationsResult = safeStoreRead(() => useConversations.getState());
  const profiles = Array.isArray(profilesResult.value) ? profilesResult.value : [];
  const models = Array.isArray(modelsResult.value) ? modelsResult.value : [];
  const conversationState = conversationsResult.value;
  const activeConversation = conversationState && typeof conversationState.activeId === 'string'
    ? conversationState.byId?.[conversationState.activeId]
    : undefined;
  const sessionsResult = safeStoreRead(() => activeGenerationSessions());
  const sessions = Array.isArray(sessionsResult.value) ? sessionsResult.value : [];
  const recentRequestsResult = safeStoreRead(() => readRecentRequestSnapshots());
  const imageCacheResult = safeStoreRead(() => imageBatchCacheMetrics());
  const generationPhaseCounts = sessions.reduce<Record<string, number>>((counts, session) => {
    counts[session.phase] = (counts[session.phase] ?? 0) + 1;
    return counts;
  }, {});

  let activeProviderCount: number | undefined;
  if (profiles.length <= 4_096) {
    activeProviderCount = 0;
    for (const profile of profiles) {
      if (profile?.active === true) activeProviderCount++;
    }
  }

  const settings = settingsResult.value as unknown as Record<string, unknown> | undefined;
  const toolSettings = (settings?.tools ?? {}) as Record<string, unknown>;
  const activeProfile = activeConversation && typeof activeConversation.serverId === 'string'
    ? (profiles as unknown as Array<Record<string, unknown>>)
      .find((profile) => profile?.id === activeConversation.serverId)
    : undefined;

  return {
    reportSurface: 'settings',
    eventBufferReadable: !diagnosticBufferUnreadable(),
    collectorFailures: collectorFailures(
      conversationResult.ok, messageResult.ok, estimateResult.ok,
      settingsResult.ok, profilesResult.ok,
    ),
    activeRequest: describeRequestContext(
      activeConversation as unknown as Record<string, unknown> | undefined,
      activeProfile,
      models as unknown as Array<Record<string, unknown>>,
    ),
    credentials: describeCredentials(activeProfile, toolSettings),
    search: describeSearch(toolSettings),
    application: {
      version: runtimeResult.applicationVersion,
      buildChannel: buildChannel(),
    },
    runtime: runtimeResult.runtime,
    startup: readPersistedStartupDiagnostics(),
    storage: {
      conversationSchemaVersion: CONVERSATION_DB_VERSION,
      settingsSchemaVersion: SETTINGS_STORE_VERSION,
      profileSchemaVersion: PROFILE_STORE_VERSION,
      ...(conversationResult.ok ? { conversationCount: conversationResult.value } : {}),
      ...(messageResult.ok ? { messageCount: messageResult.value } : {}),
      ...(estimateResult.ok ? {
        approximateBytes: estimateResult.value?.usage,
        quotaBytes: estimateResult.value?.quota,
      } : {}),
      conversationCountReadable: conversationResult.ok,
      messageCountReadable: messageResult.ok,
      estimateReadable: estimateResult.ok,
      settingsReadable: settingsResult.ok,
      profilesReadable: profilesResult.ok,
    },
    providerCount: profiles.length,
    ...(activeProviderCount !== undefined ? { activeProviderCount } : {}),
    profiles,
    modelCount: models.length,
    // The builder does not read model IDs unless the option is enabled.
    models,
    settings: settingsResult.value,
    activeConversation,
    streamingActive: safeStoreRead(() => isAnyStreaming()).value,
    activeGenerationCount: sessions.length,
    generationPhaseCounts,
    recentRequestSnapshots: recentRequestsResult.value,
    imageCacheMetrics: imageCacheResult.value,
    diagnosticEvents: readDiagnosticEvents(),
  };
}

export async function createCurrentSupportReport(
  options: SupportReportOptions = {},
  now = new Date(),
): Promise<SupportReportSnapshot> {
  const sources = await collectSupportReportSources();
  return createSupportReportSnapshotV1(sources, options, now);
}
