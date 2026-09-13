/** A parent-linked AbortSignal with an optional absolute wall-clock deadline. */
export interface ToolRoundLifecycle {
  signal: AbortSignal;
  timeout: Promise<'timeout'>;
  timedOut(): boolean;
  /** Exclude application FIFO wait from the operational deadline. */
  pauseDeadline(): void;
  /** Resume the deadline after the last overlapping FIFO wait ends. */
  resumeDeadline(): void;
  dispose(): void;
}

/**
 * Give every tool round one enforceable parent lifecycle.
 *
 * The returned signal aborts when either the generation is cancelled or the
 * absolute deadline expires. Application FIFO waits pause this round backstop.
 * Per-call deadlines still count visible interaction time. An omitted deadline
 * creates no timer, and its timeout promise stays pending. `dispose()` removes
 * the parent listener and timer once the pool settles so completed rounds
 * retain no resources.
 */
export function createToolRoundLifecycle(
  parent: AbortSignal,
  deadlineMs?: number,
): ToolRoundLifecycle {
  const controller = new AbortController();
  let expired = false;
  let disposed = false;
  let deadline = deadlineMs;
  let pauseDepth = 0;
  let pausedAt: number | undefined;
  let resolveTimeout!: (value: 'timeout') => void;
  const timeout = new Promise<'timeout'>((resolve) => { resolveTimeout = resolve; });

  const onParentAbort = () => controller.abort(parent.reason);
  if (parent.aborted) onParentAbort();
  else parent.addEventListener('abort', onParentAbort, { once: true });

  const expire = () => {
    if (disposed || expired || parent.aborted || pauseDepth > 0) return;
    expired = true;
    controller.abort(new DOMException('Tool round deadline exceeded', 'TimeoutError'));
    resolveTimeout('timeout');
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = () => {
    if (
      deadline === undefined
      || disposed
      || expired
      || parent.aborted
      || pauseDepth > 0
    ) {
      return;
    }
    timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
  };
  armDeadline();

  return {
    signal: controller.signal,
    timeout,
    timedOut: () => expired,
    pauseDeadline: () => {
      if (deadline === undefined || disposed || expired) return;
      pauseDepth += 1;
      if (pauseDepth !== 1) return;
      pausedAt = Date.now();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    resumeDeadline: () => {
      if (deadline === undefined || disposed || expired || pauseDepth === 0) return;
      pauseDepth -= 1;
      if (pauseDepth > 0) return;
      deadline += Math.max(0, Date.now() - (pausedAt ?? Date.now()));
      pausedAt = undefined;
      armDeadline();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      parent.removeEventListener('abort', onParentAbort);
    },
  };
}
