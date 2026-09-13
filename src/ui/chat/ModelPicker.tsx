import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useProfileStore } from '../../modules/server-profiles/index.ts';
import {
  isConversationStructurallyLocked,
  ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE,
  isAnyStreaming,
  isGenerationBlockingOperationActive,
  markModelOperation,
  unmarkModelOperation,
  useConversations,
} from '../../store/conversations.ts';
import { errorMessage } from '../../modules/llm-client/index.ts';
import { createLMStudioModelClient, useAppModels, type AppModelEntry } from '../../modules/server-profiles/index.ts';
import { cn } from '../../utils/cn.ts';
import { debugLog } from '../../utils/debug.ts';
import { toast } from '../../utils/toast.ts';
import { safeConfirm } from '../../utils/safeConfirm.ts';
import { useModelVisibility } from '../../store/modelVisibility.ts';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';
import { useShiftHeld } from './use-shift-held.ts';
import { formatCtx } from '../../utils/formatCtx.ts';
import { endpointForProfile, endpointLetter, endpointTone } from '../../utils/reply-meta.ts';
import { ModelCapabilityBadge } from '../shared/ModelCapabilityIcons.tsx';

interface Props {
  compact?: boolean;
}

function apiVariantLabel(v: string, style?: string): string {
  if (v === 'anthropic') return 'Anthropic';
  if (v === 'gemini') return `Gemini REST · ${endpointLetter('/interactions')}`;
  if (v === 'lm-studio') return `REST · ${endpointLetter('/chat')}`;
  return style === 'responses' ? 'OpenAI/R' : 'OpenAI/CC';
}

/**
 * The context window that actually applies right now: the length a local
 * server loaded the model with, or the declared window when nothing is
 * loaded. The row used to print both as `loaded/max`, which read as two
 * competing ceilings — only one of them is ever in force.
 */
function currentCtx(m: Pick<AppModelEntry, 'loadedContextLength' | 'maxContextLength'>): number | undefined {
  return m.loadedContextLength || m.maxContextLength || undefined;
}

type ModelRowActionKind = 'load' | 'unload' | 'refresh' | 'hide';

const ACTION_ICON: Record<ModelRowActionKind, ReactNode> = {
  // Play / stop, borrowed from transport controls: loading a model starts
  // something running on the server, unloading stops it. Refresh keeps the
  // arrow the rest of the picker already uses for "fetch again".
  load: <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden><path fill="currentColor" d="M8 5.14v13.72L19 12z" /></svg>,
  unload: <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" /></svg>,
  refresh: <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden><path fill="currentColor" d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" /></svg>,
  // The vision eye with a slash through it. Reusing that exact outline is
  // deliberate: the glyph the row already uses to mean "can see" is the one
  // that, struck through, reads as "hide this from the picker".
  hide: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M3.5 20.5 20.5 3.5" />
    </svg>
  ),
};

/**
 * The per-row action. Icon-only, so the accessible name lives in `aria-label`
 * — which is also what keeps every row's action the same width, and the badge
 * cluster beside it aligned. `hint` is the hover text, kept short and free of
 * the model id the `aria-label` carries for screen readers.
 *
 * `shiftOnly` guards the destructive-by-surprise case: hiding a model makes
 * its row vanish from under the cursor, in a list the user is mid-scan of. A
 * bare click there would be too easy to fire by accident on a row the user
 * only meant to select, so the modifier is the whole gesture — and an
 * unmodified click says so rather than doing nothing at all, since a button
 * that silently ignores a click reads as broken.
 */
function ModelRowAction({ kind, busy, disabled, label, hint, shiftOnly, onClick, onShiftClick }: {
  kind: ModelRowActionKind;
  busy: boolean;
  disabled: boolean;
  label: string;
  hint?: string;
  shiftOnly?: boolean;
  onClick: () => void;
  onShiftClick?: () => void;
}) {
  const title = disabled ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE : (hint ?? label);
  return (
    <button
      type="button"
      className={cn('icon-btn', 'xs', kind === 'unload' ? 'danger' : kind === 'hide' ? 'model-row-hide' : 'accent')}
      aria-label={label}
      title={title}
      disabled={busy || disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (shiftOnly && !e.shiftKey) {
          toast.info("Hold 'Shift' to activate 'Hide' button");
          return;
        }
        if (e.shiftKey && onShiftClick) {
          onShiftClick();
          return;
        }
        onClick();
      }}
    >
      {busy
        ? <span className="model-row-action-busy" aria-hidden>…</span>
        : ACTION_ICON[kind]}
    </button>
  );
}

/**
 * Whether the conversation on screen refuses configuration changes.
 *
 * Scoped to the selection rather than to the application: a chat the user
 * switched to during another conversation's run is fully configurable. Only
 * actions that can invalidate *any* live generation — model load/unload,
 * global model visibility, server refresh, profile mutation — keep a blanket
 * guard.
 */
function isSelectedConversationLocked(): boolean {
  const activeId = useConversations.getState().activeId;
  return activeId ? isConversationStructurallyLocked(activeId) : false;
}

export function ModelPicker({ compact }: Props) {
  // Use the conversation's server for
  // profile info, fall back to first toggled-on for empty-state display.
  const profiles = useProfileStore((s) => s.profiles);
  const activeConvId = useConversations((s) => s.activeId);
  const conv = useConversations((s) => (s.activeId ? s.byId[s.activeId] : null));
  // Configuration follows the selected conversation; only application-wide
  // model operations below keep a blanket guard.
  const generationLocked = useConversations((s) => (
    s.activeId ? isConversationStructurallyLocked(s.activeId) : false
  ));
  const applicationOperationLocked = useConversations(() => (
    isAnyStreaming() || isGenerationBlockingOperationActive()
  ));
  const profile = useProfileStore((s) =>
    s.profiles.find((p) => p.id === conv?.serverId)
    ?? s.profiles.find((p) => p.active),
  );

  // All models from the global store.
  const allModels = useAppModels((s) => s.models);
  const storeLoading = useAppModels((s) => s.loading);
  const storeError = useAppModels((s) => s.error);
  const storeRefresh = useAppModels((s) => s.refresh);

  // Reactive subscription to hidden models — used by visibleModels
  // useMemo so the dropdown re-renders when visibility changes.
  const hiddenModels = useModelVisibility((s) => s.hidden);

  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [filters, setFilters] = useState<Record<string, boolean>>({ loaded: true });
  // Live Shift state, so a load/unload row can swap its action to Hide while
  // the key is down. Tracked rather than read off each click event because the
  // swap has to be visible *before* the click — the modifier is what tells the
  // user the button in front of them means something else right now.
  const shiftHeld = useShiftHeld(open);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Auto-select a model for the conversation when models arrive.
  // Only fires when the conversation has NO model yet — never
  // overwrites a user-pinned model on chat switch or reload.
  // Respects model visibility: skips hidden models so the picker
  // never auto-selects a model the user explicitly hid.
  const autoSelectRef = useRef(false);
  useEffect(() => {
    const cid = useConversations.getState().activeId;
    const c = cid ? useConversations.getState().byId[cid] : null;
    if (!cid || !c || allModels.length === 0) return;
    if (isConversationStructurallyLocked(cid)) return;
    if (autoSelectRef.current || c.model) return;
    autoSelectRef.current = true;

    const hidden = useModelVisibility.getState().hidden;
    const visibleModels = allModels.filter(m => !hidden.has(`${m.profileId}:${m.id}`));
    if (visibleModels.length === 0) return; // all models are hidden — nothing to auto-select
    const loadedAny = visibleModels.find(m => m.state === 'loaded');
    const entry = loadedAny ?? visibleModels[0];
    // The token meter reads its ceiling from the registry by
    // profileId + modelId, so there is nothing to push here.
    // Update serverId so send() routes to the correct profile.
    if (c.serverId !== entry.profileId) {
      useConversations.getState().patchConversation(cid, { serverId: entry.profileId });
    }
    useConversations.getState().setModel(cid, entry.id);
  }, [allModels, activeConvId]);

  // Reset auto-select flag when conversation changes.
  useEffect(() => {
    autoSelectRef.current = false;
  }, [activeConvId]);

  // Escape closes the picker, only while it is the innermost overlay. Joining
  // the stack also stops the key leaking onward: the hook stops propagation in
  // the capture phase, so the global handler never runs and closing this
  // dropdown no longer closes the side panel and steals focus with it.
  useOverlayEscape(() => setOpen(false), open);

  useEffect(() => {
    if (!open) { setHighlightedIndex(-1); return; }
    const onClick = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    requestAnimationFrame(() => document.getElementById('model-search')?.focus());
    return () => { document.removeEventListener('mousedown', onClick); };
  }, [open]);

  useEffect(() => {
    if (highlightedIndex >= 0) document.getElementById(`model-row-${highlightedIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'm' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) { e.preventDefault(); setOpen(o => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Search index: one blob string per model for fast filtering. */
  const searchBlobs = useMemo(() => {
    const blobs = new Map<string, string>();
    for (const m of allModels) {
      const key = `${m.profileId}:${m.id}`;
      const parts: string[] = [m.id.toLowerCase(), m.displayName.toLowerCase()];
      const ctx = currentCtx(m);
      if (ctx) parts.push(formatCtx(ctx).toLowerCase());
      if (m.capabilities.vision) parts.push('vision', 'image');
      if (m.capabilities.reasoning) parts.push('reasoning', 'thinking');
      if (m.capabilities.tools) parts.push('tools');
      parts.push(m.profileName.toLowerCase());
      blobs.set(key, parts.join(' '));
    }
    return blobs;
  }, [allModels]);

  /** Filtered + sorted subset for the current query and capability chips. */
  const visibleModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    // The store already dedupes by profile:id, but be safe.
    const uniq = [...new Map(allModels.map(m => [`${m.profileId}:${m.id}`, m])).values()];
    let filtered = q
      ? uniq.filter(m => (searchBlobs.get(`${m.profileId}:${m.id}`) ?? '').includes(q))
      : uniq.slice();

    // Exclude hidden models (reactive — re-computes when visibility changes).
    filtered = filtered.filter(m => !hiddenModels.has(`${m.profileId}:${m.id}`));

    // Capability / state filters (AND logic).
    if (filters.loaded) filtered = filtered.filter(m => m.state === 'loaded' || m.state === undefined);
    if (filters.reasoning) filtered = filtered.filter(m => m.capabilities.reasoning);
    if (filters.vision) filtered = filtered.filter(m => m.capabilities.vision === true);
    if (filters.tools) filtered = filtered.filter(m => m.capabilities.tools === true);

    filtered.sort((a, b) => {
      const al = a.state === 'loaded' ? 0 : 1;
      const bl = b.state === 'loaded' ? 0 : 1;
      if (al !== bl) return al - bl;
      if (a.profileName !== b.profileName) return a.profileName.localeCompare(b.profileName);
      return a.id.localeCompare(b.id);
    });
    return filtered;
  }, [allModels, searchBlobs, query, filters, hiddenModels]);

  /** Group visible models by profile for section headers. */
  const grouped = useMemo(() => {
    const map = new Map<string, AppModelEntry[]>();
    for (const m of visibleModels) {
      const k = m.profileId;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(m);
    }
    return map;
  }, [visibleModels]);

  /** Find the current model in the available list, matching on both
   *  profileId and modelId (composite key). Falls back to the first
   *  available VISIBLE model if the conversation's model/server pair
   *  isn't found or the stored model is hidden. */
  const cur = useMemo(() => {
    const match = allModels.find(m => m.profileId === conv?.serverId && m.id === conv?.model);
    // If the stored model exists and is NOT hidden, use it.
    if (match && !hiddenModels.has(`${match.profileId}:${match.id}`)) return match;
    // Fall back to first visible model.
    return allModels.find(m => !hiddenModels.has(`${m.profileId}:${m.id}`));
  }, [allModels, conv?.serverId, conv?.model, hiddenModels]);
  const value = cur?.id ?? '';
  const isLoaded = cur ? (cur.state === undefined || cur.state === 'loaded') : false;
  // The collapsed trigger has room for the model name and one short tag. It
  // names the API surface rather than the context window: the surface is what
  // the reply footer's model chip also reports, so the two agree at a glance.
  const curEndpoint = cur ? endpointForProfile(cur.apiVariant, cur.apiStyle) : undefined;

  const selectModel = useCallback((profileId: string, modelId: string): boolean => {
    if (isSelectedConversationLocked()) {
      toast.info(ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE);
      return false;
    }
    const entry = allModels.find(m => m.profileId === profileId && m.id === modelId);
    if (!entry) return false;
    const cid = useConversations.getState().activeId;
    if (cid) {
      const conv = useConversations.getState().byId[cid];
      // Update the conversation's
      // serverId so ChatView routes to the correct profile.
      if (conv && conv.serverId !== entry.profileId) {
        debugLog.log('[LC] ModelPicker: updating conversation', cid, 'serverId from', conv.serverId, '→', entry.profileId);
        useConversations.getState().patchConversation(cid, { serverId: entry.profileId });
      }
      useConversations.getState().setModel(cid, modelId);
    }
    return true;
  }, [allModels]);

  const onLoad = useCallback(async (entry: AppModelEntry) => {
    if (isAnyStreaming() || isGenerationBlockingOperationActive()) return;
    const busyKey = `${entry.profileId}:${entry.id}`;
    let operationId: string | undefined;
    setBusyId(busyKey);
    try {
      operationId = markModelOperation('load', entry.id).operationId;
      const client = await createLMStudioModelClient(`${entry.profileId}::${entry.id}`);
      if (!client) throw new Error('The model server profile is unavailable.');
      await client.loadModel(entry.id);
      await storeRefresh();
      if (!activeConvId) selectModel(entry.profileId, entry.id);
      toast.success(`Loaded ${entry.id}`);
    } catch (e) { toast.error(`Load failed: ${errorMessage(e)}`); }
    finally {
      if (operationId) unmarkModelOperation(operationId);
      setBusyId(null);
    }
  }, [storeRefresh, activeConvId, selectModel]);

  const onUnload = useCallback(async (entry: AppModelEntry) => {
    if (isAnyStreaming() || isGenerationBlockingOperationActive()) return;
    const inst = entry.loadedInstances?.[0]?.id;
    if (!inst) { toast.error(`Cannot unload "${entry.id}" — no active instance.`); return; }
    if (!(await safeConfirm(`Unload "${entry.id}"?`))) return;
    const busyKey = `${entry.profileId}:${entry.id}`;
    let operationId: string | undefined;
    setBusyId(busyKey);
    try {
      operationId = markModelOperation('unload', entry.id).operationId;
      const client = await createLMStudioModelClient(`${entry.profileId}::${entry.id}`);
      if (!client) throw new Error('The model server profile is unavailable.');
      await client.unloadModel(inst);
      await storeRefresh();
      toast.success(`Unloaded ${entry.id}`);
    } catch (e) { toast.error(`Unload failed: ${errorMessage(e)}`); }
    finally {
      if (operationId) unmarkModelOperation(operationId);
      setBusyId(null);
    }
  }, [storeRefresh]);

  /** Hide one model from every picker — the same store, and the same key,
   *  that the Manage-model-visibility checkbox writes, so that panel shows
   *  the model unchecked and is where it gets restored from. */
  const onHide = useCallback((entry: AppModelEntry) => {
    if (isAnyStreaming() || isGenerationBlockingOperationActive()) return;
    useModelVisibility.getState().hide(entry.profileId, entry.id);
    toast.info(`Hid ${entry.id} — restore it in Settings → Manage models.`);
  }, []);

  const onRefreshProfile = useCallback(async (profileId: string) => {
    if (isAnyStreaming() || isGenerationBlockingOperationActive()) return;
    await useAppModels.getState().refreshServer(profileId);
  }, []);

  // ---- empty / loading / error states ----

  if (storeLoading && allModels.length === 0) return <span className="model-picker loading">Loading models…</span>;
  if (storeError && allModels.length === 0) {
    return (
      <button
        className="model-picker error ghost"
        onClick={() => {
          if (isAnyStreaming() || isGenerationBlockingOperationActive()) return;
          void storeRefresh();
        }}
        disabled={applicationOperationLocked}
        title={applicationOperationLocked
          ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE
          : `${storeError} — click to retry`}
      >
        Can't reach server — retry?
      </button>
    );
  }

  const noProfile = !profile;
  const hasProfiles = profiles.length > 0;
  const noModels = allModels.length === 0;

  if (noProfile || noModels) {
    const emptyLabel = noProfile
      ? (hasProfiles ? 'No server selected' : 'No server')
      : 'No models';

    const emptyTitle = noProfile
      ? (hasProfiles
          ? 'Select a server profile in Settings or set one as active.'
          : 'Add a server profile in Settings to get started.')
      : 'No server is online.' ;

    return (
      <div className={cn('model-picker', compact && 'compact', open && 'open')} ref={popRef}>
        <button
          className="model-picker-trigger empty"
          onClick={() => setOpen(o => !o)}
          title="No models available"
        >
          <span className="dot unreachable" />
          <span className="current-name dim">{emptyLabel}</span>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden className="chev"><path fill="currentColor" d="M7 10l5 5 5-5z" /></svg>
        </button>
        {open && (
          <div className="model-picker-pop model-picker-empty-pop">
            <div className="model-picker-empty-msg">
              <p>{emptyTitle}</p>
              <button
                className="ghost-btn small"
                onClick={() => {
                  setOpen(false);
                  window.dispatchEvent(new CustomEvent('lc:open-settings'));
                }}
              >
                Open Settings
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- render ----

  let rowIdx = -1;

  return (
    <div className={cn('model-picker', compact && 'compact', open && 'open')} ref={popRef}>
      <button
        className="model-picker-trigger"
        onClick={() => setOpen(o => !o)}
        title={generationLocked ? 'View models — selection is locked while responding' : 'Pick a model'}
      >
        <span className={cn('dot', isLoaded ? 'loaded' : 'unloaded')} />
        <span className="current-name" title={value}>{value}</span>
        {curEndpoint && (
          <span
            className={cn('endpoint', `endpoint-${endpointTone(curEndpoint)}`)}
            title={`Endpoint — ${curEndpoint}`}
          >
            {endpointLetter(curEndpoint)}
          </span>
        )}
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden className="chev"><path fill="currentColor" d="M7 10l5 5 5-5z" /></svg>
      </button>
      {open && (
        <div className={cn('model-picker-pop', shiftHeld && 'shift-armed')}>
          <div className="model-picker-head">
            <div className="model-filter-chips" style={{ flexShrink: 0 }}>
              {(['loaded','vision','reasoning','tools'] as const).map(f => (
                <button
                  key={f}
                  type="button"
                  className={cn('chip', 'small', filters[f] && 'active')}
                  onClick={() => setFilters(prev => ({ ...prev, [f]: !prev[f] }))}
                >
                  {f === 'loaded' ? 'Loaded' : f === 'reasoning' ? 'Reasoning' : f === 'vision' ? 'Vision' : 'Tools'}
                </button>
              ))}
            </div>
            <input id="model-search" name="modelSearch" type="text" className="model-picker-search" placeholder="Search…"
              value={query} onChange={e => { setQuery(e.target.value); setHighlightedIndex(-1); }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightedIndex(i => Math.min(i + 1, visibleModels.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightedIndex(i => Math.max(i - 1, 0)); }
                else if (e.key === 'Enter' && highlightedIndex >= 0 && highlightedIndex < visibleModels.length) {
                  e.preventDefault();
                  const m = visibleModels[highlightedIndex];
                  if (selectModel(m.profileId, m.id)) setOpen(false);
                }
              }} />
            {query && <button className="icon-btn small" onClick={() => setQuery('')} title="Clear search" aria-label="Clear search" type="button">×</button>}
            <div style={{ flexShrink: 0 }}>
              <button
                className="icon-btn small"
                onClick={async () => {
                  if (isAnyStreaming() || isGenerationBlockingOperationActive()) return;
                  // `refresh()` never rejects per-profile failures (they fall
                  // back to cache), so the verdict is read back from the store
                  // afterwards: the store error, or an active profile set with
                  // not one reachable server, is a fail.
                  try {
                    await storeRefresh();
                  } catch {
                    toast.error('Model refresh failed');
                    return;
                  }
                  const { error, serverHealth } = useAppModels.getState();
                  const activeIds = profiles.filter((p) => p.active).map((p) => p.id);
                  const anyReachable = activeIds.some((id) => serverHealth[id] === 'reachable');
                  if (error || (activeIds.length > 0 && !anyReachable)) toast.error('Model refresh failed');
                  else toast.success('Models refreshed');
                }}
                title={applicationOperationLocked ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE : 'Refresh all servers'}
                disabled={storeLoading || applicationOperationLocked}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden><path fill="currentColor" d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" /></svg>
              </button>
            </div>
          </div>
          <ul className="model-list">
            {[...grouped.entries()].map(([pid, group]) => (
              <li key={pid}>
                <div className="model-group-header">
                  <span className="model-group-name">{group[0].profileName}</span>
                  <span className={cn('model-group-variant', `variant-${group[0].apiVariant}`)}>{apiVariantLabel(group[0].apiVariant, group[0].apiStyle)}</span>
                </div>
                {group.map(m => {
                  const idx = ++rowIdx;
                  const loaded = m.state === undefined || m.state === 'loaded';
                  const loading_ = m.state === 'loading';
                  const unreachable = m.state === 'unreachable';
                  const isLocal = m.state !== undefined && m.state !== 'unreachable';
                  const isCur = m.profileId === cur?.profileId && m.id === value;
                  const busy = busyId === `${m.profileId}:${m.id}`;
                  const canReason = m.capabilities.reasoning;
                  const hasVision = m.capabilities.vision === true;
                  const hasTools = m.capabilities.tools === true;
                  const ctx = currentCtx(m);
                  const endpoint = endpointForProfile(m.apiVariant, m.apiStyle);
                  return (
                    <div
                      key={`${m.profileId}:${m.id}`}
                      id={`model-row-${idx}`}
                      className={cn('model-row', isCur && 'current', highlightedIndex === idx && 'highlighted', generationLocked && 'generation-config-locked')}
                      aria-disabled={generationLocked || undefined}
                      title={generationLocked ? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE : undefined}
                      onClick={() => {
                        if (selectModel(m.profileId, m.id)) setOpen(false);
                      }}
                    >
                      {/* Flat single line, laid out like a model-visibility row:
                          the name takes the slack so the badge cluster and the
                          action settle against the right edge at the same x on
                          every row. That alignment is what the fixed-width
                          action slot below is for — a row with no action still
                          reserves it. */}
                      <span className={cn('dot', unreachable ? 'unreachable' : loaded ? 'loaded' : loading_ ? 'loading' : 'unloaded')} />
                      <div className="model-name model-name-with-endpoint" title={m.id}>
                        <span className="model-name-label">{m.id}</span>
                        <span className={`protocol-letter endpoint-${endpointTone(endpoint)}`} title={`Endpoint — ${endpoint}`}>
                          {endpointLetter(endpoint)}
                        </span>
                      </div>
                      {loading_ && <span className="model-status loading">loading…</span>}
                      {!canReason && !hasVision && !hasTools && !loaded && !loading_ && <span className="model-status unloaded">not loaded</span>}
                      {(canReason || hasVision || hasTools) && (
                        <span className="model-row-caps">
                          {hasVision && <ModelCapabilityBadge kind="vision" />}
                          {canReason && <ModelCapabilityBadge kind="reasoning" />}
                          {hasTools && <ModelCapabilityBadge kind="tools" />}
                        </span>
                      )}
                      {/* The lane is a fixed width even when the figure inside
                          is a single "?", so the capability badges keep one
                          right edge down the whole list instead of sliding
                          with the length of each context figure. */}
                      <span className="model-ctx-lane">
                        {ctx
                          ? <span className="model-ctx-badge" title="Context window">{formatCtx(ctx)}</span>
                          : <span className="model-ctx-badge unknown" title="Context window unknown">?</span>}
                      </span>
                      <span className="model-row-action">
                        {unreachable ? (
                          <ModelRowAction kind="refresh" busy={busy} disabled={applicationOperationLocked}
                            label={`Refresh ${m.profileName}`}
                            onClick={() => onRefreshProfile(m.profileId)} />
                        ) : !isLocal || (shiftHeld && !busy) ? (
                          // Cloud models have nothing to load or unload, so
                          // Hide is the only row action they ever carry. On a
                          // local row it takes the slot for as long as Shift is
                          // down, which is also the gesture that arms it — so
                          // the button under the cursor is always the one that
                          // the next click will actually fire.
                          <ModelRowAction kind="hide" busy={false} disabled={applicationOperationLocked} shiftOnly
                            label={`Hide ${m.id} from every model picker`}
                            hint="Hide this model from every model picker"
                            onClick={() => onHide(m)} />
                        ) : !loaded && !loading_ ? (
                          <ModelRowAction kind="load" busy={busy} disabled={applicationOperationLocked}
                            label={`Load ${m.id}`}
                            onShiftClick={() => onHide(m)}
                            onClick={() => onLoad(m)} />
                        ) : loaded ? (
                          <ModelRowAction kind="unload" busy={busy} disabled={applicationOperationLocked}
                            label={`Unload ${m.id}`}
                            onShiftClick={() => onHide(m)}
                            onClick={() => onUnload(m)} />
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </li>
            ))}
            {allModels.length > 0 && visibleModels.length === 0 && <li className="model-empty">No models matching</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
