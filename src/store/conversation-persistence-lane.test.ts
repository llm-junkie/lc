/**
 * Phase 1 — the persistence lane, exercised through the real store.
 *
 * `conversation-persistence-coordinator.test.ts` covers the queue in
 * isolation. These tests prove the store is actually wired to it: that a
 * finalize really is enqueued as a terminal write, that a checkpoint really
 * carries its generation, and that deleting a conversation really closes its
 * lane.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { compressSync, strFromU8, strToU8 } from 'fflate';
import type { Message } from '../types';

const [dbModule, conversationModule, fixtureModule, whiteboardModule, whiteboardRuntimeModule, idbModule] = await Promise.all([
  import('./db.ts'),
  import('./conversations.ts'),
  import('./multi-conversation-fixture.ts'),
  import('./whiteboard.ts'),
  import('../modules/chat-pipeline/whiteboard-turn-runtime.ts'),
  import('../utils/idb.ts'),
]);

const { loadMessages } = dbModule;
const {
  canEnqueueConversationCheckpoint,
  drainConversationPersistence,
  enqueueConversationWrite,
  finalizeStreamingOwner,
  markStreaming,
  registerGenerationTerminalPrerequisite,
  releaseStreamingOwnerWhenDurable,
  runConversationRestoreWrite,
  unmarkStreaming,
  useConversations,
} = conversationModule;
const { seedConversation, seedConversations, releaseSeededConversations } = fixtureModule;
const { getModelWhiteboardWorking } = whiteboardModule;
const { admitWhiteboardGeneration } = whiteboardRuntimeModule;
const { deleteAttachments, loadAttachment, putAttachment } = idbModule;

await useConversations.getState().hydrate();

function turn(conversationId: string, partial: string): Message[] {
  return [
    { id: `${conversationId}-user`, role: 'user', content: 'ask', createdAt: 1, sortOrder: 1 },
    {
      id: `${conversationId}-assistant`,
      role: 'assistant',
      content: partial,
      createdAt: 2,
      sortOrder: 2,
    },
  ];
}

function compressionMarkerCollision(): string {
  return `Z:${strFromU8(compressSync(strToU8('different text')), true)}`;
}

async function loadRawMessageRow(
  messageId: string,
): Promise<{ content?: string; reasoning?: string } | undefined> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('lc:conversations');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<{ content?: string; reasoning?: string } | undefined>((resolve, reject) => {
      const request = database.transaction('messages').objectStore('messages').get(messageId);
      request.onsuccess = () => resolve(
        request.result as { content?: string; reasoning?: string } | undefined,
      );
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function loadStoredAttachmentIds(): Promise<string[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('lc');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const request = database.transaction('attachments').objectStore('attachments').getAllKeys();
      request.onsuccess = () => resolve((request.result as string[]).sort());
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function corruptAttachmentMetadata(messageId: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('lc:conversations');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('messages', 'readwrite');
      const store = transaction.objectStore('messages');
      const read = store.get(messageId);
      read.onsuccess = () => store.put({ ...read.result, attachmentsJson: '{' });
      read.onerror = () => reject(read.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

test('a checkpoint cannot overwrite the terminal row of its own generation', async () => {
  // The Phase 0 hazard, now closed. A checkpoint holds a snapshot of partial
  // output; once its generation has finalized, writing that snapshot would
  // truncate the finished answer back to whatever had streamed so far.
  const seeded = await seedConversation({
    label: 'terminal-barrier',
    messages: turn('terminal-barrier-fixed', 'partial'),
  });
  const assistantId = seeded.messages[1].id;
  try {
    const owner = markStreaming(seeded.id, assistantId);

    // The generation finishes and writes its terminal row.
    assert.equal(
      finalizeStreamingOwner(seeded.id, owner.generationId, {
        content: 'the complete answer',
        meta: { finish_reason: 'stop' },
      }),
      true,
    );
    unmarkStreaming(seeded.id, owner.generationId);

    // A checkpoint from the same generation arrives late, still holding the
    // partial snapshot it captured before finalization.
    const late = await enqueueConversationWrite(
      seeded.id,
      'checkpoint active generation',
      async () => {
        await dbModule.saveMessages(
          [{ ...seeded.messages[1], content: 'partial' }],
          seeded.id,
        );
      },
      { kind: 'checkpoint', generationId: owner.generationId },
    );

    await drainConversationPersistence(seeded.id);

    assert.equal(late, 'skipped', 'the lane retires the superseded checkpoint');

    const durable = await loadMessages(seeded.id);
    const stored = durable.find((message) => message.id === assistantId);
    assert.equal(stored?.content, 'the complete answer');
    assert.equal(stored?.meta?.finish_reason, 'stop');
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('a checkpoint from a live generation still commits normally', async () => {
  // The barrier must not turn into a blanket refusal: an in-flight generation
  // depends on its checkpoints reaching Dexie for crash safety.
  const seeded = await seedConversation({
    label: 'checkpoint-live',
    messages: turn('checkpoint-live', ''),
  });
  const assistantId = seeded.messages[1].id;
  try {
    const owner = markStreaming(seeded.id, assistantId);

    const outcome = await enqueueConversationWrite(
      seeded.id,
      'checkpoint active generation',
      () => dbModule.saveMessages(
        [{ ...seeded.messages[1], content: 'streamed so far' }],
        seeded.id,
      ),
      { kind: 'checkpoint', generationId: owner.generationId },
    );
    await drainConversationPersistence(seeded.id);

    assert.equal(outcome, 'committed');
    const durable = await loadMessages(seeded.id);
    assert.equal(
      durable.find((message) => message.id === assistantId)?.content,
      'streamed so far',
    );

    unmarkStreaming(seeded.id, owner.generationId);
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('appendMessage lands its message and metadata as one unit', async () => {
  // Two unordered promises could leave messageCount describing a row that had
  // not been written, which makes the next load treat the history as
  // incomplete and refuse to replace it.
  const seeded = await seedConversation({ label: 'unit-write' });
  try {
    const appended = useConversations.getState().appendMessage(seeded.id, {
      role: 'user',
      content: 'second turn',
    });
    assert.ok(appended);
    await drainConversationPersistence(seeded.id);

    const durable = await loadMessages(seeded.id);
    assert.equal(durable.some((message) => message.id === appended.id), true);
    assert.equal(
      useConversations.getState().byId[seeded.id]?.messageCount,
      durable.length,
      'messageCount and stored rows agree',
    );
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('lazy load repairs mixed timestamp and counter sort orders before the next append', async () => {
  const seeded = await seedConversation({
    label: 'mixed-sort-orders',
    resident: false,
    messages: [
      { id: 'mixed-old-1', role: 'user', content: 'first', createdAt: 1_700_000_001_000 },
      { id: 'mixed-old-2', role: 'assistant', content: 'second', createdAt: 1_700_000_002_000 },
      { id: 'mixed-new-3', role: 'user', content: 'third', createdAt: 1_700_000_003_000, sortOrder: 3 },
    ],
  });
  try {
    assert.deepEqual(
      (await loadMessages(seeded.id)).map((message) => message.id),
      ['mixed-old-1', 'mixed-old-2', 'mixed-new-3'],
      'mixed domains read in creation order',
    );

    const loaded = await useConversations.getState().loadConversationMessages(seeded.id);
    assert.deepEqual(loaded.map((message) => message.sortOrder), [1, 2, 3]);
    assert.deepEqual(
      (await loadMessages(seeded.id)).map((message) => message.sortOrder),
      [1, 2, 3],
      'the lazy repair is durable',
    );

    const appended = useConversations.getState().appendMessage(seeded.id, {
      role: 'assistant',
      content: 'fourth',
    });
    assert.ok(appended);
    await drainConversationPersistence(seeded.id);
    assert.deepEqual(
      (await loadMessages(seeded.id)).map((message) => message.id),
      ['mixed-old-1', 'mixed-old-2', 'mixed-new-3', appended.id],
    );
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('failed clone persistence removes every staged attachment copy', async () => {
  const attachmentId = `clone-source-${crypto.randomUUID()}`;
  const seeded = await seedConversation({
    label: 'clone-compensation',
    messages: [
      {
        id: 'clone-source-user',
        role: 'user',
        content: 'source',
        createdAt: 1,
        sortOrder: 1,
        attachments: [{
          id: attachmentId,
          name: 'source.txt',
          mime: 'text/plain',
          isImage: false,
          size: 6,
          stored: 'idb',
        }],
      },
      {
        id: 'clone-source-assistant',
        role: 'assistant',
        content: 'invalid retained reference',
        createdAt: 2,
        sortOrder: 2,
        whiteboard_refs: {
          user_board: 'missing-user-board',
          model_initial_board: 'missing-model-board',
          model_latest_board: 'missing-model-board',
        },
      },
    ],
  });
  await putAttachment(attachmentId, new Blob(['source']), {
    mime: 'text/plain',
    name: 'source.txt',
    size: 6,
  });
  try {
    const before = await loadStoredAttachmentIds();
    await assert.rejects(
      useConversations.getState().clone(seeded.id),
      /missing Whiteboard version/,
    );
    assert.deepEqual(await loadStoredAttachmentIds(), before);
    assert.ok(await loadAttachment(attachmentId), 'the source blob remains');
  } finally {
    await deleteAttachments([attachmentId]);
    await releaseSeededConversations([seeded]);
  }
});

test('branch replacement removes attachments from every discarded turn', async () => {
  const retainedAttachmentId = `branch-retained-${crypto.randomUUID()}`;
  const discardedAttachmentId = `branch-discarded-${crypto.randomUUID()}`;
  const retainedAttachment = {
    id: retainedAttachmentId,
    name: 'retained.txt',
    mime: 'text/plain',
    isImage: false,
    size: 1,
    stored: 'idb' as const,
  };
  const seeded = await seedConversation({
    label: 'branch-attachment-cleanup',
    messages: [
      {
        id: 'branch-user-1',
        role: 'user',
        content: 'first',
        createdAt: 1,
        sortOrder: 1,
        attachments: [retainedAttachment],
      },
      { id: 'branch-assistant-1', role: 'assistant', content: 'reply', createdAt: 2, sortOrder: 2 },
      {
        id: 'branch-user-2',
        role: 'user',
        content: 'second',
        createdAt: 3,
        sortOrder: 3,
        attachments: [{
          id: discardedAttachmentId,
          name: 'discarded.txt',
          mime: 'text/plain',
          isImage: false,
          size: 1,
          stored: 'idb',
        }],
      },
    ],
  });
  await Promise.all([
    putAttachment(retainedAttachmentId, new Blob(['a']), retainedAttachment),
    putAttachment(discardedAttachmentId, new Blob(['b']), {
      mime: 'text/plain',
      name: 'discarded.txt',
      size: 1,
    }),
  ]);
  try {
    assert.equal(
      await useConversations.getState().replaceFromMessage(
        seeded.id,
        'branch-user-1',
        { content: 'retry', attachments: [retainedAttachment] },
      ),
      true,
    );
    assert.ok(await loadAttachment(retainedAttachmentId), 'the retained branch still owns its blob');
    assert.equal(await loadAttachment(discardedAttachmentId), null);
    assert.deepEqual(
      (await loadMessages(seeded.id)).map((message) => message.id),
      ['branch-user-1'],
    );
  } finally {
    await deleteAttachments([retainedAttachmentId, discardedAttachmentId]);
    await releaseSeededConversations([seeded]);
  }
});

test('failed durable deletion restores the conversation and reopens its lane', async () => {
  const seeded = await seedConversation({ label: 'delete-rollback' });
  try {
    await corruptAttachmentMetadata(seeded.messages[0].id);
    const deleting = useConversations.getState().remove(seeded.id);
    assert.equal(useConversations.getState().byId[seeded.id], undefined);
    assert.equal(await deleting, false);
    assert.ok(useConversations.getState().byId[seeded.id], 'the failed deletion rolls memory back');
    assert.equal(
      await enqueueConversationWrite(
        seeded.id,
        'write after failed delete',
        () => dbModule.saveMeta({ ...seeded.conversation, title: 'lane reopened' }),
      ),
      'committed',
    );
    assert.match(
      useConversations.getState().persistenceFailures[seeded.id]?.message ?? '',
      /JSON/,
    );
  } finally {
    useConversations.getState().clearConversationPersistenceFailure(seeded.id);
    await releaseSeededConversations([seeded]);
  }
});

test('writes for two conversations do not block each other', async () => {
  const [first, second] = await seedConversations(2, { label: 'independent-lanes' });
  try {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const blocked = enqueueConversationWrite(first.id, 'slow write', () => gate);
    const quick = await enqueueConversationWrite(
      second.id,
      'quick write',
      () => dbModule.saveMeta({ ...second.conversation, title: 'renamed' }),
    );

    assert.equal(quick, 'committed', 'the second lane ran while the first was blocked');

    releaseFirst();
    assert.equal(await blocked, 'committed');
  } finally {
    await releaseSeededConversations([first, second]);
  }
});

test('deleting a conversation refuses a write queued after it', async () => {
  const seeded = await seedConversation({ label: 'delete-closes-lane' });
  try {
    useConversations.getState().remove(seeded.id);
    await drainConversationPersistence(seeded.id);

    const resurrect = await enqueueConversationWrite(
      seeded.id,
      'late append',
      () => dbModule.saveMeta(seeded.conversation),
    );
    assert.equal(resurrect, 'closed');

    const durable = await loadMessages(seeded.id);
    assert.deepEqual(durable, [], 'no row survives the delete');
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('a failure in one conversation does not erase another conversation\'s failure', async () => {
  // The single latest-value `persistenceFailure` slot cannot hold both. The
  // conversation-keyed retention map must.
  const [first, second] = await seedConversations(2, { label: 'failure-retention' });
  try {
    await Promise.all([
      enqueueConversationWrite(first.id, 'save conversation metadata', async () => {
        throw new Error('first conversation quota exceeded');
      }),
      enqueueConversationWrite(second.id, 'save conversation metadata', async () => {
        throw new Error('second conversation quota exceeded');
      }),
    ]);

    const retained = useConversations.getState().persistenceFailures;
    assert.match(retained[first.id]?.message ?? '', /first conversation/);
    assert.match(retained[second.id]?.message ?? '', /second conversation/);

    useConversations.getState().clearConversationPersistenceFailure(first.id);
    const afterClear = useConversations.getState().persistenceFailures;
    assert.equal(afterClear[first.id], undefined);
    assert.match(afterClear[second.id]?.message ?? '', /second conversation/);
  } finally {
    useConversations.setState({ persistenceFailure: null, persistenceFailures: {} });
    await releaseSeededConversations([first, second]);
  }
});

test('an intermediate tool round does not retire the generation\'s checkpoints', async () => {
  // The orchestrator finalizes the owned assistant row at the end of every
  // tool round, writing `finish_reason: 'tool_calls'` before it re-streams.
  // Classifying those as terminal retired the generation's checkpoints while
  // it was still producing output, so a crash in any later round lost
  // everything written after the first tool call.
  const seeded = await seedConversation({
    label: 'intermediate-round',
    messages: turn('intermediate-round', ''),
  });
  const assistantId = seeded.messages[1].id;
  try {
    const owner = markStreaming(seeded.id, assistantId);

    // End of an intermediate round — not the generation's terminal transition.
    useConversations.getState().finalizeMessage(seeded.id, assistantId, {
      tool_calls: [{ created_at: 0, id: 'call-1', name: 'lc_read_file', arguments: '{}' }],
      meta: { finish_reason: 'tool_calls' },
    });
    await drainConversationPersistence(seeded.id);

    // A checkpoint from the same generation must still be written.
    const outcome = await enqueueConversationWrite(
      seeded.id,
      'checkpoint active generation',
      () => dbModule.saveMessages(
        [{ ...seeded.messages[1], content: 'streamed after the tool round' }],
        seeded.id,
      ),
      { kind: 'checkpoint', generationId: owner.generationId },
    );
    await drainConversationPersistence(seeded.id);

    assert.equal(outcome, 'committed', 'the generation is still checkpointing');
    const durable = await loadMessages(seeded.id);
    assert.equal(
      durable.find((message) => message.id === assistantId)?.content,
      'streamed after the tool round',
    );

    unmarkStreaming(seeded.id, owner.generationId);
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('capacity is held until the terminal flush is durable', async () => {
  // Ownership is what admission checks. Releasing it while the terminal flush
  // is still queued lets a replacement generation start and then be
  // overwritten by the previous one's transcript snapshot.
  const seeded = await seedConversation({
    label: 'durable-release',
    messages: turn('durable-release', 'partial'),
  });
  const assistantId = seeded.messages[1].id;
  try {
    const owner = markStreaming(seeded.id, assistantId);
    finalizeStreamingOwner(seeded.id, owner.generationId, {
      content: 'final answer',
      meta: { finish_reason: 'stop' },
    });

    const released = releaseStreamingOwnerWhenDurable(seeded.id, owner.generationId);
    assert.equal(
      conversationModule.isStreaming(seeded.id),
      true,
      'ownership is still held while the flush is queued',
    );

    assert.equal(await released, true);
    assert.equal(conversationModule.isStreaming(seeded.id), false);
    assert.equal(
      conversationModule.hasPendingConversationPersistence(seeded.id),
      false,
      'nothing is left queued once the slot is free',
    );

    const durable = await loadMessages(seeded.id);
    assert.equal(durable.find((message) => message.id === assistantId)?.content, 'final answer');
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('ordinary checkpoint rows can skip synchronous message compression', () => {
  const content = 'compressible checkpoint content\n'.repeat(20_000);
  const message: Message = {
    id: 'compression-policy',
    role: 'assistant',
    content,
    reasoning: content,
    createdAt: 1,
  };

  const terminalRow = dbModule.messageToStorageRow(message, 'compression-policy');
  const checkpointRow = dbModule.messageToStorageRow(
    message,
    'compression-policy',
    { compress: false },
  );

  assert.equal(terminalRow.content?.startsWith('Z:'), true);
  assert.equal(terminalRow.reasoning?.startsWith('Z:'), true);
  assert.equal(checkpointRow.content, content);
  assert.equal(checkpointRow.reasoning, content);
});

test('checkpoint mapper encodes reserved-prefix text losslessly', () => {
  const content = compressionMarkerCollision();
  const message: Message = {
    id: 'checkpoint-marker',
    role: 'assistant',
    content,
    reasoning: content,
    createdAt: 1,
  };

  const row = dbModule.messageToStorageRow(
    message,
    'checkpoint-marker',
    { compress: false },
  );

  assert.equal(row.content?.startsWith('Z:'), true);
  assert.equal(row.reasoning?.startsWith('Z:'), true);
  assert.notEqual(row.content, content);
  assert.notEqual(row.reasoning, content);
  const restored = dbModule.messageFromStorageRow(row);
  assert.equal(restored.content, content);
  assert.equal(restored.reasoning, content);
});

test('reasoning visibility is transient and reconstructed on load', () => {
  const message: Message = {
    id: 'reasoning-visibility',
    role: 'assistant',
    content: '',
    reasoning: ' \nvisible reasoning',
    reasoningHasVisibleContent: true,
    createdAt: 1,
  };

  const row = dbModule.messageToStorageRow(message, 'reasoning-visibility');
  assert.equal('reasoningHasVisibleContent' in row, false);

  const restored = dbModule.messageFromStorageRow(row);
  assert.equal(restored.reasoning, message.reasoning);
  assert.equal(restored.reasoningHasVisibleContent, true);

  const archiveSnapshot = dbModule.persistedMessageSnapshot(message);
  assert.equal('reasoningHasVisibleContent' in archiveSnapshot, false);
});

test('the periodic checkpoint call site stores ordinary message rows plain', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const content = 'compressible live checkpoint content\n'.repeat(20_000);
  const messages = turn('checkpoint-call-site', content);
  const seeded = await seedConversation({
    label: 'checkpoint-call-site',
    messages,
  });
  const assistantId = messages[1].id;
  let generationId: string | undefined;
  try {
    assert.equal((await loadRawMessageRow(assistantId))?.content?.startsWith('Z:'), true);

    const owner = markStreaming(seeded.id, assistantId);
    generationId = owner.generationId;
    t.mock.timers.tick(5_000);
    await drainConversationPersistence(seeded.id);

    assert.equal((await loadRawMessageRow(assistantId))?.content, content);
  } finally {
    if (generationId) unmarkStreaming(seeded.id, generationId);
    await releaseSeededConversations([seeded]);
  }
});

test('the periodic checkpoint preserves reserved-prefix text after interruption', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const initialMessages = turn('checkpoint-marker-call-site', 'initial');
  const seeded = await seedConversation({
    label: 'checkpoint-marker-call-site',
    messages: initialMessages,
  });
  const content = compressionMarkerCollision();
  const liveMessages = turn('checkpoint-marker-call-site', content);
  const assistantId = liveMessages[1].id;
  useConversations.setState((state) => ({
    byId: {
      ...state.byId,
      [seeded.id]: { ...state.byId[seeded.id], messages: liveMessages },
    },
  }));
  let generationId: string | undefined;
  try {
    assert.equal((await loadRawMessageRow(assistantId))?.content, 'initial');

    const owner = markStreaming(seeded.id, assistantId);
    generationId = owner.generationId;
    t.mock.timers.tick(5_000);
    await drainConversationPersistence(seeded.id);

    const raw = await loadRawMessageRow(assistantId);
    assert.equal(raw?.content?.startsWith('Z:'), true);
    assert.notEqual(raw?.content, content);

    unmarkStreaming(seeded.id, owner.generationId);
    generationId = undefined;
    const durable = await loadMessages(seeded.id);
    assert.equal(
      durable.find((message) => message.id === assistantId)?.content,
      content,
    );
  } finally {
    if (generationId) unmarkStreaming(seeded.id, generationId);
    await releaseSeededConversations([seeded]);
  }
});

test('checkpoint capture pauses while a lifecycle mutation owns the lane', async () => {
  const seeded = await seedConversation({ label: 'checkpoint-lifecycle-fence' });
  try {
    let releaseMutation!: () => void;
    const gate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutation = enqueueConversationWrite(
      seeded.id,
      'gated Whiteboard lifecycle mutation',
      () => gate,
    );

    assert.equal(canEnqueueConversationCheckpoint(seeded.id), false);
    releaseMutation();
    assert.equal(await mutation, 'committed');
    assert.equal(canEnqueueConversationCheckpoint(seeded.id), true);
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('failed terminal persistence retains ownership until a later durable retry', async () => {
  const seeded = await seedConversation({
    label: 'failed-terminal-release',
    messages: turn('failed-terminal-release', 'partial'),
  });
  const assistantId = seeded.messages[1].id;
  try {
    const owner = markStreaming(seeded.id, assistantId);
    assert.equal(
      finalizeStreamingOwner(seeded.id, owner.generationId, {
        content: 'final answer',
        meta: { finish_reason: 'stop' },
      }),
      true,
    );

    let retiredJournal = false;
    const released = await releaseStreamingOwnerWhenDurable(
      seeded.id,
      owner.generationId,
      {
        persistSnapshot: async () => { throw new Error('forced terminal failure'); },
        saveMetadata: dbModule.saveMeta,
        closeRun: async () => {
          retiredJournal = true;
          return true;
        },
      },
    );

    assert.equal(released, false);
    assert.equal(conversationModule.isStreaming(seeded.id), true);
    assert.equal(retiredJournal, false, 'crash evidence is not retired after a failed snapshot');
    assert.throws(
      () => markStreaming(seeded.id, assistantId, 'replacement-generation'),
      /already has an active stream owner/,
    );

    assert.equal(
      await releaseStreamingOwnerWhenDurable(seeded.id, owner.generationId),
      true,
      'the retained owner can be released after persistence recovers',
    );
    assert.equal(conversationModule.isStreaming(seeded.id), false);
  } finally {
    useConversations.getState().clearConversationPersistenceFailure(seeded.id);
    await releaseSeededConversations([seeded]);
  }
});

test('failed Whiteboard settlement retains its owner, working row, and journal until retry', async () => {
  const seeded = await seedConversation({
    label: 'whiteboard-terminal-prerequisite',
    messages: turn('whiteboard-terminal-prerequisite', ''),
  });
  const assistantId = seeded.messages[1].id;
  let generationId: string | undefined;
  try {
    const owner = markStreaming(seeded.id, assistantId);
    generationId = owner.generationId;
    const lifecycle = await admitWhiteboardGeneration({
      conversationId: seeded.id,
      generationId: owner.generationId,
      assistantMessageId: assistantId,
    });
    let settlementAvailable = false;
    registerGenerationTerminalPrerequisite(
      seeded.id,
      owner.generationId,
      () => settlementAvailable
        ? lifecycle.settle('generation_ended')
        : Promise.resolve(false),
    );

    assert.equal(finalizeStreamingOwner(seeded.id, owner.generationId, {
      content: 'final answer',
      meta: { finish_reason: 'stop' },
    }), true);
    await drainConversationPersistence(seeded.id);

    assert.equal(
      await releaseStreamingOwnerWhenDurable(seeded.id, owner.generationId),
      false,
    );
    assert.equal(conversationModule.isStreaming(seeded.id), true);
    assert.match(
      useConversations.getState().persistenceFailures[seeded.id]?.message ?? '',
      /terminal prerequisite did not commit/i,
    );
    assert.equal(
      (await dbModule.loadGenerationRun(seeded.id))?.generationId,
      owner.generationId,
    );
    assert.equal(
      (await getModelWhiteboardWorking(seeded.id))?.generationId,
      owner.generationId,
    );
    assert.notEqual(
      (await loadMessages(seeded.id)).find((message) => message.id === assistantId)?.meta?.finish_reason,
      'stop',
      'the owned terminal message stays in memory until Whiteboard settlement succeeds',
    );

    settlementAvailable = true;
    useConversations.getState().clearConversationPersistenceFailure(seeded.id);
    assert.equal(
      await releaseStreamingOwnerWhenDurable(seeded.id, owner.generationId),
      true,
    );
    assert.equal(await dbModule.loadGenerationRun(seeded.id), undefined);
    assert.equal(await getModelWhiteboardWorking(seeded.id), null);
    assert.equal(
      (await loadMessages(seeded.id)).find((message) => message.id === assistantId)?.meta?.finish_reason,
      'stop',
    );
  } finally {
    useConversations.getState().clearConversationPersistenceFailure(seeded.id);
    if (generationId && conversationModule.isStreaming(seeded.id)) {
      unmarkStreaming(seeded.id, generationId);
    }
    await releaseSeededConversations([seeded]);
  }
});

test('clearAll cannot be undone by a write already running when it started', async () => {
  // A lane cannot cancel a task at its head, so the wipe waits for the running
  // heads to finish before erasing. Erasing first let a checkpoint mid-flight
  // write its rows back after the delete transaction committed.
  const seeded = await seedConversation({ label: 'wipe-race' });
  const ghostId = `wipe-ghost-${crypto.randomUUID()}`;
  let postWipeId: string | undefined;
  try {
    let releaseInFlight!: () => void;
    const gate = new Promise<void>((resolve) => { releaseInFlight = resolve; });
    const inFlight = enqueueConversationWrite(seeded.id, 'slow checkpoint', async () => {
      await gate;
      await dbModule.saveMessages(
        [{ ...seeded.messages[0], content: 'resurrected' }],
        seeded.id,
      );
    });
    let releaseGhost!: () => void;
    const ghostGate = new Promise<void>((resolve) => { releaseGhost = resolve; });
    const ghostInFlight = enqueueConversationWrite(ghostId, 'hidden slow write', async () => {
      await ghostGate;
      await dbModule.saveMeta({
        ...seeded.conversation,
        id: ghostId,
        title: 'not present in Zustand',
        messages: [],
        messageCount: 0,
      });
    });

    const wipe = useConversations.getState().clearAll();
    assert.throws(
      () => useConversations.getState().create({ title: 'must wait for wipe' }),
      /finish before changing response configuration/i,
    );
    releaseInFlight();
    releaseGhost();
    await inFlight;
    await ghostInFlight;
    assert.equal(await wipe, true);

    assert.deepEqual(
      await loadMessages(seeded.id),
      [],
      'the in-flight write did not survive the wipe',
    );
    assert.equal(
      (await dbModule.loadAllMeta()).some((conversation) => conversation.id === ghostId),
      false,
      'a lane absent from the in-memory corpus is still drained before the wipe',
    );

    const postWipe = useConversations.getState().create({ title: 'new lifetime' });
    postWipeId = postWipe.id;
    await drainConversationPersistence(postWipe.id);
    assert.equal(
      (await dbModule.loadAllMeta()).some((conversation) => conversation.id === postWipe.id),
      true,
      'a conversation created after the awaited wipe starts a durable new lifetime',
    );
  } finally {
    if (postWipeId) {
      useConversations.getState().remove(postWipeId);
      await drainConversationPersistence(postWipeId);
    }
    await releaseSeededConversations([seeded]);
  }
});

test('same-id restore waits for a pending final delete and reopens the new lifetime', async () => {
  const seeded = await seedConversation({ label: 'delete-restore-order' });
  try {
    let releaseHead!: () => void;
    const gate = new Promise<void>((resolve) => { releaseHead = resolve; });
    const head = enqueueConversationWrite(seeded.id, 'slow pre-delete write', () => gate);

    useConversations.getState().remove(seeded.id);
    let restoreStarted = false;
    const restoredMetadata = {
      ...seeded.conversation,
      title: 'restored after delete',
      messages: seeded.messages,
      messageCount: seeded.messages.length,
    };
    const restoring = runConversationRestoreWrite(
      seeded.id,
      'restore deleted conversation',
      async () => {
        restoreStarted = true;
        await dbModule.saveMessages(seeded.messages, seeded.id);
        await dbModule.saveMeta(restoredMetadata);
      },
    );

    await Promise.resolve();
    assert.equal(restoreStarted, false, 'restore stays behind the final delete barrier');
    releaseHead();
    assert.equal(await head, 'committed');
    await restoring;

    assert.equal(
      (await dbModule.loadAllMeta()).find((conversation) => conversation.id === seeded.id)?.title,
      'restored after delete',
    );
    assert.deepEqual(
      (await loadMessages(seeded.id)).map((message) => message.id),
      seeded.messages.map((message) => message.id),
    );

    assert.equal(
      await enqueueConversationWrite(
        seeded.id,
        'write after restore',
        () => dbModule.saveMeta({ ...restoredMetadata, title: 'new lifetime is open' }),
      ),
      'committed',
    );
    assert.equal(
      (await dbModule.loadAllMeta()).find((conversation) => conversation.id === seeded.id)?.title,
      'new lifetime is open',
    );
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('failed tombstone restore stays closed until a successful retry', async () => {
  const seeded = await seedConversation({ label: 'restore-retry' });
  try {
    useConversations.getState().remove(seeded.id);
    await drainConversationPersistence(seeded.id);

    await assert.rejects(
      runConversationRestoreWrite(seeded.id, 'failed restore', async () => {
        throw new Error('forced restore failure');
      }),
      /forced restore failure/,
    );
    assert.equal(
      await enqueueConversationWrite(
        seeded.id,
        'must remain tombstoned',
        () => dbModule.saveMeta(seeded.conversation),
      ),
      'closed',
    );

    await runConversationRestoreWrite(
      seeded.id,
      'successful restore retry',
      () => dbModule.saveMeta(seeded.conversation),
    );
    assert.equal(
      await enqueueConversationWrite(
        seeded.id,
        'write after successful retry',
        () => dbModule.saveMeta({ ...seeded.conversation, title: 'retry opened lane' }),
      ),
      'committed',
    );
  } finally {
    useConversations.getState().clearConversationPersistenceFailure(seeded.id);
    await releaseSeededConversations([seeded]);
  }
});

test('same-id restore invalidates an old lazy-load publication', async () => {
  const seeded = await seedConversation({ label: 'lazy-load-lifetime', resident: false });
  try {
    let releaseHead!: () => void;
    const gate = new Promise<void>((resolve) => { releaseHead = resolve; });
    const head = enqueueConversationWrite(seeded.id, 'hold old lazy load', () => gate);
    const oldLoad = useConversations.getState().loadConversationMessages(seeded.id);

    const replacement = {
      ...seeded.conversation,
      title: 'replacement lifetime',
      messages: [],
      messageCount: 0,
    };
    const restoring = runConversationRestoreWrite(
      seeded.id,
      'replace while old load is pending',
      async () => {
        await dbModule.replaceMessages(seeded.id, []);
        await dbModule.saveMeta(replacement);
      },
    );

    releaseHead();
    assert.equal(await head, 'committed');
    await restoring;
    useConversations.setState((state) => ({
      byId: { ...state.byId, [seeded.id]: replacement },
    }));
    await oldLoad;

    assert.equal(useConversations.getState().byId[seeded.id]?.title, 'replacement lifetime');
    assert.deepEqual(useConversations.getState().byId[seeded.id]?.messages, []);
    assert.deepEqual(await loadMessages(seeded.id), []);
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('a write enqueued after a delete is refused, not queued behind it', async () => {
  const seeded = await seedConversation({ label: 'delete-seal' });
  try {
    useConversations.getState().remove(seeded.id);

    // Synchronously after the delete was decided — the window the old
    // close-on-completion ordering left open.
    const sneaked = await enqueueConversationWrite(
      seeded.id,
      'late checkpoint',
      () => dbModule.saveMessages([seeded.messages[0]], seeded.id),
    );
    assert.equal(sneaked, 'closed');

    await drainConversationPersistence(seeded.id);
    assert.deepEqual(await loadMessages(seeded.id), []);
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('patchMessage clears stale block order when blocks are replaced without order', async () => {
  const assistantId = 'block-order-stale-asst';
  const seeded = await seedConversation({
    label: 'block-order-stale',
    messages: [
      { id: 'block-order-stale-user', role: 'user', content: 'ask', createdAt: 1, sortOrder: 1 },
      {
        id: assistantId,
        role: 'assistant',
        content: 'Working on it.',
        createdAt: 2,
        sortOrder: 2,
        anthropic_output_blocks: [{ type: 'thinking', thinking: 'plan' }],
        anthropic_block_order: [
          { kind: 'text', index: 0, text: 'Working on it.' },
          { kind: 'thinking', index: 1 },
        ],
      },
    ],
  });
  try {
    useConversations.getState().patchMessage(seeded.id, assistantId, {
      anthropic_output_blocks: [{ type: 'thinking', thinking: 'later' }],
    });
    const cleared = useConversations.getState().byId[seeded.id].messages
      .find((message) => message.id === assistantId);
    assert.equal(cleared?.anthropic_block_order, undefined);

    useConversations.getState().patchMessage(seeded.id, assistantId, {
      anthropic_output_blocks: [{ type: 'thinking', thinking: 'v3' }],
      anthropic_block_order: [{ kind: 'thinking', index: 0 }],
    });
    const kept = useConversations.getState().byId[seeded.id].messages
      .find((message) => message.id === assistantId);
    assert.deepEqual(kept?.anthropic_block_order, [{ kind: 'thinking', index: 0 }]);
  } finally {
    await releaseSeededConversations([seeded]);
  }
});
