/**
 * Phase 1.7 — File Lock Manager
 *
 * Serializes mutating file operations by canonical target identity.
 * Independent writes/edits may proceed concurrently; aliases of the same file
 * (different lexical paths to the same canonical location) may not. Patch
 * calls additionally hold a global reservation from native preflight through
 * execution, then acquire sorted canonical target locks to avoid deadlocks and
 * serialize against overlapping writes/edits.
 *
 * Canonical identity is supplied by the caller, not derived here: `lockKey`
 * normalizes separators and case only. Raw model-supplied paths must go
 * through `canonicalizeLockTargets` first — `apply_patch` targets already
 * arrive canonical from native preflight.
 * This manager is cooperative and in-process. Native mutating tools also take
 * a per-target OS lock so separate LC executables serialize with each other.
 * The native tool revalidates canonical identity at execution time to reduce
 * TOCTOU drift.
 *
 * Pure JS, no Tauri deps — testable in Node.
 */

/**
 * Normalise a path for lock-key comparison.
 * Forward slashes, lowercase for Windows drive letters, no trailing slash.
 */
function lockKey(path: string): string {
  let s = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  // Case-insensitive for Windows paths.
  if (/^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path)) {
    s = s.toLowerCase();
  }
  return s;
}

/** Keep patch execution globally serialized while also locking native targets. */
export function applyPatchLockTargets(affectedPaths: readonly string[]): string[] {
  return ['__lc_apply_patch__', ...affectedPaths];
}

/**
 * Map raw, model-supplied paths to canonical lock identities.
 *
 * `lockKey` normalizes separators and case but cannot resolve `.`, `..`, or
 * symlinks, so a raw path is not a safe identity on its own — `a/./b.ts` and
 * `a/b.ts` would take two different locks on one file. `resolve` supplies the
 * canonical form (native path resolution in the app, a stub in tests).
 *
 * A path that fails to resolve keeps its raw form, so it is still locked under
 * a weaker identity rather than silently skipped.
 */
export async function canonicalizeLockTargets(
  targets: readonly string[],
  resolve: (raw: string) => Promise<string | null>,
): Promise<string[]> {
  if (targets.length === 0) return [];
  return Promise.all(targets.map(async (raw) => (await resolve(raw)) ?? raw));
}

export interface ApplyPatchLockReservation {
  /** Lock canonical paths while the global patch reservation is held. */
  acquireTargets(affectedPaths: readonly string[]): Promise<() => void>;
  /** Release the global patch reservation. Safe to call more than once. */
  release(): void;
}

/**
 * In-process cooperative lock manager for file-level serialization.
 *
 * Usage:
 *   const release = await lockMgr.acquire(['/path/to/file.txt']);
 *   try { await doWrite(); } finally { release(); }
 */
export class FileLockManager {
  private locks = new Map<string, KeyLock>();

  /**
   * Acquire exclusive locks on a set of canonical file targets.
   *
   * Targets are sorted lexically before acquisition to prevent
   * deadlocks when two concurrent operations target overlapping
   * but differently-ordered file sets.
   *
   * @param targets — Canonical file paths to lock.
   * @returns A release function. Call it when the operation completes.
   */
  async acquire(targets: string[], signal?: AbortSignal): Promise<() => void> {
    return this.acquireMode(targets, 'write', signal);
  }

  /** Acquire shared read locks; readers coexist but remain FIFO with writers. */
  async acquireRead(targets: string[], signal?: AbortSignal): Promise<() => void> {
    return this.acquireMode(targets, 'read', signal);
  }

  private async acquireMode(
    targets: string[],
    mode: LockMode,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (signal?.aborted) throw abortError(signal);
    const keys = [...new Set(targets.map(lockKey))].sort();
    const releases: Array<() => void> = [];
    try {
      // Sorted, sequential acquisition prevents overlapping multi-target
      // operations from deadlocking while keeping each target independently
      // concurrent.
      for (const key of keys) {
        let lock = this.locks.get(key);
        if (!lock) {
          lock = new KeyLock(() => {
            if (this.locks.get(key) === lock && lock!.idle) this.locks.delete(key);
          });
          this.locks.set(key, lock);
        }
        releases.push(await lock.acquire(mode, signal));
      }
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    };
  }

  /**
   * Check if a file is currently locked.
   * For testing/debugging only.
   */
  isLocked(path: string): boolean {
    const lock = this.locks.get(lockKey(path));
    return lock ? !lock.idle : false;
  }
}

type LockMode = 'read' | 'write';

interface LockWaiter {
  mode: LockMode;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  detachAbort: () => void;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('File lock wait aborted', 'AbortError');
}

/** One fair FIFO read/write lock. */
class KeyLock {
  private activeReaders = 0;
  private activeWriter = false;
  private waiters: LockWaiter[] = [];

  private readonly onIdle: () => void;

  constructor(onIdle: () => void) {
    this.onIdle = onIdle;
  }

  get idle(): boolean {
    return !this.activeWriter && this.activeReaders === 0 && this.waiters.length === 0;
  }

  acquire(mode: LockMode, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        waiter.detachAbort();
        reject(abortError(signal!));
        this.drain();
        if (this.idle) this.onIdle();
      };
      const waiter: LockWaiter = {
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

  private grant(waiter: LockWaiter): void {
    waiter.detachAbort();
    if (waiter.mode === 'write') this.activeWriter = true;
    else this.activeReaders += 1;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      if (waiter.mode === 'write') this.activeWriter = false;
      else this.activeReaders -= 1;
      this.drain();
      if (this.idle) this.onIdle();
    });
  }

  private drain(): void {
    if (this.activeWriter || this.waiters.length === 0) return;
    if (this.activeReaders > 0 && this.waiters[0].mode === 'write') return;
    if (this.activeReaders === 0 && this.waiters[0].mode === 'write') {
      this.grant(this.waiters.shift()!);
      return;
    }
    while (this.waiters[0]?.mode === 'read' && !this.activeWriter) {
      this.grant(this.waiters.shift()!);
    }
  }
}

/**
 * The application's single cooperative lock domain.
 *
 * There is exactly one, deliberately. A manager built per tool round — as the
 * orchestrator used to — serializes only the calls inside that round, so two
 * generations writing the same file never contend in JavaScript and fall
 * through to the native per-target OS lock. That lock is correct but it
 * blocks, and the mutating native tools register no cancellation token, so a
 * generation waiting behind a sibling's OS lock cannot be aborted.
 *
 * Holding one process-wide manager means the abortable JavaScript wait happens
 * first, and same-target writes from different conversations serialize before
 * either one reaches native code.
 *
 * Lock keys are canonical file paths, so entries are released as soon as the
 * last waiter for a path finishes — the map does not grow with call volume.
 */
export const applicationFileLocks = new FileLockManager();

/**
 * Reserve the global patch queue before metadata-only target discovery starts.
 *
 * Discovery and preflight resolve filesystem identities used by authorization
 * and plan validation. Keep this reservation through permission handling,
 * fresh full preflight, and execution, then acquire the canonical file targets
 * after preflight confirms the discovery target set.
 */
export async function reserveApplyPatchLock(
  manager: FileLockManager,
  signal?: AbortSignal,
): Promise<ApplyPatchLockReservation> {
  const releaseGlobal = await manager.acquire(applyPatchLockTargets([]), signal);
  let released = false;

  return {
    acquireTargets: (affectedPaths) => {
      if (released) {
        throw new Error('apply_patch lock reservation has already been released');
      }
      return manager.acquire([...affectedPaths], signal);
    },
    release: () => {
      if (released) return;
      released = true;
      releaseGlobal();
    },
  };
}
