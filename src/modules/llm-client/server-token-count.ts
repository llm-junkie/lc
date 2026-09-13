/**
 * Lifecycle owner for one server token-count preflight: debounce, abort,
 * and stale-result protection around `requestServerTokenCount`. Framework-
 * agnostic so the state machine is unit-testable without a renderer; the
 * React hook in `useServerTokenCount.ts` is a thin subscriber.
 *
 * Privacy: only the caller-supplied `key` string and the numeric result are
 * retained. The API key and the generation request cross into the fetch
 * call and are never stored, logged, or exposed through the snapshot.
 *
 * Failure policy: any terminal failure (unsupported route, HTTP error,
 * malformed body, timeout, abort, transport error) returns the tracker to
 * `idle` so the meter falls back to its local estimate. A superseded
 * attempt that settles late is dropped without touching current state.
 */

import type { ProviderContractQuery } from './provider-contracts';
import { requestServerTokenCount } from './token-count.ts';

export type ServerTokenCountStatus = 'idle' | 'pending' | 'ready';

export interface ServerTokenCountSnapshot {
  status: ServerTokenCountStatus;
  /** Valid only when `status` is `ready`. */
  inputTokens?: number;
  /** Exact contract the ready value was measured against. */
  contractId?: string;
}

export interface ServerTokenCountDesired {
  /** Stable identity of these inputs; only a newer key supersedes. */
  key: string;
  query: ProviderContractQuery;
  generationRequest: Record<string, unknown>;
  apiKey: string;
}

export interface ServerTokenCountTrackerOptions {
  fetchImpl?: typeof fetch;
  /** Idle delay before firing; 0 disables the wait. Default 800. */
  debounceMs?: number;
  /** Per-attempt fetch timeout. Default 15000. */
  timeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

type Listener = () => void;

const DEFAULT_DEBOUNCE_MS = 800;
const DEFAULT_TIMEOUT_MS = 15000;

export class ServerTokenCountTracker {
  private readonly fetchImpl?: typeof fetch;
  private readonly debounceMs: number;
  private readonly timeoutMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly listeners = new Set<Listener>();
  private snapshot: ServerTokenCountSnapshot = { status: 'idle' };
  private currentKey: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt: AbortController | undefined;

  constructor(options: ServerTokenCountTrackerOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Browser timers require the global receiver, even when stored on a class.
    this.setTimeoutFn = options.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getSnapshot(): ServerTokenCountSnapshot {
    return this.snapshot;
  }

  /**
   * Request a count for these inputs, or clear to `idle` when undefined.
   * A repeated key while `pending` or `ready` is a no-op so renders do not
   * refetch; a repeated key while `idle` retries (e.g. after a failure).
   */
  request(desired: ServerTokenCountDesired | undefined): void {
    if (desired === undefined) {
      this.cancel();
      return;
    }
    if (desired.key === this.currentKey && this.snapshot.status !== 'idle') return;
    this.stopAttempt();
    this.currentKey = desired.key;
    this.setSnapshot({ status: 'pending' });
    if (this.debounceMs <= 0) {
      void this.fire(desired);
      return;
    }
    this.timer = this.setTimeoutFn(() => {
      this.timer = undefined;
      void this.fire(desired);
    }, this.debounceMs);
  }

  /** Abort in flight work and return to `idle`. Safe to call anytime. */
  cancel(): void {
    this.stopAttempt();
    this.currentKey = undefined;
    if (this.snapshot.status !== 'idle'
      || this.snapshot.inputTokens !== undefined
      || this.snapshot.contractId !== undefined) {
      this.setSnapshot({ status: 'idle' });
    }
  }

  private stopAttempt(): void {
    if (this.timer !== undefined) {
      this.clearTimeoutFn(this.timer);
      this.timer = undefined;
    }
    if (this.attempt) {
      this.attempt.abort();
      this.attempt = undefined;
    }
  }

  private setSnapshot(snapshot: ServerTokenCountSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }

  private async fire(desired: ServerTokenCountDesired): Promise<void> {
    const controller = new AbortController();
    this.attempt = controller;
    let result: Awaited<ReturnType<typeof requestServerTokenCount>>;
    try {
      result = await requestServerTokenCount({
        query: desired.query,
        generationRequest: desired.generationRequest,
        apiKey: desired.apiKey,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        signal: controller.signal,
        timeoutMs: this.timeoutMs,
      });
    } catch {
      // `requestServerTokenCount` never throws by contract; a throw here
      // means the injected fetch violated `fetch` semantics. Never surface
      // internals — fall back to the local estimate like any failure.
      result = { ok: false, error: { kind: 'transport', message: 'count failed' } };
    }
    if (this.attempt !== controller || desired.key !== this.currentKey) return;
    this.attempt = undefined;
    if (result.ok) {
      this.setSnapshot({ status: 'ready', inputTokens: result.inputTokens, contractId: result.route.contractId });
    } else {
      this.setSnapshot({ status: 'idle' });
    }
  }
}
