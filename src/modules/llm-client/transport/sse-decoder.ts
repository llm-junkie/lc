/**
 * Shared SSE (Server-Sent Events) byte-to-event decoder.
 *
 * One canonical implementation for all provider adapters. Handles:
 *   - LF and CRLF line separators
 *   - UTF-8 split across chunk boundaries
 *   - Event/data fields split across chunks
 *   - Multiple `data:` lines (joined by \n per spec)
 *   - Heartbeat / comment lines (':' prefix)
 *   - Final event without trailing blank-line delimiter
 *   - Abort via AbortSignal
 *   - Idle timeout
 *   - Malformed JSON detection (optional)
 *
 * W3C SSE spec reference: https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

// ── Types ─────────────────────────────────────────────────────────────

/** A single parsed SSE event. */
export interface SSEParsedEvent {
  /** Event type from the `event:` field. Undefined = default "message" type. */
  event?: string;
  /** Data payload from one or more `data:` fields, joined by '\n'. */
  data?: string;
  /** Event ID from the `id:` field. */
  id?: string;
  /** Retry timeout in ms from the `retry:` field. */
  retry?: number;
}

/** Structured error emitted by the decoder for non-fatal protocol issues. */
export interface SSEDecodeIssue {
  kind: 'malformed_json' | 'empty_event';
  message: string;
  /** The raw event text that caused the issue (truncated). */
  raw?: string;
}

/** Options that tune decoder behaviour. */
export interface SSEDecoderOptions {
  /**
   * When true, every `data` field is validated as JSON and a
   * `malformed_json` issue is emitted on parse failure instead of
   * yielding the event silently. Default: false.
   */
  validateJSON?: boolean;
  /** AbortSignal — checked before reading each chunk and between events. */
  signal?: AbortSignal;
  /**
   * Idle timeout in ms. If no chunk arrives within this window the
   * generator throws with a timeout error. Default: no timeout
   * (caller manages via readWithTimeout or similar).
   */
  idleTimeoutMs?: number;
}

/** The return type of `decodeSSE` — either a parsed event or a protocol issue. */
export type SSEDecodeItem =
  | { type: 'event'; event: SSEParsedEvent }
  | { type: 'issue'; issue: SSEDecodeIssue };

/** Maximum decoded characters retained for one SSE event. */
export const MAX_SSE_EVENT_CHARS = 4 * 1024 * 1024;

interface SSEParseState {
  lineParts: string[];
  lineChars: number;
  eventLines: string[];
  eventChars: number;
  skipLeadingLf: boolean;
}

// ── Implementation ────────────────────────────────────────────────────

/**
 * Decode a byte stream into SSE events.
 *
 * Usage:
 *   for await (const item of decodeSSE(response.body, { signal })) {
 *     if (item.type === 'event') {
 *       console.log(item.event.event, item.event.data);
 *     }
 *   }
 *
 * One decoded event can contain at most `MAX_SSE_EVENT_CHARS` characters.
 * A larger event throws and terminates the stream. The current provider
 * adapters catch this error and report the read as timed out or disconnected.
 */
export async function* decodeSSE(
  body: ReadableStream<Uint8Array>,
  opts: SSEDecoderOptions = {},
): AsyncGenerator<SSEDecodeItem, void, void> {
  const { validateJSON = false, signal, idleTimeoutMs } = opts;

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const parseState: SSEParseState = {
    lineParts: [],
    lineChars: 0,
    eventLines: [],
    eventChars: 0,
    skipLeadingLf: false,
  };
  let completed = false;

  try {
    while (true) {
      // ── Check abort before each read ──
      if (signal?.aborted) {
        throw new DOMException('SSE stream aborted', 'AbortError');
      }

      // ── Read next chunk ──
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        if (idleTimeoutMs != null && idleTimeoutMs > 0) {
          readResult = await raceWithTimeout(reader.read(), idleTimeoutMs, signal);
        } else {
          readResult = await reader.read();
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        // Timeout or other error — throw as a descriptive error.
        throw new Error(
          `SSE stream read failed: ${(e as Error).message || String(e)}`,
          { cause: e },
        );
      }

      const { value, done } = readResult;
      if (done) break;

      // ── Decode chunk incrementally (handles split multi-byte chars) ──
      const decoded = decoder.decode(value, { stream: true });

      // Scan only newly decoded characters. Stable prefixes stay in parts and
      // are joined once when their line or event completes.
      yield* processDecodedText(decoded, parseState, validateJSON);
    }

    // ── Flush final decoder state ──
    yield* processDecodedText(decoder.decode(), parseState, validateJSON);

    // ── Process any remaining lines (final event without trailing delimiter) ──
    if (parseState.lineChars > 0) {
      yield* completeLine(parseState, validateJSON);
    }
    if (parseState.eventLines.length > 0) {
      yield* dispatchEvent(parseState, validateJSON);
    }
    completed = true;
  } finally {
    if (!completed) {
      // A timeout, abort, parse failure, or consumer break must reach the
      // underlying source. For the Tauri stream bridge this invokes cancel(),
      // which removes the JS relay and aborts the matching native request.
      void reader.cancel('SSE decoder stopped before stream completion').catch(() => {});
    }
    reader.releaseLock();
  }
}

/**
 * Process only the new decoded text. A long fragmented line remains an array
 * of stable parts, so each character is scanned once before one final join.
 */
function* processDecodedText(
  text: string,
  state: SSEParseState,
  validateJSON: boolean,
): Generator<SSEDecodeItem, void, void> {
  let cursor = 0;
  if (state.skipLeadingLf && text.length > 0) {
    state.skipLeadingLf = false;
    if (text.startsWith('\n')) cursor = 1;
  }

  while (cursor < text.length) {
    const nextCr = text.indexOf('\r', cursor);
    const nextLf = text.indexOf('\n', cursor);
    const lineEnd = nextCr < 0
      ? nextLf
      : nextLf < 0
        ? nextCr
        : Math.min(nextCr, nextLf);

    if (lineEnd < 0) {
      appendLinePart(state, text.slice(cursor));
      break;
    }

    appendLinePart(state, text.slice(cursor, lineEnd));
    yield* completeLine(state, validateJSON);

    if (text[lineEnd] === '\r') {
      if (text[lineEnd + 1] === '\n') {
        cursor = lineEnd + 2;
      } else {
        cursor = lineEnd + 1;
        if (cursor === text.length) state.skipLeadingLf = true;
      }
    } else {
      cursor = lineEnd + 1;
    }
  }
}

function appendLinePart(state: SSEParseState, part: string): void {
  if (!part) return;
  if (state.eventChars + state.lineChars + part.length > MAX_SSE_EVENT_CHARS) {
    throw new Error(`SSE event exceeded ${MAX_SSE_EVENT_CHARS} decoded characters.`);
  }
  state.lineParts.push(part);
  state.lineChars += part.length;
}

function* completeLine(
  state: SSEParseState,
  validateJSON: boolean,
): Generator<SSEDecodeItem, void, void> {
  const line = state.lineParts.length === 1
    ? state.lineParts[0]
    : state.lineParts.join('');
  state.lineParts = [];
  state.lineChars = 0;

  if (line.length === 0) {
    yield* dispatchEvent(state, validateJSON);
    return;
  }
  if (state.eventChars + line.length + 1 > MAX_SSE_EVENT_CHARS) {
    throw new Error(`SSE event exceeded ${MAX_SSE_EVENT_CHARS} decoded characters.`);
  }
  state.eventLines.push(line);
  state.eventChars += line.length + 1;
}

function* dispatchEvent(
  state: SSEParseState,
  validateJSON: boolean,
): Generator<SSEDecodeItem, void, void> {
  const rawEvent = state.eventLines.join('\n').trim();
  state.eventLines = [];
  state.eventChars = 0;
  if (!rawEvent) return;

  const parsed = parseSSEEvent(rawEvent);
  if (!parsed) return;

  if (validateJSON && parsed.data !== undefined) {
    try {
      JSON.parse(parsed.data);
    } catch (e) {
      yield {
        type: 'issue',
        issue: {
          kind: 'malformed_json',
          message: `SSE data is not valid JSON: ${(e as Error).message}`,
          raw: parsed.data.length > 200
            ? parsed.data.slice(0, 200) + '…'
            : parsed.data,
        },
      };
      return;
    }
  }

  yield { type: 'event', event: parsed };
}

/**
 * Parse a single complete SSE event block (all lines between two blank-line
 * separators, after CR→LF normalization).
 *
 * Returns undefined for pure comment-only events (no `data:` or `event:` fields).
 */
function parseSSEEvent(raw: string): SSEParsedEvent | undefined {
  const lines = raw.split('\n');
  const dataLines: string[] = [];
  let eventType: string | undefined;
  let eventId: string | undefined;
  let retryMs: number | undefined;
  let hasNonComment = false;

  for (const line of lines) {
    if (line === '') continue;
    if (line.startsWith(':')) {
      // Comment line — per spec, may be used as heartbeat/keep-alive.
      continue;
    }

    const colonIdx = line.indexOf(':');
    let field: string;
    let value: string;

    if (colonIdx === -1) {
      // Field with no colon — the entire line is the field name, value is empty.
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIdx);
      // If value starts with a space after colon, strip it (SSE spec).
      const rawValue = line.slice(colonIdx + 1);
      value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    }

    switch (field) {
      case 'event':
        eventType = value;
        hasNonComment = true;
        break;
      case 'data':
        dataLines.push(value);
        hasNonComment = true;
        break;
      case 'id':
        // SSE spec: id field may contain null character; we strip it.
        eventId = value.replace(/\0/g, '');
        hasNonComment = true;
        break;
      case 'retry': {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) retryMs = n;
        hasNonComment = true;
        break;
      }
      // Other fields (e.g. custom) are ignored per spec.
    }
  }

  if (!hasNonComment) return undefined;

  return {
    event: eventType,
    data: dataLines.length > 0 ? dataLines.join('\n') : undefined,
    id: eventId || undefined,
    retry: retryMs,
  };
}

/** Race a promise against an idle timeout and an abort signal. */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`SSE idle timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => {
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : new Promise<never>(() => {}); // never resolves

  try {
    return await Promise.race([promise, timeoutPromise, abortPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}
