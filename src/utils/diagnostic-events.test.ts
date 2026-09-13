import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DiagnosticEventBuffer,
  type DiagnosticStorage,
} from './diagnostic-events.ts';
import { SUPPORT_REPORT_MAX_EVENTS } from './support-report-base.ts';

class MemoryStorage implements DiagnosticStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('structured diagnostic event ring', () => {
  test('keeps a bounded allowlisted ring and preserves explicit zeroes', () => {
    const storage = new MemoryStorage();
    const buffer = new DiagnosticEventBuffer(storage);
    for (let index = 0; index < 100; index++) {
      buffer.record({
        at: index,
        subsystem: 'stream',
        operation: 'completion',
        outcome: 'ok',
        code: 'finish-stop',
        httpStatus: 200,
        promptTokens: 0,
        completionTokens: index,
        totalTokens: index,
        ...({ arbitraryPayload: `secret-${index}` } as object),
      });
    }
    const events = buffer.read();
    assert.equal(events.length, SUPPORT_REPORT_MAX_EVENTS);
    assert.equal(events[0].at, 100 - SUPPORT_REPORT_MAX_EVENTS);
    assert.equal(events.at(-1)?.completionTokens, 99);
    assert.equal(events[0].promptTokens, 0);
    assert.equal(JSON.stringify(events).includes('arbitraryPayload'), false);
  });

  test('sanitizes descriptions before persistence and ignores corrupt oversized state', () => {
    const storage = new MemoryStorage();
    const buffer = new DiagnosticEventBuffer(storage);
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456';
    buffer.record({
      subsystem: 'provider',
      operation: 'request',
      outcome: 'error',
      code: 'network-error',
      description: `Failed for ${secret} at C:\\Users\\Alice\\secret.txt`,
    });
    assert.equal([...storage.values.values()].join('').includes(secret), false);
    assert.equal(JSON.stringify(buffer.read()).includes(secret), false);

    const corrupt = new MemoryStorage();
    corrupt.values.set('lc:diagnostics:v1', 'x'.repeat(70 * 1024));
    assert.deepEqual(new DiagnosticEventBuffer(corrupt).read(), []);
  });
});
