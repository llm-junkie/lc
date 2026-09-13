const CREDENTIAL_PARAMETER_NAMES = new Set([
  'accesskey',
  'accesskeyid',
  'accesstoken',
  'apikey',
  'auth',
  'authorization',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'credential',
  'credentials',
  'key',
  'password',
  'passwd',
  'refreshtoken',
  'secret',
  'sessiontoken',
  'sig',
  'signature',
  'subscriptionkey',
  'token',
  'xapikey',
  'xauthtoken',
  'xamzcredential',
  'xamzsecuritytoken',
  'xamzsignature',
  'xgoogcredential',
  'xgoogsignature',
]);

function isCredentialParameterName(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return CREDENTIAL_PARAMETER_NAMES.has(normalized);
}

function credentialParameterNames(searchParams: URLSearchParams): string[] {
  return Array.from(new Set(searchParams.keys())).filter(isCredentialParameterName);
}

interface FragmentParameters {
  prefix: string;
  separator: '' | '?';
  searchParams: URLSearchParams;
}

function fragmentParameters(hash: string): FragmentParameters | undefined {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!fragment) return undefined;

  const queryIndex = fragment.indexOf('?');
  if (queryIndex >= 0) {
    return {
      prefix: fragment.slice(0, queryIndex),
      separator: '?',
      searchParams: new URLSearchParams(fragment.slice(queryIndex + 1)),
    };
  }

  if (!fragment.includes('=') && !fragment.includes('&')) return undefined;
  return {
    prefix: '',
    separator: '',
    searchParams: new URLSearchParams(fragment),
  };
}

function credentialFragmentNames(hash: string): string[] {
  const fragment = fragmentParameters(hash);
  return fragment ? credentialParameterNames(fragment.searchParams) : [];
}

function parsedHasUrlCredentials(parsed: URL): boolean {
  return parsed.username.length > 0
    || parsed.password.length > 0
    || credentialParameterNames(parsed.searchParams).length > 0
    || credentialFragmentNames(parsed.hash).length > 0;
}

function hasHttpProtocol(parsed: URL): boolean {
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

function removeFragmentCredentials(hash: string, names: string[]): string {
  if (names.length === 0) return hash;
  const fragment = fragmentParameters(hash);
  if (!fragment) return hash;

  for (const name of names) fragment.searchParams.delete(name);
  const parameters = fragment.searchParams.toString();
  const value = `${fragment.prefix}${parameters ? `${fragment.separator}${parameters}` : ''}`;
  return value ? `#${value}` : '';
}

/**
 * Whether a URL carries username/password user-info or a recognized credential
 * parameter in its query or structured fragment. Parameter names are
 * case-insensitive and ignore separators. This reports detection only. Use
 * isUrlCredentialFree at a boundary that must reject invalid input.
 */
export function hasUrlCredentials(value: string, base?: string): boolean {
  try {
    const parsed = base ? new URL(value, base) : new URL(value);
    return parsedHasUrlCredentials(parsed);
  } catch {
    return false;
  }
}

/**
 * Whether an optional URL is empty or parses without recognized credentials.
 * A nonempty parse failure is invalid, so consuming boundaries fail closed.
 */
export function isUrlCredentialFree(value: string, base?: string): boolean {
  if (!value.trim()) return true;
  try {
    const parsed = base ? new URL(value, base) : new URL(value);
    return !parsedHasUrlCredentials(parsed);
  } catch {
    return false;
  }
}

/**
 * Whether an optional HTTP(S) URL is empty or parses without recognized
 * credentials. SearXNG uses this predicate at each consuming boundary.
 */
export function isHttpUrlCredentialFree(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const parsed = new URL(value);
    return hasHttpProtocol(parsed) && !parsedHasUrlCredentials(parsed);
  } catch {
    return false;
  }
}

function removeRelativeUrlCredentials(
  value: string,
  queryNames: string[],
  fragmentNames: string[],
): string {
  const fragmentIndex = value.indexOf('#');
  const pathAndQuery = fragmentIndex >= 0 ? value.slice(0, fragmentIndex) : value;
  const hash = fragmentIndex >= 0 ? value.slice(fragmentIndex) : '';
  const queryIndex = pathAndQuery.indexOf('?');
  let sanitizedPathAndQuery = pathAndQuery;

  if (queryIndex >= 0 && queryNames.length > 0) {
    const searchParams = new URLSearchParams(pathAndQuery.slice(queryIndex + 1));
    for (const name of queryNames) searchParams.delete(name);
    const search = searchParams.toString();
    sanitizedPathAndQuery = `${pathAndQuery.slice(0, queryIndex)}${search ? `?${search}` : ''}`;
  }

  return `${sanitizedPathAndQuery}${removeFragmentCredentials(hash, fragmentNames)}`;
}

/**
 * Remove recognized URL credentials without changing input that passes the
 * rule. A base makes relative model-fetch paths parseable while their relative
 * form remains portable. A parse failure returns an empty portable value.
 */
export function removeUrlCredentials(value: string, base?: string): string {
  try {
    let isAbsolute = true;
    try {
      new URL(value);
    } catch {
      isAbsolute = false;
    }

    const parsed = base ? new URL(value, base) : new URL(value);
    const queryNames = credentialParameterNames(parsed.searchParams);
    const fragmentNames = credentialFragmentNames(parsed.hash);
    if (
      !parsed.username
      && !parsed.password
      && queryNames.length === 0
      && fragmentNames.length === 0
    ) return value;
    parsed.username = '';
    parsed.password = '';
    for (const name of queryNames) parsed.searchParams.delete(name);
    parsed.hash = removeFragmentCredentials(parsed.hash, fragmentNames);

    if (isAbsolute) return parsed.toString();
    if (value.startsWith('//')) {
      return `//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return removeRelativeUrlCredentials(value, queryNames, fragmentNames);
  } catch {
    return '';
  }
}

/** Remove recognized credentials from an HTTP(S) URL, or return an empty value. */
export function removeHttpUrlCredentials(value: string): string {
  try {
    if (!hasHttpProtocol(new URL(value))) return '';
    return removeUrlCredentials(value);
  } catch {
    return '';
  }
}
