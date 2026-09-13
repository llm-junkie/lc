/**
 * Model Visibility Panel — hide/show models per server profile, and edit the
 * per-model metadata override that the rest of the app resolves against.
 *
 * Hidden models are excluded from all model pickers app-wide.
 *
 * Everything shown here comes from the `useAppModels` registry, including
 * inactive profiles: the panel used to join the live store against its own
 * `modelCache.getAll()` read and invalidate that read with a hand-rolled
 * `cacheVersion` token, which meant the panel could show metadata no other
 * surface agreed with.
 */

import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import {
  useAppModels,
  useProfileStore,
  modelCache,
  buildLiveEntries,
  guessModelMeta,
  isValidContextOverride,
  selectVisibilityRecords,
  downloadModelsDev,
  rebuildModelsCache,
  type ModelRegistryRecord,
  type ModelMetaOverride,
  type CustomModelDefinition,
} from '../../modules/server-profiles/index.ts';
import { useModelVisibility, hiddenModelKey } from '../../store/modelVisibility.ts';
import { cn } from '../../utils/cn.ts';
import {
  LLMClient,
  errorMessage,
  profileRequestHeaderSettings,
} from '../../modules/llm-client/index.ts';
import type { ServerProfile } from '../../types';
import { resolveProfileCredential } from '../../platform/chat-credential.ts';
import { toast } from '../../utils/toast.ts';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';
import { useShiftHeld } from '../chat/use-shift-held.ts';
import { formatCtx } from '../../utils/formatCtx.ts';
import { ModelCapabilityBadge } from '../shared/ModelCapabilityIcons.tsx';
import { safeConfirm } from '../../utils/safeConfirm.ts';

interface Props {
  onClose: (hiddenCount: number, totalCount: number) => void;
}

interface GroupRow {
  modelId: string;
  displayName: string;
  record: ModelRegistryRecord;
}

interface Group {
  profileName: string;
  apiVariant: string;
  apiStyle: string;
  models: GroupRow[];
}

interface EditorTarget {
  profileId: string;
  recordKey?: string;
}

/** Placeholder context shown when nothing detected a window at all. Matches
 *  the token meter's visual fallback so the two never contradict. */
const UNKNOWN_CONTEXT_PLACEHOLDER = 1000000;

export function ModelVisibilityPanel({ onClose }: Props) {
  // Subscribe to the record MAP, then derive the list. `selectVisibilityRecords`
  // allocates, so calling it as the zustand selector would return a new array
  // identity on every store read and re-render forever.
  const recordMap = useAppModels((s) => s.records);
  const records = useMemo(() => selectVisibilityRecords({ records: recordMap }), [recordMap]);
  const profiles = useProfileStore((s) => s.profiles);
  const hidden = useModelVisibility((s) => s.hidden);
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const shiftHeld = useShiftHeld();
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);
  // Header ⭳ in flight — disables itself and the per-profile actions so the
  // two fetch paths cannot interleave their cache writes.
  const [syncingAll, setSyncingAll] = useState(false);

  // Group registry records by profile. One source, so an override edit
  // re-renders the row it changed without any cache-invalidation token.
  const grouped = useMemo(() => {
    const map = new Map<string, Group>();
    // Profiles with no fetched models still need a group so users can add the
    // first model manually.
    for (const profile of profiles) {
      map.set(profile.id, {
        profileName: profile.name,
        apiVariant: profile.apiVariant ?? 'openai',
        apiStyle: profile.apiStyle ?? 'chat',
        models: [],
      });
    }
    for (const r of records) {
      let entry = map.get(r.profileId);
      if (!entry) {
        const prof = profiles.find((p) => p.id === r.profileId);
        entry = {
          profileName: prof?.name ?? r.effective.profileName,
          apiVariant: r.effective.apiVariant,
          apiStyle: r.effective.apiStyle,
          models: [],
        };
        map.set(r.profileId, entry);
      }
      entry.models.push({ modelId: r.modelId, displayName: r.effective.displayName, record: r });
    }
    // Sort groups by profile name, and models within each group A-Z.
    const result = [...map.entries()].sort(([, a], [, b]) => a.profileName.localeCompare(b.profileName));
    for (const [, g] of result) {
      g.models.sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
    return result;
  }, [records, profiles]);

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (profileId: string) =>
    setCollapsedGroups((c) => ({ ...c, [profileId]: !(c[profileId] ?? true) }));
  const totalCount = useMemo(
    () => grouped.reduce((n, [, g]) => n + g.models.length, 0),
    [grouped],
  );

  // Count hidden models among currently-displayed models only —
  // avoids counting stale entries from deleted/old profiles.
  const hiddenCount = useMemo(
    () => grouped.reduce((n, [profileId, group]) =>
      n + group.models.filter((m) => hidden.has(hiddenModelKey(profileId, m.modelId))).length, 0),
    [grouped, hidden],
  );

  const handleClose = useCallback(() => {
    onClose(hiddenCount, totalCount);
  }, [onClose, hiddenCount, totalCount]);

  // Close on Escape, only while this is the innermost overlay.
  //
  // This previously needed `stopImmediatePropagation()` to stop the sibling
  // capture-phase handlers on `window` — `stopPropagation()` alone does not
  // reach listeners on the same node. The stack removes the need for that
  // hammer: handlers that are not on top simply decline to act, so nothing
  // downstream has to be silenced. While the override editor is open it sits
  // above this panel on the same stack and owns the key instead.
  useOverlayEscape(handleClose, editorTarget === null);

  /** One profile's fetch, with no toasts and no busy state — the shared core
   *  for the per-profile Fetch button and the header sync, which report
   *  outcomes differently. Commits through the registry, so the panel's
   *  subscribed rows update the moment this resolves. */
  const fetchProfileModelsCore = useCallback(async (profile: ServerProfile): Promise<{ ok: boolean; count: number; error?: unknown }> => {
    try {
      const apiKey = await resolveProfileCredential(profile);
      const client = new LLMClient({
        baseUrl: profile.baseUrl,
        apiKey,
        modelFetchUrl: profile.modelFetchUrl,
        apiVariant: profile.apiVariant,
        apiStyle: profile.apiStyle ?? 'chat',
        routing: profile.routing,
        ...profileRequestHeaderSettings(profile),
      });
      const models = await client.listModels();
      useAppModels.getState().replaceProfileModels(profile.id, buildLiveEntries(profile, models), 'reachable');
      const raw = models.map((model) => ({
        id: model.id,
        display_name: model.display_name,
        max_context_length: model.max_context_length,
        capabilities: model.capabilities,
        source: model.source,
      }));
      await modelCache.set(profile.id, raw, profile);
      return { ok: true, count: models.length };
    } catch (error) {
      return { ok: false, count: 0, error };
    }
  }, []);

  const fetchProfileModels = useCallback(async (profileId: string): Promise<boolean> => {
    const profile = useProfileStore.getState().profiles.find((item) => item.id === profileId);
    if (!profile) return false;
    setBusyProfileId(profileId);
    const tid = toast.info(`Fetching models from ${profile.name}…`, { ttl: 0 });
    const result = await fetchProfileModelsCore(profile);
    toast.dismiss(tid);
    if (result.ok) {
      toast.success(`${profile.name}: fetched ${result.count} model${result.count === 1 ? '' : 's'}`);
    } else {
      toast.error(`Fetch failed: ${errorMessage(result.error)}`);
    }
    setBusyProfileId(null);
    return result.ok;
  }, [fetchProfileModelsCore]);

  /**
   * Header ⭳ — the full metadata refresh, one toast per step:
   *   1. download the models.dev catalogue,
   *   2. rebuild the compact cache from it (skipped if 1 failed — there is
   *      nothing fresh to rebuild from),
   *   3. re-fetch models from every server profile, active or not. Step 3
   *      runs even when the catalogue steps failed: the fetch enriches from
   *      whatever cache is already on disk, so a models.dev outage must not
   *      block reaching the servers themselves.
   */
  const runCatalogueSync = useCallback(async () => {
    if (syncingAll) return;
    setSyncingAll(true);
    try {
      let downloaded = false;
      try {
        const summary = await downloadModelsDev();
        toast.success(`models.dev: ${summary.providers} providers`);
        downloaded = true;
      } catch {
        toast.error('models.dev: download failed');
      }
      if (downloaded) {
        try {
          const summary = await rebuildModelsCache();
          toast.success(`Cache rebuilt: ${summary.models} models`);
        } catch {
          toast.error('Cache rebuild failed');
        }
      }

      const current = useProfileStore.getState().profiles;
      if (current.length === 0) return;
      const results = await Promise.allSettled(current.map((p) => fetchProfileModelsCore(p)));
      let okProfiles = 0;
      let totalModels = 0;
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.ok) {
          okProfiles++;
          totalModels += r.value.count;
        }
      }
      if (okProfiles === current.length) {
        toast.success(`Fetched ${totalModels} models from ${current.length} profile${current.length === 1 ? '' : 's'}`);
      } else if (okProfiles > 0) {
        toast.error(`Fetched from ${okProfiles}/${current.length} profiles`);
      } else {
        toast.error('Model fetch failed for all profiles');
      }
    } finally {
      setSyncingAll(false);
    }
  }, [syncingAll, fetchProfileModelsCore]);

  const restoreDefaults = useCallback(async (profileId: string, profileName: string) => {
    if (!(await safeConfirm(`Restore server model defaults for "${profileName}"? This removes added and deleted models, metadata edits, and visibility choices for this profile.`))) return;
    useAppModels.getState().resetProfileModelConfig(profileId);
    useModelVisibility.getState().clearForProfile(profileId);
    await fetchProfileModels(profileId);
  }, [fetchProfileModels]);

  const deleteModel = useCallback(async (record: ModelRegistryRecord) => {
    if (!(await safeConfirm(`Delete "${record.effective.displayName}" from this profile's model list?`))) return;
    useAppModels.getState().deleteModel(record.profileId, record.modelId);
    useModelVisibility.getState().show(record.profileId, record.modelId);
    toast.success(`Deleted ${record.effective.displayName}.`);
  }, []);

  const editingRecord = editorTarget?.recordKey
    ? records.find((r) => r.key === editorTarget.recordKey)
    : undefined;

  return (
    <div
      className="server-editor-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className="server-editor-card" style={{ maxWidth: 540, maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div className="section-head">
          <h3>Manage models ({totalCount - hiddenCount}/{totalCount} visible)</h3>
          {/* The ⭳ runs the full metadata refresh: models.dev download →
              compact-cache rebuild → re-fetch every profile. One toast per
              step, so a failure names which leg of the pipeline died. */}
          <button
            type="button"
            className="icon-btn"
            onClick={runCatalogueSync}
            disabled={syncingAll}
            aria-label="Refresh models.dev catalogue and re-fetch models from every server profile"
            title="Refresh models.dev catalogue, rebuild the metadata cache, and re-fetch models from every server profile"
            style={{ marginLeft: 'auto' }}
          >
            {syncingAll
              ? <span className="model-row-action-busy" aria-hidden>…</span>
              : (
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                  <path
                    fill="currentColor"
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M8 10C8 7.79086 9.79086 6 12 6C14.2091 6 16 7.79086 16 10V11H17C18.933 11 20.5 12.567 20.5 14.5C20.5 16.433 18.933 18 17 18H16.9C16.3477 18 15.9 18.4477 15.9 19C15.9 19.5523 16.3477 20 16.9 20H17C20.0376 20 22.5 17.5376 22.5 14.5C22.5 11.7793 20.5245 9.51997 17.9296 9.07824C17.4862 6.20213 15.0003 4 12 4C8.99974 4 6.51381 6.20213 6.07036 9.07824C3.47551 9.51997 1.5 11.7793 1.5 14.5C1.5 17.5376 3.96243 20 7 20H7.1C7.65228 20 8.1 19.5523 8.1 19C8.1 18.4477 7.65228 18 7.1 18H7C5.067 18 3.5 16.433 3.5 14.5C3.5 12.567 5.067 11 7 11H8V10ZM13 11C13 10.4477 12.5523 10 12 10C11.4477 10 11 10.4477 11 11V16.5858L9.70711 15.2929C9.31658 14.9024 8.68342 14.9024 8.29289 15.2929C7.90237 15.6834 7.90237 16.3166 8.29289 16.7071L11.2929 19.7071C11.6834 20.0976 12.3166 20.0976 12.7071 19.7071L15.7071 16.7071C16.0976 16.3166 16.0976 15.6834 15.7071 15.2929C15.3166 14.9024 14.6834 14.9024 14.2929 15.2929L13 16.5858V11Z"
                  />
                </svg>
              )}
          </button>
          <button className="icon-btn" onClick={handleClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Hidden models won't appear in any model picker — chat or agentic tools.
          Add or edit model details, or hold Shift to turn Edit into Delete.
        </p>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {grouped.map(([profileId, group]) => {
            const visibleCount = group.models.filter((m) => !hidden.has(hiddenModelKey(profileId, m.modelId))).length;
            const collapsed = collapsedGroups[profileId] ?? true;
            return (
              <div key={profileId} style={{ marginBottom: 8 }}>
                {/* The whole header line is the toggle, so it is a real
                    <button>: focusable, Enter/Space-activated, and it announces
                    its own state through aria-expanded. */}
                <button
                  type="button"
                  className="model-group-header-no-before"
                  aria-expanded={!collapsed}
                  title={collapsed ? `Expand ${group.profileName}` : `Collapse ${group.profileName}`}
                  onClick={() => toggleGroup(profileId)}
                >
                  {/* Same chevron the Settings sections use, with the same
                      rotation: down when open, rotated to point right when
                      collapsed. The old glyph was a filled triangle that
                      pointed right while expanded and up while collapsed —
                      both states read as the opposite of what they meant. */}
                  <svg
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    aria-hidden
                    style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
                  >
                    <path d="M4.5 6L8 9.5 11.5 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="model-group-name">{group.profileName}</span>
                  <span className={cn('model-group-variant', `variant-${group.apiVariant}`)}>
                    {group.apiVariant === 'anthropic' ? 'Anthropic' : group.apiVariant === 'gemini' ? 'Gemini REST' : group.apiVariant === 'lm-studio' ? 'REST' : (group.apiStyle === 'responses' ? 'OpenAI/R' : 'OpenAI/CC')}
                  </span>
                  <span className="dim" style={{ marginLeft: 'auto', fontSize: 11 }}>
                    {visibleCount}/{group.models.length} visible
                  </span>
                </button>
                {!collapsed && (
                  <div style={{ paddingLeft: 16 }}>
                    <div className="model-profile-toolbar">
                      <div className="model-profile-toolbar-group">
                        <button
                          className="ghost-btn small"
                          onClick={() => useModelVisibility.getState().showAllForProfile(profileId, group.models.map((m) => m.modelId))}
                        >
                          Show all
                        </button>
                        <button
                          className="ghost-btn small"
                          onClick={() => useModelVisibility.getState().hideAllForProfile(profileId, group.models.map((m) => m.modelId))}
                        >
                          Hide all
                        </button>
                      </div>
                      <div className="model-profile-toolbar-group model-profile-toolbar-actions">
                        <button
                          className="ghost-btn small"
                          disabled={busyProfileId === profileId || syncingAll}
                          onClick={() => restoreDefaults(profileId, group.profileName)}
                        >
                          Reset
                        </button>
                        <button
                          className="ghost-btn small"
                          disabled={busyProfileId === profileId || syncingAll}
                          onClick={() => fetchProfileModels(profileId)}
                        >
                          {busyProfileId === profileId ? '…' : 'Fetch'}
                        </button>
                        <button
                          className="primary-btn small"
                          disabled={busyProfileId === profileId || syncingAll}
                          onClick={() => setEditorTarget({ profileId })}
                        >
                          Add
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                      {group.models.map((m) => (
                        <ModelRow
                          key={m.modelId}
                          profileId={profileId}
                          row={m}
                          isHidden={hidden.has(hiddenModelKey(profileId, m.modelId))}
                          deleteMode={shiftHeld}
                          onEdit={() => setEditorTarget({ profileId, recordKey: m.record.key })}
                          onDelete={() => deleteModel(m.record)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {profiles.length === 0 && <p className="muted">Add a server profile before managing models.</p>}
        </div>
      </div>
      {editorTarget && (!editorTarget.recordKey || editingRecord) && (
        <ModelEditor
          profileId={editorTarget.profileId}
          record={editingRecord}
          records={records}
          onClose={() => setEditorTarget(null)}
        />
      )}
    </div>
  );
}

/**
 * One compact row:  [checkbox] name … [eye][brain][tools] [128k] [edit]
 *
 * The Edit button is deliberately a sibling of the `<label>`, not a child of
 * it: a button nested inside a label steals the label's click and toggles the
 * checkbox on its way through. The checkbox is bound with `htmlFor` instead.
 */
function ModelRow({ profileId, row, isHidden, deleteMode, onEdit, onDelete }: {
  profileId: string;
  row: GroupRow;
  isHidden: boolean;
  deleteMode: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { effective } = row.record;
  const inputId = `model-vis-${profileId}-${row.modelId}`;
  const ctx = effective.maxContextLength;
  return (
    <div className="model-vis-row">
      <input
        id={inputId}
        type="checkbox"
        checked={!isHidden}
        onChange={() => useModelVisibility.getState().toggle(profileId, row.modelId)}
      />
      <label
        htmlFor={inputId}
        className="model-vis-name"
        style={{ opacity: isHidden ? 0.4 : 1 }}
        title={row.modelId}
      >
        {row.displayName}
      </label>
      <span className="model-vis-caps">
        {effective.capabilities.vision === true && <ModelCapabilityBadge kind="vision" />}
        {effective.capabilities.reasoning === true && <ModelCapabilityBadge kind="reasoning" />}
        {effective.capabilities.tools === true && <ModelCapabilityBadge kind="tools" />}
      </span>
      {/* Same badge and same fixed-width lane the chat model picker uses, so a
          context window reads identically on both surfaces. */}
      <span className="model-ctx-lane">
        {ctx && ctx > 0
          ? <span className="model-ctx-badge" title="Context window">{formatCtx(ctx)}</span>
          : <span className="model-ctx-badge unknown" title="Context window unknown">?</span>}
      </span>
      <button
        type="button"
        className={cn('icon-btn', 'xs', 'model-vis-edit', deleteMode && 'danger')}
        aria-label={`${deleteMode ? 'Delete' : 'Edit'} ${row.displayName}`}
        title={`${deleteMode ? 'Delete' : 'Edit'} ${row.displayName}${deleteMode ? '' : ' (hold Shift to delete)'}`}
        onClick={(event) => {
          if (event.shiftKey) onDelete();
          else onEdit();
        }}
      >
        {deleteMode ? (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6.5 7l1 13h9l1-13" /><path d="M10 11v5M14 11v5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3z" />
            <path d="M13.5 6.5l4 4" />
          </svg>
        )}
      </button>
    </div>
  );
}

/** Tri-state capability value. `undefined` = inherit/unknown — deliberately distinct
 *  from `false`, so unknown metadata is never silently saved as an explicit No. */
type TriState = boolean | undefined;

interface FormState {
  displayName: string;
  modelId: string;
  context: string;
  vision: TriState;
  reasoning: TriState;
  tools: TriState;
}

function formFromRecord(record: ModelRegistryRecord | undefined): FormState {
  const model = record?.effective;
  return {
    displayName: model?.displayName ?? '',
    modelId: record?.modelId ?? '',
    context: model?.maxContextLength !== undefined ? String(model.maxContextLength) : '',
    vision: model?.capabilities.vision,
    reasoning: model?.capabilities.reasoning,
    tools: model?.capabilities.tools,
  };
}

/**
 * Shared Add/Edit model editor. Rendered as a child component so
 * `useOverlayEscape(..., true)` exists only while it is mounted — it is the
 * innermost overlay for exactly as long as it is on screen.
 */
function ModelEditor({ profileId, record, records, onClose }: {
  profileId: string;
  record?: ModelRegistryRecord;
  records: ModelRegistryRecord[];
  onClose: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => formFromRecord(record));
  const [guessing, setGuessing] = useState(false);
  const headingId = 'model-meta-editor-title';
  const errorId = 'model-meta-context-error';
  const nameRef = useRef<HTMLInputElement | null>(null);

  useOverlayEscape(onClose);

  // Initial focus into the dialog, and focus restoration to whatever opened
  // it (the row's Edit button) when it unmounts.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    nameRef.current?.focus();
    return () => { opener?.focus?.(); };
  }, []);

  const detected = record?.detected;
  const detectedCtx = detected?.maxContextLength;
  const displayName = form.displayName.trim();
  const modelId = form.modelId.trim();
  const trimmed = form.context.trim();
  const parsedContext = trimmed === '' ? undefined : Number(trimmed);
  const contextInvalid = trimmed !== '' && !isValidContextOverride(parsedContext);
  const identityInvalid = !displayName || !modelId;
  const showIdentityError = identityInvalid && (!!form.displayName || !!form.modelId);
  const duplicate = records.some((item) =>
    item.profileId === profileId && item.modelId === modelId && item.key !== record?.key);

  const setCapability = (field: 'vision' | 'reasoning' | 'tools', value: TriState) =>
    setForm((f) => ({ ...f, [field]: value }));

  const save = () => {
    if (contextInvalid || identityInvalid || duplicate) return;
    const store = useAppModels.getState();
    const custom: CustomModelDefinition = {
      n: displayName,
      ...(parsedContext !== undefined ? { c: parsedContext } : {}),
      ...(form.vision !== undefined ? { v: form.vision } : {}),
      ...(form.reasoning !== undefined ? { r: form.reasoning } : {}),
      ...(form.tools !== undefined ? { t: form.tools } : {}),
    };

    if (!record) {
      store.addCustomModel(profileId, modelId, custom);
    } else if (record.origin === 'manual') {
      const wasHidden = useModelVisibility.getState().isHidden(profileId, record.modelId);
      store.updateCustomModel(profileId, record.modelId, modelId, custom);
      if (record.modelId !== modelId) {
        useModelVisibility.getState().show(profileId, record.modelId);
        if (wasHidden) useModelVisibility.getState().hide(profileId, modelId);
      }
    } else if (modelId !== record.modelId) {
      // A server model's ID is its routing identity. Editing it therefore
      // suppresses the old server entry and creates a manual replacement.
      store.deleteModel(profileId, record.modelId);
      useModelVisibility.getState().show(profileId, record.modelId);
      store.addCustomModel(profileId, modelId, custom);
    } else {
      // Keep fetched metadata as the detected layer and persist only fields
      // that differ. Future fetches can still improve every inherited field.
      const next: ModelMetaOverride = {};
      if (displayName !== detected?.displayName) next.n = displayName;
      if (parsedContext !== undefined && parsedContext !== detectedCtx) next.c = parsedContext;
      if (form.vision !== undefined && form.vision !== detected?.capabilities.vision) next.v = form.vision;
      if (form.reasoning !== undefined && form.reasoning !== detected?.capabilities.reasoning) next.r = form.reasoning;
      if (form.tools !== undefined && form.tools !== detected?.capabilities.tools) next.t = form.tools;
      if (Object.keys(next).length === 0) store.removeMetadataOverride(profileId, record.modelId);
      else store.setMetadataOverride(profileId, record.modelId, next);
    }
    toast.success(record ? 'Model saved.' : 'Model added.');
    onClose();
  };

  const guess = async () => {
    setGuessing(true);
    try {
      if (!modelId) {
        toast.info('Enter a model ID before guessing.');
        return;
      }
      const profile = useProfileStore.getState().profiles.find((p) => p.id === profileId);
      const meta = await guessModelMeta(profile?.baseUrl ?? '', modelId);
      if (!meta) {
        toast.info("Sorry, couldn't guess.");
        return;
      }
      // Fill only. Guess never writes the override and never toasts on a hit —
      // the user still has to look at what it proposed and press Save.
      //
      // Per field, and nullish: a field models.dev has no opinion about (absent
      // here, and `null` on the Tauri wire) must leave the form exactly as the
      // user left it. Overwriting it with `false` would let Save persist an
      // explicit "No" that nobody ever asserted.
      setForm((f) => ({
        ...f,
        displayName: meta.display_name ?? f.displayName,
        context: meta.context_window !== undefined && meta.context_window !== null
          ? String(meta.context_window)
          : f.context,
        vision: meta.capabilities?.vision ?? f.vision,
        reasoning: meta.capabilities?.reasoning ?? f.reasoning,
        tools: meta.capabilities?.tools ?? f.tools,
      }));
    } catch {
      toast.info("Sorry, couldn't guess.");
    } finally {
      setGuessing(false);
    }
  };

  return (
    <div
      className="server-editor-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="server-editor-card model-meta-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        style={{ maxWidth: 420 }}
      >
        <div className="section-head">
          <h3 id={headingId}>{record ? 'Edit model' : 'Add a model'}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close model editor" style={{ marginLeft: 'auto' }}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="model-editor-identity">
          <label className="model-meta-field">
            <span>Display name</span>
            <input
              ref={nameRef}
              type="text"
              autoComplete="off"
              value={form.displayName}
              aria-invalid={!displayName || undefined}
              placeholder="GLM 5.3"
              onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
            />
          </label>
          <label className="model-meta-field">
            <span>Model ID</span>
            <input
              type="text"
              autoComplete="off"
              value={form.modelId}
              aria-invalid={!modelId || duplicate || undefined}
              placeholder="glm-5.3"
              onChange={(event) => setForm((current) => ({ ...current, modelId: event.target.value }))}
            />
          </label>
        </div>
        {showIdentityError && <p className="model-meta-error">Display name and model ID are required.</p>}
        {duplicate && <p className="model-meta-error">That model ID already exists in this profile.</p>}

        <label className="model-meta-field">
          <span>Context window</span>
          {/* A plain text line with a numeric keypad hint, matching the other
              numeric fields in Settings (auto-archive days, max web fetch).
              `type="number"` drew spinner arrows nothing else in LC has, and
              it hijacks the mouse wheel. Validation is unchanged: the value is
              still required to be a positive safe integer, Save is blocked
              while it is not, and the inline error below says so. */}
          <input
            id="model-meta-context"
            name="contextWindow"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            value={form.context}
            aria-invalid={contextInvalid || undefined}
            aria-describedby={contextInvalid ? errorId : undefined}
            onChange={(e) => setForm((f) => ({ ...f, context: e.target.value }))}
            placeholder={String(detectedCtx && detectedCtx > 0 ? detectedCtx : UNKNOWN_CONTEXT_PLACEHOLDER)}
          />
        </label>
        {contextInvalid && (
          <p id={errorId} role="alert" className="model-meta-error">
            Enter a whole number of tokens greater than zero, or leave it empty for unknown/default.
          </p>
        )}
        <p className="muted small" style={{ margin: '2px 0 18px 0' }}>
          {record?.origin === 'manual' || !record ? 'Optional for manually configured models.' : 'Empty inherits the server value.'}
        </p>

        <TriStateRow label="Vision" value={form.vision} onChange={(v) => setCapability('vision', v)} detected={detected?.capabilities.vision} manual={!record || record.origin === 'manual'} />
        <TriStateRow label="Reasoning" value={form.reasoning} onChange={(v) => setCapability('reasoning', v)} detected={detected?.capabilities.reasoning} manual={!record || record.origin === 'manual'} />
        <TriStateRow label="Tools" value={form.tools} onChange={(v) => setCapability('tools', v)} detected={detected?.capabilities.tools} manual={!record || record.origin === 'manual'} />

        <div className="form-actions">
          <button
            type="button"
            className="ghost-btn small"
            style={{ marginRight: 'auto' }}
            onClick={() => setForm(record ? {
              displayName: record.detected.displayName,
              modelId: record.modelId,
              context: record.detected.maxContextLength !== undefined ? String(record.detected.maxContextLength) : '',
              vision: record.detected.capabilities.vision,
              reasoning: record.detected.capabilities.reasoning,
              tools: record.detected.capabilities.tools,
            } : formFromRecord(undefined))}
          >
            Reset
          </button>
          <button type="button" className="ghost-btn small" onClick={guess} disabled={guessing}>
            {guessing ? '…' : 'Guess'}
          </button>
          <button type="button" className="primary-btn small" onClick={save} disabled={contextInvalid || identityInvalid || duplicate}>
            {record ? 'Save' : 'Add model'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Default/Unknown / Yes / No radio group for one capability. */
function TriStateRow({ label, value, onChange, detected, manual }: {
  label: string;
  value: TriState;
  onChange: (value: TriState) => void;
  detected: boolean | undefined;
  manual: boolean;
}) {
  const options: Array<{ key: string; label: string; value: TriState }> = [
    { key: 'inherit', label: manual ? 'Unknown' : 'Default', value: undefined },
    { key: 'yes', label: 'Yes', value: true },
    { key: 'no', label: 'No', value: false },
  ];
  const detectedLabel = detected === undefined ? 'unknown' : detected ? 'Yes' : 'No';
  return (
    <div className="model-meta-tristate" role="group" aria-label={`${label} (${manual ? 'manual' : `detected: ${detectedLabel}`})`}>
      <span className="model-meta-tristate-label">{label}</span>
      <div className="zoom-chips">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            className={cn('chip', 'small', value === o.value && 'active')}
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {!manual && <span className="dim model-meta-detected">detected: {detectedLabel}</span>}
    </div>
  );
}
