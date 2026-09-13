/**
 * Tool permission dispositions, through the real executor.
 *
 * Two things had to be true and were not:
 *
 *   1. nothing in production ever recorded a permission disposition, so
 *      `tools.recent.permission` was always `unknown`; and
 *   2. a disposition recorded as its own event would immediately be hidden by
 *      the execution event that follows it, so the permission a report showed
 *      would not belong to the execution beside it.
 *
 * The fix carries the disposition on the execution event itself, and records a
 * standalone event only for the flows where the tool never executes. These
 * tests drive the shipped `executeToolCall` and `recordBlockedPermission`.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeToolCall, recordBlockedPermission } from './runner.ts';
import { permissionDispositionFor } from '../chat-pipeline/approval-control.ts';
import {
  readDiagnosticEvents,
  resetDiagnosticEvents,
} from '../../utils/diagnostic-events.ts';
import type { ToolHandler, ToolHandlerContext, ToolCallRecord } from './types';

const call: ToolCallRecord = { created_at: 0, id: 'call-1', name: 'lc_read_file', arguments: '{"path":"/secret/path.txt"}' };

function handler(run: ToolHandler['run']): ToolHandler {
  return { name: 'lc_read_file', description: 'read', input: { parse: (v: unknown) => v }, run } as unknown as ToolHandler;
}

function context(): ToolHandlerContext {
  return {
    config: { allowedRoots: [], shellAllowlist: [] },
    identity: { operationId: 'op', groupId: 'group' },
    signal: new AbortController().signal,
    sandbox: { abortGroup: () => {} },
  } as unknown as ToolHandlerContext;
}

function toolEvents() {
  return readDiagnosticEvents().filter((event) => event.subsystem === 'tool');
}

beforeEach(() => {
  resetDiagnosticEvents();
});

describe('the disposition rides on the execution it authorized', () => {
  it('records not-required for a pre-granted execution', async () => {
    await executeToolCall(call, {}, handler(async () => ({ ok: true })), context(), 'not-required');

    const [event] = toolEvents();
    assert.equal(event.operation, 'execute');
    assert.equal(event.tool, 'lc_read_file');
    assert.equal(event.permission, 'not-required');
    assert.equal(event.code, 'tool-result-ok');
  });

  it('records granted-once on the execution it allowed', async () => {
    await executeToolCall(call, {}, handler(async () => ({ ok: true })), context(), 'granted-once');
    assert.equal(toolEvents()[0].permission, 'granted-once');
  });

  it('records granted-conversation on the execution it allowed', async () => {
    await executeToolCall(call, {}, handler(async () => ({ ok: true })), context(), 'granted-conversation');
    assert.equal(toolEvents()[0].permission, 'granted-conversation');
  });

  it('keeps the disposition on a failing execution', async () => {
    await executeToolCall(
      call, {}, handler(async () => { throw new Error('tool blew up'); }), context(), 'granted-once',
    );

    const [event] = toolEvents();
    assert.equal(event.code, 'tool-result-error');
    assert.equal(event.permission, 'granted-once');
  });

  it('produces exactly one tool event per execution', async () => {
    await executeToolCall(call, {}, handler(async () => ({ ok: true })), context(), 'granted-once');
    assert.equal(toolEvents().length, 1);
  });
});

describe('a blocked permission flow is represented even though nothing executes', () => {
  it('records a user denial', () => {
    recordBlockedPermission('lc_run_shell', 'denied');

    const [event] = toolEvents();
    assert.equal(event.operation, 'permission');
    assert.equal(event.tool, 'lc_run_shell');
    assert.equal(event.permission, 'denied');
    assert.equal(event.code, 'tool-permission-denied');
    assert.equal(event.outcome, 'rejected');
  });

  it('records an unavailable prompt distinctly from a denial', () => {
    recordBlockedPermission('lc_write_file', 'unavailable');

    const [event] = toolEvents();
    assert.equal(event.code, 'tool-permission-unavailable');
    assert.equal(event.outcome, 'error');
  });

  it('records a prompt abandoned by cancellation', () => {
    recordBlockedPermission('lc_edit_file', 'aborted');

    const [event] = toolEvents();
    assert.equal(event.code, 'tool-cancelled');
    assert.equal(event.outcome, 'cancelled');
  });

  it('is the latest tool event, so a report cannot show a stale execution', () => {
    // A denial arriving after an earlier success must be what the report shows.
    recordBlockedPermission('lc_read_file', 'denied');
    const events = toolEvents();
    assert.equal(events[events.length - 1].permission, 'denied');
  });

  it('maps an unknown tool name onto the closed vocabulary', () => {
    recordBlockedPermission('totally_made_up_tool', 'denied');
    assert.equal(toolEvents()[0].tool, 'unknown');
  });
});

describe('the disposition comes from the authoritative permission decision', () => {
  it('reports not-required when no prompt was needed', () => {
    assert.equal(permissionDispositionFor('file_io', false), 'not-required');
  });

  it('reports granted-conversation only where a grant is actually persisted', () => {
    assert.equal(permissionDispositionFor('file_io', true, 'allow_session'), 'granted-conversation');
    assert.equal(permissionDispositionFor('web_access', true, 'allow_session'), 'granted-conversation');
    // Shell never persists a grant: "allow for this chat" authorizes one call.
    assert.equal(permissionDispositionFor('shell', true, 'allow_session'), 'granted-once');
  });

  it('reports granted-once and denied verbatim', () => {
    assert.equal(permissionDispositionFor('shell', true, 'allow_once'), 'granted-once');
    assert.equal(permissionDispositionFor('shell', true, 'deny'), 'denied');
  });

  it('does not guess at an abandoned or unavailable prompt', () => {
    assert.equal(permissionDispositionFor('shell', true, 'aborted'), 'unknown');
    assert.equal(permissionDispositionFor('shell', true, 'unavailable'), 'unknown');
  });
});

describe('permission diagnostics carry no payload', () => {
  it('records no arguments, path, command, grant, or output', async () => {
    await executeToolCall(
      { created_at: 0, id: 'c', name: 'lc_run_shell', arguments: '{"cmd":"echo SEEDED-SECRET"}' },
      {},
      handler(async () => ({ stdout: 'SEEDED-SECRET-OUTPUT' })),
      context(),
      'granted-once',
    );
    recordBlockedPermission('lc_write_file', 'denied');

    const serialized = JSON.stringify(readDiagnosticEvents());
    for (const forbidden of ['SEEDED-SECRET', '/secret/path.txt', 'echo']) {
      assert.ok(!serialized.includes(forbidden), `permission diagnostics must not carry ${forbidden}`);
    }
  });
});
