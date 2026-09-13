/**
 * Generation journal — crash recovery for interrupted responses.
 *
 * A generation writes one durable row when it is admitted and deletes that row
 * when it terminalizes cleanly. A row still present at startup is therefore
 * evidence that LC stopped in the middle of an answer.
 *
 * Why this is needed even with one conversation at a time:
 *
 *   `Message.streaming` is deliberately not persisted, and the existing
 *   unanswered-tool recovery only sees turns that actually issued tool calls.
 *   A plain-text answer cut off by a crash therefore reloaded looking exactly
 *   like a finished one. Nothing in the durable graph said otherwise.
 *
 * Recovery is split deliberately:
 *
 *   **At startup**, journal-discovered and cheap. Every row is read, the one
 *   assistant row it names is patched to an interrupted finish state through a
 *   targeted update, and the conversation is flagged for attention. No
 *   transcript is loaded — a background conversation must be repairable
 *   without pulling its whole history into memory.
 *
 *   **On first open**, transcript-lazy. The existing unanswered-tool and
 *   Whiteboard repairs run inside the normal load path, and only then is the
 *   journal row compare-and-deleted.
 *
 * A row is kept whenever repair could not be completed, so a retry is
 * idempotent rather than lossy. A row is deleted early only when its
 * conversation or assistant message no longer exists at all.
 */
import {
  clearGenerationRun,
  loadGenerationRuns,
  markGenerationRunInterrupted,
  recordGenerationRun,
  type GenerationRunRow,
  type InterruptedRunOutcome,
} from './db.ts';

/** Finish reason written for an answer LC never got to complete. */
export const INTERRUPTED_FINISH_REASON = 'interrupted';

export interface JournalRecoveryResult {
  /** Conversations whose assistant row was marked interrupted. */
  interrupted: string[];
  /** Conversations whose journaled answer had in fact completed. */
  alreadyComplete: string[];
  /** Journal rows deleted because their conversation or message was gone. */
  orphaned: string[];
  /** Conversations still needing lazy transcript repair on first open. */
  pendingRepair: string[];
}

/** Runtime view of which conversations were interrupted by the last exit. */
const conversationsNeedingRecovery = new Set<string>();

/** Whether this conversation still carries unacknowledged crash evidence. */
export function conversationNeedsRecovery(conversationId: string): boolean {
  return conversationsNeedingRecovery.has(conversationId);
}

/** Every conversation flagged by the last startup recovery pass. */
export function conversationsAwaitingRecovery(): string[] {
  return [...conversationsNeedingRecovery];
}

/** Drop the attention flag once the user has seen the conversation. */
export function acknowledgeConversationRecovery(conversationId: string): void {
  conversationsNeedingRecovery.delete(conversationId);
}

/** Test seam: forget every flag without touching durable rows. */
export function resetRecoveryFlagsForTests(): void {
  conversationsNeedingRecovery.clear();
}

/**
 * Open a generation's journal ownership.
 *
 * Prefer writing the row inside the same transaction as the assistant
 * placeholder when the caller already has one; this standalone form exists for
 * paths that admit without a cross-table transaction.
 */
export function openGenerationRun(
  conversationId: string,
  generationId: string,
  assistantMessageId: string,
  state: GenerationRunRow['state'] = 'running',
): Promise<void> {
  return recordGenerationRun({
    conversationId,
    generationId,
    assistantMessageId,
    state,
    startedAt: Date.now(),
  });
}

/**
 * Close a generation's journal ownership.
 *
 * Compare-and-delete on `generationId`, so a finalizer that lost a race to a
 * replacement generation cannot delete the newer run's evidence.
 */
export function closeGenerationRun(
  conversationId: string,
  generationId: string,
): Promise<boolean> {
  return clearGenerationRun(conversationId, generationId);
}

/**
 * Startup pass over the whole journal.
 *
 * Reads every row rather than assuming the live capacity bound: an
 * interrupted recovery can leave older rows behind, and a row skipped because
 * the table "should" hold at most three would never be repaired.
 */
export async function recoverJournaledGenerations(): Promise<JournalRecoveryResult> {
  const result: JournalRecoveryResult = {
    interrupted: [],
    alreadyComplete: [],
    orphaned: [],
    pendingRepair: [],
  };

  let rows: GenerationRunRow[];
  try {
    rows = await loadGenerationRuns();
  } catch {
    // A journal that cannot be read is not a reason to block startup. The
    // rows survive, so the next launch tries again.
    return result;
  }

  for (const row of rows) {
    let outcome: InterruptedRunOutcome;
    try {
      outcome = await markGenerationRunInterrupted(
        row.conversationId,
        row.generationId,
        INTERRUPTED_FINISH_REASON,
      );
    } catch {
      // Keep the row and the flag: an unrepaired generation must stay visible.
      conversationsNeedingRecovery.add(row.conversationId);
      result.pendingRepair.push(row.conversationId);
      continue;
    }

    switch (outcome) {
      case 'marked':
        conversationsNeedingRecovery.add(row.conversationId);
        result.interrupted.push(row.conversationId);
        result.pendingRepair.push(row.conversationId);
        break;
      case 'already-final':
        // The answer completed; only the journal deletion was lost. There is
        // nothing to repair, so retire the row now.
        result.alreadyComplete.push(row.conversationId);
        await closeGenerationRun(row.conversationId, row.generationId).catch(() => undefined);
        break;
      case 'orphaned':
        // The conversation or its assistant row is gone. Nothing can reference
        // this run any more, so removing it cannot lose evidence.
        result.orphaned.push(row.conversationId);
        await closeGenerationRun(row.conversationId, row.generationId).catch(() => undefined);
        break;
      case 'superseded':
        // A newer generation owns this conversation's row. It is that
        // generation's evidence now; leave it entirely alone.
        break;
    }
  }

  return result;
}

/**
 * Retire a conversation's journal row after its lazy transcript repair.
 *
 * Called from the message-load path once unanswered-tool and Whiteboard
 * recovery have committed.
 *
 * `repaired` is the caller's verdict on that commit. A repair the persistence
 * lane refused or failed leaves the row in place, because deleting it would
 * discard the only evidence that the turn still needs fixing.
 *
 * The marking pass is repeated here rather than assumed. Startup recovery runs
 * without blocking hydration, so a conversation can be opened before the
 * startup pass reaches its row; settling unconditionally in that window left
 * an answer with no finish reason and no journal row — permanently
 * unrecoverable. Marking first makes the ordering irrelevant: whichever pass
 * arrives first does the work, and the second is a no-op.
 */
export async function settleGenerationRunAfterRepair(
  conversationId: string,
  repaired = true,
): Promise<void> {
  let row: GenerationRunRow | undefined;
  try {
    const rows = await loadGenerationRuns();
    row = rows.find((candidate) => candidate.conversationId === conversationId);
  } catch {
    return;
  }
  if (!row) {
    acknowledgeConversationRecovery(conversationId);
    return;
  }
  if (!repaired) {
    conversationsNeedingRecovery.add(conversationId);
    return;
  }

  let outcome: InterruptedRunOutcome;
  try {
    outcome = await markGenerationRunInterrupted(
      conversationId,
      row.generationId,
      INTERRUPTED_FINISH_REASON,
    );
  } catch {
    conversationsNeedingRecovery.add(conversationId);
    return;
  }
  // A row a newer generation now owns is that generation's evidence, not this
  // load's to retire.
  if (outcome === 'superseded') return;

  const deleted = await closeGenerationRun(conversationId, row.generationId)
    .catch(() => false);
  if (deleted) acknowledgeConversationRecovery(conversationId);
}
