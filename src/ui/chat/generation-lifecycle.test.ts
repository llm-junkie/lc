import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJSONStorage } from 'zustand/middleware';
import { DEFAULT_PARAMS, type Conversation } from '../../types.ts';
import {
  commitChatGenerationAdmission,
  finalizeStreamingOwner,
  getStreamingOwner,
  isGenerationBlockingOperationOwner,
  markGenerationBlockingOperation,
  markStreaming,
  unmarkGenerationBlockingOperation,
  unmarkStreaming,
  useConversations,
} from '../../store/conversations.ts';
import {
  handoffAndRegisterGenerationSession,
  installApplicationGenerationExitCleanup,
  requestGenerationStop,
  settleGenerationSessionAfterTerminalFlush,
  stopGenerationSession,
  type GenerationExitTarget,
} from './generation-lifecycle.ts';
import {
  activeGenerationSessions,
  configureGenerationCapacity,
  endGenerationSession,
  getGenerationAttention,
  getGenerationSessionView,
  resetGenerationSessionsForTests,
  setGenerationCapacityForTests,
  setGenerationSessionPhase,
  startGenerationSession,
} from '../../modules/chat-pipeline/generation-session-manager.ts';
import { useSettings } from '../../store/settings.ts';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});
useSettings.persist.setOptions({
  storage: createJSONStorage(() => globalThis.localStorage),
});

class ExitTarget implements GenerationExitTarget {
  private readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: 'pagehide' | 'beforeunload', listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: 'pagehide' | 'beforeunload', listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: 'pagehide' | 'beforeunload'): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

describe('application-owned page exit', () => {
  it('terminalizes every live session, not only the selected conversation', () => {
    // The handler used to live in ChatView, which can only ever see the
    // conversation it is rendering. Once a session can outlive the foreground
    // view, a component-owned handler terminalizes the wrong set.
    const prior = useConversations.getState();
    const ids = ['app-exit-a', 'app-exit-b', 'app-exit-c'];
    const byId: Record<string, Conversation> = {};
    for (const id of ids) {
      byId[id] = {
        id,
        title: id,
        params: { ...DEFAULT_PARAMS },
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
        messages: [{ id: `${id}-assistant`, role: 'assistant', content: '', createdAt: 1, streaming: true }],
      };
    }
    // Only the first conversation is selected; the second is a background run.
    useConversations.setState({ byId, order: ids, activeId: ids[0] });

    const target = new ExitTarget();
    const cleanup = installApplicationGenerationExitCleanup(
      activeGenerationSessions,
      endGenerationSession,
      target,
    );
    const owners: ReturnType<typeof markStreaming>[] = [];

    try {
      // Three live sessions is the point of this test, so the limit is raised
      // explicitly rather than being assumed.
      setGenerationCapacityForTests(ids.length);
      const controllers = ids.map((id) => {
        const owner = markStreaming(id, `${id}-assistant`, `${id}-generation`);
        owners.push(owner);
        const controller = new AbortController();
        startGenerationSession({ ...owner, controller });
        return controller;
      });
      target.dispatch('pagehide');

      for (const [index, id] of ids.entries()) {
        assert.equal(controllers[index].signal.aborted, true, `${id} aborted`);
        assert.equal(getStreamingOwner(id), undefined, `${id} released ownership`);
        assert.equal(
          useConversations.getState().byId[id]?.messages[0]?.meta?.finish_reason,
          'disconnected',
          `${id} terminalized`,
        );
      }
      assert.equal(activeGenerationSessions().length, 0);

      // Idempotent: a second exit event must not throw or double-finalize.
      target.dispatch('beforeunload');
      assert.equal(activeGenerationSessions().length, 0);
    } finally {
      cleanup();
      resetGenerationSessionsForTests();
      for (const owner of owners) unmarkStreaming(owner.conversationId, owner.generationId);
      useConversations.setState({ byId: prior.byId, order: prior.order, activeId: prior.activeId });
    }
  });

  it('continues after one session abort fails', () => {
    const prior = useConversations.getState();
    const ids = ['app-exit-failure-a', 'app-exit-failure-b', 'app-exit-failure-c'];
    const byId: Record<string, Conversation> = {};
    for (const id of ids) {
      byId[id] = {
        id,
        title: id,
        params: { ...DEFAULT_PARAMS },
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
        messages: [{
          id: `${id}-assistant`,
          role: 'assistant',
          content: '',
          createdAt: 1,
          streaming: true,
        }],
      };
    }
    useConversations.setState({ byId, order: ids, activeId: ids[0] });
    const target = new ExitTarget();
    const cleanup = installApplicationGenerationExitCleanup(
      activeGenerationSessions,
      endGenerationSession,
      target,
    );
    const owners: ReturnType<typeof markStreaming>[] = [];

    try {
      setGenerationCapacityForTests(ids.length);
      for (const [index, id] of ids.entries()) {
        const owner = markStreaming(id, `${id}-assistant`, `${id}-generation`);
        owners.push(owner);
        const controller = new AbortController();
        if (index === 1) {
          Object.defineProperty(controller, 'abort', {
            value: () => { throw new Error('simulated abort failure'); },
          });
        }
        startGenerationSession({ ...owner, controller });
      }

      assert.doesNotThrow(() => target.dispatch('pagehide'));
      for (const id of ids) {
        assert.equal(getStreamingOwner(id), undefined, `${id} released ownership`);
        assert.equal(
          useConversations.getState().byId[id]?.messages[0]?.meta?.finish_reason,
          'disconnected',
          `${id} terminalized`,
        );
      }
      assert.equal(activeGenerationSessions().length, 0);
    } finally {
      cleanup();
      resetGenerationSessionsForTests();
      for (const owner of owners) unmarkStreaming(owner.conversationId, owner.generationId);
      useConversations.setState({ byId: prior.byId, order: prior.order, activeId: prior.activeId });
    }
  });

  it('unmounting the handler does not terminalize live sessions', () => {
    // React unmount is not a page exit. Tearing down the listener must leave
    // running generations alone, unlike the old per-view cleanup.
    const prior = useConversations.getState();
    const conversationId = 'app-exit-unmount';
    useConversations.setState({
      byId: {
        [conversationId]: {
          id: conversationId,
          title: conversationId,
          params: { ...DEFAULT_PARAMS },
          createdAt: 1,
          updatedAt: 1,
          messageCount: 1,
          messages: [{ id: 'assistant', role: 'assistant', content: '', createdAt: 1, streaming: true }],
        },
      },
      order: [conversationId],
      activeId: conversationId,
    });
    const owner = markStreaming(conversationId, 'assistant', 'app-exit-unmount-generation');
    const controller = new AbortController();
    startGenerationSession({ ...owner, controller });

    const cleanup = installApplicationGenerationExitCleanup(
      activeGenerationSessions,
      endGenerationSession,
      new ExitTarget(),
    );

    try {
      cleanup();
      assert.equal(controller.signal.aborted, false, 'the generation keeps running');
      assert.equal(activeGenerationSessions().length, 1);
    } finally {
      resetGenerationSessionsForTests();
      unmarkStreaming(conversationId, owner.generationId);
      useConversations.setState({ byId: prior.byId, order: prior.order, activeId: prior.activeId });
    }
  });
});

describe('user stop', () => {
  it('terminalizes only the middle owner before its pipeline settles', async () => {
    const prior = useConversations.getState();
    const ids = ['stop-a', 'stop-b', 'stop-c'];
    const byId: Record<string, Conversation> = {};
    for (const id of ids) {
      byId[id] = {
        id,
        title: id,
        params: { ...DEFAULT_PARAMS },
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
        messages: [{
          id: `${id}-assistant`,
          role: 'assistant',
          content: '',
          createdAt: 1,
          streaming: true,
        }],
      };
    }
    useConversations.setState({ byId, order: ids, activeId: ids[0] });
    const owners: ReturnType<typeof markStreaming>[] = [];

    try {
      setGenerationCapacityForTests(ids.length);
      const controllers = ids.map((id) => {
        const owner = markStreaming(id, `${id}-assistant`, `${id}-generation`);
        owners.push(owner);
        const controller = new AbortController();
        startGenerationSession({ ...owner, controller });
        return controller;
      });

      assert.equal(stopGenerationSession(ids[1])?.generationId, `${ids[1]}-generation`);
      assert.equal(controllers[0].signal.aborted, false);
      assert.equal(controllers[1].signal.aborted, true);
      assert.equal(controllers[2].signal.aborted, false);
      assert.equal(activeGenerationSessions().length, 3, 'the stopped run still fences late work');

      for (const [index, id] of ids.entries()) {
        const assistant = useConversations.getState().byId[id]?.messages[0];
        assert.equal(assistant?.streaming, index !== 1, `${id} streaming state`);
        assert.equal(
          assistant?.meta?.finish_reason,
          index === 1 ? 'disconnected' : undefined,
          `${id} finish reason`,
        );
      }
      await settleGenerationSessionAfterTerminalFlush(ids[1], `${ids[1]}-generation`);
      assert.equal(
        getGenerationAttention(ids[1])?.kind,
        'completed',
        'a requested Stop is not reported as a provider failure',
      );
    } finally {
      resetGenerationSessionsForTests();
      for (const owner of owners) unmarkStreaming(owner.conversationId, owner.generationId);
      useConversations.setState({ byId: prior.byId, order: prior.order, activeId: prior.activeId });
    }
  });

  it('retries a failed terminal write from the shared Stop control', async () => {
    const prior = useConversations.getState();
    const conversationId = 'stop-retry-terminal-write';
    const assistantMessageId = `${conversationId}-assistant`;
    useConversations.setState({
      byId: {
        [conversationId]: {
          id: conversationId,
          title: conversationId,
          params: { ...DEFAULT_PARAMS },
          createdAt: 1,
          updatedAt: 1,
          messageCount: 1,
          messages: [{
            id: assistantMessageId,
            role: 'assistant',
            content: 'complete',
            createdAt: 1,
            streaming: true,
          }],
        },
      },
      order: [conversationId],
      activeId: conversationId,
    });
    const owner = markStreaming(
      conversationId,
      assistantMessageId,
      `${conversationId}-generation`,
    );
    startGenerationSession({ ...owner, controller: new AbortController() });
    finalizeStreamingOwner(conversationId, owner.generationId, {
      meta: { finish_reason: 'stop' },
    });
    setGenerationSessionPhase(conversationId, owner.generationId, 'failed');

    try {
      const request = requestGenerationStop(conversationId);
      assert.equal(request.outcome, 'retrying-terminal-write');
      assert.equal(getGenerationSessionView(conversationId)?.phase, 'finalizing');
      if (request.outcome === 'retrying-terminal-write') await request.settlement;

      assert.equal(getStreamingOwner(conversationId), undefined);
      assert.equal(getGenerationSessionView(conversationId), undefined);
    } finally {
      resetGenerationSessionsForTests();
      unmarkStreaming(conversationId, owner.generationId);
      useConversations.setState({ byId: prior.byId, order: prior.order, activeId: prior.activeId });
    }
  });

  it('reports a background provider disconnect as failed without requiring an error message', async () => {
    const prior = useConversations.getState();
    const conversationId = 'background-provider-disconnect';
    const assistantMessageId = `${conversationId}-assistant`;
    useConversations.setState({
      byId: {
        [conversationId]: {
          id: conversationId,
          title: conversationId,
          params: { ...DEFAULT_PARAMS },
          createdAt: 1,
          updatedAt: 1,
          messageCount: 1,
          messages: [{
            id: assistantMessageId,
            role: 'assistant',
            content: 'partial',
            createdAt: 1,
            streaming: true,
          }],
        },
      },
      order: [conversationId],
      activeId: 'another-conversation',
    });
    const owner = markStreaming(
      conversationId,
      assistantMessageId,
      `${conversationId}-generation`,
    );
    startGenerationSession({ ...owner, controller: new AbortController() });
    setGenerationSessionPhase(conversationId, owner.generationId, 'writing');
    finalizeStreamingOwner(conversationId, owner.generationId, {
      meta: { finish_reason: 'disconnected' },
    });

    try {
      await settleGenerationSessionAfterTerminalFlush(conversationId, owner.generationId);
      assert.equal(getGenerationAttention(conversationId)?.kind, 'failed');
    } finally {
      resetGenerationSessionsForTests();
      unmarkStreaming(conversationId, owner.generationId);
      useConversations.setState({ byId: prior.byId, order: prior.order, activeId: prior.activeId });
    }
  });

  it('projects terminal persistence instead of a stale Stop-writing phase', async () => {
    const prior = useConversations.getState();
    const conversationId = 'terminal-persistence-phase';
    const assistantMessageId = `${conversationId}-assistant`;
    useConversations.setState({
      byId: {
        [conversationId]: {
          id: conversationId,
          title: conversationId,
          params: { ...DEFAULT_PARAMS },
          createdAt: 1,
          updatedAt: 1,
          messageCount: 1,
          messages: [{
            id: assistantMessageId,
            role: 'assistant',
            content: 'complete',
            createdAt: 1,
            streaming: true,
          }],
        },
      },
      order: [conversationId],
      activeId: conversationId,
    });
    const owner = markStreaming(
      conversationId,
      assistantMessageId,
      `${conversationId}-generation`,
    );
    const controller = new AbortController();
    startGenerationSession({ ...owner, controller });
    setGenerationSessionPhase(conversationId, owner.generationId, 'writing');
    finalizeStreamingOwner(conversationId, owner.generationId, {
      meta: { finish_reason: 'stop' },
    });

    try {
      const settlement = settleGenerationSessionAfterTerminalFlush(
        conversationId,
        owner.generationId,
      );
      assert.equal(getGenerationSessionView(conversationId)?.phase, 'finalizing');
      assert.equal(requestGenerationStop(conversationId).outcome, 'idle');
      assert.equal(controller.signal.aborted, false);
      await settlement;
    } finally {
      resetGenerationSessionsForTests();
      unmarkStreaming(conversationId, owner.generationId);
      useConversations.setState({ byId: prior.byId, order: prior.order, activeId: prior.activeId });
    }
  });
});

describe('admission handoff rollback', () => {
  it('retires the third owner when Settings lowers capacity during unresolved admission', async () => {
    const prior = useConversations.getState();
    const priorLimit = useSettings.getState().maxConcurrentGenerations;
    const ids = ['capacity-live-a', 'capacity-live-b', 'capacity-admitting-c'];
    const byId: Record<string, Conversation> = {};
    for (const id of ids) {
      byId[id] = {
        id,
        title: id,
        params: { ...DEFAULT_PARAMS },
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
        messages: [{
          id: `${id}-assistant`,
          role: 'assistant',
          content: '',
          createdAt: 1,
          streaming: true,
        }],
      };
    }
    useConversations.setState({ byId, order: ids, activeId: ids[2] });
    setGenerationCapacityForTests(3);
    const existingOwners = ids.slice(0, 2).map((id) => {
      const owner = markStreaming(id, `${id}-assistant`, `${id}-generation`);
      startGenerationSession({ ...owner, controller: new AbortController() });
      return owner;
    });
    const admission = markGenerationBlockingOperation(
      'chat_generation_admission',
      'third admission before settings change',
      'capacity-lowered-admission',
      ids[2],
    );

    try {
      // This is the exact state-to-manager bridge App's settings effect runs.
      // The admission was legal at three, but its final commit must re-check
      // the current policy before any transcript or journal mutation.
      useSettings.setState({ maxConcurrentGenerations: 2 });
      configureGenerationCapacity(useSettings.getState().maxConcurrentGenerations);

      assert.throws(
        () => commitChatGenerationAdmission(admission.operationId, ids[2]),
        /All 2 generation slots are in use/,
      );

      assert.equal(getStreamingOwner(ids[2]), undefined);
      assert.equal(isGenerationBlockingOperationOwner(admission.operationId), false);
      assert.deepEqual(
        activeGenerationSessions().map((session) => session.conversationId).sort(),
        ids.slice(0, 2).sort(),
      );
      const untouched = useConversations.getState().byId[ids[2]]?.messages[0];
      assert.equal(untouched?.streaming, true);
      assert.equal(untouched?.meta?.finish_reason, undefined);
    } finally {
      unmarkGenerationBlockingOperation(admission.operationId);
      resetGenerationSessionsForTests();
      for (const owner of existingOwners) {
        unmarkStreaming(owner.conversationId, owner.generationId);
      }
      useSettings.setState({ maxConcurrentGenerations: priorLimit });
      configureGenerationCapacity(priorLimit);
      useConversations.setState({ byId: prior.byId, order: prior.order, activeId: prior.activeId });
    }
  });

  it('does not truncate Retry history when capacity falls during preflight', async () => {
    const prior = useConversations.getState();
    const priorLimit = useSettings.getState().maxConcurrentGenerations;
    const activeIds = ['capacity-retry-live-a', 'capacity-retry-live-b'];
    const retryId = 'capacity-retry-target';
    const retryMessages: Conversation['messages'] = [
      { id: 'retry-user-1', role: 'user', content: 'first request', createdAt: 1 },
      { id: 'retry-assistant-1', role: 'assistant', content: 'first response', createdAt: 2 },
      { id: 'retry-user-2', role: 'user', content: 'second request', createdAt: 3 },
      { id: 'retry-assistant-2', role: 'assistant', content: 'second response', createdAt: 4 },
    ];
    const byId: Record<string, Conversation> = {
      [retryId]: {
        id: retryId,
        title: retryId,
        params: { ...DEFAULT_PARAMS },
        createdAt: 1,
        updatedAt: 1,
        messageCount: retryMessages.length,
        messages: retryMessages,
      },
    };
    for (const id of activeIds) {
      byId[id] = {
        id,
        title: id,
        params: { ...DEFAULT_PARAMS },
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
        messages: [{
          id: `${id}-assistant`,
          role: 'assistant',
          content: '',
          createdAt: 1,
          streaming: true,
        }],
      };
    }
    useConversations.setState({ byId, order: [retryId, ...activeIds], activeId: retryId });
    setGenerationCapacityForTests(3);
    const existingOwners = activeIds.map((id) => {
      const owner = markStreaming(id, `${id}-assistant`, `${id}-generation`);
      startGenerationSession({ ...owner, controller: new AbortController() });
      return owner;
    });
    const admission = markGenerationBlockingOperation(
      'chat_generation_admission',
      'retry before settings change',
      'capacity-retry-admission',
      retryId,
    );

    try {
      useSettings.setState({ maxConcurrentGenerations: 2 });
      configureGenerationCapacity(2);
      assert.throws(
        () => commitChatGenerationAdmission(admission.operationId, retryId),
        /All 2 generation slots are in use/,
      );

      assert.deepEqual(
        useConversations.getState().byId[retryId]?.messages.map((message) => message.id),
        retryMessages.map((message) => message.id),
      );
    } finally {
      unmarkGenerationBlockingOperation(admission.operationId);
      resetGenerationSessionsForTests();
      for (const owner of existingOwners) {
        unmarkStreaming(owner.conversationId, owner.generationId);
      }
      useSettings.setState({ maxConcurrentGenerations: priorLimit });
      configureGenerationCapacity(priorLimit);
      useConversations.setState({ byId: prior.byId, order: prior.order, activeId: prior.activeId });
    }
  });

  it('keeps an admission accepted when capacity falls after its commit boundary', async () => {
    const prior = useConversations.getState();
    const priorLimit = useSettings.getState().maxConcurrentGenerations;
    const ids = ['capacity-committed-a', 'capacity-committed-b', 'capacity-committed-c'];
    const byId: Record<string, Conversation> = {};
    for (const id of ids) {
      byId[id] = {
        id,
        title: id,
        params: { ...DEFAULT_PARAMS },
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
        messages: [{
          id: `${id}-assistant`,
          role: 'assistant',
          content: '',
          createdAt: 1,
          streaming: true,
        }],
      };
    }
    useConversations.setState({ byId, order: ids, activeId: ids[2] });
    setGenerationCapacityForTests(3);
    const existingOwners = ids.slice(0, 2).map((id) => {
      const owner = markStreaming(id, `${id}-assistant`, `${id}-generation`);
      startGenerationSession({ ...owner, controller: new AbortController() });
      return owner;
    });
    const admission = markGenerationBlockingOperation(
      'chat_generation_admission',
      'third committed admission',
      'capacity-committed-admission',
      ids[2],
    );

    try {
      commitChatGenerationAdmission(admission.operationId, ids[2]);
      useSettings.setState({ maxConcurrentGenerations: 2 });
      configureGenerationCapacity(2);

      const started = await handoffAndRegisterGenerationSession(
        admission.operationId,
        ids[2],
        `${ids[2]}-assistant`,
      );

      assert.equal(started.owner.conversationId, ids[2]);
      assert.deepEqual(
        activeGenerationSessions().map((session) => session.conversationId).sort(),
        [...ids].sort(),
      );
    } finally {
      unmarkGenerationBlockingOperation(admission.operationId);
      resetGenerationSessionsForTests();
      for (const id of ids) {
        const owner = getStreamingOwner(id);
        if (owner) unmarkStreaming(owner.conversationId, owner.generationId);
      }
      for (const owner of existingOwners) {
        unmarkStreaming(owner.conversationId, owner.generationId);
      }
      useSettings.setState({ maxConcurrentGenerations: priorLimit });
      configureGenerationCapacity(priorLimit);
      useConversations.setState({ byId: prior.byId, order: prior.order, activeId: prior.activeId });
    }
  });
});
