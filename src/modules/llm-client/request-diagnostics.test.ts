/**
 * Request/stream correlation and the active-request snapshot, through the real
 * `LLMClient.chatStream` boundary.
 *
 * Every case below drives the shipped client with a stub `fetch`. No event is
 * injected: the assertions fail if a production path stops recording its
 * sequence, its request shape, or its snapshot.
 *
 * The gaps these cover were all real: HTTP-error request events carried no
 * sequence or shape, native LM Studio dropped its sequence when the result was
 * destructured, and stream failures reached the orchestrator with no way to say
 * which request they belonged to.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LLMClient } from './client.ts';
import {
  readActiveRequestSnapshot,
  resetActiveRequestSnapshot,
} from './request-snapshot.ts';
import {
  DiagnosticEventBuffer,
  readDiagnosticEvents,
  recordDiagnosticEvent,
  resetDiagnosticEvents,
  type DiagnosticEvent,
} from '../../utils/diagnostic-events.ts';
import type { AdapterRequestParams } from './adapters/adapter';

const BASE = 'https://api.example.test/v1';

function params(overrides: Partial<AdapterRequestParams> = {}): AdapterRequestParams {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    reasoningEnabled: false,
    ...overrides,
  };
}

/** A minimal SSE body that terminates the stream cleanly. */
function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines.join('')));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function chatCompletionsStream(): Response {
  return sseResponse([
    'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
    'data: [DONE]\n\n',
  ]);
}

function providerRequests(): DiagnosticEvent[] {
  return readDiagnosticEvents().filter(
    (event) => event.subsystem === 'provider' && event.operation === 'request',
  );
}

beforeEach(() => {
  resetDiagnosticEvents();
  resetActiveRequestSnapshot();
});

describe('every terminal request path keeps its sequence and request shape', () => {
  it('records an ordinary success with a sequence and a bounded shape', async () => {
    const client = new LLMClient({ baseUrl: BASE, streamFetchImpl: async () => chatCompletionsStream() });
    let handed: number | undefined;

    const result = await client.chatStream(
      params(), { onDelta: () => {} }, undefined, 60_000, undefined,
      { onSequence: (value) => { handed = value; } },
    );

    const [request] = providerRequests();
    assert.equal(request.outcome, 'ok');
    assert.equal(request.sequence, handed);
    assert.equal(result.diagnosticSequence, handed);
    assert.equal(request.protocol, 'openai');
    assert.equal(request.apiStyle, 'chat');
    assert.equal(request.endpointClass, 'public-https');
  });

  it('records a network failure with the same sequence it handed the caller', async () => {
    const client = new LLMClient({
      baseUrl: BASE,
      streamFetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    let handed: number | undefined;

    await assert.rejects(() => client.chatStream(
      params(), { onDelta: () => {} }, undefined, 60_000, undefined,
      { onSequence: (value) => { handed = value; } },
    ));

    const [request] = providerRequests();
    assert.equal(request.code, 'network-error');
    assert.equal(request.sequence, handed);
    assert.equal(request.protocol, 'openai');
  });

  it('records an HTTP failure with a sequence, a shape, and its status', async () => {
    const client = new LLMClient({
      baseUrl: BASE,
      streamFetchImpl: async () => new Response('upstream detail', { status: 502 }),
    });
    let handed: number | undefined;

    await assert.rejects(() => client.chatStream(
      params(), { onDelta: () => {} }, undefined, 60_000, undefined,
      { onSequence: (value) => { handed = value; } },
    ));

    const [request] = providerRequests();
    assert.equal(request.code, 'http-error');
    assert.equal(request.httpStatus, 502);
    // This is the gap the review found: the HTTP-error path used to omit both.
    assert.equal(request.sequence, handed);
    assert.equal(request.endpointClass, 'public-https');
  });

  it('records a missing response body with its sequence', async () => {
    const client = new LLMClient({
      baseUrl: BASE,
      streamFetchImpl: async () => ({ ok: true, status: 200, body: null } as unknown as Response),
    });
    let handed: number | undefined;

    await assert.rejects(() => client.chatStream(
      params(), { onDelta: () => {} }, undefined, 60_000, undefined,
      { onSequence: (value) => { handed = value; } },
    ));

    const [request] = providerRequests();
    assert.equal(request.code, 'missing-response-body');
    assert.equal(request.sequence, handed);
  });

  it('records a cancellation as cancelled, with its sequence', async () => {
    const controller = new AbortController();
    const client = new LLMClient({
      baseUrl: BASE,
      streamFetchImpl: async () => {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      },
    });
    let handed: number | undefined;

    await assert.rejects(() => client.chatStream(
      params(), { onDelta: () => {} }, controller.signal, 60_000, undefined,
      { onSequence: (value) => { handed = value; } },
    ));

    const [request] = providerRequests();
    assert.equal(request.outcome, 'cancelled');
    assert.equal(request.code, 'user-cancelled');
    assert.equal(request.sequence, handed);
  });

  it('keeps one sequence across a reasoning rejection and its accepted retry', async () => {
    let call = 0;
    const client = new LLMClient({
      baseUrl: 'http://localhost:1234/v1',
      apiVariant: 'lm-studio',
      streamFetchImpl: async () => {
        call += 1;
        if (call === 1) {
          return new Response(JSON.stringify({ error: { param: 'reasoning' } }), { status: 400 });
        }
        return sseResponse(['data: {"content":"ok"}\n\n', 'data: [DONE]\n\n']);
      },
    });
    let handed: number | undefined;

    await client.chatStream(
      params({ reasoningEnabled: true, reasoningEffort: 'high' }),
      { onDelta: () => {} }, undefined, 60_000, undefined,
      { onSequence: (value) => { handed = value; } },
    );

    const events = providerRequests();
    assert.equal(events.length, 2);
    assert.equal(events[0].code, 'reasoning-retry');
    assert.equal(events[0].retried, true);
    assert.equal(events[1].outcome, 'ok');
    // Both belong to one logical request, and the accepted one is latest, so a
    // report describes the request that was actually served.
    assert.ok(events.every((event) => event.sequence === handed));
    // The snapshot describes the accepted retry, not the rejected attempt.
    assert.equal(readActiveRequestSnapshot()?.reasoningEnabled, false);
    assert.equal(readActiveRequestSnapshot()?.reasoningEffort, 'none');
  });

  it('rebuilds a native request with the input item type the server named', async () => {
    const sent: unknown[] = [];
    const client = new LLMClient({
      baseUrl: 'http://localhost:1234/api/v1',
      apiVariant: 'lm-studio',
      streamFetchImpl: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        if (sent.length === 1) {
          return new Response(JSON.stringify({
            error: {
              message: "Invalid discriminator value. Expected 'message' | 'image'",
              type: 'invalid_request',
              code: 'invalid_union',
              param: 'input',
            },
          }), { status: 400 });
        }
        return sseResponse(['data: {"content":"ok"}\n\n', 'data: [DONE]\n\n']);
      },
    });

    await client.chatStream(params(), { onDelta: () => {} }, undefined, 60_000);

    const bodies = sent as Array<{ input: Array<{ type: string; content: string }> }>;
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].input[0].type, 'text', 'a released server accepts the default');
    assert.equal(bodies[1].input[0].type, 'message', 'the retry uses the type the server named');
    assert.equal(bodies[1].input[0].content, 'hi', 'the retry carries the same input');

    const events = providerRequests();
    assert.equal(events[0].code, 'input-shape-retry');
    assert.equal(events[0].retried, true);
    assert.equal(events[1].outcome, 'ok');

    // The adapter keeps the corrected type, so the next turn is not rejected.
    await client.chatStream(params(), { onDelta: () => {} }, undefined, 60_000);
    assert.equal(bodies.length, 3);
    assert.equal(bodies[2].input[0].type, 'message');
  });

  it('corrects an input shape and a rejected reasoning field in one native turn', async () => {
    const sent: Array<{ input: Array<{ type: string }>; reasoning?: string }> = [];
    const client = new LLMClient({
      baseUrl: 'http://localhost:1234/api/v1',
      apiVariant: 'lm-studio',
      streamFetchImpl: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        if (sent.length === 1) {
          return new Response(JSON.stringify({
            error: { message: "Invalid discriminator value. Expected 'message' | 'image'", code: 'invalid_union', param: 'input' },
          }), { status: 400 });
        }
        if (sent.length === 2) {
          return new Response(JSON.stringify({
            error: { message: 'Model does not expose reasoning configuration.', code: 'invalid_value', param: 'reasoning' },
          }), { status: 400 });
        }
        return sseResponse(['data: {"content":"ok"}\n\n', 'data: [DONE]\n\n']);
      },
    });

    await client.chatStream(
      params({ reasoningEnabled: true, reasoningEffort: 'high' }),
      { onDelta: () => {} }, undefined, 60_000,
    );

    assert.equal(sent.length, 3);
    assert.equal(sent[1].input[0].type, 'message', 'the first correction answers the input rejection');
    assert.equal(sent[2].input[0].type, 'message', 'the second correction keeps the corrected input');
    assert.equal(sent[2].reasoning, undefined, 'the second correction drops reasoning');

    const events = providerRequests();
    assert.deepEqual(events.map((event) => event.code), ['input-shape-retry', 'reasoning-retry', undefined]);
    assert.equal(events[2].outcome, 'ok');
  });

  it('reports a native rejection LC cannot correct as an HTTP error', async () => {
    const client = new LLMClient({
      baseUrl: 'http://localhost:1234/api/v1',
      apiVariant: 'lm-studio',
      streamFetchImpl: async () => new Response(
        JSON.stringify({ error: { message: 'Model not found', param: 'model' } }),
        { status: 400 },
      ),
    });

    await assert.rejects(
      () => client.chatStream(params(), { onDelta: () => {} }, undefined, 60_000),
      /chat failed: 400/,
    );
    const [request] = providerRequests();
    assert.equal(request.code, 'http-error');
    assert.equal(request.httpStatus, 400);
  });

  it('never corrects a non-native adapter, even on the same rejection body', async () => {
    // The corrections describe LM Studio's native schema, so no other protocol
    // may retry on them. Each variant must fail on its first request.
    for (const opts of [
      { apiVariant: 'openai', apiStyle: 'chat' as const },
      { apiVariant: 'openai', apiStyle: 'responses' as const },
      { apiVariant: 'anthropic' },
    ]) {
      resetDiagnosticEvents();
      let calls = 0;
      const client = new LLMClient({
        ...opts,
        baseUrl: BASE,
        streamFetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({
            error: { message: "Invalid discriminator value. Expected 'text' | 'image'", code: 'invalid_union', param: 'input' },
          }), { status: 400 });
        },
      });

      await assert.rejects(
        () => client.chatStream(
          params({ reasoningEnabled: true, reasoningEffort: 'high' }),
          { onDelta: () => {} }, undefined, 60_000,
        ),
        /chat failed: 400/,
      );
      assert.equal(calls, 1, `${opts.apiVariant}/${opts.apiStyle ?? '-'} must not retry`);
      assert.deepEqual(providerRequests().map((event) => event.code), ['http-error']);
    }
  });

  it('hands the native LM Studio path a sequence its result would have dropped', async () => {
    const client = new LLMClient({
      baseUrl: 'http://localhost:1234/v1',
      apiVariant: 'lm-studio',
      streamFetchImpl: async () => sseResponse(['data: {"content":"ok"}\n\n', 'data: [DONE]\n\n']),
    });
    let handed: number | undefined;

    // The orchestrator destructures the native result into loose fields, so the
    // sequence has to arrive by the callback rather than on the result object.
    await client.chatStream(
      params(), { onDelta: () => {} }, undefined, 60_000, undefined,
      { onSequence: (value) => { handed = value; } },
    );

    assert.equal(typeof handed, 'number');
    assert.equal(providerRequests()[0].sequence, handed);
  });

  it('gives consecutive requests different sequences', async () => {
    const client = new LLMClient({ baseUrl: BASE, streamFetchImpl: async () => chatCompletionsStream() });
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      await client.chatStream(
        params(), { onDelta: () => {} }, undefined, 60_000, undefined,
        { onSequence: (value) => seen.push(value) },
      );
    }
    assert.equal(new Set(seen).size, 3);
  });
});

describe('correlation cannot cross a session boundary', () => {
  it('drops retained sequences so a new request cannot pair with an old stream', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };

    // Session one: a request and its own terminal stream event.
    const first = new DiagnosticEventBuffer(storage);
    const sequence = first.nextSequence();
    first.record({ subsystem: 'provider', operation: 'request', outcome: 'ok', sequence });
    first.record({ subsystem: 'stream', operation: 'completion', outcome: 'ok', code: 'finish-stop', sequence });

    // The persisted ring must not carry the number at all.
    assert.ok(!(store.get('lc:diagnostics:v1') ?? '').includes('"sequence"'));

    // Session two: the counter restarts, so it would otherwise reissue the
    // same number and falsely pair with the retained stream event.
    const second = new DiagnosticEventBuffer(storage);
    assert.equal(second.nextSequence(), sequence);
    const retained = second.read();
    assert.equal(retained.length, 2);
    assert.ok(retained.every((event) => event.sequence === undefined));
  });

  it('wraps the sequence far above the ring size, so live events cannot collide', () => {
    const buffer = new DiagnosticEventBuffer();
    const seen = new Set<number>();
    for (let i = 0; i < 64; i++) seen.add(buffer.nextSequence());
    assert.equal(seen.size, 64);
  });
});

describe('the active request describes the request that actually ran', () => {
  it('counts the tool definitions sent to the provider, not configuration keys', async () => {
    const client = new LLMClient({ baseUrl: BASE, streamFetchImpl: async () => chatCompletionsStream() });

    await client.chatStream(params({
      tools: [
        {
          type: 'function',
          function: { name: 'a', description: 'a', parameters: { type: 'object', properties: {} } },
        },
        {
          type: 'function',
          function: { name: 'b', description: 'b', parameters: { type: 'object', properties: {} } },
        },
      ],
    }), { onDelta: () => {} }, undefined, 60_000);

    assert.equal(readActiveRequestSnapshot()?.toolDefinitionCount, 2);
  });

  it('captures protocol, routing, endpoint class, cache surface, and timeout', async () => {
    const client = new LLMClient({
      baseUrl: 'https://openrouter.ai/api/v1',
      routing: 'direct',
      streamFetchImpl: async () => chatCompletionsStream(),
    });

    await client.chatStream(
      params({ reasoningEnabled: true, reasoningEffort: 'high' }),
      { onDelta: () => {} }, undefined, 300_000, undefined,
      { capabilities: { vision: true, tools: false }, contextWindowKnown: true },
    );

    const snapshot = readActiveRequestSnapshot();
    assert.equal(snapshot?.protocol, 'openai');
    assert.equal(snapshot?.apiStyle, 'chat');
    assert.equal(snapshot?.routing, 'direct');
    assert.equal(snapshot?.endpointClass, 'public-https');
    assert.equal(snapshot?.cacheSurface, 'router');
    assert.equal(snapshot?.reasoningEnabled, true);
    assert.equal(snapshot?.reasoningEffort, 'high');
    assert.equal(snapshot?.streamTimeoutMs, 300_000);
    assert.equal(snapshot?.capabilities?.vision, true);
    assert.equal(snapshot?.contextWindowKnown, true);
  });

  it('captures a failing request too', async () => {
    const client = new LLMClient({
      baseUrl: BASE,
      streamFetchImpl: async () => new Response('nope', { status: 401 }),
    });

    await assert.rejects(() => client.chatStream(params(), { onDelta: () => {} }));

    // A failed request is exactly the one a support report needs to describe.
    assert.equal(readActiveRequestSnapshot()?.protocol, 'openai');
  });

  it('holds no identifier, host, model, or content', async () => {
    const client = new LLMClient({
      baseUrl: 'https://secret-host.example.test/v1',
      apiKey: 'sk-proj-SEEDEDSECRETKEY000000',
      streamFetchImpl: async () => chatCompletionsStream(),
    });

    await client.chatStream(
      params({ model: 'seeded-secret-model', messages: [{ role: 'user', content: 'SEEDED-SECRET-PROMPT' }] }),
      { onDelta: () => {} },
    );

    const serialized = JSON.stringify(readActiveRequestSnapshot());
    for (const forbidden of ['secret-host', 'sk-proj', 'seeded-secret-model', 'SEEDED-SECRET-PROMPT']) {
      assert.ok(!serialized.includes(forbidden), `snapshot must not carry ${forbidden}`);
    }
  });
});

describe('the correlation number never reaches a serialized report', () => {
  it('is absent from the v1 event projection the report serializes', async () => {
    const { buildSupportReportV1 } = await import('../../utils/support-report.ts');
    resetDiagnosticEvents();
    recordDiagnosticEvent({
      subsystem: 'stream', operation: 'completion', outcome: 'ok', code: 'finish-stop', sequence: 41,
    });

    const events = readDiagnosticEvents();
    assert.equal(events[0].sequence, 41, 'the ring keeps it so correlation can work');

    const report = buildSupportReportV1({ diagnosticEvents: events });

    // The projection is an allowlist, so the number cannot reach the bytes.
    assert.ok(!JSON.stringify(report).includes('"sequence"'));
    for (const event of report.diagnostics.events) {
      assert.ok(!('sequence' in event));
    }
  });
});
