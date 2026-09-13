/**
 * Fixture helpers for tests that must own two or three conversations at once.
 *
 * Every existing conversation fixture reaches its target through `activeId`,
 * because until now exactly one conversation could be selected, loaded, and
 * generating. Concurrency work invalidates that shortcut: a test for two
 * simultaneous sessions has to address each conversation by explicit ID, and a
 * test for residency has to keep messages loaded for a conversation that is
 * deliberately *not* selected.
 *
 * These helpers therefore never read or write `activeId`. Seeding installs
 * durable rows and the matching in-memory state directly, so a caller can hold
 * three fully-loaded conversations with no selection at all.
 *
 * Pure store/Dexie access — no React, no Tauri. Import `fake-indexeddb/auto`
 * before this module, exactly as the surrounding store tests do, and call
 * `useConversations.getState().hydrate()` once *before* seeding: hydrate
 * replaces `byId` wholesale from Dexie, so seeding first would be discarded.
 */
import { DEFAULT_PARAMS } from '../types.ts';
import type { Conversation, Message } from '../types';
import { deleteConversation, saveMeta, saveMessages } from './db.ts';
import { getStreamingOwner, unmarkStreaming, useConversations } from './conversations.ts';

export interface SeededConversation {
  id: string;
  conversation: Conversation;
  messages: Message[];
}

export interface SeedConversationOptions {
  /** Stable prefix so a failing test names the conversation that broke. */
  label?: string;
  model?: string;
  serverId?: string;
  /** Messages to persist. Defaults to one user turn. */
  messages?: Message[];
  /**
   * Whether the seeded rows are also placed in memory. `false` leaves a
   * metadata-only conversation, which is what a nonresident conversation looks
   * like after eviction or before its first lazy load.
   */
  resident?: boolean;
}

function defaultMessages(conversationId: string): Message[] {
  return [{
    id: `${conversationId}-user`,
    role: 'user',
    content: 'seeded prompt',
    createdAt: 1,
    sortOrder: 1,
  }];
}

/**
 * Persist one conversation and mirror it into the store without selecting it.
 *
 * The in-memory copy is written through `setState` rather than through a store
 * action because the actions apply the very single-owner guards these fixtures
 * exist to test around: `setActive` refuses while any stream is live, and it
 * clears every non-selected conversation's messages.
 */
export async function seedConversation(
  options: SeedConversationOptions = {},
): Promise<SeededConversation> {
  const label = options.label ?? 'fixture';
  const id = `${label}-${crypto.randomUUID()}`;
  const messages = options.messages ?? defaultMessages(id);
  const conversation: Conversation = {
    id,
    title: label,
    model: options.model ?? 'test-model',
    serverId: options.serverId,
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: messages.length + 1,
    messageCount: messages.length,
    messages: [],
  };

  await saveMeta(conversation);
  if (messages.length > 0) await saveMessages(messages, id);

  const resident = options.resident ?? true;
  const inMemory: Conversation = resident
    ? { ...conversation, messages }
    : { ...conversation, messages: [] };

  useConversations.setState((state) => ({
    byId: { ...state.byId, [id]: inMemory },
    order: state.order.includes(id) ? state.order : [id, ...state.order],
  }));

  return { id, conversation: inMemory, messages };
}

/** Seed several independent conversations concurrently. */
export async function seedConversations(
  count: number,
  options: SeedConversationOptions = {},
): Promise<SeededConversation[]> {
  return Promise.all(
    Array.from({ length: count }, (_unused, index) => seedConversation({
      ...options,
      label: `${options.label ?? 'fixture'}-${index}`,
    })),
  );
}

/**
 * Drop every trace of the seeded conversations from Dexie and the store.
 *
 * Deliberately tolerant: a test that already deleted a conversation as part of
 * its assertions must still be able to call this in `finally` without turning a
 * real failure into a confusing teardown error.
 *
 * Releasing stream ownership first is not optional housekeeping. The checkpoint
 * interval starts with the first owner and is cleared only when the last one
 * goes away, so an owner left behind by a failed assertion keeps a timer — and
 * therefore the whole test process — alive until the runner's timeout fires.
 */
export async function releaseSeededConversations(
  seeded: readonly SeededConversation[],
): Promise<void> {
  const ids = new Set(seeded.map((entry) => entry.id));
  for (const id of ids) {
    const owner = getStreamingOwner(id);
    if (owner) unmarkStreaming(id, owner.generationId);
  }
  await Promise.all(
    Array.from(ids, (id) => deleteConversation(id).catch(() => undefined)),
  );
  useConversations.setState((state) => {
    const byId = { ...state.byId };
    for (const id of ids) delete byId[id];
    return {
      byId,
      order: state.order.filter((id) => !ids.has(id)),
      activeId: state.activeId && ids.has(state.activeId) ? null : state.activeId,
    };
  });
}

/** Read one seeded conversation's current in-memory messages by explicit ID. */
export function residentMessages(conversationId: string): Message[] | undefined {
  return useConversations.getState().byId[conversationId]?.messages;
}

/** Evict a conversation's in-memory messages the way `setActive` currently does. */
export function evictResidentMessages(conversationId: string): void {
  useConversations.setState((state) => {
    const conversation = state.byId[conversationId];
    if (!conversation) return state;
    return {
      byId: { ...state.byId, [conversationId]: { ...conversation, messages: [] } },
    };
  });
}
