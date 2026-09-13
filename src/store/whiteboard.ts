/**
 * Durable two-owner Whiteboard version service.
 *
 * Retained rows are immutable and are inserted with `add`. The user pending
 * copy and the generation-owned model provisional copy live in the separate
 * working table and may be replaced with `put`.
 */

import type { WhiteboardOwner } from '../types';
import {
  maybeCompress,
  maybeDecompress,
  runConversationDataTransaction,
  runWhiteboardDurableMutation,
  runWhiteboardIndexedRead,
  runWhiteboardStorageTransaction,
  type ConversationDataTables,
  type WhiteboardVersionStorageRow,
  type WhiteboardWorkingStorageRow,
} from './db.ts';

export interface WhiteboardVersion {
  conversationId: string;
  id: string;
  owner: WhiteboardOwner;
  content: string;
  createdAt: number;
  sequence: number;
  sourceMessageId: string | null;
  sourceToolCallId: string | null;
}

export interface PendingUserWhiteboard {
  conversationId: string;
  owner: 'user';
  content: string;
  updatedAt: number;
}

export interface ModelWhiteboardWorkingCopy {
  conversationId: string;
  owner: 'model';
  content: string;
  updatedAt: number;
  /** Stable provisional ID after the first changed mutation. */
  id: string | null;
  /** Timestamp encoded by `id`, or null before the first changed mutation. */
  createdAt: number | null;
  initialVersionId: string;
  generationId: string;
  assistantMessageId: string;
  /** Durable mutation receipt for terminal result repair. */
  latestToolCallId: string | null;
}

export type WhiteboardWorkingCopy = PendingUserWhiteboard | ModelWhiteboardWorkingCopy;

export interface WhiteboardHeads {
  user: WhiteboardVersion | null;
  model: WhiteboardVersion | null;
}

/** One transactionally consistent data view for the responsive overlay. */
export interface WhiteboardUiSnapshot {
  conversationId: string;
  modelVersions: WhiteboardVersion[];
  userVersions: WhiteboardVersion[];
  modelHead: WhiteboardVersion | null;
  userHead: WhiteboardVersion | null;
  pendingUser: PendingUserWhiteboard | null;
  provisionalModel: ModelWhiteboardWorkingCopy | null;
  /** Storage-only gate. The public store wrapper also applies global runtime locks. */
  importEligible: boolean;
}

export interface WhiteboardPackageContents {
  modelMarkdown: string;
  userMarkdown: string;
}

export interface WhiteboardPackageImportResult {
  modelVersion: WhiteboardVersion;
  userVersion: WhiteboardVersion;
}

export interface InitializedWhiteboardHeads {
  user: WhiteboardVersion;
  model: WhiteboardVersion;
}

export interface WhiteboardMutationOptions {
  /** Injectable epoch-millisecond clock. It is sampled once per operation. */
  now?: () => number;
}

export interface PendingUserPromotion {
  version: WhiteboardVersion;
  changed: boolean;
  hadPendingCopy: boolean;
}

export interface ModelWhiteboardMutation {
  changed: boolean;
  working: ModelWhiteboardWorkingCopy;
}

export interface ModelWhiteboardSettlement {
  retained: WhiteboardVersion | null;
  latestToolCallId: string | null;
  /** False for an already-settled or generation-mismatched request. */
  settledNow: boolean;
}

export type WhiteboardTables = Pick<
  ConversationDataTables,
  'whiteboardVersions' | 'whiteboardWorking'
>;

export interface WhiteboardStorageMutation<T> {
  value: T;
  wrote: boolean;
}

export interface ConversationWhiteboardMutationAttempt {
  tables: ConversationDataTables;
  /** Advanced by one millisecond whenever an immutable insert collides. */
  candidateCreatedAt: number;
}

export interface ModelWhiteboardSettlementMutationAttempt {
  tables: ConversationDataTables;
  /** The retained ID here is the one assistant refs must pin atomically. */
  settlement: ModelWhiteboardSettlement;
}

const MAX_VERSION_ID_COLLISION_RETRIES = 10_000;
const WHITEBOARD_VERSION_ID_PATTERN = /^[um]_\d{13}$/;
export const WHITEBOARD_CONTENT_MAX_BYTES = 32 * 1024;

export type WhiteboardStorageChangeListener = (conversationId: string | null) => void;
const whiteboardStorageChangeListeners = new Set<WhiteboardStorageChangeListener>();

export class WhiteboardNotInitializedError extends Error {
  override name = 'WhiteboardNotInitializedError';
}

export class WhiteboardVersionMissingError extends Error {
  override name = 'WhiteboardVersionMissingError';
}

export class WhiteboardGenerationConflictError extends Error {
  override name = 'WhiteboardGenerationConflictError';
}

export class WhiteboardGenerationClosedError extends Error {
  override name = 'WhiteboardGenerationClosedError';
}

export class WhiteboardContentTooLargeError extends Error {
  override name = 'WhiteboardContentTooLargeError';
  readonly actualBytes: number;
  readonly limitBytes: number;

  constructor(
    actualBytes: number,
    limitBytes = WHITEBOARD_CONTENT_MAX_BYTES,
  ) {
    super(`Whiteboard content exceeds the ${limitBytes}-byte UTF-8 limit.`);
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
  }
}

export class WhiteboardImportIneligibleError extends Error {
  override name = 'WhiteboardImportIneligibleError';
}

/** Observe committed Whiteboard mutations; null invalidates every conversation. */
export function subscribeWhiteboardStorageChanges(
  listener: WhiteboardStorageChangeListener,
): () => void {
  whiteboardStorageChangeListeners.add(listener);
  return () => whiteboardStorageChangeListeners.delete(listener);
}

function publishWhiteboardStorageChange(conversationId: string | null): void {
  for (const listener of whiteboardStorageChangeListeners) {
    try {
      listener(conversationId);
    } catch {
      // A UI observer cannot change the outcome of an already-durable write.
    }
  }
}

export function whiteboardContentByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function assertWhiteboardContentSize(content: string): void {
  const actualBytes = whiteboardContentByteLength(content);
  if (actualBytes > WHITEBOARD_CONTENT_MAX_BYTES) {
    throw new WhiteboardContentTooLargeError(actualBytes);
  }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Format one conversation-scoped owner ID from local calendar fields. */
export function formatWhiteboardVersionId(owner: WhiteboardOwner, epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError('Whiteboard version time must be a finite epoch-millisecond value.');
  }
  const date = new Date(epochMs);
  const prefix = owner === 'user' ? 'u_' : 'm_';
  return prefix + [
    pad(date.getMonth() + 1, 2),
    pad(date.getDate(), 2),
    pad(date.getHours(), 2),
    pad(date.getMinutes(), 2),
    pad(date.getSeconds(), 2),
    pad(date.getMilliseconds(), 3),
  ].join('');
}

function sampleClock(options: WhiteboardMutationOptions): number {
  const value = options.now?.() ?? Date.now();
  if (!Number.isFinite(value)) {
    throw new RangeError('Whiteboard clock must return a finite epoch-millisecond value.');
  }
  return Math.trunc(value);
}

function expectedPrefix(owner: WhiteboardOwner): string {
  return owner === 'user' ? 'u_' : 'm_';
}

function assertVersionShape(version: WhiteboardVersion, conversationId?: string): void {
  if (conversationId !== undefined && version.conversationId !== conversationId) {
    throw new Error('Whiteboard version belongs to a different conversation.');
  }
  if (
    !WHITEBOARD_VERSION_ID_PATTERN.test(version.id)
    || !version.id.startsWith(expectedPrefix(version.owner))
  ) {
    throw new Error('Whiteboard version ID is malformed or does not match its owner.');
  }
  if (!Number.isSafeInteger(version.createdAt)) {
    throw new Error('Whiteboard version createdAt must be a safe epoch-millisecond integer.');
  }
  if (!Number.isSafeInteger(version.sequence) || version.sequence < 1) {
    throw new Error('Whiteboard version sequence must be a positive safe integer.');
  }
}

/** Convert a domain row to the compressed IndexedDB carrier. */
export function whiteboardVersionToStorageRow(
  version: WhiteboardVersion,
): WhiteboardVersionStorageRow {
  assertVersionShape(version);
  return {
    ...version,
    content: maybeCompress(version.content) ?? '',
  };
}

/** Convert a compressed IndexedDB carrier to the public domain row. */
export function whiteboardVersionFromStorageRow(
  row: WhiteboardVersionStorageRow,
): WhiteboardVersion {
  const version: WhiteboardVersion = {
    ...row,
    content: maybeDecompress(row.content) ?? '',
  };
  assertVersionShape(version);
  return version;
}

/** Convert a domain working copy to the compressed IndexedDB carrier. */
export function whiteboardWorkingToStorageRow(
  working: WhiteboardWorkingCopy,
): WhiteboardWorkingStorageRow {
  if (working.owner === 'user') {
    return {
      conversationId: working.conversationId,
      owner: 'user',
      content: maybeCompress(working.content) ?? '',
      updatedAt: working.updatedAt,
    };
  }
  return {
    ...working,
    content: maybeCompress(working.content) ?? '',
  };
}

/** Decode and validate one owner-specific working row. */
export function whiteboardWorkingFromStorageRow(
  row: WhiteboardWorkingStorageRow,
): WhiteboardWorkingCopy {
  const content = maybeDecompress(row.content) ?? '';
  if (row.owner === 'user') {
    return {
      conversationId: row.conversationId,
      owner: 'user',
      content,
      updatedAt: row.updatedAt,
    };
  }
  if (
    !row.initialVersionId
    || !row.generationId
    || !row.assistantMessageId
    || row.id === undefined
    || row.createdAt === undefined
  ) {
    throw new Error('Stored model Whiteboard working row is incomplete.');
  }
  if (!/^m_\d{13}$/.test(row.initialVersionId)) {
    throw new Error('Stored model Whiteboard initial version ID is malformed.');
  }
  if ((row.id === null) !== (row.createdAt === null)) {
    throw new Error('Stored model Whiteboard provisional ID and timestamp disagree.');
  }
  if (
    row.id !== null
    && (
      !/^m_\d{13}$/.test(row.id)
      || !Number.isSafeInteger(row.createdAt)
    )
  ) {
    throw new Error('Stored model Whiteboard provisional identity is malformed.');
  }
  return {
    conversationId: row.conversationId,
    owner: 'model',
    content,
    updatedAt: row.updatedAt,
    id: row.id,
    createdAt: row.createdAt,
    initialVersionId: row.initialVersionId,
    generationId: row.generationId,
    assistantMessageId: row.assistantMessageId,
    latestToolCallId: row.latestToolCallId ?? null,
  };
}

function isInitialBaseline(
  version: WhiteboardVersion | null,
  owner: WhiteboardOwner,
  sequence: number,
): boolean {
  return version !== null
    && version.owner === owner
    && version.sequence === sequence
    && version.content === ''
    && version.sourceMessageId === null
    && version.sourceToolCallId === null;
}

function whiteboardUiSnapshotFromRows(
  conversationId: string,
  versionRows: readonly WhiteboardVersionStorageRow[],
  workingRows: readonly WhiteboardWorkingStorageRow[],
): WhiteboardUiSnapshot {
  const versions = versionRows
    .map(whiteboardVersionFromStorageRow)
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const modelVersions = versions.filter((version) => version.owner === 'model');
  const userVersions = versions.filter((version) => version.owner === 'user');
  const decodedWorking = workingRows.map(whiteboardWorkingFromStorageRow);
  const pendingUser = decodedWorking.find(
    (working): working is PendingUserWhiteboard => working.owner === 'user',
  ) ?? null;
  const provisionalModel = decodedWorking.find(
    (working): working is ModelWhiteboardWorkingCopy => working.owner === 'model',
  ) ?? null;
  const modelHead = modelVersions.at(-1) ?? null;
  const userHead = userVersions.at(-1) ?? null;
  const importEligible = userVersions.length === 1
    && modelVersions.length === 1
    && isInitialBaseline(userHead, 'user', 1)
    && isInitialBaseline(modelHead, 'model', 2)
    && pendingUser === null
    && provisionalModel === null;
  return {
    conversationId,
    modelVersions,
    userVersions,
    modelHead,
    userHead,
    pendingUser,
    provisionalModel,
    importEligible,
  };
}

/** Read histories, heads, and working state from one IndexedDB snapshot. */
export function readWhiteboardUiSnapshot(conversationId: string): Promise<WhiteboardUiSnapshot> {
  return runWhiteboardIndexedRead(() => runWhiteboardStorageTransaction('r', async (tables) => {
    // Keep both reads in one direct request chain so the returned eligibility
    // and current heads describe the same IndexedDB transaction snapshot.
    const versionRows = await tables.whiteboardVersions
      .where('conversationId')
      .equals(conversationId)
      .toArray();
    const workingRows = await tables.whiteboardWorking
      .where('conversationId')
      .equals(conversationId)
      .toArray();
    return whiteboardUiSnapshotFromRows(conversationId, versionRows, workingRows);
  }));
}

/** Retained history query used inside a larger conversation transaction. */
export function listWhiteboardVersionsInTransaction(
  tables: Pick<ConversationDataTables, 'whiteboardVersions'>,
  conversationId: string,
  owner?: WhiteboardOwner,
): Promise<WhiteboardVersion[]> {
  const rows = owner
    ? tables.whiteboardVersions
      .where('[conversationId+owner]')
      .equals([conversationId, owner])
      .toArray()
    : tables.whiteboardVersions.where('conversationId').equals(conversationId).toArray();
  return rows.then((storedRows) => storedRows
    .map(whiteboardVersionFromStorageRow)
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id)));
}

/** Point query used inside a larger conversation transaction. */
export function getWhiteboardVersionInTransaction(
  tables: Pick<ConversationDataTables, 'whiteboardVersions'>,
  conversationId: string,
  versionId: string,
): Promise<WhiteboardVersion | null> {
  return tables.whiteboardVersions
    .get([conversationId, versionId])
    .then((row) => row ? whiteboardVersionFromStorageRow(row) : null);
}

function latestVersionInTransaction(
  tables: Pick<ConversationDataTables, 'whiteboardVersions'>,
  conversationId: string,
  owner: WhiteboardOwner,
): Promise<WhiteboardVersion | null> {
  return listWhiteboardVersionsInTransaction(tables, conversationId, owner)
    .then((versions) => versions.at(-1) ?? null);
}

/** Immutable retained-row insertion for a caller-owned transaction. */
export function addWhiteboardVersionInTransaction(
  tables: Pick<ConversationDataTables, 'whiteboardVersions'>,
  version: WhiteboardVersion,
): Promise<void> {
  assertVersionShape(version);
  return tables.whiteboardVersions
    .add(whiteboardVersionToStorageRow(version))
    .then(() => undefined);
}

/** Add validated retained rows without overwriting any existing row. */
export function addWhiteboardVersionsInTransaction(
  tables: Pick<ConversationDataTables, 'whiteboardVersions'>,
  versions: readonly WhiteboardVersion[],
): Promise<void> {
  const seenKeys = new Set<string>();
  const seenSequences = new Set<string>();
  for (const version of versions) {
    assertVersionShape(version);
    const key = `${version.conversationId}\0${version.id}`;
    const sequence = `${version.conversationId}\0${version.sequence}`;
    if (seenKeys.has(key) || seenSequences.has(sequence)) {
      throw new Error('Whiteboard retained rows contain a duplicate key or sequence.');
    }
    seenKeys.add(key);
    seenSequences.add(sequence);
  }
  // Even the empty case returns a Dexie request promise. A caller can await
  // this helper and continue writing without leaving its transaction idle.
  if (versions.length === 0) {
    return tables.whiteboardVersions.count().then(() => undefined);
  }
  return tables.whiteboardVersions
    .bulkAdd(versions.map(whiteboardVersionToStorageRow))
    .then(() => undefined);
}

function assertWhiteboardPackageContents(contents: WhiteboardPackageContents): void {
  assertWhiteboardContentSize(contents.modelMarkdown);
  assertWhiteboardContentSize(contents.userMarkdown);
  if (contents.modelMarkdown === '' && contents.userMarkdown === '') {
    throw new WhiteboardImportIneligibleError(
      'At least one imported Whiteboard document must contain content.',
    );
  }
}

/**
 * Administrative empty-board import inside a caller-owned conversation
 * transaction. Every eligibility condition is read again here immediately
 * before the two immutable inserts.
 */
export function importWhiteboardPackageContentsInTransaction(
  tables: ConversationDataTables,
  conversationId: string,
  contents: WhiteboardPackageContents,
  candidateCreatedAt: number,
): Promise<WhiteboardPackageImportResult> {
  assertWhiteboardPackageContents(contents);
  // Keep the nested transaction helper Dexie-promise-preserving. A native
  // async read helper can let fake-indexeddb close the rw transaction before
  // its later immutable inserts.
  return tables.conversationsMeta.get(conversationId).then((conversation) => {
    if (!conversation) {
      throw new WhiteboardImportIneligibleError(
        'The Whiteboard import conversation is unavailable.',
      );
    }
    return tables.whiteboardVersions
      .where('conversationId')
      .equals(conversationId)
      .toArray();
  }).then((versionRows) => (
    tables.whiteboardWorking
      .where('conversationId')
      .equals(conversationId)
      .toArray()
      .then((workingRows) => ({ versionRows, workingRows }))
  )).then(({ versionRows, workingRows }) => {
    const snapshot = whiteboardUiSnapshotFromRows(conversationId, versionRows, workingRows);
    if (!snapshot.importEligible) {
      throw new WhiteboardImportIneligibleError(
        'Whiteboard import requires untouched empty baselines and no working copies.',
      );
    }

    const nextSequence = versionRows.reduce(
      (maximum, row) => Math.max(maximum, row.sequence),
      0,
    ) + 1;
    if (!Number.isSafeInteger(nextSequence) || !Number.isSafeInteger(nextSequence + 1)) {
      throw new Error('Whiteboard version sequence is exhausted.');
    }
    const modelVersion: WhiteboardVersion = {
      conversationId,
      id: formatWhiteboardVersionId('model', candidateCreatedAt),
      owner: 'model',
      content: contents.modelMarkdown,
      createdAt: candidateCreatedAt,
      sequence: nextSequence,
      sourceMessageId: null,
      sourceToolCallId: null,
    };
    const userVersion: WhiteboardVersion = {
      conversationId,
      id: formatWhiteboardVersionId('user', candidateCreatedAt),
      owner: 'user',
      content: contents.userMarkdown,
      createdAt: candidateCreatedAt,
      sequence: nextSequence + 1,
      sourceMessageId: null,
      sourceToolCallId: null,
    };
    return addWhiteboardVersionInTransaction(tables, modelVersion)
      .then(() => addWhiteboardVersionInTransaction(tables, userVersion))
      .then(() => ({ modelVersion, userVersion }));
  });
}

/** Storage half of the globally leased package-import boundary. */
export function importWhiteboardPackageIntoEmptyConversationStorage(
  conversationId: string,
  contents: WhiteboardPackageContents,
  options: WhiteboardMutationOptions = {},
): Promise<WhiteboardPackageImportResult> {
  assertWhiteboardPackageContents(contents);
  return runConversationWhiteboardMutationWithRetry(async ({
    tables,
    candidateCreatedAt,
  }) => ({
    value: await importWhiteboardPackageContentsInTransaction(
      tables,
      conversationId,
      contents,
      candidateCreatedAt,
    ),
    wrote: true,
  }), options);
}

/** Replace one imported conversation's retained rows and clear working state. */
export function replaceWhiteboardVersionsInTransaction(
  tables: WhiteboardTables,
  conversationId: string,
  versions: readonly WhiteboardVersion[],
): Promise<void> {
  for (const version of versions) assertVersionShape(version, conversationId);
  return tables.whiteboardVersions
    .where('conversationId')
    .equals(conversationId)
    .delete()
    .then(() => tables.whiteboardWorking.where('conversationId').equals(conversationId).delete())
    .then(() => addWhiteboardVersionsInTransaction(tables, versions));
}

/** Delete retained rows by conversation-scoped ID (used by branch truncation). */
export function deleteWhiteboardVersionsInTransaction(
  tables: Pick<ConversationDataTables, 'whiteboardVersions'>,
  conversationId: string,
  versionIds: readonly string[],
): Promise<number> {
  const uniqueIds = [...new Set(versionIds)];
  if (uniqueIds.length === 0) {
    return tables.whiteboardVersions.count().then(() => 0);
  }
  const keys: [string, string][] = uniqueIds.map((versionId) => [conversationId, versionId]);
  return tables.whiteboardVersions.bulkGet(keys).then((existing) => (
    tables.whiteboardVersions
      .bulkDelete(keys)
      .then(() => existing.filter((row) => row !== undefined).length)
  ));
}

/** Delete both retained and working records for one conversation. */
export function deleteWhiteboardConversationRowsInTransaction(
  tables: WhiteboardTables,
  conversationId: string,
): Promise<void> {
  return tables.whiteboardVersions
    .where('conversationId')
    .equals(conversationId)
    .delete()
    .then(() => tables.whiteboardWorking.where('conversationId').equals(conversationId).delete())
    .then(() => undefined);
}

/** Clear an active model row when its assistant belongs to a discarded branch. */
export function deleteDiscardedModelWorkingCopyInTransaction(
  tables: Pick<ConversationDataTables, 'whiteboardWorking'>,
  conversationId: string,
  removedAssistantMessageIds: ReadonlySet<string>,
): Promise<boolean> {
  return tables.whiteboardWorking.get([conversationId, 'model']).then((row) => {
    if (!row?.assistantMessageId || !removedAssistantMessageIds.has(row.assistantMessageId)) {
      return false;
    }
    return tables.whiteboardWorking
      .delete([conversationId, 'model'])
      .then(() => true);
  });
}

function isConstraintError(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (
      typeof candidate === 'object'
      && candidate !== null
      && 'name' in candidate
      && candidate.name === 'ConstraintError'
    ) {
      return true;
    }
    candidate = typeof candidate === 'object' && candidate !== null && 'cause' in candidate
      ? candidate.cause
      : undefined;
  }
  return false;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof value.then === 'function'
  );
}

async function runCollisionRetry<T, TTables>(
  baseCreatedAt: number,
  runTransaction: (
    mutation: (tables: TTables) => Promise<WhiteboardStorageMutation<T>>,
  ) => Promise<WhiteboardStorageMutation<T>>,
  run: (
    tables: TTables,
    candidateCreatedAt: number,
  ) => Promise<WhiteboardStorageMutation<T>>,
): Promise<T> {
  return runWhiteboardDurableMutation(async () => {
    for (let attempt = 0; attempt < MAX_VERSION_ID_COLLISION_RETRIES; attempt += 1) {
      try {
        return await runTransaction((tables) => run(tables, baseCreatedAt + attempt));
      } catch (error) {
        if (!isConstraintError(error)) throw error;
      }
    }
    throw new Error('Whiteboard version ID collision retry limit was reached.');
  });
}

/**
 * Cross-table collision-retry seam for atomic message/meta/retained mutations.
 * The callback must use only Dexie work; prepare attachment or filesystem work
 * before entering it. A retained-row `ConstraintError` retries everything.
 */
export async function runConversationWhiteboardMutationWithRetry<T>(
  run: (
    attempt: ConversationWhiteboardMutationAttempt,
  ) => Promise<WhiteboardStorageMutation<T>>,
  options: WhiteboardMutationOptions = {},
): Promise<T> {
  const baseCreatedAt = sampleClock(options);
  const value = await runCollisionRetry<T, ConversationDataTables>(
    baseCreatedAt,
    (mutation) => runConversationDataTransaction('rw', mutation),
    (tables, candidateCreatedAt) => run({ tables, candidateCreatedAt }),
  );
  publishWhiteboardStorageChange(null);
  return value;
}

async function runWhiteboardMutationWithRetry<T>(
  run: (
    tables: WhiteboardTables,
    candidateCreatedAt: number,
  ) => Promise<WhiteboardStorageMutation<T>>,
  options: WhiteboardMutationOptions,
): Promise<T> {
  const baseCreatedAt = sampleClock(options);
  const value = await runCollisionRetry(
    baseCreatedAt,
    (mutation) => runWhiteboardStorageTransaction('rw', mutation),
    run,
  );
  publishWhiteboardStorageChange(null);
  return value;
}

/** Create the empty user/model baselines atomically and idempotently. */
export async function initializeWhiteboard(
  conversationId: string,
  options: WhiteboardMutationOptions = {},
): Promise<InitializedWhiteboardHeads> {
  return runWhiteboardMutationWithRetry(async (tables, candidateCreatedAt) => {
    // Keep the read/write transaction to one direct read before its writes.
    // fake-indexeddb can consider the transaction idle across joined/nested
    // query continuations and otherwise produce Dexie PrematureCommitError.
    const existingVersions = (
      await tables.whiteboardVersions.where('conversationId').equals(conversationId).toArray()
    )
      .map(whiteboardVersionFromStorageRow)
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
    const existingUser = existingVersions
      .filter((version) => version.owner === 'user')
      .at(-1) ?? null;
    const existingModel = existingVersions
      .filter((version) => version.owner === 'model')
      .at(-1) ?? null;
    if (existingUser && existingModel) {
      return { value: { user: existingUser, model: existingModel }, wrote: false };
    }

    let sequence = (existingVersions.at(-1)?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new Error('Whiteboard version sequence is exhausted.');
    }
    let user = existingUser;
    let model = existingModel;
    if (!user) {
      user = {
        conversationId,
        id: formatWhiteboardVersionId('user', candidateCreatedAt),
        owner: 'user',
        content: '',
        createdAt: candidateCreatedAt,
        sequence,
        sourceMessageId: null,
        sourceToolCallId: null,
      };
      await addWhiteboardVersionInTransaction(tables, user);
      sequence += 1;
    }
    if (!model) {
      model = {
        conversationId,
        id: formatWhiteboardVersionId('model', candidateCreatedAt),
        owner: 'model',
        content: '',
        createdAt: candidateCreatedAt,
        sequence,
        sourceMessageId: null,
        sourceToolCallId: null,
      };
      await addWhiteboardVersionInTransaction(tables, model);
    }
    return { value: { user, model }, wrote: true };
  }, options);
}

/** Ordered retained history. Working rows are deliberately excluded. */
export function listWhiteboardVersions(
  conversationId: string,
  owner?: WhiteboardOwner,
): Promise<WhiteboardVersion[]> {
  return runWhiteboardIndexedRead(() => runWhiteboardStorageTransaction(
    'r',
    (tables) => listWhiteboardVersionsInTransaction(tables, conversationId, owner),
  ));
}

/** Resolve one conversation-scoped retained version. */
export function getWhiteboardVersion(
  conversationId: string,
  versionId: string,
): Promise<WhiteboardVersion | null> {
  return runWhiteboardIndexedRead(() => runWhiteboardStorageTransaction(
    'r',
    (tables) => getWhiteboardVersionInTransaction(tables, conversationId, versionId),
  ));
}

/** Resolve the current retained head for both owners in one transaction. */
export function getWhiteboardHeads(conversationId: string): Promise<WhiteboardHeads> {
  return runWhiteboardIndexedRead(() => runWhiteboardStorageTransaction('r', async (tables) => {
    const [user, model] = await Promise.all([
      latestVersionInTransaction(tables, conversationId, 'user'),
      latestVersionInTransaction(tables, conversationId, 'model'),
    ]);
    return { user, model };
  }));
}

/** Persist or replace the one pending user copy. */
export async function savePendingUserWhiteboard(
  conversationId: string,
  content: string,
  options: WhiteboardMutationOptions = {},
): Promise<PendingUserWhiteboard> {
  assertWhiteboardContentSize(content);
  const pending: PendingUserWhiteboard = {
    conversationId,
    owner: 'user',
    content,
    updatedAt: sampleClock(options),
  };
  const value = await runWhiteboardDurableMutation(async () => {
    await runWhiteboardStorageTransaction('rw', async (tables) => {
      await tables.whiteboardWorking.put(whiteboardWorkingToStorageRow(pending));
    });
    return { value: pending, wrote: true };
  });
  publishWhiteboardStorageChange(conversationId);
  return value;
}

/** Load the persisted pending user copy, including an explicitly empty copy. */
export function getPendingUserWhiteboard(
  conversationId: string,
): Promise<PendingUserWhiteboard | null> {
  return runWhiteboardIndexedRead(() => runWhiteboardStorageTransaction('r', async (tables) => {
    const row = await tables.whiteboardWorking.get([conversationId, 'user']);
    if (!row) return null;
    const working = whiteboardWorkingFromStorageRow(row);
    if (working.owner !== 'user') throw new Error('Stored pending Whiteboard owner is invalid.');
    return working;
  }));
}

/** Explicitly discard the saved pending user copy. */
export async function clearPendingUserWhiteboard(conversationId: string): Promise<boolean> {
  const value = await runWhiteboardDurableMutation(async () => {
    const wrote = await runWhiteboardStorageTransaction('rw', async (tables) => {
      const key: [string, WhiteboardOwner] = [conversationId, 'user'];
      if (!await tables.whiteboardWorking.get(key)) return false;
      await tables.whiteboardWorking.delete(key);
      return true;
    });
    return { value: wrote, wrote };
  });
  publishWhiteboardStorageChange(conversationId);
  return value;
}

/**
 * Promote (or reuse) a pending user copy inside a caller-owned transaction.
 * The caller must wrap this in `runConversationWhiteboardMutationWithRetry`
 * when it also writes the source user message.
 */
export async function promotePendingUserWhiteboardInTransaction(
  tables: WhiteboardTables,
  conversationId: string,
  sourceMessageId: string,
  candidateCreatedAt: number,
): Promise<WhiteboardStorageMutation<PendingUserPromotion>> {
  const retainedVersions = (
    await tables.whiteboardVersions.where('conversationId').equals(conversationId).toArray()
  )
    .map(whiteboardVersionFromStorageRow)
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const current = retainedVersions
    .filter((version) => version.owner === 'user')
    .at(-1) ?? null;
  if (!current) {
    throw new WhiteboardNotInitializedError('The user Whiteboard has no retained head.');
  }
  const pendingRow = await tables.whiteboardWorking.get([conversationId, 'user']);
  if (!pendingRow) {
    return {
      value: { version: current, changed: false, hadPendingCopy: false },
      wrote: false,
    };
  }
  const pending = whiteboardWorkingFromStorageRow(pendingRow);
  if (pending.owner !== 'user') throw new Error('Stored pending Whiteboard owner is invalid.');
  if (pending.content === current.content) {
    await tables.whiteboardWorking.delete([conversationId, 'user']);
    return {
      value: { version: current, changed: false, hadPendingCopy: true },
      wrote: true,
    };
  }

  const retained: WhiteboardVersion = {
    conversationId,
    id: formatWhiteboardVersionId('user', candidateCreatedAt),
    owner: 'user',
    content: pending.content,
    createdAt: candidateCreatedAt,
    sequence: (retainedVersions.at(-1)?.sequence ?? 0) + 1,
    sourceMessageId,
    sourceToolCallId: null,
  };
  await addWhiteboardVersionInTransaction(tables, retained);
  await tables.whiteboardWorking.delete([conversationId, 'user']);
  return {
    value: { version: retained, changed: true, hadPendingCopy: true },
    wrote: true,
  };
}

/** Promote a pending user copy when no related message write is required. */
export function promotePendingUserWhiteboard(
  conversationId: string,
  sourceMessageId: string,
  options: WhiteboardMutationOptions = {},
): Promise<PendingUserPromotion> {
  return runWhiteboardMutationWithRetry(
    (tables, candidateCreatedAt) => promotePendingUserWhiteboardInTransaction(
      tables,
      conversationId,
      sourceMessageId,
      candidateCreatedAt,
    ),
    options,
  );
}

function assertModelWorkingOwner(
  row: WhiteboardWorkingStorageRow | undefined,
  conversationId: string,
  generationId: string,
  assistantMessageId: string,
): ModelWhiteboardWorkingCopy {
  if (!row) {
    throw new WhiteboardGenerationClosedError('The model Whiteboard turn is already closed.');
  }
  const working = whiteboardWorkingFromStorageRow(row);
  if (
    working.owner !== 'model'
    || working.conversationId !== conversationId
    || working.generationId !== generationId
    || working.assistantMessageId !== assistantMessageId
  ) {
    throw new WhiteboardGenerationClosedError('The model Whiteboard row belongs to another generation.');
  }
  return working;
}

/** Open one generation-owned model working row in a caller-owned transaction. */
export async function beginModelWhiteboardTurnInTransaction(
  tables: WhiteboardTables,
  input: {
    conversationId: string;
    generationId: string;
    assistantMessageId: string;
    initialVersionId?: string;
  },
  updatedAt: number,
): Promise<WhiteboardStorageMutation<ModelWhiteboardWorkingCopy>> {
  const existingRow = await tables.whiteboardWorking.get([input.conversationId, 'model']);
  if (existingRow) {
    const existing = whiteboardWorkingFromStorageRow(existingRow);
    if (
      existing.owner === 'model'
      && existing.generationId === input.generationId
      && existing.assistantMessageId === input.assistantMessageId
      && (!input.initialVersionId || existing.initialVersionId === input.initialVersionId)
    ) {
      return { value: existing, wrote: false };
    }
    throw new WhiteboardGenerationConflictError(
      'Another generation owns the model Whiteboard working row.',
    );
  }

  let initial: WhiteboardVersion | null;
  if (input.initialVersionId) {
    const initialRow = await tables.whiteboardVersions.get([
      input.conversationId,
      input.initialVersionId,
    ]);
    initial = initialRow ? whiteboardVersionFromStorageRow(initialRow) : null;
  } else {
    const modelRows = await tables.whiteboardVersions
      .where('[conversationId+owner]')
      .equals([input.conversationId, 'model'])
      .toArray();
    initial = modelRows
      .map(whiteboardVersionFromStorageRow)
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
      .at(-1) ?? null;
  }
  if (!initial) {
    throw input.initialVersionId
      ? new WhiteboardVersionMissingError('The initial model Whiteboard version is missing.')
      : new WhiteboardNotInitializedError('The model Whiteboard has no retained head.');
  }
  if (initial.owner !== 'model') {
    throw new WhiteboardVersionMissingError('The initial Whiteboard version is not model-owned.');
  }

  const working: ModelWhiteboardWorkingCopy = {
    conversationId: input.conversationId,
    owner: 'model',
    content: initial.content,
    updatedAt,
    id: null,
    createdAt: null,
    initialVersionId: initial.id,
    generationId: input.generationId,
    assistantMessageId: input.assistantMessageId,
    latestToolCallId: null,
  };
  await tables.whiteboardWorking.add(whiteboardWorkingToStorageRow(working));
  return { value: working, wrote: true };
}

/** Open one generation-owned model turn. */
export async function beginModelWhiteboardTurn(
  input: {
    conversationId: string;
    generationId: string;
    assistantMessageId: string;
    initialVersionId?: string;
  },
  options: WhiteboardMutationOptions = {},
): Promise<ModelWhiteboardWorkingCopy> {
  const updatedAt = sampleClock(options);
  const value = await runWhiteboardDurableMutation(async () => {
    const result = await runWhiteboardStorageTransaction(
      'rw',
      (tables) => beginModelWhiteboardTurnInTransaction(tables, input, updatedAt),
    );
    return result;
  });
  publishWhiteboardStorageChange(input.conversationId);
  return value;
}

/** Load the active provisional model copy, if any. */
export function getModelWhiteboardWorking(
  conversationId: string,
): Promise<ModelWhiteboardWorkingCopy | null> {
  return runWhiteboardIndexedRead(() => runWhiteboardStorageTransaction('r', async (tables) => {
    const row = await tables.whiteboardWorking.get([conversationId, 'model']);
    if (!row) return null;
    const working = whiteboardWorkingFromStorageRow(row);
    if (working.owner !== 'model') throw new Error('Stored model Whiteboard owner is invalid.');
    return working;
  }));
}

/** Apply model content and receipt metadata inside a caller-owned transaction. */
export async function applyModelWhiteboardContentInTransaction(
  tables: WhiteboardTables,
  input: {
    conversationId: string;
    generationId: string;
    assistantMessageId: string;
    toolCallId: string;
    content: string;
  },
  updatedAt: number,
): Promise<WhiteboardStorageMutation<ModelWhiteboardMutation>> {
  const row = await tables.whiteboardWorking.get([input.conversationId, 'model']);
  const current = assertModelWorkingOwner(
    row,
    input.conversationId,
    input.generationId,
    input.assistantMessageId,
  );
  if (current.content === input.content) {
    return { value: { changed: false, working: current }, wrote: false };
  }

  let candidate = current.id
    ? { id: current.id, createdAt: current.createdAt }
    : null;
  if (!candidate) {
    for (let offset = 0; offset < MAX_VERSION_ID_COLLISION_RETRIES; offset += 1) {
      const createdAt = updatedAt + offset;
      const id = formatWhiteboardVersionId('model', createdAt);
      if (!await tables.whiteboardVersions.get([input.conversationId, id])) {
        candidate = { id, createdAt };
        break;
      }
    }
  }
  if (!candidate) {
    throw new Error('Whiteboard provisional ID collision retry limit was reached.');
  }
  if (candidate.createdAt === null) {
    throw new Error('Stored model Whiteboard provisional timestamp is missing.');
  }
  const next: ModelWhiteboardWorkingCopy = {
    ...current,
    content: input.content,
    updatedAt,
    id: candidate.id,
    createdAt: candidate.createdAt,
    latestToolCallId: input.toolCallId,
  };
  await tables.whiteboardWorking.put(whiteboardWorkingToStorageRow(next));
  return { value: { changed: true, working: next }, wrote: true };
}

/** Apply one changed-or-no-op model content update. */
export async function applyModelWhiteboardContent(
  input: {
    conversationId: string;
    generationId: string;
    assistantMessageId: string;
    toolCallId: string;
    content: string;
  },
  options: WhiteboardMutationOptions = {},
): Promise<ModelWhiteboardMutation> {
  assertWhiteboardContentSize(input.content);
  const updatedAt = sampleClock(options);
  const value = await runWhiteboardDurableMutation(async () => runWhiteboardStorageTransaction(
    'rw',
    (tables) => applyModelWhiteboardContentInTransaction(tables, input, updatedAt),
  ));
  publishWhiteboardStorageChange(input.conversationId);
  return value;
}

async function retainedForAssistantInTransaction(
  tables: Pick<ConversationDataTables, 'whiteboardVersions'>,
  conversationId: string,
  assistantMessageId: string,
): Promise<WhiteboardVersion | null> {
  const versions = await listWhiteboardVersionsInTransaction(tables, conversationId, 'model');
  return versions.filter((version) => version.sourceMessageId === assistantMessageId).at(-1) ?? null;
}

/** Close and retain one generation-owned model row in a caller-owned transaction. */
export async function settleModelWhiteboardTurnInTransaction(
  tables: WhiteboardTables,
  input: {
    conversationId: string;
    generationId: string;
    assistantMessageId: string;
  },
  candidateCreatedAt: number,
): Promise<WhiteboardStorageMutation<ModelWhiteboardSettlement>> {
  const row = await tables.whiteboardWorking.get([input.conversationId, 'model']);
  if (
    !row
    || row.generationId !== input.generationId
    || row.assistantMessageId !== input.assistantMessageId
  ) {
    const alreadyRetained = await retainedForAssistantInTransaction(
      tables,
      input.conversationId,
      input.assistantMessageId,
    );
    return {
      value: {
        retained: alreadyRetained,
        latestToolCallId: alreadyRetained?.sourceToolCallId ?? null,
        settledNow: false,
      },
      wrote: false,
    };
  }

  const working = assertModelWorkingOwner(
    row,
    input.conversationId,
    input.generationId,
    input.assistantMessageId,
  );
  const initialRow = await tables.whiteboardVersions.get([
    input.conversationId,
    working.initialVersionId,
  ]);
  if (!initialRow || initialRow.owner !== 'model') {
    // The initial retained model row is the immutable provenance anchor for
    // this turn. If it vanished, fail closed by discarding the orphaned
    // provisional copy instead of fabricating a new retained history root.
    await tables.whiteboardWorking.delete([input.conversationId, 'model']);
    return {
      value: {
        retained: null,
        latestToolCallId: working.latestToolCallId,
        settledNow: true,
      },
      wrote: true,
    };
  }
  if (!working.id) {
    await tables.whiteboardWorking.delete([input.conversationId, 'model']);
    return {
      value: { retained: null, latestToolCallId: null, settledNow: true },
      wrote: true,
    };
  }
  if (working.createdAt === null) {
    throw new Error('Stored model Whiteboard provisional timestamp is missing.');
  }

  const retainedRows = await tables.whiteboardVersions
    .where('conversationId')
    .equals(input.conversationId)
    .toArray();
  const nextSequence = retainedRows.reduce(
    (maximum, retainedRow) => Math.max(maximum, retainedRow.sequence),
    0,
  ) + 1;

  const retained: WhiteboardVersion = {
    conversationId: input.conversationId,
    // The first attempt receives the provisional timestamp and therefore its
    // exact ID. If that immutable key collided after provisional creation,
    // the complete transaction is retried with the next millisecond and the
    // owning assistant reference can be re-pinned by the caller below.
    id: candidateCreatedAt === working.createdAt
      ? working.id
      : formatWhiteboardVersionId('model', candidateCreatedAt),
    owner: 'model',
    content: working.content,
    createdAt: candidateCreatedAt,
    sequence: nextSequence,
    sourceMessageId: input.assistantMessageId,
    sourceToolCallId: working.latestToolCallId,
  };
  await addWhiteboardVersionInTransaction(tables, retained);
  await tables.whiteboardWorking.delete([input.conversationId, 'model']);
  return {
    value: {
      retained,
      latestToolCallId: working.latestToolCallId,
      settledNow: true,
    },
    wrote: true,
  };
}

/**
 * Settle a model row and atomically run the caller's assistant/result patches.
 * A collision retries the complete transaction. Use `settlement.retained.id`
 * as `model_latest_board`; it can advance from the provisional ID on retry.
 */
export async function runModelWhiteboardSettlementMutationWithRetry<T>(
  input: {
    conversationId: string;
    generationId: string;
    assistantMessageId: string;
  },
  finalize: (
    attempt: ModelWhiteboardSettlementMutationAttempt,
  ) => WhiteboardStorageMutation<T> | Promise<WhiteboardStorageMutation<T>>,
  options: WhiteboardMutationOptions = {},
): Promise<T> {
  // Read only the timestamp needed to seed retry. The generation/row is
  // revalidated in every write transaction, so a stale pre-read cannot close
  // or mutate a newer generation.
  const provisionalCreatedAt = await runConversationDataTransaction('r', async (tables) => {
    const row = await tables.whiteboardWorking.get([input.conversationId, 'model']);
    if (
      row?.generationId === input.generationId
      && row.assistantMessageId === input.assistantMessageId
      && row.id
      && row.createdAt !== null
      && row.createdAt !== undefined
    ) {
      return row.createdAt;
    }
    return sampleClock(options);
  });

  const value = await runCollisionRetry<T, ConversationDataTables>(
    provisionalCreatedAt,
    (mutation) => runConversationDataTransaction('rw', mutation),
    async (tables, candidateCreatedAt) => {
      const settled = await settleModelWhiteboardTurnInTransaction(
        tables,
        input,
        candidateCreatedAt,
      );
      const finalizeResult = finalize({ tables, settlement: settled.value });
      const finalized = isPromiseLike<WhiteboardStorageMutation<T>>(finalizeResult)
        ? await finalizeResult
        : finalizeResult;
      return {
        value: finalized.value,
        wrote: settled.wrote || finalized.wrote,
      };
    },
  );
  publishWhiteboardStorageChange(input.conversationId);
  return value;
}

/**
 * Retain the final provisional model copy once, or close a no-op turn.
 * Lifecycle code that stores assistant references must use the callback-based
 * wrapper above so a collision re-pin is part of this same transaction.
 */
export async function settleModelWhiteboardTurn(input: {
  conversationId: string;
  generationId: string;
  assistantMessageId: string;
}): Promise<ModelWhiteboardSettlement> {
  return runModelWhiteboardSettlementMutationWithRetry(
    input,
    ({ settlement }) => ({ value: settlement, wrote: false }),
  );
}

/** Discard only the matching generation's active model row. */
export async function discardModelWhiteboardTurn(input: {
  conversationId: string;
  generationId: string;
  assistantMessageId: string;
}): Promise<boolean> {
  const value = await runWhiteboardDurableMutation(async () => {
    const wrote = await runWhiteboardStorageTransaction('rw', async (tables) => {
      const row = await tables.whiteboardWorking.get([input.conversationId, 'model']);
      if (
        !row
        || row.generationId !== input.generationId
        || row.assistantMessageId !== input.assistantMessageId
      ) {
        return false;
      }
      await tables.whiteboardWorking.delete([input.conversationId, 'model']);
      return true;
    });
    return { value: wrote, wrote };
  });
  publishWhiteboardStorageChange(input.conversationId);
  return value;
}

/** Test-only reset seam: keeps unrelated conversation rows intact. */
export async function resetWhiteboardStorageForTests(): Promise<void> {
  await runWhiteboardStorageTransaction('rw', async (tables) => {
    await tables.whiteboardVersions.clear();
    await tables.whiteboardWorking.clear();
  });
  publishWhiteboardStorageChange(null);
}

/** Test-only raw seam for proving compression and owner-row cardinality. */
export function readWhiteboardStorageRowsForTests(conversationId?: string): Promise<{
  versions: WhiteboardVersionStorageRow[];
  working: WhiteboardWorkingStorageRow[];
}> {
  return runWhiteboardStorageTransaction('r', async (tables) => ({
    versions: conversationId
      ? await tables.whiteboardVersions.where('conversationId').equals(conversationId).toArray()
      : await tables.whiteboardVersions.toArray(),
    working: conversationId
      ? await tables.whiteboardWorking.where('conversationId').equals(conversationId).toArray()
      : await tables.whiteboardWorking.toArray(),
  }));
}
