/**
 * `activeRequest` describes the request that actually ran.
 *
 * The reviewed implementation reconstructed "the active request" from whichever
 * conversation and profile were selected when the report was generated, while
 * its comment claimed it was the most recent request. Switching conversations
 * or editing a profile afterwards silently rewrote the facts a maintainer was
 * reading.
 *
 * These tests drive the real collector against the real stores, and the real
 * `LLMClient.chatStream` boundary for the snapshot.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

// The profile and settings stores persist through zustand's middleware.
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

const [
  collectorModule,
  clientModule,
  snapshotModule,
  diagnosticsModule,
  conversationsModule,
  profileModule,
  modelModule,
  typesModule,
  imageCacheModule,
  sessionModule,
  reportModule,
  settingsModule,
] = await Promise.all([
  import('./support-report-collector.ts'),
  import('../modules/llm-client/client.ts'),
  import('../modules/llm-client/request-snapshot.ts'),
  import('./diagnostic-events.ts'),
  import('../store/conversations.ts'),
  import('../modules/server-profiles/profile-store.ts'),
  import('../modules/server-profiles/model-store.ts'),
  import('../types.ts'),
  import('../modules/tool-engine/builtin/read_image.ts'),
  import('../modules/chat-pipeline/generation-session-manager.ts'),
  import('./support-report.ts'),
  import('../store/settings.ts'),
]);

const { collectSupportReportSources } = collectorModule;
const { LLMClient } = clientModule;
const { resetActiveRequestSnapshot } = snapshotModule;
const { resetDiagnosticEvents } = diagnosticsModule;
const { useConversations } = conversationsModule;
const { useProfileStore } = profileModule;
const { useAppModels } = modelModule;
const { DEFAULT_PARAMS } = typesModule;
const { cacheImageBatch, clearImageBatches } = imageCacheModule;
const {
  activeGenerationSessions,
  resetGenerationSessionsForTests,
  setGenerationCapacityForTests,
  setGenerationSessionPhase,
  startGenerationSession,
} = sessionModule;
const { createSupportReportSnapshotV1 } = reportModule;
const { useSettings } = settingsModule;

function sseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n'
        + 'data: [DONE]\n\n',
      ));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function seedProfiles(): void {
  useProfileStore.setState({
    profiles: [
      {
        id: 'anthropic-profile',
        name: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiVariant: 'anthropic',
        routing: 'direct',
        active: true,
      },
      {
        id: 'openai-profile',
        name: 'openai',
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiVariant: 'openai',
        apiStyle: 'chat',
        routing: 'proxy',
        active: true,
      },
    ],
  } as unknown as Parameters<typeof useProfileStore.setState>[0]);
}

function seedConversation(id: string, serverId: string): void {
  useConversations.setState((state) => ({
    byId: {
      ...state.byId,
      [id]: {
        id,
        title: id,
        serverId,
        model: 'test-model',
        params: { ...DEFAULT_PARAMS },
        createdAt: 1,
        updatedAt: 2,
        messageCount: 0,
        messages: [],
      },
    },
    order: [id, ...state.order.filter((entry) => entry !== id)],
    activeId: id,
  }));
}

async function activeRequest(): Promise<Record<string, unknown>> {
  const sources = await collectSupportReportSources();
  return (sources.activeRequest ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  resetDiagnosticEvents();
  resetActiveRequestSnapshot();
  clearImageBatches();
  resetGenerationSessionsForTests();
  useAppModels.setState({ models: [] });
  useConversations.setState({ byId: {}, order: [], activeId: null });
});

describe('activeRequest prefers the request that ran over current UI state', () => {
  it('labels a pre-request report as current configuration, never as a request', async () => {
    seedProfiles();
    seedConversation('conv-a', 'openai-profile');

    const request = await activeRequest();

    assert.equal(request.source, 'current-configuration');
    // No request has been assembled, so there is no tool-definition count to
    // report. The old implementation counted policy keys here instead.
    assert.equal(request.toolDefinitionCount, undefined);
  });

  it('keeps the historical request after the active conversation changes', async () => {
    seedProfiles();
    seedConversation('conv-anthropic', 'anthropic-profile');

    // The request that actually ran: Anthropic, one tool definition.
    const client = new LLMClient({
      baseUrl: 'https://api.anthropic.com',
      apiVariant: 'anthropic',
      routing: 'direct',
      streamFetchImpl: async () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
              + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    });
    await client.chatStream({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoningEnabled: false,
      tools: [{
        type: 'function',
        function: { name: 'a', description: 'a', parameters: { type: 'object', properties: {} } },
      }],
    }, { onDelta: () => {} }, undefined, 120_000);

    // Now the user switches to a different conversation on a different
    // provider and edits its configuration, exactly as they would while
    // preparing to report the failure they just saw.
    seedConversation('conv-openai', 'openai-profile');
    useProfileStore.getState().updateProfile('openai-profile', { routing: 'proxy' });

    const request = await activeRequest();

    assert.equal(request.source, 'request');
    assert.equal(request.protocol, 'anthropic');
    assert.equal(request.routing, 'direct');
    assert.equal(request.endpointClass, 'public-https');
    assert.equal(request.toolDefinitionCount, 1);
  });

  it('keeps the historical request after its conversation configuration is edited', async () => {
    seedProfiles();
    seedConversation('conv-openai', 'openai-profile');

    const client = new LLMClient({
      baseUrl: 'http://127.0.0.1:1234/v1',
      routing: 'proxy',
      streamFetchImpl: async () => sseResponse(),
    });
    await client.chatStream({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoningEnabled: true,
      reasoningEffort: 'high',
    }, { onDelta: () => {} }, undefined, 60_000);

    useConversations.setState((state) => ({
      byId: {
        ...state.byId,
        'conv-openai': {
          ...state.byId['conv-openai'],
          params: { ...DEFAULT_PARAMS, reasoning_enabled: false, reasoning_effort: 'low' },
        },
      },
    }));

    const request = await activeRequest();

    assert.equal(request.source, 'request');
    assert.equal(request.reasoningEnabled, true);
    assert.equal(request.reasoningEffort, 'high');
    assert.equal(request.endpointClass, 'loopback');
  });

  it('collects without reading a credential or refreshing a model list', async () => {
    seedProfiles();
    seedConversation('conv-openai', 'openai-profile');
    const sources = await collectSupportReportSources();
    const serialized = JSON.stringify(sources.activeRequest);
    for (const forbidden of ['apiKey', 'apiKeyRef', 'Authorization']) {
      assert.ok(!serialized.includes(forbidden), `activeRequest must not carry ${forbidden}`);
    }
  });

  it('collects recent request and image-cache diagnostics from their production seams', async () => {
    seedProfiles();
    seedConversation('conv-openai', 'openai-profile');

    const client = new LLMClient({
      baseUrl: 'http://127.0.0.1:1234/v1',
      routing: 'proxy',
      streamFetchImpl: async () => sseResponse(),
    });
    await client.chatStream({
      model: 'test-model',
      messages: [{ role: 'user', content: 'diagnose me' }],
      stream: true,
      reasoningEnabled: false,
    }, { onDelta: () => {} });
    cacheImageBatch(
      'support-batch',
      [{ path: 'D:/private/image.png', mime: 'image/png', data_url: 'data:image/png;base64,AAAA' }],
      'private-conversation-id',
      'private-generation-id',
      'private-tool-call-id',
    );

    const sources = await collectSupportReportSources();

    const recentRequests = sources.recentRequestSnapshots;
    if (!Array.isArray(recentRequests)) throw new Error('recent request snapshots must be an array');
    assert.equal(recentRequests.length, 1);
    assert.equal(recentRequests[0]?.protocol, 'openai');
    assert.deepEqual(sources.imageCacheMetrics, { batches: 1, bytes: 26, generations: 1 });
    const serialized = JSON.stringify({
      recentRequests: sources.recentRequestSnapshots,
      imageCache: sources.imageCacheMetrics,
    });
    for (const forbidden of [
      'diagnose me',
      'D:/private/image.png',
      'private-conversation-id',
      'private-generation-id',
      'private-tool-call-id',
    ]) {
      assert.ok(!serialized.includes(forbidden), `diagnostics must not carry ${forbidden}`);
    }
  });

  it('treats unsafe SearXNG values as unconfigured without serializing them', async () => {
    const previousTools = useSettings.getState().tools;

    try {
      for (const searxngBaseUrl of [
        'https://PRIVATE_USER:PRIVATE_PASSWORD@search.example.test',
        'https://search.example.test?token=PRIVATE_QUERY_PASSWORD',
        'https://search.example.test#token=PRIVATE_FRAGMENT_PASSWORD',
        'search.example.test?token=PRIVATE_MISSING_SCHEME#access_token=PRIVATE_FRAGMENT_SECRET',
        'https://[invalid?token=PRIVATE_MALFORMED_HOST',
        'data:text/plain,api_key=PRIVATE_SCHEME_SECRET',
        'file:///C:/Users/PRIVATE_SCHEME_USER/search',
        'ftp://search.example.test',
      ]) {
        useSettings.setState({
          tools: {
            ...previousTools,
            brave_search_api_key: '',
            brave_search_api_key_ref: '',
            marginalia_api_key: '',
            marginalia_api_key_ref: '',
            searxng_base_url: searxngBaseUrl,
            web_search_provider: 'searxng',
          },
        });
        const sources = await collectSupportReportSources();
        const search = sources.search as Record<string, unknown>;
        const snapshot = createSupportReportSnapshotV1(sources, {});
        assert.equal(search.configured, false);
        assert.deepEqual(search.configuredProviders, []);
        assert.equal(search.searxngBaseUrl, undefined);
        assert.doesNotMatch(
          snapshot.serialized,
          /PRIVATE_USER|PRIVATE_PASSWORD|PRIVATE_QUERY_PASSWORD|PRIVATE_FRAGMENT_PASSWORD|PRIVATE_MISSING_SCHEME|PRIVATE_FRAGMENT_SECRET|PRIVATE_MALFORMED_HOST|PRIVATE_SCHEME_SECRET|PRIVATE_SCHEME_USER/,
        );
      }
    } finally {
      useSettings.setState({ tools: previousTools });
    }
  });

  it('serializes three concurrent sessions as read-only identity-free aggregates', async () => {
    const canaries = [0, 1, 2].map((index) => ({
      conversation: `PRIVATE_CONVERSATION_${index}`,
      generation: `PRIVATE_GENERATION_${index}`,
      message: `PRIVATE_MESSAGE_${index}`,
      profile: `private-profile-${index}`,
      toolCall: `PRIVATE_TOOL_CALL_${index}`,
      title: `Private conversation title ${index}`,
      prompt: `Private request prompt ${index}`,
      path: `D:/private/session-${index}.png`,
      host: `private-session-${index}.example.test`,
      pixels: `PRIVATE_PIXELS_${index}`,
      credential: `PRIVATE_CREDENTIAL_${index}`,
    }));

    setGenerationCapacityForTests(3);
    useProfileStore.setState({
      profiles: canaries.map((canary) => ({
        id: canary.profile,
        name: canary.title,
        baseUrl: `https://${canary.host}/v1`,
        apiKey: canary.credential,
        active: true,
      })),
    });
    useConversations.setState({
      byId: Object.fromEntries(canaries.map((canary) => [canary.conversation, {
        id: canary.conversation,
        title: canary.title,
        serverId: canary.profile,
        model: 'test-model',
        params: { ...DEFAULT_PARAMS },
        createdAt: 1,
        updatedAt: 2,
        messageCount: 0,
        messages: [],
      }])),
      order: canaries.map((canary) => canary.conversation),
      activeId: canaries[0].conversation,
    });

    try {
      for (const [index, canary] of canaries.entries()) {
        startGenerationSession({
          conversationId: canary.conversation,
          generationId: canary.generation,
          assistantMessageId: canary.message,
          controller: new AbortController(),
        });
        setGenerationSessionPhase(
          canary.conversation,
          canary.generation,
          ['writing', 'using-tools', 'finalizing'][index] as 'writing' | 'using-tools' | 'finalizing',
        );
        cacheImageBatch(
          `PRIVATE_BATCH_${index}`,
          [{ path: canary.path, mime: 'image/png', data_url: `data:image/png;base64,${canary.pixels}` }],
          canary.conversation,
          canary.generation,
          canary.toolCall,
        );

        const client = new LLMClient({
          baseUrl: `https://${canary.host}/v1`,
          apiKey: canary.credential,
          streamFetchImpl: async () => sseResponse(),
        });
        await client.chatStream({
          model: 'test-model',
          messages: [{ role: 'user', content: canary.prompt }],
          stream: true,
          reasoningEnabled: false,
        }, { onDelta: () => {} }, undefined, undefined, undefined, {
          diagnosticSessionId: canary.generation,
        });
      }

      const firstSources = await collectSupportReportSources();
      const defaultSnapshot = createSupportReportSnapshotV1(firstSources, {});
      const optedInSnapshot = createSupportReportSnapshotV1(
        firstSources,
        { includeErrorDescriptions: true, includeModelIdentifiers: true },
      );
      const secondSources = await collectSupportReportSources();
      const parsed = JSON.parse(optedInSnapshot.serialized) as {
        streaming: {
          activeCount: number;
          phaseCounts: Record<string, number>;
          recentRequests: unknown[];
          imageCache: { batches: number; generations: number };
        };
      };

      assert.equal(parsed.streaming.activeCount, 3);
      assert.equal(parsed.streaming.phaseCounts.writing, 1);
      assert.equal(parsed.streaming.phaseCounts.usingTools, 1);
      assert.equal(parsed.streaming.phaseCounts.finalizing, 1);
      assert.equal(parsed.streaming.recentRequests.length, 3);
      assert.deepEqual(parsed.streaming.imageCache, firstSources.imageCacheMetrics);
      assert.equal(parsed.streaming.imageCache.batches, 3);
      assert.equal(parsed.streaming.imageCache.generations, 3);
      assert.deepEqual(secondSources.imageCacheMetrics, firstSources.imageCacheMetrics);
      assert.equal(activeGenerationSessions().length, 3);

      for (const snapshot of [defaultSnapshot, optedInSnapshot]) {
        for (const canary of canaries.flatMap((entry) => Object.values(entry))) {
          assert.ok(!snapshot.serialized.includes(String(canary)), `report leaked ${canary}`);
        }
      }
    } finally {
      resetGenerationSessionsForTests();
      clearImageBatches();
    }

    const afterCleanup = createSupportReportSnapshotV1(
      await collectSupportReportSources(),
      { includeErrorDescriptions: true, includeModelIdentifiers: true },
    );
    const cleaned = JSON.parse(afterCleanup.serialized) as {
      streaming: {
        activeCount: number;
        recentRequests: unknown[];
        imageCache: { batches: number; generations: number };
      };
    };
    assert.equal(cleaned.streaming.activeCount, 0);
    assert.equal(cleaned.streaming.recentRequests.length, 3);
    assert.equal(cleaned.streaming.imageCache.batches, 0);
    assert.equal(cleaned.streaming.imageCache.generations, 0);
    for (const canary of canaries.flatMap((entry) => Object.values(entry))) {
      assert.ok(!afterCleanup.serialized.includes(String(canary)), `report leaked ${canary}`);
    }
  });
});
