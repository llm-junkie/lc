/**
 * Phase 1.1 — Category Exposure Resolver
 * Phase 1.2 — Dynamic Call Authorization Resolver
 *
 * Pure, side-effect-free functions for LC's tool policy layer.
 * These are the single source of truth for which tools are exposed
 * to the model on the wire, and whether an exposed tool call
 * requires a permission popup.
 *
 * Key principle: Exposure and grant are SEPARATE, AUTHORITATIVE concepts.
 * Workspace enables the foundation tools. Category toggles add optional
 * tools while Workspace is enabled.
 * Checkmarks and directory permissions decide whether an exposed call
 * runs silently or requires a popup.
 *
 * Normative companion: docs/tools/TOOL-POLICY-MODEL.md
 */

import type { ToolHandler } from './types';
import {
  BUILTIN_TOOLS,
  FILE_IO_NAMES,
  FOUNDATION_NAMES,
  WEB_ACCESS_NAMES,
  OPERATIONAL_TOOL_NAMES,
  SKILLS_NAMES,
  WHITEBOARD_NAMES,
} from './registry.ts';
import {
  FILE_IO_MUTATING_NAMES as FILE_IO_MUTATING_TOOL_NAMES,
  FILE_IO_READ_ONLY_NAMES as FILE_IO_READ_ONLY_TOOL_NAMES,
} from './registry-names.ts';
import { normalizeGrantState, readToolGrants } from './grant-state.ts';
import { normalizePathForMatch, parentDirectory } from './clean-path.ts';

export { normalizePathForMatch } from './clean-path.ts';

// ═══════════════════════════════════════════════════════════════════
// 0. Canonical Constants
// ═══════════════════════════════════════════════════════════════════

/**
 * Canonical tool category type.
 * Derived from TOOL-POLICY-MODEL.md §3.
 */
export type ToolCategory = 'foundation' | 'file_io' | 'shell' | 'web_access' | 'tool_help' | 'tool_history' | 'skills' | 'whiteboard';

/**
 * The 7 read-only File I/O tools — auto-granted when a directory is added.
 * Per policy model §6.4. This is the single canonical source.
 */
export const FILE_IO_READ_ONLY_NAMES: ReadonlySet<string> = new Set(FILE_IO_READ_ONLY_TOOL_NAMES);

/**
 * The 3 mutating File I/O tools — never auto-granted.
 * Per policy model §6.4.
 */
export const FILE_IO_MUTATING_NAMES: ReadonlySet<string> = new Set(FILE_IO_MUTATING_TOOL_NAMES);

/** All built-in tool names. */
export const ALL_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...FOUNDATION_NAMES,
  ...FILE_IO_NAMES,
  ...WEB_ACCESS_NAMES,
  ...WHITEBOARD_NAMES,
  'lc_run_shell',
  'lc_tool_help',
  'lc_tool_history',
  ...SKILLS_NAMES,
]);

/** Look up a tool's category. Returns undefined for unknown tools. */
export function categoryOf(name: string): ToolCategory | undefined {
  if ((FOUNDATION_NAMES as readonly string[]).includes(name)) return 'foundation';
  if ((FILE_IO_NAMES as readonly string[]).includes(name)) return 'file_io';
  if ((WEB_ACCESS_NAMES as readonly string[]).includes(name)) return 'web_access';
  if (name === 'lc_run_shell') return 'shell';
  if (name === 'lc_tool_help') return 'tool_help';
  if (name === 'lc_tool_history') return 'tool_history';
  if ((SKILLS_NAMES as readonly string[]).includes(name)) return 'skills';
  if ((WHITEBOARD_NAMES as readonly string[]).includes(name)) return 'whiteboard';
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════
// 1. Canonical tool policy metadata
// ═══════════════════════════════════════════════════════════════════

/** Grant scope for authorization. */
export type GrantScope = 'none' | 'conversation_tool' | 'directory_tool';

/** Popup policy for an exposed tool. */
export type PromptPolicy = 'grant_or_prompt' | 'always_prompt' | 'no_prompt';

/** Classification of each tool's observable effects. */
export type Mutability = 'read_only' | 'mutating' | 'external_effect' | 'conversation_state';

/**
 * Declarative policy metadata for every built-in tool.
 * Declarative policy metadata is the sole source for category, grant scope,
 * and prompt behavior; handlers do not carry a second permission flag.
 *
 * Per TOOL-POLICY-MODEL.md §4.4 — this is the single source.
 */
export interface ToolPolicyMetadata {
  name: string;
  category: ToolCategory;
  grantScope: GrantScope;
  promptPolicy: PromptPolicy;
  /** True when this tool should be auto-granted on directory add. */
  defaultGrantOnRootAdd?: boolean;
  mutability?: Mutability;
}

/**
 * Canonical policy metadata for all built-in tools.
 * Generated from the category membership lists — no duplication.
 */
export const TOOL_POLICY: ReadonlyMap<string, ToolPolicyMetadata> = (() => {
  const map = new Map<string, ToolPolicyMetadata>();

  for (const name of FOUNDATION_NAMES) {
    map.set(name, {
      name,
      category: 'foundation',
      grantScope: 'none',
      promptPolicy: 'no_prompt',
      defaultGrantOnRootAdd: false,
      mutability: name === 'lc_get_current_time' ? 'read_only' : 'conversation_state',
    });
  }

  for (const name of FILE_IO_NAMES) {
    const isReadOnly = FILE_IO_READ_ONLY_NAMES.has(name);
    map.set(name, {
      name,
      category: 'file_io',
      grantScope: 'directory_tool',
      promptPolicy: 'grant_or_prompt',
      defaultGrantOnRootAdd: isReadOnly,
      mutability: isReadOnly ? 'read_only' : 'mutating',
    });
  }

  for (const name of WEB_ACCESS_NAMES) {
    map.set(name, {
      name,
      category: 'web_access',
      grantScope: 'conversation_tool',
      promptPolicy: 'grant_or_prompt',
      defaultGrantOnRootAdd: false,
      mutability: 'external_effect',
    });
  }

  map.set('lc_run_shell', {
    name: 'lc_run_shell',
    category: 'shell',
    grantScope: 'none',
    promptPolicy: 'always_prompt',
    defaultGrantOnRootAdd: false,
    mutability: 'external_effect',
  });

  map.set('lc_tool_help', {
    name: 'lc_tool_help',
    category: 'tool_help',
    grantScope: 'none',
    promptPolicy: 'no_prompt',
    defaultGrantOnRootAdd: false,
    mutability: 'read_only',
  });

  map.set('lc_tool_history', {
    name: 'lc_tool_history',
    category: 'tool_history',
    grantScope: 'none',
    promptPolicy: 'no_prompt',
    defaultGrantOnRootAdd: false,
    mutability: 'read_only',
  });

  for (const name of SKILLS_NAMES) {
    map.set(name, {
      name,
      category: 'skills',
      grantScope: 'none',
      promptPolicy: 'no_prompt',
      defaultGrantOnRootAdd: false,
      mutability: 'read_only',
    });
  }

  for (const name of WHITEBOARD_NAMES) {
    map.set(name, {
      name,
      category: 'whiteboard',
      grantScope: 'none',
      promptPolicy: 'no_prompt',
      defaultGrantOnRootAdd: false,
      mutability: 'conversation_state',
    });
  }

  return map;
})();

// ═══════════════════════════════════════════════════════════════════
// 2. Persisted Tools Config — the input to the resolver
// ═══════════════════════════════════════════════════════════════════

/**
 * The subset of conversation.tools needed by the exposure resolver.
 * Accepts the full persisted shape and partial snapshots so the resolver
 * can also be used by focused policy tests and pre-persistence UI state.
 */
export interface PersistedToolsConfig {
  /** Workspace master toggle. Off → no tools exposed. */
  enabled?: boolean;
  /** Category sub-toggles. */
  file_io_enabled?: boolean;
  shell_enabled?: boolean;
  web_access_enabled?: boolean;
  tool_history_enabled?: boolean;
  skills_enabled?: boolean;
  whiteboard_enabled?: boolean;
  /** This field stores conversation-scoped Web Access pre-grants. */
  tool_grants?: string[];
  /** File I/O directory-level grants. Each root/tool grant covers descendants. */
  dir_permissions?: Record<string, string[]>;
  /** Allowed roots. */
  allowed_roots?: string[];
}

// ═══════════════════════════════════════════════════════════════════
// 3. Exposure Resolver (Phase 1.1)
// ═══════════════════════════════════════════════════════════════════

/**
 * An immutable snapshot of which tools are currently exposed to the model.
 *
 * This is the single source of truth for wire materialization,
 * system prompts, token estimation, execution admission, and
 * tool-history stubs. Every consumer imports the same function
 * and gets the same answer.
 */
export interface ExposureSnapshot {
  /** Master toggle state. */
  workspaceEnabled: boolean;
  /** Complete set of tool names currently on the wire.
   *  Determined only by Workspace, foundation membership, and category toggles.
   *  Checkmarks and dir_permissions do NOT
   *  affect this set. */
  exposedNames: ReadonlySet<string>;
  /** Lookup from tool name to its category. */
  categoryByTool: ReadonlyMap<string, ToolCategory>;
  /** Convenience: exposed tool handlers ready for materialize(). */
  exposedHandlers: readonly ToolHandler[];
}

/** Sentinel empty exposure snapshot — shared, immutable. */
const EMPTY_EXPOSURE: ExposureSnapshot = Object.freeze({
  workspaceEnabled: false,
  exposedNames: new Set<string>(),
  categoryByTool: new Map<string, ToolCategory>(),
  exposedHandlers: Object.freeze([]) as readonly ToolHandler[],
});

/**
 * Resolve which tools are exposed to the model.
 *
 * This is PURE and SYNCHRONOUS. It reads Workspace and category toggles
 * from the persisted config. Checkmarks, dir_permissions, and
 * grant state is deliberately ignored.
 *
 * Rules (per TOOL-POLICY-MODEL.md §4):
 *   1. Workspace OFF → exposed set is empty.
 *   2. Workspace ON + category toggle ON → expose every canonical
 *      tool in that category.
 *   3. Checkmarks never change the wire-visible set.
 *
 * @param config — The conversation's tools config (or a partial snapshot).
 * @returns An immutable ExposureSnapshot.
 */
export function resolveExposure(config: PersistedToolsConfig): ExposureSnapshot {
  // Rule 1: Workspace off → nothing exposed.
  if (!config.enabled) {
    return EMPTY_EXPOSURE;
  }

  const names = new Set<string>();
  const categoryMap = new Map<string, ToolCategory>();

  for (const name of FOUNDATION_NAMES) {
    names.add(name);
    categoryMap.set(name, 'foundation');
  }

  // Rule 2: Each active category toggle exposes its complete list.
  if (config.file_io_enabled) {
    for (const n of FILE_IO_NAMES) {
      names.add(n);
      categoryMap.set(n, 'file_io');
    }
  }
  if (config.shell_enabled) {
    names.add('lc_run_shell');
    categoryMap.set('lc_run_shell', 'shell');
  }
  if (config.web_access_enabled) {
    for (const n of WEB_ACCESS_NAMES) {
      names.add(n);
      categoryMap.set(n, 'web_access');
    }
  }
  if (config.tool_history_enabled) {
    names.add('lc_tool_history');
    categoryMap.set('lc_tool_history', 'tool_history');
  }
  if (config.skills_enabled) {
    for (const n of SKILLS_NAMES) {
      names.add(n);
      categoryMap.set(n, 'skills');
    }
  }
  if (config.whiteboard_enabled) {
    for (const n of WHITEBOARD_NAMES) {
      names.add(n);
      categoryMap.set(n, 'whiteboard');
    }
  }

  if (OPERATIONAL_TOOL_NAMES.some((name) => names.has(name))) {
    names.add('lc_tool_help');
    categoryMap.set('lc_tool_help', 'tool_help');
  }

  // Category membership controls inclusion; the full registry controls the
  // materialized tool order for every consumer of this snapshot.
  const handlers: ToolHandler[] = BUILTIN_TOOLS.filter((handler) => names.has(handler.name));

  return Object.freeze({
    workspaceEnabled: true,
    exposedNames: Object.freeze(new Set(names)) as ReadonlySet<string>,
    categoryByTool: Object.freeze(new Map(categoryMap)) as ReadonlyMap<string, ToolCategory>,
    exposedHandlers: Object.freeze(handlers) as readonly ToolHandler[],
  });
}

/**
 * Quick check: is a specific tool name currently exposed?
 * Convenience wrapper around resolveExposure().
 */
export function isExposed(config: PersistedToolsConfig, toolName: string): boolean {
  return resolveExposure(config).exposedNames.has(toolName);
}

// ═══════════════════════════════════════════════════════════════════
// 4. Authorization Resolver (Phase 1.2)
// ═══════════════════════════════════════════════════════════════════

/**
 * Authorization decision states.
 * Per TOOL-POLICY-MODEL.md §5.1.
 *
 *   - 'not_exposed'   — Workspace/category is off; reject call.
 *   - 'prompt'        — Exposed but missing visible grant; show popup.
 *   - 'pregranted'    — Exposed and matching checkmark exists; skip popup.
 *   - 'always_prompt' — Shell invocation; popup every call.
 *   - 'no_prompt'     — Tool History; execute directly.
 */
export type AuthorizationState =
  | 'not_exposed'
  | 'prompt'
  | 'pregranted'
  | 'always_prompt'
  | 'no_prompt';

/**
 * Structured policy error codes.
 * Per TOOL-POLICY-MODEL.md §5.4.
 */
export type PolicyErrorCode =
  | 'unknown_tool'
  | 'not_exposed'
  | 'invalid_arguments'
  | 'path_outside_roots'
  | 'grant_required'
  | 'permission_ui_unavailable'
  | 'denied_by_user';

/** A structured policy issue. */
export interface StructuredIssue {
  code: PolicyErrorCode;
  message: string;
  /** Affected path(s), for file tools. */
  paths?: string[];
}

/**
 * The result of authorizing a tool call.
 * Pure: does not mutate any state.
 */
export interface AuthorizationDecision {
  /** Whether the call may proceed (with or without a popup). */
  allowed: boolean;
  /** The authorization state. */
  state: AuthorizationState;
  /** The policy metadata for this tool. */
  policy: ToolPolicyMetadata;
  /** When state is 'prompt' or 'always_prompt': the scope(s) the
   *  user must grant. */
  missingScopes?: readonly GrantScope[];
  /** When state is 'prompt' for file tools: the canonical directories
   *  that lack a grant. */
  ungrantedDirs?: readonly string[];
  /** When allowed=true for file tools: the matching canonical roots. */
  matchedRoots?: readonly string[];
  /** Structured issues for denied calls. */
  issues?: readonly StructuredIssue[];
}

/**
 * Snapshot of current grant state needed for authorization.
 *
 * Extracted from the persisted conversation config at authorization
 * time. Immutable — the resolver does not mutate it.
 */
export interface GrantSnapshot {
  /** These are conversation-scoped Web Access tool grants.
   *  The UI shows these grants as checkmarks.
   *  This is the sole persisted authority for those checkmarks. */
  toolGrants: ReadonlySet<string>;
  /** Per-directory File I/O tool grants.
   *  Key: canonical root path. Value: set of tool names pre-granted
   *  for that root and its descendants. Overlapping roots are additive. */
  dirPermissions: ReadonlyMap<string, ReadonlySet<string>>;
  /** Allowed filesystem roots (canonical). */
  allowedRoots: readonly string[];
}

/**
 * Build a GrantSnapshot from persisted conversation tool config.
 *
 * Phase 1.3: reads canonical `tool_grants` and normalizes directory keys
 * and tool names for safe lookup.
 *
 * Never includes shell or tool_history in the grant set.
 * Shell has no persistent grant; Tool History needs none.
 *
 * @param config — The conversation's tools config.
 * @returns An immutable GrantSnapshot.
 */
export function buildGrantSnapshot(config: PersistedToolsConfig): GrantSnapshot {
  const normalized = normalizeGrantState(config);
  const toolGrants = readToolGrants(normalized, WEB_ACCESS_NAMES);

  const dirPerms = new Map<string, ReadonlySet<string>>();
  if (normalized.dir_permissions) {
    for (const [rawRoot, tools] of Object.entries(normalized.dir_permissions)) {
      const root = canonicalizeRootPath(rawRoot);
      if (root) {
        dirPerms.set(root, new Set(tools));
      }
    }
  }

  const roots = (normalized.allowed_roots ?? [])
    .map((r) => canonicalizeRootPath(r))
    .filter((r): r is string => r !== null);

  return {
    toolGrants,
    dirPermissions: dirPerms,
    allowedRoots: roots,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 4a. Path Canonicalization Helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute a prompt-deduplication key for a tool call.
 *
 * Within one tool batch, same-key non-shell calls queue in arrival order.
 * They can share a persistent approval or fail-closed decision.
 * An allow_once result
 * authorizes only its displayed call; each sibling needs a fresh popup.
 * Shell calls always get a unique key (never deduplicated).
 *
 * - Web Access tools use the tool name as the key (conversation-scoped grant).
 * - File tools: key is `toolName::sortedDirs` (directory-scoped grant).
 * - Shell: key includes the call ID (always unique).
 * - Tool History: never needs a popup.
 * - Unknown tools: key includes the call ID (always unique).
 */
export function promptDedupeKey(
  toolName: string,
  callId: string,
  dirs?: string[],
): string {
  // Shell: every invocation is unique — never deduplicate.
  if (toolName === 'lc_run_shell') {
    return `shell::${callId}`;
  }

  // Tool History: never prompts.
  if (toolName === 'lc_tool_history') {
    return `tool_history::${callId}`;
  }

  const cat = categoryOf(toolName);

  // Web Access tools use a conversation-scoped grant.
  if (cat === 'web_access') {
    return `net::${toolName}`;
  }

  // File tools: directory-scoped grant.
  if (cat === 'file_io' && dirs && dirs.length > 0) {
    const sorted = [...dirs].sort();
    return `file::${toolName}::${sorted.join('|')}`;
  }

  // Fallback: unique per call (no dedup).
  return `unknown::${callId}`;
}

/**
 * Normalise a root path (directory) for grant matching.
 * Same as normalizePathForMatch but always ensures it's treated
 * as a directory prefix.
 */
function canonicalizeRootPath(p: string): string | null {
  const s = normalizePathForMatch(p);
  if (!s) return null;
  return s;
}

/**
 * Find the most-specific candidate root that contains a target path.
 *
 * "Most-specific" means the longest matching root prefix.
 * Array ordering of `allowedRoots` must not affect the result.
 *
 * Example:
 *   target = "c:/projects/private/data.txt"
 *   roots  = ["c:/projects", "c:/projects/private"]
 *   → returns "c:/projects/private" (more specific)
 *
 * Returns null if no root contains the target.
 */
export function findMostSpecificRoot(
  targetPath: string,
  allowedRoots: readonly string[],
): string | null {
  const normalised = normalizePathForMatch(targetPath);

  let best: string | null = null;
  let bestLen = 0;

  for (const root of allowedRoots) {
    const r = normalizePathForMatch(root);
    // Must be an exact match or prefix with separator.
    const isMatch =
      normalised === r ||
      normalised.startsWith(r + '/');

    if (isMatch && r.length > bestLen) {
      best = root; // return the original (non-normalised) form
      bestLen = r.length;
    }
  }

  return best;
}

/**
 * Extract the parent directory from a file path.
 * Pure lexical — no I/O.
 *
 * For directory-targeting tools (list_dir, grep, glob_files),
 * the path IS the target directory.
 */
export function parentDir(path: string): string {
  return parentDirectory(path) ?? path;
}

/**
 * Remove redundant descendant scopes while preserving the requested roots.
 *
 * A parent replaces a child only when that parent was itself requested. This
 * keeps two child directories separate, while a batch containing `root` and
 * `root/child` shows only `root`.
 */
export function collapseNestedDirectoryScopes(
  scopes: readonly string[],
): string[] {
  const unique: Array<{ original: string; normalized: string }> = [];
  const seen = new Set<string>();

  for (const original of scopes) {
    const normalized = normalizePathForMatch(original);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push({ original, normalized });
  }

  return unique
    .filter(({ normalized: candidate }) => !unique.some(({ normalized: ancestor }) => {
      if (ancestor === candidate) return false;
      const boundary = ancestor.endsWith('/') ? ancestor : `${ancestor}/`;
      return candidate.startsWith(boundary);
    }))
    .map(({ original }) => original);
}

// ═══════════════════════════════════════════════════════════════════
// 4b. File I/O Authorization
// ═══════════════════════════════════════════════════════════════════

/**
 * Result of file I/O authorization — the caller uses this to
 * decide whether to show a popup and for which directories.
 */
export interface FileAuthorizationResult {
  /** Whether ALL targets are pre-granted. */
  allGranted: boolean;
  /** The canonical roots that match targets and have the tool grant. */
  matchedRoots: string[];
  /** The canonical directories that lack a grant for this tool. */
  ungrantedDirs: string[];
  /** The configured roots that contain the targets but lack the
   *  tool checkmark. Diagnostic only; popup approval must use the
   *  canonical target directories in `ungrantedDirs`. */
  missingGrantRoots: string[];
}

/**
 * Authorize a File I/O tool call against directory+tool grants.
 *
 * This is PURE. It does NOT canonicalize paths on disk — the caller
 * must pass already-canonical target paths.
 *
 * Rules (per policy model §6):
 *   - A root/tool grant covers that root and its descendants.
 *   - For each target path, find the most-specific containing root that
 *     grants the requested tool.
 *   - A more-specific root without the tool does not shadow an ancestor grant.
 *   - If any target lacks a grant, the call is not pre-granted.
 *   - `ungrantedDirs` lists the canonical directories to show in the popup.
 *
 * @param toolName — The tool name (must be a File I/O tool).
 * @param canonicalTargets — Canonical file/directory paths the tool targets.
 * @param isDirTarget — True for list_dir, grep, glob_files where the path IS the directory.
 * @param grants — Current additive grant snapshot.
 */
export function resolveFileAuthorization(
  toolName: string,
  canonicalTargets: string[],
  isDirTarget: boolean,
  grants: GrantSnapshot,
): FileAuthorizationResult {
  const matchedRoots: string[] = [];
  const ungrantedDirs: string[] = [];
  const missingGrantRoots: string[] = [];
  const grantingRoots = grants.allowedRoots.filter((root) => {
    const rootKey = canonicalizeRootPath(root) ?? root;
    return grants.dirPermissions.get(rootKey)?.has(toolName) === true;
  });

  for (const target of canonicalTargets) {
    const matchingGrantRoot = findMostSpecificRoot(target, grantingRoots);

    if (matchingGrantRoot) {
      if (!matchedRoots.includes(matchingGrantRoot)) {
        matchedRoots.push(matchingGrantRoot);
      }
      continue;
    }

    const matchingAllowedRoot = findMostSpecificRoot(target, grants.allowedRoots);

    if (!matchingAllowedRoot) {
      // Target is outside all allowed roots.
      const dir = isDirTarget ? target : parentDir(target);
      if (dir && !ungrantedDirs.includes(dir)) {
        ungrantedDirs.push(dir);
      }
      continue;
    }

    // The target is contained but no containing root grants this tool. The
    // most-specific allowed root is diagnostic only; approval remains scoped
    // to the exact canonical target directory.
    if (!missingGrantRoots.includes(matchingAllowedRoot)) {
      missingGrantRoots.push(matchingAllowedRoot);
    }
    const dir = isDirTarget ? target : parentDir(target);
    if (dir && !ungrantedDirs.includes(dir)) {
      ungrantedDirs.push(dir);
    }
  }

  const popupScopes = collapseNestedDirectoryScopes(ungrantedDirs);

  return {
    allGranted: popupScopes.length === 0 && missingGrantRoots.length === 0,
    matchedRoots,
    ungrantedDirs: popupScopes,
    missingGrantRoots,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 4c. Main Authorization Functions
// ═══════════════════════════════════════════════════════════════════

/**
 * Authorize a tool call given the current exposure and grant state.
 *
 * This is CALL-SPECIFIC and SIDE-EFFECT-FREE.
 * It does NOT mutate persisted state, show a popup, or execute the tool.
 *
 * The caller is responsible for:
 *   1. Validating arguments (before calling this).
 *   2. Canonicalizing file targets (before calling this, for file tools).
 *   3. Showing the permission popup if state is 'prompt' or 'always_prompt'.
 *   4. Applying any persistent grant through the store reducer.
 *
 * Per TOOL-POLICY-MODEL.md §5.
 *
 * @param toolName — The tool being called.
 * @param exposure — Current exposure snapshot from resolveExposure().
 * @param grants — Current grant snapshot from buildGrantSnapshot().
 * @param fileAuth — Pre-computed file authorization result (required for File I/O tools).
 */
export function authorizeCall(
  toolName: string,
  exposure: ExposureSnapshot,
  grants: GrantSnapshot,
  fileAuth?: FileAuthorizationResult,
): AuthorizationDecision {
  // 0. Get policy metadata. Unknown tools are not exposed.
  const policy = TOOL_POLICY.get(toolName);
  if (!policy) {
    return {
      allowed: false,
      state: 'not_exposed',
      policy: {
        name: toolName,
        category: 'file_io',
        grantScope: 'none',
        promptPolicy: 'grant_or_prompt',
      },
      issues: [{ code: 'unknown_tool', message: `Unknown tool: ${toolName}` }],
    };
  }

  // 1. Not exposed → reject without a popup.
  if (!exposure.exposedNames.has(toolName)) {
    return {
      allowed: false,
      state: 'not_exposed',
      policy,
      issues: [{ code: 'not_exposed', message: `Tool "${toolName}" is not exposed in this workspace.` }],
    };
  }

  // 2. Dispatch by prompt policy.
  switch (policy.promptPolicy) {
    case 'no_prompt':
      // Foundation and read-only infrastructure tools execute directly.
      return { allowed: true, state: 'no_prompt', policy };

    case 'always_prompt':
      // Shell: always popup.  allowed=false so caller shows the modal.
      return { allowed: false, state: 'always_prompt', policy };

    case 'grant_or_prompt':
      switch (policy.grantScope) {
        case 'conversation_tool':
          // Web Access uses a global conversation-scoped checkmark.
          if (grants.toolGrants.has(toolName)) {
            return { allowed: true, state: 'pregranted', policy };
          }
          return { allowed: false, state: 'prompt', policy };

        case 'directory_tool': {
          // File I/O: directory+tool checkmark.
          if (!fileAuth) {
            // Caller must provide fileAuth for directory-scoped tools.
            return { allowed: false, state: 'prompt', policy };
          }
          if (fileAuth.allGranted) {
            return {
              allowed: true,
              state: 'pregranted',
              policy,
              matchedRoots: fileAuth.matchedRoots,
            };
          }
          return {
            allowed: false,
            state: 'prompt',
            policy,
            ungrantedDirs: fileAuth.ungrantedDirs,
          };
        }

        default:
          return { allowed: false, state: 'prompt', policy };
      }
  }
}

/**
 * Authorize a non-file tool, such as a Web Access, shell, or Tool History tool.
 */
export function authorizeNonFileCall(
  toolName: string,
  exposure: ExposureSnapshot,
  grants: GrantSnapshot,
): AuthorizationDecision {
  return authorizeCall(toolName, exposure, grants);
}

/**
 * Convenience: authorize a File I/O tool with pre-computed file auth.
 */
export function authorizeFileCall(
  toolName: string,
  exposure: ExposureSnapshot,
  grants: GrantSnapshot,
  fileAuth: FileAuthorizationResult,
): AuthorizationDecision {
  return authorizeCall(toolName, exposure, grants, fileAuth);
}

// ═══════════════════════════════════════════════════════════════════
// 5. Convenience: derive the "effective tools" set for the executor
// ═══════════════════════════════════════════════════════════════════
