/**
 * Support-report v1 completion criteria (docs/support-report.md).
 *
 * These tests are the release evidence for the support report. Each
 * `describe` block maps to one criterion in docs/support-report.md.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  REPORT_SECTIONS,
  SUPPORT_REPORT_VERSION_V1,
  buildSupportReportV1,
  createSupportReportSnapshotV1,
  finalizeSupportReportV1,
  isSupportReportV1,
  supportReportFilenameV1,
  type SupportReportV1Sources,
} from './support-report.ts';
import {
  SUPPORT_REPORT_MAX_EVENTS,
  SUPPORT_REPORT_MAX_SERIALIZED_BYTES,
  buildSupportReportBase,
  isSupportReportBase,
} from './support-report-base.ts';
import {
  copySupportReport,
  saveSupportReport,
  supportReportPreviewText,
} from './support-report-delivery.ts';

// Keep the real saved-report fixtures on the same tsx-powered test entry point
// as the pure version-1 schema tests.
import './support-report-fixtures.test.ts';

const NOW = new Date('2026-08-04T12:00:00.000Z');

function baseSources(over: Partial<SupportReportV1Sources> = {}): SupportReportV1Sources {
  return {
    reportSurface: 'settings',
    application: { version: '1.0.0', buildChannel: 'test' },
    runtime: { kind: 'tauri', osFamily: 'windows' },
    startup: { lastCompletedPhase: 'ready', incompleteStartCount: 0, safeStartState: 'inactive' },
    storage: {
      conversationSchemaVersion: 1,
      settingsSchemaVersion: 1,
      profileSchemaVersion: 1,
      conversationCount: 12,
      messageCount: 340,
      conversationCountReadable: true,
      messageCountReadable: true,
      estimateReadable: true,
      settingsReadable: true,
      profilesReadable: true,
    },
    ...over,
  };
}

function parse(sources: SupportReportV1Sources, options = {}): Record<string, unknown> {
  return JSON.parse(createSupportReportSnapshotV1(sources, options, NOW).serialized);
}

/* ------------------------------------------------------------------ */

describe('support report v1 — Settings and Safe Start share one schema and serializer', () => {
  it('emits a strict v1 envelope at the current version', () => {
    const parsed = parse(baseSources());
    assert.equal(parsed.format, 'llm-client:support-report');
    assert.equal(parsed.version, SUPPORT_REPORT_VERSION_V1);
    assert.ok(isSupportReportV1(parsed));
    // The complete v1 document is intentionally stricter than the shared base shape.
    assert.equal(isSupportReportBase(parsed), false);
  });

  it('uses the v1 default filename', () => {
    const localTime = new Date(2026, 7, 4, 12, 34);
    assert.equal(supportReportFilenameV1(localTime), 'lc-support-v1-2026-08-04-1234.json');
    assert.equal(createSupportReportSnapshotV1(baseSources(), {}, localTime).filename,
      'lc-support-v1-2026-08-04-1234.json');
  });

  it('gives Preview, Copy, and Save byte-identical JSON including the trailing newline', async () => {
    for (const surface of ['settings', 'safe-start'] as const) {
      const snapshot = createSupportReportSnapshotV1(baseSources({ reportSurface: surface }), {}, NOW);
      let copied = '';
      let saved = '';
      const preview = supportReportPreviewText(snapshot);
      await copySupportReport(snapshot, async (text) => { copied = text; });
      await saveSupportReport(snapshot, async (_name, data) => { saved = data; return true; });

      assert.ok(Object.isFrozen(snapshot));
      assert.equal(preview, snapshot.serialized);
      assert.equal(copied, preview);
      assert.equal(saved, preview);
      assert.ok(preview.endsWith('}\n'), 'trailing newline is part of the payload');
      assert.deepEqual(
        new TextEncoder().encode(copied),
        new TextEncoder().encode(saved),
      );
    }
  });

  it('records which surface produced the report', () => {
    const settings = parse(baseSources({ reportSurface: 'settings' }));
    const safeStart = parse(baseSources({ reportSurface: 'safe-start' }));
    assert.equal((settings.collection as Record<string, unknown>).surface, 'settings');
    assert.equal((safeStart.collection as Record<string, unknown>).surface, 'safe-start');
    assert.equal((safeStart.ui as Record<string, unknown>).reportSurface, 'safe-start');
  });

  it('marks store-dependent sections unavailable for a store-free Safe Start report', () => {
    // Exactly what the Safe Start collector supplies: no profiles, no models,
    // no settings, no conversation.
    const parsed = parse({
      reportSurface: 'safe-start',
      application: { version: '1.0.0', buildChannel: 'test' },
      runtime: { kind: 'tauri', osFamily: 'linux' },
      startup: { lastCompletedPhase: 'storage-opened', incompleteStartCount: 2, safeStartState: 'active' },
      storage: {
        conversationSchemaVersion: 0, settingsSchemaVersion: 0, profileSchemaVersion: 0,
        conversationCountReadable: false, messageCountReadable: false,
        estimateReadable: false, settingsReadable: false, profilesReadable: false,
      },
      credentials: [],
      profiles: [],
      models: [],
    });
    const sections = (parsed.collection as Record<string, unknown>).sections as Record<string, string>;
    assert.equal(sections.providers, 'unavailable');
    assert.equal(sections.authConfiguration, 'unavailable');
    assert.equal(sections.activeRequest, 'unavailable');
    assert.equal(sections.ui, 'unavailable');
    // Runtime and startup facts are still collected without any store.
    assert.equal(sections.runtime, 'available');
    assert.equal(sections.startup, 'available');
    assert.equal((parsed.startup as Record<string, unknown>).incompleteStartCount, 2);
  });

  it('reports the availability of every section explicitly', () => {
    const sections = (parse(baseSources()).collection as Record<string, unknown>)
      .sections as Record<string, string>;
    for (const section of REPORT_SECTIONS) {
      assert.ok(['available', 'unavailable'].includes(sections[section]), section);
    }
    assert.equal(Object.keys(sections).length, REPORT_SECTIONS.length);
  });
});

/* ------------------------------------------------------------------ */

describe('support report v1 — privacy canaries', () => {
  const CANARIES: Array<[string, string]> = [
    ['openai key', 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['anthropic key', 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBB'],
    ['brave key', 'BSAabcdefghijklmnopqrstuvwxyz01'],
    ['marginalia key', 'marginalia_abcdefghijklmnopqrstuvwxyz'],
    ['openrouter key', 'sk-or-v1-ccccccccccccccccccccccccccccccccc'],
    ['authorization header', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'],
    ['cookie header', 'Cookie: session=abcdefghijklmnop; other=1'],
    ['openrouter session id', 'session_id=abcdef0123456789abcdef0123456789'],
    ['openrouter prompt cache key', 'prompt_cache_key=abcdef0123456789abcdef0123456789'],
    ['private searxng url', 'https://searx.internal.example.lan/search?q=secret'],
    ['windows path', 'C:\\Users\\ratha\\Documents\\private.txt'],
    ['posix path', '/home/ratha/private/notes.md'],
    ['unc path', '\\\\fileserver\\share\\secret.docx'],
    ['email', 'someone.private@example.com'],
    ['long base64', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk='],
    ['prompt content', 'my secret business plan for Q4'],
    ['tool output', 'grep found PASSWORD=hunter2 in config'],
    ['search query', 'how do I treat my private medical condition'],
  ];

  for (const [label, canary] of CANARIES) {
    it(`never serializes a ${label}`, () => {
      // Seed the canary into every source path the builder reads.
      const serialized = createSupportReportSnapshotV1(baseSources({
        runtime: { kind: canary, osFamily: canary },
        startup: { incompleteStartCount: 1, safeStartState: canary, failureCode: canary },
        profiles: [{ baseUrl: canary, apiVariant: canary, apiKey: canary, modelFetchUrl: canary }],
        models: [{ id: canary, capabilities: { vision: true } }],
        settings: {
          theme: canary,
          tools: { shell_allowlist: canary, brave_search_api_key: canary },
        },
        activeConversation: { tools: { enabled: true, allowed_roots: [canary] }, custom_skills: [canary] },
        activeRequest: { protocol: canary, apiStyle: canary, baseUrl: canary, reasoningEffort: canary },
        credentials: [{ surface: 'chat', state: canary }, { surface: canary, state: canary }],
        search: { selected: canary, resolved: canary, searxngBaseUrl: canary },
        diagnosticEvents: [{
          at: 1, subsystem: 'provider', operation: 'request', outcome: 'error',
          code: canary, description: canary, tool: canary, permission: canary,
          searchSelected: canary, ignoredParams: [canary], prefixConclusion: canary,
        }],
      }), {}, NOW).serialized;

      assert.ok(!serialized.includes(canary), `${label} leaked into the default report`);
    });
  }

  it('keeps a single seeded secret out of every source and event path', () => {
    const secret = 'LC-CANARY-9f2a7c41e8b6';
    const seeded = JSON.parse(JSON.stringify(baseSources())) as Record<string, unknown>;
    // Seed it at every depth, including below the normal allowlist depth.
    seeded.settings = {
      theme: secret,
      nested: { a: { b: { c: { d: { e: { f: { g: secret } } } } } } },
      tools: { shell_allowlist: secret, secretValue: secret },
    };
    seeded.profiles = [{ baseUrl: `https://host.example.com/?k=${secret}`, apiKey: secret }];
    seeded.models = [{ id: secret }];
    seeded.activeRequest = { protocol: secret, baseUrl: secret };
    seeded.search = { selected: secret, searxngBaseUrl: `https://${secret}.internal.lan` };
    seeded.credentials = [{ surface: 'chat', state: secret }];
    seeded.diagnosticEvents = Array.from({ length: 8 }, (_, i) => ({
      at: i, subsystem: 'stream', operation: 'completion', outcome: 'error',
      code: secret, description: `failure: ${secret}`,
    }));

    const snapshot = createSupportReportSnapshotV1(seeded as SupportReportV1Sources, {}, NOW);
    assert.ok(!snapshot.serialized.includes(secret));
    // The exact delivery bytes are the same string, so this covers all three.
    assert.ok(!supportReportPreviewText(snapshot).includes(secret));
  });

  it('serializes endpoint classes, never exact hosts', () => {
    const parsed = parse(baseSources({
      profiles: [{ baseUrl: 'https://api.secret-host.example.com/v1', apiVariant: 'openai' }],
      activeRequest: { protocol: 'openai', apiStyle: 'chat', baseUrl: 'https://api.secret-host.example.com/v1' },
      search: { selected: 'searxng', resolved: 'searxng', searxngBaseUrl: 'http://searx.internal.lan:8080' },
    }));
    const serialized = JSON.stringify(parsed);
    assert.ok(!serialized.includes('secret-host'));
    assert.ok(!serialized.includes('searx.internal'));
    assert.equal((parsed.activeRequest as Record<string, unknown>).endpointClass, 'public-https');
    assert.equal((parsed.search as Record<string, unknown>).searxngEndpointClass, 'private-network');
  });

  it('adds only the exact model id when that opt-in is enabled', () => {
    const canary = 'my secret business plan for Q4';
    const serialized = createSupportReportSnapshotV1(baseSources({
      models: [{ id: 'gpt-real-model' }],
      settings: { theme: canary },
      activeConversation: { tools: { enabled: true, allowed_roots: [canary] } },
    }), { includeModelIdentifiers: true }, NOW).serialized;
    assert.ok(serialized.includes('gpt-real-model'), 'the opt-in exists to include this');
    assert.ok(!serialized.includes(canary), 'the opt-in must not widen anything else');
  });

  it('adds only a sanitized description when that opt-in is enabled', () => {
    const serialized = createSupportReportSnapshotV1(baseSources({
      diagnosticEvents: [{
        at: 1, subsystem: 'stream', operation: 'completion', outcome: 'error',
        code: 'http-error',
        description: 'chat failed: 503 Service Unavailable\n{"error":"secret upstream detail"}',
      }],
    }), { includeErrorDescriptions: true }, NOW).serialized;
    assert.ok(serialized.includes('Request failed with HTTP status 503'));
    assert.ok(!serialized.includes('secret upstream detail'));
  });

  it('keeps model identifiers and error descriptions opt-in', () => {
    const parsed = parse(baseSources({ models: [{ id: 'gpt-secret-model' }] }));
    assert.equal((parsed.models as Record<string, unknown>).identifiersIncluded, false);
    assert.ok(!JSON.stringify(parsed).includes('gpt-secret-model'));
    assert.equal((parsed.diagnostics as Record<string, unknown>).descriptionsIncluded, false);
  });
});

/* ------------------------------------------------------------------ */

describe('support report v1 — request and stream correlate without stable identifiers', () => {
  const events = [
    { at: 10, subsystem: 'provider', operation: 'request', outcome: 'ok', sequence: 41, protocol: 'openai', apiStyle: 'chat', endpointClass: 'public-https' },
    { at: 20, subsystem: 'stream', operation: 'completion', outcome: 'ok', sequence: 41, code: 'finish-stop', durationBucket: '1-5s', usageReported: true, promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    { at: 30, subsystem: 'provider', operation: 'request', outcome: 'ok', sequence: 42, protocol: 'anthropic', apiStyle: 'not-applicable' },
    { at: 40, subsystem: 'stream', operation: 'completion', outcome: 'timeout', sequence: 42, code: 'read-timeout', durationBucket: '30s-2m' },
  ];

  it('pairs the most recent request with its own terminal stream result', () => {
    const parsed = parse(baseSources({ diagnosticEvents: events }));
    const ps = parsed.providerStream as Record<string, unknown>;
    assert.equal(ps.correlated, true);
    assert.equal((ps.stream as Record<string, unknown>).outcome, 'timeout');
    assert.equal(ps.finishCode, 'read-timeout');
    assert.equal(ps.timedOut, true);
    assert.equal(ps.durationBucket, '30s-2m');
  });

  it('does not mistake an unrelated stream for the paired one', () => {
    const parsed = parse(baseSources({
      diagnosticEvents: [
        { at: 10, subsystem: 'stream', operation: 'completion', outcome: 'ok', sequence: 7, code: 'finish-stop' },
        { at: 20, subsystem: 'provider', operation: 'request', outcome: 'ok', sequence: 8 },
      ],
    }));
    const ps = parsed.providerStream as Record<string, unknown>;
    assert.equal(ps.correlated, false, 'sequence 8 has no terminal stream yet');
  });

  it('serializes no provider, request, message, conversation, or profile id and no hash', () => {
    const serialized = JSON.stringify(parse(baseSources({ diagnosticEvents: events })));
    for (const forbidden of ['requestId', 'request_id', 'messageId', 'conversationId', 'profileId', 'hash', 'digest']) {
      assert.ok(!serialized.includes(forbidden), `must not serialize ${forbidden}`);
    }
    // The correlation number itself stays inside the ring, not in the summary.
    const ps = JSON.parse(serialized).providerStream as Record<string, unknown>;
    assert.ok(!('sequence' in ps));
  });
});

/* ------------------------------------------------------------------ */

describe('support report v1 — injected failures are distinguishable', () => {
  const CASES: Array<[string, Record<string, unknown>, (parsed: Record<string, unknown>) => void]> = [
    ['startup', { startup: { lastCompletedPhase: 'settings-validated', incompleteStartCount: 2, safeStartState: 'active', failureCode: 'settings-malformed' } },
      (p) => assert.equal((p.startup as Record<string, unknown>).failureCode, 'settings-malformed')],
    ['storage open', { diagnosticEvents: [{ at: 1, subsystem: 'storage', operation: 'open', outcome: 'error', code: 'storage-open-failed' }] },
      (p) => assert.equal(((p.storage as Record<string, unknown>).databaseOpen as Record<string, unknown>).code, 'storage-open-failed')],
    ['storage hydrate', { diagnosticEvents: [{ at: 1, subsystem: 'storage', operation: 'hydrate', outcome: 'error', code: 'storage-hydrate-failed' }] },
      (p) => assert.equal(((p.storage as Record<string, unknown>).metadataHydrate as Record<string, unknown>).code, 'storage-hydrate-failed')],
    ['storage indexed read', { diagnosticEvents: [{ at: 1, subsystem: 'storage', operation: 'indexed-read', outcome: 'error', code: 'storage-read-failed' }] },
      (p) => assert.equal(((p.storage as Record<string, unknown>).indexedRead as Record<string, unknown>).code, 'storage-read-failed')],
    ['storage durable write', { diagnosticEvents: [{ at: 1, subsystem: 'storage', operation: 'durable-write', outcome: 'error', code: 'storage-write-failed' }] },
      (p) => assert.equal(((p.storage as Record<string, unknown>).durableWrite as Record<string, unknown>).code, 'storage-write-failed')],
    ['credential bootstrap', { diagnosticEvents: [{ at: 1, subsystem: 'credential', operation: 'bootstrap', outcome: 'error', code: 'credential-keychain-unavailable' }] },
      (p) => assert.equal(((p.authConfiguration as Record<string, unknown>).bootstrapOutcome as Record<string, unknown>).code, 'credential-keychain-unavailable')],
    ['model discovery', { diagnosticEvents: [{ at: 1, subsystem: 'model', operation: 'model-list', outcome: 'error', code: 'model-list-failed', httpStatus: 502, endpointClass: 'public-https', metadataSource: 'unknown' }] },
      (p) => {
        const md = p.modelDiscovery as Record<string, unknown>;
        assert.equal((md.lastOutcome as Record<string, unknown>).code, 'model-list-failed');
        assert.equal((md.lastOutcome as Record<string, unknown>).httpStatus, 502);
      }],
    ['provider request', { diagnosticEvents: [{ at: 1, subsystem: 'provider', operation: 'request', outcome: 'error', code: 'http-error', httpStatus: 429, sequence: 3 }] },
      (p) => assert.equal(((p.providerStream as Record<string, unknown>).request as Record<string, unknown>).httpStatus, 429)],
    ['stream completion', { diagnosticEvents: [{ at: 1, subsystem: 'stream', operation: 'completion', outcome: 'error', code: 'finish-disconnected' }] },
      (p) => assert.equal((p.providerStream as Record<string, unknown>).finishCode, 'finish-disconnected')],
    ['search provider failure', { diagnosticEvents: [{ at: 1, subsystem: 'search', operation: 'call', outcome: 'error', code: 'search-provider-error', httpStatus: 503 }] },
      (p) => assert.equal(((p.search as Record<string, unknown>).lastOutcome as Record<string, unknown>).code, 'search-provider-error')],
    ['tool execution', { diagnosticEvents: [{ at: 1, subsystem: 'tool', operation: 'execute', outcome: 'error', code: 'tool-result-error', tool: 'lc_run_shell', durationBucket: '5-30s' }] },
      (p) => {
        const recent = (p.tools as Record<string, unknown>).recent as Record<string, unknown>;
        assert.equal(recent.tool, 'lc_run_shell');
        assert.equal(recent.durationBucket, '5-30s');
      }],
    ['permission denial', { diagnosticEvents: [{ at: 1, subsystem: 'tool', operation: 'permission', outcome: 'rejected', code: 'tool-permission-denied', tool: 'lc_write_file', permission: 'denied' }] },
      (p) => assert.equal(((p.tools as Record<string, unknown>).recent as Record<string, unknown>).permission, 'denied')],
    ['UI report action', { diagnosticEvents: [{ at: 1, subsystem: 'ui', operation: 'support-report', outcome: 'error', code: 'report-failed' }] },
      (p) => assert.ok(JSON.stringify(p).includes('report-failed'))],
    ['collector timeout', { collectorFailures: [{ section: 'storage', code: 'collector-timeout' }] },
      (p) => assert.deepEqual((p.collection as Record<string, unknown>).failures, [{ section: 'storage', code: 'collector-timeout' }])],
  ];

  for (const [label, over, check] of CASES) {
    it(`distinguishes an injected ${label} failure`, () => {
      check(parse(baseSources(over as Partial<SupportReportV1Sources>)));
    });
  }

  it('reports an unreadable event buffer', () => {
    const parsed = parse(baseSources({ eventBufferReadable: false }));
    assert.equal((parsed.collection as Record<string, unknown>).eventBufferReadable, false);
  });

  it('reports the age bucket of the last successful durable write', () => {
    const recent = parse(baseSources({
      diagnosticEvents: [{ at: NOW.getTime() - 30_000, subsystem: 'storage', operation: 'durable-write', outcome: 'ok', code: 'storage-write-ok' }],
    }));
    assert.equal((recent.storage as Record<string, unknown>).lastDurableWriteAgeBucket, 'under-1m');

    const never = parse(baseSources());
    assert.equal((never.storage as Record<string, unknown>).lastDurableWriteAgeBucket, 'never');
  });
});

/* ------------------------------------------------------------------ */

describe('support report v1 — search facts carry no query or result content', () => {
  it('represents selection, resolution, and configuration presence', () => {
    const parsed = parse(baseSources({
      search: { selected: 'brave', configured: true, configuredProviders: ['brave'] },
      diagnosticEvents: [{
        at: 1, subsystem: 'search', operation: 'resolve', outcome: 'ok', code: 'search-resolved',
        searchSelected: 'brave', searchResolved: 'brave', searchConfigured: true,
        searchConfiguredProviders: ['brave'],
      }],
    }));
    const search = parsed.search as Record<string, unknown>;
    assert.equal(search.selectedProvider, 'brave');
    assert.equal(search.resolvedProvider, 'brave');
    assert.equal(search.configured, true);
    assert.deepEqual(search.configuredProviders, ['brave']);
  });

  it('represents `auto` as a selection rather than as an absence', () => {
    const parsed = parse(baseSources({
      search: { selected: 'auto', configured: true, configuredProviders: ['searxng'] },
      diagnosticEvents: [{
        at: 1, subsystem: 'search', operation: 'resolve', outcome: 'ok', code: 'search-resolved',
        searchSelected: 'auto', searchResolved: 'searxng', searchConfigured: true,
      }],
    }));
    const search = parsed.search as Record<string, unknown>;
    assert.equal(search.selectedProvider, 'auto');
    assert.equal(search.resolvedProvider, 'searxng');
  });

  it('represents fallback resolution when the selection is stale', () => {
    const parsed = parse(baseSources({
      search: { selected: 'brave', configured: true, configuredProviders: ['marginalia'] },
      diagnosticEvents: [{
        at: 1, subsystem: 'search', operation: 'resolve', outcome: 'ok', code: 'search-resolved',
        searchSelected: 'brave', searchResolved: 'marginalia', searchConfigured: true,
      }],
    }));
    const search = parsed.search as Record<string, unknown>;
    assert.equal(search.selectedProvider, 'brave');
    assert.equal(search.resolvedProvider, 'marginalia');
  });

  it('represents missing configuration', () => {
    const parsed = parse(baseSources({
      search: { selected: 'auto', configured: false, configuredProviders: [] },
      diagnosticEvents: [{
        at: 1, subsystem: 'search', operation: 'resolve', outcome: 'rejected',
        code: 'search-not-configured', searchResolved: 'none', searchConfigured: false,
      }],
    }));
    const search = parsed.search as Record<string, unknown>;
    assert.equal(search.resolvedProvider, 'none');
    assert.equal(search.configured, false);
    assert.deepEqual(search.configuredProviders, []);
  });

  it('never reports a resolved provider from configuration alone', () => {
    // A keychain reference proves configuration, not that a usable key loaded.
    // Without a resolver event there is no resolution to report.
    const parsed = parse(baseSources({
      search: { selected: 'brave', configured: true, configuredProviders: ['brave'] },
    }));
    const search = parsed.search as Record<string, unknown>;
    assert.equal(search.selectedProvider, 'brave');
    assert.equal(search.resolvedProvider, 'unknown');
    assert.deepEqual(search.configuredProviders, ['brave']);
  });

  it('keeps a configured-by-reference provider distinct from a failed bootstrap', () => {
    const parsed = parse(baseSources({
      search: { selected: 'brave', configured: true, configuredProviders: ['brave'] },
      credentials: [{ surface: 'brave', state: 'keychain-ref' }],
      diagnosticEvents: [{
        at: 1, subsystem: 'credential', operation: 'bootstrap', outcome: 'rejected',
        code: 'credential-missing', credentialSurface: 'brave', credentialState: 'keychain-ref',
      }],
    }));
    const search = parsed.search as Record<string, unknown>;
    const auth = parsed.authConfiguration as Record<string, unknown>;
    const surfaces = auth.surfaces as Array<Record<string, unknown>>;
    // Configured, bootstrap failed, and no successful resolution claimed.
    assert.deepEqual(search.configuredProviders, ['brave']);
    assert.equal(search.resolvedProvider, 'unknown');
    assert.equal(surfaces[0].state, 'keychain-ref');
    assert.deepEqual(surfaces[0].bootstrap, { outcome: 'rejected', code: 'credential-missing' });
  });

  it('keeps a non-chat profile credential outcome on its own bounded surface', () => {
    const parsed = parse(baseSources({
      credentials: [{ surface: 'profile', state: 'keychain-ref' }],
      diagnosticEvents: [{
        at: 1, subsystem: 'credential', operation: 'bootstrap', outcome: 'error',
        code: 'credential-keychain-unavailable', credentialSurface: 'profile',
        credentialState: 'keychain-ref',
      }],
    }));
    const auth = parsed.authConfiguration as Record<string, unknown>;
    const surfaces = auth.surfaces as Array<Record<string, unknown>>;
    const profileSurface = surfaces.find((surface) => surface.surface === 'profile');

    assert.deepEqual(profileSurface, {
      surface: 'profile',
      state: 'keychain-ref',
      bootstrap: { outcome: 'error', code: 'credential-keychain-unavailable' },
    });
  });

  it('reports only allowlisted ignored parameter names', () => {
    const parsed = parse(baseSources({
      diagnosticEvents: [{
        at: 1, subsystem: 'search', operation: 'call', outcome: 'ok', code: 'search-ok',
        ignoredParams: ['freshness', 'cross_check', 'some_private_param'],
        resultCountBucket: '10-49',
      }],
    }));
    const search = parsed.search as Record<string, unknown>;
    assert.deepEqual(search.ignoredParams, ['freshness', 'cross_check']);
    assert.equal(search.resultCountBucket, '10-49');
  });

  it('represents a no-results outcome as a bucket, not content', () => {
    const parsed = parse(baseSources({
      diagnosticEvents: [{
        at: 1, subsystem: 'search', operation: 'call', outcome: 'ok',
        code: 'search-no-results', resultCountBucket: 'none',
      }],
    }));
    const search = parsed.search as Record<string, unknown>;
    assert.equal((search.lastOutcome as Record<string, unknown>).code, 'search-no-results');
    assert.equal(search.resultCountBucket, 'none');
  });
});

/* ------------------------------------------------------------------ */

describe('support report v1 — cache and prefix facts flow in bounded', () => {
  const events = [
    { at: 1, subsystem: 'stream', operation: 'completion', outcome: 'ok', code: 'finish-stop', sequence: 5, cacheStatus: 'reported', cacheReportedBy: 'router', cacheReadTokens: 3072, cacheWriteTokens: 512, cacheMissTokens: 0, prefixConclusion: 'stable-prefix-active-suffix-changed', prefixQualifiers: ['provider-breakpoint-may-exclude-suffix', 'router-upstream-unknown'] },
    { at: 2, subsystem: 'stream', operation: 'completion', outcome: 'ok', code: 'finish-stop', sequence: 6, cacheStatus: 'not-reported', prefixConclusion: 'stable-prefix', prefixQualifiers: [] },
  ];

  it('aggregates cache counters and the prefix conclusion', () => {
    const parsed = parse(baseSources({ diagnosticEvents: events }));
    const cache = parsed.cacheAndPrefix as Record<string, unknown>;
    assert.equal(cache.status, 'not-reported');
    assert.equal(cache.prefixConclusion, 'stable-prefix');
    assert.deepEqual(cache.conclusionCounts, [
      { conclusion: 'stable-prefix-active-suffix-changed', count: 1 },
      { conclusion: 'stable-prefix', count: 1 },
    ]);
  });

  it('keeps the router label rather than naming an upstream provider', () => {
    const parsed = parse(baseSources({ diagnosticEvents: [events[0]] }));
    const cache = parsed.cacheAndPrefix as Record<string, unknown>;
    assert.equal(cache.reportedBy, 'router');
    assert.equal(cache.readTokens, 3072);
    assert.ok(!('upstream' in cache));
  });

  it('exports no per-message cache facts, content, key, or digest', () => {
    const serialized = JSON.stringify(parse(baseSources({ diagnosticEvents: events })));
    for (const forbidden of ['cache_control', 'prompt_cache_key', 'session_id', 'x-session-id', 'hmac', 'digest', 'messageId']) {
      assert.ok(!serialized.includes(forbidden), `must not export ${forbidden}`);
    }
  });

  it('bounds prefix qualifiers to the closed vocabulary', () => {
    const parsed = parse(baseSources({
      diagnosticEvents: [{
        at: 1, subsystem: 'stream', operation: 'completion', outcome: 'ok',
        prefixConclusion: 'stable-prefix',
        prefixQualifiers: ['router-upstream-unknown', 'not-a-real-qualifier'],
      }],
    }));
    assert.deepEqual((parsed.cacheAndPrefix as Record<string, unknown>).prefixQualifiers,
      ['router-upstream-unknown']);
  });
});

/* ------------------------------------------------------------------ */

describe('support report v1 — bounds and malformed sources', () => {
  it('never exceeds 64 KiB from oversized sources', () => {
    const huge = 'x'.repeat(4_000);
    const snapshot = createSupportReportSnapshotV1(baseSources({
      profiles: Array.from({ length: 400 }, () => ({ baseUrl: `https://h${huge}.example.com`, apiVariant: 'openai' })),
      models: Array.from({ length: 400 }, (_, i) => ({ id: `${huge}-${i}`, capabilities: {} })),
      diagnosticEvents: Array.from({ length: 400 }, (_, i) => ({
        at: i, subsystem: 'stream', operation: 'completion', outcome: 'error',
        code: 'finish-other', description: huge,
      })),
      credentials: Array.from({ length: 400 }, () => ({ surface: 'chat', state: huge })),
      collectorFailures: Array.from({ length: 400 }, () => ({ section: 'storage', code: huge })),
    }), { includeModelIdentifiers: true, includeErrorDescriptions: true }, NOW);

    assert.ok(snapshot.byteLength <= SUPPORT_REPORT_MAX_SERIALIZED_BYTES,
      `report was ${snapshot.byteLength} bytes`);
    assert.ok(isSupportReportV1(JSON.parse(snapshot.serialized)));
  });

  it('records which sections were omitted when the byte fallback engages', () => {
    // Build-time bounds normally keep the report far under the limit, so the
    // fallback is exercised directly against a deliberately oversized document.
    const report = buildSupportReportV1(baseSources(), {}, NOW);
    // Spaces keep the filler from matching the base64 redaction pattern, so
    // it survives redaction and actually exercises the byte fallback.
    const filler = 'ab '.repeat(160);
    const oversized = {
      ...report,
      providers: {
        ...report.providers,
        configurationsSampled: 64,
        configurations: Array.from({ length: 64 }, () => ({
          apiVariant: 'openai' as const, apiStyle: 'chat' as const, routing: 'direct' as const,
          active: true, endpointClass: 'public-https' as const,
          modelEndpointClass: 'public-https' as const, transport: 'https' as const,
        })),
      },
      models: {
        ...report.models,
        identifiersIncluded: true,
        identifiers: Array.from({ length: 64 }, () => filler),
      },
      diagnostics: {
        ...report.diagnostics,
        eventCount: 64,
        events: Array.from({ length: 64 }, (_, i) => ({
          at: i, subsystem: 'stream' as const, operation: 'completion' as const,
          outcome: 'error' as const, description: filler,
        })),
      },
    };

    const final = finalizeSupportReportV1(oversized);
    assert.ok(final.byteLength <= SUPPORT_REPORT_MAX_SERIALIZED_BYTES,
      `reduced report was ${final.byteLength} bytes`);
    const parsed = JSON.parse(final.serialized) as Record<string, unknown>;
    const collection = parsed.collection as Record<string, unknown>;
    assert.equal(collection.sizeReduced, true);
    assert.ok((collection.omitted as string[]).includes('diagnostics'));
    assert.ok((collection.omitted as string[]).length > 0);
    assert.ok(isSupportReportV1(parsed), 'a reduced report is still a valid v1 document');
  });

  it('keeps the event ring at 64 entries', () => {
    const parsed = parse(baseSources({
      diagnosticEvents: Array.from({ length: 200 }, (_, i) => ({
        at: i, subsystem: 'stream', operation: 'completion', outcome: 'ok',
      })),
    }));
    const diagnostics = parsed.diagnostics as Record<string, unknown>;
    assert.equal((diagnostics.events as unknown[]).length, SUPPORT_REPORT_MAX_EVENTS);
  });

  it('cannot be made to fail by malformed, unavailable, or hostile sources', () => {
    const hostile: unknown[] = [
      undefined, null, 'string', 42, [], { diagnosticEvents: 'nope' },
      { profiles: 'nope', models: 7, settings: null, storage: [] },
      { activeRequest: [], credentials: 'nope', search: 5, collectorFailures: {} },
      { diagnosticEvents: [null, 1, 'x', { subsystem: 'nope' }] },
      { reportSurface: { evil: true } },
    ];
    for (const sources of hostile) {
      const snapshot = createSupportReportSnapshotV1(sources as SupportReportV1Sources, {}, NOW);
      assert.ok(snapshot.byteLength > 0);
      assert.ok(isSupportReportV1(JSON.parse(snapshot.serialized)));
    }
  });

  it('survives an invalid clock', () => {
    const snapshot = createSupportReportSnapshotV1(baseSources(), {}, new Date(NaN));
    assert.ok(isSupportReportV1(JSON.parse(snapshot.serialized)));
    assert.equal(snapshot.filename, 'lc-support-v1-1970-01-01-0000.json');
  });

  it('drops unknown enum values instead of serializing provider text', () => {
    const parsed = parse(baseSources({
      activeRequest: { protocol: 'made-up-protocol', apiStyle: 'made-up-style', routing: 'made-up' },
      credentials: [{ surface: 'chat', state: 'made-up-state' }],
    }));
    const active = parsed.activeRequest as Record<string, unknown>;
    assert.equal(active.protocol, 'unknown');
    assert.equal(active.apiStyle, 'unknown');
    assert.equal(active.routing, 'unknown');
    const surfaces = (parsed.authConfiguration as Record<string, unknown>).surfaces as Array<Record<string, unknown>>;
    assert.equal(surfaces[0].state, 'unknown');
  });
});

/* ------------------------------------------------------------------ */

describe('support report v1 — shared base projection remains bounded', () => {
  it('still builds and validates the shared base document', () => {
    const base = buildSupportReportBase({ application: { version: '1.0.0', buildChannel: 'test' } }, {}, NOW);
    assert.equal(base.version, 1);
    assert.ok(isSupportReportBase(base));
  });

  it('does not let extended vocabulary leak into the base projection', () => {
    const base = buildSupportReportBase({
      diagnosticEvents: [
        { at: 1, subsystem: 'search', operation: 'resolve', outcome: 'ok', code: 'search-ok' },
        { at: 2, subsystem: 'stream', operation: 'completion', outcome: 'ok', code: 'finish-stop' },
      ],
    }, {}, NOW);
    assert.equal(base.diagnostics.events.length, 1);
    assert.equal(base.diagnostics.events[0].subsystem, 'stream');
  });

  it('keeps the v1 finalizer reachable and unchanged in shape', () => {
    const finalized = finalizeSupportReportV1(buildSupportReportV1(baseSources(), {}, NOW));
    assert.equal(finalized.report.version, 1);
    assert.ok(finalized.serialized.endsWith('\n'));
  });
});
