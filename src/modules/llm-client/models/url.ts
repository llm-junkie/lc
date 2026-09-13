/** URL helpers shared by model discovery and the server-profile editor. */

function trimTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** Whether a profile points at localhost or a LAN host. */
export function isLocalNetworkUrl(baseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.startsWith('127.') ||
    hostname.endsWith('.local') ||
    !hostname.includes('.')
  ) {
    return true;
  }

  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254);
}

/** Compute the first model-list URL used when no override is stored. */
export function getDefaultModelFetchUrl(baseUrl: string): string {
  const base = trimTrailingSlashes(baseUrl);
  if (!base) return '';
  if (!isLocalNetworkUrl(base)) return `${base}/models`;

  return getLocalNativeModelFetchUrl(base);
}

/** Resolve the native LM Studio REST base used for local model management. */
export function getLocalNativeModelBaseUrl(baseUrl: string): string {
  const base = trimTrailingSlashes(baseUrl);
  if (/\/api\/v\d+$/i.test(base)) return base;
  const serverRoot = base.replace(/\/v\d+$/i, '');
  return `${serverRoot}/api/v1`;
}

/** Build LM Studio's native model URL from a direct or proxy-rewritten base. */
export function getLocalNativeModelFetchUrl(baseUrl: string): string {
  return `${getLocalNativeModelBaseUrl(baseUrl)}/models`;
}

/**
 * Resolve an optional override. HTTP(S) URLs are exact, `/path` starts at
 * the server origin, and `path` is appended to the configured Base URL.
 */
export function resolveModelFetchUrl(baseUrl: string, override?: string): string | undefined {
  const value = override?.trim();
  if (!value) return undefined;

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Model fetching URL must use http:// or https://');
    }
    return value;
  }

  const base = trimTrailingSlashes(baseUrl);
  if (value.startsWith('/')) {
    const parsedBase = new URL(base);
    return `${parsedBase.origin}${value}`;
  }

  return `${base}/${value.replace(/^\.\//, '')}`;
}
