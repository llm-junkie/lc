/**
 * Path sanitization utilities — pure functions with no Tauri or
 * Node-specific dependencies.  Safe to import in the Node test runner.
 *
 * Kept separate from the Tauri bridge so pure path operations remain easy
 * to test and safe to use in browser code.
 */

/**
 * Clean a raw path string for use as an allowed root or filesystem
 * argument.  Strips surrounding whitespace and trailing path
 * separators, normalises double-backslashes, and ensures bare drive
 * letters get a trailing separator.
 *
 * Phase 0B.8 fix (GPT §3.4): removed the destructive regex truncation
 * at spaces, parentheses, semicolons, and commas.  Valid paths
 * containing these characters are no longer mangled.  Error-message
 * scraping is handled at the call site via structured error codes,
 * not here.
 *
 * Idempotent: cleanPath(cleanPath(x)) === cleanPath(x).
 */
export function cleanPath(raw: string): string {
  // Trim whitespace from both ends.
  let p = raw.trim();
  if (!p) return '';

  // Collapse double backslashes that survive JSON round-trips,
  // but preserve leading \\ for UNC paths.
  if (!p.startsWith('\\\\')) {
    p = p.replace(/\\\\/g, '\\');
  } else {
    // Only collapse \\ after the UNC prefix (\\server\share).
    const prefix = p.slice(0, 2); // \\
    const rest = p.slice(2);
    p = prefix + rest.replace(/\\\\/g, '\\');
  }

  // Strip trailing separators, but preserve drive roots like "C:".
  while (p.length > 2 && (p.endsWith('\\') || p.endsWith('/'))) {
    p = p.slice(0, -1);
  }

  // Restore the trailing separator for bare drive letters ("C:" -> "C:\\").
  if (/^[A-Za-z]:$/.test(p)) p += '\\';

  // Normalise Windows drive letter to uppercase so downstream
  // case-insensitive comparisons have one less mismatch to handle.
  // `std::fs::canonicalize` on Windows returns uppercase drive
  // letters, and all path-sandbox comparisons are case-insensitive,
  // but a uniform canonical form at the entry point is defense-in-
  // depth against edge cases in permission-check and root-matching
  // code paths.
  p = p.replace(/^[a-z]:/, (m) => m.toUpperCase());

  return p;
}

/** Format a path for display without changing its stored identity. */
export function formatPathForDisplay(path: string, isWindows: boolean): string {
  if (!isWindows) return path;
  const cleaned = cleanPath(path);
  return cleaned.replace(/\//g, '\\');
}

/**
 * Remove whitespace immediately adjacent to path separators.
 *
 * LLM-generated paths can contain an accidental space before or after a
 * separator. Spaces inside legitimate names such as `Program Files` remain
 * untouched.
 */
export function sanitizePathSepWhitespace(raw: string): string {
  let s = raw.trim();
  s = s.replace(/\s+([\\/])/g, '$1');
  s = s.replace(/([\\/])\s+/g, '$1');
  return s;
}

/**
 * Normalize a filesystem path for grant matching.
 *
 * This is lexical only: separators, redundant separators, dot segments,
 * trailing separators, and Windows casing are normalized, but symlinks and
 * junctions require native resolution at the authorization boundary.
 */
export function normalizePathForMatch(p: string): string {
  let s = p.replace(/\\/g, '/');
  const isUnc = s.startsWith('//');
  const isDriveAbsolute = /^[a-zA-Z]:\//.test(s);
  const isAbsolute = isUnc || isDriveAbsolute || s.startsWith('/');

  s = s.replace(/\/{3,}/g, '/');
  if (!s.startsWith('//')) s = s.replace(/\/{2,}/g, '/');

  const prefix = isUnc
    ? '//'
    : isDriveAbsolute
      ? s.slice(0, 3)
      : s.startsWith('/')
        ? '/'
        : '';
  const segments = s.slice(prefix.length).split('/');
  const collapsed: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (collapsed.length > 0 && collapsed[collapsed.length - 1] !== '..') {
        collapsed.pop();
      } else if (!isAbsolute) {
        collapsed.push('..');
      }
      continue;
    }
    collapsed.push(segment);
  }

  let normalized = prefix + collapsed.join('/');
  if (!normalized && isAbsolute) normalized = prefix;
  if (normalized.length > 1 && normalized.endsWith('/')) {
    const isRoot = normalized === '/' || /^[a-zA-Z]:\/$/.test(normalized);
    if (!isRoot) normalized = normalized.slice(0, -1);
  }

  const isWindows = /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p);
  if (isWindows) normalized = normalized.toLowerCase();
  return normalized;
}

/** Cross-platform absolute-path shape check. */
export function isAbsolutePath(p: string): boolean {
  if (!p) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith('\\\\')) return true;
  if (p.startsWith('/')) return true;
  return false;
}

/**
 * Return the parent directory of an absolute path.
 * - `C:\\foo\\bar\\file.txt` → `C:\\foo\\bar`
 * - `C:\\foo` → `C:\\`
 * - `C:\\` → `C:\\`
 * - `\\\\server\\share\\dir` → `\\\\server\\share`
 * Returns null when no parent can be determined.
 */
export function parentDirectory(path: string): string | null {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (index === 0) return path.slice(0, 1);
  if (index === 2 && /^[A-Za-z]:[\\/]/.test(path)) return path.slice(0, 3);
  return index > 0 ? path.slice(0, index) : null;
}

/** Minimal resolved-path info needed by scopeDirForResolved. */
export interface ResolvedPathInfo {
  canonical: string | null;
  exists: boolean;
  is_dir: boolean;
}

/**
 * Pure helper: given a resolved path result, return the canonical
 * directory that should serve as the grant scope for a tool call.
 *
 * - Non-existent paths always return null (can't determine scope).
 * - directoryIsTarget=true + is_dir → the path itself is the scope.
 * - directoryIsTarget=true + is_file → parent directory is the scope
 *   (handles lc_grep targeting a single file and lc_glob_files when
 *   a model mistakenly passes a file as root).
 * - directoryIsTarget=false → parent directory is always the scope.
 */
export function scopeDirForResolved(
  resolved: ResolvedPathInfo,
  directoryIsTarget: boolean,
): string | null {
  if (!resolved.canonical) return null;
  if (directoryIsTarget) {
    if (!resolved.exists) return null;
    if (resolved.is_dir) return resolved.canonical;
    return parentDirectory(resolved.canonical);
  }
  return parentDirectory(resolved.canonical);
}

/**
 * Build the `path_resolution_failed` message for a raw target path that the
 * pre-flight could not resolve. States the rule that failed: a path that is
 * empty or not absolute after cleaning never reaches native resolution at
 * all, while everything else failed because it does not exist or cannot be
 * read. One message for both classes hid the rule the caller broke.
 */
export function pathResolutionFailureMessage(raw: string): string {
  const cleaned = cleanPath(raw);
  if (!cleaned || !isAbsolutePath(cleaned)) {
    return `Target path must be absolute: ${raw}`;
  }
  return `Target path does not exist or cannot be resolved: ${raw}`;
}

/**
 * Resolve the directory scope for `lc_stat`, which accepts both files and
 * directories and also reports missing paths. Existing directories are the
 * target scope; existing files and missing paths use their parent scope.
 */
export function scopeDirForStatResolved(
  resolved: ResolvedPathInfo,
): string | null {
  if (!resolved.canonical) return null;
  if (resolved.exists && resolved.is_dir) return resolved.canonical;
  return parentDirectory(resolved.canonical);
}
