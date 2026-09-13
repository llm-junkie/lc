/**
 * Small, pure helpers for persisted tool grants.
 *
 * Exposure toggles are intentionally absent: changing exposure must never
 * mutate a grant. These helpers only update the two authoritative grant
 * stores described by TOOL-POLICY-MODEL.md.
 */

import { FILE_IO_NAMES, WEB_ACCESS_NAMES } from './registry-names.ts';
import { normalizePathForMatch } from './clean-path.ts';

export interface GrantStateConfig {
  tool_grants?: string[];
  web_access_grants_initialized?: boolean;
  allowed_roots?: string[];
  dir_permissions?: Record<string, string[]>;
}

export type NormalizedGrantState<T extends GrantStateConfig> = T & {
  tool_grants: string[];
  allowed_roots: string[];
  dir_permissions: Record<string, string[]>;
};

/** Normalize the persisted, authoritative grant state in one place. */
export function normalizeGrantState<T extends GrantStateConfig>(config: T): NormalizedGrantState<T> {
  const allowedRoots = Array.from(new Set(
    (config.allowed_roots ?? [])
      .map(normalizePathForMatch)
      .filter(Boolean),
  ));
  const allowedRootSet = new Set(allowedRoots);
  const fileToolNames = new Set<string>(FILE_IO_NAMES);
  const dirPermissions: Record<string, string[]> = {};

  for (const [rawRoot, rawTools] of Object.entries(config.dir_permissions ?? {})) {
    const root = normalizePathForMatch(rawRoot);
    if (!root || !allowedRootSet.has(root)) continue;
    const tools = new Set(dirPermissions[root] ?? []);
    for (const toolName of rawTools ?? []) {
      if (fileToolNames.has(toolName)) tools.add(toolName);
    }
    dirPermissions[root] = Array.from(tools);
  }

  const webAccessGrants = Array.from(new Set(
    (config.tool_grants ?? []).filter((name) =>
      WEB_ACCESS_NAMES.includes(name as typeof WEB_ACCESS_NAMES[number])),
  ));

  return {
    ...config,
    tool_grants: webAccessGrants,
    web_access_grants_initialized: config.web_access_grants_initialized,
    allowed_roots: allowedRoots,
    dir_permissions: dirPermissions,
  };
}

/** Read the persisted Web Access grants, filtered to known names. */
export function readToolGrants(
  config: Pick<GrantStateConfig, 'tool_grants'>,
  allowedNames: readonly string[],
): ReadonlySet<string> {
  const allowed = new Set(allowedNames);
  return new Set((config.tool_grants ?? []).filter((name) => allowed.has(name)));
}

/** Add one conversation-scoped Web Access grant without touching other state. */
export function grantTool<T extends GrantStateConfig>(
  config: T,
  toolName: string,
): NormalizedGrantState<T> {
  const normalized = normalizeGrantState(config);
  const grants = new Set(normalized.tool_grants ?? []);
  grants.add(toolName);
  return {
    ...normalized,
    tool_grants: Array.from(grants),
    web_access_grants_initialized: true,
  };
}

/** Apply the Web Access defaults exactly once. */
export function initializeWebAccessGrantDefaults<T extends GrantStateConfig>(
  config: T & { web_access_grants_initialized: boolean },
  toolNames: readonly string[],
): T {
  if (config.web_access_grants_initialized === true) return config;

  // The current default config starts with marker=false and an empty array.
  // That state means first activation is still pending, so apply the defaults.
  return {
    ...config,
    tool_grants: Array.from(new Set(toolNames)),
    web_access_grants_initialized: true,
  };
}

/**
 * Add one file-tool grant to exactly the supplied canonical roots.
 * Empty root lists are a no-op and never broaden to all configured roots.
 * Popup approval grants only the requested tool. The seven read-only defaults
 * belong exclusively to explicit Workspace root creation; a tool call must
 * never gain unrelated grants as a side effect of its popup. Adding a child
 * root remains additive and does not shadow effective ancestor grants.
 */
export function grantToolOnRoots<T extends GrantStateConfig>(
  config: T,
  toolName: string,
  canonicalRoots: readonly string[],
): NormalizedGrantState<T> {
  const normalized = normalizeGrantState(config);
  const selected = Array.from(new Set(canonicalRoots.map(normalizePathForMatch).filter(Boolean)));
  if (selected.length === 0) return normalized;

  const roots = new Set(normalized.allowed_roots ?? []);
  const permissions = { ...(normalized.dir_permissions ?? {}) };
  for (const root of selected) {
    roots.add(root);
    const tools = new Set(permissions[root] ?? []);
    tools.add(toolName);
    permissions[root] = Array.from(tools);
  }

  return {
    ...normalized,
    allowed_roots: Array.from(roots),
    dir_permissions: permissions,
  };
}

/** A file batch may run only when the modal approved every missing scope. */
export function approvedScopesCoverRequired(
  requiredScopes: readonly string[],
  approvedScopes: readonly string[],
): boolean {
  if (requiredScopes.length === 0) return true;
  const approved = new Set(approvedScopes.filter(Boolean));
  return requiredScopes.every((scope) => approved.has(scope));
}
