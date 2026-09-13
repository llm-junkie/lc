import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ProviderContractQuery } from '../../modules/llm-client/provider-contracts';
import {
  ServerTokenCountTracker,
  type ServerTokenCountSnapshot,
} from '../../modules/llm-client/server-token-count.ts';

export interface ServerTokenCountInput {
  /** Stable identity of these inputs (conversation, model, target, params). */
  key: string;
  query: ProviderContractQuery;
  generationRequest: Record<string, unknown>;
  apiKey: string;
  /** False suspends work and clears state (e.g. while streaming). */
  enabled: boolean;
  debounceMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Thin React wrapper around `ServerTokenCountTracker` (which owns the
 * debounced, abortable, stale-guarded lifecycle and is unit-tested without
 * a renderer). The caller memoizes `generationRequest` so identity churn
 * alone never refires; the tracker's key check is the second guard.
 * Options are read from the first input and stay fixed for the mount, which
 * matches a meter that never changes its timing configuration.
 */
export function useServerTokenCount(
  input: ServerTokenCountInput | undefined,
): ServerTokenCountSnapshot {
  const [tracker] = useState(() => new ServerTokenCountTracker({
    ...(input?.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input?.debounceMs !== undefined ? { debounceMs: input.debounceMs } : {}),
    ...(input?.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  }));
  const snapshot = useSyncExternalStore(
    (listener: () => void) => tracker.subscribe(listener),
    () => tracker.getSnapshot(),
    () => tracker.getSnapshot(),
  );
  const inputKey = input?.key;
  const inputEnabled = input?.enabled ?? false;
  const inputApiKey = input?.apiKey;
  const inputRequest = input?.generationRequest;
  const inputQuery = input?.query;
  useEffect(() => {
    if (!inputEnabled || !inputKey || !inputApiKey
      || !inputRequest || !inputQuery) {
      tracker.cancel();
      return;
    }
    tracker.request({
      key: inputKey,
      query: inputQuery,
      generationRequest: inputRequest,
      apiKey: inputApiKey,
    });
    // Do not cancel in this effect's cleanup. A render can reconstruct the
    // wrapper/query objects without changing their declared `key`; request()
    // deliberately treats that as the same pending or ready measurement.
    // A changed key supersedes the attempt itself, and the unmount cleanup
    // below owns final cancellation.
  }, [tracker, inputEnabled, inputKey, inputApiKey, inputRequest, inputQuery]);
  useEffect(() => () => tracker.cancel(), [tracker]);
  return snapshot;
}
