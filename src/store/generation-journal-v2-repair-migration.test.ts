/**
 * A short-lived pre-release build opened schema v2 without the generation
 * journal. The current schema must advance that database normally rather than
 * relying on Dexie's same-version SchemaDiff repair.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

const DB_NAME = 'lc:conversations';
const CONVERSATION_ID = 'pre-release-v2';
const PRE_RELEASE_V2_STORES = {
  conversationsMeta: '&id, updatedAt, archived',
  messages: '&id, conversationId, createdAt, [conversationId+createdAt], [conversationId+sortOrder]',
  whiteboardVersions:
    '&[conversationId+id], conversationId, [conversationId+owner], &[conversationId+sequence], [conversationId+owner+sequence]',
  whiteboardWorking:
    '&[conversationId+owner], conversationId, owner, generationId, assistantMessageId',
};

const legacyWhiteboardVersion = {
  conversationId: CONVERSATION_ID,
  id: 'u_1700000000001',
  owner: 'user',
  sequence: 1,
  content: 'pre-release v2 board content',
  createdAt: 3,
  sourceMessageId: null,
  sourceToolCallId: null,
};

const legacyWhiteboardWorking = {
  conversationId: CONVERSATION_ID,
  owner: 'user',
  content: 'pre-release v2 working copy',
  updatedAt: 4,
};

const legacy = new Dexie(DB_NAME);
legacy.version(2).stores(PRE_RELEASE_V2_STORES);
await legacy.open();
await legacy.table('conversationsMeta').put({
  id: CONVERSATION_ID,
  title: 'must survive v3 repair',
  model: 'fixture-model',
  paramsJson: '{}',
  createdAt: 1,
  updatedAt: 2,
  messageCount: 0,
});
await legacy.table('whiteboardVersions').put(legacyWhiteboardVersion);
await legacy.table('whiteboardWorking').put(legacyWhiteboardWorking);
legacy.close();

const warnings: unknown[][] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => warnings.push(args);

let dbModule: typeof import('./db.ts');
try {
  dbModule = await import('./db.ts');
  await dbModule.loadAllMeta();
} finally {
  console.warn = originalWarn;
}

test('pre-release v2 advances to v3 without Dexie schema repair', async () => {
  assert.equal(dbModule.CONVERSATION_DB_VERSION, 3);
  assert.ok(
    warnings.every((args) => !String(args[0]).includes('Dexie SchemaDiff')),
    'the migration must not invoke Dexie same-version repair',
  );
  assert.equal((await dbModule.loadAllMeta())[0]?.title, 'must survive v3 repair');
  assert.deepEqual(await dbModule.loadGenerationRuns(), []);

  const whiteboard = await dbModule.runWhiteboardStorageTransaction('r', async (tables) => ({
    retained: await tables.whiteboardVersions
      .where('conversationId')
      .equals(CONVERSATION_ID)
      .toArray(),
    working: await tables.whiteboardWorking
      .where('conversationId')
      .equals(CONVERSATION_ID)
      .toArray(),
  }));

  assert.deepEqual(whiteboard.retained, [legacyWhiteboardVersion]);
  assert.deepEqual(whiteboard.working, [legacyWhiteboardWorking]);
});
