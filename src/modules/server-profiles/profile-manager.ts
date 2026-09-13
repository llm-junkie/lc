/**
 * Profile manager — the single gatekeeper for all profile mutations.
 *
 * Every add/update/remove goes through this object. It handles side effects:
 * model-cache invalidation + background refresh, active-profile switching,
 * and connectivity testing.
 */

import { useProfileStore } from './profile-store.ts';
import { validateGeminiBaseUrl } from '../llm-client/adapters/gemini-rest.ts';
import { modelCache } from './model-cache.ts';
import { useAppModels } from './model-store.ts';
import {
  LLMClient,
  profileRequestHeaderSettings,
  resolveLcIdentifierHeader,
  resolveModelFetchUrl,
} from '../llm-client/index.ts';
import { syncSingleProfile, removeProfileFromCache } from './model-sync.ts';
import { uid } from '../../utils/uid.ts';
import type { ServerProfile } from '../../types';
import { deleteProfileCredentials, resolveProfileCredential } from '../../platform/chat-credential.ts';
import { keychainSet } from '../../platform/keychain.ts';
import { invalidateGenerationModelDetailConfiguration } from '../chat-pipeline/generation-model-detail-config.ts';
import {
  ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE,
  isAnyStreaming,
  isGenerationBlockingOperationActive,
  isGenerationBlockingOperationOwner,
  markGenerationBlockingOperation,
  unmarkGenerationBlockingOperation,
} from '../../store/conversations.ts';
import { useModelVisibility } from '../../store/modelVisibility.ts';
import { hasUrlCredentials } from '../../utils/url-credentials.ts';

export type ProfileHealth = 'healthy' | 'degraded' | 'offline' | 'unknown';

export type ConnectionResult =
  | { ok: true; latencyMs: number; modelCount: number }
  | { ok: false; error: string; errorCode: 'timeout' | 'refused' | 'dns' | 'auth' | 'unknown' };

interface ServerProfileDraft {
  baseUrl: string;
  modelFetchUrl?: string;
  name: string;
  apiKey?: string;
  apiVariant?: string;
  apiStyle?: string;
  apiKeyRef?: string;
  routing?: string;
  note?: string;
  active?: boolean;
  sse_read_timeout_min?: number;
  includeLcIdentifierHeader?: boolean;
  includeAdditionalRequestHeaders?: boolean;
  lcIdentifierHeader?: { name: string; value: string };
  requestHeaders?: Array<{ name: string; value: string }>;
}

const healthMap = new Map<string, ProfileHealth>();
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const PROFILE_MUTATION_STREAMING_MESSAGE =
  ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE;

/**
 * Server configuration is part of an active generation's execution context.
 * Keep every mutation behind one process-local gate so a settings call cannot
 * deactivate, retarget, or remove a profile halfway through a tool round.
 */
export function assertServerProfileMutationAllowed(operationId?: string): void {
  if (isAnyStreaming()) throw new Error(PROFILE_MUTATION_STREAMING_MESSAGE);
  if (!isGenerationBlockingOperationActive()) return;
  if (operationId && isGenerationBlockingOperationOwner(operationId, 'profile_mutation')) return;
  throw new Error(PROFILE_MUTATION_STREAMING_MESSAGE);
}

async function persistNewProfile(
  draft: ServerProfileDraft,
  operationId?: string,
  profileId = uid(),
): Promise<ServerProfile> {
  assertServerProfileMutationAllowed(operationId);
  const validation = profileManager.validateDraft(draft);
  if (validation.ok === false) throw new Error(validation.errors.join('; '));

  const profile: ServerProfile = {
    id: profileId,
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    modelFetchUrl: draft.modelFetchUrl?.trim() || undefined,
    apiKey: draft.apiKey,
    apiKeyRef: draft.apiKeyRef,
    apiVariant: draft.apiVariant as ServerProfile['apiVariant'],
    apiStyle: draft.apiStyle as ServerProfile['apiStyle'],
    routing: draft.routing as ServerProfile['routing'],
    note: draft.note,
    active: draft.active ?? true,
    sse_read_timeout_min: draft.sse_read_timeout_min ?? 5,
    ...profileRequestHeaderSettings(draft),
  };

  useProfileStore.getState().addProfile(profile);
  invalidateGenerationModelDetailConfiguration();

  // New profiles default to active: true, so they are active immediately.

  // Sync model cache in background.
  setTimeout(() => { syncSingleProfile(profile); }, 0);
  return profile;
}

export const profileManager = {
  /** Validate a draft before saving. */
  validateDraft(draft: {
    baseUrl: string; modelFetchUrl?: string; name: string; apiKey?: string;
    apiVariant?: string; routing?: string; note?: string; active?: boolean;
    includeLcIdentifierHeader?: boolean; includeAdditionalRequestHeaders?: boolean;
    lcIdentifierHeader?: { name: string; value: string };
    requestHeaders?: Array<{ name: string; value: string }>;
  }): { ok: true } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    if (!draft.name?.trim()) errors.push('Name is required');
    if (!draft.baseUrl?.trim()) errors.push('Base URL is required');
    else {
      try { new URL(draft.baseUrl.trim()); } catch { errors.push('Base URL must be a valid URL (e.g. http://localhost:1234)'); }
      if (hasUrlCredentials(draft.baseUrl.trim())) {
        errors.push('Base URL must not contain URL credentials; use the API key field');
      }
      if (draft.apiVariant === 'lm-studio' && !/\/api\/v\d+\/?$/i.test(draft.baseUrl.trim())) {
        errors.push('LM Studio native REST Base URL must end with /api/vN');
      }
      if (draft.apiVariant === 'gemini') {
        try { validateGeminiBaseUrl(draft.baseUrl.trim()); }
        catch (error) { errors.push(error instanceof Error ? error.message : 'Invalid Gemini Base URL'); }
      }
    }
    if (draft.modelFetchUrl?.trim() && draft.baseUrl?.trim()) {
      try {
        const resolved = resolveModelFetchUrl(draft.baseUrl, draft.modelFetchUrl);
        if (resolved && hasUrlCredentials(resolved)) {
          errors.push('Model fetching URL must not contain URL credentials');
        }
      } catch {
        errors.push('Model fetching URL must be an HTTP(S) URL or path');
      }
    }
    if (draft.includeLcIdentifierHeader) {
      const seen = new Set<string>();
      const identifier = resolveLcIdentifierHeader(draft);
      if (!HTTP_HEADER_NAME.test(identifier.name)) {
        errors.push('LC identifier header has an invalid name');
      }
      if (/\r|\n/.test(draft.lcIdentifierHeader?.value ?? identifier.value)) {
        errors.push('LC identifier header value cannot contain a line break');
      }
      seen.add(identifier.name.toLowerCase());

      for (const [index, row] of (
        draft.includeAdditionalRequestHeaders ? (draft.requestHeaders ?? []) : []
      ).entries()) {
        const name = row.name.trim();
        const value = row.value;
        if (!name && !value.trim()) continue;
        if (!name) {
          errors.push(`Request header ${index + 1} needs a name`);
          continue;
        }
        if (!HTTP_HEADER_NAME.test(name)) {
          errors.push(`Request header ${index + 1} has an invalid name`);
        }
        if (/\r|\n/.test(value)) {
          errors.push(`Request header ${index + 1} value cannot contain a line break`);
        }
        const lower = name.toLowerCase();
        if (seen.has(lower)) errors.push(`Request header "${name}" is duplicated`);
        seen.add(lower);
      }
    }
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
  },

  /** Test connectivity by listing models. This method adds no timeout. */
  async testConnection(profile: {
    baseUrl: string; modelFetchUrl?: string; apiKey?: string; apiKeyRef?: string;
    apiVariant?: string; routing?: string; includeLcIdentifierHeader?: boolean;
    includeAdditionalRequestHeaders?: boolean;
    lcIdentifierHeader?: { name: string; value: string };
    requestHeaders?: Array<{ name: string; value: string }>;
  }): Promise<ConnectionResult> {
    const start = performance.now();
    try {
      // Resolve API key: prefer keychain, fall back to plaintext.
      const apiKey = await resolveProfileCredential(profile);
      const client = new LLMClient({
        baseUrl: profile.baseUrl,
        modelFetchUrl: profile.modelFetchUrl,
        apiKey,
        apiVariant: profile.apiVariant,
        routing: profile.routing,
        ...profileRequestHeaderSettings(profile),
      });
      const models = await client.listModels();
      return { ok: true, latencyMs: Math.round(performance.now() - start), modelCount: models.length };
    } catch (err) {
      const msg = (err as Error).message.toLowerCase();
      const code =
        msg.includes('timeout') ? 'timeout' :
        msg.includes('refused') || msg.includes('econnrefused') ? 'refused' :
        msg.includes('enotfound') || msg.includes('dns') ? 'dns' :
        msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') ? 'auth' :
        'unknown';
      return { ok: false, error: (err as Error).message, errorCode: code };
    }
  },

  async addProfile(draft: ServerProfileDraft): Promise<ServerProfile> {
    return persistNewProfile(draft);
  },

  /**
   * Create a profile without persisting its plaintext credential before the
   * encrypted-store outcome is known. One application-wide lease owns both the
   * asynchronous encrypted write and the profile commit.
   */
  async addProfileWithCredential(
    draft: ServerProfileDraft,
    apiKey: string,
  ): Promise<{ profile: ServerProfile; stored: boolean }> {
    const validation = this.validateDraft({ ...draft, apiKey });
    if (validation.ok === false) throw new Error(validation.errors.join('; '));

    const operation = markGenerationBlockingOperation(
      'profile_mutation',
      'Add server profile credential',
    );
    try {
      const profileId = uid();
      const apiKeyRef = `profile.${profileId}`;
      const stored = await keychainSet(apiKeyRef, apiKey).then(() => true, () => false);
      const profile = await persistNewProfile({
        ...draft,
        apiKeyRef: stored ? apiKeyRef : undefined,
        apiKey: stored ? '' : apiKey,
      }, operation.operationId, profileId);
      return { profile, stored };
    } finally {
      unmarkGenerationBlockingOperation(operation.operationId);
    }
  },

  /**
   * Rotate a profile credential while holding the application-wide generation
   * boundary across the asynchronous encrypted-store write.
   */
  async updateProfileCredential(
    id: string,
    apiKey: string,
    patch: Partial<ServerProfile> = {},
  ): Promise<boolean> {
    const operation = markGenerationBlockingOperation(
      'profile_mutation',
      'Update server profile credential',
    );
    try {
      if (!useProfileStore.getState().profiles.some((profile) => profile.id === id)) {
        throw new Error('Server profile not found.');
      }
      const apiKeyRef = `profile.${id}`;
      const stored = await keychainSet(apiKeyRef, apiKey).then(() => true, () => false);
      await this.updateProfile(id, {
        ...patch,
        apiKeyRef: stored ? apiKeyRef : undefined,
        apiKey: stored ? '' : apiKey,
      }, operation.operationId);
      return stored;
    } finally {
      unmarkGenerationBlockingOperation(operation.operationId);
    }
  },

  async updateProfile(
    id: string,
    patch: Partial<ServerProfile>,
    operationId?: string,
  ): Promise<void> {
    assertServerProfileMutationAllowed(operationId);
    const previous = useProfileStore.getState().profiles.find((profile) => profile.id === id);
    useProfileStore.getState().updateProfile(id, patch);

    // Invalidate stale cache entry; auto-sync if connection details changed
    const changed =
      patch.baseUrl !== undefined ||
      'modelFetchUrl' in patch ||
      'apiKey' in patch ||
      'apiKeyRef' in patch ||
      patch.apiVariant !== undefined ||
      patch.routing !== undefined ||
      patch.includeLcIdentifierHeader !== undefined ||
      patch.lcIdentifierHeader !== undefined ||
      patch.includeAdditionalRequestHeaders !== undefined ||
      patch.requestHeaders !== undefined ||
      patch.active !== undefined;

    if (changed) {
      invalidateGenerationModelDetailConfiguration();
      modelCache.delete(id);
      const updated = useProfileStore.getState().profiles.find(p => p.id === id);
      if (updated) {
        setTimeout(() => { syncSingleProfile(updated); }, 0);
      }
    }

    useAppModels.getState().refresh();
    if (
      'apiKeyRef' in patch
      && previous?.apiKeyRef
      && previous.apiKeyRef !== patch.apiKeyRef
    ) {
      await deleteProfileCredentials([previous]);
    }
  },

  async removeProfile(id: string): Promise<void> {
    assertServerProfileMutationAllowed();
    const profile = useProfileStore.getState().profiles.find((candidate) => candidate.id === id);
    useAppModels.getState().resetProfileModelConfig(id);
    useModelVisibility.getState().clearForProfile(id);
    useProfileStore.getState().removeProfile(id);

    // Removing a profile naturally removes its models from the store on the
    // next refresh.

    setTimeout(() => { removeProfileFromCache(id); }, 0);
    // Drop the in-memory health entry too, so a removed profile's
    // connectivity state does not linger for the app lifetime.
    healthMap.delete(id);
    invalidateGenerationModelDetailConfiguration();
    useAppModels.getState().refresh();
    // Delete only after the synchronous mutation boundary admits and removes
    // the profile. A confirmation dialog can yield while a generation starts;
    // a rejected removal must never erase the credential from a live profile.
    if (profile?.apiKeyRef) await deleteProfileCredentials([profile]);
  },

  getHealth(profileId: string): ProfileHealth {
    return healthMap.get(profileId) ?? 'unknown';
  },

  async refreshAllHealth(): Promise<void> {
    const profiles = useProfileStore.getState().profiles;
    await Promise.all(profiles.map(async (p) => {
      const result = await this.testConnection(p);
      healthMap.set(p.id, result.ok ? 'healthy' : 'offline');
    }));
  },

  /** Subscribe to any profile change (returns unsubscribe fn). */
  onChange(cb: () => void): () => void {
    return useProfileStore.subscribe(cb);
  },
};
