/**
 * Dexie.js IndexedDB database for conversations.
 *
 * Two-tier storage:
 *   1. `conversationsMeta` — lightweight (title, model, timestamps).
 *      Loaded synchronously-ish on app start for instant sidebar render.
 *   2. `messages` — full message content, loaded on-demand when the
 *      user clicks a conversation.
 *
 * Tables use `&` prefix = primary key, `*` = multiEntry index.
 *
 * Why Dexie over raw IndexedDB:
 *   - Promise-based API with clean error handling
 *   - Table hooks for audit/backup without boilerplate
 *   - Bulk operations (bulkPut, bulkDelete) are one-liners
 *   - Works in WebView2 (Tauri's Windows runtime) without native deps
 */

import Dexie, { type Table } from 'dexie';
import type {
  Conversation,
  GenerationParams,
  Message,
  WhiteboardOwner,
} from '../types';
import { recordStorageOutcome as recordStorage } from './storage-outcomes.ts';
import { strFromU8, strToU8, compressSync, decompressSync } from 'fflate';
import { normalizeGrantState } from '../modules/tool-engine/grant-state.ts';
import { hasVisibleReasoningText } from '../utils/reasoning-content.ts';
import { normalizeOpaqueReplayAccounting } from '../modules/llm-client/replay-accounting.ts';
import { normalizeAnthropicBlockOrder } from '../modules/llm-client/adapters/anthropic.ts';
import { normalizePersistedUsage } from '../modules/llm-client/cache-usage.ts';
import { validateGeminiGroups } from '../modules/llm-client/gemini-state.ts';

export const CONVERSATION_DB_VERSION = 3 as const;

/** A valid `sortOrder` is a small, positive, per-conversation counter. */
export function isCounterDomainSortOrder(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value < 1_000_000_000;
}

/* ------------------------------------------------------------------ */
/*  Content compression                                                */
/*                                                                     */
/*  Message content and reasoning use compression for terminal and     */
/*  ordinary writes to reduce LevelDB's memory-mapped footprint. Live  */
/*  checkpoints keep ordinary text plain to avoid compression stalls.  */
/*  A checkpoint value that starts with `Z:` remains encoded because   */
/*  that prefix marks compressed rows.                                 */
/* ------------------------------------------------------------------ */

const Z_PREFIX = 'Z:';

export function maybeCompress(text: string | undefined): string | undefined {
  if (text == null) return text;
  // Encode as UTF-8, compress, then encode the raw bytes as Latin-1
  // (each byte → one char, lossless for binary).
  const utf8 = strToU8(text);
  const compressed = compressSync(utf8);
  // A plain value that starts with the compression marker is ambiguous on
  // read. Compress that value even when compression adds bytes, so the marker
  // always describes the bytes that follow it.
  if (compressed.length >= utf8.length && !text.startsWith(Z_PREFIX)) return text;
  return Z_PREFIX + strFromU8(compressed, true);
}

function encodeCheckpointText(text: string | undefined): string | undefined {
  return text?.startsWith(Z_PREFIX) ? maybeCompress(text) : text;
}

export function maybeDecompress(text: string | undefined): string | undefined {
  if (text == null) return text;
  if (!text.startsWith(Z_PREFIX)) return text; // plain-text current row
  try {
    const bytes = strToU8(text.slice(Z_PREFIX.length), true);
    const decompressed = decompressSync(bytes);
    return strFromU8(decompressed);
  } catch {
    // Corrupted compressed data — return as-is.
    return text;
  }
}

/* ------------------------------------------------------------------ */
/*  Row types — flat columns, JSON for nested objects                 */
/* ------------------------------------------------------------------ */

export interface ConversationMetaRow {
  id: string;
  title: string;
  serverId?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  archived: 0 | 1;
  /** Number of messages in this conversation. Tracked live during
   *  chat; computed on first load when the cache is empty. */
  messageCount: number;
  /** JSON-serialized GenerationParams. */
  paramsJson: string;
  /** JSON-serialized Conversation.tools (if present). */
  toolsJson?: string;
  /** JSON-serialized ConversationSkill[] for custom skills (if present). */
  customSkillsJson?: string;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  reasoning?: string;
  refusal?: string;
  /** JSON-serialized ToolCallRecord[]. */
  toolCallsJson?: string;
  /** Compressed JSON-serialized Responses output items for stateless replay. */
  responsesOutputJson?: string;
  /** Compressed ordered native Gemini groups including response-local usage. */
  geminiInteractionsJson?: string;
  /** Compressed Anthropic signed/redacted thinking blocks for tool replay. */
  anthropicOutputJson?: string;
  /** Compressed provider block order (with text segments) for exact replay. */
  anthropicBlockOrderJson?: string;
  /** Compressed, validated response-local accounting bound to replay state. */
  opaqueReplayAccountingJson?: string;
  /** Compressed MiniMax structured reasoning state for tool replay. */
  reasoningDetailsJson?: string;
  /** Native LM Studio state handle for the next request. */
  lmstudioResponseId?: string;
  /** JSON-serialized Attachment[] (metadata only — blobs in separate IDB). */
  attachmentsJson?: string;
  /** JSON-serialized Message.usage. */
  usageJson?: string;
  /** JSON-serialized Message.prefix — bounded enum values only. */
  prefixJson?: string;
  /** JSON-serialized Message.meta. */
  metaJson?: string;
  createdAt: number;
  tool_call_id?: string;
  tool_is_error: 0 | 1;
  tool_duration_ms?: number;
  /** JSON-serialized Message.tool_permission. */
  toolPermissionJson?: string;
  tool_lines_added?: number;
  tool_lines_removed?: number;
  toolLineChangesJson?: string;
  /** Retained user-board version pinned to a user message. */
  userBoardId?: string;
  /** JSON-serialized WhiteboardTurnReferences for an assistant message. */
  whiteboardRefsJson?: string;
  /** Monotonic sequence per conversation — stable sort when createdAt
   *  timestamps collide (same ms during rapid tool-call bursts). */
  sortOrder: number;
}

/** Compressed IndexedDB representation of one immutable retained board row. */
export interface WhiteboardVersionStorageRow {
  conversationId: string;
  id: string;
  owner: WhiteboardOwner;
  content: string;
  createdAt: number;
  sequence: number;
  sourceMessageId: string | null;
  sourceToolCallId: string | null;
}

/**
 * Compressed IndexedDB representation of one owner's mutable working row.
 * Owner-specific invariants are enforced by `store/whiteboard.ts`.
 */
export interface WhiteboardWorkingStorageRow {
  conversationId: string;
  owner: WhiteboardOwner;
  content: string;
  updatedAt: number;
  id?: string | null;
  createdAt?: number | null;
  initialVersionId?: string;
  generationId?: string;
  assistantMessageId?: string;
  latestToolCallId?: string | null;
}

/**
 * Durable evidence that a generation was admitted but has not yet completed
 * cleanly. Deliberately minimal: enough to find and repair the interrupted
 * turn after a crash, and nothing else.
 *
 * It holds no prompt, no message body, no tool arguments, no credential, and
 * no conversation title. A journal row is recovery evidence, never a snapshot
 * of what the generation was doing.
 *
 * `Message.streaming` is not persisted and unanswered-tool recovery only sees
 * tool calls, so without this row an interrupted plain-text answer reloads
 * looking complete. That is the defect the journal exists to fix.
 */
export interface GenerationRunRow {
  /** Primary key. One conversation owns at most one run at a time. */
  conversationId: string;
  generationId: string;
  assistantMessageId: string;
  state: 'admitted' | 'running' | 'stopping';
  startedAt: number;
}

/* ------------------------------------------------------------------ */
/*  Database                                                           */
/* ------------------------------------------------------------------ */

class ConversationDB extends Dexie {
  conversationsMeta!: Table<ConversationMetaRow, string>;
  messages!: Table<MessageRow, string>;
  whiteboardVersions!: Table<WhiteboardVersionStorageRow, [string, string]>;
  whiteboardWorking!: Table<WhiteboardWorkingStorageRow, [string, WhiteboardOwner]>;
  generationRuns!: Table<GenerationRunRow, string>;

  constructor() {
    super('lc:conversations');

    // v1 - the initial four-table layout. LC had not been released, so there
    // is no pre-Whiteboard migration declaration. It stays declared because
    // databases created at v1 exist on developer and pre-release machines and
    // must open and upgrade without rewriting a row.
    this.version(1).stores({
      conversationsMeta: '&id, updatedAt, archived',
      messages: '&id, conversationId, createdAt, [conversationId+createdAt], [conversationId+sortOrder]',
      whiteboardVersions:
        '&[conversationId+id], conversationId, [conversationId+owner], &[conversationId+sequence], [conversationId+owner+sequence]',
      whiteboardWorking:
        '&[conversationId+owner], conversationId, owner, generationId, assistantMessageId',
    });

    // v2 - adds the generation journal. Purely additive: Dexie needs only the
    // new store declared, every existing store keeps its indexes, and no
    // upgrade callback runs over existing content.
    this.version(2).stores({
      generationRuns: '&conversationId, generationId, startedAt',
    });

    // v3 - compatibility bump for pre-release builds that briefly advertised
    // v2 before the generation journal store was present. Re-declaring the
    // additive store at a newer native version lets IndexedDB create it during
    // a normal upgrade instead of making Dexie enter its SchemaDiff repair
    // path. Databases created by the final v2 schema already have the store, so
    // this is a no-op for their content and indexes.
    this.version(3).stores({
      generationRuns: '&conversationId, generationId, startedAt',
    });
  }
}

const db = new ConversationDB();

/**
 * Run one logical storage mutation and record exactly one durable-write
 * outcome for it.
 *
 * Every durable conversation mutation is wrapped here rather than at the Dexie
 * table level, so a function that touches two tables inside one transaction
 * (`replaceMessages`, `deleteConversation`) still produces a single event for
 * the single mutation the caller asked for.
 */
async function durableWrite<T>(run: () => Promise<T>): Promise<T> {
  let value: T;
  try {
    value = await run();
  } catch (error) {
    recordStorage('durable-write', false);
    throw error;
  }
  recordStorage('durable-write', true);
  return value;
}

/** Same contract as `durableWrite`, for a read at an indexed boundary. */
async function indexedRead<T>(run: () => Promise<T>): Promise<T> {
  let value: T;
  try {
    value = await run();
  } catch (error) {
    recordStorage('indexed-read', false);
    throw error;
  }
  recordStorage('indexed-read', true);
  return value;
}

/** Tables that must move together at conversation/Whiteboard boundaries. */
export interface ConversationDataTables {
  conversationsMeta: Table<ConversationMetaRow, string>;
  messages: Table<MessageRow, string>;
  whiteboardVersions: Table<WhiteboardVersionStorageRow, [string, string]>;
  whiteboardWorking: Table<WhiteboardWorkingStorageRow, [string, WhiteboardOwner]>;
  /**
   * The generation journal. It joins this seam so an admission or terminal
   * boundary can write its journal row in the same transaction as the
   * assistant placeholder and Whiteboard admission, instead of leaving a
   * window in which one exists without the other.
   */
  generationRuns: Table<GenerationRunRow, string>;
}

const conversationDataTables: ConversationDataTables = {
  conversationsMeta: db.conversationsMeta,
  messages: db.messages,
  whiteboardVersions: db.whiteboardVersions,
  whiteboardWorking: db.whiteboardWorking,
  generationRuns: db.generationRuns,
};

/**
 * Internal cross-table transaction seam for clone, import, truncation, and
 * recovery. Callers prepare non-Dexie work before entering this callback.
 */
export function runConversationDataTransaction<T>(
  mode: 'r' | 'rw',
  run: (tables: ConversationDataTables) => Promise<T>,
): Promise<T> {
  return db.transaction(
    mode,
    db.conversationsMeta,
    db.messages,
    db.whiteboardVersions,
    db.whiteboardWorking,
    db.generationRuns,
    () => run(conversationDataTables),
  );
}

/** Record one outcome for one cross-table logical mutation. */
export async function runConversationDataMutation<T>(
  run: (tables: ConversationDataTables) => Promise<T>,
): Promise<T> {
  return durableWrite(() => runConversationDataTransaction('rw', run));
}

/** Whiteboard-only transaction seam used by the focused version service. */
export function runWhiteboardStorageTransaction<T>(
  mode: 'r' | 'rw',
  run: (tables: Pick<ConversationDataTables, 'whiteboardVersions' | 'whiteboardWorking'>) => Promise<T>,
): Promise<T> {
  return db.transaction(
    mode,
    db.whiteboardVersions,
    db.whiteboardWorking,
    () => run(conversationDataTables),
  );
}

/**
 * Record a Whiteboard write only when the transaction changed a row. Expected
 * ID-collision retries stay inside `run`, so they produce one final outcome.
 */
export async function runWhiteboardDurableMutation<T>(
  run: () => Promise<{ value: T; wrote: boolean }>,
): Promise<T> {
  let result: { value: T; wrote: boolean };
  try {
    result = await run();
  } catch (error) {
    recordStorage('durable-write', false);
    throw error;
  }
  if (result.wrote) recordStorage('durable-write', true);
  return result.value;
}

/** Indexed-read instrumentation for retained and working Whiteboard queries. */
export function runWhiteboardIndexedRead<T>(run: () => Promise<T>): Promise<T> {
  return indexedRead(run);
}

/** Open and validate the current conversation schema without reading rows. */
export async function openConversationStorage(): Promise<void> {
  try {
    await db.open();
  } catch (error) {
    recordStorage('open', false);
    throw error;
  }
  recordStorage('open', true);
}

/* ------------------------------------------------------------------ */
/*  Helpers: row ↔ domain                                             */
/* ------------------------------------------------------------------ */

export function conversationMetaToStorageRow(conv: Conversation): ConversationMetaRow {
  // Persist one normalized policy shape so a reload cannot split a visible
  // grant from the path spelling used by the executor.
  return {
    id: conv.id,
    title: conv.title,
    serverId: conv.serverId,
    model: conv.model,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    archived: conv.archived ? 1 : 0,
    messageCount: conv.messageCount ?? conv.messages.length,
    paramsJson: JSON.stringify(conv.params),
    toolsJson: conv.tools ? JSON.stringify(normalizeGrantState(conv.tools)) : undefined,
    customSkillsJson: conv.custom_skills?.length ? JSON.stringify(conv.custom_skills) : undefined,
  };
}

export function conversationMetaFromStorageRow(row: ConversationMetaRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    serverId: row.serverId,
    model: row.model,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archived: row.archived === 1 ? true : undefined,
    messageCount: row.messageCount ?? 0,
    params: JSON.parse(row.paramsJson) as GenerationParams,
    // Normalize on read so the UI and executor share one grant shape.
    tools: row.toolsJson
      ? normalizeGrantState(JSON.parse(row.toolsJson) as NonNullable<Conversation['tools']>)
      : undefined,
    custom_skills: row.customSkillsJson ? JSON.parse(row.customSkillsJson) : undefined,
    messages: [], // populated lazily
  };
}

export interface MessageStorageOptions {
  /** Keep ordinary checkpoint text plain. Reserved-prefix text remains encoded. */
  compress?: boolean;
}

export function messageToStorageRow(
  msg: Message,
  conversationId: string,
  options: MessageStorageOptions = {},
): MessageRow {
  const encode = options.compress === false
    ? encodeCheckpointText
    : maybeCompress;
  const opaqueReplayAccounting = normalizeOpaqueReplayAccounting(
    msg.opaque_replay_accounting,
    {
      responsesOutputItems: msg.responses_output_items,
      responsesBaseUrl: msg.meta?.baseUrl,
      anthropicOutputBlocks: msg.anthropic_output_blocks,
      anthropicBaseUrl: msg.meta?.baseUrl,
    },
  );
  const usage = normalizePersistedUsage(msg.usage);
  return {
    id: msg.id,
    conversationId,
    role: msg.role,
    // Domain messages always carry string content. Keep that invariant at the
    // storage boundary even though the shared optional-text encoder also
    // handles reasoning and refusal fields.
    content: encode(msg.content) ?? '',
    reasoning: encode(msg.reasoning),
    refusal: encode(msg.refusal),
    toolCallsJson: msg.tool_calls?.length ? JSON.stringify(msg.tool_calls) : undefined,
    responsesOutputJson: msg.responses_output_items?.length
      ? encode(JSON.stringify(msg.responses_output_items))
      : undefined,
    geminiInteractionsJson: msg.gemini_interactions?.length
      ? encode(JSON.stringify(validateGeminiGroups(msg.gemini_interactions))) : undefined,
    anthropicOutputJson: msg.anthropic_output_blocks?.length
      ? encode(JSON.stringify(msg.anthropic_output_blocks))
      : undefined,
    anthropicBlockOrderJson: msg.anthropic_block_order?.length
      ? encode(JSON.stringify(msg.anthropic_block_order))
      : undefined,
    opaqueReplayAccountingJson: opaqueReplayAccounting?.length
      ? encode(JSON.stringify(opaqueReplayAccounting))
      : undefined,
    reasoningDetailsJson: msg.reasoning_details?.length
      ? encode(JSON.stringify(msg.reasoning_details))
      : undefined,
    lmstudioResponseId: msg.lmstudio_response_id,
    attachmentsJson: msg.attachments?.length
      ? JSON.stringify(msg.attachments.map(({ dataUrl: _transient, ...attachment }) => attachment))
      : undefined,
    usageJson: usage ? JSON.stringify(usage) : undefined,
    prefixJson: msg.prefix ? JSON.stringify(msg.prefix) : undefined,
    metaJson: msg.meta ? JSON.stringify(msg.meta) : undefined,
    createdAt: msg.createdAt,
    tool_call_id: msg.tool_call_id,
    tool_is_error: msg.tool_is_error ? 1 : 0,
    tool_duration_ms: msg.tool_duration_ms,
    toolPermissionJson: msg.tool_permission
      ? JSON.stringify(msg.tool_permission)
      : undefined,
    tool_lines_added: msg.tool_lines_added,
    tool_lines_removed: msg.tool_lines_removed,
    toolLineChangesJson: msg.tool_line_changes?.length
      ? JSON.stringify(msg.tool_line_changes)
      : undefined,
    userBoardId: msg.user_board,
    whiteboardRefsJson: msg.whiteboard_refs
      ? JSON.stringify(msg.whiteboard_refs)
      : undefined,
    sortOrder: msg.sortOrder ?? msg.createdAt,
  };
}

export function messageFromStorageRow(row: MessageRow): Message {
  const msg: Message = {
    id: row.id,
    role: row.role as Message['role'],
    content: maybeDecompress(row.content) ?? '',
    createdAt: row.createdAt,
  };
  if (row.sortOrder !== undefined) msg.sortOrder = row.sortOrder;
  if (row.reasoning) {
    msg.reasoning = maybeDecompress(row.reasoning);
    msg.reasoningHasVisibleContent = hasVisibleReasoningText(msg.reasoning);
  }
  if (row.refusal) msg.refusal = maybeDecompress(row.refusal);
  if (row.toolCallsJson) msg.tool_calls = JSON.parse(row.toolCallsJson);
  if (row.responsesOutputJson) {
    msg.responses_output_items = JSON.parse(maybeDecompress(row.responsesOutputJson) ?? '[]');
  }
  if (row.geminiInteractionsJson) {
    msg.gemini_interactions = validateGeminiGroups(JSON.parse(maybeDecompress(row.geminiInteractionsJson) ?? '[]'));
  }
  if (row.anthropicOutputJson) {
    msg.anthropic_output_blocks = JSON.parse(maybeDecompress(row.anthropicOutputJson) ?? '[]');
  }
  if (row.anthropicBlockOrderJson) {
    const order = normalizeAnthropicBlockOrder(
      JSON.parse(maybeDecompress(row.anthropicBlockOrderJson) ?? '[]'),
    );
    if (order) msg.anthropic_block_order = order;
  }
  if (row.metaJson) msg.meta = JSON.parse(row.metaJson);
  if (row.opaqueReplayAccountingJson) {
    const accounting = normalizeOpaqueReplayAccounting(
      JSON.parse(maybeDecompress(row.opaqueReplayAccountingJson) ?? '[]'),
      {
        responsesOutputItems: msg.responses_output_items,
        responsesBaseUrl: msg.meta?.baseUrl,
        anthropicOutputBlocks: msg.anthropic_output_blocks,
        anthropicBaseUrl: msg.meta?.baseUrl,
      },
    );
    if (accounting) msg.opaque_replay_accounting = accounting;
  }
  if (row.reasoningDetailsJson) {
    msg.reasoning_details = JSON.parse(maybeDecompress(row.reasoningDetailsJson) ?? '[]');
  }
  if (row.lmstudioResponseId) msg.lmstudio_response_id = row.lmstudioResponseId;
  if (row.attachmentsJson) msg.attachments = JSON.parse(row.attachmentsJson);
  if (row.usageJson) {
    const usage = normalizePersistedUsage(JSON.parse(row.usageJson));
    if (usage) msg.usage = usage;
  }
  if (row.prefixJson) msg.prefix = JSON.parse(row.prefixJson);
  if (row.tool_call_id) msg.tool_call_id = row.tool_call_id;
  if (row.tool_is_error) msg.tool_is_error = true;
  if (row.tool_duration_ms !== undefined) msg.tool_duration_ms = row.tool_duration_ms;
  if (row.toolPermissionJson) msg.tool_permission = JSON.parse(row.toolPermissionJson);
  if (row.tool_lines_added !== undefined) msg.tool_lines_added = row.tool_lines_added;
  if (row.tool_lines_removed !== undefined) msg.tool_lines_removed = row.tool_lines_removed;
  if (row.toolLineChangesJson) msg.tool_line_changes = JSON.parse(row.toolLineChangesJson);
  if (row.userBoardId) msg.user_board = row.userBoardId;
  if (row.whiteboardRefsJson) msg.whiteboard_refs = JSON.parse(row.whiteboardRefsJson);
  return msg;
}

/**
 * Return the canonical message shape that survives a Dexie round trip without
 * touching IndexedDB. Archive/export uses this to exclude transient lifecycle
 * fields (notably `streaming`) by construction instead of maintaining a second
 * ad-hoc denylist.
 */
export function persistedMessageSnapshot(message: Message): Message {
  const restored = messageFromStorageRow(messageToStorageRow(message, '__snapshot__'));
  const { reasoningHasVisibleContent: _transient, ...snapshot } = restored;
  return snapshot;
}

/**
 * Load ALL conversation metadata. Called once on app start.
 *
 * This is the metadata-hydrate boundary: `useConversations.hydrate()` has
 * exactly one durable source, so recording here covers hydration without
 * double-counting it in the store.
 */
export async function loadAllMeta(): Promise<Conversation[]> {
  let rows: ConversationMetaRow[];
  try {
    rows = await db.conversationsMeta.orderBy('updatedAt').reverse().toArray();
  } catch (error) {
    recordStorage('hydrate', false);
    throw error;
  }
  try {
    const metas = rows.map(conversationMetaFromStorageRow);
    recordStorage('hydrate', true);
    return metas;
  } catch (error) {
    // A malformed persisted row fails during decode, not during the read.
    recordStorage('hydrate', false);
    throw error;
  }
}

/** Every attachment ID still owned by a durable message row. */
export async function loadReferencedAttachmentIds(): Promise<Set<string>> {
  return indexedRead(async () => {
    const referenced = new Set<string>();
    await db.messages.each((row) => {
      if (!row.attachmentsJson) return;
      const attachments = JSON.parse(row.attachmentsJson) as Array<{ id?: unknown }>;
      for (const attachment of attachments) {
        if (typeof attachment.id === 'string') referenced.add(attachment.id);
      }
    });
    return referenced;
  });
}

/** Upsert a single conversation's metadata. Fast — used on every mutation. */
export async function saveMeta(conv: Conversation): Promise<void> {
  await durableWrite(() => db.conversationsMeta.put(conversationMetaToStorageRow(conv)));
}

/** Delete a conversation's metadata, messages, and every Whiteboard row. */
export async function deleteConversation(id: string): Promise<void> {
  await durableWrite(() => db.transaction(
    'rw',
    db.conversationsMeta,
    db.messages,
    db.whiteboardVersions,
    db.whiteboardWorking,
    db.generationRuns,
    async () => {
      await db.conversationsMeta.delete(id);
      await db.messages.where('conversationId').equals(id).delete();
      await db.whiteboardVersions.where('conversationId').equals(id).delete();
      await db.whiteboardWorking.where('conversationId').equals(id).delete();
      await db.generationRuns.delete(id);
    },
  ));
}

/** Delete ALL conversations and all retained and working Whiteboard rows. */
export async function deleteAllConversations(): Promise<void> {
  await durableWrite(() => db.transaction(
    'rw',
    db.conversationsMeta,
    db.messages,
    db.whiteboardVersions,
    db.whiteboardWorking,
    db.generationRuns,
    async () => {
      await db.conversationsMeta.clear();
      await db.messages.clear();
      await db.whiteboardVersions.clear();
      await db.whiteboardWorking.clear();
      await db.generationRuns.clear();
    },
  ));
}

/* ------------------------------------------------------------------ */
/*  Generation journal                                                 */
/* ------------------------------------------------------------------ */

/**
 * Record that a generation owns this conversation.
 *
 * One row per conversation, so a replacement generation overwrites its
 * predecessor's row rather than accumulating. Callers that need this to be
 * atomic with the assistant placeholder use `runConversationDataMutation` and
 * write `tables.generationRuns` directly; this helper is for the standalone
 * case.
 */
export async function recordGenerationRun(row: GenerationRunRow): Promise<void> {
  await durableWrite(() => db.generationRuns.put(row));
}

/**
 * Delete a journal row only if it still belongs to the named generation.
 *
 * The compare-and-delete matters: a finalizer that lost a race to a
 * replacement generation must not delete the newer run's evidence. Returns
 * whether a row was actually removed.
 */
export async function clearGenerationRun(
  conversationId: string,
  generationId: string,
): Promise<boolean> {
  return durableWrite(() => db.transaction('rw', db.generationRuns, async () => {
    const existing = await db.generationRuns.get(conversationId);
    if (!existing || existing.generationId !== generationId) return false;
    await db.generationRuns.delete(conversationId);
    return true;
  }));
}

/**
 * Every journaled run found at startup.
 *
 * The live runtime admits at most three at a time, but an interrupted
 * recovery can leave older rows behind, so this deliberately reads the whole
 * (small) table rather than assuming a bound.
 */
export async function loadGenerationRuns(): Promise<GenerationRunRow[]> {
  return indexedRead(() => db.generationRuns.toArray());
}

/** Read one conversation's journal row, if it has one. */
export async function loadGenerationRun(
  conversationId: string,
): Promise<GenerationRunRow | undefined> {
  return indexedRead(() => db.generationRuns.get(conversationId));
}

/**
 * Finish reasons a turn can carry while it is still running.
 *
 * `tool_calls` / `tool_use` are written at the end of every intermediate tool
 * round, before the model re-streams, and `pause_turn` is an explicit
 * continuation signal. A row carrying one of these did not finish, so finding
 * one during recovery is evidence of an interruption rather than of
 * completion. `interrupted` is recovery's own marker and stays non-terminal so
 * a repeated pass is idempotent and keeps the journal row until the transcript
 * repair has actually run.
 *
 * Anything else — including provider reasons LC does not recognize — is treated
 * as terminal. An answer that ended for an unknown reason still ended.
 */
const NON_TERMINAL_FINISH_REASONS: ReadonlySet<string> = new Set([
  'tool_calls',
  'tool_use',
  'pause_turn',
  'interrupted',
]);

/** Whether a stored finish reason means the turn actually completed. */
export function isTerminalFinishReason(reason: unknown): boolean {
  return typeof reason === 'string'
    && reason.length > 0
    && !NON_TERMINAL_FINISH_REASONS.has(reason);
}

export type InterruptedRunOutcome =
  /** The assistant row was marked interrupted. */
  | 'marked'
  /** It already carried a finish reason, so the answer really did complete. */
  | 'already-final'
  /** Conversation or assistant row is gone; the journal row is an orphan. */
  | 'orphaned'
  /** A different generation owns the row now; leave it to that generation. */
  | 'superseded';

/**
 * Mark a journaled generation's assistant row as interrupted.
 *
 * This is a targeted read-modify-write against the one row the journal names,
 * not a transcript load: startup recovery must be able to repair a background
 * conversation without pulling its whole history into memory.
 *
 * A row that already carries a finish reason is left alone and reported as
 * `already-final`. That is the crash-after-finalize case — the answer really
 * did complete and only the journal deletion was lost, so relabelling it would
 * invent a defect that never happened.
 *
 * Pure Dexie inside the transaction, with no other asynchronous work.
 */
export async function markGenerationRunInterrupted(
  conversationId: string,
  generationId: string,
  finishReason = 'interrupted',
): Promise<InterruptedRunOutcome> {
  return durableWrite(() => db.transaction(
    'rw',
    db.generationRuns,
    db.messages,
    db.conversationsMeta,
    async (): Promise<InterruptedRunOutcome> => {
      const run = await db.generationRuns.get(conversationId);
      if (!run) return 'orphaned';
      if (run.generationId !== generationId) return 'superseded';

      const conversation = await db.conversationsMeta.get(conversationId);
      if (!conversation) return 'orphaned';

      const row = await db.messages.get(run.assistantMessageId);
      if (!row || row.conversationId !== conversationId || row.role !== 'assistant') {
        return 'orphaned';
      }

      const meta = row.metaJson
        ? (JSON.parse(row.metaJson) as Record<string, unknown>)
        : {};
      // Only a genuinely terminal reason means the answer completed. A row
      // still carrying `tool_calls` was interrupted between rounds, and one
      // already carrying `interrupted` is waiting for its lazy transcript
      // repair — treating either as final would retire the journal row while
      // the turn is still unrepaired.
      if (isTerminalFinishReason(meta.finish_reason)) return 'already-final';
      if (meta.finish_reason === finishReason) return 'marked';

      await db.messages.put({
        ...row,
        metaJson: JSON.stringify({ ...meta, finish_reason: finishReason }),
      });
      return 'marked';
    },
  ));
}

/* ------------------------------------------------------------------ */
/*  CRUD: Messages                                                     */
/* ------------------------------------------------------------------ */

/**
 * Load all messages for a conversation. Called on first click.
 *
 * This is the lazy indexed-read boundary. The `count()` helpers below are
 * deliberately not instrumented: the support-report collector calls them, and
 * report collection must never manufacture normal-operation storage events.
 */
export async function loadMessages(conversationId: string): Promise<Message[]> {
  return indexedRead(async () => {
    const rows = await db.messages
      .where('conversationId')
      .equals(conversationId)
      .toArray();
    if (rows.every((row) => isCounterDomainSortOrder(row.sortOrder))) {
      rows.sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
    } else {
      // Schema-v3 legacy rows can contain timestamp-domain values. Mixing
      // those values with new counters places later messages before history.
      // Read the mixed transcript chronologically until lazy load re-sequences
      // and persists one counter domain.
      rows.sort((left, right) => (
        left.createdAt - right.createdAt
        || left.sortOrder - right.sortOrder
        || left.id.localeCompare(right.id)
      ));
    }
    return rows.map(messageFromStorageRow);
  });
}

/** Append a single message. */
export async function saveMessage(msg: Message, conversationId: string): Promise<void> {
  await durableWrite(() => db.messages.put(messageToStorageRow(msg, conversationId)));
}

/** Bulk-insert messages with the requested compression policy. */
export async function saveMessages(
  msgs: Message[],
  conversationId: string,
  options: MessageStorageOptions = {},
): Promise<void> {
  const rows = msgs.map((m) => messageToStorageRow(m, conversationId, options));
  await durableWrite(() => db.messages.bulkPut(rows));
}

/** Replace ALL messages for a conversation (used by replaceFromMessage). */
export async function replaceMessages(conversationId: string, msgs: Message[]): Promise<void> {
  await durableWrite(() => db.transaction('rw', db.messages, async () => {
    await db.messages.where('conversationId').equals(conversationId).delete();
    if (msgs.length > 0) {
      await db.messages.bulkPut(msgs.map((m) => messageToStorageRow(m, conversationId)));
    }
  }));
}

/** Update a single message by id. */
export async function updateMessage(
  messageId: string,
  patch: Partial<Message>,
): Promise<void> {
  // Read-modify-write in one transaction. Two patches to the same row each
  // start from the stored row; outside a transaction the second put would
  // restore the columns the first one changed to their pre-patch values.
  // A miss is not a mutation, so it records nothing: an event here would
  // report a durable write that never happened.
  let wrote: boolean;
  try {
    wrote = await db.transaction('rw', db.messages, async () => {
      const existing = await db.messages.get(messageId);
      if (!existing) return false;
      const updated = { ...existing };
      const hasPatch = (key: keyof Message): boolean => Object.prototype.hasOwnProperty.call(patch, key);
      if (patch.content !== undefined) updated.content = maybeCompress(patch.content) ?? '';
      if (patch.reasoning !== undefined) updated.reasoning = maybeCompress(patch.reasoning);
      if (patch.refusal !== undefined) updated.refusal = maybeCompress(patch.refusal);
      if (patch.tool_calls !== undefined) updated.toolCallsJson = JSON.stringify(patch.tool_calls);
      if (hasPatch('responses_output_items')) {
        updated.responsesOutputJson = patch.responses_output_items?.length
          ? maybeCompress(JSON.stringify(patch.responses_output_items))
          : undefined;
      }
      if (hasPatch('gemini_interactions')) {
        updated.geminiInteractionsJson = patch.gemini_interactions?.length
          ? maybeCompress(JSON.stringify(validateGeminiGroups(patch.gemini_interactions))) : undefined;
      }
      if (hasPatch('anthropic_output_blocks')) {
        updated.anthropicOutputJson = patch.anthropic_output_blocks?.length
          ? maybeCompress(JSON.stringify(patch.anthropic_output_blocks))
          : undefined;
        // A block replacement without a paired order patch leaves a stale
        // layout behind: clear it rather than replaying new blocks in an old
        // order. The serializer falls back to the legacy layout.
        if (!hasPatch('anthropic_block_order')) updated.anthropicBlockOrderJson = undefined;
      }
      if (hasPatch('anthropic_block_order')) {
        const order = normalizeAnthropicBlockOrder(patch.anthropic_block_order);
        updated.anthropicBlockOrderJson = order?.length
          ? maybeCompress(JSON.stringify(order))
          : undefined;
      }
      if (hasPatch('opaque_replay_accounting')
        || hasPatch('responses_output_items')
        || hasPatch('anthropic_output_blocks')) {
        const responsesOutputItems = hasPatch('responses_output_items')
          ? patch.responses_output_items
          : updated.responsesOutputJson
            ? JSON.parse(maybeDecompress(updated.responsesOutputJson) ?? '[]')
            : undefined;
        const anthropicOutputBlocks = hasPatch('anthropic_output_blocks')
          ? patch.anthropic_output_blocks
          : updated.anthropicOutputJson
            ? JSON.parse(maybeDecompress(updated.anthropicOutputJson) ?? '[]')
            : undefined;
        let rawAccounting: unknown = hasPatch('opaque_replay_accounting')
          ? patch.opaque_replay_accounting
          : updated.opaqueReplayAccountingJson
            ? JSON.parse(maybeDecompress(updated.opaqueReplayAccountingJson) ?? '[]')
            : undefined;
        // A replay array changed without a paired accounting patch. Clear that
        // protocol's groups rather than retaining structurally stale metadata.
        if (!hasPatch('opaque_replay_accounting') && Array.isArray(rawAccounting)) {
          rawAccounting = rawAccounting.filter((group) => {
            if (!group || typeof group !== 'object') return false;
            const protocol = (group as { protocol?: unknown }).protocol;
            if (hasPatch('responses_output_items') && protocol === 'openai-responses') return false;
            if (hasPatch('anthropic_output_blocks') && protocol === 'anthropic-messages') return false;
            return true;
          });
        }
        const accounting = normalizeOpaqueReplayAccounting(rawAccounting, {
          responsesOutputItems,
          responsesBaseUrl: patch.meta?.baseUrl ?? (updated.metaJson
            ? (JSON.parse(updated.metaJson) as Message['meta'])?.baseUrl
            : undefined),
          anthropicOutputBlocks,
          anthropicBaseUrl: patch.meta?.baseUrl ?? (updated.metaJson
            ? (JSON.parse(updated.metaJson) as Message['meta'])?.baseUrl
            : undefined),
        });
        updated.opaqueReplayAccountingJson = accounting?.length
          ? maybeCompress(JSON.stringify(accounting))
          : undefined;
      }
      if (patch.reasoning_details !== undefined) {
        updated.reasoningDetailsJson = maybeCompress(JSON.stringify(patch.reasoning_details));
      }
      if (patch.lmstudio_response_id !== undefined) {
        updated.lmstudioResponseId = patch.lmstudio_response_id;
      }
      if (patch.attachments !== undefined) {
        // `dataUrl` is a transient render field — never persisted. Strip it
        // exactly like `messageToStorageRow` does, so the patch path cannot put
        // megabyte-scale base64 strings back into stored rows.
        updated.attachmentsJson = JSON.stringify(
          patch.attachments.map(({ dataUrl: _transient, ...attachment }) => attachment),
        );
      }
      if (patch.usage !== undefined) {
        const usage = normalizePersistedUsage(patch.usage);
        updated.usageJson = usage ? JSON.stringify(usage) : undefined;
      }
      if (patch.prefix !== undefined) updated.prefixJson = JSON.stringify(patch.prefix);
      if (patch.meta !== undefined) updated.metaJson = JSON.stringify(patch.meta);
      if (patch.streaming !== undefined) {
        // streaming is transient — never persisted
      }
      if (patch.tool_call_id !== undefined) updated.tool_call_id = patch.tool_call_id;
      if (patch.tool_is_error !== undefined) updated.tool_is_error = patch.tool_is_error ? 1 : 0;
      if (patch.tool_duration_ms !== undefined) updated.tool_duration_ms = patch.tool_duration_ms;
      if (patch.tool_permission !== undefined) {
        updated.toolPermissionJson = JSON.stringify(patch.tool_permission);
      }
      if (patch.tool_lines_added !== undefined) updated.tool_lines_added = patch.tool_lines_added;
      if (patch.tool_lines_removed !== undefined) updated.tool_lines_removed = patch.tool_lines_removed;
      if (patch.tool_line_changes !== undefined) {
        updated.toolLineChangesJson = JSON.stringify(patch.tool_line_changes);
      }
      if (patch.user_board !== undefined) updated.userBoardId = patch.user_board;
      if (patch.whiteboard_refs !== undefined) {
        updated.whiteboardRefsJson = JSON.stringify(patch.whiteboard_refs);
      }
      await db.messages.put(updated);
      return true;
    });
  } catch (error) {
    recordStorage('durable-write', false);
    throw error;
  }
  if (wrote) recordStorage('durable-write', true);
}

/**
 * Delete one message for a conversation. When the caller knows which row the
 * in-memory history dropped (stream cancel pops a specific message), pass its
 * id so the durable delete targets the same row; otherwise fall back to the
 * last row by primary key. The two copies must never drop different rows:
 * deleting by "last" while memory popped another message would leave history
 * permanently divergent after the next reload.
 */
export async function deleteLastMessage(
  conversationId: string,
  messageId?: string,
): Promise<void> {
  let targetId = messageId;
  if (!targetId) {
    const last = await db.messages
      .where('conversationId')
      .equals(conversationId)
      .last();
    // Nothing to pop is not a mutation; see `updateMessage`.
    if (!last) return;
    targetId = last.id;
  }
  // Read-and-delete in one transaction, with an ownership check: an explicit
  // id must belong to the same conversation, and a miss — absent row or
  // foreign row — deletes nothing and records nothing rather than claiming a
  // write that did not happen.
  let wrote: boolean;
  try {
    wrote = await db.transaction('rw', db.messages, async () => {
      const existing = await db.messages.get(targetId);
      if (!existing || existing.conversationId !== conversationId) return false;
      await db.messages.delete(targetId);
      return true;
    });
  } catch (error) {
    recordStorage('durable-write', false);
    throw error;
  }
  if (wrote) recordStorage('durable-write', true);
}

/* ------------------------------------------------------------------ */
/*  Health check                                                       */
/*                                                                     */
/*  These three are the only conversation-database entry points the    */
/*  support-report collector calls. They stay side-effect-free and     */
/*  record nothing, so generating a report cannot fabricate storage    */
/*  activity that normal operation did not perform.                    */
/* ------------------------------------------------------------------ */

/** Returns the total count of conversations (meta rows). */
export async function conversationCount(): Promise<number> {
  return db.conversationsMeta.count();
}

/** Returns the total count of messages across all conversations. */
export async function messageCount(): Promise<number> {
  return db.messages.count();
}

/** Count messages for a single conversation (index lookup, no data loaded). */
export async function countMessages(conversationId: string): Promise<number> {
  return db.messages.where('conversationId').equals(conversationId).count();
}
