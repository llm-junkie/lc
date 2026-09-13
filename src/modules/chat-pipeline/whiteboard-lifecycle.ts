import type {
  WhiteboardToolMutationState,
  WhiteboardToolService,
  WhiteboardToolServiceResult,
  WhiteboardToolSnapshot,
} from '../tool-engine/types';
import { createSerializedAsyncQueue } from './serialized-async-queue.ts';

export type WhiteboardTerminalReason = 'aborted' | 'generation_ended' | 'timeout';

export interface WhiteboardLifecycleDependencies {
  /** True only while the owning generation may still publish ordinary results. */
  isActive(): boolean;
  read(input: {
    signal: AbortSignal;
  }): Promise<WhiteboardToolServiceResult<WhiteboardToolSnapshot>>;
  replaceModel(input: {
    content: string;
    toolCallId: string;
    signal: AbortSignal;
  }): Promise<WhiteboardToolServiceResult<WhiteboardToolMutationState>>;
  settle(reason: WhiteboardTerminalReason): Promise<void>;
}

export interface WhiteboardGenerationLifecycle {
  service: WhiteboardToolService;
  /** False as soon as terminal closure is requested, before storage settles. */
  ordinaryResultsAllowed(): boolean;
  /** Idempotently closes the generation-owned row behind every admitted write. */
  settle(reason: WhiteboardTerminalReason): Promise<boolean>;
}

type QueuedLifecycleResult =
  | {
      kind: 'replace';
      result: WhiteboardToolServiceResult<WhiteboardToolMutationState>;
    }
  | { kind: 'settle'; ok: boolean }
  | { kind: 'queue_failed' };

const ABORTED = Object.freeze({ ok: false, code: 'aborted' } as const);
const READ_FAILED = Object.freeze({ ok: false, code: 'whiteboard_read_failed' } as const);
const WRITE_FAILED = Object.freeze({ ok: false, code: 'whiteboard_write_failed' } as const);

/**
 * Build the one serialized lifecycle lane shared by model-board mutations and
 * terminal settlement. Reads remain direct because the batch governor admits
 * at most one Whiteboard call and every later tool round waits for its result.
 */
export function createWhiteboardGenerationLifecycle(
  dependencies: WhiteboardLifecycleDependencies,
): WhiteboardGenerationLifecycle {
  let closing = false;
  let terminalReason: WhiteboardTerminalReason | undefined;
  let settlement: Promise<boolean> | undefined;
  const enqueue = createSerializedAsyncQueue<
    [() => Promise<QueuedLifecycleResult>],
    QueuedLifecycleResult
  >(
    (operation) => operation(),
    () => ({ kind: 'queue_failed' }),
  );

  const service: WhiteboardToolService = {
    read: async ({ signal }) => {
      if (closing || signal.aborted || !dependencies.isActive()) return ABORTED;
      try {
        const result = await dependencies.read({ signal });
        if (closing || signal.aborted || !dependencies.isActive()) return ABORTED;
        return result;
      } catch {
        return closing || signal.aborted || !dependencies.isActive()
          ? ABORTED
          : READ_FAILED;
      }
    },
    replaceModel: async (input) => {
      if (closing || input.signal.aborted || !dependencies.isActive()) return ABORTED;
      const queued = await enqueue(async () => {
        if (closing || input.signal.aborted || !dependencies.isActive()) {
          return { kind: 'replace', result: ABORTED };
        }
        try {
          const result = await dependencies.replaceModel(input);
          // A committed storage mutation remains authoritative, but once
          // ownership is gone its ordinary worker result must not claim the
          // opposite. Terminal receipt repair publishes the durable truth.
          if (closing || input.signal.aborted || !dependencies.isActive()) {
            return { kind: 'replace', result: ABORTED };
          }
          return { kind: 'replace', result };
        } catch {
          return {
            kind: 'replace',
            result: closing || input.signal.aborted || !dependencies.isActive()
              ? ABORTED
              : WRITE_FAILED,
          };
        }
      });
      return queued.kind === 'replace' ? queued.result : WRITE_FAILED;
    },
  };

  return {
    service,
    ordinaryResultsAllowed: () => !closing && dependencies.isActive(),
    settle: (reason) => {
      if (settlement) return settlement;
      // Publish closure before enqueueing. A worker admitted after this point
      // is rejected even when the external stream owner has not yet flipped
      // its terminal bit (for example, a tool-round timeout).
      closing = true;
      terminalReason ??= reason;
      settlement = enqueue(async () => {
        try {
          await dependencies.settle(terminalReason!);
          return { kind: 'settle', ok: true };
        } catch {
          return { kind: 'settle', ok: false };
        }
      }).then((result) => {
        const ok = result.kind === 'settle' && result.ok;
        // Settlement is storage-idempotent. Keep one successful result, but
        // let a later terminal boundary retry after a transient failure.
        if (!ok) settlement = undefined;
        return ok;
      });
      return settlement;
    },
  };
}
