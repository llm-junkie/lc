/**
 * Two defects found by reading a real support report from a live session
 * (`log/lc-support-v1-2026-08-04.json`, six real provider APIs).
 *
 * 1. The report projected its event list through the narrower base
 *    vocabulary. Every `model`, `search`, and `credential` event was dropped
 *    outright, and every extended operation and code degraded to `unknown`. The real
 *    report showed 52 events, 42 of them unidentifiable, and not one of the
 *    credential/search/model events that its own sections were built from.
 *
 * 2. The streaming checkpoint saves conversation metadata and the active
 *    turn's messages every five seconds. Recording each of those filled the
 *    64-entry ring with copies of one fact and evicted the startup, credential,
 *    and search events — which is why `databaseOpen`, `metadataHydrate`,
 *    `indexedRead`, and two of the three credential bootstraps read `unknown`
 *    in a report from a healthy session.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DiagnosticEventBuffer,
  readDiagnosticEvents,
  recordDiagnosticEvent,
  resetDiagnosticEvents,
} from './diagnostic-events.ts';
import { buildSupportReportV1 } from './support-report.ts';
import { buildSupportReportBase } from './support-report-base.ts';

function eventsOf<Event>(report: { diagnostics: { events: Event[] } }): Event[] {
  return report.diagnostics.events;
}

beforeEach(() => {
  resetDiagnosticEvents();
});

describe('a support report identifies the events it was built from', () => {
  const ring = [
    { at: 1, subsystem: 'storage', operation: 'durable-write', outcome: 'ok', code: 'storage-write-ok' },
    { at: 2, subsystem: 'storage', operation: 'hydrate', outcome: 'ok', code: 'storage-hydrate-ok' },
    { at: 3, subsystem: 'storage', operation: 'indexed-read', outcome: 'ok', code: 'storage-read-ok' },
    { at: 4, subsystem: 'credential', operation: 'bootstrap', outcome: 'ok', code: 'credential-keychain-ok' },
    { at: 5, subsystem: 'search', operation: 'resolve', outcome: 'ok', code: 'search-resolved' },
    { at: 6, subsystem: 'model', operation: 'model-list', outcome: 'ok', code: 'model-list-ok', httpStatus: 200 },
    { at: 7, subsystem: 'tool', operation: 'permission', outcome: 'rejected', code: 'tool-permission-denied' },
  ] as const;

  it('keeps model, search, and credential events instead of dropping them', () => {
    const events = eventsOf(buildSupportReportV1({ diagnosticEvents: [...ring] }));

    assert.equal(events.length, ring.length);
    const subsystems = events.map((event) => event.subsystem);
    assert.ok(subsystems.includes('credential'));
    assert.ok(subsystems.includes('search'));
    assert.ok(subsystems.includes('model'));
  });

  it('reports current operations and codes instead of `unknown`', () => {
    const events = eventsOf(buildSupportReportV1({ diagnosticEvents: [...ring] }));

    assert.deepEqual(events.map((event) => event.operation), [
      'durable-write', 'hydrate', 'indexed-read', 'bootstrap', 'resolve', 'model-list', 'permission',
    ]);
    assert.deepEqual(events.map((event) => event.code), [
      'storage-write-ok', 'storage-hydrate-ok', 'storage-read-ok', 'credential-keychain-ok',
      'search-resolved', 'model-list-ok', 'tool-permission-denied',
    ]);
    assert.equal(events[5].httpStatus, 200);
  });

  it('still clamps an unrecognized value rather than serializing provider text', () => {
    const events = eventsOf(buildSupportReportV1({
      diagnosticEvents: [
        { at: 1, subsystem: 'storage', operation: 'durable-write', outcome: 'ok', code: 'not-a-real-code' },
        { at: 2, subsystem: 'not-a-real-subsystem', operation: 'durable-write', outcome: 'ok' },
      ],
    }));

    assert.equal(events.length, 1, 'an unknown subsystem is dropped, not invented');
    assert.equal(events[0].code, 'unknown');
  });

  it('never copies the correlation number into the event list', () => {
    const report = buildSupportReportV1({
      diagnosticEvents: [
        { at: 1, subsystem: 'stream', operation: 'completion', outcome: 'ok', code: 'finish-stop', sequence: 7 },
      ],
    });
    assert.ok(!JSON.stringify(report.diagnostics).includes('"sequence"'));
  });

  it('keeps the shared base projection intentionally narrow', () => {
    const events = eventsOf(buildSupportReportBase({ diagnosticEvents: [...ring] }));

    // Extended subsystems are not part of the base vocabulary and stay out of it.
    assert.ok(!events.some((event) => ['credential', 'search', 'model'].includes(event.subsystem as string)));
    // Extended operations and codes still degrade to `unknown` in the base projection.
    assert.equal(events[0].operation, 'unknown');
    assert.equal(events[0].code, 'unknown');
  });
});

describe('a repeating checkpoint cannot flush the ring', () => {
  it('collapses identical consecutive storage writes and keeps the newest time', () => {
    const buffer = new DiagnosticEventBuffer();
    for (let i = 0; i < 200; i++) {
      buffer.record({
        at: 1_000 + i, subsystem: 'storage', operation: 'durable-write', outcome: 'ok', code: 'storage-write-ok',
      });
    }

    const events = buffer.read();
    assert.equal(events.length, 1);
    assert.equal(events[0].at, 1_199, 'the retained entry carries the newest timestamp');
  });

  it('keeps startup and credential facts alive through a long generation', () => {
    const buffer = new DiagnosticEventBuffer();
    buffer.record({ at: 1, subsystem: 'storage', operation: 'open', outcome: 'ok', code: 'storage-open-ok' });
    buffer.record({ at: 2, subsystem: 'storage', operation: 'hydrate', outcome: 'ok', code: 'storage-hydrate-ok' });
    buffer.record({ at: 3, subsystem: 'credential', operation: 'bootstrap', outcome: 'ok', code: 'credential-keychain-ok' });
    buffer.record({ at: 4, subsystem: 'search', operation: 'resolve', outcome: 'ok', code: 'search-resolved' });

    // Twenty minutes of five-second checkpoints, two writes per tick.
    for (let tick = 0; tick < 240; tick++) {
      buffer.record({ at: 1_000 + tick * 5_000, subsystem: 'storage', operation: 'durable-write', outcome: 'ok', code: 'storage-write-ok' });
      buffer.record({ at: 1_001 + tick * 5_000, subsystem: 'storage', operation: 'durable-write', outcome: 'ok', code: 'storage-write-ok' });
    }

    const codes = buffer.read().map((event) => event.code);
    assert.ok(codes.includes('storage-open-ok'), 'database open must survive');
    assert.ok(codes.includes('storage-hydrate-ok'), 'hydrate must survive');
    assert.ok(codes.includes('credential-keychain-ok'), 'credential bootstrap must survive');
    assert.ok(codes.includes('search-resolved'), 'search resolution must survive');
  });

  it('still records a write failure that follows repeated successes', () => {
    const buffer = new DiagnosticEventBuffer();
    buffer.record({ at: 1, subsystem: 'storage', operation: 'durable-write', outcome: 'ok', code: 'storage-write-ok' });
    buffer.record({ at: 2, subsystem: 'storage', operation: 'durable-write', outcome: 'ok', code: 'storage-write-ok' });
    buffer.record({ at: 3, subsystem: 'storage', operation: 'durable-write', outcome: 'error', code: 'storage-write-failed' });

    assert.deepEqual(buffer.read().map((event) => event.code), ['storage-write-ok', 'storage-write-failed']);
  });

  it('does not collapse a read between two writes', () => {
    const buffer = new DiagnosticEventBuffer();
    buffer.record({ at: 1, subsystem: 'storage', operation: 'durable-write', outcome: 'ok', code: 'storage-write-ok' });
    buffer.record({ at: 2, subsystem: 'storage', operation: 'indexed-read', outcome: 'ok', code: 'storage-read-ok' });
    buffer.record({ at: 3, subsystem: 'storage', operation: 'durable-write', outcome: 'ok', code: 'storage-write-ok' });

    assert.equal(buffer.read().length, 3);
  });

  it('collapses the per-request search resolution the tool descriptions trigger', () => {
    // Regenerating the tool descriptions asks which provider is active on every
    // request. A real report showed 30 of 64 entries as this one restatement.
    const buffer = new DiagnosticEventBuffer();
    buffer.record({ at: 1, subsystem: 'credential', operation: 'bootstrap', outcome: 'ok', code: 'credential-keychain-ok' });
    for (let i = 0; i < 100; i++) {
      buffer.record({
        at: 100 + i, subsystem: 'search', operation: 'resolve', outcome: 'ok', code: 'search-resolved',
        searchSelected: 'searxng', searchResolved: 'searxng', searchConfigured: true,
      });
    }

    const events = buffer.read();
    assert.equal(events.length, 2);
    assert.equal(events[0].code, 'credential-keychain-ok', 'the startup fact must survive');
    assert.equal(events[1].at, 199);
  });

  it('still records a search resolution that changed provider', () => {
    const buffer = new DiagnosticEventBuffer();
    buffer.record({ at: 1, subsystem: 'search', operation: 'resolve', outcome: 'ok', code: 'search-resolved', searchResolved: 'brave' });
    buffer.record({ at: 2, subsystem: 'search', operation: 'resolve', outcome: 'ok', code: 'search-resolved', searchResolved: 'brave' });
    buffer.record({ at: 3, subsystem: 'search', operation: 'resolve', outcome: 'ok', code: 'search-resolved', searchResolved: 'searxng' });

    assert.deepEqual(buffer.read().map((event) => event.searchResolved), ['brave', 'searxng']);
  });

  it('never collapses events that carry counters', () => {
    // Stream events are summed across the ring, so collapsing them would
    // undercount even when two are byte-identical.
    const buffer = new DiagnosticEventBuffer();
    for (let i = 0; i < 3; i++) {
      buffer.record({
        subsystem: 'stream', operation: 'completion', outcome: 'ok', code: 'finish-stop',
        at: 10 + i, promptTokens: 5, completionTokens: 5, totalTokens: 10,
      });
    }
    assert.equal(buffer.read().length, 3);
  });

  it('keeps the last durable write age correct after collapsing', () => {
    resetDiagnosticEvents();
    for (let i = 0; i < 50; i++) {
      recordDiagnosticEvent({
        at: 1_000 + i * 5_000, subsystem: 'storage', operation: 'durable-write',
        outcome: 'ok', code: 'storage-write-ok',
      });
    }
    const events = readDiagnosticEvents();
    const report = buildSupportReportV1({ diagnosticEvents: events }, {}, new Date(1_000 + 49 * 5_000 + 30_000));

    assert.equal(report.storage.durableWrite.code, 'storage-write-ok');
    assert.equal(report.storage.lastDurableWriteAgeBucket, 'under-1m');
  });
});
