import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import 'fake-indexeddb/auto';

import { DEFAULT_PARAMS, type Conversation, type Message } from '../types.ts';
import {
  WHITEBOARD_EXPORT_FIXTURE,
  WHITEBOARD_IMPORT_ELIGIBILITY_FIXTURES,
  WHITEBOARD_LIFECYCLE_FIXTURES,
  WHITEBOARD_VERSION_ID_FIXTURES,
} from '../whiteboard/contract-fixtures.ts';
import {
  deleteConversation,
  loadAllMeta,
  loadMessages,
  runConversationDataTransaction,
  saveMeta,
  saveMessages,
} from './db.ts';
import {
  commitChatGenerationAdmission,
  finalizeStreamingOwner,
  getWhiteboardUiSnapshot,
  handoffGenerationBlockingOperationToStreaming,
  importWhiteboardPackageIntoEmptyConversation,
  isGenerationBlockingOperationActive,
  isStreamingOwner,
  markGenerationBlockingOperation,
  markStreaming,
  persistNonWhiteboardStreamingAssistant,
  recoverInterruptedToolRounds,
  unmarkGenerationBlockingOperation,
  unmarkStreaming,
  useConversations,
} from './conversations.ts';
import {
  addWhiteboardVersionInTransaction,
  applyModelWhiteboardContent,
  beginModelWhiteboardTurn,
  getModelWhiteboardWorking,
  getPendingUserWhiteboard,
  getWhiteboardVersion,
  discardModelWhiteboardTurn,
  formatWhiteboardVersionId,
  initializeWhiteboard,
  importWhiteboardPackageContentsInTransaction,
  listWhiteboardVersions,
  promotePendingUserWhiteboard,
  savePendingUserWhiteboard,
  settleModelWhiteboardTurn,
  subscribeWhiteboardStorageChanges,
  WHITEBOARD_CONTENT_MAX_BYTES,
  WhiteboardContentTooLargeError,
  WhiteboardGenerationClosedError,
  WhiteboardImportIneligibleError,
  WhiteboardVersionMissingError,
} from './whiteboard.ts';
import {
  admitWhiteboardModelTurn,
  applyWhiteboardModelMutation,
  persistWhiteboardUserSend,
  readWhiteboardModelTurn,
  recoverInterruptedWhiteboardState,
  settleWhiteboardModelTurnAndRepair,
  type WhiteboardModelAdmission,
} from './whiteboard-conversation.ts';
import { admitWhiteboardGeneration } from '../modules/chat-pipeline/whiteboard-turn-runtime.ts';
import { createWhiteboardGenerationLifecycle } from '../modules/chat-pipeline/whiteboard-lifecycle.ts';
import { whiteboard } from '../modules/tool-engine/whiteboard.ts';
import {
  decodeLcResultJson,
  duplicateToolCallIdNotice,
  encodeLcResultJson,
  repeatedToolCallNotice,
} from '../modules/tool-engine/tool-result-content.ts';
import type { ToolHandlerContext, WhiteboardToolService } from '../modules/tool-engine/types';
import {
  captureWhiteboardVisibleExport,
  createWhiteboardOverlayState,
  whiteboardOverlayReducer,
} from '../ui/tools/whiteboard-state.ts';
import {
  createWhiteboardPackage,
  readWhiteboardPackage,
} from '../ui/tools/whiteboard-package.ts';
import {
  createWhiteboardInitializationCoordinator,
  createWhiteboardToolsConfigChangeCoordinator,
} from '../ui/tools/whiteboard-toggle.ts';

const BASE_TIME = new Date(2026, 7, 22, 15, 0, 0, 0).getTime();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function conversation(id: string, messages: Message[] = []): Conversation {
  return {
    id,
    title: 'Lifecycle fixture',
    params: { ...DEFAULT_PARAMS },
    tools: {
      enabled: true,
      tool_grants: [],
      web_access_grants_initialized: true,
      file_io_enabled: false,
      shell_enabled: false,
      web_access_enabled: false,
      whiteboard_enabled: true,
      allowed_roots: [],
      dir_permissions: {},
      max_tool_rounds_per_turn: 128,
      max_tool_calls_per_batch: 16,
      sse_read_timeout_min: 5,
    },
    messages,
    messageCount: messages.length,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  };
}

function userMessage(id = 'user-1'): Message {
  return {
    id,
    role: 'user',
    content: 'Continue the work',
    createdAt: BASE_TIME + 10,
    sortOrder: 1,
  };
}

function assistantMessage(
  calls: NonNullable<Message['tool_calls']> = [],
  id = 'assistant-1',
): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    createdAt: BASE_TIME + 11,
    sortOrder: 2,
    tool_calls: calls,
  };
}

function whiteboardCall(id: string, action = 'read'): NonNullable<Message['tool_calls']>[number] {
  return {
    id,
    name: 'lc_whiteboard',
    arguments: JSON.stringify({ action }),
    created_at: BASE_TIME + 12,
  };
}

async function admittedFixture(label: string, calls: NonNullable<Message['tool_calls']> = []) {
  const conversationId = `whiteboard-lifecycle-${label}-${crypto.randomUUID()}`;
  const heads = await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
  const source = userMessage(`user-${crypto.randomUUID()}`);
  const assistant = assistantMessage(calls, `assistant-${crypto.randomUUID()}`);
  await saveMeta(conversation(conversationId, [source, assistant]));
  const admission = await admitWhiteboardModelTurn({
    conversationId,
    generationId: 'generation-1',
    sourceUserMessage: source,
    assistantMessage: assistant,
  }, { now: () => BASE_TIME + 20 });
  return { conversationId, heads, admission, assistantMessageId: assistant.id };
}

describe('Whiteboard user-send boundary', () => {
  it('promotes, pins, clears, and persists the user message atomically', async () => {
    const conversationId = `whiteboard-send-${crypto.randomUUID()}`;
    const heads = await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
    await savePendingUserWhiteboard(conversationId, '# Pending user content', {
      now: () => BASE_TIME + 1,
    });
    const message = userMessage('send-user');
    const metadata = conversation(conversationId, [message]);
    const boundary = await persistWhiteboardUserSend({
      conversationId,
      message,
      whiteboardEnabled: true,
      metadata,
    }, { now: () => BASE_TIME + 2 });

    assert.equal(boundary.initialized, true);
    assert.equal(boundary.promotion?.changed, true);
    assert.notEqual(boundary.message.user_board, heads.user.id);
    assert.equal(await getPendingUserWhiteboard(conversationId), null);
    assert.equal((await loadMessages(conversationId))[0]?.user_board, boundary.message.user_board);
    const retained = await getWhiteboardVersion(conversationId, boundary.message.user_board!);
    assert.equal(retained?.content, '# Pending user content');
    assert.equal(retained?.sourceMessageId, message.id);

    const repeated = await persistWhiteboardUserSend({
      conversationId,
      message: boundary.message,
      whiteboardEnabled: true,
    }, { now: () => BASE_TIME + 3 });
    assert.equal(repeated.message.user_board, boundary.message.user_board);
    assert.equal(repeated.promotion?.changed, false);
    assert.equal((await listWhiteboardVersions(conversationId, 'user')).length, 2);
  });

  it('clears an unchanged pending copy without creating a version', async () => {
    const conversationId = `whiteboard-send-same-${crypto.randomUUID()}`;
    const heads = await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
    await savePendingUserWhiteboard(conversationId, '', { now: () => BASE_TIME + 1 });
    const boundary = await persistWhiteboardUserSend({
      conversationId,
      message: userMessage('same-user'),
      whiteboardEnabled: true,
    }, { now: () => BASE_TIME + 2 });

    assert.equal(boundary.message.user_board, heads.user.id);
    assert.equal(boundary.promotion?.changed, false);
    assert.equal(boundary.promotion?.hadPendingCopy, true);
    assert.equal(await getPendingUserWhiteboard(conversationId), null);
    assert.equal((await listWhiteboardVersions(conversationId, 'user')).length, 1);
  });

  it('preserves pending state for disabled and never-initialized sends', async () => {
    for (const [label, enabled] of [['disabled', false], ['uninitialized', true]] as const) {
      const conversationId = `whiteboard-send-${label}-${crypto.randomUUID()}`;
      if (!enabled) await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
      await savePendingUserWhiteboard(conversationId, `# ${label}`, { now: () => BASE_TIME + 1 });
      const boundary = await persistWhiteboardUserSend({
        conversationId,
        message: userMessage(`${label}-user`),
        whiteboardEnabled: enabled,
      }, { now: () => BASE_TIME + 2 });

      assert.equal(boundary.message.user_board, undefined);
      assert.equal(boundary.promotion, null);
      assert.equal((await getPendingUserWhiteboard(conversationId))?.content, `# ${label}`);
      assert.equal((await loadMessages(conversationId))[0]?.user_board, undefined);
    }
  });

  it('rolls back promotion, pending deletion, and message write together', async () => {
    const conversationId = `whiteboard-send-rollback-${crypto.randomUUID()}`;
    await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
    await savePendingUserWhiteboard(conversationId, '# Must survive rollback', {
      now: () => BASE_TIME + 1,
    });
    const message = userMessage('rollback-user');
    const invalidMetadata = {
      ...conversation(conversationId, [message]),
      params: { unsupported: 1n },
    } as unknown as Conversation;

    await assert.rejects(
      persistWhiteboardUserSend({
        conversationId,
        message,
        whiteboardEnabled: true,
        metadata: invalidMetadata,
      }, { now: () => BASE_TIME + 2 }),
      /BigInt/,
    );
    assert.deepEqual(await loadMessages(conversationId), []);
    assert.equal(
      (await getPendingUserWhiteboard(conversationId))?.content,
      '# Must survive rollback',
    );
    assert.equal((await listWhiteboardVersions(conversationId, 'user')).length, 1);
  });

  it('awaits durability before publishing appendUserMessage to Zustand', async () => {
    const conversationId = `whiteboard-store-send-${crypto.randomUUID()}`;
    await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
    await savePendingUserWhiteboard(conversationId, '# Store pending', {
      now: () => BASE_TIME + 1,
    });
    const metadata = conversation(conversationId);
    await saveMeta(metadata);
    await useConversations.getState().hydrate();
    const prior = useConversations.getState();
    useConversations.setState((state) => ({
      byId: { ...state.byId, [conversationId]: metadata },
      order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
    }));

    try {
      const appended = await useConversations.getState().appendUserMessage(conversationId, {
        role: 'user',
        content: 'Persist before publish',
      });
      assert.ok(appended?.user_board);
      assert.equal(
        useConversations.getState().byId[conversationId].messages[0]?.user_board,
        appended.user_board,
      );
      assert.equal((await loadMessages(conversationId))[0]?.user_board, appended.user_board);
      assert.equal(await getPendingUserWhiteboard(conversationId), null);
    } finally {
      await deleteConversation(conversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('rejects an overlapping send and merges live metadata before publishing', async () => {
    const conversationId = `whiteboard-store-send-concurrent-${crypto.randomUUID()}`;
    const metadata = conversation(conversationId);
    metadata.tools = { ...metadata.tools!, whiteboard_enabled: false };
    await saveMeta(metadata);
    await useConversations.getState().hydrate();
    const prior = useConversations.getState();
    useConversations.setState((state) => ({
      byId: { ...state.byId, [conversationId]: metadata },
      order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
    }));

    try {
      const first = useConversations.getState().appendUserMessage(conversationId, {
        role: 'user',
        content: 'First and only durable send',
      });
      const overlapping = useConversations.getState().appendUserMessage(conversationId, {
        role: 'user',
        content: 'Must be rejected',
      });
      useConversations.getState().patchConversation(conversationId, {
        title: 'Renamed while send was awaiting durability',
        model: 'live-model-selection',
      });

      await assert.rejects(overlapping, /already being saved for this conversation/);
      const appended = await first;
      assert.ok(appended);
      const current = useConversations.getState().byId[conversationId];
      assert.equal(current.title, 'Renamed while send was awaiting durability');
      assert.equal(current.model, 'live-model-selection');
      assert.deepEqual(current.messages.map((message) => message.content), [
        'First and only durable send',
      ]);
      const stored = (await loadAllMeta()).find((item) => item.id === conversationId);
      assert.equal(stored?.title, current.title);
      assert.equal(stored?.model, current.model);
      assert.equal(stored?.messageCount, 1);
      assert.deepEqual(
        (await loadMessages(conversationId)).map((message) => message.content),
        ['First and only durable send'],
      );
    } finally {
      await deleteConversation(conversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('keeps an atomically committed send accepted when metadata reconciliation fails', async () => {
    const conversationId = `whiteboard-store-send-reconcile-failure-${crypto.randomUUID()}`;
    const metadata = conversation(conversationId);
    metadata.tools = { ...metadata.tools!, whiteboard_enabled: false };
    await saveMeta(metadata);
    await useConversations.getState().hydrate();
    const prior = useConversations.getState();
    useConversations.setState((state) => ({
      byId: { ...state.byId, [conversationId]: metadata },
      order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
    }));

    try {
      const pending = useConversations.getState().appendUserMessage(conversationId, {
        role: 'user',
        content: 'Primary send transaction commits',
      });
      useConversations.getState().patchConversation(conversationId, {
        params: { unsupported: 1n } as unknown as Conversation['params'],
      });

      const accepted = await pending;
      assert.ok(accepted, 'metadata-only reconciliation must not reject a committed send');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        (await loadMessages(conversationId)).some((message) => message.id === accepted.id),
        true,
      );
    } finally {
      await deleteConversation(conversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('does not resurrect a conversation deleted while a send is awaiting durability', async () => {
    const conversationId = `whiteboard-store-send-delete-${crypto.randomUUID()}`;
    const metadata = conversation(conversationId);
    metadata.tools = { ...metadata.tools!, whiteboard_enabled: false };
    await saveMeta(metadata);
    await useConversations.getState().hydrate();
    const prior = useConversations.getState();
    useConversations.setState((state) => ({
      byId: { ...state.byId, [conversationId]: metadata },
      order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
    }));

    try {
      const pending = useConversations.getState().appendUserMessage(conversationId, {
        role: 'user',
        content: 'Delete must win',
      });
      useConversations.getState().remove(conversationId);

      assert.equal(await pending, undefined);
      assert.equal(useConversations.getState().byId[conversationId], undefined);
      assert.equal(
        (await loadAllMeta()).some((item) => item.id === conversationId),
        false,
      );
      assert.deepEqual(await loadMessages(conversationId), []);
    } finally {
      await deleteConversation(conversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });
});

describe('conversation branch publication boundary', () => {
  it('rejects an overlapping replacement and preserves live metadata across the await', async () => {
    const conversationId = `whiteboard-store-branch-concurrent-${crypto.randomUUID()}`;
    const source = userMessage(`branch-user-${crypto.randomUUID()}`);
    const assistant = assistantMessage([], `branch-assistant-${crypto.randomUUID()}`);
    const metadata = conversation(conversationId, [source, assistant]);
    metadata.tools = { ...metadata.tools!, whiteboard_enabled: false };
    await saveMeta(metadata);
    await saveMessages(metadata.messages, conversationId);
    await useConversations.getState().hydrate();
    const prior = useConversations.getState();
    useConversations.setState((state) => ({
      byId: { ...state.byId, [conversationId]: metadata },
      order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
    }));

    try {
      const first = useConversations.getState().replaceFromMessage(
        conversationId,
        source.id,
        { content: 'Retried content' },
      );
      const overlapping = useConversations.getState().replaceFromMessage(
        conversationId,
        source.id,
        { content: 'Must be rejected' },
      );
      useConversations.getState().patchConversation(conversationId, {
        title: 'Renamed while branch was awaiting durability',
        model: 'branch-live-model',
      });

      await assert.rejects(overlapping, /already being saved for this conversation/);
      assert.equal(await first, true);
      const current = useConversations.getState().byId[conversationId];
      assert.equal(current.title, 'Renamed while branch was awaiting durability');
      assert.equal(current.model, 'branch-live-model');
      assert.deepEqual(current.messages.map((message) => message.content), ['Retried content']);
      const stored = (await loadAllMeta()).find((item) => item.id === conversationId);
      assert.equal(stored?.title, current.title);
      assert.equal(stored?.model, current.model);
      assert.equal(stored?.messageCount, 1);
      assert.deepEqual(
        (await loadMessages(conversationId)).map((message) => message.content),
        ['Retried content'],
      );
    } finally {
      await deleteConversation(conversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('keeps an atomically committed branch accepted when metadata reconciliation fails', async () => {
    const conversationId = `whiteboard-store-branch-reconcile-failure-${crypto.randomUUID()}`;
    const source = userMessage(`branch-reconcile-user-${crypto.randomUUID()}`);
    const assistant = assistantMessage([], `branch-reconcile-assistant-${crypto.randomUUID()}`);
    const metadata = conversation(conversationId, [source, assistant]);
    metadata.tools = { ...metadata.tools!, whiteboard_enabled: false };
    await saveMeta(metadata);
    await saveMessages(metadata.messages, conversationId);
    await useConversations.getState().hydrate();
    const prior = useConversations.getState();
    useConversations.setState((state) => ({
      byId: { ...state.byId, [conversationId]: metadata },
      order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
    }));

    try {
      const pending = useConversations.getState().replaceFromMessage(
        conversationId,
        source.id,
        { content: 'Committed replacement' },
      );
      useConversations.getState().patchConversation(conversationId, {
        params: { unsupported: 1n } as unknown as Conversation['params'],
      });

      assert.equal(
        await pending,
        true,
        'metadata-only reconciliation must not reject a committed branch',
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(
        (await loadMessages(conversationId)).map((message) => message.content),
        ['Committed replacement'],
      );
    } finally {
      await deleteConversation(conversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('does not resurrect a conversation deleted while branch persistence is pending', async () => {
    const conversationId = `whiteboard-store-branch-delete-${crypto.randomUUID()}`;
    const source = userMessage(`branch-delete-user-${crypto.randomUUID()}`);
    const assistant = assistantMessage([], `branch-delete-assistant-${crypto.randomUUID()}`);
    const metadata = conversation(conversationId, [source, assistant]);
    metadata.tools = { ...metadata.tools!, whiteboard_enabled: false };
    await saveMeta(metadata);
    await saveMessages(metadata.messages, conversationId);
    await useConversations.getState().hydrate();
    const prior = useConversations.getState();
    useConversations.setState((state) => ({
      byId: { ...state.byId, [conversationId]: metadata },
      order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
    }));

    try {
      const pending = useConversations.getState().replaceFromMessage(
        conversationId,
        source.id,
        { content: 'Deleted replacement' },
      );
      useConversations.getState().remove(conversationId);

      assert.equal(await pending, false);
      assert.equal(useConversations.getState().byId[conversationId], undefined);
      assert.equal(
        (await loadAllMeta()).some((item) => item.id === conversationId),
        false,
      );
      assert.deepEqual(await loadMessages(conversationId), []);
    } finally {
      await deleteConversation(conversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });
});

describe('Whiteboard overlay storage snapshot and package import', () => {
  for (const fixture of WHITEBOARD_IMPORT_ELIGIBILITY_FIXTURES) {
    it(`matches the Phase 0 import eligibility fixture: ${fixture.name}`, async () => {
      const conversationId = `whiteboard-ui-eligibility-${fixture.name.replaceAll(' ', '-')}-${crypto.randomUUID()}`;
      const otherConversationId = `${conversationId}-other`;
      const heads = await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
      await saveMeta(conversation(conversationId));
      let streamingOwner: ReturnType<typeof markStreaming> | undefined;

      try {
        switch (fixture.name) {
          case 'changed model board':
            await beginModelWhiteboardTurn({
              conversationId,
              generationId: 'ui-changed-model-generation',
              assistantMessageId: 'ui-changed-model-assistant',
              initialVersionId: heads.model.id,
            }, { now: () => BASE_TIME + 1 });
            await applyModelWhiteboardContent({
              conversationId,
              generationId: 'ui-changed-model-generation',
              assistantMessageId: 'ui-changed-model-assistant',
              toolCallId: 'ui-changed-model-call',
              content: '# Changed model board',
            }, { now: () => BASE_TIME + 2 });
            await settleModelWhiteboardTurn({
              conversationId,
              generationId: 'ui-changed-model-generation',
              assistantMessageId: 'ui-changed-model-assistant',
            });
            break;
          case 'changed then cleared':
            await savePendingUserWhiteboard(conversationId, '# Changed user board', {
              now: () => BASE_TIME + 1,
            });
            await promotePendingUserWhiteboard(conversationId, 'ui-user-changed', {
              now: () => BASE_TIME + 2,
            });
            await savePendingUserWhiteboard(conversationId, '', {
              now: () => BASE_TIME + 3,
            });
            await promotePendingUserWhiteboard(conversationId, 'ui-user-cleared', {
              now: () => BASE_TIME + 4,
            });
            break;
          case 'pending user copy':
            await savePendingUserWhiteboard(conversationId, '', {
              now: () => BASE_TIME + 1,
            });
            break;
          case 'provisional model copy':
            await beginModelWhiteboardTurn({
              conversationId,
              generationId: 'ui-provisional-generation',
              assistantMessageId: 'ui-provisional-assistant',
              initialVersionId: heads.model.id,
            }, { now: () => BASE_TIME + 1 });
            break;
          case 'active generation in this conversation':
            streamingOwner = markStreaming(
              conversationId,
              'ui-active-assistant',
              'ui-active-generation',
            );
            break;
          case 'active generation in another conversation':
            streamingOwner = markStreaming(
              otherConversationId,
              'ui-other-active-assistant',
              'ui-other-active-generation',
            );
            break;
          case 'initial baselines':
            break;
          default:
            assert.fail(`Unhandled eligibility fixture: ${fixture.name}`);
        }

        const snapshot = await getWhiteboardUiSnapshot(conversationId);
        assert.equal(snapshot.importEligible, fixture.eligible);
        assert.equal(snapshot.modelVersions.at(-1)?.id, snapshot.modelHead?.id);
        assert.equal(snapshot.userVersions.at(-1)?.id, snapshot.userHead?.id);
        if (fixture.name === 'changed then cleared') {
          assert.equal(snapshot.userHead?.content, '');
          assert.equal(snapshot.userVersions.length, 3);
          assert.equal(snapshot.importEligible, false, 'retained history keeps import unavailable');
        }
        if (fixture.name === 'pending user copy') assert.ok(snapshot.pendingUser);
        if (fixture.name === 'provisional model copy') assert.ok(snapshot.provisionalModel);
      } finally {
        if (streamingOwner) {
          unmarkStreaming(streamingOwner.conversationId, streamingOwner.generationId);
        }
        await deleteConversation(conversationId);
        await deleteConversation(otherConversationId);
      }
    });
  }

  it('imports exact visible content under one lease with fresh collision-safe heads', async () => {
    const conversationId = `whiteboard-ui-import-${crypto.randomUUID()}`;
    const controlledNow = WHITEBOARD_VERSION_ID_FIXTURES.controlledNow;
    const metadata = conversation(conversationId);
    await saveMeta(metadata);
    const baselines = await initializeWhiteboard(conversationId, {
      now: () => controlledNow,
    });
    const modelMarkdown = WHITEBOARD_EXPORT_FIXTURE.entries['model.md'];
    const userMarkdown = WHITEBOARD_EXPORT_FIXTURE.entries['user.md'];
    const storageEvents: Array<string | null> = [];
    const unsubscribe = subscribeWhiteboardStorageChanges((changedConversationId) => {
      storageEvents.push(changedConversationId);
    });

    try {
      const imported = await importWhiteboardPackageIntoEmptyConversation(
        conversationId,
        { modelMarkdown, userMarkdown },
        { now: () => controlledNow },
      );
      assert.equal(
        imported.modelVersion.id,
        formatWhiteboardVersionId('model', controlledNow + 1),
      );
      assert.equal(
        imported.userVersion.id,
        formatWhiteboardVersionId('user', controlledNow + 1),
      );
      assert.notEqual(imported.modelVersion.id, baselines.model.id);
      assert.notEqual(imported.userVersion.id, baselines.user.id);
      assert.equal(imported.modelVersion.content, modelMarkdown);
      assert.equal(imported.userVersion.content, userMarkdown);
      assert.equal(imported.modelVersion.sourceMessageId, null);
      assert.equal(imported.userVersion.sourceMessageId, null);
      assert.equal(imported.modelVersion.sequence, 3);
      assert.equal(imported.userVersion.sequence, 4);
      assert.ok(storageEvents.includes(null), 'cross-table commit invalidates live overlay reads');

      const snapshot = await getWhiteboardUiSnapshot(conversationId);
      assert.equal(snapshot.modelVersions.length, 2);
      assert.equal(snapshot.userVersions.length, 2);
      assert.equal(snapshot.modelHead?.id, imported.modelVersion.id);
      assert.equal(snapshot.userHead?.id, imported.userVersion.id);
      assert.equal(snapshot.modelHead?.content, modelMarkdown);
      assert.equal(snapshot.userHead?.content, userMarkdown);
      assert.equal(snapshot.pendingUser, null);
      assert.equal(snapshot.provisionalModel, null);
      assert.equal(snapshot.importEligible, false);
      assert.equal(isGenerationBlockingOperationActive(), false);
    } finally {
      unsubscribe();
      await deleteConversation(conversationId);
    }
  });

  it('completes the visible export, empty-board import, and explicit read-and-continue handoff', async () => {
    const conversationId = `whiteboard-handoff-${crypto.randomUUID()}`;
    const modelSummary = [
      '# Session handoff',
      '',
      'Implementation is complete through Phase 4.',
      'Recheck D:/work/project before relying on the recorded test state.',
    ].join('\n');
    const priorUserBoard = '# User priorities\n\nPreserve unrelated work.';
    const updatedUserBoard = `${priorUserBoard}\n\nRun every repository gate before handoff.`;

    let overlayState = createWhiteboardOverlayState({ userMarkdown: priorUserBoard });
    overlayState = whiteboardOverlayReducer(overlayState, {
      type: 'begin-user-edit',
      markdown: priorUserBoard,
    });
    overlayState = whiteboardOverlayReducer(overlayState, {
      type: 'change-user-draft',
      markdown: updatedUserBoard,
    });
    const captured = captureWhiteboardVisibleExport(overlayState, {
      model: {
        current: { source: 'retained-current', markdown: modelSummary },
        history: [],
      },
      user: {
        current: { source: 'retained-current', markdown: priorUserBoard },
        history: [],
      },
    });
    assert.equal(captured.ok, true);
    if (!captured.ok) return;
    assert.deepEqual(captured.sources, { model: 'retained-current', user: 'raw-editor' });

    const archive = createWhiteboardPackage({
      modelMarkdown: captured.entries['model.md'],
      userMarkdown: captured.entries['user.md'],
    });
    const transferred = await readWhiteboardPackage({
      name: 'lc-whiteboard-2026-08-22-1430.zip',
      data: archive,
    });
    assert.deepEqual(transferred, {
      modelMarkdown: modelSummary,
      userMarkdown: updatedUserBoard,
    });
    assert.deepEqual(Object.keys(transferred).sort(), ['modelMarkdown', 'userMarkdown']);

    await saveMeta(conversation(conversationId));
    await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
    try {
      const imported = await importWhiteboardPackageIntoEmptyConversation(
        conversationId,
        transferred,
        { now: () => BASE_TIME + 1 },
      );
      const source = userMessage(`handoff-user-${crypto.randomUUID()}`);
      source.content = 'Read the imported Whiteboard and continue from its recorded state.';
      const assistant = assistantMessage([], `handoff-assistant-${crypto.randomUUID()}`);
      const metadata = conversation(conversationId, [source, assistant]);
      const sendBoundary = await persistWhiteboardUserSend({
        conversationId,
        message: source,
        whiteboardEnabled: true,
        metadata,
      }, { now: () => BASE_TIME + 2 });
      const admission = await admitWhiteboardModelTurn({
        conversationId,
        generationId: 'handoff-generation',
        sourceUserMessage: sendBoundary.message,
        assistantMessage: assistant,
      }, { now: () => BASE_TIME + 3 });

      const service: WhiteboardToolService = {
        read: async () => ({
          ok: true,
          value: await readWhiteboardModelTurn({
            conversationId,
            generationId: 'handoff-generation',
            assistantMessageId: assistant.id,
          }),
        }),
        replaceModel: async ({ content, toolCallId }) => {
          const applied = await applyWhiteboardModelMutation({
            conversationId,
            generationId: 'handoff-generation',
            assistantMessageId: assistant.id,
            toolCallId,
            content,
          });
          return {
            ok: true,
            value: {
              refs: applied.refs,
              changed: applied.mutation.changed,
              modelMarkdown: applied.mutation.working.content,
            },
          };
        },
      };
      const context = {
        sandbox: new Proxy({}, {
          get: () => assert.fail('the Whiteboard handoff read must not access Workspace'),
        }),
        config: {},
        signal: new AbortController().signal,
        identity: {
          groupId: 'handoff-generation',
          operationId: 'handoff-read-operation',
          modelToolCallId: 'handoff-read-call',
          conversationId,
        },
        whiteboard: service,
      } as unknown as ToolHandlerContext;
      const read = await whiteboard.run({ action: 'read' }, context);
      assert.deepEqual(read, {
        status: 'ok',
        data: {
          refs: admission.refs,
          user_markdown: updatedUserBoard,
          model_markdown: modelSummary,
        },
        issues: [],
        warnings: [],
      });

      const continuedMarkdown = `${modelSummary}\n\n## Continued in the receiving session`;
      const continueContext = {
        ...context,
        identity: {
          ...context.identity,
          operationId: 'handoff-continue-operation',
          modelToolCallId: 'handoff-continue-call',
        },
      } as ToolHandlerContext;
      const continued = await whiteboard.run({
        action: 'replace',
        content: continuedMarkdown,
      }, continueContext);
      assert.equal(continued.status, 'ok');
      if (!continued.data || !('changed' in continued.data)) {
        throw new Error('replace must return mutation data');
      }
      assert.equal(continued.data.changed, true);
      const reread = await whiteboard.run({ action: 'read' }, continueContext);
      assert.equal(reread.status, 'ok');
      if (!reread.data || !('model_markdown' in reread.data)) {
        throw new Error('read must return board content');
      }
      assert.equal(reread.data.model_markdown, continuedMarkdown);
      assert.equal(reread.data.user_markdown, updatedUserBoard);

      const target = conversation(conversationId);
      assert.deepEqual(target.tools?.allowed_roots, []);
      assert.deepEqual(target.tools?.tool_grants, []);
      assert.equal(imported.modelVersion.sourceToolCallId, null);
      assert.equal(imported.userVersion.sourceMessageId, null);
    } finally {
      await deleteConversation(conversationId);
    }
  });

  it('rejects concurrent imports and rechecks a stale eligible snapshot in the transaction', async () => {
    const concurrentId = `whiteboard-ui-import-concurrent-${crypto.randomUUID()}`;
    const recheckId = `whiteboard-ui-import-recheck-${crypto.randomUUID()}`;
    await saveMeta(conversation(concurrentId));
    await saveMeta(conversation(recheckId));
    await initializeWhiteboard(concurrentId, { now: () => BASE_TIME });
    await initializeWhiteboard(recheckId, { now: () => BASE_TIME + 10 });

    try {
      const first = importWhiteboardPackageIntoEmptyConversation(
        concurrentId,
        { modelMarkdown: '# First import', userMarkdown: '' },
        { now: () => BASE_TIME + 1 },
      );
      const overlapping = importWhiteboardPackageIntoEmptyConversation(
        concurrentId,
        { modelMarkdown: '# Overlapping import', userMarkdown: '' },
        { now: () => BASE_TIME + 2 },
      );
      assert.throws(
        () => markStreaming(
          concurrentId,
          'blocked-stream-assistant',
          'blocked-stream-generation',
        ),
        /current model or conversation operation/,
      );
      await assert.rejects(overlapping, /already active/);
      const accepted = await first;
      assert.equal(accepted.modelVersion.content, '# First import');
      assert.equal((await getWhiteboardUiSnapshot(concurrentId)).modelVersions.length, 2);

      assert.equal((await getWhiteboardUiSnapshot(recheckId)).importEligible, true);
      await savePendingUserWhiteboard(recheckId, '# Arrived after the UI snapshot');
      await assert.rejects(
        importWhiteboardPackageIntoEmptyConversation(
          recheckId,
          { modelMarkdown: '# Must not write', userMarkdown: '' },
          { now: () => BASE_TIME + 11 },
        ),
        WhiteboardImportIneligibleError,
      );
      const rechecked = await getWhiteboardUiSnapshot(recheckId);
      assert.equal(rechecked.modelVersions.length, 1);
      assert.equal(rechecked.userVersions.length, 1);
      assert.equal(rechecked.pendingUser?.content, '# Arrived after the UI snapshot');
    } finally {
      await deleteConversation(concurrentId);
      await deleteConversation(recheckId);
    }
  });

  it('rolls both imported heads back when the enclosing transaction fails', async () => {
    const conversationId = `whiteboard-ui-import-rollback-${crypto.randomUUID()}`;
    await saveMeta(conversation(conversationId));
    await initializeWhiteboard(conversationId, { now: () => BASE_TIME });

    try {
      await assert.rejects(
        runConversationDataTransaction('rw', async (tables) => {
          await importWhiteboardPackageContentsInTransaction(
            tables,
            conversationId,
            { modelMarkdown: '# Rolled back model', userMarkdown: '# Rolled back user' },
            BASE_TIME + 1,
          );
          throw new Error('force package import rollback');
        }),
        /force package import rollback/,
      );
      const snapshot = await getWhiteboardUiSnapshot(conversationId);
      assert.equal(snapshot.modelVersions.length, 1);
      assert.equal(snapshot.userVersions.length, 1);
      assert.equal(snapshot.modelHead?.content, '');
      assert.equal(snapshot.userHead?.content, '');
      assert.equal(snapshot.importEligible, true);
    } finally {
      await deleteConversation(conversationId);
    }
  });

  it('requires content and bounds pending user saves by exact UTF-8 bytes', async () => {
    const conversationId = `whiteboard-ui-user-save-${crypto.randomUUID()}`;
    await saveMeta(conversation(conversationId));
    await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
    const observed: Array<string | null> = [];
    const unsubscribe = subscribeWhiteboardStorageChanges((changedConversationId) => {
      observed.push(changedConversationId);
    });

    try {
      await assert.rejects(
        importWhiteboardPackageIntoEmptyConversation(
          conversationId,
          { modelMarkdown: '', userMarkdown: '' },
        ),
        WhiteboardImportIneligibleError,
      );
      assert.equal(isGenerationBlockingOperationActive(), false);
      await assert.rejects(
        savePendingUserWhiteboard(
          conversationId,
          'é'.repeat((WHITEBOARD_CONTENT_MAX_BYTES / 2) + 1),
        ),
        (error: unknown) => (
          error instanceof WhiteboardContentTooLargeError
          && error.actualBytes === WHITEBOARD_CONTENT_MAX_BYTES + 2
          && error.limitBytes === WHITEBOARD_CONTENT_MAX_BYTES
        ),
      );
      assert.equal((await getWhiteboardUiSnapshot(conversationId)).pendingUser, null);

      const exact = ' \r\n# Exact pending user content\n';
      await savePendingUserWhiteboard(conversationId, exact, { now: () => BASE_TIME + 1 });
      assert.equal((await getWhiteboardUiSnapshot(conversationId)).pendingUser?.content, exact);
      assert.ok(observed.includes(conversationId));
    } finally {
      unsubscribe();
      await deleteConversation(conversationId);
    }
  });
});

describe('Whiteboard model admission and mutation boundaries', () => {
  it('lets admission own the first durable streaming-assistant write', async () => {
    const conversationId = `whiteboard-admission-placeholder-${crypto.randomUUID()}`;
    await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
    const sourceBoundary = await persistWhiteboardUserSend({
      conversationId,
      message: userMessage(`placeholder-user-${crypto.randomUUID()}`),
      whiteboardEnabled: true,
    }, { now: () => BASE_TIME + 1 });
    const metadata = conversation(conversationId, [sourceBoundary.message]);
    await saveMeta(metadata);
    await useConversations.getState().hydrate();
    const prior = useConversations.getState();
    useConversations.setState((state) => ({
      byId: { ...state.byId, [conversationId]: metadata },
      order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
    }));

    try {
      const assistant = useConversations.getState().appendMessage(conversationId, {
        role: 'assistant',
        content: '',
        streaming: true,
      });
      assert.ok(assistant);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(
        (await loadMessages(conversationId)).map((message) => message.id),
        [sourceBoundary.message.id],
      );

      const admission = await admitWhiteboardModelTurn({
        conversationId,
        generationId: 'placeholder-generation',
        sourceUserMessage: sourceBoundary.message,
        assistantMessage: assistant,
      }, { now: () => BASE_TIME + 2 });
      const storedAssistant = (await loadMessages(conversationId))
        .find((message) => message.id === assistant.id);
      assert.deepEqual(storedAssistant?.whiteboard_refs, admission.refs);
    } finally {
      await deleteConversation(conversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('publishes only Whiteboard refs when the stream finalizes during admission', async () => {
    const conversationId = `whiteboard-admission-finalize-${crypto.randomUUID()}`;
    const heads = await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
    const source = userMessage(`finalize-source-${crypto.randomUUID()}`);
    const assistant: Message = {
      ...assistantMessage([], `finalize-assistant-${crypto.randomUUID()}`),
      streaming: true,
    };
    const metadata = conversation(conversationId, [source, assistant]);
    await saveMeta(metadata);
    const prior = useConversations.getState();
    useConversations.setState((state) => ({
      byId: { ...state.byId, [conversationId]: metadata },
      order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
    }));
    const owner = markStreaming(conversationId, assistant.id, 'finalize-during-admission');
    const admissionGate = deferred<WhiteboardModelAdmission>();

    try {
      const pendingAdmission = admitWhiteboardGeneration({
        conversationId,
        generationId: owner.generationId,
        assistantMessageId: owner.assistantMessageId,
      }, {
        admitModelTurn: async () => admissionGate.promise,
        initialize: async () => heads,
      });
      useConversations.getState().patchMessage(conversationId, source.id, {
        content: 'Live source content written after admission started',
        meta: { finish_reason: 'source-live-meta' },
      });
      assert.equal(finalizeStreamingOwner(conversationId, owner.generationId, {
        content: 'Terminal assistant content',
        meta: {
          finish_reason: 'stop',
          error_message: 'terminal metadata must survive admission publication',
        },
      }), true);

      const refs = {
        user_board: heads.user.id,
        model_initial_board: heads.model.id,
        model_latest_board: heads.model.id,
      };
      admissionGate.resolve({
        sourceUserMessage: { ...source, user_board: refs.user_board },
        assistantMessage: { ...assistant, whiteboard_refs: refs },
        refs,
        working: {
          conversationId,
          owner: 'model',
          content: '',
          updatedAt: BASE_TIME + 1,
          id: null,
          createdAt: null,
          initialVersionId: refs.model_initial_board,
          generationId: owner.generationId,
          assistantMessageId: owner.assistantMessageId,
          latestToolCallId: null,
        },
      });
      const lifecycle = await pendingAdmission;
      const current = useConversations.getState().byId[conversationId];
      const currentSource = current.messages.find((message) => message.id === source.id);
      const currentAssistant = current.messages.find((message) => message.id === assistant.id);
      assert.equal(currentSource?.content, 'Live source content written after admission started');
      assert.equal(currentSource?.meta?.finish_reason, 'source-live-meta');
      assert.equal(currentSource?.user_board, refs.user_board);
      assert.equal(currentAssistant?.content, 'Terminal assistant content');
      assert.equal(currentAssistant?.streaming, false);
      assert.equal(currentAssistant?.meta?.finish_reason, 'stop');
      assert.equal(
        currentAssistant?.meta?.error_message,
        'terminal metadata must survive admission publication',
      );
      assert.deepEqual(currentAssistant?.whiteboard_refs, refs);
      assert.equal(lifecycle.ordinaryResultsAllowed(), false);
    } finally {
      unmarkStreaming(conversationId, owner.generationId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await deleteConversation(conversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('fallback-pins the source, writes initial refs, and does not consume pending state', async () => {
    const conversationId = `whiteboard-admission-${crypto.randomUUID()}`;
    const heads = await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
    await savePendingUserWhiteboard(conversationId, '# Next turn only', {
      now: () => BASE_TIME + 1,
    });
    const source = userMessage();
    const assistant = assistantMessage();
    const admission = await admitWhiteboardModelTurn({
      conversationId,
      generationId: 'generation-1',
      sourceUserMessage: source,
      assistantMessage: assistant,
    }, { now: () => BASE_TIME + 2 });

    assert.deepEqual(admission.refs, {
      user_board: heads.user.id,
      model_initial_board: heads.model.id,
      model_latest_board: heads.model.id,
    });
    assert.equal(admission.sourceUserMessage.user_board, heads.user.id);
    assert.deepEqual(admission.assistantMessage.whiteboard_refs, admission.refs);
    assert.equal((await loadMessages(conversationId))[0]?.user_board, heads.user.id);
    assert.deepEqual((await loadMessages(conversationId))[1]?.whiteboard_refs, admission.refs);
    assert.equal((await getPendingUserWhiteboard(conversationId))?.content, '# Next turn only');
    assert.equal((await getModelWhiteboardWorking(conversationId))?.generationId, 'generation-1');

    const repeated = await admitWhiteboardModelTurn({
      conversationId,
      generationId: 'generation-1',
      sourceUserMessage: admission.sourceUserMessage,
      assistantMessage: admission.assistantMessage,
    }, { now: () => BASE_TIME + 3 });
    assert.deepEqual(repeated.refs, admission.refs);
  });

  it('reads the pinned user version and atomically advances model refs with receipts', async () => {
    const fixture = await admittedFixture('mutation');
    const initialRead = await readWhiteboardModelTurn({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
    });
    assert.equal(initialRead.userMarkdown, '');
    assert.equal(initialRead.modelMarkdown, '');

    const first = await applyWhiteboardModelMutation({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      toolCallId: 'call-1',
      content: '# First model value',
    }, { now: () => BASE_TIME + 21 });
    assert.equal(first.mutation.changed, true);
    assert.notEqual(first.refs.model_latest_board, fixture.heads.model.id);
    assert.equal((await getModelWhiteboardWorking(fixture.conversationId))?.latestToolCallId, 'call-1');
    assert.equal(
      (await loadMessages(fixture.conversationId))[1]?.whiteboard_refs?.model_latest_board,
      first.refs.model_latest_board,
    );

    const second = await applyWhiteboardModelMutation({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      toolCallId: 'call-2',
      content: '# Second model value',
    }, { now: () => BASE_TIME + 22 });
    assert.equal(second.refs.model_latest_board, first.refs.model_latest_board);
    const latestRead = await readWhiteboardModelTurn({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
    });
    assert.equal(latestRead.modelMarkdown, '# Second model value');
    assert.equal(latestRead.refs.model_latest_board, first.refs.model_latest_board);
    assert.equal((await getModelWhiteboardWorking(fixture.conversationId))?.latestToolCallId, 'call-2');

    const noOp = await applyWhiteboardModelMutation({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      toolCallId: 'call-noop',
      content: '# Second model value',
    }, { now: () => BASE_TIME + 23 });
    assert.equal(noOp.mutation.changed, false);
    assert.equal((await getModelWhiteboardWorking(fixture.conversationId))?.latestToolCallId, 'call-2');
  });

  it('fails reads on a missing pinned version without fabricating a replacement', async () => {
    const fixture = await admittedFixture('missing-user');
    await runConversationDataTransaction('rw', async (tables) => {
      await tables.whiteboardVersions.delete([fixture.conversationId, fixture.heads.user.id]);
    });
    await assert.rejects(
      readWhiteboardModelTurn({
        conversationId: fixture.conversationId,
        generationId: 'generation-1',
        assistantMessageId: fixture.assistantMessageId,
      }),
      WhiteboardVersionMissingError,
    );
    assert.equal(await getWhiteboardVersion(fixture.conversationId, fixture.heads.user.id), null);
    assert.equal((await listWhiteboardVersions(fixture.conversationId, 'user')).length, 0);
  });
});

describe('Whiteboard terminal settlement and receipt repair', () => {
  for (const lifecycleFixture of WHITEBOARD_LIFECYCLE_FIXTURES) {
    it(`matches the Phase 0 lifecycle fixture: ${lifecycleFixture.name}`, async () => {
      const caseId = crypto.randomUUID();
      const calls = lifecycleFixture.mutations.map((_, index) => (
        whiteboardCall(`fixture-call-${caseId}-${index}`, 'replace')
      ));
      const fixture = await admittedFixture(
        `contract-${lifecycleFixture.name.replaceAll(' ', '-')}`,
        calls,
      );
      let liveAssistant = fixture.admission.assistantMessage;
      const ordinaryResults: Message[] = [];

      if (lifecycleFixture.terminal !== 'settled_before_write') {
        for (const [index, content] of lifecycleFixture.mutations.entries()) {
          const mutation = await applyWhiteboardModelMutation({
            conversationId: fixture.conversationId,
            generationId: 'generation-1',
            assistantMessageId: fixture.assistantMessageId,
            toolCallId: calls[index].id,
            content,
          }, { now: () => BASE_TIME + 100 + index });
          liveAssistant = { ...liveAssistant, whiteboard_refs: mutation.refs };
          ordinaryResults.push({
            id: `fixture-result-${caseId}-${index}`,
            role: 'tool',
            content: JSON.stringify({
              status: 'ok',
              data: {
                changed: mutation.mutation.changed,
                model_bytes: new TextEncoder().encode(content).byteLength,
                refs: mutation.refs,
              },
              issues: [],
              warnings: [],
            }),
            createdAt: BASE_TIME + 110 + index,
            sortOrder: index + 3,
            tool_call_id: calls[index].id,
            tool_is_error: false,
          });
        }
      }

      const reason = lifecycleFixture.terminal === 'timeout'
        ? 'timeout'
        : lifecycleFixture.terminal === 'aborted'
          ? 'aborted'
          : 'generation_ended';
      const terminal = await settleWhiteboardModelTurnAndRepair({
        conversationId: fixture.conversationId,
        generationId: 'generation-1',
        assistantMessageId: fixture.assistantMessageId,
        messages: [
          fixture.admission.sourceUserMessage,
          liveAssistant,
          ...ordinaryResults,
        ],
        reason,
      }, { now: () => BASE_TIME + 200 });

      assert.equal(await getModelWhiteboardWorking(fixture.conversationId), null);
      assert.equal(
        (await listWhiteboardVersions(fixture.conversationId, 'model')).length - 1,
        lifecycleFixture.retained,
      );

      if (lifecycleFixture.terminal === 'settled_before_write') {
        await assert.rejects(
          applyWhiteboardModelMutation({
            conversationId: fixture.conversationId,
            generationId: 'generation-1',
            assistantMessageId: fixture.assistantMessageId,
            toolCallId: calls[0].id,
            content: lifecycleFixture.mutations[0],
          }, { now: () => BASE_TIME + 201 }),
          WhiteboardGenerationClosedError,
        );
        assert.equal(
          (await listWhiteboardVersions(fixture.conversationId, 'model')).length - 1,
          lifecycleFixture.retained,
        );
      }

      const retainedHead = (await listWhiteboardVersions(fixture.conversationId, 'model')).at(-1);
      assert.ok(retainedHead);
      const nextSource = userMessage(`next-user-${caseId}`);
      nextSource.sortOrder = terminal.messages.length + 1;
      const nextAssistant = assistantMessage([], `next-assistant-${caseId}`);
      nextAssistant.sortOrder = terminal.messages.length + 2;
      const nextAdmission = await admitWhiteboardModelTurn({
        conversationId: fixture.conversationId,
        generationId: `next-generation-${caseId}`,
        sourceUserMessage: nextSource,
        assistantMessage: nextAssistant,
      }, { now: () => BASE_TIME + 300 });
      assert.equal(nextAdmission.refs.model_initial_board, retainedHead.id);
      assert.equal(nextAdmission.refs.model_latest_board, retainedHead.id);
      assert.equal(await discardModelWhiteboardTurn({
        conversationId: fixture.conversationId,
        generationId: `next-generation-${caseId}`,
        assistantMessageId: nextAssistant.id,
      }), true);
    });
  }

  it('uses authoritative live messages, retains once, and synthesizes compact success', async () => {
    const completed = whiteboardCall('completed-call');
    const committed = whiteboardCall('committed-call', 'replace');
    const fixture = await admittedFixture('terminal-success', [completed, committed]);
    const mutation = await applyWhiteboardModelMutation({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      toolCallId: committed.id,
      content: '# Durable receipt truth',
    }, { now: () => BASE_TIME + 21 });
    const liveAssistant: Message = {
      ...fixture.admission.assistantMessage,
      whiteboard_refs: mutation.refs,
    };
    const completedResult: Message = {
      id: 'completed-result',
      role: 'tool',
      content: '{"status":"ok","data":{"unchanged":true}}',
      createdAt: BASE_TIME + 22,
      sortOrder: 3,
      tool_call_id: completed.id,
      tool_is_error: false,
    };
    // Deliberately leave the completed result out of IndexedDB. The live array
    // is authoritative and must prevent a false repair row.
    const terminal = await settleWhiteboardModelTurnAndRepair({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      messages: [fixture.admission.sourceUserMessage, liveAssistant, completedResult],
      reason: 'generation_ended',
    }, { now: () => BASE_TIME + 23 });

    assert.equal(terminal.settlement.settledNow, true);
    assert.deepEqual(terminal.repairedCallIds, [committed.id]);
    assert.equal(await getModelWhiteboardWorking(fixture.conversationId), null);
    const models = await listWhiteboardVersions(fixture.conversationId, 'model');
    assert.equal(models.length, 2);
    assert.equal(models.at(-1)?.content, '# Durable receipt truth');
    const repaired = terminal.messages.find((message) => message.tool_call_id === committed.id);
    assert.equal(repaired?.tool_is_error, false);
    const envelope = JSON.parse(repaired?.content ?? '{}');
    assert.equal(envelope.status, 'ok');
    assert.equal(envelope.data.changed, true);
    assert.equal(envelope.data.model_bytes, new TextEncoder().encode('# Durable receipt truth').byteLength);
    assert.deepEqual(envelope.data.refs, terminal.messages[1]?.whiteboard_refs);
    assert.deepEqual(envelope.warnings, [
      'LC applied this whiteboard change before the generation ended.',
    ]);
    assert.equal(
      terminal.messages.filter((message) => message.tool_call_id === completed.id).length,
      1,
    );
    assert.equal((await loadMessages(fixture.conversationId)).length, 4);
    assert.equal(
      await runConversationDataTransaction('r', async (tables) => (
        await tables.conversationsMeta.get(fixture.conversationId)
      )?.messageCount),
      4,
    );

    const repeated = await settleWhiteboardModelTurnAndRepair({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      messages: terminal.messages,
      reason: 'generation_ended',
    }, { now: () => BASE_TIME + 24 });
    assert.equal(repeated.settlement.settledNow, false);
    assert.deepEqual(repeated.repairedCallIds, []);
    assert.equal((await listWhiteboardVersions(fixture.conversationId, 'model')).length, 2);

    await assert.rejects(
      applyWhiteboardModelMutation({
        conversationId: fixture.conversationId,
        generationId: 'generation-1',
        assistantMessageId: fixture.assistantMessageId,
        toolCallId: 'late-call',
        content: '# Too late',
      }),
      WhiteboardGenerationClosedError,
    );
  });

  it('checkpoints an ordinary live success even when no repair or ref patch is needed', async () => {
    const call = whiteboardCall('ordinary-success', 'replace');
    const fixture = await admittedFixture('terminal-checkpoint', [call]);
    const mutation = await applyWhiteboardModelMutation({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      toolCallId: call.id,
      content: '# Already returned normally',
    }, { now: () => BASE_TIME + 21 });
    const result: Message = {
      id: `ordinary-result-${crypto.randomUUID()}`,
      role: 'tool',
      content: JSON.stringify({
        status: 'ok',
        data: { changed: true, model_bytes: 27, refs: mutation.refs },
        issues: [],
        warnings: [],
      }),
      createdAt: BASE_TIME + 22,
      sortOrder: 3,
      tool_call_id: call.id,
      tool_is_error: false,
    };
    const terminal = await settleWhiteboardModelTurnAndRepair({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      messages: [
        fixture.admission.sourceUserMessage,
        { ...fixture.admission.assistantMessage, whiteboard_refs: mutation.refs },
        result,
      ],
      reason: 'generation_ended',
    }, { now: () => BASE_TIME + 23 });

    assert.deepEqual(terminal.repairedCallIds, []);
    assert.equal(
      (await loadMessages(fixture.conversationId)).some((message) => message.id === result.id),
      true,
    );
    assert.equal(
      await runConversationDataTransaction('r', async (tables) => (
        await tables.conversationsMeta.get(fixture.conversationId)
      )?.messageCount),
      3,
    );
  });

  for (const commitFirst of [false, true]) {
    it(`keeps storage and repaired results consistent when closure ${commitFirst ? 'follows commit' : 'precedes queued mutation'}`, async () => {
      const call = whiteboardCall('queued-storage-mutation', 'replace');
      const fixture = await admittedFixture('queued-storage-boundary', [call]);
      const address = {
        conversationId: fixture.conversationId,
        generationId: 'generation-1',
        assistantMessageId: fixture.assistantMessageId,
      };
      const committed = Promise.withResolvers<void>();
      const releaseResult = Promise.withResolvers<void>();
      let writes = 0;
      const lifecycle = createWhiteboardGenerationLifecycle({
        isActive: () => true,
        read: async () => ({ ok: true, value: await readWhiteboardModelTurn(address) }),
        replaceModel: async ({ content, toolCallId }) => {
          writes += 1;
          const mutation = await applyWhiteboardModelMutation({ ...address, content, toolCallId });
          committed.resolve();
          await releaseResult.promise;
          return {
            ok: true,
            value: { refs: mutation.refs, changed: mutation.mutation.changed, modelMarkdown: content },
          };
        },
        settle: async (reason) => {
          await settleWhiteboardModelTurnAndRepair({
            ...address,
            messages: await loadMessages(fixture.conversationId),
            reason,
          });
        },
      });
      try {
        const write = lifecycle.service.replaceModel({
          content: '# Committed before result',
          toolCallId: call.id,
          signal: new AbortController().signal,
        });
        if (commitFirst) {
          await committed.promise;
          const working = await getModelWhiteboardWorking(fixture.conversationId);
          assert.equal(working?.latestToolCallId, call.id);
          assert.equal(working?.content, '# Committed before result');
          const assistant = (await loadMessages(fixture.conversationId))
            .find((message) => message.id === fixture.assistantMessageId);
          assert.equal(assistant?.whiteboard_refs?.model_latest_board, working?.id);
        }
        const settlement = lifecycle.settle('aborted');
        assert.equal(lifecycle.ordinaryResultsAllowed(), false);
        releaseResult.resolve();
        assert.deepEqual(await write, { ok: false, code: 'aborted' });
        assert.equal(await settlement, true);
        assert.equal(await lifecycle.settle('timeout'), true);
        assert.equal(writes, commitFirst ? 1 : 0);
        assert.equal(await getModelWhiteboardWorking(fixture.conversationId), null);
        const retained = await listWhiteboardVersions(fixture.conversationId, 'model');
        assert.equal(retained.length, commitFirst ? 2 : 1);
        const messages = await loadMessages(fixture.conversationId);
        const results = messages.filter((message) => message.tool_call_id === call.id);
        assert.equal(results.length, 1);
        const result = JSON.parse(results[0].content);
        assert.equal(result.status, commitFirst ? 'ok' : 'aborted');
        if (commitFirst) {
          assert.equal(retained.at(-1)?.content, '# Committed before result');
          assert.equal(result.data.refs.model_latest_board, retained.at(-1)?.id);
          assert.match(result.warnings[0], /applied this whiteboard change/);
        } else {
          assert.match(result.issues[0].message, /No whiteboard change was applied/);
        }
        assert.deepEqual(await lifecycle.service.replaceModel({
          content: '# Late',
          toolCallId: 'late-storage-mutation',
          signal: new AbortController().signal,
        }), { ok: false, code: 'aborted' });
        assert.equal(writes, commitFirst ? 1 : 0);
      } finally {
        releaseResult.resolve();
        await deleteConversation(fixture.conversationId);
      }
    });
  }
  it('preserves recognized notices and ordinary output during receipt settlement', async () => {
    const call = whiteboardCall('framed-mutation', 'replace');
    const fixture = await admittedFixture('framed-settlement', [call]);
    const mutation = await applyWhiteboardModelMutation({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      toolCallId: call.id,
      content: '# Framed mutation',
    }, { now: () => BASE_TIME + 21 });
    const notices = [duplicateToolCallIdNotice(call.id, 'same_batch')];
    const ordinary: Message = {
      id: 'framed-ordinary-result',
      role: 'tool',
      createdAt: BASE_TIME + 22,
      tool_call_id: call.id,
      tool_is_error: false,
      content: encodeLcResultJson({
        status: 'ok',
        data: { changed: true, refs: mutation.refs, model_bytes: 17 },
        issues: [],
        warnings: [],
      }, notices),
    };
    try {
      const terminal = await settleWhiteboardModelTurnAndRepair({
        conversationId: fixture.conversationId,
        generationId: 'generation-1',
        assistantMessageId: fixture.assistantMessageId,
        messages: [
          fixture.admission.sourceUserMessage,
          { ...fixture.admission.assistantMessage, whiteboard_refs: mutation.refs },
          ordinary,
        ],
        reason: 'generation_ended',
      });
      const persisted = (await loadMessages(fixture.conversationId))
        .find((message) => message.id === ordinary.id);
      assert.equal(terminal.messages.find((message) => message.id === ordinary.id)?.content, ordinary.content);
      assert.equal(persisted?.content, ordinary.content);
      assert.deepEqual(terminal.repairedCallIds, []);
      assert.equal(await getModelWhiteboardWorking(fixture.conversationId), null);
      assert.equal(terminal.settlement.retained?.content, '# Framed mutation');
    } finally {
      await deleteConversation(fixture.conversationId);
    }
  });
  it('atomically re-pins every success that observed a provisional ID advanced by collision', async () => {
    const earlyReadCall = whiteboardCall('ordinary-collision-early-read', 'read');
    const call = whiteboardCall('ordinary-collision-success', 'replace');
    const laterReadCall = whiteboardCall('ordinary-collision-later-read', 'read');
    const noOpCall = whiteboardCall('ordinary-collision-no-op', 'replace');
    const fixture = await admittedFixture('terminal-collision-repin', [
      earlyReadCall,
      call,
      laterReadCall,
      noOpCall,
    ]);
    const provisionalCreatedAt = BASE_TIME + 21;
    const mutation = await applyWhiteboardModelMutation({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      toolCallId: call.id,
      content: '# Collision-retained content',
    }, { now: () => provisionalCreatedAt });
    const provisionalId = mutation.refs.model_latest_board;
    assert.equal(provisionalId, formatWhiteboardVersionId('model', provisionalCreatedAt));

    // Simulate an immutable retained row claiming the provisional key after
    // the working copy was created. Settlement must retry the whole
    // transaction and make both assistant and ordinary-result refs agree.
    await runConversationDataTransaction('rw', async (tables) => {
      await addWhiteboardVersionInTransaction(tables, {
        conversationId: fixture.conversationId,
        id: provisionalId,
        owner: 'model',
        content: '# Existing collision row',
        createdAt: provisionalCreatedAt,
        sequence: 3,
        sourceMessageId: null,
        sourceToolCallId: null,
      });
    });

    const result: Message = {
      id: `ordinary-collision-result-${crypto.randomUUID()}`,
      role: 'tool',
      content: JSON.stringify({
        status: 'ok',
        data: {
          changed: true,
          model_bytes: 29,
          refs: mutation.refs,
          preserved_detail: 'ordinary output survives',
        },
        issues: [],
        warnings: ['ordinary warning survives'],
        preserved_top_level: 42,
      }),
      createdAt: BASE_TIME + 22,
      sortOrder: 3,
      tool_call_id: call.id,
      tool_is_error: false,
      tool_duration_ms: 17,
    };
    const successfulResult = (
      id: string,
      callId: string,
      data: Record<string, unknown>,
    ): Message => ({
      id,
      role: 'tool',
      content: JSON.stringify({ status: 'ok', data, issues: [], warnings: [] }),
      createdAt: BASE_TIME + 22,
      tool_call_id: callId,
      tool_is_error: false,
      tool_duration_ms: 1,
    });
    const earlyReadResult = successfulResult(
      `ordinary-collision-early-read-${crypto.randomUUID()}`,
      earlyReadCall.id,
      {
        refs: fixture.admission.refs,
        user_markdown: '',
        model_markdown: '',
      },
    );
    const laterReadResult = successfulResult(
      `ordinary-collision-later-read-${crypto.randomUUID()}`,
      laterReadCall.id,
      {
        refs: mutation.refs,
        user_markdown: '',
        model_markdown: '# Collision-retained content',
      },
    );
    const noOpResult = successfulResult(
      `ordinary-collision-no-op-${crypto.randomUUID()}`,
      noOpCall.id,
      {
        refs: mutation.refs,
        changed: false,
        model_bytes: 28,
      },
    );
    const stackedNotices = [
      duplicateToolCallIdNotice(laterReadCall.id, 'same_batch'),
      repeatedToolCallNotice('lc_whiteboard', 2),
    ];
    laterReadResult.content = encodeLcResultJson(JSON.parse(laterReadResult.content), stackedNotices);
    noOpResult.content = encodeLcResultJson(JSON.parse(noOpResult.content), [
      repeatedToolCallNotice('lc_whiteboard', 3),
    ]);
    const terminal = await settleWhiteboardModelTurnAndRepair({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      messages: [
        fixture.admission.sourceUserMessage,
        { ...fixture.admission.assistantMessage, whiteboard_refs: mutation.refs },
        earlyReadResult,
        result,
        laterReadResult,
        noOpResult,
      ],
      reason: 'generation_ended',
    });

    const retryId = formatWhiteboardVersionId('model', provisionalCreatedAt + 1);
    assert.equal(terminal.settlement.retained?.id, retryId);
    assert.deepEqual(terminal.repairedCallIds, [call.id, laterReadCall.id, noOpCall.id]);
    assert.equal(terminal.messages[1]?.whiteboard_refs?.model_latest_board, retryId);
    const repinned = terminal.messages.find((message) => message.id === result.id);
    assert.ok(repinned);
    const envelope = JSON.parse(repinned.content);
    assert.equal(envelope.data.refs.model_latest_board, retryId);
    assert.equal(envelope.data.preserved_detail, 'ordinary output survives');
    assert.deepEqual(envelope.warnings, ['ordinary warning survives']);
    assert.equal(envelope.preserved_top_level, 42);
    assert.equal(repinned.tool_duration_ms, 17);
    const repinnedLaterRead = terminal.messages.find(
      (message) => message.id === laterReadResult.id,
    );
    const repinnedNoOp = terminal.messages.find((message) => message.id === noOpResult.id);
    const preservedEarlyRead = terminal.messages.find(
      (message) => message.id === earlyReadResult.id,
    );
    const decodedRead = decodeLcResultJson(repinnedLaterRead?.content ?? '');
    assert.deepEqual(decodedRead?.notices, stackedNotices);
    assert.equal((decodedRead?.data as { data: { refs: { model_latest_board: string } } }).data.refs.model_latest_board, retryId);
    const decodedNoOp = decodeLcResultJson(repinnedNoOp?.content ?? '');
    assert.deepEqual(decodedNoOp?.notices, [repeatedToolCallNotice('lc_whiteboard', 3)]);
    assert.equal((decodedNoOp?.data as { data: { refs: { model_latest_board: string } } }).data.refs.model_latest_board, retryId);
    assert.equal(
      JSON.parse(preservedEarlyRead?.content ?? '{}').data.refs.model_latest_board,
      fixture.admission.refs.model_latest_board,
    );

    const stored = (await loadMessages(fixture.conversationId))
      .find((message) => message.id === result.id);
    assert.equal(JSON.parse(stored?.content ?? '{}').data.refs.model_latest_board, retryId);
    assert.equal(
      (await getWhiteboardVersion(fixture.conversationId, provisionalId))?.content,
      '# Existing collision row',
    );
    assert.equal(
      (await getWhiteboardVersion(fixture.conversationId, retryId))?.content,
      '# Collision-retained content',
    );

    const repeated = await settleWhiteboardModelTurnAndRepair({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      messages: terminal.messages,
      reason: 'generation_ended',
    });
    assert.deepEqual(repeated.repairedCallIds, []);
    assert.equal((await listWhiteboardVersions(fixture.conversationId, 'model')).length, 3);
  });

  it('replaces a contradictory abort result when the durable receipt proves commit', async () => {
    const call = whiteboardCall('racing-abort', 'replace');
    const fixture = await admittedFixture('terminal-racing-abort', [call]);
    const mutation = await applyWhiteboardModelMutation({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      toolCallId: call.id,
      content: '# Receipt outranks abort',
    }, { now: () => BASE_TIME + 21 });
    const abortResult: Message = {
      id: `abort-result-${crypto.randomUUID()}`,
      role: 'tool',
      content: JSON.stringify({ status: 'aborted', issues: [{ code: 'aborted' }] }),
      createdAt: BASE_TIME + 22,
      sortOrder: 3,
      tool_call_id: call.id,
      tool_is_error: true,
    };
    const terminal = await settleWhiteboardModelTurnAndRepair({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      messages: [
        fixture.admission.sourceUserMessage,
        { ...fixture.admission.assistantMessage, whiteboard_refs: mutation.refs },
        abortResult,
      ],
      reason: 'aborted',
    }, { now: () => BASE_TIME + 23 });

    assert.deepEqual(terminal.repairedCallIds, [call.id]);
    const repaired = terminal.messages.find((message) => message.id === abortResult.id);
    assert.equal(repaired?.tool_is_error, false);
    assert.equal(JSON.parse(repaired?.content ?? '{}').status, 'ok');
    assert.deepEqual(JSON.parse(repaired?.content ?? '{}').warnings, [
      'LC applied this whiteboard change before the generation ended.',
    ]);
  });

  it('merges an accepted checkpoint-lagging call and repairs timeout as explicitly unapplied', async () => {
    const fixture = await admittedFixture('terminal-timeout');
    const accepted = whiteboardCall('accepted-not-committed', 'replace');
    const terminal = await settleWhiteboardModelTurnAndRepair({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      messages: [
        fixture.admission.sourceUserMessage,
        fixture.admission.assistantMessage,
      ],
      acceptedCalls: [accepted],
      reason: 'timeout',
    }, { now: () => BASE_TIME + 21 });

    assert.equal(terminal.settlement.retained, null);
    assert.deepEqual(terminal.repairedCallIds, [accepted.id]);
    assert.ok(terminal.messages[1]?.tool_calls?.some((call) => call.id === accepted.id));
    const result = terminal.messages.find((message) => message.tool_call_id === accepted.id);
    assert.equal(result?.tool_is_error, true);
    const envelope = JSON.parse(result?.content ?? '{}');
    assert.equal(envelope.status, 'timeout');
    assert.equal(envelope.issues[0].code, 'timeout');
    assert.match(envelope.issues[0].message, /No whiteboard change was applied by this call/);
    assert.equal((await listWhiteboardVersions(fixture.conversationId, 'model')).length, 1);
  });

  it('repairs crash recovery from the receipt before generic unknown-side-effect repair', async () => {
    const call = whiteboardCall('recovery-receipt', 'replace');
    const fixture = await admittedFixture('receipt-recovery', [call]);
    await applyWhiteboardModelMutation({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      toolCallId: call.id,
      content: '# Recovered content',
    }, { now: () => BASE_TIME + 21 });
    const loaded = await loadMessages(fixture.conversationId);
    const recovery = await recoverInterruptedWhiteboardState(fixture.conversationId, loaded);

    assert.equal(recovery.settled, true);
    assert.deepEqual(recovery.repairedCallIds, [call.id]);
    const result = recovery.messages.find((message) => message.tool_call_id === call.id);
    assert.equal(result?.tool_is_error, false);
    assert.deepEqual(JSON.parse(result?.content ?? '{}').warnings, [
      'LC applied this whiteboard change before the generation ended.',
    ]);
    const generic = recoverInterruptedToolRounds(recovery.messages);
    assert.deepEqual(generic.repairedCallIds, []);
    assert.equal(generic.messages.length, recovery.messages.length);

    const repeated = await recoverInterruptedWhiteboardState(
      fixture.conversationId,
      recovery.messages,
    );
    assert.equal(repeated.settled, false);
    assert.deepEqual(repeated.repairedCallIds, []);
    assert.equal((await listWhiteboardVersions(fixture.conversationId, 'model')).length, 2);
  });

  it('fails closed when recovery finds an orphan whose initial model version is gone', async () => {
    const call = whiteboardCall('orphaned-receipt', 'replace');
    const fixture = await admittedFixture('missing-initial-recovery', [call]);
    await applyWhiteboardModelMutation({
      conversationId: fixture.conversationId,
      generationId: 'generation-1',
      assistantMessageId: fixture.assistantMessageId,
      toolCallId: call.id,
      content: '# Must not become a replacement history root',
    }, { now: () => BASE_TIME + 21 });
    await runConversationDataTransaction('rw', async (tables) => {
      await tables.whiteboardVersions.delete([
        fixture.conversationId,
        fixture.heads.model.id,
      ]);
    });

    const recovery = await recoverInterruptedWhiteboardState(
      fixture.conversationId,
      await loadMessages(fixture.conversationId),
    );
    assert.equal(recovery.settled, true);
    assert.equal(await getModelWhiteboardWorking(fixture.conversationId), null);
    assert.deepEqual(await listWhiteboardVersions(fixture.conversationId, 'model'), []);
    const result = recovery.messages.find((message) => message.tool_call_id === call.id);
    assert.equal(JSON.parse(result?.content ?? '{}').status, 'aborted');
    assert.deepEqual(recoverInterruptedToolRounds(recovery.messages).repairedCallIds, []);
  });
});

describe('generation admission durability and ownership', () => {
  it('durably creates a non-Whiteboard streaming assistant before provider work', async () => {
    const conversationId = `non-whiteboard-admission-${crypto.randomUUID()}`;
    const source = userMessage(`non-whiteboard-user-${crypto.randomUUID()}`);
    const assistant: Message = {
      ...assistantMessage([], `non-whiteboard-assistant-${crypto.randomUUID()}`),
      streaming: true,
    };
    const durableMetadata = conversation(conversationId, [source]);
    durableMetadata.tools = { ...durableMetadata.tools!, whiteboard_enabled: false };
    const liveMetadata: Conversation = {
      ...durableMetadata,
      messages: [source, assistant],
      messageCount: 2,
      updatedAt: BASE_TIME + 1,
    };
    await saveMeta(durableMetadata);
    await saveMessages([source], conversationId);
    await useConversations.getState().hydrate();
    const prior = useConversations.getState();
    useConversations.setState((state) => ({
      byId: { ...state.byId, [conversationId]: liveMetadata },
      order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
    }));
    const owner = markStreaming(conversationId, assistant.id, 'non-whiteboard-generation');

    try {
      assert.equal(
        (await loadMessages(conversationId)).some((message) => message.id === assistant.id),
        false,
      );
      await persistNonWhiteboardStreamingAssistant({
        conversationId,
        generationId: owner.generationId,
        assistantMessageId: owner.assistantMessageId,
      });
      const storedMessages = await loadMessages(conversationId);
      assert.deepEqual(storedMessages.map((message) => message.id), [source.id, assistant.id]);
      assert.equal(
        (await loadAllMeta()).find((item) => item.id === conversationId)?.messageCount,
        2,
      );

      const orchestratorSource = readFileSync(
        new URL('../modules/chat-pipeline/orchestrator.ts', import.meta.url),
        'utf8',
      );
      const persistenceCall = orchestratorSource.indexOf(
        'await persistNonWhiteboardStreamingAssistant({',
      );
      const activeRevalidation = orchestratorSource.indexOf(
        'if (signal.aborted || !generationIsActive(owner))',
        persistenceCall,
      );
      const providerSetup = orchestratorSource.indexOf(
        'llmCallRef.current = async',
        persistenceCall,
      );
      assert.notEqual(persistenceCall, -1);
      assert.match(
        orchestratorSource.slice(persistenceCall, activeRevalidation),
        /conversationId:\s*convId/,
      );
      assert.ok(persistenceCall < activeRevalidation);
      assert.ok(activeRevalidation < providerSetup);
    } finally {
      unmarkStreaming(conversationId, owner.generationId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await deleteConversation(conversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('blocks immediate Send until preserved-state Whiteboard re-enable publishes config', async () => {
    const conversationId = `whiteboard-reenable-admission-${crypto.randomUUID()}`;
    const pendingMarkdown = '# Pending before re-enable\n\nThis edit must be promoted by Send.';
    const prior = useConversations.getState();
    const initialized = await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
    await savePendingUserWhiteboard(conversationId, pendingMarkdown, {
      now: () => BASE_TIME + 1,
    });
    const enabledMetadata = conversation(conversationId);
    const disabledTools = {
      ...enabledMetadata.tools!,
      enabled: false,
      whiteboard_enabled: true,
    };
    const metadata: Conversation = { ...enabledMetadata, tools: disabledTools };
    await saveMeta(metadata);
    await useConversations.getState().hydrate();
    useConversations.setState((state) => ({
      byId: { ...state.byId, [conversationId]: metadata },
      order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
      activeId: conversationId,
    }));

    const initializationGate = deferred<void>();
    const toolsCoordinator = createWhiteboardToolsConfigChangeCoordinator();
    let initializationCalls = 0;
    const initializationCoordinator = createWhiteboardInitializationCoordinator({
      initialize: async (targetConversationId) => {
        initializationCalls += 1;
        await initializationGate.promise;
        return initializeWhiteboard(targetConversationId, { now: () => BASE_TIME + 2 });
      },
      acquire: (targetConversationId) => markGenerationBlockingOperation(
        'whiteboard_initialization',
        'Initialize Whiteboard storage',
        undefined,
        targetConversationId,
      ),
      release: unmarkGenerationBlockingOperation,
    });
    let current = disabledTools;
    let reenable: Promise<boolean> | null = null;
    const prematureAdmissionId = `premature-admission-${crypto.randomUUID()}`;
    const admittedSendId = `admitted-send-${crypto.randomUUID()}`;

    try {
      reenable = initializationCoordinator.run(
        conversationId,
        (initialize) => toolsCoordinator.apply({
          next: { ...disabledTools, enabled: true },
          getCurrent: () => current,
          initialize,
          commit: (accepted) => {
            assert.equal(
              isGenerationBlockingOperationActive(),
              true,
              'the lease must remain owned through config publication',
            );
            current = accepted;
            useConversations.getState().patchConversation(conversationId, { tools: accepted });
          },
        }),
      );

      assert.equal(initializationCoordinator.isActive(conversationId), true);
      assert.equal(isGenerationBlockingOperationActive(), true);
      assert.throws(
        () => markGenerationBlockingOperation(
          'chat_generation_admission',
          'Immediate Send during Whiteboard re-enable',
          prematureAdmissionId,
          conversationId,
        ),
        /Initialize Whiteboard storage is already active/,
      );
      assert.equal((await getPendingUserWhiteboard(conversationId))?.content, pendingMarkdown);

      await Promise.resolve();
      assert.equal(initializationCalls, 1);
      initializationGate.resolve();
      assert.equal(await reenable, true);
      assert.equal(initializationCoordinator.isActive(conversationId), false);
      assert.equal(isGenerationBlockingOperationActive(), false);
      assert.equal(current.enabled, true);
      assert.equal(
        useConversations.getState().byId[conversationId]?.tools?.whiteboard_enabled,
        true,
      );

      const sendAdmission = markGenerationBlockingOperation(
        'chat_generation_admission',
        'Send after Whiteboard re-enable',
        admittedSendId,
        conversationId,
      );
      const appended = await useConversations.getState().appendUserMessage(conversationId, {
        role: 'user',
        content: 'Continue with the pending board.',
      });
      assert.ok(appended?.user_board);
      assert.notEqual(appended?.user_board, initialized.user.id);
      assert.equal(
        (await getWhiteboardVersion(conversationId, appended!.user_board!))?.content,
        pendingMarkdown,
      );
      assert.equal(await getPendingUserWhiteboard(conversationId), null);
      assert.equal(unmarkGenerationBlockingOperation(sendAdmission.operationId), true);
    } finally {
      initializationGate.resolve();
      await reenable?.catch(() => undefined);
      unmarkGenerationBlockingOperation(prematureAdmissionId);
      unmarkGenerationBlockingOperation(admittedSendId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await deleteConversation(conversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('keeps config and structure locked, then atomically hands the exact lease to streaming', async () => {
    const conversationId = `chat-admission-lease-${crypto.randomUUID()}`;
    const otherConversationId = `chat-admission-other-${crypto.randomUUID()}`;
    const assistantId = `chat-admission-assistant-${crypto.randomUUID()}`;
    const metadata = conversation(conversationId, [
      userMessage(`chat-admission-user-${crypto.randomUUID()}`),
      assistantMessage([], assistantId),
    ]);
    const other = conversation(otherConversationId);
    const prior = useConversations.getState();
    useConversations.setState((state) => ({
      byId: {
        ...state.byId,
        [conversationId]: metadata,
        [otherConversationId]: other,
      },
      order: [
        conversationId,
        otherConversationId,
        ...state.order.filter((id) => id !== conversationId && id !== otherConversationId),
      ],
      activeId: conversationId,
    }));
    const operation = markGenerationBlockingOperation(
      'chat_generation_admission',
      'Send chat message',
      `chat-admission-operation-${crypto.randomUUID()}`,
      conversationId,
    );

    try {
      assert.throws(
        () => handoffGenerationBlockingOperationToStreaming(
          'wrong-operation-owner',
          conversationId,
          assistantId,
        ),
        /belongs to another operation/,
      );
      assert.equal(isGenerationBlockingOperationActive(), true);

      // Navigation is no longer a locked operation; configuration still is.
      useConversations.getState().setActive(otherConversationId);
      assert.equal(useConversations.getState().activeId, otherConversationId);
      useConversations.getState().setActive(conversationId);
      useConversations.getState().setModel(conversationId, 'must-not-change');
      useConversations.getState().setParams(conversationId, {
        ...metadata.params,
        temperature: 0.123,
      });
      useConversations.getState().remove(conversationId);
      assert.equal(await useConversations.getState().clearAll(), false);
      assert.equal(useConversations.getState().activeId, conversationId);
      assert.equal(useConversations.getState().byId[conversationId]?.model, metadata.model);
      assert.deepEqual(useConversations.getState().byId[conversationId]?.params, metadata.params);
      assert.ok(useConversations.getState().byId[otherConversationId]);

      commitChatGenerationAdmission(operation.operationId, conversationId);
      const owner = handoffGenerationBlockingOperationToStreaming(
        operation.operationId,
        conversationId,
        assistantId,
        'lease-handoff-generation',
      );
      assert.equal(isGenerationBlockingOperationActive(), false);
      assert.equal(isStreamingOwner(conversationId, owner.generationId), true);
      assert.equal(unmarkStreaming(conversationId, owner.generationId), true);
    } finally {
      unmarkGenerationBlockingOperation(operation.operationId);
      const ownerStillActive = isStreamingOwner(conversationId, 'lease-handoff-generation', true);
      if (ownerStillActive) unmarkStreaming(conversationId, 'lease-handoff-generation');
      await new Promise((resolve) => setTimeout(resolve, 0));
      await deleteConversation(conversationId);
      await deleteConversation(otherConversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });
});

describe('production Whiteboard generation runtime', () => {
  it('binds one pinned service through admission, sequential mutations, and terminal retention', async () => {
    const conversationId = `whiteboard-runtime-${crypto.randomUUID()}`;
    const heads = await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
    const source: Message = {
      ...userMessage(`runtime-user-${crypto.randomUUID()}`),
      user_board: heads.user.id,
    };
    const assistant: Message = {
      ...assistantMessage([], `runtime-assistant-${crypto.randomUUID()}`),
      streaming: true,
    };
    const metadata = conversation(conversationId, [source, assistant]);
    await saveMeta(metadata);
    const prior = useConversations.getState();
    useConversations.setState((state) => ({
      byId: { ...state.byId, [conversationId]: metadata },
      order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
      activeId: conversationId,
    }));
    const owner = markStreaming(conversationId, assistant.id, 'runtime-generation');

    try {
      const lifecycle = await admitWhiteboardGeneration({
        conversationId,
        generationId: owner.generationId,
        assistantMessageId: owner.assistantMessageId,
      });
      const signal = new AbortController().signal;
      const initial = await lifecycle.service.read({ signal });
      assert.equal(initial.ok, true);
      if (!initial.ok) return;
      assert.equal(initial.value.userMarkdown, '');
      assert.equal(initial.value.modelMarkdown, '');

      const calls = [
        whiteboardCall('runtime-call-1', 'replace'),
        whiteboardCall('runtime-call-2', 'replace'),
      ];
      useConversations.getState().patchMessage(conversationId, assistant.id, {
        tool_calls: calls,
      });
      for (const [index, content] of ['# First', '# Final'].entries()) {
        const result = await lifecycle.service.replaceModel({
          content,
          toolCallId: calls[index].id,
          signal,
        });
        assert.equal(result.ok, true);
        if (!result.ok) continue;
        useConversations.getState().appendMessage(conversationId, {
          role: 'tool',
          content: JSON.stringify({
            status: 'ok',
            data: {
              refs: result.value.refs,
              changed: result.value.changed,
              model_bytes: new TextEncoder().encode(content).byteLength,
            },
            issues: [],
            warnings: [],
          }),
          tool_call_id: calls[index].id,
          tool_is_error: false,
          tool_duration_ms: 1,
        });
      }

      assert.equal(finalizeStreamingOwner(conversationId, owner.generationId), true);
      assert.equal(await lifecycle.settle('generation_ended'), true);
      assert.equal(await getModelWhiteboardWorking(conversationId), null);
      const retained = await listWhiteboardVersions(conversationId, 'model');
      assert.equal(retained.length, 2);
      assert.equal(retained.at(-1)?.content, '# Final');
      assert.equal(retained.at(-1)?.sourceToolCallId, calls[1].id);
      const stored = await loadMessages(conversationId);
      assert.equal(stored.filter((message) => message.role === 'tool').length, 2);
      assert.equal(
        stored.find((message) => message.id === assistant.id)
          ?.whiteboard_refs?.model_latest_board,
        retained.at(-1)?.id,
      );
      assert.deepEqual(await lifecycle.service.replaceModel({
        content: '# Late',
        toolCallId: 'runtime-late-call',
        signal,
      }), { ok: false, code: 'aborted' });
    } finally {
      unmarkStreaming(conversationId, owner.generationId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await deleteConversation(conversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });

  it('repairs missing initialization once before production admission', async () => {
    const conversationId = `whiteboard-runtime-repair-${crypto.randomUUID()}`;
    const source = userMessage(`runtime-repair-user-${crypto.randomUUID()}`);
    const assistant: Message = {
      ...assistantMessage([], `runtime-repair-assistant-${crypto.randomUUID()}`),
      streaming: true,
    };
    const metadata = conversation(conversationId, [source, assistant]);
    await saveMeta(metadata);
    const prior = useConversations.getState();
    useConversations.setState((state) => ({
      byId: { ...state.byId, [conversationId]: metadata },
      order: [conversationId, ...state.order.filter((id) => id !== conversationId)],
      activeId: conversationId,
    }));
    const owner = markStreaming(conversationId, assistant.id, 'runtime-repair-generation');

    try {
      assert.deepEqual(await listWhiteboardVersions(conversationId), []);
      const lifecycle = await admitWhiteboardGeneration({
        conversationId,
        generationId: owner.generationId,
        assistantMessageId: owner.assistantMessageId,
      });

      const retained = await listWhiteboardVersions(conversationId);
      assert.equal(retained.length, 2);
      assert.equal(retained[0].owner, 'user');
      assert.equal(retained[0].sequence, 1);
      assert.equal(retained[1].owner, 'model');
      assert.equal(retained[1].sequence, 2);
      const read = await lifecycle.service.read({ signal: new AbortController().signal });
      assert.equal(read.ok, true);

      assert.equal(finalizeStreamingOwner(conversationId, owner.generationId), true);
      assert.equal(await lifecycle.settle('generation_ended'), true);
    } finally {
      unmarkStreaming(conversationId, owner.generationId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await deleteConversation(conversationId);
      useConversations.setState({
        byId: prior.byId,
        order: prior.order,
        activeId: prior.activeId,
      });
    }
  });
});
