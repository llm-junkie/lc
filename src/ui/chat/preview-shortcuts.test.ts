import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  previewNavigationIndex,
  previewSelectionForTabClick,
  previewShortcutTab,
  previewTabForPhase,
  previewTodoSnapshotsAtMessage,
  type PreviewShortcutEvent,
} from './preview-shortcuts.ts';
import type { TodoSnapshot, TodoSnapshotIndex } from '../../modules/tool-engine';

const keyboardShortcutsSource = readFileSync(
  new URL('../shared/KeyboardShortcutsModal.tsx', import.meta.url),
  'utf8',
);

function key(input: Partial<PreviewShortcutEvent>): PreviewShortcutEvent {
  return {
    altKey: false,
    code: 'KeyP',
    ctrlKey: false,
    isComposing: false,
    key: 'p',
    metaKey: false,
    shiftKey: false,
    ...input,
  };
}

describe('preview shortcuts', () => {
  it('keeps the existing reasoning and tool shortcuts', () => {
    assert.equal(previewShortcutTab(key({ ctrlKey: true }), false), 'reasoning');
    assert.equal(previewShortcutTab(key({ ctrlKey: true, shiftKey: true, key: 'P' }), false), 'tools');
    assert.equal(previewShortcutTab(key({ metaKey: true }), true), 'reasoning');
  });

  it('accepts physical KeyP for supported Windows-style layouts', () => {
    for (const semanticKey of ['p', 'P']) {
      assert.equal(previewShortcutTab(key({ ctrlKey: true, altKey: true, key: semanticKey }), false), 'todo');
    }
  });

  it('accepts the macOS Option-produced semantic key', () => {
    assert.equal(previewShortcutTab(key({ metaKey: true, altKey: true, key: 'π' }), true), 'todo');
  });

  it('rejects AltGraph, composition, wrong physical keys, and non-Mac semantic changes', () => {
    assert.equal(previewShortcutTab(key({
      ctrlKey: true,
      altKey: true,
      getModifierState: (name) => name === 'AltGraph',
    }), false), undefined);
    assert.equal(previewShortcutTab(key({ ctrlKey: true, altKey: true, isComposing: true }), false), undefined);
    assert.equal(previewShortcutTab(key({ ctrlKey: true, altKey: true, code: 'KeyO' }), false), undefined);
    assert.equal(previewShortcutTab(key({ ctrlKey: true, altKey: true, key: 'π' }), false), undefined);
  });
});

describe('preview phase selection', () => {
  it('keeps a manually selected todo tab through idle and new tool phases', () => {
    assert.equal(previewTabForPhase('todo', true, false, false), 'todo');
    assert.equal(previewTabForPhase('todo', true, true, false), 'todo');
  });

  it('selects tools automatically only without a manual override', () => {
    assert.equal(previewTabForPhase('reasoning', false, true, false), 'tools');
  });
});

describe('preview bubble navigation', () => {
  it('enters a sole matching todo bubble from an inherited snapshot anchor', () => {
    assert.equal(previewNavigationIndex(1, -1, 'previous'), 0);
    assert.equal(previewNavigationIndex(1, -1, 'next'), 0);
  });

  it('does not pretend to move when the sole match is already selected', () => {
    assert.equal(previewNavigationIndex(1, 0, 'previous'), undefined);
    assert.equal(previewNavigationIndex(1, 0, 'next'), undefined);
  });

  it('wraps within multiple matching bubbles and enters at the nearest edge', () => {
    assert.equal(previewNavigationIndex(3, 0, 'previous'), 2);
    assert.equal(previewNavigationIndex(3, 2, 'next'), 0);
    assert.equal(previewNavigationIndex(3, -1, 'previous'), 2);
    assert.equal(previewNavigationIndex(3, -1, 'next'), 0);
  });
});

describe('preview tab message ownership', () => {
  it('keeps a tab click anchored to the currently previewed assistant bubble', () => {
    assert.deepEqual(previewSelectionForTabClick('todo', 'assistant-latest'), {
      activeTab: 'todo',
      openMessageId: 'assistant-latest',
      tabOverridden: true,
    });
  });

  it('does not render a previous-turn effective todo on a bubble with no list', () => {
    const prior: TodoSnapshot = {
      sourceAssistantId: 'assistant-prior',
      sourceMessageIndex: 1,
      toolCallId: 'todo-prior',
      callIndex: 0,
      completed: 0,
      blocked: 0,
      total: 1,
      todos: [{ id: 1, title: 'Prior turn task', status: 'in-progress' }],
    };
    const index: TodoSnapshotIndex = {
      latest: prior,
      ownedByAssistantId: new Map([['assistant-prior', prior]]),
      effectiveByAssistantId: new Map([
        ['assistant-prior', prior],
        ['assistant-latest', prior],
      ]),
      turnSnapshotsByAssistantId: new Map([['assistant-prior', [prior]]]),
    };

    assert.deepEqual(previewTodoSnapshotsAtMessage(index, 'assistant-prior'), [prior]);
    assert.equal(previewTodoSnapshotsAtMessage(index, 'assistant-latest'), undefined);
  });

  it('can limit a selected turn to its newest to-do list snapshot', () => {
    const first: TodoSnapshot = {
      sourceAssistantId: 'assistant-first',
      sourceMessageIndex: 1,
      toolCallId: 'todo-first',
      callIndex: 0,
      completed: 0,
      blocked: 0,
      total: 1,
      todos: [{ id: 1, title: 'First update', status: 'in-progress' }],
    };
    const latest: TodoSnapshot = {
      ...first,
      sourceAssistantId: 'assistant-latest',
      sourceMessageIndex: 3,
      toolCallId: 'todo-latest',
      callIndex: 1,
      completed: 1,
      todos: [{ id: 1, title: 'Latest update', status: 'completed' }],
    };
    const index: TodoSnapshotIndex = {
      latest,
      ownedByAssistantId: new Map([['assistant-latest', latest]]),
      effectiveByAssistantId: new Map([['assistant-latest', latest]]),
      turnSnapshotsByAssistantId: new Map([['assistant-latest', [first, latest]]]),
    };

    assert.deepEqual(previewTodoSnapshotsAtMessage(index, 'assistant-latest'), [first, latest]);
    assert.deepEqual(previewTodoSnapshotsAtMessage(index, 'assistant-latest', true), [latest]);
  });
});

describe('keyboard shortcut labels', () => {
  it('uses the platform-aware primary modifier for every primary shortcut', () => {
    assert.doesNotMatch(keyboardShortcutsSource, /\{ keys: 'Ctrl /);
    for (const key of ['N', ',', '/', 'Shift /', 'K', 'B', 'M', 'P', 'Shift P']) {
      assert.ok(
        keyboardShortcutsSource.includes(`keys: \`\${PRIMARY_KEY} ${key}\``),
        `${key} should use PRIMARY_KEY`,
      );
    }
    assert.ok(keyboardShortcutsSource.includes('const TODO_KEYS = `${PRIMARY_KEY} ${ALT_KEY} P`;'));
  });
});
