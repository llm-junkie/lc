import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMessage } from '../../modules/llm-client/types';
import { DEFAULT_PARAMS, type Conversation } from '../../types.ts';
import {
  buildServerCountGenerationRequest,
  buildServerCountGenerationRequestForConversation,
} from './server-count-request.ts';

const BASE = 'https://api.meta.ai/v1';
const MODEL = 'muse-spark-1.3-contributor';
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hello' }];

function conversation(
  messages: Conversation['messages'],
  tools?: Conversation['tools'],
): Conversation {
  return {
    id: 'server-count-conversation',
    title: 'Server count',
    model: MODEL,
    params: {
      ...DEFAULT_PARAMS,
      reasoning_enabled: true,
      reasoning_effort: 'high',
      system_prompt: 'CUSTOM SENTINEL',
    },
    messages,
    createdAt: 1,
    updatedAt: 1,
    ...(tools ? { tools } : {}),
  };
}

describe('buildServerCountGenerationRequest', () => {
  it('builds the Responses generation shape without transport fields', () => {
    const req = buildServerCountGenerationRequest('openai-responses', {
      messages: MESSAGES,
      model: MODEL,
      baseUrl: BASE,
      reasoningEnabled: true,
      reasoningEffort: 'high',
    });
    assert.ok(req);
    assert.equal(req.model, MODEL);
    assert.equal(req.stream, false);
    assert.equal(req.store, false);
    assert.deepEqual(req.reasoning, { effort: 'high', summary: 'auto' });
    assert.deepEqual(req.include, ['reasoning.encrypted_content']);
  });

  it('prepends system text as a system message', () => {
    const req = buildServerCountGenerationRequest('openai-responses', {
      messages: MESSAGES,
      model: MODEL,
      baseUrl: BASE,
      systemText: 'Be brief.',
      reasoningEnabled: false,
    });
    assert.ok(req);
    assert.equal(req.instructions, 'Be brief.');
  });

  it('builds the Messages generation shape with adaptive thinking', () => {
    const req = buildServerCountGenerationRequest('anthropic-messages', {
      messages: MESSAGES,
      model: MODEL,
      baseUrl: BASE,
      reasoningEnabled: true,
      reasoningEffort: 'high',
    });
    assert.ok(req);
    assert.equal(req.model, MODEL);
    assert.deepEqual(req.thinking, { type: 'adaptive' });
    assert.deepEqual(req.output_config, { effort: 'high' });
    assert.equal(req.top_k, undefined);
    assert.equal(req.stop_sequences, undefined);
  });

  it('returns undefined for unmatched targets instead of guessing a shape', () => {
    assert.equal(buildServerCountGenerationRequest('openai-responses', {
      messages: MESSAGES,
      model: MODEL,
      baseUrl: 'https://opencode.ai/zen/v1',
      reasoningEnabled: true,
    }), undefined);
    assert.equal(buildServerCountGenerationRequest('anthropic-messages', {
      messages: MESSAGES,
      model: MODEL,
      baseUrl: 'https://foo.meta.ai/v1',
      reasoningEnabled: true,
    }), undefined);
  });
});

describe('buildServerCountGenerationRequestForConversation', () => {
  it('restores stored origin before selecting same-provider Messages state', async () => {
    const req = await buildServerCountGenerationRequestForConversation('anthropic-messages', {
      conversation: conversation([
        { id: 'u1', role: 'user', content: 'hello', createdAt: 1 },
        {
          id: 'a1',
          role: 'assistant',
          content: 'answer',
          createdAt: 2,
          meta: { baseUrl: BASE, model: MODEL },
          anthropic_output_blocks: [{ type: 'redacted_thinking', data: 'same-provider-cipher' }],
          opaque_replay_accounting: [{
            schemaVersion: 1,
            protocol: 'anthropic-messages',
            reasoningCarrier: 'redacted-thinking',
            generatedReasoningTokens: 17,
            tokenStatus: 'provider-reported',
            locator: { kind: 'anthropic-block-indexes', blockIndexes: [0] },
          }],
        },
      ]),
      baseUrl: BASE,
      apiVariant: 'anthropic',
    });
    assert.ok(req);
    assert.match(JSON.stringify(req.messages), /same-provider-cipher/);
  });

  it('does not disclose foreign Responses state to the Meta count endpoint', async () => {
    const req = await buildServerCountGenerationRequestForConversation('openai-responses', {
      conversation: conversation([
        { id: 'u1', role: 'user', content: 'hello', createdAt: 1 },
        {
          id: 'a1',
          role: 'assistant',
          content: 'safe canonical reply',
          createdAt: 2,
          meta: { baseUrl: 'https://api.openai.com/v1', model: 'foreign-model' },
          responses_output_items: [{
            id: 'rs_foreign',
            type: 'reasoning',
            encrypted_content: 'foreign-provider-cipher',
            summary: [],
          }],
        },
      ]),
      baseUrl: BASE,
      apiVariant: 'openai',
    });
    assert.ok(req);
    const wire = JSON.stringify(req.input);
    assert.doesNotMatch(wire, /foreign-provider-cipher/);
    assert.match(wire, /safe canonical reply/);
  });

  it('uses the complete Workspace system prompt rendered for generation', async () => {
    const tools = {
      enabled: true,
      file_io_enabled: true,
      shell_enabled: false,
      web_access_enabled: false,
      tool_grants: [],
      web_access_grants_initialized: true,
      tool_history_enabled: false,
      skills_enabled: false,
      enabled_skill_ids: [],
      allowed_roots: ['c:/workspace'],
      dir_permissions: {},
      shell_allowlist: '',
      max_tool_calls_per_batch: 4,
      max_tool_rounds_per_turn: 8,
      sse_read_timeout_min: 5,
    } satisfies NonNullable<Conversation['tools']>;
    const req = await buildServerCountGenerationRequestForConversation('openai-responses', {
      conversation: conversation([
        { id: 'u1', role: 'user', content: 'hello', createdAt: 1 },
      ], tools),
      baseUrl: BASE,
      apiVariant: 'openai',
    });
    assert.ok(req);
    assert.match(String(req.instructions), /\[Environment\]/);
    assert.match(String(req.instructions), /\[Custom system instructions\]\nCUSTOM SENTINEL/);
    assert.ok(Array.isArray(req.tools) && req.tools.length > 0);
  });
});
