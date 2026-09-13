import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import * as reactModule from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_PARAMS, type Conversation } from '../../types.ts';
import { countTokens, countToolDefinitionTokens } from '../../utils/tokens.ts';
import {
  resolveWorkspaceProviderPresentation,
  structuredToolPayload,
} from '../../modules/chat-pipeline/provider-capability.ts';
import { countSystemPromptTokens } from '../../modules/chat-pipeline/system-prompt.ts';
import {
  applyServerTokenCount,
  computeTokenBreakdown,
  createTokenCountMemo,
  TokenMeter,
  tokenMeterReasoningLabel,
} from './TokenMeter.tsx';
import { buildTodoSnapshotIndex, formatTodoRequestProjection } from '../../modules/tool-engine/todo-state.ts';
import { resolveBundledProviderContract } from '../../modules/llm-client/provider-contracts.ts';
import {
  META_CHAT_FIRST_PARTY_TURN_USAGE,
} from '../../modules/llm-client/meta-chat-first-party-fixtures.ts';
import {
  META_MESSAGES_FIRST_PARTY_BLOCK_COUNTS,
  META_MESSAGES_FIRST_PARTY_GROUP_TOKENS,
  META_MESSAGES_FIRST_PARTY_TURN_USAGE,
  metaRedactedPlaceholder,
} from '../../modules/llm-client/meta-messages-first-party-fixtures.ts';
import {
  META_RESPONSES_1949_TURN_USAGE,
  metaEncryptedPlaceholder,
} from '../../modules/llm-client/meta-responses-first-party-fixtures.ts';

const originalReactDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'React');
Object.defineProperty(globalThis, 'React', { configurable: true, value: reactModule });
const { createElement } = reactModule;

after(() => {
  if (originalReactDescriptor) Object.defineProperty(globalThis, 'React', originalReactDescriptor);
  else delete (globalThis as Record<string, unknown>).React;
});

const tools = {
  enabled: true,
  file_io_enabled: true,
  shell_enabled: false,
  web_access_enabled: false,
  tool_history_enabled: true,
  skills_enabled: false,
  tool_grants: [],
  web_access_grants_initialized: true,
  allowed_roots: ['C:\\workspace'],
  dir_permissions: {},
  max_tool_rounds_per_turn: 32,
  max_tool_calls_per_batch: 16,
  sse_read_timeout_min: 5,
} satisfies NonNullable<Conversation['tools']>;

const conv: Conversation = {
  id: 'token-test',
  title: 'Token test',
  params: { ...DEFAULT_PARAMS, system_prompt: 'custom accounting instructions' },
  tools,
  createdAt: 1,
  updatedAt: 1,
  messages: [
    { id: 'u1', role: 'user', content: 'read it', createdAt: 1 },
    {
      id: 'a1', role: 'assistant', content: '', createdAt: 2,
      tool_calls: [{ id: 'call-1', name: 'lc_read_file', arguments: '{}', created_at: 2 }],
    },
    {
      id: 't1', role: 'tool', content: 'large result '.repeat(400), createdAt: 3,
      tool_call_id: 'call-1', tool_is_error: false, tool_duration_ms: 1,
    },
  ],
};

describe('provider-aware token accounting', () => {
  it('counts Workspace policy and archives Tool History for compatible profiles', () => {
    const capability = resolveWorkspaceProviderPresentation(conv.tools, 'openai');
    const system = countSystemPromptTokens(conv, capability.workspacePromptEnabled);
    const toolDefinitions = countToolDefinitionTokens(structuredToolPayload(conv.tools, 'openai'));
    const live = computeTokenBreakdown(
      conv,
      32_768,
      system,
      capability.toolCallingSupported,
      false,
      toolDefinitions,
    );
    const raw = computeTokenBreakdown(conv, 32_768, system, false, false, toolDefinitions);
    const withoutToolDefinitions = computeTokenBreakdown(
      conv,
      32_768,
      system,
      capability.toolCallingSupported,
      false,
      0,
    );

    assert.equal(capability.workspacePromptEnabled, true);
    assert.ok(system > countTokens(conv.params.system_prompt));
    assert.ok(toolDefinitions > 0);
    assert.equal(live.toolDefinitions, toolDefinitions);
    assert.equal(live.totalUsed, withoutToolDefinitions.totalUsed + toolDefinitions);
    assert.ok(live.totalUsed < raw.totalUsed);
  });

  it('counts custom-only system content and no history archiving for native LM Studio', () => {
    const capability = resolveWorkspaceProviderPresentation(conv.tools, 'lm-studio');
    const system = countSystemPromptTokens(conv, capability.workspacePromptEnabled);
    const toolDefinitions = countToolDefinitionTokens(structuredToolPayload(conv.tools, 'lm-studio'));
    const live = computeTokenBreakdown(
      conv,
      32_768,
      system,
      capability.toolCallingSupported,
      false,
      toolDefinitions,
    );
    const expected = computeTokenBreakdown(
      conv,
      32_768,
      countTokens('custom accounting instructions'),
      false,
      false,
      0,
    );

    assert.equal(capability.workspacePromptEnabled, false);
    assert.equal(system, countTokens('custom accounting instructions'));
    assert.equal(toolDefinitions, 0);
    assert.deepEqual(live, expected);
  });

  it('does not recount unarchived tool output while the tooltip is closed', () => {
    let toolContentReads = 0;
    const archivedTool = {
      id: 't-guarded',
      role: 'tool',
      createdAt: 3,
      tool_call_id: 'call-guarded',
      tool_is_error: false,
      tool_duration_ms: 1,
    } as Conversation['messages'][number];
    Object.defineProperty(archivedTool, 'content', {
      enumerable: true,
      get() {
        toolContentReads++;
        throw new Error('closed TokenMeter tooltip read archived tool content');
      },
    });

    const guardedConv = {
      ...conv,
      id: 'token-render-guard',
      messages: [
        { id: 'u-guarded', role: 'user', content: 'read it', createdAt: 1 },
        {
          id: 'a-guarded',
          role: 'assistant',
          content: '',
          createdAt: 2,
          tool_calls: [{
            id: 'call-guarded',
            name: 'lc_read_file',
            arguments: '{}',
            created_at: 2,
          }],
        },
        archivedTool,
      ],
    } as Conversation;

    assert.doesNotThrow(() => renderToStaticMarkup(createElement(TokenMeter, {
      conv: guardedConv,
      maxContext: 32_768,
      style: 'donut',
      systemPromptTokens: 0,
      toolDefinitionTokens: 0,
      toolCallingSupported: true,
    })));
    assert.equal(toolContentReads, 0);
  });

  it('reuses settled message counts and invalidates only a replaced message', () => {
    let countCalls = 0;
    const memo = createTokenCountMemo((text) => {
      countCalls++;
      return countTokens(text);
    });
    const memoConv = {
      ...conv,
      messages: [
        ...conv.messages,
        {
          id: 'a-memoized',
          role: 'assistant',
          content: 'draft reply',
          reasoning: 'stable reasoning '.repeat(100),
          createdAt: 4,
        },
      ],
    } as Conversation;
    const expected = computeTokenBreakdown(memoConv, 32_768, 0, false, false, 0);
    const first = computeTokenBreakdown(memoConv, 32_768, 0, false, false, 0, memo);
    const callsAfterFirst = countCalls;
    const second = computeTokenBreakdown(memoConv, 32_768, 0, false, false, 0, memo);

    assert.deepEqual(first, expected);
    assert.deepEqual(second, expected);
    assert.ok(callsAfterFirst > 0);
    assert.equal(countCalls, callsAfterFirst);

    const changed = {
      ...memoConv,
      messages: memoConv.messages.map((message) => message.id === 'a-memoized'
        ? { ...message, content: `${message.content} changed` }
        : message),
    } as Conversation;
    const changedExpected = computeTokenBreakdown(changed, 32_768, 0, false, false, 0);
    const changedActual = computeTokenBreakdown(changed, 32_768, 0, false, false, 0, memo);

    assert.deepEqual(changedActual, changedExpected);
    assert.equal(countCalls, callsAfterFirst + 1);
  });

  it('bounds append-only live reasoning work and reconciles exactly when idle', () => {
    const countInputs: number[] = [];
    const memo = createTokenCountMemo((text) => {
      countInputs.push(text.length);
      return text.length;
    });
    const streamingConv = {
      ...conv,
      tools: { ...tools, enabled: false, tool_history_enabled: false },
      messages: [
        { id: 'u-live', role: 'user', content: 'go', createdAt: 1 },
        { id: 'a-live', role: 'assistant', content: '', reasoning: '', createdAt: 2 },
      ],
    } as Conversation;

    computeTokenBreakdown(streamingConv, 200_000, 0, false, true, 0, memo);
    const firstText = 'a'.repeat(20_000);
    const first = computeTokenBreakdown({
      ...streamingConv,
      messages: streamingConv.messages.map((message) => message.id === 'a-live'
        ? { ...message, reasoning: firstText }
        : message),
    }, 200_000, 0, false, true, 0, memo);
    const finalText = `${firstText}${'b'.repeat(80_000)}`;
    const live = computeTokenBreakdown({
      ...streamingConv,
      messages: streamingConv.messages.map((message) => message.id === 'a-live'
        ? { ...message, reasoning: finalText }
        : message),
    }, 200_000, 0, false, true, 0, memo);

    assert.equal(first.reasoning, firstText.length);
    assert.equal(live.reasoning, finalText.length);
    assert.ok(Math.max(...countInputs) <= 10_240, 'live counter inputs must stay bounded');

    const beforeIdle = countInputs.length;
    const idle = computeTokenBreakdown({
      ...streamingConv,
      messages: streamingConv.messages.map((message) => message.id === 'a-live'
        ? { ...message, reasoning: finalText }
        : message),
    }, 200_000, 0, false, false, 0, memo);
    assert.equal(idle.reasoning, finalText.length);
    assert.ok(countInputs.slice(beforeIdle).includes(finalText.length), 'idle transition must perform one exact recount');
  });

  it('counts stored assistant text independently of provider completion usage', () => {
    const assistant = {
      id: 'a-provider-independent',
      role: 'assistant',
      content: 'visible answer kept in the assistant bubble',
      reasoning: 'persisted reasoning '.repeat(40),
      refusal: 'provider refusal text',
      createdAt: 2,
    } as Conversation['messages'][number];
    const withoutUsage = {
      ...conv,
      id: 'provider-independent-without-usage',
      tools: { ...tools, enabled: false, tool_history_enabled: false },
      messages: [
        { id: 'u-provider-independent', role: 'user', content: 'answer', createdAt: 1 },
        assistant,
      ],
    } as Conversation;
    const withUsage = {
      ...withoutUsage,
      id: 'provider-independent-with-usage',
      messages: [
        withoutUsage.messages[0],
        {
          ...assistant,
          usage: {
            prompt_tokens: 99_000,
            completion_tokens: 7,
            total_tokens: 99_007,
            source: 'provider' as const,
          },
        },
      ],
    } as Conversation;

    const estimated = computeTokenBreakdown(withoutUsage, 200_000, 0, false, false, 0);
    const reported = computeTokenBreakdown(withUsage, 200_000, 0, false, false, 0);

    assert.deepEqual(reported, estimated);
    assert.equal(estimated.reasoning, countTokens(assistant.reasoning ?? ''));
    assert.equal(
      estimated.replies,
      countTokens(assistant.content) + countTokens(assistant.refusal ?? ''),
    );
  });

  it('counts live visible reply and reasoning fields at the same time', () => {
    const memo = createTokenCountMemo((text) => text.length);
    const liveConversation = {
      ...conv,
      id: 'simultaneous-live-fields',
      tools: { ...tools, enabled: false, tool_history_enabled: false },
      messages: [
        { id: 'u-simultaneous', role: 'user', content: 'go', createdAt: 1 },
        {
          id: 'a-simultaneous',
          role: 'assistant',
          content: 'visible stream',
          reasoning: 'reasoning stream',
          createdAt: 2,
        },
      ],
    } as Conversation;

    const result = computeTokenBreakdown(
      liveConversation,
      200_000,
      0,
      false,
      true,
      0,
      memo,
    );

    assert.equal(result.replies, 'visible stream'.length);
    assert.equal(result.reasoning, 'reasoning stream'.length);
  });
});

describe('TokenMeter conversation-context projection', () => {
  it('indexes archived tool-result owners in one forward pass', () => {
    const count = 1_500;
    let idReads = 0;
    const assistants: Conversation['messages'] = [];
    const results: Conversation['messages'] = [];

    for (let index = 0; index < count; index += 1) {
      const callId = `delayed-call-${index}`;
      const call = {
        name: 'lc_read_file',
        arguments: '{}',
      } as NonNullable<Conversation['messages'][number]['tool_calls']>[number];
      Object.defineProperty(call, 'id', {
        enumerable: true,
        get() {
          idReads += 1;
          return callId;
        },
      });
      assistants.push({
        id: `assistant-${index}`,
        role: 'assistant',
        content: '',
        createdAt: index,
        tool_calls: [call],
      });
      results.push({
        id: `result-${index}`,
        role: 'tool',
        content: 'archived result',
        createdAt: count + index,
        tool_call_id: callId,
      });
    }

    const delayedConversation = {
      ...conv,
      id: 'delayed-tool-results',
      messages: [...assistants, ...results],
    } as Conversation;
    const countInputs: number[] = [];
    const memo = createTokenCountMemo((text) => {
      countInputs.push(text.length);
      return countTokens(text);
    });
    const result = computeTokenBreakdown(
      delayedConversation,
      32_768,
      0,
      true,
      false,
      0,
      memo,
    );

    assert.ok(result.helpHistorySkills > 0);
    assert.equal(result.replies, 0);
    assert.ok(
      idReads <= count * 5,
      `tool-call identifiers must have linear reads, received ${idReads}`,
    );
    assert.ok(
      Math.max(...countInputs) <= 8_192,
      'large archived projections must use bounded tokenizer inputs',
    );
    const readsAfterColdProjection = idReads;
    assert.deepEqual(
      computeTokenBreakdown(delayedConversation, 32_768, 0, true, false, 0, memo),
      result,
    );
    assert.ok(
      idReads - readsAfterColdProjection <= count * 2,
      'a stable archived prefix must reuse its tokenized projection',
    );
  });

  it('counts the archived todo projection as user input', () => {
    const todoInput = {
      todos: [
        { id: 1, title: 'Finished', status: 'completed' },
        { id: 9, title: 'Continue', status: 'in-progress', note: 'Use saved state.' },
      ],
    };
    const todoConv = {
      ...conv,
      id: 'todo-token-test',
      tools: { ...tools, file_io_enabled: false },
      messages: [
        { id: 'todo-u1', role: 'user', content: 'plan', createdAt: 1 },
        {
          id: 'todo-a1', role: 'assistant', content: '', createdAt: 2,
          tool_calls: [{ created_at: 0, id: 'todo-call', name: 'lc_todo_write', arguments: JSON.stringify(todoInput) }],
        },
        {
          id: 'todo-r1', role: 'tool', createdAt: 3, tool_call_id: 'todo-call',
          content: JSON.stringify({
            status: 'ok',
            data: { completed: 1, blocked: 0, total: 2 },
            issues: [],
            warnings: [],
          }),
        },
        { id: 'todo-u2', role: 'user', content: 'continue', createdAt: 4 },
      ],
    } as Conversation;
    const snapshot = buildTodoSnapshotIndex(todoConv.messages).latest;
    assert.ok(snapshot);
    const projection = formatTodoRequestProjection(snapshot);
    assert.ok(projection);

    const idle = computeTokenBreakdown(todoConv, 32_768, 0, true, false, 0);
    assert.equal(
      idle.userInput,
      countTokens('plan') + countTokens('continue') + countTokens(projection),
    );

    const active = computeTokenBreakdown(todoConv, 32_768, 0, true, true, 0);
    assert.equal(active.userInput, countTokens('plan') + countTokens('continue') + countTokens(projection));

    const suppliedEmptyIndex = {
      ownedByAssistantId: new Map(),
      effectiveByAssistantId: new Map(),
      turnSnapshotsByAssistantId: new Map(),
    };
    const supplied = computeTokenBreakdown(
      todoConv,
      32_768,
      0,
      true,
      false,
      0,
      undefined,
      suppliedEmptyIndex,
    );
    assert.equal(
      supplied.userInput,
      countTokens('plan') + countTokens('continue'),
      'a supplied index is reused instead of rebuilding the transcript index',
    );
  });

  it('keeps archived assistant reasoning and bubble text in their own rows', () => {
    const archivedConversation = {
      ...conv,
      id: 'archived-assistant-text',
      messages: [
        { id: 'u-archived-text', role: 'user', content: 'inspect', createdAt: 1 },
        {
          id: 'a-archived-text',
          role: 'assistant',
          content: 'the visible conclusion',
          reasoning: 'the retained reasoning trace',
          refusal: 'the retained refusal',
          createdAt: 2,
          usage: { prompt_tokens: 50_000, completion_tokens: 3, total_tokens: 50_003 },
          tool_calls: [{
            id: 'call-archived-text',
            name: 'lc_read_file',
            arguments: '{"path":"notes.md"}',
            created_at: 2,
          }],
        },
        {
          id: 'result-archived-text',
          role: 'tool',
          content: 'raw file data '.repeat(200),
          createdAt: 3,
          tool_call_id: 'call-archived-text',
        },
      ],
    } as Conversation;

    const result = computeTokenBreakdown(
      archivedConversation,
      200_000,
      0,
      true,
      false,
      0,
    );

    assert.equal(result.reasoning, countTokens('the retained reasoning trace'));
    assert.equal(
      result.replies,
      countTokens('the visible conclusion') + countTokens('the retained refusal'),
    );
    assert.ok(result.helpHistorySkills > 0);
    assert.equal(result.io, 0);
  });

  it('categorizes a changing active suffix while reusing the archived prefix', () => {
    const memo = createTokenCountMemo();
    const activeBase = {
      ...conv,
      id: 'active-suffix-category',
      messages: [
        ...conv.messages,
        { id: 'u-active-suffix', role: 'user', content: 'search now', createdAt: 4 },
      ],
    } as Conversation;

    computeTokenBreakdown(activeBase, 200_000, 0, true, true, 0, memo);
    const activeWithResult = {
      ...activeBase,
      messages: [
        ...activeBase.messages,
        {
          id: 'a-active-suffix',
          role: 'assistant',
          content: '',
          createdAt: 5,
          tool_calls: [{
            id: 'call-active-suffix',
            name: 'lc_web_fetch',
            arguments: '{"url":"https://example.test"}',
            created_at: 5,
          }],
        },
        {
          id: 'result-active-suffix',
          role: 'tool',
          content: 'fresh web result',
          createdAt: 6,
          tool_call_id: 'call-active-suffix',
        },
      ],
    } as Conversation;

    const result = computeTokenBreakdown(
      activeWithResult,
      200_000,
      0,
      true,
      true,
      0,
      memo,
    );

    assert.ok(result.webAccess > 0);
    assert.equal(result.otherTools, 0);
    assert.ok(result.helpHistorySkills > 0);
  });

  it('ignores provider cache counters entirely', () => {
    // The meter counts the retained conversation context. Provider cache
    // usage describes a completed response, so merging the two would report a
    // transport observation as conversation content
    // (docs/cache-observability.md §4).
    const withoutCache = {
      ...conv,
      messages: conv.messages.map((message) => message.role === 'assistant'
        ? { ...message, usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1_020 } }
        : message),
    } as Conversation;
    const withCache = {
      ...conv,
      messages: conv.messages.map((message) => message.role === 'assistant'
        ? {
          ...message,
          usage: {
            prompt_tokens: 900,
            completion_tokens: 120,
            total_tokens: 1_020,
            source: 'provider' as const,
            cache: {
              status: 'reported' as const,
              readTokens: 850,
              writeTokens: 40,
              missTokens: 10,
              reportedBy: 'provider' as const,
            },
          },
          prefix: { conclusion: 'stable-prefix' as const, qualifiers: [] },
        }
        : message),
    } as Conversation;

    const plain = computeTokenBreakdown(withoutCache, 32_768, 0, false, false, 0);
    const cached = computeTokenBreakdown(withCache, 32_768, 0, false, false, 0);
    assert.deepEqual(cached, plain);
  });

  it('routes every canonical tool category without treating tools as replies', () => {
    const toolNames = [
      'lc_ask_user',
      'lc_read_file',
      'lc_run_shell',
      'lc_web_fetch',
      'lc_tool_help',
      'lc_tool_history',
      'lc_skill',
      'lc_whiteboard',
      'imported_custom_tool',
    ];
    const calls = toolNames.map((name, index) => ({
      id: `category-call-${index}`,
      name,
      arguments: JSON.stringify({ category: name }),
      created_at: index + 2,
    }));
    const categoryConversation = {
      ...conv,
      id: 'canonical-tool-categories',
      tools: { ...tools, tool_history_enabled: false },
      messages: [
        { id: 'u-categories', role: 'user', content: '', createdAt: 1 },
        {
          id: 'a-categories',
          role: 'assistant',
          content: '',
          createdAt: 2,
          tool_calls: calls,
        },
        ...calls.map((call, index) => ({
          id: `category-result-${index}`,
          role: 'tool' as const,
          content: `${call.name} result`,
          createdAt: index + 20,
          tool_call_id: call.id,
        })),
      ],
    } as Conversation;

    const result = computeTokenBreakdown(
      categoryConversation,
      200_000,
      0,
      false,
      false,
      0,
    );

    assert.ok(result.foundationTools > 0);
    assert.ok(result.io > 0);
    assert.ok(result.webAccess > 0);
    assert.ok(result.whiteboard > 0);
    assert.ok(result.helpHistorySkills > 0);
    assert.ok(result.otherTools > 0);
    assert.equal(result.replies, 0);
  });
});

describe('TokenMeter opaque and remote provider-state projection', () => {
  it('counts a Gemini thought group once, skips summaries, and memoizes settled reply text', () => {
    const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    const model = 'gemini-3.8-flash';
    const target = { protocol: 'gemini-interactions' as const, baseUrl, model,
      providerContract: resolveBundledProviderContract({ baseUrl, modelId: model, protocol: 'gemini-interactions' }) };
    const largeSummary = 'display only '.repeat(50_000);
    const conversation: Conversation = { ...conv, messages: [{ id: 'native', role: 'assistant', createdAt: 2,
      content: 'native answer', reasoning: largeSummary,
      gemini_interactions: [{ schemaVersion: 1, responseId: 'native', origin: { baseUrl, model }, complete: true,
        steps: [{ type: 'thought', signature: 'opaque'.repeat(50_000), summary: [{ type: 'text', text: largeSummary }] },
          { type: 'thought', signature: 'second' }, { type: 'model_output', content: [{ type: 'text', text: 'native answer' }] }],
        thoughtStepIndexes: [0, 1], usage: { total_thought_tokens: 42 } }] }] };
    let replyCounts = 0;
    const memo = createTokenCountMemo((text) => {
      assert.ok(text.length < 16_384, 'opaque signatures and summaries never enter the tokenizer');
      if (text === 'native answer') replyCounts++;
      return countTokens(text);
    });
    for (let render = 0; render < 3; render++) {
      const result = computeTokenBreakdown(conversation, 1_000_000, 0, true, false, 0, memo, undefined, target);
      assert.equal(result.reasoning, 42);
      assert.equal(result.replies, countTokens('native answer'));
      assert.equal(result.exact, true);
    }
    assert.equal(replyCounts, 1);
  });

  const providerBreakdown = (
    conversation: Conversation,
    providerTarget: Parameters<typeof computeTokenBreakdown>[8],
    turnActive = false,
  ) => computeTokenBreakdown(
    conversation,
    1_000_000,
    0,
    false,
    turnActive,
    0,
    undefined,
    undefined,
    providerTarget,
  );

  it('live-counts plaintext Responses reasoning through the resolved contract', () => {
    const live = {
      ...conv,
      id: 'live-deepseek-responses',
      messages: [
        { id: 'u', role: 'user', content: 'go', createdAt: 1 },
        {
          id: 'a', role: 'assistant', content: '', reasoning: 'streamed reasoning',
          createdAt: 2, streaming: true,
        },
      ],
    } as Conversation;
    const contract = resolveBundledProviderContract({
      baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'openai-responses',
      modelId: 'deepseek-chat',
    });
    const result = providerBreakdown(live, {
      protocol: 'openai-responses',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      requestHasTools: false,
      providerContract: contract,
    }, true);
    assert.equal(result.reasoning, countTokens('streamed reasoning'));
    assert.equal(result.exact, true);
  });

  it('marks unlisted-provider reasoning unknown rather than claiming an exact zero', () => {
    const conversation = {
      ...conv,
      id: 'unlisted-provider',
      messages: [
        { id: 'u', role: 'user', content: 'go', createdAt: 1 },
        { id: 'a', role: 'assistant', content: 'reply', reasoning: 'retained reasoning', createdAt: 2 },
      ],
    } as Conversation;
    const result = providerBreakdown(conversation, {
      protocol: 'openai-chat',
      model: 'unknown-model',
      baseUrl: 'https://relay.example/v1',
      providerContractStatus: 'unmatched',
    });
    assert.equal(result.reasoning, 0);
    assert.equal(result.exact, false);
    assert.deepEqual(result.unknownContributions, ['opaque-reasoning']);
  });

  it('counts unlisted Chat reasoning replayed to its exact source route', () => {
    const conversation = {
      ...conv,
      id: 'unlisted-provider-same-route',
      messages: [
        { id: 'u', role: 'user', content: 'go', createdAt: 1 },
        {
          id: 'a', role: 'assistant', content: 'reply', reasoning: 'retained reasoning', createdAt: 2,
          meta: { baseUrl: 'https://relay.example/v1', model: 'unknown-model' },
        },
      ],
    } as Conversation;
    const result = providerBreakdown(conversation, {
      protocol: 'openai-chat',
      model: 'unknown-model',
      baseUrl: 'https://relay.example/v1',
      providerContractStatus: 'unmatched',
    });
    assert.equal(result.reasoning, countTokens('retained reasoning'));
    assert.equal(result.exact, true);
    assert.deepEqual(result.unknownContributions, []);
  });

  it('adds only the bound encrypted Responses contribution and never the footer aggregate', () => {
    const opaqueConversation = {
      ...conv,
      id: 'opaque-responses',
      tools: { ...tools, enabled: false, tool_history_enabled: false },
      messages: [
        { id: 'u', role: 'user', content: 'go', createdAt: 1 },
        {
          id: 'a', role: 'assistant', content: 'reply', reasoning: 'visible summary', createdAt: 2,
          usage: {
            prompt_tokens: 100_000,
            completion_tokens: 400_000,
            total_tokens: 500_000,
            source: 'provider',
            scope: 'assistant-turn',
            coverage: { responseCount: 3, providerReportedResponses: 3, estimatedResponses: 0 },
            terminalCoverage: 'complete',
            reasoning: { status: 'reported', tokens: 399_000, reportedResponses: 3, responseCount: 3 },
          },
          responses_output_items: [
            {
              id: 'r', type: 'reasoning', encrypted_content: 'cipher',
              summary: [{ type: 'summary_text', text: 'visible summary' }],
            },
            {
              id: 'm', type: 'message', role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text: 'reply', annotations: [] }],
            },
          ],
          opaque_replay_accounting: [{
            schemaVersion: 1,
            protocol: 'openai-responses',
            reasoningCarrier: 'encrypted-content',
            generatedReasoningTokens: 300_000,
            tokenStatus: 'provider-reported',
            locator: { kind: 'responses-item-ids', itemIds: ['r', 'm'] },
          }],
        },
      ],
    } as Conversation;
    const result = providerBreakdown(opaqueConversation, {
      protocol: 'openai-responses', model: 'gpt', baseUrl: 'https://api.openai.com/v1',
    });
    assert.equal(result.reasoning, 300_000);
    assert.equal(result.replies, countTokens('reply'));
    assert.equal(result.exact, true);
    assert.equal(result.opaqueReasoningMeasurement, 'provider-counter');
    assert.notEqual(result.reasoning, 399_000, 'turn usage is never reused as next-request context');
  });

  it('turns missing opaque accounting into a visible lower-bound state', () => {
    const unknownConversation = {
      ...conv,
      id: 'opaque-unknown',
      tools: { ...tools, enabled: false, tool_history_enabled: false },
      messages: [
        { id: 'u', role: 'user', content: 'go', createdAt: 1 },
        {
          id: 'a', role: 'assistant', content: '', createdAt: 2,
          responses_output_items: [{
            id: 'r', type: 'reasoning', encrypted_content: 'cipher', summary: [],
          }],
        },
      ],
    } as Conversation;
    const target = { protocol: 'openai-responses' as const, model: 'gpt' };
    const result = providerBreakdown(unknownConversation, target);
    assert.equal(result.exact, false);
    assert.deepEqual(result.unknownContributions, ['opaque-reasoning']);

    const html = renderToStaticMarkup(createElement(TokenMeter, {
      conv: unknownConversation,
      maxContext: 1_000_000,
      style: 'donut',
      systemPromptTokens: 0,
      toolDefinitionTokens: 0,
      toolCallingSupported: false,
      providerTarget: target,
    }));
    assert.match(html, /Known context lower bound/);
    assert.match(html, /unmeasured provider state/);
    assert.match(html, /token-meter-warning/);
  });

  it('counts Anthropic thinking precisely while labeling its provider value as reported', () => {
    const anthropicConversation = {
      ...conv,
      id: 'opaque-anthropic',
      tools: { ...tools, enabled: false, tool_history_enabled: false },
      messages: [
        { id: 'u', role: 'user', content: 'go', createdAt: 1 },
        {
          id: 'a', role: 'assistant', content: '', reasoning: 'summary', createdAt: 2,
          tool_calls: [{ id: 'toolu_1', name: 'tool', arguments: '{}', created_at: 2 }],
          anthropic_output_blocks: [{ type: 'thinking', thinking: 'summary', signature: 'sig' }],
          meta: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5' },
          opaque_replay_accounting: [{
            schemaVersion: 1,
            protocol: 'anthropic-messages',
            reasoningCarrier: 'signed-thinking',
            generatedReasoningTokens: 80_000,
            tokenStatus: 'provider-estimate',
            locator: { kind: 'anthropic-block-indexes', blockIndexes: [0] },
            toolCallIds: ['toolu_1'],
          }],
        },
      ],
    } as Conversation;
    const result = providerBreakdown(anthropicConversation, {
      protocol: 'anthropic-messages',
      model: 'claude-sonnet-5',
      baseUrl: 'https://api.anthropic.com/v1',
    });
    assert.equal(result.reasoning, 80_000);
    assert.equal(result.opaqueReasoningMeasurement, 'provider-estimate');
    assert.equal(result.exact, true);

    assert.equal(tokenMeterReasoningLabel('provider-estimate'), 'Reasoning (reported)');
    assert.equal(tokenMeterReasoningLabel('provider-counter'), 'Reasoning (reported)');
    assert.equal(tokenMeterReasoningLabel('mixed'), 'Reasoning (reported)');
    assert.equal(tokenMeterReasoningLabel(undefined), 'Reasoning');
  });

  it('counts MiniMax Anthropic thinking locally instead of treating its signature as encrypted', () => {
    const thinking = 'complete MiniMax reasoning';
    const baseUrl = 'https://api.gmi-serving.com/v1';
    const miniMaxConversation = {
      ...conv,
      id: 'plaintext-minimax-anthropic',
      tools: { ...tools, enabled: false, tool_history_enabled: false },
      messages: [
        { id: 'u', role: 'user', content: 'go', createdAt: 1 },
        {
          id: 'a', role: 'assistant', content: '', reasoning: thinking, createdAt: 2,
          tool_calls: [{ id: 'toolu_1', name: 'tool', arguments: '{}', created_at: 2 }],
          anthropic_output_blocks: [{
            type: 'thinking',
            thinking,
            signature: '1c3a0ae890922669e9815a201f9b645abdaafe8d8b5a65a5e48f90830c6e0750',
          }],
          meta: { baseUrl, model: 'MiniMax-M2.7' },
          opaque_replay_accounting: [{
            schemaVersion: 1,
            protocol: 'anthropic-messages',
            reasoningCarrier: 'plaintext',
            tokenStatus: 'unreported',
            locator: { kind: 'anthropic-block-indexes', blockIndexes: [0] },
            toolCallIds: ['toolu_1'],
          }],
        },
      ],
    } as Conversation;
    const result = providerBreakdown(miniMaxConversation, {
      protocol: 'anthropic-messages',
      model: 'MiniMax-M2.7',
      baseUrl,
    }, true);
    assert.equal(result.reasoning, countTokens(thinking));
    assert.equal(result.opaqueReasoningMeasurement, undefined);
    assert.equal(result.exact, true);
  });

  it('retains accounted OpenAI encrypted reasoning when Tool History rebuilds its call', () => {
    const encryptedConversation = {
      ...conv,
      id: 'archived-openai-reasoning',
      tools: { ...tools, enabled: true, tool_history_enabled: true },
      messages: [
        { id: 'u', role: 'user', content: 'go', createdAt: 1 },
        {
          id: 'a', role: 'assistant', content: '', createdAt: 2,
          tool_calls: [{ id: 'call-1', name: 'lc_read_file', arguments: '{}', created_at: 2 }],
          responses_output_items: [{
            id: 'r', type: 'reasoning', encrypted_content: 'cipher', summary: [],
          }, {
            id: 'c', type: 'function_call', call_id: 'call-1',
            name: 'lc_read_file', arguments: '{}', status: 'completed',
          }],
          opaque_replay_accounting: [{
            schemaVersion: 1,
            protocol: 'openai-responses',
            reasoningCarrier: 'encrypted-content',
            generatedReasoningTokens: 50_000,
            tokenStatus: 'provider-reported',
            locator: { kind: 'responses-item-ids', itemIds: ['r', 'c'] },
            toolCallIds: ['call-1'],
          }],
        },
        { id: 't', role: 'tool', content: 'result', createdAt: 3, tool_call_id: 'call-1' },
      ],
    } as Conversation;
    const target = {
      protocol: 'openai-responses' as const,
      model: 'gpt-5.6-luna',
      baseUrl: 'https://api.openai.com/v1',
    };
    const projected = computeTokenBreakdown(
      encryptedConversation, 1_000_000, 0, true, false, 0,
      undefined, undefined, target,
    );
    const raw = computeTokenBreakdown(
      encryptedConversation, 1_000_000, 0, false, false, 0,
      undefined, undefined, target,
    );
    assert.equal(projected.reasoning, 50_000);
    assert.equal(projected.opaqueReasoningMeasurement, 'provider-counter');
    assert.equal(projected.exact, true);
    assert.equal(raw.reasoning, 50_000);
  });

  it('retains locally counted plaintext Responses reasoning through Tool History', () => {
    const thought = 'plain reasoning returned by a compatible Responses server';
    const plaintextConversation = {
      ...conv,
      id: 'archived-compatible-responses-reasoning',
      tools: { ...tools, enabled: true, tool_history_enabled: true },
      messages: [
        { id: 'u', role: 'user', content: 'go', createdAt: 1 },
        {
          id: 'a', role: 'assistant', content: '', reasoning: thought, createdAt: 2,
          tool_calls: [{ id: 'call-1', name: 'lc_read_file', arguments: '{}', created_at: 2 }],
          responses_output_items: [{
            id: 'r', type: 'reasoning',
            content: [{ type: 'reasoning_text', text: thought }], summary: [],
          }, {
            id: 'c', type: 'function_call', call_id: 'call-1',
            name: 'lc_read_file', arguments: '{}', status: 'completed',
          }],
          opaque_replay_accounting: [{
            schemaVersion: 1,
            protocol: 'openai-responses',
            reasoningCarrier: 'plaintext',
            tokenStatus: 'unreported',
            locator: { kind: 'responses-item-ids', itemIds: ['r', 'c'] },
            toolCallIds: ['call-1'],
          }],
        },
        { id: 't', role: 'tool', content: 'result', createdAt: 3, tool_call_id: 'call-1' },
      ],
    } as Conversation;
    const target = {
      protocol: 'openai-responses' as const,
      model: 'qwen/qwen3.8-27b',
      baseUrl: 'https://compatible.example/v1',
    };
    const projected = computeTokenBreakdown(
      plaintextConversation, 1_000_000, 0, true, false, 0,
      undefined, undefined, target,
    );
    const raw = computeTokenBreakdown(
      plaintextConversation, 1_000_000, 0, false, false, 0,
      undefined, undefined, target,
    );
    assert.equal(projected.reasoning, countTokens(thought));
    assert.equal(raw.reasoning, countTokens(thought));
    assert.equal(projected.opaqueReasoningMeasurement, undefined);
    assert.equal(projected.exact, true);
  });

  it('retains Claude and MiniMax reasoning when Tool History rebuilds their calls', () => {
    const cases = [{
      id: 'archived-claude-reasoning',
      model: 'claude-sonnet-5',
      baseUrl: 'https://api.anthropic.com/v1',
      thinking: 'display summary',
      signature: 'opaque-claude-signature',
      carrier: 'signed-thinking' as const,
      generatedReasoningTokens: 80_000,
      rawReasoningTokens: 80_000,
    }, {
      id: 'archived-minimax-reasoning',
      model: 'MiniMax-M3',
      baseUrl: 'https://api.gmi-serving.com/v1',
      thinking: 'complete MiniMax reasoning',
      signature: '1c3a0ae890922669e9815a201f9b645abdaafe8d8b5a65a5e48f90830c6e0750',
      carrier: 'plaintext' as const,
      generatedReasoningTokens: undefined,
      rawReasoningTokens: countTokens('complete MiniMax reasoning'),
    }];

    for (const testCase of cases) {
      const archivedConversation = {
        ...conv,
        id: testCase.id,
        tools: { ...tools, enabled: true, tool_history_enabled: true },
        messages: [
          { id: 'u', role: 'user', content: 'go', createdAt: 1 },
          {
            id: 'a', role: 'assistant', content: 'reply', reasoning: testCase.thinking, createdAt: 2,
            tool_calls: [{
              id: 'toolu_1', name: 'lc_read_file', arguments: '{}', created_at: 2,
            }],
            anthropic_output_blocks: [{
              type: 'thinking', thinking: testCase.thinking, signature: testCase.signature,
            }],
            meta: { baseUrl: testCase.baseUrl, model: testCase.model },
            opaque_replay_accounting: [{
              schemaVersion: 1,
              protocol: 'anthropic-messages',
              reasoningCarrier: testCase.carrier,
              ...(testCase.generatedReasoningTokens !== undefined
                ? { generatedReasoningTokens: testCase.generatedReasoningTokens }
                : {}),
              tokenStatus: testCase.carrier === 'signed-thinking'
                ? 'provider-estimate' : 'unreported',
              locator: { kind: 'anthropic-block-indexes', blockIndexes: [0] },
              toolCallIds: ['toolu_1'],
            }],
          },
          {
            id: 't', role: 'tool', content: 'result', createdAt: 3,
            tool_call_id: 'toolu_1',
          },
        ],
      } as Conversation;
      const target = {
        protocol: 'anthropic-messages' as const,
        model: testCase.model,
        baseUrl: testCase.baseUrl,
      };
      const active = computeTokenBreakdown(
        archivedConversation, 1_000_000, 0, true, false, 0,
        undefined, undefined, target,
      );
      const raw = computeTokenBreakdown(
        archivedConversation, 1_000_000, 0, false, false, 0,
        undefined, undefined, target,
      );
      assert.equal(active.reasoning, testCase.rawReasoningTokens);
      assert.equal(
        active.opaqueReasoningMeasurement,
        testCase.carrier === 'signed-thinking' ? 'provider-estimate' : undefined,
      );
      assert.equal(raw.reasoning, testCase.rawReasoningTokens);
    }
  });

  it('does not substitute output usage for LM Studio remote-state occupancy', () => {
    const nativeConversation = {
      ...conv,
      id: 'remote-native',
      tools: { ...tools, enabled: false, tool_history_enabled: false },
      messages: [
        { id: 'u', role: 'user', content: 'go', createdAt: 1 },
        {
          id: 'a', role: 'assistant', content: 'large output', createdAt: 2,
          lmstudio_response_id: 'response-1',
          usage: { prompt_tokens: 10, completion_tokens: 90_000, total_tokens: 90_010 },
        },
      ],
    } as Conversation;
    const result = providerBreakdown(nativeConversation, {
      protocol: 'lmstudio-rest', model: 'local',
    });
    assert.equal(result.reasoning, 0);
    assert.equal(result.replies, 0);
    assert.equal(result.exact, false);
    assert.deepEqual(result.unknownContributions, ['remote-state']);
  });
});

describe('TokenMeter first-party Meta archive totals', () => {
  const META_BASE = 'https://api.meta.ai/v1';
  const META_MODEL = 'muse-spark-1.3-contributor';

  const providerBreakdown = (
    conversation: Conversation,
    providerTarget: Parameters<typeof computeTokenBreakdown>[8],
    turnActive = false,
  ) => computeTokenBreakdown(
    conversation,
    1_000_000,
    0,
    false,
    turnActive,
    0,
    undefined,
    undefined,
    providerTarget,
  );

  const metaUsage = (
    prompt_tokens: number,
    completion_tokens: number,
    reasoning_tokens: number,
    cached_tokens: number,
  ) => ({
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    source: 'provider',
    scope: 'assistant-turn',
    coverage: { responseCount: 1, providerReportedResponses: 1, estimatedResponses: 0 },
    terminalCoverage: 'complete',
    reasoning: { status: 'reported', tokens: reasoning_tokens, reportedResponses: 1, responseCount: 1 },
    cache: {
      status: 'reported',
      readTokens: cached_tokens,
      reportedBy: 'provider',
      coverage: { reportedResponses: 1, responseCount: 1 },
    },
  });

  // All three archived protocol tests ran on the same server/profile ID while
  // the profile moved between protocols. ChatView reads the next-request
  // target from the current mutable profile, so viewing an old conversation
  // after switching protocols legitimately shows zero carried reasoning.
  // Prefer distinct profiles for side-by-side protocol tests.
  function metaMessagesConversation(): Conversation {
    let blockCursor = 0;
    const messages: unknown[] = [{ id: 'u', role: 'user', content: 'go', createdAt: 1 }];
    META_MESSAGES_FIRST_PARTY_TURN_USAGE.forEach((turn, turnIndex) => {
      const blockCount = META_MESSAGES_FIRST_PARTY_BLOCK_COUNTS[turnIndex];
      const blocks = Array.from({ length: blockCount }, () => ({
        type: 'redacted_thinking',
        data: metaRedactedPlaceholder(blockCursor++),
      }));
      let locatorCursor = 0;
      const groupSplits = META_MESSAGES_FIRST_PARTY_GROUP_TOKENS[turnIndex];
      const groups = groupSplits.map((tokens, groupIndex) => {
        const remainingGroups = groupSplits.length - groupIndex;
        const take = groupIndex === groupSplits.length - 1
          ? blockCount - locatorCursor
          : Math.max(1, Math.floor((blockCount - locatorCursor) / remainingGroups));
        const blockIndexes = Array.from({ length: take }, (_, n) => locatorCursor + n);
        locatorCursor += take;
        return {
          schemaVersion: 1,
          protocol: 'anthropic-messages',
          reasoningCarrier: 'redacted-thinking',
          generatedReasoningTokens: tokens,
          tokenStatus: 'provider-estimate',
          locator: { kind: 'anthropic-block-indexes', blockIndexes },
        };
      });
      messages.push({
        id: `m-${turnIndex}`,
        role: 'assistant',
        content: '',
        createdAt: 2 + turnIndex,
        meta: { baseUrl: META_BASE, model: META_MODEL },
        usage: metaUsage(turn.prompt_tokens, turn.completion_tokens, turn.thinking_tokens, turn.cached_tokens),
        anthropic_output_blocks: blocks,
        opaque_replay_accounting: groups,
      });
    });
    return {
      ...conv,
      id: 'meta-messages-1949',
      tools: { ...tools, enabled: false, tool_history_enabled: false },
      messages,
    } as Conversation;
  }

  function metaResponsesConversation(): Conversation {
    const messages: unknown[] = [{ id: 'u', role: 'user', content: 'go', createdAt: 1 }];
    META_RESPONSES_1949_TURN_USAGE.forEach((turn, turnIndex) => {
      messages.push({
        id: `r-${turnIndex}`,
        role: 'assistant',
        content: '',
        createdAt: 2 + turnIndex,
        meta: { baseUrl: META_BASE, model: META_MODEL },
        usage: metaUsage(turn.prompt_tokens, turn.completion_tokens, turn.reasoning_tokens, turn.cached_tokens),
        responses_output_items: [
          {
            id: `rs_meter_${turnIndex}`,
            type: 'reasoning',
            encrypted_content: metaEncryptedPlaceholder(turnIndex),
            summary: [],
          },
          {
            id: `msg_meter_${turnIndex}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '', annotations: [] }],
          },
        ],
        opaque_replay_accounting: [{
          schemaVersion: 1,
          protocol: 'openai-responses',
          reasoningCarrier: 'encrypted-content',
          generatedReasoningTokens: turn.reasoning_tokens,
          tokenStatus: 'provider-reported',
          locator: { kind: 'responses-item-ids', itemIds: [`rs_meter_${turnIndex}`, `msg_meter_${turnIndex}`] },
        }],
      });
    });
    return {
      ...conv,
      id: 'meta-responses-1949',
      tools: { ...tools, enabled: false, tool_history_enabled: false },
      messages,
    } as Conversation;
  }

  function metaChatConversation(): Conversation {
    const messages: unknown[] = [{ id: 'u', role: 'user', content: 'go', createdAt: 1 }];
    META_CHAT_FIRST_PARTY_TURN_USAGE.forEach((turn, turnIndex) => {
      messages.push({
        id: `c-${turnIndex}`,
        role: 'assistant',
        content: 'reply',
        createdAt: 2 + turnIndex,
        meta: { baseUrl: META_BASE, model: META_MODEL },
        usage: metaUsage(turn.prompt_tokens, turn.completion_tokens, turn.reasoning_tokens, turn.cached_tokens),
      });
    });
    return {
      ...conv,
      id: 'meta-chat-1949',
      tools: { ...tools, enabled: false, tool_history_enabled: false },
      messages,
    } as Conversation;
  }

  it('counts 3,654 Messages reasoning tokens with the matching target', () => {
    const contract = resolveBundledProviderContract({
      baseUrl: META_BASE,
      protocol: 'anthropic-messages',
      modelId: META_MODEL,
    });
    assert.equal(contract?.contract.id, 'meta.messages');
    const result = providerBreakdown(metaMessagesConversation(), {
      protocol: 'anthropic-messages',
      model: META_MODEL,
      baseUrl: META_BASE,
      providerContract: contract,
    });
    assert.equal(result.reasoning, 3654);
    assert.equal(result.opaqueReasoningMeasurement, 'provider-estimate');
  });

  it('counts zero Messages reasoning for a crossed Responses target', () => {
    const contract = resolveBundledProviderContract({
      baseUrl: META_BASE,
      protocol: 'openai-responses',
      modelId: META_MODEL,
    });
    assert.equal(contract?.contract.id, 'meta.responses');
    const result = providerBreakdown(metaMessagesConversation(), {
      protocol: 'openai-responses',
      model: META_MODEL,
      baseUrl: META_BASE,
      providerContract: contract,
    });
    assert.equal(result.reasoning, 0);
  });

  it('counts zero Messages reasoning for the Zen relay', () => {
    const result = providerBreakdown(metaMessagesConversation(), {
      protocol: 'anthropic-messages',
      model: META_MODEL,
      baseUrl: 'https://opencode.ai/zen/v1',
      providerContractStatus: 'unmatched',
    });
    assert.equal(result.reasoning, 0);
    assert.equal(result.exact, false);
    assert.deepEqual(result.unknownContributions, ['opaque-reasoning']);
  });

  it('counts 3,888 Responses reasoning tokens with the matching target', () => {
    const contract = resolveBundledProviderContract({
      baseUrl: META_BASE,
      protocol: 'openai-responses',
      modelId: META_MODEL,
    });
    assert.equal(contract?.contract.id, 'meta.responses');
    const result = providerBreakdown(metaResponsesConversation(), {
      protocol: 'openai-responses',
      model: META_MODEL,
      baseUrl: META_BASE,
      providerContract: contract,
    });
    assert.equal(result.reasoning, 3888);
    assert.equal(result.opaqueReasoningMeasurement, 'provider-counter');
  });

  it('keeps Chat provider-reported reasoning out of the next-request context', () => {
    const contract = resolveBundledProviderContract({
      baseUrl: META_BASE,
      protocol: 'openai-chat',
      modelId: META_MODEL,
    });
    assert.equal(contract?.contract.id, 'meta.chat');
    const result = providerBreakdown(metaChatConversation(), {
      protocol: 'openai-chat',
      model: META_MODEL,
      baseUrl: META_BASE,
      providerContract: contract,
    });
    assert.equal(result.reasoning, 0);
  });
});

describe('applyServerTokenCount', () => {
  const providerBreakdown = (
    conversation: Conversation,
    providerTarget: Parameters<typeof computeTokenBreakdown>[8],
  ) => computeTokenBreakdown(
    conversation,
    1_000_000,
    0,
    false,
    false,
    0,
    undefined,
    undefined,
    providerTarget,
  );

  it('leaves local accounting untouched without a server value', () => {
    const stats = providerBreakdown(conv, {
      protocol: 'openai-chat',
      model: 'unknown-model',
      baseUrl: 'https://relay.example/v1',
      providerContractStatus: 'unmatched',
    });
    assert.equal(applyServerTokenCount(stats, undefined), stats);
  });

  it('makes the server total authoritative while keeping local categories', () => {
    const stats = providerBreakdown(conv, {
      protocol: 'openai-chat',
      model: 'unknown-model',
      baseUrl: 'https://relay.example/v1',
      providerContractStatus: 'unmatched',
    });
    const applied = applyServerTokenCount(stats, 5000);
    assert.equal(applied.totalUsed, 5000);
    assert.equal(applied.pct, Math.min(5000 / stats.max, 1));
    assert.equal(applied.serverMeasuredInput, true);
    assert.equal(applied.reasoning, stats.reasoning);
    assert.equal(applied.replies, stats.replies);
    assert.equal(applied.userInput, stats.userInput);
    assert.ok(!applied.unknownContributions.includes('opaque-reasoning'));
    assert.equal(applied.exact, applied.unknownContributions.length === 0);
  });
});
