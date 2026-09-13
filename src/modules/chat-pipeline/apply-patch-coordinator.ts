import { approvedScopesCoverRequired } from '../tool-engine/grant-state.ts';
import { normalizePathForMatch, pathResolutionFailureMessage } from '../tool-engine/clean-path.ts';
import type {
  ApplyPatchPreflightResult,
  ApplyPatchTargetsResult,
} from '../tool-engine/sandbox-bridge';
import type { ApplyPatchLockReservation } from '../tool-engine/file-lock';
import { validateApprovedPatchPreflight } from './patch-authorization.ts';

export interface PatchCoordinatorIssue {
  code: string;
  message: string;
  retryable: boolean;
  path?: string;
}

export type PatchAdmission =
  | { allowed: true }
  | { allowed: false; issue: PatchCoordinatorIssue };

export type PatchAuthorization =
  | { state: 'pregranted' }
  | { state: 'prompt'; requiredScopes: string[] }
  | { state: 'rejected'; issue: PatchCoordinatorIssue };

export type PatchApproval =
  | { decision: 'deny' | 'unavailable' }
  | { decision: 'allow_once' | 'allow_session'; grantedDirs: string[] };

export type PersistPatchScopesResult =
  | { ok: true; allowedRoots: string[] }
  | { ok: false; issue: PatchCoordinatorIssue };

export type PatchCoordinatorFailure = {
  status: 'rejected';
  stage: 'admission' | 'discovery' | 'authorization' | 'approval' | 'preflight';
  issue: PatchCoordinatorIssue;
};

export type PatchCoordinatorSuccess<T> = {
  status: 'executed';
  value: T;
  discoveredTargets: string[];
  approvedScopes: string[];
  allowedRoots: string[];
  planId: string;
  persisted: boolean;
};

export type PatchCoordinatorResult<T> = PatchCoordinatorFailure | PatchCoordinatorSuccess<T>;

interface CoordinateApplyPatchOptions<T> {
  admission: PatchAdmission;
  patch: string;
  initialAllowedRoots: string[];
  reserve: () => Promise<ApplyPatchLockReservation>;
  discover: (patch: string) => Promise<ApplyPatchTargetsResult>;
  resolveTargetScope: (canonicalTarget: string) => Promise<string | null | undefined>;
  authorize: (canonicalScopes: string[]) => PatchAuthorization;
  requestApproval: (requiredScopes: string[]) => Promise<PatchApproval>;
  canonicalizeApprovedScope: (requiredScope: string) => Promise<string | null | undefined>;
  persistSessionScopes: (approvedScopes: string[]) => Promise<PersistPatchScopesResult>;
  preflight: (patch: string, allowedRoots: string[]) => Promise<ApplyPatchPreflightResult>;
  execute: (args: {
    patch: string;
    allowedRoots: string[];
    planId: string;
    discoveredTargets: string[];
  }) => Promise<T>;
  normalizeError: (error: unknown) => PatchCoordinatorIssue;
}

function failure(
  stage: PatchCoordinatorFailure['stage'],
  issue: PatchCoordinatorIssue,
): PatchCoordinatorFailure {
  return { status: 'rejected', stage, issue };
}

function appendExactRoots(initial: string[], additions: string[]): string[] {
  const roots = [...initial];
  const seen = new Set(roots.map(normalizePathForMatch));
  for (const scope of additions) {
    const normalized = normalizePathForMatch(scope);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      roots.push(scope);
    }
  }
  return roots;
}

/**
 * Coordinate the complete exposed lc_apply_patch decision sequence.
 * Admission is intentionally the first branch: a disabled tool cannot reserve
 * the patch queue or invoke native target discovery.
 */
export async function coordinateApplyPatch<T>(
  options: CoordinateApplyPatchOptions<T>,
): Promise<PatchCoordinatorResult<T>> {
  if (options.admission.allowed === false) return failure('admission', options.admission.issue);

  const reservation = await options.reserve();
  try {
    let discovery: ApplyPatchTargetsResult;
    try {
      discovery = await options.discover(options.patch);
    } catch (error) {
      const issue = options.normalizeError(error);
      return failure('discovery', {
        ...issue,
        message: `apply_patch target discovery failed: ${issue.message}`,
        retryable: false,
      });
    }

    const discoveredTargets = Array.isArray(discovery.affected_paths)
      ? discovery.affected_paths
      : [];
    const diagnostics = Array.isArray(discovery.diagnostics) ? discovery.diagnostics : [];
    if (discoveredTargets.length === 0 || diagnostics.length > 0) {
      return failure('discovery', {
        code: 'invalid_arguments',
        message: `apply_patch target discovery rejected: ${diagnostics.join('. ') || 'no valid targets'}`,
        retryable: false,
      });
    }

    const canonicalScopes: string[] = [];
    for (const target of discoveredTargets) {
      const scope = await options.resolveTargetScope(target);
      if (!scope) {
        return failure('discovery', {
          code: 'path_resolution_failed',
          message: pathResolutionFailureMessage(target),
          path: target,
          retryable: false,
        });
      }
      if (!canonicalScopes.some((existing) => (
        normalizePathForMatch(existing) === normalizePathForMatch(scope)
      ))) canonicalScopes.push(scope);
    }

    const authorization = options.authorize(canonicalScopes);
    if (authorization.state === 'rejected') {
      return failure('authorization', authorization.issue);
    }

    const approvedScopes: string[] = [];
    let allowedRoots = [...options.initialAllowedRoots];
    let persisted = false;
    if (authorization.state === 'prompt') {
      const requiredScopes = authorization.requiredScopes;
      const approval = await options.requestApproval(requiredScopes);
      if (approval.decision === 'unavailable') {
        return failure('approval', {
          code: 'permission_ui_unavailable',
          message: 'The permission prompt was unavailable, so this tool call was blocked without executing it.',
          retryable: true,
        });
      }
      if (approval.decision === 'deny') {
        return failure('approval', {
          code: 'denied_by_user',
          message: 'The user denied permission for this tool call.',
          retryable: false,
        });
      }
      if (!('grantedDirs' in approval)) {
        return failure('approval', {
          code: 'invalid_approval',
          message: 'The permission prompt returned an invalid approval result.',
          retryable: false,
        });
      }
      if (!approvedScopesCoverRequired(requiredScopes, approval.grantedDirs)) {
        return failure('approval', {
          code: 'grant_required',
          message: 'All required directory scopes must be approved before this batch can run.',
          retryable: true,
        });
      }

      for (const requiredScope of requiredScopes) {
        const canonical = await options.canonicalizeApprovedScope(requiredScope);
        if (
          !canonical ||
          normalizePathForMatch(canonical) !== normalizePathForMatch(requiredScope)
        ) {
          return failure('approval', {
            code: 'path_outside_roots',
            message: `The approved directory scope could not be resolved exactly: ${requiredScope}`,
            path: requiredScope,
            retryable: true,
          });
        }
        if (!approvedScopes.some((existing) => (
          normalizePathForMatch(existing) === normalizePathForMatch(canonical)
        ))) approvedScopes.push(canonical);
      }

      if (approval.decision === 'allow_session') {
        const persistedScopes = await options.persistSessionScopes(approvedScopes);
        if (persistedScopes.ok === false) return failure('approval', persistedScopes.issue);
        allowedRoots = persistedScopes.allowedRoots;
        persisted = true;
      } else {
        allowedRoots = appendExactRoots(allowedRoots, approvedScopes);
      }
    }

    let preflight: ApplyPatchPreflightResult;
    try {
      preflight = await options.preflight(options.patch, allowedRoots);
    } catch (error) {
      const issue = options.normalizeError(error);
      return failure('preflight', {
        ...issue,
        message: `apply_patch preflight failed after authorization: ${issue.message}`,
      });
    }
    const validation = validateApprovedPatchPreflight(discoveredTargets, preflight);
    if ('message' in validation) {
      return failure('preflight', {
        code: 'invalid_arguments',
        message: validation.message,
        retryable: false,
      });
    }

    const releaseTargets = await reservation.acquireTargets(discoveredTargets);
    try {
      const value = await options.execute({
        patch: options.patch,
        allowedRoots,
        planId: validation.planId,
        discoveredTargets,
      });
      return {
        status: 'executed',
        value,
        discoveredTargets,
        approvedScopes,
        allowedRoots,
        planId: validation.planId,
        persisted,
      };
    } finally {
      releaseTargets();
    }
  } finally {
    reservation.release();
  }
}
