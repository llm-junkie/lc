/** Reproducible transport/adapter check against the local provider fixture server. */
import assert from 'node:assert/strict';
import { LLMClient } from '../src/modules/llm-client/client';
import type {
  ChatMessage,
  ToolCallWire,
  ToolDefinition,
} from '../src/modules/llm-client/types';

const fixtureRoot = (process.env.LC_AUDIT_FIXTURE_URL || 'http://127.0.0.1:4786').replace(/\/+$/, '');

const currentTimeTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'lc_get_current_time',
    description: 'Return the current time.',
    parameters: {
      type: 'object',
      properties: { tz: { type: 'string' } },
    },
  },
};

interface ProviderCase {
  name: string;
  baseUrl: string;
  model: string;
  apiVariant: 'openai' | 'anthropic';
  apiStyle: 'chat' | 'responses';
  expectedText: string;
}

const providerCases: ProviderCase[] = [
  {
    name: 'OpenAI Chat Completions',
    baseUrl: `${fixtureRoot}/openai/v1`,
    model: 'audit-openai-chat',
    apiVariant: 'openai',
    apiStyle: 'chat',
    expectedText: 'OpenAI Chat tool round completed.',
  },
  {
    name: 'Anthropic Messages',
    baseUrl: `${fixtureRoot}/anthropic/v1`,
    model: 'audit-anthropic',
    apiVariant: 'anthropic',
    apiStyle: 'chat',
    expectedText: 'Anthropic tool round completed.',
  },
  {
    name: 'OpenAI Responses',
    baseUrl: `${fixtureRoot}/responses/v1`,
    model: 'audit-responses',
    apiVariant: 'openai',
    apiStyle: 'responses',
    expectedText: 'Responses tool round completed.',
  },
];

function assistantWithCalls(calls: ToolCallWire[], outputItems?: ChatMessage['responses_output_items']): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: calls,
    responses_output_items: outputItems,
  };
}

for (const providerCase of providerCases) {
  const client = new LLMClient({
    baseUrl: providerCase.baseUrl,
    modelFetchUrl: `${providerCase.baseUrl}/models`,
    apiVariant: providerCase.apiVariant,
    apiStyle: providerCase.apiStyle,
    routing: 'direct',
  });

  const models = await client.listModels();
  assert.deepEqual(models.map((model) => model.id), [providerCase.model]);

  const userMessage: ChatMessage = { role: 'user', content: 'Use the current-time tool.' };
  const request = {
    model: providerCase.model,
    messages: [userMessage],
    stream: true,
    tools: [currentTimeTool],
    reasoningEnabled: false,
  };
  const first = await client.chatStream(request, { onDelta: () => {} });
  assert.equal(first.tool_calls?.length, 1, `${providerCase.name}: expected one tool call`);
  assert.equal(first.tool_calls?.[0]?.function.name, 'lc_get_current_time');

  const call = first.tool_calls![0];
  const second = await client.chatStream({
    ...request,
    messages: [
      userMessage,
      assistantWithCalls(first.tool_calls!, first.responses_output_items),
      {
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ time: '2026-07-30T12:00:00Z', tz: 'UTC', unix_ms: 1785412800000 }),
      },
    ],
  }, { onDelta: () => {} });

  assert.equal(second.content, providerCase.expectedText);
  assert.equal(second.tool_calls?.length ?? 0, 0);
  console.log(`PASS ${providerCase.name}: model list + tool call + result re-stream`);
}

const liveResponse = await fetch(`${fixtureRoot}/lm/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: process.env.LC_AUDIT_LM_STUDIO_MODEL || 'qwen/qwen3.6-35b-a3b',
    messages: [{ role: 'user', content: 'Reply with exactly LIVE_LM_OK and nothing else.' }],
    stream: false,
    max_tokens: 128,
    temperature: 0,
    reasoning_effort: 'none',
  }),
});
assert.equal(liveResponse.ok, true, `Live LM Studio request failed: ${liveResponse.status}`);
const liveJson = await liveResponse.json() as {
  choices?: Array<{ message?: { content?: string } }>;
};
assert.equal(liveJson.choices?.[0]?.message?.content, 'LIVE_LM_OK');
console.log('PASS live LM Studio: already-loaded model returned LIVE_LM_OK');
