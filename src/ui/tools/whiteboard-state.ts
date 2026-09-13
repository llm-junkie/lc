import { utf8ByteLength } from '../../modules/tool-engine/utf8-budget.ts';

export const WHITEBOARD_MARKDOWN_MAX_BYTES = 32 * 1024;
export const WHITEBOARD_BYTE_COUNTER_MARGIN_BYTES = 4 * 1024;
export const WHITEBOARD_SCROLL_ANCHOR_TOLERANCE_PX = 24;

export type WhiteboardLayout = 'tabbed';
export type WhiteboardOwner = 'model' | 'user';

/**
 * The retained history is ordered independently for each owner. `null` is the
 * virtual current head (retained, pending, or provisional); working heads are
 * deliberately never inserted into the retained-version position count.
 */
export interface WhiteboardPaneState {
  readonly selectedVersionId: string | null;
  readonly anchoredAtBottom: boolean;
  readonly newerVersionAvailable: boolean;
}

export interface WhiteboardUserEditorState {
  readonly mode: 'rendered' | 'editing';
  readonly savedMarkdown: string;
  readonly draftMarkdown: string;
}

export interface WhiteboardOverlayState {
  readonly panes: Readonly<Record<WhiteboardOwner, WhiteboardPaneState>>;
  readonly userEditor: WhiteboardUserEditorState;
}

export type WhiteboardOverlayAction =
  | { type: 'select-current'; owner: WhiteboardOwner }
  | { type: 'select-history'; owner: WhiteboardOwner; versionId: string }
  | { type: 'set-scroll-anchor'; owner: WhiteboardOwner; anchoredAtBottom: boolean }
  | { type: 'head-updated'; owner: WhiteboardOwner }
  | { type: 'begin-user-edit'; markdown: string }
  | { type: 'change-user-draft'; markdown: string }
  | { type: 'commit-user-edit'; markdown: string }
  | { type: 'cancel-user-edit' };

export interface WhiteboardRetainedDocument {
  readonly id: string;
  readonly content: string;
}

export type WhiteboardCurrentSource =
  | 'retained-current'
  | 'pending-rendered'
  | 'live-provisional';

export interface WhiteboardPaneDocuments {
  readonly current: {
    readonly source: WhiteboardCurrentSource;
    readonly markdown: string;
  };
  readonly history: readonly WhiteboardRetainedDocument[];
}

export type WhiteboardVisibleSourceKind =
  | WhiteboardCurrentSource
  | 'historical'
  | 'raw-editor';

export type WhiteboardVisibleSource =
  | {
      readonly available: true;
      readonly source: WhiteboardVisibleSourceKind;
      readonly markdown: string;
      readonly versionId: string | null;
    }
  | {
      readonly available: false;
      readonly source: 'unavailable';
      readonly versionId: string;
    };

export type WhiteboardPaneSelection<T extends { readonly id: string }> =
  | { readonly kind: 'current' }
  | { readonly kind: 'historical'; readonly version: T }
  | { readonly kind: 'unavailable'; readonly versionId: string };

export type WhiteboardVisibleExportCapture =
  | {
      readonly ok: true;
      readonly entries: Readonly<{
        'model.md': string;
        'user.md': string;
      }>;
      readonly sources: Readonly<{
        model: WhiteboardVisibleSourceKind;
        user: WhiteboardVisibleSourceKind;
      }>;
    }
  | {
      readonly ok: false;
      readonly unavailable: readonly Readonly<{
        owner: WhiteboardOwner;
        versionId: string;
      }>[];
    };

export interface WhiteboardByteCounter {
  readonly usedBytes: number;
  readonly limitBytes: number;
  readonly remainingBytes: number;
  readonly nearLimit: boolean;
  readonly overLimit: boolean;
  readonly canSave: boolean;
}

export interface WhiteboardScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface WhiteboardHeadUpdateDecision {
  readonly autoScroll: boolean;
  readonly showNewerVersionAvailable: boolean;
}

export type WhiteboardDirtyExitDecision = 'close' | 'confirm' | 'keep-open';

export function whiteboardLayoutForWidth(_width: number): WhiteboardLayout {
  return 'tabbed';
}

export function createWhiteboardOverlayState(input: {
  userMarkdown?: string;
  modelSelectedVersionId?: string | null;
  userSelectedVersionId?: string | null;
} = {}): WhiteboardOverlayState {
  const userMarkdown = input.userMarkdown ?? '';
  return {
    panes: {
      model: {
        selectedVersionId: input.modelSelectedVersionId ?? null,
        anchoredAtBottom: false,
        newerVersionAvailable: false,
      },
      user: {
        selectedVersionId: input.userSelectedVersionId ?? null,
        anchoredAtBottom: false,
        newerVersionAvailable: false,
      },
    },
    userEditor: {
      mode: 'rendered',
      savedMarkdown: userMarkdown,
      draftMarkdown: userMarkdown,
    },
  };
}

function replacePane(
  state: WhiteboardOverlayState,
  owner: WhiteboardOwner,
  pane: WhiteboardPaneState,
): WhiteboardOverlayState {
  return {
    ...state,
    panes: { ...state.panes, [owner]: pane },
  };
}

export function whiteboardHeadUpdateDecision(
  pane: WhiteboardPaneState,
): WhiteboardHeadUpdateDecision {
  const showingHistory = pane.selectedVersionId !== null;
  return {
    autoScroll: !showingHistory && pane.anchoredAtBottom,
    showNewerVersionAvailable: showingHistory,
  };
}

export function whiteboardOverlayReducer(
  state: WhiteboardOverlayState,
  action: WhiteboardOverlayAction,
): WhiteboardOverlayState {
  switch (action.type) {
    case 'select-current': {
      const pane = state.panes[action.owner];
      if (pane.selectedVersionId === null && !pane.newerVersionAvailable) return state;
      return replacePane(state, action.owner, {
        ...pane,
        selectedVersionId: null,
        newerVersionAvailable: false,
      });
    }
    case 'select-history': {
      if (action.owner === 'user' && isWhiteboardUserEditDirty(state.userEditor)) {
        return state;
      }
      const pane = state.panes[action.owner];
      if (pane.selectedVersionId === action.versionId) return state;
      return replacePane(state, action.owner, {
        ...pane,
        selectedVersionId: action.versionId,
        // Keep a live-update signal while moving among historical rows, but
        // do not invent one when history is first opened from the current head.
        newerVersionAvailable: pane.selectedVersionId === null
          ? false
          : pane.newerVersionAvailable,
      });
    }
    case 'set-scroll-anchor': {
      const pane = state.panes[action.owner];
      if (pane.anchoredAtBottom === action.anchoredAtBottom) return state;
      return replacePane(state, action.owner, {
        ...pane,
        anchoredAtBottom: action.anchoredAtBottom,
      });
    }
    case 'head-updated': {
      const pane = state.panes[action.owner];
      const decision = whiteboardHeadUpdateDecision(pane);
      if (pane.newerVersionAvailable === decision.showNewerVersionAvailable) return state;
      return replacePane(state, action.owner, {
        ...pane,
        newerVersionAvailable: decision.showNewerVersionAvailable,
      });
    }
    case 'begin-user-edit': {
      if (state.panes.user.selectedVersionId !== null) return state;
      return {
        ...state,
        userEditor: {
          mode: 'editing',
          savedMarkdown: action.markdown,
          draftMarkdown: action.markdown,
        },
      };
    }
    case 'change-user-draft': {
      if (state.userEditor.mode !== 'editing'
        || state.userEditor.draftMarkdown === action.markdown) {
        return state;
      }
      return {
        ...state,
        userEditor: { ...state.userEditor, draftMarkdown: action.markdown },
      };
    }
    case 'commit-user-edit': {
      if (state.userEditor.mode !== 'editing') return state;
      const hasNewerDraft = state.userEditor.draftMarkdown !== action.markdown;
      return {
        ...state,
        userEditor: {
          mode: hasNewerDraft ? 'editing' : 'rendered',
          savedMarkdown: action.markdown,
          draftMarkdown: state.userEditor.draftMarkdown,
        },
      };
    }
    case 'cancel-user-edit': {
      if (state.userEditor.mode !== 'editing') return state;
      return {
        ...state,
        userEditor: {
          mode: 'rendered',
          savedMarkdown: state.userEditor.savedMarkdown,
          draftMarkdown: state.userEditor.savedMarkdown,
        },
      };
    }
  }
}

export function resolveWhiteboardPaneSelection<T extends { readonly id: string }>(
  pane: WhiteboardPaneState,
  history: readonly T[],
): WhiteboardPaneSelection<T> {
  if (pane.selectedVersionId === null) return { kind: 'current' };
  const version = history.find((candidate) => candidate.id === pane.selectedVersionId);
  return version
    ? { kind: 'historical', version }
    : { kind: 'unavailable', versionId: pane.selectedVersionId };
}

/**
 * Build the rows behind the virtual current head without duplicating a
 * retained current row. A pending/provisional current is not retained, so all
 * retained rows remain navigable behind it.
 */
export function whiteboardRetainedHistory<T extends { readonly id: string }>(
  versions: readonly T[],
  retainedCurrentId: string | null,
  hasWorkingCurrent: boolean,
): readonly T[] {
  if (hasWorkingCurrent || retainedCurrentId === null) return versions;
  return versions.filter((version) => version.id !== retainedCurrentId);
}

/** Move through retained rows, treating the current working head as a virtual end. */
export function stepWhiteboardHistory(
  pane: WhiteboardPaneState,
  retainedVersionIds: readonly string[],
  direction: 'previous' | 'next',
): WhiteboardPaneState {
  if (retainedVersionIds.length === 0) return pane;
  if (pane.selectedVersionId === null) {
    if (direction === 'next') return pane;
    return {
      ...pane,
      selectedVersionId: retainedVersionIds[retainedVersionIds.length - 1],
      newerVersionAvailable: false,
    };
  }

  const index = retainedVersionIds.indexOf(pane.selectedVersionId);
  if (index < 0) {
    return direction === 'next'
      ? { ...pane, selectedVersionId: null, newerVersionAvailable: false }
      : pane;
  }
  if (direction === 'previous') {
    if (index === 0) return pane;
    return { ...pane, selectedVersionId: retainedVersionIds[index - 1] };
  }
  if (index === retainedVersionIds.length - 1) {
    return { ...pane, selectedVersionId: null, newerVersionAvailable: false };
  }
  return { ...pane, selectedVersionId: retainedVersionIds[index + 1] };
}

export function selectWhiteboardVisibleSource(
  state: WhiteboardOverlayState,
  owner: WhiteboardOwner,
  documents: WhiteboardPaneDocuments,
): WhiteboardVisibleSource {
  if (owner === 'user' && state.userEditor.mode === 'editing') {
    return {
      available: true,
      source: 'raw-editor',
      markdown: state.userEditor.draftMarkdown,
      versionId: null,
    };
  }

  const selection = resolveWhiteboardPaneSelection(state.panes[owner], documents.history);
  if (selection.kind === 'current') {
    return {
      available: true,
      source: documents.current.source,
      markdown: documents.current.markdown,
      versionId: null,
    };
  }
  if (selection.kind === 'historical') {
    return {
      available: true,
      source: 'historical',
      markdown: selection.version.content,
      versionId: selection.version.id,
    };
  }
  return {
    available: false,
    source: 'unavailable',
    versionId: selection.versionId,
  };
}

/** Capture exact primitive-string copies of the two panes visible at this instant. */
export function captureWhiteboardVisibleExport(
  state: WhiteboardOverlayState,
  documents: Readonly<Record<WhiteboardOwner, WhiteboardPaneDocuments>>,
): WhiteboardVisibleExportCapture {
  const model = selectWhiteboardVisibleSource(state, 'model', documents.model);
  const user = selectWhiteboardVisibleSource(state, 'user', documents.user);
  if (!model.available || !user.available) {
    const unavailable: Array<Readonly<{ owner: WhiteboardOwner; versionId: string }>> = [];
    if (!model.available) unavailable.push(Object.freeze({ owner: 'model', versionId: model.versionId }));
    if (!user.available) unavailable.push(Object.freeze({ owner: 'user', versionId: user.versionId }));
    return Object.freeze({ ok: false, unavailable: Object.freeze(unavailable) });
  }
  return Object.freeze({
    ok: true,
    entries: Object.freeze({
      'model.md': model.markdown,
      'user.md': user.markdown,
    }),
    sources: Object.freeze({ model: model.source, user: user.source }),
  });
}

export function whiteboardByteCounter(
  markdown: string,
  limitBytes = WHITEBOARD_MARKDOWN_MAX_BYTES,
): WhiteboardByteCounter {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    throw new RangeError('Whiteboard byte limit must be a positive safe integer.');
  }
  const usedBytes = utf8ByteLength(markdown);
  const remainingBytes = limitBytes - usedBytes;
  const warningMargin = Math.min(WHITEBOARD_BYTE_COUNTER_MARGIN_BYTES, limitBytes);
  const overLimit = usedBytes > limitBytes;
  return {
    usedBytes,
    limitBytes,
    remainingBytes,
    nearLimit: usedBytes >= limitBytes - warningMargin,
    overLimit,
    canSave: !overLimit,
  };
}

export function isWhiteboardScrollAnchored(
  metrics: WhiteboardScrollMetrics,
  tolerancePx = WHITEBOARD_SCROLL_ANCHOR_TOLERANCE_PX,
): boolean {
  if (![metrics.scrollTop, metrics.scrollHeight, metrics.clientHeight, tolerancePx]
    .every(Number.isFinite) || tolerancePx < 0) {
    return false;
  }
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= tolerancePx;
}

export function isWhiteboardUserEditDirty(editor: WhiteboardUserEditorState): boolean {
  return editor.mode === 'editing' && editor.draftMarkdown !== editor.savedMarkdown;
}

/**
 * `undefined` means confirmation has not been requested yet. `null` means the
 * confirmation UI failed; that path deliberately keeps the overlay open.
 */
export function whiteboardDirtyExitDecision(
  dirty: boolean,
  confirmation?: boolean | null,
): WhiteboardDirtyExitDecision {
  if (!dirty || confirmation === true) return 'close';
  if (confirmation === undefined) return 'confirm';
  return 'keep-open';
}
