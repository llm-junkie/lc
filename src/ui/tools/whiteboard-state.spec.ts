/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  WHITEBOARD_EXPORT_SOURCE_FIXTURES,
  WHITEBOARD_OVERLAY_EXIT_FIXTURES,
  WHITEBOARD_UI_STATE_FIXTURES,
} from '../../whiteboard/contract-fixtures.ts';
import {
  captureWhiteboardVisibleExport,
  createWhiteboardOverlayState,
  isWhiteboardScrollAnchored,
  isWhiteboardUserEditDirty,
  resolveWhiteboardPaneSelection,
  selectWhiteboardVisibleSource,
  stepWhiteboardHistory,
  whiteboardByteCounter,
  whiteboardDirtyExitDecision,
  whiteboardHeadUpdateDecision,
  whiteboardLayoutForWidth,
  whiteboardOverlayReducer,
  whiteboardRetainedHistory,
  WHITEBOARD_MARKDOWN_MAX_BYTES,
  type WhiteboardCurrentSource,
  type WhiteboardOverlayState,
  type WhiteboardPaneDocuments,
} from './whiteboard-state.ts';

const whiteboardIconSource = readFileSync(new URL('./WhiteboardIcon.tsx', import.meta.url), 'utf8');

const history = [
  { id: 'm_older', content: '# Older model' },
  { id: 'm_newer', content: '# Newer model' },
] as const;

const modelDocuments = (
  source: WhiteboardCurrentSource = 'retained-current',
): WhiteboardPaneDocuments => ({
  current: { source, markdown: '# Current model' },
  history,
});

const userDocuments = (
  source: WhiteboardCurrentSource = 'retained-current',
): WhiteboardPaneDocuments => ({
  current: { source, markdown: '# Current user' },
  history: [
    { id: 'u_older', content: '# Older user' },
    { id: 'u_newer', content: '# Newer user' },
  ],
});

function selectHistory(
  state: WhiteboardOverlayState,
  owner: 'model' | 'user',
  versionId: string,
): WhiteboardOverlayState {
  return whiteboardOverlayReducer(state, { type: 'select-history', owner, versionId });
}

describe('Whiteboard pure overlay state', () => {
  test('matches every frozen wide and narrow fixture', () => {
    for (const fixture of WHITEBOARD_UI_STATE_FIXTURES) {
      assert.equal(whiteboardLayoutForWidth(fixture.width), fixture.layout, fixture.name);
    }
    assert.equal(whiteboardLayoutForWidth(Number.NaN), 'tabbed');
  });

  test('keeps owner selection independent and fails closed on a missing retained row', () => {
    const initial = createWhiteboardOverlayState();
    const selected = selectHistory(initial, 'model', 'm_older');
    assert.equal(selected.panes.user.selectedVersionId, null);
    assert.deepEqual(resolveWhiteboardPaneSelection(selected.panes.model, history), {
      kind: 'historical',
      version: history[0],
    });

    const missing = selectHistory(selected, 'model', 'm_missing');
    assert.deepEqual(resolveWhiteboardPaneSelection(missing.panes.model, history), {
      kind: 'unavailable',
      versionId: 'm_missing',
    });
    assert.deepEqual(selectWhiteboardVisibleSource(missing, 'model', modelDocuments()), {
      available: false,
      source: 'unavailable',
      versionId: 'm_missing',
    });
  });

  test('moves through retained history without counting the current working head', () => {
    const current = createWhiteboardOverlayState().panes.model;
    const newer = stepWhiteboardHistory(current, history.map((row) => row.id), 'previous');
    assert.equal(newer.selectedVersionId, 'm_newer');
    const older = stepWhiteboardHistory(newer, history.map((row) => row.id), 'previous');
    assert.equal(older.selectedVersionId, 'm_older');
    assert.equal(stepWhiteboardHistory(older, history.map((row) => row.id), 'previous'), older);
    assert.equal(
      stepWhiteboardHistory(older, history.map((row) => row.id), 'next').selectedVersionId,
      'm_newer',
    );
    assert.equal(
      stepWhiteboardHistory(newer, history.map((row) => row.id), 'next').selectedVersionId,
      null,
    );
    const unavailable = { ...current, selectedVersionId: 'm_pruned' };
    assert.equal(
      stepWhiteboardHistory(unavailable, history.map((row) => row.id), 'next').selectedVersionId,
      null,
    );
  });

  test('does not duplicate a retained current head but keeps rows behind working state', () => {
    const baseline = { id: 'm_baseline', content: '' };
    const currentRow = { id: 'm_current', content: '# Current' };
    assert.deepEqual(
      whiteboardRetainedHistory([baseline], baseline.id, false),
      [],
    );
    assert.equal(
      stepWhiteboardHistory(
        createWhiteboardOverlayState().panes.model,
        whiteboardRetainedHistory([baseline], baseline.id, false).map((row) => row.id),
        'previous',
      ).selectedVersionId,
      null,
    );
    assert.deepEqual(
      whiteboardRetainedHistory([baseline, currentRow], currentRow.id, false),
      [baseline],
    );
    assert.deepEqual(
      whiteboardRetainedHistory([baseline, currentRow], currentRow.id, true),
      [baseline, currentRow],
    );
  });

  test('preserves anchored, unanchored, and older live-update behavior', () => {
    let state = createWhiteboardOverlayState();
    assert.deepEqual(whiteboardHeadUpdateDecision(state.panes.model), {
      autoScroll: false,
      showNewerVersionAvailable: false,
    });

    state = whiteboardOverlayReducer(state, {
      type: 'set-scroll-anchor',
      owner: 'model',
      anchoredAtBottom: true,
    });
    assert.deepEqual(whiteboardHeadUpdateDecision(state.panes.model), {
      autoScroll: true,
      showNewerVersionAvailable: false,
    });

    state = whiteboardOverlayReducer(state, {
      type: 'set-scroll-anchor',
      owner: 'model',
      anchoredAtBottom: false,
    });
    assert.deepEqual(whiteboardHeadUpdateDecision(state.panes.model), {
      autoScroll: false,
      showNewerVersionAvailable: false,
    });

    state = selectHistory(state, 'model', 'm_older');
    state = whiteboardOverlayReducer(state, { type: 'head-updated', owner: 'model' });
    assert.equal(state.panes.model.selectedVersionId, 'm_older');
    assert.equal(state.panes.model.newerVersionAvailable, true);
    assert.deepEqual(whiteboardHeadUpdateDecision(state.panes.model), {
      autoScroll: false,
      showNewerVersionAvailable: true,
    });

    const current = whiteboardOverlayReducer(state, { type: 'select-current', owner: 'model' });
    assert.equal(current.panes.model.newerVersionAvailable, false);
    assert.equal(isWhiteboardScrollAnchored({ scrollTop: 75, clientHeight: 100, scrollHeight: 200 }), false);
    assert.equal(isWhiteboardScrollAnchored({ scrollTop: 80, clientHeight: 100, scrollHeight: 200 }), true);
  });

  test('selects all five frozen visible export sources, including the raw editor', () => {
    assert.equal(WHITEBOARD_EXPORT_SOURCE_FIXTURES.length, 5);

    const retained = createWhiteboardOverlayState();
    assert.equal(
      selectWhiteboardVisibleSource(retained, 'model', modelDocuments()).source,
      'retained-current',
    );

    const historical = selectHistory(
      selectHistory(createWhiteboardOverlayState(), 'model', 'm_older'),
      'user',
      'u_older',
    );
    assert.equal(selectWhiteboardVisibleSource(historical, 'model', modelDocuments()).source, 'historical');
    assert.equal(selectWhiteboardVisibleSource(historical, 'user', userDocuments()).source, 'historical');

    const pending = selectHistory(createWhiteboardOverlayState(), 'model', 'm_older');
    assert.equal(
      selectWhiteboardVisibleSource(pending, 'user', userDocuments('pending-rendered')).source,
      'pending-rendered',
    );

    const live = createWhiteboardOverlayState();
    assert.equal(
      selectWhiteboardVisibleSource(live, 'model', modelDocuments('live-provisional')).source,
      'live-provisional',
    );

    let editing = whiteboardOverlayReducer(createWhiteboardOverlayState(), {
      type: 'begin-user-edit',
      markdown: '# Saved user',
    });
    editing = whiteboardOverlayReducer(editing, {
      type: 'change-user-draft',
      markdown: '# Raw unsaved user',
    });
    const capture = captureWhiteboardVisibleExport(editing, {
      model: modelDocuments('live-provisional'),
      user: userDocuments('pending-rendered'),
    });
    assert.equal(capture.ok, true);
    if (!capture.ok) return;
    assert.deepEqual(capture.entries, {
      'model.md': '# Current model',
      'user.md': '# Raw unsaved user',
    });
    assert.deepEqual(capture.sources, {
      model: 'live-provisional',
      user: 'raw-editor',
    });
    assert.equal(Object.isFrozen(capture), true);
    assert.equal(Object.isFrozen(capture.entries), true);
  });

  test('does not fabricate export content for an unavailable selected version', () => {
    const missing = selectHistory(createWhiteboardOverlayState(), 'model', 'm_missing');
    assert.deepEqual(captureWhiteboardVisibleExport(missing, {
      model: modelDocuments(),
      user: userDocuments(),
    }), {
      ok: false,
      unavailable: [{ owner: 'model', versionId: 'm_missing' }],
    });
  });

  test('measures UTF-8 bytes and exposes the bounded-save decision near the limit', () => {
    assert.equal(whiteboardByteCounter('🙂').usedBytes, 4);
    assert.equal(whiteboardByteCounter('a'.repeat(WHITEBOARD_MARKDOWN_MAX_BYTES - 4_097)).nearLimit, false);
    assert.equal(whiteboardByteCounter('a'.repeat(WHITEBOARD_MARKDOWN_MAX_BYTES - 4_096)).nearLimit, true);
    assert.equal(whiteboardByteCounter('a'.repeat(WHITEBOARD_MARKDOWN_MAX_BYTES)).canSave, true);
    const over = whiteboardByteCounter('a'.repeat(WHITEBOARD_MARKDOWN_MAX_BYTES + 1));
    assert.equal(over.overLimit, true);
    assert.equal(over.remainingBytes, -1);
  });

  test('tracks exact editor dirtiness and keeps every rejected or failed exit open', () => {
    let state = whiteboardOverlayReducer(createWhiteboardOverlayState(), {
      type: 'begin-user-edit',
      markdown: '# Saved',
    });
    assert.equal(isWhiteboardUserEditDirty(state.userEditor), false);
    state = whiteboardOverlayReducer(state, {
      type: 'change-user-draft',
      markdown: '# Unsaved',
    });
    assert.equal(isWhiteboardUserEditDirty(state.userEditor), true);
    assert.equal(whiteboardDirtyExitDecision(true), 'confirm');
    assert.equal(whiteboardDirtyExitDecision(true, true), 'close');

    for (const fixture of WHITEBOARD_OVERLAY_EXIT_FIXTURES) {
      const decision = whiteboardDirtyExitDecision(fixture.dirty, fixture.confirmed);
      assert.equal(decision === 'close', fixture.closes, fixture.path);
    }

    const cancelled = whiteboardOverlayReducer(state, { type: 'cancel-user-edit' });
    assert.equal(cancelled.userEditor.draftMarkdown, '# Saved');
    assert.equal(isWhiteboardUserEditDirty(cancelled.userEditor), false);

    const committed = whiteboardOverlayReducer(state, {
      type: 'commit-user-edit',
      markdown: '# Unsaved',
    });
    assert.equal(committed.userEditor.savedMarkdown, '# Unsaved');
    assert.equal(isWhiteboardUserEditDirty(committed.userEditor), false);

    const changedDuringSave = whiteboardOverlayReducer(
      whiteboardOverlayReducer(state, {
        type: 'change-user-draft',
        markdown: '# Newer unsaved edit',
      }),
      { type: 'commit-user-edit', markdown: '# Unsaved' },
    );
    assert.equal(changedDuringSave.userEditor.mode, 'editing');
    assert.equal(changedDuringSave.userEditor.savedMarkdown, '# Unsaved');
    assert.equal(changedDuringSave.userEditor.draftMarkdown, '# Newer unsaved edit');
    assert.equal(isWhiteboardUserEditDirty(changedDuringSave.userEditor), true);
  });

  test('keeps the inline icon pinned to the accepted path geometry', () => {
    const pathArraySource = whiteboardIconSource.match(
      /WHITEBOARD_ICON_PATHS = \[([^]*?)\] as const;/,
    )?.[1] ?? '';
    const iconPaths = Array.from(pathArraySource.matchAll(/^\s*'([^']+)',?$/gm), (match) => match[1]);
    const paths = iconPaths.join('\n');
    assert.equal(iconPaths.length, 2);
    assert.equal(
      createHash('sha256').update(paths).digest('hex'),
      '1c3c4ee30d986c22bc333d8224bb9169ba257b3c70ec26436e35b2bc5ee1a5e8',
    );
  });
});
