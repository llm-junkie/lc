/**
 * Application-wide ownership for user interactions requested by generations.
 *
 * Permission and ask-user prompts share this queue. React modal components are
 * deliberately only presentation hosts: ordering, abort removal, and stale
 * generation fences live here so a newly arriving prompt can never displace a
 * visible prompt owned by another conversation.
 */

export type GenerationInteractionKind = 'permission' | 'ask-user';

export interface GenerationInteractionIdentity {
  interactionId: string;
  conversationId: string;
  conversationTitle: string;
  generationId: string;
  assistantMessageId: string;
  toolCallId: string;
  kind: GenerationInteractionKind;
  requestedAt: number;
}

export interface InteractionQueueView {
  version: number;
  visible?: Readonly<GenerationInteractionIdentity>;
  queuedByConversation: ReadonlyMap<string, number>;
}

export interface EnqueueGenerationInteraction<Result> {
  identity: GenerationInteractionIdentity;
  signal: AbortSignal;
  /** Rechecked at enqueue, promotion, and immediately before delivery. */
  validateOwnership: () => boolean;
  /** Receives an interaction-owned signal that also aborts at the attention cap. */
  present: (presentationSignal: AbortSignal) => Promise<Result>;
  abortedResult: () => Result;
  unavailableResult: () => Result;
  /** Separate abandoned-attention ceiling; queued time has no tool deadline. */
  absoluteAttentionMs?: number;
  /** Optional execution-budget hooks; only time before visibility is excluded. */
  onQueueWaitStart?: () => void;
  onQueueWaitEnd?: () => void;
}

interface QueueEntry<Result> extends EnqueueGenerationInteraction<Result> {
  settled: boolean;
  resolve: (result: Result) => void;
  detachAbort: () => void;
  attentionTimer: ReturnType<typeof setTimeout>;
  queueWaitEnded: boolean;
  presentationController: AbortController;
}

const DEFAULT_ABSOLUTE_ATTENTION_MS = 30 * 60_000;
const queue: Array<QueueEntry<unknown>> = [];
const listeners = new Set<() => void>();
let visible: QueueEntry<unknown> | undefined;
let version = 0;

function publish(): void {
  version += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One diagnostic/UI listener cannot break interaction delivery.
    }
  }
}

export function subscribeToInteractionQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getInteractionQueueVersion(): number {
  return version;
}

export function getInteractionQueueView(): InteractionQueueView {
  const queuedByConversation = new Map<string, number>();
  if (visible) queuedByConversation.set(visible.identity.conversationId, 1);
  for (const entry of queue) {
    queuedByConversation.set(
      entry.identity.conversationId,
      (queuedByConversation.get(entry.identity.conversationId) ?? 0) + 1,
    );
  }
  return {
    version,
    ...(visible ? { visible: visible.identity } : {}),
    queuedByConversation,
  };
}

function removeQueued(entry: QueueEntry<unknown>): void {
  const index = queue.indexOf(entry);
  if (index >= 0) queue.splice(index, 1);
}

function endQueueWait(entry: QueueEntry<unknown>): void {
  if (entry.queueWaitEnded) return;
  entry.queueWaitEnded = true;
  try {
    entry.onQueueWaitEnd?.();
  } catch {
    // Budget accounting is advisory to presentation and cannot break delivery.
  }
}

function settle<Result>(entry: QueueEntry<Result>, result: Result): void {
  if (entry.settled) return;
  entry.settled = true;
  clearTimeout(entry.attentionTimer);
  entry.detachAbort();
  entry.presentationController.abort();
  endQueueWait(entry as QueueEntry<unknown>);
  removeQueued(entry as QueueEntry<unknown>);
  if (visible === entry) visible = undefined;
  entry.resolve(result);
  publish();
  queueMicrotask(promoteNext);
}

function promoteNext(): void {
  if (visible) return;
  const entry = queue.shift();
  if (!entry) return;
  if (entry.signal.aborted) {
    settle(entry, entry.abortedResult());
    return;
  }
  if (!entry.validateOwnership()) {
    settle(entry, entry.unavailableResult());
    return;
  }

  visible = entry;
  endQueueWait(entry);
  publish();
  void entry.present(entry.presentationController.signal)
    .then((result) => {
      if (entry.signal.aborted) settle(entry, entry.abortedResult());
      else if (!entry.validateOwnership()) settle(entry, entry.unavailableResult());
      else settle(entry, result);
    })
    .catch(() => settle(entry, entry.unavailableResult()));
}

/** Enqueue one prompt in strict application arrival order. */
export function enqueueGenerationInteraction<Result>(
  request: EnqueueGenerationInteraction<Result>,
): Promise<Result> {
  if (request.signal.aborted) return Promise.resolve(request.abortedResult());
  if (!request.validateOwnership()) return Promise.resolve(request.unavailableResult());

  return new Promise<Result>((resolve) => {
    const onAbort = () => settle(entry, entry.abortedResult());
    const entry: QueueEntry<Result> = {
      ...request,
      settled: false,
      queueWaitEnded: false,
      resolve,
      detachAbort: () => request.signal.removeEventListener('abort', onAbort),
      presentationController: new AbortController(),
      attentionTimer: setTimeout(
        () => settle(entry, entry.unavailableResult()),
        request.absoluteAttentionMs ?? DEFAULT_ABSOLUTE_ATTENTION_MS,
      ),
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    try {
      request.onQueueWaitStart?.();
    } catch {
      // Budget accounting is advisory to presentation and cannot break delivery.
    }
    queue.push(entry as QueueEntry<unknown>);
    publish();
    queueMicrotask(promoteNext);
  });
}

/** Test seam; production drains through normal generation cancellation. */
export function resetInteractionCoordinatorForTests(): void {
  const entries = [...queue, ...(visible ? [visible] : [])];
  queue.length = 0;
  visible = undefined;
  for (const entry of entries) {
    if (!entry.settled) settle(entry, entry.unavailableResult());
  }
  publish();
}
