/**
 * Per-conversation persistence lanes.
 *
 * Every durable write that can affect a conversation's transcript or metadata
 * goes through one serialized queue keyed by conversation ID. Lanes for
 * different conversations run independently, so one chat's slow flush cannot
 * delay another's, and one chat's stream cannot suppress another's writes.
 *
 * Three problems this solves, all of which exist today with a single
 * conversation and get sharply worse with three:
 *
 *   1. **Split writes.** A logical mutation usually touches both the message
 *      row and the conversation metadata. Issuing those as two unordered
 *      promises lets `messageCount` land without its message, so a later load
 *      sees an incomplete history and refuses to replace it. A lane task is one
 *      unit: both writes happen inside it, in order.
 *
 *   2. **Stale checkpoints.** The streaming checkpoint interval and the
 *      terminal flush are independent fire-and-forget promises with no ordering
 *      between them. A checkpoint captured before finalization overwrites the
 *      terminal row if it lands afterwards. Here, enqueuing a terminal barrier
 *      immediately discards any queued checkpoint it supersedes, and a
 *      checkpoint that reaches the head after its generation terminalized is
 *      skipped rather than written.
 *
 *   3. **Resurrection after delete.** A write queued before a conversation is
 *      deleted would recreate its rows. Closing the lane rejects everything
 *      still queued and everything enqueued later.
 *
 * Failures are reported per conversation rather than into one latest-value
 * slot, so a second conversation's error cannot erase the first's.
 *
 * Pure JS — no Dexie, no React. Tasks are closures supplied by the caller, so
 * this module never needs to know what a durable write actually is.
 */

export type PersistenceTaskKind =
  /** An ordinary durable mutation: append, patch, rename, finalize. */
  | 'ordinary'
  /** A periodic in-flight snapshot. Coalesced, and skippable when superseded. */
  | 'checkpoint'
  /** The generation's final write. Acts as a barrier and discards checkpoints. */
  | 'terminal';

export type PersistenceOutcome =
  /** The task ran and its writes settled. */
  | 'committed'
  /** The task was discarded before running; nothing was written. */
  | 'skipped'
  /** The task ran and threw. The failure was reported. */
  | 'failed'
  /** The lane was closed or sealed against new work; the task will never run. */
  | 'closed';

export interface PersistenceTask {
  /** Human-readable label used to attribute a failure. */
  operation: string;
  kind: PersistenceTaskKind;
  /**
   * The generation this write belongs to. Required for checkpoints and
   * terminal writes so a checkpoint cannot outlive the generation that
   * produced it.
   */
  generationId?: string;
  /**
   * Monotonic transcript revision the caller observed when it built this
   * write. A task whose revision is older than the lane's last committed
   * revision is stale and is skipped.
   */
  revision?: number;
  /** The durable work. Runs at most once. */
  run: () => Promise<unknown>;
  /**
   * Whether a thrown error is reported through the failure reporter.
   *
   * Value-returning lifecycle writes set this to `false`: their caller
   * re-throws and owns the error, so reporting here as well would surface the
   * same failure twice.
   */
  reportFailures?: boolean;
}

export type PersistenceFailureReporter = (
  operation: string,
  error: unknown,
  conversationId: string,
) => void;

export interface ConversationPersistenceMaintenance {
  /** Wait until every task admitted before the seal is idle. */
  drain: () => Promise<void>;
  /** Permanently close every lane known at the drained boundary. */
  closeKnownLanes: () => void;
  /** Release this exact maintenance seal. Stale releases are harmless. */
  release: () => boolean;
}

interface QueuedTask extends PersistenceTask {
  settle: (outcome: PersistenceOutcome) => void;
  discarded: boolean;
}

interface Lane {
  queue: QueuedTask[];
  running: boolean;
  /** Refuses new work and discards whatever is still queued. */
  closed: boolean;
  /**
   * Refuses new work but lets everything already queued finish.
   *
   * Deletion needs both halves at once: nothing new may be accepted from the
   * moment the delete is decided, yet the delete itself has to reach the head
   * behind the writes already in front of it. Closing the lane outright would
   * discard the delete along with them.
   */
  sealed: boolean;
  /** Revision of the newest task this lane has committed. */
  committedRevision: number;
  /** Generations whose terminal write has already been enqueued or run. */
  terminalGenerations: Set<string>;
  /** Resolves when the lane has no running or queued work. */
  idleWaiters: (() => void)[];
}

export interface ConversationPersistenceCoordinator {
  /**
   * Queue one durable unit for a conversation. Resolves with the outcome; it
   * never rejects, because callers are fire-and-forget and a rejected
   * persistence promise would become an unhandled rejection.
   */
  enqueue: (conversationId: string, task: PersistenceTask) => Promise<PersistenceOutcome>;
  /**
   * Close a lane permanently. Everything queued is settled as `closed` without
   * running, and later writes are refused, so a completion in flight when the
   * user deleted a conversation cannot resurrect its rows.
   */
  close: (conversationId: string) => void;
  /**
   * Append one final task and refuse everything enqueued after it.
   *
   * The seal takes effect synchronously, before the task runs, so no write can
   * slip in behind a deletion that has already been decided. Work queued
   * earlier still drains — it targets rows that are about to disappear, which
   * is harmless, whereas discarding it could strand an unrelated mutation.
   */
  enqueueFinal: (conversationId: string, task: PersistenceTask) => Promise<PersistenceOutcome>;
  /** Reopen a closed lane. Used when a conversation ID is recreated by import. */
  reopen: (conversationId: string) => void;
  /** Resolve once the conversation has no running or queued work. */
  drain: (conversationId: string) => Promise<void>;
  /** Resolve once every conversation has no running or queued work. */
  drainAll: () => Promise<void>;
  /** Whether the lane currently has running or queued work. */
  isBusy: (conversationId: string) => boolean;
  /** Whether the lane currently refuses new work. */
  isClosed: (conversationId: string) => boolean;
  /** Synchronously refuse all new and never-before-seen lane work. */
  beginGlobalMaintenance: () => ConversationPersistenceMaintenance;
  /** Test/diagnostic seam: how many tasks are waiting behind the head. */
  queueDepth: (conversationId: string) => number;
}

export function createConversationPersistenceCoordinator(
  reportFailure: PersistenceFailureReporter,
): ConversationPersistenceCoordinator {
  const lanes = new Map<string, Lane>();
  let maintenanceOwner: symbol | null = null;

  function laneFor(conversationId: string): Lane {
    let lane = lanes.get(conversationId);
    if (!lane) {
      lane = {
        queue: [],
        running: false,
        closed: false,
        sealed: false,
        committedRevision: -1,
        terminalGenerations: new Set(),
        idleWaiters: [],
      };
      lanes.set(conversationId, lane);
    }
    return lane;
  }

  function releaseIfIdle(lane: Lane): void {
    if (lane.running || lane.queue.length > 0) return;
    const waiters = lane.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  /**
   * Decide whether a task that has reached the head still deserves to run.
   *
   * Supersession is checked twice on purpose. It is applied eagerly at enqueue
   * so a discarded checkpoint stops holding a snapshot alive, and again here
   * because a task can be superseded while it sits behind a slow predecessor.
   */
  function isStale(lane: Lane, task: QueuedTask): boolean {
    if (task.discarded) return true;
    if (task.kind === 'checkpoint') {
      if (task.generationId && lane.terminalGenerations.has(task.generationId)) return true;
      if (task.revision !== undefined && task.revision < lane.committedRevision) return true;
    }
    return false;
  }

  async function pump(conversationId: string): Promise<void> {
    const lane = laneFor(conversationId);
    if (lane.running) return;
    lane.running = true;
    try {
      for (;;) {
        const task = lane.queue.shift();
        if (!task) break;

        if (lane.closed) {
          task.settle('closed');
          continue;
        }
        if (isStale(lane, task)) {
          task.settle('skipped');
          continue;
        }

        try {
          await task.run();
          if (task.revision !== undefined && task.revision > lane.committedRevision) {
            lane.committedRevision = task.revision;
          }
          task.settle('committed');
        } catch (error) {
          if (task.reportFailures !== false) {
            reportFailure(task.operation, error, conversationId);
          }
          task.settle('failed');
        }
      }
    } finally {
      lane.running = false;
      releaseIfIdle(lane);
    }
  }

  return {
    enqueue(conversationId, task) {
      if (maintenanceOwner) return Promise.resolve<PersistenceOutcome>('closed');
      const lane = laneFor(conversationId);
      if (lane.closed || lane.sealed) return Promise.resolve<PersistenceOutcome>('closed');

      // A terminal write ends its generation: discard every checkpoint from
      // that generation still waiting, so none of them can overwrite it. Doing
      // this at enqueue rather than at the head matters — a checkpoint queued
      // just before the barrier would otherwise still be at the head first.
      if (task.kind === 'terminal' && task.generationId) {
        lane.terminalGenerations.add(task.generationId);
        for (const queued of lane.queue) {
          if (queued.kind === 'checkpoint' && queued.generationId === task.generationId) {
            queued.discarded = true;
          }
        }
      }

      // At most one pending checkpoint per conversation: a newer snapshot
      // always contains everything an older one would have written.
      if (task.kind === 'checkpoint') {
        for (const queued of lane.queue) {
          if (queued.kind === 'checkpoint' && !queued.discarded) queued.discarded = true;
        }
      }

      return new Promise<PersistenceOutcome>((resolve) => {
        let settled = false;
        lane.queue.push({
          ...task,
          discarded: false,
          settle: (outcome) => {
            if (settled) return;
            settled = true;
            resolve(outcome);
          },
        });
        void pump(conversationId);
      });
    },

    enqueueFinal(conversationId, task) {
      if (maintenanceOwner) return Promise.resolve<PersistenceOutcome>('closed');
      const lane = laneFor(conversationId);
      if (lane.closed || lane.sealed) return Promise.resolve<PersistenceOutcome>('closed');
      const pending = this.enqueue(conversationId, task);
      lane.sealed = true;
      return pending;
    },

    close(conversationId) {
      const lane = laneFor(conversationId);
      lane.closed = true;
      lane.sealed = true;
      const queued = lane.queue.splice(0);
      for (const task of queued) task.settle('closed');
      releaseIfIdle(lane);
    },

    reopen(conversationId) {
      if (maintenanceOwner) return;
      const lane = laneFor(conversationId);
      lane.closed = false;
      lane.sealed = false;
      lane.committedRevision = -1;
      lane.terminalGenerations.clear();
    },

    drain(conversationId) {
      const lane = laneFor(conversationId);
      if (!lane.running && lane.queue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => { lane.idleWaiters.push(resolve); });
    },

    drainAll() {
      return Promise.all(
        Array.from(lanes.keys(), (conversationId) => this.drain(conversationId)),
      ).then(() => undefined);
    },

    isBusy(conversationId) {
      const lane = lanes.get(conversationId);
      return Boolean(lane && (lane.running || lane.queue.length > 0));
    },

    isClosed(conversationId) {
      const lane = lanes.get(conversationId);
      return Boolean(lane && (lane.closed || lane.sealed));
    },

    beginGlobalMaintenance() {
      if (maintenanceOwner) {
        throw new Error('Conversation persistence maintenance is already active.');
      }
      const owner = Symbol('conversation-persistence-maintenance');
      maintenanceOwner = owner;
      return {
        drain: () => Promise.all(
          Array.from(lanes.keys(), (conversationId) => this.drain(conversationId)),
        ).then(() => undefined),
        closeKnownLanes: () => {
          if (maintenanceOwner !== owner) return;
          for (const conversationId of lanes.keys()) this.close(conversationId);
        },
        release: () => {
          if (maintenanceOwner !== owner) return false;
          maintenanceOwner = null;
          return true;
        },
      };
    },

    queueDepth(conversationId) {
      return lanes.get(conversationId)?.queue.length ?? 0;
    },
  };
}
