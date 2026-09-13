/**
 * Conversation title rules — the single source of truth.
 *
 * `store/conversations.ts` applies these; `conversation-title.test.ts`
 * asserts them. This revives the old `scripts/title-test.mjs` quality sweep,
 * which embedded its own copy of the rules and drifted from production —
 * the rules now live in one module both the store and the test import.
 *
 * The rules:
 *   - A conversation starts as `New chat` (or a trimmed explicit title).
 *   - The first appended USER message renames it to the message's first
 *     line, trimmed, hard-cut at 60 characters, trimmed again so a cut
 *     landing after a word boundary never leaves trailing whitespace.
 *     Whitespace-only content keeps `New chat`.
 *   - Nothing else ever renames a conversation.
 */

export const DEFAULT_CONVERSATION_TITLE = 'New chat';

/** Title for a newly created conversation. */
export function initialConversationTitle(explicit?: string): string {
  return explicit?.trim() || DEFAULT_CONVERSATION_TITLE;
}

/** Title after appending one message to an existing conversation. */
export function conversationTitleAfterAppend(
  currentTitle: string,
  role: string,
  content: string,
): string {
  if (currentTitle !== DEFAULT_CONVERSATION_TITLE || role !== 'user') return currentTitle;
  return content.trim().split('\n')[0].slice(0, 60).trim() || DEFAULT_CONVERSATION_TITLE;
}
