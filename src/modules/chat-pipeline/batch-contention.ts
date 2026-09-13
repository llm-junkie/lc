/**
 * Detect files that one tool batch both mutates and reads.
 *
 * Only mutating File I/O tools take file locks, so a read issued in the same
 * turn as a write runs concurrently with it and can observe either side of the
 * change. A model has no way to see that interleaving from the results — in
 * testing one read the pre-edit content, was told by the edit result that the
 * change had landed, and concluded the tool had lied about it.
 *
 * Extracted from orchestrator.ts so the matching stays testable without the
 * Tauri runtime. Pure JS, no Tauri deps.
 */

import { FILE_IO_MUTATING_NAMES } from '../tool-engine/registry-names.ts';
import { targetPathsFromArgs } from '../tool-engine/check-dir-permission.ts';
import { normalizePathForMatch } from '../tool-engine/clean-path.ts';

/** Calls whose result a concurrent mutation of the same file invalidates. */
export const CONTENDABLE_READ_NAMES: ReadonlySet<string> = new Set([
  'lc_read_file',
  'lc_read_image',
  'lc_read_pdf',
  'lc_stat',
]);

const MUTATING_NAMES: ReadonlySet<string> = new Set(FILE_IO_MUTATING_NAMES);

/** The shape `findContendedFilePaths` needs from a validated tool call. */
export interface ContentionCandidate {
  call: { name: string };
  parsed?: unknown;
  error?: unknown;
}

/**
 * Files an `lc_apply_patch` call touches, read off the patch text.
 *
 * Native preflight reports these authoritatively, but only once the call is
 * running. Batch-level analysis happens before that, so recover them from the
 * patch headers instead.
 */
export function patchFileTargets(parsed: unknown): string[] {
  const patch = (parsed as { patch?: unknown } | null | undefined)?.patch;
  if (typeof patch !== 'string') return [];
  const targets: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:(.+)$/gm)) {
    targets.push(m[1].trim());
  }
  for (const m of patch.matchAll(/^\*\*\* Move to:(.+)$/gm)) {
    targets.push(m[1].trim());
  }
  return targets;
}

/** Absolute file paths one File I/O call reads or writes. */
export function fileTargetsOf(toolName: string, parsed: unknown): string[] {
  if (toolName === 'lc_apply_patch') return patchFileTargets(parsed);
  if (!parsed || typeof parsed !== 'object') return [];
  return targetPathsFromArgs(toolName, parsed as Record<string, unknown>);
}

/**
 * Paths that a single batch both mutates and reads.
 *
 * Matching is lexical: two spellings that reach one file through a symlink are
 * missed here, though the file lock still serializes the writes themselves.
 */
export function findContendedFilePaths(
  validated: readonly ContentionCandidate[],
): Set<string> {
  const mutated = new Set<string>();
  const read = new Set<string>();

  for (const { call, parsed, error } of validated) {
    if (error) continue;
    const bucket = MUTATING_NAMES.has(call.name)
      ? mutated
      : CONTENDABLE_READ_NAMES.has(call.name)
        ? read
        : null;
    if (!bucket) continue;
    for (const path of fileTargetsOf(call.name, parsed)) {
      const normalized = normalizePathForMatch(path);
      if (normalized) bucket.add(normalized);
    }
  }

  const contended = new Set<string>();
  for (const path of mutated) {
    if (read.has(path)) contended.add(path);
  }
  return contended;
}
