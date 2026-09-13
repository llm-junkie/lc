import {
  applicationFileLocks,
  reserveApplyPatchLock,
  type ApplyPatchLockReservation,
  type FileLockManager,
} from '../tool-engine/file-lock.ts';

const FILE_ACTIVITY_DOMAIN = '__lc_application_file_activity_domain__';

type CrossMode = 'mutation' | 'broad-read';

interface CrossModeWaiter {
  mode: CrossMode;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  detachAbort: () => void;
}

function abortedLockError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('Application mutation wait aborted', 'AbortError');
}

/**
 * Two compatible groups: mutations may overlap other exact-target mutations,
 * and broad reads may overlap other reads, but the two groups never overlap.
 * FIFO group handoff prevents a steady stream of either kind starving the
 * other. A normal read of an exact target does not need this gate because its
 * per-target shared lock already excludes a write to that target.
 */
class CrossModeGate {
  private activeMode: CrossMode | undefined;
  private activeCount = 0;
  private readonly waiters: CrossModeWaiter[] = [];

  isContended(mode: CrossMode): boolean {
    return (this.activeMode !== undefined && this.activeMode !== mode)
      || this.waiters.some((waiter) => waiter.mode !== mode);
  }

  acquire(mode: CrossMode, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortedLockError(signal));
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        waiter.detachAbort();
        reject(abortedLockError(signal!));
        this.drain();
      };
      const waiter: CrossModeWaiter = {
        mode,
        resolve,
        reject,
        signal,
        detachAbort: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private grant(waiter: CrossModeWaiter): void {
    waiter.detachAbort();
    this.activeMode ??= waiter.mode;
    this.activeCount += 1;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      this.activeCount -= 1;
      if (this.activeCount === 0) {
        this.activeMode = undefined;
        this.drain();
      }
    });
  }

  private drain(): void {
    if (this.waiters.length === 0) return;
    if (this.activeMode !== undefined) {
      if (this.waiters[0].mode !== this.activeMode) return;
      while (this.waiters[0]?.mode === this.activeMode) this.grant(this.waiters.shift()!);
      return;
    }
    const nextMode = this.waiters[0].mode;
    while (this.waiters[0]?.mode === nextMode) this.grant(this.waiters.shift()!);
  }
}

export interface MutationReservation {
  release(): void;
  /** True when acquisition observed an existing incompatible owner/queue. */
  contended: boolean;
}

function combine(releases: Array<() => void>, contended: boolean): MutationReservation {
  let released = false;
  return {
    contended,
    release: () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    },
  };
}

/**
 * One application mutation domain.
 *
 * Independent exact-file mutations share one mode while broad reads share the
 * incompatible mode, so each group stays concurrent internally without
 * observing the other mid-change. Exact reads use per-target shared locks.
 * Every ordinary file operation also holds the activity domain in shared mode;
 * shell takes it exclusively because its side effects cannot be enumerated.
 */
export class ApplicationMutationCoordinator {
  private readonly locks: FileLockManager;
  private readonly crossMode = new CrossModeGate();

  constructor(locks: FileLockManager) {
    this.locks = locks;
  }

  async acquireWrite(targets: string[], signal?: AbortSignal): Promise<MutationReservation> {
    const contended = targets.some((target) => this.locks.isLocked(target))
      || this.crossMode.isContended('mutation');
    const releaseActivity = await this.locks.acquireRead([FILE_ACTIVITY_DOMAIN], signal);
    try {
      const releaseMode = await this.crossMode.acquire('mutation', signal);
      try {
        const releaseTargets = await this.locks.acquire(targets, signal);
        return combine([releaseActivity, releaseMode, releaseTargets], contended);
      } catch (error) {
        releaseMode();
        throw error;
      }
    } catch (error) {
      releaseActivity();
      throw error;
    }
  }

  async acquireExactRead(targets: string[], signal?: AbortSignal): Promise<MutationReservation> {
    const contended = targets.some((target) => this.locks.isLocked(target));
    const releaseActivity = await this.locks.acquireRead([FILE_ACTIVITY_DOMAIN], signal);
    try {
      const releaseTargets = await this.locks.acquireRead(targets, signal);
      return combine([releaseActivity, releaseTargets], contended);
    } catch (error) {
      releaseActivity();
      throw error;
    }
  }

  async acquireBroadRead(signal?: AbortSignal): Promise<MutationReservation> {
    const contended = this.crossMode.isContended('broad-read');
    const releaseActivity = await this.locks.acquireRead([FILE_ACTIVITY_DOMAIN], signal);
    try {
      const releaseMode = await this.crossMode.acquire('broad-read', signal);
      return combine([releaseActivity, releaseMode], contended);
    } catch (error) {
      releaseActivity();
      throw error;
    }
  }

  /** Shell is exclusive against every shell, exact operation, broad read, and patch. */
  async acquireShell(signal?: AbortSignal): Promise<MutationReservation> {
    const contended = this.locks.isLocked(FILE_ACTIVITY_DOMAIN);
    return combine([await this.locks.acquire([FILE_ACTIVITY_DOMAIN], signal)], contended);
  }

  async reservePatch(signal?: AbortSignal): Promise<ApplyPatchLockReservation> {
    const releaseActivity = await this.locks.acquireRead([FILE_ACTIVITY_DOMAIN], signal);
    try {
      const releaseMode = await this.crossMode.acquire('mutation', signal);
      try {
        const patch = await reserveApplyPatchLock(this.locks, signal);
        return {
          acquireTargets: (targets) => patch.acquireTargets(targets),
          release: () => {
            patch.release();
            releaseMode();
            releaseActivity();
          },
        };
      } catch (error) {
        releaseMode();
        throw error;
      }
    } catch (error) {
      releaseActivity();
      throw error;
    }
  }
}

export const applicationMutationCoordinator = new ApplicationMutationCoordinator(
  applicationFileLocks,
);
