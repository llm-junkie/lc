/**
 * Storage diagnostics, through the real conversation database.
 *
 * These tests call the shipped `store/db.ts` functions against a real (faked)
 * IndexedDB and then read the diagnostic ring. Nothing is injected: if an
 * emitter is missing from a production path, the assertion below fails.
 *
 * They exist because the previous coverage injected events straight into the
 * report builder, which proved the schema could represent a hydrate or read
 * outcome while no shipped code path ever recorded one.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import type { Conversation, Message } from '../types.ts';
import type { ConversationDataTables } from './db';

const [dbModule, diagnosticsModule, typesModule, whiteboardModule, whiteboardFixtures] = await Promise.all([
  import('./db.ts'),
  import('../utils/diagnostic-events.ts'),
  import('../types.ts'),
  import('./whiteboard.ts'),
  import('../whiteboard/contract-fixtures.ts'),
]);

const {
  conversationCount,
  countMessages,
  deleteAllConversations,
  deleteConversation,
  deleteLastMessage,
  loadAllMeta,
  loadMessages,
  messageCount,
  openConversationStorage,
  replaceMessages,
  saveMeta,
  saveMessage,
  saveMessages,
  updateMessage,
} = dbModule;
const {
  CONVERSATION_DB_VERSION,
  runConversationDataMutation,
  runConversationDataTransaction,
} = dbModule;
const {
  addWhiteboardVersionInTransaction,
  applyModelWhiteboardContent,
  beginModelWhiteboardTurn,
  formatWhiteboardVersionId,
  getModelWhiteboardWorking,
  getPendingUserWhiteboard,
  getWhiteboardHeads,
  getWhiteboardVersion,
  initializeWhiteboard,
  listWhiteboardVersions,
  promotePendingUserWhiteboard,
  readWhiteboardStorageRowsForTests,
  replaceWhiteboardVersionsInTransaction,
  resetWhiteboardStorageForTests,
  runConversationWhiteboardMutationWithRetry,
  runModelWhiteboardSettlementMutationWithRetry,
  savePendingUserWhiteboard,
  settleModelWhiteboardTurn,
  WhiteboardGenerationClosedError,
} = whiteboardModule;
const {
  WHITEBOARD_STORAGE_FIXTURES,
  WHITEBOARD_VERSION_ID_FIXTURES,
} = whiteboardFixtures;
const { readDiagnosticEvents, resetDiagnosticEvents } = diagnosticsModule;
const { DEFAULT_PARAMS } = typesModule;

/** Codes recorded by the storage boundary, in order. */
function storageCodes(): string[] {
  return readDiagnosticEvents()
    .filter((event) => event.subsystem === 'storage')
    .map((event) => event.code ?? 'unknown');
}

function conversation(id: string): Conversation {
  return {
    id,
    title: 'storage diagnostics',
    model: 'test-model',
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    messages: [],
  };
}

function message(id: string, sortOrder: number): Message {
  return { id, role: 'user', content: 'hello', createdAt: sortOrder, sortOrder };
}

beforeEach(() => {
  resetDiagnosticEvents();
});

describe('storage diagnostics come from the real database boundary', () => {
  it('records metadata hydrate around the real loadAllMeta boundary', async () => {
    await openConversationStorage();
    resetDiagnosticEvents();

    await loadAllMeta();

    assert.deepEqual(storageCodes(), ['storage-hydrate-ok']);
  });

  it('records an indexed read around a real lazy message load', async () => {
    const id = `read-${crypto.randomUUID()}`;
    await saveMeta(conversation(id));
    await saveMessages([message(`${id}-a`, 1), message(`${id}-b`, 2)], id);
    resetDiagnosticEvents();

    const loaded = await loadMessages(id);

    assert.equal(loaded.length, 2);
    assert.deepEqual(storageCodes(), ['storage-read-ok']);
  });

  it('records exactly one durable write for every conversation mutation', async () => {
    const id = `write-${crypto.randomUUID()}`;

    const mutations: Array<[string, () => Promise<unknown>]> = [
      ['saveMeta', () => saveMeta(conversation(id))],
      ['saveMessage', () => saveMessage(message(`${id}-1`, 1), id)],
      ['saveMessages', () => saveMessages([message(`${id}-2`, 2)], id)],
      ['replaceMessages', () => replaceMessages(id, [message(`${id}-3`, 3)])],
      ['updateMessage', () => updateMessage(`${id}-3`, { content: 'edited' })],
      ['deleteLastMessage', () => deleteLastMessage(id)],
      ['deleteConversation', () => deleteConversation(id)],
      ['deleteAllConversations', () => deleteAllConversations()],
    ];

    for (const [name, run] of mutations) {
      resetDiagnosticEvents();
      await run();
      assert.deepEqual(storageCodes(), ['storage-write-ok'], `${name} must record one durable write`);
    }
  });

  it('records nothing when a mutation finds nothing to mutate', async () => {
    const id = `noop-${crypto.randomUUID()}`;
    await saveMeta(conversation(id));
    resetDiagnosticEvents();

    // Neither call changes a row, so neither may claim a durable write.
    await updateMessage(`${id}-absent`, { content: 'x' });
    await deleteLastMessage(id);
    await deleteLastMessage(id, `${id}-absent`);

    assert.deepEqual(storageCodes(), []);
  });

  it('never deletes a row the caller did not target, even with an explicit id', async () => {
    const a = `owner-a-${crypto.randomUUID()}`;
    const b = `owner-b-${crypto.randomUUID()}`;
    await saveMeta(conversation(a));
    await saveMeta(conversation(b));
    await saveMessages([message(`${b}-1`, 1)], b);
    resetDiagnosticEvents();

    // The explicit id belongs to conversation b — asking for a delete under
    // conversation a must not touch it, and must not record a write.
    await deleteLastMessage(a, `${b}-1`);

    assert.deepEqual(storageCodes(), []);
    assert.equal((await loadMessages(b)).length, 1);
    assert.equal((await loadMessages(a)).length, 0);
  });

  it('records a failure, not a success, when a durable write throws', async () => {
    resetDiagnosticEvents();

    await assert.rejects(
      // A conversation whose params cannot be serialized fails inside the
      // row mapping, on the same path a real malformed value would.
      () => saveMeta({
        ...conversation('cyclic'),
        params: (() => {
          const cyclic: Record<string, unknown> = {};
          cyclic.self = cyclic;
          return cyclic as unknown as Conversation['params'];
        })(),
      }),
    );

    assert.deepEqual(storageCodes(), ['storage-write-failed']);
  });

  it('serializes two concurrent patches to the same row without losing a field', async () => {
    const id = `race-${crypto.randomUUID()}`;
    await saveMeta(conversation(id));
    await saveMessage({ ...message(`${id}-1`, 1), content: 'base' }, id);
    resetDiagnosticEvents();

    // Both updates read the row before either writes it unless the
    // read-modify-write is one transaction — the second put then restores
    // the first patch's column to its stale base value.
    await Promise.all([
      updateMessage(`${id}-1`, { content: 'patched content' }),
      updateMessage(`${id}-1`, { reasoning: 'patched reasoning' }),
    ]);

    const [row] = await loadMessages(id);
    assert.equal(row.content, 'patched content');
    assert.equal(row.reasoning, 'patched reasoning');
    // Both writes landed; the ring retains them as one entry because
    // consecutive identical storage events coalesce by design
    // (docs/support-report.md).
    assert.deepEqual(
      storageCodes().filter((code) => code === 'storage-write-ok'),
      ['storage-write-ok'],
    );
  });

  it('records one durable-write outcome per blob mutation that changes a row', async () => {
    const { clearAttachments, deleteAttachment, deleteAttachments, putAttachment } =
      await import('../utils/idb.ts');

    // A put always changes a row.
    resetDiagnosticEvents();
    await putAttachment('blob-diag-1', new Blob(['x']), { mime: 'text/plain', name: 'x.txt', size: 1 });
    assert.deepEqual(storageCodes(), ['storage-write-ok']);

    resetDiagnosticEvents();
    await deleteAttachment('blob-diag-1');
    assert.deepEqual(storageCodes(), ['storage-write-ok']);

    resetDiagnosticEvents();
    await putAttachment('blob-diag-2', new Blob(['y']), { mime: 'text/plain', name: 'y.txt', size: 1 });
    resetDiagnosticEvents();
    await deleteAttachments(['blob-diag-2']);
    assert.deepEqual(storageCodes(), ['storage-write-ok']);

    resetDiagnosticEvents();
    await putAttachment('blob-diag-3', new Blob(['z']), { mime: 'text/plain', name: 'z.txt', size: 1 });
    resetDiagnosticEvents();
    await clearAttachments();
    assert.deepEqual(storageCodes(), ['storage-write-ok']);

    // Mutations that find nothing to change record nothing, and an empty
    // delete list performs no transaction at all.
    resetDiagnosticEvents();
    await deleteAttachment('blob-diag-absent');
    await deleteAttachments(['blob-diag-absent-1', 'blob-diag-absent-2']);
    await clearAttachments();
    await deleteAttachments([]);
    assert.deepEqual(storageCodes(), []);
  });

  it('records localStorage success and quota failure through the shared boundary', async () => {
    const { runLocalStorageMutation } = await import('./local-storage.ts');
    const values = new Map<string, string>();

    resetDiagnosticEvents();
    assert.equal(runLocalStorageMutation(() => values.set('setting', 'saved')), true);
    assert.equal(values.get('setting'), 'saved');
    assert.deepEqual(storageCodes(), ['storage-write-ok']);

    resetDiagnosticEvents();
    assert.equal(runLocalStorageMutation(() => {
      throw new DOMException('Storage quota exceeded.', 'QuotaExceededError');
    }), false);
    assert.deepEqual(storageCodes(), ['storage-write-failed']);
  });

  it('records the durable startup marker through the shared boundary', async () => {
    const { StartupController } = await import('../startup/startup-runtime.ts');
    const values = new Map<string, string>();

    resetDiagnosticEvents();
    new StartupController({
      persistence: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
      },
      automaticSafeStart: true,
      newProcess: true,
    });

    assert.equal(values.size, 1);
    assert.deepEqual(storageCodes(), ['storage-write-ok']);
  });

  it('keeps report-collection count queries free of storage events', async () => {
    const id = `count-${crypto.randomUUID()}`;
    await saveMeta(conversation(id));
    await saveMessages([message(`${id}-1`, 1)], id);
    resetDiagnosticEvents();

    // These three are the only database entry points the support-report
    // collector touches. Collecting a report must not manufacture activity.
    await conversationCount();
    await messageCount();
    await countMessages(id);

    assert.deepEqual(storageCodes(), []);
  });

  it('records only closed codes, never content or identifiers', async () => {
    const id = `privacy-${crypto.randomUUID()}`;
    resetDiagnosticEvents();
    await saveMeta({ ...conversation(id), title: 'SEEDED-SECRET-TITLE' });
    await saveMessage({ ...message(`${id}-1`, 1), content: 'SEEDED-SECRET-BODY' }, id);
    await loadMessages(id);

    const serialized = JSON.stringify(readDiagnosticEvents());
    assert.ok(!serialized.includes('SEEDED-SECRET'), 'no content may reach the ring');
    assert.ok(!serialized.includes(id), 'no conversation identifier may reach the ring');
    for (const event of readDiagnosticEvents()) {
      assert.equal(event.subsystem, 'storage');
      assert.ok(['open', 'hydrate', 'indexed-read', 'durable-write'].includes(event.operation));
    }
  });
});

describe('whiteboard retained and working storage', () => {
  beforeEach(async () => {
    await resetWhiteboardStorageForTests();
    resetDiagnosticEvents();
  });

  it('uses schema v3 and creates the two frozen baselines once', async () => {
    // v2 added the generation journal additively and v3 makes the pre-release
    // v2 compatibility repair explicit. The Whiteboard stores and their frozen
    // baselines are unchanged by either bump.
    assert.equal(CONVERSATION_DB_VERSION, 3);
    assert.equal(
      formatWhiteboardVersionId('user', WHITEBOARD_VERSION_ID_FIXTURES.controlledNow),
      WHITEBOARD_VERSION_ID_FIXTURES.user,
    );
    assert.equal(
      formatWhiteboardVersionId('model', WHITEBOARD_VERSION_ID_FIXTURES.controlledNow),
      WHITEBOARD_VERSION_ID_FIXTURES.model,
    );

    const initialized = await initializeWhiteboard('conv-whiteboard', {
      now: () => WHITEBOARD_VERSION_ID_FIXTURES.controlledNow,
    });
    assert.deepEqual(initialized.user, WHITEBOARD_STORAGE_FIXTURES.initialUser);
    assert.deepEqual(initialized.model, WHITEBOARD_STORAGE_FIXTURES.initialModel);

    const repeated = await initializeWhiteboard('conv-whiteboard', {
      now: () => WHITEBOARD_VERSION_ID_FIXTURES.controlledNow,
    });
    assert.deepEqual(repeated, initialized);
    assert.deepEqual(await listWhiteboardVersions('conv-whiteboard'), [
      WHITEBOARD_STORAGE_FIXTURES.initialUser,
      WHITEBOARD_STORAGE_FIXTURES.initialModel,
    ]);
    assert.deepEqual(await getWhiteboardHeads('conv-whiteboard'), initialized);

    const concurrentId = `concurrent-init-${crypto.randomUUID()}`;
    const [left, right] = await Promise.all([
      initializeWhiteboard(concurrentId, {
        now: () => WHITEBOARD_VERSION_ID_FIXTURES.controlledNow,
      }),
      initializeWhiteboard(concurrentId, {
        now: () => WHITEBOARD_VERSION_ID_FIXTURES.controlledNow,
      }),
    ]);
    assert.deepEqual(left, right);
    assert.equal((await listWhiteboardVersions(concurrentId)).length, 2);
  });

  it('raises the frozen ConstraintError, retries the complete transaction, and never overwrites', async () => {
    const conversationId = `collision-${crypto.randomUUID()}`;
    const existing = {
      conversationId,
      id: WHITEBOARD_VERSION_ID_FIXTURES.collision.existingId,
      owner: 'model' as const,
      content: WHITEBOARD_VERSION_ID_FIXTURES.collision.existingContent,
      createdAt: WHITEBOARD_VERSION_ID_FIXTURES.controlledNow,
      sequence: 1,
      sourceMessageId: null,
      sourceToolCallId: null,
    };
    await runConversationDataTransaction('rw', async (tables) => {
      await addWhiteboardVersionInTransaction(tables, existing);
    });

    await assert.rejects(
      () => runConversationDataTransaction('rw', async (tables) => {
        await addWhiteboardVersionInTransaction(tables, {
          ...existing,
          content: '# Must not replace the existing row',
          sequence: 2,
        });
      }),
      (error: unknown) => (
        error instanceof Error
        && error.name === WHITEBOARD_VERSION_ID_FIXTURES.collision.errorName
      ),
    );

    const retained = await runConversationWhiteboardMutationWithRetry(
      async ({ tables, candidateCreatedAt }) => {
        const version = {
          ...existing,
          id: formatWhiteboardVersionId('model', candidateCreatedAt),
          content: '# Retried content',
          createdAt: candidateCreatedAt,
          sequence: 2,
        };
        await addWhiteboardVersionInTransaction(tables, version);
        return { value: version, wrote: true };
      },
      { now: () => WHITEBOARD_VERSION_ID_FIXTURES.controlledNow },
    );

    assert.equal(retained.id, WHITEBOARD_VERSION_ID_FIXTURES.collision.retryId);
    assert.equal(
      (await getWhiteboardVersion(conversationId, existing.id))?.content,
      WHITEBOARD_VERSION_ID_FIXTURES.collision.expectedExistingContent,
    );
    assert.deepEqual(
      (await listWhiteboardVersions(conversationId)).map((version) => version.sequence),
      [1, 2],
    );
  });

  it('rejects malformed and owner-mismatched retained IDs before storage', async () => {
    const base = {
      conversationId: `invalid-id-${crypto.randomUUID()}`,
      owner: 'user' as const,
      content: '',
      createdAt: WHITEBOARD_VERSION_ID_FIXTURES.controlledNow,
      sequence: 1,
      sourceMessageId: null,
      sourceToolCallId: null,
    };
    for (const id of ['u_bad', 'u_082214295001', 'm_0822142950012']) {
      await assert.rejects(
        () => runConversationDataTransaction('rw', async (tables) => {
          await addWhiteboardVersionInTransaction(tables, { ...base, id });
        }),
        /malformed|owner/i,
      );
    }
    assert.equal((await listWhiteboardVersions(base.conversationId)).length, 0);
  });

  it('keeps local-calendar IDs independent from epoch timestamps across time zones', async () => {
    const conversationId = `cross-time-zone-${crypto.randomUUID()}`;
    const sourceLocalId = WHITEBOARD_VERSION_ID_FIXTURES.user;
    const sourceEpoch = WHITEBOARD_VERSION_ID_FIXTURES.controlledNow + 60_000;
    assert.notEqual(formatWhiteboardVersionId('user', sourceEpoch), sourceLocalId);
    await runConversationDataTransaction('rw', async (tables) => {
      await addWhiteboardVersionInTransaction(tables, {
        conversationId,
        id: sourceLocalId,
        owner: 'user',
        content: '# Created in another local time zone',
        createdAt: sourceEpoch,
        sequence: 1,
        sourceMessageId: null,
        sourceToolCallId: null,
      });
    });
    assert.deepEqual(await getWhiteboardVersion(conversationId, sourceLocalId), {
      conversationId,
      id: sourceLocalId,
      owner: 'user',
      content: '# Created in another local time zone',
      createdAt: sourceEpoch,
      sequence: 1,
      sourceMessageId: null,
      sourceToolCallId: null,
    });
  });

  it('replaces one pending copy, promotes it once, and reuses unchanged content', async () => {
    await initializeWhiteboard('conv-whiteboard', {
      now: () => WHITEBOARD_VERSION_ID_FIXTURES.controlledNow,
    });
    await savePendingUserWhiteboard('conv-whiteboard', '# Replaced pending copy', {
      now: () => WHITEBOARD_VERSION_ID_FIXTURES.controlledNow + 1,
    });
    await savePendingUserWhiteboard(
      'conv-whiteboard',
      WHITEBOARD_STORAGE_FIXTURES.pendingUser.content,
      { now: () => WHITEBOARD_VERSION_ID_FIXTURES.controlledNow + 2 },
    );
    assert.equal(
      (await getPendingUserWhiteboard('conv-whiteboard'))?.content,
      WHITEBOARD_STORAGE_FIXTURES.pendingUser.content,
    );
    await savePendingUserWhiteboard(
      'conv-whiteboard',
      WHITEBOARD_STORAGE_FIXTURES.retainedUser.content,
      { now: () => WHITEBOARD_VERSION_ID_FIXTURES.controlledNow + 3 },
    );

    const promoted = await promotePendingUserWhiteboard('conv-whiteboard', 'user-1', {
      now: () => WHITEBOARD_STORAGE_FIXTURES.retainedUser.createdAt,
    });
    assert.equal(promoted.changed, true);
    assert.equal(promoted.hadPendingCopy, true);
    assert.deepEqual(promoted.version, WHITEBOARD_STORAGE_FIXTURES.retainedUser);
    assert.equal(await getPendingUserWhiteboard('conv-whiteboard'), null);

    await savePendingUserWhiteboard(
      'conv-whiteboard',
      WHITEBOARD_STORAGE_FIXTURES.retainedUser.content,
    );
    const reused = await promotePendingUserWhiteboard('conv-whiteboard', 'user-2', {
      now: () => WHITEBOARD_STORAGE_FIXTURES.retainedUser.createdAt,
    });
    assert.equal(reused.changed, false);
    assert.equal(reused.version.id, WHITEBOARD_STORAGE_FIXTURES.retainedUser.id);
    assert.equal((await listWhiteboardVersions('conv-whiteboard', 'user')).length, 2);

    const withoutPending = await promotePendingUserWhiteboard('conv-whiteboard', 'user-3');
    assert.equal(withoutPending.hadPendingCopy, false);
    assert.equal(withoutPending.version.id, WHITEBOARD_STORAGE_FIXTURES.retainedUser.id);
  });

  it('orders same-millisecond and rolled-back IDs only by conversation sequence', async () => {
    const conversationId = `order-${crypto.randomUUID()}`;
    const base = WHITEBOARD_VERSION_ID_FIXTURES.controlledNow;
    await initializeWhiteboard(conversationId, { now: () => base - 100_000 });

    await savePendingUserWhiteboard(conversationId, 'A');
    const first = await promotePendingUserWhiteboard(conversationId, 'user-a', {
      now: () => base,
    });
    await savePendingUserWhiteboard(conversationId, 'B');
    const second = await promotePendingUserWhiteboard(conversationId, 'user-b', {
      now: () => base,
    });
    await savePendingUserWhiteboard(conversationId, 'C');
    const rollback = await promotePendingUserWhiteboard(conversationId, 'user-c', {
      now: () => base - 1_000,
    });

    assert.equal(first.version.id, WHITEBOARD_VERSION_ID_FIXTURES.rollbackCandidates[0]);
    assert.equal(second.version.id, WHITEBOARD_VERSION_ID_FIXTURES.rollbackCandidates[1]);
    assert.ok(rollback.version.id.localeCompare(second.version.id) < 0);
    const history = await listWhiteboardVersions(conversationId, 'user');
    assert.deepEqual(history.map((version) => version.sequence), [1, 3, 4, 5]);
    assert.deepEqual(history.map((version) => version.content), ['', 'A', 'B', 'C']);

    const otherConversationId = `${conversationId}-other`;
    const other = await initializeWhiteboard(otherConversationId, { now: () => base });
    assert.equal(other.user.id, first.version.id, 'IDs are scoped to one conversation');
  });

  it('keeps one generation-owned provisional row and retains its final receipt once', async () => {
    await initializeWhiteboard('conv-whiteboard', {
      now: () => WHITEBOARD_VERSION_ID_FIXTURES.controlledNow,
    });
    await savePendingUserWhiteboard(
      'conv-whiteboard',
      WHITEBOARD_STORAGE_FIXTURES.retainedUser.content,
    );
    await promotePendingUserWhiteboard('conv-whiteboard', 'user-1', {
      now: () => WHITEBOARD_STORAGE_FIXTURES.retainedUser.createdAt,
    });
    const initial = await beginModelWhiteboardTurn({
      conversationId: 'conv-whiteboard',
      generationId: 'generation-1',
      assistantMessageId: 'assistant-1',
      initialVersionId: WHITEBOARD_STORAGE_FIXTURES.initialModel.id,
    });
    assert.equal(initial.id, null);

    const noOp = await applyModelWhiteboardContent({
      conversationId: 'conv-whiteboard',
      generationId: 'generation-1',
      assistantMessageId: 'assistant-1',
      toolCallId: 'whiteboard-call-noop',
      content: '',
    }, { now: () => WHITEBOARD_STORAGE_FIXTURES.retainedModel.createdAt });
    assert.equal(noOp.changed, false);
    assert.equal(noOp.working.id, null);

    const first = await applyModelWhiteboardContent({
      conversationId: 'conv-whiteboard',
      generationId: 'generation-1',
      assistantMessageId: 'assistant-1',
      toolCallId: 'whiteboard-call-1',
      content: '# Intermediate model copy',
    }, { now: () => WHITEBOARD_STORAGE_FIXTURES.retainedModel.createdAt });
    const latest = await applyModelWhiteboardContent({
      conversationId: 'conv-whiteboard',
      generationId: 'generation-1',
      assistantMessageId: 'assistant-1',
      toolCallId: WHITEBOARD_STORAGE_FIXTURES.provisionalModel.latestToolCallId,
      content: WHITEBOARD_STORAGE_FIXTURES.retainedModel.content,
    }, { now: () => WHITEBOARD_STORAGE_FIXTURES.retainedModel.createdAt + 100 });
    assert.equal(first.working.id, WHITEBOARD_STORAGE_FIXTURES.provisionalModel.id);
    assert.equal(latest.working.id, first.working.id, 'later changes overwrite one provisional ID');
    assert.equal(latest.working.latestToolCallId, 'whiteboard-call-2');
    assert.equal((await listWhiteboardVersions('conv-whiteboard', 'model')).length, 1);

    const settled = await settleModelWhiteboardTurn({
      conversationId: 'conv-whiteboard',
      generationId: 'generation-1',
      assistantMessageId: 'assistant-1',
    });
    assert.equal(settled.settledNow, true);
    assert.deepEqual(settled.retained, WHITEBOARD_STORAGE_FIXTURES.retainedModel);
    assert.equal(await getModelWhiteboardWorking('conv-whiteboard'), null);

    const repeated = await settleModelWhiteboardTurn({
      conversationId: 'conv-whiteboard',
      generationId: 'generation-1',
      assistantMessageId: 'assistant-1',
    });
    assert.equal(repeated.settledNow, false);
    assert.deepEqual(repeated.retained, WHITEBOARD_STORAGE_FIXTURES.retainedModel);
    await assert.rejects(
      () => applyModelWhiteboardContent({
        conversationId: 'conv-whiteboard',
        generationId: 'generation-1',
        assistantMessageId: 'assistant-1',
        toolCallId: 'late-call',
        content: '# Too late',
      }),
      WhiteboardGenerationClosedError,
    );

    const heads = await getWhiteboardHeads('conv-whiteboard');
    assert.deepEqual({
      user_board: heads.user?.id,
      model_initial_board: WHITEBOARD_STORAGE_FIXTURES.initialModel.id,
      model_latest_board: heads.model?.id,
    }, {
      user_board: WHITEBOARD_STORAGE_FIXTURES.retainedUser.id,
      model_initial_board: WHITEBOARD_STORAGE_FIXTURES.initialModel.id,
      model_latest_board: WHITEBOARD_STORAGE_FIXTURES.retainedModel.id,
    });
  });

  it('closes no-mutation turns without retaining a model version or deleting a newer owner', async () => {
    const conversationId = `generation-${crypto.randomUUID()}`;
    const heads = await initializeWhiteboard(conversationId);
    await beginModelWhiteboardTurn({
      conversationId,
      generationId: 'generation-a',
      assistantMessageId: 'assistant-a',
      initialVersionId: heads.model.id,
    });
    const noMutation = await settleModelWhiteboardTurn({
      conversationId,
      generationId: 'generation-a',
      assistantMessageId: 'assistant-a',
    });
    assert.deepEqual(noMutation, {
      retained: null,
      latestToolCallId: null,
      settledNow: true,
    });
    assert.equal((await listWhiteboardVersions(conversationId, 'model')).length, 1);

    await beginModelWhiteboardTurn({
      conversationId,
      generationId: 'generation-b',
      assistantMessageId: 'assistant-b',
    });
    const stale = await settleModelWhiteboardTurn({
      conversationId,
      generationId: 'generation-a',
      assistantMessageId: 'assistant-a',
    });
    assert.equal(stale.settledNow, false);
    assert.equal((await getModelWhiteboardWorking(conversationId))?.generationId, 'generation-b');
  });

  it('keeps one provisional identity when the final model content reverts to its initial value', async () => {
    const conversationId = `reversion-${crypto.randomUUID()}`;
    const heads = await initializeWhiteboard(conversationId);
    await beginModelWhiteboardTurn({
      conversationId,
      generationId: 'generation-reversion',
      assistantMessageId: 'assistant-reversion',
      initialVersionId: heads.model.id,
    });
    const changed = await applyModelWhiteboardContent({
      conversationId,
      generationId: 'generation-reversion',
      assistantMessageId: 'assistant-reversion',
      toolCallId: 'reversion-call-1',
      content: '# Temporary content',
    });
    const reverted = await applyModelWhiteboardContent({
      conversationId,
      generationId: 'generation-reversion',
      assistantMessageId: 'assistant-reversion',
      toolCallId: 'reversion-call-2',
      content: '',
    });
    assert.equal(reverted.working.id, changed.working.id);

    const settled = await settleModelWhiteboardTurn({
      conversationId,
      generationId: 'generation-reversion',
      assistantMessageId: 'assistant-reversion',
    });
    assert.equal(settled.retained?.content, '');
    assert.notEqual(settled.retained?.id, heads.model.id);
    assert.equal((await listWhiteboardVersions(conversationId, 'model')).length, 2);
  });

  it('retries settlement collisions and atomically re-pins the assistant latest ID', async () => {
    const conversationId = `settlement-collision-${crypto.randomUUID()}`;
    const assistantMessageId = `${conversationId}-assistant`;
    const base = WHITEBOARD_VERSION_ID_FIXTURES.controlledNow;
    const heads = await initializeWhiteboard(conversationId, { now: () => base - 10_000 });
    await beginModelWhiteboardTurn({
      conversationId,
      generationId: 'generation-collision',
      assistantMessageId,
      initialVersionId: heads.model.id,
    });
    const provisional = await applyModelWhiteboardContent({
      conversationId,
      generationId: 'generation-collision',
      assistantMessageId,
      toolCallId: 'settlement-call',
      content: '# Final provisional content',
    }, { now: () => base });
    assert.equal(provisional.working.id, WHITEBOARD_VERSION_ID_FIXTURES.collision.existingId);

    await saveMessage({
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      createdAt: base,
      whiteboard_refs: {
        user_board: heads.user.id,
        model_initial_board: heads.model.id,
        model_latest_board: provisional.working.id ?? heads.model.id,
      },
    }, conversationId);
    const collision = {
      conversationId,
      id: provisional.working.id ?? assert.fail('provisional ID is required'),
      owner: 'model' as const,
      content: WHITEBOARD_VERSION_ID_FIXTURES.collision.existingContent,
      createdAt: base,
      sequence: 3,
      sourceMessageId: null,
      sourceToolCallId: null,
    };
    await runConversationDataTransaction('rw', async (tables) => {
      await addWhiteboardVersionInTransaction(tables, collision);
    });

    const settlement = await runModelWhiteboardSettlementMutationWithRetry(
      {
        conversationId,
        generationId: 'generation-collision',
        assistantMessageId,
      },
      async ({ tables, settlement: result }) => {
        const assistant = await tables.messages.get(assistantMessageId);
        assert.ok(assistant);
        const refs = JSON.parse(assistant.whiteboardRefsJson ?? '{}') as {
          user_board: string;
          model_initial_board: string;
          model_latest_board: string;
        };
        if (result.retained) refs.model_latest_board = result.retained.id;
        assistant.whiteboardRefsJson = JSON.stringify(refs);
        await tables.messages.put(assistant);
        return { value: result, wrote: true };
      },
    );

    assert.equal(settlement.retained?.id, WHITEBOARD_VERSION_ID_FIXTURES.collision.retryId);
    assert.equal(settlement.retained?.content, '# Final provisional content');
    assert.equal(
      (await getWhiteboardVersion(conversationId, collision.id))?.content,
      WHITEBOARD_VERSION_ID_FIXTURES.collision.expectedExistingContent,
    );
    assert.equal(
      (await loadMessages(conversationId))[0]?.whiteboard_refs?.model_latest_board,
      WHITEBOARD_VERSION_ID_FIXTURES.collision.retryId,
    );
    assert.equal(await getModelWhiteboardWorking(conversationId), null);
  });

  it('compresses retained and working Markdown while returning exact content', async () => {
    const conversationId = `compression-${crypto.randomUUID()}`;
    const longContent = '# Repeated\n' + 'compressible whiteboard content\n'.repeat(1_000);
    const heads = await initializeWhiteboard(conversationId);
    await savePendingUserWhiteboard(conversationId, longContent);
    const pendingRaw = await readWhiteboardStorageRowsForTests(conversationId);
    assert.ok(pendingRaw.working.find((row) => row.owner === 'user')?.content.startsWith('Z:'));

    const promoted = await promotePendingUserWhiteboard(conversationId, 'user-compressed');
    assert.equal(promoted.version.content, longContent);
    const retainedRaw = await readWhiteboardStorageRowsForTests(conversationId);
    assert.ok(retainedRaw.versions.find((row) => row.id === promoted.version.id)?.content.startsWith('Z:'));

    await beginModelWhiteboardTurn({
      conversationId,
      generationId: 'generation-compressed',
      assistantMessageId: 'assistant-compressed',
      initialVersionId: heads.model.id,
    });
    await applyModelWhiteboardContent({
      conversationId,
      generationId: 'generation-compressed',
      assistantMessageId: 'assistant-compressed',
      toolCallId: 'call-compressed',
      content: longContent,
    });
    const provisionalRaw = await readWhiteboardStorageRowsForTests(conversationId);
    assert.ok(provisionalRaw.working.find((row) => row.owner === 'model')?.content.startsWith('Z:'));
    assert.equal((await getModelWhiteboardWorking(conversationId))?.content, longContent);
  });

  it('round-trips message references and deletes every board row with its conversation', async () => {
    const conversationId = `refs-${crypto.randomUUID()}`;
    const otherConversationId = `${conversationId}-other`;
    const heads = await initializeWhiteboard(conversationId);
    await initializeWhiteboard(otherConversationId);
    await savePendingUserWhiteboard(conversationId, '# Pending');
    await beginModelWhiteboardTurn({
      conversationId,
      generationId: 'generation-refs',
      assistantMessageId: 'assistant-refs',
      initialVersionId: heads.model.id,
    });
    await saveMessages([
      {
        id: `${conversationId}-user`,
        role: 'user',
        content: 'hello',
        createdAt: 1,
        sortOrder: 1,
        user_board: heads.user.id,
      },
      {
        id: `${conversationId}-assistant`,
        role: 'assistant',
        content: 'reply',
        createdAt: 2,
        sortOrder: 2,
        whiteboard_refs: {
          user_board: heads.user.id,
          model_initial_board: heads.model.id,
          model_latest_board: heads.model.id,
        },
      },
    ], conversationId);

    const messages = await loadMessages(conversationId);
    assert.equal(messages[0]?.user_board, heads.user.id);
    assert.deepEqual(messages[1]?.whiteboard_refs, {
      user_board: heads.user.id,
      model_initial_board: heads.model.id,
      model_latest_board: heads.model.id,
    });

    await deleteConversation(conversationId);
    assert.deepEqual(await readWhiteboardStorageRowsForTests(conversationId), {
      versions: [],
      working: [],
    });
    assert.equal((await readWhiteboardStorageRowsForTests(otherConversationId)).versions.length, 2);
  });

  it('keeps retained replacement, working-row clearing, and transcript writes atomic', async () => {
    const conversationId = `atomic-replace-${crypto.randomUUID()}`;
    const messageId = `${conversationId}-message`;
    const heads = await initializeWhiteboard(conversationId);
    await savePendingUserWhiteboard(conversationId, '# Pending must survive rollback');
    const replacement = [
      { ...heads.user, content: '# Imported user content' },
      { ...heads.model, content: '# Imported model content' },
    ];
    const putMessage = async (tables: ConversationDataTables) => {
      await tables.messages.add({
        id: messageId,
        conversationId,
        role: 'user',
        content: 'atomic transcript row',
        createdAt: 1,
        tool_is_error: 0,
        sortOrder: 1,
      });
    };

    await assert.rejects(
      runConversationDataMutation(async (tables) => {
        await replaceWhiteboardVersionsInTransaction(tables, conversationId, replacement);
        await putMessage(tables);
        throw new Error('forced atomic replacement rollback');
      }),
      /forced atomic replacement rollback/,
    );
    assert.equal((await getWhiteboardHeads(conversationId)).user?.content, '');
    assert.equal(
      (await getPendingUserWhiteboard(conversationId))?.content,
      '# Pending must survive rollback',
    );
    assert.deepEqual(await loadMessages(conversationId), []);

    await runConversationDataMutation(async (tables) => {
      await replaceWhiteboardVersionsInTransaction(tables, conversationId, replacement);
      await putMessage(tables);
    });
    assert.deepEqual(
      (await getWhiteboardHeads(conversationId)),
      { user: replacement[0], model: replacement[1] },
    );
    assert.equal(await getPendingUserWhiteboard(conversationId), null);
    assert.deepEqual((await loadMessages(conversationId)).map((message) => message.id), [messageId]);
  });
});
