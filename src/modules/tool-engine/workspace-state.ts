import { initializeWebAccessGrantDefaults, type GrantStateConfig } from './grant-state.ts';

/** Minimal persisted shape needed by Workspace activation transitions. */
export interface WorkspaceStateConfig extends GrantStateConfig {
  enabled: boolean;
  web_access_grants_initialized: boolean;
  file_io_enabled?: boolean;
  web_access_enabled?: boolean;
  tool_history_enabled?: boolean;
  skills_enabled?: boolean;
  whiteboard_enabled?: boolean;
  skills_initialized?: boolean;
  enabled_skill_ids?: string[];
}

/**
 * Apply the Workspace master transition without touching unrelated category
 * toggles or presentation state. Activation restores the documented File I/O,
 * Tool History, and Whiteboard defaults. Web Access remains an explicit user
 * choice. Deactivation changes only the master.
 */
export function setWorkspaceEnabled<T extends WorkspaceStateConfig>(
  config: T,
  enabled: boolean,
): T {
  const next = { ...config, enabled };
  if (!enabled) return next;
  return {
    ...next,
    file_io_enabled: true,
    tool_history_enabled: true,
    whiteboard_enabled: true,
  };
}

/** Apply the Web Access transition and its one-time grant defaults. */
export function setWebAccessEnabled<T extends WorkspaceStateConfig>(
  config: T,
  enabled: boolean,
  webAccessToolNames: readonly string[],
): T {
  const next = { ...config, web_access_enabled: enabled };
  return enabled
    ? initializeWebAccessGrantDefaults(next, webAccessToolNames)
    : next;
}

/** Apply the default skill selections only on the first direct Skills activation. */
export function setSkillsEnabled<T extends WorkspaceStateConfig>(
  config: T,
  enabled: boolean,
  defaultSkillIds: readonly string[],
): T {
  const next = { ...config, skills_enabled: enabled };
  if (!enabled || config.skills_initialized !== false) return next;
  return {
    ...next,
    skills_initialized: true,
    enabled_skill_ids: Array.from(new Set([
      ...(config.enabled_skill_ids ?? []),
      ...defaultSkillIds,
    ])),
  };
}
