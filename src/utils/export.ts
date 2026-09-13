/**
 * Settings export/import (pure JSON). The conversation export lives
 * in `./exportArchive` (a .zip with the conversation + attachments).
 * We keep settings separate because:
 *   - it's a small, easy-to-share file (no per-conversation bulk)
 *   - importing portable settings fields replaces them rather than
 *     merging profile names, themes, or other exported preferences
 *   - transient UI state, secrets, caches, and conversation data remain
 *     outside this file by design
 */

import type { Conversation, ServerProfile, ThemeMode } from '../types';
import { validateGeminiBaseUrl } from '../modules/llm-client/adapters/gemini-rest.ts';
import { THEME_FILE_VERSION, type CustomTheme } from '../themes/types.ts';
import { useSettings, type WebSearchProvider } from '../store/settings.ts';
import { useProfileStore, useAppModels, type ModelCustomizationMap } from '../modules/server-profiles/index.ts';
import { lcExportFileName } from './exportNames.ts';
import { saveBlobFile } from './saveBlob.ts';
import { useModelVisibility } from '../store/modelVisibility.ts';
import {
  isHttpUrlCredentialFree,
  isUrlCredentialFree,
  removeHttpUrlCredentials,
  removeUrlCredentials,
} from './url-credentials.ts';

/* ------------------------------------------------------------------ */
/*  Settings export/import (pure JSON)                                 */
/* ------------------------------------------------------------------ */

/** Current JSON envelope version. Import accepts this exact version only. */
export const CONVERSATIONS_EXPORT_VERSION = 1 as const;

/** Wire format for the legacy portable JSON conversation envelope. ZIP
 * archives use their own validated, attachment-aware restore boundary. */
export interface ConversationsExport {
  format: 'llm-client:conversations';
  version: typeof CONVERSATIONS_EXPORT_VERSION;
  exportedAt: number;
  conversations: Conversation[];
}

/** Current portable settings version. Import accepts this exact version only. */
export const SETTINGS_EXPORT_VERSION = 1 as const;

type PortableServerProfile = Omit<ServerProfile, 'apiKey'>;

function buildPortableServerProfile(profile: ServerProfile): PortableServerProfile {
  const portable = { ...profile };
  delete portable.apiKey;
  delete portable.lcIdentifierHeader;
  delete portable.requestHeaders;
  portable.baseUrl = removeUrlCredentials(portable.baseUrl);
  if (portable.modelFetchUrl) {
    portable.modelFetchUrl = removeUrlCredentials(portable.modelFetchUrl, portable.baseUrl);
  }
  // Header values can be credentials. Do not leave an enabled toggle whose
  // values were intentionally removed from the portable snapshot.
  portable.includeAdditionalRequestHeaders = false;
  return portable;
}

/** Wire format for the portable "export settings" file. It contains
 *  the durable settings fields intended to move between installations;
 *  transient UI state, secrets, caches, and conversations are excluded. */
export interface SettingsExport {
  format: 'llm-client:settings';
  version: typeof SETTINGS_EXPORT_VERSION;
  exportedAt: number;
  settings: {
    profiles: PortableServerProfile[];
    theme: ThemeMode;
    assistantName: string;
    zoom: number;
    autoArchiveDays: number;
    /** Optional so earlier v1 exports remain importable; missing means 2. */
    maxConcurrentGenerations?: 1 | 2 | 3;
    previewOverlayHeight: number;
    /** v2 field. Legacy v1 exports carried `solidTheme` instead; the
     *  import path maps it so old files keep importing. */
    materialMode: 'auto' | 'glass' | 'solid';
    /** Legacy v1 field, accepted on import only. */
    solidTheme?: 'auto' | 'on' | 'off';
    pinComposer: boolean;
    tokenMeterStyle: 'donut' | 'cake';
    autoPreviewReasoning: boolean;
    /** Optional so earlier v1 exports retain the default (latest only). */
    showOnlyLatestTodoList?: boolean;
    customThemes: CustomTheme[];
    activeCustomThemeId: string | null;
    themeFilter: 'all' | 'light' | 'dark';
    // Three places must agree for a tool field to survive export/import:
    // this type, the writer in exportSettings(), and the validator in
    // isSettingsExport(). Miss one and the field is silently dropped.
    tools: {
      shell_allowlist: string;
      default_allowed_roots: string[];
      web_fetch_rate_per_min: number;
      brave_search_api_key: string;
      brave_search_api_key_ref: string;
      searxng_base_url: string;
      marginalia_api_key: string;
      marginalia_api_key_ref: string;
      web_search_provider: WebSearchProvider;
      vision_model: string;
      web_research_model: string;
      pdf_summarize_model?: string;
    };
    /** Hidden model keys ("profileId:modelId") from the model visibility filter. */
    hiddenModels: string[];
    /**
     * Per-model metadata overrides, keyed by "profileId:modelId".
     *
     * Optional on the wire even though the writer always emits it: version-1
     * exports predate this field and must stay importable. A missing field
     * imports as `{}` — settings import has replace semantics, so an old file
     * clears the current overrides rather than half-merging into them.
     */
    modelOverrides?: Record<string, {
      n?: string;
      c?: number;
      v?: boolean;
      r?: boolean;
      t?: boolean;
    }>;
    /** Manual models and deleted-server-model tombstones per profile. */
    modelCustomizations?: ModelCustomizationMap;
  };
}

/** Build the portable settings snapshot. Separated from the file-save step
 *  so the wire shape can be asserted without a browser download path. */
export function buildSettingsExport(): SettingsExport {
  const s = useSettings.getState();
  const ps = useProfileStore.getState();
  return {
    format: 'llm-client:settings',
    version: SETTINGS_EXPORT_VERSION,
    exportedAt: Date.now(),
    settings: {
      profiles: ps.profiles.map(buildPortableServerProfile),
      theme: s.theme,
      assistantName: s.assistantName,
      zoom: s.zoom,
      autoArchiveDays: s.autoArchiveDays,
      maxConcurrentGenerations: s.maxConcurrentGenerations,
      previewOverlayHeight: s.previewOverlayHeight,
      materialMode: s.materialMode,
      pinComposer: s.pinComposer,
      tokenMeterStyle: s.tokenMeterStyle,
      autoPreviewReasoning: s.autoPreviewReasoning,
      showOnlyLatestTodoList: s.showOnlyLatestTodoList,
      customThemes: s.customThemes,
      activeCustomThemeId: s.activeCustomThemeId,
      themeFilter: s.themeFilter,
      tools: {
        shell_allowlist: s.tools.shell_allowlist,
        default_allowed_roots: s.tools.default_allowed_roots,
        web_fetch_rate_per_min: s.tools.web_fetch_rate_per_min,
        brave_search_api_key: '', // encrypted in the local key store, not exported
        brave_search_api_key_ref: s.tools.brave_search_api_key_ref ?? '',
        searxng_base_url: removeHttpUrlCredentials(s.tools.searxng_base_url),
        marginalia_api_key: '', // encrypted in the local key store, not exported
        marginalia_api_key_ref: s.tools.marginalia_api_key_ref ?? '',
        web_search_provider: s.tools.web_search_provider,
        vision_model: s.tools.vision_model,
        web_research_model: s.tools.web_research_model,
        pdf_summarize_model: s.tools.pdf_summarize_model,
      },
      hiddenModels: [...useModelVisibility.getState().hidden],
      // Deep-copied per entry, not just the outer record: a shallow copy
      // would hand the live store objects to JSON.stringify and leave the
      // export aliasing state that can still change under it.
      modelOverrides: Object.fromEntries(
        Object.entries(useAppModels.getState().overrides).map(([key, value]) => [key, { ...value }]),
      ),
      modelCustomizations: Object.fromEntries(
        Object.entries(useAppModels.getState().customizations).map(([profileId, value]) => [profileId, {
          added: Object.fromEntries(Object.entries(value.added).map(([modelId, model]) => [modelId, { ...model }])),
          deleted: [...value.deleted],
        }]),
      ),
    },
  };
}

export async function exportSettings(): Promise<boolean> {
  const payload = buildSettingsExport();
  return saveBlobFile(
    lcExportFileName(`settings-v${payload.version}`, 'json'),
    JSON.stringify(payload, null, 2),
    [{ name: 'JSON', extensions: ['json'] }],
  );
}

/** Settings exports are a small portable document; refuse anything larger
 *  before touching the bytes. */
const MAX_SETTINGS_EXPORT_BYTES = 5 * 1024 * 1024;

export async function readSettingsFile(file: File): Promise<SettingsExport> {
  if (file.size > MAX_SETTINGS_EXPORT_BYTES) {
    throw new Error('This file is too large to be a settings export.');
  }
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  if (!isSettingsExport(parsed)) {
    throw new Error('This file is not a settings export from LLM Client.');
  }
  return parsed;
}

function isSettingsExport(x: unknown): x is SettingsExport {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (o.format !== 'llm-client:settings') return false;
  if (o.version !== SETTINGS_EXPORT_VERSION) return false;
  const s = o.settings;
  if (!isRecord(s)) return false;

  const tools = s.tools;
  return (
    Array.isArray(s.profiles) && s.profiles.every(isServerProfileExport) &&
      new Set(s.profiles.map((profile) => profile.id)).size === s.profiles.length &&
    isThemeMode(s.theme) &&
    typeof s.assistantName === 'string' &&
    isFiniteNumber(s.zoom) &&
    isFiniteNumber(s.autoArchiveDays) &&
    (s.maxConcurrentGenerations === undefined
      || s.maxConcurrentGenerations === 1
      || s.maxConcurrentGenerations === 2
      || s.maxConcurrentGenerations === 3) &&
    isFiniteNumber(s.previewOverlayHeight) &&
    (isOneOf(s.materialMode, ['auto', 'glass', 'solid'])
      || isOneOf(s.solidTheme, ['auto', 'on', 'off'])) &&
    typeof s.pinComposer === 'boolean' &&
    isOneOf(s.tokenMeterStyle, ['donut', 'cake']) &&
    typeof s.autoPreviewReasoning === 'boolean' &&
    (s.showOnlyLatestTodoList === undefined || typeof s.showOnlyLatestTodoList === 'boolean') &&
    Array.isArray(s.customThemes) && s.customThemes.every(isCustomThemeExport) &&
    (s.activeCustomThemeId === null || typeof s.activeCustomThemeId === 'string') &&
    isOneOf(s.themeFilter, ['all', 'light', 'dark']) &&
    isRecord(tools) &&
    typeof tools.shell_allowlist === 'string' &&
    Array.isArray(tools.default_allowed_roots) &&
      tools.default_allowed_roots.every((root) => typeof root === 'string') &&
    isFiniteNumber(tools.web_fetch_rate_per_min) &&
    typeof tools.brave_search_api_key === 'string' &&
    typeof tools.brave_search_api_key_ref === 'string' &&
    (tools.brave_search_api_key_ref === '' || tools.brave_search_api_key_ref === 'brave-search-key') &&
    typeof tools.searxng_base_url === 'string' &&
      isHttpUrlCredentialFree(tools.searxng_base_url) &&
    typeof tools.marginalia_api_key === 'string' &&
    typeof tools.marginalia_api_key_ref === 'string' &&
    (tools.marginalia_api_key_ref === '' || tools.marginalia_api_key_ref === 'marginalia-search-key') &&
    isOneOf(tools.web_search_provider, ['auto', 'brave', 'searxng', 'marginalia']) &&
    typeof tools.vision_model === 'string' &&
    typeof tools.web_research_model === 'string' &&
    // Optional: bundles exported before this picker existed stay importable,
    // and the store default supplies '' for them.
    (tools.pdf_summarize_model === undefined || typeof tools.pdf_summarize_model === 'string') &&
    Array.isArray(s.hiddenModels) &&
      s.hiddenModels.every((key) => typeof key === 'string') &&
    isModelOverridesExport(s.modelOverrides) &&
    isModelCustomizationsExport(s.modelCustomizations)
  );
}

/** Absent is valid (old exports). Present must be a plain record of plain
 *  records, with a positive safe-integer `c` and boolean `v`/`r`/`t`. */
function isModelOverridesExport(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  for (const entry of Object.values(value)) {
    if (!isRecord(entry)) return false;
    if (entry.n !== undefined && !(typeof entry.n === 'string' && !!entry.n.trim())) return false;
    if (entry.c !== undefined && !(typeof entry.c === 'number' && Number.isSafeInteger(entry.c) && entry.c > 0)) {
      return false;
    }
    for (const field of ['v', 'r', 't'] as const) {
      if (entry[field] !== undefined && typeof entry[field] !== 'boolean') return false;
    }
  }
  return true;
}

function isModelCustomizationsExport(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  for (const profile of Object.values(value)) {
    if (!isRecord(profile) || !isRecord(profile.added) || !Array.isArray(profile.deleted)) return false;
    if (!profile.deleted.every((id) => typeof id === 'string' && !!id.trim())) return false;
    for (const [modelId, model] of Object.entries(profile.added)) {
      if (!modelId.trim() || !isRecord(model) || typeof model.n !== 'string' || !model.n.trim()) return false;
      if (model.c !== undefined && !(typeof model.c === 'number' && Number.isSafeInteger(model.c) && model.c > 0)) return false;
      for (const field of ['v', 'r', 't'] as const) {
        if (model[field] !== undefined && typeof model[field] !== 'boolean') return false;
      }
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === 'string' && allowed.includes(value);
}

function isThemeMode(value: unknown): value is ThemeMode {
  return isOneOf(value, ['light', 'dark', 'system']);
}

function isServerProfileExport(value: unknown): value is PortableServerProfile {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.id) ||
    typeof value.name !== 'string' ||
    typeof value.baseUrl !== 'string' ||
    (value.modelFetchUrl !== undefined && typeof value.modelFetchUrl !== 'string') ||
    'apiKey' in value ||
    (value.apiKeyRef !== undefined && (
      typeof value.apiKeyRef !== 'string' ||
      (value.apiKeyRef !== '' && value.apiKeyRef !== `profile.${value.id}`)
    )) ||
    (value.note !== undefined && typeof value.note !== 'string') ||
    (value.sse_read_timeout_min !== undefined && !isFiniteNumber(value.sse_read_timeout_min)) ||
    (value.apiVariant !== undefined && !isOneOf(value.apiVariant, ['lm-studio', 'openai', 'anthropic', 'gemini'])) ||
    (value.apiStyle !== undefined && !isOneOf(value.apiStyle, ['chat', 'responses'])) ||
    (value.routing !== undefined && !isOneOf(value.routing, ['proxy', 'direct'])) ||
    (value.includeLcIdentifierHeader !== undefined && typeof value.includeLcIdentifierHeader !== 'boolean') ||
    (value.lcIdentifierHeader !== undefined && (
      !isRecord(value.lcIdentifierHeader) ||
      typeof value.lcIdentifierHeader.name !== 'string' ||
      typeof value.lcIdentifierHeader.value !== 'string'
    )) ||
    (value.includeAdditionalRequestHeaders !== undefined && typeof value.includeAdditionalRequestHeaders !== 'boolean') ||
    (value.requestHeaders !== undefined && (
      !Array.isArray(value.requestHeaders) ||
      !value.requestHeaders.every((header) => (
        isRecord(header) &&
        typeof header.name === 'string' &&
        typeof header.value === 'string'
      ))
    )) ||
    (value.active !== undefined && typeof value.active !== 'boolean')
  ) return false;

  try {
    new URL(value.baseUrl);
  } catch {
    return false;
  }
  if (!isUrlCredentialFree(value.baseUrl)) return false;
  if (
    typeof value.modelFetchUrl === 'string'
    && !isUrlCredentialFree(value.modelFetchUrl, value.baseUrl)
  ) return false;
  if (value.apiVariant === 'lm-studio' && !/\/api\/v\d+\/?$/i.test(value.baseUrl)) {
    return false;
  }
  if (value.apiVariant === 'gemini') {
    try { validateGeminiBaseUrl(value.baseUrl); } catch { return false; }
  }
  return true;
}

function isCustomThemeExport(value: unknown): value is CustomTheme {
  if (!isRecord(value) || !isRecord(value.source)) return false;
  const source = value.source;
  return (
    typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.name === 'string' &&
    isFiniteNumber(value.importedAt) &&
    typeof source.name === 'string' &&
    source.version === THEME_FILE_VERSION &&
    isOneOf(source.mode, ['spine', 'full']) &&
    (source.base === undefined || isOneOf(source.base, ['light', 'dark'])) &&
    (source.codeTheme === undefined || typeof source.codeTheme === 'string') &&
    (source.spine === undefined || isRecord(source.spine)) &&
    (source.glass === undefined || isRecord(source.glass)) &&
    (source.solid === undefined || isRecord(source.solid))
  );
}
