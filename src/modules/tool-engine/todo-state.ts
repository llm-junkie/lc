import { z } from 'zod';
import type { Message } from '../../types';
import type { ChatMessage, ContentPart } from '../llm-client/types';
import { normalizeOptionalAbsence } from './argument-normalization.ts';
import { decodeStoredToolResultEnvelope } from './tool-result-content.ts';

export const TODO_TOOL_NAME = 'lc_todo_write';
export const MAX_TODO_ITEMS = 20;
export const MAX_TODO_TITLE_CHARS = 120;
export const MAX_TODO_NOTE_CHARS = 240;
export const MAX_COMPLETION_EVIDENCE_CHARS = 240;
export const MAX_TODO_SNAPSHOT_SCAN_MESSAGES = 4_096;
export const MAX_PROJECTED_BLOCKED_NOTES = 5;
export const MAX_PROJECTED_IN_PROGRESS_NOTES = 1;
export const TODO_PROJECTION_TEXT = Object.freeze({
  start: '[LC current to-do state]',
  savedState: 'This block contains saved LC task state.',
  notRequest: 'It is not a new user request.',
  end: '[End LC current to-do state]',
});

export const TODO_ITEM_SCHEMA = z.object({
  id: z.number()
    .int('id must be an integer. Use one stable positive integer for this task.')
    .positive('id must be positive. Use one stable positive integer for this task.')
    .max(Number.MAX_SAFE_INTEGER, 'id must be a safe integer. Use a smaller positive integer.')
    .describe('Use one stable, unique, positive safe integer. IDs do not need to be sequential.'),
  title: z.string()
    .trim()
    .min(1, 'title must contain text. Add a short action title.')
    .max(MAX_TODO_TITLE_CHARS, `title accepts at most ${MAX_TODO_TITLE_CHARS} characters. Shorten the title.`)
    .describe('Give the task a short action title. LC trims leading and trailing whitespace.'),
  status: z.enum(['not-started', 'in-progress', 'blocked', 'completed'])
    .describe('Use not-started, in-progress, blocked, or completed. Multiple tasks can be in progress.'),
  note: z.string()
    .trim()
    .min(1, 'note must contain text when present. Omit an empty note.')
    .max(MAX_TODO_NOTE_CHARS, `note accepts at most ${MAX_TODO_NOTE_CHARS} characters. Shorten the note.`)
    .optional()
    .describe('Give a short blocker reason when status is blocked. Do not use notes as general working memory.'),
  completion_evidence: z.string()
    .trim()
    .max(
      MAX_COMPLETION_EVIDENCE_CHARS,
      `completion_evidence accepts at most ${MAX_COMPLETION_EVIDENCE_CHARS} characters. Shorten the evidence.`,
    )
    .refine(
      (value) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(value),
      'completion_evidence must contain visible text. Remove invisible-only content or omit the field.',
    )
    .optional()
    .describe('Report a concise model-observed result that supports completed status. LC does not verify this text.'),
}).strict();

export const TODO_WRITE_SCHEMA = z.object({
  todos: z.array(TODO_ITEM_SCHEMA)
    .min(1, 'todos must contain at least one item. Add a todo item and submit the complete list.')
    .max(
      MAX_TODO_ITEMS,
      `todos accepts at most ${MAX_TODO_ITEMS} items. Reduce the complete list to ${MAX_TODO_ITEMS} or fewer items.`,
    )
    .describe('Send the complete task list on every call. A call replaces the prior list.'),
}).strict().superRefine((input, context) => {
  const ids = new Map<number, number>();
  for (let index = 0; index < input.todos.length; index += 1) {
    const todo = input.todos[index];
    const priorIndex = ids.get(todo.id);
    if (priorIndex !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['todos', index, 'id'],
        message: `id ${todo.id} duplicates todos.${priorIndex}.id. Use one unique stable ID for each task.`,
      });
    } else {
      ids.set(todo.id, index);
    }
    if (todo.status === 'blocked' && !todo.note) {
      context.addIssue({
        code: 'custom',
        path: ['todos', index, 'note'],
        message: 'A blocked task requires a short blocker note. Add the reason.',
      });
    }
  }
});

export type TodoWriteInput = z.infer<typeof TODO_WRITE_SCHEMA>;
export type TodoItem = TodoWriteInput['todos'][number];

export const TODO_WRITE_OUTPUT_SCHEMA = z.object({
  completed: z.number().int().min(0).max(MAX_TODO_ITEMS),
  blocked: z.number().int().min(0).max(MAX_TODO_ITEMS),
  total: z.number().int().min(1).max(MAX_TODO_ITEMS),
}).strict();

export type TodoWriteOutput = z.infer<typeof TODO_WRITE_OUTPUT_SCHEMA>;

const TODO_WIRE_SCHEMA = TODO_WRITE_SCHEMA.toJSONSchema();

export function parseTodoWriteInput(value: unknown): TodoWriteInput | undefined {
  const normalized = normalizeOptionalAbsence(value, TODO_WIRE_SCHEMA, TODO_TOOL_NAME);
  const result = TODO_WRITE_SCHEMA.safeParse(normalized);
  return result.success ? result.data : undefined;
}

export function todoCounts(input: TodoWriteInput): TodoWriteOutput {
  return {
    completed: input.todos.filter((todo) => todo.status === 'completed').length,
    blocked: input.todos.filter((todo) => todo.status === 'blocked').length,
    total: input.todos.length,
  };
}

export function missingCompletionEvidenceIds(input: TodoWriteInput): number[] {
  return input.todos
    .filter((todo) => todo.status === 'completed' && !todo.completion_evidence)
    .map((todo) => todo.id);
}

export function completionEvidenceWarning(ids: readonly number[]): string | undefined {
  if (ids.length === 0) return undefined;
  if (ids.length === 1) {
    return `Completed todo ID ${ids[0]} has no completion evidence. Add completion_evidence to make this status transparent.`;
  }
  const groups: string[] = [];
  for (let index = 0; index < ids.length; index += 10) {
    const group = ids.slice(index, index + 10).join(', ');
    groups.push(`Completed todo IDs ${group} ${index === 0 ? '' : 'also '}have no completion evidence.`);
  }
  return `${groups.join(' ')} Add completion_evidence to make these statuses transparent.`;
}

export interface TodoSnapshot extends TodoWriteOutput {
  sourceAssistantId: string;
  sourceMessageIndex: number;
  toolCallId: string;
  callIndex: number;
  todos: TodoWriteInput['todos'];
}

export interface TodoSnapshotIndex {
  latest?: TodoSnapshot;
  ownedByAssistantId: ReadonlyMap<string, TodoSnapshot>;
  effectiveByAssistantId: ReadonlyMap<string, TodoSnapshot>;
  turnSnapshotsByAssistantId: ReadonlyMap<string, readonly TodoSnapshot[]>;
}

function parseStoredTodoCall(argumentsJson: string): TodoWriteInput | undefined {
  try {
    return parseTodoWriteInput(JSON.parse(argumentsJson));
  } catch {
    return undefined;
  }
}

function successfulTodoSnapshot(
  messages: readonly Message[],
  sourceMessageIndex: number,
  callIndex: number,
): TodoSnapshot | undefined {
  const assistant = messages[sourceMessageIndex];
  const call = assistant.tool_calls?.[callIndex];
  if (!call || call.name !== TODO_TOOL_NAME) return undefined;
  const input = parseStoredTodoCall(call.arguments);
  if (!input) return undefined;

  let resultMessage: Message | undefined;
  for (let index = sourceMessageIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (candidate.role === 'user') break;
    if (candidate.role === 'tool' && candidate.tool_call_id === call.id) {
      resultMessage = candidate;
      break;
    }
  }
  if (!resultMessage || resultMessage.tool_is_error === true) return undefined;
  const envelope = decodeStoredToolResultEnvelope(resultMessage.content);
  if (!envelope || envelope.status !== 'ok') return undefined;
  const output = TODO_WRITE_OUTPUT_SCHEMA.safeParse(envelope.data);
  if (!output.success) return undefined;
  const counts = todoCounts(input);
  if (
    output.data.completed !== counts.completed
    || output.data.blocked !== counts.blocked
    || output.data.total !== counts.total
  ) {
    return undefined;
  }

  return {
    sourceAssistantId: assistant.id,
    sourceMessageIndex,
    toolCallId: call.id,
    callIndex,
    todos: input.todos,
    ...counts,
  };
}

function todoListIdSet(snapshot: TodoSnapshot): string {
  return JSON.stringify(snapshot.todos
    .map((todo) => todo.id)
    .sort((leftId, rightId) => leftId - rightId));
}

function isSameTodoIdSet(left: TodoSnapshot, right: TodoSnapshot): boolean {
  return todoListIdSet(left) === todoListIdSet(right);
}

/** Match stable-ID updates while keeping unrelated lists that reuse sequential IDs separate. */
function isSameStableTodoList(left: TodoSnapshot, right: TodoSnapshot): boolean {
  if (!isSameTodoIdSet(left, right)) return false;
  const leftTitles = new Map(left.todos.map((todo) => [todo.id, todo.title]));
  const matchingTitles = right.todos.filter((todo) => leftTitles.get(todo.id) === todo.title).length;
  return matchingTitles * 2 > right.todos.length;
}

function commonTodoTitleSequenceLength(left: TodoSnapshot, right: TodoSnapshot): number {
  let priorRow = new Array<number>(right.todos.length + 1).fill(0);
  for (const leftTodo of left.todos) {
    const nextRow = new Array<number>(right.todos.length + 1).fill(0);
    for (let rightIndex = 0; rightIndex < right.todos.length; rightIndex += 1) {
      nextRow[rightIndex + 1] = leftTodo.title === right.todos[rightIndex].title
        ? priorRow[rightIndex] + 1
        : Math.max(priorRow[rightIndex + 1], nextRow[rightIndex]);
    }
    priorRow = nextRow;
  }
  return priorRow[right.todos.length];
}

/**
 * Recognize a complete-list replacement that grows in place even when the model
 * renumbers later tasks. Only forward growth qualifies so a shorter sub-list is
 * still displayed separately from its parent list.
 */
function isGrowingTodoList(left: TodoSnapshot, right: TodoSnapshot): boolean {
  if (right.todos.length <= left.todos.length) return false;
  const matchingTitles = commonTodoTitleSequenceLength(left, right);
  return matchingTitles * 2 > left.todos.length
    && matchingTitles * 2 >= right.todos.length;
}

/** Resolve todo snapshots in assistant-message and declared call order. */
export function buildTodoSnapshotIndex(
  messages: readonly Message[],
  maxMessages = MAX_TODO_SNAPSHOT_SCAN_MESSAGES,
): TodoSnapshotIndex {
  const startIndex = Math.max(0, messages.length - Math.max(0, maxMessages));
  const owned = new Map<string, TodoSnapshot>();
  const ownedSnapshots = new Map<string, readonly TodoSnapshot[]>();

  for (let messageIndex = startIndex; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    const messageSnapshots: TodoSnapshot[] = [];
    for (let callIndex = 0; callIndex < message.tool_calls.length; callIndex += 1) {
      const snapshot = successfulTodoSnapshot(messages, messageIndex, callIndex);
      if (snapshot) {
        messageSnapshots.push(snapshot);
        owned.set(message.id, snapshot);
      }
    }
    if (messageSnapshots.length > 0) ownedSnapshots.set(message.id, messageSnapshots);
  }

  const effective = new Map<string, TodoSnapshot>();
  const turnSnapshots = new Map<string, readonly TodoSnapshot[]>();
  let latest: TodoSnapshot | undefined;
  let snapshotsInTurn: readonly TodoSnapshot[] = [];
  for (let messageIndex = startIndex; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (message.role === 'user') {
      snapshotsInTurn = [];
      continue;
    }
    if (message.role !== 'assistant') continue;
    const messageSnapshots = ownedSnapshots.get(message.id);
    if (messageSnapshots) {
      const latestLists = [...snapshotsInTurn];
      for (const snapshot of messageSnapshots) {
        const stableSlot = latestLists.findIndex((prior) => isSameStableTodoList(prior, snapshot));
        const priorSlot = stableSlot >= 0
          ? stableSlot
          : latestLists.findIndex((prior) => isGrowingTodoList(prior, snapshot));
        if (priorSlot < 0) {
          latestLists.push(snapshot);
        } else {
          latestLists[priorSlot] = snapshot;
        }
      }
      snapshotsInTurn = latestLists;
    }
    latest = messageSnapshots?.at(-1) ?? latest;
    if (latest) effective.set(message.id, latest);
    if (snapshotsInTurn.length > 0) turnSnapshots.set(message.id, snapshotsInTurn);
  }

  return {
    ...(latest ? { latest } : {}),
    ownedByAssistantId: owned,
    effectiveByAssistantId: effective,
    turnSnapshotsByAssistantId: turnSnapshots,
  };
}

export function requestContainsTodoSnapshotCall(
  messages: readonly ChatMessage[],
  snapshot: TodoSnapshot,
): boolean {
  return messages.some((message) => message.role === 'assistant'
    && message.tool_calls?.some((call) =>
      call.id === snapshot.toolCallId
      && call.function.name === TODO_TOOL_NAME));
}

/** Resolve a projection only when the finalized request hides its source call. */
export function resolveTodoRequestProjection(
  storedMessages: readonly Message[],
  requestMessages: readonly ChatMessage[],
): string | undefined {
  const snapshot = buildTodoSnapshotIndex(storedMessages).latest;
  if (!snapshot || requestContainsTodoSnapshotCall(requestMessages, snapshot)) return undefined;
  return formatTodoRequestProjection(snapshot);
}

export function todoOmittedNotesNotice(count: number): string {
  return `LC omitted ${count} blocked note(s) from this request. Use lc_tool_history to read the original update.`;
}

export function todoOmittedInProgressNotesNotice(count: number): string {
  return `LC omitted ${count} in-progress note(s) from this request. Use lc_tool_history to read the original update.`;
}

/** Format saved todo data for a request whose source call was archived. */
export function formatTodoRequestProjection(snapshot: TodoSnapshot): string | undefined {
  if (snapshot.completed === snapshot.total) return undefined;
  let blockedNotes = 0;
  let omittedBlockedNotes = 0;
  let inProgressNotes = 0;
  let omittedInProgressNotes = 0;
  const rows = snapshot.todos.map((todo) => {
    const projected: Record<string, unknown> = {
      id: todo.id,
      title: todo.title,
      status: todo.status,
    };
    if (todo.status === 'in-progress' && todo.note) {
      if (inProgressNotes < MAX_PROJECTED_IN_PROGRESS_NOTES) {
        projected.note = todo.note;
        inProgressNotes += 1;
      } else {
        omittedInProgressNotes += 1;
      }
    } else if (todo.status === 'blocked' && todo.note) {
      if (blockedNotes < MAX_PROJECTED_BLOCKED_NOTES) {
        projected.note = todo.note;
        blockedNotes += 1;
      } else {
        omittedBlockedNotes += 1;
      }
    }
    return JSON.stringify(projected);
  });

  return [
    TODO_PROJECTION_TEXT.start,
    TODO_PROJECTION_TEXT.savedState,
    TODO_PROJECTION_TEXT.notRequest,
    ...rows.map((row) => `- ${row}`),
    ...(omittedBlockedNotes > 0
      ? [todoOmittedNotesNotice(omittedBlockedNotes)]
      : []),
    ...(omittedInProgressNotes > 0
      ? [todoOmittedInProgressNotesNotice(omittedInProgressNotes)]
      : []),
    TODO_PROJECTION_TEXT.end,
  ].join('\n');
}

export function appendTodoProjectionToContent(
  content: ChatMessage['content'],
  projection: string,
): ChatMessage['content'] {
  if (typeof content === 'string') return `${content}\n\n${projection}`;
  const suffix: ContentPart = { type: 'text', text: projection };
  return [...content, suffix];
}

export function todoSnapshotToPlainText(snapshot: TodoSnapshot): string {
  return snapshot.todos.map((todo) => {
    const note = todo.note
      ? ` • Note: ${todo.note}`
      : '';
    const evidence = todo.completion_evidence
      ? ` • Completion evidence: ${todo.completion_evidence}`
      : '';
    return `${todo.id}. [${todo.status}] ${todo.title}${note}${evidence}`;
  }).join('\n');
}
