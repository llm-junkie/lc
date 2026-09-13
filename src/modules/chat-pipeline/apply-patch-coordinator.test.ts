import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApplyPatchLockReservation } from '../tool-engine/file-lock';
import type { ApplyPatchTargetsResult } from '../tool-engine/sandbox-bridge';
import {
  coordinateApplyPatch,
  type PatchAdmission,
  type PatchApproval,
} from './apply-patch-coordinator.ts';

const RAW_PATCH = `*** Begin Patch
*** Update File: C:\\outside\\a.txt
@@
-old
+new
*** End Patch`;

interface HarnessOptions {
  patch?: string;
  admission?: PatchAdmission;
  approval?: PatchApproval;
  discovery?: ApplyPatchTargetsResult;
  discoveryError?: Error;
  preflightTargets?: string[];
}

function parentScope(target: string): string {
  return target.replace(/[\\/][^\\/]+$/, '');
}

function makeHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const popupScopes: string[][] = [];
  const persistedScopes: string[][] = [];
  const preflightRoots: string[][] = [];
  const executedPlans: string[] = [];
  let mutated = false;
  const rawPatch = options.patch ?? RAW_PATCH;
  const discovery = options.discovery ?? {
    affected_paths: ['C:\\outside\\a.txt'],
    actions: [{ action: 'update', path: 'C:\\outside\\a.txt' }],
    diagnostics: [],
  };
  const reservation: ApplyPatchLockReservation = {
    acquireTargets: async (targets) => {
      events.push(`lock:${targets.join('|')}`);
      return () => events.push('unlock-targets');
    },
    release: () => events.push('release-reservation'),
  };

  const run = () => coordinateApplyPatch({
    admission: options.admission ?? { allowed: true },
    patch: rawPatch,
    initialAllowedRoots: ['C:\\workspace'],
    reserve: async () => {
      events.push('reserve');
      return reservation;
    },
    discover: async (patch) => {
      events.push('discover');
      assert.equal(patch, rawPatch);
      if (options.discoveryError) throw options.discoveryError;
      return discovery;
    },
    resolveTargetScope: async (target) => parentScope(target),
    authorize: (scopes) => {
      events.push('authorize');
      return { state: 'prompt', requiredScopes: scopes };
    },
    requestApproval: async (scopes) => {
      events.push('popup');
      popupScopes.push([...scopes]);
      return options.approval ?? { decision: 'deny' };
    },
    canonicalizeApprovedScope: async (scope) => scope,
    persistSessionScopes: async (scopes) => {
      events.push('persist');
      persistedScopes.push([...scopes]);
      return { ok: true, allowedRoots: ['C:\\workspace', ...scopes] };
    },
    preflight: async (_patch, roots) => {
      events.push('preflight');
      preflightRoots.push([...roots]);
      return {
        plan_id: 'native-plan-42',
        affected_paths: options.preflightTargets ?? discovery.affected_paths,
        actions: discovery.actions,
        diagnostics: [],
      };
    },
    execute: async ({ planId }) => {
      events.push('execute');
      executedPlans.push(planId);
      mutated = true;
      return { output: 'applied', is_error: false, duration_ms: 1 };
    },
    normalizeError: (error) => ({
      code: 'invalid_arguments',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    }),
  });

  return {
    run,
    events,
    popupScopes,
    persistedScopes,
    preflightRoots,
    executedPlans,
    wasMutated: () => mutated,
  };
}

describe('apply_patch coordinator acceptance', () => {
  it('presents the exact canonical parent scope and denial cannot preflight or mutate', async () => {
    const harness = makeHarness({ approval: { decision: 'deny' } });
    const result = await harness.run();

    assert.equal(result.status, 'rejected');
    assert.deepEqual(harness.popupScopes, [['C:\\outside']]);
    assert.equal(harness.events.includes('preflight'), false);
    assert.equal(harness.events.includes('execute'), false);
    assert.equal(harness.wasMutated(), false);
  });

  it('allow_once performs fresh preflight, executes its exact plan, and does not persist', async () => {
    const harness = makeHarness({
      approval: { decision: 'allow_once', grantedDirs: ['C:\\outside'] },
    });
    const result = await harness.run();

    assert.equal(result.status, 'executed');
    assert.deepEqual(harness.preflightRoots, [['C:\\workspace', 'C:\\outside']]);
    assert.deepEqual(harness.executedPlans, ['native-plan-42']);
    assert.deepEqual(harness.persistedScopes, []);
    assert.ok(harness.events.indexOf('popup') < harness.events.indexOf('preflight'));
    assert.ok(harness.events.indexOf('preflight') < harness.events.indexOf('execute'));
  });

  it('allow_session persists only the exact scopes before fresh preflight and execution', async () => {
    const harness = makeHarness({
      approval: { decision: 'allow_session', grantedDirs: ['C:\\outside'] },
    });
    const result = await harness.run();

    assert.equal(result.status, 'executed');
    assert.deepEqual(harness.persistedScopes, [['C:\\outside']]);
    assert.deepEqual(harness.preflightRoots, [['C:\\workspace', 'C:\\outside']]);
    assert.ok(harness.events.indexOf('persist') < harness.events.indexOf('preflight'));
    assert.deepEqual(harness.executedPlans, ['native-plan-42']);
  });

  it('a multi-target move presents every canonical directory without broadening', async () => {
    const movePatch = `*** Begin Patch
*** Update File: C:\\source\\old.txt
*** Move to: D:\\destination\\new.txt
@@
-old
+new
*** Update File: E:\\also\\changed.txt
@@
-before
+after
*** End Patch`;
    const discovery = {
      affected_paths: [
        'C:\\source\\old.txt',
        'D:\\destination\\new.txt',
        'E:\\also\\changed.txt',
      ],
      actions: [{ action: 'move', path: 'C:\\source\\old.txt', move_to: 'D:\\destination\\new.txt' }],
      diagnostics: [],
    };
    const exact = ['C:\\source', 'D:\\destination', 'E:\\also'];
    const harness = makeHarness({
      patch: movePatch,
      discovery,
      approval: { decision: 'allow_once', grantedDirs: exact },
    });
    const result = await harness.run();

    assert.equal(result.status, 'executed');
    assert.deepEqual(harness.popupScopes, [exact]);
    assert.deepEqual(harness.preflightRoots, [['C:\\workspace', ...exact]]);
  });

  it('malformed discovery fails non-retryably before popup, preflight, or execution', async () => {
    const harness = makeHarness({
      patch: '*** Begin Patch\n*** Update File: ..\\..\\unsafe.txt\n*** End Patch',
      discoveryError: new Error('unsafe patch path'),
    });
    const result = await harness.run();

    assert.equal(result.status, 'rejected');
    if (result.status !== 'rejected') assert.fail('expected rejection');
    assert.equal(result.stage, 'discovery');
    assert.equal(result.issue.retryable, false);
    assert.deepEqual(harness.popupScopes, []);
    assert.equal(harness.events.includes('preflight'), false);
    assert.equal(harness.events.includes('execute'), false);
  });

  it('a known but unexposed patch never reserves or invokes discovery', async () => {
    const harness = makeHarness({
      admission: {
        allowed: false,
        issue: { code: 'tool_not_exposed', message: 'disabled', retryable: false },
      },
    });
    const result = await harness.run();

    assert.equal(result.status, 'rejected');
    assert.deepEqual(harness.events, []);
  });

  it('blocks execution when discovery and fresh preflight target sets differ', async () => {
    const harness = makeHarness({
      approval: { decision: 'allow_once', grantedDirs: ['C:\\outside'] },
      preflightTargets: ['C:\\outside\\different.txt'],
    });
    const result = await harness.run();

    assert.equal(result.status, 'rejected');
    if (result.status !== 'rejected') assert.fail('expected rejection');
    assert.equal(result.stage, 'preflight');
    assert.equal(harness.events.includes('execute'), false);
    assert.equal(harness.wasMutated(), false);
  });
});
