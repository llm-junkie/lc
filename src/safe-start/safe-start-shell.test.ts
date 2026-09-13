import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import 'fake-indexeddb/auto';
import SafeStartShell from './SafeStartShell.tsx';
import { StartupController, type StartupPersistence } from '../startup/startup-runtime.ts';
import { createSafeStartSupportReport } from './safe-start-support-report.ts';
import {
  openApplicationDataDirectory,
  resetSavedWindowGeometry,
} from '../startup/startup-platform.ts';
import { DEFAULT_PARAMS, type Message } from '../types.ts';
import { replaceMessages, saveMeta } from '../store/db.ts';
import {
  applyModelWhiteboardContent,
  beginModelWhiteboardTurn,
  initializeWhiteboard,
  listWhiteboardVersions,
  readWhiteboardStorageRowsForTests,
} from '../store/whiteboard.ts';
import { recoverInterruptedWhiteboardState } from '../store/whiteboard-conversation.ts';

class MemoryPersistence implements StartupPersistence {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

/** One new-process launch that ends before `ready`. */
function failedNormalLaunch(storage: MemoryPersistence): StartupController {
  const startup = new StartupController({
    persistence: storage,
    automaticSafeStart: true,
    newProcess: true,
  });
  assert.equal(startup.mode, 'normal');
  startup.failure('conversation-storage-unavailable');
  return startup;
}

/** Two failed launches, then the automatic recovery launch. */
function automaticEntry(storage: MemoryPersistence): StartupController {
  failedNormalLaunch(storage);
  failedNormalLaunch(storage);
  const recovery = new StartupController({
    persistence: storage,
    automaticSafeStart: true,
    newProcess: true,
  });
  assert.equal(recovery.mode, 'safe-start');
  return recovery;
}

/** One launch with `--safe-start` on a clean marker. */
function manualEntry(storage: MemoryPersistence): StartupController {
  const manual = new StartupController({
    persistence: storage,
    automaticSafeStart: true,
    newProcess: true,
    manualSafeStart: true,
  });
  assert.equal(manual.mode, 'safe-start');
  return manual;
}

/** Safe Start -> retry once -> the retry fails -> Safe Start again. */
function failedRetryEntry(storage: MemoryPersistence, fromAutomatic: boolean): StartupController {
  const first = fromAutomatic ? automaticEntry(storage) : manualEntry(storage);
  first.requestNormalRetry();
  const retry = new StartupController({
    persistence: storage,
    automaticSafeStart: true,
    newProcess: true,
  });
  assert.equal(retry.mode, 'normal');
  assert.equal(retry.retryAttempt, true);
  retry.failure('normal-app-import-failed');
  const again = new StartupController({
    persistence: storage,
    automaticSafeStart: true,
    newProcess: true,
  });
  assert.equal(again.mode, 'safe-start');
  return again;
}

function shellHtml(startup: StartupController): string {
  return renderToStaticMarkup(createElement(SafeStartShell, { startup }));
}

// Every fixture above is built by running the real state machine through
// StartupController, so the shell is always rendered against reachable
// outputs rather than hand-written snapshots.

test('Safe Start recovery shell renders from startup facts without normal stores', () => {
  const storage = new MemoryPersistence();
  const html = shellHtml(automaticEntry(storage));
  assert.match(html, /Safe Start/);
  assert.match(html, /renderer-created/);
  assert.match(html, /conversation-storage-unavailable/);
  assert.match(html, /Create support report/);
  assert.match(html, /Retry normal start once/);
  assert.match(html, /Reset saved main-window geometry/);
  assert.doesNotMatch(html, /exception text|conversation content|factory reset/i);
});

test('the headline derives from the recorded failure facts instead of assuming two launches', () => {
  // Automatic recovery after two incomplete launches claims exactly two.
  const automatic = shellHtml(automaticEntry(new MemoryPersistence()));
  assert.match(automatic, /Two consecutive desktop launches/);
  assert.match(automatic, /<dt>Incomplete starts<\/dt><dd>2<\/dd>/);

  // An explicit --safe-start on a clean marker claims no failed launch at all.
  const manual = shellHtml(manualEntry(new MemoryPersistence()));
  assert.doesNotMatch(manual, /Two consecutive desktop launches/);
  assert.match(manual, /LC paused normal startup for recovery/);
  assert.match(manual, /<dt>Incomplete starts<\/dt><dd>0<\/dd>/);

  // A failed retry from a manual --safe-start: exactly one launch ended early.
  const manualRetry = failedRetryEntry(new MemoryPersistence(), false);
  assert.equal(manualRetry.snapshot().incompleteStartCount, 1);
  const manualRetryHtml = shellHtml(manualRetry);
  assert.doesNotMatch(manualRetryHtml, /Two consecutive desktop launches/);
  assert.match(manualRetryHtml, /LC paused normal startup for recovery/);
  assert.match(manualRetryHtml, /<dt>Incomplete starts<\/dt><dd>1<\/dd>/);

  // A failed retry from an automatic Safe Start keeps the two recorded failures.
  const automaticRetry = failedRetryEntry(new MemoryPersistence(), true);
  assert.equal(automaticRetry.snapshot().incompleteStartCount, 2);
  const automaticRetryHtml = shellHtml(automaticRetry);
  assert.match(automaticRetryHtml, /Two consecutive desktop launches/);
});

test('Safe Start leaves hostile Whiteboard rows unchanged until normal lazy recovery', async () => {
  const conversationId = `safe-start-whiteboard-${crypto.randomUUID()}`;
  const baseTime = new Date(2026, 7, 30, 4, 0, 0, 0).getTime();
  const heads = await initializeWhiteboard(conversationId, { now: () => baseTime });
  const messages: Message[] = [
    {
      id: 'safe-start-user',
      role: 'user',
      content: 'Continue',
      createdAt: baseTime + 1,
      sortOrder: 1,
      user_board: heads.user.id,
    },
    {
      id: 'safe-start-assistant',
      role: 'assistant',
      content: '',
      createdAt: baseTime + 2,
      sortOrder: 2,
      whiteboard_refs: {
        user_board: heads.user.id,
        model_initial_board: heads.model.id,
        model_latest_board: heads.model.id,
      },
      tool_calls: [{
        id: 'safe-start-call',
        name: 'lc_whiteboard',
        arguments: '{"action":"replace","content":"# Hostile provisional"}',
        created_at: baseTime + 2,
      }],
    },
  ];
  await saveMeta({
    id: conversationId,
    title: 'Safe Start hostile state',
    params: { ...DEFAULT_PARAMS },
    messages,
    messageCount: messages.length,
    createdAt: baseTime,
    updatedAt: baseTime + 2,
  });
  await replaceMessages(conversationId, messages);
  await beginModelWhiteboardTurn({
    conversationId,
    generationId: 'safe-start-generation',
    assistantMessageId: 'safe-start-assistant',
    initialVersionId: heads.model.id,
  }, { now: () => baseTime + 3 });
  await applyModelWhiteboardContent({
    conversationId,
    generationId: 'safe-start-generation',
    assistantMessageId: 'safe-start-assistant',
    toolCallId: 'safe-start-call',
    content: '# Hostile provisional',
  }, { now: () => baseTime + 4 });

  const rawBytes = async () => Buffer.from(JSON.stringify(
    await readWhiteboardStorageRowsForTests(conversationId),
  ));
  const before = await rawBytes();
  assert.match(before.toString(), /safe-start-call/);

  const startup = manualEntry(new MemoryPersistence());
  await createSafeStartSupportReport(startup.snapshot());
  assert.deepEqual(await rawBytes(), before);

  startup.requestNormalRetry();
  assert.deepEqual(await rawBytes(), before);

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const invoked: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => { invoked.push(command); },
      },
    },
  });
  try {
    await openApplicationDataDirectory();
    assert.deepEqual(await rawBytes(), before);
    await resetSavedWindowGeometry();
    assert.deepEqual(await rawBytes(), before);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
  assert.deepEqual(invoked, ['open_app_data_directory', 'reset_window_state']);

  const first = await recoverInterruptedWhiteboardState(conversationId, messages);
  assert.equal(first.settled, true);
  const afterFirst = await rawBytes();
  assert.notDeepEqual(afterFirst, before);
  const versionCount = (await listWhiteboardVersions(conversationId, 'model')).length;

  const second = await recoverInterruptedWhiteboardState(conversationId, first.messages);
  assert.equal(second.settled, false);
  assert.deepEqual(await rawBytes(), afterFirst);
  assert.equal((await listWhiteboardVersions(conversationId, 'model')).length, versionCount);
});
