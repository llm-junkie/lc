/** Minimal shape needed to serialize first-enable initialization with config writes. */
export interface WhiteboardToggleConfig {
  readonly enabled: boolean;
  readonly whiteboard_enabled?: boolean;
}

export interface WhiteboardToolsChange<T extends WhiteboardToggleConfig> {
  readonly next: T;
  /** Return the same object identity while the persisted config is unchanged. */
  readonly getCurrent: () => T | null;
  readonly initialize: () => Promise<unknown>;
  readonly commit: (next: T) => void;
}

export interface WhiteboardToolsConfigChangeCoordinator {
  apply<T extends WhiteboardToggleConfig>(input: WhiteboardToolsChange<T>): Promise<boolean>;
}

export interface WhiteboardInitializationCoordinator {
  /**
   * Run one settings change. Calling the supplied initializer lazily joins the
   * conversation's shared initialization and holds its generation-blocking
   * lease until this settings change has finished publishing its result.
   */
  run<T>(
    conversationId: string,
    operation: (initialize: () => Promise<unknown>) => T | PromiseLike<T>,
  ): Promise<T>;
  isActive(conversationId: string): boolean;
}

interface ActiveWhiteboardInitialization {
  readonly operationId: string;
  readonly promise: Promise<unknown>;
  readonly participants: Set<symbol>;
  settled: boolean;
}

/**
 * Share first-visible initialization for one conversation and keep its exact
 * generation-blocking lease through every participating config publication.
 * The operation callback must request initialization synchronously before its
 * first await; `applyWhiteboardToolsConfigChange` satisfies that contract.
 */
export function createWhiteboardInitializationCoordinator(deps: {
  readonly initialize: (conversationId: string) => Promise<unknown>;
  readonly acquire: (conversationId: string) => { operationId: string };
  readonly release: (operationId: string) => unknown;
}): WhiteboardInitializationCoordinator {
  const activeByConversation = new Map<string, ActiveWhiteboardInitialization>();

  const releaseIfIdle = (
    conversationId: string,
    active: ActiveWhiteboardInitialization,
  ): void => {
    if (!active.settled || active.participants.size > 0) return;
    if (activeByConversation.get(conversationId) !== active) return;
    activeByConversation.delete(conversationId);
    deps.release(active.operationId);
  };

  const join = (
    conversationId: string,
    participant: symbol,
  ): ActiveWhiteboardInitialization => {
    let active = activeByConversation.get(conversationId);
    if (!active) {
      const lease = deps.acquire(conversationId);
      const created: ActiveWhiteboardInitialization = {
        operationId: lease.operationId,
        promise: Promise.resolve()
          .then(() => deps.initialize(conversationId))
          .finally(() => {
            created.settled = true;
            releaseIfIdle(conversationId, created);
          }),
        participants: new Set<symbol>(),
        settled: false,
      };
      activeByConversation.set(conversationId, created);
      active = created;
    }
    active.participants.add(participant);
    return active;
  };

  return {
    run<T>(
      conversationId: string,
      operation: (initialize: () => Promise<unknown>) => T | PromiseLike<T>,
    ): Promise<T> {
      const participant = Symbol(conversationId);
      let joined: ActiveWhiteboardInitialization | null = null;
      const initialize = () => {
        joined ??= join(conversationId, participant);
        return joined.promise;
      };
      let result: Promise<T>;
      try {
        result = Promise.resolve(operation(initialize));
      } catch (error) {
        result = Promise.reject(error);
      }
      return result.finally(() => {
        if (!joined) return;
        joined.participants.delete(participant);
        releaseIfIdle(conversationId, joined);
      });
    },
    isActive: (conversationId) => activeByConversation.has(conversationId),
  };
}

/**
 * Keep the latest overlapping settings request authoritative while an older
 * first-enable initialization is awaiting storage. A stale completion may
 * finish its idempotent initialization, but it cannot publish config.
 */
export function createWhiteboardToolsConfigChangeCoordinator(): WhiteboardToolsConfigChangeCoordinator {
  let latestRequest = 0;
  return {
    async apply<T extends WhiteboardToggleConfig>(
      input: WhiteboardToolsChange<T>,
    ): Promise<boolean> {
      const request = ++latestRequest;
      let committed = false;
      try {
        const accepted = await applyWhiteboardToolsConfigChange({
          ...input,
          commit: (next) => {
            if (request !== latestRequest) return;
            committed = true;
            input.commit(next);
          },
        });
        return accepted && committed;
      } catch (error) {
        if (request !== latestRequest) return false;
        throw error;
      }
    },
  };
}

/**
 * Apply one tools-config change without letting a slow first initialization
 * overwrite a newer Workspace-off action or another intervening config edit.
 */
export async function applyWhiteboardToolsConfigChange<T extends WhiteboardToggleConfig>(
  input: WhiteboardToolsChange<T>,
): Promise<boolean> {
  const before = input.getCurrent();
  if (!before) return false;
  const firstVisibleEnable = input.next.enabled
    && input.next.whiteboard_enabled === true
    && !(before.enabled && before.whiteboard_enabled === true);
  if (!firstVisibleEnable) {
    input.commit(input.next);
    return true;
  }

  await input.initialize();
  const latest = input.getCurrent();
  if (!latest) return false;
  // No intervening write: commit the complete requested transition. This is
  // load-bearing when Workspace is being re-enabled with Whiteboard preserved
  // on—the durable current value is still disabled until this commit.
  if (latest === before) {
    input.commit(input.next);
    return true;
  }
  // A distinct disabled snapshot is a newer Workspace-off decision. Do not
  // let the completed initialization overwrite it.
  if (!latest.enabled) return false;
  // A concurrent sibling change kept Workspace on. Rebase only the category
  // bit so the newer settings survive.
  input.commit({ ...latest, whiteboard_enabled: true });
  return true;
}
