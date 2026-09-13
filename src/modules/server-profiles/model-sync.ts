import type { ServerProfile } from '../../types';
import { resolveProfileCredential } from '../../platform/chat-credential.ts';
import { LLMClient, profileRequestHeaderSettings } from '../llm-client/index.ts';
import { modelCache } from './model-cache.ts';

/** Fetch and cache the current model list for one profile. */
export async function syncSingleProfile(
  profile: ServerProfile,
): Promise<Record<string, import('./model-cache.ts').CachedModel> | null> {
  try {
    const apiKey = await resolveProfileCredential(profile);
    const client = new LLMClient({
      baseUrl: profile.baseUrl,
      modelFetchUrl: profile.modelFetchUrl,
      apiKey,
      apiVariant: profile.apiVariant,
      apiStyle: profile.apiStyle,
      routing: profile.routing,
      ...profileRequestHeaderSettings(profile),
    });
    const list = await client.listModels();
    const raw = list.map((m) => ({
      id: m.id,
      display_name: m.display_name,
      max_context_length: m.max_context_length,
      capabilities: m.capabilities,
      source: m.source,
    }));
    await modelCache.set(profile.id, raw, profile);
    return modelCache.getCompatible(profile)?.models ?? null;
  } catch {
    return null;
  }
}

/** Remove a profile's cached model metadata. */
export function removeProfileFromCache(profileId: string): void {
  modelCache.delete(profileId);
  // The profile is gone for good: drop the in-memory write-version
  // bookkeeping too. Safe because versions come from a global sequence that
  // never reuses a number, so a stale write cannot collide with a new one.
  modelCache.prune(profileId);
}
