import type {
  Conversation,
  ProfileRequestHeaderSettings,
  ServerProfile,
} from '../../types';
import { useSettings } from '../../store/settings.ts';
import {
  resolveModelServerAuth,
  useAppModels,
  type ModelRegistrySnapshot,
} from '../server-profiles/index.ts';
import {
  LLMClient,
  getProviderContractRegistry,
  providerContractProtocol,
  profileRequestHeaderSettings,
  resolveBundledProviderContract,
  type LLMClientOptions,
  type ModelInfo,
  type ResolvedProviderContract,
} from '../llm-client/index.ts';
import { resolveSearchProvider } from '../tool-engine/search-provider.ts';
import { resolveExposure } from '../tool-engine/policy.ts';
import { buildSystemPrompt, shellListFromConv } from './system-prompt.ts';
import {
  resolveWorkspaceProviderPresentation,
  structuredToolPayload,
} from './provider-capability.ts';
import {
  generationModelDetailConfigurationGeneration,
  invalidateGenerationModelDetailConfiguration,
} from './generation-model-detail-config.ts';

export interface SnapshotConversationConfig {
  id: string;
  title: string;
  serverId?: string;
  model?: string;
  params: Conversation['params'];
  tools?: Conversation['tools'];
  custom_skills?: Conversation['custom_skills'];
}

export interface SnapshotProfileFacts extends ProfileRequestHeaderSettings {
  id: string;
  name: string;
  baseUrl: string;
  apiVariant?: ServerProfile['apiVariant'];
  apiStyle?: ServerProfile['apiStyle'];
  routing?: ServerProfile['routing'];
  modelFetchUrl?: string;
  sseReadTimeoutMin: number;
}

export interface SnapshotHelperRoute extends ProfileRequestHeaderSettings {
  profileId: string;
  modelId: string;
  baseUrl: string;
  modelFetchUrl?: string;
  apiVariant: string;
  apiStyle: 'chat' | 'responses';
  routing: 'proxy' | 'direct';
  modelDetail: Readonly<ModelInfo> | null;
  providerContract?: Readonly<ResolvedProviderContract>;
  providerContractStatus: 'matched' | 'unmatched';
}

/** Immutable, serializable inputs for one admitted generation. No API keys. */
export interface GenerationExecutionSnapshot {
  conversation: Readonly<SnapshotConversationConfig>;
  profile: Readonly<SnapshotProfileFacts>;
  systemPrompt: string;
  workspace: Readonly<ReturnType<typeof resolveWorkspaceProviderPresentation>>;
  exposedToolNames: readonly string[];
  structuredTools: Readonly<ReturnType<typeof structuredToolPayload>>;
  modelRegistry: Readonly<ModelRegistrySnapshot>;
  modelDetail: Readonly<ModelInfo> | null;
  /** Verified wire behavior fixed at generation admission time. */
  providerContract?: Readonly<ResolvedProviderContract>;
  providerContractStatus: 'matched' | 'unmatched';
  providerContractRegistryVersion: 1;
  toolRuntime: Readonly<{
    searchProvider: Readonly<{ provider: 'brave' | 'searxng' | 'marginalia'; baseUrl: string }> | null;
    visionModel: string;
    webResearchModel: string;
    pdfSummarizeModel: string;
    shellAllowlist: readonly string[];
    helperRoutes: Readonly<Record<string, Readonly<SnapshotHelperRoute>>>;
  }>;
  capturedAt: number;
}

/** Runtime-only secrets kept adjacent to, never inside, the frozen snapshot. */
export interface GenerationRuntimeSecrets {
  searchProviderApiKey: string;
  helperApiKeys: Readonly<Record<string, string>>;
}

type ModelDetailRoute = Pick<
  LLMClientOptions,
  | 'baseUrl'
  | 'modelFetchUrl'
  | 'apiKey'
  | 'apiVariant'
  | 'apiStyle'
  | 'routing'
  | 'fetchImpl'
  | 'streamFetchImpl'
  | 'modelsCache'
  | 'includeLcIdentifierHeader'
  | 'lcIdentifierHeader'
  | 'includeAdditionalRequestHeaders'
  | 'requestHeaders'
> & { profileId: string };

interface ModelDetailCacheEntry {
  at: number;
  detail: ModelInfo;
}

interface ModelDetailFlight {
  controller: AbortController;
  promise: Promise<ModelInfo | null>;
  waiters: number;
  settled: boolean;
}

const MODEL_DETAIL_TTL_MS = 60_000;
const MODEL_DETAIL_CACHE_MAX_ENTRIES = 32;
const modelDetailCache = new Map<string, ModelDetailCacheEntry>();
const modelDetailFlights = new Map<string, ModelDetailFlight>();

function modelDetailKey(route: ModelDetailRoute, modelId: string): string {
  // Credentials and fetch implementations are intentionally absent. The key
  // contains only profile/configuration and routing facts that can change
  // which model-list resource is queried; no secret is retained in cache
  // ownership or diagnostics.
  return JSON.stringify([
    generationModelDetailConfigurationGeneration(),
    route.profileId,
    route.baseUrl,
    route.modelFetchUrl ?? '',
    route.apiVariant ?? 'openai',
    route.apiStyle ?? 'chat',
    route.routing ?? 'proxy',
    modelId,
  ]);
}

function rememberModelDetail(key: string, detail: ModelInfo): void {
  modelDetailCache.delete(key);
  modelDetailCache.set(key, { at: Date.now(), detail });
  while (modelDetailCache.size > MODEL_DETAIL_CACHE_MAX_ENTRIES) {
    const oldest = modelDetailCache.keys().next().value;
    if (oldest === undefined) break;
    modelDetailCache.delete(oldest);
  }
}

function cachedModelDetail(key: string): ModelInfo | null {
  const hit = modelDetailCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= MODEL_DETAIL_TTL_MS) {
    modelDetailCache.delete(key);
    return null;
  }
  modelDetailCache.delete(key);
  modelDetailCache.set(key, hit);
  return hit.detail;
}

function waitForModelDetailFlight(
  flight: ModelDetailFlight,
  signal?: AbortSignal,
): Promise<ModelInfo | null> {
  if (!signal) return flight.promise;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (detail: ModelInfo | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(detail);
    };
    const onAbort = () => finish(null);
    signal.addEventListener('abort', onAbort, { once: true });
    void flight.promise.then(finish, () => finish(null));
  });
}

/**
 * Resolve one model detail through the application cache.
 *
 * Concurrent captures share a fetch, but each caller keeps its own abortable
 * wait. The underlying request is aborted only after its final waiter leaves,
 * so cancelling conversation A cannot make conversation B lose the same
 * in-flight lookup. Failed/missing lookups are not cached.
 */
export async function getCachedModelDetail(
  route: ModelDetailRoute,
  modelId: string,
  signal?: AbortSignal,
): Promise<ModelInfo | null> {
  if (!modelId || signal?.aborted) return null;
  const key = modelDetailKey(route, modelId);
  const hit = cachedModelDetail(key);
  if (hit) return hit;

  let flight = modelDetailFlights.get(key);
  if (!flight || flight.controller.signal.aborted) {
    const controller = new AbortController();
    const next: ModelDetailFlight = {
      controller,
      promise: Promise.resolve(null),
      waiters: 0,
      settled: false,
    };
    next.promise = (async () => {
      try {
        const client = new LLMClient(route);
        const models = await client.listModels(controller.signal);
        const detail = models.find((model) => model.id === modelId) ?? null;
        if (detail) rememberModelDetail(key, detail);
        return detail;
      } catch {
        return null;
      } finally {
        next.settled = true;
        if (modelDetailFlights.get(key) === next) modelDetailFlights.delete(key);
      }
    })();
    flight = next;
    modelDetailFlights.set(key, flight);
  }

  flight.waiters += 1;
  try {
    return await waitForModelDetailFlight(flight, signal);
  } finally {
    flight.waiters -= 1;
    if (!flight.settled && flight.waiters === 0) {
      if (modelDetailFlights.get(key) === flight) modelDetailFlights.delete(key);
      flight.controller.abort();
    }
  }
}

/** Clear bounded model-detail state after an application-wide config change. */
export function clearGenerationModelDetailCache(): void {
  invalidateGenerationModelDetailConfiguration();
  modelDetailCache.clear();
  const flights = [...modelDetailFlights.values()];
  modelDetailFlights.clear();
  for (const flight of flights) flight.controller.abort();
}

export function freezeGenerationExecutionSnapshot<T>(value: T): T {
  const clone = typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    Object.freeze(entry);
    for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
  };
  freeze(clone);
  return clone;
}

export async function captureGenerationExecutionState(
  conversation: Conversation,
  profile: ServerProfile,
  options: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<{ snapshot: GenerationExecutionSnapshot; secrets: GenerationRuntimeSecrets }> {
  const workspace = resolveWorkspaceProviderPresentation(conversation.tools, profile.apiVariant);
  const settingsTools = useSettings.getState().tools;
  const resolvedSearch = resolveSearchProvider(settingsTools);
  const systemPrompt = workspace.workspacePromptEnabled
    ? await buildSystemPrompt(conversation)
    : (conversation.params.system_prompt?.trim() ?? '');
  const helperSelections = [
    settingsTools.vision_model,
    settingsTools.web_research_model,
    settingsTools.pdf_summarize_model,
  ].filter((selection, index, all) => selection.includes('::') && all.indexOf(selection) === index);
  const helperRoutes: Record<string, SnapshotHelperRoute> = {};
  const helperApiKeys: Record<string, string> = {};
  // Start the main lookup in the same wave as helper route resolution. A
  // configured remote helper must not make the chat model wait an additional
  // full network round-trip after the helpers settle.
  const modelDetailPromise = conversation.model
    ? getCachedModelDetail({
        profileId: profile.id,
        baseUrl: profile.baseUrl,
        modelFetchUrl: profile.modelFetchUrl,
        apiKey: options.apiKey ?? profile.apiKey ?? '',
        apiVariant: profile.apiVariant,
        apiStyle: profile.apiStyle,
        routing: profile.routing,
        ...profileRequestHeaderSettings(profile),
      }, conversation.model, options.signal)
    : Promise.resolve(null);
  await Promise.all(helperSelections.map(async (selection) => {
    const route = await resolveModelServerAuth(selection);
    if (!route) return;
    // Only Anthropic consumes helper model metadata (its output-token ceiling).
    // Fetching lists for OpenAI-compatible vision/research/PDF helpers added
    // latency while the result was discarded by every downstream adapter.
    const modelDetail = route.apiVariant === 'anthropic'
      ? await getCachedModelDetail({
          profileId: route.profileId,
          baseUrl: route.baseUrl,
          modelFetchUrl: route.modelFetchUrl,
          apiKey: route.apiKey,
          apiVariant: route.apiVariant,
          apiStyle: route.apiStyle,
          routing: route.routing,
          ...profileRequestHeaderSettings(route),
        }, route.modelId, options.signal)
      : null;
    const providerContract = resolveBundledProviderContract({
      baseUrl: route.baseUrl,
      protocol: providerContractProtocol(route.apiVariant, route.apiStyle),
      modelId: route.modelId,
    });
    helperRoutes[selection] = {
      profileId: route.profileId,
      modelId: route.modelId,
      baseUrl: route.baseUrl,
      modelFetchUrl: route.modelFetchUrl,
      apiVariant: route.apiVariant,
      apiStyle: route.apiStyle,
      routing: route.routing,
      modelDetail,
      ...(providerContract ? { providerContract } : {}),
      providerContractStatus: providerContract ? 'matched' : 'unmatched',
      ...profileRequestHeaderSettings(route),
    };
    helperApiKeys[selection] = route.apiKey;
  }));
  const modelDetail = await modelDetailPromise;
  const providerContract = conversation.model
    ? resolveBundledProviderContract({
        baseUrl: profile.baseUrl,
        protocol: providerContractProtocol(profile.apiVariant, profile.apiStyle),
        modelId: conversation.model,
      })
    : undefined;
  const snapshot: GenerationExecutionSnapshot = {
    conversation: {
      id: conversation.id,
      title: conversation.title,
      serverId: conversation.serverId,
      model: conversation.model,
      params: conversation.params,
      tools: conversation.tools,
      custom_skills: conversation.custom_skills,
    },
    profile: {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiVariant: profile.apiVariant,
      apiStyle: profile.apiStyle,
      routing: profile.routing,
      modelFetchUrl: profile.modelFetchUrl,
      sseReadTimeoutMin: profile.sse_read_timeout_min ?? 5,
      ...profileRequestHeaderSettings(profile),
    },
    systemPrompt,
    workspace,
    exposedToolNames: [...resolveExposure(conversation.tools ?? {}).exposedNames],
    structuredTools: structuredToolPayload(conversation.tools, profile.apiVariant),
    modelRegistry: {
      records: useAppModels.getState().records,
      overrides: useAppModels.getState().overrides,
      customizations: useAppModels.getState().customizations,
      models: useAppModels.getState().models,
    },
    modelDetail,
    ...(providerContract ? { providerContract } : {}),
    providerContractStatus: providerContract ? 'matched' : 'unmatched',
    providerContractRegistryVersion: getProviderContractRegistry().schema_version,
    toolRuntime: {
      searchProvider: resolvedSearch
        ? { provider: resolvedSearch.provider, baseUrl: resolvedSearch.baseUrl }
        : null,
      visionModel: settingsTools.vision_model,
      webResearchModel: settingsTools.web_research_model,
      pdfSummarizeModel: settingsTools.pdf_summarize_model,
      shellAllowlist: shellListFromConv(conversation),
      helperRoutes,
    },
    capturedAt: Date.now(),
  };
  return {
    snapshot: freezeGenerationExecutionSnapshot(snapshot),
    secrets: {
      searchProviderApiKey: resolvedSearch?.apiKey ?? '',
      helperApiKeys: Object.freeze({ ...helperApiKeys }),
    },
  };
}

export async function captureGenerationExecutionSnapshot(
  conversation: Conversation,
  profile: ServerProfile,
): Promise<GenerationExecutionSnapshot> {
  return (await captureGenerationExecutionState(conversation, profile)).snapshot;
}
