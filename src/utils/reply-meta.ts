import type { ReplyEndpoint } from '../types';

/** Resolve the user-facing endpoint path from a server profile. */
export function endpointForProfile(apiVariant?: string, apiStyle?: string): ReplyEndpoint {
  if (apiVariant === 'lm-studio') return '/chat';
  if (apiVariant === 'anthropic') return '/messages';
  if (apiVariant === 'gemini') return '/interactions';
  return apiStyle === 'responses' ? '/responses' : '/chat/completions';
}

/**
 * Short tag for the API surface a reply came from, for the bubble's model
 * chip. The chip has room for a couple of characters next to the model name,
 * so the paths are abbreviated rather than spelled out — the popover under
 * the chip still names the full path.
 *
 * Uppercase labels are shared by settings, model pickers, and reply chips.
 * `O` covers unknown surfaces and replies persisted without an endpoint.
 */
export function endpointLetter(endpoint?: ReplyEndpoint): string {
  if (endpoint === '/responses') return 'R';
  if (endpoint === '/chat/completions') return 'CC';
  if (endpoint === '/messages') return 'M';
  if (endpoint === '/interactions') return 'I';
  if (endpoint === '/chat') return 'C';
  return 'O';
}

/** Shared protocol tone for picker choices, triggers, and historical replies. */
export function endpointTone(endpoint?: ReplyEndpoint): 'openai' | 'anthropic' | 'lmstudio' | 'gemini' | 'unknown' {
  if (endpoint === '/messages') return 'anthropic';
  if (endpoint === '/chat') return 'lmstudio';
  if (endpoint === '/interactions') return 'gemini';
  if (endpoint === '/responses' || endpoint === '/chat/completions') return 'openai';
  return 'unknown';
}
