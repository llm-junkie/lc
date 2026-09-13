/**
 * Bulk import operations. The export side lives in `utils/export.ts`;
 * this file is the inverse — reads a parsed export object and applies
 * it to the live stores.
 *
 * Why a separate file? The export module is pure (reads store state,
 * produces a Blob). The import side has to mutate stores and handle
 * the cross-store dependency where conversations reference profile
 * IDs that may or may not exist. Keeping the two apart lets the
 * export module stay easy to test.
 *
 * For settings import: exported portable fields replace the current
 * values. Profiles are replaced, with one preservation: a profile whose
 * imported copy carries the same keychain ref keeps its local plaintext
 * API-key fallback, and keyed search-provider fields replace only when
 * the file carries the key or its ref — a credential the export cannot
 * reproduce is never destroyed by the import. UI/session state, secrets,
 * caches, and conversation data are intentionally outside this snapshot.
 *
 * Conversation import adds new IDs and replaces matching conversations.
 * It preserves conversations whose IDs are absent from the import.
 * Conversations reference `serverId` (a profile ID). If the imported
 * conversations point at profile IDs that no longer exist after the
 * settings import, those messages would have a dangling reference.
 * If both are being imported together, settings should be imported first
 * so conversation profile references resolve immediately.
 */

import type { Conversation, ServerProfile } from '../types';
import { DEFAULT_PARAMS } from '../types.ts';
import {
  ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE,
  addHighlights,
  drainAllConversationPersistence,
  isAnyStreaming,
  isGenerationBlockingOperationActive,
  markConversationCorpusMutation,
  reportConversationPersistenceFailure,
  runConversationWrite,
  runConversationRestoreWrite,
  unmarkConversationCorpusMutation,
  useConversations,
} from '../store/conversations.ts';
import {
  drainConversationUiCleanup,
  drainConversationUiWork,
  fenceConversationUiLifetime,
  useConversationUi,
} from '../store/conversation-ui.ts';
import { useSettings, getDefaultSettingsData } from '../store/settings.ts';
import { useProfileStore, modelCache, useAppModels } from '../modules/server-profiles/index.ts';
import { keychainGet } from '../platform/keychain.ts';
import { deleteProfileCredentials } from '../platform/chat-credential.ts';
import { invalidateGenerationModelDetailConfiguration } from '../modules/chat-pipeline/generation-model-detail-config.ts';
import { setSearchKey, type KeyedSearchProvider } from '../platform/search-key-cache.ts';
import {
  clearAttachments,
  loadStoredAttachment,
  putAttachments,
  restoreAttachmentRows,
  type AttachmentRollbackRow,
} from './idb.ts';
import { clearAndResetWindowState } from './windowState.ts';
import type { ConversationsExport, SettingsExport } from './export';
import { migrateSolidTheme } from '../platform/material-resolver.ts';
import { isTauri, tauriInvoke } from './saveBlob.ts';
import {
  conversationMetaToStorageRow,
  loadAllMeta,
  messageToStorageRow,
  persistedMessageSnapshot,
  replaceMessages,
  runConversationDataMutation,
  runConversationDataTransaction,
  saveMeta,
} from '../store/db.ts';
import { useModelVisibility } from '../store/modelVisibility.ts';
import { normalizeGrantState } from '../modules/tool-engine/grant-state.ts';
import { runLocalStorageMutation } from '../store/local-storage.ts';
import {
  replaceWhiteboardVersionsInTransaction,
} from '../store/whiteboard.ts';
import { readArchiveStaged, type ImportedConversation } from './exportArchive.ts';

export interface ConversationPersistence {
  saveMeta: typeof saveMeta;
  replaceMessages: typeof replaceMessages;
  /** Atomic production path; separate methods remain available to test failures. */
  persistConversation?: (conversation: Conversation) => Promise<void>;
}

export interface ConversationArchivePersistence {
  persist(bundle: ImportedConversation): Promise<void>;
}

export interface ConversationArchiveImportFailure {
  conversationId: string;
  error: unknown;
}

export interface ConversationArchiveImportResult {
  /** Successfully persisted and applied archive conversations. */
  imported: number;
  /** Successful conversations whose IDs were not already in memory. */
  added: number;
  /** Normalized bundles that reached durable storage successfully. */
  successful: ImportedConversation[];
  /** Per-conversation durable failures. */
  failures: ConversationArchiveImportFailure[];
}

function normalizedImportedConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((source) => {
      // Route imports through the same strict storage projection as reload,
      // clone, and archive export. Malformed replay accounting fails closed
      // before the conversation becomes visible in memory.
      const { streaming: _streaming, ...message } = persistedMessageSnapshot(source);
      return {
        ...message,
        attachments: message.attachments?.map(({ dataUrl: _dataUrl, ...attachment }) => attachment),
      };
    }),
    messageCount: conversation.messages.length,
    tools: conversation.tools ? normalizeGrantState(conversation.tools) : undefined,
  };
}

/**
 * Atomically replace one archive conversation's metadata, complete message
 * history, retained Whiteboard rows, and mutable Whiteboard state. Attachment
 * blobs are staged by the validated reader and installed by the caller around
 * this transaction with compensating rollback on failure.
 */
async function persistImportedConversationArchiveTransaction(
  bundle: ImportedConversation,
): Promise<void> {
  const conversation = normalizedImportedConversation(bundle.conversation);
  await runConversationDataMutation(async (tables) => {
    await tables.conversationsMeta.put(conversationMetaToStorageRow(conversation));
    await tables.messages.where('conversationId').equals(conversation.id).delete();
    if (conversation.messages.length > 0) {
      // `add` semantics make a message ID collision with another conversation
      // fail and roll back instead of overwriting the unrelated message.
      await tables.messages.bulkAdd(
        conversation.messages.map((message) => messageToStorageRow(message, conversation.id)),
      );
    }
    await replaceWhiteboardVersionsInTransaction(
      tables,
      conversation.id,
      bundle.whiteboardVersions,
    );
    await tables.generationRuns.delete(conversation.id);
  });
}

/**
 * Restore one archive through the conversation's ordering lane. Any final
 * delete for the same ID commits first; a closed lane is reopened only for the
 * transactional restore and is closed again if that transaction fails.
 */
export function persistImportedConversationArchive(
  bundle: ImportedConversation,
): Promise<void> {
  return runConversationRestoreWrite(
    bundle.conversation.id,
    'import conversation archive',
    () => persistArchiveBundleWithAttachments(
      bundle,
      () => persistImportedConversationArchiveTransaction(bundle),
    ),
  );
}

const DEFAULT_CONVERSATION_ARCHIVE_PERSISTENCE: ConversationArchivePersistence = {
  // `importConversationArchivesUnderLease` supplies the lane wrapper so an
  // injected persistence seam cannot accidentally bypass ordering.
  persist: persistImportedConversationArchiveTransaction,
};

/** Attachment ids held by an unsent draft or an open edit, by conversation. */
function draftAttachmentOwners(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [conversationId, entry] of Object.entries(useConversationUi.getState().byId)) {
    for (const attachment of entry.draftAttachments) owners.set(attachment.id, conversationId);
    for (const attachmentId of entry.editAttachmentIds) owners.set(attachmentId, conversationId);
  }
  return owners;
}

async function persistArchiveBundleWithAttachments(
  bundle: ImportedConversation,
  persist: () => Promise<void>,
): Promise<void> {
  const attachmentIds = new Set(
    bundle.conversation.messages.flatMap((message) => (
      message.attachments?.map((attachment) => attachment.id) ?? []
    )),
  );
  if (attachmentIds.size > 0) {
    // A staged draft or in-progress edit owns blobs in the same global store
    // but has no durable message row, so a scan of `messages` alone cannot see
    // it. Importing over one would overwrite bytes the draft still references,
    // and sending it afterwards would attach the archive's content instead.
    for (const [attachmentId, ownerId] of draftAttachmentOwners()) {
      if (attachmentIds.has(attachmentId)) {
        throw new Error(
          `Attachment ${attachmentId} is staged in conversation ${ownerId}.`,
        );
      }
    }
    const conflictingOwners = await runConversationDataTransaction('r', async (tables) => {
      const conflicts = new Map<string, string>();
      const rows = await tables.messages.toArray();
      for (const row of rows) {
        if (row.conversationId === bundle.conversation.id || !row.attachmentsJson) continue;
        const attachments = JSON.parse(row.attachmentsJson) as Array<{ id?: unknown }>;
        for (const attachment of attachments) {
          if (typeof attachment.id === 'string' && attachmentIds.has(attachment.id)) {
            conflicts.set(attachment.id, row.conversationId);
          }
        }
      }
      return conflicts;
    });
    if (conflictingOwners.size > 0) {
      const [attachmentId, ownerId] = conflictingOwners.entries().next().value!;
      throw new Error(
        `Attachment ${attachmentId} already belongs to conversation ${ownerId}.`,
      );
    }
  }

  const staged = [...new Map(
    (bundle.stagedAttachments ?? []).map((attachment) => [attachment.id, attachment]),
  ).values()];
  let rollbackRows: AttachmentRollbackRow[] = [];
  if (staged.length > 0) {
    rollbackRows = await Promise.all(staged.map(async (attachment) => ({
      id: attachment.id,
      previous: await loadStoredAttachment(attachment.id),
    })));
    await putAttachments(staged);
  }

  try {
    await persist();
  } catch (error) {
    if (rollbackRows.length > 0) {
      try {
        await restoreAttachmentRows(rollbackRows);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Conversation import failed and its attachment rollback also failed.',
          { cause: rollbackError },
        );
      }
    }
    throw error;
  }
}

/**
 * Persist validated archive bundles before making any transcript visible in
 * memory. Each conversation is one independent transaction: a failed bundle
 * leaves that conversation's durable and in-memory state untouched while
 * later bundles can still succeed.
 */
async function importConversationArchivesUnderLease(
  bundles: ImportedConversation[],
  persistence: ConversationArchivePersistence = DEFAULT_CONVERSATION_ARCHIVE_PERSISTENCE,
): Promise<ConversationArchiveImportResult> {
  // Archive validation already rejects duplicate conversation groups. Keep a
  // defensive last-wins normalization here for injected callers and future
  // non-file entry points, without running two transactions for one ID.
  const normalized = [...new Map(bundles.map((bundle) => [
    bundle.conversation.id,
    {
      ...bundle,
      conversation: normalizedImportedConversation(bundle.conversation),
    },
  ])).values()];
  for (const bundle of normalized) {
    fenceConversationUiLifetime(bundle.conversation.id);
  }
  // Corpus admission blocks new mutations; finish every older lane task before
  // validating globally-keyed attachment ownership against durable messages.
  await drainAllConversationPersistence();
  await drainConversationUiWork();
  // UI-owned blob deletion uses a separate IndexedDB database. A same-ID
  // restore must not install archive bytes until cleanup from the old lifetime
  // has drained, or a late delete could remove the newly imported row.
  await drainConversationUiCleanup();
  const successful: ImportedConversation[] = [];
  const failures: ConversationArchiveImportFailure[] = [];

  for (const bundle of normalized) {
    try {
      await runConversationRestoreWrite(
        bundle.conversation.id,
        'import conversation archive',
        () => persistArchiveBundleWithAttachments(
          bundle,
          () => persistence.persist(bundle),
        ),
      );
      successful.push(bundle);
    } catch (error) {
      failures.push({ conversationId: bundle.conversation.id, error });
      reportConversationPersistenceFailure(
        'import conversation archive',
        error,
        bundle.conversation.id,
      );
    }
  }

  let addedIds: string[] = [];
  if (successful.length > 0) {
    await Promise.all(successful.map((bundle) => (
      useConversationUi.getState().replaceConversationLifetime(bundle.conversation.id)
    )));
    const importedIds = successful.map((bundle) => bundle.conversation.id);
    const importedIdSet = new Set(importedIds);
    const successfulById = new Map(
      successful.map((bundle) => [bundle.conversation.id, bundle.conversation]),
    );
    useConversations.setState((current) => {
      addedIds = importedIds.filter((id) => current.byId[id] === undefined);
      const byId = { ...current.byId };
      for (const [id, conversation] of successfulById) {
        byId[id] = current.activeId === id
          ? conversation
          : { ...conversation, messages: [] };
      }
      return {
        byId,
        order: [
          ...importedIds,
          ...current.order.filter((id) => !importedIdSet.has(id)),
        ],
        // An import replaces these transcripts wholesale, so any load still
        // marked for them describes rows that no longer exist.
        loadingMessageIds: new Set(
          [...current.loadingMessageIds].filter((id) => !importedIdSet.has(id)),
        ),
        structuralVersion: current.structuralVersion + 1,
      };
    });
    addHighlights(addedIds);
  }

  return {
    imported: successful.length,
    added: addedIds.length,
    successful,
    failures,
  };
}

async function persistImportedLegacyConversationTransaction(
  conversation: Conversation,
): Promise<void> {
  await runConversationDataMutation(async (tables) => {
    await tables.conversationsMeta.put(conversationMetaToStorageRow(conversation));
    await tables.messages.where('conversationId').equals(conversation.id).delete();
    if (conversation.messages.length > 0) {
      // A cross-conversation message-ID collision fails and rolls the whole
      // restore back instead of overwriting an unrelated row.
      await tables.messages.bulkAdd(
        conversation.messages.map((message) => messageToStorageRow(message, conversation.id)),
      );
    }
    await tables.whiteboardVersions.where('conversationId').equals(conversation.id).delete();
    await tables.whiteboardWorking.where('conversationId').equals(conversation.id).delete();
    // The imported transcript is a new lifetime for this ID. Old crash
    // evidence must never repair or interrupt it on the next startup.
    await tables.generationRuns.delete(conversation.id);
  });
}

const DEFAULT_CONVERSATION_PERSISTENCE: ConversationPersistence = {
  saveMeta,
  replaceMessages,
  persistConversation: persistImportedLegacyConversationTransaction,
};

export async function importConversationArchives(
  bundles: ImportedConversation[],
  persistence: ConversationArchivePersistence = DEFAULT_CONVERSATION_ARCHIVE_PERSISTENCE,
): Promise<ConversationArchiveImportResult> {
  const operation = markConversationCorpusMutation('Import conversation archives');
  try {
    await operation.ready;
    return await importConversationArchivesUnderLease(bundles, persistence);
  } finally {
    unmarkConversationCorpusMutation(operation.operationId);
  }
}

/**
 * File-level archive import. The corpus lease starts before archive reading so
 * the default staged reader and any injected reader belong to one lifetime.
 * No clear/delete can interleave between parsing and durable installation.
 */
export async function importConversationArchiveFile(
  file: File,
  reader: (file: File) => Promise<ImportedConversation[]> = readArchiveStaged,
  persistence: ConversationArchivePersistence = DEFAULT_CONVERSATION_ARCHIVE_PERSISTENCE,
): Promise<ConversationArchiveImportResult> {
  const operation = markConversationCorpusMutation('Import conversation archive file');
  try {
    await operation.ready;
    // Finish deletes admitted before the lease before invoking even an
    // injected reader, which may still have attachment-storage side effects.
    await drainAllConversationPersistence();
    const bundles = await reader(file);
    return await importConversationArchivesUnderLease(bundles, persistence);
  } finally {
    unmarkConversationCorpusMutation(operation.operationId);
  }
}

/** Persist legacy JSON imports atomically by default. The split metadata/
 * message seam remains only for focused injected tests and older callers. */
export async function persistImportedConversations(
  conversations: Conversation[],
  persistence: ConversationPersistence = DEFAULT_CONVERSATION_PERSISTENCE,
): Promise<Array<string | null>> {
  return Promise.all(conversations.map(async (conversation): Promise<string | null> => {
    try {
      await runConversationRestoreWrite(
        conversation.id,
        'import legacy conversation',
        async () => {
          if (persistence.persistConversation) {
            await persistence.persistConversation(conversation);
          } else {
            await persistence.saveMeta(conversation);
            await persistence.replaceMessages(conversation.id, conversation.messages);
          }
        },
      );
      return conversation.id;
    } catch (error) {
      reportConversationPersistenceFailure('import conversation', error, conversation.id);
      return null;
    }
  }));
}

/** The single default profile both reset paths restore. */
const DEFAULT_LOCAL_PROFILE: ServerProfile = {
  id: 'local',
  name: 'Local LM Studio',
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: '',
  apiKeyRef: '',
  apiVariant: 'openai',
  routing: 'proxy',
  note: 'Default local LM Studio profile',
  active: true,
  sse_read_timeout_min: 5,
  apiStyle: 'chat',
  includeLcIdentifierHeader: false,
  lcIdentifierHeader: { name: '', value: '' },
  includeAdditionalRequestHeaders: false,
  requestHeaders: [],
};

/**
 * Merge the imported conversations into the existing set. Imported
 * chats are added to the top of the list. If an imported conversation
 * has the same ID as an existing one, the imported version overwrites
 * the existing entry in place (its contents are updated) and the
 * entry is moved to the top of the list. Duplicate IDs in the import
 * file itself are deduplicated; the toast reports how many new IDs
 * were added (zero on a re-import of the same file).
 *
 * Returns the count of newly added IDs, for the toast.
 */
export async function importConversations(payload: ConversationsExport): Promise<number> {
  const operation = markConversationCorpusMutation('Import legacy conversations');
  try {
    await operation.ready;
    const normalized = payload.conversations.map(normalizedImportedConversation);
    // Last duplicate wins before persistence so duplicate IDs cannot race.
    const conversations = [...new Map(
      normalized.map((conversation) => [conversation.id, conversation]),
    ).values()];
    for (const conversation of conversations) {
      fenceConversationUiLifetime(conversation.id);
    }
    await drainConversationUiWork();
    await drainConversationUiCleanup();
    const outcomes = await persistImportedConversations(conversations);
    const persisted = new Set(outcomes.filter((id): id is string => id !== null));
    const successful = conversations.filter((conversation) => persisted.has(conversation.id));
    if (successful.length === 0) return 0;

    await Promise.all(successful.map((conversation) => (
      useConversationUi.getState().replaceConversationLifetime(conversation.id)
    )));

    const state = useConversations.getState();
    const existingIds = new Set(Object.keys(state.byId));
    const importedIds = successful.map((conversation) => conversation.id);
    const importedIdSet = new Set(importedIds);
    const newIds = importedIds.filter((id) => !existingIds.has(id));
    const byId: Record<string, Conversation> = { ...state.byId };
    for (const conversation of successful) {
      byId[conversation.id] = state.activeId === conversation.id
        ? conversation
        : { ...conversation, messages: [] };
    }
    useConversations.setState({
      byId,
      order: [
        ...importedIds,
        ...state.order.filter((id) => !importedIdSet.has(id)),
      ],
      loadingMessageIds: new Set(
        [...state.loadingMessageIds].filter((id) => !importedIdSet.has(id)),
      ),
      structuralVersion: state.structuralVersion + 1,
    });
    addHighlights(newIds);
    return newIds.length;
  } finally {
    unmarkConversationCorpusMutation(operation.operationId);
  }
}

/**
 * Apply the imported portable settings snapshot. Exported fields replace
 * their current values; intentionally omitted UI/session state remains
 * unchanged. Returns a short summary of what was imported.
 */
export function importSettings(payload: SettingsExport): {
  profiles: number;
} {
  if (isAnyStreaming() || isGenerationBlockingOperationActive()) {
    throw new Error(ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE);
  }
  const s = payload.settings;

  // Write profiles and params into the profile store. A portable profile can
  // reuse a local credential only when its identity, reference, and both
  // credential destinations are unchanged. A matching ID alone is not
  // authority: a crafted import could otherwise keep the local reference and
  // replace the endpoint that receives the key. A new or changed destination
  // is imported without `apiKeyRef`; the user must connect its credential.
  const prevProfiles = useProfileStore.getState().profiles;
  const nextProfiles = s.profiles.map((imported) => {
    if (!imported.apiKeyRef) return imported;
    const prev = prevProfiles.find((candidate) => candidate.id === imported.id);
    const retainsLocalCredential = (
      prev?.apiKeyRef === imported.apiKeyRef &&
      prev.baseUrl === imported.baseUrl &&
      (prev.modelFetchUrl ?? '') === (imported.modelFetchUrl ?? '')
    );
    if (!retainsLocalCredential) {
      return { ...imported, apiKeyRef: undefined };
    }
    return prev.apiKey ? { ...imported, apiKey: prev.apiKey } : imported;
  });
  useProfileStore.setState({ profiles: nextProfiles });
  invalidateGenerationModelDetailConfiguration();
  const retainedCredentialRefs = new Set(nextProfiles.map((profile) => profile.apiKeyRef));
  void deleteProfileCredentials(prevProfiles.filter((profile) => (
    profile.apiKeyRef && !retainedCredentialRefs.has(profile.apiKeyRef)
  )));

  // Keyed search-provider fields replace exactly when the file carries the
  // key or its keychain ref. A file that carries neither must not erase a
  // local plaintext key: a key with no ref exists only in this store (web
  // build, or a failed keychain write), and the export cannot carry it.
  // Every keyed provider must appear in the list below.
  const importedTools = s.tools as Record<string, unknown>;
  const prevTools = useSettings.getState().tools as Record<string, unknown>;
  const nextTools: Record<string, unknown> = { ...prevTools, ...importedTools };
  const keyedProviders: Array<[KeyedSearchProvider, string, string]> = [
    ['brave', 'brave_search_api_key_ref', 'brave_search_api_key'],
    ['marginalia', 'marginalia_api_key_ref', 'marginalia_api_key'],
  ];
  for (const [, refField, keyField] of keyedProviders) {
    if (!importedTools[keyField] && !importedTools[refField] && prevTools[keyField]) {
      nextTools[keyField] = prevTools[keyField];
    }
  }

  // Write everything else into the settings store.
  useSettings.setState((prev) => ({
    ...prev,
    theme: s.theme,
    assistantName: s.assistantName,
    zoom: s.zoom,
    autoArchiveDays: s.autoArchiveDays,
    maxConcurrentGenerations: s.maxConcurrentGenerations ?? 2,
    previewOverlayHeight: s.previewOverlayHeight,
    // Legacy v1 exports carried `solidTheme`; map it so an old file
    // keeps its effective preference. An impossible legacy value falls
    // back to the default rather than rejecting the whole import.
    materialMode: s.materialMode ?? migrateSolidTheme(s.solidTheme) ?? 'auto',
    pinComposer: s.pinComposer,
    tokenMeterStyle: s.tokenMeterStyle,
    autoPreviewReasoning: s.autoPreviewReasoning,
    showOnlyLatestTodoList: s.showOnlyLatestTodoList ?? true,
    customThemes: s.customThemes,
    activeCustomThemeId: s.activeCustomThemeId,
    themeFilter: s.themeFilter,
    tools: nextTools as unknown as typeof prev.tools,
  }));

  // Restore the exported visibility filter exactly. An empty array is a
  // valid current setting and intentionally clears the existing selection.
  useModelVisibility.setState({ hidden: new Set(s.hiddenModels) });
  // Reset cached filter button counts — the panel will recompute on next open.
  runLocalStorageMutation(() => localStorage.removeItem('lc_filter_counts'));

  // Replace, never merge: an older export with no `modelOverrides` clears
  // the current ones, exactly like every other field in this snapshot.
  useAppModels.getState().replaceMetadataOverrides(s.modelOverrides ?? {});
  useAppModels.getState().replaceModelCustomizations(s.modelCustomizations ?? {});

  // The imported profile IDs may collide with IDs from the previous
  // installation, in which case the persistent base cache would hand the
  // registry another machine's model metadata. Drop it and rebuild: records
  // and effective models recompute immediately from the (now empty) cache
  // plus the installed overrides, then again from real detected models as
  // discovery completes.
  modelCache.clearAll();
  void useAppModels.getState().bootstrap();

  // After import, load each search-provider key from the encrypted local key
  // store if a reference exists but the plaintext value was not exported.
  //
  // Every keyed provider must be listed. Missing one leaves that provider
  // broken until the next app start — the store holds '' because a ref
  // exists, so `credentialFor` finds nothing in the cache and the search
  // fails with "not configured" while the others keep working.
  for (const [provider, refField, keyField] of keyedProviders) {
    const ref = importedTools[refField] as string | undefined;
    if (!isTauri || !ref || importedTools[keyField]) continue;
    // Into the in-memory cache, not the persisted store — see
    // platform/search-key-cache.ts.
    keychainGet(ref).then((val) => {
      if (val) setSearchKey(provider, val);
    }).catch(() => {});
  }
  return { profiles: s.profiles.length };
}

/**
 * Wipe everything: every conversation, every attachment blob in IDB,
 * and both persisted stores — settings AND profiles — reset to their
 * defaults (the default Local LM Studio profile). Reload is the
 * caller's responsibility — we don't navigate here so the import side
 * stays testable.
 *
 * Rejected at the mutation boundary during an active generation, like
 * every other destructive reset.
 *
 * The conversation wipe must commit before any other store is reset. The
 * secondary attachment/window cleanup remains best-effort.
 */
export async function clearAndResetAll(): Promise<void> {
  const operation = markConversationCorpusMutation('Reset all application data');
  try {
    await operation.ready;
    const cleared = await useConversations.getState().clearAll(operation.operationId);
    // A full restore ends every conversation's lifetime, so their drafts and
    // staged attachments go with them; a restored ID must not inherit the
    // draft that belonged to the conversation it replaced.
    if (cleared) await useConversationUi.getState().releaseAll();
    if (!cleared) throw new Error('Conversation storage could not be cleared.');
    // Clear the metadata overrides and the visibility filter through their
    // stores. Removing 'lc:settings' below does not touch their keys, and a
    // reload would otherwise restore both from storage that survived the wipe.
    useAppModels.getState().resetMetadataOverrides();
    useAppModels.getState().resetModelCustomizations();
    useModelVisibility.getState().resetAll();
    // And the derived detected-model cache, which lives under its own key too.
    // Leaving it would let the restored default profile briefly rehydrate the
    // previous installation's models on the next launch — no user data, but a
    // "clear everything" that visibly does not.
    modelCache.clearAll();
    try {
      await clearAttachments();
    } catch {
      // The conversation transaction has committed; orphaned blob cleanup is
      // best-effort and can be retried by a later reset.
    }
    // Reset both persisted stores through their own setters so the in-memory
    // state and the persist write agree immediately, instead of deleting
    // localStorage keys and hoping no re-render re-persists the pre-wipe state
    // during the reload window. Deleting only 'lc:settings' would also leave
    // 'lc:profile-store' untouched, so profiles would survive a full wipe.
    await deleteProfileCredentials(useProfileStore.getState().profiles);
    useSettings.setState(getDefaultSettingsData());
    useProfileStore.setState({ profiles: [{ ...DEFAULT_LOCAL_PROFILE }] });
    invalidateGenerationModelDetailConfiguration();

    // Also wipe the window-state plugin's saved geometry so the next launch
    // uses the configured default size and position. Best-effort: failure only
    // leaves the previous geometry for the next launch.
    try {
      await clearAndResetWindowState();
    } catch {
      // ignore
    }
  } finally {
    unmarkConversationCorpusMutation(operation.operationId);
  }
}

/**
 * Reset everything EXCEPT the conversation history. Used by the
 * Settings row's "Reset settings" button — same as
 * `clearAndResetAll` minus the conversation store and
 * attachment clear, so the user's chat history survives.
 *
 * Each conversation stores its own params snapshot (see
 * `Conversation.params`), so a plain settings-store reset
 * leaves every conversation's preset stuck at whatever the
 * user picked last. We walk every conversation and reset
 * its `params` to `DEFAULT_PARAMS` (all `*_enabled: false`),
 * which makes the params panel show "Server default" for
 * every chat.
 *
 * The settings store is reset to its full defaults via
 * `getDefaultSettingsData()` so the persisted write produces
 * the default state rather than racing with a
 * `localStorage.removeItem` call. On reload the store
 * hydrates from the clean defaults.
 *
 * Note: the window-state plugin's file is also NOT touched
 * here, because the user is doing a "settings reset",
 * not a full app reset. Their window position/size should
 * survive a settings reset.
 */
export async function resetSettings(): Promise<void> {
  if (isAnyStreaming() || isGenerationBlockingOperationActive()) {
    throw new Error(ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE);
  }
  const operation = markConversationCorpusMutation('Reset application settings');
  try {
    await operation.ready;
    // Reset every durable conversation's per-chat params snapshot before the
    // UI reports success. Zustand does not persist this store itself.
    await drainAllConversationPersistence();
    const durableConversations = await loadAllMeta();
    const resetTargets = new Map(
      durableConversations.map((conversation) => [conversation.id, conversation]),
    );
    for (const conversation of Object.values(useConversations.getState().byId)) {
      if (!resetTargets.has(conversation.id)) resetTargets.set(conversation.id, conversation);
    }
    await Promise.all(Array.from(resetTargets.values(), (conversation) => {
      const updated = { ...conversation, params: { ...DEFAULT_PARAMS } };
      return runConversationWrite(
        conversation.id,
        'reset conversation parameters',
        () => saveMeta(updated),
      );
    }));
    useConversations.setState((s) => {
      const nextById: Record<string, Conversation> = {};
      for (const [id, conv] of Object.entries(s.byId)) {
        nextById[id] = { ...conv, params: { ...DEFAULT_PARAMS } };
      }
      return { byId: nextById };
    });

    // Reset profiles and the entire settings store through their setters so
    // in-memory state and their persisted snapshots agree immediately.
    await deleteProfileCredentials(useProfileStore.getState().profiles);
    useProfileStore.setState({
      profiles: [{ ...DEFAULT_LOCAL_PROFILE }],
    });
    invalidateGenerationModelDetailConfiguration();
    useSettings.setState(getDefaultSettingsData());

    // Rebuild model discovery from clean metadata and visibility state.
    modelCache.clearAll();
    useModelVisibility.getState().resetAll();
    useAppModels.getState().resetMetadataOverrides();
    useAppModels.getState().resetModelCustomizations();
    runLocalStorageMutation(() => localStorage.removeItem('lc_filter_counts'));

    if (isTauri) {
      try {
        await tauriInvoke('reset_window_state');
      } catch {
        // Best-effort.
      }
      // Delete the downloaded models-cache.json so the next sync re-fetches
      // models.dev and the next lookup falls back to the bundled copy.
      try {
        await tauriInvoke('clear_models_dev_cache');
      } catch {
        // Best-effort.
      }
    }
  } finally {
    unmarkConversationCorpusMutation(operation.operationId);
  }
}
