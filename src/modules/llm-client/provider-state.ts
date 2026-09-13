/**
 * Provider-state provenance checks shared by request assembly and adapters.
 * Opaque continuation state must remain inside its verified provider boundary.
 * Tool History may rebuild the paired tool call, but the provider-native
 * reasoning block remains unchanged and is still replayed. A verified
 * provider contract can delegate same-provider model-switch filtering to the
 * provider; an unmatched compatible relay retains the exact-model guard.
 */

import type { AnthropicReplayOrigin } from './types';

function normalizedBaseUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Keep provider-returned continuation state inside its source endpoint. A
 * verified surface may let the provider decide model-switch compatibility;
 * an unlisted surface must remain on the exact source model.
 */
export function canReplayProviderOutputState(options: {
  origin?: AnthropicReplayOrigin;
  targetBaseUrl?: string;
  targetModel: string;
  allowModelSwitch?: boolean;
}): boolean {
  if (!options.origin) return false;
  const source = normalizedBaseUrl(options.origin.baseUrl);
  const target = normalizedBaseUrl(options.targetBaseUrl);
  return source !== undefined
    && target !== undefined
    && source === target
    && (options.allowModelSwitch === true || options.origin.model === options.targetModel);
}

export function canReplayAnthropicOutputBlocks(options: {
  origin?: AnthropicReplayOrigin;
  targetBaseUrl?: string;
  targetModel: string;
  /**
   * @deprecated Ignored and retained only for source compatibility. Tool
   * History changes tool-call history, never provider-state provenance.
   */
  toolCallRewritten?: boolean;
  /** Verified surface contract says the provider owns cross-model filtering. */
  allowModelSwitch?: boolean;
}): boolean {
  return canReplayProviderOutputState(options);
}
