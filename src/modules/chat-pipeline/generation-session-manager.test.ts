import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GENERATION_CAPACITY,
  GENERATION_CAPACITY,
  activeGenerationCount,
  activeGenerationSessions,
  cancelGenerationSession,
  clearGenerationAttention,
  endGenerationSession,
  getGenerationAttention,
  getGenerationSession,
  getGenerationSessionView,
  getGenerationSessionsVersion,
  hasGenerationCapacity,
  isGenerationSessionOwner,
  resetGenerationSessionsForTests,
  setGenerationCapacityForTests,
  setGenerationSessionPhase,
  setGenerationSessionTps,
  startGenerationSession,
  subscribeToGenerationSession,
  subscribeToGenerationSessions,
} from './generation-session-manager.ts';
import {
  enqueueGenerationInteraction,
  getInteractionQueueView,
  resetInteractionCoordinatorForTests,
  type GenerationInteractionIdentity,
} from './interaction-coordinator.ts';
import { createGenerationPhaseTracker } from './phase-tracker.ts';
import {
  getPhase,
  onPhaseChange,
  resetResponseStatusForTests,
} from '../../store/responseStatus.ts';
import {
  clearGenerationModelDetailCache,
  freezeGenerationExecutionSnapshot,
  getCachedModelDetail,
  type GenerationExecutionSnapshot,
} from './generation-snapshot.ts';
import { invalidateGenerationModelDetailConfiguration } from './generation-model-detail-config.ts';

function start(conversationId: string, generationId: string) {
  const controller = new AbortController();
  return startGenerationSession({
    conversationId,
    generationId,
    assistantMessageId: `${conversationId}-assistant`,
    controller,
  });
}

afterEach(() => {
  resetInteractionCoordinatorForTests();
  resetResponseStatusForTests();
  resetGenerationSessionsForTests();
  clearGenerationModelDetailCache();
});

function interactionIdentity(
  id: string,
  conversationId: string,
  kind: GenerationInteractionIdentity['kind'] = 'permission',
): GenerationInteractionIdentity {
  return {
    interactionId: id,
    conversationId,
    conversationTitle: conversationId,
    generationId: `generation-${conversationId}`,
    assistantMessageId: `assistant-${conversationId}`,
    toolCallId: `tool-${id}`,
    kind,
    requestedAt: Date.now(),
  };
}

describe('application interaction coordination', () => {
  it('presents prompts in strict application FIFO order', async () => {
    const shown: string[] = [];
    const releases = new Map<string, (value: string) => void>();
    const enqueue = (id: string, conversationId: string) => enqueueGenerationInteraction({
      identity: interactionIdentity(id, conversationId),
      signal: new AbortController().signal,
      validateOwnership: () => true,
      present: () => new Promise<string>((resolve) => {
        shown.push(id);
        releases.set(id, resolve);
      }),
      abortedResult: () => 'aborted',
      unavailableResult: () => 'unavailable',
    });

    const first = enqueue('first', 'a');
    const second = enqueue('second', 'b');
    const third = enqueue('third', 'a');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(shown, ['first']);
    assert.deepEqual([...getInteractionQueueView().queuedByConversation], [['a', 2], ['b', 1]]);

    releases.get('first')?.('first-result');
    assert.equal(await first, 'first-result');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(shown, ['first', 'second']);

    releases.get('second')?.('second-result');
    assert.equal(await second, 'second-result');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(shown, ['first', 'second', 'third']);
    releases.get('third')?.('third-result');
    assert.equal(await third, 'third-result');
  });

  it('orders permission and Ask User prompts across three conversations', async () => {
    const shown: string[] = [];
    const releases = new Map<string, (value: string) => void>();
    const enqueue = (
      id: string,
      conversationId: string,
      kind: GenerationInteractionIdentity['kind'],
    ) => enqueueGenerationInteraction({
      identity: interactionIdentity(id, conversationId, kind),
      signal: new AbortController().signal,
      validateOwnership: () => true,
      present: () => new Promise<string>((resolve) => {
        shown.push(id);
        releases.set(id, resolve);
      }),
      abortedResult: () => 'aborted',
      unavailableResult: () => 'unavailable',
    });

    const permissionFirst = enqueue('permission-first', 'a', 'permission');
    const askSecond = enqueue('ask-second', 'b', 'ask-user');
    const permissionThird = enqueue('permission-third', 'c', 'permission');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(shown, ['permission-first']);

    releases.get('permission-first')?.('allowed');
    assert.equal(await permissionFirst, 'allowed');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(shown, ['permission-first', 'ask-second']);

    releases.get('ask-second')?.('answered');
    assert.equal(await askSecond, 'answered');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(shown, ['permission-first', 'ask-second', 'permission-third']);
    releases.get('permission-third')?.('allowed');
    assert.equal(await permissionThird, 'allowed');
  });

  it('keeps Ask User ahead of a later permission prompt', async () => {
    const shown: string[] = [];
    const releases = new Map<string, (value: string) => void>();
    const enqueue = (
      id: string,
      conversationId: string,
      kind: GenerationInteractionIdentity['kind'],
    ) => enqueueGenerationInteraction({
      identity: interactionIdentity(id, conversationId, kind),
      signal: new AbortController().signal,
      validateOwnership: () => true,
      present: () => new Promise<string>((resolve) => {
        shown.push(id);
        releases.set(id, resolve);
      }),
      abortedResult: () => 'aborted',
      unavailableResult: () => 'unavailable',
    });

    const askFirst = enqueue('ask-first', 'a', 'ask-user');
    const permissionSecond = enqueue('permission-second', 'b', 'permission');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(shown, ['ask-first']);

    releases.get('ask-first')?.('answered');
    assert.equal(await askFirst, 'answered');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(shown, ['ask-first', 'permission-second']);
    releases.get('permission-second')?.('allowed');
    assert.equal(await permissionSecond, 'allowed');
  });

  it('removes aborted queued prompts and fences stale visible delivery', async () => {
    let releaseFirst!: (value: string) => void;
    const first = enqueueGenerationInteraction({
      identity: interactionIdentity('first', 'a'),
      signal: new AbortController().signal,
      validateOwnership: () => true,
      present: () => new Promise<string>((resolve) => { releaseFirst = resolve; }),
      abortedResult: () => 'aborted',
      unavailableResult: () => 'unavailable',
    });
    const controller = new AbortController();
    let secondPresented = false;
    const second = enqueueGenerationInteraction({
      identity: interactionIdentity('second', 'b'),
      signal: controller.signal,
      validateOwnership: () => true,
      present: async () => { secondPresented = true; return 'shown'; },
      abortedResult: () => 'aborted',
      unavailableResult: () => 'unavailable',
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    controller.abort();
    assert.equal(await second, 'aborted');
    assert.equal(secondPresented, false);
    assert.equal(getInteractionQueueView().visible?.interactionId, 'first');
    releaseFirst('allowed');
    assert.equal(await first, 'allowed');

    let owned = true;
    let releaseStale!: (value: string) => void;
    const stale = enqueueGenerationInteraction({
      identity: interactionIdentity('stale', 'a'),
      signal: new AbortController().signal,
      validateOwnership: () => owned,
      present: () => new Promise<string>((resolve) => { releaseStale = resolve; }),
      abortedResult: () => 'aborted',
      unavailableResult: () => 'unavailable',
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    owned = false;
    releaseStale('allow');
    assert.equal(await stale, 'unavailable');
  });

  it('brackets only FIFO queue wait so tool deadlines can exclude it', async () => {
    let releaseFirst!: (value: string) => void;
    const first = enqueueGenerationInteraction({
      identity: interactionIdentity('first-budget', 'a'),
      signal: new AbortController().signal,
      validateOwnership: () => true,
      present: () => new Promise<string>((resolve) => { releaseFirst = resolve; }),
      abortedResult: () => 'aborted',
      unavailableResult: () => 'unavailable',
    });
    const events: string[] = [];
    const second = enqueueGenerationInteraction({
      identity: interactionIdentity('second-budget', 'b'),
      signal: new AbortController().signal,
      validateOwnership: () => true,
      present: async () => {
        events.push('visible');
        return 'allowed';
      },
      abortedResult: () => 'aborted',
      unavailableResult: () => 'unavailable',
      onQueueWaitStart: () => events.push('queued'),
      onQueueWaitEnd: () => events.push('queue-ended'),
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(events, ['queued']);

    releaseFirst('allowed');
    await first;
    assert.equal(await second, 'allowed');
    assert.deepEqual(events, ['queued', 'queue-ended', 'visible']);
  });

  it('aborts visible presentation when the absolute attention cap expires', async () => {
    let presentationAborted = false;
    const result = enqueueGenerationInteraction({
      identity: interactionIdentity('attention-cap', 'a'),
      signal: new AbortController().signal,
      validateOwnership: () => true,
      present: (presentationSignal) => new Promise<string>(() => {
        presentationSignal.addEventListener('abort', () => {
          presentationAborted = true;
        }, { once: true });
      }),
      abortedResult: () => 'aborted',
      unavailableResult: () => 'unavailable',
      absoluteAttentionMs: 5,
    });
    assert.equal(await result, 'unavailable');
    assert.equal(presentationAborted, true);
    assert.equal(getInteractionQueueView().visible, undefined);
  });
});

describe('generation session ownership', () => {
  it('registers a session and exposes it as a stable projection', () => {
    const runtime = start('conv-a', 'gen-1');

    const first = getGenerationSessionView('conv-a');
    const second = getGenerationSessionView('conv-a');
    assert.ok(first);
    assert.equal(first, second, 'the view is referentially stable between reads');
    assert.equal(first.generationId, 'gen-1');
    assert.equal(first.phase, 'running');
    assert.equal(first.tps, null);

    // The controller is runtime-only and must never reach the projection.
    assert.equal('controller' in first, false);
    assert.ok(runtime.controller instanceof AbortController);
  });

  it('reports no view for a conversation without a session', () => {
    assert.equal(getGenerationSessionView('conv-idle'), undefined);
    assert.equal(getGenerationSessionView(null), undefined);
    assert.equal(getGenerationSessionView(undefined), undefined);
  });

  it('refuses a second session for one conversation', () => {
    start('conv-a', 'gen-1');
    assert.throws(() => start('conv-a', 'gen-2'), /already owns generation gen-1/);
  });

  it('defaults to capacity two while retaining a hard maximum of three', () => {
    assert.equal(DEFAULT_GENERATION_CAPACITY, 2);
    assert.equal(GENERATION_CAPACITY, 3);
    assert.equal(hasGenerationCapacity(), true);

    start('conv-a', 'gen-1');
    start('conv-b', 'gen-2');
    assert.equal(activeGenerationCount(), 2);
    assert.equal(hasGenerationCapacity(), false);

    endGenerationSession('conv-a', 'gen-1');
    assert.equal(hasGenerationCapacity(), true);
  });

  it('refuses a session once every slot is taken', () => {
    setGenerationCapacityForTests(3);
    start('conv-a', 'gen-1');
    start('conv-b', 'gen-2');
    start('conv-c', 'gen-3');
    assert.throws(() => start('conv-d', 'gen-4'), /All 3 generation slots are in use/);
    assert.equal(activeGenerationCount(), 3, 'the rejected session left no trace');
  });

  it('tracks sessions in different conversations independently', () => {
    // The registry must be able to hold more than one session before the
    // product is allowed to admit more than one. Raising the limit explicitly
    // is what keeps this test honest about which of the two is being relaxed.
    setGenerationCapacityForTests(3);
    start('conv-a', 'gen-a');
    start('conv-b', 'gen-b');

    assert.equal(activeGenerationCount(), 2);
    assert.equal(getGenerationSessionView('conv-a')?.generationId, 'gen-a');
    assert.equal(getGenerationSessionView('conv-b')?.generationId, 'gen-b');

    endGenerationSession('conv-a', 'gen-a');
    assert.equal(getGenerationSessionView('conv-a'), undefined);
    assert.equal(getGenerationSessionView('conv-b')?.generationId, 'gen-b', 'the sibling survives');
  });
});

describe('conversation-keyed generation phases', () => {
  it('keeps simultaneous phase/TPS projections isolated and fences stale cleanup', () => {
    setGenerationCapacityForTests(2);
    start('conv-a', 'gen-a');
    start('conv-b', 'gen-b');
    const a = createGenerationPhaseTracker('conv-a', 'gen-a');
    const b = createGenerationPhaseTracker('conv-b', 'gen-b');
    const bEvents: string[] = [];
    const unsubscribe = onPhaseChange('conv-b', (phase) => bEvents.push(phase.toolUse));

    a.reasoning.started();
    a.reasoning.running();
    assert.equal(getPhase('conv-a').reasoning, 'running');
    assert.equal(getPhase('conv-b').reasoning, 'idle');
    assert.equal(getGenerationSessionView('conv-a')?.phase, 'thinking');
    assert.equal(getGenerationSessionView('conv-b')?.phase, 'running');
    assert.deepEqual(bEvents, []);

    b.toolUse.started();
    b.toolUse.running();
    assert.equal(getPhase('conv-b').toolUse, 'running');
    assert.equal(getGenerationSessionView('conv-b')?.phase, 'using-tools');
    a.clear();
    assert.equal(getPhase('conv-b').toolUse, 'running');
    unsubscribe();
  });
});

describe('immutable generation execution snapshots', () => {
  it('keeps model-detail results isolated by exact profile identity', async () => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        data: [{
          id: 'shared-model',
          max_input_tokens: fetchCalls === 1 ? 8_192 : 131_072,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const commonRoute = {
      baseUrl: 'https://shared-endpoint.example/v1',
      apiVariant: 'openai',
      routing: 'direct',
      modelsCache: {},
      fetchImpl,
    } as const;

    const first = await getCachedModelDetail(
      { ...commonRoute, profileId: 'profile-a', apiKey: 'secret-a' },
      'shared-model',
    );
    const second = await getCachedModelDetail(
      { ...commonRoute, profileId: 'profile-b', apiKey: 'secret-b' },
      'shared-model',
    );

    assert.equal(first?.max_context_length, 8_192);
    assert.equal(second?.max_context_length, 131_072);
    assert.equal(fetchCalls, 2, 'each profile owns a distinct detail-cache key');
  });

  it('invalidates model-detail reuse after profile configuration changes', async () => {
    let fetchCalls = 0;
    const route = {
      profileId: 'profile-config',
      baseUrl: 'https://config-change.example/v1',
      apiVariant: 'openai',
      routing: 'direct',
      modelsCache: {},
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: [{
          id: 'configured-model',
          max_input_tokens: fetchCalls === 1 ? 4_096 : 65_536,
        }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    } as const;

    assert.equal((await getCachedModelDetail(route, 'configured-model'))?.max_context_length, 4_096);
    invalidateGenerationModelDetailConfiguration();
    assert.equal((await getCachedModelDetail(route, 'configured-model'))?.max_context_length, 65_536);
    assert.equal(fetchCalls, 2);
  });

  it('expires successful model details after the bounded TTL', async () => {
    const originalNow = Date.now;
    let now = 1_000;
    let fetchCalls = 0;
    Date.now = () => now;
    const route = {
      profileId: 'profile-expiry',
      baseUrl: 'https://expiry.example/v1',
      apiVariant: 'openai',
      routing: 'direct',
      modelsCache: {},
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: [{ id: 'expiry-model' }] }), { status: 200 });
      },
    } as const;
    try {
      await getCachedModelDetail(route, 'expiry-model');
      now += 60_000;
      await getCachedModelDetail(route, 'expiry-model');
      assert.equal(fetchCalls, 2);
    } finally {
      Date.now = originalNow;
    }
  });

  it('evicts the least-recent detail when more than 32 keys are cached', async () => {
    let fetchCalls = 0;
    const ids = Array.from({ length: 33 }, (_, index) => `pressure-model-${index}`);
    const route = {
      profileId: 'profile-pressure',
      baseUrl: 'https://pressure.example/v1',
      apiVariant: 'openai',
      routing: 'direct',
      modelsCache: {},
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
      },
    } as const;

    for (const id of ids) await getCachedModelDetail(route, id);
    await getCachedModelDetail(route, ids[0]);
    assert.equal(fetchCalls, 34);
  });

  it('does not cache failed detail lookups', async () => {
    let fetchCalls = 0;
    const route = {
      profileId: 'profile-retry',
      baseUrl: 'https://retry.example/v1',
      apiVariant: 'openai',
      routing: 'direct',
      modelsCache: {},
      fetchImpl: async () => {
        fetchCalls += 1;
        return fetchCalls === 1
          ? new Response('failed', { status: 500 })
          : new Response(JSON.stringify({ data: [{ id: 'retry-model' }] }), { status: 200 });
      },
    } as const;

    assert.equal(await getCachedModelDetail(route, 'retry-model'), null);
    assert.equal((await getCachedModelDetail(route, 'retry-model'))?.id, 'retry-model');
    assert.equal(fetchCalls, 2);
  });

  it('aborts a shared detail request when its final waiter leaves', async () => {
    let requestAborted = false;
    const route = {
      profileId: 'profile-final-abort',
      baseUrl: 'https://final-abort.example/v1',
      apiVariant: 'openai',
      routing: 'direct',
      modelsCache: {},
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          requestAborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
    } as const;
    const controller = new AbortController();
    const pending = getCachedModelDetail(route, 'abort-model', controller.signal);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    controller.abort();

    assert.equal(await pending, null);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(requestAborted, true);
  });

  it('deduplicates in-flight model details and reuses the bounded TTL cache', async () => {
    let fetchCalls = 0;
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const route = {
      profileId: 'profile-cache',
      baseUrl: 'https://model-detail-cache.example/v1',
      apiVariant: 'openai',
      routing: 'direct',
      modelsCache: {},
      fetchImpl: async () => {
        fetchCalls += 1;
        await fetchGate;
        return new Response(JSON.stringify({
          data: [{ id: 'cached-model', capabilities: { vision: true } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    } as const;

    const first = getCachedModelDetail(route, 'cached-model');
    const second = getCachedModelDetail(route, 'cached-model');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(fetchCalls, 1);

    releaseFetch();
    assert.equal((await first)?.id, 'cached-model');
    assert.equal((await second)?.id, 'cached-model');
    assert.equal((await getCachedModelDetail(route, 'cached-model'))?.id, 'cached-model');
    assert.equal(fetchCalls, 1, 'the successful detail remains cached');
  });

  it('keeps a shared lookup alive when only one conversation cancels', async () => {
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const route = {
      profileId: 'profile-cancel',
      baseUrl: 'https://model-detail-cancel.example/v1',
      apiVariant: 'openai',
      routing: 'direct',
      modelsCache: {},
      fetchImpl: async () => {
        await fetchGate;
        return new Response(JSON.stringify({ data: [{ id: 'shared-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    } as const;
    const cancelled = new AbortController();
    const sibling = new AbortController();
    const first = getCachedModelDetail(route, 'shared-model', cancelled.signal);
    const second = getCachedModelDetail(route, 'shared-model', sibling.signal);

    cancelled.abort();
    assert.equal(await first, null);
    releaseFetch();
    assert.equal((await second)?.id, 'shared-model');
  });

  it('deep-clones configuration while credentials remain in adjacent runtime state', () => {
    const source = {
      conversation: { id: 'conversation-a', title: 'Snapshot title', params: { system_prompt: 'Frozen' } },
      profile: { id: 'profile-a', name: 'Profile A', baseUrl: 'http://local', sseReadTimeoutMin: 5 },
      systemPrompt: 'Frozen',
      workspace: { toolCallingSupported: true },
      exposedToolNames: ['lc_read_file'],
      structuredTools: [],
      modelRegistry: { records: {}, overrides: {}, customizations: {}, models: [] },
      modelDetail: { type: 'llm', key: 'model-a', max_context_length: 32_768 },
      toolRuntime: {
        searchProvider: { provider: 'brave', baseUrl: '' },
        visionModel: 'vision-a',
        webResearchModel: 'research-a',
        pdfSummarizeModel: 'pdf-a',
        shellAllowlist: ['git'],
        helperRoutes: {
          'profile-a::vision-a': {
            modelId: 'vision-a',
            baseUrl: 'https://example.invalid/v1',
            apiVariant: 'openai',
            apiStyle: 'chat',
            routing: 'direct',
            modelDetail: { type: 'vlm', key: 'vision-a' },
          },
        },
      },
      capturedAt: 1,
    } as unknown as GenerationExecutionSnapshot;
    const snapshot = freezeGenerationExecutionSnapshot(source);
    (source.conversation as { title: string }).title = 'Mutated title';
    const runtimeSecrets = {
      searchProviderApiKey: 'snapshot-secret-key',
      helperApiKeys: { 'profile-a::vision-a': 'helper-secret-key' },
    };

    assert.equal(snapshot.conversation.title, 'Snapshot title');
    assert.equal(Object.isFrozen(snapshot.conversation.params), true);
    assert.equal(JSON.stringify(snapshot).includes(runtimeSecrets.searchProviderApiKey), false);
    assert.equal(JSON.stringify(snapshot).includes(runtimeSecrets.helperApiKeys['profile-a::vision-a']), false);
    assert.equal(snapshot.modelDetail?.max_context_length, 32_768);
    assert.equal(runtimeSecrets.searchProviderApiKey, 'snapshot-secret-key');
  });
});

describe('generation fencing', () => {
  it('a stale phase tracker cannot replace its successor\'s phase map', () => {
    const stale = start('conv-a', 'gen-old');
    const oldTracker = createGenerationPhaseTracker('conv-a', 'gen-old');
    oldTracker.reasoning.running();
    endGenerationSession('conv-a', 'gen-old');

    start('conv-a', 'gen-new');
    const current = createGenerationPhaseTracker('conv-a', 'gen-new');
    current.reset();
    current.textResponse.running();
    oldTracker.toolUse.running();
    oldTracker.clear();

    assert.equal(stale.generationId, 'gen-old');
    assert.equal(getPhase('conv-a').textResponse, 'running');
    assert.equal(getPhase('conv-a').toolUse, 'idle');
    assert.equal(getGenerationSessionView('conv-a')?.phase, 'writing');
  });

  it('retains background completion/error attention until the chat is viewed', () => {
    start('conv-a', 'gen-1');
    endGenerationSession('conv-a', 'gen-1', { unread: true, outcome: 'completed' });
    assert.equal(getGenerationAttention('conv-a')?.kind, 'completed');

    clearGenerationAttention('conv-a');
    assert.equal(getGenerationAttention('conv-a'), undefined);

    start('conv-a', 'gen-2');
    setGenerationSessionPhase('conv-a', 'gen-2', 'failed');
    endGenerationSession('conv-a', 'gen-2', { unread: true });
    assert.equal(getGenerationAttention('conv-a')?.kind, 'failed');
  });

  it('a stale generation cannot end its successor', () => {
    start('conv-a', 'gen-1');
    endGenerationSession('conv-a', 'gen-1');
    start('conv-a', 'gen-2');

    assert.equal(endGenerationSession('conv-a', 'gen-1'), false);
    assert.equal(getGenerationSessionView('conv-a')?.generationId, 'gen-2');
  });

  it('a stale generation cannot write tps or phase', () => {
    start('conv-a', 'gen-2');

    setGenerationSessionTps('conv-a', 'gen-1', 99);
    setGenerationSessionPhase('conv-a', 'gen-1', 'failed');

    const view = getGenerationSessionView('conv-a');
    assert.equal(view?.tps, null);
    assert.equal(view?.phase, 'running');
  });

  it('reports ownership by conversation and generation together', () => {
    start('conv-a', 'gen-1');
    assert.equal(isGenerationSessionOwner('conv-a', 'gen-1'), true);
    assert.equal(isGenerationSessionOwner('conv-a', 'gen-2'), false);
    assert.equal(isGenerationSessionOwner('conv-b', 'gen-1'), false);
  });
});

describe('cancellation', () => {
  it('marks stopping and aborts only the targeted session', () => {
    setGenerationCapacityForTests(3);
    const a = start('conv-a', 'gen-a');
    const b = start('conv-b', 'gen-b');

    const cancelled = cancelGenerationSession('conv-a');

    assert.equal(cancelled?.generationId, 'gen-a');
    assert.equal(a.controller.signal.aborted, true);
    assert.equal(b.controller.signal.aborted, false, 'the sibling keeps running');
    assert.equal(getGenerationSessionView('conv-a')?.phase, 'stopping');
    assert.equal(getGenerationSessionView('conv-b')?.phase, 'running');
  });

  it('cancels the middle owner without affecting two siblings', () => {
    setGenerationCapacityForTests(3);
    const first = start('conv-a', 'gen-a');
    const middle = start('conv-b', 'gen-b');
    const third = start('conv-c', 'gen-c');

    assert.equal(cancelGenerationSession('conv-b')?.generationId, 'gen-b');
    assert.equal(first.controller.signal.aborted, false);
    assert.equal(middle.controller.signal.aborted, true);
    assert.equal(third.controller.signal.aborted, false);
    assert.equal(getGenerationSessionView('conv-a')?.phase, 'running');
    assert.equal(getGenerationSessionView('conv-b')?.phase, 'stopping');
    assert.equal(getGenerationSessionView('conv-c')?.phase, 'running');
  });

  it('keeps the session registered until the pipeline settles', () => {
    // Deregistering on abort would let late work admit a replacement
    // generation while the cancelled one is still unwinding.
    start('conv-a', 'gen-a');
    cancelGenerationSession('conv-a');

    assert.equal(activeGenerationCount(), 1);
    assert.ok(getGenerationSession('conv-a'));

    endGenerationSession('conv-a', 'gen-a');
    assert.equal(activeGenerationCount(), 0);
  });

  it('cancelling a conversation with no session is a no-op', () => {
    assert.equal(cancelGenerationSession('conv-idle'), undefined);
  });

  it('a fenced cancel cannot stop a replacement generation', () => {
    // A deferred callback holding the generation it captured earlier must not
    // cancel the run that replaced it.
    const replacement = start('conv-a', 'gen-2');

    assert.equal(cancelGenerationSession('conv-a', 'gen-1'), undefined);
    assert.equal(replacement.controller.signal.aborted, false);
    assert.equal(getGenerationSessionView('conv-a')?.phase, 'running');

    // Unfenced cancel is the Stop button: stop whatever is running here.
    assert.equal(cancelGenerationSession('conv-a')?.generationId, 'gen-2');
    assert.equal(replacement.controller.signal.aborted, true);
  });
});

describe('subscription', () => {
  it('notifies only the subscriber for the changed conversation', () => {
    let conversationA = 0;
    let conversationB = 0;
    const unsubscribeA = subscribeToGenerationSession('conv-a', () => { conversationA += 1; });
    const unsubscribeB = subscribeToGenerationSession('conv-b', () => { conversationB += 1; });

    start('conv-a', 'gen-a');
    setGenerationSessionTps('conv-a', 'gen-a', 42);
    start('conv-b', 'gen-b');

    assert.equal(conversationA, 2);
    assert.equal(conversationB, 1);
    unsubscribeA();
    unsubscribeB();
  });

  it('notifies an attention-only row when the test registry resets', () => {
    start('conv-a', 'gen-a');
    endGenerationSession('conv-a', 'gen-a', { unread: true });
    assert.equal(getGenerationAttention('conv-a')?.kind, 'completed');

    let notifications = 0;
    const unsubscribe = subscribeToGenerationSession('conv-a', () => {
      notifications += 1;
    });

    resetGenerationSessionsForTests();

    assert.equal(notifications, 1);
    assert.equal(getGenerationAttention('conv-a'), undefined);
    unsubscribe();
  });

  it('notifies and advances the version on every change', () => {
    let notifications = 0;
    const unsubscribe = subscribeToGenerationSessions(() => { notifications += 1; });
    const before = getGenerationSessionsVersion();

    start('conv-a', 'gen-1');
    setGenerationSessionTps('conv-a', 'gen-1', 42);
    endGenerationSession('conv-a', 'gen-1');

    assert.equal(notifications, 3);
    assert.ok(getGenerationSessionsVersion() > before);
    unsubscribe();
  });

  it('does not notify when a write changes nothing', () => {
    start('conv-a', 'gen-1');
    setGenerationSessionTps('conv-a', 'gen-1', 42);

    let notifications = 0;
    const unsubscribe = subscribeToGenerationSessions(() => { notifications += 1; });
    setGenerationSessionTps('conv-a', 'gen-1', 42);
    setGenerationSessionPhase('conv-a', 'gen-1', 'running');

    assert.equal(notifications, 0, 'a no-op write must not re-render subscribers');
    unsubscribe();
  });

  it('a throwing subscriber does not stop the others', () => {
    let reached = false;
    const first = subscribeToGenerationSessions(() => { throw new Error('bad subscriber'); });
    const second = subscribeToGenerationSessions(() => { reached = true; });

    start('conv-a', 'gen-1');

    assert.equal(reached, true);
    first();
    second();
  });
});

describe('page exit', () => {
  it('lists every live session as a snapshot safe to iterate while ending them', () => {
    setGenerationCapacityForTests(3);
    start('conv-a', 'gen-a');
    start('conv-b', 'gen-b');

    const snapshot = activeGenerationSessions();
    assert.equal(snapshot.length, 2);

    for (const session of snapshot) {
      session.controller.abort();
      endGenerationSession(session.conversationId, session.generationId);
    }

    assert.equal(activeGenerationCount(), 0);
  });
});
