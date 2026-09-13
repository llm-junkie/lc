/**
 * Phase 2 — residency and navigation during a run.
 *
 * Before this phase, `setActive` refused while any conversation streamed and
 * cleared every non-selected transcript from memory. Both had to change
 * together: a background generation reads and mutates its transcript through
 * the store by conversation ID, so allowing navigation without a residency
 * policy would strand its tool loop mid-turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import type { Message } from '../types.ts';

const [conversationModule, fixtureModule, sessionManagerModule] = await Promise.all([
  import('./conversations.ts'),
  import('./multi-conversation-fixture.ts'),
  import('../modules/chat-pipeline/generation-session-manager.ts'),
]);

const {
  canEvictConversationMessages,
  commitChatGenerationAdmission,
  drainConversationPersistence,
  generationAdmissionBlockReason,
  getStreamingOwner,
  handoffGenerationBlockingOperationToStreaming,
  isConversationStructurallyLocked,
  markGenerationBlockingOperation,
  markStreaming,
  residentConversationIds,
  unmarkStreaming,
  unmarkGenerationBlockingOperation,
  useConversations,
} = conversationModule;
const { seedConversation, seedConversations, releaseSeededConversations } = fixtureModule;
const { setGenerationCapacityForTests } = sessionManagerModule;

await useConversations.getState().hydrate();

function messagesOf(id: string): Message[] {
  return useConversations.getState().byId[id]?.messages ?? [];
}

test('switching away from a generating conversation keeps its transcript resident', async () => {
  const [running, other] = await seedConversations(2, { label: 'residency-run' });
  try {
    useConversations.setState({ activeId: running.id });
    const owner = markStreaming(running.id, `${running.id}-assistant`);

    useConversations.getState().setActive(other.id);

    assert.equal(useConversations.getState().activeId, other.id, 'navigation is permitted');
    assert.ok(
      messagesOf(running.id).length > 0,
      'the running conversation keeps the transcript its generation is writing',
    );

    unmarkStreaming(running.id, owner.generationId);
    await drainConversationPersistence(running.id);
  } finally {
    await releaseSeededConversations([running, other]);
  }
});

test('an idle complete transcript is still evicted on switch', async () => {
  // The blanket clear existed for a real reason — tool-heavy transcripts hold
  // megabytes of strings. Scoping it must not turn into never releasing them.
  const [idle, other] = await seedConversations(2, { label: 'residency-evict' });
  try {
    useConversations.setState({ activeId: idle.id });
    assert.ok(messagesOf(idle.id).length > 0);

    useConversations.getState().setActive(other.id);

    assert.deepEqual(messagesOf(idle.id), [], 'nothing references it, so it is released');
  } finally {
    await releaseSeededConversations([idle, other]);
  }
});

test('an incomplete transcript is pinned even when nothing else references it', async () => {
  // A failed or partial load leaves fewer messages than messageCount. Evicting
  // it would let a later replacement write treat the fragment as authoritative.
  const seeded = await seedConversation({ label: 'residency-partial' });
  const other = await seedConversation({ label: 'residency-partial-other' });
  try {
    useConversations.setState((state) => ({
      activeId: seeded.id,
      byId: {
        ...state.byId,
        [seeded.id]: { ...state.byId[seeded.id]!, messageCount: 5 },
      },
    }));

    useConversations.getState().setActive(other.id);

    assert.ok(
      messagesOf(seeded.id).length > 0,
      'an incomplete history stays in memory rather than becoming authoritative',
    );
  } finally {
    await releaseSeededConversations([seeded, other]);
  }
});

test('rapid A to B to A while B is still loading replaces neither transcript', async () => {
  const [first, second] = await seedConversations(2, { label: 'residency-race' });
  try {
    useConversations.setState({ activeId: first.id });
    const store = useConversations.getState();

    // B has never been loaded, so selecting it starts a lazy load.
    useConversations.setState((state) => ({
      byId: { ...state.byId, [second.id]: { ...state.byId[second.id]!, messages: [] } },
    }));

    store.setActive(second.id);
    store.setActive(first.id);
    await drainConversationPersistence(second.id);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(useConversations.getState().activeId, first.id);
    assert.deepEqual(
      messagesOf(first.id).map((message) => message.id),
      first.messages.map((message) => message.id),
      'A keeps its own transcript',
    );
    const secondMessages = messagesOf(second.id);
    if (secondMessages.length > 0) {
      assert.deepEqual(
        secondMessages.map((message) => message.id),
        second.messages.map((message) => message.id),
        'B resolved to its own rows, never A\'s',
      );
    }
  } finally {
    await releaseSeededConversations([first, second]);
  }
});

test('the resident set names every conversation with transcript work in flight', async () => {
  const [running, selected, idle] = await seedConversations(3, { label: 'residency-set' });
  try {
    const owner = markStreaming(running.id, `${running.id}-assistant`);

    const resident = residentConversationIds(selected.id);
    assert.equal(resident.has(running.id), true, 'the generation owner');
    assert.equal(resident.has(selected.id), true, 'the selected conversation');
    assert.equal(resident.has(idle.id), false, 'nothing else');

    assert.equal(
      canEvictConversationMessages(useConversations.getState().byId[running.id]!, resident),
      false,
    );
    assert.equal(
      canEvictConversationMessages(useConversations.getState().byId[idle.id]!, resident),
      true,
    );

    unmarkStreaming(running.id, owner.generationId);
    await drainConversationPersistence(running.id);
  } finally {
    await releaseSeededConversations([running, selected, idle]);
  }
});

test('structural locks follow the target, not the application', async () => {
  const [running, other] = await seedConversations(2, { label: 'residency-lock' });
  try {
    const owner = markStreaming(running.id, `${running.id}-assistant`);

    assert.equal(isConversationStructurallyLocked(running.id), true);
    assert.equal(isConversationStructurallyLocked(other.id), false);

    unmarkStreaming(running.id, owner.generationId);
    await drainConversationPersistence(running.id);

    assert.equal(isConversationStructurallyLocked(running.id), false);
  } finally {
    await releaseSeededConversations([running, other]);
  }
});

test('creating a chat does not erase a running conversation transcript', async () => {
  // `create` was permitted during a generation but kept a blanket "clear every
  // other conversation" loop, so starting a new chat wiped the transcript the
  // running generation was still writing to.
  const running = await seedConversation({ label: 'create-evicts' });
  try {
    useConversations.setState({ activeId: running.id });
    const owner = markStreaming(running.id, `${running.id}-assistant`);

    const created = useConversations.getState().create({ title: 'new while busy' });

    assert.ok(created, 'a new chat can still be started at capacity');
    assert.ok(
      messagesOf(running.id).length > 0,
      'the running transcript survives the new chat',
    );

    unmarkStreaming(running.id, owner.generationId);
    await drainConversationPersistence(running.id);
    useConversations.getState().remove(created.id);
    await drainConversationPersistence(created.id);
  } finally {
    await releaseSeededConversations([running]);
  }
});

test('branch replacement is scoped to its conversation', async () => {
  const [running, edited] = await seedConversations(2, { label: 'replace-during-run' });
  try {
    const owner = markStreaming(running.id, `${running.id}-assistant`);
    const source = edited.messages.find((message) => message.role === 'user');
    assert.ok(source);

    assert.equal(
      await useConversations.getState().replaceFromMessage(
        edited.id,
        source.id,
        { content: 'replacement while another chat runs' },
      ),
      true,
    );
    assert.equal(messagesOf(edited.id)[0]?.content, 'replacement while another chat runs');

    unmarkStreaming(running.id, owner.generationId);
    await drainConversationPersistence(running.id);
  } finally {
    await releaseSeededConversations([running, edited]);
  }
});

test('cloning an idle conversation is allowed while another one generates', async () => {
  // The store guard was target-scoped but the lease underneath still refused
  // on `isAnyStreaming()`, so the clone passed the guard and then threw.
  const [running, source] = await seedConversations(2, { label: 'clone-during-run' });
  try {
    useConversations.setState({ activeId: running.id });
    const owner = markStreaming(running.id, `${running.id}-assistant`);

    const cloned = await useConversations.getState().clone(source.id);

    assert.ok(cloned, 'an idle source clones during an unrelated run');
    assert.ok(
      messagesOf(running.id).length > 0,
      'and the clone does not evict the running transcript',
    );

    unmarkStreaming(running.id, owner.generationId);
    await drainConversationPersistence(running.id);
    useConversations.getState().remove(cloned.id);
    await drainConversationPersistence(cloned.id);
  } finally {
    await releaseSeededConversations([running, source]);
  }
});

test('cloning the generating conversation is still refused', async () => {
  const running = await seedConversation({ label: 'clone-locked' });
  try {
    const owner = markStreaming(running.id, `${running.id}-assistant`);

    assert.equal(await useConversations.getState().clone(running.id), undefined);

    unmarkStreaming(running.id, owner.generationId);
    await drainConversationPersistence(running.id);
  } finally {
    await releaseSeededConversations([running]);
  }
});

test('an unrelated generation admission can coexist with a scoped data operation', () => {
  const clone = markGenerationBlockingOperation(
    'conversation_clone',
    'Clone conversation b',
    undefined,
    'b',
  );
  let admission: ReturnType<typeof markGenerationBlockingOperation> | undefined;
  try {
    admission = markGenerationBlockingOperation(
      'chat_generation_admission',
      'Send in c',
      undefined,
      'c',
    );
    assert.equal(isConversationStructurallyLocked('b'), true);
    assert.equal(isConversationStructurallyLocked('c'), true);
    assert.equal(isConversationStructurallyLocked('d'), false);
  } finally {
    if (admission) unmarkGenerationBlockingOperation(admission.operationId);
    unmarkGenerationBlockingOperation(clone.operationId);
  }
});

test('scoped provisional admissions enforce capacity without an off-by-one', () => {
  setGenerationCapacityForTests(2);
  const firstId = `capacity-first-${crypto.randomUUID()}`;
  const secondId = `capacity-second-${crypto.randomUUID()}`;
  const thirdId = `capacity-third-${crypto.randomUUID()}`;
  const admissions: Array<ReturnType<typeof markGenerationBlockingOperation>> = [];
  try {
    admissions.push(markGenerationBlockingOperation(
      'chat_generation_admission',
      'First scoped admission',
      undefined,
      firstId,
    ));
    admissions.push(markGenerationBlockingOperation(
      'chat_generation_admission',
      'Second scoped admission',
      undefined,
      secondId,
    ));
    assert.equal(
      generationAdmissionBlockReason(thirdId),
      'All 2 generation slots are in use.',
    );
    assert.throws(
      () => markGenerationBlockingOperation(
        'chat_generation_admission',
        'Third scoped admission',
        undefined,
        thirdId,
      ),
      /All 2 generation slots are in use/,
    );
  } finally {
    for (const admission of admissions) {
      unmarkGenerationBlockingOperation(admission.operationId);
    }
    setGenerationCapacityForTests(1);
  }
});

test('one stream plus one provisional admission fills capacity two exactly', () => {
  setGenerationCapacityForTests(2);
  const streamingId = `capacity-stream-${crypto.randomUUID()}`;
  const admittedId = `capacity-admitted-${crypto.randomUUID()}`;
  const refusedId = `capacity-refused-${crypto.randomUUID()}`;
  let stream: ReturnType<typeof markStreaming> | undefined;
  let admission: ReturnType<typeof markGenerationBlockingOperation> | undefined;
  try {
    stream = markStreaming(streamingId, `${streamingId}-assistant`);
    admission = markGenerationBlockingOperation(
      'chat_generation_admission',
      'Admission beside one stream',
      undefined,
      admittedId,
    );
    assert.throws(
      () => markGenerationBlockingOperation(
        'chat_generation_admission',
        'Admission beyond mixed capacity',
        undefined,
        refusedId,
      ),
      /All 2 generation slots are in use/,
    );
  } finally {
    if (admission) unmarkGenerationBlockingOperation(admission.operationId);
    if (stream) unmarkStreaming(stream.conversationId, stream.generationId);
    setGenerationCapacityForTests(1);
  }
});

test('capacity reduction preserves provisional admission order at commit', () => {
  setGenerationCapacityForTests(3);
  const firstId = `commit-order-first-${crypto.randomUUID()}`;
  const secondId = `commit-order-second-${crypto.randomUUID()}`;
  const first = markGenerationBlockingOperation(
    'chat_generation_admission',
    'First pending preflight',
    undefined,
    firstId,
  );
  const second = markGenerationBlockingOperation(
    'chat_generation_admission',
    'Second pending preflight',
    undefined,
    secondId,
  );

  try {
    setGenerationCapacityForTests(1);
    assert.throws(
      () => commitChatGenerationAdmission(second.operationId, secondId),
      /All 1 generation slots are in use/,
    );
    assert.equal(unmarkGenerationBlockingOperation(second.operationId), false);
    assert.equal(
      commitChatGenerationAdmission(first.operationId, firstId).admissionState,
      'committed',
    );
  } finally {
    unmarkGenerationBlockingOperation(first.operationId);
    unmarkGenerationBlockingOperation(second.operationId);
    setGenerationCapacityForTests(1);
  }
});

test('admission handoff synchronously replaces the exact owner with a stream owner', () => {
  setGenerationCapacityForTests(2);
  const conversationId = `capacity-handoff-${crypto.randomUUID()}`;
  let admission: ReturnType<typeof markGenerationBlockingOperation> | undefined;
  let owner: ReturnType<typeof handoffGenerationBlockingOperationToStreaming> | undefined;
  try {
    admission = markGenerationBlockingOperation(
      'chat_generation_admission',
      'Admission to hand off',
      undefined,
      conversationId,
    );
    assert.throws(
      () => handoffGenerationBlockingOperationToStreaming(
        admission!.operationId,
        conversationId,
        `${conversationId}-assistant`,
        `${conversationId}-generation`,
      ),
      /has not reached its commit boundary/,
    );
    commitChatGenerationAdmission(admission.operationId, conversationId);
    owner = handoffGenerationBlockingOperationToStreaming(
      admission.operationId,
      conversationId,
      `${conversationId}-assistant`,
      `${conversationId}-generation`,
    );
    assert.deepEqual(getStreamingOwner(conversationId), owner);
    assert.throws(
      () => markGenerationBlockingOperation(
        'chat_generation_admission',
        'Same-target admission after handoff',
        undefined,
        conversationId,
      ),
      /finish before changing response configuration/,
    );
  } finally {
    if (owner) unmarkStreaming(owner.conversationId, owner.generationId);
    else if (admission) unmarkGenerationBlockingOperation(admission.operationId);
    setGenerationCapacityForTests(1);
  }
});

test('Whiteboard initialization is scoped to its target conversation', () => {
  const stream = markStreaming('running-a', 'assistant-a');
  let initialization: ReturnType<typeof markGenerationBlockingOperation> | undefined;
  try {
    initialization = markGenerationBlockingOperation(
      'whiteboard_initialization',
      'Initialize Whiteboard in idle-b',
      undefined,
      'idle-b',
    );
    assert.throws(
      () => markGenerationBlockingOperation(
        'whiteboard_initialization',
        'Initialize Whiteboard in running-a',
        undefined,
        'running-a',
      ),
      /finish before changing response configuration/,
    );
  } finally {
    if (initialization) unmarkGenerationBlockingOperation(initialization.operationId);
    unmarkStreaming(stream.conversationId, stream.generationId);
  }
});
