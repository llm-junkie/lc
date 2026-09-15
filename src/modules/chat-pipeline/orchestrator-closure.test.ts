import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from 'gpt-tokenizer';
import type { Conversation, ServerProfile } from '../../types';
import type { LLMClient as LLMClientType } from '../llm-client';
import type { StreamResult } from '../llm-client/adapters/adapter';
import { OpenAIResponsesAdapter } from '../llm-client/adapters/openai-responses.ts';
import type { ChatMessage } from '../llm-client/types';
import { decodeLcResultJson } from '../tool-engine/tool-result-content.ts';
import type { PipelineOptions } from './orchestrator';
import { TokenCounter } from './token-counter.ts';
import { countTokens, MAX_FULL_TOKEN_TEXT_CHARS } from '../../utils/tokens.ts';
import { WHITEBOARD_ISSUE_FIXTURES } from '../../whiteboard/contract-fixtures.ts';
import { archiveToolCallId } from './message-history.ts';
import 'fake-indexeddb/auto';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

const originalFetch = globalThis.fetch;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
type TestStreamRequestInit = RequestInit & { responseTimeoutMs?: number };
let chatPostResponse: ((init?: TestStreamRequestInit) => Response) | null = null;
globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
  setTimeout(() => callback(performance.now()), 0) as unknown as number);
globalThis.cancelAnimationFrame = ((handle: number) => clearTimeout(handle));
globalThis.fetch = async (_input, init) => {
  if ((init?.method ?? 'GET').toUpperCase() === 'POST' && chatPostResponse) {
    return chatPostResponse(init);
  }
  return new Response(JSON.stringify({
    data: [{ id: 'closure-model', capabilities: { tools: true } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const [typesModule, conversationModule, profileModule, pipelineModule, toolModule, llmClientModule, permissionModule, askUserModule, interactionModule] = await Promise.all([
  import('../../types.ts'),
  import('../../store/conversations.ts'),
  import('../server-profiles/index.ts'),
  import('./orchestrator.ts'),
  import('../tool-engine/index.ts'),
  import('../llm-client/index.ts'),
  import('../../ui/tools/ToolPermissionModal.tsx'),
  import('../../ui/tools/AskUserModal.tsx'),
  import('./interaction-coordinator.ts'),
]);
const { DEFAULT_PARAMS } = typesModule;
const {
  finalizeStreamingOwner,
  markStreaming,
  unmarkStreaming,
  useConversations,
} = conversationModule;
const { useAppModels, useProfileStore } = profileModule;
const { runStream, runStreamWithTools, runToolLoop } = pipelineModule;
const { LLMClient } = llmClientModule;
const { HANDLERS_BY_NAME } = toolModule;
const { registerPermissionHandler } = permissionModule;
const { registerAskUserHandler } = askUserModule;
const { enqueueGenerationInteraction } = interactionModule;

after(() => {
  globalThis.fetch = originalFetch;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

describe('Gemini native tool-loop integration', () => {
  it('persists three stateless native responses and replays two tool rounds in provider order', async () => {
    const fixture = createFixture({ enabled: true });
    const nativeBase = 'https://generativelanguage.googleapis.com/v1beta';
    fixture.profile.apiVariant = 'gemini';
    fixture.profile.baseUrl = nativeBase;
    const initial = useConversations.getState().byId[fixture.conversationId];
    useConversations.setState({ byId: { [fixture.conversationId]: { ...initial, model: 'gemini-3.8-flash' } } });
    const original = HANDLERS_BY_NAME.get('lc_get_current_time')!;
    HANDLERS_BY_NAME.set('lc_get_current_time', { ...original, run: async () => ({ time: 'test', tz: 'UTC' }) });
    const bodies: Array<{ input: Array<Record<string, unknown>> }> = [];
    chatPostResponse = (init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const round = bodies.length;
      const steps = [
        { type: 'thought', signature: `synthetic-signature-${round}` },
        ...(round < 3
          ? (round === 1 ? ['a', 'b'] : ['c']).map((id) => ({ type: 'function_call', id,
            name: 'lc_get_current_time', arguments: {} }))
          : [{ type: 'model_output', content: [{ type: 'text', text: 'Gemini finished' }] }]),
      ];
      const events: Record<string, unknown>[] = [
        { event_type: 'interaction.created', interaction: { id: '', model: 'gemini-3.8-flash', status: 'in_progress' } },
        ...steps.flatMap((step, index) => [
          { event_type: 'step.start', index, step }, { event_type: 'step.stop', index },
        ]),
        { event_type: 'interaction.completed', interaction: { id: '', status: round < 3 ? 'requires_action' : 'completed',
          usage: { total_input_tokens: 100, total_output_tokens: 25, total_thought_tokens: 10, total_tokens: 135 } } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const client = new LLMClient({ baseUrl: nativeBase, apiVariant: 'gemini', routing: 'direct' });
      await runStreamWithTools(fixture.conversationId, new AbortController().signal, {
        ...fixture.options(client), apiVariant: 'gemini', model: 'gemini-3.8-flash',
      });
      const conversation = useConversations.getState().byId[fixture.conversationId];
      const assistant = conversation.messages.find((message) => message.id === fixture.assistantId)!;
      assert.equal(bodies.length, 3, assistant.meta?.error_message ?? 'Expected three provider responses');
      assert.equal(assistant.gemini_interactions?.length, 3);
      assert.equal(new Set(assistant.gemini_interactions!.map((group) => group.responseId)).size, 3);
      assert.equal(assistant.usage?.total_tokens, 405);
      assert.equal(assistant.usage?.reasoning?.tokens, 30);
      assert.equal(assistant.content, 'Gemini finished');
      const replay = bodies[2].input.filter((step) => step.type !== 'user_input');
      assert.deepEqual(replay.map((step) => step.type), [
        'thought', 'function_call', 'function_call', 'function_result', 'function_result',
        'thought', 'function_call', 'function_result',
      ]);
      assert.deepEqual(replay.filter((step) => step.type === 'function_result').map((step) => step.call_id), ['a', 'b', 'c']);
      const { persistedMessageSnapshot } = await import('../../store/db.ts');
      assert.deepEqual(persistedMessageSnapshot(assistant).gemini_interactions, assistant.gemini_interactions);
    } finally {
      chatPostResponse = null;
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });
});

describe('terminal token reconciliation', () => {
  it('counts normal text as one canonical field', () => {
    const normal = new TokenCounter();
    normal.reset();
    normal.feedContent('hel');
    normal.feedContent('lo');
    assert.equal(normal.terminalTokens('hello'), countTokens('hello'));
  });

  it('keeps an oversized canonical estimate independent of provider delta size', () => {
    const canonical = 'hello world '
      .repeat(Math.ceil((300 * 1_024) / 12))
      .slice(0, 300 * 1_024);
    assert.ok(canonical.length > MAX_FULL_TOKEN_TEXT_CHARS);
    const exact = encode(canonical).length;
    const estimates = new Set<number>();
    const liveTotals = new Set<number>();

    for (const deltaChars of [1, 4, 16, 256, 4_096]) {
      const counter = new TokenCounter();
      counter.reset();
      for (let start = 0; start < canonical.length; start += deltaChars) {
        counter.feedContent(canonical.slice(start, start + deltaChars));
      }
      const estimate = counter.terminalTokens(canonical);
      estimates.add(estimate);
      liveTotals.add(counter.totalTokens());
      const relativeError = Math.abs(estimate - exact) / exact;
      assert.ok(
        relativeError < 0.02,
        `${deltaChars}-character deltas produced ${(relativeError * 100).toFixed(2)}% error`,
      );
    }

    assert.equal(estimates.size, 1, 'transport chunking changed the terminal estimate');
    assert.ok(liveTotals.size > 1, 'fixture did not exercise the former per-delta failure');
  });

  it('keeps internal canonical segment boundaries independent of provider deltas', () => {
    const canonical = 'Segmented canonical prose. '
      .repeat(30_000)
      .slice(0, 700 * 1_024);
    const exact = encode(canonical).length;
    const estimates = new Set<number>();

    for (const deltaChars of [257, 4_096, 65_536]) {
      const counter = new TokenCounter();
      counter.reset();
      for (let start = 0; start < canonical.length; start += deltaChars) {
        counter.feedReasoning(canonical.slice(start, start + deltaChars));
      }
      const estimate = counter.terminalTokens('', canonical);
      estimates.add(estimate);
      assert.ok(Math.abs(estimate - exact) / exact < 0.02);
    }

    assert.equal(estimates.size, 1, 'canonical segment accounting changed with deltas');
  });
});

function tools(overrides: Partial<NonNullable<Conversation['tools']>> = {}): NonNullable<Conversation['tools']> {
  return {
    enabled: false,
    tool_grants: [],
    web_access_grants_initialized: true,
    file_io_enabled: false,
    shell_enabled: false,
    web_access_enabled: false,
    allowed_roots: [],
    dir_permissions: {},
    max_tool_rounds_per_turn: 128,
    max_tool_calls_per_batch: 16,
    sse_read_timeout_min: 5,
    ...overrides,
  };
}

interface LifecycleFixture {
  conversationId: string;
  assistantId: string;
  generationId: string;
  profile: ServerProfile;
  finalizations: () => number;
  options: (client: LLMClientType) => Omit<PipelineOptions, 'signal'>;
  cleanup: () => void;
}

function createFixture(toolOverrides: Partial<NonNullable<Conversation['tools']>> = {}): LifecycleFixture {
  const priorConversations = useConversations.getState();
  const priorProfiles = useProfileStore.getState().profiles;
  const priorModels = useAppModels.getState();
  const conversationId = `closure-conversation-${crypto.randomUUID()}`;
  const assistantId = `closure-assistant-${crypto.randomUUID()}`;
  const generationId = `closure-generation-${crypto.randomUUID()}`;
  const profile: ServerProfile = {
    id: `closure-profile-${crypto.randomUUID()}`,
    name: 'closure profile',
    baseUrl: 'http://closure.test/v1',
    active: true,
    apiVariant: 'openai',
    apiStyle: 'chat',
    routing: 'direct',
  };
  const conversation: Conversation = {
    id: conversationId,
    title: 'closure lifecycle',
    serverId: profile.id,
    model: 'closure-model',
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 2,
    messages: [
      { id: `closure-user-${crypto.randomUUID()}`, role: 'user', content: 'test', createdAt: 1 },
      { id: assistantId, role: 'assistant', content: '', createdAt: 2, streaming: true },
    ],
    tools: tools(toolOverrides),
  };
  let finalizeCount = 0;
  const originalFinalizeMessage = priorConversations.finalizeMessage;
  useConversations.setState({
    byId: { [conversationId]: conversation },
    order: [conversationId],
    activeId: conversationId,
    loadingMessageIds: new Set<string>(),
    finalizeMessage: (id, messageId, patch) => {
      const recordsIntermediateToolTurn = patch?.meta?.finish_reason === 'tool_calls'
        && (patch.tool_calls?.length ?? 0) > 0;
      if (!recordsIntermediateToolTurn) finalizeCount++;
      originalFinalizeMessage(id, messageId, patch);
    },
  });
  useProfileStore.setState({ profiles: [profile] });
  useAppModels.setState({ models: [{
    id: 'closure-model',
    displayName: 'closure-model',
    profileId: profile.id,
    profileName: profile.name,
    apiVariant: 'openai',
    apiStyle: 'chat',
    capabilities: { tools: true },
  }] });
  markStreaming(conversationId, assistantId, generationId);

  return {
    conversationId,
    assistantId,
    generationId,
    profile,
    finalizations: () => finalizeCount,
    options: (client) => ({
      convId: conversationId,
      llmClient: client,
      model: 'closure-model',
      profile: { baseUrl: profile.baseUrl, apiKey: '' },
      apiVariant: 'openai',
      apiStyle: 'chat',
      routing: 'direct',
      generationId,
      assistantMessageId: assistantId,
    }),
    cleanup: () => {
      unmarkStreaming(conversationId, generationId);
      useConversations.setState({
        byId: priorConversations.byId,
        order: priorConversations.order,
        activeId: priorConversations.activeId,
        loadingMessageIds: priorConversations.loadingMessageIds,
        finalizeMessage: originalFinalizeMessage,
      });
      useProfileStore.setState({ profiles: priorProfiles });
      useAppModels.setState({
        models: priorModels.models,
        loading: priorModels.loading,
        error: priorModels.error,
        _refreshing: priorModels._refreshing,
        serverHealth: priorModels.serverHealth,
      });
    },
  };
}

function clientWith(chatStream: LLMClientType['chatStream']): LLMClientType {
  return { chatStream } as unknown as LLMClientType;
}

function result(overrides: Partial<StreamResult> = {}): StreamResult {
  return {
    content: '',
    refusal: '',
    finish_reason: 'stop',
    ...overrides,
  };
}

function stopStreamResponse(content = 'done'): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode([
        `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n')));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

for (const historyEnabled of [false, true]) {
  it(`attaches reused image call IDs to the current turn with Tool History ${historyEnabled ? 'enabled' : 'disabled'}`, async () => {
    const fixture = createFixture({
      enabled: true, file_io_enabled: true, tool_history_enabled: historyEnabled,
      allowed_roots: ['D:/images'], dir_permissions: { 'D:/images': ['lc_read_image'] },
    });
    const original = HANDLERS_BY_NAME.get('lc_read_image');
    assert.ok(original);
    const callId = 'reused-image-call';
    const oldContent = '{"images":[],"warning":null}';
    const current = useConversations.getState().byId[fixture.conversationId]!;
    useConversations.setState({
      byId: {
        ...useConversations.getState().byId,
        [fixture.conversationId]: {
          ...current,
          messages: [
            { id: 'prior-image-user', role: 'user', content: 'previous question', createdAt: 0 },
            {
              id: 'prior-image-assistant', role: 'assistant', content: '', createdAt: 0,
              tool_calls: [{ id: callId, name: 'lc_read_image', arguments: '{"paths":["D:/images/old.png"]}', created_at: 0 }],
            },
            { id: 'prior-image-result', role: 'tool', tool_call_id: callId, content: oldContent, createdAt: 0 },
            ...current.messages,
          ],
        },
      },
    });
    useAppModels.getState().setMetadataOverride(fixture.profile.id, 'closure-model', { v: true });
    HANDLERS_BY_NAME.set('lc_read_image', {
      ...original,
      run: (input, ctx) => original.run(input, {
        ...ctx,
        sandbox: {
          ...ctx.sandbox,
          readImage: async () => ({ images: [{
            path: 'D:/images/current.png', mime: 'image/png', data_url: 'data:image/png;base64,AAAA',
            size_bytes: 3, original_size_bytes: 3, encoding: 'original', truncated: false,
          }] }),
        },
      }),
    });
    let wireMessages: ChatMessage[] = [];
    chatPostResponse = (init) => {
      wireMessages = JSON.parse(String(init?.body)).messages;
      return stopStreamResponse();
    };
    try {
      await runStreamWithTools(fixture.conversationId, new AbortController().signal, fixture.options(clientWith(async () => result({
        finish_reason: 'tool_calls',
        tool_calls: [{ id: callId, type: 'function', function: {
          name: 'lc_read_image', arguments: '{"paths":["D:/images/current.png"]}',
        } }],
      }))));
      const imageTurns = wireMessages.flatMap((message, index) =>
        Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url') ? [index] : []);
      assert.equal(imageTurns.length, 1);
      const currentResultIndex = wireMessages.findLastIndex((message) =>
        message.role === 'tool' && message.tool_call_id === callId);
      assert.ok(imageTurns[0] > currentResultIndex, 'current pixels must follow the current tool result, not its historical ID collision');
      const persisted = useConversations.getState().byId[fixture.conversationId]!.messages;
      assert.equal(persisted.find((message) => message.id === 'prior-image-result')?.content, oldContent);
      for (const message of persisted) assert.doesNotMatch(message.content, /_image_batch_id|images_delivered|data:image/);
    } finally {
      useAppModels.getState().removeMetadataOverride(fixture.profile.id, 'closure-model');
      chatPostResponse = null;
      HANDLERS_BY_NAME.set('lc_read_image', original);
      fixture.cleanup();
    }
  });
}

it('reports a removed profile to legacy callers instead of returning silently', async () => {
  const fixture = createFixture();
  let streamCalls = 0;
  let reported: { message: string; aborted: boolean } | undefined;
  useProfileStore.setState({ profiles: [] });
  try {
    await runStream({
      ...fixture.options(clientWith(async () => {
        streamCalls += 1;
        return result();
      })),
      signal: new AbortController().signal,
      callbacks: {
        onDelta: () => undefined,
        onReasoning: () => undefined,
        onDone: () => undefined,
        onError: (message, aborted) => { reported = { message, aborted }; },
      },
      tokenCounter: new TokenCounter(),
    });

    assert.deepEqual(reported, {
      message: 'Server profile is gone. Pick another from settings.',
      aborted: false,
    });
    assert.equal(streamCalls, 0);
  } finally {
    fixture.cleanup();
  }
});

it('sends a second user turn when Workspace tools are disabled', async () => {
  const fixture = createFixture();
  const current = useConversations.getState().byId[fixture.conversationId];
  assert.ok(current);
  const streamingAssistant = current.messages.at(-1);
  assert.ok(streamingAssistant?.streaming);
  useConversations.setState((state) => ({
    byId: {
      ...state.byId,
      [fixture.conversationId]: {
        ...current,
        messageCount: 4,
        messages: [
          { id: 'prior-user', role: 'user', content: 'hello', createdAt: 1 },
          { id: 'prior-assistant', role: 'assistant', content: 'hi', createdAt: 2 },
          { id: 'current-user', role: 'user', content: 'follow up', createdAt: 3 },
          streamingAssistant,
        ],
      },
    },
  }));
  let sentMessages: ChatMessage[] | undefined;
  try {
    await runStream({
      ...fixture.options(clientWith(async (params) => {
        sentMessages = params.messages;
        return result({ content: 'done' });
      })),
      signal: new AbortController().signal,
      callbacks: {
        onDelta: () => undefined,
        onReasoning: () => undefined,
        onDone: () => undefined,
        onError: () => undefined,
      },
      tokenCounter: new TokenCounter(),
    });

    assert.deepEqual(sentMessages?.map((message) => [message.role, message.content]), [
      ['user', 'hello'],
      ['assistant', 'hi'],
      ['user', 'follow up'],
    ]);
  } finally {
    fixture.cleanup();
  }
});

it('carries the recorded Messages block order through request assembly', async () => {
  const fixture = createFixture();
  const current = useConversations.getState().byId[fixture.conversationId];
  assert.ok(current);
  const streamingAssistant = current.messages.at(-1);
  assert.ok(streamingAssistant?.streaming);
  const recordedOrder: NonNullable<ChatMessage['anthropic_block_order']> = [
    { kind: 'text', index: 0, text: 'Looking into it.' },
    { kind: 'thinking', index: 1 },
  ];
  useConversations.setState((state) => ({
    byId: {
      ...state.byId,
      [fixture.conversationId]: {
        ...current,
        messageCount: 3,
        messages: [
          { id: 'order-user', role: 'user', content: 'inspect this', createdAt: 1 },
          {
            id: 'order-assistant',
            role: 'assistant',
            content: 'Looking into it.',
            createdAt: 2,
            meta: { baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3-contributor' },
            anthropic_output_blocks: [{ type: 'thinking', thinking: 'plan' }],
            anthropic_block_order: recordedOrder,
          },
          streamingAssistant,
        ],
      },
    },
  }));
  let sentMessages: ChatMessage[] | undefined;
  try {
    await runStream({
      ...fixture.options(clientWith(async (params) => {
        sentMessages = params.messages;
        return result({ content: 'done' });
      })),
      profile: { baseUrl: 'https://api.meta.ai/v1', apiKey: '' },
      model: 'muse-spark-1.3-contributor',
      apiVariant: 'anthropic',
      signal: new AbortController().signal,
      callbacks: {
        onDelta: () => undefined,
        onReasoning: () => undefined,
        onDone: () => undefined,
        onError: () => undefined,
      },
      tokenCounter: new TokenCounter(),
    });

    const priorAssistant = sentMessages?.find((message) => message.role === 'assistant');
    assert.ok(priorAssistant, 'assembled request keeps the prior assistant turn');
    assert.deepEqual(priorAssistant.anthropic_block_order, recordedOrder);
  } finally {
    fixture.cleanup();
  }
});

async function abortAtNormalizedDelta(kind: 'reasoning' | 'text'): Promise<void> {
  const fixture = createFixture();
  const controller = new AbortController();
  let reached!: () => void;
  const deltaReached = new Promise<void>((resolve) => { reached = resolve; });
  const client = clientWith(async (_params, callbacks, signal) => {
    if (kind === 'reasoning') callbacks.onReasoning?.('controlled reasoning');
    else callbacks.onDelta('controlled text');
    reached();
    return new Promise<StreamResult>((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  });

  try {
    const running = runStreamWithTools(fixture.conversationId, controller.signal, fixture.options(client));
    await deltaReached;
    controller.abort();
    await running;

    const assistant = useConversations.getState().byId[fixture.conversationId]
      ?.messages.find((message) => message.id === fixture.assistantId);
    assert.equal(fixture.finalizations(), 1);
    assert.equal(assistant?.meta?.finish_reason, 'disconnected');
    assert.equal(finalizeStreamingOwner(fixture.conversationId, fixture.generationId), false);
  } finally {
    fixture.cleanup();
  }
}

for (const toolHistoryEnabled of [false, true]) {
  it(`provider request ${toolHistoryEnabled ? 'archives' : 'retains'} prior tool results when Tool History is ${toolHistoryEnabled ? 'enabled' : 'disabled'}`, async () => {
    const fixture = createFixture({
      enabled: true,
      tool_history_enabled: toolHistoryEnabled,
    });
    const current = useConversations.getState().byId[fixture.conversationId];
    assert.ok(current);
    useConversations.setState((state) => ({
      byId: {
        ...state.byId,
        [fixture.conversationId]: {
          ...current,
          messageCount: 8,
          messages: [
            { id: 'history-user', role: 'user', content: 'inspect', createdAt: 1 },
            {
              id: 'history-assistant',
              role: 'assistant',
              content: '',
              reasoning: 'flattened display reasoning must not be sent',
              createdAt: 2,
              tool_calls: [
                { created_at: 0, id: 'history-call', name: 'lc_get_current_time', arguments: '{}' },
                {
                  created_at: 0,
                  id: 'history-whiteboard-call',
                  name: 'lc_whiteboard',
                  arguments: JSON.stringify({
                    action: 'replace',
                    content: '# Full historical model content',
                  }),
                },
              ],
            },
            {
              id: 'history-result',
              role: 'tool',
              content: 'full historical output',
              createdAt: 3,
              tool_call_id: 'history-call',
            },
            {
              id: 'history-whiteboard-result',
              role: 'tool',
              content: JSON.stringify({
                user_markdown: '# Full historical user content',
                model_markdown: '# Full historical model content',
              }),
              createdAt: 4,
              tool_call_id: 'history-whiteboard-call',
            },
            { id: 'current-user', role: 'user', content: 'continue', createdAt: 5 },
            {
              id: 'active-whiteboard-assistant',
              role: 'assistant',
              content: '',
              createdAt: 6,
              tool_calls: [{
                created_at: 0,
                id: 'active-whiteboard-call',
                name: 'lc_whiteboard',
                arguments: JSON.stringify({ action: 'replace', content: '# Active model content' }),
              }],
            },
            {
              id: 'active-whiteboard-result',
              role: 'tool',
              content: JSON.stringify({
                user_markdown: '# Active user content',
                model_markdown: '# Active model content',
              }),
              createdAt: 7,
              tool_call_id: 'active-whiteboard-call',
            },
            { id: fixture.assistantId, role: 'assistant', content: '', createdAt: 8, streaming: true },
          ],
        },
      },
    }));
    let requestMessages: ChatMessage[] | undefined;
    const client = clientWith(async (params) => {
      requestMessages = params.messages;
      return result({ content: 'done' });
    });

    try {
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        fixture.options(client),
      );

      assert.ok(requestMessages);
      const historicalAssistant = requestMessages.find((message) =>
        message.role === 'assistant'
        && message.tool_calls?.some((call) => call.id !== 'active-whiteboard-call'));
      const historicalResults = requestMessages.filter((message) => message.role === 'tool');
      if (toolHistoryEnabled) {
        assert.equal(historicalAssistant?.tool_calls?.[0]?.function.name, 'lc_tool_history');
        assert.equal(historicalAssistant?.tool_calls?.length, 1);
        assert.match(String(historicalResults[0]?.content), /2 tool result\(s\).*archived/i);
        assert.doesNotMatch(
          JSON.stringify(requestMessages),
          /full historical output|Full historical (?:model|user) content/,
        );
      } else {
        assert.equal(historicalAssistant?.tool_calls?.[0]?.id, 'history-call');
        assert.equal(historicalAssistant?.tool_calls?.[1]?.id, 'history-whiteboard-call');
        assert.deepEqual(
          JSON.parse(historicalAssistant?.tool_calls?.[1]?.function.arguments ?? ''),
          { action: 'replace', content: '# Full historical model content' },
        );
        assert.equal(historicalResults[0]?.tool_call_id, 'history-call');
        assert.equal(historicalResults[0]?.content, 'full historical output');
        assert.equal(historicalResults[1]?.tool_call_id, 'history-whiteboard-call');
        assert.deepEqual(JSON.parse(String(historicalResults[1]?.content)), {
          user_markdown: '# Full historical user content',
          model_markdown: '# Full historical model content',
        });
      }
      const activeAssistant = requestMessages.find((message) =>
        message.role === 'assistant'
        && message.tool_calls?.some((call) => call.id === 'active-whiteboard-call'));
      const activeResult = requestMessages.find((message) =>
        message.role === 'tool' && message.tool_call_id === 'active-whiteboard-call');
      assert.deepEqual(JSON.parse(activeAssistant?.tool_calls?.[0]?.function.arguments ?? ''), {
        action: 'replace',
        content: '# Active model content',
      });
      assert.deepEqual(JSON.parse(String(activeResult?.content)), {
        user_markdown: '# Active user content',
        model_markdown: '# Active model content',
      });
      const canonical = useConversations.getState().byId[fixture.conversationId]?.messages;
      assert.match(JSON.stringify(canonical), /full historical output/);
      assert.match(JSON.stringify(canonical), /Full historical model content/);
      assert.match(JSON.stringify(canonical), /Full historical user content/);
    } finally {
      fixture.cleanup();
    }
  });
}

describe('Stop lifecycle matrix', () => {
  it('Stop during reasoning has one terminal transition', async () => {
    await abortAtNormalizedDelta('reasoning');
  });

  it('Stop during visible text has one terminal transition', async () => {
    await abortAtNormalizedDelta('text');
  });

  it('Stop cancels an already-running native handler without persisting its late result', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
    });
    const controller = new AbortController();
    const original = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(original);
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...original,
      run: async (_input, context) => {
        started();
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (context.signal.aborted) abort();
          else context.signal.addEventListener('abort', abort, { once: true });
        });
      },
    });

    try {
      const loop = runToolLoop(
        fixture.conversationId,
        [{ created_at: 0, id: 'native-stop-call', name: 'lc_get_current_time', arguments: '{}' }],
        controller.signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );
      await handlerStarted;
      controller.abort();
      assert.equal(finalizeStreamingOwner(fixture.conversationId, fixture.generationId, {
        meta: { finish_reason: 'disconnected' },
      }), true);
      const outcome = await loop;

      assert.equal(outcome.stopReason, 'aborted');
      assert.equal(fixture.finalizations(), 1);
      const toolResults = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.tool_call_id === 'native-stop-call') ?? [];
      // The late completion must not be trusted as a success. A terminal,
      // non-replayed aborted result is persisted instead so the durable
      // graph has no unanswered tool_call_id.
      assert.equal(toolResults.length, 1);
      assert.ok(toolResults[0].tool_is_error);
      assert.match(toolResults[0].content, /"status":"aborted"/);
    } finally {
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });

  it('Stop after an eager tool result prevents the re-stream and finalizes once', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
    });
    const controller = new AbortController();
    const unsubscribe = useConversations.subscribe((state) => {
      const hasResult = state.byId[fixture.conversationId]?.messages
        .some((message) => message.tool_call_id === 'eager-stop-call');
      if (hasResult && !controller.signal.aborted) controller.abort();
    });

    try {
      const outcome = await runToolLoop(
        fixture.conversationId,
        [{ created_at: 0, id: 'eager-stop-call', name: 'lc_get_current_time', arguments: '{}' }],
        controller.signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options(clientWith(async () => {
          throw new Error('re-stream must not start after Stop');
        })),
        { current: new Set<string>() },
      );
      assert.equal(outcome.stopReason, 'aborted');
      assert.equal(finalizeStreamingOwner(fixture.conversationId, fixture.generationId, {
        meta: { finish_reason: 'disconnected' },
      }), true);
      assert.equal(fixture.finalizations(), 1);
      assert.equal(
        useConversations.getState().byId[fixture.conversationId]?.messages
          .filter((message) => message.tool_call_id === 'eager-stop-call').length,
        1,
      );
    } finally {
      unsubscribe();
      fixture.cleanup();
    }
  });

  it('provider disconnect/error has one terminal transition', async () => {
    const fixture = createFixture();
    const client = clientWith(async () => {
      throw new Error('controlled disconnect');
    });
    try {
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        fixture.options(client),
      );
      const assistant = useConversations.getState().byId[fixture.conversationId]
        ?.messages.find((message) => message.id === fixture.assistantId);
      assert.equal(fixture.finalizations(), 1);
      assert.equal(assistant?.meta?.finish_reason, 'error');
      assert.match(assistant?.meta?.error_message ?? '', /controlled disconnect/);
    } finally {
      fixture.cleanup();
    }
  });

  it('Stop mid-batch answers every accepted tool_call id with a terminal row, even when a handler ignores its abort signal', { timeout: 10_000 }, async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
    });
    const controller = new AbortController();
    const original = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(original);
    let hangStarted!: () => void;
    const hangStartedPromise = new Promise<void>((resolve) => { hangStarted = resolve; });
    let executions = 0;
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...original,
      run: async () => {
        executions++;
        if (executions === 1) return { time: 'fast', tz: 'UTC', unix_ms: 1 };
        hangStarted();
        // Deliberately ignores the abort signal — the pool can never settle.
        return new Promise<never>(() => {});
      },
    });

    try {
      const loop = runToolLoop(
        fixture.conversationId,
        [
          { created_at: 0, id: 'abort-fast', name: 'lc_get_current_time', arguments: '{}' },
          { created_at: 0, id: 'abort-hang', name: 'lc_get_current_time', arguments: '{}' },
        ],
        controller.signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );
      await hangStartedPromise;
      controller.abort();
      finalizeStreamingOwner(fixture.conversationId, fixture.generationId, {
        meta: { finish_reason: 'disconnected' },
      });
      const outcome = await loop;
      assert.equal(outcome.stopReason, 'aborted');
      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.role === 'tool') ?? [];
      assert.deepEqual(
        results.map((message) => message.tool_call_id).sort(),
        ['abort-fast', 'abort-hang'],
        'every accepted call id must be answered exactly once',
      );
      for (const message of results) {
        assert.ok(message.tool_is_error);
        assert.match(message.content, /"status":"aborted"/);
      }
    } finally {
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });

  it('duplicate tool_call ids in one batch execute once and persist one result', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
    });
    const original = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(original);
    let executions = 0;
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...original,
      run: async () => {
        executions++;
        return { time: 'fast', tz: 'UTC', unix_ms: executions };
      },
    });

    try {
      await runToolLoop(
        fixture.conversationId,
        [
          { created_at: 0, id: 'dup-id', name: 'lc_get_current_time', arguments: '{}' },
          { created_at: 0, id: 'dup-id', name: 'lc_get_current_time', arguments: '{}' },
        ],
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );
      assert.equal(executions, 1, 'a duplicate id must not run twice');
      const assistant = useConversations.getState().byId[fixture.conversationId]
        ?.messages.find((message) => message.id === fixture.assistantId);
      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.role === 'tool') ?? [];
      // The provider protocol has one result slot per id: the persisted graph
      // must hold exactly one call and one result for the id.
      assert.equal(assistant?.tool_calls?.filter((call) => call.id === 'dup-id').length, 1);
      assert.equal(results.filter((message) => message.tool_call_id === 'dup-id').length, 1);
      const result = results.find((message) => message.tool_call_id === 'dup-id');
      assert.ok(result);
      assert.ok(!result.tool_is_error, 'the surviving row is the real execution');
      assert.match(result.content, /did not execute later duplicates/);
    } finally {
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });

  it('keeps duplicate-id notices on the current generation when a prior turn reused the id', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
    });
    const original = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(original);
    const oldContent = '{"status":"ok","data":{"time":"prior generation"}}';
    const current = useConversations.getState().byId[fixture.conversationId]!;
    useConversations.setState({
      byId: {
        ...useConversations.getState().byId,
        [fixture.conversationId]: {
          ...current,
          messages: [
            { id: 'prior-user', role: 'user', content: 'prior turn', createdAt: 0 },
            {
              id: 'prior-assistant', role: 'assistant', content: '', createdAt: 0,
              tool_calls: [{ created_at: 0, id: 'reused-id', name: 'lc_get_current_time', arguments: '{}' }],
            },
            { id: 'prior-result', role: 'tool', tool_call_id: 'reused-id', content: oldContent, createdAt: 0 },
            ...current.messages,
          ],
        },
      },
    });
    const completed: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...original,
      run: async (_input, ctx) => {
        if (ctx.identity.modelToolCallId === 'reused-id') await slowGate;
        else releaseSlow();
        completed.push(ctx.identity.modelToolCallId);
        return { time: 'current', tz: 'UTC', unix_ms: 1 };
      },
    });

    try {
      await runToolLoop(
        fixture.conversationId,
        [
          { created_at: 0, id: 'reused-id', name: 'lc_get_current_time', arguments: '{}' },
          { created_at: 0, id: 'reused-id', name: 'lc_get_current_time', arguments: '{}' },
          { created_at: 0, id: 'fast-sibling', name: 'lc_get_current_time', arguments: '{}' },
        ],
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );
      assert.deepEqual(completed, ['fast-sibling', 'reused-id']);
      const messages = useConversations.getState().byId[fixture.conversationId]!.messages;
      assert.equal(messages.find((message) => message.id === 'prior-result')?.content, oldContent);
      const currentResults = messages.filter((message) =>
        message.role === 'tool' && message.id !== 'prior-result');
      assert.equal(currentResults.length, 2);
      const duplicateResult = currentResults.find((message) => message.tool_call_id === 'reused-id');
      assert.ok(duplicateResult);
      assert.match(duplicateResult.content, /did not execute later duplicates/);
    } finally {
      releaseSlow();
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });
  it('keeps the duplicate-id notice when the surviving call fails before execution', async () => {
    const fixture = createFixture({ enabled: true });

    try {
      await runToolLoop(
        fixture.conversationId,
        [
          { created_at: 0, id: 'duplicate-invalid-id', name: 'lc_unknown_tool', arguments: '{}' },
          { created_at: 0, id: 'duplicate-invalid-id', name: 'lc_unknown_tool', arguments: '{}' },
        ],
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );

      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.role === 'tool') ?? [];
      assert.equal(results.length, 1);
      assert.equal(results[0].tool_call_id, 'duplicate-invalid-id');
      assert.match(results[0].content, /did not execute later duplicates/);
      const decoded = decodeLcResultJson(results[0].content);
      assert.equal((decoded?.data as { issues?: Array<{ code?: string }> })?.issues?.[0]?.code, 'unknown_tool');
    } finally {
      fixture.cleanup();
    }
  });

  it('fences three concurrent tool loops and a replacement from a retired worker', { timeout: 5_000 }, async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
    });
    const original = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(original);
    const template = useConversations.getState().byId[fixture.conversationId]!;
    const owners = [
      { convId: fixture.conversationId, generationId: fixture.generationId, assistantMessageId: fixture.assistantId },
      ...[1, 2].map((index) => ({
        convId: `parallel-conversation-${index}-${crypto.randomUUID()}`,
        generationId: `parallel-generation-${index}`,
        assistantMessageId: `parallel-assistant-${index}`,
      })),
    ];
    for (const owner of owners.slice(1)) {
      useConversations.setState((state) => ({
        byId: {
          ...state.byId,
          [owner.convId]: {
            ...template,
            id: owner.convId,
            messages: [
              { id: `user-${owner.convId}`, role: 'user', content: 'test', createdAt: 1 },
              { id: owner.assistantMessageId, role: 'assistant', content: '', streaming: true, createdAt: 2 },
            ],
          },
        },
      }));
      markStreaming(owner.convId, owner.assistantMessageId, owner.generationId);
    }
    const controls = owners.map(() => new AbortController());
    const gates = new Map(owners.map((owner) => [owner.generationId, Promise.withResolvers<void>()]));
    const started = Promise.withResolvers<void>();
    const lateReturned = Promise.withResolvers<void>();
    const executions: string[] = [];
    const completions: string[] = [];
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...original,
      run: async (_input, ctx) => {
        const generation = ctx.identity.generationId;
        executions.push(generation);
        if (executions.length === 3) started.resolve();
        await gates.get(generation)?.promise;
        completions.push(generation);
        if (generation === owners[1].generationId) lateReturned.resolve();
        return { time: generation, tz: 'UTC', unix_ms: 1 };
      },
    });
    const startLoop = (owner: typeof owners[number], signal: AbortSignal) => {
      useConversations.getState().patchMessage(owner.convId, owner.assistantMessageId, {
        tool_calls: [{ created_at: 0, id: 'shared-provider-id', name: 'lc_get_current_time', arguments: '{}' }],
      });
      return runToolLoop(
        owner.convId,
        [{ created_at: 0, id: 'shared-provider-id', name: 'lc_get_current_time', arguments: '{}' }],
        signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        { ...fixture.options({} as LLMClientType), ...owner },
        { current: new Set<string>() },
      );
    };
    const replacement = {
      ...owners[1],
      generationId: 'replacement-generation',
      assistantMessageId: 'replacement-assistant',
    };
    chatPostResponse = () => stopStreamResponse();

    try {
      const loops = owners.map((owner, index) => startLoop(owner, controls[index].signal));
      await started.promise;
      assert.equal(new Set(executions).size, 3);
      controls[1].abort();
      finalizeStreamingOwner(owners[1].convId, owners[1].generationId);
      assert.equal((await loops[1]).stopReason, 'aborted');
      unmarkStreaming(owners[1].convId, owners[1].generationId);
      const middleBefore = useConversations.getState().byId[owners[1].convId]!.messages;
      const repaired = middleBefore.find((message) => message.role === 'tool');
      assert.ok(repaired);
      assert.match(repaired.content, /"status":"aborted"/);
      useConversations.getState().appendMessage(replacement.convId, {
        role: 'user', content: 'retry',
      });
      const replacementAssistant = useConversations.getState().appendMessage(replacement.convId, {
        role: 'assistant', content: '', streaming: true,
      });
      assert.ok(replacementAssistant);
      replacement.assistantMessageId = replacementAssistant.id;
      markStreaming(replacement.convId, replacement.assistantMessageId, replacement.generationId);
      await startLoop(replacement, new AbortController().signal);

      gates.get(owners[2].generationId)!.resolve();
      await loops[2];
      gates.get(owners[0].generationId)!.resolve();
      await loops[0];
      gates.get(owners[1].generationId)!.resolve();
      await lateReturned.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.deepEqual(completions, [
        replacement.generationId, owners[2].generationId, owners[0].generationId, owners[1].generationId,
      ]);
      for (const owner of [owners[0], owners[2]]) {
        const results = useConversations.getState().byId[owner.convId]!.messages
          .filter((message) => message.role === 'tool');
        assert.equal(results.length, 1);
        assert.equal((decodeLcResultJson(results[0].content)?.data as { time: string }).time, owner.generationId);
      }
      const middleResults = useConversations.getState().byId[replacement.convId]!.messages
        .filter((message) => message.role === 'tool');
      assert.equal(middleResults.length, 2);
      assert.equal(middleResults[0].content, repaired.content);
      assert.equal(
        (decodeLcResultJson(middleResults[1].content)?.data as { time: string }).time,
        replacement.generationId,
      );
    } finally {
      for (const control of controls) control.abort();
      for (const gate of gates.values()) gate.resolve();
      for (const owner of [...owners, replacement]) unmarkStreaming(owner.convId, owner.generationId);
      chatPostResponse = null;
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });
  it('same-scope prompted calls share one modal but retain distinct execution groups', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: [],
    });
    const original = HANDLERS_BY_NAME.get('lc_web_search');
    assert.ok(original);
    const groupIds: string[] = [];
    let popupCount = 0;
    let presentedConversationTitle = '';
    let presentedModelId = '';
    HANDLERS_BY_NAME.set('lc_web_search', {
      ...original,
      run: async (_input, context) => {
        groupIds.push(context.identity.groupId);
        return { query: 'permission fixture', results: [] };
      },
    });
    const unregister = registerPermissionHandler(async (_call, _dirs, _signal, presentation) => {
      popupCount += 1;
      presentedConversationTitle = presentation?.conversationTitle ?? '';
      presentedModelId = presentation?.modelId ?? '';
      return { decision: 'allow_session', grantedDirs: [] };
    });

    try {
      await runToolLoop(
        fixture.conversationId,
        [
          { created_at: 0, id: 'prompt-group-a', name: 'lc_web_search', arguments: '{"query":"permission fixture"}' },
          { created_at: 0, id: 'prompt-group-b', name: 'lc_web_search', arguments: '{"query":"permission fixture"}' },
        ],
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );

      assert.equal(popupCount, 1, 'matching conversation-scoped calls share one decision');
      assert.equal(presentedConversationTitle, 'closure lifecycle');
      assert.equal(presentedModelId, 'closure-model');
      assert.equal(groupIds.length, 2);
      assert.ok(groupIds.every(Boolean), 'prompt handling must not replace identity with the empty base context');
      assert.equal(new Set(groupIds).size, 2, 'each model tool call keeps its own native cancellation group');
    } finally {
      unregister();
      HANDLERS_BY_NAME.set('lc_web_search', original);
      fixture.cleanup();
    }
  });

  it('same-scope allow-once decisions authorize one logical call each', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: [],
    });
    const original = HANDLERS_BY_NAME.get('lc_web_search');
    assert.ok(original);
    let executions = 0;
    let popupCount = 0;
    HANDLERS_BY_NAME.set('lc_web_search', {
      ...original,
      run: async () => {
        executions += 1;
        return { query: 'permission fixture', results: [] };
      },
    });
    const unregister = registerPermissionHandler(async () => {
      popupCount += 1;
      const shownAt = Date.now();
      if (popupCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      return { decision: 'allow_once', grantedDirs: [], shownAt };
    });

    try {
      await runToolLoop(
        fixture.conversationId,
        [
          { created_at: 0, id: 'allow-once-a', name: 'lc_web_search', arguments: '{"query":"permission fixture"}' },
          { created_at: 0, id: 'allow-once-b', name: 'lc_web_search', arguments: '{"query":"permission fixture"}' },
        ],
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );

      assert.equal(popupCount, 2, 'allow_once cannot authorize a sibling logical call');
      assert.equal(executions, 2);
      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.role === 'tool') ?? [];
      const audits = results.map((message) => message.tool_permission);
      assert.equal(audits.length, 2);
      assert.ok(audits.every((audit) => audit?.decision === 'allow_once'));
      assert.equal(new Set(audits.map((audit) => audit?.prompt_id)).size, 2);
      assert.deepEqual(
        new Set(audits.map((audit) => audit?.displayed_call.tool_call_id)),
        new Set(['allow-once-a', 'allow-once-b']),
      );
      const auditsByCall = new Map(audits.map((audit) => [audit?.displayed_call.tool_call_id, audit]));
      const secondAudit = auditsByCall.get('allow-once-b');
      assert.ok(secondAudit?.shown_at != null);
      assert.ok(
        secondAudit.shown_at - secondAudit.requested_at >= 30,
        'the queued call audit must include time spent behind the first allow-once popup',
      );
    } finally {
      unregister();
      HANDLERS_BY_NAME.set('lc_web_search', original);
      fixture.cleanup();
    }
  });

  it('an unanswered permission prompt is dismissed by the round deadline', { timeout: 5_000 }, async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: [],
      sse_read_timeout_min: 0.001,
    });
    const original = HANDLERS_BY_NAME.get('lc_web_search');
    assert.ok(original);
    let executions = 0;
    let popupCount = 0;
    HANDLERS_BY_NAME.set('lc_web_search', {
      ...original,
      run: async () => {
        executions += 1;
        return { query: 'permission fixture', results: [] };
      },
    });
    const unregister = registerPermissionHandler(async () => {
      popupCount += 1;
      return new Promise<never>(() => {});
    });

    try {
      const outcome = await runToolLoop(
        fixture.conversationId,
        [{ created_at: 0, id: 'permission-deadline', name: 'lc_web_search', arguments: '{"query":"permission fixture"}' }],
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );

      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.tool_call_id === 'permission-deadline') ?? [];
      assert.equal(outcome.stopReason, 'tool_timeout');
      assert.equal(popupCount, 1);
      assert.equal(executions, 0);
      assert.equal(results.length, 1);
      assert.match(results[0].content, /"status":"timeout"/);
    } finally {
      unregister();
      HANDLERS_BY_NAME.set('lc_web_search', original);
      fixture.cleanup();
    }
  });

  it('excludes application FIFO wait from a permission round deadline', { timeout: 5_000 }, async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: [],
      sse_read_timeout_min: 0.001,
    });
    const original = HANDLERS_BY_NAME.get('lc_web_search');
    assert.ok(original);
    let executions = 0;
    let popupCount = 0;
    let releaseBlocker: ((value: string) => void) | undefined;
    HANDLERS_BY_NAME.set('lc_web_search', {
      ...original,
      run: async () => {
        executions += 1;
        return { query: 'permission fixture', results: [] };
      },
    });
    const blocker = enqueueGenerationInteraction({
      identity: {
        interactionId: 'deadline-blocker',
        conversationId: 'other-conversation',
        conversationTitle: 'Other conversation',
        generationId: 'other-generation',
        assistantMessageId: 'other-assistant',
        toolCallId: 'other-call',
        kind: 'ask-user' as const,
        requestedAt: Date.now(),
      },
      signal: new AbortController().signal,
      validateOwnership: () => true,
      present: () => new Promise<string>((resolve) => { releaseBlocker = resolve; }),
      abortedResult: () => 'aborted',
      unavailableResult: () => 'unavailable',
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const unregister = registerPermissionHandler(async () => {
      popupCount += 1;
      return { decision: 'allow_once', grantedDirs: [] };
    });
    chatPostResponse = () => stopStreamResponse();

    try {
      const loop = runToolLoop(
        fixture.conversationId,
        [{ created_at: 0, id: 'permission-queued', name: 'lc_web_search', arguments: '{"query":"permission fixture"}' }],
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(popupCount, 0);
      assert.equal(executions, 0);
      releaseBlocker?.('released');
      assert.equal(await blocker, 'released');

      const outcome = await loop;
      assert.notEqual(outcome.stopReason, 'tool_timeout');
      assert.equal(popupCount, 1);
      assert.equal(executions, 1);
      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.tool_call_id === 'permission-queued') ?? [];
      assert.equal(results.length, 1);
      assert.doesNotMatch(results[0].content, /"status":"timeout"/);
    } finally {
      releaseBlocker?.('released');
      chatPostResponse = null;
      unregister();
      HANDLERS_BY_NAME.set('lc_web_search', original);
      fixture.cleanup();
    }
  });

  for (const decision of ['allow_session', 'allow_once'] as const) {
    it(`credits shared FIFO wait to every same-scope research call after ${decision}`, { timeout: 5_000 }, async () => {
      const fixture = createFixture({
        enabled: true,
        web_access_enabled: true,
        tool_grants: [],
        sse_read_timeout_min: 0.002,
      });
      const original = HANDLERS_BY_NAME.get('lc_web_research');
      assert.ok(original);
      let searches = 0;
      let popupCount = 0;
      const releaseBlocker = Promise.withResolvers<string>();
      const blockerController = new AbortController();
      HANDLERS_BY_NAME.set('lc_web_research', {
        ...original,
        run: (input, context) => original.run(input, {
          ...context,
          config: {
            ...context.config,
            searchProvider: { provider: 'brave', apiKey: 'fixture-key', baseUrl: '' },
          },
          sandbox: {
            ...context.sandbox,
            webSearch: async () => {
              searches += 1;
              return { source: 'brave', results: [] };
            },
          },
        }),
      });
      const blocker = enqueueGenerationInteraction({
        identity: {
          interactionId: 'shared-deadline-blocker',
          conversationId: 'other-conversation',
          conversationTitle: 'Other conversation',
          generationId: 'other-generation',
          assistantMessageId: 'other-assistant',
          toolCallId: 'other-call',
          kind: 'ask-user',
          requestedAt: Date.now(),
        },
        signal: blockerController.signal,
        validateOwnership: () => true,
        present: () => releaseBlocker.promise,
        abortedResult: () => 'aborted',
        unavailableResult: () => 'unavailable',
      });
      const unregister = registerPermissionHandler(async () => {
        popupCount += 1;
        return { decision, grantedDirs: [] };
      });
      chatPostResponse = () => stopStreamResponse();

      try {
        const loop = runToolLoop(
          fixture.conversationId,
          ['research-a', 'research-b', 'research-c'].map((id) => ({
            created_at: 0, id, name: 'lc_web_research', arguments: '{"query":"shared permission"}',
          })),
          new AbortController().signal,
          { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
          { current: 'closure-model' },
          { current: undefined },
          fixture.options({} as LLMClientType),
          { current: new Set<string>() },
        );
        // The FIFO wait exceeds the whole operational budget.
        await new Promise((resolve) => setTimeout(resolve, 220));
        assert.equal(popupCount, 0);
        assert.equal(searches, 0);
        releaseBlocker.resolve('released');
        await blocker;
        const outcome = await loop;
        assert.notEqual(outcome.stopReason, 'tool_timeout');
        assert.equal(popupCount, decision === 'allow_session' ? 1 : 3);
        const results = useConversations.getState().byId[fixture.conversationId]!.messages
          .filter((message) => message.role === 'tool');
        assert.equal(results.length, 3);
        assert.equal(searches, 3, JSON.stringify(results.map((message) => decodeLcResultJson(message.content)?.data)));
        assert.ok(results.every((message) => !message.tool_is_error));
      } finally {
        blockerController.abort();
        releaseBlocker.resolve('released');
        await blocker;
        chatPostResponse = null;
        unregister();
        HANDLERS_BY_NAME.set('lc_web_research', original);
        fixture.cleanup();
      }
    });
  }
  it('a thrown handler is isolated to its call while successful siblings still publish', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
    });
    const original = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(original);
    let executions = 0;
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...original,
      run: async () => {
        executions += 1;
        if (executions === 1) throw new Error('controlled handler failure');
        return { time: 'fast', tz: 'UTC', unix_ms: executions };
      },
    });

    try {
      await runToolLoop(
        fixture.conversationId,
        [
          { created_at: 0, id: 'handler-throws', name: 'lc_get_current_time', arguments: '{}' },
          { created_at: 0, id: 'handler-succeeds', name: 'lc_get_current_time', arguments: '{}' },
        ],
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );
      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.role === 'tool') ?? [];
      assert.deepEqual(results.map((message) => message.tool_call_id).sort(), ['handler-succeeds', 'handler-throws']);
      assert.equal(results.filter((message) => message.tool_is_error).length, 1);
    } finally {
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });

  it('an unknown tool is answered once without opening a permission prompt', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: [],
    });
    let popupCount = 0;
    const unregister = registerPermissionHandler(async () => {
      popupCount += 1;
      return { decision: 'allow_once', grantedDirs: [] };
    });

    try {
      await runToolLoop(
        fixture.conversationId,
        [{ created_at: 0, id: 'unknown-tool-call', name: 'lc_not_a_real_tool', arguments: '{}' }],
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );

      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.tool_call_id === 'unknown-tool-call') ?? [];
      assert.equal(popupCount, 0);
      assert.equal(results.length, 1);
      assert.equal(results[0].tool_is_error, true);
      assert.match(results[0].content, /unknown_tool/);
    } finally {
      unregister();
      fixture.cleanup();
    }
  });

  it('repairs an unanswered id before propagating an eager-persistence callback failure', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
    });
    const originalHandler = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(originalHandler);
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...originalHandler,
      run: async () => ({ time: 'fast', tz: 'UTC', unix_ms: 1 }),
    });
    const originalAppend = useConversations.getState().appendMessage;
    let throwOnce = true;
    useConversations.setState({
      appendMessage: (...args: Parameters<typeof originalAppend>) => {
        if (throwOnce && args[1]?.role === 'tool') {
          throwOnce = false;
          throw new Error('controlled eager persistence failure');
        }
        return originalAppend(...args);
      },
    });

    try {
      await assert.rejects(
        runToolLoop(
          fixture.conversationId,
          [
            { created_at: 0, id: 'persist-fails', name: 'lc_get_current_time', arguments: '{}' },
            { created_at: 0, id: 'persist-succeeds', name: 'lc_get_current_time', arguments: '{}' },
          ],
          new AbortController().signal,
          { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
          { current: 'closure-model' },
          { current: undefined },
          fixture.options({} as LLMClientType),
          { current: new Set<string>() },
        ),
        /controlled eager persistence failure/,
      );
      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.role === 'tool') ?? [];
      assert.deepEqual(
        results.map((message) => message.tool_call_id).sort(),
        ['persist-fails', 'persist-succeeds'],
      );
      assert.equal(results.filter((message) => message.tool_call_id === 'persist-fails').length, 1);
      assert.match(
        results.find((message) => message.tool_call_id === 'persist-fails')?.content ?? '',
        /generation ended before the result/i,
      );
    } finally {
      useConversations.setState({ appendMessage: originalAppend });
      HANDLERS_BY_NAME.set('lc_get_current_time', originalHandler);
      fixture.cleanup();
    }
  });

  it('preserves the original pool error when unanswered-id repair also fails', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
    });
    const originalHandler = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(originalHandler);
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...originalHandler,
      run: async () => ({ time: 'fast', tz: 'UTC', unix_ms: 1 }),
    });
    const originalAppend = useConversations.getState().appendMessage;
    const originalSetState = useConversations.setState;
    let repairWrites = 0;
    useConversations.setState({
      appendMessage: (...args: Parameters<typeof originalAppend>) => {
        if (args[1]?.role === 'tool') {
          throw new Error('original eager persistence failure');
        }
        return originalAppend(...args);
      },
    });
    useConversations.setState = () => {
      repairWrites += 1;
      throw new Error('repair persistence failure');
    };

    try {
      await assert.rejects(
        runToolLoop(
          fixture.conversationId,
          [{ created_at: 0, id: 'persistent-store-failure', name: 'lc_get_current_time', arguments: '{}' }],
          new AbortController().signal,
          { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
          { current: 'closure-model' },
          { current: undefined },
          fixture.options({} as LLMClientType),
          { current: new Set<string>() },
        ),
        /original eager persistence failure/,
      );
      assert.equal(repairWrites, 1, 'the repair is attempted once without replacing the pool error');
    } finally {
      useConversations.setState = originalSetState;
      originalSetState({ appendMessage: originalAppend });
      HANDLERS_BY_NAME.set('lc_get_current_time', originalHandler);
      fixture.cleanup();
    }
  });

  it('a capped provider turn executes no sibling and makes no re-stream request', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
    });
    const original = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(original);
    let executions = 0;
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...original,
      run: async () => {
        executions++;
        return { time: 'fast', tz: 'UTC', unix_ms: executions };
      },
    });

    // The provider stream delivers one valid call and one over-cap call in
    // the same delta set, then ends with finish_reason "tool_calls".
    const okCall = '{}';
    const overCap = 'x'.repeat(2 * 1024 * 1024 + 1);
    let postRequests = 0;
    const encoder = new TextEncoder();
    chatPostResponse = () => {
      postRequests++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"ok_1","type":"function","function":{"name":"lc_get_current_time","arguments":${JSON.stringify(okCall)}}}]},"finish_reason":null}]}`,
            '',
            `data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"bad_1","type":"function","function":{"name":"lc_get_current_time","arguments":${JSON.stringify(overCap)}}}]},"finish_reason":"tool_calls"}]}`,
            '',
            'data: [DONE]',
            '',
          ].join('\n')));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    try {
      // The initial stream must go through the real Chat Completions
      // adapter so the cap path runs for real; the global fetch supplies
      // the SSE body and the re-stream counter proves nothing follows.
      const initialClient = new LLMClient({
        baseUrl: fixture.profile.baseUrl,
        apiKey: '',
        apiVariant: 'openai',
        apiStyle: 'chat',
        routing: 'direct',
      });
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        fixture.options(initialClient),
      );
      assert.equal(executions, 0, 'no handler runs after a cap violation');
      assert.equal(postRequests, 1, 'the initial request happens and no re-stream follows');
      const assistant = useConversations.getState().byId[fixture.conversationId]
        ?.messages.find((message) => message.id === fixture.assistantId);
      assert.equal(assistant?.meta?.finish_reason, 'error');
      assert.match(assistant?.meta?.error_message ?? '', /argument/i);
    } finally {
      chatPostResponse = null;
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });

  it('a provider EOF before the tool-call finish executes no call and makes no re-stream request', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
    });
    const original = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(original);
    let executions = 0;
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...original,
      run: async () => {
        executions++;
        return { time: 'must-not-run', tz: 'UTC', unix_ms: executions };
      },
    });

    let postRequests = 0;
    const encoder = new TextEncoder();
    chatPostResponse = () => {
      postRequests++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"incomplete-item","type":"function_call","call_id":"incomplete-call","name":"lc_get_current_time"}}',
            '',
            'data: {"type":"response.function_call_arguments.delta","item_id":"incomplete-item","delta":"{}"}',
            '',
          ].join('\n')));
          // A clean body EOF without a provider finish marker is still a
          // disconnected provider turn. The accumulated call is not admitted.
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    try {
      const client = new LLMClient({
        baseUrl: fixture.profile.baseUrl,
        apiKey: '',
        apiVariant: 'openai',
        apiStyle: 'responses',
        routing: 'direct',
      });
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        fixture.options(client),
      );

      assert.equal(executions, 0, 'an incomplete provider turn cannot execute a tool');
      assert.equal(postRequests, 1, 'the disconnected turn cannot start a re-stream');
      const conversation = useConversations.getState().byId[fixture.conversationId];
      const assistant = conversation?.messages.find((message) => message.id === fixture.assistantId);
      assert.equal(assistant?.meta?.finish_reason, 'disconnected');
      assert.equal(assistant?.responses_output_items, undefined);
      assert.equal(
        conversation?.messages.filter((message) => message.tool_call_id === 'incomplete-call').length,
        0,
      );
    } finally {
      chatPostResponse = null;
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });

  it('a replayed tool_call id across re-stream rounds is pruned, not executed', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
      max_tool_rounds_per_turn: 128,
    });
    const original = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(original);
    let executions = 0;
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...original,
      run: async () => {
        executions++;
        return { time: 'fast', tz: 'UTC', unix_ms: executions };
      },
    });

    // Round 1 (injected client) and round 2 (global-fetch re-stream) both
    // return the SAME tool_call id — the provider replaying an old id in a
    // later round of one turn. The id must execute exactly once.
    const replayed = { index: 0, id: 'reused-id', type: 'function' as const, function: { name: 'lc_get_current_time', arguments: '{}' } };
    let postRequests = 0;
    const encoder = new TextEncoder();
    chatPostResponse = () => {
      postRequests++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"reused-id","type":"function","function":{"name":"lc_get_current_time","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`,
            '',
            'data: [DONE]',
            '',
          ].join('\n')));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    try {
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        fixture.options(clientWith(async () => result({ finish_reason: 'tool_calls', tool_calls: [replayed] }))),
      );
      assert.equal(postRequests, 1, 'one re-stream happened');
      assert.equal(executions, 1, 'the replayed id must not execute again');
      const assistant = useConversations.getState().byId[fixture.conversationId]
        ?.messages.find((message) => message.id === fixture.assistantId);
      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.role === 'tool') ?? [];
      assert.equal(results.filter((message) => message.tool_call_id === 'reused-id').length, 1,
        'one result row per id across rounds');
      assert.equal(assistant?.tool_calls?.filter((call) => call.id === 'reused-id').length, 1,
        'one call row per id in the persisted graph');
      // The cross-round replay notice is persisted on the surviving row so a
      // later request that includes it makes the notice model-visible.
      assert.match(results[0].content, /already answered earlier in this turn/);
    } finally {
      chatPostResponse = null;
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });

  it('executes a repeated call with a new id and marks its result', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
      max_tool_rounds_per_turn: 128,
    });
    const original = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(original);
    let executions = 0;
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...original,
      run: async () => {
        executions++;
        return { time: 'fast', tz: 'UTC', unix_ms: executions };
      },
    });

    const firstCall = {
      index: 0,
      id: 'repeat-id-1',
      type: 'function' as const,
      function: { name: 'lc_get_current_time', arguments: '{}' },
    };
    let postRequests = 0;
    const encoder = new TextEncoder();
    chatPostResponse = () => {
      postRequests++;
      if (postRequests > 1) return stopStreamResponse('continued');
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"repeat-id-2","type":"function","function":{"name":"lc_get_current_time","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n')));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    try {
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        fixture.options(clientWith(async () => result({
          finish_reason: 'tool_calls',
          tool_calls: [firstCall],
        }))),
      );

      assert.equal(executions, 2, 'distinct call IDs both execute');
      assert.equal(postRequests, 2, 'the second result reaches one final re-stream');
      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.role === 'tool') ?? [];
      assert.equal(results.length, 2);
      assert.doesNotMatch(results[0].content, /Same call repeated/);
      const repeated = decodeLcResultJson(results[1].content);
      assert.ok(repeated);
      assert.match(repeated.notices[0], /Same call repeated 2× \(lc_get_current_time\)/);
      assert.equal((repeated.data as { unix_ms: number }).unix_ms, 2);
    } finally {
      chatPostResponse = null;
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });

  it('aggregates usage from three provider responses into one assistant-turn footer', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
      max_tool_rounds_per_turn: 128,
    });
    const original = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(original);
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...original,
      run: async () => ({ time: 'fast', tz: 'UTC', unix_ms: 1 }),
    });
    const firstCall = {
      index: 0,
      id: 'usage-round-1',
      type: 'function' as const,
      function: { name: 'lc_get_current_time', arguments: '{}' },
    };
    let postRequests = 0;
    const encoder = new TextEncoder();
    chatPostResponse = () => {
      postRequests += 1;
      const payload = postRequests === 1
        ? {
          choices: [{
            delta: { tool_calls: [{
              index: 0,
              id: 'usage-round-2',
              type: 'function',
              function: { name: 'lc_get_current_time', arguments: '{}' },
            }] },
            finish_reason: 'tool_calls',
          }],
          usage: {
            prompt_tokens: 2_000,
            completion_tokens: 5_000,
            total_tokens: 7_000,
            completion_tokens_details: { reasoning_tokens: 4_500 },
            prompt_tokens_details: { cached_tokens: 200 },
          },
        }
        : {
          choices: [{ delta: { content: 'final' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 3_000,
            completion_tokens: 2_605,
            total_tokens: 5_605,
            completion_tokens_details: { reasoning_tokens: 2_000 },
            prompt_tokens_details: { cached_tokens: 300 },
          },
        };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            `data: ${JSON.stringify(payload)}`,
            '',
            'data: [DONE]',
            '',
          ].join('\n')));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    try {
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        fixture.options(clientWith(async () => result({
          finish_reason: 'tool_calls',
          tool_calls: [firstCall],
          usage: {
            prompt_tokens: 1_000,
            completion_tokens: 300_000,
            total_tokens: 301_000,
            source: 'provider',
            reasoning: { status: 'reported', tokens: 299_000, measurement: 'provider-counter' },
            cache: { status: 'reported', readTokens: 100, reportedBy: 'provider' },
          },
        }))),
      );
      assert.equal(postRequests, 2);
      const assistant = useConversations.getState().byId[fixture.conversationId]
        ?.messages.find((message) => message.id === fixture.assistantId);
      assert.equal(assistant?.usage?.scope, 'assistant-turn');
      assert.deepEqual(assistant?.usage?.coverage, {
        responseCount: 3,
        providerReportedResponses: 3,
        estimatedResponses: 0,
      });
      assert.deepEqual(
        [assistant?.usage?.prompt_tokens, assistant?.usage?.completion_tokens, assistant?.usage?.total_tokens],
        [6_000, 307_605, 313_605],
      );
      assert.equal(assistant?.usage?.reasoning?.tokens, 305_500);
      assert.equal(assistant?.usage?.cache?.readTokens, 600);
      assert.equal(assistant?.usage?.terminalCoverage, 'complete');
      assert.equal(assistant?.meta?.totalTokens, 307_605);
      assert.equal(assistant?.meta?.baseUrl, fixture.profile.baseUrl);
      assert.ok((assistant?.meta?.durationMs ?? 0) >= 0);
    } finally {
      chatPostResponse = null;
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });

  it('assigns repeat notices by declared order after argument normalization', async () => {
    const fixture = createFixture({
      enabled: true,
      max_tool_rounds_per_turn: 128,
    });
    const original = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(original);
    const allStarted = Promise.withResolvers<void>();
    const releases = new Map<string, () => void>();
    let started = 0;
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...original,
      run: async (_input, context) => {
        await new Promise<void>((resolve) => {
          releases.set(context.identity.modelToolCallId, resolve);
          started += 1;
          if (started === 3) allStarted.resolve();
        });
        return { time: context.identity.modelToolCallId, tz: 'UTC', unix_ms: 1 };
      },
    });
    chatPostResponse = () => stopStreamResponse();

    try {
      const loop = runToolLoop(
        fixture.conversationId,
        [
          { created_at: 0, id: 'repeat-order-first', name: 'lc_get_current_time', arguments: '{}' },
          { created_at: 0, id: 'repeat-order-second', name: 'lc_get_current_time', arguments: '{"tz":""}' },
          { created_at: 0, id: 'repeat-order-third', name: 'lc_get_current_time', arguments: '{}' },
        ],
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );
      await allStarted.promise;
      releases.get('repeat-order-second')?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      releases.get('repeat-order-third')?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      releases.get('repeat-order-first')?.();
      await loop;

      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.role === 'tool') ?? [];
      const byId = new Map(results.map((message) => [message.tool_call_id, message.content]));
      assert.doesNotMatch(byId.get('repeat-order-first') ?? '', /Same call repeated/);
      assert.match(byId.get('repeat-order-second') ?? '', /Same call repeated 2×/);
      assert.match(byId.get('repeat-order-third') ?? '', /Same call repeated 3×/);
    } finally {
      chatPostResponse = null;
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });

  it('a replayed help id does not consume the budget for surviving calls', async () => {
    const fixture = createFixture({
      enabled: true,
      file_io_enabled: true,
      max_tool_rounds_per_turn: 128,
    });
    const firstId = 'reused-help-id';
    const helpArguments = JSON.stringify({ tool: 'lc_read_file' });
    const replayed = {
      index: 0,
      id: firstId,
      type: 'function' as const,
      function: { name: 'lc_tool_help', arguments: helpArguments },
    };
    const surviving = Array.from({ length: 5 }, (_value, index) => ({
      index: index + 1,
      id: `fresh-help-${index + 1}`,
      type: 'function' as const,
      function: { name: 'lc_tool_help', arguments: helpArguments },
    }));
    let postRequests = 0;
    const encoder = new TextEncoder();
    chatPostResponse = () => {
      postRequests += 1;
      const event = postRequests === 1
        ? { choices: [{ delta: { tool_calls: [replayed, ...surviving] }, finish_reason: 'tool_calls' }] }
        : { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            `data: ${JSON.stringify(event)}`,
            '',
            'data: [DONE]',
            '',
          ].join('\n')));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    try {
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        fixture.options(clientWith(async () => result({
          finish_reason: 'tool_calls',
          tool_calls: [replayed],
        }))),
      );

      assert.equal(postRequests, 2, 'one tool re-stream and one final response');
      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.role === 'tool') ?? [];
      const freshResults = surviving.map((call) => {
        const message = results.find((candidate) => candidate.tool_call_id === call.id);
        assert.ok(message, `missing result for ${call.id}`);
        return JSON.parse(message.content) as { data?: { mode?: string } };
      });
      assert.ok(freshResults.every((entry) => entry.data?.mode === 'already_returned'));
      assert.equal(results.filter((message) => message.tool_call_id === firstId).length, 1);
    } finally {
      chatPostResponse = null;
      fixture.cleanup();
    }
  });
});

describe('foundation tool execution', () => {
  it('executes lc_todo_write with every optional category off and no popup', async () => {
    const fixture = createFixture({ enabled: true });
    const original = HANDLERS_BY_NAME.get('lc_todo_write');
    assert.ok(original);
    let executions = 0;
    let popupCount = 0;
    let exposedNames: string[] = [];
    HANDLERS_BY_NAME.set('lc_todo_write', {
      ...original,
      run: async (input, context) => {
        executions += 1;
        return original.run(input, context);
      },
    });
    const unregister = registerPermissionHandler(async () => {
      popupCount += 1;
      return { decision: 'deny', grantedDirs: [] };
    });
    const encoder = new TextEncoder();
    chatPostResponse = () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n')));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    try {
      const call = {
        index: 0,
        id: 'foundation-todo-call',
        type: 'function' as const,
        function: {
          name: 'lc_todo_write',
          arguments: JSON.stringify({
            todos: [{ id: 1, title: 'Verify foundation execution', status: 'in-progress' }],
          }),
        },
      };
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        fixture.options(clientWith(async (params) => {
          exposedNames = params.tools?.map((tool) => tool.function.name) ?? [];
          return result({ finish_reason: 'tool_calls', tool_calls: [call] });
        })),
      );

      assert.deepEqual(exposedNames, ['lc_get_current_time', 'lc_todo_write', 'lc_ask_user']);
      assert.equal(popupCount, 0);
      assert.equal(executions, 1);
      const messages = useConversations.getState().byId[fixture.conversationId]?.messages ?? [];
      const assistant = messages.find((message) => message.id === fixture.assistantId);
      const storedResult = messages.find((message) => message.tool_call_id === call.id);
      assert.equal(assistant?.tool_calls?.some((stored) => stored.id === call.id), true);
      assert.ok(storedResult);
      assert.deepEqual(JSON.parse(storedResult.content), {
        status: 'ok',
        data: { completed: 0, blocked: 0, total: 1 },
        issues: [],
        warnings: [],
      });
    } finally {
      chatPostResponse = null;
      unregister();
      HANDLERS_BY_NAME.set('lc_todo_write', original);
      fixture.cleanup();
    }
  });

  it('executes lc_ask_user with a linked presentation signal and no permission popup', async () => {
    const configuredReadTimeoutMin = Number.MIN_VALUE;
    const fixture = createFixture({ enabled: true, sse_read_timeout_min: configuredReadTimeoutMin });
    const controller = new AbortController();
    let askCount = 0;
    let popupCount = 0;
    let exposedNames: string[] = [];
    let followUpResponseTimeoutMs: number | undefined;
    const unregisterAsk = registerAskUserHandler(async (request) => {
      askCount += 1;
      // The coordinator owns the presentation signal so either parent
      // cancellation or the absolute attention cap can dismiss the modal.
      assert.notEqual(request.signal, controller.signal);
      assert.equal(request.signal.aborted, false);
      assert.equal(request.conversationId, fixture.conversationId);
      assert.equal(request.conversationTitle, 'closure lifecycle');
      assert.equal(request.modelId, 'closure-model');
      // The configured ordinary tool deadline is effectively zero. A sole
      // valid ask-user round must remain governed only by its attention cap.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        decision: 'submitted',
        data: { answers: [{ id: 12, answer: 'Markdown' }] },
      };
    });
    const unregisterPermission = registerPermissionHandler(async () => {
      popupCount += 1;
      return { decision: 'deny', grantedDirs: [] };
    });
    chatPostResponse = (init) => {
      followUpResponseTimeoutMs = init?.responseTimeoutMs;
      return stopStreamResponse('continued');
    };

    try {
      const call = {
        index: 0,
        id: 'foundation-ask-call',
        type: 'function' as const,
        function: {
          name: 'lc_ask_user',
          arguments: JSON.stringify({
            questions: [{
              id: 12,
              question: 'Choose the format.',
              choices: [{ title: 'Markdown' }, { title: 'Plain text' }],
            }],
          }),
        },
      };
      await runStreamWithTools(
        fixture.conversationId,
        controller.signal,
        fixture.options(clientWith(async (params) => {
          exposedNames = params.tools?.map((tool) => tool.function.name) ?? [];
          return result({ finish_reason: 'tool_calls', tool_calls: [call] });
        })),
      );

      assert.deepEqual(exposedNames, ['lc_get_current_time', 'lc_todo_write', 'lc_ask_user']);
      assert.equal(askCount, 1);
      assert.equal(popupCount, 0);
      assert.equal(
        followUpResponseTimeoutMs,
        configuredReadTimeoutMin * 60_000,
        'the post-answer provider stream receives the full configured timeout',
      );
      assert.equal(
        useConversations.getState().byId[fixture.conversationId]?.messages
          .some((message) => message.content.includes('continued')),
        true,
        'a fresh follow-up stream starts after the delayed answer',
      );
      const messages = useConversations.getState().byId[fixture.conversationId]?.messages ?? [];
      const stored = messages.find((message) => message.tool_call_id === call.id);
      assert.ok(stored);
      assert.deepEqual(JSON.parse(stored.content), {
        status: 'ok',
        data: { answers: [{ id: 12, answer: 'Markdown' }] },
        issues: [],
        warnings: [],
      });
    } finally {
      chatPostResponse = null;
      unregisterPermission();
      unregisterAsk();
      fixture.cleanup();
    }
  });

  it('rejects an interactive mixed batch before any sibling executes', async () => {
    const fixture = createFixture({ enabled: true });
    const originalTodo = HANDLERS_BY_NAME.get('lc_todo_write');
    assert.ok(originalTodo);
    let askCount = 0;
    let todoCount = 0;
    let popupCount = 0;
    HANDLERS_BY_NAME.set('lc_todo_write', {
      ...originalTodo,
      run: async (input, context) => {
        todoCount += 1;
        return originalTodo.run(input, context);
      },
    });
    const unregisterAsk = registerAskUserHandler(async () => {
      askCount += 1;
      return { decision: 'submitted', data: { answers: [{ id: 1, answer: 'A' }] } };
    });
    const unregisterPermission = registerPermissionHandler(async () => {
      popupCount += 1;
      return { decision: 'deny', grantedDirs: [] };
    });
    chatPostResponse = () => stopStreamResponse();

    try {
      const calls = [{
        index: 0,
        id: 'mixed-ask-call',
        type: 'function' as const,
        function: {
          name: 'lc_ask_user',
          arguments: JSON.stringify({
            questions: [{
              id: 1,
              question: 'Choose one.',
              choices: [{ title: 'A' }, { title: 'B' }],
            }],
          }),
        },
      }, {
        index: 1,
        id: 'mixed-second-ask-call',
        type: 'function' as const,
        function: {
          name: 'lc_ask_user',
          arguments: JSON.stringify({
            questions: [{
              id: 2,
              question: 'Choose another.',
              choices: [{ title: 'C' }, { title: 'D' }],
            }],
          }),
        },
      }, {
        index: 2,
        id: 'mixed-todo-call',
        type: 'function' as const,
        function: {
          name: 'lc_todo_write',
          arguments: JSON.stringify({
            todos: [{ id: 1, title: 'Do not execute', status: 'not-started' }],
          }),
        },
      }];
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        fixture.options(clientWith(async () => result({
          finish_reason: 'tool_calls',
          tool_calls: calls,
        }))),
      );

      assert.equal(askCount, 0);
      assert.equal(todoCount, 0);
      assert.equal(popupCount, 0);
      const results = (useConversations.getState().byId[fixture.conversationId]?.messages ?? [])
        .filter((message) => message.role === 'tool' && calls.some((call) => call.id === message.tool_call_id));
      assert.deepEqual(results.map((message) => message.tool_call_id), [
        'mixed-ask-call',
        'mixed-second-ask-call',
        'mixed-todo-call',
      ]);
      for (const message of results) {
        const envelope = JSON.parse(message.content);
        assert.equal(envelope.status, 'error');
        assert.equal(envelope.issues[0].code, 'interactive_tool_must_run_alone');
        assert.equal(envelope.issues[0].retryable, false);
      }
    } finally {
      chatPostResponse = null;
      unregisterPermission();
      unregisterAsk();
      HANDLERS_BY_NAME.set('lc_todo_write', originalTodo);
      fixture.cleanup();
    }
  });

  it('does not isolate a near-match Ask User name from an operational sibling', async () => {
    const fixture = createFixture({ enabled: true });
    const originalTodo = HANDLERS_BY_NAME.get('lc_todo_write');
    assert.ok(originalTodo);
    let todoCount = 0;
    HANDLERS_BY_NAME.set('lc_todo_write', {
      ...originalTodo,
      run: async (input, context) => {
        todoCount += 1;
        return originalTodo.run(input, context);
      },
    });
    chatPostResponse = () => stopStreamResponse();

    try {
      await runToolLoop(
        fixture.conversationId,
        [
          { created_at: 0, id: 'near-ask', name: 'lc_ask_use', arguments: '{}' },
          {
            created_at: 0,
            id: 'near-ask-todo',
            name: 'lc_todo_write',
            arguments: JSON.stringify({
              todos: [{ id: 1, title: 'Execute once', status: 'not-started' }],
            }),
          },
        ],
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );

      assert.equal(todoCount, 1);
      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.role === 'tool') ?? [];
      assert.deepEqual(
        results.map((message) => message.tool_call_id).sort(),
        ['near-ask', 'near-ask-todo'],
      );
      const nearMatch = results.find((message) => message.tool_call_id === 'near-ask');
      assert.ok(nearMatch);
      assert.match(nearMatch.content, /unknown_tool/);
      assert.doesNotMatch(nearMatch.content, /interactive_tool_must_run_alone/);
    } finally {
      chatPostResponse = null;
      HANDLERS_BY_NAME.set('lc_todo_write', originalTodo);
      fixture.cleanup();
    }
  });

  it('keeps a sibling validation error when it suppresses an interactive batch', async () => {
    const fixture = createFixture({ enabled: true });
    let askCount = 0;
    const unregisterAsk = registerAskUserHandler(async () => {
      askCount += 1;
      return { decision: 'submitted', data: { answers: [{ id: 1, answer: 'A' }] } };
    });
    chatPostResponse = () => stopStreamResponse();
    try {
      const calls = [{
        index: 0,
        id: 'mixed-specific-ask',
        type: 'function' as const,
        function: {
          name: 'lc_ask_user',
          arguments: '{"questions":[{"id":1,"question":"Choose.","choices":[{"title":"A"},{"title":"B"}]}]}',
        },
      }, {
        index: 1,
        id: 'mixed-specific-invalid',
        type: 'function' as const,
        function: { name: 'lc_todo_write', arguments: '{"todos":[]}' },
      }, {
        index: 2,
        id: 'mixed-specific-unknown',
        type: 'function' as const,
        function: { name: 'lc_unknown_operation', arguments: '{}' },
      }];
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        fixture.options(clientWith(async () => result({ finish_reason: 'tool_calls', tool_calls: calls }))),
      );
      assert.equal(askCount, 0);
      const results = (useConversations.getState().byId[fixture.conversationId]?.messages ?? [])
        .filter((message) => message.role === 'tool' && calls.some((call) => call.id === message.tool_call_id));
      assert.deepEqual(results.map((message) => JSON.parse(message.content).issues[0].code), [
        'interactive_tool_must_run_alone',
        'invalid_arguments',
        'unknown_tool',
      ]);
    } finally {
      chatPostResponse = null;
      unregisterAsk();
      fixture.cleanup();
    }
  });

  it('does not charge rejected interactive siblings against the help-guidance limit', async () => {
    const fixture = createFixture({ enabled: true, file_io_enabled: true });
    let postRequests = 0;
    const encoder = new TextEncoder();
    chatPostResponse = () => {
      postRequests += 1;
      if (postRequests > 1) return stopStreamResponse();
      const toolCall = {
        index: 0,
        id: 'isolated-help',
        type: 'function',
        function: {
          name: 'lc_tool_help',
          arguments: JSON.stringify({ tool: 'lc_grep', query: 'encoding' }),
        },
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] })}`,
            '',
            'data: [DONE]',
            '',
          ].join('\n')));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    try {
      await runToolLoop(
        fixture.conversationId,
        [
          { created_at: 0, id: 'mixed-ask', name: 'lc_ask_user', arguments: '{}' },
          { created_at: 0, id: 'mixed-help-1', name: 'lc_tool_help', arguments: JSON.stringify({ tool: 'lc_read_file' }) },
          { created_at: 0, id: 'mixed-help-2', name: 'lc_tool_help', arguments: JSON.stringify({ tool: 'lc_read_pdf' }) },
          { created_at: 0, id: 'mixed-help-3', name: 'lc_tool_help', arguments: JSON.stringify({ tool: 'lc_grep' }) },
        ],
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );

      const resultMessage = useConversations.getState().byId[fixture.conversationId]?.messages
        .find((message) => message.role === 'tool' && message.tool_call_id === 'isolated-help');
      assert.ok(resultMessage);
      const envelope = decodeLcResultJson(resultMessage.content)?.data as {
        data?: { mode?: string };
      };
      assert.equal(envelope.data?.mode, 'matched');
    } finally {
      chatPostResponse = null;
      fixture.cleanup();
    }
  });
});

describe('Whiteboard batch admission', () => {
  function installWhiteboardServiceTripwire() {
    const original = HANDLERS_BY_NAME.get('lc_whiteboard');
    assert.ok(original);
    const touches = { handler: 0, service: 0 };
    const service = {
      read: async () => {
        touches.service += 1;
        throw new Error('Whiteboard service must not be reached by a conflicted batch.');
      },
      replaceModel: async () => {
        touches.service += 1;
        throw new Error('Whiteboard service must not be reached by a conflicted batch.');
      },
    };
    HANDLERS_BY_NAME.set('lc_whiteboard', {
      ...original,
      run: async (input, context) => {
        touches.handler += 1;
        return original.run(input, { ...context, whiteboard: service });
      },
    });
    return {
      touches,
      restore: () => HANDLERS_BY_NAME.set('lc_whiteboard', original),
    };
  }

  function persistedResult(conversationId: string, callId: string) {
    const message = useConversations.getState().byId[conversationId]?.messages
      .find((candidate) => candidate.role === 'tool' && candidate.tool_call_id === callId);
    assert.ok(message, `missing persisted result for ${callId}`);
    const decoded = decodeLcResultJson(message.content);
    assert.ok(decoded, `invalid stored result JSON for ${callId}`);
    return { message, data: decoded.data as Record<string, unknown> };
  }

  it('rejects two exact calls before their service and still executes an unrelated sibling', async () => {
    const fixture = createFixture({
      enabled: true,
      whiteboard_enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
    });
    const tripwire = installWhiteboardServiceTripwire();
    const calls = [{
      id: 'whiteboard-live-read',
      name: 'lc_whiteboard',
      arguments: '{"action":"read"}',
      created_at: 10,
    }, {
      id: 'whiteboard-live-sibling',
      name: 'lc_get_current_time',
      arguments: '{"format":"unix_ms"}',
      created_at: 11,
    }, {
      id: 'whiteboard-live-replace',
      name: 'lc_whiteboard',
      arguments: '{"action":"replace","content":"must not be stored"}',
      created_at: 12,
    }];
    useConversations.getState().patchMessage(fixture.conversationId, fixture.assistantId, {
      tool_calls: calls,
    });
    chatPostResponse = () => stopStreamResponse();

    try {
      const outcome = await runToolLoop(
        fixture.conversationId,
        calls,
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options(clientWith(async () => result())),
        { current: new Set<string>() },
      );

      assert.equal(outcome.toolRounds, 1);
      assert.deepEqual(tripwire.touches, { handler: 0, service: 0 });
      for (const id of ['whiteboard-live-read', 'whiteboard-live-replace']) {
        const stored = persistedResult(fixture.conversationId, id);
        assert.equal(stored.message.tool_is_error, true);
        assert.deepEqual(stored.data, {
          status: 'error',
          issues: [{
            code: 'whiteboard_batch_conflict',
            ...WHITEBOARD_ISSUE_FIXTURES.whiteboard_batch_conflict,
          }],
          warnings: [],
        });
      }

      const sibling = persistedResult(fixture.conversationId, 'whiteboard-live-sibling');
      assert.equal(sibling.message.tool_is_error, false);
      assert.equal(typeof sibling.data.unix_ms, 'number');
      assert.equal(sibling.data.time, String(sibling.data.unix_ms));
    } finally {
      chatPostResponse = null;
      tripwire.restore();
      fixture.cleanup();
    }
  });

  it('keeps Whiteboard conflict precedence inside Ask User mixed-batch suppression', async () => {
    const fixture = createFixture({ enabled: true, whiteboard_enabled: true });
    const tripwire = installWhiteboardServiceTripwire();
    const originalTodo = HANDLERS_BY_NAME.get('lc_todo_write');
    assert.ok(originalTodo);
    let todoExecutions = 0;
    let askExecutions = 0;
    HANDLERS_BY_NAME.set('lc_todo_write', {
      ...originalTodo,
      run: async (input, context) => {
        todoExecutions += 1;
        return originalTodo.run(input, context);
      },
    });
    const unregisterAsk = registerAskUserHandler(async () => {
      askExecutions += 1;
      return { decision: 'submitted', data: { answers: [{ id: 1, answer: 'A' }] } };
    });
    const calls = [{
      id: 'whiteboard-mixed-ask',
      name: 'lc_ask_user',
      arguments: JSON.stringify({
        questions: [{
          id: 1,
          question: 'Choose one.',
          choices: [{ title: 'A' }, { title: 'B' }],
        }],
      }),
      created_at: 20,
    }, {
      id: 'whiteboard-mixed-read',
      name: 'lc_whiteboard',
      arguments: '{"action":"read"}',
      created_at: 21,
    }, {
      id: 'whiteboard-mixed-replace',
      name: 'lc_whiteboard',
      arguments: '{"action":"replace","content":"must not be stored"}',
      created_at: 22,
    }, {
      id: 'whiteboard-mixed-todo',
      name: 'lc_todo_write',
      arguments: JSON.stringify({
        todos: [{ id: 1, title: 'Must stay suppressed', status: 'not-started' }],
      }),
      created_at: 23,
    }];
    useConversations.getState().patchMessage(fixture.conversationId, fixture.assistantId, {
      tool_calls: calls,
    });
    chatPostResponse = () => stopStreamResponse();

    try {
      const outcome = await runToolLoop(
        fixture.conversationId,
        calls,
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options(clientWith(async () => result())),
        { current: new Set<string>() },
      );

      assert.equal(outcome.toolRounds, 1);
      assert.equal(askExecutions, 0);
      assert.equal(todoExecutions, 0);
      assert.deepEqual(tripwire.touches, { handler: 0, service: 0 });
      const results = calls.map((call) => persistedResult(fixture.conversationId, call.id));
      assert.deepEqual(
        results.map(({ data }) => (data.issues as Array<{ code: string }>)[0].code),
        [
          'interactive_tool_must_run_alone',
          'whiteboard_batch_conflict',
          'whiteboard_batch_conflict',
          'interactive_tool_must_run_alone',
        ],
      );
      assert.ok(results.every(({ message }) => message.tool_is_error === true));
    } finally {
      chatPostResponse = null;
      unregisterAsk();
      HANDLERS_BY_NAME.set('lc_todo_write', originalTodo);
      tripwire.restore();
      fixture.cleanup();
    }
  });
});

describe('provider-state request assembly', () => {
  it('stores one plaintext Anthropic group for relayed MiniMax even if apiStyle is stale', async () => {
    const fixture = createFixture();
    const signature = '1c3a0ae890922669e9815a201f9b645abdaafe8d8b5a65a5e48f90830c6e0750';
    const client = clientWith(async () => result({
      content: 'done',
      anthropic_output_blocks: [{
        type: 'thinking',
        thinking: 'complete relayed MiniMax reasoning',
        signature,
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        source: 'provider',
        reasoning: {
          status: 'reported',
          tokens: 8,
          measurement: 'provider-estimate',
        },
      },
    }));

    try {
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        {
          ...fixture.options(client),
          profile: { baseUrl: 'https://api.gmi-serving.com/v1', apiKey: '' },
          apiVariant: 'anthropic',
          // A stale hidden style value must not create empty Responses groups
          // alongside the active Anthropic protocol.
          apiStyle: 'responses',
        },
      );
      const assistant = useConversations.getState().byId[fixture.conversationId]
        ?.messages.find((message) => message.id === fixture.assistantId);
      assert.deepEqual(
        assistant?.opaque_replay_accounting?.map((group) => ({
          protocol: group.protocol,
          carrier: group.reasoningCarrier,
          status: group.tokenStatus,
        })),
        [{ protocol: 'anthropic-messages', carrier: 'plaintext', status: 'unreported' }],
      );
      assert.equal(assistant?.responses_output_items, undefined);
      assert.equal(assistant?.anthropic_output_blocks?.[0]?.type, 'thinking');
    } finally {
      fixture.cleanup();
    }
  });

  it('projects one archived todo list onto only the request copy of the latest user message', async () => {
    const fixture = createFixture({ enabled: true, tool_history_enabled: true });
    const current = useConversations.getState().byId[fixture.conversationId];
    assert.ok(current);
    const todoArguments = JSON.stringify({
      todos: [
        { id: 1, title: 'Completed work', status: 'completed' },
        { id: 8, title: 'Continue implementation', status: 'in-progress', note: 'Use the saved state.' },
      ],
    });
    useConversations.setState({
      byId: {
        ...useConversations.getState().byId,
        [fixture.conversationId]: {
          ...current,
          messageCount: 5,
          messages: [
            { id: 'todo-user-old', role: 'user', content: 'Make a plan.', createdAt: 1 },
            {
              id: 'todo-assistant-old', role: 'assistant', content: '', createdAt: 2,
              tool_calls: [{ created_at: 0, id: 'todo-call-old', name: 'lc_todo_write', arguments: todoArguments }],
            },
            {
              id: 'todo-result-old', role: 'tool', createdAt: 3, tool_call_id: 'todo-call-old',
              content: JSON.stringify({
                status: 'ok',
                data: { completed: 1, blocked: 0, total: 2 },
                issues: [],
                warnings: [],
              }),
            },
            { id: 'todo-user-current', role: 'user', content: 'Continue.', createdAt: 4 },
            { id: fixture.assistantId, role: 'assistant', content: '', createdAt: 5, streaming: true },
          ],
        },
      },
    });
    let sent: ChatMessage[] = [];

    try {
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        fixture.options(clientWith(async (params) => {
          sent = params.messages;
          return result({ content: 'done' });
        })),
      );

      const latestUser = [...sent].reverse().find((message) => message.role === 'user');
      assert.equal(typeof latestUser?.content, 'string');
      const requestContent = latestUser?.content as string;
      assert.match(requestContent, /Continue\.\n\n\[LC current to-do state\]/);
      assert.equal((requestContent.match(/Continue implementation/g) ?? []).length, 1);
      assert.equal(requestContent.includes('Completed work'), true);
      const storedUser = useConversations.getState().byId[fixture.conversationId]
        ?.messages.find((message) => message.id === 'todo-user-current');
      assert.equal(storedUser?.content, 'Continue.');
      const archivedAssistant = sent.find((message) =>
        message.role === 'assistant' && message.tool_calls?.length);
      assert.equal(archivedAssistant?.tool_calls?.[0]?.function.name, 'lc_tool_history');
    } finally {
      fixture.cleanup();
    }
  });

  it('retains signed Anthropic blocks when Tool History rebuilds their tool call', async () => {
    const fixture = createFixture({
      enabled: true,
      tool_history_enabled: true,
    });
    const anthropicBaseUrl = 'https://api.anthropic.com/v1';
    useProfileStore.setState((state) => ({
      profiles: state.profiles.map((profile) => profile.id === fixture.profile.id
        ? { ...profile, baseUrl: anthropicBaseUrl, apiVariant: 'anthropic' }
        : profile),
    }));
    const current = useConversations.getState().byId[fixture.conversationId];
    assert.ok(current);
    useConversations.setState({
      byId: {
        ...useConversations.getState().byId,
        [fixture.conversationId]: {
          ...current,
          messageCount: 6,
          messages: [
            { id: 'history-user', role: 'user', content: 'inspect', createdAt: 1 },
            {
              id: 'history-assistant',
              role: 'assistant',
              content: '',
              createdAt: 2,
              tool_calls: [{ created_at: 0, id: 'toolu_original', name: 'lc_get_current_time', arguments: '{}' }],
              anthropic_output_blocks: [{
                type: 'thinking', thinking: 'opaque turn', signature: 'sig-original',
              }],
              opaque_replay_accounting: [{
                schemaVersion: 1,
                protocol: 'anthropic-messages',
                reasoningCarrier: 'signed-thinking',
                generatedReasoningTokens: 55,
                tokenStatus: 'provider-estimate',
                locator: { kind: 'anthropic-block-indexes', blockIndexes: [0] },
                toolCallIds: ['toolu_original'],
              }],
              meta: { model: 'closure-model', baseUrl: anthropicBaseUrl },
            },
            {
              id: 'history-result', role: 'tool', content: 'done', createdAt: 3,
              tool_call_id: 'toolu_original',
            },
            { id: 'current-user', role: 'user', content: 'continue', createdAt: 4 },
            {
              id: fixture.assistantId, role: 'assistant', content: '', createdAt: 5,
              streaming: true,
            },
          ],
        },
      },
    });
    let sent: ChatMessage[] = [];
    const client = clientWith(async (params) => {
      sent = params.messages;
      return result();
    });

    try {
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        {
          ...fixture.options(client),
          profile: { baseUrl: anthropicBaseUrl, apiKey: '' },
          apiVariant: 'anthropic',
        },
      );
      const archived = sent.find((message) => message.role === 'assistant'
        && message.tool_calls?.[0]?.function.name === 'lc_tool_history');
      assert.ok(archived, 'the original call should be replaced by the archive marker');
      assert.deepEqual(archived.anthropic_output_blocks, [{
        type: 'thinking', thinking: 'opaque turn', signature: 'sig-original',
      }]);
      assert.deepEqual(archived.anthropic_output_origin, {
        model: 'closure-model', baseUrl: anthropicBaseUrl,
      });
      assert.equal(archived.reasoning_content, undefined);
    } finally {
      fixture.cleanup();
    }
  });

  it('removes raw Responses function calls even when their id collides with the archive marker', async () => {
    const fixture = createFixture({
      enabled: true,
      tool_history_enabled: true,
    });
    const responsesBaseUrl = 'https://api.openai.com/v1';
    useProfileStore.setState((state) => ({
      profiles: state.profiles.map((profile) => profile.id === fixture.profile.id
        ? { ...profile, baseUrl: responsesBaseUrl, apiVariant: 'openai', apiStyle: 'responses' }
        : profile),
    }));
    const current = useConversations.getState().byId[fixture.conversationId];
    assert.ok(current);
    const archivedAssistantId = 'responses-archive-owner';
    const collidingCallId = archiveToolCallId(archivedAssistantId);
    const secretBoard = '# Historical board must stay out of the request';
    useConversations.setState({
      byId: {
        ...useConversations.getState().byId,
        [fixture.conversationId]: {
          ...current,
          messageCount: 5,
          messages: [
            { id: 'responses-history-user', role: 'user', content: 'update it', createdAt: 1 },
            {
              id: archivedAssistantId,
              role: 'assistant',
              content: '',
              createdAt: 2,
              tool_calls: [{
                created_at: 0,
                id: collidingCallId,
                name: 'lc_whiteboard',
                arguments: JSON.stringify({ action: 'replace', content: secretBoard }),
              }],
              responses_output_items: [
                {
                  id: 'responses-reasoning',
                  type: 'reasoning',
                  summary: [],
                  encrypted_content: 'signed-reasoning-survives',
                },
                {
                  id: 'responses-message',
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: '', annotations: [] }],
                },
                {
                  id: 'responses-function-call',
                  type: 'function_call',
                  call_id: collidingCallId,
                  name: 'lc_whiteboard',
                  arguments: JSON.stringify({ action: 'replace', content: secretBoard }),
                  status: 'completed',
                },
              ],
              opaque_replay_accounting: [{
                schemaVersion: 1,
                protocol: 'openai-responses',
                reasoningCarrier: 'encrypted-content',
                generatedReasoningTokens: 77,
                tokenStatus: 'provider-reported',
                locator: {
                  kind: 'responses-item-ids',
                  itemIds: ['responses-reasoning', 'responses-function-call'],
                },
                toolCallIds: [collidingCallId],
              }, {
                schemaVersion: 1,
                protocol: 'openai-responses',
                reasoningCarrier: 'none',
                tokenStatus: 'unreported',
                locator: { kind: 'responses-item-ids', itemIds: ['responses-message'] },
              }],
            },
            {
              id: 'responses-history-result',
              role: 'tool',
              content: JSON.stringify({ status: 'ok', data: { changed: true } }),
              createdAt: 3,
              tool_call_id: collidingCallId,
            },
            { id: 'responses-current-user', role: 'user', content: 'continue', createdAt: 4 },
            {
              id: fixture.assistantId,
              role: 'assistant',
              content: '',
              createdAt: 5,
              streaming: true,
            },
          ],
        },
      },
    });
    let sent: ChatMessage[] = [];
    const client = clientWith(async (params) => {
      sent = params.messages;
      return result();
    });

    try {
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        {
          ...fixture.options(client),
          profile: { baseUrl: responsesBaseUrl, apiKey: '' },
          apiStyle: 'responses',
        },
      );
      const archived = sent.find((message) => message.role === 'assistant'
        && message.tool_calls?.[0]?.id === collidingCallId);
      assert.ok(archived);
      assert.equal(archived.tool_calls?.[0]?.function.name, 'lc_tool_history');
      assert.deepEqual(
        archived.responses_output_items?.map((item) => item.type),
        ['reasoning', 'message'],
      );
      assert.deepEqual(
        archived.opaque_replay_accounting?.[0]?.locator,
        { kind: 'responses-item-ids', itemIds: ['responses-reasoning'] },
      );
      assert.equal(archived.opaque_replay_accounting?.[0]?.generatedReasoningTokens, 77);

      const request = new OpenAIResponsesAdapter().buildRequest({
        model: 'closure-model',
        messages: sent,
        stream: true,
        reasoningEnabled: false,
        baseUrl: responsesBaseUrl,
      });
      assert.ok(Array.isArray(request.input));
      const wire = request.input;
      const functionCalls = wire.filter((item) => item.type === 'function_call');
      assert.equal(functionCalls.length, 1);
      assert.equal(functionCalls[0].call_id, collidingCallId);
      assert.equal(functionCalls[0].name, 'lc_tool_history');
      assert.equal(JSON.stringify(wire).includes(secretBoard), false);
      assert.equal(JSON.stringify(wire).includes('"name":"lc_whiteboard"'), false);
      assert.equal(JSON.stringify(wire).includes('signed-reasoning-survives'), true);
      assert.equal(wire.some((item) => item.type === 'message' && item.role === 'assistant'), true);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('Lifecycle limit outcomes', () => {
  it('a never-resolving handler is cancelled by the round deadline and answered once', { timeout: 5_000 }, async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
      sse_read_timeout_min: 0.001,
    });
    const original = HANDLERS_BY_NAME.get('lc_get_current_time');
    assert.ok(original);
    HANDLERS_BY_NAME.set('lc_get_current_time', {
      ...original,
      run: async () => new Promise<never>(() => {}),
    });

    try {
      const startedAt = performance.now();
      const outcome = await runToolLoop(
        fixture.conversationId,
        [{ created_at: 0, id: 'deadline-hang', name: 'lc_get_current_time', arguments: '{}' }],
        new AbortController().signal,
        { current: { baseUrl: fixture.profile.baseUrl, apiKey: '' } },
        { current: 'closure-model' },
        { current: undefined },
        fixture.options({} as LLMClientType),
        { current: new Set<string>() },
      );
      assert.equal(outcome.stopReason, 'tool_timeout');
      assert.ok(performance.now() - startedAt < 1_000);
      const results = useConversations.getState().byId[fixture.conversationId]?.messages
        .filter((message) => message.tool_call_id === 'deadline-hang') ?? [];
      assert.equal(results.length, 1);
      assert.ok(results[0].tool_is_error);
      assert.match(results[0].content, /"status":"timeout"/);
      assert.match(results[0].content, /Side effects may have happened/);
    } finally {
      HANDLERS_BY_NAME.set('lc_get_current_time', original);
      fixture.cleanup();
    }
  });

  it('oversized tool batches terminate once without executing any call', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
      max_tool_calls_per_batch: 2,
    });
    const calls = Array.from({ length: 3 }, (_, index) => ({
      index,
      id: `batch-limit-${index}`,
      type: 'function' as const,
      function: { name: 'lc_get_current_time', arguments: '{}' },
    }));
    const client = clientWith(async () => result({ finish_reason: 'tool_calls', tool_calls: calls }));
    try {
      await runStreamWithTools(fixture.conversationId, new AbortController().signal, fixture.options(client));
      const assistant = useConversations.getState().byId[fixture.conversationId]
        ?.messages.find((message) => message.id === fixture.assistantId);
      assert.equal(fixture.finalizations(), 1);
      assert.equal(assistant?.meta?.finish_reason, 'tool_batch_limit');
      assert.equal(useConversations.getState().byId[fixture.conversationId]?.messages.some((m) => m.role === 'tool'), false);
    } finally {
      fixture.cleanup();
    }
  });

  it('tool-round limit terminates once after the accepted round', async () => {
    const fixture = createFixture({
      enabled: true,
      web_access_enabled: true,
      tool_grants: ['lc_get_current_time'],
      max_tool_rounds_per_turn: 1,
    });
    let streamNumber = 0;
    let postRequests = 0;
    const encoder = new TextEncoder();
    chatPostResponse = () => {
      postRequests++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"round-limit-2","type":"function","function":{"name":"lc_get_current_time","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n')));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const client = clientWith(async () => {
      const id = `round-limit-${++streamNumber}`;
      return result({
        finish_reason: 'tool_calls',
        tool_calls: [{ id, type: 'function', function: { name: 'lc_get_current_time', arguments: '{}' } }],
      });
    });
    try {
      await runStreamWithTools(fixture.conversationId, new AbortController().signal, fixture.options(client));
      const assistant = useConversations.getState().byId[fixture.conversationId]
        ?.messages.find((message) => message.id === fixture.assistantId);
      assert.equal(streamNumber, 1);
      assert.equal(postRequests, 1);
      assert.equal(fixture.finalizations(), 1);
      assert.equal(assistant?.meta?.finish_reason, 'tool_round_limit');
    } finally {
      chatPostResponse = null;
      fixture.cleanup();
    }
  });

  it('provider length/context finish terminates once with the provider reason', async () => {
    const fixture = createFixture();
    const client = clientWith(async (_params, callbacks) => {
      callbacks.onDelta('partial at context boundary');
      return result({ content: 'partial at context boundary', finish_reason: 'length' });
    });
    try {
      await runStreamWithTools(fixture.conversationId, new AbortController().signal, fixture.options(client));
      const assistant = useConversations.getState().byId[fixture.conversationId]
        ?.messages.find((message) => message.id === fixture.assistantId);
      assert.equal(fixture.finalizations(), 1);
      assert.equal(assistant?.meta?.finish_reason, 'length');
    } finally {
      fixture.cleanup();
    }
  });

  it('repeating reasoning guard terminates once through the production finalizer', async () => {
    const fixture = createFixture();
    const repeated = 'ABCD'.repeat(12);
    const client = clientWith(async (_params, callbacks, signal) => {
      callbacks.onReasoning?.(repeated);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return result();
    });
    try {
      await runStreamWithTools(
        fixture.conversationId,
        new AbortController().signal,
        {
          ...fixture.options(client),
          reasoningLoopDetectorOptions: { armAfterMs: 0, blockSize: 4, requiredBlocks: 2 },
        },
      );
      const assistant = useConversations.getState().byId[fixture.conversationId]
        ?.messages.find((message) => message.id === fixture.assistantId);
      assert.equal(fixture.finalizations(), 1);
      assert.equal(assistant?.meta?.finish_reason, 'infinite_reasoning_loop');
    } finally {
      fixture.cleanup();
    }
  });
});
