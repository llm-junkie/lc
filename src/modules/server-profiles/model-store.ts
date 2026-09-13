/**
 * Canonical model registry — the single live metadata source of truth for
 * every model LC knows about, across every profile.
 *
 * Server discovery, models.dev enrichment, the persistent base cache, and
 * override persistence are all *inputs* to this store. UI and runtime
 * consumers read effective metadata from here and nowhere else; nobody else
 * queries `modelCache`, models.dev, or `model-overrides` directly. Before
 * this was true, Settings, the visibility panel, ChatView, and the
 * orchestrator each kept their own projection, and they could disagree.
 *
 * State shape:
 *   - `records`  — the canonical map, one `ModelRegistryRecord` per
 *                  `profileId + modelId`, holding the detected layer, the
 *                  optional user override, and the merged effective entry.
 *                  Includes cached records for INACTIVE profiles so the
 *                  visibility panel can list everything from one source.
 *   - `overrides`— the live override layer. `model-overrides.ts` validates
 *                  and persists it; this store owns it.
 *   - `models`   — a derived array of ACTIVE effective entries, kept for the
 *                  existing chat/tool consumers (`useAppModels(s => s.models)`).
 *
 * Every ingest path funnels through `commitDetected()`, so detected updates,
 * override application, and the active projection can never be regenerated
 * out of step with each other.
 */

import { create } from 'zustand';
import type { ServerProfile } from '../../types';
import { useProfileStore } from './profile-store.ts';
import {
  LLMClient,
  isLocalNetworkUrl,
  profileRequestHeaderSettings,
} from '../llm-client/index.ts';
import type { ModelInfo } from '../llm-client/types';
import { modelCache, type CachedModel } from './model-cache.ts';
import { resolveProfileCredential } from '../../platform/chat-credential.ts';
import { hiddenModelKey } from '../../store/modelVisibility.ts';
import {
  applyOverride,
  loadModelOverrides,
  sanitizeOverride,
  sanitizeOverrideMap,
  saveModelOverrides,
  clearModelOverrides,
  type ModelMetaOverride,
  type ModelMetaOverrideMap,
} from './model-overrides.ts';
import {
  clearModelCustomizations,
  loadModelCustomizations,
  sanitizeModelCustomizations,
  saveModelCustomizations,
  type CustomModelDefinition,
  type ModelCustomizationMap,
} from './model-customizations.ts';

export interface AppModelCapabilities {
  vision?: boolean;
  reasoning?: boolean;
  tools?: boolean;
}

export interface AppModelEntry {
  id: string;
  displayName: string;
  profileId: string;
  profileName: string;
  apiVariant: string;
  apiStyle: string;
  state?: 'loaded' | 'not-loaded' | 'loading' | 'unreachable';
  loadedContextLength?: number;
  maxContextLength?: number;
  loadedInstances?: Array<{ id: string; config?: { context_length?: number } }>;
  capabilities: AppModelCapabilities;
  type?: string;
  publisher?: string;
  architecture?: string;
  paramsString?: string;
  format?: string;
  modelSource?: 'lmstudio-rest' | 'gemini-rest';
}

/** One model on one profile: what was detected, what the user said, and the
 *  merge of the two. `origin` distinguishes a live probe from a cache read. */
export interface ModelRegistryRecord {
  /** `hiddenModelKey(profileId, modelId)` — the composite identity. */
  key: string;
  profileId: string;
  modelId: string;
  profileActive: boolean;
  origin: 'live' | 'cache' | 'manual';
  /** Server/native metadata plus models.dev fallback enrichment. */
  detected: AppModelEntry;
  override?: ModelMetaOverride;
  /** `detected` with the override applied, field by field. */
  effective: AppModelEntry;
}

/** The readable half of the registry — what selectors and consumers need,
 *  without the action surface. `useAppModels.getState()` satisfies it. */
export interface ModelRegistrySnapshot {
  /** Canonical registry: active AND inactive profiles. */
  records: Record<string, ModelRegistryRecord>;
  /** Live override layer, persisted through the model-overrides adapter. */
  overrides: ModelMetaOverrideMap;
  /** Added models and deleted-server-model tombstones, keyed by profile. */
  customizations: ModelCustomizationMap;
  /** Active effective entries — the compatibility projection. */
  models: AppModelEntry[];
}

interface State extends ModelRegistrySnapshot {
  loading: boolean;
  error: string | null;
  _refreshing: boolean;
  /** Per-profile reachability; absent key = not yet probed. */
  serverHealth: Record<string, 'reachable' | 'unreachable'>;
  bootstrap: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Re-fetch one profile only — used by the per-model Refresh button. */
  refreshServer: (profileId: string) => Promise<void>;
  /** Commit freshly detected entries for one profile (no network), and
   *  optionally that profile's reachability in the same update. */
  replaceProfileModels: (
    profileId: string,
    entries: AppModelEntry[],
    health?: 'reachable' | 'unreachable',
  ) => void;
  setMetadataOverride: (profileId: string, modelId: string, value: ModelMetaOverride) => void;
  removeMetadataOverride: (profileId: string, modelId: string) => void;
  replaceMetadataOverrides: (value: Record<string, ModelMetaOverride>) => void;
  resetMetadataOverrides: () => void;
  addCustomModel: (profileId: string, modelId: string, value: CustomModelDefinition) => void;
  updateCustomModel: (profileId: string, previousModelId: string, modelId: string, value: CustomModelDefinition) => void;
  deleteModel: (profileId: string, modelId: string) => void;
  resetProfileModelConfig: (profileId: string) => void;
  replaceModelCustomizations: (value: ModelCustomizationMap) => void;
  resetModelCustomizations: () => void;
}

function isNonChatModel(id: string): boolean {
  const l = id.toLowerCase();
  return l.includes('embed') || l.includes('rerank');
}

function usesFullModelId(profile: Pick<ServerProfile, 'apiVariant' | 'baseUrl'>, model?: { source?: 'lmstudio-rest' | 'gemini-rest' }): boolean {
  return profile.apiVariant === 'lm-studio' || model?.source === 'lmstudio-rest' ||
    (!!profile.baseUrl && isLocalNetworkUrl(profile.baseUrl));
}

/** Deduplicate by profileId:id, sort by profile name → model id. */
function sortAndDedup(entries: AppModelEntry[]): AppModelEntry[] {
  const seen = new Set<string>();
  const out = entries.filter(e => {
    const key = hiddenModelKey(e.profileId, e.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  out.sort((a, b) => {
    if (a.profileName !== b.profileName) return a.profileName.localeCompare(b.profileName);
    return a.id.localeCompare(b.id);
  });
  return out;
}

/** Build live AppModelEntry[] from raw API response. Detected layer only. */
export function buildLiveEntries(
  profile: Pick<ServerProfile, 'id' | 'name' | 'baseUrl' | 'apiVariant' | 'apiStyle'>,
  models: ModelInfo[],
): AppModelEntry[] {
  return models
    .filter(m => !isNonChatModel(m.id))
    .map(m => {
      const caps = m.capabilities ?? {};
      const source = m.source;
      const fullModelId = usesFullModelId(profile, source ? { source } : undefined);
      const loaded = m.loaded_instances ?? [];
      return {
        id: m.id,
        displayName: fullModelId ? m.id : (m.display_name || m.id),
        profileId: profile.id,
        profileName: profile.name,
        apiVariant: profile.apiVariant ?? 'openai',
        apiStyle: profile.apiStyle ?? 'chat',
        state: m.state,
        loadedContextLength: m.loaded_context_length,
        maxContextLength: m.max_context_length,
        loadedInstances: loaded.length > 0 ? loaded : undefined,
        capabilities: {
          vision: caps.vision === true,
          reasoning: caps.reasoning === true || (typeof caps.reasoning === 'object' && caps.reasoning !== null),
          // Match the lenient default from modelEnricher.enrich():
          // tools defaults to true unless explicitly disabled.  LM Studio
          // REST may omit trained_for_tool_use for models that actually
          // support tool calling — absence ≠ incapability.
          tools: caps.trained_for_tool_use === true || caps.tools === true ||
            (caps.trained_for_tool_use !== false && caps.tools !== false),
        },
        type: m.type,
        publisher: m.publisher,
        architecture: m.architecture,
        paramsString: m.params_string,
        format: m.format,
        ...(source ? { modelSource: source } : {}),
      } satisfies AppModelEntry;
    });
}

/**
 * Build detected entries from the persistent base cache.
 *
 * `state` is the caller's call because the same cache read means different
 * things: a cold-start populate shows models as selectable, whereas a cache
 * read taken *because a live probe failed* must mark them unreachable.
 */
export function buildCacheEntries(
  profile: Pick<ServerProfile, 'id' | 'name' | 'baseUrl' | 'apiVariant' | 'apiStyle'>,
  cachedModels: Record<string, CachedModel>,
  state: AppModelEntry['state'],
): AppModelEntry[] {
  return Object.entries(cachedModels)
    .filter(([id]) => !isNonChatModel(id))
    .map(([id, m]) => ({
      id,
      displayName: usesFullModelId(profile, m) ? id : (m.n || id),
      profileId: profile.id,
      profileName: profile.name,
      apiVariant: profile.apiVariant ?? 'openai',
      apiStyle: profile.apiStyle ?? 'chat',
      state,
      maxContextLength: m.c,
      capabilities: { vision: m.v, reasoning: m.r, tools: m.t },
      ...(m.source ? { modelSource: m.source } : {}),
    }));
}

/** The cold-start state for cached entries: local models are "not loaded",
 *  cloud models have no load state at all. Mirrors the pre-registry
 *  `buildFromCache()` so the picker's default "Loaded" chip still shows them. */
function cacheState(profile: Pick<ServerProfile, 'apiVariant'>): AppModelEntry['state'] {
  return profile.apiVariant === 'lm-studio' ? 'not-loaded' : undefined;
}

/** One profile's worth of detected entries, tagged with where they came from. */
interface DetectedGroup {
  profileId: string;
  origin: 'live' | 'cache';
  entries: AppModelEntry[];
}

/** Read the persistent base cache for every known profile — active and not. */
function cacheGroups(): DetectedGroup[] {
  const groups: DetectedGroup[] = [];
  for (const p of useProfileStore.getState().profiles) {
    const cached = modelCache.getCompatible(p);
    if (!cached?.models) continue;
    groups.push({
      profileId: p.id,
      origin: 'cache',
      entries: buildCacheEntries(p, cached.models, cacheState(p)),
    });
  }
  return groups;
}

function manualEntry(profile: ServerProfile, modelId: string, value: CustomModelDefinition): AppModelEntry {
  return {
    id: modelId,
    displayName: value.n,
    profileId: profile.id,
    profileName: profile.name,
    apiVariant: profile.apiVariant ?? 'openai',
    apiStyle: profile.apiStyle ?? 'chat',
    state: profile.apiVariant === 'lm-studio' ? 'not-loaded' : undefined,
    maxContextLength: value.c,
    capabilities: { vision: value.v, reasoning: value.r, tools: value.t },
  };
}

/** Records for one detected group, with the exact-key override applied. */
function recordsFor(
  group: DetectedGroup,
  overrides: ModelMetaOverrideMap,
  customizations: ModelCustomizationMap,
  activeIds: Set<string>,
): ModelRegistryRecord[] {
  const profileActive = activeIds.has(group.profileId);
  const seen = new Set<string>();
  const out: ModelRegistryRecord[] = [];
  const customization = customizations[group.profileId];
  const deleted = new Set(customization?.deleted ?? []);
  const added = customization?.added ?? {};
  for (const detected of group.entries) {
    if (deleted.has(detected.id) || added[detected.id]) continue;
    const key = hiddenModelKey(group.profileId, detected.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const override = overrides[key];
    out.push({
      key,
      profileId: group.profileId,
      modelId: detected.id,
      profileActive,
      origin: group.origin,
      detected,
      ...(override ? { override } : {}),
      effective: applyOverride(detected, override),
    });
  }

  const profile = useProfileStore.getState().profiles.find((p) => p.id === group.profileId);
  if (profile) {
    for (const [modelId, value] of Object.entries(added)) {
      const detected = manualEntry(profile, modelId, value);
      const key = hiddenModelKey(group.profileId, modelId);
      if (seen.has(key)) continue;
      seen.add(key);
      const override = overrides[key];
      out.push({
        key,
        profileId: group.profileId,
        modelId,
        profileActive,
        origin: 'manual',
        detected,
        ...(override ? { override } : {}),
        effective: applyOverride(detected, override),
      });
    }
  }
  return out;
}

/** Derive the active compatibility projection from the record map. */
function projectActiveModels(records: Record<string, ModelRegistryRecord>): AppModelEntry[] {
  const entries: AppModelEntry[] = [];
  for (const r of Object.values(records)) {
    if (r.profileActive) entries.push(r.effective);
  }
  return sortAndDedup(entries);
}

/**
 * The one place detected metadata enters the registry.
 *
 * `scope: 'all'` replaces the whole map (bootstrap / full refresh);
 * `scope: 'profiles'` replaces only the named profiles' records and leaves
 * everything else standing (single-server refresh, Fetch models).
 *
 * Either way the override layer is re-applied and `models` is regenerated in
 * the same `set()`, so no consumer can observe a half-updated registry.
 */
function commitDetected(
  state: State,
  groups: DetectedGroup[],
  scope: 'all' | 'profiles',
): Pick<State, 'records' | 'models'> {
  const effectiveGroups = [...groups];
  if (scope === 'all') {
    const groupedProfiles = new Set(effectiveGroups.map((group) => group.profileId));
    for (const profileId of Object.keys(state.customizations)) {
      if (!groupedProfiles.has(profileId)) {
        effectiveGroups.push({ profileId, origin: 'cache', entries: [] });
      }
    }
  }
  const activeIds = new Set(
    useProfileStore.getState().profiles.filter(p => p.active).map(p => p.id),
  );
  const touched = new Set(effectiveGroups.map(g => g.profileId));
  const records: Record<string, ModelRegistryRecord> = {};

  if (scope === 'profiles') {
    for (const r of Object.values(state.records)) {
      if (touched.has(r.profileId)) continue;
      // Profile activation can change without a re-probe; keep the cached
      // record but refresh its projection membership.
      const profileActive = activeIds.has(r.profileId);
      records[r.key] = profileActive === r.profileActive ? r : { ...r, profileActive };
    }
  }

  for (const group of effectiveGroups) {
    for (const record of recordsFor(group, state.overrides, state.customizations, activeIds)) {
      records[record.key] = record;
    }
  }

  return { records, models: projectActiveModels(records) };
}

/** Server/native entries currently known for one profile, excluding manual
 * entries. This is used to re-project a customization change without a fetch. */
function currentDetectedGroup(state: State, profileId: string): DetectedGroup {
  const records = Object.values(state.records).filter((record) =>
    record.profileId === profileId && record.origin !== 'manual');
  return {
    profileId,
    origin: records.some((record) => record.origin === 'live') ? 'live' : 'cache',
    entries: records.map((record) => record.detected),
  };
}

/** Reconstruct the uncustomized server list from cache plus any newer live
 * records. Cache supplies models currently hidden behind deletion tombstones;
 * live records win for metadata where both layers contain the same ID. */
function defaultDetectedGroup(state: State, profileId: string): DetectedGroup {
  const profile = useProfileStore.getState().profiles.find((item) => item.id === profileId);
  const byId = new Map<string, AppModelEntry>();
  const cached = profile ? modelCache.getCompatible(profile) : null;
  if (profile && cached?.models) {
    for (const entry of buildCacheEntries(profile, cached.models, cacheState(profile))) {
      byId.set(entry.id, entry);
    }
  }
  const current = Object.values(state.records).filter((record) =>
    record.profileId === profileId && record.origin !== 'manual');
  for (const record of current) byId.set(record.modelId, record.detected);
  return {
    profileId,
    origin: current.some((record) => record.origin === 'live') ? 'live' : 'cache',
    entries: [...byId.values()],
  };
}

function withoutProfileOverrides(overrides: ModelMetaOverrideMap, profileId: string): ModelMetaOverrideMap {
  const prefix = hiddenModelKey(profileId, '');
  return Object.fromEntries(Object.entries(overrides).filter(([key]) => !key.startsWith(prefix)));
}

/** Re-apply a new override layer to every existing record. Immutable, and
 *  synchronous — no server refresh is needed to see an override take effect. */
function commitOverrides(state: State, overrides: ModelMetaOverrideMap): Pick<State, 'records' | 'overrides' | 'models'> {
  const records: Record<string, ModelRegistryRecord> = {};
  for (const [key, record] of Object.entries(state.records)) {
    const override = overrides[key];
    const next: ModelRegistryRecord = {
      ...record,
      effective: applyOverride(record.detected, override),
    };
    if (override) next.override = override;
    else delete next.override;
    records[key] = next;
  }
  return { records, overrides, models: projectActiveModels(records) };
}

/* ---- selectors ---------------------------------------------------------- */

/** Effective metadata for an exact profile + model. Never falls back to a
 *  model-ID-only match: duplicate IDs across profiles are different models. */
export function selectEffectiveModel(
  state: Pick<ModelRegistrySnapshot, 'records'>,
  profileId: string | undefined,
  modelId: string | undefined,
): AppModelEntry | undefined {
  if (!profileId || !modelId) return undefined;
  return state.records[hiddenModelKey(profileId, modelId)]?.effective;
}

/** The full registry record (detected + override + effective) for an exact pair. */
export function selectModelRecord(
  state: Pick<ModelRegistrySnapshot, 'records'>,
  profileId: string | undefined,
  modelId: string | undefined,
): ModelRegistryRecord | undefined {
  if (!profileId || !modelId) return undefined;
  return state.records[hiddenModelKey(profileId, modelId)];
}

/** The stored override for an exact pair. Survives its record: an orphaned
 *  key stays applicable if the model comes back. */
export function selectMetadataOverride(
  state: Pick<ModelRegistrySnapshot, 'overrides'>,
  profileId: string | undefined,
  modelId: string | undefined,
): ModelMetaOverride | undefined {
  if (!profileId || !modelId) return undefined;
  return state.overrides[hiddenModelKey(profileId, modelId)];
}

/** Active effective entries — same value as `state.models`. */
export function selectActiveEffectiveModels(state: Pick<ModelRegistrySnapshot, 'models'>): AppModelEntry[] {
  return state.models;
}

/**
 * Which profile owns a BARE (unqualified) model ID — the legacy routing case,
 * for references saved before LC packed `profileId::modelId`.
 *
 * This is a routing question, not a metadata one, and it is inherently
 * ambiguous: the same model ID can exist on several profiles. The answer is
 * therefore made deterministic rather than clever — an entry in the active
 * projection wins (a model LC can reach right now), and otherwise profiles are
 * walked in their stored order, which is the same order the old direct
 * `modelCache.getAll()` scan used. The registry replaces that cache read
 * because its records already cover active and cached-inactive profiles alike.
 *
 * Callers holding a packed reference must resolve the profile from the
 * reference and never come through here.
 */
export function selectModelOwnerProfileId(
  state: Pick<ModelRegistrySnapshot, 'records' | 'models'>,
  modelId: string,
  profiles: ReadonlyArray<Pick<ServerProfile, 'id'>>,
): string | undefined {
  const live = state.models.find((m) => m.id === modelId);
  if (live) return live.profileId;
  for (const p of profiles) {
    if (state.records[hiddenModelKey(p.id, modelId)]) return p.id;
  }
  return undefined;
}

/** Every record the visibility panel should show: active profiles and
 *  cached inactive ones alike, so the panel needs no cache read of its own. */
export function selectVisibilityRecords(state: Pick<ModelRegistrySnapshot, 'records'>): ModelRegistryRecord[] {
  return Object.values(state.records);
}

let refreshQueued = false;
export const useAppModels = create<State>((set, get) => ({
  records: {},
  overrides: loadModelOverrides(),
  customizations: loadModelCustomizations(),
  models: [],
  loading: false,
  error: null,
  _refreshing: false,
  serverHealth: {},

  /** Instant cache → registry. Then background live fetch. */
  async bootstrap() {
    if (get().loading) {
      // A profile edit/toggle can arrive during a live probe. Remember it so
      // the completed probe cannot leave the store on the old profile set.
      refreshQueued = true;
      return;
    }
    set((s) => ({ ...commitDetected(s, cacheGroups(), 'all'), loading: true }));
    await get().refresh();
  },

  /** Parallel live fetch from all relevant profiles. For unreachable
   *  profiles falls back to cached models marked 'unreachable'. */
  async refresh() {
    const { _refreshing } = get();
    if (_refreshing) {
      refreshQueued = true;
      return;
    }
    set({ _refreshing: true, loading: true, error: null });
    try {
      const allProfiles = useProfileStore.getState().profiles;
      const profiles = allProfiles.filter(p => p.active);

      const results = await Promise.allSettled(profiles.map(async (p) => {
        // Resolve API key: prefer keychain, fall back to plaintext.
        const apiKey = await resolveProfileCredential(p);
        const client = new LLMClient({
          baseUrl: p.baseUrl, apiKey,
          modelFetchUrl: p.modelFetchUrl,
          apiVariant: p.apiVariant,
          apiStyle: p.apiStyle ?? 'chat',
          routing: p.routing,
          ...profileRequestHeaderSettings(p),
        });
        const list = await client.listModels();
        return { profile: p, models: list };
      }));

      const liveGroups: DetectedGroup[] = [];
      const health: Record<string, 'reachable' | 'unreachable'> = {};

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const p = profiles[i];
        if (r.status === 'fulfilled') {
          const { profile, models } = r.value;
          health[profile.id] = 'reachable';
          liveGroups.push({
            profileId: profile.id,
            origin: 'live',
            entries: buildLiveEntries(profile, models),
          });
          // Persist enriched data to cache (fire-and-forget). The cache is a
          // DETECTED-layer store: user overrides are never written into it.
          const raw = models.map(m => ({
            id: m.id, display_name: m.display_name,
            max_context_length: m.max_context_length,
            capabilities: m.capabilities,
            source: m.source,
          }));
          modelCache.set(profile.id, raw, profile).catch(() => {});
        } else {
          // Unreachable — pull from cache, mark all models as unreachable.
          health[p.id] = 'unreachable';
          const cached = modelCache.getCompatible(p);
          if (cached?.models) {
            liveGroups.push({
              profileId: p.id,
              origin: 'cache',
              entries: buildCacheEntries(p, cached.models, 'unreachable'),
            });
          }
        }
      }

      // Inactive profiles still belong in the registry (the visibility panel
      // lists them), they just stay out of the active projection. Live groups
      // win over the cache read for the profiles they cover.
      const probed = new Set(liveGroups.map(g => g.profileId));
      const groups = [...cacheGroups().filter(g => !probed.has(g.profileId)), ...liveGroups];

      set((s) => ({
        ...commitDetected(s, groups, 'all'),
        serverHealth: { ...s.serverHealth, ...health },
        loading: false,
        _refreshing: false,
      }));
    } catch (err) {
      set({ error: (err as Error).message, loading: false, _refreshing: false });
    } finally {
      if (refreshQueued) {
        refreshQueued = false;
        await get().bootstrap();
      }
    }
  },

  /** Re-fetch one profile — per-model Refresh button target. */
  async refreshServer(profileId: string) {
    const allProfiles2 = useProfileStore.getState().profiles;
    const profile = allProfiles2.find(p => p.id === profileId);
    if (!profile) return;
    // Only active profiles get their models shown in the store.
    // The `active` toggle is the single gate — no active-profile
    // exemption. Toggling it OFF on any profile hides its models.
    if (!profile.active) return;

    try {
      // Resolve API key: prefer keychain, fall back to plaintext.
      const apiKey = await resolveProfileCredential(profile);
      const client = new LLMClient({
        baseUrl: profile.baseUrl, apiKey,
        modelFetchUrl: profile.modelFetchUrl,
        apiVariant: profile.apiVariant,
        apiStyle: profile.apiStyle ?? 'chat',
        routing: profile.routing,
        ...profileRequestHeaderSettings(profile),
      });
      const list = await client.listModels();

      // Update persistent cache
      const raw = list.map(m => ({
        id: m.id, display_name: m.display_name,
        max_context_length: m.max_context_length,
        capabilities: m.capabilities,
        source: m.source,
      }));
      modelCache.set(profile.id, raw, profile).catch(() => {});

      get().replaceProfileModels(profileId, buildLiveEntries(profile, list), 'reachable');
    } catch {
      // Still unreachable — keep cached entries, don't change state
    }
  },

  /**
   * Commit detected entries for one profile without a network round trip.
   * `SettingsPage::testServer()` used to write `useAppModels.setState({ models })`
   * straight through, which bypassed the override layer and the record map.
   *
   * Health commits in the SAME update when supplied: models and reachability
   * describe one probe, and splitting them across two `set()` calls let a
   * subscriber render the new model list against the previous health for a
   * frame.
   */
  replaceProfileModels(profileId, entries, health) {
    set((s) => ({
      ...commitDetected(s, [{ profileId, origin: 'live', entries }], 'profiles'),
      ...(health ? { serverHealth: { ...s.serverHealth, [profileId]: health } } : {}),
    }));
  },

  setMetadataOverride(profileId, modelId, value) {
    const key = hiddenModelKey(profileId, modelId);
    const clean = sanitizeOverride(value);
    set((s) => {
      const overrides = { ...s.overrides };
      if (clean) overrides[key] = clean;
      else delete overrides[key];
      return commitOverrides(s, overrides);
    });
    saveModelOverrides(get().overrides);
  },

  removeMetadataOverride(profileId, modelId) {
    const key = hiddenModelKey(profileId, modelId);
    set((s) => {
      if (!(key in s.overrides)) return s;
      const overrides = { ...s.overrides };
      delete overrides[key];
      return commitOverrides(s, overrides);
    });
    saveModelOverrides(get().overrides);
  },

  replaceMetadataOverrides(value) {
    set((s) => commitOverrides(s, sanitizeOverrideMap(value)));
    saveModelOverrides(get().overrides);
  },

  resetMetadataOverrides() {
    set((s) => commitOverrides(s, {}));
    clearModelOverrides();
  },

  addCustomModel(profileId, modelId, value) {
    const normalizedId = modelId.trim();
    const clean = sanitizeModelCustomizations({
      [profileId]: { added: { [normalizedId]: value }, deleted: [] },
    })[profileId]?.added[normalizedId];
    if (!clean) return;
    set((s) => {
      const previous = s.customizations[profileId] ?? { added: {}, deleted: [] };
      const customizations: ModelCustomizationMap = {
        ...s.customizations,
        [profileId]: {
          added: { ...previous.added, [normalizedId]: clean },
          deleted: previous.deleted.filter((id) => id !== normalizedId),
        },
      };
      const overrides = { ...s.overrides };
      delete overrides[hiddenModelKey(profileId, normalizedId)];
      const next = { ...s, customizations, overrides };
      return {
        customizations,
        overrides,
        ...commitDetected(next, [currentDetectedGroup(s, profileId)], 'profiles'),
      };
    });
    saveModelCustomizations(get().customizations);
    saveModelOverrides(get().overrides);
  },

  updateCustomModel(profileId, previousModelId, modelId, value) {
    const normalizedId = modelId.trim();
    const clean = sanitizeModelCustomizations({
      [profileId]: { added: { [normalizedId]: value }, deleted: [] },
    })[profileId]?.added[normalizedId];
    if (!clean) return;
    set((s) => {
      const previous = s.customizations[profileId] ?? { added: {}, deleted: [] };
      const added = { ...previous.added };
      delete added[previousModelId];
      added[normalizedId] = clean;
      const customizations: ModelCustomizationMap = {
        ...s.customizations,
        [profileId]: {
          added,
          deleted: previous.deleted.filter((id) => id !== normalizedId),
        },
      };
      const overrides = { ...s.overrides };
      delete overrides[hiddenModelKey(profileId, previousModelId)];
      delete overrides[hiddenModelKey(profileId, normalizedId)];
      const next = { ...s, customizations, overrides };
      return {
        customizations,
        overrides,
        ...commitDetected(next, [currentDetectedGroup(s, profileId)], 'profiles'),
      };
    });
    saveModelCustomizations(get().customizations);
    saveModelOverrides(get().overrides);
  },

  deleteModel(profileId, modelId) {
    set((s) => {
      const previous = s.customizations[profileId] ?? { added: {}, deleted: [] };
      const wasManual = !!previous.added[modelId] ||
        s.records[hiddenModelKey(profileId, modelId)]?.origin === 'manual';
      const added = { ...previous.added };
      delete added[modelId];
      const deleted = wasManual
        ? previous.deleted.filter((id) => id !== modelId)
        : [...new Set([...previous.deleted, modelId])];
      const customizations = { ...s.customizations };
      if (Object.keys(added).length === 0 && deleted.length === 0) delete customizations[profileId];
      else customizations[profileId] = { added, deleted };
      const overrides = { ...s.overrides };
      delete overrides[hiddenModelKey(profileId, modelId)];
      const next = { ...s, customizations, overrides };
      return {
        customizations,
        overrides,
        ...commitDetected(next, [currentDetectedGroup(s, profileId)], 'profiles'),
      };
    });
    saveModelCustomizations(get().customizations);
    saveModelOverrides(get().overrides);
  },

  resetProfileModelConfig(profileId) {
    set((s) => {
      const customizations = { ...s.customizations };
      delete customizations[profileId];
      const overrides = withoutProfileOverrides(s.overrides, profileId);
      const next = { ...s, customizations, overrides };
      return {
        customizations,
        overrides,
        ...commitDetected(next, [defaultDetectedGroup(s, profileId)], 'profiles'),
      };
    });
    saveModelCustomizations(get().customizations);
    saveModelOverrides(get().overrides);
  },

  replaceModelCustomizations(value) {
    const customizations = sanitizeModelCustomizations(value);
    set((s) => {
      const next = { ...s, customizations };
      const groups = useProfileStore.getState().profiles.map((profile) => defaultDetectedGroup(s, profile.id));
      return { customizations, ...commitDetected(next, groups, 'all') };
    });
    saveModelCustomizations(get().customizations);
  },

  resetModelCustomizations() {
    set((s) => {
      const customizations: ModelCustomizationMap = {};
      const next = { ...s, customizations };
      const groups = useProfileStore.getState().profiles.map((profile) => defaultDetectedGroup(s, profile.id));
      return { customizations, ...commitDetected(next, groups, 'all') };
    });
    clearModelCustomizations();
  },
}));
