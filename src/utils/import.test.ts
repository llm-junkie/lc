import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS, type Conversation, type Message } from '../types.ts';
import 'fake-indexeddb/auto';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

// Dynamic so the storage shim above is installed first: the settings store
// resolves its persist backend once, at module-evaluation time, and would
// otherwise capture `undefined`.
const {
  clearAndResetAll,
  importConversationArchiveFile,
  importConversationArchives,
  importConversations,
  importSettings,
  persistImportedConversationArchive,
  persistImportedConversations,
  resetSettings,
} = await import('./import.ts');
const {
  clearHighlight,
  closeConversationPersistence,
  drainConversationPersistence,
  enqueueConversationWrite,
  isHighlighted,
  markConversationCorpusMutation,
  markGenerationBlockingOperation,
  markStreaming,
  unmarkConversationCorpusMutation,
  unmarkGenerationBlockingOperation,
  unmarkStreaming,
  useConversations,
} = await import('../store/conversations.ts');
const {
  deleteAllConversations,
  deleteConversation,
  loadGenerationRun,
  loadAllMeta,
  loadMessages,
  recordGenerationRun,
  saveMeta,
  saveMessages,
} = await import('../store/db.ts');
const { deleteAttachment, loadAttachment, putAttachment } = await import('./idb.ts');
const {
  listWhiteboardVersions,
  readWhiteboardStorageRowsForTests,
  savePendingUserWhiteboard,
} = await import('../store/whiteboard.ts');
const {
  useAppModels,
  modelCache,
  profileManager,
  useProfileStore,
} = await import('../modules/server-profiles/index.ts');
const { useModelVisibility } = await import('../store/modelVisibility.ts');
const { useSettings } = await import('../store/settings.ts');
const { useConversationUi } = await import('../store/conversation-ui.ts');
type SettingsExport = import('./export.ts').SettingsExport;
type ImportedConversation = import('./exportArchive.ts').ImportedConversation;
type WhiteboardVersion = import('../store/whiteboard.ts').WhiteboardVersion;
const { buildArchive } = await import('./exportArchive.ts');

/** Settings import triggers a cache-first registry rebuild. Model discovery
 *  is a network round trip, and none of these assertions need one. */
function stubModelDiscovery(): () => void {
  const realRefresh = useAppModels.getState().refresh;
  useAppModels.setState({ refresh: async () => {} });
  return () => useAppModels.setState({ refresh: realRefresh, loading: false, _refreshing: false });
}

function settingsPayload(
  modelOverrides?: SettingsExport['settings']['modelOverrides'],
  modelCustomizations?: SettingsExport['settings']['modelCustomizations'],
): SettingsExport {
  return {
    format: 'llm-client:settings',
    version: 1,
    exportedAt: 1700000000000,
    settings: {
      profiles: [],
      theme: 'system',
      assistantName: 'Assistant',
      zoom: 1,
      autoArchiveDays: 0,
      previewOverlayHeight: 175,
      materialMode: 'auto',
      pinComposer: false,
      tokenMeterStyle: 'donut',
      autoPreviewReasoning: true,
      customThemes: [],
      activeCustomThemeId: null,
      themeFilter: 'all',
      tools: {
        shell_allowlist: 'node',
        default_allowed_roots: [],
        web_fetch_rate_per_min: 50,
        brave_search_api_key: '',
        brave_search_api_key_ref: '',
        searxng_base_url: '',
        marginalia_api_key: '',
        marginalia_api_key_ref: '',
        web_search_provider: 'auto',
        vision_model: '',
        web_research_model: '',
      },
      hiddenModels: [],
      ...(modelOverrides !== undefined ? { modelOverrides } : {}),
      ...(modelCustomizations !== undefined ? { modelCustomizations } : {}),
    },
  };
}

function conversation(messages: Message[]): Conversation {
  return {
    id: 'replace-import',
    title: 'Imported',
    createdAt: 1,
    updatedAt: 2,
    params: { ...DEFAULT_PARAMS },
    messages,
  };
}

function importedBundle(
  importedConversation: Conversation,
  whiteboardVersions: WhiteboardVersion[],
): ImportedConversation {
  return {
    conversation: importedConversation,
    whiteboardVersions,
    attachmentsRestored: 0,
    attachmentsMissing: 0,
  };
}

function retainedPair(
  conversationId: string,
  suffix: '0101000000000' | '0101000001000',
  contentLabel: string,
): WhiteboardVersion[] {
  return [
    {
      conversationId,
      id: `u_${suffix}`,
      owner: 'user',
      content: `# ${contentLabel} user`,
      createdAt: suffix === '0101000000000' ? 1 : 2,
      sequence: 1,
      sourceMessageId: null,
      sourceToolCallId: null,
    },
    {
      conversationId,
      id: `m_${suffix}`,
      owner: 'model',
      content: `# ${contentLabel} model`,
      createdAt: suffix === '0101000000000' ? 1 : 2,
      sequence: 2,
      sourceMessageId: null,
      sourceToolCallId: null,
    },
  ];
}

function durableConversation(
  id: string,
  title: string,
  messages: Message[],
): Conversation {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt: 2,
    params: { ...DEFAULT_PARAMS },
    messages,
    messageCount: messages.length,
  };
}

test('shorter import replaces every persisted message row for its conversation', async () => {
  const rows = new Map<string, Message[]>([
    ['replace-import', [1, 2, 3, 4].map((n) => ({
      id: `old-${n}`,
      role: n % 2 ? 'user' : 'assistant',
      content: String(n),
      createdAt: n,
    }))],
  ]);
  const shorter = conversation([
    { id: 'new-1', role: 'user', content: 'one', createdAt: 10 },
    { id: 'new-2', role: 'assistant', content: 'two', createdAt: 11 },
  ]);

  const persisted = await persistImportedConversations([shorter], {
    saveMeta: async () => {},
    replaceMessages: async (id, messages) => {
      rows.set(id, messages.map((message) => ({ ...message })));
    },
  });

  assert.deepEqual(persisted, ['replace-import']);
  assert.deepEqual(rows.get('replace-import')?.map((message) => message.id), ['new-1', 'new-2']);
});

test('empty import clears every persisted message row for its conversation', async () => {
  const rows = new Map<string, Message[]>([
    ['replace-import', [{ id: 'stale', role: 'user', content: 'stale', createdAt: 1 }]],
  ]);

  await persistImportedConversations([conversation([])], {
    saveMeta: async () => {},
    replaceMessages: async (id, messages) => {
      rows.set(id, [...messages]);
    },
  });

  assert.deepEqual(rows.get('replace-import'), []);
});

test('default legacy import rolls metadata and messages back as one transaction', async () => {
  const id = `legacy-atomic-${crypto.randomUUID()}`;
  const blockerId = `legacy-collision-${crypto.randomUUID()}`;
  const collisionMessageId = `shared-message-${crypto.randomUUID()}`;
  const oldConversation = durableConversation(id, 'keep old metadata', [
    { id: `${id}-old`, role: 'user', content: 'keep old row', createdAt: 1 },
  ]);
  const blocker = durableConversation(blockerId, 'unrelated owner', [
    { id: collisionMessageId, role: 'user', content: 'do not overwrite', createdAt: 1 },
  ]);
  try {
    await persistImportedConversationArchive(importedBundle(oldConversation, []));
    await persistImportedConversationArchive(importedBundle(blocker, []));

    const outcome = await persistImportedConversations([
      durableConversation(id, 'must roll back', [
        { id: collisionMessageId, role: 'assistant', content: 'collision', createdAt: 2 },
      ]),
    ]);
    assert.deepEqual(outcome, [null]);
    assert.equal(
      (await loadAllMeta()).find((conversation) => conversation.id === id)?.title,
      'keep old metadata',
    );
    assert.deepEqual(
      (await loadMessages(id)).map((message) => message.id),
      [`${id}-old`],
    );
    assert.equal((await loadMessages(blockerId))[0]?.content, 'do not overwrite');
  } finally {
    useConversations.getState().clearConversationPersistenceFailure(id);
    await Promise.all([deleteConversation(id), deleteConversation(blockerId)]);
  }
});

test('archive persistence atomically replaces metadata, messages, retained rows, and working rows', async () => {
  const id = 'archive-atomic-replace';
  await deleteAllConversations();
  try {
    const oldConversation = durableConversation(id, 'Old durable title', [
      { id: `${id}-old-1`, role: 'user', content: 'old one', createdAt: 1 },
      { id: `${id}-old-2`, role: 'assistant', content: 'old two', createdAt: 2 },
    ]);
    await persistImportedConversationArchive(importedBundle(
      oldConversation,
      retainedPair(id, '0101000000000', 'old'),
    ));
    await recordGenerationRun({
      conversationId: id,
      generationId: 'old-archive-generation',
      assistantMessageId: `${id}-old-2`,
      state: 'running',
      startedAt: 1,
    });
    await savePendingUserWhiteboard(id, '# pending state must be cleared');

    const replacement = durableConversation(id, 'Imported durable title', [
      { id: `${id}-new-1`, role: 'user', content: 'new only', createdAt: 10 },
    ]);
    const replacementVersions = retainedPair(id, '0101000001000', 'new');
    await persistImportedConversationArchive(importedBundle(replacement, replacementVersions));

    const metadata = (await loadAllMeta()).find((candidate) => candidate.id === id);
    assert.equal(metadata?.title, 'Imported durable title');
    assert.equal(metadata?.messageCount, 1);
    assert.deepEqual(
      (await loadMessages(id)).map((message) => message.id),
      [`${id}-new-1`],
    );
    assert.deepEqual(await listWhiteboardVersions(id), replacementVersions);
    const rawWhiteboard = await readWhiteboardStorageRowsForTests(id);
    assert.equal(rawWhiteboard.working.length, 0);
    assert.equal(rawWhiteboard.versions.length, 2);
    assert.equal(
      await loadGenerationRun(id),
      undefined,
      'archive replacement retires crash evidence from the previous lifetime',
    );
  } finally {
    await deleteAllConversations();
  }
});

test('archive persistence failure rolls back a partially attempted replacement', async () => {
  const id = 'archive-atomic-rollback';
  await deleteAllConversations();
  try {
    const oldConversation = durableConversation(id, 'Keep durable title', [
      { id: `${id}-old`, role: 'user', content: 'keep me', createdAt: 1 },
    ]);
    const oldVersions = retainedPair(id, '0101000000000', 'keep');
    await persistImportedConversationArchive(importedBundle(oldConversation, oldVersions));
    await savePendingUserWhiteboard(id, '# keep pending on rollback');

    const replacement = durableConversation(id, 'Must roll back', [
      { id: `${id}-new`, role: 'assistant', content: 'do not keep', createdAt: 2 },
    ]);
    const duplicateSequence = retainedPair(id, '0101000001000', 'invalid');
    duplicateSequence[1] = { ...duplicateSequence[1], sequence: 1 };

    await assert.rejects(
      persistImportedConversationArchive(importedBundle(replacement, duplicateSequence)),
      /duplicate key or sequence/,
    );

    const metadata = (await loadAllMeta()).find((candidate) => candidate.id === id);
    assert.equal(metadata?.title, 'Keep durable title');
    assert.deepEqual(
      (await loadMessages(id)).map((message) => message.id),
      [`${id}-old`],
    );
    assert.deepEqual(await listWhiteboardVersions(id), oldVersions);
    const rawWhiteboard = await readWhiteboardStorageRowsForTests(id);
    assert.equal(rawWhiteboard.working.length, 1);
  } finally {
    await deleteAllConversations();
  }
});

test('failed archive replacement restores overwritten attachment bytes', async () => {
  const id = `archive-blob-rollback-${crypto.randomUUID()}`;
  const attachmentId = `archive-blob-rollback-attachment-${crypto.randomUUID()}`;
  await putAttachment(attachmentId, new Blob(['old bytes']), {
    mime: 'text/plain',
    name: 'old.txt',
    size: 9,
  });
  try {
    const replacement = durableConversation(id, 'replacement must fail', [{
      id: `${id}-message`,
      role: 'user',
      content: 'replacement',
      createdAt: 1,
      attachments: [{
        id: attachmentId,
        name: 'new.txt',
        mime: 'text/plain',
        isImage: false,
        size: 9,
        stored: 'idb',
      }],
    }]);
    const outcome = await importConversationArchives([{
      ...importedBundle(replacement, []),
      stagedAttachments: [{
        id: attachmentId,
        blob: new Blob(['new bytes']),
        mime: 'text/plain',
        name: 'new.txt',
        size: 9,
      }],
    }], {
      persist: async () => { throw new Error('forced conversation rollback'); },
    });

    assert.equal(outcome.imported, 0);
    assert.equal(outcome.failures.length, 1);
    assert.equal(await (await loadAttachment(attachmentId))?.text(), 'old bytes');
  } finally {
    useConversations.getState().clearConversationPersistenceFailure(id);
    await Promise.all([deleteConversation(id), deleteAttachment(attachmentId)]);
  }
});

test('staged archive file import installs attachment bytes only with the conversation commit', async () => {
  const id = `archive-staged-success-${crypto.randomUUID()}`;
  const attachmentId = `archive-staged-success-attachment-${crypto.randomUUID()}`;
  const source = durableConversation(id, 'staged success', [{
    id: `${id}-message`,
    role: 'user',
    content: 'portable attachment',
    createdAt: 1,
    attachments: [{
      id: attachmentId,
      name: 'portable.txt',
      mime: 'text/plain',
      isImage: false,
      size: 14,
      stored: 'idb',
    }],
  }]);
  await putAttachment(attachmentId, new Blob(['portable bytes']), {
    mime: 'text/plain',
    name: 'portable.txt',
    size: 14,
  });
  try {
    const archive = await buildArchive([source]);
    await deleteAttachment(attachmentId);
    assert.equal(await loadAttachment(attachmentId), null, 'parsing has not happened yet');

    const outcome = await importConversationArchiveFile(archive as File);

    assert.equal(outcome.imported, 1);
    assert.equal((await loadAllMeta()).some((row) => row.id === id), true);
    assert.equal(await (await loadAttachment(attachmentId))?.text(), 'portable bytes');
  } finally {
    await Promise.all([deleteConversation(id), deleteAttachment(attachmentId)]);
    useConversations.setState((state) => {
      const { [id]: _removed, ...byId } = state.byId;
      return { byId, order: state.order.filter((candidate) => candidate !== id) };
    });
  }
});

test('archive import rejects an attachment ID owned by another conversation', async () => {
  const ownerId = `archive-attachment-owner-${crypto.randomUUID()}`;
  const importedId = `archive-attachment-collision-${crypto.randomUUID()}`;
  const attachmentId = `archive-shared-attachment-${crypto.randomUUID()}`;
  const attachment = {
    id: attachmentId,
    name: 'owner.txt',
    mime: 'text/plain',
    isImage: false,
    size: 11,
    stored: 'idb' as const,
  };
  await putAttachment(attachmentId, new Blob(['owner bytes']), attachment);
  try {
    await persistImportedConversationArchive(importedBundle(
      durableConversation(ownerId, 'attachment owner', [{
        id: `${ownerId}-message`,
        role: 'user',
        content: 'owns the bytes',
        createdAt: 1,
        attachments: [attachment],
      }]),
      [],
    ));

    const outcome = await importConversationArchives([{
      ...importedBundle(durableConversation(importedId, 'must be rejected', [{
        id: `${importedId}-message`,
        role: 'user',
        content: 'tries to share bytes',
        createdAt: 1,
        attachments: [{ ...attachment, name: 'attacker.txt' }],
      }]), []),
      stagedAttachments: [{
        id: attachmentId,
        blob: new Blob(['other bytes']),
        mime: 'text/plain',
        name: 'attacker.txt',
        size: 11,
      }],
    }]);

    assert.equal(outcome.imported, 0);
    assert.match(String(outcome.failures[0]?.error), /already belongs to conversation/);
    assert.equal(await (await loadAttachment(attachmentId))?.text(), 'owner bytes');
    assert.equal((await loadAllMeta()).some((row) => row.id === importedId), false);
  } finally {
    useConversations.getState().clearConversationPersistenceFailure(importedId);
    await Promise.all([
      deleteConversation(ownerId),
      deleteConversation(importedId),
      deleteAttachment(attachmentId),
    ]);
  }
});

test('archive import rejects an attachment ID staged in the replaced conversation', async () => {
  const id = `archive-same-ui-owner-${crypto.randomUUID()}`;
  const attachmentId = `archive-same-ui-attachment-${crypto.randomUUID()}`;
  const attachment = {
    id: attachmentId,
    name: 'draft.txt',
    mime: 'text/plain',
    isImage: false,
    size: 11,
    stored: 'idb' as const,
  };
  await putAttachment(attachmentId, new Blob(['draft bytes']), attachment);
  useConversationUi.getState().addDraftAttachments(id, [attachment]);
  try {
    const outcome = await importConversationArchives([{
      ...importedBundle(durableConversation(id, 'replacement', [{
        id: `${id}-message`,
        role: 'user',
        content: 'archive attachment',
        createdAt: 1,
        attachments: [{ ...attachment, name: 'archive.txt' }],
      }]), []),
      stagedAttachments: [{
        id: attachmentId,
        blob: new Blob(['archive bytes']),
        mime: 'text/plain',
        name: 'archive.txt',
        size: 13,
      }],
    }]);

    assert.equal(outcome.imported, 0);
    assert.match(String(outcome.failures[0]?.error), /staged in conversation/);
    assert.equal(await (await loadAttachment(attachmentId))?.text(), 'draft bytes');
    assert.deepEqual(
      useConversationUi.getState().get(id).draftAttachments.map((item) => item.id),
      [attachmentId],
    );
  } finally {
    await useConversationUi.getState().releaseConversation(id);
    useConversations.getState().clearConversationPersistenceFailure(id);
    await deleteConversation(id);
    await deleteAttachment(attachmentId);
  }
});

test('archive import applies and highlights only conversations whose durable write succeeded', async () => {
  const prior = useConversations.getState();
  const failedBefore = durableConversation('archive-failed', 'Existing failed', [
    { id: 'archive-failed-old', role: 'user', content: 'unchanged', createdAt: 1 },
  ]);
  const unrelated = durableConversation('archive-unrelated', 'Unrelated', []);
  useConversations.setState({
    byId: {
      [failedBefore.id]: failedBefore,
      [unrelated.id]: unrelated,
    },
    order: [failedBefore.id, unrelated.id],
    activeId: failedBefore.id,
    persistenceFailure: null,
  });
  clearHighlight('archive-success');
  clearHighlight(failedBefore.id);
  const persisted: string[] = [];
  let releaseSuccessfulPersistence!: () => void;
  let markPersistenceStarted!: () => void;
  const successfulPersistenceGate = new Promise<void>((resolve) => {
    releaseSuccessfulPersistence = resolve;
  });
  const persistenceStarted = new Promise<void>((resolve) => {
    markPersistenceStarted = resolve;
  });
  try {
    const success = importedBundle(
      durableConversation('archive-success', 'Successful import', [
        { id: 'archive-success-message', role: 'user', content: 'success', createdAt: 1 },
      ]),
      [],
    );
    const failed = importedBundle(
      durableConversation(failedBefore.id, 'Failed replacement', [
        { id: 'archive-failed-new', role: 'assistant', content: 'failed', createdAt: 2 },
      ]),
      [],
    );
    const importTask = importConversationArchives([success, failed], {
      persist: async (bundle) => {
        if (bundle.conversation.id === failedBefore.id) throw new Error('injected failure');
        markPersistenceStarted();
        await successfulPersistenceGate;
        persisted.push(bundle.conversation.id);
      },
    });
    await persistenceStarted;
    assert.equal(
      useConversations.getState().byId['archive-success'],
      undefined,
      'memory must not expose an archive conversation before its durable write resolves',
    );
    releaseSuccessfulPersistence();
    const outcome = await importTask;

    assert.deepEqual(persisted, ['archive-success']);
    assert.equal(outcome.imported, 1);
    assert.equal(outcome.added, 1);
    assert.deepEqual(outcome.successful.map((bundle) => bundle.conversation.id), ['archive-success']);
    assert.deepEqual(outcome.failures.map((failure) => failure.conversationId), [failedBefore.id]);
    const state = useConversations.getState();
    assert.equal(state.byId[failedBefore.id], failedBefore);
    assert.equal(state.byId[failedBefore.id].title, 'Existing failed');
    assert.deepEqual(state.order, ['archive-success', failedBefore.id, unrelated.id]);
    assert.equal(isHighlighted('archive-success'), true);
    assert.equal(isHighlighted(failedBefore.id), false);
  } finally {
    clearHighlight('archive-success');
    clearHighlight(failedBefore.id);
    useConversations.setState({
      byId: prior.byId,
      order: prior.order,
      activeId: prior.activeId,
      persistenceFailure: prior.persistenceFailure,
    });
  }
});

test('active generation rejects conversation import, settings import, and reset before mutation', async () => {
  const owner = markStreaming('import-config-lock', 'assistant-config-lock', 'generation-config-lock');
  try {
    await assert.rejects(
      importConversations({
        format: 'llm-client:conversations',
        version: 1,
        exportedAt: 1,
        conversations: [conversation([])],
      }),
      /finish before changing response configuration/,
    );
    await assert.rejects(
      importConversationArchives([]),
      /finish before changing response configuration/,
    );
    assert.throws(
      () => importSettings({} as never),
      /finish before changing response configuration/,
    );
    await assert.rejects(
      resetSettings(),
      /finish before changing response configuration/,
    );
    await assert.rejects(
      clearAndResetAll(),
      /finish before changing response configuration/,
    );
  } finally {
    unmarkStreaming(owner.conversationId, owner.generationId);
  }
});

test('provisional generation admission rejects settings and profile mutations', async () => {
  const operation = markGenerationBlockingOperation(
    'chat_generation_admission',
    'Test provisional generation admission',
  );
  try {
    assert.throws(
      () => importSettings({} as never),
      /finish before changing response configuration/i,
    );
    await assert.rejects(
      resetSettings(),
      /finish before changing response configuration/i,
    );
    await assert.rejects(
      profileManager.updateProfile('local', { name: 'must not change' }),
      /finish before changing response configuration/i,
    );
  } finally {
    unmarkGenerationBlockingOperation(operation.operationId);
  }
});

test('archive file import acquires corpus exclusivity before its reader restores blobs', async () => {
  const operation = markConversationCorpusMutation('Hold corpus for reader ordering test');
  let readerCalled = false;
  try {
    await operation.ready;
    await assert.rejects(
      importConversationArchiveFile({} as File, async () => {
        readerCalled = true;
        return [];
      }),
      /already active/,
    );
    assert.equal(readerCalled, false);
  } finally {
    unmarkConversationCorpusMutation(operation.operationId);
  }
});

test('settings import replaces model overrides rather than merging them', () => {
  const restore = stubModelDiscovery();
  try {
    useAppModels.getState().replaceMetadataOverrides({
      'old-profile:model-a': { c: 4096 },
      'old-profile:model-b': { v: true },
    });

    importSettings(settingsPayload({ 'new-profile:model-c': { c: 131072, v: false } }));

    assert.deepEqual(useAppModels.getState().overrides, {
      'new-profile:model-c': { c: 131072, v: false },
    });
  } finally {
    restore();
    useAppModels.getState().resetMetadataOverrides();
  }
});

test('settings import restores the concurrency rollback cap and defaults old v1 files to two', () => {
  const restoreRefresh = stubModelDiscovery();
  const previous = useSettings.getState().maxConcurrentGenerations;
  try {
    const payload = settingsPayload();
    payload.settings.maxConcurrentGenerations = 2;
    importSettings(payload);
    assert.equal(useSettings.getState().maxConcurrentGenerations, 2);

    useSettings.setState({ maxConcurrentGenerations: 1 });
    importSettings(settingsPayload());
    assert.equal(useSettings.getState().maxConcurrentGenerations, 2);
  } finally {
    useSettings.setState({ maxConcurrentGenerations: previous });
    restoreRefresh();
  }
});

test('settings import restores the to-do preview choice and defaults old v1 files to latest only', () => {
  const restoreRefresh = stubModelDiscovery();
  const previous = useSettings.getState().showOnlyLatestTodoList;
  try {
    const payload = settingsPayload();
    payload.settings.showOnlyLatestTodoList = true;
    importSettings(payload);
    assert.equal(useSettings.getState().showOnlyLatestTodoList, true);

    importSettings(settingsPayload());
    assert.equal(useSettings.getState().showOnlyLatestTodoList, true);
  } finally {
    useSettings.setState({ showOnlyLatestTodoList: previous });
    restoreRefresh();
  }
});

test('importing an old export with no modelOverrides clears the current ones', () => {
  const restore = stubModelDiscovery();
  try {
    useAppModels.getState().replaceMetadataOverrides({ 'p1:model-a': { c: 4096 } });

    importSettings(settingsPayload());

    assert.deepEqual(useAppModels.getState().overrides, {});
  } finally {
    restore();
  }
});

test('settings import replaces model-list customizations', () => {
  const restore = stubModelDiscovery();
  try {
    useAppModels.getState().replaceModelCustomizations({
      old: { added: { stale: { n: 'Stale' } }, deleted: [] },
    });
    importSettings(settingsPayload(undefined, {
      next: { added: { manual: { n: 'Manual', c: 8192 } }, deleted: ['fetched'] },
    }));
    assert.deepEqual(useAppModels.getState().customizations, {
      next: { added: { manual: { n: 'Manual', c: 8192 } }, deleted: ['fetched'] },
    });
  } finally {
    restore();
    useAppModels.getState().resetModelCustomizations();
  }
});

test('settings import clears the stale detected-model cache', () => {
  const restore = stubModelDiscovery();
  try {
    // The imported profile IDs can collide with the previous installation's,
    // in which case this cache would hand the registry another machine's
    // metadata for the same key.
    storage.setItem('lc:server-model-cache', JSON.stringify({
      p1: {
        name: 'Stale', baseUrl: 'https://stale.example.test/v1', apiVariant: 'openai',
        updatedAt: Date.now(), models: { 'model-a': { c: 999 } },
      },
    }));

    importSettings(settingsPayload());

    assert.deepEqual(modelCache.getAll(), {});
  } finally {
    restore();
  }
});

test('reset settings clears in-memory, primary, and backup override state', async () => {
  useAppModels.getState().replaceMetadataOverrides({ 'p1:model-a': { c: 4096 } });
  assert.equal(storage.getItem('lc_model_meta_overrides'), JSON.stringify({ 'p1:model-a': { c: 4096 } }));
  useModelVisibility.getState().hide('p1', 'model-a');

  await resetSettings();

  assert.deepEqual(useAppModels.getState().overrides, {});
  assert.equal(storage.getItem('lc_model_meta_overrides'), '{}');
  assert.equal(storage.getItem('lc_model_meta_overrides_bak'), '{}');
  assert.equal(useModelVisibility.getState().hidden.size, 0);
});

test('reset settings durably resets every conversation parameter snapshot', async () => {
  const id = `reset-params-${crypto.randomUUID()}`;
  const prior = useConversations.getState();
  const seeded = {
    ...conversationWithId(id, 1),
    params: { ...DEFAULT_PARAMS, temperature: 0.91, tools_enabled: true },
  };
  try {
    await saveMeta(seeded);
    useConversations.setState((state) => ({
      byId: { ...state.byId, [id]: seeded },
      order: [id, ...state.order.filter((candidate) => candidate !== id)],
    }));

    await resetSettings();

    assert.deepEqual(useConversations.getState().byId[id]?.params, DEFAULT_PARAMS);
    assert.deepEqual(
      (await loadAllMeta()).find((conversation) => conversation.id === id)?.params,
      DEFAULT_PARAMS,
    );
  } finally {
    await deleteConversation(id);
    useConversations.setState({
      byId: prior.byId,
      order: prior.order,
      activeId: prior.activeId,
      persistenceFailure: prior.persistenceFailure,
    });
  }
});

test('clear and reset wipes overrides, visibility, and the derived model cache', async () => {
  useAppModels.getState().replaceMetadataOverrides({ 'p1:model-a': { v: false } });
  useModelVisibility.getState().hide('p1', 'model-a');
  useProfileStore.setState({
    profiles: [{ id: 'p-other', name: 'Other', baseUrl: 'https://other.example/v1', apiKey: 'SECRET', active: true }],
  });
  useSettings.setState({ assistantName: 'Custom' });
  storage.setItem('lc:server-model-cache', JSON.stringify({
    p1: {
      name: 'Old install', baseUrl: 'https://old.example.test/v1', apiVariant: 'openai',
      updatedAt: Date.now(), models: { 'model-a': { c: 999 } },
    },
  }));

  await clearAndResetAll();

  assert.deepEqual(useAppModels.getState().overrides, {});
  assert.equal(storage.getItem('lc_model_meta_overrides'), '{}');
  assert.equal(storage.getItem('lc_model_meta_overrides_bak'), '{}');
  assert.equal(useModelVisibility.getState().hidden.size, 0);
  // Otherwise the restored default profile rehydrates the previous
  // installation's detected models on the next launch.
  assert.deepEqual(modelCache.getAll(), {});
  // "Back to the default Local LM Studio profile" — the profile store must
  // actually be reset, not merely left for a reload to rediscover.
  const profiles = useProfileStore.getState().profiles;
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, 'local');
  assert.equal(profiles[0].name, 'Local LM Studio');
  assert.equal(useSettings.getState().assistantName, 'Assistant');
});

function conversationWithId(id: string, updatedAt: number): Conversation {
  return {
    id,
    title: `imported ${id}`,
    createdAt: 1,
    updatedAt,
    params: { ...DEFAULT_PARAMS },
    messages: [{ id: `${id}-m`, role: 'user' as const, content: 'x', createdAt: 1 }],
  };
}

test('conversation import puts imported chats at the top and counts only new ids', async () => {
  const prior = useConversations.getState();
  useConversations.setState({
    byId: {
      'existing-a': conversationWithId('existing-a', 1000),
      'existing-b': conversationWithId('existing-b', 2000),
    },
    order: ['existing-a', 'existing-b'],
    activeId: null,
    persistenceFailure: null,
  });
  try {
    const count = await importConversations({
      format: 'llm-client:conversations',
      version: 1,
      exportedAt: 1,
      conversations: [
        conversationWithId('new-a', 30),
        conversationWithId('existing-a', 10),
        conversationWithId('new-a', 30), // duplicate within the file itself
        conversationWithId('new-b', 20),
      ],
    });

    assert.equal(count, 2);
    assert.deepEqual(
      useConversations.getState().order,
      ['new-a', 'existing-a', 'new-b', 'existing-b'],
    );
  } finally {
    useConversations.setState({
      byId: prior.byId,
      order: prior.order,
      activeId: prior.activeId,
      persistenceFailure: prior.persistenceFailure,
    });
  }
});

test('legacy import reopens a tombstoned lane for subsequent durable writes', async () => {
  const id = `legacy-reopen-${crypto.randomUUID()}`;
  const prior = useConversations.getState();
  try {
    await persistImportedConversationArchive(importedBundle(
      conversationWithId(id, 1),
      retainedPair(id, '0101000000000', 'stale legacy lifetime'),
    ));
    await savePendingUserWhiteboard(id, '# stale working state');
    await recordGenerationRun({
      conversationId: id,
      generationId: 'old-legacy-generation',
      assistantMessageId: `${id}-old-assistant`,
      state: 'stopping',
      startedAt: 1,
    });
    closeConversationPersistence(id);
    await useConversationUi.getState().releaseConversation(id);
    assert.equal(
      await importConversations({
        format: 'llm-client:conversations',
        version: 1,
        exportedAt: 1,
        conversations: [conversationWithId(id, 10)],
      }),
      1,
    );
    assert.equal(
      await loadGenerationRun(id),
      undefined,
      'legacy replacement retires crash evidence from the previous lifetime',
    );
    const whiteboardRows = await readWhiteboardStorageRowsForTests(id);
    assert.equal(whiteboardRows.versions.length, 0);
    assert.equal(whiteboardRows.working.length, 0);

    const imported = useConversations.getState().byId[id];
    assert.ok(imported);
    assert.equal(
      await enqueueConversationWrite(
        id,
        'post-import metadata mutation',
        () => saveMeta({ ...imported, title: 'durable after import' }),
      ),
      'committed',
    );
    await drainConversationPersistence(id);
    assert.equal(
      (await loadAllMeta()).find((conversation) => conversation.id === id)?.title,
      'durable after import',
    );
    useConversationUi.getState().setDraftText(id, 'fresh imported lifetime');
    assert.equal(
      useConversationUi.getState().get(id).draftText,
      'fresh imported lifetime',
      'the imported conversation is no longer UI-tombstoned',
    );
  } finally {
    clearHighlight(id);
    await deleteConversation(id);
    useConversations.setState({
      byId: prior.byId,
      order: prior.order,
      activeId: prior.activeId,
      persistenceFailure: prior.persistenceFailure,
    });
  }
});

test('settings import keeps a local plaintext search key when the file carries no replacement', () => {
  const restore = stubModelDiscovery();
  const priorTools = useSettings.getState().tools;
  useSettings.getState().setTools({
    ...priorTools,
    brave_search_api_key: 'SECRET',
    brave_search_api_key_ref: undefined,
  });
  try {
    importSettings(settingsPayload());
    const tools = useSettings.getState().tools;
    assert.equal(tools.brave_search_api_key, 'SECRET');
    assert.equal(tools.brave_search_api_key_ref, '');
  } finally {
    restore();
    useSettings.setState({ tools: priorTools });
  }
});

test('settings import replaces the local plaintext key when the file carries a keychain ref', () => {
  const restore = stubModelDiscovery();
  const priorTools = useSettings.getState().tools;
  useSettings.getState().setTools({
    ...priorTools,
    brave_search_api_key: 'SECRET',
    brave_search_api_key_ref: undefined,
  });
  const payload = settingsPayload();
  payload.settings.tools.brave_search_api_key_ref = 'brave-search-key';
  try {
    importSettings(payload);
    const tools = useSettings.getState().tools;
    assert.equal(tools.brave_search_api_key, '');
    assert.equal(tools.brave_search_api_key_ref, 'brave-search-key');
  } finally {
    restore();
    useSettings.setState({ tools: priorTools });
  }
});

test('settings import disconnects a local credential when its endpoint changes', () => {
  const restore = stubModelDiscovery();
  const priorProfiles = useProfileStore.getState().profiles;
  useProfileStore.setState({
    profiles: [{
      id: 'p1',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'SECRET',
      apiKeyRef: 'profile.p1',
      active: true,
    }],
  });
  const payload = settingsPayload();
  payload.settings.profiles = [{
    id: 'p1',
    name: 'Imported',
    baseUrl: 'https://imported.example/v1',
    apiKeyRef: 'profile.p1',
    active: true,
  }];
  try {
    importSettings(payload);
    const [imported] = useProfileStore.getState().profiles;
    assert.equal(imported.name, 'Imported');
    assert.equal(imported.baseUrl, 'https://imported.example/v1');
    assert.equal(imported.apiKey, undefined);
    assert.equal(imported.apiKeyRef, undefined);
  } finally {
    restore();
    useProfileStore.setState({ profiles: priorProfiles });
  }
});

test('settings import preserves a local credential for unchanged destinations', () => {
  const restore = stubModelDiscovery();
  const priorProfiles = useProfileStore.getState().profiles;
  useProfileStore.setState({
    profiles: [{
      id: 'p1',
      name: 'Local',
      baseUrl: 'https://same.example/v1',
      modelFetchUrl: 'https://same.example/models',
      apiKey: 'SECRET',
      apiKeyRef: 'profile.p1',
      active: true,
    }],
  });
  const payload = settingsPayload();
  payload.settings.profiles = [{
    id: 'p1',
    name: 'Imported name',
    baseUrl: 'https://same.example/v1',
    modelFetchUrl: 'https://same.example/models',
    apiKeyRef: 'profile.p1',
    active: true,
  }];
  try {
    importSettings(payload);
    const [imported] = useProfileStore.getState().profiles;
    assert.equal(imported.name, 'Imported name');
    assert.equal(imported.apiKey, 'SECRET');
    assert.equal(imported.apiKeyRef, 'profile.p1');
  } finally {
    restore();
    useProfileStore.setState({ profiles: priorProfiles });
  }
});

test('archive reader restores blobs only after an admitted same-id delete has drained', async () => {
  await useConversations.getState().hydrate();
  const prior = useConversations.getState();
  const id = `archive-delete-blob-${crypto.randomUUID()}`;
  const attachmentId = `archive-delete-attachment-${crypto.randomUUID()}`;
  const attachment = {
    id: attachmentId,
    name: 'replacement.txt',
    mime: 'text/plain',
    isImage: false,
    size: 3,
    stored: 'idb' as const,
  };
  const oldMessage: Message = {
    id: `${id}-old-message`,
    role: 'user',
    content: 'old lifetime',
    createdAt: 1,
    attachments: [attachment],
  };
  const oldConversation = durableConversation(id, 'old lifetime', [oldMessage]);
  let releaseHead!: () => void;
  const gate = new Promise<void>((resolve) => { releaseHead = resolve; });
  try {
    await saveMeta(oldConversation);
    await saveMessages([oldMessage], id);
    await putAttachment(attachmentId, new Blob(['old']), {
      mime: attachment.mime,
      name: attachment.name,
      size: 3,
    });
    useConversations.setState((state) => ({
      byId: { ...state.byId, [id]: { ...oldConversation, messages: [] } },
      order: [id, ...state.order.filter((candidate) => candidate !== id)],
    }));

    const head = enqueueConversationWrite(id, 'hold delete lane', () => gate);
    useConversations.getState().remove(id);

    let readerCalled = false;
    const replacement = durableConversation(id, 'replacement lifetime', [{
      id: `${id}-replacement-message`,
      role: 'user',
      content: 'replacement lifetime',
      createdAt: 2,
      attachments: [attachment],
    }]);
    const importing = importConversationArchiveFile({} as File, async () => {
      readerCalled = true;
      await putAttachment(attachmentId, new Blob(['new']), {
        mime: attachment.mime,
        name: attachment.name,
        size: 3,
      });
      return [importedBundle(replacement, [])];
    });

    await Promise.resolve();
    assert.equal(readerCalled, false, 'the side-effecting reader waits for old cleanup');
    releaseHead();
    assert.equal(await head, 'committed');
    assert.equal((await importing).imported, 1);

    const restoredBlob = await loadAttachment(attachmentId);
    assert.equal(await restoredBlob?.text(), 'new');
  } finally {
    releaseHead();
    clearHighlight(id);
    await Promise.all([
      deleteConversation(id),
      deleteAttachment(attachmentId),
    ]);
    useConversations.setState({
      byId: prior.byId,
      order: prior.order,
      activeId: prior.activeId,
      persistenceFailure: prior.persistenceFailure,
    });
  }
});
