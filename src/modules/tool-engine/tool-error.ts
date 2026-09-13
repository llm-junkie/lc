import { READ_PDF_SELECTION_ERROR_CODES } from './tool-guidance.ts';
import { boundedToolIssueMessage } from './model-text-budget.ts';

export type NormalizedToolErrorStatus = 'error' | 'aborted' | 'timeout';

export interface NormalizedThrownToolError {
  status: NormalizedToolErrorStatus;
  issue: {
    code: string;
    message: string;
    path?: string;
    retryable?: boolean;
    native_code?: number | string;
    native_reason?: string;
    executable?: string;
    suggested_call?: Record<string, unknown>;
    remedy?: string;
    help?: { tool: string; query: string };
    suggestions?: Array<{ tool: string; purpose: string }>;
    required_allowlist_entry?: string;
  };
}

const NON_RETRYABLE_NATIVE_CODES = new Set([
  'blocked_cmd',
  'blocked_host',
  'cwd_not_directory',
  'cwd_not_found',
  'cwd_outside_roots',
  'executable_not_found',
  'permission_denied',
  'spawn_failed',
  'windows_builtin_requires_cmd',
  'invalid_arguments',
  ...Object.values(READ_PDF_SELECTION_ERROR_CODES),
]);

function snakeCaseCode(code: string): string {
  return code
    // Split a run of capitals before a final capitalized word, so
    // `NotAFile` becomes `not_a_file` rather than `not_afile`.
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

/** Preserve structured native command errors instead of flattening them. */
export function normalizeThrownToolError(error: unknown): NormalizedThrownToolError {
  if (error instanceof Error && error.cause) {
    const cause = error.cause as Record<string, unknown>;
    if (typeof cause.code === 'string') return normalizeThrownToolError(cause);
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return {
      status: 'aborted',
      issue: {
        code: 'aborted',
        message: 'Operation cancelled by user.',
        retryable: false,
      },
    };
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.code === 'string') {
      const code = snakeCaseCode(record.code);
      const payload = record.message;
      let message = typeof payload === 'string' ? payload : record.code;
      let path: string | undefined;
      let nativeCode: number | string | undefined;
      let nativeReason: string | undefined;
      let executable: string | undefined;
      let suggestedCall: Record<string, unknown> | undefined;
      let requiredAllowlistEntry: string | undefined;
      let remedy: string | undefined;
      let help: { tool: string; query: string } | undefined;
      let suggestions: Array<{ tool: string; purpose: string }> | undefined;
      if (payload && typeof payload === 'object') {
        const detail = payload as Record<string, unknown>;
        if (typeof detail.path === 'string') path = detail.path;
        if (typeof detail.native_code === 'number' || typeof detail.native_code === 'string') {
          nativeCode = detail.native_code;
        }
        if (typeof detail.native_reason === 'string') nativeReason = detail.native_reason;
        if (typeof detail.executable === 'string') executable = detail.executable;
        if (detail.suggested_call && typeof detail.suggested_call === 'object' && !Array.isArray(detail.suggested_call)) {
          suggestedCall = detail.suggested_call as Record<string, unknown>;
        }
        if (typeof detail.required_allowlist_entry === 'string') {
          requiredAllowlistEntry = detail.required_allowlist_entry;
        }
        if (typeof detail.remedy === 'string') remedy = detail.remedy;
        if (detail.help && typeof detail.help === 'object' && !Array.isArray(detail.help)) {
          const value = detail.help as Record<string, unknown>;
          if (typeof value.tool === 'string' && typeof value.query === 'string') {
            help = { tool: value.tool, query: value.query };
          }
        }
        if (Array.isArray(detail.suggestions)) {
          suggestions = detail.suggestions
            .filter((value): value is { tool: string; purpose: string } => Boolean(
              value && typeof value === 'object'
              && typeof (value as Record<string, unknown>).tool === 'string'
              && typeof (value as Record<string, unknown>).purpose === 'string',
            ))
            .slice(0, 3);
        }
        const allowed = Array.isArray(detail.allowed_roots)
          ? detail.allowed_roots.filter((root): root is string => typeof root === 'string')
          : [];
        if (code === 'cwd_outside_roots' && path) {
          message = allowed.length > 0
            ? `Working directory ${path} is outside the allowed roots: ${allowed.join(', ')}`
            : `Working directory ${path} is outside the allowed roots.`;
        } else if (code === 'path_outside_roots' && path) {
          message = allowed.length > 0
            ? `${path} is outside the allowed roots: ${allowed.join(', ')}`
            : path;
        } else if (code === 'cwd_not_found' && path) {
          message = `Working directory does not exist: ${path}.${nativeReason ? ` Native error: ${nativeReason}` : ''}`;
        } else if (code === 'cwd_not_directory' && path) {
          message = `Working directory is not a directory: ${path}.`;
        } else if (code === 'executable_not_found') {
          message = `Executable was not found on the child PATH: ${executable ?? '?'}.${nativeReason ? ` Native error: ${nativeReason}` : ''}`;
        } else if (code === 'windows_builtin_requires_cmd') {
          const builtin = typeof detail.builtin === 'string' ? detail.builtin : '?';
          message = `"${builtin}" is a cmd.exe builtin, not a standalone executable. Submit suggested_call as a new approval-controlled call. The cmd executable must be allowlisted.`;
        } else if (code === 'permission_denied') {
          const operation = typeof detail.operation === 'string' ? detail.operation : 'perform operation';
          message = `Permission denied while attempting to ${operation}.${nativeReason ? ` Native error: ${nativeReason}` : ''}`;
        } else if (code === 'spawn_failed') {
          message = `Failed to spawn ${executable ?? '?'}.${nativeReason ? ` Native error: ${nativeReason}` : ''}`;
        }
      }
      const status: NormalizedToolErrorStatus = code === 'aborted'
        ? 'aborted'
        : code === 'timeout'
          ? 'timeout'
          : 'error';
      return {
        status,
        issue: {
          code,
          message: boundedToolIssueMessage(message),
          ...(path ? { path } : {}),
          ...(nativeCode !== undefined ? { native_code: nativeCode } : {}),
          ...(nativeReason ? { native_reason: nativeReason } : {}),
          ...(executable ? { executable } : {}),
          ...(suggestedCall ? { suggested_call: suggestedCall } : {}),
          ...(requiredAllowlistEntry ? { required_allowlist_entry: requiredAllowlistEntry } : {}),
          ...(remedy ? { remedy } : {}),
          ...(help ? { help } : {}),
          ...(suggestions?.length ? { suggestions } : {}),
          retryable: status === 'error' && !NON_RETRYABLE_NATIVE_CODES.has(code),
        },
      };
    }
  }

  const message = boundedToolIssueMessage(error);
  return {
    status: 'error',
    issue: { code: 'handler_exception', message, retryable: true },
  };
}
