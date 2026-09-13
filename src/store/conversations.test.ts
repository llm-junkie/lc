import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS, type Conversation, type Message } from '../types.ts';
import {
  currentStreamingTurnMessages,
  finalizeStreamingOwner,
  interruptedToolResultContent,
  isConversationMessageHistoryComplete,
  isMessagesLoaded,
  isModelOperationActive,
  isStreaming,
  isStreamingOwner,
  mergeLazyLoadedMessages,
  markStreaming,
  markModelOperation,
  persistConversationMessageSnapshot,
  recoverInterruptedToolRounds,
  repairUnansweredToolCalls,
  reportConversationPersistenceWarning,
  trackConversationPersistence,
  unmarkStreaming,
  unmarkModelOperation,
  useConversations,
} from './conversations.ts';

describe('conversation tool-turn state', () => {
  it('clears only the accounting protocol whose replay array changes in memory', () => {
    const conversationId = `replay-state-${crypto.randomUUID()}`;
    const prior = useConversations.getState();
    const responseItem = {
      id: 'reasoning-response',
      type: 'reasoning' as const,
      encrypted_content: 'ciphertext',
      summary: [],
    };
    const anthropicBlock = {
      type: 'thinking' as const,
      thinking: '',
      signature: 'signature',
    };
    const assistant: Message = {
      id: 'assistant-replay-state',
      role: 'assistant',
      content: '',
      createdAt: 1,
      responses_output_items: [responseItem],
      anthropic_output_blocks: [anthropicBlock],
      opaque_replay_accounting: [
        {
          schemaVersion: 1,
          protocol: 'openai-responses',
          reasoningCarrier: 'encrypted-content',
          generatedReasoningTokens: 10,
          tokenStatus: 'provider-reported',
          locator: { kind: 'responses-item-ids', itemIds: [responseItem.id] },
        },
        {
          schemaVersion: 1,
          protocol: 'anthropic-messages',
          reasoningCarrier: 'signed-thinking',
          generatedReasoningTokens: 20,
          tokenStatus: 'provider-estimate',
          locator: { kind: 'anthropic-block-indexes', blockIndexes: [0] },
        },
      ],
    };
    useConversations.setState({
      byId: {
        ...prior.byId,
        [conversationId]: {
          id: conversationId,
          title: 'replay state',
          params: { ...DEFAULT_PARAMS },
          createdAt: 1,
          updatedAt: 1,
          messages: [assistant],
          messageCount: 1,
        } as Conversation,
      },
      order: [conversationId, ...prior.order.filter((id) => id !== conversationId)],
    });

    try {
      useConversations.getState().patchMessage(conversationId, assistant.id, {
        responses_output_items: [],
      });
      let current = useConversations.getState().byId[conversationId]?.messages[0];
      assert.deepEqual(current?.opaque_replay_accounting?.map((group) => group.protocol), [
        'anthropic-messages',
      ]);

      useConversations.getState().patchMessage(conversationId, assistant.id, {
        anthropic_output_blocks: [],
      });
      current = useConversations.getState().byId[conversationId]?.messages[0];
      assert.equal(current?.opaque_replay_accounting, undefined);
    } finally {
      useConversations.setState({ byId: prior.byId, order: prior.order, activeId: prior.activeId });
    }
  });

  it('repairs a crash-checkpointed partial tool round without replaying calls', () => {
    const persisted: Message[] = [
      { id: 'user-crash', role: 'user', content: 'do both', createdAt: 1, sortOrder: 1 },
      {
        id: 'assistant-crash',
        role: 'assistant',
        content: '',
        createdAt: 2,
        sortOrder: 2,
        tool_calls: [
          { created_at: 0, id: 'call-complete', name: 'lc_read_file', arguments: '{}' },
          { created_at: 0, id: 'call-unknown', name: 'lc_write_file', arguments: '{}' },
        ],
      },
      {
        id: 'tool-complete',
        role: 'tool',
        content: 'read result',
        createdAt: 3,
        sortOrder: 3,
        tool_call_id: 'call-complete',
      },
    ];

    const repaired = recoverInterruptedToolRounds(persisted);
    assert.deepEqual(repaired.repairedCallIds, ['call-unknown']);
    assert.deepEqual(
      repaired.messages.map((message) => [message.role, message.tool_call_id]),
      [
        ['user', undefined],
        ['assistant', undefined],
        ['tool', 'call-complete'],
        ['tool', 'call-unknown'],
      ],
    );
    const recoveryResult = repaired.messages.at(-1);
    assert.equal(recoveryResult?.tool_is_error, true);
    assert.match(recoveryResult?.content ?? '', /completion and side effects are unknown/i);

    const secondLoad = recoverInterruptedToolRounds(repaired.messages);
    assert.equal(secondLoad.messages, repaired.messages);
    assert.deepEqual(secondLoad.repairedCallIds, []);
  });

  it('inserts an interrupted result before the next provider turn', () => {
    const persisted: Message[] = [
      { id: 'assistant-before-boundary', role: 'assistant', content: '', createdAt: 1, tool_calls: [
        { created_at: 0, id: 'call-before-boundary', name: 'lc_run_shell', arguments: '{}' },
      ] },
      { id: 'assistant-after-boundary', role: 'assistant', content: 'later', createdAt: 2 },
    ];

    const repaired = recoverInterruptedToolRounds(persisted);
    assert.deepEqual(repaired.messages.map((message) => message.id), [
      'assistant-before-boundary',
      'recovery:assistant-before-boundary:call-before-boundary',
      'assistant-after-boundary',
    ]);
  });

  describe('repairUnansweredToolCalls — round-scoped Stop repair', () => {
    function repairFixture(messages: Message[]): string {
      const prior = useConversations.getState();
      const conversationId = `repair-${crypto.randomUUID()}`;
      useConversations.setState({
        byId: { ...prior.byId, [conversationId]: {
          id: conversationId,
          title: 'repair',
          params: { ...DEFAULT_PARAMS },
          createdAt: 1,
          updatedAt: 1,
          messages,
          messageCount: messages.length,
        } as Conversation },
        order: [conversationId, ...prior.order.filter((id) => id !== conversationId)],
        activeId: conversationId,
      });
      return conversationId;
    }

    it('a reused id answered by an earlier round still gets a current-round terminal row', () => {
      const conversationId = repairFixture([
        // Earlier round: answered reuse-id.
        { id: 'old-assistant', role: 'assistant', content: '', createdAt: 1, sortOrder: 1, tool_calls: [
          { created_at: 0, id: 'reuse-id', name: 'lc_get_current_time', arguments: '{}' },
        ] },
        { id: 'old-result', role: 'tool', content: 'old', createdAt: 2, sortOrder: 2, tool_call_id: 'reuse-id' },
        // Current round: reuses the same id, unanswered.
        { id: 'current-assistant', role: 'assistant', content: '', createdAt: 3, sortOrder: 3, tool_calls: [
          { created_at: 0, id: 'reuse-id', name: 'lc_get_current_time', arguments: '{}' },
        ] },
      ]);

      const repaired = repairUnansweredToolCalls(conversationId, ['reuse-id'], 'current-assistant', 'aborted');
      assert.equal(repaired, 1, 'the earlier result must not answer the current round');
      const messages = useConversations.getState().byId[conversationId]?.messages ?? [];
      const currentRound = messages.slice(messages.findIndex((m) => m.id === 'current-assistant'));
      assert.equal(currentRound.filter((m) => m.role === 'tool' && m.tool_call_id === 'reuse-id').length, 1);
      assert.match(currentRound.find((m) => m.role === 'tool')?.content ?? '', /"status":"aborted"/);
      // Repair rows are owner-scoped: the primary key must include the
      // owning assistant id, or two rounds reusing one call id would produce
      // two messages with the same durable primary key.
      const repairRow = currentRound.find((m) => m.role === 'tool');
      assert.equal(repairRow?.id, `repair:${conversationId}:current-assistant:reuse-id`);
    });

    it('two rounds reusing one id get distinct repair row ids', () => {
      const conversationId = repairFixture([
        { id: 'round-1-assistant', role: 'assistant', content: '', createdAt: 1, sortOrder: 1, tool_calls: [
          { created_at: 0, id: 'reuse-id', name: 'lc_get_current_time', arguments: '{}' },
        ] },
        { id: 'round-2-assistant', role: 'assistant', content: '', createdAt: 2, sortOrder: 2, tool_calls: [
          { created_at: 0, id: 'reuse-id', name: 'lc_get_current_time', arguments: '{}' },
        ] },
      ]);

      assert.equal(repairUnansweredToolCalls(conversationId, ['reuse-id'], 'round-1-assistant', 'aborted'), 1);
      assert.equal(repairUnansweredToolCalls(conversationId, ['reuse-id'], 'round-2-assistant', 'aborted'), 1);
      const messages = useConversations.getState().byId[conversationId]?.messages ?? [];
      const ids = messages.filter((m) => m.role === 'tool').map((m) => m.id);
      assert.equal(new Set(ids).size, ids.length, 'repair row ids are unique across rounds');
      assert.ok(ids.includes(`repair:${conversationId}:round-1-assistant:reuse-id`));
      assert.ok(ids.includes(`repair:${conversationId}:round-2-assistant:reuse-id`));
      // sortOrder must be strictly increasing after insertion.
      const orders = messages.map((m) => m.sortOrder ?? -1).filter((o) => o >= 0);
      assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
    });

    it('an id persisted by the same round never gets a second row', () => {
      const conversationId = repairFixture([
        { id: 'current-assistant', role: 'assistant', content: '', createdAt: 1, sortOrder: 1, tool_calls: [
          { created_at: 0, id: 'fast-id', name: 'lc_get_current_time', arguments: '{}' },
        ] },
        { id: 'fast-result', role: 'tool', content: '{}', createdAt: 2, sortOrder: 2, tool_call_id: 'fast-id' },
      ]);

      const repaired = repairUnansweredToolCalls(conversationId, ['fast-id'], 'current-assistant', 'aborted');
      assert.equal(repaired, 0);
      const messages = useConversations.getState().byId[conversationId]?.messages ?? [];
      assert.equal(messages.filter((m) => m.role === 'tool' && m.tool_call_id === 'fast-id').length, 1);
    });

    it('repair content carries the shared aborted envelope shape', () => {
      const content = interruptedToolResultContent('aborted', 'lc_write_file');
      assert.match(content, /"status":"aborted"/);
      assert.match(content, /side effects may have happened/i);
      assert.doesNotMatch(content, /completion and side effects are unknown/i);
    });

    it('timeout repair is terminal without claiming the side effect was absent', () => {
      const content = interruptedToolResultContent('timeout', 'lc_write_file');
      const parsed = JSON.parse(content);
      assert.equal(parsed.status, 'timeout');
      assert.equal(parsed.issues[0].code, 'timeout');
      assert.equal(parsed.issues[0].retryable, false);
      assert.match(parsed.issues[0].message, /side effects may have happened/i);
    });
  });

  it('makes model operations and generation admission reciprocally exclusive', () => {
    const modelOwner = markModelOperation('unload', 'model-a', 'model-operation-a');
    try {
      assert.equal(isModelOperationActive(), true);
      assert.throws(
        () => markStreaming('model-lock-conversation', 'assistant-a', 'generation-a'),
        /model or conversation operation/i,
      );
      assert.equal(unmarkModelOperation('stale-operation'), false);
    } finally {
      assert.equal(unmarkModelOperation(modelOwner.operationId), true);
    }

    const streamOwner = markStreaming(
      'model-lock-conversation',
      'assistant-b',
      'generation-b',
    );
    try {
      assert.throws(
        () => markModelOperation('load', 'model-b', 'model-operation-b'),
        /current response/i,
      );
      assert.equal(isModelOperationActive(), false);
    } finally {
      assert.equal(unmarkStreaming(streamOwner.conversationId, streamOwner.generationId), true);
    }

    const releasedOwner = markModelOperation('load', 'model-c', 'model-operation-c');
    assert.equal(unmarkModelOperation(releasedOwner.operationId), true);
  });

  it('permits navigation but target-scopes structural actions during a run', async () => {
    const prior = useConversations.getState();
    const activeId = 'navigation-active';
    const otherId = 'navigation-other';
    const active: Conversation = {
      id: activeId,
      title: 'active',
      params: { ...DEFAULT_PARAMS },
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      messageCount: 0,
    };
    const other: Conversation = {
      ...active,
      id: otherId,
      title: 'other',
      createdAt: 2,
      updatedAt: 2,
    };
    useConversations.setState({
      byId: { [activeId]: active, [otherId]: other },
      order: [activeId, otherId],
      activeId,
      filterTab: 'active',
    });
    const owner = markStreaming(activeId, 'navigation-assistant', 'navigation-generation');

    try {
      const before = useConversations.getState();

      // Navigation away from a generating conversation is now permitted: the
      // response belongs to its conversation, not to the visible pane.
      before.setActive(otherId);
      assert.equal(useConversations.getState().activeId, otherId);

      // So are structural actions on a conversation that is *not* generating.
      before.rename(otherId, 'mutated');
      assert.equal(useConversations.getState().byId[otherId]?.title, 'mutated');

      // A new chat can always be started, even at capacity.
      const drafted = before.create({ title: 'draft while busy' });
      assert.ok(drafted);
      useConversations.getState().remove(drafted.id);

      // The generating conversation itself stays locked.
      before.rename(activeId, 'must-not-change');
      before.archive(activeId);
      before.remove(activeId);
      assert.equal(await before.clone(activeId), undefined);

      const locked = useConversations.getState();
      assert.equal(locked.byId[activeId]?.title, 'active');
      assert.equal(locked.byId[activeId]?.archived, undefined);
      assert.ok(locked.byId[activeId], 'the generating conversation survives delete');

      // Restore the selection the rest of this test expects.
      locked.setActive(activeId);
      locked.rename(otherId, 'other');

      // Expanded sidebar tab controls are inspection-only: they may filter the
      // list, but must not displace the active conversation.
      locked.setFilterTab('archive');
      assert.equal(useConversations.getState().filterTab, 'archive');
      assert.equal(useConversations.getState().activeId, activeId);
    } finally {
      unmarkStreaming(owner.conversationId, owner.generationId);
    }

    try {
      const clonePromise = useConversations.getState().clone(otherId);
      assert.throws(
        () => markStreaming(otherId, 'clone-race-assistant', 'clone-race-generation'),
        /model or conversation operation/i,
      );
      const cloned = await clonePromise;
      assert.ok(cloned);

      useConversations.getState().setActive(otherId);
      assert.equal(useConversations.getState().activeId, otherId);
      useConversations.getState().archive(otherId);
      assert.equal(useConversations.getState().byId[otherId]?.archived, true);
    } finally {
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
        filterTab: prior.filterTab,
      });
    }
  });

  it('surfaces rejected persistence instead of silently reporting success', async () => {
    const priorFailure = useConversations.getState().persistenceFailure;
    useConversations.setState({ persistenceFailure: null });
    try {
      await trackConversationPersistence(
        Promise.reject(new Error('injected quota failure')),
        'flush complete conversation history',
        'persistence-failure-test',
      );
      const failure = useConversations.getState().persistenceFailure;
      assert.equal(failure?.severity, 'error');
      assert.equal(failure?.operation, 'flush complete conversation history');
      assert.equal(failure?.conversationId, 'persistence-failure-test');
      assert.match(failure?.message ?? '', /injected quota failure/);

      assert.ok(failure);
      useConversations.getState().clearPersistenceFailure(failure.at);
      assert.equal(useConversations.getState().persistenceFailure, null);

      reportConversationPersistenceWarning(
        'preserve incomplete conversation history',
        'injected safe upsert',
        'persistence-failure-test',
      );
      const warning = useConversations.getState().persistenceFailure;
      assert.equal(warning?.severity, 'warning');
      assert.match(warning?.message ?? '', /safe upsert/);
      assert.ok(warning);
      useConversations.getState().clearPersistenceFailure(warning.at);
      assert.equal(useConversations.getState().persistenceFailure, null);
    } finally {
      useConversations.setState({ persistenceFailure: priorFailure });
    }
  });

  it('rejects a stale lazy-load snapshot after a new turn is appended', async () => {
    let release!: (messages: Message[]) => void;
    const deferred = new Promise<Message[]>((resolve) => {
      release = resolve;
    });
    let current: Conversation = {
      id: 'lazy-load-race',
      title: 'test',
      params: { ...DEFAULT_PARAMS },
      createdAt: 1,
      updatedAt: 1,
      messages: [],
    };

    const pending = deferred.then((messages) => {
      current = mergeLazyLoadedMessages(current, messages);
    });
    current = {
      ...current,
      messages: [
        { id: 'new-user', role: 'user', content: 'new', createdAt: 10 },
        { id: 'new-assistant', role: 'assistant', content: '', createdAt: 11, streaming: true },
      ],
    };
    release([{ id: 'stale-user', role: 'user', content: 'old', createdAt: 1 }]);
    await pending;

    assert.deepEqual(current.messages.map((message) => message.id), ['new-user', 'new-assistant']);
  });

  it('reconciles a stale durable count from an authoritative message reload', () => {
    const conversationId = 'stale-message-count';
    const prior = useConversations.getState();
    const messages: Message[] = [
      { id: 'durable-user', role: 'user', content: 'one', createdAt: 1 },
      { id: 'durable-assistant', role: 'assistant', content: 'two', createdAt: 2 },
    ];
    const stale: Conversation = {
      id: conversationId,
      title: 'stale count fixture',
      params: { ...DEFAULT_PARAMS },
      createdAt: 1,
      updatedAt: 1,
      messages,
      messageCount: messages.length + 1,
    };
    useConversations.setState({
      byId: { ...prior.byId, [conversationId]: stale },
      activeId: conversationId,
    });

    try {
      assert.equal(isConversationMessageHistoryComplete(stale), false);
      assert.equal(isMessagesLoaded(conversationId), false);

      const reconciled = mergeLazyLoadedMessages(stale, messages.map((message) => ({ ...message })));
      assert.notEqual(reconciled, stale);
      assert.equal(reconciled.messageCount, messages.length);
      assert.equal(reconciled.messages, stale.messages);
      useConversations.setState((state) => ({
        byId: { ...state.byId, [conversationId]: reconciled },
      }));

      assert.equal(isConversationMessageHistoryComplete(reconciled), true);
      assert.equal(isMessagesLoaded(conversationId), true);
    } finally {
      useConversations.setState({
        byId: prior.byId,
        activeId: prior.activeId,
      });
    }
  });

  it('preserves durable rows when a failed load leaves the live snapshot incomplete', async () => {
    const conversationId = 'incomplete-flush-test';
    const prior = useConversations.getState();
    const durableRows = new Map<string, Message>([
      ['old-user', { id: 'old-user', role: 'user', content: 'old', createdAt: 1 }],
      ['old-assistant', { id: 'old-assistant', role: 'assistant', content: 'old reply', createdAt: 2 }],
    ]);
    let replaceCalls = 0;
    let warningCalls = 0;

    useConversations.setState({
      byId: {
        ...prior.byId,
        [conversationId]: {
          id: conversationId,
          title: 'failed load fixture',
          params: { ...DEFAULT_PARAMS },
          createdAt: 1,
          updatedAt: 1,
          // Dexie still has two rows, but the rejected load published none.
          messages: [],
          messageCount: 2,
        },
      },
      activeId: conversationId,
    });

    try {
      assert.equal(
        isConversationMessageHistoryComplete(useConversations.getState().byId[conversationId]),
        false,
      );

      useConversations.getState().appendMessage(conversationId, {
        role: 'user',
        content: 'new turn',
      });
      useConversations.getState().appendMessage(conversationId, {
        role: 'assistant',
        content: 'new reply',
        streaming: false,
      });
      const incomplete = useConversations.getState().byId[conversationId];
      assert.equal(incomplete.messages.length, 2);
      assert.equal(incomplete.messageCount, 4);
      assert.equal(isConversationMessageHistoryComplete(incomplete), false);

      const mode = await persistConversationMessageSnapshot(
        incomplete,
        {
          saveMessages: async (messages, persistedConversationId) => {
            assert.equal(persistedConversationId, conversationId);
            for (const message of messages) durableRows.set(message.id, message);
          },
          replaceMessages: async () => {
            replaceCalls++;
            durableRows.clear();
          },
        },
        (snapshot) => {
          warningCalls++;
          assert.equal(snapshot.messageCount, 4);
          assert.equal(snapshot.messages.length, 2);
        },
      );

      assert.equal(mode, 'upsert');
      assert.equal(replaceCalls, 0);
      assert.equal(warningCalls, 1);
      assert.deepEqual(
        [...durableRows.values()].map((message) => message.content),
        ['old', 'old reply', 'new turn', 'new reply'],
      );
    } finally {
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('uses replacement only for a provably complete live snapshot', async () => {
    const messages: Message[] = [
      { id: 'complete-user', role: 'user', content: 'one', createdAt: 1 },
      { id: 'complete-assistant', role: 'assistant', content: 'two', createdAt: 2 },
    ];
    assert.equal(isConversationMessageHistoryComplete({ messages }), false);
    assert.equal(isConversationMessageHistoryComplete({ messages, messageCount: messages.length }), true);
    let replaceCalls = 0;
    let saveCalls = 0;
    const mode = await persistConversationMessageSnapshot(
      { id: 'complete-flush-test', messages, messageCount: messages.length },
      {
        saveMessages: async () => { saveCalls++; },
        replaceMessages: async (conversationId, persisted) => {
          replaceCalls++;
          assert.equal(conversationId, 'complete-flush-test');
          assert.equal(persisted, messages);
        },
      },
      () => assert.fail('complete snapshots must not warn'),
    );

    assert.equal(mode, 'replace');
    assert.equal(replaceCalls, 1);
    assert.equal(saveCalls, 0);
  });

  it('preserves assistant metadata and prior tool calls across partial finalization', () => {
    const conversationId = 'tool-turn-meta-test';
    const priorById = useConversations.getState().byId;
    const conversation: Conversation = {
      id: conversationId,
      title: 'test',
      model: 'model-a',
      params: { ...DEFAULT_PARAMS },
      createdAt: 1,
      updatedAt: 1,
      messages: [{
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        createdAt: 1,
        streaming: true,
        meta: {
          model: 'model-a',
          avgTps: 12,
          finish_reason: 'tool_calls',
        },
        tool_calls: [{
          id: 'call-1',
          name: 'lc_get_current_time',
          arguments: '{}',
          created_at: 1,
        }],
      }],
    };

    useConversations.setState({
      byId: { ...priorById, [conversationId]: conversation },
    });

    try {
      useConversations.getState().finalizeLast(conversationId, {
        meta: { model: 'model-b' },
        tool_calls: [{
          id: 'call-2',
          name: 'lc_todo_write',
          arguments: '{"items":[]}',
          created_at: 2,
        }],
      });

      const assistant = useConversations.getState().byId[conversationId].messages[0];
      assert.equal(assistant.streaming, false);
      assert.equal(assistant.meta?.model, 'model-b');
      assert.equal(assistant.meta?.avgTps, 12);
      assert.equal(assistant.meta?.finish_reason, 'tool_calls');
      assert.deepEqual(assistant.tool_calls?.map((call) => call.id), ['call-1', 'call-2']);
    } finally {
      useConversations.setState({ byId: priorById });
    }
  });

  it('checkpoints the current assistant and every following tool result', () => {
    const messages: Message[] = [
      { id: 'user-old', role: 'user', content: 'old', createdAt: 1 },
      { id: 'assistant-old', role: 'assistant', content: 'old reply', createdAt: 2 },
      { id: 'user-current', role: 'user', content: 'work', createdAt: 3 },
      { id: 'assistant-current', role: 'assistant', content: '', createdAt: 4, streaming: false },
      { id: 'tool-1', role: 'tool', content: 'one', createdAt: 5, tool_call_id: 'call-1' },
      { id: 'tool-2', role: 'tool', content: 'two', createdAt: 6, tool_call_id: 'call-2' },
    ];

    assert.deepEqual(
      currentStreamingTurnMessages(messages).map((message) => message.id),
      ['assistant-current', 'tool-1', 'tool-2'],
    );
    assert.deepEqual(
      currentStreamingTurnMessages(messages, 'assistant-old').map((message) => message.id),
      ['assistant-old', 'user-current', 'assistant-current', 'tool-1', 'tool-2'],
    );
  });

  it('keeps terminal and cleanup ownership generation-scoped', () => {
    const conversationId = 'generation-owner-test';
    const prior = useConversations.getState();
    const conversation: Conversation = {
      id: conversationId,
      title: 'owner test',
      model: 'model-a',
      params: { ...DEFAULT_PARAMS },
      createdAt: 1,
      updatedAt: 1,
      messages: [{
        id: 'assistant-a',
        role: 'assistant',
        content: 'a-live',
        createdAt: 1,
        streaming: true,
      }],
    };

    useConversations.setState({
      byId: { ...prior.byId, [conversationId]: conversation },
      order: [conversationId, ...prior.order.filter((id) => id !== conversationId)],
      activeId: conversationId,
    });

    try {
      const ownerA = markStreaming(conversationId, 'assistant-a', 'generation-a');
      assert.equal(finalizeStreamingOwner(conversationId, ownerA.generationId, {
        meta: { finish_reason: 'disconnected' },
      }), true);
      assert.equal(finalizeStreamingOwner(conversationId, ownerA.generationId, {
        meta: { finish_reason: 'error' },
      }), false);
      assert.equal(unmarkStreaming(conversationId, ownerA.generationId), true);

      useConversations.getState().appendMessage(conversationId, {
        role: 'user',
        content: 'turn b',
      });
      const assistantB = useConversations.getState().appendMessage(conversationId, {
        role: 'assistant',
        content: 'b-live',
        streaming: true,
      });
      assert.ok(assistantB);
      const ownerB = markStreaming(conversationId, assistantB.id, 'generation-b');

      // A's stale terminal/finally operations cannot mutate or release B.
      assert.equal(finalizeStreamingOwner(conversationId, ownerA.generationId, {
        meta: { finish_reason: 'error' },
      }), false);
      assert.equal(unmarkStreaming(conversationId, ownerA.generationId), false);
      assert.equal(isStreamingOwner(conversationId, ownerA.generationId), false);
      assert.equal(isStreamingOwner(conversationId, ownerB.generationId), true);
      assert.equal(isStreaming(conversationId), true);

      const messages = useConversations.getState().byId[conversationId].messages;
      assert.equal(messages.find((message) => message.id === 'assistant-a')?.meta?.finish_reason, 'disconnected');
      assert.equal(messages.find((message) => message.id === assistantB.id)?.content, 'b-live');
      assert.equal(messages.find((message) => message.id === assistantB.id)?.streaming, true);

      assert.equal(unmarkStreaming(conversationId, ownerB.generationId), true);
    } finally {
      const currentOwner = isStreaming(conversationId);
      if (currentOwner) unmarkStreaming(conversationId, 'generation-b');
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('freezes model, parameters, and destructive conversation reset during a generation', async () => {
    const conversationId = 'generation-config-lock';
    const prior = useConversations.getState();
    const initial: Conversation = {
      id: conversationId,
      title: 'config lock',
      model: 'model-a',
      params: { ...DEFAULT_PARAMS, temperature: 0.25 },
      createdAt: 1,
      updatedAt: 1,
      messages: [{ id: 'assistant-lock', role: 'assistant', content: '', createdAt: 1, streaming: true }],
      messageCount: 1,
    };
    useConversations.setState({
      byId: { ...prior.byId, [conversationId]: initial },
      order: [conversationId, ...prior.order.filter((id) => id !== conversationId)],
      activeId: conversationId,
    });
    const owner = markStreaming(conversationId, 'assistant-lock', 'generation-config-lock');

    try {
      const store = useConversations.getState();
      store.setModel(conversationId, 'model-b');
      store.setParams(conversationId, { ...DEFAULT_PARAMS, temperature: 0.9 });
      assert.equal(await store.clearAll(), false);

      const unchanged = useConversations.getState().byId[conversationId];
      assert.equal(unchanged.model, 'model-a');
      assert.equal(unchanged.params.temperature, 0.25);
      assert.equal(useConversations.getState().order.includes(conversationId), true);
    } finally {
      unmarkStreaming(owner.conversationId, owner.generationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('targets deltas and finalization by assistant message id', () => {
    const conversationId = 'targeted-message-test';
    const priorById = useConversations.getState().byId;
    useConversations.setState({
      byId: {
        ...priorById,
        [conversationId]: {
          id: conversationId,
          title: 'target test',
          model: 'model-a',
          params: { ...DEFAULT_PARAMS },
          createdAt: 1,
          updatedAt: 1,
          messages: [
            { id: 'assistant-a', role: 'assistant', content: 'a', createdAt: 1, streaming: true },
            { id: 'assistant-b', role: 'assistant', content: 'b', createdAt: 2, streaming: true },
          ],
        },
      },
    });

    try {
      const store = useConversations.getState();
      store.appendToMessage(conversationId, 'assistant-a', '-delta');
      store.appendReasoningToMessage(conversationId, 'assistant-a', 'reason');
      store.finalizeMessage(conversationId, 'assistant-a', {
        meta: { finish_reason: 'stop' },
      });
      const [assistantA, assistantB] = useConversations.getState().byId[conversationId].messages;
      assert.equal(assistantA.content, 'a-delta');
      assert.equal(assistantA.reasoning, 'reason');
      assert.equal(assistantA.reasoningHasVisibleContent, true);
      assert.equal(assistantA.streaming, false);
      assert.equal(assistantA.meta?.finish_reason, 'stop');
      assert.equal(assistantB.content, 'b');
      assert.equal(assistantB.streaming, true);
      assert.equal(assistantB.meta, undefined);
    } finally {
      useConversations.setState({ byId: priorById });
    }
  });

  it('clone preserves tool-call linkage while giving messages a new conversation', async () => {
    const sourceId = 'clone-tool-turn-source';
    const sourceCallId = 'source-call-1';
    const prior = useConversations.getState();
    const source: Conversation = {
      id: sourceId,
      title: 'source',
      model: 'model-a',
      params: { ...DEFAULT_PARAMS },
      createdAt: 1,
      updatedAt: 1,
      messages: [
        {
          id: 'source-user',
          role: 'user',
          content: 'read a file',
          createdAt: 1,
          attachments: [{
            id: 'source-attachment',
            name: 'notes.txt',
            mime: 'text/plain',
            isImage: false,
            size: 5,
            stored: 'inline',
            dataUrl: 'data:text/plain;base64,SGVsbG8=',
          }],
        },
        {
          id: 'source-assistant',
          role: 'assistant',
          content: '',
          createdAt: 2,
          tool_calls: [{ created_at: 0, id: sourceCallId, name: 'lc_read_file', arguments: '{}' }],
        },
        { id: 'source-tool', role: 'tool', content: 'file contents', createdAt: 3, tool_call_id: sourceCallId },
      ],
    };

    useConversations.setState({
      byId: { ...prior.byId, [sourceId]: source },
      order: [sourceId, ...prior.order.filter((id) => id !== sourceId)],
      activeId: sourceId,
    });

    try {
      const cloned = await useConversations.getState().clone(sourceId);
      assert.ok(cloned);
      assert.notEqual(cloned.id, sourceId);
      const clonedAssistant = cloned.messages.find((message) => message.role === 'assistant');
      const clonedTool = cloned.messages.find((message) => message.role === 'tool');
      const clonedAttachment = cloned.messages[0]?.attachments?.[0];
      const clonedCallId = clonedAssistant?.tool_calls?.[0]?.id;

      assert.ok(clonedCallId);
      assert.equal(clonedCallId, sourceCallId);
      assert.equal(clonedTool?.tool_call_id, sourceCallId);
      assert.ok(clonedAttachment);
      assert.notEqual(clonedAttachment.id, 'source-attachment');
      assert.equal(clonedAttachment.dataUrl, 'data:text/plain;base64,SGVsbG8=');
      assert.equal(source.messages[1]?.tool_calls?.[0]?.id, sourceCallId);
      assert.equal(source.messages[2]?.tool_call_id, sourceCallId);
      assert.equal(source.messages[0]?.attachments?.[0]?.id, 'source-attachment');
    } finally {
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('clone preserves an empty transcript as empty', async () => {
    const sourceId = `clone-empty-source-${crypto.randomUUID()}`;
    const prior = useConversations.getState();
    const source: Conversation = {
      id: sourceId,
      title: 'empty source',
      params: { ...DEFAULT_PARAMS },
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      messages: [],
    };

    useConversations.setState({
      byId: { ...prior.byId, [sourceId]: source },
      order: [sourceId, ...prior.order.filter((id) => id !== sourceId)],
      activeId: sourceId,
    });

    try {
      const cloned = await useConversations.getState().clone(sourceId);
      assert.ok(cloned);
      assert.deepEqual(cloned.messages, []);
      assert.equal(cloned.messageCount, 0);
    } finally {
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });
});
