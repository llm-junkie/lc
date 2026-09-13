/**
 * Conversations store — Zustand state + Dexie persistence.
 *
 * Two-tier lazy-load architecture:
 *   1. On app start, `hydrate()` loads ALL conversation metadata
 *      (title, model, timestamps) for instant sidebar render.
 *   2. When the user clicks a conversation, `loadConversationMessages(id)`
 *      fetches the full message history from Dexie on demand.
 *   3. During streaming, message deltas accumulate in-memory at
 *      render-frame rate; a 5 s checkpoint flushes to Dexie for
 *      crash safety; a full flush runs at stream end.
 *
 * Why NOT localStorage anymore:
 *   - 10 MB cap (QuotaExceededError = silent data loss)
 *   - Compression bugs (SENTINEL_GONE wipes all data on corruption)
 *   - Fragile hydration guards (queueMicrotask timing races)
 *   - No async support (Zustand persist is sync-only)
 *
 * Why Dexie / IndexedDB:
 *   - Effectively unlimited storage (browser-managed, ~50% disk)
 *   - Async transactions — no blocking the UI thread
 *   - Proper error handling — failures don't cascade
 *   - No native Rust deps needed (works in WebView2)
 */

import { create } from 'zustand';
import type { Conversation, GenerationParams, Message } from '../types';
import { DEFAULT_PARAMS } from '../types.ts';
import {
  clearAttachments,
  deleteAttachments,
  loadAttachment,
  putAttachments,
  type AttachmentWrite,
} from '../utils/idb.ts';
import { uid } from '../utils/uid.ts';
import { appendReasoningDelta } from '../utils/reasoning-content.ts';
import {
  loadAllMeta,
  saveMeta,
  deleteConversation,
  deleteAllConversations,
  loadMessages,
  saveMessage,
  saveMessages,
  replaceMessages,
  updateMessage,
  deleteLastMessage,
  countMessages,
  conversationMetaToStorageRow,
  messageToStorageRow,
  runConversationDataMutation,
  isCounterDomainSortOrder,
} from './db.ts';
import { normalizeGrantState } from '../modules/tool-engine/grant-state.ts';
import { recordDiagnosticEvent } from '../utils/diagnostic-events.ts';
import {
  createConversationPersistenceCoordinator,
  type PersistenceOutcome,
  type PersistenceTaskKind,
} from './conversation-persistence-coordinator.ts';
import {
  closeGenerationRun,
  settleGenerationRunAfterRepair,
} from './generation-journal.ts';
import { initialConversationTitle, conversationTitleAfterAppend } from '../utils/conversation-title.ts';
import {
  persistClonedConversationData,
  persistWhiteboardUserSend,
  recoverInterruptedWhiteboardState,
  replaceConversationBranch,
  type WhiteboardBranchBoundary,
} from './whiteboard-conversation.ts';
import {
  getModelWhiteboardWorking,
  importWhiteboardPackageIntoEmptyConversationStorage,
  readWhiteboardUiSnapshot,
  type WhiteboardMutationOptions,
  type WhiteboardPackageContents,
  type WhiteboardPackageImportResult,
  type WhiteboardUiSnapshot,
} from './whiteboard.ts';
import {
  generationCapacity,
  profileGenerationLimit,
} from '../modules/chat-pipeline/generation-session-manager.ts';
import { normalizeOpaqueReplayAccounting } from '../modules/llm-client/replay-accounting.ts';

/* ------------------------------------------------------------------ */
/*  Streaming throttle                                                 */
/* ------------------------------------------------------------------ */

export interface StreamOwner {
  conversationId: string;
  generationId: string;
  assistantMessageId: string;
  profileId?: string;
}

export const ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE =
  'Wait for the current response to finish before changing response configuration.';

export const ACTIVE_GENERATION_BLOCKING_OPERATION_MESSAGE =
  'Wait for the current model or conversation operation to finish before sending a message.';

export const ACTIVE_MODEL_OPERATION_GENERATION_LOCK_MESSAGE =
  ACTIVE_GENERATION_BLOCKING_OPERATION_MESSAGE;

export interface ModelOperationOwner {
  operationId: string;
  kind: 'load' | 'unload';
  modelId: string;
}

export interface GenerationBlockingOperationOwner {
  operationId: string;
  kind:
    | 'model_load'
    | 'model_unload'
    | 'conversation_clone'
    | 'profile_mutation'
    | 'chat_generation_admission'
    | 'whiteboard_initialization'
    | 'whiteboard_import';
  label: string;
  /**
   * The conversation this lease reserves, when it has one.
   *
   * Residency needs it: a chat admission holds a slot before any stream owner
   * exists, and evicting that conversation's messages in the gap would strand
   * the send it is about to commit. Application-exclusive kinds leave
   * it undefined.
   */
  conversationId?: string;
  /** Profile limiter identity for chat admissions. */
  profileId?: string;
  /** Chat admissions become irrevocable immediately before transcript mutation. */
  admissionState?: 'provisional' | 'committed';
}

export interface ConversationCorpusMutationOwner {
  operationId: string;
  label: string;
  /** Startup metadata hydration that was already admitted before this lease. */
  ready: Promise<void>;
}

export interface ConversationPersistenceFailure {
  severity: 'error' | 'warning';
  operation: string;
  conversationId?: string;
  message: string;
  at: number;
}

interface StreamOwnerState extends StreamOwner {
  terminal: boolean;
}

const streamingOwners = new Map<string, StreamOwnerState>();
const generationBlockingOperationOwners = new Map<string, GenerationBlockingOperationOwner>();
interface ConversationCorpusMutationOwnerState extends ConversationCorpusMutationOwner {
  released: Promise<void>;
  release: () => void;
}
let conversationCorpusMutationOwner: ConversationCorpusMutationOwnerState | null = null;
let hydrationInFlight: Promise<void> | null = null;
let checkpointTimer: ReturnType<typeof setInterval> | null = null;
interface GenerationTerminalPrerequisite {
  generationId: string;
  run: () => Promise<boolean>;
}
const generationTerminalPrerequisites = new Map<string, GenerationTerminalPrerequisite>();
type ConversationTurnBoundary = 'user send' | 'branch replacement';

/** Same-conversation Send/Retry/Edit durability boundaries may not overlap. */
const pendingConversationTurnBoundaries = new Map<string, ConversationTurnBoundary>();
/** Final delete barriers keyed by the conversation ID they tombstone. */
const pendingConversationDeletes = new Map<string, Promise<PersistenceOutcome>>();

function claimConversationTurnBoundary(
  conversationId: string,
  boundary: ConversationTurnBoundary,
): void {
  const pending = pendingConversationTurnBoundaries.get(conversationId);
  if (pending) {
    throw new Error(`A ${pending} is already being saved for this conversation.`);
  }
  pendingConversationTurnBoundaries.set(conversationId, boundary);
}

function releaseConversationTurnBoundary(
  conversationId: string,
  boundary: ConversationTurnBoundary,
): void {
  if (pendingConversationTurnBoundaries.get(conversationId) === boundary) {
    pendingConversationTurnBoundaries.delete(conversationId);
  }
}

/** Latest in-flight lazy-load token per conversation. */
const pendingMessageLoads = new Map<string, symbol>();

/**
 * Apply a lazy-loaded Dexie snapshot while the metadata-only conversation is
 * pristine. If a retry loads the exact rows already held in memory, preserve
 * their possibly-newer content but reconcile messageCount from Dexie. A
 * different non-empty array is a concurrent mutation, so the original
 * reference remains the stale-load signal.
 */
export function mergeLazyLoadedMessages(
  conversation: Conversation,
  messages: Message[],
): Conversation {
  if (conversation.messages.length > 0) {
    const sameRows = conversation.messages.length === messages.length
      && conversation.messages.every((message, index) => message.id === messages[index]?.id);
    if (!sameRows) return conversation;
    return { ...conversation, messageCount: messages.length };
  }
  return { ...conversation, messages, messageCount: messages.length };
}

export const INTERRUPTED_TOOL_RESULT_CODE = 'interrupted_completion_unknown';

export interface InterruptedToolRoundRecovery {
  messages: Message[];
  repairedCallIds: string[];
}

/**
 * Content of the terminal, non-replayed result LC persists for a call whose
 * execution stopped without a stored outcome. The shape matches the aborted
 * envelope the orchestrator writes for calls it stops itself, so the model
 * sees one consistent terminal vocabulary for every call that did not finish.
 * It deliberately does NOT say the side effect did not happen — the point is
 * that it is unknown and must be inspected, never replayed.
 */
export function interruptedToolResultContent(
  reason: 'aborted' | 'generation_ended' | 'timeout',
  toolName: string,
): string {
  return JSON.stringify({
    status: reason === 'timeout' ? 'timeout' : 'aborted',
    issues: [{
      code: reason,
      message: reason === 'aborted'
        ? `LC stopped before the result of ${toolName} was saved. Side effects may have happened. Inspect current state before retrying.`
        : reason === 'timeout'
          ? `The tool-round deadline expired before the result of ${toolName} was saved. Side effects may have happened. Inspect current state before retrying.`
        : `This generation ended before the result of ${toolName} was saved. Side effects may have happened. Inspect current state before retrying.`,
      retryable: false,
    }],
    warnings: [],
    metrics: { durationMs: 0 },
  });
}

export function restartedToolResultMessage(toolName: string): string {
  return `LC restarted before the result of ${toolName} was saved. Completion and side effects are unknown. Inspect current state before retrying.`;
}

/**
 * In-session repair for a round whose pool was interrupted by Stop or owner
 * replacement. Persists exactly one terminal result per accepted tool_call id
 * that has no stored result for the owning assistant round; ids that already
 * have a result are left untouched. Result ownership is round-scoped: a row
 * answered by an *earlier* assistant round does not answer the current round —
 * a provider that reuses an id across rounds still gets a current-round
 * terminal row. Runs synchronously against the store so the durable graph is
 * provider-valid before the loop abandons its (possibly never-settling)
 * workers.
 *
 * Unlike `recoverInterruptedToolRounds`, this is not a load-time graph sweep:
 * it knows the exact accepted ids and only patches the live store. The
 * persisted rows use the same content shape as the crash-recovery pass, so the
 * two paths cannot disagree about what an unanswered call means.
 */
export function repairUnansweredToolCalls(
  conversationId: string,
  acceptedCallIds: readonly string[],
  assistantMessageId: string,
  reason: 'aborted' | 'generation_ended' | 'timeout',
  options: { skipToolNames?: ReadonlySet<string> } = {},
): number {
  const state = useConversations.getState();
  const conversation = state.byId[conversationId];
  if (!conversation) return 0;

  const ownerIdx = conversation.messages.findIndex((m) => m.id === assistantMessageId && m.role === 'assistant');
  if (ownerIdx < 0) return 0;

  // Result rows that answer THIS round: tool messages sitting between the
  // owner and the next non-tool message whose id is one of the accepted
  // ids. A result for an id of an earlier round must not satisfy the
  // current round; an id persisted by this round already must not get a
  // second row even when the owning assistant's tool_calls have not been
  // written yet (the re-stream finalize writes them after the loop).
  const accepted = new Set(acceptedCallIds);
  const ownerCalls = new Map<string, string>();
  for (const call of conversation.messages[ownerIdx].tool_calls ?? []) {
    ownerCalls.set(call.id, call.name);
  }
  const resolvedIds = new Set<string>();
  for (let i = ownerIdx + 1; i < conversation.messages.length; i++) {
    const m = conversation.messages[i];
    if (m.role !== 'tool') break;
    if (m.tool_call_id && accepted.has(m.tool_call_id)) resolvedIds.add(m.tool_call_id);
  }

  const missing: { id: string; name: string }[] = [];
  for (const id of acceptedCallIds) {
    if (resolvedIds.has(id)) continue;
    if (missing.some((m) => m.id === id)) continue;
    // An accepted id absent from the owning assistant's tool_calls still
    // gets a repair row — the id itself must be answered. Names resolve
    // from the owning round when present.
    const name = ownerCalls.get(id) ?? 'tool';
    if (options.skipToolNames?.has(name)) continue;
    missing.push({ id, name });
  }
  if (missing.length === 0) return 0;

  // Insert the repair rows immediately after the owning assistant message so
  // the provider-facing sequence stays contiguous (assistant tool_calls are
  // answered before the next non-tool message). Row ids include the owning
  // assistant id — a provider call id is not a conversation-global identity,
  // and two rounds reusing one id must never produce two messages with the
  // same primary key. sortOrder is one-based and sequential: the owner keeps
  // its order, inserted rows take owner+1, owner+2, … and every following
  // message is renumbered after them so no two rows share an order.
  const messages = [...conversation.messages];
  const ownerSort = messages[ownerIdx].sortOrder ?? ownerIdx + 1;
  const repairRows: Message[] = missing.map((entry, offset) => {
    const message: Message = {
      id: `repair:${conversation.id}:${assistantMessageId}:${entry.id}`,
      role: 'tool',
      content: interruptedToolResultContent(reason, entry.name),
      createdAt: Date.now(),
      tool_call_id: entry.id,
      tool_is_error: true,
      tool_duration_ms: 0,
      sortOrder: ownerSort + 1 + offset,
    };
    return message;
  });
  let nextOrder = ownerSort + 1 + repairRows.length;
  const tail = messages.slice(ownerIdx + 1).map((m) => ({ ...m, sortOrder: nextOrder++ }));
  const repairedMessages = [
    ...messages.slice(0, ownerIdx + 1),
    ...repairRows,
    ...tail,
  ];
  useConversations.setState((s) => {
    const current = s.byId[conversationId];
    if (!current) return s;
    return {
      byId: {
        ...s.byId,
        [conversationId]: {
          ...current,
          messages: repairedMessages,
          messageCount: repairedMessages.length,
          updatedAt: Date.now(),
        },
      },
    };
  });
  void enqueueConversationWrite(
    conversationId,
    'repair unanswered tool calls',
    () => saveMessages(repairedMessages.slice(ownerIdx), conversationId),
  );
  return missing.length;
}

/**
 * Repair a durable message graph left behind by a hard shutdown during a tool
 * batch. An unresolved call is never replayed: native side effects may already
 * have happened even though its result row did not reach IndexedDB. Instead we
 * insert a provider-valid error result at the original turn boundary and tell
 * the next model turn to inspect state before retrying.
 */
export function recoverInterruptedToolRounds(messages: Message[]): InterruptedToolRoundRecovery {
  const recovered: Message[] = [];
  const repairedCallIds: string[] = [];

  for (let index = 0; index < messages.length;) {
    const message = messages[index];
    recovered.push(message);
    index++;
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;

    const resolved = new Set<string>();
    while (index < messages.length && messages[index].role === 'tool') {
      const toolMessage = messages[index];
      if (toolMessage.tool_call_id) resolved.add(toolMessage.tool_call_id);
      recovered.push(toolMessage);
      index++;
    }

    const seenCallIds = new Set<string>();
    for (const call of message.tool_calls) {
      if (seenCallIds.has(call.id)) continue;
      seenCallIds.add(call.id);
      if (resolved.has(call.id)) continue;
      repairedCallIds.push(call.id);
      recovered.push({
        id: `recovery:${message.id}:${call.id}`,
        role: 'tool',
        content: JSON.stringify({
          ok: false,
          error: {
            code: INTERRUPTED_TOOL_RESULT_CODE,
            message: restartedToolResultMessage(call.name),
            retryable: false,
          },
        }),
        createdAt: message.createdAt,
        tool_call_id: call.id,
        tool_is_error: true,
        tool_duration_ms: 0,
      });
    }
  }

  if (repairedCallIds.length === 0) return { messages, repairedCallIds };
  return {
    messages: recovered.map((message, index) => ({ ...message, sortOrder: index + 1 })),
    repairedCallIds,
  };
}

/* ------------------------------------------------------------------ */
/*  Hydration guard                                                    */
/* ------------------------------------------------------------------ */

let hydrated = false;

interface ConversationHydrationPersistence {
  loadMetadata: typeof loadAllMeta;
  countMessages: typeof countMessages;
}

const DEFAULT_CONVERSATION_HYDRATION_PERSISTENCE: ConversationHydrationPersistence = {
  loadMetadata: loadAllMeta,
  countMessages,
};

let conversationHydrationPersistence = DEFAULT_CONVERSATION_HYDRATION_PERSISTENCE;

/** Install a deterministic startup-hydration seam. Must run before hydration starts. */
export function setConversationHydrationPersistenceForTests(
  overrides?: Partial<ConversationHydrationPersistence>,
): void {
  if (hydrationInFlight) throw new Error('Conversation hydration is already running.');
  conversationHydrationPersistence = overrides
    ? { ...DEFAULT_CONVERSATION_HYDRATION_PERSISTENCE, ...overrides }
    : DEFAULT_CONVERSATION_HYDRATION_PERSISTENCE;
}

export function isHydrated(): boolean {
  return hydrated;
}

/* ------------------------------------------------------------------ */
/*  Message memory management                                         */
/*                                                                     */
/*  Messages are only kept in Zustand for the CURRENTLY ACTIVE         */
/*  conversation. When switching away, they're cleared from memory     */
/*  immediately — the canonical copy is in IndexedDB (Dexie).          */
/*  Switching back reloads from IndexedDB, exactly like after an       */
/*  app restart.  This keeps the JS heap small regardless of how       */
/*  many tool-heavy conversations have been opened.                    */
/* ------------------------------------------------------------------ */

export function isMessagesLoaded(id: string): boolean {
  const conv = useConversations.getState().byId[id];
  return conv ? isConversationMessageHistoryComplete(conv) : false;
}

/* ------------------------------------------------------------------ */
/*  Import highlight — accent titles of freshly imported chats         */
/* ------------------------------------------------------------------ */

const highlightedIds = new Set<string>();

/** Mark conversation IDs as freshly imported (accent title highlight). */
export function addHighlights(ids: string[]): void {
  for (const id of ids) highlightedIds.add(id);
}

/** Check if a conversation title should be accented. */
export function isHighlighted(id: string): boolean {
  return highlightedIds.has(id);
}

/** Clear the highlight for a conversation (called on click / interaction). */
export function clearHighlight(id: string): void {
  highlightedIds.delete(id);
}

const PERSISTENCE_FAILURE_NOTICE_WINDOW_MS = 5_000;

/** Retention key for failures that belong to no single conversation. */
const APPLICATION_PERSISTENCE_SCOPE = '__application__';

function reportConversationPersistenceIssue(
  severity: ConversationPersistenceFailure['severity'],
  operation: string,
  error: unknown,
  conversationId?: string,
): void {
  const now = Date.now();
  const scope = conversationId ?? APPLICATION_PERSISTENCE_SCOPE;
  const failure: ConversationPersistenceFailure = {
    severity,
    operation,
    conversationId,
    message: error instanceof Error ? error.message : String(error),
    at: now,
  };

  // Two separate concerns. `persistenceFailures` retains one unresolved
  // failure per conversation so a second conversation's error can never erase
  // the first — with three lanes writing at once, a single latest-value slot
  // silently drops errors. `persistenceFailure` remains the foreground toast
  // slot, and its rate limit is now scoped to the conversation as well, so an
  // unrelated chat's failure no longer swallows the selected chat's notice.
  const state = useConversations.getState();
  const retained = { ...state.persistenceFailures, [scope]: failure };
  const current = state.persistenceFailure;
  const rateLimited = current
    && (current.conversationId ?? APPLICATION_PERSISTENCE_SCOPE) === scope
    && now - current.at < PERSISTENCE_FAILURE_NOTICE_WINDOW_MS;

  useConversations.setState(rateLimited
    ? { persistenceFailures: retained }
    : { persistenceFailures: retained, persistenceFailure: failure });

  if (rateLimited) return;
  recordDiagnosticEvent({
    subsystem: 'storage',
    operation: 'persistence',
    outcome: severity === 'error' ? 'error' : 'rejected',
    code: severity === 'error' ? 'persistence-error' : 'persistence-warning',
    description: error,
  });
}

export function reportConversationPersistenceFailure(
  operation: string,
  error: unknown,
  conversationId?: string,
): void {
  reportConversationPersistenceIssue('error', operation, error, conversationId);
}

export function reportConversationPersistenceWarning(
  operation: string,
  warning: unknown,
  conversationId?: string,
): void {
  reportConversationPersistenceIssue('warning', operation, warning, conversationId);
}

/** Track a best-effort persistence task while making rejection user-visible. */
export function trackConversationPersistence(
  task: Promise<unknown>,
  operation: string,
  conversationId?: string,
): Promise<void> {
  return task.then(
    () => undefined,
    (error) => reportConversationPersistenceFailure(operation, error, conversationId),
  );
}

/* ------------------------------------------------------------------ */
/*  Per-conversation persistence lanes                                 */
/* ------------------------------------------------------------------ */

const persistenceLanes = createConversationPersistenceCoordinator(
  reportConversationPersistenceFailure,
);

/**
 * Transcript revision per conversation.
 *
 * A checkpoint records the revision it snapshotted so the lane can drop it if
 * a newer write has already committed by the time it reaches the head. The
 * counter is process-local and monotonic; it is never persisted, because its
 * only job is to order writes within one run of the app.
 */
const transcriptRevisions = new Map<string, number>();

function nextTranscriptRevision(conversationId: string): number {
  const next = (transcriptRevisions.get(conversationId) ?? 0) + 1;
  transcriptRevisions.set(conversationId, next);
  return next;
}

function currentTranscriptRevision(conversationId: string): number {
  return transcriptRevisions.get(conversationId) ?? 0;
}

/**
 * Classify a durable write against the conversation's live generation.
 *
 * Only the generation's *claimed* terminal transition counts. `owner.terminal`
 * is set by `finalizeStreamingOwner`, which is the single place a generation
 * ends; the orchestrator also calls `finalizeMessage` on the same assistant row
 * at the end of every intermediate tool round, writing
 * `finish_reason: 'tool_calls'` before it re-streams.
 *
 * Treating those intermediate rounds as terminal would retire the generation's
 * checkpoints while it is still producing output, so a crash during any later
 * round would lose everything written after the first tool call. Requiring the
 * claimed transition keeps checkpointing alive for the whole turn and still
 * discards superseded snapshots the moment the answer really does finish.
 */
function terminalWriteOptionsFor(
  conversationId: string,
  messageId: string | undefined,
): ConversationWriteOptions {
  const owner = streamingOwners.get(conversationId);
  if (!owner || !owner.terminal) return {};
  if (!messageId || owner.assistantMessageId !== messageId) return {};
  return { kind: 'terminal', generationId: owner.generationId };
}

function terminalPersistenceIsDeferred(
  conversationId: string,
  messageId: string | undefined,
): boolean {
  const owner = streamingOwners.get(conversationId);
  if (!owner || !owner.terminal || owner.assistantMessageId !== messageId) return false;
  return generationTerminalPrerequisites.get(conversationId)?.generationId === owner.generationId;
}

interface ConversationWriteOptions {
  kind?: PersistenceTaskKind;
  generationId?: string;
  /**
   * Revision this write represents. Ordinary writes take a fresh revision;
   * checkpoints reuse the current one so a later ordinary write supersedes
   * them rather than the other way round.
   */
  revision?: number;
}

/**
 * Queue one logical durable mutation on a conversation's lane.
 *
 * `run` must contain every write belonging to the mutation — typically the
 * message row *and* the conversation metadata. Splitting them into two calls
 * reintroduces the interleaving this coordinator exists to prevent.
 */
export function enqueueConversationWrite(
  conversationId: string,
  operation: string,
  run: () => Promise<unknown>,
  options: ConversationWriteOptions = {},
): Promise<PersistenceOutcome> {
  const kind = options.kind ?? 'ordinary';
  const revision = options.revision
    ?? (kind === 'checkpoint'
      ? currentTranscriptRevision(conversationId)
      : nextTranscriptRevision(conversationId));
  return persistenceLanes.enqueue(conversationId, {
    operation,
    kind,
    generationId: options.generationId,
    revision,
    run,
  });
}

/**
 * Run one durable lifecycle mutation on the conversation's lane and return its
 * value.
 *
 * Send admission, branch replacement, and assistant/journal admission used to
 * write straight to Dexie while ordinary writes queued in the lane. That left
 * two ordering domains for one conversation: a terminal flush queued when a
 * stream ended could still be waiting when the user hit Retry, and would then
 * rewrite the transcript the branch replacement had just discarded.
 *
 * Unlike `enqueueConversationWrite`, this rejects rather than reporting, because
 * these callers already have their own failure handling and their result
 * decides whether a user action is accepted.
 */
export async function runConversationWrite<T>(
  conversationId: string,
  operation: string,
  run: () => Promise<T>,
  options: ConversationWriteOptions = {},
): Promise<T> {
  let value: T;
  let captured: unknown;
  let threw = false;
  const outcome = await persistenceLanes.enqueue(conversationId, {
    operation,
    kind: options.kind ?? 'ordinary',
    generationId: options.generationId,
    revision: options.revision ?? nextTranscriptRevision(conversationId),
    reportFailures: false,
    run: async () => {
      try {
        value = await run();
      } catch (error) {
        threw = true;
        captured = error;
        throw error;
      }
    },
  });
  if (threw) throw captured;
  if (outcome !== 'committed') {
    throw new Error(`This conversation was deleted before "${operation}" could be saved.`);
  }
  return value!;
}

/** Run one value-returning task as the lane's synchronously sealed final unit. */
async function runFinalConversationWrite<T>(
  conversationId: string,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  let value: T;
  let captured: unknown;
  let threw = false;
  const outcome = await persistenceLanes.enqueueFinal(conversationId, {
    operation,
    kind: 'ordinary',
    revision: nextTranscriptRevision(conversationId),
    reportFailures: false,
    run: async () => {
      try {
        value = await run();
      } catch (error) {
        threw = true;
        captured = error;
        throw error;
      }
    },
  });
  if (threw) throw captured;
  if (outcome !== 'committed') {
    throw new Error(`This conversation could not be restored during "${operation}".`);
  }
  return value!;
}

/** Wait for a conversation's queued durable work to settle. */
export function drainConversationPersistence(conversationId: string): Promise<void> {
  return persistenceLanes.drain(conversationId);
}

/** Wait for every conversation's queued durable work to settle. */
export function drainAllConversationPersistence(): Promise<void> {
  return persistenceLanes.drainAll();
}

/** Whether a conversation still has durable work running or queued. */
export function hasPendingConversationPersistence(conversationId: string): boolean {
  return persistenceLanes.isBusy(conversationId);
}

/**
 * Conversations whose complete in-memory transcript must not be evicted.
 *
 * Before navigation was allowed during a run, only the selected conversation
 * could hold messages and `setActive` cleared every other one. That is no
 * longer safe: a generation reads and mutates its transcript through the store
 * by conversation ID, so evicting a background run's messages would strand its
 * tool loop mid-turn.
 *
 * The set is the union of everything with transcript work in flight — a
 * running or stopping generation, a chat admission that has not yet produced
 * one, a send or branch durability boundary, a pending load, a
 * deferred terminal prerequisite, and a queued delete — plus the conversation
 * the user is currently looking at.
 */
export function residentConversationIds(selectedId?: string | null): Set<string> {
  const resident = new Set<string>();
  if (selectedId) resident.add(selectedId);
  for (const id of streamingOwners.keys()) resident.add(id);
  for (const id of pendingConversationTurnBoundaries.keys()) resident.add(id);
  for (const id of pendingMessageLoads.keys()) resident.add(id);
  for (const id of generationTerminalPrerequisites.keys()) resident.add(id);
  for (const id of pendingConversationDeletes.keys()) resident.add(id);
  for (const operation of generationBlockingOperationOwners.values()) {
    if (operation.conversationId) resident.add(operation.conversationId);
  }
  return resident;
}

/**
 * Whether this conversation's messages may be dropped from memory.
 *
 * Residency is necessary but not sufficient. An incomplete transcript — the
 * result of a failed or partial lazy load — must also stay put: evicting it
 * would leave `messageCount` describing rows that memory no longer has, and a
 * later replacement write would treat the fragment as authoritative.
 */
export function canEvictConversationMessages(
  conversation: Conversation,
  resident: ReadonlySet<string>,
): boolean {
  if (resident.has(conversation.id)) return false;
  if (conversation.messages.length === 0) return false;
  return isConversationMessageHistoryComplete(conversation);
}

/**
 * Whether a structural action on this conversation must be refused.
 *
 * Structural actions used to be blocked whenever *any* conversation was
 * generating, which was indistinguishable from correct while only one
 * conversation was reachable. Now that the user can work in a second chat
 * during a run, the question is about the target: renaming, archiving,
 * deleting, or cloning a conversation that owns a live generation would
 * mutate or read a transcript that generation is still writing.
 *
 * A corpus mutation still blocks everything — it is about to invalidate every
 * row — and so does a chat admission for this same conversation, which holds a
 * slot before any stream owner exists.
 */
export function isConversationStructurallyLocked(conversationId: string): boolean {
  if (conversationCorpusMutationOwner) return true;
  if (streamingOwners.has(conversationId)) return true;
  if (pendingConversationDeletes.has(conversationId)) return true;
  for (const operation of generationBlockingOperationOwners.values()) {
    // Application-exclusive leases (model load/unload) name no conversation
    // and block everything; scoped leases block only their own target.
    if (
      operation.conversationId === undefined
      || operation.conversationId === conversationId
    ) return true;
  }
  return false;
}

/**
 * Release the transcripts nothing is using, given the conversation that is
 * about to become selected.
 *
 * Every path that publishes a new selection needs this, not just `setActive`.
 * `create` and `clone` used to run their own blanket "clear every other
 * conversation" loop, which was correct only while those actions were refused
 * during a generation. Once they are allowed to run alongside one, that loop
 * silently erases the transcript a background generation is still writing to,
 * leaving a registered session whose assistant message no longer exists.
 */
function evictNonResidentMessages(
  byId: Record<string, Conversation>,
  selectedId: string,
): { byId: Record<string, Conversation>; evicted: boolean } {
  const resident = residentConversationIds(selectedId);
  const nextById = { ...byId };
  let evicted = false;
  for (const cid of Object.keys(nextById)) {
    const other = nextById[cid];
    if (!other || !canEvictConversationMessages(other, resident)) continue;
    nextById[cid] = { ...other, messages: [] };
    evicted = true;
  }
  return { byId: nextById, evicted };
}

/** Checkpoint snapshots are safe only outside another lifecycle write. */
export function canEnqueueConversationCheckpoint(conversationId: string): boolean {
  return !hasPendingConversationPersistence(conversationId);
}

/**
 * Permanently refuse further writes for a deleted conversation, so a write
 * still queued behind the delete cannot recreate its rows.
 */
export function closeConversationPersistence(conversationId: string): void {
  persistenceLanes.close(conversationId);
  transcriptRevisions.delete(conversationId);
}

/**
 * Run a conversation's last durable write and refuse everything after it.
 *
 * The seal is applied synchronously at enqueue, not when the delete completes.
 * Closing only afterwards leaves a window in which a checkpoint or flush can be
 * accepted behind the delete and recreate the rows it just removed.
 */
export function enqueueFinalConversationWrite(
  conversationId: string,
  operation: string,
  run: () => Promise<unknown>,
): Promise<PersistenceOutcome> {
  return persistenceLanes.enqueueFinal(conversationId, {
    operation,
    kind: 'terminal',
    revision: nextTranscriptRevision(conversationId),
    run,
  });
}

/**
 * Allow writes again for a conversation ID that an import or restore recreated.
 *
 * Without this, importing an archive of a conversation that was previously
 * deleted or cleared produces a chat that works in memory while every durable
 * write is silently refused — the lane is still sealed against the old ID.
 */
export function reopenConversationPersistence(conversationId: string): void {
  persistenceLanes.reopen(conversationId);
  transcriptRevisions.delete(conversationId);
}

/**
 * Restore one conversation only after any older sealed delete has finished.
 *
 * Imports preserve conversation IDs. If an ID is restored while its previous
 * final delete is still queued, that delete can otherwise land after the
 * import and erase the newly restored rows. Waiting for idle first establishes
 * the delete-before-restore order; a previously closed lane is reopened only
 * for this attempt and is closed again if the restore fails.
 */
export async function runConversationRestoreWrite<T>(
  conversationId: string,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  await pendingConversationDeletes.get(conversationId);
  await persistenceLanes.drain(conversationId);
  const wasClosed = persistenceLanes.isClosed(conversationId);
  if (wasClosed) reopenConversationPersistence(conversationId);
  try {
    const value = await runFinalConversationWrite(conversationId, operation, run);
    // The final restore task seals against anything that could slip behind it.
    // Successful recreation becomes the new open lifetime for this ID.
    pendingMessageLoads.delete(conversationId);
    reopenConversationPersistence(conversationId);
    return value;
  } catch (error) {
    if (wasClosed) closeConversationPersistence(conversationId);
    else reopenConversationPersistence(conversationId);
    throw error;
  }
}

export interface ConversationMessagePersistence {
  saveMessages: typeof saveMessages;
  replaceMessages: typeof replaceMessages;
}

export type ConversationMessageFlushMode = 'replace' | 'upsert' | 'skip';

/**
 * A replacement write is safe only when the in-memory array is known to contain
 * the complete history. After a failed lazy load, messageCount still describes
 * the durable history while messages contains only subsequently appended rows.
 */
export function isConversationMessageHistoryComplete(
  conversation: Pick<Conversation, 'messages' | 'messageCount'>,
): boolean {
  return conversation.messageCount !== undefined
    && conversation.messages.length === conversation.messageCount;
}

/**
 * Persist a live conversation snapshot without allowing an incomplete lazy-load
 * result to turn a transient read failure into deletion of older durable rows.
 * The injectable boundary keeps both the replace and safe-upsert branches
 * deterministic in regression tests.
 */
export async function persistConversationMessageSnapshot(
  conversation: Pick<Conversation, 'id' | 'messages' | 'messageCount'>,
  persistence: ConversationMessagePersistence = { saveMessages, replaceMessages },
  onIncomplete: (conversation: Pick<Conversation, 'id' | 'messages' | 'messageCount'>) => void = (incomplete) => {
    reportConversationPersistenceWarning(
      'preserve incomplete conversation history',
      new Error(
        `Only ${incomplete.messages.length} of ${incomplete.messageCount ?? 'an unknown number of'} messages were loaded. `
        + 'Existing stored rows were preserved with a non-deleting flush; reselect the conversation to retry the full load.',
      ),
      incomplete.id,
    );
  },
): Promise<ConversationMessageFlushMode> {
  if (conversation.messages.length === 0) return 'skip';
  if (!isConversationMessageHistoryComplete(conversation)) {
    await persistence.saveMessages(conversation.messages, conversation.id);
    onIncomplete(conversation);
    return 'upsert';
  }
  await persistence.replaceMessages(conversation.id, conversation.messages);
  return 'replace';
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

interface ConversationsState {
  /** True until hydrate() has loaded metadata from Dexie. */
  loading: boolean;
  /** True while loadConversationMessages() is fetching messages. */
  /**
   * Conversations whose message load is in flight.
   *
   * A single boolean could only ever describe the selected conversation, so a
   * background load was invisible and a load that finished after the user
   * navigated away cleared the flag for whichever chat was on screen. The set
   * mirrors the tokenized `pendingMessageLoads` map that already existed.
   */
  loadingMessageIds: ReadonlySet<string>;
  /** Latest surfaced IndexedDB failure or safe-fallback warning. */
  persistenceFailure: ConversationPersistenceFailure | null;
  /** Clear a notice only if the UI is acknowledging the same occurrence. */
  clearPersistenceFailure: (at: number) => void;
  /**
   * One retained unresolved failure per conversation, plus an
   * `__application__` entry for failures that belong to no single
   * conversation. `persistenceFailure` is only the foreground notice; with
   * several conversations writing at once it cannot be the record of what
   * failed, because each new failure would erase the last.
   */
  persistenceFailures: Record<string, ConversationPersistenceFailure>;
  /** Acknowledge and drop one conversation's retained failure. */
  clearConversationPersistenceFailure: (conversationId: string) => void;
  /** Incremented every time a conversation's messages are fully loaded.
   *  Sidebar subscribes to this to re-render when messageCount updates. */
  loadedVersion: number;
  /**
   * Incremented only when the shape of the conversation list changes —
   * creation, deletion, rename, archive state, ordering, import, wipe.
   *
   * The Sidebar needs to know about those while a generation runs, but must
   * not re-render on streamed tokens. `byId` changes on every delta, so
   * subscribing to it directly would re-render the whole list at token rate;
   * deriving a structural key from it would run an O(n) comparison just as
   * often. An explicit counter is the cheap signal: bumped a handful of times
   * per session, never during streaming.
   */
  structuralVersion: number;
  byId: Record<string, Conversation>;
  order: string[];
  activeId: string | null;
  filterTab: 'active' | 'archive';
  setFilterTab: (tab: 'active' | 'archive') => void;

  list: () => Conversation[];
  get: (id: string) => Conversation | undefined;

  hydrate: () => Promise<void>;
  loadConversationMessages: (id: string) => Promise<Message[]>;

  create: (input?: { title?: string; serverId?: string; model?: string; params?: GenerationParams }) => Conversation;
  clone: (id: string) => Promise<Conversation | undefined>;
  setActive: (id: string | null) => void;
  rename: (id: string, title: string) => void;
  remove: (id: string) => Promise<boolean>;
  archive: (id: string) => void;
  unarchive: (id: string) => void;
  /** `corpusOperationId` is reserved for an already-owned full-app reset. */
  clearAll: (corpusOperationId?: string) => Promise<boolean>;

  appendMessage: (id: string, msg: Omit<Message, 'id' | 'createdAt'>) => Message | undefined;
  appendUserMessage: (
    id: string,
    msg: Omit<Message, 'id' | 'createdAt'> & { role: 'user' },
  ) => Promise<Message | undefined>;
  patchMessage: (id: string, messageId: string, patch: Partial<Message>) => void;
  appendToMessage: (id: string, messageId: string, delta: string) => void;
  appendReasoningToMessage: (id: string, messageId: string, delta: string) => void;
  appendRefusalToMessage: (id: string, messageId: string, delta: string) => void;
  finalizeMessage: (id: string, messageId: string, patch?: Partial<Message>) => void;
  appendToLast: (id: string, delta: string) => void;
  appendReasoning: (id: string, delta: string) => void;
  appendRefusal: (id: string, delta: string) => void;
  finalizeLast: (id: string, patch?: Partial<Message>) => void;
  popLast: (id: string) => void;
  patchConversation: (id: string, patch: Partial<Conversation>) => void;
  replaceFromMessage: (
    id: string,
    messageId: string,
    next: { content: string; attachments?: Message['attachments'] },
    boundary?: WhiteboardBranchBoundary,
  ) => Promise<boolean>;
  setModel: (id: string, model: string) => void;
  setParams: (id: string, params: GenerationParams) => void;
}

export const useConversations = create<ConversationsState>()(
  (set, get) => ({
    loading: true,
    loadingMessageIds: new Set<string>(),
    persistenceFailure: null,
    clearPersistenceFailure: (at) => set((s) => (
      s.persistenceFailure?.at === at ? { persistenceFailure: null } : s
    )),
    persistenceFailures: {},
    clearConversationPersistenceFailure: (conversationId) => set((s) => {
      if (!(conversationId in s.persistenceFailures)) return s;
      const { [conversationId]: _acknowledged, ...rest } = s.persistenceFailures;
      return { persistenceFailures: rest };
    }),
    loadedVersion: 0,
    structuralVersion: 0,
    byId: {},
    order: [],
    activeId: null,
    filterTab: 'active',
    setFilterTab: (filterTab) => set({ filterTab }),

    list: () => get().order.map((id) => get().byId[id]).filter(Boolean),
    get: (id) => get().byId[id],

    /* ---------------------------------------------------------- */
    /*  Async lifecycle                                            */
    /* ---------------------------------------------------------- */

    hydrate: () => {
      if (hydrated) return Promise.resolve();
      if (hydrationInFlight) return hydrationInFlight;

      const hydrateOnce = async () => {
        // A corpus lease acquired before this call owns the earlier lifetime.
        // Wait for it to publish first. Conversely, a lease acquired after
        // this point captures `hydrationInFlight` as its `ready` barrier, so
        // the two directions cannot deadlock or publish out of order.
        while (conversationCorpusMutationOwner) {
          await conversationCorpusMutationOwner.released;
        }
        if (hydrated) return;

        const persistence = conversationHydrationPersistence;
        const metas = await persistence.loadMetadata();
        const byId: Record<string, Conversation> = {};
        const order: string[] = [];
        for (const meta of metas) {
          byId[meta.id] = meta;
          order.push(meta.id);
        }

        // Populate messageCount for rows that do not have the cached count.
        // Uses Dexie's index-based count() — fast, no data loaded.
        for (const meta of metas) {
          if (!meta.messageCount) {
            meta.messageCount = await persistence.countMessages(meta.id);
            if (meta.messageCount > 0) {
              // Persist the computed count so we don't re-count next time.
              void enqueueConversationWrite(meta.id, 'save hydrated message count', () => saveMeta(meta));
            }
          }
        }

        hydrated = true;
        set({
          byId,
          order,
          loading: false,
          loadedVersion: (get().loadedVersion || 0) + 1,
          structuralVersion: get().structuralVersion + 1,
        });
      };

      const tracked = hydrateOnce().finally(() => {
        if (hydrationInFlight === tracked) hydrationInFlight = null;
      });
      hydrationInFlight = tracked;
      return tracked;
    },

    loadConversationMessages: async (id: string) => {
      // Already loaded? Skip the DB round-trip.
      if (isMessagesLoaded(id)) {
        set((s) => ({ loadedVersion: s.loadedVersion + 1 }));
        return get().byId[id]!.messages;
      }

      const loadToken = Symbol(id);
      pendingMessageLoads.set(id, loadToken);
      set((s) => ({ loadingMessageIds: new Set(s.loadingMessageIds).add(id) }));
      try {
        // Whiteboard owns durable mutation receipts, so settle its orphaned
        // working row and repair the assistant reference before generic tool
        // recovery classifies any unanswered call as side-effect-unknown. The
        // lane is reserved before the IndexedDB read starts so a corpus wipe
        // or same-ID restore cannot finish and then be overwritten by this
        // stale load's recovery transaction.
        const whiteboardRecovery = await runConversationWrite(
          id,
          'load and recover conversation messages',
          async () => {
            const loadedMessages = await loadMessages(id);
            const needsSortOrderRepair = loadedMessages.some(
              (message) => !isCounterDomainSortOrder(message.sortOrder),
            );
            const orderedMessages = needsSortOrderRepair
              ? loadedMessages.map((message, index) => ({ ...message, sortOrder: index + 1 }))
              : loadedMessages;
            const recovered = await recoverInterruptedWhiteboardState(id, orderedMessages);
            return { ...recovered, needsSortOrderRepair };
          },
        );
        const recovery = recoverInterruptedToolRounds(whiteboardRecovery.messages);
        const msgs = recovery.messages;

        // Whether the transcript is durably repaired. When repair is needed,
        // only the load token that actually commits it may retire the journal.
        // An older overlapping load whose token lost ownership must leave the
        // row in place for the newer load rather than treating its skipped
        // replacement as vacuous success.
        const needsTranscriptRepair = whiteboardRecovery.needsSortOrderRepair
          || recovery.repairedCallIds.length > 0;
        let repaired = !needsTranscriptRepair;
        if (needsTranscriptRepair) {
          // This is a one-time durable repair. The deterministic recovery row
          // IDs also make a repeated load idempotent if persistence is
          // interrupted again while this replacement is in flight.
          const current = get().byId[id];
          if (pendingMessageLoads.get(id) === loadToken && current?.messages.length === 0) {
            // Keep this conversation marked loading until the repaired graph is
            // durable, so
            // normal Send/Retry/Edit admission cannot race the replacement.
            const outcome = await enqueueConversationWrite(
              id,
              'repair interrupted tool round',
              () => replaceMessages(id, msgs),
            );
            repaired = outcome === 'committed';
          }
        }

        // The transcript-level repairs above are what the journal row was
        // waiting for. Retire it only if they committed; otherwise the row
        // stays so the next open retries, which is safe because both repairs
        // are idempotent.
        if (pendingMessageLoads.get(id) === loadToken) {
          await settleGenerationRunAfterRepair(id, repaired);
        }

        set((s) => {
          if (pendingMessageLoads.get(id) !== loadToken) return s;
          const conv = s.byId[id];
          if (!conv) {
            return {
              loadingMessageIds: new Set(pendingMessageLoads.keys()),
            };
          }

          // A load starts only for an empty in-memory history. If anything was
          // appended while Dexie was pending, that newer state owns the array;
          // never replace it with the stale snapshot that just resolved.
          const updated = mergeLazyLoadedMessages(conv, msgs);
          if (updated === conv) {
            return {
              loadingMessageIds: new Set(pendingMessageLoads.keys()),
            };
          }
          // Rows successfully read from Dexie are authoritative for the durable
          // count. Persist reconciliation so the next restart does not recreate
          // an incomplete-history/read-only state after a split write failure.
          if (conv.messageCount !== updated.messageCount) {
            if (hydrated) void enqueueConversationWrite(id, 'save lazy-loaded message count', () => saveMeta(updated));
          }
          return {
            byId: { ...s.byId, [id]: updated },
            loadingMessageIds: new Set(pendingMessageLoads.keys()),
            loadedVersion: s.loadedVersion + 1,
          };
        });

        return get().byId[id]?.messages ?? [];
      } catch (error) {
        reportConversationPersistenceFailure('load conversation messages', error, id);
        return [];
      } finally {
        if (pendingMessageLoads.get(id) === loadToken) pendingMessageLoads.delete(id);
        set(() => ({
          loadingMessageIds: new Set(pendingMessageLoads.keys()),
        }));
      }
    },

    /* ---------------------------------------------------------- */
    /*  Mutations                                                  */
    /* ---------------------------------------------------------- */

    create: (input) => {
      // Deliberately not blocked by a running generation. Target behavior
      // requires that a further conversation can be opened and drafted even
      // when every generation slot is occupied; only a corpus mutation, which
      // is about to erase or replace the whole store, refuses.
      if (conversationCorpusMutationOwner) {
        throw new Error(ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE);
      }
      const now = Date.now();
      const id = uid();
      const conv: Conversation = {
        id,
        title: initialConversationTitle(input?.title),
        serverId: input?.serverId,
        model: input?.model,
        params: input?.params ?? { ...DEFAULT_PARAMS },
        messages: [],
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      if (hydrated) void enqueueConversationWrite(id, 'create conversation', () => saveMeta(conv));
      set((s) => {
        // Resident-aware, exactly like `setActive`. Starting a new chat while
        // another conversation generates must not erase the transcript that
        // generation is writing.
        const { byId } = evictNonResidentMessages({ ...s.byId, [id]: conv }, id);
        return {
          byId,
          order: [id, ...s.order],
          structuralVersion: s.structuralVersion + 1,
          activeId: id,
        };
      });
      return conv;
    },

    clone: async (id) => {
      // Cloning reads the source transcript, so a generating source is refused
      // while an idle one may be copied during another conversation's run.
      if (isConversationStructurallyLocked(id)) return undefined;
      const operation = markGenerationBlockingOperation(
        'conversation_clone',
        `Clone conversation ${id}`,
        undefined,
        // Names its source, so cloning an idle conversation is not refused
        // because some unrelated chat is streaming.
        id,
      );
      try {
        const source = get().byId[id];
        if (!source) return undefined;

      // 1. Flush the original to Dexie so we clone from the canonical
      //    on-disk copy — no state/cache consistency guesswork.
      if (hydrated && source.messages.length > 0) {
        await runConversationWrite(id, 'flush clone source', async () => {
          // Persist rows before the count that advertises them.
          await persistConversationMessageSnapshot(source);
          await saveMeta(source);
        });
      }

      // 2. Load from Dexie (the single source of truth).
      const msgs = hydrated
        ? await loadMessages(id)
        : source.messages;

      // 3. Build the clone with fresh ids — every message gets a new
      //    unique id so bulkPut won't overwrite the originals (Dexie's
      //    messages table uses message `id` as its primary key, not a
      //    composite of (conversationId, id)).
      const now = Date.now();
      const newId = uid();
      const messageIdMap = new Map(msgs.map((message) => [message.id, uid()]));
      const attachmentIdMap = new Map<string, Promise<string>>();
      const attachmentWrites: AttachmentWrite[] = [];
      const cloneAttachment = (attachment: NonNullable<Message['attachments']>[number]): Promise<NonNullable<Message['attachments']>[number]> => {
        let clonedId = attachmentIdMap.get(attachment.id);
        if (!clonedId) {
          const newAttachmentId = uid();
          clonedId = (async () => {
            // IDB-backed blobs need their own key. Inline attachments have
            // no external bytes to copy, but still get a fresh identity so
            // deleting one conversation cannot affect the other.
            if (attachment.stored === 'idb') {
              const blob = await loadAttachment(attachment.id);
              if (blob) {
                attachmentWrites.push({
                  id: newAttachmentId,
                  blob,
                  mime: attachment.mime,
                  name: attachment.name,
                  size: attachment.size,
                });
              }
            }
            return newAttachmentId;
          })();
          attachmentIdMap.set(attachment.id, clonedId);
        }
        return clonedId.then((id) => ({ ...attachment, id }));
      };
      const clonedMessages = await Promise.all(msgs.map(async (m, i) => {
        const newMsgId = messageIdMap.get(m.id);
        if (!newMsgId) throw new Error(`Could not allocate a clone ID for message ${m.id}.`);
        // Explicit sequential sortOrder so the clone sorts correctly
        // even when the source messages were loaded from Dexie (where
        // rowToMessage may not have restored the original sortOrder).
        const cloned = { ...m, id: newMsgId, sortOrder: i + 1 };
        if (cloned.attachments) {
          cloned.attachments = await Promise.all(cloned.attachments.map(cloneAttachment));
        }
        // Copy the array and records so later patches cannot mutate the
        // source conversation's nested tool-call data. The IDs themselves
        // are intentionally preserved: tool_call_id is a conversation-local
        // reference between an assistant call and its tool result.
        if (cloned.tool_calls) {
          cloned.tool_calls = cloned.tool_calls.map((tc) => ({ ...tc }));
        }
        return cloned;
      }));

      const cloned: Conversation = {
        ...source,
        id: newId,
        title: source.title,
        messages: clonedMessages,
        messageCount: clonedMessages.length,
        // Clones are a persistence boundary too: keep the visible checkmarks
        // and executor lookup keys in the same normalized representation.
        tools: source.tools ? normalizeGrantState({ ...source.tools }) : undefined,
        params: { ...source.params },
        createdAt: now,
        updatedAt: now,
      };

      // 4. Persist the clone.
      const stagedAttachmentIds = attachmentWrites.map((entry) => entry.id);
      await putAttachments(attachmentWrites);
      if (hydrated) {
        try {
          await runConversationWrite(
            newId,
            'persist cloned conversation',
            () => persistClonedConversationData(id, cloned, messageIdMap),
          );
        } catch (error) {
          try {
            await deleteAttachments(stagedAttachmentIds);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'The clone failed, and its staged attachments could not be removed.',
              { cause: cleanupError },
            );
          }
          throw error;
        }
      }

      // 5. Update in-memory state.
      set((s) => {
        const { byId } = evictNonResidentMessages({ ...s.byId, [newId]: cloned }, newId);
        return {
          byId,
          order: [newId, ...s.order],
          structuralVersion: s.structuralVersion + 1,
          activeId: newId,
        };
      });
        return cloned;
      } finally {
        unmarkGenerationBlockingOperation(operation.operationId);
      }
    },

    setActive: (id) => {
      // Switching no longer waits for a generation. A response belongs to its
      // conversation, not to whatever the user happens to be looking at, and
      // the session manager keeps its ownership across the change. A corpus
      // mutation still blocks, because it is about to invalidate the very rows
      // a switch would try to read.
      if (conversationCorpusMutationOwner) return;
      set((s) => {
        const prev = s.activeId;
        if (prev === id) return s;
        // Only the transcripts nothing is using are dropped. Evicting every
        // non-selected conversation — which is what this used to do — would
        // strand a background generation's tool loop, because the orchestrator
        // reads and mutates its transcript through the store by conversation
        // ID. The memory pressure that motivated the blanket clear is still
        // handled: an idle, complete, unreferenced transcript is released
        // exactly as before.
        const { byId, evicted } = evictNonResidentMessages(s.byId, id ?? '');
        // Eviction empties a transcript but does not change the list's shape,
        // so it deliberately does not bump `structuralVersion`.
        return evicted ? { byId, activeId: id } : { activeId: id };
      });

      if (id) {
        highlightedIds.delete(id);
        if (!isMessagesLoaded(id)) {
          get().loadConversationMessages(id);
        }
      }
    },

    rename: (id, title) => {
      if (isConversationStructurallyLocked(id)) return;
      set((s) => {
        const conv = s.byId[id];
        if (!conv) return s;
        const updated = { ...conv, title, updatedAt: Date.now() };
        if (hydrated) void enqueueConversationWrite(id, 'rename conversation', () => saveMeta(updated));
        return { byId: { ...s.byId, [id]: updated }, structuralVersion: s.structuralVersion + 1 };
      });
    },

    archive: (id) => {
      // Archiving a conversation mid-response has no defined meaning for the
      // response, so the generating target stays blocked.
      if (isConversationStructurallyLocked(id)) return;
      set((s) => {
        const conv = s.byId[id];
        if (!conv || conv.archived) return s;
        const updated = { ...conv, archived: true, updatedAt: Date.now() };
        if (hydrated) void enqueueConversationWrite(id, 'archive conversation', () => saveMeta(updated));
        return { byId: { ...s.byId, [id]: updated }, structuralVersion: s.structuralVersion + 1 };
      });
    },

    unarchive: (id) => {
      if (isConversationStructurallyLocked(id)) return;
      set((s) => {
        const conv = s.byId[id];
        if (!conv || !conv.archived) return s;
        const { archived: _drop, ...rest } = conv;
        const updated = { ...rest, updatedAt: Date.now() };
        if (hydrated) void enqueueConversationWrite(id, 'unarchive conversation', () => saveMeta(updated));
        const nextById = { ...s.byId, [id]: updated };
        const nextFilterTab = s.activeId === id ? 'active' : s.filterTab;
        return {
          byId: nextById,
          filterTab: nextFilterTab,
          structuralVersion: s.structuralVersion + 1,
        };
      });
    },

    remove: async (id) => {
      if (isConversationStructurallyLocked(id)) return false;
      const conv = get().byId[id];
      if (!conv) return false;
      const priorOrderIndex = get().order.indexOf(id);
      const wasActive = get().activeId === id;
      if (hydrated) {
        // The delete is the lane's final task and seals it in the same
        // synchronous step. Work queued earlier still drains against rows that
        // are about to disappear, which is harmless; nothing enqueued after
        // this point is accepted, so a generation still settling when the user
        // deleted this conversation cannot resurrect it. Sealing only once the
        // delete resolved would leave exactly that window open.
        const queued = enqueueFinalConversationWrite(
          id,
          'delete conversation',
          async () => {
            // Read authoritative IDs first, but never delete their bytes until
            // the conversation transaction commits. A failed corpus delete
            // must leave the still-referenced blobs intact.
            const attachmentIds = collectAttachmentIds(await loadMessages(id));
            await deleteConversation(id);
            if (attachmentIds.length > 0) {
              try {
                await deleteAttachments(attachmentIds);
              } catch (error) {
                reportConversationPersistenceWarning(
                  'delete conversation attachments after conversation delete',
                  error,
                  id,
                );
              }
            }
          },
        );
        const barrier: Promise<PersistenceOutcome> = queued
          .then((outcome) => {
            if (outcome === 'committed') {
              closeConversationPersistence(id);
              highlightedIds.delete(id);
            } else {
              reopenConversationPersistence(id);
              set((state) => {
                if (state.byId[id]) return state;
                const order = [...state.order];
                order.splice(Math.min(Math.max(priorOrderIndex, 0), order.length), 0, id);
                return {
                  byId: { ...state.byId, [id]: conv },
                  order,
                  structuralVersion: state.structuralVersion + 1,
                  activeId: wasActive && state.activeId === null ? id : state.activeId,
                };
              });
            }
            return outcome;
          })
          .finally(() => {
            if (pendingConversationDeletes.get(id) === barrier) {
              pendingConversationDeletes.delete(id);
            }
          });
        pendingConversationDeletes.set(id, barrier);
      } else if (conv) {
        const attachmentIds = collectAttachmentIds(conv.messages);
        if (attachmentIds.length > 0) {
          try {
            await deleteAttachments(attachmentIds);
          } catch (error) {
            reportConversationPersistenceFailure(
              'delete unhydrated conversation attachments',
              error,
              id,
            );
            return false;
          }
        }
      }
      set((s) => {
        const { [id]: _drop, ...rest } = s.byId;
        return {
          byId: rest,
          order: s.order.filter((x) => x !== id),
          structuralVersion: s.structuralVersion + 1,
          activeId: s.activeId === id ? null : s.activeId,
        };
      });
      if (!hydrated) {
        highlightedIds.delete(id);
        return true;
      }
      return (await pendingConversationDeletes.get(id)) === 'committed';
    },

    clearAll: async (corpusOperationId) => {
      const ownsCorpusLease = corpusOperationId !== undefined
        && conversationCorpusMutationOwner?.operationId === corpusOperationId;
      if (!ownsCorpusLease && (isAnyStreaming() || isGenerationBlockingOperationActive())) {
        return false;
      }
      const operation = ownsCorpusLease
        ? undefined
        : markConversationCorpusMutation('Wipe all conversations');
      const corpusOwner = ownsCorpusLease ? conversationCorpusMutationOwner : operation;
      let maintenance: ReturnType<typeof persistenceLanes.beginGlobalMaintenance> | undefined;
      try {
        await corpusOwner!.ready;
        maintenance = persistenceLanes.beginGlobalMaintenance();
        await maintenance.drain();
        // Hydration is a UI/readiness state, not evidence that IndexedDB is
        // empty. Settings can invoke a wipe while startup hydration is still
        // pending, so the durable corpus must always be cleared.
        await deleteAllConversations();

        maintenance.closeKnownLanes();
        pendingMessageLoads.clear();
        generationTerminalPrerequisites.clear();
        highlightedIds.clear();
        set((state) => ({
          byId: {},
          order: [],
          activeId: null,
          loading: false,
          loadingMessageIds: new Set<string>(),
          structuralVersion: state.structuralVersion + 1,
        }));

        // Every attachment belongs to the corpus just removed. Clearing the
        // whole store also reclaims orphans left by older failed cleanups.
        try {
          await clearAttachments();
        } catch (error) {
          reportConversationPersistenceWarning(
            'clear attachment blobs after conversation wipe',
            error,
          );
        }
        return true;
      } catch (error) {
        reportConversationPersistenceFailure('delete all conversations', error);
        return false;
      } finally {
        maintenance?.release();
        if (operation) unmarkConversationCorpusMutation(operation.operationId);
      }
    },

    /* ---------------------------------------------------------- */
    /*  Message mutations                                          */
    /* ---------------------------------------------------------- */

    appendUserMessage: async (id, msg) => {
      if (conversationCorpusMutationOwner) return undefined;
      claimConversationTurnBoundary(id, 'user send');
      try {
        const conversation = get().byId[id];
        if (!conversation) return undefined;
        const nextCount = (conversation.messageCount ?? conversation.messages.length) + 1;
        const now = Date.now();
        const message: Message = {
          id: uid(),
          createdAt: now,
          sortOrder: nextCount,
          ...msg,
          role: 'user',
        };
        const boundaryMetadata: Conversation = {
          ...conversation,
          title: conversationTitleAfterAppend(conversation.title, 'user', msg.content),
          messages: [...conversation.messages, message],
          messageCount: nextCount,
          updatedAt: now,
        };

        const persistedMessage = hydrated
          ? (await runConversationWrite(
              id,
              'persist user-send boundary',
              () => persistWhiteboardUserSend({
                conversationId: id,
                message,
                whiteboardEnabled: Boolean(
                  conversation.tools?.enabled && conversation.tools.whiteboard_enabled,
                ),
                metadata: boundaryMetadata,
              }),
            )).message
          : message;

        // Re-read after the durable boundary. Metadata-only changes are
        // merged from the live conversation instead of being replaced by the
        // pre-await snapshot. A concurrent remove already owns the tracked
        // final lane delete, so this continuation must not launch an untracked
        // raw delete that could erase a later same-ID restore.
        const current = get().byId[id];
        if (!current) {
          await pendingConversationDeletes.get(id);
          return undefined;
        }
        const mergeMessage = (latest: Conversation): Conversation => {
          const alreadyPresent = latest.messages.some(
            (candidate) => candidate.id === persistedMessage.id,
          );
          const messages = alreadyPresent
            ? latest.messages
            : [...latest.messages, persistedMessage];
          return {
            ...latest,
            title: latest.title === conversation.title
              ? conversationTitleAfterAppend(latest.title, 'user', msg.content)
              : latest.title,
            messages,
            messageCount: alreadyPresent
              ? (latest.messageCount ?? latest.messages.length)
              : (latest.messageCount ?? latest.messages.length) + 1,
            updatedAt: Math.max(latest.updatedAt, now),
          };
        };
        let published = false;
        let publishedConversation: Conversation | undefined;
        set((state) => {
          const latest = state.byId[id];
          if (!latest) return state;
          published = true;
          const merged = mergeMessage(latest);
          publishedConversation = merged;
          return {
            byId: { ...state.byId, [id]: merged },
            order: moveToFront(state.order, id),
            loadedVersion: state.loadedVersion + 1,
          };
        });
        if (!published || !publishedConversation) {
          await pendingConversationDeletes.get(id);
          return undefined;
        }
        // The message itself was durable before publication. Reconcile the
        // live metadata snapshot without changing acceptance semantics: a
        // metadata-only follow-up failure must not report this already-
        // committed send as rejected (which would duplicate a restored draft).
        if (hydrated) {
          try {
            await runConversationWrite(
              id,
              'reconcile user-send conversation metadata',
              () => saveMeta(publishedConversation!),
            );
          } catch (error) {
            reportConversationPersistenceWarning(
              'reconcile user-send conversation metadata',
              error,
              id,
            );
          }
        }
        return persistedMessage;
      } finally {
        releaseConversationTurnBoundary(id, 'user send');
      }
    },

    appendMessage: (id, msg) => {
      const conv = get().byId[id];
      if (!conv) return undefined;
      const nextCount = (conv.messageCount ?? conv.messages.length) + 1;
      const message: Message = {
        id: uid(),
        createdAt: Date.now(),
        sortOrder: nextCount,
        ...msg,
      };
      set((s) => {
        const current = s.byId[id];
        if (!current) return s;
        const newTitle = conversationTitleAfterAppend(current.title, msg.role, msg.content);
        const updated = {
          ...current,
          title: newTitle,
          messages: [...current.messages, message],
          messageCount: nextCount,
          updatedAt: Date.now(),
        };
        const isStreamingAssistantPlaceholder = msg.role === 'assistant' && msg.streaming === true;
        // Scoped to this conversation, not to the application. While only one
        // chat was reachable, `streamingOwners.size === 0` was an adequate
        // stand-in for "this chat is not streaming"; once the user can edit a
        // different conversation during a run, that global form silently drops
        // the other conversation's writes. A conversation that *is* streaming
        // still defers to its own checkpoint and terminal path, which owns
        // that transcript's ordering.
        if (hydrated && !streamingOwners.has(id) && !isStreamingAssistantPlaceholder) {
          // One unit: a metadata row whose messageCount outran its message row
          // makes the next load look like an incomplete history.
          void enqueueConversationWrite(id, 'append conversation message', async () => {
            await saveMessage(message, id);
            await saveMeta(updated);
          });
        }
        return {
          byId: { ...s.byId, [id]: updated },
          order: moveToFront(s.order, id),
          loadedVersion: s.loadedVersion + 1,
        };
      });
      return message;
    },

    patchMessage: (id, messageId, patch) =>
      set((s) => {
        const conv = s.byId[id];
        if (!conv) return s;
        const updated = {
          ...conv,
          updatedAt: Date.now(),
          messages: conv.messages.map((m) =>
            m.id === messageId ? { ...m, ...normalizeReplayStatePatch(m, patch) } : m,
          ),
        };
        if (hydrated && !streamingOwners.has(id)) {
          void enqueueConversationWrite(id, 'patch conversation message', async () => {
            await updateMessage(messageId, patch);
            await saveMeta(updated);
          });
        }
        return {
          byId: { ...s.byId, [id]: updated },
          order: moveToFront(s.order, id),
        };
      }),

    appendToMessage: (id, messageId, delta) =>
      set((s) => patchMessageById(s, id, messageId, (m) => ({ content: m.content + delta }), { streaming: true })),

    appendReasoningToMessage: (id, messageId, delta) =>
      set((s) => patchMessageById(s, id, messageId, (m) => appendReasoningDelta(m, delta), { streaming: true })),

    appendRefusalToMessage: (id, messageId, delta) =>
      set((s) => patchMessageById(s, id, messageId, (m) => ({ refusal: (m.refusal ?? '') + delta }), { streaming: true })),

    appendToLast: (id, delta) =>
      set((s) => {
        const result = patchLastMessage(s, id, (m) => ({ content: m.content + delta }), { streaming: true });
        if (hydrated && !streamingOwners.has(id) && result.byId) {
          const updated = result.byId[id];
          if (updated) void enqueueConversationWrite(id, 'save streamed message metadata', () => saveMeta(updated));
        }
        return result;
      }),

    appendReasoning: (id, delta) =>
      set((s) => {
        const result = patchLastMessage(s, id, (m) => appendReasoningDelta(m, delta), { streaming: true });
        if (hydrated && !streamingOwners.has(id) && result.byId) {
          const updated = result.byId[id];
          if (updated) void enqueueConversationWrite(id, 'save streamed reasoning metadata', () => saveMeta(updated));
        }
        return result;
      }),

    appendRefusal: (id, delta) =>
      set((s) => {
        const result = patchLastMessage(s, id, (m) => ({ refusal: (m.refusal ?? '') + delta }), { streaming: true });
        if (hydrated && !streamingOwners.has(id) && result.byId) {
          const updated = result.byId[id];
          if (updated) void enqueueConversationWrite(id, 'save streamed refusal metadata', () => saveMeta(updated));
        }
        return result;
      }),

    finalizeMessage: (id, messageId, patch) =>
      set((s) => {
        const result = patchMessageById(s, id, messageId, (m) => mergeFinalPatch(m, patch));
        if (hydrated && result.byId) {
          const updated = result.byId[id];
          const message = updated?.messages.find((candidate) => candidate.id === messageId);
          if (updated && message && !terminalPersistenceIsDeferred(id, message.id)) {
            void enqueueConversationWrite(
              id,
              'finalize conversation message',
              async () => {
                await updateMessage(message.id, message);
                await saveMeta(updated);
              },
              terminalWriteOptionsFor(id, message.id),
            );
          }
        }
        return result;
      }),

    finalizeLast: (id, patch) =>
      set((s) => {
        const result = patchLastMessage(s, id, (m) => mergeFinalPatch(m, patch));
        if (hydrated && result.byId) {
          const updated = result.byId[id];
          if (updated) {
            const lastAssistant = [...updated.messages]
              .reverse()
              .find((message) => message.role === 'assistant');
            if (terminalPersistenceIsDeferred(id, lastAssistant?.id)) return result;
            void enqueueConversationWrite(
              id,
              lastAssistant ? 'finalize assistant message' : 'save finalized conversation metadata',
              async () => {
                if (lastAssistant) await updateMessage(lastAssistant.id, lastAssistant);
                await saveMeta(updated);
              },
              terminalWriteOptionsFor(id, lastAssistant?.id),
            );
          }
        }
        return result;
      }),

    patchConversation: (id, patch) =>
      set((s) => {
        const conv = s.byId[id];
        if (!conv) return s;
        const updated = { ...conv, ...patch, updatedAt: Date.now() };
        if (hydrated) void enqueueConversationWrite(id, 'patch conversation metadata', () => saveMeta(updated));
        return { byId: { ...s.byId, [id]: updated } };
      }),

    popLast: (id) => {
      if (conversationCorpusMutationOwner) return;
      const conv = get().byId[id];
      const dropped = conv && conv.messages.length > 0
        ? conv.messages[conv.messages.length - 1]
        : undefined;
      // Only fire the durable delete when memory actually dropped a row: a
      // null drop would fall back to `.last()` and delete an arbitrary
      // sibling while memory dropped nothing. Blob cleanup shares the same
      // lane so a terminal/global drain includes it before a same-ID restore.
      if (dropped) {
        const deleteDurableMessage = hydrated;
        void enqueueConversationWrite(
          id,
          'delete last conversation message',
          async () => {
            if (dropped.attachments?.length) {
              await deleteAttachments(dropped.attachments.map((attachment) => attachment.id));
            }
            if (deleteDurableMessage) await deleteLastMessage(id, dropped.id);
          },
        );
      }
      set((s) => {
        const conv = s.byId[id];
        if (!conv || conv.messages.length === 0) return s;
        const newMessages = conv.messages.slice(0, -1);
        return {
          byId: {
            ...s.byId,
            [id]: { ...conv, messages: newMessages, messageCount: Math.max(0, (conv.messageCount ?? conv.messages.length) - 1) },
          },
          loadedVersion: s.loadedVersion + 1,
        };
      });
    },

    replaceFromMessage: async (id, messageId, next, boundary = 'retry') => {
      if (streamingOwners.has(id) || conversationCorpusMutationOwner) return false;
      claimConversationTurnBoundary(id, 'branch replacement');
      try {
        const conv = get().byId[id];
        if (!conv) return false;
        const idx = conv.messages.findIndex((message) => message.id === messageId);
        if (idx < 0 || conv.messages[idx]?.role !== 'user') return false;
        const droppedAttachmentIds = collectBranchAttachmentIds(
          conv.messages,
          idx,
          next.attachments,
        );

        let replaced: Conversation;
        if (hydrated) {
          try {
            const result = await runConversationWrite(
              id,
              'replace conversation history',
              async () => {
                const branch = await replaceConversationBranch({
                  conversation: conv,
                  messageId,
                  next,
                  boundary,
                  whiteboardEnabled: conv.tools?.enabled === true
                    && conv.tools.whiteboard_enabled === true,
                });
                if (droppedAttachmentIds.length > 0) {
                  try {
                    await deleteAttachments(droppedAttachmentIds);
                  } catch (error) {
                    reportConversationPersistenceWarning(
                      'delete attachments removed by branch replacement',
                      error,
                      id,
                    );
                  }
                }
                return branch;
              },
            );
            replaced = result.conversation;
          } catch (error) {
            reportConversationPersistenceFailure('replace conversation history', error, id);
            throw error;
          }
        } else {
          const now = Date.now();
          const updated = conv.messages.slice(0, idx);
          updated.push({
            ...conv.messages[idx],
            createdAt: now,
            content: next.content,
            attachments: next.attachments,
            streaming: false,
            usage: undefined,
            reasoning: undefined,
          });
          replaced = {
            ...conv,
            messages: updated,
            messageCount: updated.length,
            updatedAt: now,
          };
          if (droppedAttachmentIds.length > 0) {
            try {
              await deleteAttachments(droppedAttachmentIds);
            } catch (error) {
              reportConversationPersistenceWarning(
                'delete attachments removed by branch replacement',
                error,
                id,
              );
            }
          }
        }

        // The branch transaction intentionally owns message truncation, but
        // live metadata/configuration changes made during its await remain
        // authoritative. If deletion won, its tracked final lane delete owns
        // durable cleanup; this continuation must not race a later restore.
        if (!get().byId[id]) {
          await pendingConversationDeletes.get(id);
          return false;
        }
        let published = false;
        let publishedConversation: Conversation | undefined;
        set((state) => {
          const current = state.byId[id];
          if (!current) return state;
          published = true;
          const merged: Conversation = {
            ...current,
            messages: replaced.messages,
            messageCount: replaced.messageCount,
            updatedAt: Math.max(current.updatedAt, replaced.updatedAt),
          };
          publishedConversation = merged;
          return {
            byId: { ...state.byId, [id]: merged },
            order: moveToFront(state.order, id),
            loadedVersion: state.loadedVersion + 1,
          };
        });
        if (!published || !publishedConversation) {
          await pendingConversationDeletes.get(id);
          return false;
        }
        // The atomic branch transaction already committed. This best-effort
        // metadata reconciliation may warn, but it cannot turn that accepted
        // branch into a false failure for Retry/Edit-and-resend callers.
        if (hydrated) {
          try {
            await runConversationWrite(
              id,
              'reconcile replaced conversation metadata',
              () => saveMeta(publishedConversation!),
            );
          } catch (error) {
            reportConversationPersistenceWarning(
              'reconcile replaced conversation metadata',
              error,
              id,
            );
          }
        }
        return true;
      } finally {
        releaseConversationTurnBoundary(id, 'branch replacement');
      }
    },

    setModel: (id, model) => {
      // Configuration is locked for the conversation that is generating, not
      // for every conversation. A chat the user switched to during someone
      // else's run stays fully configurable.
      if (isConversationStructurallyLocked(id)) return;
      set((s) => {
        const conv = s.byId[id];
        if (!conv) return s;
        const updated = { ...conv, model, updatedAt: Date.now() };
        if (hydrated) void enqueueConversationWrite(id, 'set conversation model', () => saveMeta(updated));
        return { byId: { ...s.byId, [id]: updated } };
      });
    },

    setParams: (id, params) => {
      if (isConversationStructurallyLocked(id)) return;
      set((s) => {
        const conv = s.byId[id];
        if (!conv) return s;
        const updated = { ...conv, params, updatedAt: Date.now() };
        if (hydrated) void enqueueConversationWrite(id, 'set generation parameters', () => saveMeta(updated));
        return { byId: { ...s.byId, [id]: updated } };
      });
    },
  }),
);

/**
 * Read the overlay's atomic storage snapshot and apply process-local runtime
 * locks to its package-import gate.
 */
export async function getWhiteboardUiSnapshot(
  conversationId: string,
): Promise<WhiteboardUiSnapshot> {
  const snapshot = await readWhiteboardUiSnapshot(conversationId);
  return {
    ...snapshot,
    importEligible: snapshot.importEligible
      && !isConversationStructurallyLocked(conversationId),
  };
}

/**
 * Globally exclude generation/config work while the empty-board package
 * transaction repeats its storage eligibility checks and inserts both heads.
 */
export async function importWhiteboardPackageIntoEmptyConversation(
  conversationId: string,
  contents: WhiteboardPackageContents,
  options: WhiteboardMutationOptions = {},
): Promise<WhiteboardPackageImportResult> {
  const operation = markGenerationBlockingOperation(
    'whiteboard_import',
    `Import Whiteboard package into ${conversationId}`,
    undefined,
    conversationId,
  );
  try {
    const imported = await importWhiteboardPackageIntoEmptyConversationStorage(
      conversationId,
      contents,
      options,
    );
    // Existing UI/store subscribers use loadedVersion as an invalidation
    // signal; the board rows themselves remain sourced from the atomic read.
    useConversations.setState((state) => ({
      loadedVersion: state.loadedVersion + 1,
    }));
    return imported;
  } finally {
    unmarkGenerationBlockingOperation(operation.operationId);
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function moveToFront(arr: string[], id: string): string[] {
  if (arr[0] === id) return arr;
  return [id, ...arr.filter((x) => x !== id)];
}

function patchLastMessage(
  state: ConversationsState,
  id: string,
  patch: (m: Message) => Partial<Message>,
  opts: { streaming?: boolean } = {},
): Partial<ConversationsState> {
  const conv = state.byId[id];
  if (!conv || conv.messages.length === 0) return state;
  let idx = conv.messages.length - 1;
  while (idx >= 0 && conv.messages[idx].role !== 'assistant') {
    idx--;
  }
  if (idx < 0) return state;
  const last = conv.messages[idx];
  const messages = [...conv.messages];
  messages[idx] = { ...last, ...patch(last) };
  return {
    byId: {
      ...state.byId,
      [id]: {
        ...conv,
        messages,
        updatedAt: opts.streaming ? conv.updatedAt : Date.now(),
      },
    },
  };
}

function patchMessageById(
  state: ConversationsState,
  id: string,
  messageId: string,
  patch: (m: Message) => Partial<Message>,
  opts: { streaming?: boolean } = {},
): Partial<ConversationsState> {
  const conv = state.byId[id];
  if (!conv) return state;
  const idx = conv.messages.findIndex((message) => message.id === messageId);
  if (idx < 0) return state;
  const messages = [...conv.messages];
  messages[idx] = { ...messages[idx], ...patch(messages[idx]) };
  return {
    byId: {
      ...state.byId,
      [id]: {
        ...conv,
        messages,
        updatedAt: opts.streaming ? conv.updatedAt : Date.now(),
      },
    },
  };
}

function mergeFinalPatch(message: Message, patch?: Partial<Message>): Partial<Message> {
  const replaySafePatch = normalizeReplayStatePatch(message, patch ?? {});
  const merged: Partial<Message> = { streaming: false, ...replaySafePatch };
  // `meta` is a partial status/metrics update, just like the top-level Message
  // patch. Preserve fields written by an earlier tool-loop turn unless the new
  // patch explicitly replaces them.
  if (replaySafePatch.meta) merged.meta = { ...message.meta, ...replaySafePatch.meta };
  if (replaySafePatch.tool_calls && message.tool_calls?.length) {
    merged.tool_calls = [...message.tool_calls, ...replaySafePatch.tool_calls];
  } else if (!replaySafePatch.tool_calls && message.tool_calls?.length) {
    merged.tool_calls = message.tool_calls;
  }
  return merged;
}

/**
 * Replay carriers and their response-local accounting form one message field.
 * Any unpaired carrier-array replacement invalidates that protocol's groups in
 * memory immediately; persistence applies the same rule transactionally.
 */
function normalizeReplayStatePatch(message: Message, patch: Partial<Message>): Partial<Message> {
  const has = (key: keyof Message): boolean => Object.prototype.hasOwnProperty.call(patch, key);
  const responsesChanged = has('responses_output_items');
  const anthropicChanged = has('anthropic_output_blocks');
  const orderChanged = has('anthropic_block_order');
  const accountingChanged = has('opaque_replay_accounting');
  if (!responsesChanged && !anthropicChanged && !orderChanged && !accountingChanged) return patch;

  const responsesOutputItems = responsesChanged
    ? patch.responses_output_items
    : message.responses_output_items;
  const anthropicOutputBlocks = anthropicChanged
    ? patch.anthropic_output_blocks
    : message.anthropic_output_blocks;
  let rawAccounting: unknown = accountingChanged
    ? patch.opaque_replay_accounting
    : message.opaque_replay_accounting;
  if (!accountingChanged && Array.isArray(rawAccounting)) {
    rawAccounting = rawAccounting.filter((group) => {
      if (responsesChanged && group.protocol === 'openai-responses') return false;
      if (anthropicChanged && group.protocol === 'anthropic-messages') return false;
      return true;
    });
  }
  return {
    ...patch,
    // A block replacement without a paired order patch leaves a stale layout
    // behind: clear it rather than replaying new blocks in an old order.
    ...(anthropicChanged && !orderChanged ? { anthropic_block_order: undefined } : {}),
    opaque_replay_accounting: normalizeOpaqueReplayAccounting(rawAccounting, {
      responsesOutputItems,
      responsesBaseUrl: patch.meta?.baseUrl ?? message.meta?.baseUrl,
      anthropicOutputBlocks,
      anthropicBaseUrl: patch.meta?.baseUrl ?? message.meta?.baseUrl,
    }),
  };
}

function collectAttachmentIds(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (!m.attachments) continue;
    for (const a of m.attachments) out.push(a.id);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Streaming marker                                                   */
/* ------------------------------------------------------------------ */

/**
 * Create the initial assistant row for a generation that does not admit
 * Whiteboard. Whiteboard admission owns its own atomic assistant write; this
 * explicit alternative preserves crash recovery for every other turn without
 * racing a later Whiteboard reference patch.
 */
export async function persistNonWhiteboardStreamingAssistant(
  owner: StreamOwner,
): Promise<Message> {
  const currentOwner = streamingOwners.get(owner.conversationId);
  if (
    !currentOwner
    || currentOwner.terminal
    || currentOwner.generationId !== owner.generationId
    || currentOwner.assistantMessageId !== owner.assistantMessageId
  ) {
    throw new Error('The streaming assistant admission is no longer owned by this generation.');
  }
  const conversation = useConversations.getState().byId[owner.conversationId];
  const assistant = conversation?.messages.find(
    (message) => message.id === owner.assistantMessageId && message.role === 'assistant',
  );
  if (!conversation || !assistant) {
    throw new Error('The streaming assistant admission message is unavailable.');
  }
  const assistantRow = messageToStorageRow(assistant, owner.conversationId);
  const metadataRow = conversationMetaToStorageRow(conversation);
  const startedAt = Date.now();
  // On the lane, not beside it: a terminal flush left over from the previous
  // generation must land before this admission, never after it.
  await runConversationWrite(
    owner.conversationId,
    'admit streaming assistant',
    () => runConversationDataMutation(async (tables) => {
    const existing = await tables.messages.get(assistant.id);
    if (existing && existing.conversationId !== owner.conversationId) {
      throw new Error('The streaming assistant message ID belongs to another conversation.');
    }
    await tables.messages.put(assistantRow);
    await tables.conversationsMeta.put(metadataRow);
    // The journal row joins the admission transaction rather than following
    // it. A placeholder that exists without its journal row is exactly the
    // response that reloads looking complete after a crash.
      await tables.generationRuns.put({
        conversationId: owner.conversationId,
        generationId: owner.generationId,
        assistantMessageId: owner.assistantMessageId,
        state: 'running',
        startedAt,
      });
    }),
  );
  return assistant;
}

export function markStreaming(
  id: string,
  assistantMessageId: string,
  generationId = uid(),
  profileId?: string,
): StreamOwner {
  for (const operation of generationBlockingOperationOwners.values()) {
    if (
      operation.conversationId === undefined
      || operation.conversationId === id
    ) {
      throw new Error(ACTIVE_GENERATION_BLOCKING_OPERATION_MESSAGE);
    }
  }
  if (conversationCorpusMutationOwner) {
    throw new Error(ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE);
  }
  if (streamingOwners.has(id)) {
    throw new Error(`Conversation ${id} already has an active stream owner.`);
  }
  const owner: StreamOwnerState = {
    conversationId: id,
    generationId,
    assistantMessageId,
    ...(profileId ? { profileId } : {}),
    terminal: false,
  };
  streamingOwners.set(id, owner);
  if (!checkpointTimer) {
    checkpointTimer = setInterval(async () => {
      if (!hydrated) return;
      const { byId } = useConversations.getState();
      for (const [sid, currentOwner] of streamingOwners) {
        if (currentOwner.terminal) continue;
        // A lifecycle mutation can commit durable Whiteboard refs before its
        // awaiting caller publishes them to Zustand. Do not capture a
        // checkpoint while any conversation-lane task is running or queued;
        // the next interval observes the post-publication state instead of
        // placing a pre-publication snapshot behind that mutation.
        if (!canEnqueueConversationCheckpoint(sid)) continue;
        const conv = byId[sid];
        if (!conv) continue;
        const checkpointMessages = currentStreamingTurnMessages(
          conv.messages,
          currentOwner.assistantMessageId,
        );
        // One coalesced unit per conversation. The lane keeps only the newest
        // pending checkpoint and drops any checkpoint whose generation has
        // already terminalized, so a snapshot of partial output can never be
        // written after the finished answer.
        void enqueueConversationWrite(
          sid,
          'checkpoint active generation',
          async () => {
            if (checkpointMessages.length > 0) {
              await saveMessages(checkpointMessages, sid, { compress: false });
            }
            await saveMeta(conv);
          },
          { kind: 'checkpoint', generationId: currentOwner.generationId },
        );
      }
    }, 5_000);
  }
  useConversations.setState((s) => ({ ...s }));
  return {
    conversationId: owner.conversationId,
    generationId: owner.generationId,
    assistantMessageId: owner.assistantMessageId,
  };
}

export function isStreamingOwner(
  id: string,
  generationId: string,
  includeTerminal = false,
): boolean {
  const owner = streamingOwners.get(id);
  return !!owner
    && owner.generationId === generationId
    && (includeTerminal || !owner.terminal);
}

/** Claim the generation's single terminal transition and finalize its message. */
export function finalizeStreamingOwner(
  id: string,
  generationId: string,
  patch?: Partial<Message>,
): boolean {
  const owner = streamingOwners.get(id);
  if (!owner || owner.generationId !== generationId || owner.terminal) return false;
  owner.terminal = true;
  useConversations.getState().finalizeMessage(id, owner.assistantMessageId, patch);
  useConversations.setState((s) => ({ ...s }));
  return true;
}

export function getStreamingOwner(id: string): StreamOwner | undefined {
  const owner = streamingOwners.get(id);
  return owner
    ? {
        conversationId: owner.conversationId,
        generationId: owner.generationId,
        assistantMessageId: owner.assistantMessageId,
      }
    : undefined;
}

/**
 * Queue the generation's terminal flush.
 *
 * Enqueued as `terminal`, so it retires every checkpoint this generation still
 * has waiting and becomes the barrier the lane drains to.
 */
export interface TerminalFlushPersistence {
  persistSnapshot: typeof persistConversationMessageSnapshot;
  saveMetadata: typeof saveMeta;
  closeRun: typeof closeGenerationRun;
  /** Production boundary: Whiteboard guard, transcript, metadata, and journal. */
  persistTerminal?: (conversation: Conversation, generationId: string) => Promise<void>;
}

/**
 * Register storage work that must succeed before this generation may retire
 * its crash journal or release capacity. Whiteboard uses this to keep its
 * generation-owned working row and the generic transcript terminal boundary
 * in one failure domain while still allowing an in-process retry.
 */
export function registerGenerationTerminalPrerequisite(
  id: string,
  generationId: string,
  run: () => Promise<boolean>,
): () => void {
  const owner = streamingOwners.get(id);
  if (!owner || owner.generationId !== generationId) {
    throw new Error('Cannot register a terminal prerequisite for a stale generation.');
  }
  const prerequisite = { generationId, run };
  generationTerminalPrerequisites.set(id, prerequisite);
  return () => {
    if (generationTerminalPrerequisites.get(id) === prerequisite) {
      generationTerminalPrerequisites.delete(id);
    }
  };
}

async function satisfyGenerationTerminalPrerequisite(
  id: string,
  generationId: string,
): Promise<boolean> {
  const prerequisite = generationTerminalPrerequisites.get(id);
  if (!prerequisite || prerequisite.generationId !== generationId) return true;
  try {
    const settled = await prerequisite.run();
    if (!settled) {
      reportConversationPersistenceFailure(
        'settle generation terminal prerequisite',
        new Error('The generation terminal prerequisite did not commit.'),
        id,
      );
    }
    return settled;
  } catch (error) {
    reportConversationPersistenceFailure(
      'settle generation terminal prerequisite',
      error,
      id,
    );
    return false;
  }
}

async function persistTerminalConversationTransaction(
  conversation: Conversation,
  generationId: string,
): Promise<void> {
  const incomplete = conversation.messages.length > 0
    && !isConversationMessageHistoryComplete(conversation);
  await runConversationDataMutation(async (tables) => {
    const whiteboardWorking = await tables.whiteboardWorking.get([conversation.id, 'model']);
    if (whiteboardWorking) {
      throw new Error(
        `Whiteboard generation ${whiteboardWorking.generationId ?? 'unknown'} is not durably settled.`,
      );
    }

    if (conversation.messages.length > 0) {
      const rows = conversation.messages.map((message) => (
        messageToStorageRow(message, conversation.id)
      ));
      if (!incomplete) {
        await tables.messages.where('conversationId').equals(conversation.id).delete();
      }
      await tables.messages.bulkPut(rows);
    }
    await tables.conversationsMeta.put(conversationMetaToStorageRow(conversation));
    const run = await tables.generationRuns.get(conversation.id);
    if (run?.generationId === generationId) {
      await tables.generationRuns.delete(conversation.id);
    }
  });

  if (incomplete) {
    reportConversationPersistenceWarning(
      'preserve incomplete conversation history',
      new Error(
        `Only ${conversation.messages.length} of ${conversation.messageCount ?? 'an unknown number of'} messages were loaded. `
        + 'Existing stored rows were preserved with a non-deleting flush; reselect the conversation to retry the full load.',
      ),
      conversation.id,
    );
  }
}

const DEFAULT_TERMINAL_FLUSH_PERSISTENCE: TerminalFlushPersistence = {
  persistSnapshot: persistConversationMessageSnapshot,
  saveMetadata: saveMeta,
  closeRun: closeGenerationRun,
  persistTerminal: persistTerminalConversationTransaction,
};

function enqueueTerminalFlush(
  id: string,
  generationId: string,
  persistence: TerminalFlushPersistence = DEFAULT_TERMINAL_FLUSH_PERSISTENCE,
): Promise<PersistenceOutcome> {
  // Before hydration there is no durable conversation/journal boundary to
  // cross. Treat the in-memory release as committed rather than manufacturing
  // a permanent failed owner during startup-only tests.
  if (!hydrated) return Promise.resolve('committed');
  const conv = useConversations.getState().byId[id];
  if (!conv) return Promise.resolve('closed');
  return enqueueConversationWrite(
    id,
    'flush conversation history',
    async () => {
      if (persistence.persistTerminal) {
        await persistence.persistTerminal(conv, generationId);
        return;
      }
      // Injectable tests may exercise the legacy split seam. Production uses
      // `persistTerminal`, whose guard and writes share one Dexie transaction.
      const whiteboardWorking = await getModelWhiteboardWorking(id);
      if (whiteboardWorking) {
        throw new Error(
          `Whiteboard generation ${whiteboardWorking.generationId} is not durably settled.`,
        );
      }
      if (conv.messages.length > 0) await persistence.persistSnapshot(conv);
      await persistence.saveMetadata(conv);
      // Retire this generation's crash evidence last, and only if the row
      // still belongs to it. A finalizer that lost a race to a replacement
      // generation must not delete the newer run's evidence.
      await persistence.closeRun(id, generationId);
    },
    { kind: 'terminal', generationId },
  );
}

function dropStreamingOwner(id: string, generationId: string): boolean {
  const owner = streamingOwners.get(id);
  if (!owner || owner.generationId !== generationId) return false;
  streamingOwners.delete(id);
  if (generationTerminalPrerequisites.get(id)?.generationId === generationId) {
    generationTerminalPrerequisites.delete(id);
  }
  if (streamingOwners.size === 0 && checkpointTimer) {
    clearInterval(checkpointTimer);
    checkpointTimer = null;
  }
  useConversations.setState((s) => ({ ...s }));
  return true;
}

/**
 * Release stream ownership immediately, queueing the terminal flush behind it.
 *
 * Synchronous, which is what page exit needs — there is no opportunity to await
 * anything there. Everywhere else prefer `releaseStreamingOwnerWhenDurable`:
 * this form frees the conversation for a new generation while its final writes
 * are still queued, so a replacement can start before the previous transcript
 * snapshot has landed.
 */
export function unmarkStreaming(id: string, generationId: string): boolean {
  const owner = streamingOwners.get(id);
  if (!owner || owner.generationId !== generationId) return false;
  if (generationTerminalPrerequisites.get(id)?.generationId === generationId) {
    // Whiteboard settlement is asynchronous and must precede the generic
    // terminal snapshot. Page-exit callers cannot await, so start the durable
    // release without dropping the owner or its recovery evidence early.
    void releaseStreamingOwnerWhenDurable(id, generationId);
    return true;
  }
  // Queue first. Dropping ownership publishes synchronously, and a subscriber
  // may otherwise start a destructive operation that seals the lane in the
  // gap before the terminal task is accepted.
  void enqueueTerminalFlush(id, generationId);
  return dropStreamingOwner(id, generationId);
}

/**
 * Release stream ownership only after the generation's writes are durable.
 *
 * Ownership is what admission checks, so dropping it the moment the pipeline
 * returns hands the conversation to a new generation while the previous one's
 * terminal snapshot is still queued — and that snapshot then overwrites
 * whatever the new generation has already written. The flush is therefore
 * queued while ownership is still held, the lane is drained to that barrier,
 * and only then is the owner removed.
 *
 * Holding ownership across the drain is safe: the generation has already
 * claimed its terminal transition, so the checkpoint timer skips it.
 */
export async function releaseStreamingOwnerWhenDurable(
  id: string,
  generationId: string,
  persistence: TerminalFlushPersistence = DEFAULT_TERMINAL_FLUSH_PERSISTENCE,
): Promise<boolean> {
  const owner = streamingOwners.get(id);
  if (!owner || owner.generationId !== generationId) return false;
  if (!await satisfyGenerationTerminalPrerequisite(id, generationId)) {
    return false;
  }
  const outcome = await enqueueTerminalFlush(id, generationId, persistence);
  await drainConversationPersistence(id);
  if (outcome !== 'committed') {
    // The one-row journal cannot safely be replaced while this generation's
    // terminal snapshot is still uncertain. Retaining ownership keeps both
    // same-chat admission and global capacity fenced until a later retry or
    // application restart recovers the journaled run.
    return false;
  }
  // Revalidate after the await: a stale finalizer must not delete a successor.
  return dropStreamingOwner(id, generationId);
}

export function isStreaming(id: string): boolean {
  return streamingOwners.has(id);
}

export function isAnyStreaming(): boolean {
  return streamingOwners.size > 0;
}

/**
 * Acquire the process-local lease that makes LM Studio model load/unload and
 * generation admission mutually exclusive. Both this function and
 * `markStreaming` perform their check-and-set synchronously, so no asynchronous
 * gap exists between observing the other side and publishing ownership.
 */
export function markModelOperation(
  kind: ModelOperationOwner['kind'],
  modelId: string,
  operationId = uid(),
): ModelOperationOwner {
  markGenerationBlockingOperation(
    kind === 'load' ? 'model_load' : 'model_unload',
    `${kind} ${modelId}`,
    operationId,
  );
  return { operationId, kind, modelId };
}

export function markGenerationBlockingOperation(
  kind: GenerationBlockingOperationOwner['kind'],
  label: string,
  operationId = uid(),
  conversationId?: string,
  profileId?: string,
): GenerationBlockingOperationOwner {
  if (conversationCorpusMutationOwner) {
    throw new Error(`${conversationCorpusMutationOwner.label} is already active.`);
  }

  const operations = [...generationBlockingOperationOwners.values()];
  const applicationExclusive = operations.find((operation) => (
    operation.conversationId === undefined
  ));
  if (conversationId === undefined) {
    if (isAnyStreaming()) throw new Error(ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE);
    const existing = operations[0];
    if (existing) throw new Error(`${existing.label} is already active.`);
  } else {
    if (streamingOwners.has(conversationId)) {
      throw new Error(ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE);
    }
    if (applicationExclusive) {
      throw new Error(`${applicationExclusive.label} is already active.`);
    }
    const targetOwner = operations.find((operation) => (
      operation.conversationId === conversationId
    ));
    if (targetOwner) throw new Error(`${targetOwner.label} is already active.`);

    if (kind === 'chat_generation_admission') {
      const chatAdmissions = operations.filter((operation) => (
        operation.kind === 'chat_generation_admission'
      )).length;
      if (streamingOwners.size + chatAdmissions >= generationCapacity()) {
        throw new Error(`All ${generationCapacity()} generation slots are in use.`);
      }
      if (profileId) {
        const profileOwners = [...streamingOwners.values()].filter((owner) => (
          owner.profileId === profileId
        )).length;
        const profileAdmissions = operations.filter((operation) => (
          operation.kind === 'chat_generation_admission' && operation.profileId === profileId
        )).length;
        const limit = profileGenerationLimit(profileId);
        if (profileOwners + profileAdmissions >= limit) {
          throw new Error(`This server profile is limited to ${limit} concurrent generation${limit === 1 ? '' : 's'}.`);
        }
      }
    }
  }

  const owner = {
    operationId,
    kind,
    label,
    conversationId,
    ...(profileId ? { profileId } : {}),
    ...(kind === 'chat_generation_admission'
      ? { admissionState: 'provisional' as const }
      : {}),
  };
  generationBlockingOperationOwners.set(operationId, owner);
  useConversations.setState((state) => ({ ...state }));
  return { ...owner };
}

function collectBranchAttachmentIds(
  messages: readonly Message[],
  targetIndex: number,
  retainedAttachments: Message['attachments'],
): string[] {
  const retainedIds = new Set<string>();
  for (const message of messages.slice(0, targetIndex)) {
    for (const attachment of message.attachments ?? []) retainedIds.add(attachment.id);
  }
  for (const attachment of retainedAttachments ?? []) retainedIds.add(attachment.id);

  const removedIds = new Set<string>();
  for (const message of messages.slice(targetIndex)) {
    for (const attachment of message.attachments ?? []) {
      if (!retainedIds.has(attachment.id)) removedIds.add(attachment.id);
    }
  }
  return [...removedIds];
}

/** Whether this target can reserve generation capacity synchronously. */
export function isGenerationAdmissionBlocked(conversationId?: string | null): boolean {
  return generationAdmissionBlockReason(conversationId) !== null;
}

/** User-facing reason a target cannot reserve generation capacity right now. */
export function generationAdmissionBlockReason(
  conversationId?: string | null,
): string | null {
  if (!conversationId || conversationCorpusMutationOwner) {
    return ACTIVE_GENERATION_BLOCKING_OPERATION_MESSAGE;
  }
  if (streamingOwners.has(conversationId)) {
    return ACTIVE_GENERATION_BLOCKING_OPERATION_MESSAGE;
  }
  const operations = [...generationBlockingOperationOwners.values()];
  if (operations.some((operation) => (
    operation.conversationId === undefined
    || operation.conversationId === conversationId
  ))) return ACTIVE_GENERATION_BLOCKING_OPERATION_MESSAGE;
  const chatAdmissions = operations.filter((operation) => (
    operation.kind === 'chat_generation_admission'
  )).length;
  if (streamingOwners.size + chatAdmissions >= generationCapacity()) {
    return `All ${generationCapacity()} generation slots are in use.`;
  }
  const profileId = useConversations.getState().byId[conversationId]?.serverId;
  if (profileId) {
    const profileOwners = [...streamingOwners.values()].filter((owner) => owner.profileId === profileId).length;
    const profileAdmissions = operations.filter((operation) => (
      operation.kind === 'chat_generation_admission' && operation.profileId === profileId
    )).length;
    const limit = profileGenerationLimit(profileId);
    if (profileOwners + profileAdmissions >= limit) {
      return `This server profile is limited to ${limit} concurrent generation${limit === 1 ? '' : 's'}.`;
    }
  }
  return null;
}

/**
 * Commit the exact provisional admission immediately before a durable Send,
 * Retry, or Edit boundary. Settings may lower either limit while asynchronous
 * preflight is unresolved, so this final synchronous check is the last point
 * where refusal can still leave the transcript byte-for-byte unchanged.
 *
 * Already committed admissions are accepted work and cannot be displaced by
 * a later settings change. Provisional admissions retain acquisition order so
 * a later preflight cannot overtake an earlier one when capacity is reduced.
 */
export function commitChatGenerationAdmission(
  operationId: string,
  conversationId: string,
): GenerationBlockingOperationOwner {
  const operations = [...generationBlockingOperationOwners.values()];
  const operationIndex = operations.findIndex((owner) => owner.operationId === operationId);
  const operation = operationIndex >= 0 ? operations[operationIndex] : undefined;
  if (
    !operation
    || operation.kind !== 'chat_generation_admission'
    || operation.conversationId !== conversationId
  ) {
    throw new Error('The chat generation admission lease belongs to another operation.');
  }
  if (operation.admissionState === 'committed') return { ...operation };

  const otherCommitted = operations.filter((owner) => (
    owner.operationId !== operationId
    && owner.kind === 'chat_generation_admission'
    && owner.admissionState === 'committed'
  ));
  const precedingProvisional = operations.slice(0, operationIndex).filter((owner) => (
    owner.kind === 'chat_generation_admission'
    && owner.admissionState !== 'committed'
  ));
  const reject = (message: string): never => {
    generationBlockingOperationOwners.delete(operationId);
    useConversations.setState((state) => ({ ...state }));
    throw new Error(message);
  };

  if (
    streamingOwners.size
    + otherCommitted.length
    + precedingProvisional.length
    >= generationCapacity()
  ) {
    reject(`All ${generationCapacity()} generation slots are in use.`);
  }
  if (operation.profileId) {
    const profileOwners = [...streamingOwners.values()].filter((owner) => (
      owner.profileId === operation.profileId
    )).length;
    const profileCommitted = otherCommitted.filter((owner) => (
      owner.profileId === operation.profileId
    )).length;
    const profilePreceding = precedingProvisional.filter((owner) => (
      owner.profileId === operation.profileId
    )).length;
    const limit = profileGenerationLimit(operation.profileId);
    if (profileOwners + profileCommitted + profilePreceding >= limit) {
      reject(`This server profile is limited to ${limit} concurrent generation${limit === 1 ? '' : 's'}.`);
    }
  }

  const committed: GenerationBlockingOperationOwner = {
    ...operation,
    admissionState: 'committed',
  };
  generationBlockingOperationOwners.set(operationId, committed);
  useConversations.setState((state) => ({ ...state }));
  return { ...committed };
}

/**
 * Atomically exchange a chat-admission lease for its stream owner. All
 * validation happens before either owner changes, so a wrong caller cannot
 * release somebody else's lease or leave an unlocked handoff gap.
 */
export function handoffGenerationBlockingOperationToStreaming(
  operationId: string,
  conversationId: string,
  assistantMessageId: string,
  generationId = uid(),
): StreamOwner {
  const operation = generationBlockingOperationOwners.get(operationId);
  if (
    !operation
    || operation.kind !== 'chat_generation_admission'
    || operation.conversationId !== conversationId
  ) {
    throw new Error('The chat generation admission lease belongs to another operation.');
  }
  if (operation.admissionState !== 'committed') {
    throw new Error('The chat generation admission lease has not reached its commit boundary.');
  }
  if (streamingOwners.has(conversationId)) {
    throw new Error(`Conversation ${conversationId} already has an active stream owner.`);
  }
  generationBlockingOperationOwners.delete(operationId);
  // No user code or await can observe the cleared lease before markStreaming
  // installs the stream owner in this same JavaScript call stack.
  return markStreaming(conversationId, assistantMessageId, generationId, operation.profileId);
}

export function getModelOperationOwner(): ModelOperationOwner | undefined {
  const owner = [...generationBlockingOperationOwners.values()].find((operation) => (
    operation.kind === 'model_load' || operation.kind === 'model_unload'
  ));
  if (!owner || (owner.kind !== 'model_load' && owner.kind !== 'model_unload')) return undefined;
  return {
    operationId: owner.operationId,
    kind: owner.kind === 'model_load' ? 'load' : 'unload',
    modelId: owner.label.replace(/^(?:load|unload) /, ''),
  };
}

export function isModelOperationActive(): boolean {
  return getModelOperationOwner() !== undefined;
}

export function unmarkModelOperation(operationId: string): boolean {
  return unmarkGenerationBlockingOperation(operationId);
}

export function isGenerationBlockingOperationActive(): boolean {
  return generationBlockingOperationOwners.size > 0
    || conversationCorpusMutationOwner !== null;
}

export function isGenerationBlockingOperationOwner(
  operationId: string,
  expectedKind?: GenerationBlockingOperationOwner['kind'],
): boolean {
  const owner = generationBlockingOperationOwners.get(operationId);
  return owner?.operationId === operationId
    && (expectedKind === undefined || owner.kind === expectedKind);
}

export function unmarkGenerationBlockingOperation(operationId: string): boolean {
  if (!generationBlockingOperationOwners.delete(operationId)) return false;
  useConversations.setState((state) => ({ ...state }));
  return true;
}

/**
 * Acquire the application-wide conversation corpus lease used by whole-set
 * wipes and imports. Existing action guards observe it through
 * `isGenerationBlockingOperationActive`, so no create/delete/config mutation
 * can start while a delayed global database operation is still in flight.
 */
/** Whether a whole-corpus mutation (wipe, restore) currently owns the store. */
export function isConversationCorpusMutationActive(): boolean {
  return conversationCorpusMutationOwner !== null;
}

export function markConversationCorpusMutation(
  label: string,
  operationId = uid(),
): ConversationCorpusMutationOwner {
  if (isAnyStreaming()) throw new Error(ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE);
  const generationOperation = generationBlockingOperationOwners.values().next().value;
  if (generationOperation) {
    throw new Error(`${generationOperation.label} is already active.`);
  }
  if (conversationCorpusMutationOwner) {
    throw new Error(`${conversationCorpusMutationOwner.label} is already active.`);
  }

  // Start (or join) metadata hydration before publishing the corpus lease.
  // A whole-corpus operation must merge/wipe the durable corpus that existed
  // at admission, not an empty startup placeholder. Hydration that begins
  // later sees the lease and waits for its release instead.
  const ready = hydrationInFlight
    ?? (hydrated ? Promise.resolve() : useConversations.getState().hydrate());
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  conversationCorpusMutationOwner = { operationId, label, ready, released, release };
  useConversations.setState((state) => ({ ...state }));
  return { operationId, label, ready };
}

export function unmarkConversationCorpusMutation(operationId: string): boolean {
  const owner = conversationCorpusMutationOwner;
  if (owner?.operationId !== operationId) return false;
  conversationCorpusMutationOwner = null;
  owner.release();
  useConversations.setState((state) => ({ ...state }));
  return true;
}

/**
 * Return the in-flight assistant turn that a periodic checkpoint must save.
 * Tool results follow their assistant message, so saving only `messages.at(-1)`
 * skips the entire turn whenever the latest message has role `tool`.
 */
export function currentStreamingTurnMessages(
  messages: Message[],
  assistantMessageId?: string,
): Message[] {
  let assistantIndex = assistantMessageId
    ? messages.findIndex((message) => message.id === assistantMessageId && message.role === 'assistant')
    : messages.length - 1;
  if (!assistantMessageId) {
    while (assistantIndex >= 0 && messages[assistantIndex].role !== 'assistant') {
      assistantIndex--;
    }
  }
  return assistantIndex >= 0 ? messages.slice(assistantIndex) : [];
}

/* ------------------------------------------------------------------ */
/*  Auto-archive sweep                                                 */
/* ------------------------------------------------------------------ */

export function autoArchiveSweep(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = Date.now() - days * 86_400_000;
  const { byId } = useConversations.getState();
  const toArchive: string[] = [];
  for (const c of Object.values(byId)) {
    if (c.archived) continue;
    if (c.updatedAt < cutoff) toArchive.push(c.id);
  }
  if (toArchive.length === 0) return 0;
  for (const id of toArchive) {
    useConversations.getState().archive(id);
  }
  return toArchive.length;
}
