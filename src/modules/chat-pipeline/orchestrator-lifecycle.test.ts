import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS, type Conversation } from '../../types.ts';
import {
  finalizeStreamingOwner,
  markStreaming,
  unmarkStreaming,
  useConversations,
} from '../../store/conversations.ts';
import {
  registerPermissionHandler,
  type PermissionResult,
} from '../../ui/tools/ToolPermissionModal.tsx';
import type { LLMClient } from '../llm-client';
import { runSubAgentChatOnce, runToolLoop, type PipelineOptions } from './orchestrator.ts';

test('Stop aborts an already-running sub-agent model request', async () => {
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const client = {
    chatOnce: async (_params, opts) => {
      assert.equal(opts?.signal, controller.signal);
      markStarted();
      return new Promise<string>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    },
  } satisfies Pick<LLMClient, 'chatOnce'>;

  const request = runSubAgentChatOnce(client, 'research-model', {
    systemPrompt: 'research',
    userContent: 'topic',
    signal: controller.signal,
  });
  await started;
  controller.abort();

  await assert.rejects(request, (error: unknown) =>
    error instanceof DOMException && error.name === 'AbortError');
});

test('sub-agent calls honor an explicit reasoning override', async () => {
  let seen: Parameters<LLMClient['chatOnce']>[0] | undefined;
  const client = {
    chatOnce: async (params) => {
      seen = params;
      return 'visible summary';
    },
  } satisfies Pick<LLMClient, 'chatOnce'>;

  const result = await runSubAgentChatOnce(client, 'vision-model', {
    systemPrompt: 'summarize',
    userContent: 'pages',
    signal: new AbortController().signal,
    max_tokens: 8192,
    reasoningEnabled: false,
    reasoningEffort: 'none',
  });

  assert.equal(result, 'visible summary');
  assert.equal(seen?.maxTokens, 8192);
  assert.equal(seen?.reasoningEnabled, false);
  assert.equal(seen?.reasoningEffort, 'none');
});

test('a ceiling-less sub-agent call still carries the model\'s own limit', async () => {
  let seen: Parameters<LLMClient['chatOnce']>[0] | undefined;
  const client = {
    chatOnce: async (params) => {
      seen = params;
      return 'visible summary';
    },
  } satisfies Pick<LLMClient, 'chatOnce'>;

  await runSubAgentChatOnce(client, 'vision-model', {
    systemPrompt: 'summarize',
    userContent: 'pages',
    signal: new AbortController().signal,
    reasoningEnabled: false,
  }, 64_000);

  // The caller sends no ceiling, so adapters that key on `maxTokens` omit one.
  // Anthropic requires the field and reads `maxOutputTokens` instead — without
  // it that call silently lands on a hard-coded 4,096.
  assert.equal(seen?.maxTokens, undefined);
  assert.equal(seen?.maxOutputTokens, 64_000);
});

test('an unreported model ceiling leaves adapter defaults alone', async () => {
  let seen: Parameters<LLMClient['chatOnce']>[0] | undefined;
  const client = {
    chatOnce: async (params) => {
      seen = params;
      return 'visible summary';
    },
  } satisfies Pick<LLMClient, 'chatOnce'>;

  await runSubAgentChatOnce(client, 'vision-model', {
    systemPrompt: 'summarize',
    userContent: 'pages',
    signal: new AbortController().signal,
  });

  assert.equal(seen?.maxOutputTokens, undefined);
});

test('Stop during a late permission decision persists no grant or tool result', { timeout: 5_000 }, async () => {
  const conversationId = 'permission-stop-lifecycle';
  const assistantId = 'permission-stop-assistant';
  const prior = useConversations.getState();
  const conversation: Conversation = {
    id: conversationId,
    title: 'permission stop',
    serverId: 'profile',
    model: 'test-model',
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 1,
    messages: [{
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: 1,
      streaming: true,
    }],
    tools: {
      enabled: true,
      tool_grants: [],
      web_access_grants_initialized: true,
      file_io_enabled: false,
      shell_enabled: false,
      web_access_enabled: true,
      allowed_roots: [],
      dir_permissions: {},
      max_tool_rounds_per_turn: 128,
      max_tool_calls_per_batch: 8,
      sse_read_timeout_min: 5,
    },
  };
  useConversations.setState({
    byId: { ...prior.byId, [conversationId]: conversation },
    order: [conversationId, ...prior.order.filter((id) => id !== conversationId)],
    activeId: conversationId,
  });

  const owner = markStreaming(conversationId, assistantId, 'permission-stop-generation');
  const controller = new AbortController();
  let revealPrompt!: () => void;
  const promptSeen = new Promise<void>((resolve) => { revealPrompt = resolve; });
  let releaseDecision!: (result: PermissionResult) => void;
  const unregister = registerPermissionHandler(async () => {
    revealPrompt();
    return new Promise<PermissionResult>((resolve) => { releaseDecision = resolve; });
  });
  const streamOpts: Omit<PipelineOptions, 'signal'> = {
    convId: conversationId,
    // runToolLoop does not use the top-level client; re-streaming would, but
    // this fixture stops at the permission barrier before that boundary.
    llmClient: {} as PipelineOptions['llmClient'],
    model: 'test-model',
    profile: { baseUrl: 'http://127.0.0.1:1', apiKey: '' },
    generationId: owner.generationId,
    assistantMessageId: owner.assistantMessageId,
  };

  try {
    const loop = runToolLoop(
      conversationId,
      [{
        id: 'fetch-call',
        name: 'lc_web_fetch',
        arguments: '{"url":"https://example.com"}',
        created_at: 2,
      }],
      controller.signal,
      { current: streamOpts.profile },
      { current: streamOpts.model },
      { current: undefined },
      streamOpts,
      { current: new Set<string>() },
    );

    await Promise.race([
      promptSeen,
      loop.then((result) => {
        throw new Error(`tool loop settled before permission prompt: ${JSON.stringify(result)}`);
      }),
    ]);
    controller.abort();
    assert.equal(finalizeStreamingOwner(conversationId, owner.generationId, {
      meta: { finish_reason: 'disconnected' },
    }), true);
    // Deliberately emulate a stale UI that approves after Stop. The
    // orchestrator barrier must reject it even if the modal misbehaves.
    releaseDecision({ decision: 'allow_session', grantedDirs: [] });

    const result = await loop;
    const after = useConversations.getState().byId[conversationId];
    assert.equal(result.stopReason, 'aborted');
    assert.deepEqual(after.tools?.tool_grants, []);
    // The stale approval must not produce a result — but the accepted call id
    // must not stay unanswered either. A terminal aborted row is persisted so
    // the durable graph remains provider-valid.
    const toolResults = after.messages.filter((message) => message.role === 'tool');
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].tool_call_id, 'fetch-call');
    assert.ok(toolResults[0].tool_is_error);
    assert.match(toolResults[0].content, /"status":"aborted"/);
    assert.equal(after.messages[0].meta?.finish_reason, 'disconnected');
  } finally {
    unregister();
    unmarkStreaming(conversationId, owner.generationId);
    useConversations.setState({
      byId: prior.byId,
      order: prior.order,
      activeId: prior.activeId,
    });
  }
});

test('a permission decision is attached to the durable tool-result message', { timeout: 5_000 }, async () => {
  const conversationId = `permission-audit-${crypto.randomUUID()}`;
  const assistantId = `permission-audit-assistant-${crypto.randomUUID()}`;
  const call = {
    id: 'permission-audit-call',
    name: 'lc_web_fetch',
    arguments: '{"url":"https://example.com"}',
    created_at: Date.now(),
  };
  const coveredCall = {
    ...call,
    id: 'permission-audit-covered-call',
    arguments: '{"url":"https://example.org"}',
  };
  const prior = useConversations.getState();
  const conversation: Conversation = {
    id: conversationId,
    title: 'permission audit',
    serverId: 'profile',
    model: 'test-model',
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 1,
    messages: [{
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: 1,
      streaming: true,
      tool_calls: [call, coveredCall],
    }],
    tools: {
      enabled: true,
      tool_grants: [],
      web_access_grants_initialized: true,
      file_io_enabled: false,
      shell_enabled: false,
      web_access_enabled: true,
      allowed_roots: [],
      dir_permissions: {},
      max_tool_rounds_per_turn: 128,
      max_tool_calls_per_batch: 8,
      sse_read_timeout_min: 5,
    },
  };
  useConversations.setState({
    byId: { ...prior.byId, [conversationId]: conversation },
    order: [conversationId, ...prior.order.filter((id) => id !== conversationId)],
    activeId: conversationId,
  });

  const owner = markStreaming(conversationId, assistantId, `permission-audit-generation-${crypto.randomUUID()}`);
  let shownAt = 0;
  let popupCount = 0;
  const unregister = registerPermissionHandler(async () => {
    popupCount++;
    shownAt = Date.now();
    return {
      decision: 'deny',
      grantedDirs: [],
      shownAt,
      resolvedAt: shownAt + 25,
    };
  });
  const controller = new AbortController();
  const streamOpts: Omit<PipelineOptions, 'signal'> = {
    convId: conversationId,
    llmClient: {} as PipelineOptions['llmClient'],
    model: 'test-model',
    profile: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' },
    apiVariant: 'openai',
    apiStyle: 'chat',
    routing: 'direct',
    generationId: owner.generationId,
    assistantMessageId: owner.assistantMessageId,
  };

  try {
    await runToolLoop(
      conversationId,
      [call, coveredCall],
      controller.signal,
      { current: streamOpts.profile },
      { current: streamOpts.model },
      { current: undefined },
      streamOpts,
      { current: new Set<string>() },
    );

    const toolMessage = useConversations.getState().byId[conversationId].messages
      .find((message) => message.role === 'tool' && message.tool_call_id === call.id);
    assert.ok(toolMessage);
    assert.equal(toolMessage.tool_permission?.decision, 'deny');
    assert.equal(toolMessage.tool_permission?.shown_at, shownAt);
    assert.equal(toolMessage.tool_permission?.resolved_at, shownAt + 25);
    assert.deepEqual(toolMessage.tool_permission?.scopes, []);
    assert.deepEqual(toolMessage.tool_permission?.displayed_call, {
      tool_call_id: call.id,
      tool_name: call.name,
    });
    assert.equal(typeof toolMessage.tool_permission?.prompt_id, 'string');
    const coveredToolMessage = useConversations.getState().byId[conversationId].messages
      .find((message) => message.role === 'tool' && message.tool_call_id === coveredCall.id);
    assert.ok(coveredToolMessage);
    assert.equal(popupCount, 1);
    assert.equal(
      coveredToolMessage.tool_permission?.prompt_id,
      toolMessage.tool_permission?.prompt_id,
    );
    assert.deepEqual(
      coveredToolMessage.tool_permission?.displayed_call,
      toolMessage.tool_permission?.displayed_call,
    );
  } finally {
    unregister();
    unmarkStreaming(conversationId, owner.generationId);
    useConversations.setState({
      byId: prior.byId,
      order: prior.order,
      activeId: prior.activeId,
    });
  }
});
