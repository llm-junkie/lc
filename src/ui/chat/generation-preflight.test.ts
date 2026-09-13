import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS, type Conversation, type ServerProfile } from '../../types.ts';

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

const [conversationModule, profileModule, preflightModule] = await Promise.all([
  import('../../store/conversations.ts'),
  import('../../modules/server-profiles/index.ts'),
  import('./generation-preflight.ts'),
]);
const {
  isGenerationBlockingOperationActive,
  isGenerationBlockingOperationOwner,
  markGenerationBlockingOperation,
  unmarkGenerationBlockingOperation,
  useConversations,
} = conversationModule;
const { useAppModels, useProfileStore } = profileModule;
const { resolveGenerationPreflight, runGenerationPreflightWithAdmission } = preflightModule;

function installValidPreflightFixture(prefix: string) {
  const priorConversations = useConversations.getState();
  const priorProfiles = useProfileStore.getState().profiles;
  const priorModels = useAppModels.getState();
  const profile = {
    id: `${prefix}-profile`,
    name: prefix,
    baseUrl: 'http://127.0.0.1:1',
    active: true,
    apiVariant: 'openai',
  } as ServerProfile;
  const conversation: Conversation = {
    id: `${prefix}-conversation`,
    title: prefix,
    serverId: profile.id,
    model: `${prefix}-model`,
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    messages: [{ id: `${prefix}-message`, role: 'user', content: 'retry', createdAt: 1 }],
  };
  useConversations.setState({
    byId: { [conversation.id]: conversation },
    order: [conversation.id],
    activeId: conversation.id,
    loadingMessageIds: new Set<string>(),
  });
  useProfileStore.setState({ profiles: [profile] });
  useAppModels.setState({
    models: [{
      id: conversation.model!,
      displayName: conversation.model!,
      profileId: profile.id,
      profileName: profile.name,
      apiVariant: 'openai',
      apiStyle: 'chat',
      capabilities: { tools: true },
    }],
  });

  return {
    conversation,
    profile,
    restore: () => {
      useConversations.setState({
        byId: priorConversations.byId,
        order: priorConversations.order,
        activeId: priorConversations.activeId,
        loadingMessageIds: priorConversations.loadingMessageIds,
      });
      useProfileStore.setState({ profiles: priorProfiles });
      useAppModels.setState({
        models: priorModels.models,
        loading: priorModels.loading,
        error: priorModels.error,
        _refreshing: priorModels._refreshing,
        serverHealth: priorModels.serverHealth,
      });
    },
  };
}

describe('Retry/Edit asynchronous preflight', () => {
  it('leaves history unchanged when mutable prerequisites change during the await', async () => {
    const fixture = installValidPreflightFixture('mutable-preflight');
    const admission = markGenerationBlockingOperation(
      'chat_generation_admission',
      'mutable preflight',
      'mutable-preflight-admission',
    );

    let release!: (key: string) => void;
    const pendingKey = new Promise<string>((resolve) => { release = resolve; });
    const before = JSON.stringify(useConversations.getState().byId);

    try {
      const pending = resolveGenerationPreflight({
        conversationId: fixture.conversation.id,
        messageId: fixture.conversation.messages[0].id,
        expectedProfile: fixture.profile,
        admissionOperationId: admission.operationId,
        resolveApiKey: () => pendingKey,
      });
      useProfileStore.setState({ profiles: [{ ...fixture.profile, active: false }] });
      release('resolved-key');

      assert.equal(await pending, null);
      assert.equal(JSON.stringify(useConversations.getState().byId), before);
      assert.equal(isGenerationBlockingOperationActive(), false);
    } finally {
      unmarkGenerationBlockingOperation(admission.operationId);
      fixture.restore();
    }
  });

  it("accepts the caller's current chat admission and retains it after valid preflight", async () => {
    const fixture = installValidPreflightFixture('owned-preflight');
    const admission = markGenerationBlockingOperation(
      'chat_generation_admission',
      'owned preflight',
      'owned-preflight-admission',
    );

    try {
      const result = await resolveGenerationPreflight({
        conversationId: fixture.conversation.id,
        messageId: fixture.conversation.messages[0].id,
        expectedProfile: fixture.profile,
        admissionOperationId: admission.operationId,
        resolveApiKey: async () => 'valid-key',
      });
      assert.equal(result?.conversation, fixture.conversation);
      assert.equal(result?.message.id, fixture.conversation.messages[0].id);
      assert.equal(result?.messageIndex, 0);
      assert.equal(result?.resolvedKey, 'valid-key');
      assert.equal(isGenerationBlockingOperationOwner(
        admission.operationId,
        'chat_generation_admission',
      ), true);
    } finally {
      unmarkGenerationBlockingOperation(admission.operationId);
      fixture.restore();
    }
  });

  it('keeps the owned admission when navigation changes during preflight', async () => {
    const fixture = installValidPreflightFixture('navigation-preflight');
    const admission = markGenerationBlockingOperation(
      'chat_generation_admission',
      'navigation preflight',
      'navigation-preflight-admission',
      fixture.conversation.id,
      fixture.profile.id,
    );
    let release!: (key: string) => void;
    const pendingKey = new Promise<string>((resolve) => { release = resolve; });

    try {
      const pending = resolveGenerationPreflight({
        conversationId: fixture.conversation.id,
        messageId: fixture.conversation.messages[0].id,
        expectedProfile: fixture.profile,
        admissionOperationId: admission.operationId,
        resolveApiKey: () => pendingKey,
      });
      useConversations.setState({ activeId: 'navigation-preflight-other' });
      release('resolved-key');

      const result = await pending;
      assert.equal(result?.conversation.id, fixture.conversation.id);
      assert.equal(isGenerationBlockingOperationOwner(
        admission.operationId,
        'chat_generation_admission',
      ), true);
    } finally {
      unmarkGenerationBlockingOperation(admission.operationId);
      fixture.restore();
    }
  });

  it('rejects a foreign blocking operation without resolving credentials or releasing it', async () => {
    const fixture = installValidPreflightFixture('foreign-preflight');
    const foreign = markGenerationBlockingOperation(
      'conversation_clone',
      'foreign clone',
      'foreign-preflight-operation',
    );
    let credentialCalls = 0;

    try {
      const result = await resolveGenerationPreflight({
        conversationId: fixture.conversation.id,
        messageId: fixture.conversation.messages[0].id,
        expectedProfile: fixture.profile,
        admissionOperationId: foreign.operationId,
        resolveApiKey: async () => {
          credentialCalls++;
          return 'must-not-resolve';
        },
      });
      assert.equal(result, null);
      assert.equal(credentialCalls, 0);
      assert.equal(isGenerationBlockingOperationOwner(
        foreign.operationId,
        'conversation_clone',
      ), true);
    } finally {
      unmarkGenerationBlockingOperation(foreign.operationId);
      fixture.restore();
    }
  });

  it('releases exactly once when credential preflight rejects', async () => {
    const fixture = installValidPreflightFixture('rejected-preflight');
    const admission = markGenerationBlockingOperation(
      'chat_generation_admission',
      'rejected preflight',
      'rejected-preflight-admission',
    );

    try {
      await assert.rejects(resolveGenerationPreflight({
        conversationId: fixture.conversation.id,
        messageId: fixture.conversation.messages[0].id,
        expectedProfile: fixture.profile,
        admissionOperationId: admission.operationId,
        resolveApiKey: async () => { throw new Error('credential unavailable'); },
      }), /credential unavailable/);
      assert.equal(isGenerationBlockingOperationActive(), false);

      let releaseCalls = 0;
      await assert.rejects(runGenerationPreflightWithAdmission(
        'counted-admission',
        async () => { throw new Error('preflight failed'); },
        () => {
          releaseCalls++;
          return true;
        },
      ), /preflight failed/);
      assert.equal(releaseCalls, 1);
    } finally {
      unmarkGenerationBlockingOperation(admission.operationId);
      fixture.restore();
    }
  });
});
