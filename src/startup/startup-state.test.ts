import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STARTUP_INCOMPLETE_LIMIT,
  advanceStartupPhase,
  beginStartup,
  initialStartupMarker,
  markStartupFailure,
  markStartupReady,
  parseStartupMarker,
  requestNormalStartRetry,
  serializeStartupMarker,
} from './startup-state.ts';

function nextLaunch(raw: string | null) {
  const parsed = parseStartupMarker(raw);
  return beginStartup(parsed.marker, { automaticSafeStart: true, newProcess: true });
}

describe('Safe Start state machine', () => {
  test('one incomplete startup increments the count but still attempts normal startup', () => {
    const first = nextLaunch(null);
    assert.equal(first.mode, 'normal');
    assert.equal(first.marker.incompleteStartCount, 0);

    const second = nextLaunch(serializeStartupMarker(first.marker));
    assert.equal(second.mode, 'normal');
    assert.equal(second.marker.incompleteStartCount, 1);
  });

  test('two consecutive incomplete startups select Safe Start on the following launch', () => {
    const first = nextLaunch(null);
    const second = nextLaunch(serializeStartupMarker(first.marker));
    const third = nextLaunch(serializeStartupMarker(second.marker));
    assert.equal(third.mode, 'safe-start');
    assert.equal(third.marker.incompleteStartCount, STARTUP_INCOMPLETE_LIMIT);
    assert.equal(third.marker.safeStartState, 'active');
    assert.equal(third.marker.status, 'idle');
  });

  test('ready clears the incomplete marker and counter', () => {
    const starting = {
      ...nextLaunch(null).marker,
      incompleteStartCount: 1,
      failureCode: 'conversation-storage-unavailable' as const,
    };
    const ready = markStartupReady(starting);
    assert.equal(ready.status, 'idle');
    assert.equal(ready.lastCompletedPhase, 'ready');
    assert.equal(ready.incompleteStartCount, 0);
    assert.equal(ready.failureCode, undefined);

    const following = beginStartup(ready, { automaticSafeStart: true, newProcess: true });
    assert.equal(following.mode, 'normal');
    assert.equal(following.marker.incompleteStartCount, 0);
  });

  test('phase and readiness transitions are monotonic and idempotent', () => {
    const start = nextLaunch(null).marker;
    const settings = advanceStartupPhase(start, 'settings-validated');
    assert.equal(advanceStartupPhase(settings, 'renderer-created'), settings);
    assert.equal(advanceStartupPhase(settings, 'settings-validated'), settings);
    const ready = markStartupReady(settings);
    assert.equal(markStartupReady(ready), ready);
    assert.equal(markStartupFailure(ready, 'startup-failure-unknown'), ready);
  });

  test('development and same-process reloads do not accumulate failures', () => {
    const development = beginStartup(initialStartupMarker(), {
      automaticSafeStart: false,
      newProcess: true,
    });
    assert.equal(development.trackAttempt, false);
    assert.equal(development.marker.incompleteStartCount, 0);

    const first = nextLaunch(null);
    const reload = beginStartup(first.marker, {
      automaticSafeStart: true,
      newProcess: false,
    });
    assert.equal(reload.mode, 'normal');
    assert.equal(reload.marker, first.marker);
    assert.equal(reload.marker.incompleteStartCount, 0);

    const completedReload = beginStartup(markStartupReady(first.marker), {
      automaticSafeStart: true,
      newProcess: false,
    });
    assert.equal(completedReload.trackAttempt, false);
    assert.equal(completedReload.marker.incompleteStartCount, 0);
  });

  test('normal-start retry bypasses Safe Start once, then a failed retry returns to Safe Start', () => {
    const safeMarker = {
      ...initialStartupMarker('active'),
      incompleteStartCount: STARTUP_INCOMPLETE_LIMIT,
      safeStartState: 'active' as const,
    };
    const requested = requestNormalStartRetry(safeMarker);
    const retry = beginStartup(requested, {
      automaticSafeStart: true,
      newProcess: false,
      manualSafeStart: true,
    });
    assert.equal(retry.mode, 'normal');
    assert.equal(retry.retryAttempt, true);
    assert.equal(retry.marker.retryNormalOnce, false);

    const afterFailedRetry = beginStartup(retry.marker, {
      automaticSafeStart: true,
      newProcess: true,
    });
    assert.equal(afterFailedRetry.mode, 'safe-start');
    assert.equal(afterFailedRetry.marker.incompleteStartCount, STARTUP_INCOMPLETE_LIMIT);

    const repeatedReload = beginStartup(retry.marker, {
      automaticSafeStart: true,
      newProcess: false,
    });
    assert.equal(repeatedReload.mode, 'safe-start');
  });

  test('malformed and oversized markers fail safely without private strings', () => {
    for (const raw of [
      '{not-json',
      JSON.stringify({ version: 1, lastCompletedPhase: 'C:\\Users\\Alice', incompleteStartCount: 'x' }),
      'x'.repeat(5 * 1024),
    ]) {
      const parsed = parseStartupMarker(raw);
      assert.equal(parsed.malformed, true);
      assert.deepEqual(parsed.marker, initialStartupMarker());
      assert.equal(serializeStartupMarker(parsed.marker).includes('Alice'), false);
    }
  });

  test('explicit --safe-start requests recovery even with a zero failure count', () => {
    const requested = beginStartup(initialStartupMarker(), {
      automaticSafeStart: true,
      newProcess: true,
      manualSafeStart: true,
    });
    assert.equal(requested.mode, 'safe-start');
    assert.equal(requested.marker.safeStartState, 'active');
    assert.equal(requested.marker.incompleteStartCount, 0);
  });

  test('a failed retry from a manual Safe Start reports the real count, not the limit', () => {
    const manual = beginStartup(initialStartupMarker(), {
      automaticSafeStart: true,
      newProcess: true,
      manualSafeStart: true,
    });
    assert.equal(manual.mode, 'safe-start');
    assert.equal(manual.marker.incompleteStartCount, 0);

    const requested = requestNormalStartRetry(manual.marker);
    const retry = beginStartup(requested, {
      automaticSafeStart: true,
      newProcess: true,
    });
    assert.equal(retry.mode, 'normal');
    assert.equal(retry.retryAttempt, true);
    assert.equal(retry.marker.incompleteStartCount, 0);

    const afterFailedRetry = beginStartup(retry.marker, {
      automaticSafeStart: true,
      newProcess: true,
    });
    assert.equal(afterFailedRetry.mode, 'safe-start');
    // Exactly one launch ended early (the retry); the recovery shell must not
    // claim two consecutive launches.
    assert.equal(afterFailedRetry.marker.incompleteStartCount, 1);
  });
});
