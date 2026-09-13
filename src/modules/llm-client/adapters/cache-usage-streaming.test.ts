/**
 * Streaming terminal-usage coverage for provider cache counters.
 *
 * `cache-usage.test.ts` pins the pure normalization rules. This file proves
 * the same facts survive the real SSE path of each adapter, including the
 * non-streaming envelopes replayed through `parseStream` (see
 * cache-observability.md §4, cache-observability.md §4).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAIAdapter } from './openai.ts';
import { OpenAIResponsesAdapter } from './openai-responses.ts';
import { AnthropicAdapter } from './anthropic.ts';
import { ToolCallAccumulator } from '../tool-accumulator.ts';
import { CACHE_USAGE_FIXTURES, NO_CACHE_FIELD_FIXTURES } from '../cache-usage-fixtures.ts';
import type { StreamResult } from './adapter';

const encoder = new TextEncoder();

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

const NOOP = { onDelta: () => {} };

function chatStream(usage: Record<string, unknown>): string {
  return [
    'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
    '',
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":${JSON.stringify(usage)}}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

function responsesStream(usage: Record<string, unknown>): string {
  const completed = {
    type: 'response.completed',
    response: { output: [], usage },
  };
  return [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","item_id":"i1","output_index":0,"content_index":0,"delta":"hi"}',
    '',
    'event: response.completed',
    `data: ${JSON.stringify(completed)}`,
    '',
    '',
  ].join('\n');
}

function anthropicStream(usage: Record<string, unknown>): string {
  const { output_tokens: outputTokens, ...startUsage } = usage;
  const start = {
    type: 'message_start',
    message: { id: 'm1', type: 'message', role: 'assistant', model: 'x', content: [], usage: startUsage },
  };
  const delta = {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: outputTokens ?? 0 },
  };
  return [
    'event: message_start',
    `data: ${JSON.stringify(start)}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify(delta)}`,
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n');
}

async function runFixture(
  fixture: { envelope: string; usage: Record<string, unknown>; router?: boolean },
): Promise<StreamResult> {
  const baseUrl = fixture.router ? 'https://openrouter.ai/api/v1' : 'https://api.example.test/v1';
  if (fixture.envelope === 'chat-completions') {
    return new OpenAIAdapter(baseUrl).parseStream(
      bodyOf(chatStream(fixture.usage)), NOOP, 1_000, new ToolCallAccumulator(),
    );
  }
  if (fixture.envelope === 'responses') {
    return new OpenAIResponsesAdapter(baseUrl).parseStream(
      bodyOf(responsesStream(fixture.usage)), NOOP, 1_000, new ToolCallAccumulator(),
    );
  }
  return new AnthropicAdapter(baseUrl).parseStream(
    bodyOf(anthropicStream(fixture.usage)), NOOP, 1_000, new ToolCallAccumulator(),
  );
}

describe('streaming terminal usage — every documented provider surface', () => {
  for (const fixture of CACHE_USAGE_FIXTURES) {
    it(`carries cache counters through the stream for ${fixture.surface}`, async () => {
      const result = await runFixture(fixture);
      assert.ok(result.usage, 'terminal usage must reach StreamResult');
      assert.equal(result.usage.cache?.status, 'reported');
      assert.equal(
        result.usage.cache?.reportedBy,
        fixture.router ? 'router' : 'provider',
      );
    });
  }

  it('labels OpenRouter Chat Completions counters as router-reported end to end', async () => {
    const result = await runFixture(CACHE_USAGE_FIXTURES[2]);
    assert.equal(result.usage?.cache?.readTokens, 3_072);
    assert.equal(result.usage?.cache?.writeTokens, 512);
    assert.equal(result.usage?.cache?.reportedBy, 'router');
    assert.ok(!JSON.stringify(result.usage).includes('discount'));
  });

  it('labels OpenRouter Responses counters as router-reported end to end', async () => {
    const result = await runFixture(CACHE_USAGE_FIXTURES[3]);
    assert.equal(result.usage?.cache?.readTokens, 3_072);
    assert.equal(result.usage?.cache?.reportedBy, 'router');
  });

  it('composes the Anthropic prompt total once across message_start and message_delta', async () => {
    const result = await runFixture(CACHE_USAGE_FIXTURES[4]);
    assert.equal(result.usage?.prompt_tokens, 120 + 15_000 + 2_500);
    assert.equal(result.usage?.completion_tokens, 340);
    assert.equal(result.usage?.total_tokens, 17_960);
    assert.deepEqual(result.usage?.cache?.writeTokensByTtl, { ephemeral5m: 2_000, ephemeral1h: 500 });
  });

  it('keeps DeepSeek hit and miss counters as details of the prompt total', async () => {
    const result = await runFixture(CACHE_USAGE_FIXTURES[5]);
    assert.equal(result.usage?.prompt_tokens, 9_000);
    assert.equal(result.usage?.cache?.readTokens, 8_192);
    assert.equal(result.usage?.cache?.missTokens, 808);
  });
});

describe('streaming terminal usage — compatible servers without cache fields', () => {
  for (const fixture of NO_CACHE_FIELD_FIXTURES) {
    it(`leaves ${fixture.surface} behaving as before`, async () => {
      const result = await runFixture(fixture);
      assert.equal(result.usage?.prompt_tokens, 100);
      assert.equal(result.usage?.completion_tokens, 20);
      assert.equal(result.usage?.cache?.status, 'not-reported');
      assert.equal(result.usage?.cache?.readTokens, undefined);
      assert.equal(result.usage?.cache?.writeTokens, undefined);
    });
  }

  it('leaves usage absent when a stream reports none at all', async () => {
    const result = await new OpenAIAdapter().parseStream(
      bodyOf('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
      NOOP, 1_000, new ToolCallAccumulator(),
    );
    assert.equal(result.usage, undefined);
    assert.equal(result.content, 'hi');
  });
});

describe('streaming terminal usage — explicit zeroes survive', () => {
  it('preserves an explicit zero cached_tokens on Chat Completions', async () => {
    const result = await runFixture({
      envelope: 'chat-completions',
      usage: {
        prompt_tokens: 500, completion_tokens: 40, total_tokens: 540,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });
    assert.equal(result.usage?.cache?.status, 'reported');
    assert.equal(result.usage?.cache?.readTokens, 0);
  });

  it('preserves an explicit zero cached_tokens on Responses', async () => {
    const result = await runFixture({
      envelope: 'responses',
      usage: {
        input_tokens: 500, output_tokens: 40, total_tokens: 540,
        input_tokens_details: { cached_tokens: 0 },
      },
    });
    assert.equal(result.usage?.cache?.status, 'reported');
    assert.equal(result.usage?.cache?.readTokens, 0);
  });

  it('preserves an explicit zero output_tokens on Anthropic', async () => {
    const result = await runFixture({
      envelope: 'anthropic',
      usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0 },
    });
    assert.equal(result.usage?.completion_tokens, 0);
    assert.equal(result.usage?.cache?.readTokens, 0);
    assert.equal(result.usage?.cache?.status, 'reported');
  });
});

describe('streaming usage — unusable later restatements do not erase valid reports', () => {
  it('keeps Chat Completions usage when a later chunk carries an empty object', async () => {
    const result = await new OpenAIAdapter().parseStream(
      bodyOf([
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}',
        '',
        'data: {"choices":[],"usage":{}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
      NOOP, 1_000, new ToolCallAccumulator(),
    );
    assert.equal(result.usage?.total_tokens, 120);
    assert.equal(result.usage?.source, 'provider');
  });

  it('keeps Responses usage when a later terminal dialect carries an empty object', async () => {
    const result = await new OpenAIResponsesAdapter().parseStream(
      bodyOf([
        'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}',
        '',
        'data: {"type":"response.done","response":{"output":[],"usage":{}}}',
        '',
      ].join('\n')),
      NOOP, 1_000, new ToolCallAccumulator(),
    );
    assert.equal(result.usage?.total_tokens, 120);
    assert.equal(result.usage?.source, 'provider');
  });
});

/**
 * Anthropic-compatible servers do not all place `input_tokens` on
 * `message_start`. Current API versions restate cumulative usage on
 * `message_delta`, and a server that reports the uncached input only there
 * used to read as zero — which made the normalized prompt total exactly equal
 * the cache read. That is the shape a live MiniMax-M3 session produced, and it
 * is indistinguishable in a conversation archive from a provider that really
 * did report `input_tokens: 0`.
 */
describe('Anthropic input tokens restated on the terminal event', () => {
  function stream(startUsage: Record<string, unknown>, deltaUsage: Record<string, unknown>): string {
    const start = {
      type: 'message_start',
      message: { id: 'm1', type: 'message', role: 'assistant', model: 'x', content: [], usage: startUsage },
    };
    const delta = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: deltaUsage,
    };
    return [
      'event: message_start', `data: ${JSON.stringify(start)}`, '',
      'event: message_delta', `data: ${JSON.stringify(delta)}`, '',
      'event: message_stop', 'data: {"type":"message_stop"}', '', '',
    ].join('\n');
  }

  const run = (startUsage: Record<string, unknown>, deltaUsage: Record<string, unknown>) =>
    new AnthropicAdapter('https://api.example.test/v1').parseStream(
      bodyOf(stream(startUsage, deltaUsage)), NOOP, 1_000, new ToolCallAccumulator(),
    );

  it('uses the terminal input count when message_start omitted it', async () => {
    const result = await run(
      { cache_read_input_tokens: 6_705 },
      { output_tokens: 807, input_tokens: 1_240, cache_read_input_tokens: 6_705 },
    );
    assert.equal(result.usage?.prompt_tokens, 1_240 + 6_705);
    assert.equal(result.usage?.cache?.readTokens, 6_705);
    assert.notEqual(result.usage?.prompt_tokens, result.usage?.cache?.readTokens);
  });

  it('prefers the terminal cumulative count over the opening one', async () => {
    const result = await run(
      { input_tokens: 12, cache_read_input_tokens: 6_705 },
      { output_tokens: 807, input_tokens: 1_240 },
    );
    assert.equal(result.usage?.prompt_tokens, 1_240 + 6_705);
  });

  it('keeps the opening count when the terminal event reports zero', async () => {
    // A request always carries input, so a terminal zero means "nothing
    // further to report" and must not erase a real opening value.
    const result = await run(
      { input_tokens: 1_240, cache_read_input_tokens: 6_705 },
      { output_tokens: 807, input_tokens: 0 },
    );
    assert.equal(result.usage?.prompt_tokens, 1_240 + 6_705);
  });

  it('still reports a genuine all-cached response faithfully', async () => {
    // Neither event names any uncached input: the prompt total legitimately
    // equals the cache read, and LC does not invent a base count.
    const result = await run(
      { cache_read_input_tokens: 8_753 },
      { output_tokens: 981 },
    );
    assert.equal(result.usage?.prompt_tokens, 8_753);
    assert.equal(result.usage?.cache?.readTokens, 8_753);
  });
});

/**
 * A terminal restatement that is present but unusable must not erase a good
 * `message_start` counter. Where the erased counter was non-zero this dropped
 * those tokens out of the documented input + read + creation prompt sum
 * (cache-observability.md §2 rules 1, 2, and 4).
 */
describe('Anthropic cache counters restated unusably on the terminal event', () => {
  function stream(startUsage: Record<string, unknown>, deltaUsage: Record<string, unknown>): string {
    const start = {
      type: 'message_start',
      message: { id: 'm1', type: 'message', role: 'assistant', model: 'x', content: [], usage: startUsage },
    };
    const delta = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: deltaUsage,
    };
    return [
      'event: message_start', `data: ${JSON.stringify(start)}`, '',
      'event: message_delta', `data: ${JSON.stringify(delta)}`, '',
      'event: message_stop', 'data: {"type":"message_stop"}', '', '',
    ].join('\n');
  }

  const run = (startUsage: Record<string, unknown>, deltaUsage: Record<string, unknown>) =>
    new AnthropicAdapter('https://api.example.test/v1').parseStream(
      bodyOf(stream(startUsage, deltaUsage)), NOOP, 1_000, new ToolCallAccumulator(),
    );

  it('keeps a non-zero write counter when the terminal event nulls it', async () => {
    const result = await run(
      { input_tokens: 100, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 2_048 },
      { output_tokens: 653, cache_creation_input_tokens: null },
    );
    assert.equal(result.usage?.cache?.writeTokens, 2_048);
    assert.equal(result.usage?.prompt_tokens, 100 + 5_000 + 2_048);
    assert.equal(result.usage?.cache?.anomalies, undefined);
  });

  it('keeps a read counter when the terminal event nulls it', async () => {
    const result = await run(
      { input_tokens: 100, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 2_048 },
      { output_tokens: 653, cache_read_input_tokens: null },
    );
    assert.equal(result.usage?.cache?.readTokens, 5_000);
    assert.equal(result.usage?.prompt_tokens, 100 + 5_000 + 2_048);
  });

  it('keeps an explicit zero from the opening event', async () => {
    // The archived OpenRouter shape: opening zeroes, terminal null. The
    // explicit `0` write is a provider report and stays visible (rule 2).
    const result = await run(
      { input_tokens: 8_441, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { output_tokens: 653, cache_read_input_tokens: 0, cache_creation_input_tokens: null },
    );
    assert.equal(result.usage?.cache?.writeTokens, 0);
    assert.equal(result.usage?.cache?.readTokens, 0);
    assert.equal(result.usage?.cache?.anomalies, undefined);
  });

  it('reads a null-only counter as absent, not malformed', async () => {
    // Nothing usable ever arrived for the write counter. `null` spells "no
    // value", so the counter is absent and the turn stays clean — this is the
    // live OpenRouter shape (cache-observability.md §3.4).
    const result = await run(
      { input_tokens: 100, cache_read_input_tokens: 5_000 },
      { output_tokens: 653, cache_creation_input_tokens: null },
    );
    assert.equal(result.usage?.cache?.writeTokens, undefined);
    assert.equal(result.usage?.cache?.anomalies, undefined);
    assert.equal(result.usage?.prompt_tokens, 100 + 5_000);
  });

  it('still records the bounded code for a genuinely malformed value', async () => {
    // Not `null`: an unusable payload LC cannot read as "no value" still
    // codes under rule 1 rather than being silently dropped.
    const result = await run(
      { input_tokens: 100, cache_read_input_tokens: 5_000 },
      { output_tokens: 653, cache_creation_input_tokens: 'lots' },
    );
    assert.deepEqual(result.usage?.cache?.anomalies, ['malformed-value']);
    assert.equal(result.usage?.cache?.writeTokens, undefined);
  });

  it('still lets a usable terminal restatement win', async () => {
    const result = await run(
      { input_tokens: 100, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 64 },
      { output_tokens: 653, cache_read_input_tokens: 4_096, cache_creation_input_tokens: 0 },
    );
    assert.equal(result.usage?.cache?.readTokens, 4_096);
    assert.equal(result.usage?.cache?.writeTokens, 0);
    assert.equal(result.usage?.prompt_tokens, 100 + 4_096 + 0);
  });

  it('does not let a null TTL breakdown erase a good one', async () => {
    const result = await run(
      {
        input_tokens: 100,
        cache_creation_input_tokens: 1_000,
        cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
      },
      { output_tokens: 653, cache_creation: null },
    );
    assert.deepEqual(result.usage?.cache?.writeTokensByTtl, { ephemeral5m: 600, ephemeral1h: 400 });
    assert.equal(result.usage?.cache?.writeTokens, 1_000);
  });
});
