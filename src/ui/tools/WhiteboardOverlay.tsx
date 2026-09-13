import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  getWhiteboardUiSnapshot,
  importWhiteboardPackageIntoEmptyConversation,
  isAnyStreaming,
  isGenerationBlockingOperationActive,
  useConversations,
} from '../../store/conversations.ts';
import {
  savePendingUserWhiteboard,
  subscribeWhiteboardStorageChanges,
  type WhiteboardUiSnapshot,
  type WhiteboardVersion,
} from '../../store/whiteboard.ts';
import { errorMessage } from '../../modules/llm-client/index.ts';
import { Markdown } from '../../utils/markdown.tsx';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';
import { saveBlobFile } from '../../utils/saveBlob.ts';
import { toast } from '../../utils/toast.ts';
import {
  captureWhiteboardVisibleExport,
  createWhiteboardOverlayState,
  isWhiteboardScrollAnchored,
  isWhiteboardUserEditDirty,
  resolveWhiteboardPaneSelection,
  selectWhiteboardVisibleSource,
  stepWhiteboardHistory,
  whiteboardByteCounter,
  whiteboardOverlayReducer,
  whiteboardRetainedHistory,
  type WhiteboardOwner,
  type WhiteboardPaneDocuments,
} from './whiteboard-state.ts';
import {
  createWhiteboardPackage,
  readWhiteboardPackage,
  whiteboardPackageFilename,
} from './whiteboard-package.ts';
import { pickWhiteboardPackageFile } from './whiteboard-file-picker.ts';
import {
  registerWhiteboardOverlayExitGuard,
  type WhiteboardOverlayExitReason,
} from './whiteboard-overlay-guard.ts';
import {
  WHITEBOARD_UI_TEXT,
  whiteboardExportNotice,
  whiteboardHistoryControlsLabel,
  whiteboardNextVersionLabel,
  whiteboardPreviousVersionLabel,
} from './whiteboard-ui-text.ts';

interface Props {
  conversationId: string;
  onClosed: () => void;
}

interface PendingExit {
  promise: Promise<boolean>;
  resolve: (allowed: boolean) => void;
}

interface WhiteboardVersionPaneDocuments extends WhiteboardPaneDocuments {
  readonly history: readonly WhiteboardVersion[];
}

const TRANSFER_ICON_PROPS = {
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

function ExportIcon() {
  return (
    <svg {...TRANSFER_ICON_PROPS}>
      <path d="M12 4v10" />
      <path d="M7 9l5 5 5-5" />
      <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg {...TRANSFER_ICON_PROPS}>
      <path d="M12 14V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
    </svg>
  );
}

function formatVersionDate(createdAt: number): string {
  return new Date(createdAt).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function currentSource(
  owner: WhiteboardOwner,
  snapshot: WhiteboardUiSnapshot,
): WhiteboardPaneDocuments['current'] {
  if (owner === 'model' && snapshot.provisionalModel) {
    return { source: 'live-provisional', markdown: snapshot.provisionalModel.content };
  }
  if (owner === 'user' && snapshot.pendingUser) {
    return { source: 'pending-rendered', markdown: snapshot.pendingUser.content };
  }
  const retained = owner === 'model' ? snapshot.modelHead : snapshot.userHead;
  return { source: 'retained-current', markdown: retained?.content ?? '' };
}

function currentExists(owner: WhiteboardOwner, snapshot: WhiteboardUiSnapshot): boolean {
  return owner === 'model'
    ? snapshot.provisionalModel !== null || snapshot.modelHead !== null
    : snapshot.pendingUser !== null || snapshot.userHead !== null;
}

function paneLabel(
  owner: WhiteboardOwner,
  selection: ReturnType<typeof resolveWhiteboardPaneSelection<WhiteboardVersion>>,
  snapshot: WhiteboardUiSnapshot,
  editing: boolean,
): string {
  if (selection.kind === 'historical') return formatVersionDate(selection.version.createdAt);
  if (selection.kind === 'unavailable') return WHITEBOARD_UI_TEXT.shortVersionUnavailable;
  if (owner === 'model' && snapshot.provisionalModel) return WHITEBOARD_UI_TEXT.currentLive;
  if (owner === 'user' && editing) return WHITEBOARD_UI_TEXT.currentUnsaved;
  if (owner === 'user' && snapshot.pendingUser) return WHITEBOARD_UI_TEXT.currentSavedForNextSend;
  const head = owner === 'model' ? snapshot.modelHead : snapshot.userHead;
  return head
    ? `${WHITEBOARD_UI_TEXT.current} · ${formatVersionDate(head.createdAt)}`
    : WHITEBOARD_UI_TEXT.current;
}

function exportSelectionLabel(
  owner: WhiteboardOwner,
  selection: ReturnType<typeof resolveWhiteboardPaneSelection<WhiteboardVersion>>,
  snapshot: WhiteboardUiSnapshot,
  userEditing: boolean,
): string {
  if (selection.kind === 'historical') return formatVersionDate(selection.version.createdAt);
  if (selection.kind === 'unavailable') return WHITEBOARD_UI_TEXT.shortVersionUnavailable;
  if (owner === 'user' && userEditing) return WHITEBOARD_UI_TEXT.unsavedDraft;
  const timestamp = owner === 'model'
    ? snapshot.provisionalModel?.updatedAt ?? snapshot.modelHead?.createdAt
    : snapshot.pendingUser?.updatedAt ?? snapshot.userHead?.createdAt;
  return timestamp === undefined
    ? WHITEBOARD_UI_TEXT.unavailable
    : formatVersionDate(timestamp);
}

export function WhiteboardOverlay({ conversationId, onClosed }: Props) {
  const [snapshot, setSnapshot] = useState<WhiteboardUiSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeOwner, setActiveOwner] = useState<WhiteboardOwner>('model');
  const [state, dispatch] = useReducer(
    whiteboardOverlayReducer,
    undefined,
    () => createWhiteboardOverlayState(),
  );
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingExitRef = useRef<PendingExit | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const modelBodyRef = useRef<HTMLDivElement | null>(null);
  const userBodyRef = useRef<HTMLDivElement | null>(null);
  const ownerScrollTopRef = useRef<Record<WhiteboardOwner, number>>({ model: 0, user: 0 });
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmReturnFocusRef = useRef<HTMLElement | null>(null);
  const refreshSequenceRef = useRef(0);
  const modelHeadSignatureRef = useRef<string | null>(null);
  const modelAnchorMeasuredRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const runtimeBusy = useConversations(
    () => isAnyStreaming() || isGenerationBlockingOperationActive(),
  );

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    try {
      const next = await getWhiteboardUiSnapshot(conversationId);
      if (sequence !== refreshSequenceRef.current) return;
      const modelSignature = next.provisionalModel
        ? `working:${next.provisionalModel.id ?? 'initial'}:${next.provisionalModel.updatedAt}:${next.provisionalModel.content}`
        : `retained:${next.modelHead?.id ?? 'missing'}`;
      if (
        modelHeadSignatureRef.current !== null
        && modelHeadSignatureRef.current !== modelSignature
      ) {
        dispatch({ type: 'head-updated', owner: 'model' });
      }
      modelHeadSignatureRef.current = modelSignature;
      setSnapshot(next);
      setLoadError(null);
    } catch (error) {
      if (sequence !== refreshSequenceRef.current) return;
      setLoadError(errorMessage(error));
    }
  }, [conversationId]);

  useEffect(() => {
    return subscribeWhiteboardStorageChanges((changedConversationId) => {
      if (changedConversationId === null || changedConversationId === conversationId) {
        void refresh();
      }
    });
  }, [conversationId, refresh]);
  useEffect(() => {
    void refresh();
  }, [refresh, runtimeBusy]);

  useEffect(() => {
    if (activeOwner === 'user' && state.userEditor.mode === 'editing') {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [activeOwner, state.userEditor.mode]);
  useLayoutEffect(() => {
    const pane = activeOwner === 'model' ? modelBodyRef.current : userBodyRef.current;
    if (pane) pane.scrollTop = ownerScrollTopRef.current[activeOwner];
  }, [activeOwner]);
  useEffect(() => {
    requestAnimationFrame(() => closeButtonRef.current?.focus());
  }, []);

  const documents = useMemo<
    Readonly<Record<WhiteboardOwner, WhiteboardVersionPaneDocuments>> | null
  >(() => {
    if (!snapshot) return null;
    return {
      model: {
        current: currentSource('model', snapshot),
        history: whiteboardRetainedHistory(
          snapshot.modelVersions,
          snapshot.modelHead?.id ?? null,
          snapshot.provisionalModel !== null,
        ),
      },
      user: {
        current: currentSource('user', snapshot),
        history: whiteboardRetainedHistory(
          snapshot.userVersions,
          snapshot.userHead?.id ?? null,
          snapshot.pendingUser !== null,
        ),
      },
    };
  }, [snapshot]);

  const visibleModel = documents
    ? selectWhiteboardVisibleSource(state, 'model', documents.model)
    : null;
  const visibleUser = documents
    ? selectWhiteboardVisibleSource(state, 'user', documents.user)
    : null;
  const dirty = isWhiteboardUserEditDirty(state.userEditor);

  const finishConfirmation = useCallback((allowed: boolean) => {
    const pending = pendingExitRef.current;
    const returnFocus = confirmReturnFocusRef.current;
    pendingExitRef.current = null;
    confirmReturnFocusRef.current = null;
    setConfirmOpen(false);
    pending?.resolve(allowed);
    if (allowed) {
      onClosed();
      return;
    }
    requestAnimationFrame(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
      else (textareaRef.current ?? closeButtonRef.current)?.focus();
    });
  }, [onClosed]);

  const attemptClose = useCallback((reason: WhiteboardOverlayExitReason): Promise<boolean> => {
    void reason;
    if (saveInFlightRef.current) return Promise.resolve(false);
    if (!dirty) {
      onClosed();
      return Promise.resolve(true);
    }
    if (pendingExitRef.current) return pendingExitRef.current.promise;
    let resolve!: (allowed: boolean) => void;
    const promise = new Promise<boolean>((done) => { resolve = done; });
    pendingExitRef.current = { promise, resolve };
    confirmReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setConfirmOpen(true);
    return promise;
  }, [dirty, onClosed]);

  const attemptCloseRef = useRef(attemptClose);
  useEffect(() => {
    attemptCloseRef.current = attemptClose;
  }, [attemptClose]);
  useEffect(() => registerWhiteboardOverlayExitGuard(
    (reason) => attemptCloseRef.current(reason),
  ), []);
  useEffect(() => () => {
    pendingExitRef.current?.resolve(false);
    pendingExitRef.current = null;
  }, []);

  useEffect(() => {
    if (!dirty && !saving) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty, saving]);

  useOverlayEscape(() => { void attemptCloseRef.current('escape'); });
  useOverlayEscape(() => finishConfirmation(false), confirmOpen);

  const measureModelAnchor = useCallback(() => {
    const pane = modelBodyRef.current;
    if (!pane) return;
    dispatch({
      type: 'set-scroll-anchor',
      owner: 'model',
      anchoredAtBottom: isWhiteboardScrollAnchored(pane),
    });
  }, []);
  useLayoutEffect(() => {
    if (!snapshot || modelAnchorMeasuredRef.current) return;
    modelAnchorMeasuredRef.current = true;
    measureModelAnchor();
  }, [measureModelAnchor, snapshot]);
  useEffect(() => {
    window.addEventListener('resize', measureModelAnchor);
    return () => window.removeEventListener('resize', measureModelAnchor);
  }, [measureModelAnchor]);
  const handleModelMarkdownCommitted = useCallback((_markdown: string) => {
    if (state.panes.model.selectedVersionId !== null) return;
    if (!state.panes.model.anchoredAtBottom) return;
    const pane = modelBodyRef.current;
    if (pane) {
      pane.scrollTop = pane.scrollHeight;
      ownerScrollTopRef.current.model = pane.scrollTop;
    }
  }, [state.panes.model.anchoredAtBottom, state.panes.model.selectedVersionId]);

  const stepHistory = (owner: WhiteboardOwner, direction: 'previous' | 'next') => {
    if (!documents) return;
    const versions = documents[owner].history;
    const next = stepWhiteboardHistory(
      state.panes[owner],
      versions.map((version) => version.id),
      direction,
    );
    if (next.selectedVersionId === null) dispatch({ type: 'select-current', owner });
    else dispatch({ type: 'select-history', owner, versionId: next.selectedVersionId });
  };

  const trapDialogFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const root = confirmOpen
      ? dialogRef.current?.querySelector<HTMLElement>('.whiteboard-confirm') ?? null
      : dialogRef.current;
    if (!root) return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.closest('[inert]') && element.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleSave = async () => {
    const draftMarkdown = state.userEditor.draftMarkdown;
    const counter = whiteboardByteCounter(draftMarkdown);
    if (!counter.canSave) {
      toast.error(WHITEBOARD_UI_TEXT.userTooLarge);
      return;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      await savePendingUserWhiteboard(conversationId, draftMarkdown);
      dispatch({ type: 'commit-user-edit', markdown: draftMarkdown });
      await refresh();
      toast.success(WHITEBOARD_UI_TEXT.savedForNextSend);
    } catch (error) {
      toast.error(`${WHITEBOARD_UI_TEXT.couldNotSave} ${errorMessage(error)}`);
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  };

  const handleExport = async () => {
    if (!snapshot || !documents) return;
    if (
      (state.panes.model.selectedVersionId === null && !currentExists('model', snapshot))
      || (state.panes.user.selectedVersionId === null && !currentExists('user', snapshot))
    ) {
      toast.error(WHITEBOARD_UI_TEXT.visibleVersionUnavailable);
      return;
    }
    const capture = captureWhiteboardVisibleExport(state, documents);
    if (!capture.ok) {
      toast.error(WHITEBOARD_UI_TEXT.visibleVersionUnavailable);
      return;
    }
    // Capture both primitive strings before the first await. Later live model
    // updates cannot change this ZIP's contents.
    const modelMarkdown = capture.entries['model.md'];
    const userMarkdown = capture.entries['user.md'];
    const filename = whiteboardPackageFilename(new Date());
    setExporting(true);
    try {
      const archive = createWhiteboardPackage({ modelMarkdown, userMarkdown });
      const saved = await saveBlobFile(filename, archive, [
        { name: WHITEBOARD_UI_TEXT.packageFilter, extensions: ['zip'] },
      ]);
      if (saved) toast.success(WHITEBOARD_UI_TEXT.packageExported);
    } catch (error) {
      toast.error(`${WHITEBOARD_UI_TEXT.couldNotExport} ${errorMessage(error)}`);
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const file = await pickWhiteboardPackageFile();
      if (!file) return;
      const contents = await readWhiteboardPackage({ name: file.name, data: file });
      await importWhiteboardPackageIntoEmptyConversation(conversationId, contents);
      dispatch({ type: 'select-current', owner: 'model' });
      dispatch({ type: 'select-current', owner: 'user' });
      await refresh();
      toast.success(WHITEBOARD_UI_TEXT.packageImported);
    } catch (error) {
      toast.error(`${WHITEBOARD_UI_TEXT.couldNotImport} ${errorMessage(error)}`);
    } finally {
      setImporting(false);
    }
  };

  const renderHistoryControls = (owner: WhiteboardOwner) => {
    if (!snapshot || !documents) return null;
    const versions = documents[owner].history;
    const pane = state.panes[owner];
    const selection = resolveWhiteboardPaneSelection(pane, versions);
    const index = selection.kind === 'historical'
      ? versions.findIndex((version) => version.id === selection.version.id)
      : selection.kind === 'current'
        ? versions.length
        : -1;
    const editing = owner === 'user' && state.userEditor.mode === 'editing';
    return (
      <div className="whiteboard-history" aria-label={whiteboardHistoryControlsLabel(owner)}>
        <button
          type="button"
          className="icon-btn"
          onClick={() => stepHistory(owner, 'previous')}
          disabled={editing || index === 0 || versions.length === 0 || index < 0}
          aria-label={whiteboardPreviousVersionLabel(owner)}
          title={WHITEBOARD_UI_TEXT.previousVersion}
        >
          <svg
            className="whiteboard-history-chevron"
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="whiteboard-version-label">
          {paneLabel(owner, selection, snapshot, editing)}
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => stepHistory(owner, 'next')}
          disabled={editing || selection.kind === 'current'}
          aria-label={whiteboardNextVersionLabel(owner)}
          title={WHITEBOARD_UI_TEXT.nextVersion}
        >
          <svg
            className="whiteboard-history-chevron"
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
    );
  };

  const modelSelection = snapshot
    ? resolveWhiteboardPaneSelection(state.panes.model, documents?.model.history ?? [])
    : null;
  const userSelection = snapshot
    ? resolveWhiteboardPaneSelection(state.panes.user, documents?.user.history ?? [])
    : null;
  const editorCounter = whiteboardByteCounter(state.userEditor.draftMarkdown);
  const exportNotice = snapshot && modelSelection && userSelection
    ? whiteboardExportNotice(
        exportSelectionLabel('model', modelSelection, snapshot, false),
        exportSelectionLabel(
          'user',
          userSelection,
          snapshot,
          state.userEditor.mode === 'editing',
        ),
      )
    : '';
  const importVisible = Boolean(
    snapshot?.importEligible
    && !runtimeBusy
    && state.userEditor.mode === 'rendered',
  );

  const handleOwnerTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    let owner: WhiteboardOwner | null = null;
    if (event.key === 'Home') owner = 'model';
    else if (event.key === 'End') owner = 'user';
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      owner = activeOwner === 'model' ? 'user' : 'model';
    }
    if (!owner) return;
    event.preventDefault();
    setActiveOwner(owner);
    requestAnimationFrame(() => {
      document.getElementById(`whiteboard-${owner}-tab`)?.focus();
    });
  };

  return createPortal(
    <div
      className="whiteboard-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="whiteboard-title"
      onClick={() => { void attemptCloseRef.current('backdrop'); }}
    >
      <section
        ref={dialogRef}
        className="whiteboard-dialog"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={trapDialogFocus}
      >
        <header className="whiteboard-header" inert={confirmOpen}>
          <div className="whiteboard-heading">
            <h3 id="whiteboard-title" title={WHITEBOARD_UI_TEXT.description}>
              {WHITEBOARD_UI_TEXT.title}
            </h3>
          </div>
          <div
            className="conv-filter-tabs whiteboard-owner-tabs"
            role="tablist"
            aria-label={WHITEBOARD_UI_TEXT.ownerTabs}
          >
            <button
              id="whiteboard-model-tab"
              type="button"
              role="tab"
              aria-selected={activeOwner === 'model'}
              aria-controls="whiteboard-board-panel"
              tabIndex={activeOwner === 'model' ? 0 : -1}
              className={`conv-filter-tab${activeOwner === 'model' ? ' is-active' : ''}`}
              onClick={() => setActiveOwner('model')}
              onKeyDown={handleOwnerTabKeyDown}
            >
              {WHITEBOARD_UI_TEXT.modelTab}
            </button>
            <button
              id="whiteboard-user-tab"
              type="button"
              role="tab"
              aria-selected={activeOwner === 'user'}
              aria-controls="whiteboard-board-panel"
              tabIndex={activeOwner === 'user' ? 0 : -1}
              className={`conv-filter-tab${activeOwner === 'user' ? ' is-active' : ''}`}
              onClick={() => setActiveOwner('user')}
              onKeyDown={handleOwnerTabKeyDown}
            >
              {WHITEBOARD_UI_TEXT.userTab}
            </button>
          </div>
          <div className="whiteboard-header-actions">
            <button
              ref={closeButtonRef}
              type="button"
              className="icon-btn"
              onClick={() => { void attemptCloseRef.current('close'); }}
              disabled={saving}
              aria-label={WHITEBOARD_UI_TEXT.closeWhiteboard}
              title={WHITEBOARD_UI_TEXT.close}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path
                  fill="currentColor"
                  d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                />
              </svg>
            </button>
          </div>
        </header>

        {loadError && (
          <div className="whiteboard-load-error" role="alert" inert={confirmOpen}>
            {WHITEBOARD_UI_TEXT.couldNotLoad} {loadError}
            <button type="button" className="link-btn" onClick={() => { void refresh(); }}>
              {WHITEBOARD_UI_TEXT.retry}
            </button>
          </div>
        )}

        {!snapshot ? (
          <div className="whiteboard-loading" role="status" inert={confirmOpen}>
            {WHITEBOARD_UI_TEXT.loading}
          </div>
        ) : (
          <div className="whiteboard-board" inert={confirmOpen}>
            <section
              id="whiteboard-board-panel"
              className="whiteboard-pane"
              role="tabpanel"
              aria-labelledby={`whiteboard-${activeOwner}-tab`}
            >
              <header
                className={`whiteboard-board-toolbar${activeOwner === 'user' && state.userEditor.mode === 'editing' ? ' is-editing' : ''}`}
              >
                {renderHistoryControls(activeOwner)}
                {activeOwner === 'user' && (
                  <div className="whiteboard-user-action-group">
                    {state.userEditor.mode === 'editing' ? (
                      <>
                        <button
                          type="button"
                          className="ghost-btn small whiteboard-user-action"
                          onClick={() => dispatch({ type: 'cancel-user-edit' })}
                          disabled={saving}
                        >
                          {WHITEBOARD_UI_TEXT.cancel}
                        </button>
                        <button
                          type="button"
                          className="primary-btn small whiteboard-user-action"
                          onClick={() => { void handleSave(); }}
                          disabled={saving || !editorCounter.canSave}
                        >
                          {saving ? WHITEBOARD_UI_TEXT.saving : WHITEBOARD_UI_TEXT.save}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="ghost-btn small whiteboard-user-action"
                        onClick={() => {
                          if (!visibleUser?.available) return;
                          dispatch({ type: 'begin-user-edit', markdown: visibleUser.markdown });
                        }}
                        disabled={userSelection?.kind !== 'current' || !visibleUser?.available}
                      >
                        {WHITEBOARD_UI_TEXT.edit}
                      </button>
                    )}
                  </div>
                )}
              </header>

              {activeOwner === 'model' && state.panes.model.newerVersionAvailable && (
                <div className="whiteboard-newer" role="status">
                  {WHITEBOARD_UI_TEXT.newerVersionAvailable}
                </div>
              )}

              {activeOwner === 'model' ? (
                <div
                  ref={modelBodyRef}
                  className="whiteboard-pane-body"
                  tabIndex={0}
                  aria-label={WHITEBOARD_UI_TEXT.modelMarkdown}
                  onScroll={(event) => {
                    ownerScrollTopRef.current.model = event.currentTarget.scrollTop;
                    dispatch({
                      type: 'set-scroll-anchor',
                      owner: 'model',
                      anchoredAtBottom: isWhiteboardScrollAnchored(event.currentTarget),
                    });
                  }}
                >
                  {!currentExists('model', snapshot)
                    && state.panes.model.selectedVersionId === null ? (
                      <p className="whiteboard-unavailable">{WHITEBOARD_UI_TEXT.versionUnavailable}</p>
                    ) : visibleModel?.available ? (
                      visibleModel.markdown.length > 0
                        ? (
                          <Markdown onCommitted={handleModelMarkdownCommitted}>
                            {visibleModel.markdown}
                          </Markdown>
                        )
                        : <p className="whiteboard-empty">{WHITEBOARD_UI_TEXT.nothingHereYet}</p>
                    ) : (
                      <p className="whiteboard-unavailable">{WHITEBOARD_UI_TEXT.versionUnavailable}</p>
                    )}
                </div>
              ) : (
                <div
                  ref={userBodyRef}
                  className="whiteboard-pane-body whiteboard-user-body"
                  tabIndex={0}
                  onScroll={(event) => {
                    ownerScrollTopRef.current.user = event.currentTarget.scrollTop;
                  }}
                >
                  {!currentExists('user', snapshot)
                    && state.panes.user.selectedVersionId === null ? (
                      <p className="whiteboard-unavailable">{WHITEBOARD_UI_TEXT.versionUnavailable}</p>
                    ) : state.userEditor.mode === 'editing' ? (
                      <div className="whiteboard-editor">
                        <textarea
                          ref={textareaRef}
                          value={state.userEditor.draftMarkdown}
                          disabled={saving}
                          onChange={(event) => dispatch({
                            type: 'change-user-draft',
                            markdown: event.target.value,
                          })}
                          aria-label={WHITEBOARD_UI_TEXT.editUserMarkdown}
                          aria-describedby="whiteboard-user-byte-counter"
                          spellCheck
                        />
                        <span
                          id="whiteboard-user-byte-counter"
                          className={`whiteboard-byte-counter${editorCounter.nearLimit ? ' is-near' : ''}${editorCounter.overLimit ? ' is-over' : ''}`}
                        >
                          {editorCounter.usedBytes.toLocaleString()} / {editorCounter.limitBytes.toLocaleString()} {WHITEBOARD_UI_TEXT.bytes}
                        </span>
                        <span
                          className="sr-only"
                          role={editorCounter.overLimit ? 'alert' : 'status'}
                        >
                          {editorCounter.overLimit
                            ? WHITEBOARD_UI_TEXT.overLimit
                            : editorCounter.nearLimit
                              ? WHITEBOARD_UI_TEXT.nearLimit
                              : ''}
                        </span>
                      </div>
                    ) : visibleUser?.available ? (
                      visibleUser.markdown.length > 0
                        ? <Markdown>{visibleUser.markdown}</Markdown>
                        : <p className="whiteboard-empty">{WHITEBOARD_UI_TEXT.nothingHereYet}</p>
                    ) : (
                      <p className="whiteboard-unavailable">{WHITEBOARD_UI_TEXT.versionUnavailable}</p>
                    )}
                </div>
              )}
            </section>
          </div>
        )}

        <footer className="whiteboard-footer" inert={confirmOpen}>
          <span>{exportNotice}</span>
          <div className="whiteboard-footer-actions">
            <button
              type="button"
              className="ghost-btn small"
              onClick={() => { void handleExport(); }}
              disabled={
                exporting
                || snapshot === null
                || (state.userEditor.mode === 'editing' && editorCounter.overLimit)
              }
              title={
                state.userEditor.mode === 'editing' && editorCounter.overLimit
                  ? WHITEBOARD_UI_TEXT.userTooLarge
                  : undefined
              }
            >
              <ExportIcon />
              {exporting ? WHITEBOARD_UI_TEXT.exporting : WHITEBOARD_UI_TEXT.export}
            </button>
            {importVisible && (
              <button
                type="button"
                className="ghost-btn small"
                onClick={() => { void handleImport(); }}
                disabled={importing}
              >
                <ImportIcon />
                {importing ? WHITEBOARD_UI_TEXT.importing : WHITEBOARD_UI_TEXT.import}
              </button>
            )}
          </div>
        </footer>

        {confirmOpen && (
          <div
            className="whiteboard-confirm-backdrop"
            role="presentation"
            onClick={(event) => {
              event.stopPropagation();
              finishConfirmation(false);
            }}
          >
            <div
              className="whiteboard-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="whiteboard-discard-title"
              aria-describedby="whiteboard-discard-description"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="whiteboard-discard-title">{WHITEBOARD_UI_TEXT.discardTitle}</h3>
              <p id="whiteboard-discard-description">
                {WHITEBOARD_UI_TEXT.discardDescription}
              </p>
              <div className="whiteboard-confirm-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => finishConfirmation(false)}
                  autoFocus
                >
                  {WHITEBOARD_UI_TEXT.keepEditing}
                </button>
                <button
                  type="button"
                  className="primary-btn danger"
                  onClick={() => finishConfirmation(true)}
                >
                  {WHITEBOARD_UI_TEXT.discardChanges}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
