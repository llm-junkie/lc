/**
 * todo_write — maintain a structured task list.
 *
 * Pure JS (no Rust round-trip). The list persists in the
 * conversation history — each call's result is a role: 'tool'
 * message that the model sees on subsequent turns. This is
 * intentionally minimal: no persistence outside the conversation,
 * no global state, just a structured checklist the model owns.
 */
import type { ToolHandler, ToolResultEnvelope } from '../types';
import type { JsonSchema } from '../../llm-client/types';
import {
  completionEvidenceWarning,
  missingCompletionEvidenceIds,
  TODO_WRITE_SCHEMA,
  todoCounts,
  type TodoWriteInput,
  type TodoWriteOutput,
} from '../todo-state.ts';

const CACHED_SCHEMA = Object.freeze(TODO_WRITE_SCHEMA.toJSONSchema()) as unknown as JsonSchema;

export const todoWrite: ToolHandler<TodoWriteInput, ToolResultEnvelope<TodoWriteOutput>> = {
  name: 'lc_todo_write',
  description:
    'Use lc_todo_write for multi-step work. Do not use it for a trivial one-step action.\n' +
    'Send the complete list on every call. A call replaces the prior list.\n' +
    'Preserve each existing task ID when you update or reorder the list.\n' +
    'Use unique positive integer IDs. IDs do not need to be sequential.\n' +
    'Mark each active task in progress. Mark completed work promptly.\n' +
    'Add completion_evidence to completed tasks when a result supports them. LC warns when completed tasks omit it.\n' +
    'Use blocked with a short reason when work cannot continue.\n' +
    'Do not use notes as general working memory.\n' +
    'A list can contain from 1 through 20 todos.',
  uiDescription: 'Track a structured task list for multi-step work.',
  input: TODO_WRITE_SCHEMA,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input) => {
    const warning = completionEvidenceWarning(missingCompletionEvidenceIds(input));
    return {
      status: 'ok',
      data: todoCounts(input),
      issues: [],
      warnings: warning ? [warning] : [],
    };
  },
};
