/**
 * `OpenAIResponsesAdapter.buildRequest` — ChatMessage[] → Responses input items.
 *
 * The Responses API models context as a flat list of typed *items* rather than
 * messages with glued-on fields: a `message`, a `function_call`, and a
 * `function_call_output` are separate items. LC's conversion therefore
 * "explodes" an assistant message carrying `tool_calls` into one message item
 * plus one `function_call` item per call — which is also what makes it
 * possible to switch a conversation between Chat Completions and Responses
 * mid-stream.
 *
 * Verified against the OpenAI docs (July 2026):
 *   - Reasoning is a NESTED object here — `reasoning: { effort, summary }` —
 *     unlike Chat Completions, which takes a flat `reasoning_effort` string.
 *     https://developers.openai.com/api/docs/guides/reasoning
 *   - Text being sent TO the model is typed `input_text`; text the model
 *     GENERATED is typed `output_text`.
 *     https://platform.openai.com/docs/guides/migrate-to-responses
 *   - `function_call_output` carries `call_id` and `output`.
 *
 * Run with:
 *   npx tsx --test src/modules/llm-client/adapters/openai-responses.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIResponsesAdapter } from './openai-responses.ts';
import { TOOL_CALL_ARGS_MAX_CHARS } from '../tool-accumulator.ts';
import type { AdapterRequestParams } from './adapter';
import type { ToolDefinition } from '../types';
import { OPENROUTER_RESPONSES_EVENTS, OPENAI_RESPONSES_EVENTS, OPENAI_ERROR_EVENT } from '../responses-event-fixtures.ts';
import { resolveBundledProviderContract } from '../provider-contracts.ts';

const adapter = new OpenAIResponsesAdapter();

function params(over: Partial<AdapterRequestParams> = {}): AdapterRequestParams {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    reasoningEnabled: false,
    ...over,
  };
}

/** `input` is a string shortcut in one narrow case; otherwise an item array. */
function items(req: { input: unknown }): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(req.input), `expected item array, got ${typeof req.input}`);
  return req.input as Array<Record<string, unknown>>;
}

function toolCall(id: string, name: string, args: string) {
  return { id, type: 'function' as const, function: { name, arguments: args } };
}

describe('OpenAIResponsesAdapter — endpoint and headers', () => {
  it('targets /responses', () => {
    assert.equal(adapter.streamEndpoint, '/responses');
    assert.equal(adapter.protocol, 'openai');
  });

  it('sends a bearer token', () => {
    assert.deepEqual(adapter.buildHeaders('sk-test'), {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
    });
  });
});

describe('OpenAIResponsesAdapter — system messages', () => {
  it('hoists a system message into top-level instructions', () => {
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
    }));
    assert.equal(req.instructions, 'Be brief.');
    assert.equal(req.input, 'hi', 'single user message collapses to the string shortcut');
  });

  it('joins multiple system messages with a newline', () => {
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'system', content: 'First.' },
        { role: 'system', content: 'Second.' },
        { role: 'user', content: 'hi' },
      ],
    }));
    assert.equal(req.instructions, 'First.\nSecond.');
  });

  it('omits instructions when no system message is present', () => {
    assert.equal(adapter.buildRequest(params()).instructions, undefined);
  });
});

describe('OpenAIResponsesAdapter — input shape', () => {
  it('collapses a lone plain user message to a bare string', () => {
    assert.equal(adapter.buildRequest(params()).input, 'hi');
  });

  it('uses the item array once there is more than one message', () => {
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ],
    }));
    const list = items(req);
    assert.equal(list.length, 2);
    assert.deepEqual(list[0], { type: 'message', role: 'user', content: 'one' });
    assert.deepEqual(list[1], { type: 'message', role: 'assistant', content: 'two' });
  });

  it('does not collapse a lone assistant message', () => {
    // The shortcut is guarded on role === 'user'.
    const req = adapter.buildRequest(params({
      messages: [{ role: 'assistant', content: 'solo' }],
    }));
    assert.equal(items(req).length, 1);
  });

  it('does not collapse a lone user message with array content', () => {
    const req = adapter.buildRequest(params({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'parts' }] }],
    }));
    assert.deepEqual(items(req)[0].content, [{ type: 'input_text', text: 'parts' }]);
  });
});

describe('OpenAIResponsesAdapter — tool calls and results', () => {
  it('explodes assistant tool_calls into separate function_call items', () => {
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'working',
          tool_calls: [toolCall('c1', 'lc_grep', '{"pattern":"x"}'), toolCall('c2', 'lc_stat', '{}')],
        },
      ],
    }));
    const list = items(req);
    assert.equal(list.length, 4, 'user + assistant message + 2 function_call items');
    assert.deepEqual(list[1], { type: 'message', role: 'assistant', content: 'working' });
    assert.deepEqual(list[2], {
      type: 'function_call',
      call_id: 'c1',
      name: 'lc_grep',
      arguments: '{"pattern":"x"}',
    });
    assert.equal(list[3].call_id, 'c2');
  });

  it('keeps tool arguments as an unparsed JSON string', () => {
    // The Responses API takes `arguments` as a string, so LC must not parse it
    // here the way the Anthropic adapter does for `tool_use.input`.
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'n', '{"a":1}')] },
      ],
    }));
    assert.equal(typeof items(req)[2].arguments, 'string');
    assert.equal(items(req)[2].arguments, '{"a":1}');
  });

  it('converts a tool message into a function_call_output item', () => {
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'n', '{}')] },
        { role: 'tool', content: 'the result', tool_call_id: 'c1' },
      ],
    }));
    const list = items(req);
    assert.deepEqual(list[list.length - 1], {
      type: 'function_call_output',
      call_id: 'c1',
      output: 'the result',
    });
  });

  it('emits a tool message without tool_call_id as a message item with role "tool"', () => {
    // ⚠️ CONFIRMED divergence. The `function_call_output` branch is guarded on
    // `tool_call_id`, so a tool message lacking one falls through to the
    // trailing user-message branch. The `m.role as 'user'` cast there hides
    // the mismatch from the type checker and the item keeps `role: 'tool'`.
    //
    // Tool results are their own item type (`function_call_output`, correlated
    // by `call_id`) — "tool" is not a message-item role.
    // https://developers.openai.com/api/docs/guides/migrate-to-responses
    //
    // Unreachable today: LC always stores tool_call_id on tool messages.
    // Recorded so the behavior is visible if that ever stops being true.
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'tool', content: 'orphan' },
      ],
    }));
    const list = items(req);
    assert.equal(list.length, 2);
    assert.deepEqual(list[1], { type: 'message', role: 'tool', content: 'orphan' });
  });

  it('still emits the assistant message item when its text is empty', () => {
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'n', '{}')] },
      ],
    }));
    const list = items(req);
    assert.deepEqual(list[1], { type: 'message', role: 'assistant', content: '' });
  });

  it('replays Responses output items, including encrypted reasoning', () => {
    const outputItems = [
      {
        id: 'rs_1',
        type: 'reasoning' as const,
        summary: [{ type: 'summary_text', text: 'checked the plan' }],
        encrypted_content: 'opaque-reasoning',
      },
      {
        id: 'msg_1',
        type: 'message' as const,
        role: 'assistant' as const,
        status: 'completed' as const,
        content: [{ type: 'output_text' as const, text: 'done', annotations: [] }],
      },
    ];
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'done', responses_output_items: outputItems },
      ],
    }));
    assert.deepEqual(items(req), [
      { type: 'message', role: 'user', content: 'go' },
      ...outputItems,
    ]);
  });

  it('replays provider-returned plaintext reasoning on compatible Responses servers', () => {
    const req = adapter.buildRequest(params({
      baseUrl: 'https://compatible.example/v1',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall('archived_a1', 'lc_tool_history', '{}')],
          responses_output_items: [{
            id: 'rs_plain',
            type: 'reasoning',
            content: [{ type: 'reasoning_text', text: 'why the tool was needed' }],
            summary: [],
          }, {
            id: 'fc_original',
            type: 'function_call',
            call_id: 'call_original',
            name: 'lc_read_file',
            arguments: '{}',
            status: 'completed',
          }],
        },
        { role: 'tool', content: 'archived', tool_call_id: 'archived_a1' },
      ],
    }));
    const list = items(req);
    assert.deepEqual(list[1], {
      type: 'reasoning',
      id: 'rs_plain',
      content: [{ type: 'reasoning_text', text: 'why the tool was needed' }],
    });
    assert.equal(list[2].type, 'function_call');
    assert.equal(list[2].call_id, 'archived_a1');
    assert.equal(list[3].type, 'function_call_output');
  });

  it('reconciles replayed function-call IDs with normalized assistant calls', () => {
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall('archived_a1', 'lc_tool_history', '{}')],
          responses_output_items: [
            {
              id: 'rs_1',
              type: 'reasoning',
              summary: [],
              encrypted_content: 'opaque-reasoning',
            },
            {
              id: 'fc_1',
              type: 'function_call',
              call_id: 'call_original',
              name: 'lc_list_dir',
              arguments: '{}',
              status: 'completed',
            },
          ],
        },
        { role: 'tool', content: 'archived result', tool_call_id: 'archived_a1' },
      ],
    }));
    const list = items(req);
    assert.equal(list[1].type, 'reasoning');
    assert.deepEqual(list[2], {
      type: 'function_call',
      call_id: 'archived_a1',
      name: 'lc_tool_history',
      arguments: '{}',
    });
    assert.deepEqual(list[3], {
      type: 'function_call_output',
      call_id: 'archived_a1',
      output: 'archived result',
    });
  });

  it('reconciles duplicate raw call_ids as a multiset, not a set', () => {
    // Two raw function_call items share one call_id; the normalized calls
    // hold one. A set-based comparison would replay both raws, producing
    // functionCalls=2 with one output — the invalid pairing shape.
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall('dup', 'lc_test', '{}')],
          responses_output_items: [
            { id: 'fc_a', type: 'function_call', call_id: 'dup', name: 'lc_test', arguments: '{}', status: 'completed' },
            { id: 'fc_b', type: 'function_call', call_id: 'dup', name: 'lc_test', arguments: '{}', status: 'completed' },
          ],
        },
        { role: 'tool', content: 'r', tool_call_id: 'dup' },
      ],
    }));
    const list = items(req);
    const calls = list.filter((i) => i.type === 'function_call');
    const outputs = list.filter((i) => i.type === 'function_call_output');
    assert.equal(calls.length, 1, 'one replayed call after multiset reconciliation');
    assert.equal(outputs.length, 1);
    assert.deepEqual(
      calls.map((i) => (i as { call_id?: string }).call_id),
      ['dup'],
    );
  });

  it('replays matching raw items untouched when multisets agree', () => {
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall('dup', 'lc_test', '{}'), toolCall('other', 'lc_test', '{}')],
          responses_output_items: [
            { id: 'fc_a', type: 'function_call', call_id: 'dup', name: 'lc_test', arguments: '{}', status: 'completed' },
            { id: 'fc_b', type: 'function_call', call_id: 'other', name: 'lc_test', arguments: '{}', status: 'completed' },
          ],
        },
        { role: 'tool', content: 'r1', tool_call_id: 'dup' },
        { role: 'tool', content: 'r2', tool_call_id: 'other' },
      ],
    }));
    const list = items(req);
    const calls = list.filter((i) => i.type === 'function_call');
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((i) => (i as { call_id?: string }).call_id).sort(),
      ['dup', 'other'],
    );
  });

  it('re-expands three response groups so calls and outputs retain provider order', () => {
    const responseItems = [
      { id: 'r1', type: 'reasoning' as const, encrypted_content: 'cipher-1', summary: [] },
      {
        id: 'fc1', type: 'function_call' as const, call_id: 'call-1', name: 'first',
        arguments: '{}', status: 'completed' as const,
      },
      { id: 'r2', type: 'reasoning' as const, encrypted_content: 'cipher-2', summary: [] },
      {
        id: 'fc2', type: 'function_call' as const, call_id: 'call-2', name: 'second',
        arguments: '{}', status: 'completed' as const,
      },
      {
        id: 'msg3', type: 'message' as const, role: 'assistant' as const,
        status: 'completed' as const,
        content: [{ type: 'output_text' as const, text: 'final', annotations: [] }],
      },
    ];
    const accounting = [
      {
        schemaVersion: 1 as const,
        protocol: 'openai-responses' as const,
        reasoningCarrier: 'encrypted-content' as const,
        generatedReasoningTokens: 100,
        tokenStatus: 'provider-reported' as const,
        locator: { kind: 'responses-item-ids' as const, itemIds: ['r1', 'fc1'] },
        toolCallIds: ['call-1'],
      },
      {
        schemaVersion: 1 as const,
        protocol: 'openai-responses' as const,
        reasoningCarrier: 'encrypted-content' as const,
        generatedReasoningTokens: 200,
        tokenStatus: 'provider-reported' as const,
        locator: { kind: 'responses-item-ids' as const, itemIds: ['r2', 'fc2'] },
        toolCallIds: ['call-2'],
      },
      {
        schemaVersion: 1 as const,
        protocol: 'openai-responses' as const,
        reasoningCarrier: 'none' as const,
        tokenStatus: 'unreported' as const,
        locator: { kind: 'responses-item-ids' as const, itemIds: ['msg3'] },
      },
    ];
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: 'final',
          tool_calls: [toolCall('call-1', 'first', '{}'), toolCall('call-2', 'second', '{}')],
          responses_output_items: responseItems,
          opaque_replay_accounting: accounting,
        },
        { role: 'tool', content: 'one', tool_call_id: 'call-1' },
        { role: 'tool', content: 'two', tool_call_id: 'call-2' },
        { role: 'user', content: 'continue' },
      ],
    }));
    const list = items(req);
    assert.deepEqual(list.map((item) => item.type), [
      'message',
      'reasoning', 'function_call', 'function_call_output',
      'reasoning', 'function_call', 'function_call_output',
      'message', 'message',
    ]);
    assert.deepEqual(
      list.filter((item) => item.type === 'function_call' || item.type === 'function_call_output')
        .map((item) => item.call_id),
      ['call-1', 'call-1', 'call-2', 'call-2'],
    );
    assert.equal(JSON.stringify(list).match(/"text":"final"/g)?.length, 1);
  });

  it('places canonical final text after the last tool output when the server omitted final output items', () => {
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: 'canonical final',
          tool_calls: [toolCall('call-1', 'first', '{}')],
          responses_output_items: [
            { id: 'r1', type: 'reasoning', encrypted_content: 'cipher-1', summary: [] },
            {
              id: 'fc1', type: 'function_call', call_id: 'call-1', name: 'first',
              arguments: '{}', status: 'completed',
            },
          ],
          opaque_replay_accounting: [
            {
              schemaVersion: 1,
              protocol: 'openai-responses',
              reasoningCarrier: 'encrypted-content',
              generatedReasoningTokens: 100,
              tokenStatus: 'provider-reported',
              locator: { kind: 'responses-item-ids', itemIds: ['r1', 'fc1'] },
              toolCallIds: ['call-1'],
            },
            {
              schemaVersion: 1,
              protocol: 'openai-responses',
              reasoningCarrier: 'none',
              tokenStatus: 'unreported',
              locator: { kind: 'responses-item-ids', itemIds: [] },
            },
          ],
        },
        { role: 'tool', content: 'one', tool_call_id: 'call-1' },
        { role: 'user', content: 'continue' },
      ],
    }));
    const list = items(req);
    assert.deepEqual(list.map((item) => item.type), [
      'message', 'reasoning', 'function_call', 'function_call_output', 'message', 'message',
    ]);
    const finalIndex = list.findIndex((item) => item.type === 'message'
      && JSON.stringify(item).includes('canonical final'));
    const outputIndex = list.findIndex((item) => item.type === 'function_call_output');
    assert.ok(finalIndex > outputIndex);
  });
});

describe('OpenAIResponsesAdapter — multimodal content', () => {
  it('maps text and image parts to input_text and input_image', () => {
    const req = adapter.buildRequest(params({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          ],
        },
        { role: 'assistant', content: 'a picture' },
      ],
    }));
    assert.deepEqual(items(req)[0].content, [
      { type: 'input_text', text: 'what is this' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
    ]);
  });

  it('flattens image_url objects to a bare string', () => {
    // Chat Completions nests `image_url: { url }`; Responses takes the URL
    // directly on `image_url`.
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/a.png' } }] },
        { role: 'assistant', content: 'ok' },
      ],
    }));
    const content = items(req)[0].content as Array<Record<string, unknown>>;
    assert.equal(content[0].image_url, 'https://x/a.png');
  });

  it('labels replayed assistant array content as input_text', () => {
    // ⚠️ CONFIRMED divergence. When prior assistant turns are passed back as
    // input items, their text uses `output_text` content blocks, not
    // `input_text` — `input_text` is for text being sent TO the model.
    // https://developers.openai.com/api/docs/guides/migrate-to-responses
    //
    // Unreachable today: `Message.content` is always a string in LC's domain
    // model, so assistant messages take the string branch above and never
    // reach this mapping. Recorded so it is visible if that changes.
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'text', text: 'prior answer' }] },
      ],
    }));
    assert.deepEqual(items(req)[1].content, [{ type: 'input_text', text: 'prior answer' }]);
  });
});

describe('OpenAIResponsesAdapter — request options', () => {
  it('always opts out of server-side storage', () => {
    // LC keeps conversation state itself, so `store` is pinned false.
    assert.equal(adapter.buildRequest(params()).store, false);
  });

  it('uses max_output_tokens rather than max_tokens', () => {
    const req = adapter.buildRequest(params({ maxTokens: 512 }));
    assert.equal(req.max_output_tokens, 512);
    assert.ok(!('max_tokens' in req));
  });

  it('passes temperature and top_p, keeping zero', () => {
    const req = adapter.buildRequest(params({ temperature: 0, topP: 0.5 }));
    assert.equal(req.temperature, 0);
    assert.equal(req.top_p, 0.5);
  });

  it('does not send top_k or repeat_penalty', () => {
    // Neither is a Responses parameter; unlike the Chat Completions adapter,
    // this one drops them.
    const req = adapter.buildRequest(params({ topK: 40, repeatPenalty: 1.1 }));
    assert.ok(!('top_k' in req));
    assert.ok(!('repeat_penalty' in req));
  });

  it('converts tool definitions from externally to internally tagged form', () => {
    const tools: ToolDefinition[] = [{
      type: 'function',
      function: {
        name: 'lc_read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    }];
    const req = adapter.buildRequest(params({ tools }));
    assert.deepEqual(req.tools, [{
      type: 'function',
      name: 'lc_read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }]);
  });

  it('omits an empty tools array', () => {
    assert.equal(adapter.buildRequest(params({ tools: [] })).tools, undefined);
  });
});

describe('OpenAIResponsesAdapter — unlisted Responses fallback', () => {
  const baseUrl = 'https://responses-relay.example/v1';
  const reasoningItem = {
    id: 'reasoning-item',
    type: 'reasoning' as const,
    encrypted_content: 'opaque',
    summary: [],
  };

  it('replays same-route output items but sends no guessed reasoning control', () => {
    const req = new OpenAIResponsesAdapter(baseUrl).buildRequest({
      model: 'future-model',
      messages: [{
        role: 'assistant',
        content: '',
        responses_output_items: [reasoningItem],
        provider_output_origin: { baseUrl, model: 'future-model' },
      }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: 'max',
      baseUrl,
      providerContractStatus: 'unmatched',
    });
    assert.equal(req.reasoning, undefined);
    assert.ok(Array.isArray(req.input));
    assert.deepEqual(req.input, [reasoningItem]);
  });

  it('preserves the complete same-route plaintext reasoning item', () => {
    // Live LM Studio /v1/responses verification (2026-09-02): its
    // validator returns `Invalid type for input` if this provider-returned
    // plaintext item is rebuilt without `summary: []`. Replaying the complete
    // returned reasoning + message items succeeds. Generic fallback therefore
    // means exact wire-shape replay, not normalization to OpenAI's minimum.
    const plaintextReasoning = {
      id: 'rs_lmstudio',
      type: 'reasoning' as const,
      status: 'completed' as const,
      summary: [],
      content: [{ type: 'reasoning_text' as const, text: 'Need a short answer.' }],
    };
    const outputMessage = {
      id: 'msg_lmstudio',
      type: 'message' as const,
      role: 'assistant' as const,
      status: 'completed' as const,
      content: [{ type: 'output_text' as const, text: 'ALPHA', annotations: [] }],
    };
    const req = new OpenAIResponsesAdapter(baseUrl).buildRequest({
      model: 'future-model',
      messages: [
        { role: 'user', content: 'Reply with ALPHA.' },
        {
          role: 'assistant',
          content: 'ALPHA',
          responses_output_items: [plaintextReasoning, outputMessage],
          provider_output_origin: { baseUrl, model: 'future-model' },
        },
        { role: 'user', content: 'Now reply with BETA.' },
      ],
      stream: true,
      reasoningEnabled: false,
      baseUrl,
      providerContractStatus: 'unmatched',
    });
    assert.deepEqual(req.input, [
      { type: 'message', role: 'user', content: 'Reply with ALPHA.' },
      plaintextReasoning,
      outputMessage,
      { type: 'message', role: 'user', content: 'Now reply with BETA.' },
    ]);
  });

  it('drops output items after an endpoint or model switch', () => {
    const req = new OpenAIResponsesAdapter(baseUrl).buildRequest({
      model: 'different-model',
      messages: [{
        role: 'assistant',
        content: 'answer',
        responses_output_items: [reasoningItem],
        provider_output_origin: { baseUrl, model: 'future-model' },
      }],
      stream: true,
      reasoningEnabled: false,
      baseUrl,
      providerContractStatus: 'unmatched',
    });
    assert.ok(Array.isArray(req.input));
    assert.equal(req.input.some((item) => item.type === 'reasoning'), false);
  });
});

describe('OpenAIResponsesAdapter — reasoning', () => {
  it('sends no reasoning object when reasoning is disabled', () => {
    assert.equal(adapter.buildRequest(params({ reasoningEnabled: false, reasoningEffort: 'high' })).reasoning, undefined);
  });

  it('sends a nested reasoning object with summary auto', () => {
    // Responses uses the nested form; `summary` is required for the server to
    // emit reasoning text events at all.
    const req = adapter.buildRequest(params({ reasoningEnabled: true, reasoningEffort: 'medium' }));
    assert.deepEqual(req.reasoning, { effort: 'medium', summary: 'auto' });
  });

  it('passes max through to Responses', () => {
    const req = adapter.buildRequest(params({ reasoningEnabled: true, reasoningEffort: 'max' }));
    assert.deepEqual(req.reasoning, { effort: 'max', summary: 'auto' });
  });

  it('passes max through to Meta AI Responses verbatim', () => {
    // No client-side folding of `max` — Meta's ladder may grow, and an
    // unsupported level is the provider's own 400 to surface.
    // https://dev.meta.ai/docs/api-reference/responses/schemas  (ReasoningEffort)
    const req = adapter.buildRequest(params({
      baseUrl: 'https://api.meta.ai/v1',
      reasoningEnabled: true,
      reasoningEffort: 'max',
    }));
    assert.deepEqual(req.reasoning, { effort: 'max', summary: 'auto' });
  });

  it('keeps other Meta AI efforts unchanged with summary auto', () => {
    const req = adapter.buildRequest(params({
      baseUrl: 'https://api.meta.ai/v1',
      reasoningEnabled: true,
      reasoningEffort: 'medium',
    }));
    assert.deepEqual(req.reasoning, { effort: 'medium', summary: 'auto' });
  });

  it('passes effort "none" through as-is', () => {
    const req = adapter.buildRequest(params({ reasoningEnabled: true, reasoningEffort: 'none' }));
    assert.deepEqual(req.reasoning, { effort: 'none', summary: 'auto' });
  });

  it('omits reasoning when enabled but no effort is given', () => {
    assert.equal(adapter.buildRequest(params({ reasoningEnabled: true })).reasoning, undefined);
  });
});

describe('OpenAIResponsesAdapter — streaming refusals and state', () => {
  it('handles refusal events and retains completed output items', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[],"encrypted_content":"opaque"}}',
          '',
          'data: {"type":"response.refusal.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":"I cannot"}',
          '',
          'data: {"type":"response.refusal.done","item_id":"msg_1","output_index":1,"content_index":0,"refusal":"I cannot help."}',
          '',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5},"output":[{"id":"rs_1","type":"reasoning","summary":[],"encrypted_content":"opaque"},{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"refusal","refusal":"I cannot help."}]}]}}',
          '',
        ].join('\n')));
        controller.close();
      },
    });
    const refusals: string[] = [];
    let toolActivity = 0;
    const result = await adapter.parseStream(
      body,
      { onDelta: () => {}, onRefusal: (text) => refusals.push(text), onToolCall: () => { toolActivity++; } },
      1000,
      undefined,
    );
    assert.equal(result.refusal, 'I cannot');
    assert.deepEqual(refusals, ['I cannot']);
    assert.equal(result.responses_output_items?.[0]?.type, 'reasoning');
    assert.equal((result.responses_output_items?.[0] as { encrypted_content?: string }).encrypted_content, 'opaque');
    // A server that reports usage but no cache counters carries an explicit
    // `not-reported` status, which is distinct from reporting a zero.
    assert.deepEqual(result.usage, {
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
      source: 'provider',
      cache: { status: 'not-reported', reportedBy: 'provider' },
    });
    assert.equal(toolActivity, 0);
  });

  it('reports function-call activity before arguments finish', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_item","type":"function_call","call_id":"call_1","name":"lc_test"}}',
          '',
          'data: {"type":"response.function_call_arguments.delta","item_id":"fc_item","delta":"{}"}',
          '',
          'data: {"type":"response.completed","response":{"output":[{"type":"function_call","id":"fc_item","call_id":"call_1","name":"lc_test","arguments":"{}"}]}}',
          '',
        ].join('\n')));
        controller.close();
      },
    });
    let toolActivity = 0;
    const result = await adapter.parseStream(
      body,
      { onDelta: () => {}, onToolCall: () => { toolActivity++; } },
      1000,
      undefined,
    );
    assert.ok(toolActivity >= 1);
    assert.equal(result.tool_calls?.[0]?.function.name, 'lc_test');
  });

  it('ignores permissively parsed events that omit their required indexes or item ids', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"type":"response.reasoning_text.delta","delta":"first"}',
          '',
          'data: {"type":"response.reasoning_summary_part.added"}',
          '',
          'data: {"type":"response.function_call_arguments.delta","delta":"{}"}',
          '',
          'data: {"type":"response.function_call_arguments.done","name":"lc_test","arguments":"{}"}',
          '',
        ].join('\n')));
        controller.close();
      },
    });
    const reasoning: string[] = [];
    let toolActivity = 0;
    const result = await adapter.parseStream(
      body,
      {
        onDelta: () => {},
        onReasoning: (text) => reasoning.push(text),
        onToolCall: () => { toolActivity++; },
      },
      1000,
      undefined,
    );

    assert.deepEqual(reasoning, ['first']);
    assert.equal(toolActivity, 0);
    assert.equal(result.tool_calls, undefined);
  });

  it('collects every terminal output_text part when no text deltas streamed', async () => {
    const encoder = new TextEncoder();
    const output = [
      { type: 'message', content: [
        { type: 'output_text', text: 'first ' },
        { type: 'output_text', text: 'second ' },
      ] },
      { type: 'message', content: [{ type: 'output_text', text: 'third' }] },
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`));
        controller.close();
      },
    });
    const result = await adapter.parseStream(body, { onDelta: () => {} }, 1000, undefined);
    assert.equal(result.content, 'first second third');
  });
});

/**
 * Argument-accumulation cap on the Responses delta path. The adapter has its
 * own per-call accumulator (keyed by call_id), so the bound must hold there
 * too, not only in the shared ToolCallAccumulator.
 */
describe('OpenAIResponsesAdapter — argument cap on the delta path', () => {
  function sseBody(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(lines.flatMap((line) => [line, '']).join('\n')));
        controller.close();
      },
    });
  }

  it('drops the call when the delta stream exceeds the cap', async () => {
    const big = 'x'.repeat(TOOL_CALL_ARGS_MAX_CHARS + 1);
    const body = sseBody([
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_item","type":"function_call","call_id":"call_1","name":"lc_test"}}',
      `data: {"type":"response.function_call_arguments.delta","item_id":"fc_item","delta":${JSON.stringify(big)}}`,
      'data: {"type":"response.function_call_arguments.done","item_id":"fc_item","name":"lc_test","arguments":"{}"}',
    ]);
    const result = await adapter.parseStream(body, { onDelta: () => {}, onToolCall: () => {} }, 1000, undefined);
    assert.equal((result.tool_calls ?? []).length, 0, 'a capped delta stream must not produce a wire call');
    assert.match(result.error_message ?? '', /exceeded/i);
  });

  it('a capped sibling suppresses every call and raw replay item after response.completed', async () => {
    const big = 'x'.repeat(TOOL_CALL_ARGS_MAX_CHARS + 1);
    const completedOutput = [
      { id: 'fc_ok', type: 'function_call', call_id: 'call_ok', name: 'lc_test', arguments: '{}' },
      { id: 'fc_bad', type: 'function_call', call_id: 'call_bad', name: 'lc_test', arguments: big },
    ];
    const body = sseBody([
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_ok","type":"function_call","call_id":"call_ok","name":"lc_test"}}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_ok","delta":"{}"}',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"fc_bad","type":"function_call","call_id":"call_bad","name":"lc_test"}}',
      `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_bad', delta: big })}`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { output: completedOutput } })}`,
    ]);
    const result = await adapter.parseStream(body, { onDelta: () => {}, onToolCall: () => {} }, 1000, undefined);
    assert.equal(result.tool_calls, undefined, 'the valid sibling must not survive a capped turn');
    assert.equal(result.finish_reason, 'error', 'the provider terminal event must not override the cap');
    assert.match(result.error_message ?? '', /exceeded/i);
    assert.equal(result.responses_output_items, undefined, 'no unresolved function_call item may be replayed');
  });

  it('keeps a delta stream landing exactly on the cap', async () => {
    // `{"content":""}` is 14 characters of framing.
    const exact = `{"content":"${'x'.repeat(TOOL_CALL_ARGS_MAX_CHARS - 14)}"}`;
    assert.equal(exact.length, TOOL_CALL_ARGS_MAX_CHARS);
    const body = sseBody([
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_item","type":"function_call","call_id":"call_1","name":"lc_test"}}',
      `data: {"type":"response.function_call_arguments.delta","item_id":"fc_item","delta":${JSON.stringify(exact)}}`,
    ]);
    const result = await adapter.parseStream(body, { onDelta: () => {}, onToolCall: () => {} }, 1000, undefined);
    assert.equal(result.tool_calls?.length, 1);
    assert.equal(result.tool_calls?.[0].function.arguments.length, TOOL_CALL_ARGS_MAX_CHARS);
  });

  it('rejects an oversized terminal arguments blob in output_item.done', async () => {
    const big = 'y'.repeat(TOOL_CALL_ARGS_MAX_CHARS + 10);
    const body = sseBody([
      `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_item","call_id":"call_1","name":"lc_test","arguments":${JSON.stringify(big)}}}`,
    ]);
    const result = await adapter.parseStream(body, { onDelta: () => {}, onToolCall: () => {} }, 1000, undefined);
    assert.equal((result.tool_calls ?? []).length, 0);
    assert.match(result.error_message ?? '', /exceeded/i);
  });
});

/**
 * DeepSeek's Responses API carries chain-of-thought as plaintext
 * `reasoning_text` parts. The Responses page documents the carrier but does not
 * publish Chat's tools-dependent history filter. Real LLMClient requests use
 * the contract; one direct-adapter fixture below retains legacy isolation.
 *   https://api-docs.deepseek.com/guides/thinking_mode#tool-calls
 *   https://api-docs.deepseek.com/guides/responses_api  (Input Items:
 *   "reasoning — Plain-text content is merged into the adjacent assistant
 *   message; summary and encrypted_content are not supported")
 */
describe('OpenAIResponsesAdapter — DeepSeek reasoning pass-back', () => {
  const DEEPSEEK = 'https://api.deepseek.com';

  const reasoningItem = (text: string) => ({
    id: 'rs_1',
    type: 'reasoning' as const,
    content: [{ type: 'reasoning_text' as const, text }],
    status: 'completed' as const,
  });

  const toolCallTurn = (over: Record<string, unknown> = {}) => ({
    role: 'assistant' as const,
    content: '',
    tool_calls: [toolCall('call_1', 'get_weather', '{"location":"Hangzhou"}')],
    ...over,
  });

  it('replays plain-text reasoning items on tool-call rounds', () => {
    const req = adapter.buildRequest(params({
      baseUrl: DEEPSEEK,
      messages: [
        { role: 'user', content: 'weather?' },
        toolCallTurn({
          responses_output_items: [
            reasoningItem('Need tomorrow’s date first.'),
            {
              id: 'fc_1',
              type: 'function_call' as const,
              call_id: 'call_1',
              name: 'get_weather',
              arguments: '{"location":"Hangzhou"}',
              status: 'completed' as const,
            },
          ],
        }),
        { role: 'tool', content: 'Cloudy', tool_call_id: 'call_1' },
      ],
    }));
    const list = items(req);
    assert.deepEqual(list[1], {
      type: 'reasoning',
      id: 'rs_1',
      content: [{ type: 'reasoning_text', text: 'Need tomorrow’s date first.' }],
    });
    assert.equal(list[2].type, 'function_call');
    assert.equal(list[3].type, 'function_call_output');
  });

  it('never sends summary or encrypted_content to DeepSeek', () => {
    // Neither is supported inside DeepSeek's reasoning input-item schema. This
    // does not describe the separate top-level reasoning.summary option.
    const req = adapter.buildRequest(params({
      baseUrl: DEEPSEEK,
      messages: [
        { role: 'user', content: 'go' },
        toolCallTurn({
          responses_output_items: [{
            id: 'rs_1',
            type: 'reasoning' as const,
            summary: [{ type: 'summary_text', text: 'a summary' }],
            encrypted_content: 'opaque',
          }],
        }),
      ],
    }));
    const serialized = JSON.stringify(items(req));
    assert.ok(!serialized.includes('encrypted_content'));
    assert.ok(!serialized.includes('summary'));
  });

  it('replays mixed-field DeepSeek tool rounds with each output beside its call', () => {
    const providerContract = resolveBundledProviderContract({
      baseUrl: `${DEEPSEEK}/v1`,
      protocol: 'openai-responses',
      modelId: 'deepseek-v4-flash',
    });
    const responseItems = [
      {
        id: 'r1', type: 'reasoning' as const,
        content: [{ type: 'reasoning_text' as const, text: 'reasoning one' }],
        encrypted_content: 'auxiliary-1', summary: [],
      },
      {
        id: 'm1', type: 'message' as const, role: 'assistant' as const,
        status: 'completed' as const,
        content: [{ type: 'output_text' as const, text: 'checking one', annotations: [] }],
      },
      {
        id: 'fc1', type: 'function_call' as const, call_id: 'call-1', name: 'first',
        arguments: '{}', status: 'completed' as const,
      },
      {
        id: 'r2', type: 'reasoning' as const,
        content: [{ type: 'reasoning_text' as const, text: 'reasoning two' }],
        encrypted_content: 'auxiliary-2', summary: [],
      },
      {
        id: 'm2', type: 'message' as const, role: 'assistant' as const,
        status: 'completed' as const,
        content: [{ type: 'output_text' as const, text: 'checking two', annotations: [] }],
      },
      {
        id: 'fc2', type: 'function_call' as const, call_id: 'call-2', name: 'second',
        arguments: '{}', status: 'completed' as const,
      },
    ];
    // This is the accounting shape saved by affected LC builds. Request-time
    // normalization must migrate the carrier without losing either boundary.
    const accounting = [
      {
        schemaVersion: 1 as const,
        protocol: 'openai-responses' as const,
        reasoningCarrier: 'encrypted-content' as const,
        generatedReasoningTokens: 100,
        tokenStatus: 'provider-reported' as const,
        locator: { kind: 'responses-item-ids' as const, itemIds: ['r1', 'm1', 'fc1'] },
        toolCallIds: ['call-1'],
      },
      {
        schemaVersion: 1 as const,
        protocol: 'openai-responses' as const,
        reasoningCarrier: 'encrypted-content' as const,
        generatedReasoningTokens: 200,
        tokenStatus: 'provider-reported' as const,
        locator: { kind: 'responses-item-ids' as const, itemIds: ['r2', 'm2', 'fc2'] },
        toolCallIds: ['call-2'],
      },
    ];
    const archivedItems = structuredClone(responseItems);
    const req = adapter.buildRequest(params({
      model: 'deepseek-v4-flash',
      baseUrl: `${DEEPSEEK}/v1`,
      providerContract,
      providerContractStatus: 'matched',
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: 'checking two',
          reasoning_content: 'reasoning one\nreasoning two',
          tool_calls: [toolCall('call-1', 'first', '{}'), toolCall('call-2', 'second', '{}')],
          responses_output_items: responseItems,
          opaque_replay_accounting: accounting,
        },
        { role: 'tool', content: 'one', tool_call_id: 'call-1' },
        { role: 'tool', content: 'two', tool_call_id: 'call-2' },
      ],
    }));
    const list = items(req);
    assert.deepEqual(list.map((item) => item.type), [
      'message',
      'reasoning', 'message', 'function_call', 'function_call_output',
      'reasoning', 'message', 'function_call', 'function_call_output',
    ]);
    assert.deepEqual(
      list.filter((item) => item.type === 'function_call' || item.type === 'function_call_output')
        .map((item) => item.call_id),
      ['call-1', 'call-1', 'call-2', 'call-2'],
    );
    assert.ok(!JSON.stringify(list).includes('encrypted_content'));
    assert.ok(!JSON.stringify(list).includes('summary'));
    assert.deepEqual(responseItems, archivedItems, 'request serialization must not mutate archived output');
  });

  it('synthesizes a reasoning item from reasoning_content when no output items exist', () => {
    // The turn was generated over Chat Completions or the Anthropic Messages
    // API before the profile switched to Responses, so there is no stored
    // Responses item. Current LC synthesizes the plaintext compatibility item.
    const req = adapter.buildRequest(params({
      baseUrl: DEEPSEEK,
      messages: [
        { role: 'user', content: 'weather?' },
        toolCallTurn({ reasoning_content: 'The user wants tomorrow.' }),
        { role: 'tool', content: 'Cloudy', tool_call_id: 'call_1' },
      ],
    }));
    const list = items(req);
    assert.deepEqual(list[1], {
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: 'The user wants tomorrow.' }],
    });
    assert.equal(list[2].type, 'message', 'the assistant message still follows');
    assert.equal(list[3].type, 'function_call');
    assert.equal(list[4].type, 'function_call_output');
  });

  it('synthesizes reasoning when stored output items carry none', () => {
    // Encrypted-only items from an OpenAI turn leave nothing replayable, so
    // the fallback still has to produce the chain-of-thought.
    const req = adapter.buildRequest(params({
      baseUrl: DEEPSEEK,
      messages: [
        { role: 'user', content: 'go' },
        toolCallTurn({
          reasoning_content: 'recovered CoT',
          responses_output_items: [
            { id: 'rs_1', type: 'reasoning' as const, encrypted_content: 'opaque' },
            {
              id: 'fc_1',
              type: 'function_call' as const,
              call_id: 'call_1',
              name: 'get_weather',
              arguments: '{"location":"Hangzhou"}',
              status: 'completed' as const,
            },
          ],
        }),
      ],
    }));
    const list = items(req);
    assert.deepEqual(list[1], {
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: 'recovered CoT' }],
    });
    assert.equal(list[2].type, 'function_call');
  });

  it('does not duplicate reasoning when a replayable item is present', () => {
    const req = adapter.buildRequest(params({
      baseUrl: DEEPSEEK,
      messages: [
        { role: 'user', content: 'go' },
        toolCallTurn({
          reasoning_content: 'stored on the message too',
          responses_output_items: [reasoningItem('from the provider')],
        }),
      ],
    }));
    assert.equal(items(req).filter((i) => i.type === 'reasoning').length, 1);
  });

  it('drops reasoning on turns without tool calls', () => {
    // Direct adapter callers omit the LLMClient resolution marker and retain
    // the historical fallback. Production requests exercise the next test.
    const req = adapter.buildRequest(params({
      baseUrl: DEEPSEEK,
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'hello',
          reasoning_content: 'a greeting',
          responses_output_items: [
            reasoningItem('a greeting'),
            {
              id: 'msg_1',
              type: 'message' as const,
              role: 'assistant' as const,
              status: 'completed' as const,
              content: [{ type: 'output_text' as const, text: 'hello', annotations: [] }],
            },
          ],
        },
        { role: 'user', content: 'and now?' },
      ],
    }));
    assert.equal(items(req).some((i) => i.type === 'reasoning'), false);
  });

  it('the resolved Responses contract replays reasoning on non-tool turns', () => {
    const providerContract = resolveBundledProviderContract({
      baseUrl: `${DEEPSEEK}/v1`,
      protocol: 'openai-responses',
      modelId: 'deepseek-chat',
    });
    const req = adapter.buildRequest(params({
      baseUrl: `${DEEPSEEK}/v1`,
      providerContract,
      providerContractStatus: 'matched',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'hello',
          reasoning_content: 'a greeting',
          responses_output_items: [reasoningItem('a greeting')],
        },
        { role: 'user', content: 'and now?' },
      ],
    }));
    assert.equal(items(req).filter((item) => item.type === 'reasoning').length, 1);
  });

  it('keeps the chain-of-thought when archived tool-call IDs are rewritten', () => {
    // Tool History renames call IDs, which forces function_call items to be
    // rebuilt. The reasoning item must survive that rebuild.
    const req = adapter.buildRequest(params({
      baseUrl: DEEPSEEK,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall('archived_a1', 'lc_tool_history', '{}')],
          responses_output_items: [
            reasoningItem('why I called the tool'),
            {
              id: 'fc_1',
              type: 'function_call' as const,
              call_id: 'call_original',
              name: 'lc_list_dir',
              arguments: '{}',
              status: 'completed' as const,
            },
          ],
        },
        { role: 'tool', content: 'archived result', tool_call_id: 'archived_a1' },
      ],
    }));
    const list = items(req);
    assert.equal(list[1].type, 'reasoning');
    assert.deepEqual(list[1].content, [{ type: 'reasoning_text', text: 'why I called the tool' }]);
    assert.equal(list[2].call_id, 'archived_a1');
  });

  it('leaves OpenAI replay untouched', () => {
    // No baseUrl → not DeepSeek: encrypted items replay verbatim, and canonical
    // display text is not invented when no provider reasoning item exists.
    const outputItems = [
      { id: 'rs_1', type: 'reasoning' as const, summary: [], encrypted_content: 'opaque' },
    ];
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'go' },
        toolCallTurn({ reasoning_content: 'plain text', responses_output_items: outputItems }),
      ],
    }));
    assert.deepEqual(items(req)[1], { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] });
  });

  it('does not synthesize reasoning items for non-DeepSeek providers', () => {
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'go' },
        toolCallTurn({ reasoning_content: 'plain text' }),
      ],
    }));
    assert.equal(items(req).some((i) => i.type === 'reasoning'), false);
  });

  it('surfaces reasoning_text parts that arrive only as output items', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","status":"completed","content":[{"type":"reasoning_text","text":"thinking it through"}]}}',
          '',
          'data: {"type":"response.completed","response":{"output":[{"id":"rs_1","type":"reasoning","status":"completed","content":[{"type":"reasoning_text","text":"thinking it through"}]}]}}',
          '',
        ].join('\n')));
        controller.close();
      },
    });
    const reasoning: string[] = [];
    const result = await adapter.parseStream(
      body,
      { onDelta: () => {}, onReasoning: (text) => reasoning.push(text) },
      1000,
      undefined,
    );
    assert.deepEqual(reasoning, ['thinking it through'], 'emitted once, not once per event');
    assert.equal(result.responses_output_items?.[0]?.type, 'reasoning');
  });
});

/**
 * `response.incomplete` carries WHY it stopped, and the two documented reasons
 * mean opposite things to a user: `max_output_tokens` is a limit they can
 * raise, `content_filter` is not. Collapsing both to `length` labelled a
 * filtered response "✂ truncated".
 * https://developers.openai.com/api/docs/guides/reasoning
 */
describe('OpenAIResponsesAdapter — incomplete reasons stay distinguishable', () => {
  function sseBody(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(lines.flatMap((line) => [line, '']).join('\n')));
        controller.close();
      },
    });
  }

  const callbacks = { onDelta: () => {}, onReasoning: () => {}, onRefusal: () => {}, onToolCall: () => {} };

  function incompleteEvent(reason?: string): string {
    const response = reason ? { incomplete_details: { reason } } : {};
    return `data: ${JSON.stringify({ type: 'response.incomplete', response })}`;
  }

  it('reports a content-filtered stop as content_filter, not length', async () => {
    const result = await adapter.parseStream(
      sseBody([incompleteEvent('content_filter')]), callbacks, 1000, undefined,
    );
    assert.equal(result.finish_reason, 'content_filter');
    assert.equal(result.provider_finish_reason, 'response.incomplete (content_filter)');
  });

  it('still reports a token-limit stop as length', async () => {
    const result = await adapter.parseStream(
      sseBody([incompleteEvent('max_output_tokens')]), callbacks, 1000, undefined,
    );
    assert.equal(result.finish_reason, 'length');
    assert.equal(result.provider_finish_reason, 'response.incomplete (max_output_tokens)');
  });

  it('falls back to length when no reason is given', async () => {
    const result = await adapter.parseStream(
      sseBody([incompleteEvent()]), callbacks, 1000, undefined,
    );
    assert.equal(result.finish_reason, 'length');
    assert.equal(result.provider_finish_reason, 'response.incomplete');
  });
});

/**
 * OpenRouter is a compatible server on this adapter, and it spells three
 * streaming events differently from OpenAI: text arrives as
 * `response.content_part.delta`, reasoning as `response.reasoning.delta`, and
 * the terminal payload as `response.done`. None of the three had a case, so a
 * documented OpenRouter stream parsed to an empty assistant message with no
 * finish reason and no usage — the server succeeded and the user saw nothing.
 *
 * The stream below is the shape of OpenRouter's published basic-usage example.
 * https://openrouter.ai/docs/api_reference/responses/basic-usage
 */
describe('OpenAIResponsesAdapter — OpenRouter event dialect', () => {
  function sseBody(events: unknown[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
  }

  // Transcribed from OpenRouter's published example, field for field. Two
  // details are load-bearing and were got wrong on the first attempt: the
  // content delta is keyed by `response_id` (not `item_id`), and the terminal
  // `response` object carries NO `output` array — so the visible text can only
  // come from the deltas. A fixture that invents an `output` here would pass
  // even if delta handling were still broken.
  const openRouterStream = [
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    OPENROUTER_RESPONSES_EVENTS[1],
    OPENROUTER_RESPONSES_EVENTS[0],
    { ...OPENROUTER_RESPONSES_EVENTS[0], delta: ' upon' },
    { ...OPENROUTER_RESPONSES_EVENTS[0], delta: ' a time' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Once upon a time' }] },
    },
    OPENROUTER_RESPONSES_EVENTS[2],
  ];

  it('renders text, reasoning, finish reason, and usage from the documented stream', async () => {
    const deltas: string[] = [];
    const reasoning: string[] = [];
    const result = await new OpenAIResponsesAdapter('https://openrouter.ai/api/v1').parseStream(
      sseBody(openRouterStream),
      { onDelta: (t) => deltas.push(t), onReasoning: (t) => reasoning.push(t), onRefusal: () => {}, onToolCall: () => {} },
      1000,
      undefined,
    );
    assert.deepEqual(deltas, ['Once', ' upon', ' a time'], 'content_part.delta must stream to the UI');
    assert.equal(result.content, 'Once upon a time');
    assert.deepEqual(reasoning, ['thinking it over'], 'reasoning.delta must not be dropped');
    assert.equal(result.finish_reason, 'stop');
    assert.equal(result.provider_finish_reason, 'response.done');
    assert.equal(result.usage?.prompt_tokens, 12, 'the counts are the published example\'s own');
    assert.equal(result.usage?.completion_tokens, 45);
    assert.equal(result.usage?.cache?.reportedBy, 'router', 'openrouter.ai counters are router-reported');
    assert.equal(
      result.responses_output_items?.length,
      1,
      'with no `output` on response.done, the streamed output_item.done must still supply the replay items',
    );
  });

  it('still handles the OpenAI dialect unchanged', async () => {
    const deltas: string[] = [];
    const result = await adapter.parseStream(
      sseBody([...OPENAI_RESPONSES_EVENTS]),
      { onDelta: (t) => deltas.push(t), onReasoning: () => {}, onRefusal: () => {}, onToolCall: () => {} },
      1000,
      undefined,
    );
    assert.deepEqual(deltas, ['Hello']);
    assert.equal(result.provider_finish_reason, 'response.completed');
    assert.equal(result.usage?.prompt_tokens, 2);
  });

  it("surfaces OpenAI's top-level error message, not a JSON dump", async () => {
    // The Responses error event is flat: {type, code, message, param,
    // sequence_number}. Reading only a nested `error.message` fell through to
    // JSON.stringify and showed the user the raw event.
    // https://developers.openai.com/api/reference/resources/responses/streaming-events
    await assert.rejects(
      adapter.parseStream(
        sseBody([OPENAI_ERROR_EVENT]),
        { onDelta: () => {}, onReasoning: () => {}, onRefusal: () => {}, onToolCall: () => {} }, 1000, undefined,
      ),
      /Responses API error: Something went wrong$/,
    );
  });

  it('still surfaces a nested error message from the undocumented fallback shape', async () => {
    await assert.rejects(
      adapter.parseStream(
        sseBody([{ type: 'error', error: { type: 'server_error', message: 'upstream died' } }]),
        { onDelta: () => {}, onReasoning: () => {}, onRefusal: () => {}, onToolCall: () => {} }, 1000, undefined,
      ),
      /Responses API error: upstream died$/,
    );
  });

  it('ignores a delta event carrying no usable string', async () => {
    const deltas: string[] = [];
    const result = await adapter.parseStream(
      sseBody([
        { type: 'response.content_part.delta', output_index: 0 },
        { type: 'response.output_text.delta', delta: '' },
        { type: 'response.completed', response: { output: [] } },
      ]),
      { onDelta: (t) => deltas.push(t), onReasoning: () => {}, onRefusal: () => {}, onToolCall: () => {} },
      1000,
      undefined,
    );
    assert.deepEqual(deltas, [], 'a missing or empty delta must not reach the UI');
    assert.equal(result.content, '');
  });
});
