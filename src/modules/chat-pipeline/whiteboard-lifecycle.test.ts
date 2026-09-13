import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  WhiteboardToolMutationState,
  WhiteboardToolSnapshot,
} from '../tool-engine/types';
import { createWhiteboardGenerationLifecycle } from './whiteboard-lifecycle.ts';

const snapshot: WhiteboardToolSnapshot = {
  refs: {
    user_board: 'u_0822142950012',
    model_initial_board: 'm_0822142950012',
    model_latest_board: 'm_0822142950012',
  },
  userMarkdown: '# User',
  modelMarkdown: '# Model',
};

const mutation: WhiteboardToolMutationState = {
  refs: {
    ...snapshot.refs,
    model_latest_board: 'm_0822143119048',
  },
  changed: true,
  modelMarkdown: '# Changed',
};

describe('generation-owned Whiteboard lifecycle queue', () => {
  it('settles behind a committed write and suppresses its stale ordinary result', async () => {
    let active = true;
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const events: string[] = [];
    const lifecycle = createWhiteboardGenerationLifecycle({
      isActive: () => active,
      read: async () => ({ ok: true, value: snapshot }),
      replaceModel: async () => {
        events.push('write:start');
        writeStarted();
        await released;
        events.push('write:commit');
        return { ok: true, value: mutation };
      },
      settle: async () => { events.push('settle'); },
    });
    const signal = new AbortController().signal;

    const write = lifecycle.service.replaceModel({
      content: mutation.modelMarkdown,
      toolCallId: 'whiteboard-call',
      signal,
    });
    await started;
    active = false;
    const settlement = lifecycle.settle('aborted');
    assert.equal(lifecycle.ordinaryResultsAllowed(), false);
    releaseWrite();

    assert.deepEqual(await write, { ok: false, code: 'aborted' });
    assert.equal(await settlement, true);
    assert.deepEqual(events, ['write:start', 'write:commit', 'settle']);
    assert.equal(await lifecycle.settle('timeout'), true);
    assert.deepEqual(events, ['write:start', 'write:commit', 'settle']);
  });

  it('rejects queued and late workers once terminal closure is requested', async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let writes = 0;
    const lifecycle = createWhiteboardGenerationLifecycle({
      isActive: () => true,
      read: async () => ({ ok: true, value: snapshot }),
      replaceModel: async () => {
        writes += 1;
        if (writes === 1) {
          firstStarted();
          await released;
        }
        return { ok: true, value: mutation };
      },
      settle: async () => {},
    });
    const signal = new AbortController().signal;
    const first = lifecycle.service.replaceModel({ content: 'A', toolCallId: 'call-a', signal });
    await started;
    const queued = lifecycle.service.replaceModel({ content: 'B', toolCallId: 'call-b', signal });
    const settlement = lifecycle.settle('timeout');
    releaseFirst();

    assert.deepEqual(await first, { ok: false, code: 'aborted' });
    assert.deepEqual(await queued, { ok: false, code: 'aborted' });
    assert.equal(await settlement, true);
    assert.equal(writes, 1);
    assert.deepEqual(
      await lifecycle.service.replaceModel({ content: 'C', toolCallId: 'call-c', signal }),
      { ok: false, code: 'aborted' },
    );
    assert.equal(writes, 1);
  });

  it('maps thrown direct operations without leaking exceptions', async () => {
    let settlementAttempts = 0;
    const lifecycle = createWhiteboardGenerationLifecycle({
      isActive: () => true,
      read: async () => { throw new Error('read failed'); },
      replaceModel: async () => { throw new Error('write failed'); },
      settle: async () => {
        settlementAttempts += 1;
        if (settlementAttempts === 1) throw new Error('settle failed once');
      },
    });
    const signal = new AbortController().signal;

    assert.deepEqual(await lifecycle.service.read({ signal }), {
      ok: false,
      code: 'whiteboard_read_failed',
    });
    assert.deepEqual(await lifecycle.service.replaceModel({
      content: '# Changed',
      toolCallId: 'whiteboard-call',
      signal,
    }), {
      ok: false,
      code: 'whiteboard_write_failed',
    });
    assert.equal(await lifecycle.settle('generation_ended'), false);
    // A later boundary retries idempotently and keeps the first terminal
    // reason instead of reclassifying the unfinished call.
    assert.equal(await lifecycle.settle('timeout'), true);
    assert.equal(settlementAttempts, 2);
  });

  it('deduplicates concurrent settlement attempts', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let attempts = 0;
    const lifecycle = createWhiteboardGenerationLifecycle({
      isActive: () => true,
      read: async () => ({ ok: true, value: snapshot }),
      replaceModel: async () => ({ ok: true, value: mutation }),
      settle: async () => {
        attempts += 1;
        await barrier;
      },
    });

    const first = lifecycle.settle('aborted');
    const second = lifecycle.settle('timeout');
    assert.equal(first, second);
    release();
    assert.equal(await first, true);
    assert.equal(attempts, 1);
  });
});
