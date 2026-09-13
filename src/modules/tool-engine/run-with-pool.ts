/**
 * Bounded-concurrency async worker pool.
 *
 * Runs `fn` on each item, with at most the normalized limit of workers.
 * Results are accumulated in-order in the returned array.  An optional
 * `onItem` callback fires immediately as each result completes (used
 * by the orchestrator for eager UI updates).
 *
 * Phase 0B.11 fix: uses Promise.allSettled instead of Promise.all so
 * one worker's error does not abandon the others.  If any workers
 * reject, an aggregate Error is thrown after ALL workers have settled.
 *
 * Non-finite values and values below one use the default of eight workers.
 * Values above 64 are clamped to 64. Invalid configuration does not reject
 * the operation; the normalized limit applies at the execution boundary.
 *
 * Extracted from runner.ts for testability (no Tauri deps).
 */

/** Valid concurrency range per Phase 1.6. */
const MAX_CONCURRENCY = 64;
const DEFAULT_CONCURRENCY = 8;

/**
 * Normalise a concurrency value to the valid 1–64 range.
 * Non-finite values and values below one resolve to the default (8).
 * Values above 64 are clamped to 64.
 */
export function normalizeConcurrency(raw: number): number {
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_CONCURRENCY;
  return Math.min(raw, MAX_CONCURRENCY);
}

export async function runWithPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onItem?: (result: R, index: number) => void,
): Promise<R[]> {
  // Phase 1.6: clamp concurrency at the execution boundary.
  const effectiveLimit = normalizeConcurrency(limit);

  const out: R[] = new Array(items.length);
  let cursor = 0;
  const itemErrors: unknown[] = [];
  const callbackErrors: unknown[] = [];
  const workers = Array.from(
    { length: Math.min(effectiveLimit, items.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        try {
          out[i] = await fn(items[i], i);
        } catch (error) {
          // A rejected item must not retire this worker and leave later,
          // already-accepted indices unvisited.
          itemErrors.push(error);
          continue;
        }
        // A UI/store observer must not terminate a worker before the remaining
        // accepted calls have even been claimed.  Record callback failures and
        // report them only after every worker has drained its input.
        try {
          onItem?.(out[i], i);
        } catch (error) {
          callbackErrors.push(error);
        }
      }
    },
  );

  const settled = await Promise.allSettled(workers);
  const errors = settled
    .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
    .map((s) => s.reason)
    .concat(itemErrors, callbackErrors);

  if (errors.length > 0) {
    const msg = errors.length === 1
      ? String(errors[0])
      : `${errors.length} tool workers failed:\n${errors.map((e) => `  - ${String(e)}`).join('\n')}`;
    throw new Error(msg);
  }

  return out;
}
