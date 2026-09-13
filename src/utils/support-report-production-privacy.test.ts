/**
 * Seeded-secret and hostile-input coverage for the **production** event paths.
 *
 * The existing support-report.md canary tests seed secrets into the report builder's
 * sources. That proves the builder redacts what it is handed; it cannot prove
 * that a shipped emitter never puts a secret into the ring in the first place.
 *
 * This drives the real storage, credential, search, model-discovery, provider,
 * and tool emitters with hostile values, then serializes a real v1 report from
 * whatever they recorded.
 */
import { describe, it } from 'node:test';
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

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

const keychain = new Map<string, string>();
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: Record<string, unknown>) =>
        command === 'keychain_get' ? keychain.get(String(args.key ?? '')) ?? null : null,
    },
    isSecureContext: true,
  },
});

const [
  diagnosticsModule, reportModule, dbModule, chatCredentialModule,
  clientModule, listModule, searchProviderModule, webSearchModule, runnerModule, typesModule,
] = await Promise.all([
  import('./diagnostic-events.ts'),
  import('./support-report.ts'),
  import('../store/db.ts'),
  import('../platform/chat-credential.ts'),
  import('../modules/llm-client/client.ts'),
  import('../modules/llm-client/models/list.ts'),
  import('../modules/tool-engine/search-provider.ts'),
  import('../modules/tool-engine/builtin/web_search.ts'),
  import('../modules/tool-engine/runner.ts'),
  import('../types.ts'),
]);

const { readDiagnosticEvents, resetDiagnosticEvents } = diagnosticsModule;
const { createSupportReportSnapshotV1 } = reportModule;
const { loadAllMeta, loadMessages, saveMeta, saveMessage } = dbModule;
const { resolveChatCredential } = chatCredentialModule;
const { LLMClient } = clientModule;
const { listModels } = listModule;
const { resolveSearchProvider } = searchProviderModule;
const { webSearch } = webSearchModule;
const { executeToolCall, recordBlockedPermission } = runnerModule;
const { DEFAULT_PARAMS } = typesModule;

/**
 * One unique token seeded into every value a production emitter can see. If it
 * appears anywhere in the serialized report, some path carried user data.
 */
const SECRET = 'LCSEEDEDCANARY7f3b91d4';

/** Shapes a report must never contain, regardless of where they came from. */
const CANARIES = [
  SECRET,
  `sk-proj-${SECRET}`,
  `sk-ant-api03-${SECRET}`,
  `BSA${SECRET}`,
  `marginalia_${SECRET}`,
  `sk-or-v1-${SECRET}`,
  `Authorization: Bearer ${SECRET}`,
  `Cookie: session=${SECRET}`,
  `session_id=${SECRET}`,
  `prompt_cache_key=${SECRET}`,
  `https://searx.${SECRET}.internal`,
  `C:\\Users\\${SECRET}\\notes.txt`,
  `/home/${SECRET}/notes.txt`,
  `${SECRET}@example.test`,
];

async function driveProductionEmitters(): Promise<void> {
  const conversationId = `canary-${crypto.randomUUID()}`;

  // Storage: hydrate, indexed read, durable write.
  await saveMeta({
    id: conversationId,
    title: `${SECRET} conversation title`,
    model: `${SECRET}-model`,
    serverId: SECRET,
    params: { ...DEFAULT_PARAMS, system_prompt: `system ${SECRET}` },
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    messages: [],
  });
  await saveMessage(
    { id: `${conversationId}-m`, role: 'user', content: `prompt ${SECRET}`, createdAt: 1, sortOrder: 1 },
    conversationId,
  );
  await loadMessages(conversationId);
  await loadAllMeta();

  // Credential bootstrap.
  keychain.set(`ref-${SECRET}`, `sk-proj-${SECRET}`);
  await resolveChatCredential({ apiKeyRef: `ref-${SECRET}`, apiKey: `sk-proj-${SECRET}` });

  // Search resolution and a provider failure whose message echoes the query.
  resolveSearchProvider({
    brave_search_api_key: `BSA${SECRET}`,
    brave_search_api_key_ref: undefined,
    searxng_base_url: `https://searx.${SECRET}.internal`,
    marginalia_api_key: `marginalia_${SECRET}`,
    marginalia_api_key_ref: undefined,
    web_search_provider: 'auto',
  });
  await assert.rejects(() => webSearch.run({ query: `${SECRET} query` }, {
    config: {
      searchProvider: { provider: 'brave', apiKey: `BSA${SECRET}`, baseUrl: '' },
      allowedRoots: [], shellAllowlist: [],
    },
    identity: { operationId: 'op', groupId: 'group' },
    signal: new AbortController().signal,
    sandbox: {
      webSearch: async () => {
        throw new Error(`provider rejected {"query":"${SECRET}","key":"BSA${SECRET}"}`);
      },
    },
  } as never));

  // Model discovery failure carrying a hostile body.
  await assert.rejects(() => listModels(
    `https://models.${SECRET}.test/v1`,
    `https://models.${SECRET}.test/v1`,
    `sk-proj-${SECRET}`,
    async () => new Response(`{"error":"${SECRET}"}`, { status: 403 }),
  ));

  // Provider request failure whose body echoes headers and routing fields.
  const client = new LLMClient({
    baseUrl: `https://chat.${SECRET}.test/v1`,
    apiKey: `sk-ant-api03-${SECRET}`,
    streamFetchImpl: async () => new Response(
      `Authorization: Bearer ${SECRET}\nCookie: session=${SECRET}\nsession_id=${SECRET}\nprompt_cache_key=${SECRET}`,
      { status: 500 },
    ),
  });
  await assert.rejects(() => client.chatStream(
    {
      model: `${SECRET}-model`,
      messages: [{ role: 'user', content: `${SECRET}@example.test wrote C:\\Users\\${SECRET}\\notes.txt` }],
      stream: true,
      reasoningEnabled: false,
    },
    { onDelta: () => {} },
  ));

  // Tool execution failure plus a denied permission flow.
  await executeToolCall(
    { created_at: 0, id: 'c', name: 'lc_run_shell', arguments: `{"cmd":"echo ${SECRET}"}` },
    {},
    {
      name: 'lc_run_shell',
      run: async () => { throw new Error(`/home/${SECRET}/notes.txt not found`); },
    } as never,
    {
      config: { allowedRoots: [`/home/${SECRET}`], shellAllowlist: [SECRET] },
      identity: { operationId: 'op', groupId: 'group' },
      signal: new AbortController().signal,
      sandbox: { abortGroup: () => {} },
    } as never,
    'granted-once',
  );
  recordBlockedPermission('lc_write_file', 'denied');

  // Conversation-state tools keep their canonical name for diagnosis, but
  // their Markdown arguments and results never enter the event vocabulary.
  await executeToolCall(
    {
      created_at: 0,
      id: 'whiteboard-canary',
      name: 'lc_whiteboard',
      arguments: JSON.stringify({ action: 'replace', content: `# ${SECRET} board` }),
    },
    { action: 'replace', content: `# ${SECRET} board` },
    {
      name: 'lc_whiteboard',
      run: async () => ({
        status: 'ok',
        data: { changed: true, model_bytes: SECRET.length },
        issues: [],
        warnings: [],
      }),
    } as never,
    {
      config: {},
      identity: { operationId: 'whiteboard-op', groupId: 'whiteboard-group' },
      signal: new AbortController().signal,
      sandbox: { abortGroup: () => {} },
    } as never,
    'not-required',
  );
}

describe('no production emitter can put a secret into a support report', () => {
  it('keeps a seeded secret out of every event the shipped paths record', async () => {
    resetDiagnosticEvents();
    await driveProductionEmitters();

    const events = readDiagnosticEvents();
    assert.ok(events.length > 0, 'the production paths must have recorded something');
    assert.ok(
      events.some((event) => event.tool === 'lc_whiteboard'),
      'the closed diagnostic vocabulary must preserve the Whiteboard tool name',
    );
    const ring = JSON.stringify(events);
    assert.ok(!ring.includes(SECRET), 'the diagnostic ring itself must not carry the secret');
  });

  it('keeps every canary shape out of the serialized report bytes', async () => {
    resetDiagnosticEvents();
    await driveProductionEmitters();

    // Descriptions are the widest channel, so the strictest case turns them on.
    const snapshot = createSupportReportSnapshotV1(
      { reportSurface: 'settings', diagnosticEvents: readDiagnosticEvents() },
      { includeErrorDescriptions: true, includeModelIdentifiers: true },
    );

    for (const canary of CANARIES) {
      assert.ok(
        !snapshot.serialized.includes(canary),
        `serialized report must not contain ${canary.slice(0, 32)}`,
      );
    }
    assert.ok(snapshot.byteLength <= 64 * 1024);
  });

  it('records only closed vocabulary, never free text, from those paths', async () => {
    resetDiagnosticEvents();
    await driveProductionEmitters();

    const allowed = new Set([
      'at', 'subsystem', 'operation', 'outcome', 'code', 'httpStatus',
      'promptTokens', 'completionTokens', 'totalTokens', 'description',
      'sequence', 'protocol', 'apiStyle', 'routing', 'endpointClass',
      'durationBucket', 'retried', 'usageReported', 'cacheStatus',
      'cacheReportedBy', 'cacheReadTokens', 'cacheWriteTokens', 'cacheMissTokens',
      'prefixConclusion', 'prefixQualifiers', 'tool', 'permission',
      'searchSelected', 'searchResolved', 'searchConfigured',
      'searchConfiguredProviders', 'ignoredParams', 'resultCountBucket',
      'credentialState', 'credentialSurface', 'metadataSource', 'returnedCountBucket',
    ]);
    for (const event of readDiagnosticEvents()) {
      for (const key of Object.keys(event)) {
        assert.ok(allowed.has(key), `unexpected event field ${key}`);
      }
      // Sanitized descriptions are the only strings, and they are drawn from a
      // fixed set of recognized failure classes.
      if (event.description !== undefined) {
        assert.ok(!event.description.includes(SECRET));
      }
    }
  });
});
