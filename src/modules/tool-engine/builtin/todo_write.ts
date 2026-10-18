import { TODO_WRITE_GUIDANCE } from '../tool-guidance.ts';
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
  description: TODO_WRITE_GUIDANCE.essential,
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
