/**
 * Per-conversation UI state — the temporary things a chat remembers that are
 * not part of its durable record.
 *
 * Until now this state lived inside `Composer`, which `ChatView` mounted with
 * `key={`composer-${conv.id}`}`. That key made the component remount on every
 * conversation switch, which destroyed the draft outright and, worse, orphaned
 * any attachment blob the draft was holding: `removeAttachmentBlob` only ran
 * from the explicit remove button, so switching away from a chat with a staged
 * file leaked its bytes in IndexedDB with nothing left referencing them.
 *
 * Ownership is therefore explicit here rather than implied by component
 * lifetime:
 *
 *   - Removing an attachment from a draft deletes its blob.
 *   - Sending a draft *transfers* ownership to the message, so the blob is
 *     deliberately not deleted.
 *   - Discarding a draft, or deleting its conversation, deletes the blobs the
 *     draft still holds.
 *
 * Entries for conversations that are neither selected nor otherwise resident
 * are evicted by a bounded LRU, so drafts for hundreds of old chats cannot
 * accumulate. Eviction discards blobs, exactly like an explicit discard: an
 * evicted draft is gone, and leaving its bytes behind would be the same leak
 * in a slower form.
 *
 * Not persisted. Drafts are restart-ephemeral by design for this release.
 * Startup garbage collection removes blobs left by the previous process after
 * checking every durable message reference.
 */
import { create } from 'zustand';
import type { Attachment } from '../types';
import { removeAttachmentBlob } from '../utils/attachments.ts';
import { uid } from '../utils/uid.ts';
import {
  clearAllGenerationAttention,
  clearGenerationAttention,
} from '../modules/chat-pipeline/generation-session-manager.ts';
import { isConversationCorpusMutationActive } from './conversations.ts';

export type SidePanelTab = 'params' | 'tools';
export type ConversationPreviewTab = 'reasoning' | 'tools' | 'todo';

export interface ConversationUiState {
  draftText: string;
  draftAttachments: Attachment[];
  /**
   * The user message currently open for editing, if any.
   *
   * Component-local before this: `ChatView` held one `editingId` for the whole
   * app and never cleared it on a switch, so starting an edit in one chat and
   * navigating away left the destination chat's Composer hidden behind an edit
   * bubble that no longer existed.
   */
  editingMessageId: string | null;
  /** Stable fence for asynchronous work belonging to the current edit. */
  editSessionId: string | null;
  /** Prevent cancellation or mutation while durable edit replacement is pending. */
  editSubmitting: boolean;
  /** Complete unsaved edit state; switching conversations must not reset it. */
  editDraftText: string;
  editAttachments: Attachment[];
  /**
   * Blobs staged by an in-progress edit that no message owns yet.
   *
   * `MessageBubble` released these when the user cancelled, but a switch
   * unmounts it without cancelling, so the ids are mirrored here and released
   * with the rest of the conversation's UI state.
   */
  editAttachmentIds: string[];
  sidePanelOpen: boolean;
  sidePanelTab: SidePanelTab;
  scrollTop: number;
  followOutput: boolean;
  workspaceManagerOpen: boolean;
  workspaceSections: Record<string, boolean>;
  workspaceExpandedDir: string | null;
  previewOpenMessageId: string | null;
  previewDismissedDuringStream: boolean;
  previewPinned: boolean;
  previewPinnedByUser: boolean;
  previewActiveTab: ConversationPreviewTab;
  previewTabOverridden: boolean;
}

export const EMPTY_CONVERSATION_UI: Readonly<ConversationUiState> = Object.freeze({
  draftText: '',
  draftAttachments: [],
  editingMessageId: null,
  editSessionId: null,
  editSubmitting: false,
  editDraftText: '',
  editAttachments: [],
  editAttachmentIds: [],
  sidePanelOpen: false,
  sidePanelTab: 'tools' as SidePanelTab,
  scrollTop: 0,
  followOutput: true,
  workspaceManagerOpen: false,
  workspaceSections: {},
  workspaceExpandedDir: null,
  previewOpenMessageId: null,
  previewDismissedDuringStream: false,
  previewPinned: false,
  previewPinnedByUser: false,
  previewActiveTab: 'reasoning' as ConversationPreviewTab,
  previewTabOverridden: false,
});

/**
 * How many non-resident conversations keep UI state.
 *
 * Generous enough that ordinary back-and-forth navigation never loses a draft,
 * small enough that a long-lived session cannot accumulate unbounded staged
 * attachments.
 */
export const CONVERSATION_UI_LRU_LIMIT = 24;

/** Recent delete fences retained for callbacks that do not carry a lifetime. */
export const CONVERSATION_UI_TOMBSTONE_LIMIT = 256;

interface ConversationUiStore {
  byId: Record<string, ConversationUiState>;
  /** Most-recently-touched first. Only used to choose an eviction victim. */
  recency: string[];
  /**
   * Conversations deleted during this session.
   *
   * Attachment encoding is asynchronous, so a file dropped moments before a
   * delete can resolve after it. Without a tombstone the resulting
   * `addDraftAttachments` would recreate UI state for a conversation that no
   * longer exists, and its blob would have no owner to release it.
   * Only the 256 most recent fences remain. Lifetime-bearing attachment work
   * stays exact even after an older fence is evicted.
   */
  tombstoned: ReadonlySet<string>;

  get: (conversationId: string) => Readonly<ConversationUiState>;
  setDraftText: (conversationId: string, draftText: string) => void;
  addDraftAttachments: (
    conversationId: string,
    attachments: Attachment[],
    expectedLifetime?: number,
  ) => void;
  removeDraftAttachment: (conversationId: string, attachmentId: string) => Promise<void>;
  setSidePanel: (conversationId: string, open: boolean, tab?: SidePanelTab) => void;
  setPresentation: (
    conversationId: string,
    patch: Partial<Pick<
      ConversationUiState,
      | 'scrollTop'
      | 'followOutput'
      | 'workspaceManagerOpen'
      | 'workspaceSections'
      | 'workspaceExpandedDir'
      | 'previewOpenMessageId'
      | 'previewDismissedDuringStream'
      | 'previewPinned'
      | 'previewPinnedByUser'
      | 'previewActiveTab'
      | 'previewTabOverridden'
    >>,
  ) => void;
  beginEdit: (
    conversationId: string,
    messageId: string,
    text: string,
    attachments: readonly Attachment[],
  ) => string | null;
  setEditDraftText: (
    conversationId: string,
    messageId: string,
    editSessionId: string,
    text: string,
  ) => void;
  addEditAttachments: (
    conversationId: string,
    messageId: string,
    editSessionId: string,
    uiLifetime: number,
    attachments: Attachment[],
  ) => void;
  startEditSubmission: (
    conversationId: string,
    messageId: string,
    editSessionId: string,
  ) => boolean;
  resumeEditSubmission: (
    conversationId: string,
    messageId: string,
    editSessionId: string,
  ) => void;
  removeEditAttachment: (
    conversationId: string,
    messageId: string,
    editSessionId: string,
    attachmentId: string,
  ) => Promise<void>;
  /** Cancel an edit and release only the blobs staged by that edit. */
  cancelEdit: (
    conversationId: string,
    messageId: string,
    editSessionId: string,
  ) => Promise<void>;
  /** The durable edited message now owns the staged blobs. */
  finishEdit: (
    conversationId: string,
    messageId: string,
    editSessionId: string,
  ) => void;
  /**
   * Take the draft for sending. Clears it *without* deleting blobs, because
   * the message being sent becomes their owner.
   */
  takeDraft: (conversationId: string) => {
    text: string;
    attachments: Attachment[];
    uiLifetime: number;
  };
  /** Put a taken draft back after a send the store refused. */
  restoreDraft: (
    conversationId: string,
    text: string,
    attachments: Attachment[],
    uiLifetime?: number,
  ) => void;
  /** Clear a draft and delete the blobs it still owns. */
  discardDraft: (conversationId: string) => Promise<void>;
  /** Drop all UI state for a deleted conversation, releasing its blobs. */
  releaseConversation: (conversationId: string) => Promise<void>;
  /** Replace a durable conversation ID with a fresh, non-tombstoned UI lifetime. */
  replaceConversationLifetime: (conversationId: string) => Promise<void>;
  /** Drop every conversation's UI state. Used when the corpus is wiped. */
  releaseAll: () => Promise<void>;
  /** Evict UI state for conversations outside the resident set and the LRU. */
  pruneNonResident: (resident: ReadonlySet<string>) => Promise<void>;
}

function touch(recency: string[], conversationId: string): string[] {
  const next = recency.filter((id) => id !== conversationId);
  next.unshift(conversationId);
  return next;
}

function addBoundedTombstone(
  tombstoned: ReadonlySet<string>,
  conversationId: string,
): ReadonlySet<string> {
  const next = new Set(tombstoned);
  next.delete(conversationId);
  next.add(conversationId);
  while (next.size > CONVERSATION_UI_TOMBSTONE_LIMIT) {
    const oldest = next.values().next().value as string | undefined;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

let nextUiLifetime = 1;
const uiLifetimes = new Map<string, number>();
const uiCleanupTails = new Map<string, Promise<void>>();
const uiWork = new Map<string, Set<Promise<void>>>();

/** Current in-process UI lifetime for fencing asynchronous attachment work. */
export function conversationUiLifetime(conversationId: string): number {
  let lifetime = uiLifetimes.get(conversationId);
  if (lifetime === undefined) {
    lifetime = nextUiLifetime++;
    uiLifetimes.set(conversationId, lifetime);
  }
  return lifetime;
}

function rotateConversationUiLifetime(conversationId: string): number {
  const lifetime = nextUiLifetime++;
  uiLifetimes.set(conversationId, lifetime);
  return lifetime;
}

/** Fence work that started before a restore without discarding current UI state. */
export function fenceConversationUiLifetime(conversationId: string): number {
  return rotateConversationUiLifetime(conversationId);
}

/**
 * Register asynchronous attachment encoding before its first await.
 * Restore paths fence the lifetime, then drain this work before installing
 * same-ID bytes, so rejected late results finish their cleanup first.
 */
export function beginConversationUiWork(conversationId: string): {
  uiLifetime: number;
  finish: () => void;
} | null {
  // Corpus replacement fences every conversation lifetime and then drains
  // this registry. Refusing new work here is the service-level invariant that
  // makes that drain finite; UI disabled states are only presentation.
  if (
    isConversationCorpusMutationActive()
    || useConversationUi.getState().tombstoned.has(conversationId)
  ) return null;
  const uiLifetime = conversationUiLifetime(conversationId);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const work = uiWork.get(conversationId) ?? new Set<Promise<void>>();
  work.add(pending);
  uiWork.set(conversationId, work);
  void pending.finally(() => {
    work.delete(pending);
    if (work.size === 0 && uiWork.get(conversationId) === work) {
      uiWork.delete(conversationId);
    }
  });
  let finished = false;
  return {
    uiLifetime,
    finish: () => {
      if (finished) return;
      finished = true;
      finish();
    },
  };
}

/** Wait until every attachment encoder admitted before a restore has settled. */
export async function drainConversationUiWork(conversationId?: string): Promise<void> {
  while (true) {
    const pending = conversationId === undefined
      ? [...uiWork.values()].flatMap((work) => [...work])
      : [...(uiWork.get(conversationId) ?? [])];
    if (pending.length === 0) return;
    await Promise.all(pending);
  }
}

function enqueueUiCleanup(
  conversationId: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  const prior = uiCleanupTails.get(conversationId) ?? Promise.resolve();
  const task = prior.catch(() => undefined).then(cleanup);
  const tracked = task.finally(() => {
    if (uiCleanupTails.get(conversationId) === tracked) {
      uiCleanupTails.delete(conversationId);
    }
  });
  uiCleanupTails.set(conversationId, tracked);
  return tracked;
}

/** Import/restore waits for blob cleanup from the conversation's old lifetime. */
export async function drainConversationUiCleanup(conversationId?: string): Promise<void> {
  if (conversationId !== undefined) {
    await (uiCleanupTails.get(conversationId) ?? Promise.resolve());
    return;
  }
  await Promise.all([...uiCleanupTails.values()]);
}

async function retireConversationUiLifetime(
  conversationId: string,
  retiredLifetime: number,
): Promise<void> {
  await drainConversationUiWork(conversationId);
  await drainConversationUiCleanup(conversationId);
  if (
    uiLifetimes.get(conversationId) === retiredLifetime
    && useConversationUi.getState().byId[conversationId] === undefined
  ) {
    uiLifetimes.delete(conversationId);
  }
}

/** Best-effort blob release. A failure here must never break a UI action. */
async function releaseAttachmentIds(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => removeAttachmentBlob(id).catch(() => undefined)));
}

async function releaseAttachments(attachments: readonly Attachment[]): Promise<void> {
  await releaseAttachmentIds(attachments.map((attachment) => attachment.id));
}

/** Everything a conversation's UI state owns outright. */
function ownedAttachmentIds(entry: ConversationUiState): string[] {
  return [
    ...entry.draftAttachments.map((attachment) => attachment.id),
    ...entry.editAttachmentIds,
  ];
}

export const useConversationUi = create<ConversationUiStore>()((set, get) => ({
  byId: {},
  recency: [],
  tombstoned: new Set<string>(),

  get: (conversationId) => get().byId[conversationId] ?? EMPTY_CONVERSATION_UI,

  setDraftText: (conversationId, draftText) => set((state) => {
    if (state.tombstoned.has(conversationId)) return state;
    const current = state.byId[conversationId] ?? EMPTY_CONVERSATION_UI;
    if (current.draftText === draftText) return state;
    return {
      byId: { ...state.byId, [conversationId]: { ...current, draftText } },
      recency: touch(state.recency, conversationId),
    };
  }),

  addDraftAttachments: (conversationId, attachments, expectedLifetime?: number) => {
    // Refused outright for a deleted conversation, and the late bytes are
    // released rather than left behind with nothing referencing them.
    if (
      useConversationUi.getState().tombstoned.has(conversationId)
      || (expectedLifetime !== undefined
        && expectedLifetime !== conversationUiLifetime(conversationId))
    ) {
      void enqueueUiCleanup(conversationId, () => releaseAttachments(attachments));
      return;
    }
    set((state) => {
      if (
        state.tombstoned.has(conversationId)
        || (expectedLifetime !== undefined
          && expectedLifetime !== conversationUiLifetime(conversationId))
      ) {
        void enqueueUiCleanup(conversationId, () => releaseAttachments(attachments));
        return state;
      }
      if (attachments.length === 0) return state;
      const current = state.byId[conversationId] ?? EMPTY_CONVERSATION_UI;
      const known = new Set(current.draftAttachments.map((attachment) => attachment.id));
      const added = attachments.filter((attachment) => !known.has(attachment.id));
      if (added.length === 0) return state;
      return {
        byId: {
          ...state.byId,
          [conversationId]: {
            ...current,
            draftAttachments: [...current.draftAttachments, ...added],
          },
        },
        recency: touch(state.recency, conversationId),
      };
    });
  },

  removeDraftAttachment: async (conversationId, attachmentId) => {
    const current = get().byId[conversationId];
    const removed = current?.draftAttachments.find((a) => a.id === attachmentId);
    set((state) => {
      const entry = state.byId[conversationId];
      if (!entry) return state;
      return {
        byId: {
          ...state.byId,
          [conversationId]: {
            ...entry,
            draftAttachments: entry.draftAttachments.filter((a) => a.id !== attachmentId),
          },
        },
      };
    });
    // The draft was this blob's only owner, so removing it from the draft is
    // what releases the bytes.
    if (removed) {
      await enqueueUiCleanup(conversationId, () => releaseAttachments([removed]));
    }
  },

  setSidePanel: (conversationId, open, tab) => set((state) => {
    const current = state.byId[conversationId] ?? EMPTY_CONVERSATION_UI;
    const nextTab = tab ?? current.sidePanelTab;
    if (current.sidePanelOpen === open && current.sidePanelTab === nextTab) return state;
    return {
      byId: {
        ...state.byId,
        [conversationId]: { ...current, sidePanelOpen: open, sidePanelTab: nextTab },
      },
      recency: touch(state.recency, conversationId),
    };
  }),

  beginEdit: (conversationId, messageId, text, attachments) => {
    const state = get();
    if (state.tombstoned.has(conversationId)) return null;
    const previous = state.byId[conversationId] ?? EMPTY_CONVERSATION_UI;
    // A submitting edit has already handed this exact attachment set to the
    // durable replacement path. Replacing the session here would release its
    // staged blobs while that path is still awaiting preflight/persistence.
    if (previous.editSubmitting) return null;
    const editSessionId = uid();
    set({
      byId: {
        ...state.byId,
        [conversationId]: {
          ...previous,
          editingMessageId: messageId,
          editSessionId,
          editSubmitting: false,
          editDraftText: text,
          editAttachments: [...attachments],
          editAttachmentIds: [],
        },
      },
      recency: touch(state.recency, conversationId),
    });
    if (previous.editAttachmentIds.length > 0) {
      void enqueueUiCleanup(
        conversationId,
        () => releaseAttachmentIds(previous.editAttachmentIds),
      );
    }
    return editSessionId;
  },

  setEditDraftText: (conversationId, messageId, editSessionId, text) => set((state) => {
    if (state.tombstoned.has(conversationId)) return state;
    const current = state.byId[conversationId];
    if (
      !current
      || current.editingMessageId !== messageId
      || current.editSessionId !== editSessionId
      || current.editSubmitting
      || current.editDraftText === text
    ) return state;
    return {
      byId: { ...state.byId, [conversationId]: { ...current, editDraftText: text } },
      recency: touch(state.recency, conversationId),
    };
  }),

  setPresentation: (conversationId, patch) => set((state) => {
    if (state.tombstoned.has(conversationId)) return state;
    const current = state.byId[conversationId] ?? EMPTY_CONVERSATION_UI;
    return {
      byId: {
        ...state.byId,
        [conversationId]: { ...current, ...patch },
      },
      recency: touch(state.recency, conversationId),
    };
  }),

  addEditAttachments: (
    conversationId,
    messageId,
    editSessionId,
    uiLifetime,
    attachments,
  ) => {
    const state = get();
    const current = state.byId[conversationId];
    if (
      state.tombstoned.has(conversationId)
      || uiLifetime !== conversationUiLifetime(conversationId)
      || !current
      || current.editingMessageId !== messageId
      || current.editSessionId !== editSessionId
      || current.editSubmitting
    ) {
      void enqueueUiCleanup(conversationId, () => releaseAttachments(attachments));
      return;
    }
    const known = new Set(current.editAttachments.map((attachment) => attachment.id));
    const added = attachments.filter((attachment) => !known.has(attachment.id));
    if (added.length === 0) return;
    set((latest) => {
      const entry = latest.byId[conversationId];
      if (
        !entry
        || entry.editingMessageId !== messageId
        || entry.editSessionId !== editSessionId
        || entry.editSubmitting
        || latest.tombstoned.has(conversationId)
        || uiLifetime !== conversationUiLifetime(conversationId)
      ) {
        void enqueueUiCleanup(conversationId, () => releaseAttachments(added));
        return latest;
      }
      return {
        byId: {
          ...latest.byId,
          [conversationId]: {
            ...entry,
            editAttachments: [...entry.editAttachments, ...added],
            editAttachmentIds: [...entry.editAttachmentIds, ...added.map((a) => a.id)],
          },
        },
        recency: touch(latest.recency, conversationId),
      };
    });
  },

  startEditSubmission: (conversationId, messageId, editSessionId) => {
    let started = false;
    set((state) => {
      const current = state.byId[conversationId];
      if (
        !current
        || current.editingMessageId !== messageId
        || current.editSessionId !== editSessionId
        || current.editSubmitting
      ) return state;
      started = true;
      return {
        byId: {
          ...state.byId,
          [conversationId]: { ...current, editSubmitting: true },
        },
      };
    });
    return started;
  },

  resumeEditSubmission: (conversationId, messageId, editSessionId) => set((state) => {
    const current = state.byId[conversationId];
    if (
      !current
      || current.editingMessageId !== messageId
      || current.editSessionId !== editSessionId
      || !current.editSubmitting
    ) return state;
    return {
      byId: {
        ...state.byId,
        [conversationId]: { ...current, editSubmitting: false },
      },
    };
  }),

  removeEditAttachment: async (conversationId, messageId, editSessionId, attachmentId) => {
    const current = get().byId[conversationId];
    if (
      !current
      || current.editingMessageId !== messageId
      || current.editSessionId !== editSessionId
      || current.editSubmitting
    ) return;
    const staged = current.editAttachmentIds.includes(attachmentId);
    set((state) => {
      const entry = state.byId[conversationId];
      if (
        !entry
        || entry.editingMessageId !== messageId
        || entry.editSessionId !== editSessionId
        || entry.editSubmitting
      ) return state;
      return {
        byId: {
          ...state.byId,
          [conversationId]: {
            ...entry,
            editAttachments: entry.editAttachments.filter((a) => a.id !== attachmentId),
            editAttachmentIds: entry.editAttachmentIds.filter((id) => id !== attachmentId),
          },
        },
      };
    });
    if (staged) {
      await enqueueUiCleanup(conversationId, () => releaseAttachmentIds([attachmentId]));
    }
  },

  cancelEdit: async (conversationId, messageId, editSessionId) => {
    const current = get().byId[conversationId];
    if (
      !current
      || current.editingMessageId !== messageId
      || current.editSessionId !== editSessionId
      || current.editSubmitting
    ) return;
    set((state) => {
      const entry = state.byId[conversationId];
      if (
        !entry
        || entry.editingMessageId !== messageId
        || entry.editSessionId !== editSessionId
        || entry.editSubmitting
      ) return state;
      return {
        byId: {
          ...state.byId,
          [conversationId]: {
            ...entry,
            editingMessageId: null,
            editSessionId: null,
            editSubmitting: false,
            editDraftText: '',
            editAttachments: [],
            editAttachmentIds: [],
          },
        },
      };
    });
    await enqueueUiCleanup(
      conversationId,
      () => releaseAttachmentIds(current.editAttachmentIds),
    );
  },

  finishEdit: (conversationId, messageId, editSessionId) => set((state) => {
    const current = state.byId[conversationId];
    if (
      !current
      || current.editingMessageId !== messageId
      || current.editSessionId !== editSessionId
      || !current.editSubmitting
    ) return state;
    return {
      byId: {
        ...state.byId,
        [conversationId]: {
          ...current,
          editingMessageId: null,
          editSessionId: null,
          editSubmitting: false,
          editDraftText: '',
          editAttachments: [],
          // Ownership transferred to the durable edited message.
          editAttachmentIds: [],
        },
      },
    };
  }),

  takeDraft: (conversationId) => {
    const current = get().byId[conversationId] ?? EMPTY_CONVERSATION_UI;
    const taken = {
      text: current.draftText,
      attachments: current.draftAttachments,
      uiLifetime: conversationUiLifetime(conversationId),
    };
    set((state) => {
      const entry = state.byId[conversationId];
      if (!entry) return state;
      return {
        byId: {
          ...state.byId,
          [conversationId]: { ...entry, draftText: '', draftAttachments: [] },
        },
      };
    });
    return taken;
  },

  restoreDraft: (conversationId, text, attachments, uiLifetime) => set((state) => {
    if (
      state.tombstoned.has(conversationId)
      || (uiLifetime !== undefined && uiLifetime !== conversationUiLifetime(conversationId))
    ) {
      void enqueueUiCleanup(conversationId, () => releaseAttachments(attachments));
      return state;
    }
    const current = state.byId[conversationId] ?? EMPTY_CONVERSATION_UI;
    // Never overwrite what the user typed while the durable boundary was
    // pending; merge the taken draft underneath it instead.
    const knownIds = new Set(current.draftAttachments.map((a) => a.id));
    return {
      byId: {
        ...state.byId,
        [conversationId]: {
          ...current,
          draftText: current.draftText.length > 0 ? current.draftText : text,
          draftAttachments: current.draftAttachments.length === 0
            ? attachments
            : [...attachments.filter((a) => !knownIds.has(a.id)), ...current.draftAttachments],
        },
      },
      recency: touch(state.recency, conversationId),
    };
  }),

  discardDraft: async (conversationId) => {
    const current = get().byId[conversationId];
    if (!current) return;
    set((state) => {
      const entry = state.byId[conversationId];
      if (!entry) return state;
      return {
        byId: {
          ...state.byId,
          [conversationId]: { ...entry, draftText: '', draftAttachments: [] },
        },
      };
    });
    await enqueueUiCleanup(
      conversationId,
      () => releaseAttachments(current.draftAttachments),
    );
  },

  releaseConversation: async (conversationId) => {
    const current = get().byId[conversationId];
    const retiredLifetime = rotateConversationUiLifetime(conversationId);
    set((state) => {
      const { [conversationId]: _dropped, ...rest } = state.byId;
      return {
        byId: rest,
        // A deleted conversation is tombstoned rather than merely forgotten.
        // An attachment staged before the delete can still finish encoding
        // afterwards, and without this its `addDraftAttachments` would
        // recreate UI state — and an untracked blob — for a chat that is gone.
        //
        // Recorded unconditionally: a conversation deleted before it ever had
        // a draft has no entry to remove, and that is exactly the case where a
        // file dropped moments earlier is still encoding.
        tombstoned: addBoundedTombstone(state.tombstoned, conversationId),
        recency: state.recency.filter((id) => id !== conversationId),
      };
    });
    clearGenerationAttention(conversationId);
    if (current) {
      await enqueueUiCleanup(
        conversationId,
        () => releaseAttachmentIds(ownedAttachmentIds(current)),
      );
    }
    await retireConversationUiLifetime(conversationId, retiredLifetime);
  },

  replaceConversationLifetime: async (conversationId) => {
    const current = get().byId[conversationId];
    const retiredLifetime = rotateConversationUiLifetime(conversationId);
    set((state) => {
      const { [conversationId]: _dropped, ...rest } = state.byId;
      const tombstoned = new Set(state.tombstoned);
      tombstoned.delete(conversationId);
      return {
        byId: rest,
        tombstoned,
        recency: state.recency.filter((id) => id !== conversationId),
      };
    });
    clearGenerationAttention(conversationId);
    if (current) {
      await enqueueUiCleanup(
        conversationId,
        () => releaseAttachmentIds(ownedAttachmentIds(current)),
      );
    } else {
      await drainConversationUiCleanup(conversationId);
    }
    await retireConversationUiLifetime(conversationId, retiredLifetime);
  },

  releaseAll: async () => {
    const { byId } = get();
    const retiredLifetimes = new Map<string, number>();
    for (const id of uiLifetimes.keys()) {
      retiredLifetimes.set(id, rotateConversationUiLifetime(id));
    }
    // A wipe ends every conversation's lifetime, so previous tombstones are
    // meaningless and a fresh import may legitimately reuse any ID.
    set({ byId: {}, recency: [], tombstoned: new Set<string>() });
    clearAllGenerationAttention();
    await drainConversationUiWork();
    // A corpus wipe clears the attachment store wholesale, so this is
    // belt-and-braces rather than the only cleanup — but it keeps the two
    // stores consistent if the wipe order ever changes.
    await Promise.all(Object.entries(byId).map(([conversationId, entry]) => (
      enqueueUiCleanup(conversationId, () => releaseAttachmentIds(ownedAttachmentIds(entry)))
    )));
    await drainConversationUiCleanup();
    const latestById = get().byId;
    for (const [conversationId, retiredLifetime] of retiredLifetimes) {
      if (
        uiLifetimes.get(conversationId) === retiredLifetime
        && latestById[conversationId] === undefined
      ) {
        uiLifetimes.delete(conversationId);
      }
    }
  },

  pruneNonResident: async (resident) => {
    const { byId, recency } = get();
    const evictable = recency.filter((id) => !resident.has(id) && id in byId);
    if (evictable.length <= CONVERSATION_UI_LRU_LIMIT) return;
    const victims = evictable.slice(CONVERSATION_UI_LRU_LIMIT);
    const retiredLifetimes = new Map(
      victims.map((conversationId) => [
        conversationId,
        rotateConversationUiLifetime(conversationId),
      ]),
    );
    set((state) => {
      const nextById = { ...state.byId };
      for (const id of victims) {
        const entry = nextById[id];
        if (!entry) continue;
        delete nextById[id];
      }
      return {
        byId: nextById,
        recency: state.recency.filter((id) => !victims.includes(id)),
      };
    });
    // An evicted draft is gone, so its blobs go with it. Keeping them would be
    // the same leak the keyed remount used to produce, only slower.
    await Promise.all(victims.map(async (conversationId) => {
      const entry = byId[conversationId];
      if (entry) {
        await enqueueUiCleanup(
          conversationId,
          () => releaseAttachmentIds(ownedAttachmentIds(entry)),
        );
      }
      const retiredLifetime = retiredLifetimes.get(conversationId);
      if (retiredLifetime !== undefined) {
        await retireConversationUiLifetime(conversationId, retiredLifetime);
      }
    }));
  },
}));
