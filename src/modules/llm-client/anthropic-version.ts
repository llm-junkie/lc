/**
 * The `anthropic-version` header LC pins. Required on every request to
 * `api.anthropic.com`, model discovery included.
 *
 * This is a dated API contract with a closed history (`2023-01-01`,
 * `2023-06-01`) and no `latest` alias, so an unrecognized value is an error,
 * not a newer contract. Within a version Anthropic only adds; new models and
 * features arrive through model IDs and the `anthropic-beta` header instead.
 *
 * Leave it alone unless Anthropic publishes a new dated version *and* the
 * adapter's parsing has been verified against it.
 *
 * @see https://platform.claude.com/docs/en/api/versioning
 */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Whether a Base URL points at Anthropic's own API rather than at one of the
 * servers that merely speak the Anthropic-compatible wire format.
 *
 * Anything that is Anthropic's own requirement or opt-in — the version header,
 * `cache_control`, `thinking.display` — is keyed on this and sent to nobody
 * else, which keeps constraint 7 true.
 *
 * **Match the parsed hostname exactly, never the URL as a substring.** A
 * substring test returns true for every URL that merely *contains* the string:
 * `https://api.anthropic.com.evil.example/v1` (a different registrable domain)
 * and `https://proxy.test/api.anthropic.com/v1` (the name in a path segment)
 * both passed, and both would then be sent Anthropic-only fields — the exact
 * constraint-7 breakage this predicate exists to prevent. Profiles are
 * validated with `new URL()` before they reach here, so an unparseable value
 * is not a reachable Base URL; it reads as "not Anthropic" rather than
 * throwing. This matches `isOfficialOpenAIEndpoint` and `isMetaAIEndpoint`,
 * which already classify the hostname.
 */
export function isAnthropicOwnApi(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.anthropic.com';
  } catch {
    return false;
  }
}

/**
 * Whether the request needs `anthropic-version`. Anthropic rejects any request
 * that omits it — `/v1/models` and `/v1/messages` alike — and no compatible
 * server asks for it.
 */
export function requiresAnthropicVersion(baseUrl: string | undefined): boolean {
  return isAnthropicOwnApi(baseUrl);
}
