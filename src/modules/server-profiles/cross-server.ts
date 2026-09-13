/**
 * Cross-server model list for the sub-agent model picker.
 *
 * Thin layer on top of the global model-store. No own change detection,
 * no own subscription — derives everything from `useAppModels`.
 */

import type { ServerProfile } from '../../types';
import { useAppModels, selectModelOwnerProfileId } from './model-store.ts';
import { useModelVisibility } from '../../store/modelVisibility.ts';

export interface CrossServerModelEntry {
  modelId: string;
  /** Display name from the API (falls back to modelId). */
  displayName: string;
  /** Which profile this model belongs to. */
  profileId: string;
  /** Profile display name for the dropdown label. */
  profileName: string;
  /** API variant label: "OpenAI", "Anthropic", or "REST". */
  apiVariant: string;
  /** API style for OpenAI: "chat" or "responses". */
  apiStyle: string;
  /** Capabilities from the persistent cache. */
  capabilities: { vision?: boolean; reasoning?: boolean; tools?: boolean };
}

/** Build cross-server picker list, optionally filtered by capability. */
export function crossServerModels(
  profiles: ReadonlyArray<Pick<ServerProfile, 'id' | 'active'>>,
  filter?: 'vision' | 'tools',
): CrossServerModelEntry[] {
  const all = useAppModels.getState().models;
  const crossIds = new Set(profiles.filter(p => p.active).map(p => p.id));
  const hidden = useModelVisibility.getState().hidden;
  const seen = new Set<string>();
  const entries: CrossServerModelEntry[] = [];

  for (const m of all) {
    if (!crossIds.has(m.profileId)) continue;
    const key = `${m.profileId}:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Skip hidden models.
    if (hidden.has(key)) continue;
    if (filter && !m.capabilities[filter]) continue;
    entries.push({
      modelId: m.id,
      displayName: m.displayName,
      profileId: m.profileId,
      profileName: m.profileName,
      apiVariant: m.apiVariant,
      apiStyle: m.apiStyle,
      capabilities: { ...m.capabilities },
    });
  }

  return entries.sort((a, b) =>
    a.profileName.localeCompare(b.profileName) || a.modelId.localeCompare(b.modelId),
  );
}

/**
 * Find the owning profile for a bare model ID (sub-agent routing).
 *
 * Resolved through the registry, which already holds records for cached
 * inactive profiles — so this no longer needs its own `modelCache` read to
 * cover the profiles the active projection leaves out.
 */
export function findModelOwner(modelId: string, profiles: ServerProfile[]): ServerProfile | undefined {
  const ownerId = selectModelOwnerProfileId(useAppModels.getState(), modelId, profiles);
  return ownerId ? profiles.find(p => p.id === ownerId) : undefined;
}
