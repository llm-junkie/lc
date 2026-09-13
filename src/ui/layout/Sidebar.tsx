import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useSettings } from '../../store/settings.ts';
import { useProfileStore } from '../../modules/server-profiles/index.ts';
import {
  useConversations,
  isConversationCorpusMutationActive,
  isConversationStructurallyLocked,
  isHighlighted,
} from '../../store/conversations.ts';
import {
  activeGenerationCount,
  getGenerationAttention,
  getGenerationSessionView,
  subscribeToGenerationSession,
  subscribeToGenerationSessions,
} from '../../modules/chat-pipeline/generation-session-manager.ts';
import { requestGenerationStop } from '../chat/generation-lifecycle.ts';
import { useShiftHeld } from '../chat/use-shift-held.ts';
import { formatRelative } from '../../utils/format.ts';
import { cn } from '../../utils/cn.ts';
import { useResolvedTheme } from '../shared/ThemeProvider.tsx';
import { toast } from '../../utils/toast.ts';
import { applyCustomTheme, applyBuiltinTheme } from '../../themes/resolver.ts';
import { BUILTIN_KEYS } from '../../themes/builtin.ts';
import { requestWhiteboardOverlayExit } from '../tools/whiteboard-overlay-guard.ts';
import { useConversationUi } from '../../store/conversation-ui.ts';
import { LC_VERSION } from '../../app-metadata.ts';
import { exportConversationArchive } from '../../utils/exportArchive.ts';
import { loadMessages } from '../../store/db.ts';
import { listWhiteboardVersions } from '../../store/whiteboard.ts';
import { errorMessage } from '../../modules/llm-client/index.ts';
import {
  getInteractionQueueView,
  subscribeToInteractionQueue,
} from '../../modules/chat-pipeline/interaction-coordinator.ts';

interface Props {
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onOpenKeyboardShortcuts: () => void;
}

export function Sidebar({ onOpenSettings, onOpenAbout, onOpenKeyboardShortcuts }: Props) {
  const sidebarOpen = useSettings((s) => s.ui.sidebarOpen);
  const toggleSidebar = useSettings((s) => s.toggleSidebar);

  // Auto-collapse sidebar when the window shrinks below 1024px.
  // Only triggers when crossing the threshold downward — the user
  // can still manually open it at any width.
  useEffect(() => {
    let prevWidth = window.innerWidth;
    const onResize = () => {
      if (prevWidth >= 1024 && window.innerWidth < 1024 && sidebarOpen) {
        toggleSidebar(false);
      }
      prevWidth = window.innerWidth;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [sidebarOpen, toggleSidebar]);
  // Use the first toggled-on profile for the sidebar header display.
  const profile = useProfileStore((s) => s.profiles.find((p) => p.active));
  const setTheme = useSettings((s) => s.setTheme);
  const theme = useSettings((s) => s.theme);
  const activeCustomThemeId = useSettings((s) => s.activeCustomThemeId);
  const setActiveCustomTheme = useSettings((s) => s.setActiveCustomTheme);
  const setCustomThemeOpen = useSettings((s) => s.setCustomThemeOpen);
  const customThemes = useSettings((s) => s.customThemes);
  const themeFilter = useSettings((s) => s.themeFilter);
  // The quick-theme icon and its tooltip describe the
  // *resolved* theme (what the user actually sees right
  // now), not the stored value. With `theme: 'system'`,
  // the icon would otherwise stay on "light" while the
  // rendered page is dark — e.g. after a settings reset
  // lands on a dark OS theme. Resolving through
  // `useResolvedTheme` keeps the icon in sync with the
  // applied `data-theme` and with OS-level dark-mode
  // flips at runtime.
  const resolved = useResolvedTheme();

  // Click = cycle through themes. Shift+click = open custom theme modal.
  // When a built-in theme is active (system / light / dark), cycle only
  // through the two built-in themes. When a custom theme is active, cycle
  // only through custom themes (never jump to built-in / system themes),
  // respecting the theme filter.
  const handleThemeClick = (e: React.MouseEvent) => {
    if (e.shiftKey) {
      setCustomThemeOpen(true);
      return;
    }
    const builtinKeys = [...BUILTIN_KEYS] as ('light' | 'dark')[];

    // When the user is on a built-in theme (system, light, dark), only
    // cycle through the two built-in themes. Custom themes rejoin the
    // cycle once the user explicitly picks one from the custom modal.
    const inBuiltinMode = activeCustomThemeId === null;

    // When a custom theme is active, cycle only through custom
    // themes — never jump to built-in / system themes.
    const allIds: Array<{ kind: 'builtin'; key: 'light' | 'dark' } | { kind: 'custom'; id: string }> = inBuiltinMode
      ? builtinKeys.map((k) => ({ kind: 'builtin' as const, key: k }))
      : customThemes.map((t) => ({ kind: 'custom' as const, id: t.id }));

    // Filter by active theme filter (only applies in custom mode).
    const filtered = inBuiltinMode
      ? allIds
      : allIds.filter((item) => {
          if (themeFilter === 'all') return true;
          if (item.kind !== 'custom') return true;
          const ct = customThemes.find((t) => t.id === item.id);
          return ct?.source.base === themeFilter;
        });
    if (filtered.length === 0) return;

    // Find current position.  "system" resolves to its OS-matched builtin.
    const effectiveKey: 'light' | 'dark' =
      theme === 'system' ? resolved : (theme as 'light' | 'dark');

    let idx = filtered.findIndex((item) => {
      if (item.kind === 'builtin') return activeCustomThemeId === null && item.key === effectiveKey;
      return item.kind === 'custom' && item.id === activeCustomThemeId;
    });
    if (idx === -1) idx = 0;

    const next = filtered[(idx + 1) % filtered.length];

    if (next.kind === 'builtin') {
      setActiveCustomTheme(null);
      setTheme(next.key);
      applyBuiltinTheme(next.key);
    } else {
      const ct = customThemes.find((t) => t.id === next.id);
      if (ct && applyCustomTheme(ct)) {
        setActiveCustomTheme(ct.id);
      }
    }
  };

  // Icon: sneak-peek the next theme's base. Mirrors the cycle logic
  // in handleThemeClick so the icon always previews where a click
  // will land.
  const nextBase = useMemo<'light' | 'dark'>(() => {
    const builtinKeys = [...BUILTIN_KEYS] as ('light' | 'dark')[];

    const inBuiltinMode = activeCustomThemeId === null;

    // When a custom theme is active, cycle only through custom
    // themes — never jump to built-in / system themes.
    const allIds: Array<{ kind: 'builtin'; key: 'light' | 'dark' } | { kind: 'custom'; id: string }> = inBuiltinMode
      ? builtinKeys.map((k) => ({ kind: 'builtin' as const, key: k }))
      : customThemes.map((t) => ({ kind: 'custom' as const, id: t.id }));

    const filtered = inBuiltinMode
      ? allIds
      : allIds.filter((item) => {
          if (themeFilter === 'all') return true;
          if (item.kind !== 'custom') return true;
          const ct = customThemes.find((t) => t.id === item.id);
          return ct?.source.base === themeFilter;
        });
    if (filtered.length === 0) return 'dark';

    const effectiveKey: 'light' | 'dark' =
      theme === 'system' ? resolved : (theme as 'light' | 'dark');

    let idx = filtered.findIndex((item) => {
      if (item.kind === 'builtin') return activeCustomThemeId === null && item.key === effectiveKey;
      return item.kind === 'custom' && item.id === activeCustomThemeId;
    });
    if (idx === -1) idx = 0;

    const next = filtered[(idx + 1) % filtered.length];

    if (next.kind === 'builtin') return next.key;
    const ct = customThemes.find((t) => t.id === next.id);
    return ct?.source.base ?? 'dark';
  }, [resolved, activeCustomThemeId, customThemes, theme, themeFilter]);

  // NOTE: select raw fields and compute the list with `useMemo`. If we did
  // `useConversations((s) => s.list())` the selector would return a brand-new
  // array every render, and zustand v5 + React 19's `useSyncExternalStore`
  // would treat that as a state change → infinite re-render → blank page.
  //
  // During streaming, `byId` changes on every token — subscribing reactively
  // causes the entire Sidebar to re-render 60×/s, which kills the collapsed
  // popup's hover state → flash.  We read `byId`/`order` from getState()
  // instead and only update the frozen snapshot when NOT streaming.
  const activeConvId = useConversations((s) => s.activeId);
  const create = useConversations((s) => s.create);
  const setActive = useConversations((s) => s.setActive);
  const remove = useConversations((s) => s.remove);
  const rename = useConversations((s) => s.rename);
  const clone = useConversations((s) => s.clone);
  const archive = useConversations((s) => s.archive);
  const unarchive = useConversations((s) => s.unarchive);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Inbox/Archive tab filter. Lives in the conversations store
  // (not local state) so the welcome screen's "Start a new chat"
  // button — rendered by ChatView, a sibling of Sidebar — can
  // keep the tab in sync with the chat it creates. See the
  // EmptyState comment for the full rationale. Reads/writes
  // the store directly so the setter is stable across renders.
  const filterTab = useConversations((s) => s.filterTab);
  const setFilterTab = useConversations((s) => s.setFilterTab);
  // Per-tab "last loaded" memory. The store's `activeId` is a single
  // pointer to whatever the main pane is showing right now, but the
  // user may have a distinct *most-recently-touched* chat in each
  // tab (e.g. they were reading an Archive chat, then went back to
  // Active and clicked chat #3 — when they re-open the Archive tab
  // they expect the same Archive chat they had open, not chat #3 or
  // the first one in the list). We track both slots independently
  // and restore the matching one when the user switches tabs.
  //
  // These are session-only (component state, not the persisted
  // store) — they describe the user's navigation flow on this
  // device, not cross-session data. Reloading the app should pick
  // a sensible default from the persisted `activeId` instead of
  // restoring a session-only pointer to a conversation that may
  // have been deleted.
  const [lastActiveConvId, setLastActiveConvId] = useState<string | null>(null);
  const [lastArchiveConvId, setLastArchiveConvId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Track the shift key state at the window level so the conv-list
  // delete button can show its "armed" red styling while shift is held
  // (not just at click time). The button is shift-to-arm; the CSS
  // mirrors that — muted gray when neutral, red only when shift is
  // held and the button is hovered. Without this, the user sees red
  // on every plain hover and reads it as "this button is clickable,"
  // which it isn't.
  //
  // When a title is being edited, tracking is disabled so holding
  // Shift (typing capitals) doesn't re-render the list and reset the
  // rename input.
  const shiftDown = useShiftHeld(editingId === null);

  // ── Structural snapshot ──────────────────────────────────────
  // `byId` changes on every streamed token, so the list is rebuilt from an
  // explicit structural signal rather than from the store object itself.
  //
  // The previous version froze the snapshot for as long as *any* conversation
  // was streaming, and justified that with "actions are blocked by
  // isAnyStreaming guards". That is no longer true: renaming, archiving,
  // deleting, and creating are now permitted on conversations that are not
  // themselves generating, so a frozen list would simply not show them. The
  // 300 ms poll it used to detect stream transitions is gone with it.
  //
  // `structuralVersion` bumps only when the list's shape changes;
  // `loadedVersion` catches message-count updates. Neither fires per token.
  const structuralVersion = useConversations((s) => s.structuralVersion);
  const loadedVersion = useConversations((s) => s.loadedVersion);
  const [actionTick, setActionTick] = useState(0);

  const [snapshot, setSnapshot] = useState(() => useConversations.getState());
  useEffect(() => {
    setSnapshot(useConversations.getState());
  }, [actionTick, loadedVersion, structuralVersion]);
  const { byId, order } = snapshot;

  const list = useMemo(
    () => order.map((id) => byId[id]).filter((c): c is NonNullable<typeof c> => Boolean(c)),
    [byId, order],
  );

  const tabList = useMemo(
    () => list.filter((c) => (filterTab === 'active' ? !c.archived : c.archived)),
    [list, filterTab],
  );
  const cycleIndex = activeConvId ? tabList.findIndex((c) => c.id === activeConvId) : -1;
  const canCycleDown = tabList.length > 0 && (cycleIndex === -1 || cycleIndex < tabList.length - 1);
  const canCycleUp = cycleIndex > 0;
  // Switching is always permitted now. The only thing that may refuse it is
  // the foreground Whiteboard discard guard, which each caller already
  // consults, plus a corpus mutation that is about to invalidate every row.
  const conversationNavigationLocked = () => isConversationCorpusMutationActive();
  const handleOpenSettings = async () => {
    if (!await requestWhiteboardOverlayExit('settings-open')) return;
    onOpenSettings();
  };
  const cycleUp = async () => {
    if (!canCycleUp) return;
    if (conversationNavigationLocked()) { toast.info('Wait for the current storage operation to finish.'); return; }
    if (!await requestWhiteboardOverlayExit('conversation-switch')) return;
    setActive(tabList[cycleIndex - 1].id);
  };
  const cycleDown = async () => {
    if (!canCycleDown) return;
    if (conversationNavigationLocked()) { toast.info('Wait for the current storage operation to finish.'); return; }
    if (!await requestWhiteboardOverlayExit('conversation-switch')) return;
    setActive(tabList[cycleIndex === -1 ? 0 : cycleIndex + 1].id);
  };

  const handleNewChat = async () => {
    if (conversationNavigationLocked()) { toast.info('Wait for the current storage operation to finish before starting a new chat.'); return; }
    if (!await requestWhiteboardOverlayExit('new-conversation')) return;
    const p = profile ?? useProfileStore.getState().profiles[0];
    if (!p) { onOpenSettings(); return; }
    create({ serverId: p.id });
    if (filterTab !== 'active') setFilterTab('active');
  };

  const switchToTab = async (target: 'active' | 'archive') => {
    if (target === filterTab) return;
    if (conversationNavigationLocked()) { toast.info('Wait for the current storage operation to finish.'); return; }
    if (!await requestWhiteboardOverlayExit('conversation-switch')) return;
    const pointer = target === 'active' ? lastActiveConvId : lastArchiveConvId;
    const pointerStillValid =
      pointer !== null && byId[pointer] !== undefined &&
      (target === 'active' ? !byId[pointer].archived : !!byId[pointer].archived);
    setActive(pointerStillValid ? pointer : null);
    setFilterTab(target);
  };

  useEffect(() => {
    if (!activeConvId) return;
    const conv = byId[activeConvId];
    if (!conv) return;
    if (conv.archived) setLastArchiveConvId(activeConvId);
    else setLastActiveConvId(activeConvId);
  }, [activeConvId, byId]);

  const rowItems = useMemo(
    () => list.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, model: c.model, archived: !!c.archived, messageCount: c.messageCount })),
    [list],
  );

  const activeCount = useMemo(() => list.reduce((n, c) => n + (c.archived ? 0 : 1), 0), [list]);
  const archiveCount = useMemo(() => list.reduce((n, c) => n + (c.archived ? 1 : 0), 0), [list]);
  const currentCategory: 'active' | 'archive' =
    activeConvId && byId[activeConvId]
      ? (byId[activeConvId].archived ? 'archive' : 'active')
      : filterTab;
  const currentCategoryLabel = currentCategory === 'active' ? 'Inbox' : 'Archive';
  const currentCategoryCount = currentCategory === 'active' ? activeCount : archiveCount;

  const handleCompactTabClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey) {
      void switchToTab(filterTab === 'active' ? 'archive' : 'active');
      return;
    }

    // The compact badge describes the conversation currently on screen. If
    // that differs from the list's remembered filter, align the expanded tab
    // with the badge before revealing the sidebar.
    if (filterTab !== currentCategory) setFilterTab(currentCategory);
    toggleSidebar(true);
  };

  // The collapsed tab switch doubles as the background-work indicator. The
  // foreground conversation already has its animated assistant bubble, so the
  // switch lights up only when at least one *other* conversation is running.
  // This boolean stays stable across phase and TPS publications.
  const hasOtherActiveGenerations = useSyncExternalStore(
    subscribeToGenerationSessions,
    () => activeGenerationCount() > (getGenerationSessionView(activeConvId) ? 1 : 0),
  );

  const filtered = useMemo(() => {
    const inTab = rowItems.filter((r) => filterTab === 'active' ? !r.archived : r.archived);
    const q = query.trim().toLowerCase();
    if (!q) return inTab;
    return list
      .filter((c) => {
        if (filterTab === 'active' && c.archived) return false;
        if (filterTab === 'archive' && !c.archived) return false;
        if (c.title.toLowerCase().includes(q)) return true;
        if (c.model?.toLowerCase().includes(q)) return true;
        for (const m of c.messages) {
          if (m.content.toLowerCase().includes(q)) return true;
        }
        return false;
      })
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, model: c.model, archived: !!c.archived, messageCount: c.messageCount }));
  }, [list, rowItems, query, filterTab]);

  // Stable callbacks so ConvRow memo doesn't break on every render.
  //
  // Selecting a conversation no longer waits for a generation: a response
  // belongs to its conversation, not to the visible pane. The foreground
  // Whiteboard discard guard is still consulted, because unsaved editor text
  // lives in the pane the switch is about to replace.
  const handleSelect = useCallback(async (id: string) => {
    if (isConversationCorpusMutationActive()) {
      toast.info('Wait for the current storage operation to finish.');
      return;
    }
    if (!await requestWhiteboardOverlayExit('conversation-switch')) return;
    setActive(id);
  }, [setActive]);
  const handleRenameStart = useCallback((id: string, _title: string) => {
    if (isConversationStructurallyLocked(id)) {
      toast.info("Wait for that conversation's response to finish.");
      return;
    }
    setEditingId(id);
  }, []);
  const handleRenameCommit = useCallback((id: string, newTitle: string) => {
    if (isConversationStructurallyLocked(id)) {
      toast.info("Wait for that conversation's response to finish.");
      return;
    }
    rename(id, newTitle);
    setEditingId(null);
    setActionTick((t) => t + 1);
  }, [rename]);
  const handleArchive = useCallback((id: string, title: string) => {
    if (isConversationStructurallyLocked(id)) {
      toast.info("Wait for that conversation's response to finish.");
      return;
    }
    archive(id);
    toast.success(`"${title}" archived`);
    setActionTick((t) => t + 1);
  }, [archive]);
  const handleUnarchive = useCallback((id: string, title: string) => {
    if (isConversationStructurallyLocked(id)) {
      toast.info("Wait for that conversation's response to finish.");
      return;
    }
    unarchive(id);
    toast.success(`"${title}" moved back to Active`);
    setActionTick((t) => t + 1);
  }, [unarchive]);
  const handleClone = useCallback(async (id: string, title: string) => {
    if (isConversationStructurallyLocked(id)) {
      toast.info("Wait for that conversation's response to finish.");
      return;
    }
    const cloned = await clone(id);
    if (cloned) toast.success(`"${title}" cloned`);
    setActionTick((t) => t + 1);
  }, [clone]);
  const handleDelete = useCallback(async (id: string) => {
    if (isConversationStructurallyLocked(id)) {
      toast.info("Wait for that conversation's response to finish.");
      return;
    }
    if (!await requestWhiteboardOverlayExit('conversation-delete')) return;
    if (!await remove(id)) return;
    // The draft dies with its conversation, so its staged blobs go too.
    await useConversationUi.getState().releaseConversation(id);
    setActionTick((t) => t + 1);
  }, [remove]);
  const handleExport = useCallback(async (id: string) => {
    if (isConversationStructurallyLocked(id)) {
      toast.info("Wait for that conversation's response to finish.");
      return;
    }
    const conversation = useConversations.getState().byId[id];
    if (!conversation) {
      toast.error('This conversation is no longer available.');
      return;
    }
    try {
      await exportConversationArchive(
        conversation,
        loadMessages,
        listWhiteboardVersions,
      );
    } catch (error) {
      toast.error(`Export failed: ${errorMessage(error)}`);
    }
  }, []);

  // Memoized conversation row.  Without this, every stream token causes
  // ALL rows to re-render because zustand creates a new `byId` reference
  // → `list` recomputes → `filtered` recomputes → full O(N) re-render.
  // With React.memo, only the row whose props actually changed re-renders.
  const ConvRow = memo(function ConvRow({
    item,
    isActive,
    isEditing,
    disableActions,
    shiftDown,
    onSelect,
    onRenameStart,
    onRenameCommit,
    onArchive,
    onUnarchive,
    onClone,
    onDelete,
    onExport,
  }: {
    item: { id: string; title: string; updatedAt: number; model?: string; archived: boolean; messageCount?: number };
    isActive: boolean;
    isEditing: boolean;
    disableActions: boolean;
    shiftDown: boolean;
    onSelect: (id: string) => void;
    onRenameStart: (id: string, title: string) => void;
    onRenameCommit: (id: string, newTitle: string) => void;
    onArchive: (id: string, title: string) => void;
    onUnarchive: (id: string, title: string) => void;
    onClone: (id: string, title: string) => void;
    onDelete: (id: string) => void;
    onExport: (id: string) => void;
  }) {
    const [localDraft, setLocalDraft] = useState(item.title);
    const prevEditing = useRef(false);

    // When entering edit mode, seed localDraft from the current store
    // title.  We use a ref to detect the false→true transition so we
    // only sync on entry, never while the user is actively typing.
    // Only isEditing is in the dep array — item.title is intentionally
    // excluded so Shift-key re-renders (which change shiftDown but not
    // isEditing) never trigger a sync.
    useEffect(() => {
      if (isEditing && !prevEditing.current) {
        setLocalDraft(item.title);
      }
      prevEditing.current = isEditing;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isEditing]);

    // Streaming dot: a real subscription to this row's session, replacing a
    // 400 ms interval per visible row.
    //
    const subscribeToRowSession = useCallback(
      (listener: () => void) => subscribeToGenerationSession(item.id, listener),
      [item.id],
    );
    const generationPhase = useSyncExternalStore(
      subscribeToRowSession,
      () => getGenerationSessionView(item.id)?.phase ?? null,
    );
    const terminalAttention = useSyncExternalStore(
      subscribeToRowSession,
      () => getGenerationAttention(item.id)?.kind ?? null,
    );
    const isGenerating = generationPhase !== null;
    const attentionCount = useSyncExternalStore(
      subscribeToInteractionQueue,
      () => getInteractionQueueView().queuedByConversation.get(item.id) ?? 0,
    );
    const hasStorageFailure = useConversations(
      (state) => state.persistenceFailures[item.id] !== undefined,
    );
    const hasTerminalFailure = hasStorageFailure || terminalAttention === 'failed';
    const hasRowStatus = isGenerating
      || attentionCount > 0
      || hasStorageFailure
      || terminalAttention !== null;

    return (
      <div
        className={cn(
          'conv-item',
          isActive && 'active',
          isGenerating && 'streaming',
          hasRowStatus && 'has-status',
        )}
        onClick={() => onSelect(item.id)}
      >
        {hasRowStatus && (
          <div className="conv-status">
            {isGenerating && (
              <button
                type="button"
                className={cn('conv-streaming-dot', `phase-${generationPhase}`)}
                title={generationPhase === 'finalizing'
                  ? 'Saving response'
                  : generationPhase === 'stopping'
                  ? 'Stopping response'
                  : generationPhase === 'failed'
                    ? 'Retry final conversation storage write'
                  : `Stop ${generationPhase.replace('-', ' ')}`}
                aria-label={generationPhase === 'finalizing'
                  ? 'Saving response'
                  : generationPhase === 'stopping'
                  ? 'Stopping response'
                  : generationPhase === 'failed'
                    ? 'Retry final conversation storage write'
                    : 'Stop response'}
                disabled={generationPhase === 'stopping' || generationPhase === 'finalizing'}
                onClick={(event) => {
                  event.stopPropagation();
                  const stop = requestGenerationStop(item.id);
                  if (stop.outcome === 'retrying-terminal-write') {
                    toast.info('Retrying the final conversation storage write…');
                  }
                }}
              />
            )}
            {attentionCount > 0 && (
              <span
                className={cn('conv-attention-dot', isGenerating && 'overlaid')}
                title={`${attentionCount} generation request${attentionCount === 1 ? '' : 's'} waiting for your attention`}
                aria-label="Needs attention"
              >!</span>
            )}
            {!isGenerating && attentionCount === 0 && (hasStorageFailure || terminalAttention) && (
              <span
                className={cn(
                  'conv-terminal-attention',
                  hasTerminalFailure && 'failed',
                )}
                title={hasStorageFailure
                  ? 'Conversation storage failed'
                  : terminalAttention === 'failed'
                    ? 'Background response failed'
                    : 'Background response completed'}
                aria-label={hasTerminalFailure
                  ? 'Unread response failure'
                  : 'Unread completed response'}
              >
                {hasTerminalFailure ? '!' : (
                  <svg className="conv-complete-check" viewBox="0 0 12 12" aria-hidden>
                    <path d="M2.25 6.1 4.8 8.5 9.75 3.5" />
                  </svg>
                )}
              </span>
            )}
          </div>
        )}
        {isEditing ? (
          <input
            id={`rename-${item.id}`}
            name="title"
            autoFocus
            className="conv-rename"
            value={localDraft}
            onChange={(e) => setLocalDraft(e.target.value)}
            onBlur={() => onRenameCommit(item.id, localDraft.trim() || item.title)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameCommit(item.id, localDraft.trim() || item.title);
              else if (e.key === 'Escape') onRenameCommit(item.id, item.title);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <div className={cn('conv-title', isHighlighted(item.id) && 'highlighted')} title={item.title}>
              {(item.messageCount ?? 0) > 0 && <span className="conv-msg-count">{item.messageCount}</span>}
              <span className="conv-title-text">{item.title}</span>
            </div>
            <div className="conv-meta">
              <span className="conv-timestamp">{formatRelative(item.updatedAt)}</span>
              {item.model && <span className="conv-model" title={item.model}>{shortModel(item.model)}</span>}
            </div>
            {!disableActions && (
            <div className="conv-actions">
              <button className="icon-btn xs conv-action-rename" title="Rename"
                onClick={(e) => { e.stopPropagation(); onRenameStart(item.id, item.title); }}>
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                  <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                </svg>
              </button>
              <button
                className={cn('icon-btn xs conv-action-archive', shiftDown && 'is-delete is-armed')}
                title={shiftDown ? "Delete" : item.archived ? "Unarchive (Hold 'Shift' to delete)" : "Archive (Hold 'Shift' to delete)"}
                onClick={(e) => {
                  e.stopPropagation();
                  if (e.shiftKey) {
                    onDelete(item.id);
                    return;
                  }
                  if (item.archived) onUnarchive(item.id, item.title);
                  else onArchive(item.id, item.title);
                }}>
                {shiftDown ? (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 7h16" />
                    <path d="M9 7V4h6v3" />
                    <path d="M6 7l1 13h10l1-13" />
                    <path d="M10 11v6" />
                    <path d="M14 11v6" />
                  </svg>
                ) : item.archived ? (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M21 8H3v5h2v8h14v-8h2V8z" transform="translate(0,-1) rotate(-3 12 12)" />
                    <path d="M3 8l2-4h14l2 4" />
                    <path d="M12 12v6" />
                    <path d="M9 15l3-3 3 3" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="4" width="18" height="4" rx="1" />
                    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
                    <path d="M10 12h4" />
                  </svg>
                )}
              </button>
              <button className="icon-btn xs conv-action-clone" title="Clone"
                onClick={(e) => { e.stopPropagation(); onClone(item.id, item.title); }}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="6" cy="6" r="2.5" />
                  <circle cx="18" cy="6" r="2.5" />
                  <circle cx="12" cy="18" r="2.5" />
                  <path d="M6 8.5V11H12" />
                  <path d="M12 15.5V11" />
                  <path d="M18 8.5C18 8.5 18 11 12 11" />
                </svg>
              </button>
              <button
                className="icon-btn xs conv-action-export"
                title="Export this conversation"
                aria-label="Export this conversation"
                onClick={(e) => {
                  e.stopPropagation();
                  onExport(item.id);
                }}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 4v10" />
                  <path d="M7 9l5 5 5-5" />
                  <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
                </svg>
              </button>
            </div>
            )}
          </>
        )}
      </div>
    );
  });

  return (
    <aside className={cn('sidebar', !sidebarOpen && 'collapsed')}>
      <div className="sidebar-top">
        <button
          className="icon-btn"
          aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          onClick={() => toggleSidebar()}
        >
          {sidebarOpen ? (
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
              <path d="M17 16l-4-4 4-4" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
              <path d="M13 8l4 4-4 4" />
            </svg>
          )}
        </button>
        <div className="brand" />
        <button
          className="icon-btn"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (F1)"
          onClick={onOpenKeyboardShortcuts}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 13H6.01M6 17H6.01M10 13H10.01M14 13H14.01M18 17H18.01M18 13H18.01M16 3V5H8V9M10 17H14M5.2 21H18.8C19.9201 21 20.4802 21 20.908 20.782C21.2843 20.5903 21.5903 20.2843 21.782 19.908C22 19.4802 22 18.9201 22 17.8V12.2C22 11.0799 22 10.5198 21.782 10.092C21.5903 9.71569 21.2843 9.40973 20.908 9.21799C20.4802 9 19.9201 9 18.8 9H5.2C4.07989 9 3.51984 9 3.09202 9.21799C2.71569 9.40973 2.40973 9.71569 2.21799 10.092C2 10.5198 2 11.0799 2 12.2V17.8C2 18.9201 2 19.4802 2.21799 19.908C2.40973 20.2843 2.71569 20.5903 3.09202 20.782C3.51984 21 4.0799 21 5.2 21Z" />
          </svg>
        </button>
        <button
          className="icon-btn"
          aria-label="Toggle theme"
          onClick={handleThemeClick}
          title="Cycle theme (Shift+click to manage)"
        >
          {nextBase === 'light' ? (
            // Sun — next theme is light-based (preview the destination).
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 3v2" />
              <path d="M12 19v2" />
              <path d="M5.05 5.05l1.41 1.41" />
              <path d="M17.54 17.54l1.41 1.41" />
              <path d="M3 12h2" />
              <path d="M19 12h2" />
              <path d="M5.05 18.95l1.41-1.41" />
              <path d="M17.54 6.46l1.41-1.41" />
            </svg>
          ) : (
            // Moon — next theme is dark-based.
            // Crescent built from two arcs.
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a0.5 0.5 0 0 0-0.7-0.4 9.5 9.5 0 1 0 12.1 12.1 0.5 0.5 0 0 0-0.4-0.7z" />
            </svg>
          )}
        </button>
        <SettingsIconButton onClick={() => { void handleOpenSettings(); }} />
      </div>

      {!sidebarOpen && (
        <>
          <div className="sidebar-actions-compact">
            <button
              className="icon-btn"
              aria-label="New chat"
              title="New chat"
              onClick={handleNewChat}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
              </svg>
            </button>
            <button
              className="icon-btn"
              aria-label="Search conversations"
              title="Search conversations"
              onClick={() => {
                toggleSidebar(true);
                // Focus search input after sidebar opens
                requestAnimationFrame(() => searchRef.current?.focus());
              }}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path fill="currentColor" d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8L19 20.5 20.5 19 15.5 14zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z" />
              </svg>
            </button>

            {/* The badge follows the conversation currently on screen (or the
                filter tab on the welcome screen), and its count comes from the
                same category. A normal click opens that category in the full
                sidebar. Shift+click retains the compact list-switch shortcut. */}
            <button
              type="button"
              className={cn(
                'sidebar-tab-switch-compact',
                filterTab === 'active'
                  && hasOtherActiveGenerations
                  && 'has-active-generations',
              )}
              aria-label={`Open ${currentCategoryLabel} conversation list. Shift+click to switch lists without expanding the sidebar.`}
              title={`Open ${currentCategoryLabel}. Shift+click to switch lists.`}
              onClick={handleCompactTabClick}
            >
              <span className="sidebar-tab-switch-label">
                {currentCategoryLabel}
              </span>
              <span className="sidebar-tab-switch-count">
                {currentCategoryCount}
              </span>
            </button>

            {/* Cycle through conversations — paired up/down buttons
                sharing a single rounded outer rect. Sits inside the
                same flex column as the new-chat + search buttons so
                the user sees: + → 🔍 → [Active/Archive] → ↑ → ↓ as
                one continuous stack with 4px gaps between siblings
                and 1px between the paired-button cells. */}
            <div className="sidebar-cycle-compact">
              <button
                className="icon-btn"
                aria-label="Previous conversation"
                title={canCycleUp ? 'Previous conversation' : 'Already at the top'}
                onClick={cycleUp}
                disabled={!canCycleUp}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="6 14 12 8 18 14" />
                </svg>
              </button>
              <button
                className="icon-btn"
                aria-label="Next conversation"
                title={canCycleDown ? 'Next conversation' : 'Already at the bottom'}
                onClick={cycleDown}
                disabled={!canCycleDown}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="6 10 12 16 18 10" />
                </svg>
              </button>
            </div>
          </div>

        <div className="sidebar-spacer" />

        {/* Bottom block: theme toggle + settings, same look/behaviour
            as the buttons in the expanded sidebar's .sidebar-top.
            Pushed to the bottom of the collapsed sidebar by a flex
            spacer (set in CSS). */}
        <div className="sidebar-bottom-compact">
          <button
            className="icon-btn kbd-shortcuts-btn-compact"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (F1)"
            onClick={onOpenKeyboardShortcuts}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 13H6.01M6 17H6.01M10 13H10.01M14 13H14.01M18 17H18.01M18 13H18.01M16 3V5H8V9M10 17H14M5.2 21H18.8C19.9201 21 20.4802 21 20.908 20.782C21.2843 20.5903 21.5903 20.2843 21.782 19.908C22 19.4802 22 18.9201 22 17.8V12.2C22 11.0799 22 10.5198 21.782 10.092C21.5903 9.71569 21.2843 9.40973 20.908 9.21799C20.4802 9 19.9201 9 18.8 9H5.2C4.07989 9 3.51984 9 3.09202 9.21799C2.71569 9.40973 2.40973 9.71569 2.21799 10.092C2 10.5198 2 11.0799 2 12.2V17.8C2 18.9201 2 19.4802 2.21799 19.908C2.40973 20.2843 2.71569 20.5903 3.09202 20.782C3.51984 21 4.0799 21 5.2 21Z" />
            </svg>
          </button>
          <button
            className="icon-btn"
            aria-label="Toggle theme"
            onClick={handleThemeClick}
            title="Cycle theme (Shift+click to manage)"
          >
            {nextBase === 'light' ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 3v2" />
                <path d="M12 19v2" />
                <path d="M5.05 5.05l1.41 1.41" />
                <path d="M17.54 17.54l1.41 1.41" />
                <path d="M3 12h2" />
                <path d="M19 12h2" />
                <path d="M5.05 18.95l1.41-1.41" />
                <path d="M17.54 6.46l1.41-1.41" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a0.5 0.5 0 0 0-0.7-0.4 9.5 9.5 0 1 0 12.1 12.1 0.5 0.5 0 0 0-0.4-0.7z" />
              </svg>
            )}
          </button>
          <SettingsIconButton onClick={() => { void handleOpenSettings(); }} />
          </div>
        </>
      )}

      {sidebarOpen && (
        <>
          <button
            className="new-chat-btn"
            onClick={handleNewChat}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
              <path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
            </svg>
            <span>New chat</span>
          </button>

          {list.length > 0 && (
            <div className="conv-search">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <path
                  fill="currentColor"
                  d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8L19 20.5 20.5 19 15.5 14zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"
                />
              </svg>
              <input
                ref={searchRef}
                id="sidebar-search"
                name="search"
                type="text"
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button
                  className="icon-btn small"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  type="button"
                >
                  ×
                </button>
              )}
            </div>
          )}

          {/* Segmented Active/Archive tab. Sits below the search so
              the user can scope their view, and shows the count for
              each tab so they know at a glance how many chats are
              archived (without clicking through). The inbox tab
              gets a filled background; the inactive one is just a
              label. */}
          {list.length > 0 && (
            <div className="conv-filter-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={filterTab === 'active'}
                className={`conv-filter-tab${filterTab === 'active' ? ' is-active' : ''}`}
                onClick={() => setFilterTab('active')}
              >
                <span>Inbox</span>
                <span className="conv-filter-tab-count">{activeCount}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={filterTab === 'archive'}
                className={`conv-filter-tab${filterTab === 'archive' ? ' is-active' : ''}`}
                onClick={() => setFilterTab('archive')}
              >
                <span>Archive</span>
                <span className="conv-filter-tab-count">{archiveCount}</span>
              </button>
            </div>
          )}

          <div className="conv-list">
            {list.length === 0 && (
              <div className="conv-empty">No conversations yet. Start one above.</div>
            )}
            {list.length > 0 && filtered.length === 0 && query.trim() && (
              <div className="conv-empty">No matches for "{query}".</div>
            )}
            {list.length > 0 && filtered.length === 0 && !query.trim() && filterTab === 'archive' && (
              <div className="conv-empty">No archived conversations.</div>
            )}
            {list.length > 0 && filtered.length === 0 && !query.trim() && filterTab === 'active' && (
              <div className="conv-empty">No active conversations.</div>
            )}
            {filtered.map((c) => (
              <ConvRow
                key={c.id}
                item={c}
                isActive={c.id === activeConvId}
                isEditing={editingId === c.id}
                disableActions={editingId !== null}
                shiftDown={shiftDown}
                onSelect={handleSelect}
                onRenameStart={handleRenameStart}
                onRenameCommit={handleRenameCommit}
                onArchive={handleArchive}
                onUnarchive={handleUnarchive}
                onClone={handleClone}
                onDelete={handleDelete}
                onExport={handleExport}
              />
            ))}
          </div>

          <div className="sidebar-footer" onClick={onOpenAbout} title="About LC">
            <span className="sidebar-footer-name">LC</span>
            <span className="sidebar-footer-meta">v{LC_VERSION} · © {new Date().getFullYear()}</span>
          </div>
        </>
      )}
    </aside>
  );
}

function shortModel(id: string): string {
  if (id.length <= 22) return id;
  return id.slice(0, 10) + '…' + id.slice(-8);
}

/**
 * Settings button — extracted so the expanded-sidebar and
 * collapsed-sidebar copies are guaranteed identical.
 *
 * Heroicons `cog-6-tooth` — definitively 6 teeth (the path
 * traces 6 distinct bumps via rounded square "cogs" around
 * the perimeter), stroke-only outline, no fill, no animation.
 * The inner `<path>` is a 3-radius "eye" at center.
 *
 * Sized at 16×16 inside the 32×32 .icon-btn so the icon
 * sits visually smaller than the other top-bar buttons,
 * matching the user's "minimal" preference.
 */
function SettingsIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="icon-btn"
      aria-label="Open settings"
      onClick={onClick}
      title="Settings"
    >
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {/* Outer cog: 6 rounded "teeth" arranged around a central
            hexagonal frame. Traced as a single closed path so the
            stroke is one continuous outline. */}
        <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
        {/* Inner eye: 3-radius circle at the gear's center. Drawn
            as a closed path (not <circle>) for consistent stroke
            rendering with the outer cog. */}
        <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
      </svg>
    </button>
  );
}
