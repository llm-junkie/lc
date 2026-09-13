import { useRef, useState, useEffect, useMemo, type ReactNode } from 'react';
import { useSettings, DEFAULT_BASE_URL, getDefaultShellAllowlist } from '../../store/settings.ts';
import {
  ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE,
  isAnyStreaming,
  isGenerationBlockingOperationActive,
  useConversations,
} from '../../store/conversations.ts';
import { useConversationUi } from '../../store/conversation-ui.ts';
import { loadMessages } from '../../store/db.ts';
import { listWhiteboardVersions } from '../../store/whiteboard.ts';
import { AllowedRootsEditor } from './AllowedRootsEditor.tsx';
import {
  LC_IDENTIFIER_HEADER_NAME,
  LC_IDENTIFIER_HEADER_VALUE,
  LLMClient,
  errorMessage,
  getDefaultModelFetchUrl,
  profileRequestHeaderSettings,
} from '../../modules/llm-client/index.ts';
import {
  useProfileStore,
  profileManager,
  modelCache,
  useAppModels,
  buildLiveEntries,
  selectVisibilityRecords,
} from '../../modules/server-profiles/index.ts';
import { cn } from '../../utils/cn.ts';
import { endpointForProfile, endpointLetter, endpointTone } from '../../utils/reply-meta.ts';
import { toast } from '../../utils/toast.ts';
import { getStorageUsage, type StorageUsage } from '../../utils/storage.ts';
import type { ServerProfile, Conversation } from '../../types';
import {
  exportSettings,
  readSettingsFile,
} from '../../utils/export.ts';
import { exportAllArchives } from '../../utils/exportArchive.ts';
import {
  importConversationArchiveFile,
  importSettings,
  resetSettings,
} from '../../utils/import.ts';
import { crossServerModels, type CrossServerModelEntry } from '../../modules/server-profiles/index.ts';
import { SubAgentModelPicker } from './SubAgentModelPicker.tsx';
import { resolveSubAgentSelections } from './sub-agent-model-invalidation.ts';
import { keychainSet, keychainDelete, keychainGet } from '../../platform/keychain.ts';
import { resolveProfileCredential } from '../../platform/chat-credential.ts';
import { runLocalStorageMutation } from '../../store/local-storage.ts';
import {
  getBraveSearchKey,
  getMarginaliaKey,
  setSearchKey,
  type KeyedSearchProvider,
} from '../../platform/search-key-cache.ts';
import { KeychainKeyRow, type KeyCommitResult } from './KeychainKeyRow.tsx';
import { createTauriBridge } from '../../modules/tool-engine/sandbox-bridge.ts';
import { isTauri } from '../../utils/saveBlob.ts';
import { WEB_SEARCH_PRIORITY } from '../../store/settings.ts';
import { configuredProviders, isConfigured } from '../../modules/tool-engine/search-provider.ts';
import { safeConfirm } from '../../utils/safeConfirm.ts';
import { useModelVisibility } from '../../store/modelVisibility.ts';
import { ModelVisibilityPanel } from './ModelVisibilityPanel.tsx';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';
import { LC_GITHUB_URL, openSupportLink } from './support-links.ts';
import { hasUrlCredentials } from '../../utils/url-credentials.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenAbout: () => void;
  /** Opens the support report modal. Owned by App so the Shift+F1
   *  shortcut and the F1 sheet's help button can reach it. */
  onOpenSupportReport: () => void;
  /** True when a sub-overlay (About, Keyboard Shortcuts, Support report)
   *  is open — Escape should close that sub-overlay first, not Settings. */
  hasSubOverlay?: boolean;
}

/** Discrete zoom levels exposed in the settings panel. Chips are simpler
 *  than a slider — the user picks an exact level, no off-by-one drift,
 *  and the 5 values cover the common use cases (compact to large UI). */
const ZOOM_LEVELS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5] as const;
const ZOOM_LABELS: Record<number, string> = {
  0.8: '80%',
  0.9: '90%',
  1.0: '100%',
  1.1: '110%',
  1.25: '125%',
  1.5: '150%',
};

/** Stand-in value for a key that lives in the encrypted local key store and
 *  has not been fetched. A blurred key field renders `type="password"`, so
 *  the real value is masked by the browser. A key-store-backed key has no
 *  value in the DOM, and an empty field would read as "no key set". This
 *  fixed-width filler keeps the field looking populated without ever
 *  putting the secret in the DOM. Its length is deliberately uniform so it
 *  leaks nothing about the real key. */
const KEY_MASK = '••••••••••••••••••••••••••••••••••••••••••••••••';

/** Shared stroke geometry for the inline button icons below. `.ghost-btn`
 *  is already `inline-flex` with `gap: 6px`, so an icon dropped in front of
 *  the label lays itself out — no extra wrapper or CSS needed. 14px matches
 *  the other icons paired with `.small` (12px) button text. */
const ICON_STROKE = {
  viewBox: '0 0 24 24',
  width: 14,
  height: 14,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** Arrow down into a tray — same icon the per-chat Export button in the
 *  conversation list uses, so both export affordances read as the same action. */
function ExportIcon() {
  return (
    <svg {...ICON_STROKE}>
      <path d="M12 4v10" />
      <path d="M7 9l5 5 5-5" />
      <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
    </svg>
  );
}

/** Export mirrored: arrow up out of the tray. Pairing the two as
 *  reflections makes the direction of each action legible at a glance. */
function ImportIcon() {
  return (
    <svg {...ICON_STROKE}>
      <path d="M12 14V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
    </svg>
  );
}

/** The GitHub Octicons mark. Fill-based rather than stroke, so it does not
 *  share ICON_STROKE — it is a logo, not part of the line-icon set. */
function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

/** Collapsible settings section. Chevron rotates 90° when collapsed. */
function Section({ title, children, collapsed, onToggle, extra, disabled }: {
  title: string;
  children: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  extra?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <section>
      <div className="section-head">
        <button type="button" className="side-collapse-btn" onClick={onToggle}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden
            style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
            <path d="M4.5 6L8 9.5 11.5 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <h3>{title}</h3>
        </button>
        {extra}
      </div>
      {!collapsed && (
        <div
          className={cn('settings-section-content', disabled && 'is-locked')}
          inert={disabled || undefined}
          aria-disabled={disabled || undefined}
          title={disabled ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE : undefined}
        >
          {children}
        </div>
      )}
    </section>
  );
}

export function SettingsPage({ open, onClose, onOpenAbout, onOpenSupportReport, hasSubOverlay }: Props) {
  const profiles = useProfileStore((s) => s.profiles);
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const materialMode = useSettings((s) => s.materialMode);
  const setMaterialMode = useSettings((s) => s.setMaterialMode);
  const assistantName = useSettings((s) => s.assistantName);
  const setAssistantName = useSettings((s) => s.setAssistantName);
  const zoom = useSettings((s) => s.zoom);
  const setZoom = useSettings((s) => s.setZoom);
  const pinComposer = useSettings((s) => s.pinComposer);
  const setPinComposer = useSettings((s) => s.setPinComposer);
  const tokenMeterStyle = useSettings((s) => s.tokenMeterStyle);
  const setTokenMeterStyle = useSettings((s) => s.setTokenMeterStyle);
  const autoPreviewReasoning = useSettings((s) => s.autoPreviewReasoning);
  const setAutoPreviewReasoning = useSettings((s) => s.setAutoPreviewReasoning);
  const showOnlyLatestTodoList = useSettings((s) => s.showOnlyLatestTodoList);
  const setShowOnlyLatestTodoList = useSettings((s) => s.setShowOnlyLatestTodoList);
  const autoArchiveDays = useSettings((s) => s.autoArchiveDays);
  const setAutoArchiveDays = useSettings((s) => s.setAutoArchiveDays);
  const maxConcurrentGenerations = useSettings((s) => s.maxConcurrentGenerations);
  const setMaxConcurrentGenerations = useSettings((s) => s.setMaxConcurrentGenerations);
  const tools = useSettings((s) => s.tools);
  const setTools = useSettings((s) => s.setTools);
  const activeCustomThemeId = useSettings((s) => s.activeCustomThemeId);
  const setCustomThemeOpen = useSettings((s) => s.setCustomThemeOpen);
  const setActiveCustomTheme = useSettings((s) => s.setActiveCustomTheme);
  const [rootsEditorOpen, setRootsEditorOpen] = useState(false);
  // Guards the SearXNG probe so a slow instance cannot be queued up twice.
  const [searxngTesting, setSearxngTesting] = useState(false);
  const clearAll = useConversations((s) => s.clearAll);
  const profileMutationsBlocked = useConversations(
    () => isAnyStreaming() || isGenerationBlockingOperationActive(),
  );

  // What `auto` would resolve to — the first configured provider by priority.
  // Shown on the `auto` chip so the default selection is not opaque about
  // which index it queries. Deliberately independent of the current
  // selection: while another provider is pinned, this must still describe
  // what choosing `auto` would do, not echo the pin back.
  const autoProvider = configuredProviders(tools)[0];

  // Storage usage — recalculated when the panel opens, after a
  // wipe, after import, and after any profile change. Uses
  // navigator.storage.estimate() which covers IndexedDB (Dexie)
  // + localStorage, not just the old 10 MB localStorage cap.
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  const [storageVersion, setStorageVersion] = useState(0);
  const refreshStorage = () => setStorageVersion((v) => v + 1);
  useEffect(() => {
    if (!open) return;
    getStorageUsage().then(setStorageUsage).catch(() => {});
  }, [open, storageVersion]);
  const storageSummary = !storageUsage || storageUsage.totalBytes === 0
    ? null
    : storageUsage.percentUsed >= 80
      ? `${storageUsage.totalFormatted} / ${storageUsage.quotaFormatted} (${storageUsage.percentUsed}%)`
      : `${storageUsage.totalFormatted} / ${storageUsage.quotaFormatted}`;

  // Cross-server model list for the sub-agent model pickers (§2.2).
  //
  // Derived, not snapshotted. This used to be `useState` filled by
  // `crossServerModels()` on open / profile change / explicit Reload, which
  // meant a metadata override edited in the visibility panel — the exact
  // thing that decides whether a model is a vision candidate — did not reach
  // this list until the user pressed Reload. Subscribing to the registry's
  // active effective projection, the profile list, and the hidden set covers
  // every input the list actually depends on.
  const effectiveModels = useAppModels((s) => s.models);
  const modelsLoading = useAppModels((s) => s.loading);
  const hiddenModels = useModelVisibility((s) => s.hidden);
  const subAgentModels = useMemo<CrossServerModelEntry[]>(
    () => crossServerModels(profiles),
    // `crossServerModels` reads the registry and the hidden set through
    // `getState()`; these three are the reactive triggers for that read.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [profiles, effectiveModels, hiddenModels],
  );
  const subAgentModelsLoading = modelsLoading && subAgentModels.length === 0;
  const visionCandidates = useMemo(
    () => subAgentModels.filter((m) => m.capabilities.vision === true),
    [subAgentModels],
  );

  // Hidden file input used by both "Import" and "Import settings" — we
  // share one element and let the click handlers differentiate via
  // the kind ref. The conversation import auto-detects single-chat
  // vs bulk archive based on the zip's internal structure, so we
  // only have one button for it.
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const importKindRef = useRef<'conversations' | 'settings'>('conversations');

  const [editing, setEditing] = useState<ServerProfile | null>(null);
  const serverEditorOpen = editing !== null;
  const [isNew, setIsNew] = useState(false);
  // Focus drives reveal for the server API-key field: blurred is masked,
  // focused shows the real key in the clear and editable. See KEY_MASK. The
  // search-provider key rows use KeychainKeyRow, which owns the same
  // behaviour internally.
  const [apiKeyFocused, setApiKeyFocused] = useState(false);
  const [keychainFetched, setKeychainFetched] = useState<string | null>(null);

  // Model visibility management panel state.
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const [btnHiddenCount, setBtnHiddenCount] = useState(() => {
    try {
      const raw = localStorage.getItem('lc_filter_counts');
      if (raw) { const v = JSON.parse(raw); return (v.h as number) ?? 0; }
      } catch { /* localStorage may be unavailable. */ }
    return 0;
  });
  const [btnTotalCount, setBtnTotalCount] = useState(() => {
    try {
      const raw = localStorage.getItem('lc_filter_counts');
      if (raw) { const v = JSON.parse(raw); return (v.t as number) ?? 0; }
      } catch { /* localStorage may be unavailable. */ }
    return 0;
  });

  // A profile and the execution-related settings are part of every active
  // generation and any later tool/sub-agent round. Dismiss mutable overlays if
  // generation ownership begins while Settings is still open.
  useEffect(() => {
    if (!profileMutationsBlocked) return;
    setEditing(null);
    setIsNew(false);
    setApiKeyFocused(false);
    setKeychainFetched(null);
    setRootsEditorOpen(false);
    setVisibilityOpen(false);
  }, [profileMutationsBlocked]);

  function saveFilterCounts(hidden: number, total: number) {
    setBtnHiddenCount(hidden);
    setBtnTotalCount(total);
    runLocalStorageMutation(() => {
      localStorage.setItem('lc_filter_counts', JSON.stringify({ h: hidden, t: total }));
    });
  }

  // Sort state for the server profile list — sorted by name A-Z by default.
  const [sortBy, setSortBy] = useState<'name' | 'url' | 'api' | 'note'>('name');
  const [sortAsc, setSortAsc] = useState(true);

  const sortedProfiles = useMemo(() => {
    if (!sortBy) return profiles;
    const sorted = [...profiles].sort((a, b) => {
      let va: string, vb: string;
      switch (sortBy) {
        case 'name': va = a.name; vb = b.name; break;
        case 'url':  va = a.baseUrl; vb = b.baseUrl; break;
        case 'api':  va = a.apiVariant ?? ''; vb = b.apiVariant ?? ''; break;
        case 'note': va = a.note ?? ''; vb = b.note ?? ''; break;
        default: return 0;
      }
      return va.localeCompare(vb, undefined, { sensitivity: 'base' });
    });
    return sortAsc ? sorted : sorted.reverse();
  }, [profiles, sortBy, sortAsc]);
  // Sections collapsed by default (server and appearance stay expanded).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    chat: true,
    model_tools: true,
    backup_reset: true,
    data_support: true,
  });
  const toggleSection = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));
  // Reset collapse state + close edit form every time the panel opens.
  // When `openAgenticTools` is set (from the Workspace panel's
  // "Open Settings > AGENTIC TOOLS" button), auto-expand the
  // Agentic tools section and collapse everything else.
  useEffect(() => {
    if (open) {
      const agenticTools = useSettings.getState().ui.openAgenticTools;
      if (agenticTools) {
        useSettings.setState((s) => ({ ui: { ...s.ui, openAgenticTools: false } }));
        setCollapsed({
          server_profiles: true,
          appearance: true,
          chat: true,
          model_tools: false,
          backup_reset: true,
          data_support: true,
        });
      } else {
        setCollapsed({ chat: true, model_tools: true, backup_reset: true, data_support: true });
      }
      setEditing(null);
      setIsNew(false);
      setApiKeyFocused(false);
      // The provider key rows reset themselves: KeychainKeyRow is unmounted
      // with its Section while collapsed, so a stale draft cannot survive a
      // close/reopen the way the inline Brave field's state used to.
      //
      // The sub-agent model list needs no priming here: it is derived from
      // the registry above and is already correct before this panel opens.
    }
  }, [open]);

  // Escape closes the innermost settings surface. Child overlays that are
  // real components (visibility panel, roots editor, About, the F1 sheet) sit
  // above this one on the overlay stack and own the key themselves, so this
  // only runs when Settings is genuinely on top.
  //
  // The `serverEditorOpen` branch stays: that editor is inline state rather
  // than a separate component, so it has no stack entry of its own and must
  // be unwound here before Settings itself closes.
  //
  // The old `!visibilityOpen && !rootsEditorOpen && !hasSubOverlay` guard is
  // kept as a belt-and-braces check. The stack already covers all three, but
  // they are cheap, and they keep the behaviour correct for any sub-overlay
  // that has not adopted the hook.
  useOverlayEscape(() => {
    if (visibilityOpen || rootsEditorOpen || hasSubOverlay) return;
    if (serverEditorOpen) {
      setEditing(null);
      setIsNew(false);
      setApiKeyFocused(false);
      setKeychainFetched(null);
    } else {
      onClose();
    }
  }, open);

  // When settings closes, also close the visibility panel.
  // Skip initial mount (open starts as false).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open) { wasOpenRef.current = true; return; }
    if (!wasOpenRef.current) return; // skip initial mount
    setVisibilityOpen(false);
    const vis = useModelVisibility.getState();
    // The registry already covers active and cached-inactive profiles alike,
    // so the Manage models button's counts come from the same records the visibility
    // panel shows — no second `modelCache.getAll()` read to drift from it.
    const records = selectVisibilityRecords(useAppModels.getState());
    // Count hidden models among known models only — avoids
    // inflating the count with stale entries from deleted profiles.
    let hidden = 0;
    for (const r of records) {
      if (vis.hidden.has(r.key)) hidden++;
    }
    saveFilterCounts(hidden, records.length);
  }, [open]);

  // Invalidate a sub-agent model selection that can no longer be honoured.
  //
  // Runs on every input the candidate list depends on, not just the profile
  // list: an override that turns vision off, or hiding the model, has to
  // release the selection the same way deactivating its profile does —
  // otherwise LC keeps routing image analysis at a model it now knows can't
  // do it. Packed `profileId::modelId` identity throughout; a bare model ID
  // is a legacy value that means "same as chat model" and is left alone.
  useEffect(() => {
    if (!open) return;
    const currentProfiles = useProfileStore.getState().profiles;
    const currentTools = useSettings.getState().tools;
    const next = resolveSubAgentSelections({
      visionModel: currentTools.vision_model,
      webResearchModel: currentTools.web_research_model,
      pdfSummarizeModel: currentTools.pdf_summarize_model,
      activeProfileIds: new Set(currentProfiles.filter((p) => p.active).map((p) => p.id)),
      knownProfileIds: new Set(effectiveModels.map((m) => m.profileId)),
      visionCandidateKeys: new Set(visionCandidates.map((m) => `${m.profileId}::${m.modelId}`)),
      modelsLoading,
    });
    if (next.changed) {
      useSettings.getState().setTools({
        ...currentTools,
        vision_model: next.visionModel,
        web_research_model: next.webResearchModel,
        pdf_summarize_model: next.pdfSummarizeModel,
      });
    }
  }, [profiles, open, effectiveModels, visionCandidates, modelsLoading]);

  // Refresh storage meter when profiles change (add/edit/remove).
  useEffect(() => {
    if (!open) return;
    getStorageUsage().then(setStorageUsage).catch(() => {});
  }, [profiles, open]);

  if (!open) return null;

  const rejectExecutionConfigMutationWhileStreaming = (): boolean => {
    if (!isAnyStreaming() && !isGenerationBlockingOperationActive()) return false;
    toast.info(ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE);
    return true;
  };

  /** Per-provider settings field names and keychain ref. Kept together so a
   *  new keyed provider is one entry rather than a scattered edit. */
  const SEARCH_KEY_FIELDS = {
    brave: {
      key: 'brave_search_api_key',
      ref: 'brave_search_api_key_ref',
      keychainRef: 'brave-search-key',
    },
    marginalia: {
      key: 'marginalia_api_key',
      ref: 'marginalia_api_key_ref',
      keychainRef: 'marginalia-search-key',
    },
  } as const satisfies Record<KeyedSearchProvider, { key: string; ref: string; keychainRef: string }>;

  /**
   * Commit a search-provider key to the encrypted local key store.
   *
   * Returns what happened so the caller can pick a message:
   *   'saved'    — written to the keychain
   *   'cleared'  — the field was emptied, the stored key removed
   *   'fallback' — the keychain write failed, key kept in settings instead
   */
  const commitSearchKey = async (
    provider: KeyedSearchProvider,
    value: string,
  ): Promise<KeyCommitResult> => {
    const f = SEARCH_KEY_FIELDS[provider];
    const current = useSettings.getState().tools;
    if (value) {
      const ok = await keychainSet(f.keychainRef, value).then(() => true, () => false);
      // Live value for this session lives in memory; the store keeps it
      // only when the keychain write failed.
      setSearchKey(provider, ok ? value : null);
      setTools({
        ...current,
        [f.key]: ok ? '' : value,
        [f.ref]: ok ? f.keychainRef : undefined,
      });
      return ok ? 'saved' : 'fallback';
    }
    const existingRef = (current as Record<string, unknown>)[f.ref] as string | undefined;
    if (existingRef) {
      await keychainDelete(existingRef).catch(() => {});
    }
    setSearchKey(provider, null);
    setTools({
      ...current,
      [f.key]: '',
      [f.ref]: undefined,
      // Releasing the pin keeps the chip row honest. Resolution already falls
      // back when the selected provider has no credential, but leaving the
      // selector pointed at it renders that chip active *and* disabled — the
      // user would see it highlighted while searches quietly went elsewhere.
      ...(current.web_search_provider === provider ? { web_search_provider: 'auto' as const } : {}),
    });
    return 'cleared';
  };

  const startNew = () => {
    if (rejectExecutionConfigMutationWhileStreaming()) return;
    setEditing({
      id: '',
      name: '',
      baseUrl: DEFAULT_BASE_URL,
      modelFetchUrl: '',
      apiKey: '',
      apiKeyRef: undefined,
      apiVariant: 'openai',
      apiStyle: 'chat',
      routing: 'proxy',
      note: '',
      sse_read_timeout_min: 5,
      active: true,
      includeLcIdentifierHeader: false,
      lcIdentifierHeader: { name: '', value: '' },
      includeAdditionalRequestHeaders: false,
      requestHeaders: [],
    });
    // Without this, `save()` would fall into the `updateProfile`
    // branch (since `isNew` defaults to false), call
    // `updateProfile('', {...})` — which finds no matching id
    // and silently does nothing. Symptom: clicking "+ Add
    // server" → fill form → click "Add server" → the modal
    // closes and the profile list is unchanged. (Caught the
    // hard way: a single missing state-set between the open
    // and the submit makes the whole flow look like it's
    // doing nothing.)
    setIsNew(true);
  };

  const save = async () => {
    if (!editing) return;
    if (rejectExecutionConfigMutationWhileStreaming()) return;
    const validation = profileManager.validateDraft(editing);
    if (validation.ok === false) {
      toast.error(validation.errors.join('; '));
      return;
    }
    const key = editing.apiKey?.trim();
    if (isNew) {
      const draft = {
        name: editing.name.trim(),
        baseUrl: editing.baseUrl.trim(),
        modelFetchUrl: editing.modelFetchUrl?.trim() || undefined,
        apiVariant: editing.apiVariant || 'openai',
        apiStyle: editing.apiStyle || 'responses',
        routing: editing.routing || 'proxy',
        note: editing.note?.trim() || undefined,
        active: editing.active ?? false,
        sse_read_timeout_min: editing.sse_read_timeout_min ?? 5,
        includeLcIdentifierHeader: editing.includeLcIdentifierHeader ?? false,
        lcIdentifierHeader: editing.lcIdentifierHeader
          ? {
              name: editing.lcIdentifierHeader.name.trim(),
              value: editing.lcIdentifierHeader.value.trim(),
            }
          : undefined,
        includeAdditionalRequestHeaders: editing.includeAdditionalRequestHeaders ?? false,
        requestHeaders: editing.requestHeaders?.map((header) => ({
          name: header.name.trim(),
          value: header.value.trim(),
        })) ?? [],
      };
      if (key) {
        const { stored } = await profileManager.addProfileWithCredential(draft, key);
        if (stored) {
          toast.info('API key stored securely');
        } else {
          toast.error('Could not store API key — kept as plaintext fallback');
        }
      } else {
        await profileManager.addProfile(draft);
      }
    } else {
      if (key) {
        // Store the new key under an application-wide generation lease. A
        // failed encrypted write disconnects the old reference and keeps the
        // new value as the authoritative plaintext fallback.
        const ok = await profileManager.updateProfileCredential(editing.id, key, {
          name: editing.name.trim(),
          baseUrl: editing.baseUrl.trim(),
          modelFetchUrl: editing.modelFetchUrl?.trim() || undefined,
          apiVariant: editing.apiVariant || 'openai',
          apiStyle: editing.apiStyle || 'responses',
          routing: editing.routing || 'proxy',
          note: editing.note?.trim() || undefined,
          active: editing.active ?? false,
          sse_read_timeout_min: editing.sse_read_timeout_min ?? 5,
          includeLcIdentifierHeader: editing.includeLcIdentifierHeader ?? false,
          lcIdentifierHeader: editing.lcIdentifierHeader
            ? {
                name: editing.lcIdentifierHeader.name.trim(),
                value: editing.lcIdentifierHeader.value.trim(),
              }
            : undefined,
          includeAdditionalRequestHeaders: editing.includeAdditionalRequestHeaders ?? false,
          requestHeaders: editing.requestHeaders?.map((header) => ({
            name: header.name.trim(),
            value: header.value.trim(),
          })) ?? [],
        });
        if (ok) {
          toast.info('API key stored securely');
        } else {
          toast.error('Could not store API key — kept as plaintext fallback');
        }
      } else {
        // Key field left empty. The profile manager removes a disconnected
        // encrypted entry only after it admits the profile mutation.
        const orig = useProfileStore.getState().profiles.find(p => p.id === editing.id);
        await profileManager.updateProfile(editing.id, {
          name: editing.name.trim(),
          baseUrl: editing.baseUrl.trim(),
          modelFetchUrl: editing.modelFetchUrl?.trim() || undefined,
          apiKey: '',
          apiKeyRef: editing.apiKeyRef === undefined && orig?.apiKeyRef ? undefined : orig?.apiKeyRef,
          apiVariant: editing.apiVariant || 'openai',
          apiStyle: editing.apiStyle || 'responses',
          routing: editing.routing || 'proxy',
          note: editing.note?.trim() || undefined,
          active: editing.active ?? false,
          sse_read_timeout_min: editing.sse_read_timeout_min ?? 5,
          includeLcIdentifierHeader: editing.includeLcIdentifierHeader ?? false,
          lcIdentifierHeader: editing.lcIdentifierHeader
            ? {
                name: editing.lcIdentifierHeader.name.trim(),
                value: editing.lcIdentifierHeader.value.trim(),
              }
            : undefined,
          includeAdditionalRequestHeaders: editing.includeAdditionalRequestHeaders ?? false,
          requestHeaders: editing.requestHeaders?.map((header) => ({
            name: header.name.trim(),
            value: header.value.trim(),
          })) ?? [],
        });
      }
    }
    setEditing(null);
    setIsNew(false);
    setApiKeyFocused(false);
  };

  const fetchModels = async (profile: ServerProfile) => {
    // The agentic-tools pickers are derived from the registry, so committing
    // the fetched models is all it takes for them to update.
    await testServer(profile);
  };

  return (
    // `role="dialog"` + `aria-modal` are not decoration here. This overlay is
    // `position: fixed; inset: 0` with a dim background, so it already owns
    // pointer input completely — nothing behind it is clickable. The modal
    // gate in `utils/shortcuts.ts` keys off `aria-modal` to give it the same
    // ownership of the keyboard; without these attributes Ctrl+/ and friends
    // still fired and opened panels behind Settings that the user could see
    // but not reach. Removing them re-opens that hole.
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-page">
        <header>
          <h2>Settings</h2>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="icon-btn" onClick={onOpenAbout} aria-label="About LC" title="About LC">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path
                  fill="currentColor"
                  d="M11 17h2v-6h-2v6zm1-15C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zM11 9h2V7h-2v2z"
                />
              </svg>
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Close settings">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path
                  fill="currentColor"
                  d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                />
              </svg>
            </button>
          </div>
        </header>

        <div className="settings-body">
          <Section
            title={`Server profiles (${profiles.length})`}
            collapsed={!!collapsed.server_profiles}
            onToggle={() => toggleSection('server_profiles')}
            extra={(
              <button
                className="primary-btn small"
                onClick={startNew}
                disabled={profileMutationsBlocked}
                title={profileMutationsBlocked ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE : 'Add server'}
              >
                + Add server
              </button>
            )}
          >
            <p className="muted small">
              LC supports OpenAI-compatible, Anthropic-compatible, Gemini REST, and LM Studio REST.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, marginTop: 8, marginLeft: 2, marginRight: 2 }}>
              <div className="model-filter-chips" style={{ justifyContent: 'flex-start', marginBottom: 0, marginTop: 0 }}>
                {(['name', 'url', 'api', 'note'] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`chip small${sortBy === key ? ' active' : ''}`}
                    onClick={() => {
                      if (sortBy === key) setSortAsc((v) => !v);
                      else { setSortBy(key); setSortAsc(true); }
                    }}
                  >
                    {sortBy === key && (
                      <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden style={{ transform: sortAsc ? '' : 'scaleY(-1)' }}>
                        <path fill="currentColor" d="M8 3.5l-4 5h8l-4-5z" />
                      </svg>
                    )}
                    {key}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button
                className="ghost-btn small"
                title={profileMutationsBlocked
                  ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE
                  : 'Add, edit, delete, or hide models for each server profile'}
                disabled={profileMutationsBlocked}
                onClick={() => {
                  if (rejectExecutionConfigMutationWhileStreaming()) return;
                  setVisibilityOpen(true);
                }}
              >
                Manage models{btnTotalCount > 0 ? ` (${btnTotalCount - btnHiddenCount}/${btnTotalCount})` : ''}
              </button>
              </div>
            </div>
            <ul className="profile-list">
              {sortedProfiles.map((p) => {
                return (
                  <li
                    key={p.id}
                    className="profile-row"
                  >
                    <div className="profile-info">
                      <div className="profile-name">
                        {p.name}
                        <span
                          className={cn(
                            'profile-variant-chip',
                            p.apiVariant === 'openai' ? 'variant-openai' : p.apiVariant === 'gemini' ? 'variant-gemini' : p.apiVariant === 'anthropic' ? 'variant-anthropic' : 'variant-lmstudio',
                          )}
                          title={
                            p.apiVariant === 'openai'
                              ? (p.apiStyle === 'responses'
                                  ? 'OpenAI Responses — /responses'
                                  : 'OpenAI Chat Completions — /chat/completions')
                              : p.apiVariant === 'anthropic'
                              ? 'Anthropic Messages — /messages'
                              : p.apiVariant === 'gemini' ? 'Google Gemini native REST — /interactions' : 'LM Studio REST — /chat'
                          }
                        >
                          {p.apiVariant === 'openai' ? (p.apiStyle === 'responses' ? 'OpenAI/R' : 'OpenAI/CC') : p.apiVariant === 'gemini' ? 'Gemini REST' : p.apiVariant === 'anthropic' ? 'Anthropic' : 'REST'}
                        </span>
                      </div>
                      <div className="profile-url">
                        <code>{p.baseUrl}</code>
                      </div>
                      {p.note && <div className="profile-note">{p.note}</div>}
                    </div>
                    <div className="profile-actions">
                      <button
                        type="button"
                        className="bubble-icon-btn profile-edit-btn"
                        disabled={profileMutationsBlocked}
                        aria-label={`Edit ${p.name}`}
                        title={profileMutationsBlocked ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE : `Edit ${p.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (rejectExecutionConfigMutationWhileStreaming()) return;
                          setEditing({
                            ...p,
                            lcIdentifierHeader: p.lcIdentifierHeader
                              ? { ...p.lcIdentifierHeader }
                              : { name: '', value: '' },
                            requestHeaders: p.requestHeaders?.length
                              ? p.requestHeaders.map((header) => ({ ...header }))
                              : [{ name: '', value: '' }],
                          });
                          setIsNew(false);
                          setApiKeyFocused(false);
                        }}
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                          <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                          </svg>
                      </button>
                      <button
                        type="button"
                        className={cn('toggle', p.active && 'on')}
                        role="switch"
                        aria-checked={p.active ?? false}
                        disabled={profileMutationsBlocked}
                        title={profileMutationsBlocked
                          ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE
                          : (p.active ? 'Deactivate this profile.' : 'Activate this profile.')}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (rejectExecutionConfigMutationWhileStreaming()) return;
                          profileManager.updateProfile(p.id, { active: !p.active });
                          // The agentic-tools pickers re-derive from the
                          // registry's active projection on their own.
                        }}
                      >
                        <span className="toggle-thumb" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Section>

          {editing && !profileMutationsBlocked && (
            <div className="server-editor-overlay">
              <div className="server-editor-card">
                <div className="section-head">
                  <h3>{isNew ? 'New server' : 'Edit server'}</h3>
                  <div className="profile-actions">
                    <button className="icon-btn" onClick={() => { setEditing(null); setApiKeyFocused(false); }} aria-label="Close editor">
                      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                        <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="form-grid">
                  <div className="server-profile-activation-controls">
                    <div className="request-header-toggle-row">
                      <span>Activate this profile</span>
                      <button
                        type="button"
                        className={cn('toggle', editing.active && 'on')}
                        role="switch"
                        aria-checked={editing.active ?? false}
                        title="Activate this profile."
                        onClick={() => setEditing({ ...editing, active: !editing.active })}
                      >
                        <span className="toggle-thumb" />
                      </button>
                    </div>
                  </div>
                  <div className="server-profile-api-controls" role="group" aria-label="API and protocol">
                    <div className="api-variant-row api-protocol-row">
                      {(['openai', 'anthropic', 'gemini', 'lm-studio'] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          className={cn('chip', (editing.apiVariant ?? 'openai') === v && 'active')}
                          onClick={() => setEditing({ ...editing, apiVariant: v })}
                          title={
                            v === 'openai'
                              ? 'OpenAI compatible — /responses or /chat/completions'
                              : v === 'gemini' ? 'Google Gemini native REST — /interactions'
                              : v === 'lm-studio'
                              ? 'LM Studio\'s native REST — /chat'
                              : 'Anthropic compatible — /messages'
                          }
                        >
                          {v === 'openai' ? 'OpenAI' : v === 'gemini' ? 'Gemini REST' : v === 'lm-studio' ? 'LM Studio REST' : 'Anthropic'}
                        </button>
                      ))}
                    </div>
                    <hr className="server-profile-api-separator" />
                    <div className="api-variant-row">
                      {(editing.apiVariant ?? 'openai') === 'openai'
                        ? (['responses', 'chat'] as const).map((s) => (
                          <button
                            key={s}
                            type="button"
                            className={cn('chip', (editing.apiStyle ?? 'chat') === s && 'active')}
                            aria-pressed={(editing.apiStyle ?? 'chat') === s}
                            onClick={() => setEditing({ ...editing, apiStyle: s })}
                            title={
                              s === 'responses'
                                ? 'Responses — /responses'
                                : 'Chat Completions — /chat/completions'
                            }
                          >
                            <span>
                              {s === 'responses' ? 'Responses' : 'Chat Completions'} · <span className="protocol-letter endpoint-openai">
                                {endpointLetter(endpointForProfile('openai', s))}
                              </span>
                            </span>
                          </button>
                        ))
                        : (
                          <button
                            type="button"
                            className="chip active"
                            aria-pressed="true"
                            title={editing.apiVariant === 'anthropic'
                              ? 'Messages — /messages'
                              : editing.apiVariant === 'gemini'
                                ? 'Interactions — /interactions'
                                : 'Chat — /chat'}
                          >
                            <span>
                              {editing.apiVariant === 'anthropic' ? 'Messages'
                                : editing.apiVariant === 'gemini' ? 'Interactions' : 'Chat'} · <span
                                className={`protocol-letter endpoint-${endpointTone(endpointForProfile(editing.apiVariant))}`}
                              >
                                {endpointLetter(endpointForProfile(editing.apiVariant))}
                              </span>
                            </span>
                          </button>
                        )}
                    </div>
                    {(editing.apiVariant ?? 'openai') === 'lm-studio' && (
                      <p className="side-section-hint side-shell-warning">
                        ⚠︎ LM Studio REST does not support workspace/tools.
                      </p>
                    )}
                  </div>
                  <div className="server-profile-controls">
                  {/* Row 2: Display name (left) | SSE idle timeout (right) */}
                  <label>
                    <span>Display name</span>
                    <input
                      id="server-name"
                      name="name"
                      type="text"
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      placeholder="Home server"
                    />
                  </label>
                  <label>
                    <span title="Minutes before assuming server disconnected (default 5)">Stream idle timeout</span>
                    <input
                      id="sse-idle-timeout"
                      type="number"
                      min={1}
                      max={10}
                      step={1}
                      value={editing.sse_read_timeout_min ?? 5}
                      onChange={(e) => {
                        const v = Math.max(1, Math.min(10, Number(e.target.value) || 5));
                        setEditing({ ...editing, sse_read_timeout_min: v });
                      }}
                      style={{ width: '100%' }}
                    />
                  </label>
                  {/* Row 3: Base URL (left) | API key (right) */}
                  <label>
                    <span title="Include the API version, such as /v1beta for Gemini or /api/v1 for LM Studio native REST. Omit the operation path, such as /interactions.">Base URL (include API version)</span>
                    <input
                      id="server-url"
                      name="baseUrl"
                      type="text"
                      value={editing.baseUrl}
                      onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                      placeholder="http://127.0.0.1:1234/v1"
                    />
                  </label>
                  <label>
                    <span>API key</span>
                    <div className="api-key-row">
                      {(() => {
                        const isKeychain = !!(editing.apiKeyRef && !editing.apiKey);
                        // Blurred: masked. Focused: the real key, in the clear
                        // and directly editable — no reveal toggle to hunt for.
                        // A keychain-backed key has no value in the DOM until
                        // the focus handler fetches it, so it falls back to the
                        // fixed-width filler.
                        const displayValue = apiKeyFocused
                          ? (keychainFetched ?? editing.apiKey ?? '')
                          : (isKeychain ? KEY_MASK : (editing.apiKey ?? ''));
                        return (
                          <input
                            id="server-apikey"
                            name="apiKey"
                            type={apiKeyFocused ? 'text' : 'password'}
                            autoComplete="off"
                            value={displayValue}
                            onFocus={async () => {
                              setApiKeyFocused(true);
                              if (isKeychain && keychainFetched === null) {
                                const val = await keychainGet(editing.apiKeyRef!).catch(() => null);
                                setKeychainFetched(val ?? '');
                              }
                            }}
                            onBlur={() => {
                              setApiKeyFocused(false);
                              // Drop the fetched plaintext so it does not sit in
                              // component state while the field is idle. An
                              // untouched keychain key falls back to the mask; a
                              // key the user actually edited lives in
                              // `editing.apiKey` and survives.
                              setKeychainFetched(null);
                            }}
                            onChange={(e) => {
                              setKeychainFetched(null);
                              setEditing({ ...editing, apiKey: e.target.value, apiKeyRef: undefined });
                            }}
                            placeholder={isKeychain ? 'Stored securely — click to reveal and edit' : 'xx-xx-xxxxxxxx:xxxxxxxxxxxxxxxxxxxx'}
                          />
                        );
                      })()}
                    </div>
                  </label>
                  {/*
                   * Dev routing (Browser-only) — HIDDEN from UI.
                   *
                   * This setting only matters when running the Vite dev server in a
                   * browser (import.meta.env.DEV && !isTauri). In production:
                   *   - Tauri (.exe): Rust proxy_request handles both forms.
                   *   - Plain browser (static build): no Vite proxy exists, always direct.
                   *
                   * Kept in code so `editing.routing` still defaults to 'proxy' and
                   * devProxyUrl() behavior is unaffected. Restore this block if the
                   * Vite dev-server browser workflow ever becomes a first-class target.
                   *
                  <label>
                    <span title="No effect in production builds">Dev routing (Browser-only)</span>
                    <div className="api-variant-row">
                      {([
                        { v: 'proxy', label: 'Vite proxy', title: 'Proxies via /lc-proxy/* to bypass browser CORS.' },
                        { v: 'direct', label: 'Direct (CORS)', title: 'Direct request. Needs LM Studio CORS.' },
                      ] as const).map((opt) => (
                        <button
                          key={opt.v}
                          type="button"
                          className={cn('chip', (editing.routing ?? 'proxy') === opt.v && 'active')}
                          onClick={() => setEditing({ ...editing, routing: opt.v })}
                          title={opt.title}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </label>
                   */}
                  {/* Row 4: Model fetching URL (left) | Note (right) */}
                  <label>
                    <span title="Optional full HTTP(S) URL or path. Empty uses LC's local/LAN-aware default.">Model fetching URL (optional)</span>
                    <input
                      id="server-model-fetch-url"
                      name="modelFetchUrl"
                      type="text"
                      value={editing.modelFetchUrl ?? ''}
                      onChange={(e) => setEditing({ ...editing, modelFetchUrl: e.target.value })}
                      placeholder={getDefaultModelFetchUrl(editing.baseUrl)}
                    />
                  </label>
                  <label>
                    <span>Note (optional)</span>
                    <input
                      id="server-note"
                      name="note"
                      type="text"
                      value={editing.note ?? ''}
                      onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                      placeholder="Basement"
                    />
                  </label>
                  </div>
                  <div className="request-header-controls">
                    <div className="request-header-toggle-row">
                      <span>Include app identifier header</span>
                      <button
                        type="button"
                        className={cn('toggle', editing.includeLcIdentifierHeader && 'on')}
                        role="switch"
                        aria-checked={editing.includeLcIdentifierHeader ?? false}
                        title="Configure and send an LC identifier header with requests for this profile."
                        onClick={() => setEditing({
                          ...editing,
                          includeLcIdentifierHeader: !editing.includeLcIdentifierHeader,
                          lcIdentifierHeader: editing.lcIdentifierHeader ?? { name: '', value: '' },
                        })}
                      >
                        <span className="toggle-thumb" />
                      </button>
                    </div>

                    {editing.includeLcIdentifierHeader && (
                      <div className="request-header-nested">
                        <div className="request-header-identifier-row">
                          <input
                            type="text"
                            value={editing.lcIdentifierHeader?.name ?? ''}
                            aria-label="LC identifier header name"
                            placeholder={LC_IDENTIFIER_HEADER_NAME}
                            autoCapitalize="none"
                            spellCheck={false}
                            onChange={(event) => setEditing({
                              ...editing,
                              lcIdentifierHeader: {
                                name: event.target.value,
                                value: editing.lcIdentifierHeader?.value ?? '',
                              },
                            })}
                          />
                          <input
                            type="text"
                            value={editing.lcIdentifierHeader?.value ?? ''}
                            aria-label="LC identifier header value"
                            placeholder={LC_IDENTIFIER_HEADER_VALUE}
                            autoCapitalize="none"
                            spellCheck={false}
                            onChange={(event) => setEditing({
                              ...editing,
                              lcIdentifierHeader: {
                                name: editing.lcIdentifierHeader?.name ?? '',
                                value: event.target.value,
                              },
                            })}
                          />
                          <button
                            type="button"
                            className="bubble-icon-btn request-header-reset"
                            aria-label="Reset LC identifier header to defaults"
                            title={`Reset to ${LC_IDENTIFIER_HEADER_NAME}: ${LC_IDENTIFIER_HEADER_VALUE}`}
                            onClick={() => setEditing({
                              ...editing,
                              lcIdentifierHeader: { name: '', value: '' },
                            })}
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                              <path
                                fill="currentColor"
                                d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
                              />
                            </svg>
                          </button>
                        </div>
                        <div className="request-header-toggle-row">
                          <span>Include additional request headers</span>
                          <button
                            type="button"
                            className={cn('toggle', editing.includeAdditionalRequestHeaders && 'on')}
                            role="switch"
                            aria-checked={editing.includeAdditionalRequestHeaders ?? false}
                            onClick={() => {
                              const enabled = !editing.includeAdditionalRequestHeaders;
                              setEditing({
                                ...editing,
                                includeAdditionalRequestHeaders: enabled,
                                requestHeaders: enabled && !editing.requestHeaders?.length
                                  ? [{ name: '', value: '' }]
                                  : editing.requestHeaders,
                              });
                            }}
                          >
                            <span className="toggle-thumb" />
                          </button>
                        </div>

                        {editing.includeAdditionalRequestHeaders && (
                          <div className="request-header-editor">
                            {(editing.requestHeaders ?? []).map((header, index) => (
                              <div className="request-header-row" key={index}>
                                <input
                                  type="text"
                                  value={header.name}
                                  aria-label={`Request header ${index + 1} name`}
                                  placeholder="Header name"
                                  autoCapitalize="none"
                                  spellCheck={false}
                                  onChange={(event) => setEditing({
                                    ...editing,
                                    requestHeaders: (editing.requestHeaders ?? []).map((entry, entryIndex) => (
                                      entryIndex === index ? { ...entry, name: event.target.value } : entry
                                    )),
                                  })}
                                />
                                <input
                                  type="text"
                                  value={header.value}
                                  aria-label={`Request header ${index + 1} value`}
                                  placeholder="Header value"
                                  autoCapitalize="none"
                                  spellCheck={false}
                                  onChange={(event) => setEditing({
                                    ...editing,
                                    requestHeaders: (editing.requestHeaders ?? []).map((entry, entryIndex) => (
                                      entryIndex === index ? { ...entry, value: event.target.value } : entry
                                    )),
                                  })}
                                />
                                <button
                                  type="button"
                                  className="bubble-icon-btn request-header-remove"
                                  aria-label={`Remove request header ${index + 1}`}
                                  title="Remove header"
                                  onClick={() => {
                                    const headers = editing.requestHeaders ?? [];
                                    setEditing({
                                      ...editing,
                                      requestHeaders: headers.length > 1
                                        ? headers.filter((_, entryIndex) => entryIndex !== index)
                                        : [{ name: '', value: '' }],
                                    });
                                  }}
                                >
                                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                                    <path
                                      fill="currentColor"
                                      d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                                    />
                                  </svg>
                                </button>
                              </div>
                            ))}
                            <button
                              type="button"
                              className="ghost-btn small request-header-add"
                              onClick={() => setEditing({
                                ...editing,
                                requestHeaders: [
                                  ...(editing.requestHeaders ?? []),
                                  { name: '', value: '' },
                                ],
                              })}
                            >
                              + Add header
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="form-actions">
                  {!isNew && (
                    <button
                      className="ghost-btn small danger"
                      style={{ marginRight: 'auto' }}
                      onClick={async () => {
                        if (await safeConfirm(`Remove profile "${editing.name}"?`)) {
                          try {
                            await profileManager.removeProfile(editing.id);
                            setEditing(null);
                            setApiKeyFocused(false);
                          } catch (error) {
                            toast.error(errorMessage(error));
                          }
                        }
                      }}
                    >
                      Remove
                    </button>
                  )}
                  <button
                    className="ghost-btn small"
                    disabled={!editing.active}
                    title={editing.active ? `Fetch models from ${editing.name}` : 'Toggle this server on to load models'}
                    onClick={() => fetchModels(editing)}
                  >
                    Fetch models
                  </button>
                  <button className="primary-btn small" onClick={save}>
                    {isNew ? 'Add server' : 'Save changes'}
                  </button>
                </div>
              </div>
            </div>
          )}

          <Section title="Appearance" collapsed={!!collapsed.appearance} onToggle={() => toggleSection('appearance')}>
            <div className="appearance-grid">
              <span className="zoom-label">Zoom</span>
              <div className="zoom-chips">
                {ZOOM_LEVELS.map((z) => (
                  <button
                    key={z}
                    className={cn('chip', zoom === z && 'active')}
                    onClick={() => setZoom(z)}
                    title={`Set interface zoom to ${Math.round(z * 100)}%`}
                  >
                    {ZOOM_LABELS[z]}
                  </button>
                ))}
              </div>
              <span className="zoom-label">Theme</span>
              <div className="zoom-chips">
                <button
                  className={cn('chip', theme === 'system' && !activeCustomThemeId && 'active')}
                  onClick={() => { setActiveCustomTheme(null); setTheme('system'); }}
                >
                  system
                </button>
                <button
                  className={cn('chip', theme === 'light' && !activeCustomThemeId && 'active')}
                  onClick={() => { setActiveCustomTheme(null); setTheme('light'); }}
                >
                  built-in light
                </button>
                <button
                  className={cn('chip', theme === 'dark' && !activeCustomThemeId && 'active')}
                  onClick={() => { setActiveCustomTheme(null); setTheme('dark'); }}
                >
                  built-in dark
                </button>
                <button
                  className={cn('chip', !!activeCustomThemeId && 'active')}
                  onClick={() => setCustomThemeOpen(true)}
                >
                  ✦ custom
                </button>
              </div>
              <span
                className="zoom-label"
                title="Window and surface material. Auto uses the native system material where the platform supports one (Mica/Acrylic on Windows, vibrancy on macOS) and flat matte surfaces on Linux."
              >
                Material
              </span>
              <div className="zoom-chips">
                {(['auto', 'glass', 'solid'] as const).map((m) => (
                  <button
                    key={m}
                    className={cn('chip', materialMode === m && 'active')}
                    onClick={() => setMaterialMode(m)}
                    title={
                      m === 'auto'
                        ? 'Native material where supported, matte on Linux (default).'
                        : m === 'glass'
                          ? 'Prefer glass surfaces, with a readable fallback when blur is unavailable.'
                          : 'Opaque surfaces on every platform.'
                    }
                  >
                    {m}
                  </button>
                ))}
              </div>
              <span className="zoom-label">Token meter</span>
              <div className="zoom-chips">
                <button
                  className={cn('chip', tokenMeterStyle === 'donut' && 'active')}
                  onClick={() => setTokenMeterStyle('donut')}
                >
                  donut
                </button>
                <button
                  className={cn('chip', tokenMeterStyle === 'cake' && 'active')}
                  onClick={() => setTokenMeterStyle('cake')}
                >
                  cake
                </button>
              </div>
            </div>
          </Section>

          <Section title="Chat" collapsed={!!collapsed.chat} onToggle={() => toggleSection('chat')}>
            <div className="appearance-grid">
              <span
                className="zoom-label"
                title="Maximum chats that may generate at once. Choose three only when your provider and machine can sustain it."
              >
                Concurrent chats
              </span>
              <div className="zoom-chips">
                {([1, 2, 3] as const).map((count) => (
                  <button
                    key={count}
                    className={cn('chip', maxConcurrentGenerations === count && 'active')}
                    onClick={() => setMaxConcurrentGenerations(count)}
                  >
                    {count}
                  </button>
                ))}
              </div>
              <span className="zoom-label">Pin composer</span>
              <div className="zoom-chips">
                <button
                  className={cn('chip', pinComposer && 'active')}
                  onClick={() => setPinComposer(true)}
                >
                  on
                </button>
                <button
                  className={cn('chip', !pinComposer && 'active')}
                  onClick={() => setPinComposer(false)}
                >
                  off
                </button>
              </div>
              <span className="zoom-label">Auto reasoning preview</span>
              <div className="zoom-chips">
                <button
                  className={cn('chip', autoPreviewReasoning && 'active')}
                  onClick={() => setAutoPreviewReasoning(true)}
                >
                  on
                </button>
                <button
                  className={cn('chip', !autoPreviewReasoning && 'active')}
                  onClick={() => setAutoPreviewReasoning(false)}
                >
                  off
                </button>
              </div>
              <span
                className="zoom-label"
                title="Choose whether the preview overlay shows every to-do list update in the selected turn or only its newest list."
              >
                To-do list preview
              </span>
              <div className="zoom-chips">
                <button
                  className={cn('chip', !showOnlyLatestTodoList && 'active')}
                  onClick={() => setShowOnlyLatestTodoList(false)}
                >
                  all updates
                </button>
                <button
                  className={cn('chip', showOnlyLatestTodoList && 'active')}
                  onClick={() => setShowOnlyLatestTodoList(true)}
                >
                  latest only
                </button>
              </div>
              <span
                className={cn('zoom-label', profileMutationsBlocked && 'generation-config-locked')}
                title={profileMutationsBlocked
                  ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE
                  : 'Archive idle chats after N days. Runs on startup and when this setting changes. 0 disables it.'}
              >
                Auto archive idle chats after
              </span>
              <div
                className={cn('auto-archive-row tool-row-stepper', profileMutationsBlocked && 'generation-config-locked')}
                inert={profileMutationsBlocked || undefined}
                aria-disabled={profileMutationsBlocked || undefined}
                title={profileMutationsBlocked
                  ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE
                  : 'Archive idle chats after N days. Runs on startup and when this setting changes. 0 disables it.'}
              >
                <button
                  type="button"
                  className="icon-btn small auto-archive-step"
                  aria-label="Decrease auto-archive days"
                  onClick={() => setAutoArchiveDays(Math.max(0, autoArchiveDays - 1))}
                  disabled={autoArchiveDays === 0}
                >
                  −
                </button>
                <input
                  id="auto-archive-days"
                  name="autoArchiveDays"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className="auto-archive-input"
                  value={autoArchiveDays}
                  onChange={(e) => {
                    const cleaned = e.target.value.replace(/[^0-9]/g, '');
                    if (cleaned === '') {
                      setAutoArchiveDays(0);
                      return;
                    }
                    const v = Number(cleaned);
                    if (!Number.isFinite(v)) return;
                    setAutoArchiveDays(Math.max(0, Math.min(999, v)));
                  }}
                />
                <button
                  type="button"
                  className="icon-btn small auto-archive-step"
                  aria-label="Increase auto-archive days"
                  onClick={() => setAutoArchiveDays(Math.min(999, autoArchiveDays + 1))}
                  disabled={autoArchiveDays === 999}
                >
                  +
                </button>
                <span className="auto-archive-unit">
                  day{autoArchiveDays === 1 ? '' : 's'}
                  {autoArchiveDays === 0 ? ' (0 = disabled)' : ''}
                </span>
              </div>
              <span
                className="zoom-label"
                title="Shown in the message header above the AI's replies. Defaults to &quot;Assistant&quot;."
              >
                Assistant name
              </span>
              <div className="assistant-name-row">
                <input
                  id="assistant-name"
                  name="assistantName"
                  type="text"
                  value={assistantName}
                  onChange={(e) => setAssistantName(e.target.value)}
                  placeholder="Assistant"
                  maxLength={40}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                />
                <button
                  type="button"
                  className="bubble-icon-btn"
                  title="Save assistant name"
                  aria-label="Save assistant name"
                  onClick={() => toast.success(`Assistant name set to "${assistantName}"`)}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                    <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                </button>
              </div>
            </div>
          </Section>

          <Section
            title="Workspace"
            collapsed={!!collapsed.model_tools}
            onToggle={() => toggleSection('model_tools')}
            disabled={profileMutationsBlocked}
          >
            <p className="muted small">
              Per-conversation defaults for workspace. New conversation inherits the allowed shell 
              binaries here; enable tools per conversation in the <code>Workspace</code> tab.
            </p>
            <div className="appearance-grid">
              <span className="zoom-label">Known directories</span>
              <div className="tool-row-input">
                <button
                  type="button"
                  className="ghost-btn small"
                  onClick={() => setRootsEditorOpen(true)}
                >
                  Manage
                </button>
              </div>

              <span
                className="zoom-label"
                title="Vision model used for lc_read_image analyze mode and for summarizing lc_read_pdf pages. lc_read_pdf only rasterizes pages when this model (or the chat model it falls back to) supports vision."
              >
                Model for image analyze
              </span>
              <div className="vision-model-row">
                <SubAgentModelPicker
                  value={tools.vision_model}
                  onChange={(modelId) => setTools({ ...tools, vision_model: modelId })}
                  models={subAgentModels}
                  loading={subAgentModelsLoading}
                  disabled={profileMutationsBlocked}
                  filter="vision"
                />
              </div>

              <span
                className="zoom-label"
                title="Tool model used for lc_web_research."
              >
                Model for web research
              </span>
              <div className="web-research-model-row">
                <SubAgentModelPicker
                  value={tools.web_research_model}
                  onChange={(modelId) => setTools({ ...tools, web_research_model: modelId })}
                  models={subAgentModels}
                  loading={subAgentModelsLoading}
                  disabled={profileMutationsBlocked}
                  filter="tools"
                />
              </div>

              <span
                className="zoom-label"
                title="Tool model used for lc_read_pdf text summaries. Pages needing vision use Model for image analyze instead."
              >
                Model for PDF summarize
              </span>
              <div className="pdf-summarize-model-row">
                <SubAgentModelPicker
                  value={tools.pdf_summarize_model}
                  onChange={(modelId) => setTools({ ...tools, pdf_summarize_model: modelId })}
                  models={subAgentModels}
                  loading={subAgentModelsLoading}
                  disabled={profileMutationsBlocked}
                  filter="tools"
                />
              </div>

              <span
                className="zoom-label"
                title="Brave Search API key for web_search. Get one at brave.com/search/api."
              >
                Brave Search API key
              </span>
              <KeychainKeyRow
                id="brave-search-api-key"
                name="brave_search_api_key"
                label="Brave Search API key"
                placeholder="BSAxxx (Get a key at brave.com/search/api)"
                storedKey={tools.brave_search_api_key}
                storedRef={tools.brave_search_api_key_ref}
                liveKey={getBraveSearchKey()}
                onCommit={(value) => commitSearchKey('brave', value)}
              />

              <span
                className="zoom-label"
                title="Your own SearXNG instance. Its JSON API must be enabled."
              >
                SearXNG base URL
              </span>
              {/* `.api-key-row` rather than `.tool-row-input` so the field
                  inherits the same radius, background, border, and focus
                  colour as the two key rows — the styling lives on
                  `.api-key-row input`. Search resolution accepts only a URL
                  that passes the shared credential rule. The supported value
                  is plain text with no masking and no keychain. */}
              <div className="api-key-row">
                <input
                  id="searxng-base-url"
                  name="searxng_base_url"
                  type="text"
                  autoComplete="off"
                  value={tools.searxng_base_url}
                  onChange={(e) => {
                    const next = e.target.value;
                    setTools({
                      ...tools,
                      searxng_base_url: next,
                      // Same self-heal as the key rows: emptying the URL
                      // releases a pin that can no longer take effect.
                      ...(!next.trim() && tools.web_search_provider === 'searxng'
                        ? { web_search_provider: 'auto' as const }
                        : {}),
                    });
                  }}
                  placeholder="http://localhost:8080"
                />
                <button
                  type="button"
                  className="bubble-icon-btn"
                  disabled={searxngTesting}
                  onClick={async () => {
                    // The URL already persists on every keystroke, so this
                    // button tests rather than saves. It runs a real search
                    // through the same Rust path the tool uses, because the
                    // failure that matters — an instance serving 403 for
                    // `format=json` because the operator never enabled it —
                    // is invisible to any cheaper check, and would otherwise
                    // only surface mid-conversation as a failed tool call.
                    const raw = tools.searxng_base_url.trim();
                    if (!raw) {
                      toast.info('Enter a base URL first, e.g. http://localhost:8080');
                      return;
                    }
                    let parsed: URL;
                    try {
                      parsed = new URL(raw);
                    } catch {
                      toast.error('Not a valid URL — include the scheme, e.g. http://localhost:8080');
                      return;
                    }
                    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                      toast.error(`Unsupported scheme "${parsed.protocol}" — use http or https.`);
                      return;
                    }
                    if (hasUrlCredentials(parsed.toString())) {
                      toast.error('SearXNG URL credentials are not supported. Remove user-info and credential parameters from queries or fragments.');
                      return;
                    }
                    if (!isTauri) {
                      // The probe goes through the Rust command, so there is
                      // nothing to call on the web build. Say that plainly
                      // rather than surfacing a raw bridge rejection.
                      toast.info(
                        'Testing requires the desktop app — the URL is saved and will be used there.',
                      );
                      return;
                    }
                    setSearxngTesting(true);
                    const tid = toast.info(`Testing ${parsed.host}…`, { ttl: 0 });
                    try {
                      const res = await createTauriBridge().webSearch({
                        query: 'searxng connection test',
                        max_results: 1,
                        provider: 'searxng',
                        base_url: raw,
                        deadline_ms: 15_000,
                      });
                      toast.dismiss(tid);
                      const n = res.results?.length ?? 0;
                      if (n > 0) {
                        toast.success(`${parsed.host} reachable — JSON enabled, search working.`);
                      } else {
                        // JSON parsed but nothing came back: the instance is
                        // configured correctly and simply has no engines
                        // returning results, which is a different problem.
                        toast.info(
                          `${parsed.host} reachable and JSON is enabled, but it returned no results. Check that engines are enabled on the instance.`,
                        );
                      }
                    } catch (err) {
                      toast.dismiss(tid);
                      // The Rust side already turns a 403 into an actionable
                      // "add `json` under search.formats" message.
                      toast.error(errorMessage(err));
                    } finally {
                      setSearxngTesting(false);
                    }
                  }}
                  title="Test the SearXNG instance"
                  aria-label="Test the SearXNG instance"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                    <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                </button>
              </div>

              <span
                className="zoom-label"
                title="Marginalia API key. The shared `public` key needs no signup but allows only ~3 queries/minute."
              >
                Marginalia API key
              </span>
              <KeychainKeyRow
                id="marginalia-api-key"
                name="marginalia_api_key"
                label="Marginalia API key"
                placeholder="public (shared, ~3 queries/min) or your own key"
                storedKey={tools.marginalia_api_key}
                storedRef={tools.marginalia_api_key_ref}
                liveKey={getMarginaliaKey()}
                onCommit={(value) => commitSearchKey('marginalia', value)}
              />

              <span
                className="zoom-label"
                title="Which engine serves lc_web_search and lc_web_research. Exactly one is used — there is no fallback between them."
              >
                Search provider
              </span>
              <div className="zoom-chips">
                {(['auto', ...WEB_SEARCH_PRIORITY] as const).map((p) => {
                  const configured = p === 'auto' || isConfigured(p, tools);
                  const label = p === 'auto'
                    ? (autoProvider ? `auto (${autoProvider})` : 'auto (none)')
                    : p;
                  return (
                    <button
                      key={p}
                      className={cn('chip', tools.web_search_provider === p && 'active')}
                      disabled={!configured}
                      title={configured
                        ? (p === 'auto'
                            ? 'Use the first configured provider: brave, then searxng, then marginalia.'
                            : `Always use ${p}.`)
                        : `Add a ${p === 'searxng' ? 'base URL' : 'key'} above to select ${p}.`}
                      onClick={() => setTools({ ...tools, web_search_provider: p })}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <span
                className="zoom-label"
                title="Per-conversation cap on how many web_fetch calls the model can make per minute."
              >
                Max web fetch
              </span>
              <div className="auto-archive-row tool-row-stepper">
                <button
                  type="button"
                  className="icon-btn small auto-archive-step"
                  aria-label="Decrease web fetch rate limit"
                  onClick={() =>
                    setTools({
                      ...tools,
                      web_fetch_rate_per_min: Math.max(
                        1,
                        tools.web_fetch_rate_per_min - 1,
                      ),
                    })
                  }
                  disabled={tools.web_fetch_rate_per_min === 1}
                >
                  −
                </button>
                <input
                  id="web-fetch-rate"
                  name="web_fetch_rate_per_min"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className="auto-archive-input"
                  value={tools.web_fetch_rate_per_min}
                  onChange={(e) => {
                    const cleaned = e.target.value.replace(/[^0-9]/g, '');
                    const v = cleaned === '' ? 1 : Number(cleaned);
                    if (!Number.isFinite(v)) return;
                    setTools({
                      ...tools,
                      web_fetch_rate_per_min: Math.max(1, Math.min(600, v)),
                    });
                  }}
                />
                <button
                  type="button"
                  className="icon-btn small auto-archive-step"
                  aria-label="Increase web fetch rate limit"
                  onClick={() =>
                    setTools({
                      ...tools,
                      web_fetch_rate_per_min: Math.min(
                        600,
                        tools.web_fetch_rate_per_min + 1,
                      ),
                    })
                  }
                  disabled={tools.web_fetch_rate_per_min === 600}
                >
                  +
                </button>
                <span className="auto-archive-unit">(calls / min)</span>
              </div>

              <span className="zoom-label">Default shell binaries</span>
              <div className="tool-row-input" style={{ alignItems: 'flex-start' }}>
                <textarea
                  id="settings-shell-allowlist"
                  name="settings-shell_allowlist"
                  className="shell-allowlist-textarea"
                  value={tools.shell_allowlist}
                  onChange={(e) =>
                    setTools({ ...tools, shell_allowlist: e.target.value })
                  }
                  placeholder={(() => {
                    const def = getDefaultShellAllowlist();
                    return def
                      ? `${def.split(',').slice(0, 5).join(',')},… (comma-separated, no spaces)`
                      : 'cmd,powershell,sh,bash,… (comma-separated, no spaces)';
                  })()}
                  rows={3}
                />
                <button
                  type="button"
                  className="ghost-btn small"
                  onClick={() =>
                    setTools({
                      ...tools,
                      shell_allowlist: getDefaultShellAllowlist(),
                    })
                  }
                >
                  Reset
                </button>
              </div>
            </div>
          </Section>

          <Section
            title="Backup & reset"
            collapsed={!!collapsed.backup_reset}
            onToggle={() => toggleSection('backup_reset')}
            disabled={profileMutationsBlocked}
          >
            <div className="backup-group">
              <div className="backup-group-head">
                <h4>Chat history</h4>
                {storageSummary && (
                  <span className="muted small">Local storage: {storageSummary}</span>
                )}
              </div>
            <p className="muted small">
              Export every chat — titles, messages, reasoning, attachments,
              and per-reply meta — to a single <code>.zip</code> archive.
              The same format is used by the per-chat Export button. Imported chats merge 
              into your list by ID: existing entries are updated in place and moved to the 
              top, new ones are added.
            </p>

            <div className="data-grid">
              <div className="data-grid-left">
                <button
                  className="ghost-btn small"
                  onClick={async () => {
                    try {
                      const all = useConversations.getState();
                      const order = all.order;
                      const byId = all.byId;
                      const convs = order
                        .map((id) => byId[id])
                        .filter((c): c is Conversation => Boolean(c));
                      if (convs.length === 0) {
                        toast.error('No conversations to export.');
                        return;
                      }
                      // Load authoritative messages on demand. buildArchive
                      // still retains projected transcripts for the whole export.
                      const ok = await exportAllArchives(
                        convs,
                        loadMessages,
                        listWhiteboardVersions,
                      );
                      if (ok) {
                        toast.success(
                          `Exported ${convs.length} conversation${convs.length === 1 ? '' : 's'}.`,
                        );
                      }
                    } catch (err) {
                      toast.error(
                        `Export failed: ${errorMessage(err)}`,
                      );
                    }
                  }}
                >
                  <ExportIcon />
                  Export chats
                </button>
                <button
                  className="ghost-btn small"
                  onClick={() => {
                    importKindRef.current = 'conversations';
                    // Set the accept filter right before
                    // clicking so the file dialog shows
                    // .zip only — without this, the last
                    // used filter (from App settings' Import
                    // click) would persist and the user
                    // would see .json or a duplicated
                    // filter.
                    //
                    // Use just the extension (`.zip`)
                    // without the MIME type. On Windows,
                    // the common-dialog uses MIME
                    // (application/zip) and the OS maps
                    // it to the same `.zip` extension, so
                    // listing BOTH produces a duplicated
                    // "*.zip;*.zip" entry in the filter
                    // dropdown.
                    if (importInputRef.current) {
                      importInputRef.current.setAttribute('accept', '.zip');
                    }
                    importInputRef.current?.click();
                  }}
                >
                  <ImportIcon />
                  Import chats
                </button>
              </div>
              <DangerAction
                className="push-right"
                label="Delete all chats"
                warning="Permanently deletes every conversation and its cached attachments. Export first if you want to keep them."
                align="right"
                onConfirm={async () => {
                  if (
                    await safeConfirm(
                      'Delete ALL chats? This cannot be undone.',
                    )
                  ) {
                    const wiped = await clearAll();
                    // Drafts, staged attachments, and panel state belong to
                    // conversations that no longer exist.
                    if (wiped) await useConversationUi.getState().releaseAll();
                    if (wiped) {
                      await refreshStorage();
                      toast.success('All chats deleted.');
                    }
                  }
                }}
              />
            </div>
            </div>
            <div className="backup-group">
              <div className="backup-group-head">
                <h4>App settings</h4>
              </div>
            <p className="muted small">
              Export your server profiles, theme, zoom, assistant name, custom themes, tool 
              configuration, and all other preferences to a JSON file, or import a previously 
              exported file. Importing replaces the current settings wholesale.
            </p>
            <div className="data-grid">
              <div className="data-grid-left">
                <button
                  className="ghost-btn small"
                  onClick={async () => {
                    try {
                      if (await exportSettings()) {
                        toast.success('Settings exported.');
                      }
                    } catch (err) {
                      toast.error(
                        `Export failed: ${errorMessage(err)}`,
                      );
                    }
                  }}
                >
                  <ExportIcon />
                  Export settings
                </button>
                <button
                  className="ghost-btn small"
                  onClick={() => {
                    importKindRef.current = 'settings';
                    // Settings export is a JSON file
                    // (`.json`), not a `.zip`. Setting the
                    // accept filter imperatively right
                    // before clicking is the only way to
                    // override the previous filter the
                    // dialog remembered.
                    //
                    // Just the extension — listing both
                    // the ext and the MIME causes Windows
                    // to show a duplicated entry in the
                    // file dialog's filter dropdown.
                    if (importInputRef.current) {
                      importInputRef.current.setAttribute('accept', '.json');
                    }
                    importInputRef.current?.click();
                  }}
                >
                  <ImportIcon />
                  Import settings
                </button>
              </div>
              <DangerAction
                className="push-right"
                label="Reset to defaults"
                warning="Wipes all server profiles, theme, zoom, assistant name, AND resets every conversation's parameter preset back to Server default. Your messages are kept. The app will reload."
                align="right"
                onConfirm={async () => {
                  if (
                    !(await safeConfirm(
                      'Reset ALL settings to defaults? Your server profiles, theme, zoom, and agentic-tool config will be wiped. Your conversations will be kept, but their parameter presets will reset to Server default. The app will reload.',
                    ))
                  ) {
                    return;
                  }
                  try {
                    await resetSettings();
                    toast.success('Settings reset. Reloading…');
                    // Force a reload so the settings store
                    // re-initializes from the empty localStorage.
                    setTimeout(() => window.location.reload(), 400);
                  } catch (err) {
                    toast.error(
                      `Reset failed: ${errorMessage(err)}`,
                    );
                  }
                }}
              />
            </div>
            </div>
          </Section>
          <Section
            title="Support"
            collapsed={!!collapsed.data_support}
            onToggle={() => toggleSection('data_support')}
          >
            <p className="muted small">
              Create a bounded, redacted JSON report for troubleshooting. The preview is generated locally,
              nothing is uploaded, and Copy and Save use the exact previewed content.
            </p>
            <div className="support-section-actions">
              <button
                type="button"
                className="ghost-btn small"
                onClick={() => void openSupportLink(LC_GITHUB_URL)}
              >
                <GitHubIcon />
                GitHub
              </button>
              <button
                type="button"
                className="ghost-btn small"
                onClick={onOpenSupportReport}
              >
                Create support report
              </button>
            </div>
          </Section>
          {/* Hidden file input shared by both Import buttons.  Outside
              any collapsible Section so the DOM ref is always alive. */}
          <input
            ref={importInputRef}
            id="import-file"
            name="importFile"
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              if (rejectExecutionConfigMutationWhileStreaming()) return;
              const kind = importKindRef.current;
              try {
                if (kind === 'conversations') {
                  const imported = await importConversationArchiveFile(file);
                  const totalRestored = imported.successful.reduce(
                    (count, result) => count + result.attachmentsRestored,
                    0,
                  );
                  const totalMissing = imported.successful.reduce(
                    (count, result) => count + result.attachmentsMissing,
                    0,
                  );
                  const attNote = totalRestored > 0 || totalMissing > 0
                    ? `, restored ${totalRestored} attachment${totalRestored === 1 ? '' : 's'}` +
                      (totalMissing > 0
                        ? ` (${totalMissing} unavailable)`
                        : '')
                    : '';
                  if (imported.imported > 0) {
                    toast.success(
                      `Imported ${imported.imported} conversation${imported.imported === 1 ? '' : 's'}${attNote}.`,
                    );
                  }
                  if (imported.failures.length > 0) {
                    toast.error(
                      `Failed to import ${imported.failures.length} conversation${imported.failures.length === 1 ? '' : 's'}. Existing data was kept.`,
                    );
                  }
                  refreshStorage();
                } else {
                  const payload = await readSettingsFile(file);
                  const result = importSettings(payload);
                  toast.success(
                    `Imported ${result.profiles} profile${result.profiles === 1 ? '' : 's'}.`,
                  );
                  refreshStorage();
                }
              } catch (err) {
                const msg = errorMessage(err);
                toast.error(msg);
              }
              }}
            />
        </div>
      </div>
      {visibilityOpen && !profileMutationsBlocked && (
        <ModelVisibilityPanel
          onClose={(hidden, total) => { setVisibilityOpen(false); saveFilterCounts(hidden, total); }}
        />
      )}
      <AllowedRootsEditor
        open={rootsEditorOpen && !profileMutationsBlocked}
        roots={tools.default_allowed_roots}
        onChange={(next) => {
          if (rejectExecutionConfigMutationWhileStreaming()) return;
          setTools({ ...tools, default_allowed_roots: next });
        }}
        onClose={() => setRootsEditorOpen(false)}
      />
    </div>
  );
}

async function testServer(p: ServerProfile) {
  const apiKey = await resolveProfileCredential(p);
  const client = new LLMClient({
    baseUrl: p.baseUrl,
    modelFetchUrl: p.modelFetchUrl,
    apiKey,
    apiVariant: p.apiVariant,
    apiStyle: p.apiStyle,
    routing: p.routing,
    ...profileRequestHeaderSettings(p),
  });
  // Cheap progress toast while we wait.
  const tid = toast.info(`Fetching models from ${p.name}…`, { ttl: 0 });
  try {
    const r = await client.testConnection();
    toast.dismiss(tid);
    if (r.ok) {
      // Write to the shared model cache so the ModelPicker sees the
      // same data. Without this, the Test button and the Refresh
      // button in the chat model picker used separate caches.
      const raw = r.models.map(m => ({
        id: m.id,
        display_name: m.display_name,
        max_context_length: m.max_context_length,
        capabilities: m.capabilities,
        source: m.source,
      }));
      modelCache.set(p.id, raw, p).catch(() => {});

      // Commit through the registry rather than writing `models` directly.
      // The old `useAppModels.setState({ models })` bypassed the record map
      // and the override layer entirely, so a Fetch models could silently
      // drop the user's metadata corrections until the next full refresh.
      useAppModels.getState().replaceProfileModels(p.id, buildLiveEntries(p, r.models), 'reachable');

      toast.success(`${p.name}: reachable, ${r.models.length} model${r.models.length === 1 ? '' : 's'}`);
    } else {
      toast.error(`${p.name}: ${(r as { ok: false; error: string }).error}`);
    }
  } catch (e) {
    toast.dismiss(tid);
    toast.error(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * A destructive button that shows a warning tooltip on hover. Used
 * for "Wipe all conversations" and "Reset settings" so the user
 * gets a clear "this is destructive" heads-up before they even click.
 *
 * `align` controls which side of the button the tooltip anchors to:
 *   - "right" — tooltip is left-of / right-side of the button and
 *     right-aligned to the panel (used for the Wipe button so the
 *     tooltip text reads toward the panel edge instead of being
 *     clipped off the right side of the settings page).
 *   - "left" — tooltip appears above/below the button, normal
 *     centered position (used for "Reset settings" at the start
 *     of the danger row).
 *
 * The tooltip is hover-only — no focus state — because the warning
 * text is for users still deciding whether to click, not a
 * post-click confirmation. The actual confirm() prompt on click is
 * still the safety net.
 */
function DangerAction({
  label,
  warning,
  align,
  onConfirm,
  className,
}: {
  label: string;
  warning: string;
  align: 'left' | 'right';
  onConfirm: () => void | Promise<void>;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'danger-action',
        align === 'right' && 'align-right',
        className,
      )}
    >
      <button
        type="button"
        className="ghost-btn danger"
        onClick={onConfirm}
      >
        {label}
      </button>
      <span className="danger-action-warn" role="tooltip">
        <span className="danger-action-warn-icon" aria-hidden>
          {/* Warning triangle — same shape browsers use for invalid
              form fields. Conveys "be careful" at a glance without
              needing to read the text. */}
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path
              fill="currentColor"
              d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"
            />
          </svg>
        </span>
        <span className="danger-action-warn-text">{warning}</span>
      </span>
    </span>
  );
}
