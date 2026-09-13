import { Channel } from '@tauri-apps/api/core';
import { STATUS_TEXT } from './fetch.ts';

const MAX_QUEUE_BYTES = 16 * 1024 * 1024; // 16 MiB

export interface StreamRequestInit extends RequestInit {
  /** Maximum time to wait for upstream response headers / the first relay event. */
  responseTimeoutMs?: number;
}

export type StreamFetch = (
  input: string | URL | Request,
  init?: StreamRequestInit,
) => Promise<Response>;

/**
 * Tauri-aware streaming fetch: kicks off the Rust streaming proxy and returns
 * a Response whose body is a ReadableStream that yields chunks as the
 * upstream SSE stream produces them. Used for chat completions so the user
 * sees the assistant's reply token-by-token (and reasoning deltas) even
 * though the webview never touches the LM Studio URL directly.
 */
export async function tauriStreamFetch(
  input: string | URL | Request,
  init?: StreamRequestInit,
): Promise<Response> {
  const invoke = (window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: unknown) => Promise<unknown> };
  }).__TAURI_INTERNALS__?.invoke;
  if (!invoke) {
    throw new Error('Tauri internals not available');
  }

  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? 'GET';
  const headers: Array<[string, string]> = [];
  if (init?.headers) {
    const h = new Headers(init.headers);
    h.forEach((v, k) => headers.push([k, v]));
  }
  const body = init?.body ? String(init.body) : undefined;

  type Payload = { chunk?: string; done: boolean; status?: number; error?: string };
  const state = {
    firstEvent: null as Payload | null,
    pendingEvents: [] as Payload[],
    pendingEventBytes: 0,
    controller: null as ReadableStreamDefaultController<Uint8Array> | null,
    cancelled: false,
    closed: false,
    failure: null as Error | null,
  };
  const encoder = new TextEncoder();
  let connectAbortHandler: (() => void) | null = null;
  let streamAbortHandler: (() => void) | null = null;
  let nativeCallId: string | null = null;
  let nativeCancelRequested = false;
  let nativeCancelSent = false;

  let resolveFirst!: (p: Payload) => void;
  let rejectFirst!: (e: unknown) => void;
  const firstEventP = new Promise<Payload>((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });

  const cancelNativeStream = () => {
    nativeCancelRequested = true;
    if (!nativeCallId || nativeCancelSent) return;
    nativeCancelSent = true;
    void invoke('abort_tool_calls', { callIds: [nativeCallId] }).catch(() => {});
  };

  const removeAbortHandlers = () => {
    if (connectAbortHandler) {
      init?.signal?.removeEventListener('abort', connectAbortHandler);
      connectAbortHandler = null;
    }
    if (streamAbortHandler) {
      init?.signal?.removeEventListener('abort', streamAbortHandler);
      streamAbortHandler = null;
    }
  };

  const cleanup = (cancelNative: boolean) => {
    if (cancelNative) cancelNativeStream();
    removeAbortHandlers();
  };

  const releasePendingEvents = () => {
    state.pendingEvents.length = 0;
    state.pendingEventBytes = 0;
  };

  const failStream = (error: Error, cancelNative: boolean) => {
    if (state.closed || state.cancelled) return;
    state.closed = true;
    state.failure = error;
    releasePendingEvents();
    const controller = state.controller;
    state.controller = null;
    try {
      controller?.error(error);
    } finally {
      cleanup(cancelNative);
    }
  };

  const enqueueChunk = (chunk: string): boolean => {
    const controller = state.controller;
    if (!controller || state.closed || state.cancelled) return false;

    // ByteLengthQueuingStrategy provides backpressure signalling, not a hard
    // cap. Abort the whole relay when the next chunk would exceed the budget.
    // Dropping a chunk and continuing can silently produce valid-looking but
    // incomplete SSE/tool-call data.
    const desiredSize = controller.desiredSize;
    if (desiredSize === null || desiredSize <= 0) {
      failStream(new Error('Tauri stream buffer exceeded 16 MiB'), true);
      return false;
    }
    const encoded = encoder.encode(chunk);
    if (encoded.byteLength > desiredSize) {
      failStream(new Error('Tauri stream buffer exceeded 16 MiB'), true);
      return false;
    }
    controller.enqueue(encoded);
    return true;
  };

  if (init?.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  connectAbortHandler = () => {
    if (state.cancelled || state.closed) return;
    state.cancelled = true;
    cleanup(true);
    rejectFirst(new DOMException('Aborted', 'AbortError'));
  };
  init?.signal?.addEventListener('abort', connectAbortHandler, { once: true });

  const handleStreamEvent = (payload: Payload) => {
    if (state.cancelled || state.closed) return;
    if (payload.error) {
      // Rust sends errors as terminal messages, so no second native cancel is
      // needed here; just release the JS stream state.
      failStream(new Error(payload.error), false);
      return;
    }
    if (payload.chunk && !enqueueChunk(payload.chunk)) return;
    if (payload.done) {
      state.closed = true;
      const controller = state.controller;
      state.controller = null;
      controller?.close();
      cleanup(false);
    }
  };

  // A Tauri Channel callback is registered before invoke starts the native
  // relay. Unlike an app event listener installed after invoke returns, it
  // cannot miss a fast status/error event emitted by the spawned Rust task.
  const events = new Channel<Payload>((payload) => {
    if (state.cancelled || state.closed) return;
    if (state.firstEvent === null) {
      state.firstEvent = payload;
      if (payload.chunk) {
        const chunkBytes = encoder.encode(payload.chunk).byteLength;
        if (chunkBytes > MAX_QUEUE_BYTES) {
          failStream(new Error('Tauri stream buffer exceeded 16 MiB'), true);
          resolveFirst(payload);
          return;
        }
        state.pendingEventBytes = chunkBytes;
      }
      if (connectAbortHandler) {
        init?.signal?.removeEventListener('abort', connectAbortHandler);
        connectAbortHandler = null;
      }
      resolveFirst(payload);
      return;
    }
    // Rust can send body chunks immediately after status, before the invoke
    // continuation has constructed the ReadableStream controller.
    if (!state.controller) {
      if (payload.chunk) {
        const chunkBytes = encoder.encode(payload.chunk).byteLength;
        if (chunkBytes > MAX_QUEUE_BYTES - state.pendingEventBytes) {
          failStream(new Error('Tauri stream buffer exceeded 16 MiB'), true);
          return;
        }
        state.pendingEventBytes += chunkBytes;
      }
      state.pendingEvents.push(payload);
      return;
    }
    handleStreamEvent(payload);
  });

  let first: Payload;
  try {
    // Start the native relay and retain the registry identity used by Rust.
    // Cancelling only the JS ReadableStream is insufficient: without the
    // matching native abort, reqwest keeps reading and Tauri keeps sending.
    const streamId = (await invoke('proxy_stream', {
      req: {
        url,
        method,
        headers,
        body,
        responseTimeoutMs: init?.responseTimeoutMs,
      },
      onEvent: events,
    })) as string;
    nativeCallId = `lc-stream-${streamId}`;
    if (nativeCancelRequested) cancelNativeStream();
    first = await firstEventP;
  } catch (error) {
    releasePendingEvents();
    cleanup(true);
    if (init?.signal?.aborted || state.cancelled) {
      throw new DOMException('Aborted', 'AbortError');
    }
    throw error;
  }
  if (state.failure) {
    throw state.failure;
  }
  if (first.error) {
    state.closed = true;
    releasePendingEvents();
    cleanup(false);
    throw new Error(first.error);
  }
  const upstreamStatus = first.status ?? 200;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      state.controller = controller;
      if (init?.signal?.aborted) {
        state.cancelled = true;
        state.controller = null;
        controller.error(new DOMException('Aborted', 'AbortError'));
        cleanup(true);
        return;
      }
      if (first.chunk && !enqueueChunk(first.chunk)) return;
      if (first.done) {
        state.closed = true;
        state.controller = null;
        controller.close();
        cleanup(false);
        return;
      }

      streamAbortHandler = () => {
        if (state.closed || state.cancelled) return;
        state.cancelled = true;
        state.controller = null;
        controller.error(new DOMException('Aborted', 'AbortError'));
        cleanup(true);
      };
      init?.signal?.addEventListener('abort', streamAbortHandler, { once: true });

      const pending = state.pendingEvents.splice(0);
      state.pendingEventBytes = 0;
      for (const payload of pending) {
        handleStreamEvent(payload);
        if (state.closed || state.cancelled) return;
      }
    },
    cancel() {
      state.cancelled = true;
      state.controller = null;
      cleanup(true);
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_QUEUE_BYTES }));

  return new Response(stream, {
    status: upstreamStatus,
    statusText: STATUS_TEXT[upstreamStatus] ?? '',
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
