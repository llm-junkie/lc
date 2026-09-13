import {
  finalizeStreamingOwner,
  getStreamingOwner,
  handoffGenerationBlockingOperationToStreaming,
  releaseStreamingOwnerWhenDurable,
  unmarkStreaming,
  useConversations,
  type StreamOwner,
} from '../../store/conversations.ts';
import {
  cancelGenerationSession,
  endGenerationSession,
  getGenerationSessionView,
  setGenerationSessionPhase,
  setGenerationSessionTps,
  startCommittedGenerationSession,
} from '../../modules/chat-pipeline/generation-session-manager.ts';

export interface ActiveGenerationHandle extends StreamOwner {
  controller: AbortController;
}

export interface StartedGenerationSession {
  owner: ReturnType<typeof handoffGenerationBlockingOperationToStreaming>;
  controller: AbortController;
}

const FAILED_GENERATION_FINISH_REASONS = new Set([
  'error',
  'disconnected',
  'infinite_reasoning_loop',
  'tool_batch_limit',
  'tool_round_limit',
  'tool_timeout',
]);

/** Abort one session and synchronously claim its terminal store transition. */
export function stopGenerationSession(
  conversationId: string,
  expectedGenerationId?: string,
): ReturnType<typeof cancelGenerationSession> {
  const cancelled = cancelGenerationSession(conversationId, expectedGenerationId);
  if (!cancelled) return undefined;
  finalizeStreamingOwner(cancelled.conversationId, cancelled.generationId, {
    meta: { finish_reason: 'disconnected' },
  });
  return cancelled;
}

export async function settleGenerationSessionAfterTerminalFlush(
  conversationId: string,
  generationId: string,
): Promise<void> {
  const settlingSession = getGenerationSessionView(conversationId);
  const deliberatelyStopped = settlingSession?.generationId === generationId
    && settlingSession.phase === 'stopping';
  setGenerationSessionPhase(conversationId, generationId, 'finalizing');
  const released = await releaseStreamingOwnerWhenDurable(conversationId, generationId);
  const owner = getStreamingOwner(conversationId);

  if (released || !owner || owner.generationId !== generationId) {
    const state = useConversations.getState();
    const session = getGenerationSessionView(conversationId);
    const assistant = session
      ? state.byId[conversationId]?.messages.find(
          (message) => message.id === session.assistantMessageId,
        )
      : undefined;
    const finishReason = assistant?.meta?.finish_reason;
    const failed = session?.phase === 'failed'
      || Boolean(assistant?.meta?.error_message)
      || (!deliberatelyStopped
        && finishReason !== undefined
        && FAILED_GENERATION_FINISH_REASONS.has(finishReason));
    endGenerationSession(conversationId, generationId, {
      unread: state.activeId !== conversationId,
      outcome: failed ? 'failed' : 'completed',
    });
    return;
  }

  // Keep the durable owner and capacity slot after a failed terminal write.
  // The same control can retry this boundary without admitting a replacement.
  setGenerationSessionTps(conversationId, generationId, null);
  setGenerationSessionPhase(conversationId, generationId, 'failed');
}

export type GenerationStopRequest =
  | { outcome: 'idle' | 'stopped' }
  | { outcome: 'retrying-terminal-write'; settlement: Promise<void> };

/** Stop a live run, or retry the terminal write for a failed run. */
export function requestGenerationStop(
  conversationId: string,
  expectedGenerationId?: string,
): GenerationStopRequest {
  const session = getGenerationSessionView(conversationId);
  if (!session) return { outcome: 'idle' };
  if (expectedGenerationId !== undefined && session.generationId !== expectedGenerationId) {
    return { outcome: 'idle' };
  }
  if (session.phase === 'failed') {
    setGenerationSessionPhase(conversationId, session.generationId, 'finalizing');
    return {
      outcome: 'retrying-terminal-write',
      settlement: settleGenerationSessionAfterTerminalFlush(
        conversationId,
        session.generationId,
      ),
    };
  }
  if (session.phase === 'finalizing') return { outcome: 'idle' };
  return {
    outcome: stopGenerationSession(conversationId, session.generationId)
      ? 'stopped'
      : 'idle',
  };
}

/**
 * Atomically hand a committed admission to the store owner, then register its
 * runtime session. Configured capacity was rechecked before transcript
 * mutation; registration retains the hard maximum and owner fences.
 */
export async function handoffAndRegisterGenerationSession(
  admissionOperationId: string,
  conversationId: string,
  assistantMessageId: string,
): Promise<StartedGenerationSession> {
  const owner = handoffGenerationBlockingOperationToStreaming(
    admissionOperationId,
    conversationId,
    assistantMessageId,
  );
  const controller = new AbortController();
  try {
    startCommittedGenerationSession({ ...owner, controller });
  } catch (error) {
    finalizeStreamingOwner(conversationId, owner.generationId, {
      meta: { finish_reason: 'disconnected' },
    });
    const released = await releaseStreamingOwnerWhenDurable(
      conversationId,
      owner.generationId,
    );
    if (!released) {
      // The terminal task was queued before this synchronous fallback drops
      // ownership. There was never a model request, so keeping an unreachable
      // capacity slot is less safe than journal-based restart recovery.
      unmarkStreaming(conversationId, owner.generationId);
    }
    throw error;
  }
  return { owner, controller };
}

export interface GenerationExitTarget {
  addEventListener(type: 'pagehide' | 'beforeunload', listener: () => void): void;
  removeEventListener(type: 'pagehide' | 'beforeunload', listener: () => void): void;
}

/** Abort, terminalize, and release an owner when its React/UI host is leaving. */
export function terminateGenerationForExit(active: ActiveGenerationHandle): void {
  // Exit cleanup is best effort. One failed operation must not prevent the
  // remaining operations for this owner or the owners that follow it.
  try {
    active.controller.abort();
  } catch {
    // Continue to the terminal store transition.
  }
  try {
    finalizeStreamingOwner(active.conversationId, active.generationId, {
      meta: { finish_reason: 'disconnected' },
    });
  } catch {
    // Continue to the synchronous ownership release.
  }
  try {
    unmarkStreaming(active.conversationId, active.generationId);
  } catch {
    // A hard exit cannot wait for another recovery path.
  }
}

/**
 * Application-level page-exit handling for every live session.
 *
 * Owned by the application, not by `ChatView`. A response's lifetime is not
 * the chat component's lifetime — that component unmounts whenever the user
 * navigates, and once sessions can outlive the selected conversation a handler
 * owned by the foreground view would terminalize the wrong set.
 *
 * The pass is idempotent and snapshots the registry first, because
 * terminalizing mutates it.
 *
 * Note what this cannot promise. Aborting and claiming the terminal transition
 * are synchronous, but the durable writes they queue are not, and a hard exit
 * does not wait for IndexedDB. The generation journal is what makes the
 * outcome recoverable when those writes never land.
 */
export function installApplicationGenerationExitCleanup(
  listSessions: () => readonly ActiveGenerationHandle[],
  endSession: (conversationId: string, generationId: string) => void,
  target: GenerationExitTarget = window,
): () => void {
  const stop = () => {
    for (const active of listSessions()) {
      try {
        endSession(active.conversationId, active.generationId);
      } catch {
        // Continue with store cleanup and the remaining session snapshot.
      }
      terminateGenerationForExit(active);
    }
  };
  target.addEventListener('pagehide', stop);
  target.addEventListener('beforeunload', stop);
  return () => {
    target.removeEventListener('pagehide', stop);
    target.removeEventListener('beforeunload', stop);
  };
}
