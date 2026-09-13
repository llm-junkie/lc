import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import type { Conversation, Message } from '../types.ts';

const [typesModule, dbModule, conversationModule, idbModule, whiteboardModule] = await Promise.all([
  import('../types.ts'),
  import('./db.ts'),
  import('./conversations.ts'),
  import('../utils/idb.ts'),
  import('./whiteboard.ts'),
]);
const { DEFAULT_PARAMS } = typesModule;
const {
  deleteConversation,
  loadAllMeta,
  loadGenerationRun,
  loadMessages,
  recordGenerationRun,
  saveMessages,
  saveMeta,
} = dbModule;
const {
  repairUnansweredToolCalls,
  setConversationHydrationPersistenceForTests,
  useConversations,
} = conversationModule;
const { loadAttachment, putAttachment } = idbModule;
const { readWhiteboardStorageRowsForTests, savePendingUserWhiteboard } = whiteboardModule;

test('clearAll joins an already-started hydration before wiping its captured corpus', async () => {
  const conversationId = `prehydrate-wipe-${crypto.randomUUID()}`;
  const attachmentId = `prehydrate-attachment-${crypto.randomUUID()}`;
  const message: Message = {
    id: `${conversationId}-message`,
    role: 'user',
    content: 'durable before hydrate',
    createdAt: 1,
    attachments: [{
      id: attachmentId,
      name: 'prehydrate.txt',
      mime: 'text/plain',
      isImage: false,
      size: 1,
      stored: 'idb',
    }],
  };
  await saveMeta({
    id: conversationId,
    title: 'prehydrate wipe',
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    messages: [],
  });
  await saveMessages([message], conversationId);
  await recordGenerationRun({
    conversationId,
    generationId: 'prehydrate-generation',
    assistantMessageId: message.id,
    state: 'running',
    startedAt: 1,
  });
  await savePendingUserWhiteboard(conversationId, '# prehydrate working row');
  await putAttachment(attachmentId, new Blob(['x']), {
    mime: 'text/plain',
    name: 'prehydrate.txt',
    size: 1,
  });

  let releaseHydration!: () => void;
  const hydrationGate = new Promise<void>((resolve) => { releaseHydration = resolve; });
  let metadataCaptured!: () => void;
  const captured = new Promise<void>((resolve) => { metadataCaptured = resolve; });
  setConversationHydrationPersistenceForTests({
    loadMetadata: async () => {
      const rows = await loadAllMeta();
      metadataCaptured();
      await hydrationGate;
      return rows;
    },
  });

  const clearing = useConversations.getState().clearAll();
  await captured;
  let cleared = false;
  void clearing.then(() => { cleared = true; });
  await Promise.resolve();
  assert.equal(cleared, false, 'the wipe waits for hydration admitted before its corpus lease');
  releaseHydration();
  assert.equal(await clearing, true);
  setConversationHydrationPersistenceForTests();

  assert.equal((await loadAllMeta()).some((row) => row.id === conversationId), false);
  assert.deepEqual(await loadMessages(conversationId), []);
  assert.equal(await loadGenerationRun(conversationId), undefined);
  const whiteboardRows = await readWhiteboardStorageRowsForTests(conversationId);
  assert.equal(whiteboardRows.versions.length, 0);
  assert.equal(whiteboardRows.working.length, 0);
  assert.equal(await loadAttachment(attachmentId), null);
});

test('hard-reload repairs a partially checkpointed tool round durably and idempotently', async () => {
  const conversationId = `crash-recovery-${crypto.randomUUID()}`;
  const persisted: Message[] = [
    { id: `${conversationId}-user`, role: 'user', content: 'mutate and inspect', createdAt: 1, sortOrder: 1 },
    {
      id: `${conversationId}-assistant`,
      role: 'assistant',
      content: '',
      createdAt: 2,
      sortOrder: 2,
      tool_calls: [
        { created_at: 0, id: `${conversationId}-complete`, name: 'lc_read_file', arguments: '{}' },
        { created_at: 0, id: `${conversationId}-unknown`, name: 'lc_write_file', arguments: '{}' },
      ],
      meta: { finish_reason: 'tool_calls' },
    },
    {
      id: `${conversationId}-result`,
      role: 'tool',
      content: 'completed read',
      createdAt: 3,
      sortOrder: 3,
      tool_call_id: `${conversationId}-complete`,
    },
  ];
  const metadata: Conversation = {
    id: conversationId,
    title: 'crash recovery',
    model: 'test-model',
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 3,
    messageCount: persisted.length,
    messages: [],
  };

  await saveMeta(metadata);
  await saveMessages(persisted, conversationId);
  useConversations.setState((state) => ({
    byId: { ...state.byId, [conversationId]: metadata },
    order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
  }));
  useConversations.getState().setActive(conversationId);

  try {
    const firstReload = await useConversations.getState().loadConversationMessages(conversationId);
    const recovered = firstReload.find((message) => message.tool_call_id === `${conversationId}-unknown`);
    assert.equal(firstReload.length, 4);
    assert.equal(recovered?.tool_is_error, true);
    assert.match(recovered?.content ?? '', /side effects are unknown/i);

    const durableAfterRepair = await loadMessages(conversationId);
    assert.equal(durableAfterRepair.length, 4);
    assert.equal(
      durableAfterRepair.filter((message) => message.tool_call_id === `${conversationId}-unknown`).length,
      1,
    );

    // Simulate a fresh renderer loading the repaired durable rows again.
    const current = useConversations.getState().byId[conversationId]!;
    useConversations.setState({
      byId: { ...useConversations.getState().byId, [conversationId]: { ...current, messages: [], messageCount: 4 } },
    });
    const secondReload = await useConversations.getState().loadConversationMessages(conversationId);
    assert.equal(secondReload.length, 4);
    assert.equal(
      secondReload.filter((message) => message.tool_call_id === `${conversationId}-unknown`).length,
      1,
    );
  } finally {
    await deleteConversation(conversationId);
    useConversations.setState((state) => {
      const { [conversationId]: _removed, ...byId } = state.byId;
      return {
        byId,
        order: state.order.filter((id) => id !== conversationId),
        activeId: state.activeId === conversationId ? null : state.activeId,
      };
    });
  }
});

test('stop repair rows survive a real IndexedDB save/reload with reused call ids', async () => {
  const conversationId = `repair-durable-${crypto.randomUUID()}`;
  const persisted: Message[] = [
    { id: 'round-1-assistant', role: 'assistant', content: '', createdAt: 1, sortOrder: 1, tool_calls: [
      { created_at: 0, id: 'reuse-id', name: 'lc_get_current_time', arguments: '{}' },
    ] },
    { id: 'round-2-assistant', role: 'assistant', content: '', createdAt: 2, sortOrder: 2, tool_calls: [
      { created_at: 0, id: 'reuse-id', name: 'lc_get_current_time', arguments: '{}' },
    ] },
  ];
  const metadata: Conversation = {
    id: conversationId,
    title: 'repair durable',
    model: 'test-model',
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 2,
    messageCount: persisted.length,
    messages: [],
  };
  await saveMeta(metadata);
  await saveMessages(persisted, conversationId);
  const prior = useConversations.getState();
  useConversations.setState((state) => ({
    byId: { ...state.byId, [conversationId]: { ...metadata, messages: persisted } },
    activeId: conversationId,
  }));

  try {
    assert.equal(repairUnansweredToolCalls(conversationId, ['reuse-id'], 'round-1-assistant', 'aborted'), 1);
    assert.equal(repairUnansweredToolCalls(conversationId, ['reuse-id'], 'round-2-assistant', 'aborted'), 1);
    // Let the fire-and-forget durable write settle, then reload from Dexie.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const durable = await loadMessages(conversationId);
    const repairRows = durable.filter((m) => m.role === 'tool');
    assert.equal(repairRows.length, 2, 'both rounds keep their own repair row');
    assert.equal(new Set(repairRows.map((m) => m.id)).size, 2, 'owner-scoped ids never collide');
    assert.ok(repairRows.some((m) => m.id === `repair:${conversationId}:round-1-assistant:reuse-id`));
    assert.ok(repairRows.some((m) => m.id === `repair:${conversationId}:round-2-assistant:reuse-id`));
    const orders = durable.map((message) => {
      if (message.sortOrder === undefined) {
        throw new Error(`durable message ${message.id} is missing sortOrder`);
      }
      return message.sortOrder;
    }).sort((a, b) => a - b);
    assert.deepEqual(orders, [1, 2, 3, 4], 'durable sortOrder stays strictly sequential');
  } finally {
    await deleteConversation(conversationId);
    useConversations.setState({
      byId: prior.byId,
      order: prior.order,
      activeId: prior.activeId,
    });
  }
});

test('popLast drops the exact durable row the in-memory history dropped', async () => {
  const conversationId = `pop-${crypto.randomUUID()}`;
  const persisted: Message[] = [
    { id: 'mmm-1', role: 'user', content: 'one', createdAt: 1, sortOrder: 1 },
    { id: 'mmm-2', role: 'assistant', content: 'two', createdAt: 2, sortOrder: 2 },
    { id: 'aaa-last', role: 'assistant', content: 'three', createdAt: 3, sortOrder: 3 },
  ];
  const metadata: Conversation = {
    id: conversationId,
    title: 'pop last',
    model: 'test-model',
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 3,
    messageCount: persisted.length,
    messages: [],
  };

  await useConversations.getState().hydrate();
  await saveMeta(metadata);
  await saveMessages(persisted, conversationId);
  useConversations.setState((state) => ({
    byId: { ...state.byId, [conversationId]: { ...metadata, messages: persisted } },
    activeId: conversationId,
  }));

  try {
    useConversations.getState().popLast(conversationId);
    // The durable delete is fire-and-forget and runs inside its own Dexie
    // transaction (read + ownership check + delete); let it settle before
    // asserting the durable state, exactly like the no-drop test below.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const durable = await loadMessages(conversationId);
    assert.deepEqual(durable.map((message) => message.id), ['mmm-1', 'mmm-2']);
    assert.deepEqual(
      useConversations.getState().byId[conversationId].messages.map((message) => message.id),
      ['mmm-1', 'mmm-2'],
    );
  } finally {
    await deleteConversation(conversationId);
    useConversations.setState((state) => {
      const { [conversationId]: _removed, ...byId } = state.byId;
      return {
        byId,
        order: state.order.filter((id) => id !== conversationId),
        activeId: state.activeId === conversationId ? null : state.activeId,
      };
    });
  }
});

test('removing a conversation deletes its blob attachments even when messages are not resident', async () => {
  const conversationId = `remove-blobs-${crypto.randomUUID()}`;
  const attachmentId = `blob-remove-${crypto.randomUUID()}`;
  const persisted: Message[] = [{
    id: 'blob-remove-user',
    role: 'user',
    content: 'with attachment',
    createdAt: 1,
    sortOrder: 1,
    attachments: [{
      id: attachmentId,
      name: 'notes.txt',
      mime: 'text/plain',
      isImage: false,
      size: 5,
      stored: 'idb',
    }],
  }];
  const metadata: Conversation = {
    id: conversationId,
    title: 'blob removal',
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 2,
    messageCount: persisted.length,
    messages: [],
  };

  await putAttachment(attachmentId, new Blob(['hello']), {
    mime: 'text/plain',
    name: 'notes.txt',
    size: 5,
  });
  await saveMeta(metadata);
  await saveMessages(persisted, conversationId);
  await useConversations.getState().hydrate();
  const prior = useConversations.getState();
  useConversations.setState((state) => ({
    byId: { ...state.byId, [conversationId]: metadata },
    activeId: null,
  }));

  try {
    useConversations.getState().remove(conversationId);
    // Blob deletion runs behind the Dexie read + conversation delete.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(await loadAttachment(attachmentId), null);
    assert.equal((await loadMessages(conversationId)).length, 0);
  } finally {
    useConversations.setState({
      byId: prior.byId,
      order: prior.order,
      activeId: prior.activeId,
    });
  }
});

test('popLast with no messages in memory deletes nothing durably', async () => {
  // The lazy-load-normal state: metadata resident, message rows in Dexie,
  // live array empty. Popping nothing must delete nothing — the previous
  // call shape fell through to `.last()` and deleted an arbitrary row
  // while memory dropped nothing.
  const conversationId = `pop-empty-${crypto.randomUUID()}`;
  const persisted: Message[] = [
    { id: 'kept-row', role: 'user', content: 'one', createdAt: 1, sortOrder: 1 },
  ];
  const metadata: Conversation = {
    id: conversationId,
    title: 'pop empty',
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 2,
    messageCount: persisted.length,
    messages: [],
  };

  await saveMeta(metadata);
  await saveMessages(persisted, conversationId);
  await useConversations.getState().hydrate();
  const prior = useConversations.getState();
  useConversations.setState((state) => ({
    byId: { ...state.byId, [conversationId]: metadata },
    activeId: null,
  }));

  try {
    useConversations.getState().popLast(conversationId);
    // Settle the fire-and-forget durable path.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const durable = await loadMessages(conversationId);
    assert.deepEqual(durable.map((message) => message.id), ['kept-row']);
  } finally {
    await deleteConversation(conversationId);
    useConversations.setState({
      byId: prior.byId,
      order: prior.order,
      activeId: prior.activeId,
    });
  }
});

test('clearAll deletes every blob attachment even when no messages are resident', async () => {
  const attachmentA = `blob-clear-a-${crypto.randomUUID()}`;
  const attachmentB = `blob-clear-b-${crypto.randomUUID()}`;
  const conversationA = `clear-blobs-a-${crypto.randomUUID()}`;
  const conversationB = `clear-blobs-b-${crypto.randomUUID()}`;
  const seeds: Array<[string, string]> = [
    [attachmentA, conversationA],
    [attachmentB, conversationB],
  ];
  for (const [attachmentId, conversationId] of seeds) {
    await putAttachment(attachmentId, new Blob(['x']), {
      mime: 'text/plain',
      name: `${attachmentId}.txt`,
      size: 1,
    });
    await saveMeta({
      id: conversationId,
      title: conversationId,
      params: { ...DEFAULT_PARAMS },
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      messages: [],
    });
    await saveMessages([{
      id: `${conversationId}-m`,
      role: 'user',
      content: 'x',
      createdAt: 1,
      sortOrder: 1,
      attachments: [{
        id: attachmentId,
        name: `${attachmentId}.txt`,
        mime: 'text/plain',
        isImage: false,
        size: 1,
        stored: 'idb',
      }],
    }], conversationId);
  }
  await useConversations.getState().hydrate();
  useConversations.setState((state) => {
    const byId = { ...state.byId };
    for (const [, conversationId] of seeds) {
      byId[conversationId] = {
        id: conversationId,
        title: conversationId,
        params: { ...DEFAULT_PARAMS },
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        messages: [],
      };
    }
    return { byId };
  });
  const prior = useConversations.getState();

  try {
    assert.equal(await useConversations.getState().clearAll(), true);
    for (const [attachmentId] of seeds) {
      assert.equal(await loadAttachment(attachmentId), null, attachmentId);
    }
    assert.deepEqual(useConversations.getState().byId, {});
  } finally {
    useConversations.setState({
      byId: prior.byId,
      order: prior.order,
      activeId: prior.activeId,
    });
  }
});

test('clearAll also reclaims orphaned blobs no conversation references', async () => {
  // A blob whose conversation was already deleted (or whose rows were lost)
  // cannot be reached by id collection — only a whole-store clear can
  // reclaim it, and the wipe promise says cached attachments go.
  const conversationId = `orphan-owner-${crypto.randomUUID()}`;
  const attachmentId = `blob-orphan-${crypto.randomUUID()}`;

  await putAttachment(attachmentId, new Blob(['x']), {
    mime: 'text/plain',
    name: `${attachmentId}.txt`,
    size: 1,
  });
  await saveMeta({
    id: conversationId,
    title: conversationId,
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    messages: [],
  });
  await useConversations.getState().hydrate();
  const prior = useConversations.getState();
  useConversations.setState((state) => {
    const byId = { ...state.byId };
    byId[conversationId] = {
      id: conversationId,
      title: conversationId,
      params: { ...DEFAULT_PARAMS },
      createdAt: 1,
      updatedAt: 2,
      messageCount: 0,
      messages: [],
    };
    return { byId };
  });

  try {
    assert.equal(await useConversations.getState().clearAll(), true);
    assert.equal(await loadAttachment(attachmentId), null);
    assert.deepEqual(useConversations.getState().byId, {});
  } finally {
    useConversations.setState({
      byId: prior.byId,
      order: prior.order,
      activeId: prior.activeId,
    });
  }
});
