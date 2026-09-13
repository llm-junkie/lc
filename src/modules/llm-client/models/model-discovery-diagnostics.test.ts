/**
 * Model-discovery diagnostics, through the real `listModels`.
 *
 * The reviewed build recorded `metadataSource` *before* enrichment ran, so it
 * could only ever claim `discovered` or `override` — never `cached`, and never
 * `unknown` after a metadata failure. It also discarded the HTTP status, so a
 * 401 was indistinguishable from a DNS failure.
 *
 * Every case below drives the shipped function with a stub `fetch` and reads
 * the diagnostic ring.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listModels } from './list.ts';
import {
  readDiagnosticEvents,
  resetDiagnosticEvents,
  type DiagnosticEvent,
} from '../../../utils/diagnostic-events.ts';
import type { CompactCache } from './enrich';

const ROOT = 'https://api.example.test/v1';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function discovery(): DiagnosticEvent {
  const events = readDiagnosticEvents().filter((event) => event.subsystem === 'model');
  assert.equal(events.length, 1, 'exactly one discovery outcome per list');
  return events[0];
}

beforeEach(() => {
  resetDiagnosticEvents();
});

describe('model discovery reports where its facts came from', () => {
  it('reports `discovered` when the server describes its own models', async () => {
    const models = await listModels(
      ROOT, ROOT, '',
      async () => json({ models: [{ key: 'local-model', max_context_length: 8192 }] }),
      // An empty cache is still a cache; nothing in it matches, so no
      // enrichment applies and the server's own metadata is what was used.
      {} as CompactCache,
    );

    assert.equal(models.length, 1);
    const event = discovery();
    assert.equal(event.code, 'model-list-ok');
    assert.equal(event.metadataSource, 'discovered');
    assert.equal(event.returnedCountBucket, '1-9');
    assert.equal(event.endpointClass, 'public-https');
    assert.equal(event.httpStatus, 200);
  });

  it('reports `cached` when bundled metadata actually enriched an entry', async () => {
    const cache: CompactCache = {
      example: { api: ROOT, m: { 'cloud-model': { c: 128_000, n: 'Cloud Model', v: true } } },
    };

    const models = await listModels(
      ROOT, ROOT, '', async () => json({ data: [{ id: 'cloud-model' }] }), cache,
    );

    assert.equal(models[0].max_context_length, 128_000);
    assert.equal(discovery().metadataSource, 'cached');
  });

  it('reports `unknown` when neither the server nor a cache described anything', async () => {
    const models = await listModels(
      ROOT, ROOT, '', async () => json({ data: [{ id: 'bare-model' }] }), {} as CompactCache,
    );

    assert.equal(models.length, 1);
    assert.equal(discovery().metadataSource, 'unknown');
  });

  it('reports `override` when a custom endpoint supplied the list', async () => {
    await listModels(
      ROOT, ROOT, '',
      async () => json({ data: [{ id: 'custom-model' }] }),
      { example: { api: ROOT, m: { 'custom-model': { c: 4096 } } } } as CompactCache,
      'https://custom.example.test/models',
    );

    // Override outranks cached enrichment: LC neither resolved the endpoint
    // nor can vouch for the shape of what it returned.
    assert.equal(discovery().metadataSource, 'override');
  });

  it('records a bounded HTTP status when the server refuses the request', async () => {
    await assert.rejects(() => listModels(
      ROOT, ROOT, '', async () => new Response('nope', { status: 401 }),
    ));

    const event = discovery();
    assert.equal(event.code, 'model-list-failed');
    assert.equal(event.outcome, 'error');
    assert.equal(event.httpStatus, 401);
    assert.equal(event.metadataSource, 'unknown');
  });

  it('records a network failure with no status at all', async () => {
    await assert.rejects(() => listModels(
      ROOT, ROOT, '', async () => { throw new TypeError('Failed to fetch'); },
    ));

    const event = discovery();
    assert.equal(event.code, 'model-list-failed');
    assert.equal(event.httpStatus, undefined);
  });

  it('records a parse failure as a failed list, not an empty one', async () => {
    await assert.rejects(() => listModels(
      ROOT, ROOT, '', async () => new Response('<html>not json</html>', { status: 200 }),
    ));

    const event = discovery();
    assert.equal(event.code, 'model-list-failed');
    assert.equal(event.httpStatus, 200);
    assert.equal(event.returnedCountBucket, 'unknown');
  });

  it('never serializes a model list, an exact identifier, or the host', async () => {
    await listModels(
      'https://secret-host.example.test/v1',
      'https://secret-host.example.test/v1',
      'sk-proj-SEEDEDSECRETKEY000000',
      async () => json({ data: [{ id: 'seeded-secret-model-id' }] }),
      {} as CompactCache,
    );

    const serialized = JSON.stringify(readDiagnosticEvents());
    for (const forbidden of ['seeded-secret-model-id', 'secret-host', 'sk-proj']) {
      assert.ok(!serialized.includes(forbidden), `model diagnostics must not carry ${forbidden}`);
    }
  });
});
