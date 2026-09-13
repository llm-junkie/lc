/**
 * Phase 1 — the generation journal and crash recovery.
 *
 * The behavior under test is the one Phase 0 characterized as a defect: an
 * interrupted plain-text answer used to reload looking complete, because
 * `Message.streaming` is not durable and unanswered-tool recovery only sees
 * tool calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import type { Message } from '../types.ts';

const [dbModule, conversationModule, journalModule, fixtureModule] = await Promise.all([
  import('./db.ts'),
  import('./conversations.ts'),
  import('./generation-journal.ts'),
  import('./multi-conversation-fixture.ts'),
]);

const {
  CONVERSATION_DB_VERSION,
  loadGenerationRun,
  loadGenerationRuns,
  loadMessages,
  recordGenerationRun,
} = dbModule;
const {
  drainConversationPersistence,
  finalizeStreamingOwner,
  markStreaming,
  persistNonWhiteboardStreamingAssistant,
  unmarkStreaming,
  useConversations,
} = conversationModule;
const {
  INTERRUPTED_FINISH_REASON,
  closeGenerationRun,
  conversationNeedsRecovery,
  recoverJournaledGenerations,
  resetRecoveryFlagsForTests,
  settleGenerationRunAfterRepair,
} = journalModule;
const { seedConversation, releaseSeededConversations } = fixtureModule;

await useConversations.getState().hydrate();

function partialTurn(prefix: string): Message[] {
  return [
    { id: `${prefix}-user`, role: 'user', content: 'explain', createdAt: 1, sortOrder: 1 },
    {
      id: `${prefix}-assistant`,
      role: 'assistant',
      content: 'partial answer cut off mid-',
      createdAt: 2,
      sortOrder: 2,
    },
  ];
}

test('the schema is at version 3 with the journal declared additively', () => {
  assert.equal(CONVERSATION_DB_VERSION, 3);
});

test('an interrupted plain-text answer is recovered as interrupted', async () => {
  // Phase 0 asserted the opposite: the answer reloaded with no finish reason
  // and was indistinguishable from a completed one.
  const prefix = `journal-plain-${crypto.randomUUID()}`;
  const seeded = await seedConversation({
    label: 'journal-plain',
    messages: partialTurn(prefix),
    resident: false,
  });
  const assistantId = seeded.messages[1].id;
  try {
    await recordGenerationRun({
      conversationId: seeded.id,
      generationId: 'gen-crashed',
      assistantMessageId: assistantId,
      state: 'running',
      startedAt: 1,
    });

    const recovery = await recoverJournaledGenerations();
    assert.ok(recovery.interrupted.includes(seeded.id));
    assert.equal(conversationNeedsRecovery(seeded.id), true);

    const durable = await loadMessages(seeded.id);
    const assistant = durable.find((message) => message.id === assistantId);
    assert.equal(assistant?.meta?.finish_reason, INTERRUPTED_FINISH_REASON);
    assert.equal(
      assistant?.content,
      'partial answer cut off mid-',
      'recovery marks the answer without rewriting what was streamed',
    );
  } finally {
    resetRecoveryFlagsForTests();
    await releaseSeededConversations([seeded]);
  }
});

test('a journaled answer that had actually finished is left alone', async () => {
  // Crash-after-finalize: only the journal deletion was lost. Relabelling it
  // would invent a defect that never happened.
  const prefix = `journal-complete-${crypto.randomUUID()}`;
  const messages = partialTurn(prefix);
  messages[1] = { ...messages[1], content: 'the whole answer', meta: { finish_reason: 'stop' } };
  const seeded = await seedConversation({
    label: 'journal-complete',
    messages,
    resident: false,
  });
  try {
    await recordGenerationRun({
      conversationId: seeded.id,
      generationId: 'gen-finished',
      assistantMessageId: messages[1].id,
      state: 'running',
      startedAt: 1,
    });

    const recovery = await recoverJournaledGenerations();
    assert.ok(recovery.alreadyComplete.includes(seeded.id));
    assert.equal(conversationNeedsRecovery(seeded.id), false);

    const durable = await loadMessages(seeded.id);
    assert.equal(
      durable.find((message) => message.id === messages[1].id)?.meta?.finish_reason,
      'stop',
    );
    assert.equal(await loadGenerationRun(seeded.id), undefined, 'the stale row is retired');
  } finally {
    resetRecoveryFlagsForTests();
    await releaseSeededConversations([seeded]);
  }
});

test('recovery marks every journaled row, not just the first three', async () => {
  // An interrupted recovery can leave older rows behind, so the table is not
  // bounded by the live capacity limit. Each conversation gets a real
  // *assistant* row: pointing the journal at a user message would classify
  // every row as orphaned and the test would pass without recovering anything.
  const seeded = await Promise.all(Array.from({ length: 5 }, (_unused, index) =>
    seedConversation({
      label: `journal-many-${index}`,
      messages: partialTurn(`journal-many-${index}`),
      resident: false,
    })));
  try {
    await Promise.all(seeded.map((entry, index) => recordGenerationRun({
      conversationId: entry.id,
      generationId: `gen-${index}`,
      assistantMessageId: entry.messages[1].id,
      state: 'running',
      startedAt: index,
    })));

    const recovery = await recoverJournaledGenerations();

    for (const entry of seeded) {
      assert.equal(
        recovery.interrupted.includes(entry.id),
        true,
        `${entry.id} was marked interrupted, not skipped or written off as an orphan`,
      );
      const durable = await loadMessages(entry.id);
      assert.equal(
        durable.find((message) => message.role === 'assistant')?.meta?.finish_reason,
        INTERRUPTED_FINISH_REASON,
        `${entry.id} assistant row carries the interrupted marker`,
      );
    }
    assert.deepEqual(recovery.orphaned, [], 'no row was mistaken for an orphan');
  } finally {
    resetRecoveryFlagsForTests();
    await Promise.all(seeded.map((entry, index) =>
      closeGenerationRun(entry.id, `gen-${index}`).catch(() => undefined)));
    await releaseSeededConversations(seeded);
  }
});

test('a turn interrupted between tool rounds is not mistaken for a finished one', async () => {
  // The assistant row carries `finish_reason: 'tool_calls'` at the end of every
  // intermediate round. Treating any nonempty finish reason as final retired
  // the journal row and left the interruption invisible.
  const prefix = `journal-tool-round-${crypto.randomUUID()}`;
  const messages = partialTurn(prefix);
  messages[1] = {
    ...messages[1],
    meta: { finish_reason: 'tool_calls' },
    tool_calls: [{ created_at: 0, id: `${prefix}-call`, name: 'lc_read_file', arguments: '{}' }],
  };
  const seeded = await seedConversation({
    label: 'journal-tool-round',
    messages,
    resident: false,
  });
  try {
    await recordGenerationRun({
      conversationId: seeded.id,
      generationId: 'gen-tool-round',
      assistantMessageId: messages[1].id,
      state: 'running',
      startedAt: 1,
    });

    const recovery = await recoverJournaledGenerations();

    assert.ok(recovery.interrupted.includes(seeded.id));
    assert.equal(recovery.alreadyComplete.includes(seeded.id), false);
    const durable = await loadMessages(seeded.id);
    assert.equal(
      durable.find((message) => message.role === 'assistant')?.meta?.finish_reason,
      INTERRUPTED_FINISH_REASON,
    );
  } finally {
    resetRecoveryFlagsForTests();
    await closeGenerationRun(seeded.id, 'gen-tool-round').catch(() => undefined);
    await releaseSeededConversations([seeded]);
  }
});

test('opening a conversation before startup recovery still marks it interrupted', async () => {
  // Startup recovery does not block hydration, so a conversation can be opened
  // before the startup pass reaches its row. Settling unconditionally in that
  // window left an answer with no finish reason and no journal row.
  const prefix = `journal-early-open-${crypto.randomUUID()}`;
  const seeded = await seedConversation({
    label: 'journal-early-open',
    messages: partialTurn(prefix),
    resident: false,
  });
  try {
    await recordGenerationRun({
      conversationId: seeded.id,
      generationId: 'gen-early',
      assistantMessageId: seeded.messages[1].id,
      state: 'running',
      startedAt: 1,
    });

    // The load path settles the row without any startup pass having run.
    await settleGenerationRunAfterRepair(seeded.id);

    const durable = await loadMessages(seeded.id);
    assert.equal(
      durable.find((message) => message.role === 'assistant')?.meta?.finish_reason,
      INTERRUPTED_FINISH_REASON,
      'the marking happened even though startup recovery never ran',
    );
    assert.equal(await loadGenerationRun(seeded.id), undefined, 'and the row was retired');
  } finally {
    resetRecoveryFlagsForTests();
    await releaseSeededConversations([seeded]);
  }
});

test('a failed transcript repair keeps the journal row', async () => {
  const prefix = `journal-failed-repair-${crypto.randomUUID()}`;
  const seeded = await seedConversation({
    label: 'journal-failed-repair',
    messages: partialTurn(prefix),
    resident: false,
  });
  try {
    await recordGenerationRun({
      conversationId: seeded.id,
      generationId: 'gen-failed',
      assistantMessageId: seeded.messages[1].id,
      state: 'running',
      startedAt: 1,
    });

    await settleGenerationRunAfterRepair(seeded.id, false);

    assert.ok(
      await loadGenerationRun(seeded.id),
      'evidence of the damage survives a repair that did not commit',
    );
    assert.equal(conversationNeedsRecovery(seeded.id), true);
  } finally {
    resetRecoveryFlagsForTests();
    await closeGenerationRun(seeded.id, 'gen-failed').catch(() => undefined);
    await releaseSeededConversations([seeded]);
  }
});

test('a journal row whose conversation is gone is retired as an orphan', async () => {
  const orphanId = `journal-orphan-${crypto.randomUUID()}`;
  await recordGenerationRun({
    conversationId: orphanId,
    generationId: 'gen-orphan',
    assistantMessageId: `${orphanId}-assistant`,
    state: 'running',
    startedAt: 1,
  });
  try {
    const recovery = await recoverJournaledGenerations();
    assert.ok(recovery.orphaned.includes(orphanId));
    assert.equal(await loadGenerationRun(orphanId), undefined);
    assert.equal(conversationNeedsRecovery(orphanId), false);
  } finally {
    resetRecoveryFlagsForTests();
  }
});

test('a stale finalizer cannot delete a replacement generation\'s row', async () => {
  const seeded = await seedConversation({ label: 'journal-fence', resident: false });
  try {
    await recordGenerationRun({
      conversationId: seeded.id,
      generationId: 'gen-replacement',
      assistantMessageId: seeded.messages[0].id,
      state: 'running',
      startedAt: 2,
    });

    assert.equal(
      await closeGenerationRun(seeded.id, 'gen-superseded'),
      false,
      'the compare-and-delete refuses a mismatched generation',
    );
    assert.equal((await loadGenerationRun(seeded.id))?.generationId, 'gen-replacement');

    assert.equal(await closeGenerationRun(seeded.id, 'gen-replacement'), true);
    assert.equal(await loadGenerationRun(seeded.id), undefined);
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('a clean generation opens and retires its own journal row', async () => {
  const prefix = `journal-lifecycle-${crypto.randomUUID()}`;
  const seeded = await seedConversation({
    label: 'journal-lifecycle',
    messages: partialTurn(prefix),
  });
  const assistantId = seeded.messages[1].id;
  try {
    const owner = markStreaming(seeded.id, assistantId);
    await persistNonWhiteboardStreamingAssistant(owner);

    const admitted = await loadGenerationRun(seeded.id);
    assert.equal(admitted?.generationId, owner.generationId);
    assert.equal(admitted?.assistantMessageId, assistantId);

    finalizeStreamingOwner(seeded.id, owner.generationId, {
      content: 'done',
      meta: { finish_reason: 'stop' },
    });
    unmarkStreaming(seeded.id, owner.generationId);
    await drainConversationPersistence(seeded.id);

    assert.equal(
      await loadGenerationRun(seeded.id),
      undefined,
      'a clean finish leaves no crash evidence behind',
    );
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('the journal row carries no prompt, content, title, or credential', async () => {
  const seeded = await seedConversation({ label: 'journal-privacy', resident: false });
  try {
    await recordGenerationRun({
      conversationId: seeded.id,
      generationId: 'gen-privacy',
      assistantMessageId: seeded.messages[0].id,
      state: 'running',
      startedAt: 1,
    });
    const rows = await loadGenerationRuns();
    const row = rows.find((candidate) => candidate.conversationId === seeded.id);
    assert.ok(row);
    assert.deepEqual(
      Object.keys(row).sort(),
      ['assistantMessageId', 'conversationId', 'generationId', 'startedAt', 'state'],
      'the journal shape is identifiers and state only',
    );
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('deleting a conversation removes its journal row', async () => {
  const seeded = await seedConversation({ label: 'journal-delete' });
  try {
    await recordGenerationRun({
      conversationId: seeded.id,
      generationId: 'gen-delete',
      assistantMessageId: seeded.messages[0].id,
      state: 'running',
      startedAt: 1,
    });

    useConversations.getState().remove(seeded.id);
    await drainConversationPersistence(seeded.id);

    assert.equal(await loadGenerationRun(seeded.id), undefined);
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('lazy settlement retires the row and clears the attention flag', async () => {
  const prefix = `journal-settle-${crypto.randomUUID()}`;
  const seeded = await seedConversation({
    label: 'journal-settle',
    messages: partialTurn(prefix),
    resident: false,
  });
  try {
    await recordGenerationRun({
      conversationId: seeded.id,
      generationId: 'gen-settle',
      assistantMessageId: seeded.messages[1].id,
      state: 'running',
      startedAt: 1,
    });
    await recoverJournaledGenerations();
    assert.equal(conversationNeedsRecovery(seeded.id), true);

    await settleGenerationRunAfterRepair(seeded.id);

    assert.equal(await loadGenerationRun(seeded.id), undefined);
    assert.equal(conversationNeedsRecovery(seeded.id), false);
  } finally {
    resetRecoveryFlagsForTests();
    await releaseSeededConversations([seeded]);
  }
});
