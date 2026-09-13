/**
 * Phase 2 — per-conversation UI state and attachment blob ownership.
 *
 * The behavior under test is the leak the keyed Composer remount produced:
 * switching conversations destroyed the draft and orphaned any blob it was
 * holding, because `removeAttachmentBlob` only ran from the remove button.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import type { Attachment } from '../types.ts';

const [uiModule, idbModule, conversationModule, generationModule] = await Promise.all([
  import('./conversation-ui.ts'),
  import('../utils/idb.ts'),
  import('./conversations.ts'),
  import('../modules/chat-pipeline/generation-session-manager.ts'),
]);
const { deleteConversation, saveMessage } = await import('./db.ts');
const { reclaimRestartOrphanedAttachments } = await import('./attachment-gc.ts');

const {
  beginConversationUiWork,
  CONVERSATION_UI_LRU_LIMIT,
  CONVERSATION_UI_TOMBSTONE_LIMIT,
  conversationUiLifetime,
  drainConversationUiCleanup,
  drainConversationUiWork,
  fenceConversationUiLifetime,
  useConversationUi,
} = uiModule;
const { loadAttachment, putAttachment } = idbModule;
const {
  markConversationCorpusMutation,
  unmarkConversationCorpusMutation,
} = conversationModule;
const {
  endGenerationSession,
  getGenerationAttention,
  resetGenerationSessionsForTests,
  startGenerationSession,
} = generationModule;

async function stage(name: string): Promise<Attachment> {
  const attachment: Attachment = {
    id: `att-${name}-${crypto.randomUUID()}`,
    mime: 'text/plain',
    name: `${name}.txt`,
    size: 5,
    isImage: false,
  };
  await putAttachment(attachment.id, new Blob(['bytes']), attachment);
  return attachment;
}

const blobExists = async (id: string): Promise<boolean> => (await loadAttachment(id)) != null;

beforeEach(() => {
  useConversationUi.setState({ byId: {}, recency: [], tombstoned: new Set() });
  resetGenerationSessionsForTests();
});

test('three drafts survive independent conversation switching', () => {
  const ui = useConversationUi.getState();
  ui.setDraftText('a', 'half-written thought');
  ui.setDraftText('b', 'other chat');
  ui.setDraftText('c', 'third chat');

  assert.equal(ui.get('a').draftText, 'half-written thought');
  assert.equal(ui.get('b').draftText, 'other chat');
  assert.equal(ui.get('c').draftText, 'third chat');
});

test('scroll, Workspace, and preview snapshots stay conversation-owned', () => {
  const ui = useConversationUi.getState();
  ui.setPresentation('a', {
    scrollTop: 640,
    workspaceManagerOpen: true,
    workspaceSections: { files: true },
    workspaceExpandedDir: 'D:\\workspace',
    previewOpenMessageId: 'message-a',
    previewPinned: true,
    previewActiveTab: 'tools',
  });
  ui.setPresentation('b', {
    scrollTop: 12,
    workspaceManagerOpen: false,
    previewOpenMessageId: 'message-b',
    previewActiveTab: 'todo',
  });

  assert.equal(ui.get('a').scrollTop, 640);
  assert.equal(ui.get('a').workspaceManagerOpen, true);
  assert.equal(ui.get('a').workspaceExpandedDir, 'D:\\workspace');
  assert.equal(ui.get('a').previewOpenMessageId, 'message-a');
  assert.equal(ui.get('a').previewActiveTab, 'tools');
  assert.equal(ui.get('b').scrollTop, 12);
  assert.equal(ui.get('b').workspaceManagerOpen, false);
  assert.equal(ui.get('b').previewOpenMessageId, 'message-b');
  assert.equal(ui.get('b').previewActiveTab, 'todo');
});

test('removing an attachment from a draft deletes its blob', async () => {
  const attachment = await stage('removed');
  useConversationUi.getState().addDraftAttachments('a', [attachment]);
  assert.equal(await blobExists(attachment.id), true);

  await useConversationUi.getState().removeDraftAttachment('a', attachment.id);

  assert.deepEqual(useConversationUi.getState().get('a').draftAttachments, []);
  assert.equal(await blobExists(attachment.id), false);
});

test('sending transfers blob ownership instead of releasing it', async () => {
  // The persisted message becomes the owner, so deleting here would destroy
  // an attachment the transcript still references.
  const attachment = await stage('sent');
  useConversationUi.getState().addDraftAttachments('a', [attachment]);
  useConversationUi.getState().setDraftText('a', 'here is a file');

  const taken = useConversationUi.getState().takeDraft('a');

  assert.equal(taken.text, 'here is a file');
  assert.deepEqual(taken.attachments.map((a) => a.id), [attachment.id]);
  assert.equal(useConversationUi.getState().get('a').draftText, '');
  assert.deepEqual(useConversationUi.getState().get('a').draftAttachments, []);
  assert.equal(await blobExists(attachment.id), true, 'the message owns these bytes now');
});

test('a rejected send restores the draft under anything typed meanwhile', async () => {
  const attachment = await stage('rejected');
  useConversationUi.getState().addDraftAttachments('a', [attachment]);
  useConversationUi.getState().setDraftText('a', 'original');

  const taken = useConversationUi.getState().takeDraft('a');
  // The user keeps typing while the durable boundary is pending.
  useConversationUi.getState().setDraftText('a', 'typed while waiting');
  const newer = await stage('newer');
  useConversationUi.getState().addDraftAttachments('a', [newer]);

  useConversationUi.getState().restoreDraft('a', taken.text, taken.attachments);

  const restored = useConversationUi.getState().get('a');
  assert.equal(restored.draftText, 'typed while waiting', 'newer text wins');
  assert.deepEqual(
    restored.draftAttachments.map((a) => a.id),
    [attachment.id, newer.id],
    'the taken attachments are merged underneath the newer one',
  );
  assert.equal(await blobExists(attachment.id), true);
});

test('discarding a draft releases the blobs it still owns', async () => {
  const attachment = await stage('discarded');
  useConversationUi.getState().addDraftAttachments('a', [attachment]);

  await useConversationUi.getState().discardDraft('a');

  assert.deepEqual(useConversationUi.getState().get('a').draftAttachments, []);
  assert.equal(await blobExists(attachment.id), false);
});

test('deleting a conversation releases its staged blobs', async () => {
  const attachment = await stage('deleted-conversation');
  useConversationUi.getState().addDraftAttachments('a', [attachment]);
  useConversationUi.getState().setDraftText('a', 'never sent');

  await useConversationUi.getState().releaseConversation('a');

  assert.equal(useConversationUi.getState().byId.a, undefined);
  assert.equal(await blobExists(attachment.id), false);
});

test('pruning keeps resident conversations and bounds the rest', async () => {
  const ui = useConversationUi.getState();
  // One more than the limit, plus a resident conversation that must survive
  // regardless of how stale it looks.
  ui.setDraftText('resident', 'a running generation owns this');
  for (let index = 0; index <= CONVERSATION_UI_LRU_LIMIT; index += 1) {
    ui.setDraftText(`idle-${index}`, `draft ${index}`);
  }

  await useConversationUi.getState().pruneNonResident(new Set(['resident']));

  const remaining = useConversationUi.getState().byId;
  assert.equal(
    remaining.resident?.draftText,
    'a running generation owns this',
    'a resident conversation is never evicted',
  );
  assert.ok(
    Object.keys(remaining).length <= CONVERSATION_UI_LRU_LIMIT + 1,
    'the rest are bounded',
  );
  assert.equal(remaining['idle-0'], undefined, 'the least recently touched went first');
});

test('eviction releases the evicted draft blobs', async () => {
  const attachment = await stage('evicted');
  useConversationUi.getState().setDraftText('oldest', 'stale draft');
  useConversationUi.getState().addDraftAttachments('oldest', [attachment]);
  for (let index = 0; index <= CONVERSATION_UI_LRU_LIMIT; index += 1) {
    useConversationUi.getState().setDraftText(`newer-${index}`, `draft ${index}`);
  }

  await useConversationUi.getState().pruneNonResident(new Set());

  assert.equal(useConversationUi.getState().byId.oldest, undefined);
  assert.equal(
    await blobExists(attachment.id),
    false,
    'an evicted draft must not leave its bytes behind',
  );
});

test('the side panel is remembered per conversation', () => {
  const ui = useConversationUi.getState();
  ui.setSidePanel('a', true, 'params');
  ui.setSidePanel('b', true, 'tools');

  assert.equal(ui.get('a').sidePanelTab, 'params');
  assert.equal(ui.get('b').sidePanelTab, 'tools');

  useConversationUi.getState().setSidePanel('a', false);
  assert.equal(useConversationUi.getState().get('a').sidePanelOpen, false);
  assert.equal(
    useConversationUi.getState().get('a').sidePanelTab,
    'params',
    'closing remembers which tab was showing',
  );
  assert.equal(useConversationUi.getState().get('b').sidePanelOpen, true);
});

test('the complete edit draft is remembered per conversation', async () => {
  // A single app-wide `editingId` was never cleared on a switch, so opening an
  // edit in one chat left the next chat's Composer hidden behind a bubble that
  // had already unmounted.
  const ui = useConversationUi.getState();
  const session = ui.beginEdit('a', 'message-1', 'original', []);
  assert.ok(session);
  ui.setEditDraftText('a', 'message-1', session, 'unsaved replacement');

  assert.equal(ui.get('a').editingMessageId, 'message-1');
  assert.equal(ui.get('a').editDraftText, 'unsaved replacement');
  assert.equal(
    ui.get('b').editingMessageId,
    null,
    'the other conversation has no edit open, so its composer stays visible',
  );

  await useConversationUi.getState().cancelEdit('a', 'message-1', session);
  assert.equal(useConversationUi.getState().get('a').editingMessageId, null);
});

test('a submitting edit cannot cancel its staged blobs before durable ownership transfers', async () => {
  const attachment = await stage('edit-submit-fence');
  const ui = useConversationUi.getState();
  const session = ui.beginEdit('a', 'message-1', 'replacement', []);
  assert.ok(session);
  ui.addEditAttachments(
    'a',
    'message-1',
    session,
    conversationUiLifetime('a'),
    [attachment],
  );

  assert.equal(ui.startEditSubmission('a', 'message-1', session), true);
  assert.equal(
    ui.beginEdit('a', 'message-2', 'another replacement', []),
    null,
    'another bubble cannot replace the submitting edit session',
  );
  assert.equal(ui.get('a').editingMessageId, 'message-1');
  await ui.cancelEdit('a', 'message-1', session);
  assert.equal(ui.get('a').editingMessageId, 'message-1');
  assert.equal(await blobExists(attachment.id), true);

  ui.resumeEditSubmission('a', 'message-1', session);
  await ui.cancelEdit('a', 'message-1', session);
  assert.equal(ui.get('a').editingMessageId, null);
  assert.equal(await blobExists(attachment.id), false);
});

test('abandoned edit attachments are released with their conversation', async () => {
  // `MessageBubble` releases these when the user cancels, but a switch
  // unmounts it without cancelling, so the ids must outlive the component.
  const attachment = await stage('edit-staged');
  const ui = useConversationUi.getState();
  const session = ui.beginEdit('a', 'message-1', 'draft', []);
  assert.ok(session);
  ui.addEditAttachments(
    'a',
    'message-1',
    session,
    conversationUiLifetime('a'),
    [attachment],
  );

  assert.deepEqual(useConversationUi.getState().get('a').editAttachmentIds, [attachment.id]);
  assert.deepEqual(
    useConversationUi.getState().get('a').editAttachments.map((item) => item.id),
    [attachment.id],
  );

  await useConversationUi.getState().releaseConversation('a');

  assert.equal(await blobExists(attachment.id), false);
});

test('a late edit encode is retained across navigation but released after cancel', async () => {
  const ui = useConversationUi.getState();
  const session = ui.beginEdit('a', 'message-1', 'draft', []);
  assert.ok(session);
  const lifetime = conversationUiLifetime('a');

  // Navigation does not end the edit lifetime.
  ui.setDraftText('b', 'foreground chat');
  const attachment = await stage('late-edit');
  ui.addEditAttachments('a', 'message-1', session, lifetime, [attachment]);
  assert.deepEqual(ui.get('a').editAttachmentIds, [attachment.id]);

  await ui.cancelEdit('a', 'message-1', session);
  assert.equal(await blobExists(attachment.id), false);
});

test('a conversation deleted before it had any draft is still tombstoned', async () => {
  // The case a draft-first test misses: with no entry to remove, an early
  // return would skip recording the tombstone — and that is precisely when a
  // file dropped moments before the delete is still encoding.
  await useConversationUi.getState().releaseConversation('never-drafted');
  assert.equal(beginConversationUiWork('never-drafted'), null);

  const late = await stage('never-drafted-late');
  useConversationUi.getState().addDraftAttachments('never-drafted', [late]);

  assert.equal(useConversationUi.getState().byId['never-drafted'], undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await blobExists(late.id), false);
});

test('delete fences are bounded and the newest deleted conversations stay protected', async () => {
  const oldestLifetime = conversationUiLifetime('deleted-0');
  for (let index = 0; index <= CONVERSATION_UI_TOMBSTONE_LIMIT; index += 1) {
    await useConversationUi.getState().releaseConversation(`deleted-${index}`);
  }

  const tombstoned = useConversationUi.getState().tombstoned;
  assert.equal(tombstoned.size, CONVERSATION_UI_TOMBSTONE_LIMIT);
  assert.equal(tombstoned.has('deleted-0'), false);
  assert.equal(tombstoned.has(`deleted-${CONVERSATION_UI_TOMBSTONE_LIMIT}`), true);

  const late = await stage('deleted-0-late');
  useConversationUi.getState().addDraftAttachments('deleted-0', [late], oldestLifetime);
  await drainConversationUiCleanup('deleted-0');
  assert.equal(useConversationUi.getState().byId['deleted-0'], undefined);
  assert.equal(await blobExists(late.id), false);
});

test('deleting a conversation releases its unread generation attention', async () => {
  const conversationId = 'deleted-with-attention';
  startGenerationSession({
    conversationId,
    generationId: 'generation-1',
    assistantMessageId: 'assistant-1',
    controller: new AbortController(),
  });
  endGenerationSession(conversationId, 'generation-1', {
    unread: true,
    outcome: 'completed',
  });
  assert.equal(getGenerationAttention(conversationId)?.kind, 'completed');

  await useConversationUi.getState().releaseConversation(conversationId);

  assert.equal(getGenerationAttention(conversationId), undefined);
});

test('a late attachment cannot resurrect a deleted conversation', async () => {
  // Encoding is asynchronous: a file dropped moments before a delete can
  // resolve after it. Without a tombstone that recreates UI state, and the
  // blob it carries would have no owner left to release it.
  const ui = useConversationUi.getState();
  ui.setDraftText('doomed', 'about to be deleted');
  await useConversationUi.getState().releaseConversation('doomed');

  const late = await stage('late-arrival');
  useConversationUi.getState().addDraftAttachments('doomed', [late]);
  useConversationUi.getState().setDraftText('doomed', 'should not stick');

  assert.equal(
    useConversationUi.getState().byId.doomed,
    undefined,
    'no UI state is recreated for a deleted conversation',
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await blobExists(late.id), false, 'and the late bytes are released');
});

test('a corpus wipe clears every draft and lifts the tombstones', async () => {
  const attachment = await stage('wiped');
  const ui = useConversationUi.getState();
  ui.setDraftText('a', 'draft a');
  ui.addDraftAttachments('a', [attachment]);
  await useConversationUi.getState().releaseConversation('b');
  startGenerationSession({
    conversationId: 'attention-only',
    generationId: 'generation-wipe',
    assistantMessageId: 'assistant-wipe',
    controller: new AbortController(),
  });
  endGenerationSession('attention-only', 'generation-wipe', { unread: true });

  await useConversationUi.getState().releaseAll();

  assert.deepEqual(useConversationUi.getState().byId, {});
  assert.equal(await blobExists(attachment.id), false);
  assert.equal(getGenerationAttention('attention-only'), undefined);

  // A wipe ends every lifetime, so a later import may legitimately reuse any
  // ID — including one that was tombstoned before it.
  useConversationUi.getState().setDraftText('b', 'restored chat');
  assert.equal(useConversationUi.getState().get('b').draftText, 'restored chat');
});

test('replacement import rotates the UI lifetime and revives a tombstoned id', async () => {
  const id = 'restored-same-id';
  const oldLifetime = conversationUiLifetime(id);
  await useConversationUi.getState().releaseConversation(id);
  await useConversationUi.getState().replaceConversationLifetime(id);

  useConversationUi.getState().setDraftText(id, 'new lifetime');
  assert.equal(useConversationUi.getState().get(id).draftText, 'new lifetime');
  assert.equal(useConversationUi.getState().tombstoned.has(id), false);

  const late = await stage('old-lifetime');
  useConversationUi.getState().addDraftAttachments(id, [late], oldLifetime);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await blobExists(late.id), false, 'old async work is fenced out');
  assert.deepEqual(useConversationUi.getState().get(id).draftAttachments, []);
});

test('a restore can fence and drain attachment encoding that began in the old lifetime', async () => {
  const id = 'restore-drains-encoding';
  const work = beginConversationUiWork(id);
  assert.ok(work);
  fenceConversationUiLifetime(id);
  let drained = false;
  const draining = drainConversationUiWork(id).then(() => {
    drained = true;
  });

  await Promise.resolve();
  assert.equal(drained, false);

  const late = await stage('restore-drained-late');
  useConversationUi.getState().addDraftAttachments(id, [late], work.uiLifetime);
  work.finish();
  await draining;
  await uiModule.drainConversationUiCleanup(id);

  assert.equal(await blobExists(late.id), false);
  assert.deepEqual(useConversationUi.getState().get(id).draftAttachments, []);
});

test('attachment encoders cannot enter while a corpus mutation is active', async () => {
  const operation = markConversationCorpusMutation('test UI work exclusion');
  try {
    await operation.ready;
    assert.equal(beginConversationUiWork('blocked-by-corpus'), null);
    await drainConversationUiWork();
  } finally {
    unmarkConversationCorpusMutation(operation.operationId);
  }
});

test('startup attachment GC removes only prior-process blobs without durable owners', async () => {
  const conversationId = `attachment-gc-${crypto.randomUUID()}`;
  const orphan = await stage('restart-orphan');
  const retained = await stage('durable-owner');
  await saveMessage({
    id: `${conversationId}-message`,
    role: 'user',
    content: 'owns an attachment',
    createdAt: 1,
    attachments: [retained],
  }, conversationId);

  const currentProcessCutoff = Date.now() + 5;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const currentProcess = await stage('current-process');
  try {
    await reclaimRestartOrphanedAttachments(currentProcessCutoff);

    assert.equal(await blobExists(orphan.id), false);
    assert.equal(await blobExists(retained.id), true, 'durable message ownership wins');
    assert.equal(
      await blobExists(currentProcess.id),
      true,
      'a blob created after this process started is outside the sweep',
    );
  } finally {
    await deleteConversation(conversationId);
    await Promise.all([
      idbModule.deleteAttachment(orphan.id),
      idbModule.deleteAttachment(retained.id),
      idbModule.deleteAttachment(currentProcess.id),
    ]);
  }
});
