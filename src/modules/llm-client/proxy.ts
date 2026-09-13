import { isTauri } from '../../utils/saveBlob.ts';

/**
 * Rewrite any direct LM Studio URL to go through the proxy so we never
 * hit CORS preflight failures. The proxy target is encoded in the path
 * (not a query param) so the client's normal `${baseUrl}/models` string
 * concatenation works correctly.
 *
 *   http://192.168.31.7:1234/v1  →  /lc-proxy/http+192.168.31.7:1234/v1
 *
 * The rewrite applies whenever we're running inside the Vite dev server
 * (DEV mode) OR inside the Tauri shell — in both cases there's a proxy
 * available at /lc-proxy/*. Plain browser usage (no Tauri, no Vite)
 * leaves the URL alone, which will hit CORS — that's expected.
 *
 * `routing === 'direct'` skips the rewrite so the browser hits the
 * real URL. Use that when LM Studio has CORS enabled, or when the
 * proxy is misbehaving and you want to bypass it for debugging.
 */
export function devProxyUrl(baseUrl: string, routing: 'proxy' | 'direct' = 'proxy'): string {
  if (routing === 'direct') return baseUrl;
  if (!import.meta.env?.DEV && !isTauri) return baseUrl;
  // Already a proxy URL — leave it alone. Anchored on the slash so
  // a hypothetical path like `/lc-proxy-foo/...` doesn't match.
  if (baseUrl.startsWith('/lc-proxy/') || baseUrl === '/lc-proxy') return baseUrl;

  // The user is expected to paste a bare host:port (e.g.
  // `http://192.168.1.10:1234`) but the field is forgiving — it
  // will also accept trailing/leading whitespace and a base path
  // (`http://localhost:1234/lms`) for users running LM Studio
  // behind a reverse proxy. Trim, then parse.
  const trimmed = baseUrl.trim();
  if (!trimmed) return baseUrl;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Not a parseable absolute URL — return as-is. The downstream
    // fetch will fail with a clear error, and the user can fix the
    // input.
    return baseUrl;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return baseUrl;
  const proto = url.protocol.replace(':', ''); // "http" or "https"
  // `url.host` includes user-info (`user:pass@host:1234`) if the
  // caller pasted credentials into the URL. We refuse to forward
  // those — the Vite proxy would put them in the upstream request
  // URL and the browser would send them as `Authorization: Basic`,
  // which LM Studio doesn't accept and which leaks the password
  // to anyone who can see the network traffic (or the dev proxy
  // log). LM Studio uses the `Authorization: Bearer` header from
  // the `apiKey` field, not URL-embedded credentials.
  if (url.username || url.password) {
    return baseUrl;
  }
  const hostPort = url.host; // "192.168.31.7:1234"
  const path = url.pathname.replace(/\/+$/, '') || '';
  return `/lc-proxy/${proto}+${hostPort}${path}`;
}

export function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
