import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWhiteboardOverlayExitGuardActive,
  registerWhiteboardOverlayExitGuard,
  requestWhiteboardOverlayExit,
  resetWhiteboardOverlayExitGuardForTests,
} from './whiteboard-overlay-guard.ts';

afterEach(resetWhiteboardOverlayExitGuardForTests);

test('allows exits when no Whiteboard overlay owns the guard', async () => {
  assert.equal(isWhiteboardOverlayExitGuardActive(), false);
  assert.equal(await requestWhiteboardOverlayExit('conversation-switch'), true);
});

test('routes the reason to the active in-app guard', async () => {
  const reasons: string[] = [];
  const unregister = registerWhiteboardOverlayExitGuard(async (reason) => {
    reasons.push(reason);
    return reason === 'close';
  });

  assert.equal(isWhiteboardOverlayExitGuardActive(), true);
  assert.equal(await requestWhiteboardOverlayExit('escape'), false);
  assert.equal(await requestWhiteboardOverlayExit('close'), true);
  assert.deepEqual(reasons, ['escape', 'close']);
  unregister();
  assert.equal(isWhiteboardOverlayExitGuardActive(), false);
});

test('fails closed when confirmation throws or returns a non-true value', async () => {
  registerWhiteboardOverlayExitGuard(() => {
    throw new Error('confirmation renderer failed');
  });
  assert.equal(await requestWhiteboardOverlayExit('backdrop'), false);

  registerWhiteboardOverlayExitGuard(async () => undefined as never);
  assert.equal(await requestWhiteboardOverlayExit('parent-unmount'), false);
});

test('a stale unregister cannot clear a newer overlay owner', async () => {
  const unregisterOld = registerWhiteboardOverlayExitGuard(() => false);
  registerWhiteboardOverlayExitGuard(() => true);
  unregisterOld();
  assert.equal(await requestWhiteboardOverlayExit('preview-open'), true);
});
