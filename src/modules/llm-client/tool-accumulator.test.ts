/**
 * ToolCallAccumulator unit tests.
 * Run with: node --test src/modules/llm-client/tool-accumulator.test.ts
 *
 * Note: this file is a .ts file using the Node test runner. Node 20+ has
 * built-in --test support; --experimental-strip-types makes TypeScript
 * work natively without a build step. We invoke via `node --import
 * tsx --test ...` to keep the toolchain minimal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallAccumulator, TOOL_CALL_ARGS_MAX_CHARS } from './tool-accumulator.ts';

test('single call, deltas in order', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 0, id: 'call_1', type: 'function', function: { name: 'lc_read_file', arguments: '{"path"' } });
  a.ingest({ index: 0, function: { arguments: ':"/tmp/x"}' } });
  const out = a.finalize();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'call_1');
  assert.equal(out[0].type, 'function');
  assert.equal(out[0].function.name, 'lc_read_file');
  assert.equal(out[0].function.arguments, '{"path":"/tmp/x"}');
});

test('two parallel calls, interleaved deltas', () => {
  const a = new ToolCallAccumulator();
  // Index 0: read_file, args arrive in 2 fragments: '{"' + 'path":"/a"}'
  a.ingest({ index: 0, id: 'c0', function: { name: 'lc_read_file', arguments: '{"' } });
  a.ingest({ index: 0, function: { arguments: 'path":"/a"}' } });
  // Index 1: list_dir, args arrive in 2 fragments: '{"path":' + '"/b"}'
  a.ingest({ index: 1, id: 'c1', function: { name: 'lc_list_dir', arguments: '{"path":' } });
  a.ingest({ index: 1, function: { arguments: '"/b"}' } });
  const out = a.finalize();
  assert.equal(out.length, 2);
  // Order is by index, not arrival order
  assert.equal(out[0].id, 'c0');
  assert.equal(out[0].function.name, 'lc_read_file');
  assert.equal(out[0].function.arguments, '{"path":"/a"}');
  assert.equal(out[1].id, 'c1');
  assert.equal(out[1].function.name, 'lc_list_dir');
  assert.equal(out[1].function.arguments, '{"path":"/b"}');
});

test('id arrives in a later delta than name', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 0, function: { name: 'lc_read_file' } });
  a.ingest({ index: 0, id: 'late_id', function: { arguments: '{}' } });
  const out = a.finalize();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'late_id');
  assert.equal(out[0].function.name, 'lc_read_file');
});

test('later deltas cannot replace the first non-empty call identity', () => {
  const a = new ToolCallAccumulator();
  a.ingest({
    index: 0,
    id: 'first-id',
    function: { name: 'lc_read_file', arguments: '{"path":' },
  });
  a.ingest({
    index: 0,
    id: 'replacement-id',
    function: { name: 'lc_run_shell', arguments: '"/tmp/a"}' },
  });

  const out = a.finalize();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'first-id');
  assert.equal(out[0].function.name, 'lc_read_file');
  assert.equal(out[0].function.arguments, '{"path":"/tmp/a"}');
});

test('missing id at stream end → skipped with warn', () => {
  // Suppress the console.warn so test output isn't noisy
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const a = new ToolCallAccumulator();
    a.ingest({ index: 0, function: { name: 'lc_read_file', arguments: '{}' } });
    const out = a.finalize();
    assert.equal(out.length, 0);
  } finally {
    console.warn = origWarn;
  }
});

test('missing name at stream end → skipped with warn', () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const a = new ToolCallAccumulator();
    a.ingest({ index: 0, id: 'c0', function: { arguments: '{}' } });
    const out = a.finalize();
    assert.equal(out.length, 0);
  } finally {
    console.warn = origWarn;
  }
});

test('empty arguments → defaults to "{}"', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 0, id: 'c0', function: { name: 'lc_get_current_time' } });
  // no arguments delta at all
  const out = a.finalize();
  assert.equal(out.length, 1);
  assert.equal(out[0].function.arguments, '{}');
});

test('no deltas → empty array', () => {
  const a = new ToolCallAccumulator();
  const out = a.finalize();
  assert.equal(out.length, 0);
});

test('post-finalize ingest is a no-op', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 0, id: 'c0', function: { name: 'lc_read_file', arguments: '{}' } });
  const out1 = a.finalize();
  // Try to inject more after finalize
  a.ingest({ index: 0, id: 'injected', function: { name: 'evil', arguments: '{}' } });
  a.ingest({ index: 1, id: 'c1', function: { name: 'lc_list_dir', arguments: '{}' } });
  const out2 = a.finalize();
  // out2 is the same cached array, no injection
  assert.equal(out1, out2); // reference-equal (idempotent)
  assert.equal(out2.length, 1);
  assert.equal(out2[0].id, 'c0');
});

test('finalize is idempotent (second call returns same array)', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 0, id: 'c0', function: { name: 'lc_read_file', arguments: '{}' } });
  const out1 = a.finalize();
  const out2 = a.finalize();
  assert.equal(out1, out2); // same reference
});

test('returned array is frozen', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 0, id: 'c0', function: { name: 'lc_read_file', arguments: '{}' } });
  const out = a.finalize();
  assert.equal(Object.isFrozen(out), true);
  // Mutating throws in strict mode
  assert.throws(() => { Array.prototype.push.call(out, { id: 'evil' }); }, TypeError);
});

test('unicode in arguments concatenates correctly', () => {
  const a = new ToolCallAccumulator();
  // Real LM Studio emits these in pieces; emoji is multi-byte UTF-8
  // and could land across a delta boundary. Concatenation should
  // preserve the original string.
  a.ingest({ index: 0, id: 'c0', function: { name: 'test', arguments: '{"emoji":"' } });
  a.ingest({ index: 0, function: { arguments: '⚙️' } });
  a.ingest({ index: 0, function: { arguments: '"}' } });
  const out = a.finalize();
  assert.equal(out[0].function.arguments, '{"emoji":"⚙️"}');
});

// ── Phase 4.4: sort-by-index + structured issues ─────────────────

test('sort by numeric index — out-of-order insertion', () => {
  const a = new ToolCallAccumulator();
  // Insert index 1 first, then index 0. Output must be [0, 1] not [1, 0].
  a.ingest({ index: 1, id: 'c1', function: { name: 'lc_list_dir', arguments: '{}' } });
  a.ingest({ index: 0, id: 'c0', function: { name: 'lc_read_file', arguments: '{}' } });
  const out = a.finalize();
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'c0');
  assert.equal(out[0].function.name, 'lc_read_file');
  assert.equal(out[1].id, 'c1');
  assert.equal(out[1].function.name, 'lc_list_dir');
});

test('sort by numeric index — sparse indices', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 5, id: 'c5', function: { name: 't5', arguments: '{}' } });
  a.ingest({ index: 2, id: 'c2', function: { name: 't2', arguments: '{}' } });
  a.ingest({ index: 7, id: 'c7', function: { name: 't7', arguments: '{}' } });
  const out = a.finalize();
  assert.equal(out.length, 3);
  assert.equal(out[0].function.name, 't2');
  assert.equal(out[1].function.name, 't5');
  assert.equal(out[2].function.name, 't7');
});

test('structured issues — missing id produces issue', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 0, function: { name: 'lc_read_file', arguments: '{}' } });
  const out = a.finalize();
  assert.equal(out.length, 0);
  const issues = a.issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'incomplete_tool_slot');
  assert.equal(issues[0].index, 0);
  assert.equal(issues[0].hasId, false);
  assert.equal(issues[0].hasName, true);
  assert.ok(issues[0].message.includes('id'));
});

test('structured issues — missing name produces issue', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 1, id: 'c1', function: { arguments: '{}' } });
  const out = a.finalize();
  assert.equal(out.length, 0);
  const issues = a.issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'incomplete_tool_slot');
  assert.equal(issues[0].index, 1);
  assert.equal(issues[0].hasId, true);
  assert.equal(issues[0].hasName, false);
  assert.ok(issues[0].message.includes('name'));
});

test('structured issues — both missing produces one issue', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 0, function: { arguments: '{"partial"' } });
  const out = a.finalize();
  assert.equal(out.length, 0);
  const issues = a.issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].hasId, false);
  assert.equal(issues[0].hasName, false);
});

test('structured issues — no issues when all slots complete', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 0, id: 'c0', function: { name: 'tool_a', arguments: '{}' } });
  a.finalize();
  const issues = a.issues;
  assert.equal(issues.length, 0);
});

test('structured issues — issues array is frozen', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 0, function: { name: 'tool', arguments: '{}' } }); // no id
  a.finalize();
  assert.equal(Object.isFrozen(a.issues), true);
});

test('issues getter triggers finalize lazily', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 0, id: 'c0', function: { name: 'tool', arguments: '{}' } });
  // Access issues before calling finalize()
  const issues = a.issues;
  assert.equal(issues.length, 0); // complete slot, no issues
  // Now finalize should be idempotent
  const out = a.finalize();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'c0');
});

// ── Argument-length cap ────────────────────────────────────────

test('argument stream over the cap drops the slot with a structured issue', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 0, id: 'c0', function: { name: 'lc_write_file', arguments: 'x'.repeat(TOOL_CALL_ARGS_MAX_CHARS + 10_000) } });
  const out = a.finalize();
  assert.equal(out.length, 0, 'a capped argument string must never be executed');
  const issues = a.issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'incomplete_tool_slot');
  assert.equal(issues[0].hasId, true);
  assert.equal(issues[0].hasName, true);
  assert.ok(issues[0].message.includes('argument'));
});

test('argument stream at exactly the cap stays valid', () => {
  const a = new ToolCallAccumulator();
  // Build an argument string whose length is exactly TOOL_CALL_ARGS_MAX_CHARS:
  // 12 characters of framing plus a payload of MAX - 12.
  const framing = '{"content":""}';
  const payloadLen = TOOL_CALL_ARGS_MAX_CHARS - framing.length;
  const args = `{"content":"${'x'.repeat(payloadLen)}"}`;
  assert.equal(args.length, TOOL_CALL_ARGS_MAX_CHARS);
  a.ingest({ index: 0, id: 'c0', function: { name: 'lc_write_file', arguments: args } });
  const out = a.finalize();
  assert.equal(out.length, 1, 'an exact-cap single delta is complete, not capped');
  assert.equal(out[0].function.arguments.length, TOOL_CALL_ARGS_MAX_CHARS);
  assert.equal(a.issues.length, 0);
});

test('many split deltas past the cap: first cap bytes retained, rest counted', () => {
  const a = new ToolCallAccumulator();
  const total = TOOL_CALL_ARGS_MAX_CHARS + 50_000;
  const chunk = 64 * 1024;
  for (let offset = 0; offset < total; offset += chunk) {
    a.ingest({ index: 0, id: 'c0', function: { name: 'lc_write_file', arguments: 'y'.repeat(Math.min(chunk, total - offset)) } });
  }
  const out = a.finalize();
  assert.equal(out.length, 0, 'capped slot must not produce a wire call');
  assert.equal(a.issues.length, 1);
  assert.ok(a.issues[0].message.includes(String(TOOL_CALL_ARGS_MAX_CHARS)));
});

test('uncapped slot after a capped sibling is unaffected', () => {
  const a = new ToolCallAccumulator();
  a.ingest({ index: 0, id: 'c0', function: { name: 'lc_write_file', arguments: 'x'.repeat(TOOL_CALL_ARGS_MAX_CHARS + 1) } });
  a.ingest({ index: 1, id: 'c1', function: { name: 'lc_read_file', arguments: '{"path":"/a"}' } });
  const out = a.finalize();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'c1');
  assert.equal(out[0].function.arguments, '{"path":"/a"}');
});
