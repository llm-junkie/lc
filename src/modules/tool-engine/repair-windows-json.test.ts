/**
 * repairWindowsJson regression tests.
 *
 * The function lives in `runner.ts`, whose import chain needs the tsx
 * loader (Tauri stubs, `import.meta.env`), so these tests run in the
 * tsx segment of the test script. They pin the claims in
 * docs/tools/tool-error-handling.md#repairwindowsjson-is-only-ever-a-fallback:
 * the repair is idempotent on already-correct JSON and fixes the
 * single-backslash Windows-path case.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentTime } from './builtin/get_current_time.ts';
import { repairWindowsJson, repairWindowsJsonAfterParseFailure, validateToolCalls } from './runner.ts';

describe('repairWindowsJson', () => {
  it('leaves valid single-backslash path JSON unchanged (idempotent)', () => {
    // JSON text with the correct `\\` escape: parses to the path D:\DEV.
    const input = '{"path":"D:\\\\DEV"}';
    assert.equal(JSON.parse(input).path, 'D:\\DEV');
    const once = repairWindowsJson(input);
    const twice = repairWindowsJson(once);
    assert.equal(once, input);
    assert.equal(twice, input);
  });

  it('leaves valid double-backslash path JSON unchanged', () => {
    // JSON text with two `\\` escapes: parses to the path D:\\DEV.
    const input = '{"path":"D:\\\\\\\\DEV"}';
    assert.equal(JSON.parse(input).path, 'D:\\\\DEV');
    assert.equal(repairWindowsJson(input), input);
  });

  it('preserves valid JSON escapes', () => {
    const input = '{"s":"a\\nb\\tt\\"q\\\\z"}';
    assert.equal(JSON.parse(input).s, 'a\nb\tt"q\\z');
    assert.equal(repairWindowsJson(input), input);
  });

  it('repairs the broken single-backslash case into parseable JSON', () => {
    // Invalid JSON: a lone backslash before `D`.
    const broken = '{"path":"D:\\DEV"}';
    assert.throws(() => JSON.parse(broken));
    const repaired = repairWindowsJson(broken);
    assert.equal(JSON.parse(repaired).path, 'D:\\DEV');
    // And the repair is a fixed point.
    assert.equal(repairWindowsJson(repaired), repaired);
  });

  it('routes production repair through a parse-first gate', () => {
    const valid = '{"path":"D:\\\\DEV","text":"line\\nnext"}';
    assert.equal(repairWindowsJsonAfterParseFailure(valid), valid);

    const broken = '{"path":"D:\\DEV"}';
    assert.throws(() => JSON.parse(broken));
    assert.equal(JSON.parse(repairWindowsJsonAfterParseFailure(broken)).path, 'D:\\DEV');
  });
});

describe('validateToolCalls JSON gate', () => {
  const handlers = new Map([[getCurrentTime.name, getCurrentTime]]);

  it('accepts valid JSON without correction', () => {
    const [validated] = validateToolCalls([{
      created_at: 0,
      id: 'valid-json',
      name: getCurrentTime.name,
      arguments: '{"tz":"UTC"}',
    }], handlers);

    assert.deepEqual(validated.parsed, { tz: 'UTC' });
    assert.equal(validated.error, undefined);
  });

  it('rejects unrecoverable malformed JSON', () => {
    const [validated] = validateToolCalls([{
      created_at: 0,
      id: 'malformed-json',
      name: getCurrentTime.name,
      arguments: '{"tz":',
    }], handlers);

    assert.equal(validated.parsed, undefined);
    assert.equal(validated.error?.[0]?.code, 'invalid_arguments');
    assert.match(validated.error?.[0]?.message ?? '', /not valid JSON|could not be parsed/i);
  });

  it('repairs a Windows backslash only after parse failure and validates the repaired value', () => {
    const [validated] = validateToolCalls([{
      created_at: 0,
      id: 'windows-json',
      name: getCurrentTime.name,
      arguments: '{"tz":"D:\\DEV"}',
    }], handlers);

    assert.deepEqual(validated.parsed, { tz: 'D:\\DEV' });
    assert.equal(validated.error, undefined);
  });
});
