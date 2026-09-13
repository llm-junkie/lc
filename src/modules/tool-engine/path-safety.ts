/**
 * Shared path sanitization for anything that ends up in
 * `Conversation.tools.allowed_roots`.
 *
 * `cleanPath(raw)` performs conservative separator/whitespace cleanup while
 * preserving legitimate spaces and punctuation. Native resolution supplies
 * canonical identities; human-readable error strings are never mined for
 * roots or permission scopes.
 */
import { invoke } from '@tauri-apps/api/core';
import {
  cleanPath,
  isAbsolutePath,
  parentDirectory,
  scopeDirForResolved,
  scopeDirForStatResolved,
} from './clean-path.ts';

export interface CheckPathResult {
  exists: boolean;
  is_dir: boolean;
  canonical: string | null;
}

/**
 * Verify a path actually resolves to a directory on the local
 * filesystem. Returns `{ exists: false }` (NOT a thrown error) for
 * non-existent paths so the caller can present a clean "Directory
 * does not exist" message instead of letting the user silently add
 * a bogus root. `canonical` is the OS-canonicalized form when the
 * path resolves; `null` otherwise.
 *
 * On non-Tauri (browser dev) builds, returns a permissive `{ exists:
 * true, is_dir: true, canonical: input }` so the rest of the flow
 * keeps working — the Tauri-only side does the real validation in
 * production.
 */
export async function checkPath(raw: string): Promise<CheckPathResult> {
  const cleaned = cleanPath(raw);
  if (!cleaned || !isAbsolutePath(cleaned)) {
    return { exists: false, is_dir: false, canonical: null };
  }
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    // Non-Tauri build: trust the caller. Production is always Tauri;
    // this is just so the JS unit tests / browser dev preview keep
    // working.
    return { exists: true, is_dir: true, canonical: cleaned };
  }
  try {
    const res = await invoke<CheckPathResult>('tool_check_path', {
      req: { path: cleaned },
    });
    return res;
  } catch {
    return { exists: false, is_dir: false, canonical: null };
  }
}

/**
 * Resolve an approved directory scope to the canonical root to persist.
 *
 * Returns the canonical form (so Windows short-path names don't fragment the
 * roots list), or null when the path is malformed or is an existing file.
 * Callers should fall back to the "no specific directory" branch on null.
 *
 * A scope that does not exist yet still resolves. Requiring existence here was
 * right for a root picked in Settings but wrong at approval time: the first
 * `lc_write_file` into a new subdirectory is approved for a scope that the
 * write itself is about to create. Rejecting it made that write fail with
 * `path_outside_roots` even though the sandbox allowed it and the native
 * writer creates missing parents — and the failure was order-dependent, since
 * a later write to the same path succeeds once the enclosing root carries the
 * grant.
 *
 * The scope stays exactly as narrow as the one shown in the popup: this
 * canonicalizes the approved path itself, never an enclosing ancestor.
 * Native resolution canonicalizes the deepest existing ancestor and re-appends
 * the not-yet-created tail, so symlinks in the existing part are still
 * resolved. An existing *file* is not a directory scope and returns null.
 */
export async function resolveDirForApprovedScope(
  raw: string | null | undefined,
): Promise<string | null> {
  if (!raw) return null;
  const cleaned = cleanPath(raw);
  if (!cleaned || !isAbsolutePath(cleaned)) return null;

  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return cleaned;
  }

  try {
    const resolved = await invoke<CheckPathResult>('tool_resolve_path', {
      req: { path: cleaned },
    });
    if (resolved.exists && !resolved.is_dir) return null;
    return resolved.canonical ?? cleaned;
  } catch {
    return null;
  }
}

/**
 * Resolve a raw tool target to the canonical directory used as its grant scope.
 *
 * For file tools (lc_read_file, lc_write_file, lc_edit_file, etc.) the scope is the
 * parent directory.  For directory tools (lc_list_dir), the scope is the path
 * itself.  For dual-purpose tools (lc_grep, lc_glob_files), the scope is the
 * path itself when it's a directory, or the parent directory when it's a file.
 * `lc_stat` uses `resolveStatPathForScope` because it also accepts missing
 * paths and must walk back to the nearest existing directory.
 *
 * Returns null when the path cannot be resolved (non-existent, malformed, or
 * outside the filesystem).
 */
export async function resolvePathForScope(
  raw: string,
  directoryIsTarget: boolean,
): Promise<string | null> {
  const cleaned = cleanPath(raw);
  if (!cleaned || !isAbsolutePath(cleaned)) return null;

  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return directoryIsTarget ? cleaned : parentDirectory(cleaned);
  }

  try {
    const resolved = await invoke<CheckPathResult>('tool_resolve_path', {
      req: { path: cleaned },
    });
    return scopeDirForResolved(resolved, directoryIsTarget);
  } catch {
    return null;
  }
}

/**
 * Resolve a mutating file target to the canonical identity used for locking.
 *
 * The in-process file lock must map every alias of one file to a single key:
 * `a/./b.ts`, `a/b.ts`, and a symlink to either are one target and must not be
 * written concurrently. `lockKey` normalizes only separators and case, so the
 * raw model-supplied path is not a safe identity by itself.
 *
 * Unlike `resolvePathForScope`, this keeps the file-level path instead of
 * reducing it to a grant scope — the lock is per file, not per directory.
 * Native resolution walks up to the deepest existing ancestor and re-appends
 * the tail, so a file `lc_write_file` is about to create still gets a stable
 * identity before it exists.
 *
 * Returns null when the path cannot be resolved at all; callers fall back to
 * the raw path so a lock is still taken rather than skipped.
 */
export async function resolveLockTarget(raw: string): Promise<string | null> {
  const cleaned = cleanPath(raw);
  if (!cleaned || !isAbsolutePath(cleaned)) return null;

  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return cleaned;
  }

  try {
    const resolved = await invoke<CheckPathResult>('tool_resolve_path', {
      req: { path: cleaned },
    });
    return resolved.canonical ?? cleaned;
  } catch {
    return null;
  }
}

/**
 * Resolve an `lc_stat` target to a valid directory grant scope.
 *
 * `lc_stat` is dual-purpose: an existing directory is itself the target,
 * while files and missing paths are scoped to their nearest existing parent.
 * The ancestor walk matters for missing nested paths such as
 * `root/missing-dir/file.txt`, where the lexical parent does not exist.
 */
export async function resolveStatPathForScope(raw: string): Promise<string | null> {
  const cleaned = cleanPath(raw);
  if (!cleaned || !isAbsolutePath(cleaned)) return null;

  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return parentDirectory(cleaned);
  }

  try {
    const resolved = await invoke<CheckPathResult>('tool_resolve_path', {
      req: { path: cleaned },
    });
    const scope = scopeDirForStatResolved(resolved);
    if (!scope) return null;
    if (resolved.exists && resolved.is_dir) return scope;

    let candidate: string | null = scope;
    while (candidate) {
      const checked = await checkPath(candidate);
      if (checked.exists && checked.is_dir) return checked.canonical ?? candidate;
      const next = parentDirectory(candidate);
      if (!next || next === candidate) break;
      candidate = next;
    }
    return null;
  } catch {
    return null;
  }
}
