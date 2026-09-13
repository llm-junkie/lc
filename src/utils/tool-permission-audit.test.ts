import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import type { Conversation, Message, ToolPermissionAudit } from '../types.ts';

const [dbModule, archiveModule, typesModule] = await Promise.all([
  import('../store/db.ts'),
  import('./exportArchive.ts'),
  import('../types.ts'),
]);

const {
  loadMessages,
  persistedMessageSnapshot,
  replaceMessages,
  saveMeta,
} = dbModule;
const { buildArchive, readArchive } = archiveModule;
const { DEFAULT_PARAMS } = typesModule;

const AUDIT: ToolPermissionAudit = {
  prompt_id: '7d62d51c-7261-4c2a-9d99-4ce3c9b729de',
  requested_at: 1_800_000_000_100,
  shown_at: 1_800_000_000_125,
  resolved_at: 1_800_000_004_500,
  decision: 'allow_session',
  displayed_call: {
    tool_call_id: 'permission-call',
    tool_name: 'lc_write_file',
  },
  scopes: ['D:\\workspace\\child'],
};

function toolMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `permission-result-${crypto.randomUUID()}`,
    role: 'tool',
    content: '{"ok":true}',
    createdAt: 1_800_000_004_510,
    sortOrder: 2,
    tool_call_id: 'permission-call',
    tool_is_error: false,
    tool_duration_ms: 10,
    tool_permission: AUDIT,
    ...overrides,
  };
}

function conversation(id: string, messages: Message[]): Conversation {
  return {
    id,
    title: 'permission audit',
    model: 'test-model',
    serverId: 'local',
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 2,
    messageCount: messages.length,
    messages,
  };
}

describe('permission popup evidence is durable conversation data', () => {
  it('survives the canonical Dexie row mapping', () => {
    const restored = persistedMessageSnapshot(toolMessage());
    assert.deepEqual(restored.tool_permission, AUDIT);
  });

  it('survives a real IndexedDB write and reload', async () => {
    const id = `permission-persist-${crypto.randomUUID()}`;
    const message = toolMessage();
    await saveMeta(conversation(id, [message]));
    await replaceMessages(id, [message]);

    const [restored] = await loadMessages(id);
    assert.deepEqual(restored.tool_permission, AUDIT);
  });

  it('survives a real conversation archive export and import', async () => {
    const id = `permission-archive-${crypto.randomUUID()}`;
    const blob = await buildArchive([conversation(id, [toolMessage()])]);
    const imported = await readArchive({ arrayBuffer: () => blob.arrayBuffer() } as File);

    assert.deepEqual(imported[0].conversation.messages[0].tool_permission, AUDIT);
  });

  it('does not invent an audit for an older tool-result message', () => {
    const restored = persistedMessageSnapshot(toolMessage({ tool_permission: undefined }));
    assert.equal(restored.tool_permission, undefined);
  });
});
