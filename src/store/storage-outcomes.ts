/**
 * Closed-code storage outcome recorder for conversation rows, attachment
 * blobs, localStorage stores, and desktop key-store mutations.
 *
 * Only a closed code and the operation name are kept — never a title,
 * message, path, or exception. The support-report collector reads these
 * from the diagnostic ring; see docs/support-report.md.
 */
import { recordDiagnosticEvent } from '../utils/diagnostic-events.ts';

export type StorageOperation = 'open' | 'hydrate' | 'indexed-read' | 'durable-write';

/** Record a storage outcome at its normalized boundary. */
export function recordStorageOutcome(operation: StorageOperation, ok: boolean): void {
  const codes = {
    open: ['storage-open-ok', 'storage-open-failed'],
    hydrate: ['storage-hydrate-ok', 'storage-hydrate-failed'],
    'indexed-read': ['storage-read-ok', 'storage-read-failed'],
    'durable-write': ['storage-write-ok', 'storage-write-failed'],
  } as const;
  recordDiagnosticEvent({
    subsystem: 'storage',
    operation,
    outcome: ok ? 'ok' : 'error',
    code: codes[operation][ok ? 0 : 1],
  });
}

/** Run one asynchronous durable write and preserve its rejection. */
export async function runObservableDurableWrite<T>(run: () => Promise<T>): Promise<T> {
  try {
    const value = await run();
    recordStorageOutcome('durable-write', true);
    return value;
  } catch (error) {
    recordStorageOutcome('durable-write', false);
    throw error;
  }
}
