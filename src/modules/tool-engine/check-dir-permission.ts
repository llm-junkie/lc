/**
 * Pure-function permission check: does a tool call's target path(s)
 * fall within allowed roots and have the necessary tool grants?
 *
 * Root/tool grants cover descendants and overlapping roots are additive per
 * tool. The most-specific containing root that grants the requested tool is
 * selected, independent of allowedRoots array ordering.
 *
 * Extracted from runner.ts so it can be unit-tested without the
 * Tauri runtime (`path-safety` → `@tauri-apps/api/core`).
 */

import { normalizePathForMatch } from './clean-path.ts';

export type DirPermResult =
  | { ok: true; root: string }
  | { ok: false; reason: 'not_granted'; root: string; ungranted: string[] };

/** Extract every raw filesystem target represented by a validated file-tool call. */
export function targetPathsFromArgs(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  let paths: string[] | undefined;
  if (
    toolName === 'lc_read_file' ||
    toolName === 'lc_list_dir' ||
    toolName === 'lc_stat' ||
    toolName === 'lc_read_image' ||
    toolName === 'lc_read_pdf'
  ) {
    paths = args.paths as string[] | undefined;
  } else if (toolName === 'lc_write_file' || toolName === 'lc_edit_file' || toolName === 'lc_apply_patch') {
    const files = args.files as Array<{ path: string }> | undefined;
    if (files && files.length > 0) paths = files.map((file) => file.path);
    else if (typeof args.path === 'string' && args.path) paths = [args.path];
  } else if (toolName === 'lc_grep') {
    const searches = args.searches as Array<{ path: string }> | undefined;
    paths = searches?.map((search) => search.path);
  } else if (toolName === 'lc_glob_files') {
    const root = args.root as string | undefined;
    if (root) paths = [root];
  }

  return Array.from(new Set((paths ?? []).filter(Boolean)));
}

export function directoryIsTargetTool(toolName: string): boolean {
  return toolName === 'lc_list_dir' || toolName === 'lc_grep' || toolName === 'lc_glob_files';
}

/**
 * Extract lexical directories for pure permission checks and unit tests.
 *
 * `lc_stat` is intentionally not a directory-target tool here: its target
 * may be an existing directory, an existing file, or a missing path. The
 * authorization path must resolve those cases natively first via
 * `resolveStatPathForScope`; this lexical helper cannot safely infer that
 * scope on its own.
 */
export function targetDirsFromArgs(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  const directories = targetPathsFromArgs(toolName, args).map((path) => {
    if (directoryIsTargetTool(toolName)) return path;
    const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (index === 0) return path.slice(0, 1);
    if (index === 2 && /^[A-Za-z]:[\\/]/.test(path)) return path.slice(0, 3);
    return index > 0 ? path.slice(0, index) : path;
  });
  return Array.from(new Set(directories.filter(Boolean)));
}

/** Check already-canonical target directories against canonical grant roots. */
export function checkDirPermissionForDirs(
  toolName: string,
  targetDirs: readonly string[],
  allowedRoots: readonly string[],
  dirPermissions: Readonly<Record<string, string[]>>,
): DirPermResult {
  if (targetDirs.length === 0) return { ok: true, root: '' };

  const normalizedRoots = allowedRoots.map(normalizePathForMatch).filter(Boolean);
  const normalizedPermissions = new Map<string, Set<string>>();
  for (const [rawRoot, tools] of Object.entries(dirPermissions)) {
    const root = normalizePathForMatch(rawRoot);
    if (!root) continue;
    const grants = normalizedPermissions.get(root) ?? new Set<string>();
    for (const tool of tools ?? []) grants.add(tool);
    normalizedPermissions.set(root, grants);
  }
  const grantingRoots = normalizedRoots.filter(
    (root) => normalizedPermissions.get(root)?.has(toolName) === true,
  );

  const ungranted = new Set<string>();
  let firstRoot = '';
  for (const directory of targetDirs) {
    const matchingGrant = findMostSpecificRoot(directory, grantingRoots);
    if (matchingGrant) {
      if (!firstRoot) firstRoot = matchingGrant;
      continue;
    }

    const matchingAllowed = findMostSpecificRoot(directory, normalizedRoots);
    if (!matchingAllowed) {
      ungranted.add(directory);
      if (!firstRoot) firstRoot = directory;
      continue;
    }
    if (!firstRoot) firstRoot = matchingAllowed;
    ungranted.add(directory);
  }

  if (ungranted.size === 0) {
    return { ok: true, root: firstRoot || normalizedRoots[0] || '' };
  }
  return {
    ok: false,
    reason: 'not_granted',
    root: firstRoot || Array.from(ungranted)[0],
    ungranted: Array.from(ungranted),
  };
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
function findMostSpecificRoot(
  targetPath: string,
  allowedRoots: readonly string[],
): string | null {
  const normalised = normalizePathForMatch(targetPath);
  let best: string | null = null;
  let bestLen = 0;

  for (const root of allowedRoots) {
    const r = normalizePathForMatch(root);
    const isMatch = normalised === r || normalised.startsWith(r + '/');
    if (isMatch && r.length > bestLen) {
      best = r;
      bestLen = r.length;
    }
  }

  return best;
}

/**
 * Check whether a tool call's path(s) are permitted given the
 * current `allowedRoots` and `dirPermissions` grant set.
 *
 * For multi-path tools, ALL unique parent directories of all paths
 * are checked. If any are ungranted, `ungranted` lists them all so
 * the permission modal can show every missing scope as read-only
 * information for the whole-call approval decision.
 *
 * If a target falls within overlapping roots, the most-specific root that
 * grants this tool is used. A more-specific root without the tool is skipped,
 * not treated as an implicit deny. Child grants never match parents or
 * siblings because containment remains directional.
 */
export function checkDirPermission(
  toolName: string,
  args: Record<string, unknown>,
  allowedRoots: string[],
  dirPermissions: Record<string, string[]>,
): DirPermResult {
  return checkDirPermissionForDirs(
    toolName,
    targetDirsFromArgs(toolName, args),
    allowedRoots,
    dirPermissions,
  );
}
