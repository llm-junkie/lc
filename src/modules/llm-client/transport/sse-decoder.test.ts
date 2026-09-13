/**
 * Shared SSE decoder — fixture-based tests.
 * Run with: node --test --experimental-strip-types src/modules/llm-client/transport/sse-decoder.test.ts
 *
 * Covers all 10 cases from Phase 4.1 of the LC Tools Stability Plan:
 *   1. LF separators
 *   2. CRLF separators
 *   3. UTF-8 split across chunks
 *   4. Event/data fields split across chunks
 *   5. Multiple data: lines
 *   6. Heartbeat/comment lines
 *   7. Final event without trailing delimiter
 *   8. Abort via AbortSignal
 *   9. Idle timeout
 *  10. Malformed JSON with surfaced protocol error
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeSSE,
  MAX_SSE_EVENT_CHARS,
  type SSEParsedEvent,
} from './sse-decoder.ts';

// ── Helpers ───────────────────────────────────────────────────────────

/** Create a ReadableStream from an array of string chunks. */
function stringStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const byteChunks = chunks.map((s) => enc.encode(s));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of byteChunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** Create a ReadableStream from raw byte chunks. */
function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** Collect all items from an async generator into an array. */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

/** Collect only event items. */
async function collectEvents(
  gen: AsyncGenerator<import('./sse-decoder.ts').SSEDecodeItem>,
): Promise<SSEParsedEvent[]> {
  const events: SSEParsedEvent[] = [];
  for await (const item of gen) {
    if (item.type === 'event') events.push(item.event);
  }
  return events;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('SSE decoder', () => {
  // ── 1. LF separators ──────────────────────────────────────────

  test('LF separators — basic event', async () => {
    const stream = stringStream([
      'data: hello world\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, 'hello world');
    assert.equal(events[0].event, undefined);
  });

  test('LF separators — multiple events', async () => {
    const stream = stringStream([
      'data: first\n\n',
      'data: second\n\n',
      'data: third\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 3);
    assert.equal(events[0].data, 'first');
    assert.equal(events[1].data, 'second');
    assert.equal(events[2].data, 'third');
  });

  test('LF separators — event with type', async () => {
    const stream = stringStream([
      'event: response.output_text.delta\n',
      'data: {"delta":"hello"}\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'response.output_text.delta');
    assert.equal(events[0].data, '{"delta":"hello"}');
  });

  // ── 2. CRLF separators ────────────────────────────────────────

  test('CRLF separators', async () => {
    const stream = stringStream([
      'data: hello\r\n\r\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, 'hello');
  });

  test('CRLF separators — mixed with LF', async () => {
    const stream = stringStream([
      'event: test\r\ndata: value\r\n\r\n',
      'event: test2\ndata: value2\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'test');
    assert.equal(events[0].data, 'value');
    assert.equal(events[1].event, 'test2');
    assert.equal(events[1].data, 'value2');
  });

  test('CRLF remains one line ending when split between chunks', async () => {
    const stream = stringStream([
      'event: split\r',
      '\ndata: value\r',
      '\n\r',
      '\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.deepEqual(events.map(({ event, data }) => ({ event, data })), [
      { event: 'split', data: 'value' },
    ]);
  });

  test('CRLF remains one line ending across an empty decoded chunk', async () => {
    const stream = stringStream([
      'data: value\r',
      '',
      '\n\r',
      '\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.deepEqual(events.map(({ data }) => data), ['value']);
  });

  test('CRLF — data field with CRLF (value itself contains CRLF — should not split)', async () => {
    // The data value "hello\r\nthere" — the \r\n inside data should be the value,
    // not a line separator. Only the blank line after \r\n\r\n is the event boundary.
    // But since we normalize to LF first, the value becomes "hello\nthere"...
    // Actually per SSE spec, lines are separated by \r\n, \r, or \n.
    // A data line "data: hello\r\n" followed by another data line "there" or a
    // blank line. But "data: hello\r\n" inside a chunk... let me test the actual
    // OpenAI format: each SSE event is several lines ending with \n\n.
    // CRLF normalization happens BEFORE line splitting.
    //
    // The key test: CRLF-terminated data lines inside an event.
    const stream = stringStream([
      'data: line1\r\ndata: line2\r\n\r\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    // Two data lines joined by \n
    assert.equal(events[0].data, 'line1\nline2');
  });

  // ── 3. UTF-8 split across chunks ──────────────────────────────

  test('UTF-8 split across chunks — emoji', async () => {
    // '🔥' in UTF-8 is F0 9F 94 A5 (4 bytes)
    const prefix = new TextEncoder().encode('data: hello ');
    const emoji = new TextEncoder().encode('🔥');       // 4 bytes
    const suffix = new TextEncoder().encode(' world\n\n');

    // Split the emoji across chunk boundary: 2 bytes in chunk1, 2 in chunk2.
    const chunk1 = new Uint8Array(prefix.length + 2);
    chunk1.set(prefix, 0);
    chunk1.set(emoji.slice(0, 2), prefix.length);

    const chunk2 = new Uint8Array(2 + suffix.length);
    chunk2.set(emoji.slice(2), 0);
    chunk2.set(suffix, 2);

    const stream = byteStream([chunk1, chunk2]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, 'hello 🔥 world');
  });

  test('UTF-8 split across chunks — multi-byte at chunk boundary', async () => {
    // Japanese: '日本語' — 日 = E6 97 A5, 本 = E6 9C AC, 語 = E8 AA 9E
    const text = 'data: 日本語テスト\n\n';
    const bytes = new TextEncoder().encode(text);

    // Split in the middle of the second character (本 = E6 9C AC at offset ~10)
    const splitPoint = 11; // inside the multi-byte sequence
    const chunk1 = bytes.slice(0, splitPoint);
    const chunk2 = bytes.slice(splitPoint);

    const stream = byteStream([chunk1, chunk2]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, '日本語テスト');
  });

  // ── 4. Event/data fields split across chunks ──────────────────

  test('event field name split across chunks', async () => {
    const stream = stringStream([
      'eve',
      'nt: test\ndata: value\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'test');
    assert.equal(events[0].data, 'value');
  });

  test('data value split across chunks', async () => {
    const stream = stringStream([
      'data: {"delta":"hel',
      'lo"}\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, '{"delta":"hello"}');
  });

  test('data line split mid-keyword', async () => {
    const stream = stringStream([
      'da',
      'ta: hello\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, 'hello');
  });

  test('event boundary split across chunks', async () => {
    const stream = stringStream([
      'data: first\n',
      '\ndata: second\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 2);
    assert.equal(events[0].data, 'first');
    assert.equal(events[1].data, 'second');
  });

  // ── 5. Multiple data: lines ───────────────────────────────────

  test('multiple data lines — joined by newline', async () => {
    const stream = stringStream([
      'data: line one\n',
      'data: line two\n',
      'data: line three\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, 'line one\nline two\nline three');
  });

  test('multiple data lines — with empty data line', async () => {
    // Per SSE spec, an empty data line (just "data:" with nothing after or just space)
    // appends an empty string, which becomes a blank line in the joined data.
    const stream = stringStream([
      'data: line one\n',
      'data:\n',  // empty data line
      'data: line three\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, 'line one\n\nline three');
  });

  // ── 6. Heartbeat/comment lines ────────────────────────────────

  test('comment lines — skipped (pure comment event)', async () => {
    // A comment-only event block produces no event.
    const stream = stringStream([
      ': heartbeat\n\n',
      'data: real event\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, 'real event');
  });

  test('comment lines mixed with data', async () => {
    const stream = stringStream([
      ': this is a comment\n',
      'data: payload\n',
      ': another comment\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, 'payload');
  });

  test('multiple consecutive comment-only events', async () => {
    const stream = stringStream([
      ': ping\n\n',
      ': pong\n\n',
      'data: actual\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, 'actual');
  });

  // ── 7. Final event without trailing delimiter ─────────────────

  test('final event without trailing blank line', async () => {
    const stream = stringStream([
      'data: first\n\n',
      'data: last',  // no trailing \n\n
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 2);
    assert.equal(events[0].data, 'first');
    assert.equal(events[1].data, 'last');
  });

  test('final event — partial line at EOF', async () => {
    const stream = stringStream([
      'data: first\n\n',
      'data: incomplete',  // no \n at all
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 2);
    assert.equal(events[0].data, 'first');
    assert.equal(events[1].data, 'incomplete');
  });

  test('final event with trailing whitespace only', async () => {
    const stream = stringStream([
      'data: hello\n\n  \n  ',  // trailing whitespace after last event
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, 'hello');
  });

  test('only [DONE] sentinel — no event emitted', async () => {
    const stream = stringStream([
      'data: [DONE]\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    // [DONE] is just a data value — the decoder doesn't special-case it.
    // The adapter handles [DONE] semantics.
    assert.equal(events.length, 1);
    assert.equal(events[0].data, '[DONE]');
  });

  // ── 8. Abort via AbortSignal ──────────────────────────────────

  test('abort before stream starts', async () => {
    const controller = new AbortController();
    controller.abort();

    const stream = stringStream(['data: hello\n\n']);
    await assert.rejects(
      async () => {
        for await (const _ of decodeSSE(stream, { signal: controller.signal })) {
          // should not reach here
        }
      },
      (err: unknown) => {
        return err instanceof DOMException && (err as DOMException).name === 'AbortError';
      },
    );
  });

  test('abort mid-stream', async () => {
    const controller = new AbortController();

    // Stream that never ends unless aborted
    let resolveChunk: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\n'));
        // Wait indefinitely — we'll abort instead.
        await new Promise<void>((resolve) => { resolveChunk = resolve; });
      },
    });

    let eventCount = 0;
    const promise = (async () => {
      try {
        for await (const item of decodeSSE(stream, { signal: controller.signal })) {
          if (item.type === 'event') eventCount++;
          // Abort after first event
          controller.abort();
        }
      } catch (e) {
        // Clean up the stuck promise
        resolveChunk?.();
        throw e;
      }
    })();

    await assert.rejects(
      promise,
      (err: unknown) => {
        return err instanceof DOMException && (err as DOMException).name === 'AbortError';
      },
    );
    assert.equal(eventCount, 1, 'first event should have been processed');
  });

  test('completed reads release their abort listeners', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    let additions = 0;
    let removals = 0;
    signal.addEventListener = ((...args: Parameters<typeof signal.addEventListener>) => {
      const [type] = args;
      if (type === 'abort') additions++;
      originalAdd(...args);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((...args: Parameters<typeof signal.removeEventListener>) => {
      const [type] = args;
      if (type === 'abort') removals++;
      originalRemove(...args);
    }) as typeof signal.removeEventListener;

    try {
      const stream = stringStream(['data: complete\n\n']);
      for await (const _ of decodeSSE(stream, { signal, idleTimeoutMs: 1_000 })) {
        // Consume the event and the final done read.
      }
      assert.ok(additions > 0);
      assert.equal(removals, additions);
    } finally {
      signal.addEventListener = originalAdd;
      signal.removeEventListener = originalRemove;
    }
  });

  // ── 9. Idle timeout ──────────────────────────────────────────

  test('idle timeout — no chunks received', async () => {
    // A stream that never produces a chunk
    let cancelReason: unknown;
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // never enqueue anything
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });

    await assert.rejects(
      async () => {
        for await (const _ of decodeSSE(stream, { idleTimeoutMs: 50 })) {
          // should not reach here
        }
      },
      (err: unknown) => {
        return (err as Error).message.includes('idle timeout');
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(cancelReason, 'SSE decoder stopped before stream completion');
  });

  // ── 10. Malformed JSON with surfaced protocol error ────────────

  test('validateJSON — valid JSON passes through', async () => {
    const stream = stringStream([
      'data: {"key":"value"}\n\n',
    ]);
    const items = await collect(decodeSSE(stream, { validateJSON: true }));
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'event');
    if (items[0].type === 'event') {
      assert.equal(items[0].event.data, '{"key":"value"}');
    }
  });

  test('validateJSON — invalid JSON emits issue, not event', async () => {
    const stream = stringStream([
      'data: {broken json\n\n',
    ]);
    const items = await collect(decodeSSE(stream, { validateJSON: true }));
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'issue');
    if (items[0].type === 'issue') {
      assert.equal(items[0].issue.kind, 'malformed_json');
      assert.ok(items[0].issue.message.includes('JSON'));
      assert.equal(items[0].issue.raw, '{broken json');
    }
  });

  test('validateJSON — mixed valid and invalid', async () => {
    const stream = stringStream([
      'data: {"ok":true}\n\n',
      'data: not json\n\n',
      'data: {"also":"ok"}\n\n',
    ]);
    const items = await collect(decodeSSE(stream, { validateJSON: true }));
    assert.equal(items.length, 3);

    assert.equal(items[0].type, 'event');
    if (items[0].type === 'event') {
      assert.equal(items[0].event.data, '{"ok":true}');
    }

    assert.equal(items[1].type, 'issue');
    if (items[1].type === 'issue') {
      assert.equal(items[1].issue.kind, 'malformed_json');
    }

    assert.equal(items[2].type, 'event');
    if (items[2].type === 'event') {
      assert.equal(items[2].event.data, '{"also":"ok"}');
    }
  });

  test('validateJSON — truncated JSON (long data)', async () => {
    // Build a 300-char non-JSON string to test truncation
    const long = 'x'.repeat(300);
    const stream = stringStream([
      `data: ${long}\n\n`,
    ]);
    const items = await collect(decodeSSE(stream, { validateJSON: true }));
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'issue');
    if (items[0].type === 'issue') {
      assert.ok(items[0].issue.raw!.endsWith('…'), 'raw should be truncated');
      assert.ok(items[0].issue.raw!.length < 250, 'raw should be <250 chars');
    }
  });

  test('validateJSON — data field with internal newlines (valid JSON)', async () => {
    // Multiple data lines forming valid JSON when joined
    const stream = stringStream([
      'data: {"a":1,\n',
      'data: "b":2}\n\n',
    ]);
    const items = await collect(decodeSSE(stream, { validateJSON: true }));
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'event');
    // Joined data should be '{"a":1,\n"b":2}' which is valid JSON
    if (items[0].type === 'event') {
      assert.equal(items[0].event.data, '{"a":1,\n"b":2}');
    }
  });

  // ── Additional edge cases ────────────────────────────────────

  test('event with id and retry fields', async () => {
    const stream = stringStream([
      'id: 42\n',
      'event: update\n',
      'retry: 5000\n',
      'data: payload\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].id, '42');
    assert.equal(events[0].event, 'update');
    assert.equal(events[0].retry, 5000);
    assert.equal(events[0].data, 'payload');
  });

  test('data field with colon (value contains colon)', async () => {
    const stream = stringStream([
      'data: {"url":"https://example.com"}\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, '{"url":"https://example.com"}');
  });

  test('data field with leading space after colon', async () => {
    // SSE spec: if value starts with U+0020 SPACE after colon, strip it.
    const stream = stringStream([
      'data: hello\n\n',  // single space
      'data:  world\n\n', // double space; only first stripped
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 2);
    assert.equal(events[0].data, 'hello');
    assert.equal(events[1].data, ' world'); // only first space stripped
  });

  test('field without colon (empty value)', async () => {
    const stream = stringStream([
      'data\n\n',  // "data" with no colon = empty value
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, ''); // empty string, but present
  });

  test('empty stream — no events', async () => {
    const stream = stringStream([]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 0);
  });

  test('only whitespace between events', async () => {
    const stream = stringStream([
      'data: a\n\n',
      '  \n  \n',  // whitespace-only lines
      'data: b\n\n',
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 2);
    assert.equal(events[0].data, 'a');
    assert.equal(events[1].data, 'b');
  });

  test('large event — multi-kilobyte data payload', async () => {
    // Simulate a large tool result in SSE
    const payload = JSON.stringify({ result: 'x'.repeat(10000) });
    const stream = stringStream([
      `event: tool_result\ndata: ${payload}\n\n`,
    ]);
    const events = await collectEvents(decodeSSE(stream));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'tool_result');
    assert.equal(events[0].data, payload);
  });

  test('one large line remains exact across small chunks', async () => {
    const payload = 'x'.repeat(1024 * 1024);
    const raw = `data: ${payload}\n\n`;
    const chunks = Array.from(
      { length: Math.ceil(raw.length / 1024) },
      (_, index) => raw.slice(index * 1024, (index + 1) * 1024),
    );
    const events = await collectEvents(decodeSSE(stringStream(chunks)));
    assert.equal(events.length, 1);
    assert.equal(events[0].data, payload);
  });

  test('rejects one event above the decoded-character cap', async () => {
    const oversized = `data: ${'x'.repeat(MAX_SSE_EVENT_CHARS)}\n\n`;
    await assert.rejects(
      () => collect(decodeSSE(stringStream([oversized]))),
      new RegExp(`SSE event exceeded ${MAX_SSE_EVENT_CHARS} decoded characters`),
    );
  });
});
