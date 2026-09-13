/**
 * Phase 0 characterization — what LC does today, before concurrency work.
 *
 * These tests are not aspirational. Each one asserts current behavior so that
 * the phases which deliberately change it produce a visible, reviewable diff
 * instead of a silent one. Where the documented behavior is a defect, the test
 * says so in its name and comment, and the phase that fixes it is expected to
 * rewrite the assertion rather than delete the test.
 *
 * See `docs/concurrent-conversations.md`, "Admission and session lifecycle."
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import type { Message } from '../types.ts';
import type { ToolExecutionIdentity } from '../modules/tool-engine/types';
import {
  resetGenerationSessionsForTests,
  setGenerationCapacityForTests,
  setProfileGenerationLimit,
} from '../modules/chat-pipeline/generation-session-manager.ts';

const [dbModule, conversationModule, fixtureModule, fileLockModule] = await Promise.all([
  import('./db.ts'),
  import('./conversations.ts'),
  import('./multi-conversation-fixture.ts'),
  import('../modules/tool-engine/file-lock.ts'),
]);

const { loadMessages, saveMessages, updateMessage } = dbModule;
const {
  drainConversationPersistence,
  finalizeStreamingOwner,
  isAnyStreaming,
  isStreaming,
  markGenerationBlockingOperation,
  markStreaming,
  unmarkGenerationBlockingOperation,
  unmarkStreaming,
  useConversations,
} = conversationModule;
const { seedConversation, seedConversations, releaseSeededConversations } = fixtureModule;
const { FileLockManager } = fileLockModule;

// Hydrate once, before any fixture seeds: `hydrate()` replaces `byId` wholesale.
await useConversations.getState().hydrate();

/* ------------------------------------------------------------------ */
/*  Admission and ownership                                            */
/* ------------------------------------------------------------------ */

test('the store already permits stream owners in two conversations at once', async () => {
  // Capacity one is enforced in the UI layer, not here: `markStreaming` only
  // fences per conversation. This is why the session manager can be introduced
  // without changing the ownership primitive underneath it.
  const [first, second] = await seedConversations(2, { label: 'admit-two' });
  try {
    const firstOwner = markStreaming(first.id, `${first.id}-assistant`);
    const secondOwner = markStreaming(second.id, `${second.id}-assistant`);

    assert.equal(isStreaming(first.id), true);
    assert.equal(isStreaming(second.id), true);
    assert.notEqual(firstOwner.generationId, secondOwner.generationId);

    unmarkStreaming(first.id, firstOwner.generationId);
    unmarkStreaming(second.id, secondOwner.generationId);
    assert.equal(isAnyStreaming(), false);
  } finally {
    await releaseSeededConversations([first, second]);
  }
});

test('one conversation cannot hold two stream owners', async () => {
  const seeded = await seedConversation({ label: 'admit-same' });
  try {
    const owner = markStreaming(seeded.id, `${seeded.id}-assistant`);
    assert.throws(
      () => markStreaming(seeded.id, `${seeded.id}-assistant-2`),
      /already has an active stream owner/,
    );
    unmarkStreaming(seeded.id, owner.generationId);
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

test('capacity three synchronously rejects a fourth real conversation admission', async () => {
  // Production Sends name their target conversation. Keep this characterization
  // on that path so it exercises capacity accounting rather than the separate
  // app-exclusive operation branch.
  const [first, second, third, fourth] = await seedConversations(4, { label: 'admit-lease' });
  setGenerationCapacityForTests(3);
  try {
    const owners = [first, second, third].map((conversation) => (
      markStreaming(conversation.id, `${conversation.id}-assistant`)
    ));
    assert.throws(
      () => markGenerationBlockingOperation(
        'chat_generation_admission',
        `Send in ${fourth.id}`,
        undefined,
        fourth.id,
      ),
      /All 3 generation slots are in use/,
    );
    for (const owner of owners) unmarkStreaming(owner.conversationId, owner.generationId);

    // With no stream live, the same admission succeeds.
    const lease = markGenerationBlockingOperation(
      'chat_generation_admission',
      `Send in ${fourth.id}`,
      undefined,
      fourth.id,
    );
    assert.equal(unmarkGenerationBlockingOperation(lease.operationId), true);
  } finally {
    resetGenerationSessionsForTests();
    await releaseSeededConversations([first, second, third, fourth]);
  }
});

test('capacity one admits only one of two provisional generation leases', async () => {
  const [first, second] = await seedConversations(2, { label: 'admit-provisional-one' });
  setGenerationCapacityForTests(1);
  let firstLease: ReturnType<typeof markGenerationBlockingOperation> | undefined;
  try {
    firstLease = markGenerationBlockingOperation(
      'chat_generation_admission',
      `Send in ${first.id}`,
      undefined,
      first.id,
    );
    assert.throws(
      () => markGenerationBlockingOperation(
        'chat_generation_admission',
        `Send in ${second.id}`,
        undefined,
        second.id,
      ),
      /All 1 generation slots are in use/,
    );
  } finally {
    if (firstLease) unmarkGenerationBlockingOperation(firstLease.operationId);
    resetGenerationSessionsForTests();
    await releaseSeededConversations([first, second]);
  }
});

test('per-profile limiter defaults open but can serialize a constrained server', async () => {
  const profileId = `limited-${crypto.randomUUID()}`;
  const [first, second] = await seedConversations(2, {
    label: 'profile-limit',
    serverId: profileId,
  });
  setProfileGenerationLimit(profileId, 1);
  try {
    const owner = markStreaming(first.id, `${first.id}-assistant`, undefined, profileId);
    assert.throws(
      () => markGenerationBlockingOperation(
        'chat_generation_admission',
        `Send in ${second.id}`,
        undefined,
        second.id,
        profileId,
      ),
      /profile is limited to 1 concurrent generation/,
    );
    unmarkStreaming(owner.conversationId, owner.generationId);
  } finally {
    setProfileGenerationLimit(profileId, null);
    await releaseSeededConversations([first, second]);
  }
});

test('a stale generation id cannot finalize or release a live owner', async () => {
  const seeded = await seedConversation({ label: 'admit-fence' });
  try {
    const owner = markStreaming(seeded.id, `${seeded.id}-assistant`);
    assert.equal(finalizeStreamingOwner(seeded.id, 'not-the-owner'), false);
    assert.equal(unmarkStreaming(seeded.id, 'not-the-owner'), false);
    assert.equal(isStreaming(seeded.id), true);
    unmarkStreaming(seeded.id, owner.generationId);
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

/* ------------------------------------------------------------------ */
/*  Cross-conversation persistence suppression                         */
/* ------------------------------------------------------------------ */

test('one conversation streaming no longer suppresses another conversation\'s writes', async () => {
  // Phase 0 asserted the opposite. `appendMessage` skipped Dexie whenever
  // *any* conversation was streaming, which was indistinguishable from correct
  // while only one chat was reachable and became silent data loss the moment
  // navigation was unblocked. The gate is now scoped to the target.
  const [streaming, idle] = await seedConversations(2, { label: 'suppress' });
  try {
    const owner = markStreaming(streaming.id, `${streaming.id}-assistant`);

    const appended = useConversations.getState().appendMessage(idle.id, {
      role: 'user',
      content: 'written while an unrelated conversation streams',
    });
    assert.ok(appended);
    await drainConversationPersistence(idle.id);

    const durable = await loadMessages(idle.id);
    assert.equal(
      durable.some((message) => message.id === appended.id),
      true,
      'the unrelated conversation persists normally',
    );

    unmarkStreaming(streaming.id, owner.generationId);
  } finally {
    await releaseSeededConversations([streaming, idle]);
  }
});

test('a conversation that owns the stream still defers to its own terminal path', async () => {
  // The scoped gate must not become a blanket allow: an in-flight transcript
  // is written by the checkpoint and terminal barrier, which own its ordering.
  const seeded = await seedConversation({ label: 'self-suppress' });
  try {
    const owner = markStreaming(seeded.id, `${seeded.id}-assistant`);

    const appended = useConversations.getState().appendMessage(seeded.id, {
      role: 'user',
      content: 'appended mid-stream',
    });
    assert.ok(appended);
    await drainConversationPersistence(seeded.id);

    const durable = await loadMessages(seeded.id);
    assert.equal(
      durable.some((message) => message.id === appended.id),
      false,
      'its own stream still routes through the terminal flush',
    );

    unmarkStreaming(seeded.id, owner.generationId);
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

/* ------------------------------------------------------------------ */
/*  Checkpoint versus terminal ordering                                */
/* ------------------------------------------------------------------ */

test('the raw db primitives impose no ordering between a checkpoint and a finalize', async () => {
  // `updateMessage` and `saveMessages` are independent durable writes: neither
  // knows about the other, so a checkpoint captured before finalization
  // restores pre-terminal content if it lands afterwards. That is still true
  // of the primitives, and is exactly why the store no longer calls them
  // directly. Ordering now comes from the per-conversation lane — see
  // `conversation-persistence-lane.test.ts` for the store-level guarantee.
  const assistant: Message = {
    id: 'checkpoint-order-assistant',
    role: 'assistant',
    content: 'partial',
    createdAt: 2,
    sortOrder: 2,
  };
  const seeded = await seedConversation({
    label: 'checkpoint-order',
    messages: [
      { id: 'checkpoint-order-user', role: 'user', content: 'go', createdAt: 1, sortOrder: 1 },
      assistant,
    ],
  });
  try {
    // A checkpoint captures the in-flight snapshot...
    const checkpointSnapshot = [{ ...assistant }];

    // ...the generation then finalizes...
    await updateMessage(assistant.id, {
      content: 'complete answer',
      meta: { finish_reason: 'stop' },
    });

    // ...and the older checkpoint finally reaches Dexie.
    await saveMessages(checkpointSnapshot, seeded.id);

    const durable = await loadMessages(seeded.id);
    const stored = durable.find((message) => message.id === assistant.id);
    assert.equal(
      stored?.content,
      'partial',
      'unordered primitives: the stale checkpoint wins',
    );
    assert.equal(stored?.meta?.finish_reason, undefined);
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

/* ------------------------------------------------------------------ */
/*  Interrupted plain-text responses                                   */
/* ------------------------------------------------------------------ */

test('without a journal row an interrupted answer is indistinguishable from a finished one', async () => {
  // `Message.streaming` is deliberately not persisted, and unanswered-tool
  // recovery only covers tool calls, so the durable graph on its own says
  // nothing about whether a plain-text answer finished. Phase 1 did not change
  // that — it added the evidence that makes the difference recoverable. This
  // test keeps the underlying gap visible; `generation-journal.test.ts` covers
  // the same conversation once a journal row exists for it.
  const seeded = await seedConversation({
    label: 'interrupted-text',
    messages: [
      { id: 'interrupted-text-user', role: 'user', content: 'explain', createdAt: 1, sortOrder: 1 },
      {
        id: 'interrupted-text-assistant',
        role: 'assistant',
        content: 'partial answer cut off mid-',
        createdAt: 2,
        sortOrder: 2,
        streaming: true,
      },
    ],
    resident: false,
  });
  try {
    const reloaded = await useConversations.getState().loadConversationMessages(seeded.id);
    const assistant = reloaded.find((message) => message.role === 'assistant');

    assert.ok(assistant, 'the truncated row survives the crash');
    assert.equal(assistant.streaming, undefined, 'the streaming marker is not durable');
    assert.equal(
      assistant.meta?.finish_reason,
      undefined,
      'no journal row means nothing marks the answer as interrupted',
    );
  } finally {
    await releaseSeededConversations([seeded]);
  }
});

/* ------------------------------------------------------------------ */
/*  Cooperative mutation locking                                       */
/* ------------------------------------------------------------------ */

test('separate FileLockManager instances share no lock domain', async () => {
  // Why the orchestrator no longer builds one per tool round. Two managers are
  // two domains, so two generations writing one file would contend only at the
  // native OS lock — which blocks and cannot be aborted. Phase 1 moved the
  // orchestrator onto `applicationFileLocks`; this documents what that avoids.
  const roundOne = new FileLockManager();
  const roundTwo = new FileLockManager();
  const target = 'C:/workspace/shared.txt';

  const releaseFirst = await roundOne.acquire([target]);
  let secondAcquired = false;
  const secondPending = roundTwo.acquire([target]).then((release) => {
    secondAcquired = true;
    return release;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(secondAcquired, true, 'independent managers do not serialize');

  releaseFirst();
  (await secondPending)();
});

test('one FileLockManager does serialize the same canonical target', async () => {
  // The primitive itself is correct; only its scope is wrong. Promoting it
  // must not change this behavior.
  const shared = new FileLockManager();
  const target = 'C:/workspace/shared.txt';

  const releaseFirst = await shared.acquire([target]);
  let secondAcquired = false;
  const secondPending = shared.acquire([target]).then((release) => {
    secondAcquired = true;
    return release;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(secondAcquired, false, 'the second caller waits');

  releaseFirst();
  (await secondPending)();
  assert.equal(secondAcquired, true);
});

/* ------------------------------------------------------------------ */
/*  Tool execution identity                                            */
/* ------------------------------------------------------------------ */

test('ToolExecutionIdentity carries both conversation and generation scope', () => {
  // Phase 1 closed the gap §13.3 named: prompt fencing, dedupe keys, image
  // cleanup, and audit records all key on a generation, not just a
  // conversation. The Phase 0 version of this test asserted the four-field
  // shape that made those impossible.
  const identity: ToolExecutionIdentity = {
    groupId: 'group',
    operationId: 'operation',
    modelToolCallId: 'call_abc',
    conversationId: 'conversation',
    generationId: 'generation',
  };

  assert.deepEqual(
    Object.keys(identity).sort(),
    ['conversationId', 'generationId', 'groupId', 'modelToolCallId', 'operationId'],
  );
});
