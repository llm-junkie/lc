/**
 * `convertToAnthropicRequest` — OpenAI-compat → Anthropic Messages conversion.
 *
 * This function is the single point where LC's internal message history is
 * reshaped for the Anthropic Messages API. The tests below pin LC's
 * normalization behavior. Be careful not to confuse that with the API
 * contract — they are not the same thing:
 *
 *   - **Role alternation is LC's own normalization goal, not an API
 *     requirement.** The Messages API explicitly combines consecutive
 *     same-role turns into one ("Consecutive `user` or `assistant` turns in
 *     your request will be combined into a single turn"). LC merges them
 *     itself so the request is unambiguous and because the same adapter also
 *     serves stricter Anthropic-compatible endpoints (LM Studio, DeepSeek,
 *     MiniMax, Alibaba MaaS).
 *   - **Leading synthetic user message** — likewise defensive; the docs state
 *     no first-message role requirement.
 *   - **`tool_result`-first ordering** is LC's chosen invariant. The public
 *     docs place `tool_result` blocks in a user message referencing a prior
 *     `tool_use` by id, but do not document a position requirement within the
 *     content array.
 *   - **System prompts at the top level** — this one is a real API contract.
 *
 * What the API does enforce, and these tests do not fully cover: every
 * `tool_use` needs a matching `tool_result`, and text content blocks must be
 * non-empty.
 *
 * Run with:
 *   node --test --experimental-strip-types src/modules/llm-client/adapters/anthropic.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter, convertToAnthropicRequest, normalizeAnthropicBlockOrder, validateAnthropicBlockOrderText } from './anthropic.ts';
import { isAnthropicOwnApi } from '../anthropic-version.ts';
import { resolveBundledProviderContract } from '../provider-contracts.ts';
import { TOOL_CALL_ARGS_MAX_CHARS, ToolCallAccumulator } from '../tool-accumulator.ts';
import type {
  AnthropicContentBlock,
  AnthropicRequestMessage,
  ChatMessage,
  ToolDefinition,
} from '../types';

const MODEL = 'claude-test';

/** Narrow a message's content to the block-array form. */
function blocks(msg: AnthropicRequestMessage): AnthropicContentBlock[] {
  assert.ok(Array.isArray(msg.content), `expected block array, got ${typeof msg.content}`);
  return msg.content;
}

/**
 * Assert LC's own normalization goal: no two consecutive same-role messages.
 *
 * This is deliberately stricter than the Messages API, which merges
 * consecutive same-role turns on its own. LC normalizes up front so the
 * request means exactly one thing, and because the same adapter targets
 * Anthropic-compatible endpoints that may not be as forgiving. A failure here
 * is a change in LC's behavior, not proof of an API-level defect.
 */
function assertAlternates(messages: AnthropicRequestMessage[]): void {
  for (let i = 1; i < messages.length; i++) {
    assert.notEqual(
      messages[i].role,
      messages[i - 1].role,
      `consecutive ${messages[i].role} messages at index ${i - 1}/${i}`,
    );
  }
}

function toolCall(id: string, name: string, args: string): NonNullable<ChatMessage['tool_calls']>[number] {
  return { id, type: 'function', function: { name, arguments: args } };
}

describe('convertToAnthropicRequest — system messages', () => {
  it('hoists a system message to the top level and drops it from messages', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hi' },
      ],
      MODEL,
    );
    assert.equal(req.system, 'You are helpful.');
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, 'user');
  });

  it('concatenates multiple system messages with newline separation', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'system', content: 'First.' },
        { role: 'system', content: 'Second.' },
        { role: 'user', content: 'hi' },
      ],
      MODEL,
    );
    assert.equal(req.system, 'First.\nSecond.');
  });

  it('omits system entirely when it is only whitespace', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'system', content: '   ' },
        { role: 'user', content: 'hi' },
      ],
      MODEL,
    );
    assert.equal(req.system, undefined);
  });
});

describe('convertToAnthropicRequest — tool-result/image alternation', () => {
  it('merges an injected image message into the preceding tool-result message', () => {
    // `lc_read_image` without `analyze:true` produces a tool result
    // (which becomes a user message) immediately followed by an injected
    // array-content image payload (also a user message). Appending rather
    // than merging yields two consecutive user messages → Anthropic 400.
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: 'look at this' },
        { role: 'assistant', content: '', tool_calls: [toolCall('call_1', 'lc_read_image', '{"paths":["a.png"]}')] },
        { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_1' },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
        },
      ],
      MODEL,
    );

    assertAlternates(req.messages);
    assert.equal(req.messages.length, 3, 'image must merge, not create a 4th message');

    const merged = blocks(req.messages[2]);
    assert.equal(req.messages[2].role, 'user');
    assert.equal(merged.length, 2);
    assert.equal(merged[0].type, 'tool_result');
    assert.equal(merged[1].type, 'image');
  });

  it('merges consecutive plain-text messages of the same role', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
      ],
      MODEL,
    );
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].content, 'one\n\ntwo');
  });

  it('merges a plain-text message into a preceding same-role block array', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        { role: 'user', content: 'second' },
      ],
      MODEL,
    );
    assert.equal(req.messages.length, 1);
    const content = blocks(req.messages[0]);
    assert.equal(content.length, 2);
    assert.deepEqual(content[1], { type: 'text', text: 'second' });
  });

  it('prepends a synthetic user message when the history opens with an assistant', () => {
    const req = convertToAnthropicRequest(
      [{ role: 'assistant', content: 'I go first' }],
      MODEL,
    );
    assert.equal(req.messages.length, 2);
    assert.equal(req.messages[0].role, 'user');
    assert.equal(req.messages[0].content, '_');
    assert.equal(req.messages[1].role, 'assistant');
  });

  it('keeps alternation across a full multi-turn tool loop', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'lc_read_file', '{}')] },
        { role: 'tool', content: 'r1', tool_call_id: 'c1' },
        { role: 'assistant', content: 'answer 1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: '', tool_calls: [toolCall('c2', 'lc_grep', '{}')] },
        { role: 'tool', content: 'r2', tool_call_id: 'c2' },
      ],
      MODEL,
    );
    assertAlternates(req.messages);
    assert.equal(req.messages[0].role, 'user');
  });
});

describe('convertToAnthropicRequest — tool calls', () => {
  it('converts tool_calls into tool_use blocks with parsed input', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'lc_grep', '{"pattern":"foo"}')] },
      ],
      MODEL,
    );
    const content = blocks(req.messages[1]);
    assert.deepEqual(content[0], {
      type: 'tool_use',
      id: 'c1',
      name: 'lc_grep',
      input: { pattern: 'foo' },
    });
  });

  it('falls back to empty input when tool arguments are not valid JSON', () => {
    // Malformed arguments must not throw — a broken call should still reach
    // the model as a well-formed block so the turn can recover.
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'lc_grep', '{not json')] },
      ],
      MODEL,
    );
    const content = blocks(req.messages[1]);
    assert.equal(content[0].type, 'tool_use');
    assert.deepEqual((content[0] as { input: unknown }).input, {});
  });

  it('places assistant text before its tool_use blocks', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'let me check', tool_calls: [toolCall('c1', 'lc_stat', '{}')] },
      ],
      MODEL,
    );
    const content = blocks(req.messages[1]);
    assert.equal(content[0].type, 'text');
    assert.equal(content[1].type, 'tool_use');
  });

  it('omits the text block when assistant content is empty', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'lc_stat', '{}')] },
      ],
      MODEL,
    );
    const content = blocks(req.messages[1]);
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'tool_use');
  });
});

describe('convertToAnthropicRequest — tool results', () => {
  it('converts a tool message into a user message with a tool_result block', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'lc_stat', '{}')] },
        { role: 'tool', content: 'result text', tool_call_id: 'c1' },
      ],
      MODEL,
    );
    assert.equal(req.messages[2].role, 'user');
    assert.deepEqual(blocks(req.messages[2])[0], {
      type: 'tool_result',
      tool_use_id: 'c1',
      content: 'result text',
      is_error: false,
    });
  });

  it('propagates tool_is_error onto the tool_result block', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'lc_stat', '{}')] },
        { role: 'tool', content: 'boom', tool_call_id: 'c1', tool_is_error: true },
      ],
      MODEL,
    );
    assert.equal((blocks(req.messages[2])[0] as { is_error: boolean }).is_error, true);
  });

  it('merges parallel tool results into one user message', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall('c1', 'lc_stat', '{}'), toolCall('c2', 'lc_grep', '{}')],
        },
        { role: 'tool', content: 'r1', tool_call_id: 'c1' },
        { role: 'tool', content: 'r2', tool_call_id: 'c2' },
      ],
      MODEL,
    );
    assertAlternates(req.messages);
    assert.equal(req.messages.length, 3);
    assert.equal(blocks(req.messages[2]).length, 2);
  });

  it('keeps tool_result blocks ahead of merged image blocks', () => {
    // Anthropic requires tool_result blocks first in the content array. When
    // an image was already merged into the user message, a later tool_result
    // must be spliced in after the last tool_result — not pushed to the end.
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall('c1', 'lc_read_image', '{}'), toolCall('c2', 'lc_grep', '{}')],
        },
        { role: 'tool', content: 'r1', tool_call_id: 'c1' },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }],
        },
        { role: 'tool', content: 'r2', tool_call_id: 'c2' },
      ],
      MODEL,
    );

    const content = blocks(req.messages[2]);
    assert.deepEqual(
      content.map((b) => b.type),
      ['tool_result', 'tool_result', 'image'],
      'tool_result blocks must precede the image block',
    );
    assert.equal((content[1] as { tool_use_id: string }).tool_use_id, 'c2');
  });

  it('uses an empty tool_use_id when tool_call_id is missing', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'lc_stat', '{}')] },
        { role: 'tool', content: 'orphan' },
      ],
      MODEL,
    );
    assert.equal((blocks(req.messages[2])[0] as { tool_use_id: string }).tool_use_id, '');
  });
});

describe('convertToAnthropicRequest — DeepSeek thinking mode', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: 'checking',
      reasoning_content: 'internal reasoning',
      tool_calls: [toolCall('c1', 'lc_stat', '{}')],
    },
  ];

  it('emits a leading thinking block when isDeepSeek is set', () => {
    // Pin the current DeepSeek Messages compatibility carrier and ordering.
    // The public compatibility page does not define an encrypted carrier or
    // import Chat's tools-dependent history rule.
    const req = convertToAnthropicRequest(history, MODEL, { isDeepSeek: true });
    const content = blocks(req.messages[1]);
    assert.deepEqual(content[0], { type: 'thinking', thinking: 'internal reasoning' });
    assert.equal(content[1].type, 'text');
    assert.equal(content[2].type, 'tool_use');
  });

  it('omits the thinking block for non-DeepSeek providers', () => {
    const req = convertToAnthropicRequest(history, MODEL);
    const content = blocks(req.messages[1]);
    assert.ok(!content.some((b) => b.type === 'thinking'));
  });

  it('omits the thinking block when reasoning_content is blank', () => {
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'checking',
          reasoning_content: '   ',
          tool_calls: [toolCall('c1', 'lc_stat', '{}')],
        },
      ],
      MODEL,
      { isDeepSeek: true },
    );
    assert.ok(!blocks(req.messages[1]).some((b) => b.type === 'thinking'));
  });
});

describe('Anthropic signed thinking replay', () => {
  const baseUrl = 'https://api.anthropic.com';
  const signed = { type: 'thinking' as const, thinking: 'private reasoning', signature: 'sig_123' };
  const redacted = { type: 'redacted_thinking' as const, data: 'opaque_456' };

  function replayRequest(origin = { baseUrl, model: MODEL }, target = { baseUrl, model: MODEL }) {
    return convertToAnthropicRequest([
      { role: 'user', content: 'inspect this' },
      {
        role: 'assistant',
        content: '',
        anthropic_output_blocks: [signed, redacted],
        anthropic_output_origin: origin,
        tool_calls: [{
          id: 'toolu_1', type: 'function',
          function: { name: 'lc_read_file', arguments: '{"path":"x"}' },
        }],
      },
      { role: 'tool', content: 'result', tool_call_id: 'toolu_1' },
    ], target.model, { baseUrl: target.baseUrl });
  }

  it('replays signed and redacted blocks unchanged before tool_use', () => {
    const req = replayRequest();
    const assistant = req.messages[1].content as AnthropicContentBlock[];
    assert.deepEqual(assistant.slice(0, 2), [signed, redacted]);
    assert.equal(assistant[2].type, 'tool_use');
  });

  it('strips opaque blocks after an endpoint or model switch without a resolved provider contract', () => {
    for (const target of [
      { baseUrl: 'https://api.minimax.io/anthropic', model: MODEL },
      { baseUrl, model: 'claude-opus-5' },
    ]) {
      const assistant = replayRequest(undefined, target).messages[1].content as AnthropicContentBlock[];
      assert.equal(assistant.some((block) => block.type === 'thinking'), false, JSON.stringify(target));
      assert.equal(assistant.some((block) => block.type === 'redacted_thinking'), false, JSON.stringify(target));
      assert.equal(assistant.at(-1)?.type, 'tool_use');
    }
  });

  it('does not replay opaque blocks whose origin is unavailable', () => {
    const req = convertToAnthropicRequest([
      { role: 'user', content: 'inspect this' },
      {
        role: 'assistant',
        content: '',
        anthropic_output_blocks: [signed],
        tool_calls: [{
          id: 'toolu_1', type: 'function',
          function: { name: 'lc_read_file', arguments: '{}' },
        }],
      },
    ], MODEL, { baseUrl });
    assert.equal((req.messages[1].content as AnthropicContentBlock[])
      .some((block) => block.type === 'thinking'), false);
  });

  it('re-expands three response groups with every signed/redacted block in provider order', () => {
    const round1 = { type: 'thinking' as const, thinking: 'one', signature: 'sig-1' };
    const round2 = { type: 'redacted_thinking' as const, data: 'cipher-2' };
    const round3 = { type: 'thinking' as const, thinking: '', signature: 'sig-3' };
    const req = convertToAnthropicRequest([
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: 'final',
        anthropic_output_blocks: [round1, round2, round3],
        anthropic_output_origin: { baseUrl, model: MODEL },
        tool_calls: [
          toolCall('toolu_1', 'first', '{}'),
          toolCall('toolu_2', 'second', '{}'),
        ],
        opaque_replay_accounting: [
          {
            schemaVersion: 1,
            protocol: 'anthropic-messages',
            reasoningCarrier: 'signed-thinking',
            generatedReasoningTokens: 100,
            tokenStatus: 'provider-estimate',
            locator: { kind: 'anthropic-block-indexes', blockIndexes: [0] },
            toolCallIds: ['toolu_1'],
          },
          {
            schemaVersion: 1,
            protocol: 'anthropic-messages',
            reasoningCarrier: 'redacted-thinking',
            generatedReasoningTokens: 200,
            tokenStatus: 'provider-estimate',
            locator: { kind: 'anthropic-block-indexes', blockIndexes: [1] },
            toolCallIds: ['toolu_2'],
          },
          {
            schemaVersion: 1,
            protocol: 'anthropic-messages',
            reasoningCarrier: 'signed-thinking',
            generatedReasoningTokens: 300,
            tokenStatus: 'provider-estimate',
            locator: { kind: 'anthropic-block-indexes', blockIndexes: [2] },
          },
        ],
      },
      { role: 'tool', content: 'result-1', tool_call_id: 'toolu_1' },
      { role: 'tool', content: 'result-2', tool_call_id: 'toolu_2' },
      { role: 'user', content: 'continue' },
    ], MODEL, { baseUrl });

    assertAlternates(req.messages);
    assert.deepEqual(req.messages.map((message) => message.role), [
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user',
    ]);
    assert.deepEqual(blocks(req.messages[1]).map((block) => block.type), ['thinking', 'tool_use']);
    assert.deepEqual(blocks(req.messages[3]).map((block) => block.type), ['redacted_thinking', 'tool_use']);
    assert.deepEqual(blocks(req.messages[5]).map((block) => block.type), ['thinking', 'text']);
    assert.equal((blocks(req.messages[2])[0] as { tool_use_id: string }).tool_use_id, 'toolu_1');
    assert.equal((blocks(req.messages[4])[0] as { tool_use_id: string }).tool_use_id, 'toolu_2');
    assert.equal(JSON.stringify(req.messages).match(/"text":"final"/g)?.length, 1);
  });

  it('captures thinking signatures and redacted blocks from CRLF SSE', async () => {
    const records = [
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ] as const;
    const encoder = new TextEncoder();
    const wire = records.map(([event, data]) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`).join('');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(wire));
        controller.close();
      },
    });
    const visible: string[] = [];
    const result = await new AnthropicAdapter('https://api.anthropic.com').parseStream(
      body,
      { onDelta: () => {}, onReasoning: (text) => visible.push(text) },
      1000,
      new ToolCallAccumulator(),
    );
    assert.deepEqual(visible, ['reason']);
    assert.deepEqual(result.anthropic_output_blocks, [
      { type: 'thinking', thinking: 'reason', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
    ]);
  });
});

describe('convertToAnthropicRequest — multimodal content', () => {
  it('converts a base64 data URL into an image block', () => {
    const req = convertToAnthropicRequest(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
          ],
        },
      ],
      MODEL,
    );
    const content = blocks(req.messages[0]);
    assert.deepEqual(content[0], { type: 'text', text: 'what is this' });
    assert.deepEqual(content[1], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' },
    });
  });

  it('drops non-data-URL images rather than emitting an invalid block', () => {
    // Anthropic has no remote-URL image source here; a passthrough would be
    // rejected by the API, so the block is omitted.
    const req = convertToAnthropicRequest(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
      MODEL,
    );
    const content = blocks(req.messages[0]);
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
  });
});

describe('AnthropicAdapter — buildHeaders', () => {
  it('sends anthropic-version to Anthropic\'s own API, which requires it', () => {
    assert.deepEqual(new AnthropicAdapter('https://api.anthropic.com/v1').buildHeaders('sk-ant-test'), {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'sk-ant-test',
    });
  });

  it('does not impose it on the other servers speaking this protocol', () => {
    // "Anthropic-compatible" is a wire format, not a vendor. None of these
    // require anthropic-version, so LC must not send it to them.
    const compatible = [
      'https://api.minimax.io/anthropic',
      'https://api.deepseek.com/anthropic',
      'https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy',
      'https://api.z.ai/api/anthropic',
      'http://192.168.1.8:1234/v1',
    ];

    for (const baseUrl of compatible) {
      assert.deepEqual(
        new AnthropicAdapter(baseUrl).buildHeaders('key'),
        { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': 'key' },
        `${baseUrl} must not be sent anthropic-version`,
      );
    }
  });

  it('omits the api key header when no key is configured', () => {
    assert.deepEqual(new AnthropicAdapter('http://127.0.0.1:1234/v1').buildHeaders(''), {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
  });
});

describe('convertToAnthropicRequest — reasoning shape per model', () => {
  function reasoningFor(model: string, effort = 'high') {
    const req = convertToAnthropicRequest([{ role: 'user', content: 'hi' }], model, {
      reasoningEnabled: true,
      reasoningEffort: effort,
    });
    return { thinking: req.thinking, output_config: req.output_config };
  }

  // Every expectation below mirrors `capabilities` from a live
  // GET https://api.anthropic.com/v1/models response (2026-08-05).

  it('sends adaptive thinking to every Claude on major version 5 or later', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']) {
      assert.deepEqual(
        reasoningFor(model),
        { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
        `${model} reports thinking.types.enabled.supported=false; budget_tokens returns 400`,
      );
    }
  });

  it('keeps xhigh for models that support it and folds it to max for 4.6', () => {
    assert.deepEqual(reasoningFor('claude-opus-5', 'xhigh').output_config, { effort: 'xhigh' });
    assert.deepEqual(reasoningFor('claude-opus-4-7', 'xhigh').output_config, { effort: 'xhigh' });
    assert.deepEqual(reasoningFor('claude-opus-4-6', 'xhigh').output_config, { effort: 'max' });
    assert.deepEqual(reasoningFor('claude-sonnet-4-6', 'xhigh').output_config, { effort: 'max' });
  });

  it('sends budget_tokens and no effort to models that report no effort support', () => {
    for (const model of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929']) {
      const { thinking, output_config } = reasoningFor(model);
      assert.deepEqual(thinking, { type: 'enabled', budget_tokens: 8192 });
      assert.equal(output_config, undefined, `${model} reports effort.supported=false`);
    }
  });
});

describe('convertToAnthropicRequest — Meta AI (Muse Spark) reasoning shape', () => {
  function metaReasoningFor(effort = 'high') {
    const req = convertToAnthropicRequest([{ role: 'user', content: 'hi' }], 'muse-spark-1.1', {
      reasoningEnabled: true,
      reasoningEffort: effort,
      isMetaAI: true,
    });
    return { thinking: req.thinking, output_config: req.output_config };
  }

  it('sends adaptive thinking + output_config.effort', () => {
    // Meta's Messages endpoint documents `thinking: {type:'adaptive'}` +
    // `output_config.effort` as the shape that carries the effort and returns
    // a summarized output. The `enabled`/`budget_tokens` form is accepted for
    // compatibility but not translated into an effort value, so it silently
    // ignores the selected depth.
    // https://dev.meta.ai/docs/protocols/messages#reasoning
    assert.deepEqual(
      metaReasoningFor('high'),
      { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
    );
    assert.deepEqual(metaReasoningFor('max').output_config, { effort: 'max' });
  });

  it('does not send disabled at effort "none" — Muse Spark always reasons', () => {
    // `thinking: {type:'disabled'}` returns HTTP 400; the field is omitted
    // instead so the request runs at the model's default reasoning level.
    const req = convertToAnthropicRequest([{ role: 'user', content: 'hi' }], 'muse-spark-1.1', {
      reasoningEnabled: true,
      reasoningEffort: 'none',
      isMetaAI: true,
    });
    assert.equal(req.thinking, undefined);
  });
});

describe('convertToAnthropicRequest — request options', () => {
  it('defaults max_tokens and always streams', () => {
    const req = convertToAnthropicRequest([{ role: 'user', content: 'hi' }], MODEL);
    assert.equal(req.max_tokens, 4096);
    assert.equal(req.stream, true);
    assert.equal(req.model, MODEL);
  });

  it('omits sampling parameters that were not supplied', () => {
    const req = convertToAnthropicRequest([{ role: 'user', content: 'hi' }], MODEL);
    assert.equal(req.temperature, undefined);
    assert.equal(req.top_p, undefined);
    assert.equal(req.top_k, undefined);
    assert.equal(req.stop_sequences, undefined);
    assert.equal(req.tools, undefined);
  });

  it('passes through supplied sampling parameters, including zero', () => {
    const req = convertToAnthropicRequest([{ role: 'user', content: 'hi' }], MODEL, {
      maxTokens: 100,
      temperature: 0,
      topP: 0.9,
      topK: 40,
      stopSequences: ['STOP'],
    });
    assert.equal(req.max_tokens, 100);
    assert.equal(req.temperature, 0, 'temperature 0 must survive the undefined check');
    assert.equal(req.top_p, 0.9);
    assert.equal(req.top_k, 40);
    assert.deepEqual(req.stop_sequences, ['STOP']);
  });

  it('converts OpenAI tool definitions to Anthropic input_schema form', () => {
    const tools: ToolDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'lc_read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ];
    const req = convertToAnthropicRequest([{ role: 'user', content: 'hi' }], MODEL, { tools });
    assert.deepEqual(req.tools, [
      {
        name: 'lc_read_file',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ]);
  });

  it('omits an empty tools array', () => {
    const req = convertToAnthropicRequest([{ role: 'user', content: 'hi' }], MODEL, { tools: [] });
    assert.equal(req.tools, undefined);
  });
});

/**
 * `max_tokens` is required by the Messages API, so LC must send one even when
 * the user's override toggle is off. It used to send a hard-coded 4,096 —
 * 3% of a Sonnet 5's 128,000 range — and adaptive thinking has to fit its
 * reasoning inside that same budget, which is the likeliest reason a
 * max-effort request came back with no thinking at all.
 */
describe('Anthropic max_tokens when the user override is off', () => {
  function build(params: Record<string, unknown>) {
    return new AnthropicAdapter('https://api.anthropic.com').buildRequest({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: 'max',
      baseUrl: 'https://api.anthropic.com',
      ...params,
    } as never) as unknown as Record<string, unknown>;
  }

  it("uses the model's reported ceiling when the override is off", () => {
    assert.equal(build({ maxOutputTokens: 128_000 }).max_tokens, 128_000);
  });

  it('prefers the user override over the reported ceiling', () => {
    assert.equal(build({ maxTokens: 8_000, maxOutputTokens: 128_000 }).max_tokens, 8_000);
  });

  it('falls back to a safe constant when the server reported no ceiling', () => {
    // A compatible server that lists only ids leaves LC nothing to go on, and
    // the API still demands the field.
    assert.equal(build({}).max_tokens, 4_096);
  });

  it('leaves room for thinking rather than capping it at the old default', () => {
    const req = build({ maxOutputTokens: 128_000 });
    assert.equal((req.thinking as { type: string }).type, 'adaptive');
    assert.ok((req.max_tokens as number) > 4_096);
  });
});

/**
 * `budget_tokens` is carved out of `max_tokens`, so a request whose budget is
 * not strictly smaller is rejected outright. Observed live on QwenCloud's
 * Anthropic Messages endpoint with `qwen3.8-max`: reasoning override on at
 * `max`, every other toggle off, and a model list that reports no output
 * ceiling — LC sent `max_tokens: 4096` with `budget_tokens: 16384` and the
 * request 400'd with "max_completion_tokens [4096] must be greater than
 * thinking_budget [16384]".
 *
 * Only models that miss the Claude name match reach this path; Claude models
 * take the adaptive branch and carry no budget at all.
 */
describe('Anthropic thinking budget vs. max_tokens', () => {
  function build(params: Record<string, unknown>) {
    return new AnthropicAdapter('https://dashscope-intl.aliyuncs.com/api/v2').buildRequest({
      model: 'qwen3.8-max',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: 'max',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/api/v2',
      ...params,
    } as never) as unknown as Record<string, unknown>;
  }

  function budgetOf(req: Record<string, unknown>): number {
    return (req.thinking as { budget_tokens?: number }).budget_tokens ?? 0;
  }

  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    it(`keeps the budget under max_tokens at ${effort} effort`, () => {
      const req = build({ reasoningEffort: effort });
      assert.ok(
        budgetOf(req) < (req.max_tokens as number),
        `budget ${budgetOf(req)} must be < max_tokens ${req.max_tokens}`,
      );
    });
  }

  it('grows max_tokens when nothing real caps it', () => {
    // 24,576 * 2.5. `max_tokens` is only LC's placeholder here, so it yields.
    const req = build({});
    assert.equal(budgetOf(req), 24_576);
    assert.equal(req.max_tokens, 61_440);
  });

  it("never grows max_tokens past the user's explicit override", () => {
    const req = build({ maxTokens: 8_000 });
    assert.equal(req.max_tokens, 8_000, 'the override is a hard cap');
    assert.equal(budgetOf(req), 3_200, 'the budget yields instead');
  });

  it('never grows max_tokens past the reported ceiling', () => {
    const req = build({ maxOutputTokens: 10_000 });
    assert.equal(req.max_tokens, 10_000);
    assert.equal(budgetOf(req), 4_000);
  });

  it('leaves a roomy ceiling alone rather than shrinking it to the ratio', () => {
    const req = build({ maxOutputTokens: 128_000 });
    assert.equal(req.max_tokens, 128_000, 'the ratio is a floor, not an assignment');
    assert.equal(budgetOf(req), 24_576, 'the full requested budget fits');
  });

  it('holds the budget at its floor when the cap is small', () => {
    const req = build({ maxTokens: 2_000, reasoningEffort: 'low' });
    assert.equal(budgetOf(req), 1_024, "Anthropic's documented minimum");
    assert.ok(budgetOf(req) < (req.max_tokens as number));
  });

  it('leaves MiniMax untouched — it has no budget to accommodate', () => {
    const req = new AnthropicAdapter('https://api.minimax.io/v1').buildRequest({
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: 'max',
      baseUrl: 'https://api.minimax.io/v1',
    } as never) as unknown as Record<string, unknown>;
    assert.deepEqual(req.thinking, { type: 'adaptive' });
    assert.equal(req.max_tokens, 4_096, 'the untied fallback, exactly as before');
  });
});

describe('AnthropicAdapter — contract-governed DeepSeek Messages controls', () => {
  const baseUrl = 'https://api.deepseek.com/anthropic';
  const providerContract = resolveBundledProviderContract({
    baseUrl,
    protocol: 'anthropic-messages',
    modelId: 'deepseek-chat',
  });

  function build(reasoningEnabled: boolean, reasoningEffort: string) {
    assert.ok(providerContract);
    return new AnthropicAdapter(baseUrl).buildRequest({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoningEnabled,
      reasoningEffort,
      baseUrl,
      providerContract,
      providerContractStatus: 'matched',
    } as never) as unknown as Record<string, unknown>;
  }

  it('uses the declared mode and effort without inventing a Claude token budget', () => {
    const req = build(true, 'high');
    assert.deepEqual(req.thinking, { type: 'enabled' });
    assert.deepEqual(req.output_config, { effort: 'high' });
  });

  it('uses the declared disabled mode and omits effort and budget controls', () => {
    const req = build(false, 'none');
    assert.deepEqual(req.thinking, { type: 'disabled' });
    assert.equal(req.output_config, undefined);
  });
});

describe('AnthropicAdapter — contract-governed Meta Messages controls', () => {
  const baseUrl = 'https://api.meta.ai/v1';
  const providerContract = resolveBundledProviderContract({
    baseUrl,
    protocol: 'anthropic-messages',
    modelId: 'muse-spark-1.3',
  });

  function build(reasoningEnabled: boolean, reasoningEffort: string) {
    assert.ok(providerContract);
    return new AnthropicAdapter(baseUrl).buildRequest({
      model: 'muse-spark-1.3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoningEnabled,
      reasoningEffort,
      topK: 40,
      stopSequences: ['STOP'],
      baseUrl,
      providerContract,
      providerContractStatus: 'matched',
    } as never) as unknown as Record<string, unknown>;
  }

  it('sends adaptive mode with every effort unchanged, including max', () => {
    // https://ai.developer.meta.com/docs/protocols/messages
    assert.deepEqual(build(true, 'high').thinking, { type: 'adaptive' });
    assert.deepEqual(build(true, 'high').output_config, { effort: 'high' });
    assert.deepEqual(build(true, 'max').output_config, { effort: 'max' });
  });

  it('sends disabled mode for none instead of omitting it', () => {
    const req = build(true, 'none');
    assert.deepEqual(req.thinking, { type: 'disabled' });
    assert.equal(req.output_config, undefined);
  });

  it('never emits top_k or stop_sequences, even from imported settings', () => {
    for (const req of [build(true, 'high'), build(true, 'none')]) {
      assert.equal(req.top_k, undefined);
      assert.equal(req.stop_sequences, undefined);
    }
  });

  it('authenticates with Bearer and sends neither x-api-key nor anthropic-version', () => {
    assert.ok(providerContract);
    const adapter = new AnthropicAdapter(baseUrl);
    adapter.buildRequest({
      model: 'muse-spark-1.3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: 'high',
      baseUrl,
      providerContract,
      providerContractStatus: 'matched',
    } as never);
    assert.deepEqual(adapter.buildHeaders('meta-key'), {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer meta-key',
    });
  });

  it('leaves lookalike origins on the generic unmatched path', () => {
    const lookalike = 'https://foo.meta.ai/v1';
    const req = new AnthropicAdapter(lookalike).buildRequest({
      model: 'muse-spark-1.3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: 'high',
      baseUrl: lookalike,
      providerContractStatus: 'unmatched',
    });
    assert.equal(req.thinking, undefined);
    assert.equal(req.output_config, undefined);
  });
});

describe('AnthropicAdapter — unlisted Messages fallback', () => {
  const baseUrl = 'https://messages-relay.example/v1';

  it('replays same-route thinking blocks without inventing controls', () => {
    const req = new AnthropicAdapter(baseUrl).buildRequest({
      model: 'future-model',
      messages: [{
        role: 'assistant',
        content: 'answer',
        anthropic_output_blocks: [{ type: 'thinking', thinking: 'thought', signature: 'signature' }],
        anthropic_output_origin: { baseUrl, model: 'future-model' },
      }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: 'max',
      baseUrl,
      providerContractStatus: 'unmatched',
    });
    assert.equal(req.thinking, undefined);
    assert.equal(req.output_config, undefined);
    const assistant = req.messages.find((message) => message.role === 'assistant');
    assert.ok(assistant && Array.isArray(assistant.content));
    assert.deepEqual(assistant.content[0], {
      type: 'thinking', thinking: 'thought', signature: 'signature',
    });
  });

  it('drops thinking blocks after a model switch on an unmatched provider surface', () => {
    const req = new AnthropicAdapter(baseUrl).buildRequest({
      model: 'different-model',
      messages: [{
        role: 'assistant',
        content: 'answer',
        anthropic_output_blocks: [{ type: 'thinking', thinking: 'thought', signature: 'signature' }],
        anthropic_output_origin: { baseUrl, model: 'future-model' },
      }],
      stream: true,
      reasoningEnabled: false,
      baseUrl,
      providerContractStatus: 'unmatched',
    });
    assert.equal(JSON.stringify(req.messages).includes('signature'), false);
  });
});

/**
 * Two Anthropic-only opt-ins, both keyed on the base URL.
 *
 * Neither is sent to the other servers speaking this protocol: they already
 * behave correctly without them, an unknown field is a rejection risk, and
 * constraint 7 promises a compatible server keeps working exactly as before.
 */
describe('Anthropic-only request opt-ins', () => {
  const COMPATIBLE = 'https://api.minimax.io/anthropic';

  function build(model: string, baseUrl: string, effort = 'max') {
    return new AnthropicAdapter(baseUrl).buildRequest({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: effort,
      baseUrl,
    } as never) as unknown as Record<string, unknown>;
  }

  /**
   * The reported bug: every Claude 5 produced no reasoning whatever the UI was
   * set to. `thinking.display` defaults to `omitted` from Opus 4.7 onward, so
   * the thinking blocks arrived with an empty `thinking` field.
   */
  it('asks for summarized thinking on models that would otherwise omit it', () => {
    for (const model of [
      'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5',
      'claude-opus-4-8', 'claude-opus-4-7',
    ]) {
      assert.deepEqual(
        build(model, 'https://api.anthropic.com').thinking,
        { type: 'adaptive', display: 'summarized' },
        `${model} defaults to display:omitted and returns empty thinking text`,
      );
    }
  });

  it('leaves 4.6 alone, which predates the field and already summarizes', () => {
    for (const model of ['claude-opus-4-6', 'claude-sonnet-4-6']) {
      assert.deepEqual(build(model, 'https://api.anthropic.com').thinking, { type: 'adaptive' });
    }
  });

  it('never sends display to a compatible server', () => {
    assert.deepEqual(build('claude-sonnet-5', COMPATIBLE).thinking, { type: 'adaptive' });
  });

  it('does not send display on the budget_tokens path', () => {
    assert.deepEqual(
      build('claude-haiku-4-5-20251001', 'https://api.anthropic.com').thinking,
      { type: 'enabled', budget_tokens: 24576 },
    );
  });

  /**
   * The other reported bug: cache read and write were always 0. Anthropic
   * caching is opt-in, so with no `cache_control` the server truthfully
   * reported zero — unlike the compatible services, which cache automatically.
   */
  it('opts in to automatic prompt caching on Anthropic\'s own API', () => {
    assert.deepEqual(
      build('claude-sonnet-5', 'https://api.anthropic.com').cache_control,
      { type: 'ephemeral' },
    );
  });

  it('does not opt a compatible server in', () => {
    assert.equal(build('MiniMax-M3', COMPATIBLE).cache_control, undefined);
  });

  it('places no breakpoint of its own anywhere in the request body', () => {
    // cache-observability.md §1: LC must not insert or move a native cache breakpoint. The
    // top-level field asks the server to place it; nothing below the root
    // carries a directive.
    const req = build('claude-sonnet-5', 'https://api.anthropic.com');
    const { cache_control: _root, ...rest } = req;
    assert.ok(
      !JSON.stringify(rest).includes('cache_control'),
      'no content block, tool, or system entry may carry cache_control',
    );
  });

  it('keeps the MiniMax thinking override free of both opt-ins', () => {
    const req = build('MiniMax-M3', COMPATIBLE);
    assert.deepEqual(req.thinking, { type: 'adaptive' });
    assert.equal(req.cache_control, undefined);
  });
});

/**
 * Argument-accumulation cap on the Anthropic `input_json_delta` path. The
 * adapter buffers partial_json per tool_use block and ingests it into the
 * shared ToolCallAccumulator, so the bound must hold at both layers.
 */
describe('AnthropicAdapter — argument cap on the input_json_delta path', () => {
  function anthropicSseBody(events: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(events.flatMap((event) => [event, '']).join('\n')));
        controller.close();
      },
    });
  }

  function sseEvent(type: string, payload: string): string {
    return `event: ${type}\ndata: ${payload}`;
  }

  function startEvent(index: number, id: string, name: string): string {
    return sseEvent('content_block_start', JSON.stringify({
      type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} },
    }));
  }

  function deltaEvent(index: number, partial: string): string {
    return sseEvent('content_block_delta', JSON.stringify({
      type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partial },
    }));
  }

  const callbacks = { onDelta: () => {}, onReasoning: () => {}, onRefusal: () => {}, onToolCall: () => {} };

  it('drops the call when the delta stream exceeds the cap', async () => {
    const big = 'x'.repeat(TOOL_CALL_ARGS_MAX_CHARS + 1);
    const acc = new ToolCallAccumulator();
    const body = anthropicSseBody([
      startEvent(0, 'toolu_1', 'lc_test'),
      deltaEvent(0, big),
      sseEvent('content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 0 })),
    ]);
    const result = await new AnthropicAdapter('https://api.anthropic.com').parseStream(body, callbacks, 1000, acc);
    assert.equal((result.tool_calls ?? []).length, 0, 'a capped delta stream must not produce a wire call');
    assert.equal(result.finish_reason, 'error', 'the capped turn terminates in error');
    assert.match(result.error_message ?? '', /exceeded/i);
    assert.equal(acc.issues.length, 0, 'the capped slot never reaches the shared accumulator');
  });

  it('a stream ending before content_block_stop still poisons the turn', async () => {
    const big = 'x'.repeat(TOOL_CALL_ARGS_MAX_CHARS + 1);
    const acc = new ToolCallAccumulator();
    const body = anthropicSseBody([
      startEvent(0, 'toolu_1', 'lc_test'),
      deltaEvent(0, big),
      // No content_block_stop, no message_delta — the stream just ends.
    ]);
    const result = await new AnthropicAdapter('https://api.anthropic.com').parseStream(body, callbacks, 1000, acc);
    assert.equal((result.tool_calls ?? []).length, 0, 'no call survives');
    assert.equal(result.finish_reason, 'error', 'EOF after the cap still terminates in error');
    assert.match(result.error_message ?? '', /exceeded/i);
  });

  it('a capped sibling suppresses every valid call in the same turn', async () => {
    const big = 'x'.repeat(TOOL_CALL_ARGS_MAX_CHARS + 1);
    const acc = new ToolCallAccumulator();
    const body = anthropicSseBody([
      startEvent(0, 'toolu_ok', 'lc_test'),
      deltaEvent(0, '{"path":"/a"}'),
      sseEvent('content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 0 })),
      startEvent(1, 'toolu_bad', 'lc_test'),
      deltaEvent(1, big),
      sseEvent('content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 1 })),
      sseEvent('message_delta', JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })),
    ]);
    const result = await new AnthropicAdapter('https://api.anthropic.com').parseStream(body, callbacks, 1000, acc);
    assert.equal(result.tool_calls, undefined, 'the valid sibling must not survive a capped turn');
    assert.equal(result.finish_reason, 'error', 'the provider tool_use finish must not override the cap');
    assert.match(result.error_message ?? '', /exceeded/i);
  });

  it('keeps a delta stream landing exactly on the cap', async () => {
    // `{"content":""}` is 14 characters of framing.
    const exact = `{"content":"${'x'.repeat(TOOL_CALL_ARGS_MAX_CHARS - 14)}"}`;
    assert.equal(exact.length, TOOL_CALL_ARGS_MAX_CHARS);
    const acc = new ToolCallAccumulator();
    const body = anthropicSseBody([
      startEvent(0, 'toolu_1', 'lc_test'),
      deltaEvent(0, exact),
      sseEvent('content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 0 })),
    ]);
    const result = await new AnthropicAdapter('https://api.anthropic.com').parseStream(body, callbacks, 1000, acc);
    assert.equal((result.tool_calls ?? []).length, 1);
    assert.equal(result.tool_calls?.[0].function.arguments.length, TOOL_CALL_ARGS_MAX_CHARS);
    assert.equal(acc.issues.length, 0);
  });

  it('split deltas: exact-cap total stays valid, one char past is dropped', async () => {
    const acc = new AnthropicAdapter('https://api.anthropic.com');
    const acc1 = new ToolCallAccumulator();
    const half = Math.floor(TOOL_CALL_ARGS_MAX_CHARS / 2);
    const exactA = 'a'.repeat(half);
    const exactB = 'b'.repeat(TOOL_CALL_ARGS_MAX_CHARS - half);
    assert.equal(exactA.length + exactB.length, TOOL_CALL_ARGS_MAX_CHARS);
    const body1 = anthropicSseBody([
      startEvent(0, 'toolu_1', 'lc_test'),
      deltaEvent(0, exactA),
      deltaEvent(0, exactB),
      sseEvent('content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 0 })),
    ]);
    const result1 = await acc.parseStream(body1, callbacks, 1000, acc1);
    assert.equal((result1.tool_calls ?? []).length, 1);

    // One character over the cap across two deltas: dropped.
    const acc2 = new ToolCallAccumulator();
    const overA = 'a'.repeat(half);
    const overB = 'b'.repeat(TOOL_CALL_ARGS_MAX_CHARS - half + 1);
    const body2 = anthropicSseBody([
      startEvent(0, 'toolu_1', 'lc_test'),
      deltaEvent(0, overA),
      deltaEvent(0, overB),
      sseEvent('content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 0 })),
    ]);
    const result2 = await acc.parseStream(body2, callbacks, 1000, acc2);
    assert.equal((result2.tool_calls ?? []).length, 0);
  });
});

describe('AnthropicAdapter — terminal error events', () => {
  it('preserves an error event that arrives without a trailing blank line', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'event: error',
          'data: {"type":"error","error":{"message":"trailing provider failure"}}',
        ].join('\n')));
        controller.close();
      },
    });
    const result = await new AnthropicAdapter('https://api.anthropic.com').parseStream(
      body,
      { onDelta: () => {} },
      1_000,
      new ToolCallAccumulator(),
    );

    assert.equal(result.finish_reason, 'error');
    assert.equal(result.error_message, 'trailing provider failure');
  });
});

/**
 * Per-model thinking configuration, reconciled against Anthropic's published
 * per-model tables rather than against LC's own prior belief.
 *
 * `xhigh` is a NEWER level than `max`, so "supports max" does not imply
 * "supports xhigh": Mythos Preview and the 4.6 pair take `max` and reject
 * `xhigh`. And the models that reject `thinking: {type:"disabled"}` are the
 * three marked `Always on` — Fable 5, Mythos 5, and Mythos Preview — not the
 * ones marked `On`.
 *
 * https://platform.claude.com/docs/en/build-with-claude/effort#effort-levels
 * https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting#supported-models
 */
describe('convertToAnthropicRequest — Mythos Preview capability rows', () => {
  const MYTHOS_PREVIEW = 'claude-mythos-preview';

  function build(model: string, effort: string) {
    return convertToAnthropicRequest([{ role: 'user', content: 'hi' }], model, {
      reasoningEnabled: true,
      reasoningEffort: effort,
      isAnthropicOwnApi: true,
    });
  }

  it('folds xhigh to max — Mythos Preview supports max but not xhigh', () => {
    assert.deepEqual(build(MYTHOS_PREVIEW, 'xhigh').output_config, { effort: 'max' });
  });

  it('still passes the levels it does support straight through', () => {
    for (const effort of ['low', 'medium', 'high', 'max']) {
      assert.deepEqual(build(MYTHOS_PREVIEW, effort).output_config, { effort });
    }
  });

  it('keeps adaptive thinking and the summarized-display opt-in', () => {
    assert.deepEqual(build(MYTHOS_PREVIEW, 'high').thinking, { type: 'adaptive', display: 'summarized' });
  });

  it('never sends thinking:{type:"disabled"} to an always-on model', () => {
    for (const model of ['claude-fable-5', 'claude-mythos-5', MYTHOS_PREVIEW]) {
      assert.equal(
        build(model, 'none').thinking,
        undefined,
        `${model} is marked "Always on" and rejects "disabled" with a 400`,
      );
    }
  });

  it('still disables thinking on a model that accepts it', () => {
    assert.deepEqual(build('claude-opus-4-6', 'none').thinking, { type: 'disabled' });
    assert.deepEqual(build('claude-sonnet-5', 'none').thinking, { type: 'disabled' });
  });
});

describe('AnthropicAdapter — terminal-only usage is still a provider report', () => {
  function bodyOf(events: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(events.flatMap((event) => [event, '']).join('\n')));
        controller.close();
      },
    });
  }

  const callbacks = { onDelta: () => {}, onReasoning: () => {}, onRefusal: () => {}, onToolCall: () => {} };

  it('keeps output_tokens when message_start carried no usage at all', async () => {
    // A compatible server that reports only on the terminal event. Gating the
    // envelope on message_start's usage threw the figure away and left LC
    // counting tokens itself.
    const body = bodyOf([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);
    const result = await new AnthropicAdapter('http://127.0.0.1:1234/v1')
      .parseStream(body, callbacks, 1000, new ToolCallAccumulator());
    assert.equal(result.usage?.completion_tokens, 42);
    assert.equal(result.usage?.source, 'provider');
    assert.equal(result.usage?.cache?.status, 'not-reported');
  });

  it('preserves thinking_tokens delivered only on the terminal message_delta', async () => {
    const body = bodyOf([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42,"output_tokens_details":{"thinking_tokens":40}}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);
    const result = await new AnthropicAdapter('https://api.anthropic.com/v1')
      .parseStream(body, callbacks, 1000, new ToolCallAccumulator());
    assert.equal(result.usage?.completion_tokens, 42);
    assert.equal(result.usage?.total_tokens, 52, 'thinking is already included in output_tokens');
    assert.deepEqual(result.usage?.reasoning, {
      status: 'reported', tokens: 40, measurement: 'provider-estimate',
    });
  });

  it('still reports no usage when the provider sent none', async () => {
    const body = bodyOf([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    ]);
    const result = await new AnthropicAdapter('http://127.0.0.1:1234/v1')
      .parseStream(body, callbacks, 1000, new ToolCallAccumulator());
    assert.equal(result.usage, undefined);
  });
});

/**
 * `isAnthropicOwnApi()` decides who receives Anthropic-only fields — the
 * `anthropic-version` header, top-level `cache_control`, and
 * `thinking.display`. A false positive puts all three on a server that is not
 * Anthropic, which is standing constraint 7 broken.
 *
 * The cases that matter are the ones that merely *contain* the name. A
 * substring test passes both of them: a different registrable domain that
 * starts with it, and an unrelated host carrying it in a path segment. Neither
 * appears in a plausible-looking list of compatible endpoints, which is exactly
 * why the predicate has to be tested with inputs chosen to break it rather than
 * with inputs chosen to look realistic.
 */
describe('isAnthropicOwnApi — hostname, not substring', () => {
  it('accepts Anthropic\'s own host', () => {
    for (const url of [
      'https://api.anthropic.com',
      'https://api.anthropic.com/v1',
      'https://API.Anthropic.COM/v1',
    ]) {
      assert.equal(isAnthropicOwnApi(url), true, url);
    }
  });

  it('rejects hosts and paths that merely contain the name', () => {
    for (const url of [
      'https://api.anthropic.com.evil.example/v1',
      'https://not-api.anthropic.com.co/v1',
      'https://proxy.test/api.anthropic.com/v1',
      'https://api.anthropic.com.example.net/api.anthropic.com/v1',
    ]) {
      assert.equal(isAnthropicOwnApi(url), false, `${url} is not Anthropic's own API`);
    }
  });

  it('rejects a subdomain of the real host, which is a different endpoint', () => {
    assert.equal(isAnthropicOwnApi('https://staging.api.anthropic.com/v1'), false);
  });

  it('rejects absent and unparseable values instead of throwing', () => {
    assert.equal(isAnthropicOwnApi(undefined), false);
    assert.equal(isAnthropicOwnApi(''), false);
    assert.equal(isAnthropicOwnApi('api.anthropic.com/v1'), false);
  });

  it('keeps every Anthropic-only field off a lookalike endpoint', () => {
    const lookalike = 'https://api.anthropic.com.evil.example/v1';

    assert.deepEqual(
      new AnthropicAdapter(lookalike).buildHeaders('key'),
      { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': 'key' },
      'anthropic-version must not reach a lookalike host',
    );

    const req = convertToAnthropicRequest([{ role: 'user', content: 'hi' }], 'claude-sonnet-5', {
      reasoningEnabled: true,
      reasoningEffort: 'high',
      isAnthropicOwnApi: isAnthropicOwnApi(lookalike),
    });
    assert.equal(req.cache_control, undefined, 'the cache opt-in must not reach a lookalike host');
    assert.deepEqual(req.thinking, { type: 'adaptive' }, 'display must not reach a lookalike host');
  });
});

describe('AnthropicAdapter — recorded provider block order', () => {
  const META_BASE = 'https://api.meta.ai/v1';
  const metaContract = resolveBundledProviderContract({
    baseUrl: META_BASE,
    protocol: 'anthropic-messages',
    modelId: 'muse-spark-1.3-contributor',
  });
  const callbacks = { onDelta: () => {}, onReasoning: () => {}, onRefusal: () => {}, onToolCall: () => {} };

  function bodyOf(events: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(events.flatMap((event) => [event, '']).join('\n')));
        controller.close();
      },
    });
  }

  function startBlock(index: number, block: unknown): string {
    return `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: block })}`;
  }

  function stopBlock(index: number): string {
    return `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}`;
  }

  /** Stream shape [text, thinking, tool_use]: text arrives before thinking. */
  async function textFirstResult() {
    const body = bodyOf([
      startBlock(0, { type: 'text', text: 'Working on it.' }),
      stopBlock(0),
      startBlock(1, { type: 'thinking', thinking: 'plan' }),
      stopBlock(1),
      startBlock(2, { type: 'tool_use', id: 'toolu_1', name: 'lc_test', input: {} }),
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } })}`,
      stopBlock(2),
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } })}`,
    ]);
    return new AnthropicAdapter(META_BASE).parseStream(body, callbacks, 1000, new ToolCallAccumulator());
  }

  it('records the streamed kind order alongside the blocks', async () => {
    const result = await textFirstResult();
    assert.deepEqual(result.anthropic_block_order, [
      { kind: 'text', index: 0, text: 'Working on it.' },
      { kind: 'thinking', index: 1 },
      { kind: 'tool_use', index: 2 },
    ]);
    assert.deepEqual(result.anthropic_output_blocks, [
      { type: 'thinking', thinking: 'plan', signature: undefined },
    ]);
  });

  it('serializes the recorded order instead of the legacy layout', () => {
    assert.ok(metaContract);
    const message = {
      role: 'assistant',
      content: 'Working on it.',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'lc_test', arguments: '{}' } }],
      anthropic_output_blocks: [{ type: 'thinking', thinking: 'plan' }],
      anthropic_output_origin: { baseUrl: META_BASE, model: 'muse-spark-1.3-contributor' },
      anthropic_block_order: [
        { kind: 'text', index: 0 },
        { kind: 'thinking', index: 1 },
        { kind: 'tool_use', index: 2 },
      ],
    } as unknown as ChatMessage;
    const req = convertToAnthropicRequest([message], 'muse-spark-1.3-contributor', {
      baseUrl: META_BASE,
      providerContract: metaContract,
      providerContractStatus: 'matched',
    });
    // The history opens with an assistant turn, so the adapter prepends a
    // synthetic user message; the assistant turn under test is last.
    const assistant = req.messages.at(-1)!;
    assert.deepEqual(
      (assistant.content as AnthropicContentBlock[]).map((block) => block.type),
      ['text', 'thinking', 'tool_use'],
      'text-first provider order must survive serialization',
    );
    const legacy = convertToAnthropicRequest(
      [{ ...message, anthropic_block_order: undefined } as unknown as ChatMessage],
      'muse-spark-1.3-contributor',
      { baseUrl: META_BASE, providerContract: metaContract, providerContractStatus: 'matched' },
    );
    assert.deepEqual(
      (legacy.messages.at(-1)!.content as AnthropicContentBlock[]).map((block) => block.type),
      ['thinking', 'text', 'tool_use'],
      'absent order keeps the legacy layout byte-for-byte',
    );
  });

  it('never emits gated-out opaque blocks even with a recorded order', () => {
    assert.ok(metaContract);
    const message = {
      role: 'assistant',
      content: 'Working on it.',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'lc_test', arguments: '{}' } }],
      anthropic_output_blocks: [{ type: 'thinking', thinking: 'plan' }],
      anthropic_output_origin: { baseUrl: META_BASE, model: 'muse-spark-1.3-contributor' },
      anthropic_block_order: [
        { kind: 'text', index: 0 },
        { kind: 'thinking', index: 1 },
        { kind: 'tool_use', index: 2 },
      ],
    } as unknown as ChatMessage;
    const req = convertToAnthropicRequest([message], 'muse-spark-1.3-contributor', {
      baseUrl: 'https://opencode.ai/zen/v1',
      providerContractStatus: 'unmatched',
    });
    const types = (req.messages.at(-1)!.content as AnthropicContentBlock[]).map((block) => block.type);
    assert.ok(!types.includes('thinking'), 'opaque Meta state must not reach another origin');
    assert.deepEqual(types, ['text', 'tool_use']);
  });

  it('replays several text blocks in place instead of joining them first', async () => {
    assert.ok(metaContract);
    const delta = (index: number, text: string): string =>
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })}`;
    const body = bodyOf([
      startBlock(0, { type: 'text', text: 'Alpha ' }),
      delta(0, 'and '),
      stopBlock(0),
      startBlock(1, { type: 'thinking', thinking: 'plan' }),
      stopBlock(1),
      startBlock(2, { type: 'text', text: 'beta.' }),
      stopBlock(2),
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } })}`,
    ]);
    const result = await new AnthropicAdapter(META_BASE).parseStream(body, callbacks, 1000, new ToolCallAccumulator());
    assert.deepEqual(result.anthropic_block_order, [
      { kind: 'text', index: 0, text: 'Alpha and ' },
      { kind: 'thinking', index: 1 },
      { kind: 'text', index: 2, text: 'beta.' },
    ]);
    const message = {
      role: 'assistant',
      content: result.content,
      anthropic_output_blocks: result.anthropic_output_blocks,
      anthropic_output_origin: { baseUrl: META_BASE, model: 'muse-spark-1.3-contributor' },
      anthropic_block_order: result.anthropic_block_order,
    } as unknown as ChatMessage;
    const req = convertToAnthropicRequest([message], 'muse-spark-1.3-contributor', {
      baseUrl: META_BASE,
      providerContract: metaContract,
      providerContractStatus: 'matched',
    });
    const content = req.messages.at(-1)!.content as AnthropicContentBlock[];
    assert.deepEqual(content.map((block) => block.type), ['text', 'thinking', 'text']);
    assert.deepEqual(
      content.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text),
      ['Alpha and ', 'beta.'],
      'each provider text segment must keep its own position',
    );
  });

  it('filters the recorded order to each expanded response group', () => {
    assert.ok(metaContract);
    const round1 = { type: 'thinking' as const, thinking: 'one', signature: 'sig-1' };
    const round2 = { type: 'redacted_thinking' as const, data: 'cipher-2' };
    const round3 = { type: 'thinking' as const, thinking: 'three', signature: 'sig-3' };
    const group = (
      blockIndexes: number[],
      toolCallIds: string[],
      carrier: 'signed-thinking' | 'redacted-thinking',
      tokens: number,
    ) => ({
      schemaVersion: 1 as const,
      protocol: 'anthropic-messages' as const,
      reasoningCarrier: carrier,
      generatedReasoningTokens: tokens,
      tokenStatus: 'provider-estimate' as const,
      locator: { kind: 'anthropic-block-indexes' as const, blockIndexes },
      toolCallIds,
    });
    const req = convertToAnthropicRequest([
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: 'final',
        anthropic_output_blocks: [round1, round2, round3],
        anthropic_output_origin: { baseUrl: META_BASE, model: 'muse-spark-1.3-contributor' },
        tool_calls: [toolCall('toolu_1', 'first', '{}'), toolCall('toolu_2', 'second', '{}')],
        opaque_replay_accounting: [
          group([0], ['toolu_1'], 'signed-thinking', 100),
          group([1], ['toolu_2'], 'redacted-thinking', 200),
          group([2], [], 'signed-thinking', 300),
        ],
        anthropic_block_order: [
          { kind: 'thinking', index: 0, responseIndex: 0 },
          { kind: 'tool_use', index: 1, responseIndex: 0 },
          { kind: 'thinking', index: 2, responseIndex: 1 },
          { kind: 'tool_use', index: 3, responseIndex: 1 },
          { kind: 'thinking', index: 4, responseIndex: 2 },
          { kind: 'text', index: 5, responseIndex: 2, text: 'final' },
        ],
      },
      { role: 'tool', content: 'result-1', tool_call_id: 'toolu_1' },
      { role: 'tool', content: 'result-2', tool_call_id: 'toolu_2' },
      { role: 'user', content: 'continue' },
    ], 'muse-spark-1.3-contributor', {
      baseUrl: META_BASE,
      providerContract: metaContract,
      providerContractStatus: 'matched',
    });
    assert.deepEqual(req.messages.map((message) => message.role), [
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user',
    ]);
    const first = blocks(req.messages[1]);
    const second = blocks(req.messages[3]);
    const third = blocks(req.messages[5]);
    assert.deepEqual(first.map((block) => block.type), ['thinking', 'tool_use']);
    assert.deepEqual(second.map((block) => block.type), ['redacted_thinking', 'tool_use']);
    assert.deepEqual(third.map((block) => block.type), ['thinking', 'text']);
    assert.equal((first[0] as { thinking: string }).thinking, 'one');
    assert.equal((first[1] as { id: string }).id, 'toolu_1');
    assert.equal((second[1] as { id: string }).id, 'toolu_2',
      'the second round must carry its own call, not the first round\u2019s');
    assert.equal((third[0] as { thinking: string }).thinking, 'three');
    assert.equal((third[1] as { text: string }).text, 'final');
  });

  it('keeps intermediate text inside its own response', () => {
    assert.ok(metaContract);
    const redacted = (data: string) => ({ type: 'redacted_thinking' as const, data });
    const group = (blockIndexes: number[], toolCallIds: string[], tokens: number) => ({
      schemaVersion: 1 as const,
      protocol: 'anthropic-messages' as const,
      reasoningCarrier: 'redacted-thinking' as const,
      generatedReasoningTokens: tokens,
      tokenStatus: 'provider-estimate' as const,
      locator: { kind: 'anthropic-block-indexes' as const, blockIndexes },
      toolCallIds,
    });
    const message = {
      role: 'assistant',
      content: 'earlyfinal',
      anthropic_output_blocks: [redacted('cipher-1'), redacted('cipher-2')],
      anthropic_output_origin: { baseUrl: META_BASE, model: 'muse-spark-1.3-contributor' },
      tool_calls: [toolCall('toolu_1', 'first', '{}')],
      opaque_replay_accounting: [
        {
          schemaVersion: 1 as const,
          protocol: 'anthropic-messages' as const,
          reasoningCarrier: 'redacted-thinking' as const,
          generatedReasoningTokens: 100,
          tokenStatus: 'provider-estimate' as const,
          locator: { kind: 'anthropic-block-indexes' as const, blockIndexes: [0] },
          toolCallIds: ['toolu_1'],
        },
        group([1], [], 200),
      ],
      anthropic_block_order: [
        { kind: 'redacted_thinking', index: 0, responseIndex: 0 },
        { kind: 'text', index: 1, responseIndex: 0, text: 'early' },
        { kind: 'tool_use', index: 2, responseIndex: 0 },
        { kind: 'redacted_thinking', index: 3, responseIndex: 1 },
        { kind: 'text', index: 4, responseIndex: 1, text: 'final' },
      ],
    } as unknown as ChatMessage;
    const req = convertToAnthropicRequest([
      { role: 'user', content: 'start' },
      message,
      { role: 'tool', content: 'result-1', tool_call_id: 'toolu_1' },
      { role: 'user', content: 'continue' },
    ], 'muse-spark-1.3-contributor', {
      baseUrl: META_BASE,
      providerContract: metaContract,
      providerContractStatus: 'matched',
    });
    assert.deepEqual(req.messages.map((entry) => entry.role), [
      'user', 'assistant', 'user', 'assistant', 'user',
    ]);
    const first = blocks(req.messages[1]);
    const second = blocks(req.messages[3]);
    assert.deepEqual(first.map((block) => block.type), ['redacted_thinking', 'text', 'tool_use']);
    assert.deepEqual(second.map((block) => block.type), ['redacted_thinking', 'text']);
    assert.equal((first[1] as { text: string }).text, 'early');
    assert.equal((second[1] as { text: string }).text, 'final');
    assert.ok(!JSON.stringify(second).includes('early'), 'intermediate text must not migrate forward');
    assert.ok(!JSON.stringify(first).includes('final'), 'final text must not leak backward');
  });

  it('preserves multi-response text through a persistence-shaped round trip', () => {
    assert.ok(metaContract);
    const redacted = (data: string) => ({ type: 'redacted_thinking' as const, data });
    const stored = JSON.parse(JSON.stringify({
      role: 'assistant',
      content: 'earlyfinal',
      anthropic_output_blocks: [redacted('cipher-1'), redacted('cipher-2')],
      anthropic_output_origin: { baseUrl: META_BASE, model: 'muse-spark-1.3-contributor' },
      tool_calls: [toolCall('toolu_1', 'first', '{}')],
      opaque_replay_accounting: [
        {
          schemaVersion: 1 as const,
          protocol: 'anthropic-messages' as const,
          reasoningCarrier: 'redacted-thinking' as const,
          generatedReasoningTokens: 100,
          tokenStatus: 'provider-estimate' as const,
          locator: { kind: 'anthropic-block-indexes' as const, blockIndexes: [0] },
          toolCallIds: ['toolu_1'],
        },
        {
          schemaVersion: 1 as const,
          protocol: 'anthropic-messages' as const,
          reasoningCarrier: 'redacted-thinking' as const,
          generatedReasoningTokens: 200,
          tokenStatus: 'provider-estimate' as const,
          locator: { kind: 'anthropic-block-indexes' as const, blockIndexes: [1] },
          toolCallIds: [],
        },
      ],
      anthropic_block_order: [
        { kind: 'redacted_thinking', index: 0, responseIndex: 0 },
        { kind: 'text', index: 1, responseIndex: 0, text: 'early' },
        { kind: 'tool_use', index: 2, responseIndex: 0 },
        { kind: 'redacted_thinking', index: 3, responseIndex: 1 },
        { kind: 'text', index: 4, responseIndex: 1, text: 'final' },
      ],
    })) as unknown as ChatMessage;
    const req = convertToAnthropicRequest([
      { role: 'user', content: 'start' },
      stored,
      { role: 'tool', content: 'result-1', tool_call_id: 'toolu_1' },
      { role: 'user', content: 'continue' },
    ], 'muse-spark-1.3-contributor', {
      baseUrl: META_BASE,
      providerContract: metaContract,
      providerContractStatus: 'matched',
    });
    const first = blocks(req.messages[1]);
    const second = blocks(req.messages[3]);
    assert.deepEqual(first.map((block) => block.type), ['redacted_thinking', 'text', 'tool_use']);
    assert.deepEqual(second.map((block) => block.type), ['redacted_thinking', 'text']);
    assert.equal((first[1] as { text: string }).text, 'early');
    assert.equal((second[1] as { text: string }).text, 'final');
  });

  it('keeps the legacy layout for segment-less orders', () => {
    assert.ok(metaContract);
    const message = {
      role: 'assistant',
      content: 'hello',
      tool_calls: [toolCall('toolu_1', 'first', '{}')],
      anthropic_output_blocks: [
        { type: 'redacted_thinking' as const, data: 'cipher-1' },
        { type: 'redacted_thinking' as const, data: 'cipher-2' },
      ],
      anthropic_output_origin: { baseUrl: META_BASE, model: 'muse-spark-1.3-contributor' },
      opaque_replay_accounting: [
        {
          schemaVersion: 1 as const,
          protocol: 'anthropic-messages' as const,
          reasoningCarrier: 'redacted-thinking' as const,
          generatedReasoningTokens: 100,
          tokenStatus: 'provider-estimate' as const,
          locator: { kind: 'anthropic-block-indexes' as const, blockIndexes: [0] },
          toolCallIds: ['toolu_1'],
        },
        {
          schemaVersion: 1 as const,
          protocol: 'anthropic-messages' as const,
          reasoningCarrier: 'redacted-thinking' as const,
          generatedReasoningTokens: 200,
          tokenStatus: 'provider-estimate' as const,
          locator: { kind: 'anthropic-block-indexes' as const, blockIndexes: [1] },
          toolCallIds: [],
        },
      ],
      anthropic_block_order: [
        { kind: 'redacted_thinking', index: 0, responseIndex: 0 },
        { kind: 'text', index: 1, responseIndex: 0 },
        { kind: 'tool_use', index: 2, responseIndex: 0 },
        { kind: 'redacted_thinking', index: 3, responseIndex: 1 },
      ],
    } as unknown as ChatMessage;
    const req = convertToAnthropicRequest([
      { role: 'user', content: 'start' },
      message,
      { role: 'tool', content: 'result-1', tool_call_id: 'toolu_1' },
      { role: 'user', content: 'continue' },
    ], 'muse-spark-1.3-contributor', {
      baseUrl: META_BASE,
      providerContract: metaContract,
      providerContractStatus: 'matched',
    });
    const first = blocks(req.messages[1]);
    const second = blocks(req.messages[3]);
    assert.deepEqual(first.map((block) => block.type), ['redacted_thinking', 'tool_use']);
    assert.deepEqual(second.map((block) => block.type), ['redacted_thinking', 'text']);
    assert.equal((second[1] as { text: string }).text, 'hello');
  });

  it('keeps a text-only final response behind its tool-result boundary', () => {
    assert.ok(metaContract);
    const message = {
      role: 'assistant',
      content: 'earlyfinal',
      anthropic_output_blocks: [{ type: 'redacted_thinking' as const, data: 'cipher-1' }],
      anthropic_output_origin: { baseUrl: META_BASE, model: 'muse-spark-1.3-contributor' },
      tool_calls: [toolCall('toolu_1', 'first', '{}')],
      opaque_replay_accounting: [
        {
          schemaVersion: 1 as const,
          protocol: 'anthropic-messages' as const,
          reasoningCarrier: 'redacted-thinking' as const,
          generatedReasoningTokens: 100,
          tokenStatus: 'provider-estimate' as const,
          locator: { kind: 'anthropic-block-indexes' as const, blockIndexes: [0] },
          toolCallIds: ['toolu_1'],
        },
        {
          schemaVersion: 1 as const,
          protocol: 'anthropic-messages' as const,
          reasoningCarrier: 'none' as const,
          tokenStatus: 'unreported' as const,
          locator: { kind: 'anthropic-block-indexes' as const, blockIndexes: [] },
        },
      ],
      anthropic_block_order: [
        { kind: 'redacted_thinking', index: 0, responseIndex: 0 },
        { kind: 'text', index: 1, responseIndex: 0, text: 'early' },
        { kind: 'tool_use', index: 2, responseIndex: 0 },
        { kind: 'text', index: 3, responseIndex: 1, text: 'final' },
      ],
    } as unknown as ChatMessage;
    const req = convertToAnthropicRequest([
      { role: 'user', content: 'start' },
      message,
      { role: 'tool', content: 'result-1', tool_call_id: 'toolu_1' },
      { role: 'user', content: 'continue' },
    ], 'muse-spark-1.3-contributor', {
      baseUrl: META_BASE,
      providerContract: metaContract,
      providerContractStatus: 'matched',
    });
    assert.deepEqual(req.messages.map((entry) => entry.role), [
      'user', 'assistant', 'user', 'assistant', 'user',
    ]);
    assert.equal((blocks(req.messages[1])[1] as { text: string }).text, 'early');
    assert.equal(req.messages[3].content, 'final');
  });
});

describe('normalizeAnthropicBlockOrder', () => {
  it('accepts well-formed orders with text segments', () => {
    assert.deepEqual(normalizeAnthropicBlockOrder([
      { kind: 'text', index: 0, responseIndex: 0, text: 'hi' },
      { kind: 'thinking', index: 1 },
      { kind: 'redacted_thinking', index: 2 },
      { kind: 'tool_use', index: 3 },
    ]), [
      { kind: 'text', index: 0, responseIndex: 0, text: 'hi' },
      { kind: 'thinking', index: 1 },
      { kind: 'redacted_thinking', index: 2 },
      { kind: 'tool_use', index: 3 },
    ]);
  });

  it('rejects malformed orders wholesale instead of reshuffling', () => {
    assert.equal(normalizeAnthropicBlockOrder(undefined), undefined);
    assert.equal(normalizeAnthropicBlockOrder([]), undefined);
    assert.equal(normalizeAnthropicBlockOrder([{ kind: 'text', index: 0, text: 'hi' }, { kind: 'nope', index: 1 }]), undefined);
    assert.equal(normalizeAnthropicBlockOrder([{ kind: 'text', index: -1, text: 'hi' }]), undefined);
    assert.equal(normalizeAnthropicBlockOrder([{ kind: 'text', index: 0, text: 42 }]), undefined);
    assert.equal(normalizeAnthropicBlockOrder([{ kind: 'text', index: 0, responseIndex: -1 }]), undefined);
    assert.equal(
      normalizeAnthropicBlockOrder(Array.from({ length: 257 }, (_, index) => ({ kind: 'text', index, text: 'x' }))),
      undefined,
    );
  });
});

describe('validateAnthropicBlockOrderText', () => {
  it('accepts only segments that concatenate to canonical content exactly', () => {
    assert.equal(validateAnthropicBlockOrderText(undefined, 'anything'), true);
    assert.equal(validateAnthropicBlockOrderText([], 'anything'), true);
    assert.equal(validateAnthropicBlockOrderText(
      [{ kind: 'thinking', index: 0 }, { kind: 'tool_use', index: 1 }],
      'hello',
    ), true);
    assert.equal(validateAnthropicBlockOrderText(
      [
        { kind: 'text', index: 0, text: 'Alpha and ' },
        { kind: 'thinking', index: 1 },
        { kind: 'text', index: 2, text: 'beta.' },
      ],
      'Alpha and beta.',
    ), true);
    assert.ok(validateAnthropicBlockOrderText(
      [
        { kind: 'text', index: 0, text: 'Done.' },
        { kind: 'thinking', index: 1 },
        { kind: 'text', index: 2, text: ' Done.' },
      ],
      'Done. Done.',
    ), 'repeated identical segments still resolve in order');
  });

  it('rejects segments that cannot come from the canonical content', () => {
    assert.equal(validateAnthropicBlockOrderText(
      [{ kind: 'text', index: 0, text: 'hidden old' }],
      'visible edited',
    ), false);
    assert.equal(validateAnthropicBlockOrderText(
      [{ kind: 'text', index: 0, text: 'old' }],
      'prefix old suffix',
    ), false, 'an ordered substring must not shadow canonical prefix/suffix text');
    assert.equal(validateAnthropicBlockOrderText(
      [
        { kind: 'text', index: 0, text: 'beta.' },
        { kind: 'text', index: 1, text: 'Alpha and ' },
      ],
      'Alpha and beta.',
    ), false);
    assert.equal(validateAnthropicBlockOrderText(
      [{ kind: 'text', index: 0, text: 'Alpha and beta. Plus more.' }],
      'Alpha and beta.',
    ), false);
    assert.ok(!validateAnthropicBlockOrderText(
      [{ kind: 'text', index: 0, text: 'Done.' }, { kind: 'text', index: 1, text: 'Done.' }],
      'Done.',
    ), 'a duplicated segment needs two occurrences');
  });
});

describe('AnthropicAdapter — canonical content authority', () => {
  const META_BASE = 'https://api.meta.ai/v1';
  const metaContract = resolveBundledProviderContract({
    baseUrl: META_BASE,
    protocol: 'anthropic-messages',
    modelId: 'muse-spark-1.3-contributor',
  });

  function staleOrderMessage(content: string) {
    return {
      role: 'assistant',
      content,
      tool_calls: [toolCall('toolu_1', 'first', '{}')],
      anthropic_output_blocks: [
        { type: 'redacted_thinking' as const, data: 'cipher-1' },
        { type: 'redacted_thinking' as const, data: 'cipher-2' },
      ],
      anthropic_output_origin: { baseUrl: META_BASE, model: 'muse-spark-1.3-contributor' },
      opaque_replay_accounting: [
        {
          schemaVersion: 1 as const,
          protocol: 'anthropic-messages' as const,
          reasoningCarrier: 'redacted-thinking' as const,
          generatedReasoningTokens: 100,
          tokenStatus: 'provider-estimate' as const,
          locator: { kind: 'anthropic-block-indexes' as const, blockIndexes: [0] },
          toolCallIds: ['toolu_1'],
        },
        {
          schemaVersion: 1 as const,
          protocol: 'anthropic-messages' as const,
          reasoningCarrier: 'redacted-thinking' as const,
          generatedReasoningTokens: 200,
          tokenStatus: 'provider-estimate' as const,
          locator: { kind: 'anthropic-block-indexes' as const, blockIndexes: [1] },
          toolCallIds: [],
        },
      ],
      anthropic_block_order: [
        { kind: 'redacted_thinking', index: 0 },
        { kind: 'text', index: 1, text: 'hidden old' },
        { kind: 'tool_use', index: 2 },
        { kind: 'redacted_thinking', index: 3 },
        { kind: 'text', index: 4, text: 'hidden older' },
      ],
    } as unknown as ChatMessage;
  }

  it('falls back to canonical content when segments disagree with it', () => {
    assert.ok(metaContract);
    const req = convertToAnthropicRequest([
      { role: 'user', content: 'start' },
      staleOrderMessage('visible edited'),
      { role: 'tool', content: 'result-1', tool_call_id: 'toolu_1' },
      { role: 'user', content: 'continue' },
    ], 'muse-spark-1.3-contributor', {
      baseUrl: META_BASE,
      providerContract: metaContract,
      providerContractStatus: 'matched',
    });
    const wire = JSON.stringify(req);
    assert.ok(!wire.includes('hidden old'), 'stale segments must never reach the wire');
    assert.ok(!wire.includes('hidden older'), 'stale segments must never reach the wire');
    assert.equal(wire.split('visible edited').length - 1, 1, 'canonical content appears exactly once');
    const second = (req.messages[3].content as AnthropicContentBlock[]);
    assert.deepEqual(second.map((block) => block.type), ['redacted_thinking', 'text']);
    assert.equal((second[1] as { text: string }).text, 'visible edited');
  });

  it('treats an edited message the same as a malformed import', () => {
    assert.ok(metaContract);
    const recorded = {
      role: 'assistant',
      content: 'earlyfinal',
      anthropic_output_blocks: [
        { type: 'redacted_thinking' as const, data: 'cipher-1' },
        { type: 'redacted_thinking' as const, data: 'cipher-2' },
      ],
      anthropic_output_origin: { baseUrl: META_BASE, model: 'muse-spark-1.3-contributor' },
      tool_calls: [toolCall('toolu_1', 'first', '{}')],
      opaque_replay_accounting: [
        {
          schemaVersion: 1 as const,
          protocol: 'anthropic-messages' as const,
          reasoningCarrier: 'redacted-thinking' as const,
          generatedReasoningTokens: 100,
          tokenStatus: 'provider-estimate' as const,
          locator: { kind: 'anthropic-block-indexes' as const, blockIndexes: [0] },
          toolCallIds: ['toolu_1'],
        },
        {
          schemaVersion: 1 as const,
          protocol: 'anthropic-messages' as const,
          reasoningCarrier: 'redacted-thinking' as const,
          generatedReasoningTokens: 200,
          tokenStatus: 'provider-estimate' as const,
          locator: { kind: 'anthropic-block-indexes' as const, blockIndexes: [1] },
          toolCallIds: [],
        },
      ],
      anthropic_block_order: [
        { kind: 'redacted_thinking', index: 0 },
        { kind: 'text', index: 1, text: 'early' },
        { kind: 'tool_use', index: 2 },
        { kind: 'redacted_thinking', index: 3 },
        { kind: 'text', index: 4, text: 'final' },
      ],
    } as unknown as ChatMessage;
    // Simulate an in-memory edit that replaces the visible text while the
    // recorded order still describes the old one.
    const edited = { ...recorded, content: 'visible edited' } as unknown as ChatMessage;
    const req = convertToAnthropicRequest([
      { role: 'user', content: 'start' },
      edited,
      { role: 'tool', content: 'result-1', tool_call_id: 'toolu_1' },
      { role: 'user', content: 'continue' },
    ], 'muse-spark-1.3-contributor', {
      baseUrl: META_BASE,
      providerContract: metaContract,
      providerContractStatus: 'matched',
    });
    const wire = JSON.stringify(req);
    assert.ok(!wire.includes('early'), 'pre-edit segments must not survive an edit');
    assert.ok(!wire.includes('final'), 'pre-edit segments must not survive an edit');
    assert.ok(wire.includes('visible edited'), 'edited content stays authoritative');
  });
});
