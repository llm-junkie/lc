import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORT_REPORT_FORMAT,
  SUPPORT_REPORT_MAX_EVENTS,
  SUPPORT_REPORT_MAX_SERIALIZED_BYTES,
  SUPPORT_REPORT_VERSION,
  buildSupportReportBase,
  classifyEndpoint,
  createSupportReportSnapshot,
  finalRecursiveRedaction,
  isSupportReportBase,
  type SupportReportSources,
} from './support-report-base.ts';

const NOW = new Date('2026-08-03T12:34:56.000Z');

function baseSources(): SupportReportSources {
  return {
    application: { version: '1.0.0', buildChannel: 'test' },
    runtime: {
      kind: 'tauri',
      osFamily: 'windows',
      osVersion: '10.0',
      architecture: 'x86_64',
      tauriVersion: '2.11.1',
      webviewFamily: 'webview2',
      webviewVersion: '140.0.0.0',
      locale: 'en-BE',
      timeZone: 'Europe/Brussels',
      secureContext: true,
    },
    startup: {
      lastCompletedPhase: 'ready',
      incompleteStartCount: 0,
      safeStartState: 'inactive',
      failureCode: 'conversation-storage-unavailable',
    },
    storage: {
      conversationSchemaVersion: 2,
      settingsSchemaVersion: 1,
      profileSchemaVersion: 1,
      conversationCount: 0,
      messageCount: 0,
      approximateBytes: 0,
      quotaBytes: 100_000,
      conversationCountReadable: true,
      messageCountReadable: true,
      estimateReadable: true,
      settingsReadable: true,
      profilesReadable: true,
    },
    providerCount: 2,
    activeProviderCount: 1,
    profiles: [
      {
        baseUrl: 'http://127.0.0.1:1234/v1?secret=yes',
        modelFetchUrl: '/v1/models?api_key=hidden',
        apiVariant: 'openai',
        apiStyle: 'responses',
        routing: 'direct',
        active: true,
      },
      {
        baseUrl: 'https://api.example.test/v1',
        apiVariant: 'anthropic',
        routing: 'proxy',
        active: false,
      },
    ],
    modelCount: 2,
    models: [
      { id: 'org/model-a', capabilities: { vision: true, reasoning: false, tools: true } },
      { id: 'org/model-b', capabilities: { vision: false, reasoning: true } },
    ],
    settings: {
      theme: 'system',
      zoom: 1,
      materialMode: 'auto',
      codeTheme: 'system',
      pinComposer: false,
      tokenMeterStyle: 'donut',
      autoPreviewReasoning: true,
      activeCustomThemeId: null,
      customThemes: [],
      ui: { sidebarOpen: true, sidePanelOpen: false },
      tools: { default_allowed_roots: [], shell_allowlist: '', web_fetch_rate_per_min: 0 },
    },
    activeConversation: {
      tools: {
        enabled: true,
        tool_grants: [],
        file_io_enabled: false,
        shell_enabled: false,
        web_access_enabled: false,
        skills_enabled: false,
        enabled_skill_ids: [],
        allowed_roots: [],
        dir_permissions: {},
        max_tool_rounds_per_turn: 0,
        max_tool_calls_per_batch: 0,
        sse_read_timeout_min: 0,
      },
      custom_skills: [],
    },
    streamingActive: false,
    activeGenerationCount: 0,
    generationPhaseCounts: { finalizing: 2 },
    recentRequestSnapshots: [{
      at: NOW.getTime() - 30_000,
      protocol: 'openai',
      apiStyle: 'responses',
      routing: 'direct',
      endpointClass: 'public-https',
      cacheSurface: 'router',
      reasoningEnabled: true,
      reasoningEffort: 'high',
      streamTimeoutMs: 300_000,
      toolDefinitionCount: 4,
      capabilities: { vision: true, reasoning: true, tools: false },
      contextWindowKnown: true,
    }],
    imageCacheMetrics: { batches: 2, bytes: 4096, generations: 2 },
    diagnosticEvents: [{
      at: 0,
      subsystem: 'stream',
      operation: 'completion',
      outcome: 'ok',
      code: 'finish-stop',
      httpStatus: 200,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    }],
  };
}

describe('support report base projection and allowlist collection', () => {
  test('builds a strict versioned document and preserves explicit zeroes', () => {
    const snapshot = createSupportReportSnapshot(baseSources(), {}, NOW);
    const parsed: unknown = JSON.parse(snapshot.serialized);
    assert.ok(isSupportReportBase(parsed));
    assert.equal(parsed.format, SUPPORT_REPORT_FORMAT);
    assert.equal(parsed.version, SUPPORT_REPORT_VERSION);
    assert.equal(parsed.createdAt, NOW.toISOString());
    assert.equal(parsed.storage.conversationCount, 0);
    assert.equal(parsed.storage.messageCount, 0);
    assert.equal(parsed.storage.approximateBytes, 0);
    assert.equal(parsed.startup.failureCode, 'conversation-storage-unavailable');
    assert.equal(parsed.tools.limits.maxRoundsPerTurn, 0);
    assert.equal(parsed.streaming.phaseCounts.finalizing, 2);
    assert.equal(parsed.tools.policyMode, 'foundation');
    assert.equal(parsed.tools.globalDefaults.webFetchRatePerMinute, 0);
    assert.equal(parsed.streaming.promptTokens, 0);
    assert.equal(parsed.streaming.recentRequests.length, 1);
    assert.equal(parsed.streaming.recentRequests[0].ageBucket, 'under-1m');
    assert.equal(parsed.streaming.recentRequests[0].protocol, 'openai');
    assert.equal(parsed.streaming.recentRequests[0].toolDefinitionCount, 4);
    assert.deepEqual(parsed.streaming.imageCache, { batches: 2, bytes: 4096, generations: 2 });
    assert.ok(snapshot.serialized.endsWith('\n'));
    assert.equal(snapshot.byteLength, new TextEncoder().encode(snapshot.serialized).byteLength);
  });

  test('rejects an envelope with unknown schema keys', () => {
    const parsed = JSON.parse(createSupportReportSnapshot(baseSources(), {}, NOW).serialized) as Record<string, unknown>;
    parsed.unplanned = 'future state dump';
    assert.equal(isSupportReportBase(parsed), false);
  });

  test('does not read API-key properties during collection', () => {
    let reads = 0;
    const profile = {
      baseUrl: 'https://api.example.test/v1',
      apiVariant: 'openai',
      apiStyle: 'chat',
      routing: 'direct',
      active: true,
      get apiKey() {
        reads++;
        throw new Error('API key getter must never be read');
      },
    };
    const settings = baseSources();
    settings.profiles = [profile];
    const snapshot = createSupportReportSnapshot(settings, {}, NOW);
    assert.equal(reads, 0);
    assert.equal(snapshot.serialized.includes('API key getter'), false);
  });

  test('ignores nested unknown keys rather than serializing then deleting them', () => {
    const CANARY = 'CANARY-UNKNOWN-NESTED-SECRET-5f8bc6';
    const sources = baseSources();
    sources.application = {
      ...(sources.application as object),
      arbitrary: { nested: { authorization: CANARY } },
    };
    sources.profiles = [{
      ...(sources.profiles as unknown[])[0] as object,
      headers: { Authorization: `Bearer ${CANARY}` },
      responseBody: CANARY,
    }];
    sources.activeConversation = {
      ...(sources.activeConversation as object),
      messages: [{ content: CANARY, reasoning: CANARY, attachments: [CANARY] }],
      prompt: CANARY,
      toolOutput: CANARY,
    };
    const serialized = createSupportReportSnapshot(sources, { includeErrorDescriptions: true }, NOW).serialized;
    assert.equal(serialized.includes(CANARY), false);
    assert.equal(serialized.includes('responseBody'), false);
    assert.equal(serialized.includes('messages'), false);
  });
});

describe('endpoint classification', () => {
  test('classifies hosts without exposing them', () => {
    assert.equal(classifyEndpoint('http://localhost:1234/v1'), 'loopback');
    assert.equal(classifyEndpoint('https://127.8.9.10/v1'), 'loopback');
    assert.equal(classifyEndpoint('http://[::1]:1234/v1'), 'loopback');
    assert.equal(classifyEndpoint('http://192.168.4.2/v1'), 'private-network');
    assert.equal(classifyEndpoint('https://10.0.0.1/v1'), 'private-network');
    assert.equal(classifyEndpoint('https://[fd12::1]/v1'), 'private-network');
    assert.equal(classifyEndpoint('https://api.example.com/v1'), 'public-https');
    assert.equal(classifyEndpoint('http://api.example.com/v1'), 'public-http');
    assert.equal(classifyEndpoint('file:///home/person/key'), 'invalid');
    assert.equal(classifyEndpoint('not a url'), 'invalid');
  });

  test('report contains endpoint classes but never exact hosts, credentials, queries, or fragments', () => {
    const sources = baseSources();
    sources.profiles = [{
      baseUrl: 'https://user:pass@private.corp.internal:8443/v1?token=canary#frag',
      modelFetchUrl: 'https://models.private.internal/list?key=canary',
      apiVariant: 'openai',
      apiStyle: 'chat',
      routing: 'direct',
      active: true,
    }];
    const serialized = createSupportReportSnapshot(sources, {}, NOW).serialized;
    for (const excluded of ['user', 'pass', 'private.corp.internal', 'models.private.internal', 'token=canary', '#frag']) {
      assert.equal(serialized.includes(excluded), false, excluded);
    }
    assert.match(serialized, /"endpointClass": "private-network"/);
  });
});

describe('redaction canaries', () => {
  const canaries = [
    'Bearer eyJhbGciOiJIUzI1NiJ9.canary.signature',
    'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
    'BSAabcdefghijklmnopqrstuvwxyz1234567890',
    'Cookie: session=top-secret-cookie; auth=second-secret',
    'Authorization: Basic dXNlcjpwYXNz',
    'https://user:password@private.internal/api?q=secret#fragment',
    'C:\\Users\\Alice\\private\\config.json',
    'C:\\Users\\Alice Smith\\private config.json',
    '\\\\server\\share\\private\\file.txt',
    '\\\\server\\shared folder\\private file.txt',
    '/home/alice/private/config.json',
    '/home/alice smith/private config.json',
    'file:///Users/alice/private/key.txt',
    'file:///Users/Alice Smith/private key.txt',
    'alice.private@example.com',
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWg==',
  ];

  test('none can appear in the final output, even with optional descriptions enabled', () => {
    const sources = baseSources();
    sources.diagnosticEvents = canaries.map((description, index) => ({
      at: index,
      subsystem: 'provider',
      operation: 'request',
      outcome: 'error',
      code: 'network-error',
      description,
      arbitrary: { nested: description },
    }));
    sources.models = canaries.map((id) => ({ id, capabilities: {} }));
    const serialized = createSupportReportSnapshot(
      sources,
      { includeErrorDescriptions: true, includeModelIdentifiers: true },
      NOW,
    ).serialized;
    for (const canary of canaries) {
      assert.equal(serialized.includes(canary), false, canary);
    }
    assert.equal(serialized.includes('private.internal'), false);
    assert.equal(serialized.includes('alice.private@example.com'), false);
    assert.match(serialized, /redacted|\[path\]|\[email\]|encoded-data|Sanitized details unavailable/i);
  });

  test('model IDs and descriptions are disabled by default', () => {
    const sources = baseSources();
    sources.models = [{ id: 'private-org/private-model', capabilities: {} }];
    sources.diagnosticEvents = [{
      at: 1,
      subsystem: 'stream',
      operation: 'completion',
      outcome: 'error',
      code: 'network-error',
      description: 'Connection refused at a private endpoint',
    }];
    const parsed = JSON.parse(createSupportReportSnapshot(sources, {}, NOW).serialized);
    assert.equal(parsed.models.identifiersIncluded, false);
    assert.equal('identifiers' in parsed.models, false);
    assert.equal(parsed.diagnostics.descriptionsIncluded, false);
    assert.equal('description' in parsed.diagnostics.events[0], false);
  });

  test('final recursive pass catches sensitive keys and depth independently', () => {
    const redacted = finalRecursiveRedaction({
      safe: 'ok',
      authorization: 'Bearer still-secret',
      nested: { cookie: 'session=still-secret' },
      deep: { a: { b: { c: { d: { e: { f: { g: { h: 'too deep' } } } } } } } },
    }) as Record<string, unknown>;
    assert.equal(redacted.authorization, '[redacted]');
    assert.equal(JSON.stringify(redacted).includes('still-secret'), false);
    assert.equal(JSON.stringify(redacted).includes('truncated-depth'), true);
  });
});

describe('bounds, malformed state, and serialization', () => {
  test('handles malformed optional values and sparse oversized collections synchronously', () => {
    const sources = baseSources();
    const hugeProfiles: unknown[] = [];
    hugeProfiles.length = 1_000_000;
    hugeProfiles[0] = { baseUrl: 'http://localhost:1234', active: true };
    const hugeModels: unknown[] = [];
    hugeModels.length = 1_000_000;
    hugeModels[0] = { id: 'model', capabilities: { vision: true } };
    const hugeEvents: unknown[] = [];
    hugeEvents.length = 1_000_000;
    hugeEvents[999_999] = { at: 0, subsystem: 'stream', operation: 'completion', outcome: 'ok' };
    sources.profiles = hugeProfiles;
    sources.models = hugeModels;
    sources.diagnosticEvents = hugeEvents;
    sources.storage = {
      conversationSchemaVersion: Number.NaN,
      settingsSchemaVersion: 'corrupt',
      profileSchemaVersion: {},
      conversationCount: -10,
      messageCount: Number.POSITIVE_INFINITY,
      approximateBytes: 'lots',
    };

    const started = performance.now();
    const snapshot = createSupportReportSnapshot(sources, { includeModelIdentifiers: true }, NOW);
    const elapsed = performance.now() - started;
    const parsed = JSON.parse(snapshot.serialized);
    assert.ok(isSupportReportBase(parsed));
    assert.equal(parsed.providers.configurations.length, 32);
    assert.equal(parsed.models.capabilitySampleCount, 64);
    assert.ok(parsed.diagnostics.events.length <= SUPPORT_REPORT_MAX_EVENTS);
    assert.ok(snapshot.byteLength <= SUPPORT_REPORT_MAX_SERIALIZED_BYTES);
    assert.ok(elapsed < 1_000, `generation took ${elapsed}ms`);
  });

  test('caps strings, arrays, events, nesting, and final serialized bytes', () => {
    const long = 'x'.repeat(100_000);
    const sources = baseSources();
    sources.models = Array.from({ length: 2_000 }, (_, index) => ({
      id: `${index}-${long}`,
      capabilities: { vision: index % 2 === 0, reasoning: true, tools: false },
    }));
    sources.diagnosticEvents = Array.from({ length: 2_000 }, (_, index) => ({
      at: index,
      subsystem: 'stream',
      operation: 'completion',
      outcome: 'error',
      code: 'network-error',
      description: long,
    }));
    const snapshot = createSupportReportSnapshot(
      sources,
      { includeModelIdentifiers: true, includeErrorDescriptions: true },
      NOW,
    );
    const parsed = JSON.parse(snapshot.serialized);
    assert.ok(snapshot.byteLength <= SUPPORT_REPORT_MAX_SERIALIZED_BYTES);
    assert.ok(parsed.models.identifiers.length <= 64);
    assert.ok(parsed.diagnostics.events.length <= SUPPORT_REPORT_MAX_EVENTS);
    assert.ok(parsed.limits.stringsTruncated > 0);
    assert.ok(parsed.limits.arraysTruncated > 0);
    assert.ok(parsed.limits.eventsDropped > 0);
  });

  test('a directly built report remains valid after final serialization', () => {
    const built = buildSupportReportBase(baseSources(), { includeModelIdentifiers: true }, NOW);
    const snapshot = createSupportReportSnapshot(baseSources(), { includeModelIdentifiers: true }, NOW);
    assert.equal(built.format, SUPPORT_REPORT_FORMAT);
    assert.ok(isSupportReportBase(JSON.parse(snapshot.serialized)));
  });
});
