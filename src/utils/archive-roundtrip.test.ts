/**
 * JSON-level round-trip tests for the current
 * Conversation shape. The actual archive pipeline uses `Blob`,
 * `File`, and IndexedDB (browser APIs we can't reach from node),
 * so we test the JSON round-trip directly — the archive's
 * `conversations.json` is just `JSON.stringify(archive, null, 2)`,
 * so JSON round-trip ↔ archive round-trip.
 *
 * Run with:
 *   node --experimental-strip-types --test src/utils/archive-roundtrip.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Build a current Conversation with all tool-calling fields
 *  populated. Used as the source of the round-trip — if any
 *  field is dropped by serialization, this test catches it. */
function makeCurrentConversation() {
  return {
    id: 'conv_current_test',
    title: 'tool-call chat',
    createdAt: 1700000000000,
    updatedAt: 1700000010000,
    archived: false,
    model: 'qwen3.6-35b',
    serverId: 'local',
    params: {
      temperature_enabled: true,
      temperature: 0.7,
      top_p_enabled: true,
      top_p: 0.9,
      top_k_enabled: false,
      top_k: 40,
      max_tokens_enabled: true,
      max_tokens: 4096,
      repeat_penalty_enabled: false,
      repeat_penalty: 1.0,
      reasoning_enabled: false,
      reasoning_effort: 'medium',
      system_prompt: '',
      stop: '',
    },
    messages: [
      {
        id: 'm1', role: 'user', content: 'read /tmp/x.txt', createdAt: 1700000000000,
        user_board: 'u_1114221320000',
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        reasoning: 'let me read that file',
        responses_output_items: [
          { id: 'rs_42', type: 'reasoning', summary: [], encrypted_content: 'opaque' },
          {
            id: 'fc_42', type: 'function_call', call_id: 'call_42', name: 'lc_read_file',
            arguments: '{"path":"/tmp/x.txt"}', status: 'completed',
          },
        ],
        tool_calls: [
          { created_at: 0, id: 'call_42', name: 'lc_read_file', arguments: '{"path":"/tmp/x.txt"}' },
        ],
        whiteboard_refs: {
          user_board: 'u_1114221320000',
          model_initial_board: 'm_1114221320000',
          model_latest_board: 'm_1114221325000',
        },
        createdAt: 1700000000100,
      },
      {
        id: 'm3',
        role: 'tool',
        content: '{"content":"hello","total_lines":1,"size_bytes":5}',
        tool_call_id: 'call_42',
        createdAt: 1700000000200,
      },
      {
      id: 'm4',
      role: 'assistant',
      content: '',
      refusal: 'I cannot comply with that request.',
      createdAt: 1700000000300,
    },
    ],
    tools: {
      enabled: true,
      tool_grants: ['lc_web_fetch'],
      web_access_grants_initialized: true,
      whiteboard_enabled: true,
      allowed_roots: ['/home/me/projects'],
      dir_permissions: { '/home/me/projects': ['lc_read_file', 'lc_write_file'] },
      max_tool_rounds_per_turn: 128,
    },
  };
}

test('current conversation: JSON round-trip preserves all fields', () => {
  const original = makeCurrentConversation();
  const json = JSON.stringify(original);
  const restored = JSON.parse(json);

  // Top-level scalars
  assert.equal(restored.id, original.id);
  assert.equal(restored.title, original.title);
  assert.equal(restored.model, original.model);
  assert.equal(restored.serverId, original.serverId);

  // Generation params
  assert.equal(restored.params.temperature, 0.7);
  assert.equal(restored.params.max_tokens, 4096);

  // Current message fields
  const assistant = restored.messages[1];
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.reasoning, 'let me read that file');
  assert.equal(assistant.responses_output_items[0].encrypted_content, 'opaque');
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].id, 'call_42');
  assert.equal(assistant.tool_calls[0].name, 'lc_read_file');
  assert.equal(assistant.tool_calls[0].arguments, '{"path":"/tmp/x.txt"}');
  assert.equal(restored.messages[0].user_board, 'u_1114221320000');
  assert.deepEqual(assistant.whiteboard_refs, {
    user_board: 'u_1114221320000',
    model_initial_board: 'm_1114221320000',
    model_latest_board: 'm_1114221325000',
  });
  assert.equal(restored.messages[3].refusal, 'I cannot comply with that request.');

  // role: 'tool' message — tool_call_id preserved
  const tool = restored.messages[2];
  assert.equal(tool.role, 'tool');
  assert.equal(tool.tool_call_id, 'call_42');
  assert.equal(tool.content, '{"content":"hello","total_lines":1,"size_bytes":5}');

  // Current conversation-level tools config
  assert.ok(restored.tools);
  assert.equal(restored.tools.enabled, true);
  assert.equal(restored.tools.max_tool_rounds_per_turn, 128);
  assert.deepEqual(restored.tools.tool_grants, ['lc_web_fetch']);
  assert.equal(restored.tools.web_access_grants_initialized, true);
  assert.equal(restored.tools.whiteboard_enabled, true);
  assert.equal(restored.tools.allowed_roots[0], '/home/me/projects');
  // Per-directory permissions roundtrip
  assert.ok(restored.tools.dir_permissions);
  assert.deepEqual(restored.tools.dir_permissions['/home/me/projects'], [
    'lc_read_file', 'lc_write_file',
  ]);
});

test('conversation without tools field: JSON round-trip is lossless', () => {
  // A conversation without a tools field — no
  // `tool_calls` / `tool_call_id` on messages. The runtime treats this as
  // an unconfigured conversation (tools stays undefined).
  const withoutTools = {
    id: 'conv_without_tools',
    title: 'chat without tools',
    createdAt: 1600000000000,
    updatedAt: 1600000001000,
    archived: false,
    model: 'some-model',
    serverId: 'local',
    params: {
      temperature_enabled: true,
      temperature: 0.5,
      top_p_enabled: false,
      top_p: 1.0,
      top_k_enabled: false,
      top_k: 40,
      max_tokens_enabled: false,
      max_tokens: 4096,
      repeat_penalty_enabled: false,
      repeat_penalty: 1.0,
      reasoning_enabled: false,
      reasoning_effort: 'medium',
      system_prompt: '',
      stop: '',
    },
    messages: [
      { id: 'm1', role: 'user', content: 'hi', createdAt: 1600000000000 },
      { id: 'm2', role: 'assistant', content: 'hello', createdAt: 1600000000100 },
    ],
    // no `tools` field at all
  };

  const json = JSON.stringify(withoutTools);
  const restored = JSON.parse(json);

  assert.equal(restored.id, 'conv_without_tools');
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.messages[1].role, 'assistant');
  assert.equal(restored.messages[1].tool_calls, undefined);
  assert.equal(restored.tools, undefined);
  // The pipeline treats `tools: undefined` as "no tools configured" —
  // same behavior as conversations that
  // explicitly disable tools. The chat pipeline reads `c.tools?`
  // everywhere, so missing is equivalent to disabled.
});

test('mixed current conversation: messages + missing tools field', () => {
  // A conversation that has some current message shapes (tool_calls
  // on one message) but no top-level `tools` config. The
  // normalization should preserve the tool_calls and leave `tools`
  // undefined so the orchestrator uses safe defaults.
  const mixed = {
    id: 'mixed',
    title: 'partial current shape',
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    archived: false,
    model: 'x',
    serverId: 'local',
    params: {
      temperature_enabled: false,
      temperature: 1.0,
      top_p_enabled: false,
      top_p: 1.0,
      top_k_enabled: false,
      top_k: 40,
      max_tokens_enabled: false,
      max_tokens: 4096,
      repeat_penalty_enabled: false,
      repeat_penalty: 1.0,
      reasoning_enabled: false,
      reasoning_effort: 'medium',
      system_prompt: '',
      stop: '',
    },
    messages: [
      { id: 'm1', role: 'assistant', content: 'no tool here', createdAt: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        tool_calls: [
          { created_at: 0, id: 'c1', name: 'lc_get_current_time', arguments: '{}' },
        ],
        createdAt: 2,
      },
    ],
  };

  const restored = JSON.parse(JSON.stringify(mixed));
  assert.equal(restored.messages[0].tool_calls, undefined);
  assert.ok(restored.messages[1].tool_calls);
  assert.equal(restored.messages[1].tool_calls[0].name, 'lc_get_current_time');
  assert.equal(restored.tools, undefined);
});
