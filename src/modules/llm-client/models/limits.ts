/** Shared discovery limits. The native non-stream proxy uses the same 64 MiB body ceiling. */
export const MODEL_DISCOVERY_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
export const MODEL_LIST_MAX_ENTRIES = 16_384;
export const MODEL_ENRICHMENT_CONCURRENCY = 16;
export const MODELS_DEV_MAX_PROVIDERS = 1_024;
export const MODELS_DEV_MAX_MODELS = 65_536;

/** Read a fetch response without allowing `Response.text()` to buffer without a limit. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes = MODEL_DISCOVERY_RESPONSE_MAX_BYTES,
): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`response exceeds the ${maxBytes}-byte model discovery limit`);
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`response exceeds the ${maxBytes}-byte model discovery limit`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(`response exceeds the ${maxBytes}-byte model discovery limit`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
