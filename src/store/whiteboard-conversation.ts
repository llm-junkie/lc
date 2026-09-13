/**
 * Cross-table conversation/Whiteboard persistence boundaries.
 *
 * These operations deliberately live outside the React store. They prepare
 * ordinary JavaScript values first, then commit metadata, messages, retained
 * versions, and working rows in one Dexie transaction.
 */

import type { Conversation, Message, WhiteboardTurnReferences } from '../types';
import {
  decodeLcResultJson,
  encodeLcResultJson,
  type DecodedLcResultJson,
} from '../modules/tool-engine/tool-result-content.ts';
import {
  conversationMetaToStorageRow,
  messageToStorageRow,
  runConversationDataMutation,
  runConversationDataTransaction,
} from './db.ts';
import {
  applyModelWhiteboardContentInTransaction,
  beginModelWhiteboardTurnInTransaction,
  discardModelWhiteboardTurn,
  getModelWhiteboardWorking,
  promotePendingUserWhiteboardInTransaction,
  runConversationWhiteboardMutationWithRetry,
  runModelWhiteboardSettlementMutationWithRetry,
  whiteboardWorkingFromStorageRow,
  whiteboardVersionToStorageRow,
  whiteboardVersionFromStorageRow,
  WhiteboardGenerationClosedError,
  WhiteboardNotInitializedError,
  WhiteboardVersionMissingError,
  type ModelWhiteboardMutation,
  type ModelWhiteboardSettlement,
  type ModelWhiteboardWorkingCopy,
  type PendingUserPromotion,
  type WhiteboardMutationOptions,
  type WhiteboardVersion,
} from './whiteboard.ts';

export type WhiteboardBranchBoundary = 'retry' | 'edit-and-resend';

export interface ReplaceConversationBranchInput {
  conversation: Conversation;
  messageId: string;
  next: {
    content: string;
    attachments?: Message['attachments'];
  };
  boundary: WhiteboardBranchBoundary;
  /** Pending state is promoted only at an enabled edit-and-resend boundary. */
  whiteboardEnabled: boolean;
}

export interface ReplacedConversationBranch {
  conversation: Conversation;
  removedMessageIds: string[];
  removedVersionIds: string[];
}

export interface ClonedConversationData {
  copiedVersionIds: string[];
}

export interface WhiteboardCrashRecovery {
  messages: Message[];
  settled: boolean;
  discarded: boolean;
  latestToolCallId: string | null;
  repairedCallIds: string[];
}

export interface WhiteboardUserSendBoundaryInput {
  conversationId: string;
  message: Message;
  whiteboardEnabled: boolean;
  /** Updated conversation metadata to persist in the same transaction. */
  metadata?: Conversation;
}

export interface WhiteboardUserSendBoundary {
  message: Message;
  promotion: PendingUserPromotion | null;
  /** False only when an enabled conversation has no retained user baseline. */
  initialized: boolean;
}

export interface WhiteboardModelAdmissionInput {
  conversationId: string;
  generationId: string;
  sourceUserMessage: Message;
  assistantMessage: Message;
  /** Production conversation snapshot whose count joins the admission commit. */
  metadata?: Conversation;
}

export interface WhiteboardModelAdmission {
  sourceUserMessage: Message;
  assistantMessage: Message;
  refs: WhiteboardTurnReferences;
  working: ModelWhiteboardWorkingCopy;
}

export interface WhiteboardModelTurnInput {
  conversationId: string;
  generationId: string;
  assistantMessageId: string;
}

export interface WhiteboardModelTurnRead {
  refs: WhiteboardTurnReferences;
  userMarkdown: string;
  modelMarkdown: string;
}

export interface WhiteboardModelMutationInput extends WhiteboardModelTurnInput {
  toolCallId: string;
  content: string;
}

export interface WhiteboardModelMutationBoundary {
  mutation: ModelWhiteboardMutation;
  refs: WhiteboardTurnReferences;
}

export type WhiteboardTerminalReason = 'aborted' | 'generation_ended' | 'timeout';

export interface SettleWhiteboardModelTurnInput extends WhiteboardModelTurnInput {
  /** Authoritative live array; IndexedDB can lag while a stream owner exists. */
  messages: Message[];
  reason: WhiteboardTerminalReason;
  /** Accepted calls not yet present on the checkpointed assistant row. */
  acceptedCalls?: readonly NonNullable<Message['tool_calls']>[number][];
}

export interface WhiteboardTerminalBoundary {
  messages: Message[];
  settlement: ModelWhiteboardSettlement;
  repairedCallIds: string[];
}

const encoder = new TextEncoder();
export const APPLIED_AFTER_TERMINATION_WARNING =
  'LC applied this whiteboard change before the generation ended.';
export const WHITEBOARD_TERMINAL_ISSUE_TEXT = Object.freeze({
  timeout: 'The whiteboard operation timed out before it committed. No whiteboard change was applied by this call.',
  aborted: 'The owning generation ended before the whiteboard operation completed. No whiteboard change was applied by this call.',
  remedy: 'Read the current boards in a later turn before you continue.',
});

function sampleBoundaryClock(options: WhiteboardMutationOptions): number {
  const sampled = options.now?.() ?? Date.now();
  if (!Number.isFinite(sampled)) {
    throw new RangeError('Whiteboard boundary clock must return a finite epoch-millisecond value.');
  }
  return Math.trunc(sampled);
}

function latestOwnerVersion(
  versions: readonly WhiteboardVersion[],
  owner: WhiteboardVersion['owner'],
): WhiteboardVersion | null {
  return versions
    .filter((version) => version.owner === owner)
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .at(-1) ?? null;
}

function parseTurnRefs(raw: string | undefined): WhiteboardTurnReferences {
  if (!raw) throw new Error('The generation-owned assistant has no Whiteboard turn references.');
  const refs = JSON.parse(raw) as Partial<WhiteboardTurnReferences>;
  if (
    typeof refs.user_board !== 'string'
    || typeof refs.model_initial_board !== 'string'
    || typeof refs.model_latest_board !== 'string'
  ) {
    throw new Error('The generation-owned assistant has malformed Whiteboard turn references.');
  }
  return refs as WhiteboardTurnReferences;
}

function successfulRepairContent(
  refs: WhiteboardTurnReferences,
  modelContent: string,
): string {
  return JSON.stringify({
    status: 'ok',
    data: {
      refs,
      changed: true,
      model_bytes: encoder.encode(modelContent).byteLength,
    },
    issues: [],
    warnings: [APPLIED_AFTER_TERMINATION_WARNING],
  });
}

function unappliedRepairContent(reason: WhiteboardTerminalReason): string {
  const timeout = reason === 'timeout';
  return JSON.stringify({
    status: timeout ? 'timeout' : 'aborted',
    issues: [{
      code: timeout ? 'timeout' : 'aborted',
      message: timeout
        ? WHITEBOARD_TERMINAL_ISSUE_TEXT.timeout
        : WHITEBOARD_TERMINAL_ISSUE_TEXT.aborted,
      retryable: false,
      remedy: WHITEBOARD_TERMINAL_ISSUE_TEXT.remedy,
    }],
    warnings: [],
  });
}

interface SuccessfulWhiteboardResultEnvelope extends Record<string, unknown> {
  status: 'ok';
  data: Record<string, unknown>;
}

function decodeSuccessfulWhiteboardResult(
  message: Message,
): (DecodedLcResultJson & { data: SuccessfulWhiteboardResultEnvelope }) | null {
  if (message.role !== 'tool' || message.tool_is_error) return null;
  try {
    const decoded = decodeLcResultJson(message.content);
    if (!decoded) return null;
    const parsed = decoded.data;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const envelope = parsed as Record<string, unknown>;
    const data = envelope.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (envelope.status !== 'ok') return null;
    return { ...decoded, data: envelope as SuccessfulWhiteboardResultEnvelope };
  } catch {
    return null;
  }
}

function appliedWhiteboardResultEnvelope(
  message: Message,
): SuccessfulWhiteboardResultEnvelope | null {
  const envelope = decodeSuccessfulWhiteboardResult(message)?.data;
  return envelope?.data.changed === true ? envelope : null;
}

function hasExactTurnReferences(value: unknown, refs: WhiteboardTurnReferences): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 3
    && candidate.user_board === refs.user_board
    && candidate.model_initial_board === refs.model_initial_board
    && candidate.model_latest_board === refs.model_latest_board;
}

/**
 * A retained-ID collision can advance the provisional model ID during
 * settlement. Keep any ordinary success envelope that observed that
 * provisional ID, but make its references agree with the receipt-derived
 * retained row in the same transaction. Earlier reads of the initial retained
 * head keep their original references.
 */
function repinSuccessfulWhiteboardResult(
  message: Message,
  previousModelLatestId: string,
  refs: WhiteboardTurnReferences,
): Message | null {
  const decoded = decodeSuccessfulWhiteboardResult(message);
  if (!decoded || hasExactTurnReferences(decoded.data.data.refs, refs)) return null;
  const envelope = decoded.data;
  const priorRefs = envelope.data.refs;
  if (!priorRefs || typeof priorRefs !== 'object' || Array.isArray(priorRefs)) return null;
  if ((priorRefs as Record<string, unknown>).model_latest_board !== previousModelLatestId) {
    return null;
  }
  return {
    ...message,
    content: encodeLcResultJson({
      ...envelope,
      data: { ...envelope.data, refs },
    }, decoded.notices),
  };
}

function terminalRepairMessage(input: {
  conversationId: string;
  assistantMessageId: string;
  callId: string;
  createdAt: number;
  applied: boolean;
  refs: WhiteboardTurnReferences;
  modelContent: string;
  reason: WhiteboardTerminalReason;
}): Message {
  return {
    id: `whiteboard-repair:${input.conversationId}:${input.assistantMessageId}:${input.callId}`,
    role: 'tool',
    content: input.applied
      ? successfulRepairContent(input.refs, input.modelContent)
      : unappliedRepairContent(input.reason),
    createdAt: input.createdAt,
    tool_call_id: input.callId,
    tool_is_error: !input.applied,
    tool_duration_ms: 0,
  };
}

/**
 * Persist one new user message and its enabled Whiteboard send boundary in one
 * collision-retried transaction. Disabled or uninitialized sends leave the
 * pending copy untouched and store no user-board reference.
 */
export function persistWhiteboardUserSend(
  input: WhiteboardUserSendBoundaryInput,
  options: WhiteboardMutationOptions = {},
): Promise<WhiteboardUserSendBoundary> {
  if (input.message.role !== 'user') {
    return Promise.reject(new Error('Only a user message can own a Whiteboard send boundary.'));
  }
  if (input.metadata && input.metadata.id !== input.conversationId) {
    return Promise.reject(new Error('Whiteboard send metadata belongs to another conversation.'));
  }

  return runConversationWhiteboardMutationWithRetry(async ({
    tables,
    candidateCreatedAt,
  }) => {
    const existing = await tables.messages.get(input.message.id);
    if (existing && existing.conversationId !== input.conversationId) {
      throw new Error('The user message ID belongs to another conversation.');
    }

    const { user_board: _untrustedReference, ...messageWithoutReference } = input.message;
    let message: Message = messageWithoutReference;
    let promotion: PendingUserPromotion | null = null;
    let initialized = false;

    if (input.whiteboardEnabled) {
      const retainedRows = await tables.whiteboardVersions
        .where('[conversationId+owner]')
        .equals([input.conversationId, 'user'])
        .toArray();
      const current = latestOwnerVersion(
        retainedRows.map(whiteboardVersionFromStorageRow),
        'user',
      );
      if (current) {
        const promoted = await promotePendingUserWhiteboardInTransaction(
          tables,
          input.conversationId,
          input.message.id,
          candidateCreatedAt,
        );
        promotion = promoted.value;
        initialized = true;
        message = { ...messageWithoutReference, user_board: promotion.version.id };
      }
    }

    // Serialization happens inside the transaction: if it or either put
    // fails, pending deletion and any retained insertion roll back with it.
    await tables.messages.put(messageToStorageRow(message, input.conversationId));
    if (input.metadata) {
      await tables.conversationsMeta.put(conversationMetaToStorageRow(input.metadata));
    }
    return {
      value: { message, promotion, initialized },
      wrote: true,
    };
  }, options);
}

/**
 * Atomically fallback-pin the source user, persist initial assistant refs, and
 * open the generation-owned model working row.
 */
export function admitWhiteboardModelTurn(
  input: WhiteboardModelAdmissionInput,
  options: WhiteboardMutationOptions = {},
): Promise<WhiteboardModelAdmission> {
  if (input.sourceUserMessage.role !== 'user') {
    return Promise.reject(new Error('Whiteboard admission requires a source user message.'));
  }
  if (input.assistantMessage.role !== 'assistant') {
    return Promise.reject(new Error('Whiteboard admission requires an assistant owner message.'));
  }
  if (input.sourceUserMessage.id === input.assistantMessage.id) {
    return Promise.reject(new Error('Whiteboard source and assistant messages must be distinct.'));
  }
  if (input.metadata && input.metadata.id !== input.conversationId) {
    return Promise.reject(new Error('Whiteboard admission metadata belongs to another conversation.'));
  }

  return runConversationWhiteboardMutationWithRetry(async ({
    tables,
    candidateCreatedAt,
  }) => {
    const [storedSource, storedAssistant] = await tables.messages.bulkGet([
      input.sourceUserMessage.id,
      input.assistantMessage.id,
    ]);
    if (storedSource && storedSource.conversationId !== input.conversationId) {
      throw new Error('The Whiteboard source user message belongs to another conversation.');
    }
    if (storedAssistant && storedAssistant.conversationId !== input.conversationId) {
      throw new Error('The Whiteboard assistant message belongs to another conversation.');
    }

    const retainedRows = await tables.whiteboardVersions
      .where('conversationId')
      .equals(input.conversationId)
      .toArray();
    const retained = retainedRows.map(whiteboardVersionFromStorageRow);
    let userVersion: WhiteboardVersion | null;
    if (input.sourceUserMessage.user_board) {
      userVersion = retained.find(
        (version) => version.id === input.sourceUserMessage.user_board,
      ) ?? null;
      if (!userVersion || userVersion.owner !== 'user') {
        throw new WhiteboardVersionMissingError(
          'The source user message references a missing Whiteboard version.',
        );
      }
    } else {
      userVersion = latestOwnerVersion(retained, 'user');
    }
    const modelVersion = latestOwnerVersion(retained, 'model');
    if (!userVersion || !modelVersion) {
      throw new WhiteboardNotInitializedError(
        'Whiteboard admission requires retained user and model baselines.',
      );
    }

    const refs: WhiteboardTurnReferences = {
      user_board: userVersion.id,
      model_initial_board: modelVersion.id,
      model_latest_board: modelVersion.id,
    };
    const sourceUserMessage: Message = {
      ...input.sourceUserMessage,
      user_board: userVersion.id,
    };
    const assistantMessage: Message = {
      ...input.assistantMessage,
      whiteboard_refs: refs,
    };
    const opened = await beginModelWhiteboardTurnInTransaction(
      tables,
      {
        conversationId: input.conversationId,
        generationId: input.generationId,
        assistantMessageId: input.assistantMessage.id,
        initialVersionId: modelVersion.id,
      },
      candidateCreatedAt,
    );
    await tables.messages.bulkPut([
      messageToStorageRow(sourceUserMessage, input.conversationId),
      messageToStorageRow(assistantMessage, input.conversationId),
    ]);
    if (input.metadata) {
      await tables.conversationsMeta.put(conversationMetaToStorageRow(input.metadata));
    }
    // Whiteboard admission is the alternative to the plain assistant
    // admission, so it owns the same journal responsibility: without this row
    // a Whiteboard turn interrupted before any tool call would reload with no
    // evidence that it never finished.
    await tables.generationRuns.put({
      conversationId: input.conversationId,
      generationId: input.generationId,
      assistantMessageId: input.assistantMessage.id,
      state: 'running',
      startedAt: candidateCreatedAt,
    });
    return {
      value: {
        sourceUserMessage,
        assistantMessage,
        refs,
        working: opened.value,
      },
      wrote: true,
    };
  }, options);
}

/** Read exactly the pinned user and latest working model state for one turn. */
export function readWhiteboardModelTurn(
  input: WhiteboardModelTurnInput,
): Promise<WhiteboardModelTurnRead> {
  return runConversationDataTransaction('r', async (tables) => {
    const assistantRow = await tables.messages.get(input.assistantMessageId);
    if (!assistantRow || assistantRow.conversationId !== input.conversationId) {
      throw new WhiteboardVersionMissingError(
        'The generation-owned Whiteboard assistant message is unavailable.',
      );
    }
    const refs = parseTurnRefs(assistantRow.whiteboardRefsJson);
    const workingRow = await tables.whiteboardWorking.get([input.conversationId, 'model']);
    if (!workingRow) {
      throw new WhiteboardGenerationClosedError('The model Whiteboard turn is already closed.');
    }
    const working = whiteboardWorkingFromStorageRow(workingRow);
    if (
      working.owner !== 'model'
      || working.generationId !== input.generationId
      || working.assistantMessageId !== input.assistantMessageId
    ) {
      throw new WhiteboardGenerationClosedError(
        'The model Whiteboard row belongs to another generation.',
      );
    }
    const expectedLatest = working.id ?? working.initialVersionId;
    if (
      refs.model_initial_board !== working.initialVersionId
      || refs.model_latest_board !== expectedLatest
    ) {
      throw new WhiteboardVersionMissingError(
        'The assistant Whiteboard references do not match its active model row.',
      );
    }
    const userRow = await tables.whiteboardVersions.get([
      input.conversationId,
      refs.user_board,
    ]);
    if (!userRow) {
      throw new WhiteboardVersionMissingError('The pinned user Whiteboard version is missing.');
    }
    const userVersion = whiteboardVersionFromStorageRow(userRow);
    if (userVersion.owner !== 'user') {
      throw new WhiteboardVersionMissingError('The pinned Whiteboard version is not user-owned.');
    }
    return {
      refs,
      userMarkdown: userVersion.content,
      modelMarkdown: working.content,
    };
  });
}

/** Apply model content, mutation receipt, and assistant latest-ref atomically. */
export function applyWhiteboardModelMutation(
  input: WhiteboardModelMutationInput,
  options: WhiteboardMutationOptions = {},
): Promise<WhiteboardModelMutationBoundary> {
  return runConversationWhiteboardMutationWithRetry(async ({
    tables,
    candidateCreatedAt,
  }) => {
    const assistant = await tables.messages.get(input.assistantMessageId);
    if (!assistant || assistant.conversationId !== input.conversationId) {
      throw new WhiteboardVersionMissingError(
        'The generation-owned Whiteboard assistant message is unavailable.',
      );
    }
    const currentRefs = parseTurnRefs(assistant.whiteboardRefsJson);
    const mutation = await applyModelWhiteboardContentInTransaction(
      tables,
      input,
      candidateCreatedAt,
    );
    if (!mutation.value.changed) {
      return {
        value: { mutation: mutation.value, refs: currentRefs },
        wrote: false,
      };
    }
    if (!mutation.value.working.id) {
      throw new Error('A changed Whiteboard mutation has no provisional ID.');
    }
    const refs: WhiteboardTurnReferences = {
      ...currentRefs,
      model_latest_board: mutation.value.working.id,
    };
    assistant.whiteboardRefsJson = JSON.stringify(refs);
    await tables.messages.put(assistant);
    return {
      value: { mutation: mutation.value, refs },
      wrote: true,
    };
  }, options);
}

/**
 * Close one model turn and reconcile unanswered Whiteboard results from the
 * durable receipt, using the live message array as the authority.
 */
export function settleWhiteboardModelTurnAndRepair(
  input: SettleWhiteboardModelTurnInput,
  options: WhiteboardMutationOptions = {},
): Promise<WhiteboardTerminalBoundary> {
  const repairCreatedAt = sampleBoundaryClock(options);
  return runModelWhiteboardSettlementMutationWithRetry(
    input,
    async ({ tables, settlement }) => {
      const messages: Message[] = input.messages.map((message) => ({
        ...message,
        tool_calls: message.tool_calls?.map((call) => ({ ...call })),
        whiteboard_refs: message.whiteboard_refs
          ? { ...message.whiteboard_refs }
          : undefined,
      }));
      const assistantIndex = messages.findIndex(
        (message) => message.id === input.assistantMessageId && message.role === 'assistant',
      );
      if (assistantIndex < 0) {
        throw new Error('The terminal Whiteboard owner assistant is unavailable.');
      }

      const assistant = messages[assistantIndex];
      const acceptedWhiteboardCalls = (input.acceptedCalls ?? [])
        .filter((call) => call.name === 'lc_whiteboard');
      const calls = [...(assistant.tool_calls ?? [])];
      for (const call of acceptedWhiteboardCalls) {
        if (!calls.some((candidate) => candidate.id === call.id)) calls.push({ ...call });
      }
      let assistantChanged = calls.length !== (assistant.tool_calls?.length ?? 0);
      assistant.tool_calls = calls.length > 0 ? calls : assistant.tool_calls;

      const originalRefs = assistant.whiteboard_refs;
      if (!originalRefs) {
        throw new Error('The terminal Whiteboard owner has no turn references.');
      }
      const refs: WhiteboardTurnReferences = settlement.retained
        ? { ...originalRefs, model_latest_board: settlement.retained.id }
        : { ...originalRefs };
      if (refs.model_latest_board !== originalRefs.model_latest_board) assistantChanged = true;
      assistant.whiteboard_refs = refs;

      let toolBlockEnd = assistantIndex + 1;
      const resultIndexByCallId = new Map<string, number>();
      while (toolBlockEnd < messages.length && messages[toolBlockEnd].role === 'tool') {
        const result = messages[toolBlockEnd];
        if (result.tool_call_id && !resultIndexByCallId.has(result.tool_call_id)) {
          resultIndexByCallId.set(result.tool_call_id, toolBlockEnd);
        }
        toolBlockEnd += 1;
      }

      const repairCalls = calls.filter((call) => call.name === 'lc_whiteboard');
      const seen = new Set<string>();
      const repairs: Message[] = [];
      const repairedCallIds: string[] = [];
      let resultChanged = false;
      for (const call of repairCalls) {
        if (seen.has(call.id)) continue;
        seen.add(call.id);
        const applied = Boolean(
          settlement.retained
          && settlement.latestToolCallId === call.id,
        );
        const existingResultIndex = resultIndexByCallId.get(call.id);
        if (existingResultIndex !== undefined) {
          // A durable receipt outranks an ordinary aborted/timeout result that
          // raced with generation closure. Preserve already-successful output,
          // but re-pin its refs when collision retry advanced the retained ID.
          // Changed mutations, later reads, and no-op mutations can all expose
          // the same provisional ID, so every such success must follow the
          // final retained reference. Earlier reads of the initial head do not.
          const repinned = repinSuccessfulWhiteboardResult(
            messages[existingResultIndex],
            originalRefs.model_latest_board,
            refs,
          );
          if (repinned) {
            messages[existingResultIndex] = repinned;
            repairedCallIds.push(call.id);
            resultChanged = true;
            continue;
          }
          if (appliedWhiteboardResultEnvelope(messages[existingResultIndex])) continue;
          // Only the latest mutation receipt can prove that a contradictory
          // terminal result should be replaced with a synthesized success.
          if (!applied) continue;
          const existingResult = messages[existingResultIndex];
          messages[existingResultIndex] = {
            ...terminalRepairMessage({
              conversationId: input.conversationId,
              assistantMessageId: input.assistantMessageId,
              callId: call.id,
              createdAt: existingResult.createdAt,
              applied: true,
              refs,
              modelContent: settlement.retained!.content,
              reason: input.reason,
            }),
            id: existingResult.id,
            sortOrder: existingResult.sortOrder,
          };
          repairedCallIds.push(call.id);
          resultChanged = true;
          continue;
        }
        repairs.push(terminalRepairMessage({
          conversationId: input.conversationId,
          assistantMessageId: input.assistantMessageId,
          callId: call.id,
          createdAt: repairCreatedAt + repairs.length,
          applied,
          refs,
          modelContent: settlement.retained?.content ?? '',
          reason: input.reason,
        }));
        repairedCallIds.push(call.id);
      }

      const reconciled = [
        ...messages.slice(0, toolBlockEnd),
        ...repairs,
        ...messages.slice(toolBlockEnd),
      ].map((message, index) => ({ ...message, sortOrder: index + 1 }));
      const messageChanged = assistantChanged || resultChanged || repairs.length > 0;
      const shouldCheckpoint = settlement.settledNow || messageChanged;
      if (shouldCheckpoint) {
        const rows = reconciled.map((message) => messageToStorageRow(
          message,
          input.conversationId,
        ));
        const existing = await tables.messages.bulkGet(rows.map((row) => row.id));
        for (const row of existing) {
          if (row && row.conversationId !== input.conversationId) {
            throw new Error('A reconciled Whiteboard message ID belongs to another conversation.');
          }
        }
        await tables.messages.bulkPut(rows);
        const metadata = await tables.conversationsMeta.get(input.conversationId);
        if (metadata) {
          const latestMessageAt = reconciled.reduce(
            (latest, message) => Math.max(latest, message.createdAt),
            metadata.updatedAt,
          );
          await tables.conversationsMeta.put({
            ...metadata,
            messageCount: reconciled.length,
            updatedAt: latestMessageAt,
          });
        }
      }
      return {
        value: {
          messages: shouldCheckpoint ? reconciled : input.messages,
          settlement,
          repairedCallIds,
        },
        wrote: shouldCheckpoint,
      };
    },
    options,
  );
}

function referencedWhiteboardIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.user_board) ids.add(message.user_board);
    if (!message.whiteboard_refs) continue;
    ids.add(message.whiteboard_refs.user_board);
    ids.add(message.whiteboard_refs.model_initial_board);
    ids.add(message.whiteboard_refs.model_latest_board);
  }
  return ids;
}

function initializationBaselineIds(versions: readonly WhiteboardVersion[]): Set<string> {
  const ids = new Set<string>();
  const user = versions.find((version) => version.owner === 'user');
  const model = versions.find((version) => version.owner === 'model');
  if (user) ids.add(user.id);
  if (model) ids.add(model.id);
  return ids;
}

/**
 * Atomically replace a transcript branch and remove only board state owned by
 * that discarded branch. Retry never consumes pending user state. An enabled
 * edit-and-resend first restores the surviving user head, then applies the
 * normal pending-promotion rule to the retained edit target.
 */
export async function replaceConversationBranch(
  input: ReplaceConversationBranchInput,
  options: WhiteboardMutationOptions = {},
): Promise<ReplacedConversationBranch> {
  const targetIndex = input.conversation.messages.findIndex(
    (message) => message.id === input.messageId,
  );
  if (targetIndex < 0) {
    throw new Error('The message selected for branch replacement is unavailable.');
  }
  const target = input.conversation.messages[targetIndex];
  if (target.role !== 'user') {
    throw new Error('Only a user message can own a retry or edit-and-resend boundary.');
  }

  const removedMessages = input.conversation.messages.slice(targetIndex + 1);
  const removedMessageIds = removedMessages.map((message) => message.id);
  const removedMessageIdSet = new Set(removedMessageIds);
  const removedAssistantIds = new Set(
    removedMessages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.id),
  );
  const retainedTargetTemplate: Message = {
    ...target,
    content: input.next.content,
    attachments: input.next.attachments,
    streaming: false,
    usage: undefined,
    reasoning: undefined,
  };
  const survivingPrefix = input.conversation.messages.slice(0, targetIndex);

  return runConversationWhiteboardMutationWithRetry(async ({
    tables,
    candidateCreatedAt,
  }) => {
    // The collision wrapper can run this callback more than once. Rebuild all
    // mutable attempt-local values so an aborted transaction cannot leak its
    // provisional references into the retry.
    // The user bubble shows the accepted resend time, including after reload.
    const retainedTarget: Message = { ...retainedTargetTemplate, createdAt: candidateCreatedAt };
    const survivingMessages = [...survivingPrefix, retainedTarget];
    // Keep read→write request chains direct inside this rw callback. Nested
    // async query helpers can let fake-indexeddb consider the transaction idle
    // before the following mutation.
    const allVersions = (
      await tables.whiteboardVersions
        .where('conversationId')
        .equals(input.conversation.id)
        .toArray()
    )
      .map(whiteboardVersionFromStorageRow)
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
    const baselineIds = initializationBaselineIds(allVersions);

    // First restore the branch heads. This order is load-bearing for an edit
    // of an older user message: pending comparison must use the last surviving
    // user version, never a user version sourced by a message being discarded.
    const initiallyRequired = referencedWhiteboardIds(survivingMessages);
    for (const id of baselineIds) initiallyRequired.add(id);
    const firstDelete = allVersions
      .filter((version) => version.sourceMessageId !== null)
      .filter((version) => removedMessageIdSet.has(version.sourceMessageId!))
      .filter((version) => !initiallyRequired.has(version.id))
      .map((version) => version.id);
    if (firstDelete.length > 0) {
      await tables.whiteboardVersions.bulkDelete(
        firstDelete.map((versionId): [string, string] => [input.conversation.id, versionId]),
      );
    }
    const modelWorking = await tables.whiteboardWorking.get([
      input.conversation.id,
      'model',
    ]);
    if (
      modelWorking?.assistantMessageId
      && removedAssistantIds.has(modelWorking.assistantMessageId)
    ) {
      await tables.whiteboardWorking.delete([input.conversation.id, 'model']);
    }

    if (input.boundary === 'edit-and-resend' && input.whiteboardEnabled) {
      const promotion = await promotePendingUserWhiteboardInTransaction(
        tables,
        input.conversation.id,
        retainedTarget.id,
        candidateCreatedAt,
      );
      retainedTarget.user_board = promotion.value.version.id;
    }

    // A changed edit-and-resend can replace the retained edit target's prior
    // user version. Preserve it only if another surviving message still
    // references it or it is an initialization baseline.
    const finallyRequired = referencedWhiteboardIds(survivingMessages);
    for (const id of baselineIds) finallyRequired.add(id);
    const secondDelete = allVersions
      .filter((version) => version.sourceMessageId === retainedTarget.id)
      .filter((version) => !finallyRequired.has(version.id))
      .map((version) => version.id);
    if (secondDelete.length > 0) {
      await tables.whiteboardVersions.bulkDelete(
        secondDelete.map((versionId): [string, string] => [input.conversation.id, versionId]),
      );
    }

    const conversation: Conversation = {
      ...input.conversation,
      messages: survivingMessages,
      messageCount: survivingMessages.length,
      updatedAt: candidateCreatedAt,
    };
    await tables.messages.where('conversationId').equals(conversation.id).delete();
    if (survivingMessages.length > 0) {
      await tables.messages.bulkAdd(
        survivingMessages.map((message) => messageToStorageRow(message, conversation.id)),
      );
    }
    await tables.conversationsMeta.put(conversationMetaToStorageRow(conversation));

    return {
      value: {
        conversation,
        removedMessageIds,
        removedVersionIds: [...new Set([...firstDelete, ...secondDelete])],
      },
      // Replacing metadata and messages always changes this transaction.
      wrote: true,
    };
  }, options);
}

/**
 * Persist a prepared clone as one metadata/message/retained-row mutation.
 * Version IDs and tool-call IDs stay conversation-scoped; source message IDs
 * follow the same complete old→new map used for the cloned transcript.
 */
export async function persistClonedConversationData(
  sourceConversationId: string,
  clonedConversation: Conversation,
  messageIdMap: ReadonlyMap<string, string>,
): Promise<ClonedConversationData> {
  return runConversationDataMutation(async (tables) => {
    // Keep the read followed by direct writes in one flat transaction chain;
    // see the fake-indexeddb note in replaceConversationBranch.
    const sourceVersions = (
      await tables.whiteboardVersions
        .where('conversationId')
        .equals(sourceConversationId)
        .toArray()
    )
      .map(whiteboardVersionFromStorageRow)
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));

    const selectedIds = referencedWhiteboardIds(clonedConversation.messages);
    for (const id of initializationBaselineIds(sourceVersions)) selectedIds.add(id);
    const currentUser = sourceVersions.filter((version) => version.owner === 'user').at(-1);
    const currentModel = sourceVersions.filter((version) => version.owner === 'model').at(-1);
    if (currentUser) selectedIds.add(currentUser.id);
    if (currentModel) selectedIds.add(currentModel.id);

    const sourceById = new Map(sourceVersions.map((version) => [version.id, version]));
    for (const id of referencedWhiteboardIds(clonedConversation.messages)) {
      if (!sourceById.has(id)) {
        throw new Error(`The clone references missing Whiteboard version ${id}.`);
      }
    }
    const copiedVersions = sourceVersions
      .filter((version) => selectedIds.has(version.id))
      .map((version): WhiteboardVersion => {
        let sourceMessageId: string | null = null;
        if (version.sourceMessageId !== null) {
          const mappedMessageId = messageIdMap.get(version.sourceMessageId);
          if (!mappedMessageId) {
            throw new Error(
              `The clone cannot remap Whiteboard source message ${version.sourceMessageId}.`,
            );
          }
          sourceMessageId = mappedMessageId;
        }
        return {
          ...version,
          conversationId: clonedConversation.id,
          sourceMessageId,
        };
      });

    await tables.conversationsMeta.add(conversationMetaToStorageRow(clonedConversation));
    if (clonedConversation.messages.length > 0) {
      await tables.messages.bulkAdd(
        clonedConversation.messages.map((message) => (
          messageToStorageRow(message, clonedConversation.id)
        )),
      );
    }
    if (copiedVersions.length > 0) {
      await tables.whiteboardVersions.bulkAdd(
        copiedVersions.map(whiteboardVersionToStorageRow),
      );
    }
    return { copiedVersionIds: copiedVersions.map((version) => version.id) };
  });
}

/**
 * Settle one orphaned provisional row during lazy conversation load. This
 * runs before generic unanswered-tool repair so later recovery can use the
 * durable receipt instead of guessing whether a Whiteboard change applied.
 */
export async function recoverInterruptedWhiteboardState(
  conversationId: string,
  messages: Message[],
): Promise<WhiteboardCrashRecovery> {
  const working = await getModelWhiteboardWorking(conversationId);
  if (!working) {
    return {
      messages,
      settled: false,
      discarded: false,
      latestToolCallId: null,
      repairedCallIds: [],
    };
  }

  const assistant = messages.find(
    (message) => message.id === working.assistantMessageId && message.role === 'assistant',
  );
  if (!assistant) {
    const discarded = await discardModelWhiteboardTurn({
      conversationId,
      generationId: working.generationId,
      assistantMessageId: working.assistantMessageId,
    });
    return {
      messages,
      settled: false,
      discarded,
      latestToolCallId: working.latestToolCallId,
      repairedCallIds: [],
    };
  }

  const terminal = await settleWhiteboardModelTurnAndRepair({
    conversationId,
    generationId: working.generationId,
    assistantMessageId: working.assistantMessageId,
    messages,
    reason: 'generation_ended',
  });
  return {
    messages: terminal.messages,
    settled: terminal.settlement.settledNow,
    discarded: false,
    latestToolCallId: terminal.settlement.latestToolCallId,
    repairedCallIds: terminal.repairedCallIds,
  };
}
