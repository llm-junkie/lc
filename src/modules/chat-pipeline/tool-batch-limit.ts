/**
 * Per-round tool-batch policy.
 *
 * The Workspace setting is intentionally used for both sides of the same
 * boundary: it caps how many calls a model may emit in one tool-call round and it
 * sets the executor pool width for an accepted batch.
 */
export const DEFAULT_TOOL_BATCH_LIMIT = 16;
export const MIN_TOOL_BATCH_LIMIT = 1;
export const MAX_TOOL_BATCH_LIMIT = 64;
export const DEFAULT_TOOL_ROUND_LIMIT = 128;
export const MIN_TOOL_ROUND_LIMIT = 1;
export const MAX_TOOL_ROUND_LIMIT = 256;

export function resolveToolBatchLimit(value: number | undefined): number {
  const candidate = typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : DEFAULT_TOOL_BATCH_LIMIT;
  return Math.max(MIN_TOOL_BATCH_LIMIT, Math.min(MAX_TOOL_BATCH_LIMIT, candidate));
}

/**
 * Normalize the persisted round limit at the execution boundary.
 *
 * The UI intentionally offers the narrower 8–256 slider range, while the
 * runtime accepts 1 for focused configurations and tests. Imported or stale
 * state must never turn the round cap into an effectively unbounded value.
 */
export function resolveToolRoundLimit(value: number | undefined): number {
  const candidate = typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : DEFAULT_TOOL_ROUND_LIMIT;
  return Math.max(MIN_TOOL_ROUND_LIMIT, Math.min(MAX_TOOL_ROUND_LIMIT, candidate));
}

export function exceedsToolBatchLimit(callCount: number, limit: number): boolean {
  return callCount > limit;
}

export function formatToolBatchLimitMessage(callCount: number, limit: number): string {
  return `LC rejected a batch of ${callCount} tool calls. The maximum is ${limit}. No calls were executed, and the response ended.`;
}
