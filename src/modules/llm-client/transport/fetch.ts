/** Subset of the standard HTTP status text table — covers what
 *  LM Studio can actually return (5xx, 4xx, 2xx). Falls back to
 *  an empty string for anything we don't know, which matches the
 *  default Web `Response` behavior. */
export const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/**
 * Tauri-aware fetch: routes all requests through the Rust proxy command
 * so that CORS is never an issue (the webview is always same-origin).
 * Returns a Response-like object so it can be used as a drop-in for fetch.
 */
export async function tauriFetch(
  input: string | URL | Request,
  init?: RequestInit,
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

  const result = (await invoke('proxy_request', {
    req: { url, method, headers, body },
  })) as { status: number; headers: Array<[string, string]>; body: string };

  const respHeaders = new Headers();
  for (const [k, v] of result.headers) {
    try { respHeaders.set(k, v); } catch { /* skip invalid */ }
  }
  return new Response(result.body, {
    status: result.status,
    statusText: '',
    headers: respHeaders,
  });
}
