import { normalizePathForMatch } from '../tool-engine/clean-path.ts';
import type { ApplyPatchPreflightResult } from '../tool-engine/sandbox-bridge';

export type PatchPreflightValidation =
  | { ok: true; planId: string }
  | { ok: false; message: string };

/** Ensure authorized discovery and fresh full preflight cover exactly one plan. */
export function validateApprovedPatchPreflight(
  discoveredTargets: readonly string[],
  preflight: ApplyPatchPreflightResult,
): PatchPreflightValidation {
  const affectedPaths = Array.isArray(preflight.affected_paths) ? preflight.affected_paths : [];
  const diagnostics = Array.isArray(preflight.diagnostics) ? preflight.diagnostics : [];
  const approved = new Set(discoveredTargets.map(normalizePathForMatch));
  const validated = new Set(affectedPaths.map(normalizePathForMatch));
  const targetsMatch = approved.size === validated.size && [...approved].every((path) => validated.has(path));

  if (diagnostics.length > 0) {
    return {
      ok: false,
      message: `apply_patch preflight rejected.\n${diagnostics.map((item) => `- ${item}`).join('\n')}`,
    };
  }
  if (!targetsMatch) return { ok: false, message: 'apply_patch preflight targets changed after authorization' };
  if (!preflight.plan_id || affectedPaths.length === 0) {
    return { ok: false, message: 'apply_patch preflight did not produce an executable plan' };
  }
  return { ok: true, planId: preflight.plan_id };
}
