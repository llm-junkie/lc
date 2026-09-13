import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolRoundLifecycle } from './tool-round-lifecycle.ts';

test('a deadline-free tool round creates no timer and follows its parent abort', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let timerCalls = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    timerCalls += 1;
    return originalSetTimeout(...args);
  }) as typeof setTimeout;
  const parent = new AbortController();
  try {
    const lifecycle = createToolRoundLifecycle(parent.signal);
    assert.equal(timerCalls, 0);
    assert.equal(lifecycle.timedOut(), false);
    assert.equal(await Promise.race([
      lifecycle.timeout.then(() => 'timeout' as const),
      Promise.resolve('pending' as const),
    ]), 'pending');
    parent.abort();
    assert.equal(lifecycle.signal.aborted, true);
    assert.equal(lifecycle.timedOut(), false);
    lifecycle.dispose();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('a normal tool round still creates and clears its deadline timer', () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let timerCalls = 0;
  let clearCalls = 0;
  globalThis.setTimeout = ((..._args: Parameters<typeof setTimeout>) => {
    timerCalls += 1;
    return 73 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((_timer?: ReturnType<typeof setTimeout>) => {
    clearCalls += 1;
  }) as typeof clearTimeout;
  try {
    const lifecycle = createToolRoundLifecycle(new AbortController().signal, Date.now() + 1_000);
    assert.equal(timerCalls, 1);
    lifecycle.dispose();
    assert.equal(clearCalls, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('overlapping FIFO waits extend the deadline by their union', () => {
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = 1_000;
  const delays: number[] = [];
  let clearCalls = 0;
  Date.now = () => now;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timeout = args[1];
    delays.push(timeout ?? 0);
    return delays.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((_timer?: ReturnType<typeof setTimeout>) => {
    clearCalls += 1;
  }) as typeof clearTimeout;
  try {
    const lifecycle = createToolRoundLifecycle(
      new AbortController().signal,
      now + 100,
    );
    assert.deepEqual(delays, [100]);

    now += 20;
    lifecycle.pauseDeadline();
    now += 10;
    lifecycle.pauseDeadline();
    now += 40;
    lifecycle.resumeDeadline();
    assert.deepEqual(delays, [100]);
    now += 10;
    lifecycle.resumeDeadline();

    assert.deepEqual(delays, [100, 80]);
    assert.equal(clearCalls, 1);
    lifecycle.dispose();
    assert.equal(clearCalls, 2);
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
