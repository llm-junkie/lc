import type { ToolCallRecord, ToolResultEnvelope } from './types';
import { addCatalogRecovery } from './tool-guidance.ts';
import { WHITEBOARD_ISSUES, WHITEBOARD_TOOL_NAME } from './whiteboard.ts';

/**
 * The governor runs after tool-call-id admission, so every entry has one
 * durable provider result slot. Validation failures stay in the input because
 * malformed exact-name Whiteboard calls still participate in the batch rule.
 */
export interface WhiteboardGovernableCall {
  call: ToolCallRecord;
  parsed?: unknown;
  error?: unknown;
}

function batchConflictEnvelope(): ToolResultEnvelope<never> {
  return {
    status: 'error',
    issues: [addCatalogRecovery(
      WHITEBOARD_TOOL_NAME,
      { ...WHITEBOARD_ISSUES.whiteboard_batch_conflict },
    )],
    warnings: [],
  };
}

/**
 * Decide one-batch Whiteboard admission in stable batch-index order.
 *
 * One exact lc_whiteboard call may run beside any number of other tools. If
 * two or more surviving exact-name calls are declared, every one receives the
 * same terminal conflict result and none may execute. Invalid exact-name calls
 * count too; aliases and misspellings do not.
 */
export function governWhiteboardCalls(
  calls: readonly WhiteboardGovernableCall[],
): ReadonlyMap<ToolCallRecord, ToolResultEnvelope<never>> {
  const whiteboardCalls = calls.filter(
    (entry) => entry.call.name === WHITEBOARD_TOOL_NAME,
  );
  const results = new Map<ToolCallRecord, ToolResultEnvelope<never>>();
  if (whiteboardCalls.length <= 1) return results;

  for (const entry of whiteboardCalls) {
    results.set(entry.call, batchConflictEnvelope());
  }
  return results;
}
