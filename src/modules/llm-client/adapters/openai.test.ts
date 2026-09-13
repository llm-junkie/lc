/**
 * `OpenAIAdapter` — request building and streaming-delta extraction.
 *
 * These tests pin LC's behavior. Where that behavior matches a documented
 * API contract it is labelled as such; where LC deliberately targets
 * OpenAI-*compatible* servers rather than OpenAI itself, that is called out
 * so a future reader does not mistake a local convention for a spec rule.
 *
 * Verified against the OpenAI docs (July 2026):
 *   - A tool-role message takes exactly `role`, `content`, `tool_call_id`.
 *     https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
 *   - Chat Completions takes reasoning effort as the FLAT `reasoning_effort`
 *     string. The nested `reasoning: { effort }` object is Responses-API
 *     syntax. Values are model-dependent from:
 *     none | minimal | low | medium | high | xhigh | max.
 *     https://developers.openai.com/api/docs/guides/reasoning
 *   - `top_k` and `repeat_penalty` are not OpenAI parameters; LC sends them
 *     for local engines (LM Studio, llama.cpp) that do accept them, and
 *     withholds them from official OpenAI and Azure, whose schemas define
 *     neither. What either host does with an undefined field is not documented
 *     and is not asserted anywhere here.
 *
 * One exception to the above: the Gemini compatibility-endpoint cases are
 * documentation-derived only. They were written without a Google API key and
 * have never been run against the live endpoint, so they pin what the docs
 * describe rather than observed behavior. Google's page documents the flat
 * `reasoning_effort` field and its enum; it does NOT document what the
 * compatibility layer does with an unrecognized chat-completions parameter,
 * and no test here depends on that.
 * https://ai.google.dev/gemini-api/docs/openai
 *
 * Run with:
 *   npx tsx --test src/modules/llm-client/adapters/openai.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAIAdapter,
  extractDelta,
  isAlibabaModelStudioEndpoint,
  isOpenRouterEndpoint,
  isZAIEndpoint,
} from './openai.ts';
import type { AdapterRequestParams } from './adapter';
import type { ToolDefinition } from '../types';
import { ToolCallAccumulator, TOOL_CALL_ARGS_MAX_CHARS } from '../tool-accumulator.ts';

const adapter = new OpenAIAdapter();

function params(over: Partial<AdapterRequestParams> = {}): AdapterRequestParams {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    reasoningEnabled: false,
    ...over,
  };
}

describe('OpenAIAdapter — endpoint and headers', () => {
  it('targets /chat/completions', () => {
    assert.equal(adapter.streamEndpoint, '/chat/completions');
    assert.equal(adapter.protocol, 'openai');
  });

  it('sends a bearer token', () => {
    assert.deepEqual(adapter.buildHeaders('sk-test'), {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
    });
  });
});

describe('OpenAIAdapter — streaming refusals', () => {
  it('surfaces streamed refusal deltas separately from content', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"choices":[{"delta":{"refusal":"I cannot"},"finish_reason":null}]}',
          '',
          'data: {"choices":[{"delta":{"refusal":" help with that."},"finish_reason":"refusal"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n')));
        controller.close();
      },
    });
    const refusals: string[] = [];
    const result = await adapter.parseStream(
      body,
      { onDelta: () => {}, onRefusal: (text) => refusals.push(text) },
      1000,
      new ToolCallAccumulator(),
    );
    assert.equal(result.content, '');
    assert.equal(result.refusal, 'I cannot help with that.');
    assert.deepEqual(refusals, ['I cannot', ' help with that.']);
    assert.equal(result.finish_reason, 'refusal');
  });

  it('reports tool-call activity as soon as a tool delta arrives', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lc_test","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
          '',
          'data: [DONE]',
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
      new ToolCallAccumulator(),
    );
    assert.equal(toolActivity, 1);
    assert.equal(result.tool_calls?.[0]?.function.name, 'lc_test');
  });

  it('a capped sibling suppresses every call and forces the error finish', async () => {
    const encoder = new TextEncoder();
    const okCall = '{"path":"/a"}';
    const overCap = 'x'.repeat(TOOL_CALL_ARGS_MAX_CHARS + 1);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"ok_1","type":"function","function":{"name":"lc_test","arguments":${JSON.stringify(okCall)}}}]},"finish_reason":null}]}`,
          '',
          `data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"bad_1","type":"function","function":{"name":"lc_test","arguments":${JSON.stringify(overCap)}}}]},"finish_reason":"tool_calls"}]}`,
          '',
          'data: [DONE]',
          '',
        ].join('\n')));
        controller.close();
      },
    });
    const result = await adapter.parseStream(
      body,
      { onDelta: () => {} },
      1000,
      new ToolCallAccumulator(),
    );
    assert.equal(result.finish_reason, 'error');
    assert.match(result.error_message ?? '', /argument/i);
    assert.equal(result.tool_calls, undefined, 'the valid sibling must not survive a capped turn');
  });
});

describe('OpenAIAdapter — tool message sanitation', () => {
  it('strips non-standard fields from tool messages', () => {
    // API contract: a tool message takes only role, content, tool_call_id.
    // LC carries extra fields internally (tool_is_error and friends); strict
    // OpenAI-compat engines reject unknown fields, so they are dropped here.
    const req = adapter.buildRequest(params({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'tool',
          content: 'result',
          tool_call_id: 'call_1',
          tool_is_error: true,
          reasoning_content: 'leak',
        },
      ],
    }));
    assert.deepEqual(req.messages[1], {
      role: 'tool',
      content: 'result',
      tool_call_id: 'call_1',
    });
  });

  it('omits tool_call_id when absent rather than sending undefined', () => {
    const req = adapter.buildRequest(params({
      messages: [{ role: 'tool', content: 'orphan' }],
    }));
    assert.deepEqual(req.messages[0], { role: 'tool', content: 'orphan' });
    assert.ok(!('tool_call_id' in req.messages[0]));
  });

  it('leaves non-tool messages untouched', () => {
    const assistant = {
      role: 'assistant' as const,
      content: 'text',
      tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'n', arguments: '{}' } }],
      reasoning_content: 'kept',
    };
    const req = adapter.buildRequest(params({ messages: [assistant] }));
    assert.deepEqual(req.messages[0], assistant);
  });
});

describe('OpenAIAdapter — unlisted Chat fallback', () => {
  const baseUrl = 'https://relay.example/v1';

  it('omits guessed controls and provenance-free reasoning state', () => {
    const req = new OpenAIAdapter(baseUrl).buildRequest({
      model: 'future-model',
      messages: [{ role: 'assistant', content: '', reasoning_content: 'private' }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: 'max',
      topK: 40,
      repeatPenalty: 1.1,
      baseUrl,
      providerContractStatus: 'unmatched',
    });
    assert.equal(req.reasoning, undefined);
    assert.equal(req.reasoning_effort, undefined);
    assert.equal(req.top_k, undefined);
    assert.equal(req.repeat_penalty, undefined);
    assert.equal(req.messages[0].reasoning_content, undefined);
  });

  it('retains plaintext state returned by the exact same endpoint and model', () => {
    const req = new OpenAIAdapter(baseUrl).buildRequest({
      model: 'future-model',
      messages: [{
        role: 'assistant',
        content: '',
        reasoning_content: 'private',
        provider_output_origin: { baseUrl, model: 'future-model' },
      }],
      stream: true,
      reasoningEnabled: false,
      baseUrl,
      providerContractStatus: 'unmatched',
    });
    assert.equal(req.messages[0].reasoning_content, 'private');
  });
});

describe('OpenAIAdapter — sampling parameters', () => {
  it('sends only model, messages and stream by default', () => {
    const req = adapter.buildRequest(params());
    assert.deepEqual(Object.keys(req).sort(), ['messages', 'model', 'stream']);
  });

  it('passes through supplied sampling parameters', () => {
    const req = adapter.buildRequest(params({
      maxTokens: 256,
      temperature: 0.3,
      topP: 0.9,
      topK: 40,
      repeatPenalty: 1.1,
      stopSequences: ['STOP'],
      streamOptions: { include_usage: true },
    }));
    assert.equal(req.max_tokens, 256);
    assert.equal(req.temperature, 0.3);
    assert.equal(req.top_p, 0.9);
    // Not OpenAI parameters — intentional, for local OpenAI-compatible engines.
    assert.equal(req.top_k, 40);
    assert.equal(req.repeat_penalty, 1.1);
    assert.deepEqual(req.stop, ['STOP']);
    assert.deepEqual(req.stream_options, { include_usage: true });
  });

  it('uses max_completion_tokens for official OpenAI', () => {
    const req = adapter.buildRequest(params({
      baseUrl: 'https://api.openai.com/v1',
      maxTokens: 256,
    }));
    assert.equal(req.max_completion_tokens, 256);
    assert.equal(req.max_tokens, undefined);
  });

  it('keeps temperature 0 and preserves an explicit maxTokens value', () => {
    // Both fields use an explicit undefined check.
    const req = adapter.buildRequest(params({ temperature: 0, maxTokens: 0 }));
    assert.equal(req.temperature, 0);
    assert.equal(req.max_tokens, 0);
  });

  it('omits tools when none are supplied', () => {
    assert.equal(adapter.buildRequest(params()).tools, undefined);
  });

  it('passes tool definitions through unchanged', () => {
    const tools: ToolDefinition[] = [{
      type: 'function',
      function: { name: 'lc_read_file', description: 'read', parameters: { type: 'object', properties: {} } },
    }];
    assert.deepEqual(adapter.buildRequest(params({ tools })).tools, tools);
  });
});

describe('OpenAIAdapter — reasoning by provider', () => {
  it('sends no reasoning fields when reasoning is disabled', () => {
    const req = adapter.buildRequest(params({ reasoningEnabled: false, reasoningEffort: 'high' }));
    assert.equal(req.reasoning, undefined);
    assert.equal(req.reasoning_effort, undefined);
    assert.equal(req.thinking, undefined);
  });

  it('uses thinking + reasoning_effort for DeepSeek', () => {
    const req = adapter.buildRequest(params({
      baseUrl: 'https://api.deepseek.com/v1',
      reasoningEnabled: true,
      reasoningEffort: 'high',
    }));
    assert.deepEqual(req.thinking, { type: 'enabled' });
    assert.equal(req.reasoning_effort, 'high');
  });

  it('sends xhigh to DeepSeek unchanged', () => {
    // This test previously pinned `xhigh` → `max`. DeepSeek publishes its own
    // mapping (xhigh→high, max→max), so the rewrite promoted the selection
    // above what the user asked for and made the two top rungs identical.
    // https://api-docs.deepseek.com/guides/thinking_mode
    const req = adapter.buildRequest(params({
      baseUrl: 'https://api.deepseek.com/v1',
      reasoningEnabled: true,
      reasoningEffort: 'xhigh',
    }));
    assert.equal(req.reasoning_effort, 'xhigh');
  });

  it('uses adaptive thinking + reasoning_split for MiniMax', () => {
    const req = adapter.buildRequest(params({
      baseUrl: 'https://api.minimax.io/v1',
      reasoningEnabled: true,
      reasoningEffort: 'medium',
    }));
    assert.deepEqual(req.thinking, { type: 'adaptive' });
    assert.equal((req as unknown as Record<string, unknown>).reasoning_split, true);
  });

  it('detects provider case-insensitively', () => {
    const req = adapter.buildRequest(params({
      baseUrl: 'https://API.DeepSeek.COM/v1',
      reasoningEnabled: true,
      reasoningEffort: 'low',
    }));
    assert.deepEqual(req.thinking, { type: 'enabled' });
  });

  it('sends a FLAT reasoning_effort field to official OpenAI', () => {
    // The documented Chat Completions request body has no `reasoning` object —
    // reasoning effort is the flat `reasoning_effort` string, and the nested
    // form belongs to the Responses API.
    // https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
    //
    // DO NOT "FIX" THIS WITHOUT EVIDENCE. Both OpenAI paths have been
    // exercised in production against real OpenAI models with reasoning
    // enabled, including max effort, with no failure — so the extra field is
    // tolerated in practice. The same adapter also serves OpenAI-compatible
    // engines (LM Studio, OpenRouter, DeepSeek, MiniMax), some of which take
    // the nested form. Aligning to the flat field is a provider-compatibility
    // change that risks a working path to satisfy a spec reading.
    //
    // Note the internal inconsistency this pins: effort 'none' takes the flat
    // `reasoning_effort` (see the test below), every other effort takes the
    // nested object.
    const req = adapter.buildRequest(params({
      baseUrl: 'https://api.openai.com/v1',
      reasoningEnabled: true,
      reasoningEffort: 'high',
    }));
    assert.equal(req.reasoning_effort, 'high');
    assert.equal(req.reasoning, undefined);
  });

  it('passes max through to official OpenAI', () => {
    const req = adapter.buildRequest(params({
      baseUrl: 'https://api.openai.com/v1',
      reasoningEnabled: true,
      reasoningEffort: 'max',
    }));
    assert.equal(req.reasoning_effort, 'max');
  });

  it('sends a FLAT reasoning_effort field to Meta AI', () => {
    // Meta Model API's Chat Completions is strictly OpenAI-compatible: it
    // takes the flat `reasoning_effort` string and rejects the nested
    // `reasoning` object with 400 (`param: "reasoning"`).
    // https://dev.meta.ai/docs/protocols/chat-completions#parameters
    const req = adapter.buildRequest(params({
      baseUrl: 'https://api.meta.ai/v1',
      reasoningEnabled: true,
      reasoningEffort: 'high',
    }));
    assert.equal(req.reasoning_effort, 'high');
    assert.equal(req.reasoning, undefined);
  });

  it('passes max through to Meta AI verbatim', () => {
    // No client-side folding of `max`: Meta's ladder may grow, and an
    // unsupported level is the provider's own 400 to surface, not LC's to
    // guess around. The user picks a level the model accepts.
    // https://dev.meta.ai/docs/protocols/chat-completions#parameters
    const req = adapter.buildRequest(params({
      baseUrl: 'https://api.meta.ai/v1',
      reasoningEnabled: true,
      reasoningEffort: 'max',
    }));
    assert.equal(req.reasoning_effort, 'max');
    assert.equal(req.reasoning, undefined);
  });

  it('omits reasoning_effort at "none" for Meta AI, which cannot disable reasoning', () => {
    // Muse Spark always reasons; `reasoning_effort: "none"` returns HTTP 400.
    // https://dev.meta.ai/docs/reasoning
    const req = adapter.buildRequest(params({
      baseUrl: 'https://api.meta.ai/v1',
      reasoningEnabled: true,
      reasoningEffort: 'none',
    }));
    assert.equal(req.reasoning_effort, undefined);
    assert.equal(req.reasoning, undefined);
    assert.equal(req.thinking, undefined);
  });

  it('sends a FLAT reasoning_effort field to the Gemini compatibility endpoint', () => {
    // Written from Google's documentation, NOT verified against a live
    // endpoint — no API key was available. Google documents the flat field;
    // what the layer does with the nested object is not documented for chat
    // completions and is not asserted here.
    // https://ai.google.dev/gemini-api/docs/openai
    const req = adapter.buildRequest(params({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      reasoningEnabled: true,
      reasoningEffort: 'medium',
    }));
    assert.equal(req.reasoning_effort, 'medium');
    assert.equal(req.reasoning, undefined);
  });

  it('folds xhigh and max down to high for Gemini, whose ladder stops there', () => {
    // Unlike the Meta branch, which sends unsupported levels verbatim: Gemini's
    // documented enum is minimal|low|medium|high (plus none), so `high` is a
    // value the page defines and `xhigh`/`max` are not. Folding sends something
    // documented. What Gemini would do with an out-of-enum value is not
    // documented for chat completions and is deliberately not assumed.
    for (const effort of ['xhigh', 'max']) {
      const req = adapter.buildRequest(params({
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        reasoningEnabled: true,
        reasoningEffort: effort,
      }));
      assert.equal(req.reasoning_effort, 'high', effort);
      assert.equal(req.reasoning, undefined, effort);
    }
  });

  it('uses the FLAT reasoning_effort at "none" for Gemini', () => {
    // Reached through the shared default branch, which already emits the flat
    // field Google documents for `none` on 2.5 models.
    const req = adapter.buildRequest(params({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      reasoningEnabled: true,
      reasoningEffort: 'none',
    }));
    assert.equal(req.reasoning_effort, 'none');
    assert.equal(req.reasoning, undefined);
  });

  it('does not treat the native Gemini API as the compatibility endpoint', () => {
    // Same host, different API. `generateContent` is not OpenAI-compatible and
    // never reaches this adapter; only the `/openai` path segment opts in.
    const req = adapter.buildRequest(params({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      reasoningEnabled: true,
      reasoningEffort: 'high',
    }));
    assert.equal(req.reasoning_effort, undefined);
    assert.deepEqual(req.reasoning, { effort: 'high' });
  });

  it('uses Z.AI Chat fields instead of the nested Responses shape', () => {
    const enabled = adapter.buildRequest(params({
      baseUrl: 'https://api.z.ai/api/paas/v4',
      model: 'glm-5.2',
      reasoningEnabled: true,
      reasoningEffort: 'high',
    }));
    assert.deepEqual(enabled.thinking, { type: 'enabled' });
    assert.equal(enabled.reasoning_effort, 'high');
    assert.equal(enabled.reasoning, undefined);

    const disabled = adapter.buildRequest(params({
      baseUrl: 'https://api.z.ai/api/paas/v4',
      reasoningEnabled: true,
      reasoningEffort: 'none',
    }));
    assert.deepEqual(disabled.thinking, { type: 'disabled' });
    assert.equal(disabled.reasoning, undefined);
  });

  it('keeps Z.AI reasoning_effort off models whose contract does not support it', () => {
    for (const model of ['glm-5.1', 'glm-5-turbo', 'glm-4.7']) {
      const req = adapter.buildRequest(params({
        baseUrl: 'https://api.z.ai/api/paas/v4',
        model,
        reasoningEnabled: true,
        reasoningEffort: 'xhigh',
      }));
      assert.deepEqual(req.thinking, { type: 'enabled' }, model);
      assert.equal(req.reasoning_effort, undefined, model);
      assert.equal(req.reasoning, undefined, model);
    }
  });

  it('uses Alibaba Model Studio Chat fields for every documented toggle family', () => {
    const baseUrl = 'https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
    for (const model of [
      'qwen3.7-plus',
      'qwen3.6-flash',
      'qwen3.5-plus',
      'qwen3-plus',
      'qwen3-omni-flash',
      'qwen3-vl-plus',
      'deepseek-v3.1',
      'deepseek-v3.2',
      'deepseek-v3.2-exp',
      'kimi-k2.5',
      'kimi-k2.6',
      'kimi-k2.7-code',
      'kimi/kimi-k2.7-code-highspeed',
    ]) {
      const req = adapter.buildRequest(params({
        baseUrl, model, reasoningEnabled: true, reasoningEffort: 'medium',
      }));
      assert.equal(req.enable_thinking, true, model);
      assert.equal(req.reasoning_effort, undefined, model);
      assert.equal(req.reasoning, undefined, model);
    }

    for (const model of ['glm-5.2', 'deepseek-v4-pro', 'deepseek-v4-flash']) {
      for (const [effort, expected] of [
        ['low', 'high'],
        ['medium', 'high'],
        ['high', 'high'],
        ['xhigh', 'max'],
        ['max', 'max'],
      ] as const) {
        const req = adapter.buildRequest(params({
          baseUrl, model, reasoningEnabled: true, reasoningEffort: effort,
        }));
        assert.equal(req.enable_thinking, true, `${model}/${effort}`);
        assert.equal(req.reasoning_effort, expected, `${model}/${effort}`);
        assert.equal(req.reasoning, undefined, `${model}/${effort}`);
      }
    }

    const minimax = adapter.buildRequest(params({
      baseUrl, model: 'MiniMax-M3', reasoningEnabled: true, reasoningEffort: 'high',
    }));
    assert.deepEqual(minimax.thinking, { type: 'adaptive' });
    assert.equal(minimax.reasoning, undefined);

    const off = adapter.buildRequest(params({
      baseUrl, model: 'kimi-k2.6', reasoningEnabled: true, reasoningEffort: 'none',
    }));
    assert.equal(off.enable_thinking, false);
  });

  it('does not invent a reasoning dialect for unsupported Alibaba models', () => {
    const baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    for (const model of ['deepseek-r1', 'qwen2.5-max', 'third-party-model']) {
      for (const effort of ['high', 'none']) {
        const req = adapter.buildRequest(params({
          baseUrl, model, reasoningEnabled: true, reasoningEffort: effort,
        }));
        assert.equal(req.enable_thinking, undefined, `${model}/${effort}`);
        assert.equal(req.thinking, undefined, `${model}/${effort}`);
        assert.equal(req.reasoning_effort, undefined, `${model}/${effort}`);
        assert.equal(req.reasoning, undefined, `${model}/${effort}`);
      }
    }
  });

  it('keeps the nested compatibility mapping for local servers', () => {
    const req = adapter.buildRequest(params({
      baseUrl: 'http://localhost:1234/v1',
      reasoningEnabled: true,
      reasoningEffort: 'max',
    }));
    assert.deepEqual(req.reasoning, { effort: 'xhigh' });
  });

  it('uses the FLAT reasoning_effort for effort "none" on the default path', () => {
    // Note the inconsistency with the branch above: 'none' takes the flat
    // field, every other effort takes the nested object.
    const req = adapter.buildRequest(params({
      reasoningEnabled: true,
      reasoningEffort: 'none',
    }));
    assert.equal(req.reasoning_effort, 'none');
    assert.equal(req.reasoning, undefined);
  });

  it('disables thinking for DeepSeek and MiniMax at effort "none"', () => {
    for (const baseUrl of ['https://api.deepseek.com/v1', 'https://api.minimax.io/v1']) {
      const req = adapter.buildRequest(params({ baseUrl, reasoningEnabled: true, reasoningEffort: 'none' }));
      assert.deepEqual(req.thinking, { type: 'disabled' }, baseUrl);
    }
  });
});

describe('OpenAIAdapter — MiniMax structured reasoning', () => {
  it('replays reasoning_details unchanged only to a MiniMax endpoint', () => {
    const message = {
      role: 'assistant' as const,
      content: '',
      reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'complete thought' }],
      tool_calls: [{
        id: 'call_1', type: 'function' as const,
        function: { name: 'lc_read_file', arguments: '{}' },
      }],
    };
    const mini = new OpenAIAdapter('https://api.minimax.io/v1').buildRequest(params({
      baseUrl: 'https://api.minimax.io/v1', messages: [message],
    }));
    assert.deepEqual(mini.messages[0].reasoning_details, message.reasoning_details);

    const openai = adapter.buildRequest(params({
      baseUrl: 'https://api.openai.com/v1', messages: [message],
    }));
    assert.equal(openai.messages[0].reasoning_details, undefined);
  });

  it('deduplicates cumulative content and reasoning_details in the documented stream', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      { choices: [{ delta: { content: 'Hel', reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'rea' }] }, finish_reason: null }] },
      { choices: [{ delta: { content: 'Hello', reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'reason' }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')));
        controller.close();
      },
    });
    const visible: string[] = [];
    const reasoning: string[] = [];
    const result = await new OpenAIAdapter('https://api.minimax.io/v1').parseStream(
      body,
      { onDelta: (text) => visible.push(text), onReasoning: (text) => reasoning.push(text) },
      1000,
      new ToolCallAccumulator(),
    );
    assert.deepEqual(visible, ['Hel', 'lo']);
    assert.deepEqual(reasoning, ['rea', 'son']);
    assert.equal(result.content, 'Hello');
    assert.deepEqual(result.reasoning_details, [
      { type: 'reasoning.text', index: 0, text: 'reason' },
    ]);
  });
});

describe('extractDelta — streaming delta normalization', () => {
  it('returns empty strings for an empty delta', () => {
    assert.deepEqual(extractDelta({}), { content: '', reasoning: '' });
  });

  it('extracts plain string content', () => {
    assert.deepEqual(extractDelta({ content: 'hello' }), { content: 'hello', reasoning: '' });
  });

  it('concatenates text parts from array content', () => {
    const d = extractDelta({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] as never });
    assert.equal(d.content, 'ab');
  });

  it('ignores non-text parts in array content', () => {
    const d = extractDelta({ content: [{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }] as never });
    assert.equal(d.content, 'a');
  });

  it('treats null content as empty', () => {
    assert.equal(extractDelta({ content: null } as never).content, '');
  });

  it('reads reasoning_content (DeepSeek style)', () => {
    assert.equal(extractDelta({ reasoning_content: 'thinking' } as never).reasoning, 'thinking');
  });

  it('falls back to reasoning when reasoning_content is absent', () => {
    assert.equal(extractDelta({ reasoning: 'thinking' } as never).reasoning, 'thinking');
  });

  it('prefers reasoning_content over reasoning', () => {
    const d = extractDelta({ reasoning_content: 'primary', reasoning: 'secondary' } as never);
    assert.equal(d.reasoning, 'primary');
  });

  it('joins MiniMax reasoning_details entries', () => {
    const d = extractDelta({ reasoning_details: [{ text: 'one' }, { text: 'two' }] } as never);
    assert.equal(d.reasoning, 'onetwo');
  });

  it('does not let reasoning_details overwrite a standard reasoning field', () => {
    const d = extractDelta({ reasoning: 'standard', reasoning_details: [{ text: 'other' }] } as never);
    assert.equal(d.reasoning, 'standard');
  });

  it('survives malformed reasoning_details entries', () => {
    const d = extractDelta({ reasoning_details: [null, { notText: 1 }, { text: 'ok' }] } as never);
    assert.equal(d.reasoning, 'ok');
  });

  it('extracts content and reasoning together', () => {
    const d = extractDelta({ content: 'answer', reasoning_content: 'why' } as never);
    assert.deepEqual(d, { content: 'answer', reasoning: 'why' });
  });
});

/**
 * The two directions of "one adapter, many servers".
 *
 * `top_k` and `repeat_penalty` are compatible-server extensions that neither
 * OpenAI's nor Azure's request schema defines, so the same predicate that
 * chooses `max_completion_tokens` withholds them there rather than sending
 * them as though they were supported parameters. What either host does with an
 * undefined field is not documented and is deliberately not asserted — these
 * tests prove only what LC emits. And DeepSeek
 * publishes its own effort mapping — low→low, medium→high, high→high,
 * xhigh→high, max→max — so LC forwards the user's rung rather than rewriting
 * it. https://api-docs.deepseek.com/guides/thinking_mode
 */
describe('OpenAIAdapter — first-party vs compatible request shape', () => {
  it('withholds top_k and repeat_penalty from official OpenAI', () => {
    for (const baseUrl of ['https://api.openai.com/v1', 'https://acme.openai.azure.com/openai/v1']) {
      const req = adapter.buildRequest(params({ baseUrl, topK: 40, repeatPenalty: 1.1 }));
      assert.equal(req.top_k, undefined, `${baseUrl} defines no top_k parameter`);
      assert.equal(req.repeat_penalty, undefined, baseUrl);
    }
  });

  it('still sends both to every compatible server', () => {
    const req = adapter.buildRequest(params({
      baseUrl: 'http://127.0.0.1:1234/v1', topK: 40, repeatPenalty: 1.1,
    }));
    assert.equal(req.top_k, 40);
    assert.equal(req.repeat_penalty, 1.1);
  });

  it('forwards every effort rung to DeepSeek unchanged', () => {
    const deepseek = 'https://api.deepseek.com/v1';
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const req = adapter.buildRequest(params({
        baseUrl: deepseek, reasoningEnabled: true, reasoningEffort: effort,
      }));
      assert.equal(req.reasoning_effort, effort, `${effort} is an accepted DeepSeek request value`);
      assert.deepEqual(req.thinking, { type: 'enabled' });
    }
  });

  it('keeps xhigh and max distinct on DeepSeek', () => {
    const deepseek = 'https://api.deepseek.com/v1';
    const xhigh = adapter.buildRequest(params({
      baseUrl: deepseek, reasoningEnabled: true, reasoningEffort: 'xhigh',
    }));
    const max = adapter.buildRequest(params({
      baseUrl: deepseek, reasoningEnabled: true, reasoningEffort: 'max',
    }));
    assert.notEqual(xhigh.reasoning_effort, max.reasoning_effort);
  });
});

/**
 * OpenRouter spells the repetition control `repetition_penalty`; its schema has
 * no `repeat_penalty`. llama.cpp, LM Studio, and vLLM document the opposite.
 * Sending the local spelling to OpenRouter put an undefined field on the wire
 * and expressed the user's selection nowhere.
 * https://openrouter.ai/docs/api-reference/parameters
 */
describe('OpenAIAdapter — OpenRouter repetition control', () => {
  const openRouter = 'https://openrouter.ai/api/v1';

  it('sends repetition_penalty, never repeat_penalty, to OpenRouter', () => {
    const req = adapter.buildRequest(params({ baseUrl: openRouter, repeatPenalty: 1.1, topK: 40 }));
    assert.equal(req.repetition_penalty, 1.1);
    assert.equal(req.repeat_penalty, undefined, 'OpenRouter defines no repeat_penalty');
    assert.equal(req.top_k, 40, 'top_k is spelled the same on both');
  });

  it('keeps repeat_penalty for the local servers that document it', () => {
    const req = adapter.buildRequest(params({ baseUrl: 'http://127.0.0.1:1234/v1', repeatPenalty: 1.1 }));
    assert.equal(req.repeat_penalty, 1.1);
    assert.equal(req.repetition_penalty, undefined);
  });

  it('sends neither when the toggle is off', () => {
    const req = adapter.buildRequest(params({ baseUrl: openRouter }));
    assert.equal(req.repetition_penalty, undefined);
    assert.equal(req.repeat_penalty, undefined);
  });
});

/**
 * `isOpenRouterEndpoint()` changes what goes on the wire — it decides between
 * two mutually exclusive spellings of the repetition control — so invariant 10
 * applies: classify the parsed hostname, and prove it with inputs chosen to
 * break it rather than a list of plausible URLs.
 *
 * The same discipline was applied to `isAnthropicOwnApi()` after a substring
 * test there let lookalike hosts receive Anthropic-only fields. A new predicate
 * of the same class does not get to skip it.
 */
describe('isOpenRouterEndpoint — hostname, not substring', () => {
  it('accepts the real host and its subdomains, case-insensitively', () => {
    for (const url of [
      'https://openrouter.ai/api/v1',
      'https://OpenRouter.AI/api/v1',
      'https://gateway.openrouter.ai/api/v1',
    ]) {
      assert.equal(isOpenRouterEndpoint(url), true, url);
    }
  });

  it('rejects hosts and paths that merely contain the name', () => {
    for (const url of [
      'https://openrouter.ai.evil.test/api/v1',
      'https://not-openrouter.ai.co/api/v1',
      'https://proxy.test/openrouter.ai/api/v1',
      'https://openrouter.ai.example.net/openrouter.ai/v1',
    ]) {
      assert.equal(isOpenRouterEndpoint(url), false, `${url} is not OpenRouter`);
    }
  });

  it('rejects absent and unparseable values instead of throwing', () => {
    assert.equal(isOpenRouterEndpoint(undefined), false);
    assert.equal(isOpenRouterEndpoint(''), false);
    assert.equal(isOpenRouterEndpoint('openrouter.ai/api/v1'), false);
  });

  it('keeps the OpenRouter spelling off a lookalike host', () => {
    // The consequence, not just the predicate: a lookalike must still get the
    // local spelling, or the user's selection is lost on a server that
    // documents `repeat_penalty`.
    const req = adapter.buildRequest(params({
      baseUrl: 'https://openrouter.ai.evil.test/api/v1',
      repeatPenalty: 1.1,
    }));
    assert.equal(req.repetition_penalty, undefined);
    assert.equal(req.repeat_penalty, 1.1);
  });

  it('still sends the OpenRouter spelling to a mixed-case real host', () => {
    const req = adapter.buildRequest(params({
      baseUrl: 'https://OpenRouter.AI/api/v1',
      repeatPenalty: 1.1,
    }));
    assert.equal(req.repetition_penalty, 1.1);
    assert.equal(req.repeat_penalty, undefined);
  });
});

describe('Z.AI and Alibaba endpoint predicates — hostname, not substring', () => {
  it('accepts the documented first-party hosts', () => {
    assert.equal(isZAIEndpoint('https://api.z.ai/api/paas/v4'), true);
    for (const url of [
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
      'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
      'https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      'https://workspace.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
    ]) {
      assert.equal(isAlibabaModelStudioEndpoint(url), true, url);
    }
  });

  it('rejects lookalike hosts and provider names in paths', () => {
    for (const url of [
      'https://api.z.ai.evil.test/api/paas/v4',
      'https://not-api.z.ai.co/v1',
      'https://proxy.example.com/api.z.ai/v1',
    ]) {
      assert.equal(isZAIEndpoint(url), false, url);
    }
    for (const url of [
      'https://dashscope.aliyuncs.com.evil.test/v1',
      'https://evil-dashscope.aliyuncs.com/v1',
      'https://workspace.maas.aliyuncs.com/v1',
      'https://proxy.example.com/dashscope/compatible-mode/v1',
    ]) {
      assert.equal(isAlibabaModelStudioEndpoint(url), false, url);
    }
  });

  it('keeps provider-only reasoning fields off lookalike endpoints', () => {
    const zai = adapter.buildRequest(params({
      baseUrl: 'https://api.z.ai.evil.test/api/paas/v4',
      model: 'glm-5.2',
      reasoningEnabled: true,
      reasoningEffort: 'high',
    }));
    assert.equal(zai.thinking, undefined);
    assert.deepEqual(zai.reasoning, { effort: 'high' });

    const alibaba = adapter.buildRequest(params({
      baseUrl: 'https://proxy.example.com/dashscope/compatible-mode/v1',
      model: 'kimi-k2.6',
      reasoningEnabled: true,
      reasoningEffort: 'high',
    }));
    assert.equal(alibaba.enable_thinking, undefined);
    assert.deepEqual(alibaba.reasoning, { effort: 'high' });
  });
});
