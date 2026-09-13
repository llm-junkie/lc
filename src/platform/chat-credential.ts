/**
 * Resolving a server profile's API key.
 *
 * This module is the normalized boundary for profile credential resolution.
 * Chat and non-chat callers share the same precedence and record separate,
 * bounded, value-free outcomes.
 */

import { keychainDelete, keychainGet } from './keychain.ts';
import { recordCredentialBootstrap } from './credential-diagnostics.ts';

/** The profile fields this resolution reads. Nothing else is touched. */
export interface ProfileCredentialSource {
  apiKeyRef?: string;
  apiKey?: string;
}

interface ProfileCredentialResolution {
  value: string;
  outcome?: 'loaded' | 'missing' | 'unavailable';
}

async function loadProfileCredential(
  profile: ProfileCredentialSource,
): Promise<ProfileCredentialResolution> {
  const ref = profile.apiKeyRef;
  if (!ref) return { value: profile.apiKey || '' };
  try {
    const stored = await keychainGet(ref);
    return {
      value: stored || profile.apiKey || '',
      outcome: stored ? 'loaded' : 'missing',
    };
  } catch {
    return { value: profile.apiKey || '', outcome: 'unavailable' };
  }
}

/** Prefer the encrypted store and use the documented plaintext fallback. */
export async function resolveProfileCredential(profile: ProfileCredentialSource): Promise<string> {
  const resolution = await loadProfileCredential(profile);
  if (resolution.outcome) recordCredentialBootstrap('profile', resolution.outcome);
  return resolution.value;
}

/** Delete each distinct encrypted profile credential. Failures remain diagnostic events. */
export async function deleteProfileCredentials(
  profiles: ReadonlyArray<ProfileCredentialSource>,
): Promise<void> {
  const refs = [...new Set(profiles.map((profile) => profile.apiKeyRef).filter((ref): ref is string => !!ref))];
  await Promise.allSettled(refs.map((ref) => keychainDelete(ref)));
}

/**
 * The key to send with a generation request.
 *
 * A profile with no keychain reference records nothing: no bootstrap happened,
 * and many local servers legitimately need no key at all. When a reference does
 * exist, its outcome is recorded as a closed code — the value never is.
 */
export async function resolveChatCredential(profile: ProfileCredentialSource): Promise<string> {
  const resolution = await loadProfileCredential(profile);
  if (resolution.outcome) recordCredentialBootstrap('chat', resolution.outcome);
  return resolution.value;
}
