import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConversationPersistenceCoordinator,
  type PersistenceFailureReporter,
} from './conversation-persistence-coordinator.ts';

interface Recorded {
  operation: string;
  error: unknown;
  conversationId: string;
}

function coordinator(): {
  lanes: ReturnType<typeof createConversationPersistenceCoordinator>;
  failures: Recorded[];
} {
  const failures: Recorded[] = [];
  const report: PersistenceFailureReporter = (operation, error, conversationId) => {
    failures.push({ operation, error, conversationId });
  };
  return { lanes: createConversationPersistenceCoordinator(report), failures };
}

/** A task that resolves only when the returned trigger is called. */
function gated(log: string[], label: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    release,
    run: async () => {
      await gate;
      log.push(label);
    },
  };
}

test('writes for one conversation run in enqueue order', async () => {
  const { lanes } = coordinator();
  const log: string[] = [];

  const outcomes = await Promise.all([
    lanes.enqueue('a', { operation: 'first', kind: 'ordinary', run: async () => { log.push('1'); } }),
    lanes.enqueue('a', { operation: 'second', kind: 'ordinary', run: async () => { log.push('2'); } }),
    lanes.enqueue('a', { operation: 'third', kind: 'ordinary', run: async () => { log.push('3'); } }),
  ]);

  assert.deepEqual(log, ['1', '2', '3']);
  assert.deepEqual(outcomes, ['committed', 'committed', 'committed']);
});

test('a slow write in one conversation does not delay another', async () => {
  const { lanes } = coordinator();
  const log: string[] = [];
  const slow = gated(log, 'slow-a');

  const pendingA = lanes.enqueue('a', { operation: 'slow', kind: 'ordinary', run: slow.run });
  const doneB = await lanes.enqueue('b', {
    operation: 'quick',
    kind: 'ordinary',
    run: async () => { log.push('quick-b'); },
  });

  assert.equal(doneB, 'committed');
  assert.deepEqual(log, ['quick-b'], 'b committed while a is still blocked');

  slow.release();
  assert.equal(await pendingA, 'committed');
  assert.deepEqual(log, ['quick-b', 'slow-a']);
});

test('three conversation writers use three independent lanes', async () => {
  const { lanes } = coordinator();
  const log: string[] = [];
  const slow = gated(log, 'slow-a');

  const pendingA = lanes.enqueue('a', { operation: 'slow', kind: 'ordinary', run: slow.run });
  const [doneB, doneC] = await Promise.all([
    lanes.enqueue('b', {
      operation: 'quick-b',
      kind: 'ordinary',
      run: async () => { log.push('quick-b'); },
    }),
    lanes.enqueue('c', {
      operation: 'quick-c',
      kind: 'ordinary',
      run: async () => { log.push('quick-c'); },
    }),
  ]);

  assert.deepEqual([doneB, doneC], ['committed', 'committed']);
  assert.deepEqual(new Set(log), new Set(['quick-b', 'quick-c']));
  slow.release();
  assert.equal(await pendingA, 'committed');
});

test('a newer checkpoint supersedes the one still queued', async () => {
  const { lanes } = coordinator();
  const log: string[] = [];
  const head = gated(log, 'head');

  const pendingHead = lanes.enqueue('a', { operation: 'head', kind: 'ordinary', run: head.run });
  const stale = lanes.enqueue('a', {
    operation: 'checkpoint',
    kind: 'checkpoint',
    generationId: 'gen',
    run: async () => { log.push('stale-checkpoint'); },
  });
  const fresh = lanes.enqueue('a', {
    operation: 'checkpoint',
    kind: 'checkpoint',
    generationId: 'gen',
    run: async () => { log.push('fresh-checkpoint'); },
  });

  head.release();
  await pendingHead;

  assert.equal(await stale, 'skipped');
  assert.equal(await fresh, 'committed');
  assert.deepEqual(log, ['head', 'fresh-checkpoint'], 'only the newest snapshot is written');
});

test('a terminal write discards checkpoints queued ahead of it', async () => {
  // The hazard characterized in Phase 0: a checkpoint captured before
  // finalization must never reach Dexie after the terminal row.
  const { lanes } = coordinator();
  const log: string[] = [];
  const head = gated(log, 'head');

  const pendingHead = lanes.enqueue('a', { operation: 'head', kind: 'ordinary', run: head.run });
  const checkpoint = lanes.enqueue('a', {
    operation: 'checkpoint active generation',
    kind: 'checkpoint',
    generationId: 'gen',
    run: async () => { log.push('checkpoint'); },
  });
  const terminal = lanes.enqueue('a', {
    operation: 'finalize',
    kind: 'terminal',
    generationId: 'gen',
    run: async () => { log.push('terminal'); },
  });

  head.release();
  await pendingHead;

  assert.equal(await checkpoint, 'skipped');
  assert.equal(await terminal, 'committed');
  assert.deepEqual(log, ['head', 'terminal']);
});

test('a checkpoint enqueued after its generation terminalized is skipped', async () => {
  const { lanes } = coordinator();
  const log: string[] = [];

  assert.equal(
    await lanes.enqueue('a', {
      operation: 'finalize',
      kind: 'terminal',
      generationId: 'gen',
      run: async () => { log.push('terminal'); },
    }),
    'committed',
  );

  const late = await lanes.enqueue('a', {
    operation: 'checkpoint active generation',
    kind: 'checkpoint',
    generationId: 'gen',
    run: async () => { log.push('late-checkpoint'); },
  });

  assert.equal(late, 'skipped');
  assert.deepEqual(log, ['terminal'], 'a late checkpoint cannot revive pre-terminal content');
});

test('a replacement generation checkpoints normally after the previous one terminalized', async () => {
  const { lanes } = coordinator();
  const log: string[] = [];

  await lanes.enqueue('a', {
    operation: 'finalize',
    kind: 'terminal',
    generationId: 'gen-1',
    run: async () => { log.push('terminal-1'); },
  });
  const replacement = await lanes.enqueue('a', {
    operation: 'checkpoint active generation',
    kind: 'checkpoint',
    generationId: 'gen-2',
    run: async () => { log.push('checkpoint-2'); },
  });

  assert.equal(replacement, 'committed');
  assert.deepEqual(log, ['terminal-1', 'checkpoint-2']);
});

test('a checkpoint older than the committed revision is skipped', async () => {
  const { lanes } = coordinator();
  const log: string[] = [];
  const head = gated(log, 'head');

  const pendingHead = lanes.enqueue('a', { operation: 'head', kind: 'ordinary', run: head.run });
  const newer = lanes.enqueue('a', {
    operation: 'append',
    kind: 'ordinary',
    revision: 5,
    run: async () => { log.push('revision-5'); },
  });
  const older = lanes.enqueue('a', {
    operation: 'checkpoint active generation',
    kind: 'checkpoint',
    generationId: 'gen',
    revision: 3,
    run: async () => { log.push('revision-3'); },
  });

  head.release();
  await pendingHead;

  assert.equal(await newer, 'committed');
  assert.equal(await older, 'skipped');
  assert.deepEqual(log, ['head', 'revision-5']);
});

test('closing a lane refuses queued and later writes without running them', async () => {
  const { lanes } = coordinator();
  const log: string[] = [];
  const head = gated(log, 'head');

  const pendingHead = lanes.enqueue('a', { operation: 'head', kind: 'ordinary', run: head.run });
  const queued = lanes.enqueue('a', {
    operation: 'append',
    kind: 'ordinary',
    run: async () => { log.push('should-not-run'); },
  });

  lanes.close('a');
  assert.equal(await queued, 'closed');

  const afterClose = await lanes.enqueue('a', {
    operation: 'late append',
    kind: 'ordinary',
    run: async () => { log.push('also-should-not-run'); },
  });
  assert.equal(afterClose, 'closed');

  head.release();
  await pendingHead;
  assert.deepEqual(log, ['head'], 'no write after the close resurrects rows');
});

test('closing one conversation leaves other lanes working', async () => {
  const { lanes } = coordinator();
  const log: string[] = [];

  lanes.close('deleted');
  assert.equal(
    await lanes.enqueue('deleted', {
      operation: 'append',
      kind: 'ordinary',
      run: async () => { log.push('deleted'); },
    }),
    'closed',
  );
  assert.equal(
    await lanes.enqueue('alive', {
      operation: 'append',
      kind: 'ordinary',
      run: async () => { log.push('alive'); },
    }),
    'committed',
  );
  assert.deepEqual(log, ['alive']);
});

test('a failing write is reported against its conversation and does not stall the lane', async () => {
  const { lanes, failures } = coordinator();
  const log: string[] = [];
  const boom = new Error('quota exceeded');

  const failed = await lanes.enqueue('a', {
    operation: 'append conversation message',
    kind: 'ordinary',
    run: async () => { throw boom; },
  });
  const next = await lanes.enqueue('a', {
    operation: 'append conversation message',
    kind: 'ordinary',
    run: async () => { log.push('after-failure'); },
  });

  assert.equal(failed, 'failed');
  assert.equal(next, 'committed');
  assert.deepEqual(log, ['after-failure']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].conversationId, 'a');
  assert.equal(failures[0].operation, 'append conversation message');
  assert.equal(failures[0].error, boom);
});

test('failures in two conversations are both reported', async () => {
  // The single latest-value `persistenceFailure` slot loses the first error.
  // Lane reporting must attribute each one.
  const { lanes, failures } = coordinator();

  await Promise.all([
    lanes.enqueue('a', {
      operation: 'save conversation metadata',
      kind: 'ordinary',
      run: async () => { throw new Error('a failed'); },
    }),
    lanes.enqueue('b', {
      operation: 'save conversation metadata',
      kind: 'ordinary',
      run: async () => { throw new Error('b failed'); },
    }),
  ]);

  assert.deepEqual(failures.map((entry) => entry.conversationId).sort(), ['a', 'b']);
});

test('drain resolves only after queued work settles', async () => {
  const { lanes } = coordinator();
  const log: string[] = [];
  const slow = gated(log, 'slow');

  const pending = lanes.enqueue('a', { operation: 'slow', kind: 'ordinary', run: slow.run });
  assert.equal(lanes.isBusy('a'), true);

  let drained = false;
  const draining = lanes.drain('a').then(() => { drained = true; });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(drained, false, 'drain waits for the running task');

  slow.release();
  await pending;
  await draining;

  assert.equal(drained, true);
  assert.equal(lanes.isBusy('a'), false);
});

test('drain of an idle conversation resolves immediately', async () => {
  const { lanes } = coordinator();
  await lanes.drain('never-used');
  await lanes.drainAll();
});

test('global maintenance seals existing and never-before-seen lanes before its first await', async () => {
  const { lanes } = coordinator();
  const log: string[] = [];
  const head = gated(log, 'head');
  const running = lanes.enqueue('existing', {
    operation: 'running write',
    kind: 'ordinary',
    run: head.run,
  });

  const maintenance = lanes.beginGlobalMaintenance();
  assert.equal(
    await lanes.enqueue('existing', {
      operation: 'late existing write',
      kind: 'ordinary',
      run: async () => { log.push('late-existing'); },
    }),
    'closed',
  );
  assert.equal(
    await lanes.enqueue('new-id', {
      operation: 'late new write',
      kind: 'ordinary',
      run: async () => { log.push('late-new'); },
    }),
    'closed',
  );

  let drained = false;
  const draining = maintenance.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false, 'maintenance waits for work admitted before its seal');

  head.release();
  assert.equal(await running, 'committed');
  await draining;
  maintenance.closeKnownLanes();
  assert.equal(maintenance.release(), true);

  const nextMaintenance = lanes.beginGlobalMaintenance();
  assert.equal(maintenance.release(), false, 'a stale release cannot affect another owner');
  assert.equal(
    await lanes.enqueue('new-id', {
      operation: 'blocked by successor maintenance',
      kind: 'ordinary',
      run: async () => { log.push('stale-release-escaped'); },
    }),
    'closed',
  );
  assert.equal(nextMaintenance.release(), true);

  assert.equal(
    await lanes.enqueue('existing', {
      operation: 'resurrect closed lane',
      kind: 'ordinary',
      run: async () => { log.push('resurrected'); },
    }),
    'closed',
  );
  assert.equal(
    await lanes.enqueue('new-id', {
      operation: 'new lifetime',
      kind: 'ordinary',
      run: async () => { log.push('new-lifetime'); },
    }),
    'committed',
  );
  assert.deepEqual(log, ['head', 'new-lifetime']);
});

test('a logical unit writes message and metadata together or not at all', async () => {
  // Two unordered promises can split `messageCount` from its message. One task
  // owning both writes cannot.
  const { lanes } = coordinator();
  const writes: string[] = [];

  await lanes.enqueue('a', {
    operation: 'append conversation message',
    kind: 'ordinary',
    run: async () => {
      writes.push('message');
      writes.push('metadata');
    },
  });

  assert.deepEqual(writes, ['message', 'metadata']);
});
