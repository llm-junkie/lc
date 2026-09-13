import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { DEFAULT_PARAMS, type Conversation, type Message } from '../types.ts';
import {
  loadAllMeta,
  loadMessages,
  replaceMessages,
  runConversationDataTransaction,
  saveMeta,
} from './db.ts';
import {
  addWhiteboardVersionsInTransaction,
  applyModelWhiteboardContent,
  beginModelWhiteboardTurn,
  getModelWhiteboardWorking,
  getPendingUserWhiteboard,
  getWhiteboardVersion,
  initializeWhiteboard,
  listWhiteboardVersions,
  promotePendingUserWhiteboard,
  savePendingUserWhiteboard,
  settleModelWhiteboardTurn,
} from './whiteboard.ts';
import {
  persistClonedConversationData,
  recoverInterruptedWhiteboardState,
  replaceConversationBranch,
} from './whiteboard-conversation.ts';

const BASE_TIME = new Date(2026, 7, 22, 14, 29, 50, 12).getTime();

async function branchFixture(label: string): Promise<{
  conversation: Conversation;
  baselineUserId: string;
  baselineModelId: string;
  retainedUserId: string;
  retainedModelId: string;
}> {
  const conversationId = `whiteboard-branch-${label}-${crypto.randomUUID()}`;
  const heads = await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
  await savePendingUserWhiteboard(conversationId, '# User version one', {
    now: () => BASE_TIME + 1,
  });
  const user = await promotePendingUserWhiteboard(conversationId, 'user-1', {
    now: () => BASE_TIME + 2,
  });
  await beginModelWhiteboardTurn({
    conversationId,
    generationId: 'generation-1',
    assistantMessageId: 'assistant-1',
    initialVersionId: heads.model.id,
  }, { now: () => BASE_TIME + 3 });
  await applyModelWhiteboardContent({
    conversationId,
    generationId: 'generation-1',
    assistantMessageId: 'assistant-1',
    toolCallId: 'whiteboard-call-1',
    content: '# Model branch version',
  }, { now: () => BASE_TIME + 4 });
  const settled = await settleModelWhiteboardTurn({
    conversationId,
    generationId: 'generation-1',
    assistantMessageId: 'assistant-1',
  });
  assert.ok(settled.retained);

  const messages: Message[] = [
    {
      id: 'user-1',
      role: 'user',
      content: 'original prompt',
      createdAt: BASE_TIME + 10,
      sortOrder: 1,
      user_board: user.version.id,
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'branch response',
      createdAt: BASE_TIME + 11,
      sortOrder: 2,
      whiteboard_refs: {
        user_board: user.version.id,
        model_initial_board: heads.model.id,
        model_latest_board: settled.retained.id,
      },
      tool_calls: [{
        created_at: 0,
        id: 'whiteboard-call-1',
        name: 'lc_whiteboard',
        arguments: '{"action":"replace","content":"# Model branch version"}',
      }],
    },
    {
      id: 'tool-1',
      role: 'tool',
      content: '{"changed":true}',
      createdAt: BASE_TIME + 12,
      sortOrder: 3,
      tool_call_id: 'whiteboard-call-1',
    },
  ];
  const conversation: Conversation = {
    id: conversationId,
    title: 'Branch fixture',
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
    updatedAt: BASE_TIME + 12,
  };
  await saveMeta(conversation);
  await replaceMessages(conversationId, messages);
  return {
    conversation,
    baselineUserId: heads.user.id,
    baselineModelId: heads.model.id,
    retainedUserId: user.version.id,
    retainedModelId: settled.retained.id,
  };
}

describe('atomic Whiteboard transcript branch boundaries', () => {
  it('Retry preserves pending user state and its pinned user version', async () => {
    const fixture = await branchFixture('retry');
    await savePendingUserWhiteboard(fixture.conversation.id, '# Pending for a later send', {
      now: () => BASE_TIME + 20,
    });

    const result = await replaceConversationBranch({
      conversation: fixture.conversation,
      messageId: 'user-1',
      next: { content: 'original prompt' },
      boundary: 'retry',
      whiteboardEnabled: true,
    }, { now: () => BASE_TIME + 21 });

    assert.deepEqual(result.removedMessageIds, ['assistant-1', 'tool-1']);
    assert.deepEqual((await loadMessages(fixture.conversation.id)).map((message) => message.id), [
      'user-1',
    ]);
    assert.equal(result.conversation.messages[0]?.createdAt, BASE_TIME + 21);
    assert.equal((await loadMessages(fixture.conversation.id))[0]?.createdAt, BASE_TIME + 21);
    assert.equal(result.conversation.messages[0]?.user_board, fixture.retainedUserId);
    assert.equal((await getPendingUserWhiteboard(fixture.conversation.id))?.content, '# Pending for a later send');
    assert.equal(await getWhiteboardVersion(fixture.conversation.id, fixture.retainedModelId), null);
    assert.ok(await getWhiteboardVersion(fixture.conversation.id, fixture.baselineModelId));
  });

  it('Edit-and-resend promotes pending state onto the retained target and removes its replaced branch versions', async () => {
    const fixture = await branchFixture('edit');
    await savePendingUserWhiteboard(fixture.conversation.id, '# Replacement user board', {
      now: () => BASE_TIME + 30,
    });

    const result = await replaceConversationBranch({
      conversation: fixture.conversation,
      messageId: 'user-1',
      next: { content: 'edited prompt' },
      boundary: 'edit-and-resend',
      whiteboardEnabled: true,
    }, { now: () => BASE_TIME + 31 });

    const [message] = await loadMessages(fixture.conversation.id);
    assert.equal(message.content, 'edited prompt');
    assert.equal(message.createdAt, BASE_TIME + 31);
    assert.equal(result.conversation.messages[0]?.createdAt, message.createdAt);
    assert.notEqual(message.user_board, fixture.retainedUserId);
    assert.equal(result.conversation.messages[0]?.user_board, message.user_board);
    assert.equal(await getPendingUserWhiteboard(fixture.conversation.id), null);
    assert.equal(await getWhiteboardVersion(fixture.conversation.id, fixture.retainedUserId), null);
    assert.equal(await getWhiteboardVersion(fixture.conversation.id, fixture.retainedModelId), null);
    const promoted = await getWhiteboardVersion(fixture.conversation.id, message.user_board!);
    assert.equal(promoted?.content, '# Replacement user board');
    assert.equal(promoted?.sourceMessageId, 'user-1');
    assert.deepEqual(
      (await listWhiteboardVersions(fixture.conversation.id)).map((version) => version.id),
      [fixture.baselineUserId, fixture.baselineModelId, message.user_board],
    );
  });

  it('rolls back board deletion and pending promotion when the transcript write fails', async () => {
    const fixture = await branchFixture('rollback');
    await savePendingUserWhiteboard(fixture.conversation.id, '# Must remain pending', {
      now: () => BASE_TIME + 40,
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const invalidAttachment = {
      id: 'invalid-attachment',
      name: 'invalid.txt',
      mime: 'text/plain',
      isImage: false,
      size: 1,
      extra: circular,
    } as unknown as NonNullable<Message['attachments']>[number];

    await assert.rejects(
      replaceConversationBranch({
        conversation: fixture.conversation,
        messageId: 'user-1',
        next: { content: 'edited prompt', attachments: [invalidAttachment] },
        boundary: 'edit-and-resend',
        whiteboardEnabled: true,
      }, { now: () => BASE_TIME + 41 }),
      /circular|cyclic/i,
    );

    assert.deepEqual((await loadMessages(fixture.conversation.id)).map((message) => message.id), [
      'user-1', 'assistant-1', 'tool-1',
    ]);
    assert.equal((await loadMessages(fixture.conversation.id))[0]?.createdAt, BASE_TIME + 10);
    assert.equal(fixture.conversation.messages[0]?.createdAt, BASE_TIME + 10);
    assert.equal((await getPendingUserWhiteboard(fixture.conversation.id))?.content, '# Must remain pending');
    assert.ok(await getWhiteboardVersion(fixture.conversation.id, fixture.retainedUserId));
    assert.ok(await getWhiteboardVersion(fixture.conversation.id, fixture.retainedModelId));
  });
});

describe('atomic Whiteboard conversation clone boundary', () => {
  it('copies only baselines, referenced rows, and current heads while remapping source messages', async () => {
    const fixture = await branchFixture('clone');
    const sourceId = fixture.conversation.id;
    const middleId = 'm_0822142950062';
    const currentId = 'm_0822142950072';
    await runConversationDataTransaction('rw', async (tables) => {
      await addWhiteboardVersionsInTransaction(tables, [
        {
          conversationId: sourceId,
          id: middleId,
          owner: 'model',
          content: '# Unreferenced intermediate head',
          createdAt: BASE_TIME + 50,
          sequence: 5,
          sourceMessageId: null,
          sourceToolCallId: null,
        },
        {
          conversationId: sourceId,
          id: currentId,
          owner: 'model',
          content: '# Current retained head',
          createdAt: BASE_TIME + 60,
          sequence: 6,
          sourceMessageId: null,
          sourceToolCallId: null,
        },
      ]);
    });
    await savePendingUserWhiteboard(sourceId, '# Pending must not clone');

    const cloneId = `clone-target-${crypto.randomUUID()}`;
    const messageIdMap = new Map([
      ['user-1', 'clone-user-1'],
      ['assistant-1', 'clone-assistant-1'],
      ['tool-1', 'clone-tool-1'],
    ]);
    const clonedMessages = fixture.conversation.messages.map((message, index) => ({
      ...message,
      id: messageIdMap.get(message.id)!,
      sortOrder: index + 1,
    }));
    const clone: Conversation = {
      ...fixture.conversation,
      id: cloneId,
      messages: clonedMessages,
      messageCount: clonedMessages.length,
      createdAt: BASE_TIME + 100,
      updatedAt: BASE_TIME + 100,
    };

    const persisted = await persistClonedConversationData(sourceId, clone, messageIdMap);
    assert.equal(persisted.copiedVersionIds.includes(middleId), false);
    assert.equal(persisted.copiedVersionIds.includes(currentId), true);
    assert.deepEqual((await loadMessages(cloneId)).map((message) => message.id), [
      'clone-user-1', 'clone-assistant-1', 'clone-tool-1',
    ]);
    const versions = await listWhiteboardVersions(cloneId);
    assert.equal(versions.some((version) => version.id === middleId), false);
    assert.equal(versions.find((version) => version.id === fixture.retainedUserId)?.sourceMessageId, 'clone-user-1');
    assert.equal(versions.find((version) => version.id === fixture.retainedModelId)?.sourceMessageId, 'clone-assistant-1');
    assert.equal(await getPendingUserWhiteboard(cloneId), null);
  });

  it('rolls back the complete clone when a transcript reference is dangling', async () => {
    const fixture = await branchFixture('clone-dangling');
    const cloneId = `clone-dangling-target-${crypto.randomUUID()}`;
    const messageIdMap = new Map(fixture.conversation.messages.map(
      (message, index) => [message.id, `dangling-clone-message-${index}`],
    ));
    const clonedMessages = fixture.conversation.messages.map((message, index) => ({
      ...message,
      id: messageIdMap.get(message.id)!,
      sortOrder: index + 1,
    }));
    clonedMessages[0] = { ...clonedMessages[0], user_board: 'u_0101000009999' };
    const clone: Conversation = {
      ...fixture.conversation,
      id: cloneId,
      messages: clonedMessages,
      messageCount: clonedMessages.length,
    };

    await assert.rejects(
      persistClonedConversationData(fixture.conversation.id, clone, messageIdMap),
      /references missing Whiteboard version/,
    );
    assert.equal((await loadAllMeta()).some((conversation) => conversation.id === cloneId), false);
    assert.deepEqual(await loadMessages(cloneId), []);
    assert.deepEqual(await listWhiteboardVersions(cloneId), []);
  });
});

describe('lazy Whiteboard crash recovery boundary', () => {
  it('settles an orphaned provisional row once and re-pins its owning assistant', async () => {
    const conversationId = `whiteboard-recovery-${crypto.randomUUID()}`;
    const heads = await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
    const messages: Message[] = [
      {
        id: 'recovery-user',
        role: 'user',
        content: 'continue',
        createdAt: BASE_TIME + 1,
        sortOrder: 1,
        user_board: heads.user.id,
      },
      {
        id: 'recovery-assistant',
        role: 'assistant',
        content: '',
        createdAt: BASE_TIME + 2,
        sortOrder: 2,
        whiteboard_refs: {
          user_board: heads.user.id,
          model_initial_board: heads.model.id,
          model_latest_board: heads.model.id,
        },
        tool_calls: [{
          created_at: 0,
          id: 'recovery-call',
          name: 'lc_whiteboard',
          arguments: '{"action":"replace","content":"# Recovered"}',
        }],
      },
    ];
    await saveMeta({
      id: conversationId,
      title: 'Recovery',
      params: { ...DEFAULT_PARAMS },
      messages,
      messageCount: messages.length,
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME + 2,
    });
    await replaceMessages(conversationId, messages);
    await beginModelWhiteboardTurn({
      conversationId,
      generationId: 'recovery-generation',
      assistantMessageId: 'recovery-assistant',
      initialVersionId: heads.model.id,
    }, { now: () => BASE_TIME + 3 });
    await applyModelWhiteboardContent({
      conversationId,
      generationId: 'recovery-generation',
      assistantMessageId: 'recovery-assistant',
      toolCallId: 'recovery-call',
      content: '# Recovered',
    }, { now: () => BASE_TIME + 4 });

    const first = await recoverInterruptedWhiteboardState(conversationId, messages);
    assert.equal(first.settled, true);
    assert.equal(first.latestToolCallId, 'recovery-call');
    const latestId = first.messages[1]?.whiteboard_refs?.model_latest_board;
    assert.ok(latestId);
    assert.notEqual(latestId, heads.model.id);
    assert.equal((await getWhiteboardVersion(conversationId, latestId))?.content, '# Recovered');
    assert.equal((await loadMessages(conversationId))[1]?.whiteboard_refs?.model_latest_board, latestId);
    assert.equal(await getModelWhiteboardWorking(conversationId), null);

    const versionCount = (await listWhiteboardVersions(conversationId, 'model')).length;
    const second = await recoverInterruptedWhiteboardState(conversationId, first.messages);
    assert.equal(second.settled, false);
    assert.equal((await listWhiteboardVersions(conversationId, 'model')).length, versionCount);
  });

  it('discards a working row whose owning assistant is missing without fabricating a retained version', async () => {
    const conversationId = `whiteboard-orphan-${crypto.randomUUID()}`;
    const heads = await initializeWhiteboard(conversationId, { now: () => BASE_TIME });
    await beginModelWhiteboardTurn({
      conversationId,
      generationId: 'orphan-generation',
      assistantMessageId: 'missing-assistant',
      initialVersionId: heads.model.id,
    }, { now: () => BASE_TIME + 1 });
    await applyModelWhiteboardContent({
      conversationId,
      generationId: 'orphan-generation',
      assistantMessageId: 'missing-assistant',
      toolCallId: 'orphan-call',
      content: '# Must not be fabricated',
    }, { now: () => BASE_TIME + 2 });

    const recovered = await recoverInterruptedWhiteboardState(conversationId, []);
    assert.equal(recovered.discarded, true);
    assert.equal(await getModelWhiteboardWorking(conversationId), null);
    assert.deepEqual(
      (await listWhiteboardVersions(conversationId, 'model')).map((version) => version.id),
      [heads.model.id],
    );
  });
});
