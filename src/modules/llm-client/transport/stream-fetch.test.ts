/**
 * Tauri stream bridge lifecycle tests.
 * Run with: node --test --experimental-strip-types
 * src/modules/llm-client/transport/stream-fetch.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tauriStreamFetch } from './stream-fetch.ts';

type Payload = { chunk?: string; done: boolean; status?: number; error?: string };

test('pre-registered IPC channel preserves a first message sent before invoke resolves', async (t) => {
  const originalWindow = globalThis.window;
  let nextCallbackId = 1;
  let relayChannel: { onmessage: (payload: Payload) => void } | undefined;
  let relayRequest: { responseTimeoutMs?: number } | undefined;
  const commands: string[] = [];

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        transformCallback: () => nextCallbackId++,
        unregisterCallback: () => {},
        invoke: async (command: string, args: unknown) => {
          commands.push(command);
          if (command !== 'proxy_stream') return 0;
          const invocation = args as {
            req: { responseTimeoutMs?: number };
            onEvent: { onmessage: (payload: Payload) => void };
          };
          relayRequest = invocation.req;
          relayChannel = invocation.onEvent;
          // This is the ordering that the old event-listener bridge could
          // lose: Rust emits status before the invoke promise settles.
          relayChannel.onmessage({ done: false, status: 201 });
          relayChannel.onmessage({ chunk: 'data: ok\n\n', done: false, status: 201 });
          relayChannel.onmessage({ done: true, status: 201 });
          return '7';
        },
      },
    },
  });
  t.after(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  const response = await tauriStreamFetch('https://example.test/stream', {
    method: 'POST',
    responseTimeoutMs: 12_345,
  });
  assert.equal(response.status, 201);
  assert.equal(relayRequest?.responseTimeoutMs, 12_345);

  assert.equal(await response.text(), 'data: ok\n\n');
  assert.deepEqual(commands, ['proxy_stream']);
});

test('aggregate events before controller creation obey the 16 MiB queue cap', async (t) => {
  const originalWindow = globalThis.window;
  let nextCallbackId = 1;
  const abortedIds: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        transformCallback: () => nextCallbackId++,
        unregisterCallback: () => {},
        invoke: async (command: string, args: unknown) => {
          if (command === 'abort_tool_calls') {
            abortedIds.push(...(args as { callIds: string[] }).callIds);
            return 0;
          }
          assert.equal(command, 'proxy_stream');
          const channel = (args as {
            onEvent: { onmessage: (payload: Payload) => void };
          }).onEvent;
          channel.onmessage({ done: false, status: 200 });
          const chunk = 'x'.repeat(6 * 1024 * 1024);
          channel.onmessage({ chunk, done: false });
          channel.onmessage({ chunk, done: false });
          channel.onmessage({ chunk, done: false });
          return '77';
        },
      },
    },
  });
  t.after(() => {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  await assert.rejects(
    tauriStreamFetch('https://example.test/pre-controller-cap'),
    /buffer exceeded 16 MiB/,
  );
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.deepEqual(abortedIds, ['lc-stream-77']);
});

test('an already-aborted request never starts a native relay', async (t) => {
  const originalWindow = globalThis.window;
  let invoked = false;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async () => {
          invoked = true;
          return '1';
        },
      },
    },
  });
  t.after(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tauriStreamFetch('https://example.test/stream', { signal: controller.signal }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(invoked, false);
});

test('three native streams stay isolated when the middle request is cancelled', async (t) => {
  const originalWindow = globalThis.window;
  let nextStreamId = 1;
  let nextCallbackId = 1;
  const channels = new Map<number, { onmessage: (payload: Payload) => void }>();
  const aborts: string[][] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        transformCallback: () => nextCallbackId++,
        unregisterCallback: () => {},
        invoke: async (command: string, args: unknown) => {
          if (command === 'abort_tool_calls') {
            aborts.push((args as { callIds: string[] }).callIds);
            return 0;
          }
          assert.equal(command, 'proxy_stream');
          const id = nextStreamId++;
          const channel = (args as { onEvent: { onmessage: (payload: Payload) => void } }).onEvent;
          channels.set(id, channel);
          channel.onmessage({ done: false, status: 200 });
          return String(id);
        },
      },
    },
  });
  t.after(() => {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const [a, b, c] = await Promise.all(controllers.map((controller, index) =>
    tauriStreamFetch(`https://example.test/stream-${index}`, { signal: controller.signal })));

  const aText = a.text();
  const bText = b.text();
  const cText = c.text();
  channels.get(1)?.onmessage({ chunk: 'data: a\n\n', done: false });
  channels.get(2)?.onmessage({ chunk: 'data: b-before-cancel\n\n', done: false });
  channels.get(3)?.onmessage({ chunk: 'data: c\n\n', done: false });
  controllers[1]?.abort();
  channels.get(1)?.onmessage({ done: true });
  channels.get(3)?.onmessage({ done: true });

  assert.equal(await aText, 'data: a\n\n');
  await assert.rejects(bText, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(await cText, 'data: c\n\n');
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.deepEqual(aborts, [['lc-stream-2']]);
});

test('a middle maximum-queue failure leaves two sibling streams independent', async (t) => {
  const originalWindow = globalThis.window;
  let nextStreamId = 1;
  let nextCallbackId = 1;
  const channels = new Map<number, { onmessage: (payload: Payload) => void }>();
  const abortedIds: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        transformCallback: () => nextCallbackId++,
        unregisterCallback: () => {},
        invoke: async (command: string, args: unknown) => {
          if (command === 'abort_tool_calls') {
            abortedIds.push(...(args as { callIds: string[] }).callIds);
            return 0;
          }
          const id = nextStreamId++;
          const channel = (args as { onEvent: { onmessage: (payload: Payload) => void } }).onEvent;
          channels.set(id, channel);
          channel.onmessage({ done: false, status: 200 });
          return String(id);
        },
      },
    },
  });
  t.after(() => {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  const responses = await Promise.all([1, 2, 3].map((id) =>
    tauriStreamFetch(`https://example.test/max-${id}`)));
  const reads = responses.map((response) => response.text());
  const oversizedChunk = 'x'.repeat(16 * 1024 * 1024 + 1);
  channels.get(1)?.onmessage({ chunk: 'data: a\n\n', done: false });
  channels.get(2)?.onmessage({ chunk: oversizedChunk, done: false });
  channels.get(3)?.onmessage({ chunk: 'data: c\n\n', done: false });
  channels.get(1)?.onmessage({ done: true });
  channels.get(3)?.onmessage({ done: true });

  assert.equal(await reads[0], 'data: a\n\n');
  await assert.rejects(reads[1], /buffer exceeded 16 MiB/);
  assert.equal(await reads[2], 'data: c\n\n');
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.deepEqual(abortedIds, ['lc-stream-2']);
});
