/**
 * Phase 1 — schema v1 to the current version must be additive and lossless.
 *
 * A pre-release database created at v1 exists on developer machines. Opening
 * it under the current schema has to add the generation-journal store and
 * change nothing else:
 * same conversations, same messages, same Whiteboard rows, same counts, same
 * content.
 *
 * Import order is load-bearing. This file creates and populates a real v1
 * database with a raw Dexie handle *before* importing `db.ts`, because that
 * module opens the application's singleton at the current version on first import. Importing it
 * earlier would upgrade the database before there was anything to migrate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

const DB_NAME = 'lc:conversations';

const V1_STORES = {
  conversationsMeta: '&id, updatedAt, archived',
  messages: '&id, conversationId, createdAt, [conversationId+createdAt], [conversationId+sortOrder]',
  whiteboardVersions:
    '&[conversationId+id], conversationId, [conversationId+owner], &[conversationId+sequence], [conversationId+owner+sequence]',
  whiteboardWorking:
    '&[conversationId+owner], conversationId, owner, generationId, assistantMessageId',
};

const CONVERSATION_ID = 'legacy-v1-conversation';

/** Rows written through a v1 handle, exactly as a pre-release build would. */
const legacyMeta = {
  id: CONVERSATION_ID,
  title: 'created under v1',
  model: 'legacy-model',
  paramsJson: JSON.stringify({ temperature: 0.7 }),
  createdAt: 10,
  updatedAt: 20,
  messageCount: 2,
};

const legacyMessages = [
  {
    id: 'legacy-user',
    conversationId: CONVERSATION_ID,
    role: 'user',
    content: 'a question written before the migration',
    createdAt: 11,
    sortOrder: 1,
    tool_is_error: 0,
  },
  {
    id: 'legacy-assistant',
    conversationId: CONVERSATION_ID,
    role: 'assistant',
    content: 'an answer written before the migration',
    createdAt: 12,
    sortOrder: 2,
    tool_is_error: 0,
    metaJson: JSON.stringify({ finish_reason: 'stop' }),
  },
];

const legacyWhiteboardVersion = {
  conversationId: CONVERSATION_ID,
  id: 'u_1700000000000',
  owner: 'user',
  sequence: 1,
  content: 'legacy board content',
  createdAt: 13,
  sourceMessageId: null,
  sourceToolCallId: null,
};

const legacyWhiteboardWorking = {
  conversationId: CONVERSATION_ID,
  owner: 'user',
  content: 'legacy working copy',
  updatedAt: 14,
};

// ── Populate a genuine v1 database, then close the handle. ───────────
const legacy = new Dexie(DB_NAME);
legacy.version(1).stores(V1_STORES);
await legacy.open();
assert.equal(legacy.verno, 1, 'the fixture database really is at version 1');
await legacy.table('conversationsMeta').put(legacyMeta);
await legacy.table('messages').bulkPut(legacyMessages);
await legacy.table('whiteboardVersions').put(legacyWhiteboardVersion);
await legacy.table('whiteboardWorking').put(legacyWhiteboardWorking);
legacy.close();

// Only now does the application schema get to open and upgrade it.
const dbModule = await import('./db.ts');
const { CONVERSATION_DB_VERSION, loadGenerationRuns, loadMessages, loadAllMeta } = dbModule;

test('the upgraded database reports version 3', async () => {
  await loadAllMeta(); // forces the open/upgrade
  assert.equal(CONVERSATION_DB_VERSION, 3);
});

test('v1 conversation metadata survives the upgrade unchanged', async () => {
  const metas = await loadAllMeta();
  const restored = metas.find((meta) => meta.id === CONVERSATION_ID);

  assert.ok(restored, 'the legacy conversation is still present');
  assert.equal(restored.title, legacyMeta.title);
  assert.equal(restored.model, legacyMeta.model);
  assert.equal(restored.createdAt, legacyMeta.createdAt);
  assert.equal(restored.updatedAt, legacyMeta.updatedAt);
  assert.equal(restored.messageCount, legacyMeta.messageCount);
});

test('v1 messages survive the upgrade with identical content and order', async () => {
  const messages = await loadMessages(CONVERSATION_ID);

  assert.equal(messages.length, legacyMessages.length, 'no row was added or dropped');
  assert.deepEqual(
    messages.map((message) => message.id),
    ['legacy-user', 'legacy-assistant'],
    'sort order is preserved',
  );
  assert.equal(messages[0].content, legacyMessages[0].content);
  assert.equal(messages[1].content, legacyMessages[1].content);
  assert.equal(messages[1].meta?.finish_reason, 'stop', 'no row was relabelled');
});

test('v1 Whiteboard rows survive the upgrade', async () => {
  const versions = await dbModule.runWhiteboardStorageTransaction('r', async (tables) => {
    const retained = await tables.whiteboardVersions
      .where('conversationId')
      .equals(CONVERSATION_ID)
      .toArray();
    const working = await tables.whiteboardWorking
      .where('conversationId')
      .equals(CONVERSATION_ID)
      .toArray();
    return { retained, working };
  });

  assert.equal(versions.retained.length, 1);
  assert.equal(versions.retained[0].id, legacyWhiteboardVersion.id);
  assert.equal(versions.retained[0].content, legacyWhiteboardVersion.content);
  assert.equal(versions.working.length, 1);
  assert.equal(versions.working[0].content, legacyWhiteboardWorking.content);
});

test('the upgrade adds an empty generation journal rather than inventing rows', async () => {
  // A migrated database has no interrupted generations by definition: nothing
  // was running when it was written. Fabricating a row here would make every
  // upgraded conversation look crashed.
  assert.deepEqual(await loadGenerationRuns(), []);
});
