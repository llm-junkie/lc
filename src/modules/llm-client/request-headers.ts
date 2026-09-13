import type { ProfileRequestHeaderSettings } from '../../types';
import { LC_VERSION } from '../../app-metadata.ts';

/** LC owns only its own generic HTTP identity. Provider-specific headers are
 *  profile data supplied by the user. */
export const LC_IDENTIFIER_HEADER_NAME = 'User-Agent';
export const LC_IDENTIFIER_HEADER_VALUE = `LC/${LC_VERSION}`;

/** Copy just the request-header settings from any profile-shaped object. */
export function profileRequestHeaderSettings(
  profile: ProfileRequestHeaderSettings,
): ProfileRequestHeaderSettings {
  return {
    includeLcIdentifierHeader: profile.includeLcIdentifierHeader === true,
    lcIdentifierHeader: profile.lcIdentifierHeader
      ? { ...profile.lcIdentifierHeader }
      : undefined,
    includeAdditionalRequestHeaders: profile.includeAdditionalRequestHeaders === true,
    requestHeaders: profile.requestHeaders?.map((header) => ({ ...header })) ?? [],
  };
}

/** Resolve blank profile overrides back to LC's stable defaults. */
export function resolveLcIdentifierHeader(
  settings: ProfileRequestHeaderSettings,
): { name: string; value: string } {
  return {
    name: settings.lcIdentifierHeader?.name.trim() || LC_IDENTIFIER_HEADER_NAME,
    value: settings.lcIdentifierHeader?.value.trim() || LC_IDENTIFIER_HEADER_VALUE,
  };
}

function setCaseInsensitive(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  const lower = name.toLowerCase();
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === lower);
  if (existing && existing !== name) delete headers[existing];
  headers[name] = value;
}

/** Apply the progressive profile settings to protocol-owned base headers.
 *  Additional rows are deliberately gated by both toggles. */
export function withProfileRequestHeaders(
  base: Record<string, string>,
  settings: ProfileRequestHeaderSettings,
): Record<string, string> {
  const headers = { ...base };
  if (settings.includeLcIdentifierHeader !== true) return headers;

  const identifier = resolveLcIdentifierHeader(settings);
  setCaseInsensitive(headers, identifier.name, identifier.value);
  if (settings.includeAdditionalRequestHeaders !== true) return headers;

  for (const row of settings.requestHeaders ?? []) {
    const name = row.name.trim();
    if (!name) continue;
    setCaseInsensitive(headers, name, row.value.trim());
  }
  return headers;
}
