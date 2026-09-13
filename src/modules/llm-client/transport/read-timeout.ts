/**
 * If no chunk arrives from the server within this window, the stream is
 * considered dead (server crash, network drop, etc.) and is cancelled.
 * 300 s (5 min) is generous enough for slow / reasoning models that pause
 * between token bursts, but short enough that the user isn't left staring
 * at a spinning indicator forever.
 */
export const SSE_READ_TIMEOUT_MS = 300_000; // 5 min — large tool loops can pause token output for minutes

/**
 * Race a `reader.read()` against a timeout.  If the timeout wins the
 * reader is cancelled (so the owning SSE consume loop can exit) and
 * the promise rejects with a descriptive error.
 */
export async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Cancel the reader so the stream body is released and any
          // pending read is unblocked.
          reader.cancel('read timeout').catch(() => {});
          reject(
            new Error(
              `Stream read timed out after ${timeoutMs / 1000}s — ` +
              `server may have disconnected or crashed`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
