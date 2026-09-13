/**
 * Phase 1.7 — File Lock Manager tests.
 *
 * Run with:
 *   node --test --experimental-strip-types src/modules/tool-engine/file-lock.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationFileLocks,
  applyPatchLockTargets,
  canonicalizeLockTargets,
  FileLockManager,
  reserveApplyPatchLock,
} from './file-lock.ts';
import { ApplicationMutationCoordinator } from '../chat-pipeline/mutation-coordinator.ts';

describe('FileLockManager — basic acquire/release', () => {
  it('acquires and releases a single file lock', async () => {
    const mgr = new FileLockManager();
    const release = await mgr.acquire(['/tmp/file.txt']);
    assert.ok(mgr.isLocked('/tmp/file.txt'), 'file should be locked');
    release();
    assert.ok(!mgr.isLocked('/tmp/file.txt'), 'file should be released');
  });

  it('acquires and releases multiple file locks', async () => {
    const mgr = new FileLockManager();
    const release = await mgr.acquire(['/tmp/a.txt', '/tmp/b.txt']);
    assert.ok(mgr.isLocked('/tmp/a.txt'));
    assert.ok(mgr.isLocked('/tmp/b.txt'));
    release();
    assert.ok(!mgr.isLocked('/tmp/a.txt'));
    assert.ok(!mgr.isLocked('/tmp/b.txt'));
  });

  it('deduplicates identical targets', async () => {
    const mgr = new FileLockManager();
    const release = await mgr.acquire(['/tmp/file.txt', '/tmp/file.txt']);
    // Should not deadlock or double-lock.
    assert.ok(mgr.isLocked('/tmp/file.txt'));
    release();
    assert.ok(!mgr.isLocked('/tmp/file.txt'));
  });
});

describe('FileLockManager — serialization: same file', () => {
  it('two operations on the same file serialize (second waits for first)', async () => {
    const mgr = new FileLockManager();
    const order: string[] = [];

    const op1 = mgr.acquire(['/tmp/shared.txt']).then((release) => {
      order.push('op1-start');
      return new Promise<void>((r) => setTimeout(() => { order.push('op1-end'); release(); r(); }, 50));
    });

    // Small delay to ensure op1 acquires first.
    await new Promise((r) => setTimeout(r, 10));

    const op2 = mgr.acquire(['/tmp/shared.txt']).then((release) => {
      order.push('op2-start');
      order.push('op2-end');
      release();
    });

    await Promise.all([op1, op2]);

    // op1 must start and end before op2 starts.
    const op1Start = order.indexOf('op1-start');
    const op1End = order.indexOf('op1-end');
    const op2Start = order.indexOf('op2-start');
    assert.ok(op1Start < op1End, 'op1 start before op1 end');
    assert.ok(op1End < op2Start, 'op1 must end before op2 starts');
  });

  it('keeps multiple queued callers serialized after the first release', async () => {
    const mgr = new FileLockManager();
    const release1 = await mgr.acquire(['/tmp/shared.txt']);
    const started: string[] = [];
    let release2: (() => void) | undefined;
    let release3: (() => void) | undefined;

    const op2 = mgr.acquire(['/tmp/shared.txt']).then((release) => {
      release2 = release;
      started.push('op2');
    });
    const op3 = mgr.acquire(['/tmp/shared.txt']).then((release) => {
      release3 = release;
      started.push('op3');
    });

    release1();
    await op2;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(started, ['op2'], 'third caller must remain queued behind second');

    release2!();
    await op3;
    assert.deepEqual(started, ['op2', 'op3']);
    release3!();
  });
});

describe('FileLockManager — concurrency: different files', () => {
  it('two operations on different files proceed concurrently', async () => {
    const mgr = new FileLockManager();
    const order: string[] = [];

    const op1 = mgr.acquire(['/tmp/a.txt']).then((release) => {
      order.push('op1-start');
      return new Promise<void>((r) => setTimeout(() => { order.push('op1-end'); release(); r(); }, 50));
    });

    // Small delay to ensure op1 acquires first.
    await new Promise((r) => setTimeout(r, 10));

    const op2 = mgr.acquire(['/tmp/b.txt']).then((release) => {
      order.push('op2-start');
      order.push('op2-end');
      release();
    });

    await Promise.all([op1, op2]);

    // op2 should start before op1 ends (different files → concurrent).
    const op1Start = order.indexOf('op1-start');
    const op1End = order.indexOf('op1-end');
    const op2Start = order.indexOf('op2-start');
    assert.ok(op1Start < op2Start, 'op1 starts first (acquired earlier)');
    assert.ok(op2Start < op1End, 'op2 must start before op1 ends (different files)');
  });
});

describe('FileLockManager — abortable read/write waits', () => {
  it('lets exact readers coexist and makes a writer wait for all of them', async () => {
    const mgr = new FileLockManager();
    const releaseReadA = await mgr.acquireRead(['/tmp/shared.txt']);
    const releaseReadB = await mgr.acquireRead(['/tmp/shared.txt']);
    let writerStarted = false;
    const writer = mgr.acquire(['/tmp/shared.txt']).then((release) => {
      writerStarted = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(writerStarted, false);
    releaseReadA();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(writerStarted, false);
    releaseReadB();
    const releaseWriter = await writer;
    assert.equal(writerStarted, true);
    releaseWriter();
  });

  it('removes an aborted waiter before it can reach native execution', async () => {
    const mgr = new FileLockManager();
    const releaseFirst = await mgr.acquire(['/tmp/shared.txt']);
    const controller = new AbortController();
    let nativeStarts = 0;
    const waiting = mgr.acquire(['/tmp/shared.txt'], controller.signal).then((release) => {
      nativeStarts += 1;
      return release;
    });
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    releaseFirst();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(nativeStarts, 0, 'an aborted waiter never crosses the native-call boundary');

    const releaseLater = await mgr.acquire(['/tmp/shared.txt']).then((release) => {
      nativeStarts += 1;
      return release;
    });
    assert.equal(nativeStarts, 1, 'the next fair waiter can reach native execution');
    releaseLater();
    assert.equal(mgr.isLocked('/tmp/shared.txt'), false);
  });
});

describe('ApplicationMutationCoordinator', () => {
  it('blocks a broad read across active/future writes while independent writes coexist', async () => {
    const coordinator = new ApplicationMutationCoordinator(new FileLockManager());
    const writeA = await coordinator.acquireWrite(['/tmp/a.txt']);
    const writeB = await coordinator.acquireWrite(['/tmp/b.txt']);
    let broadStarted = false;
    const broad = coordinator.acquireBroadRead().then((reservation) => {
      broadStarted = true;
      return reservation;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(broadStarted, false);
    writeA.release();
    writeB.release();
    const broadReservation = await broad;
    assert.equal(broadReservation.contended, true);

    let laterWriteStarted = false;
    const laterWrite = coordinator.acquireWrite(['/tmp/c.txt']).then((reservation) => {
      laterWriteStarted = true;
      return reservation;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(laterWriteStarted, false);
    broadReservation.release();
    (await laterWrite).release();
  });

  it('admits a queued broad read before a later mutation', async () => {
    const coordinator = new ApplicationMutationCoordinator(new FileLockManager());
    const activeWrite = await coordinator.acquireWrite(['/tmp/a.txt']);
    let broadStarted = false;
    let laterWriteStarted = false;
    const broad = coordinator.acquireBroadRead().then((reservation) => {
      broadStarted = true;
      return reservation;
    });
    const laterWrite = coordinator.acquireWrite(['/tmp/b.txt']).then((reservation) => {
      laterWriteStarted = true;
      return reservation;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(broadStarted, false);
    assert.equal(laterWriteStarted, false);

    activeWrite.release();
    const broadReservation = await broad;
    assert.equal(broadStarted, true);
    assert.equal(laterWriteStarted, false, 'later mutations cannot starve an earlier broad read');

    broadReservation.release();
    (await laterWrite).release();
    assert.equal(laterWriteStarted, true);
  });

  it('serializes shell calls application-wide and makes their wait abortable', async () => {
    const coordinator = new ApplicationMutationCoordinator(new FileLockManager());
    const first = await coordinator.acquireShell();
    const controller = new AbortController();
    const second = coordinator.acquireShell(controller.signal);
    controller.abort();
    await assert.rejects(second, { name: 'AbortError' });
    first.release();
    const third = await coordinator.acquireShell();
    third.release();
  });

  it('makes shell exclusive against reads, writes, and broad searches', async () => {
    const coordinator = new ApplicationMutationCoordinator(new FileLockManager());
    const exactRead = await coordinator.acquireExactRead(['/tmp/read.txt']);
    const write = await coordinator.acquireWrite(['/tmp/write.txt']);
    let shellStarted = false;
    const shell = coordinator.acquireShell().then((reservation) => {
      shellStarted = true;
      return reservation;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(shellStarted, false);
    exactRead.release();
    write.release();
    (await shell).release();

    const broad = await coordinator.acquireBroadRead();
    shellStarted = false;
    const shellBehindBroad = coordinator.acquireShell().then((reservation) => {
      shellStarted = true;
      return reservation;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(shellStarted, false);
    broad.release();
    (await shellBehindBroad).release();
  });

  it('allows broad reads together while keeping later mutations behind them', async () => {
    const coordinator = new ApplicationMutationCoordinator(new FileLockManager());
    const first = await coordinator.acquireBroadRead();
    const second = await coordinator.acquireBroadRead();
    let writeStarted = false;
    const write = coordinator.acquireWrite(['/tmp/later.txt']).then((reservation) => {
      writeStarted = true;
      return reservation;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(writeStarted, false);
    first.release();
    assert.equal(writeStarted, false);
    second.release();
    (await write).release();
  });

  it('aborts a mutation queued behind a broad read before it can acquire targets', async () => {
    const coordinator = new ApplicationMutationCoordinator(new FileLockManager());
    const broad = await coordinator.acquireBroadRead();
    const controller = new AbortController();
    const mutation = coordinator.acquireWrite(['/tmp/cancelled.txt'], controller.signal);
    controller.abort();
    await assert.rejects(mutation, { name: 'AbortError' });
    broad.release();
    const later = await coordinator.acquireWrite(['/tmp/cancelled.txt']);
    later.release();
  });
});

describe('FileLockManager — deadlock prevention via sorted locks', () => {
  it('overlapping multi-file operations do not deadlock', async () => {
    const mgr = new FileLockManager();
    const order: string[] = [];

    // op1 locks [a, b], op2 locks [b, c] — overlap on b.
    // Sorted acquisition prevents deadlock.
    const op1 = mgr.acquire(['/tmp/b.txt', '/tmp/a.txt']).then((release) => {
      order.push('op1-start');
      return new Promise<void>((r) => setTimeout(() => { order.push('op1-end'); release(); r(); }, 50));
    });

    await new Promise((r) => setTimeout(r, 10));

    const op2 = mgr.acquire(['/tmp/c.txt', '/tmp/b.txt']).then((release) => {
      order.push('op2-start');
      order.push('op2-end');
      release();
    });

    await Promise.all([op1, op2]);

    const op1End = order.indexOf('op1-end');
    const op2Start = order.indexOf('op2-start');
    assert.ok(op1End < op2Start, 'op1 must release b before op2 can acquire it');
  });
});

describe('FileLockManager — path normalisation', () => {
  it('treats backslash and forward slash as the same file (Windows)', async () => {
    const mgr = new FileLockManager();
    const release = await mgr.acquire(['C:\\tmp\\file.txt']);
    // The normalised key should be 'c:/tmp/file.txt'.
    assert.ok(mgr.isLocked('C:/tmp/file.txt'), 'forward-slash variant should be locked');
    assert.ok(mgr.isLocked('C:\\tmp\\file.txt'), 'backslash variant should be locked');
    release();
  });

  it('treats different case as the same file (Windows drive letters)', async () => {
    const mgr = new FileLockManager();
    const release = await mgr.acquire(['C:\\Tmp\\File.txt']);
    assert.ok(mgr.isLocked('c:/tmp/file.txt'), 'lowercase variant should be locked');
    release();
  });

  it('does not case-fold Unix paths', () => {
    const mgr = new FileLockManager();
    // Unix paths don't match the Windows pattern, so no case folding.
    // Just verify they work without error.
    assert.ok(!mgr.isLocked('/Home/User/file.txt'));
  });
});

describe('FileLockManager — release only own locks', () => {
  it('release does not affect locks acquired by a later operation', async () => {
    const mgr = new FileLockManager();

    const release1 = await mgr.acquire(['/tmp/file.txt']);
    release1();

    // Acquire again — should work because first lock was released.
    const release2 = await mgr.acquire(['/tmp/file.txt']);
    assert.ok(mgr.isLocked('/tmp/file.txt'));
    release2();
    assert.ok(!mgr.isLocked('/tmp/file.txt'));
  });

  it('release is idempotent', async () => {
    const mgr = new FileLockManager();
    const release = await mgr.acquire(['/tmp/file.txt']);
    release();
    release();
    assert.ok(!mgr.isLocked('/tmp/file.txt'));
  });
});

describe('apply_patch lock targets', () => {
  it('includes the global patch key and every canonical preflight path', () => {
    assert.deepEqual(
      applyPatchLockTargets(['C:\\repo\\a.ts', 'C:\\repo\\moved.ts']),
      ['__lc_apply_patch__', 'C:\\repo\\a.ts', 'C:\\repo\\moved.ts'],
    );
  });

  it('serializes preflight through execution for dependent patch calls', async () => {
    const mgr = new FileLockManager();
    const order: string[] = [];
    let fileExists = false;

    const runPatch = async (action: 'add' | 'delete') => {
      const reservation = await reserveApplyPatchLock(mgr);
      try {
        order.push(`${action}:preflight`);
        if (action === 'delete') {
          assert.equal(fileExists, true, 'delete preflight must observe the earlier add');
        }

        const releaseTargets = await reservation.acquireTargets(['C:\\repo\\created.txt']);
        try {
          order.push(`${action}:execute`);
          fileExists = action === 'add';
        } finally {
          releaseTargets();
        }
      } finally {
        reservation.release();
      }
    };

    await Promise.all([runPatch('add'), runPatch('delete')]);

    assert.deepEqual(order, [
      'add:preflight',
      'add:execute',
      'delete:preflight',
      'delete:execute',
    ]);
    assert.equal(fileExists, false);
  });

  it('releases a preflight reservation idempotently after an early failure', async () => {
    const mgr = new FileLockManager();
    const first = await reserveApplyPatchLock(mgr);
    first.release();
    first.release();

    const second = await reserveApplyPatchLock(mgr);
    second.release();
    assert.equal(mgr.isLocked('__lc_apply_patch__'), false);
  });
});

describe('canonicalizeLockTargets', () => {
  /** Stand-in for native resolution: collapses `.` segments and symlinks. */
  const stubResolve = async (raw: string): Promise<string | null> => {
    if (raw.includes('unresolvable')) return null;
    const collapsed = raw.replace(/\/\.\//g, '/');
    return collapsed.replace('/link/', '/real/');
  };

  it('maps lexical aliases of one file to a single lock key', async () => {
    const mgr = new FileLockManager();
    const targets = await canonicalizeLockTargets(
      ['/repo/./src/a.ts', '/repo/src/a.ts'],
      stubResolve,
    );
    assert.deepEqual(targets, ['/repo/src/a.ts', '/repo/src/a.ts']);

    // The manager dedupes identical keys, so one release frees the file.
    const release = await mgr.acquire(targets);
    assert.ok(mgr.isLocked('/repo/src/a.ts'));
    release();
    assert.equal(mgr.isLocked('/repo/src/a.ts'), false);
  });

  it('serializes concurrent writers that arrived under different spellings', async () => {
    const mgr = new FileLockManager();
    const order: string[] = [];

    const write = async (label: string, rawPath: string) => {
      const targets = await canonicalizeLockTargets([rawPath], stubResolve);
      const release = await mgr.acquire(targets);
      try {
        order.push(`${label}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`${label}:end`);
      } finally {
        release();
      }
    };

    await Promise.all([
      write('alias', '/repo/./src/a.ts'),
      write('direct', '/repo/src/a.ts'),
    ]);

    // Without canonicalization these interleave as start/start/end/end.
    assert.deepEqual(order, [
      'alias:start',
      'alias:end',
      'direct:start',
      'direct:end',
    ]);
  });

  it('maps a symlinked path onto its real target', async () => {
    const targets = await canonicalizeLockTargets(
      ['/repo/link/a.ts', '/repo/real/a.ts'],
      stubResolve,
    );
    assert.deepEqual(targets, ['/repo/real/a.ts', '/repo/real/a.ts']);
  });

  it('falls back to the raw path when resolution fails', async () => {
    const targets = await canonicalizeLockTargets(
      ['/repo/unresolvable.ts'],
      stubResolve,
    );
    // Still locked, just under the weaker raw identity — never skipped.
    assert.deepEqual(targets, ['/repo/unresolvable.ts']);
  });

  it('returns an empty list unchanged without calling the resolver', async () => {
    let calls = 0;
    const counting = async (raw: string) => {
      calls += 1;
      return raw;
    };
    assert.deepEqual(await canonicalizeLockTargets([], counting), []);
    assert.equal(calls, 0);
  });

  it('preserves distinct files as distinct locks', async () => {
    const mgr = new FileLockManager();
    const targets = await canonicalizeLockTargets(
      ['/repo/./src/a.ts', '/repo/src/b.ts'],
      stubResolve,
    );
    assert.deepEqual(targets, ['/repo/src/a.ts', '/repo/src/b.ts']);

    const release = await mgr.acquire(targets);
    assert.ok(mgr.isLocked('/repo/src/a.ts'));
    assert.ok(mgr.isLocked('/repo/src/b.ts'));
    release();
  });
});

describe('applicationFileLocks — the single process-wide domain', () => {
  it('serializes writers from different generations on the same target', async () => {
    // Phase 1: the orchestrator holds this one manager instead of building a
    // fresh one per tool round, so two conversations writing the same file
    // wait for each other here — in abortable JavaScript — rather than
    // colliding at the native lock, which blocks and registers no
    // cancellation token.
    const target = 'C:/workspace/shared-across-generations.txt';

    const releaseFirst = await applicationFileLocks.acquire([target]);
    let secondAcquired = false;
    const secondPending = applicationFileLocks.acquire([target]).then((release) => {
      secondAcquired = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(secondAcquired, false, 'the second generation waits');

    releaseFirst();
    const releaseSecond = await secondPending;
    assert.equal(secondAcquired, true);
    releaseSecond();

    assert.equal(applicationFileLocks.isLocked(target), false, 'the entry is released');
  });

  it('still lets independent targets proceed concurrently', async () => {
    const releaseA = await applicationFileLocks.acquire(['C:/workspace/a.txt']);
    const releaseB = await applicationFileLocks.acquire(['C:/workspace/b.txt']);
    releaseA();
    releaseB();
    assert.equal(applicationFileLocks.isLocked('C:/workspace/a.txt'), false);
    assert.equal(applicationFileLocks.isLocked('C:/workspace/b.txt'), false);
  });
});
