import { resolveProfileCredential } from '../../platform/chat-credential.ts';
import {
  getLocalNativeModelBaseUrl,
  LMStudioNative,
  profileRequestHeaderSettings,
} from '../llm-client/index.ts';
import type { ProfileRequestHeaderSettings } from '../../types';
import { useAppModels, selectModelOwnerProfileId } from './model-store.ts';
import { useProfileStore } from './profile-store.ts';

export interface ResolvedModelServer extends ProfileRequestHeaderSettings {
  profileId: string;
  modelId: string;
  baseUrl: string;
  modelFetchUrl?: string;
  apiKey: string;
  apiKeyRef?: string;
  apiVariant: string;
  apiStyle: 'chat' | 'responses';
  routing: 'proxy' | 'direct';
}

/** Resolve a model reference to its active owning server profile. */
export function resolveModelServer(ref: string): ResolvedModelServer | null {
  const doubleColon = ref.indexOf('::');
  let modelId: string;
  let profileId: string | undefined;

  if (doubleColon !== -1) {
    // A packed reference names its profile outright — never guess from the
    // model ID when the caller already told us which profile it meant.
    profileId = ref.slice(0, doubleColon);
    modelId = ref.slice(doubleColon + 2);
  } else {
    // Legacy bare ID. The registry answers this: its records cover cached
    // inactive profiles too, which is what the old direct `modelCache` scan
    // was there for, and it walks profiles in the same stored order so the
    // resolution stays deterministic.
    modelId = ref;
    profileId = selectModelOwnerProfileId(
      useAppModels.getState(),
      ref,
      useProfileStore.getState().profiles,
    );
  }

  if (!profileId) return null;
  const profile = useProfileStore.getState().profiles.find((p) => p.id === profileId);
  if (!profile || !profile.active) return null;

  return {
    profileId,
    modelId,
    baseUrl: profile.baseUrl,
    modelFetchUrl: profile.modelFetchUrl,
    apiKey: profile.apiKey ?? '',
    apiKeyRef: profile.apiKeyRef,
    apiVariant: profile.apiVariant ?? 'openai',
    apiStyle: profile.apiStyle ?? 'chat',
    routing: profile.routing ?? 'proxy',
    ...profileRequestHeaderSettings(profile),
  };
}

/** Resolve a selected model reference and load its keychain secret when needed. */
export async function resolveModelServerAuth(ref: string): Promise<ResolvedModelServer | null> {
  const resolved = resolveModelServer(ref);
  if (!resolved) return null;
  const apiKey = await resolveProfileCredential(resolved);
  return apiKey === resolved.apiKey ? resolved : { ...resolved, apiKey };
}

/** Build the native model-management client with the owning profile's key. */
export async function createLMStudioModelClient(
  ref: string,
  fetchImpl?: typeof fetch,
): Promise<LMStudioNative | null> {
  const resolved = await resolveModelServerAuth(ref);
  if (!resolved) return null;
  return new LMStudioNative({
    baseUrl: getLocalNativeModelBaseUrl(resolved.baseUrl),
    apiKey: resolved.apiKey,
    routing: resolved.routing,
    fetchImpl,
    ...profileRequestHeaderSettings(resolved),
  });
}
