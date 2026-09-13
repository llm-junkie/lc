/**
 * Pure tool-execution functions. These are the building blocks the
 * `runToolLoop` in `chat-pipeline/orchestrator.ts` composes. They take
 * everything they need as arguments; they have no state, no closures
 * over the chat pipeline, and no awareness of the store. That makes
 * them unit-testable with simple fakes — no React, no `ChatView`,
 * no Tauri runtime.
 *
 *   - `validateToolCalls`: zod-validate each call's `arguments`
 *     against its tool's schema. Returns one entry per call with
 *     either `parsed` (success) or `error` (validation/json failure).
 *   - `resolveHandler`: name → handler lookup with the exposure set.
 *     Returns either the handler or a structured denial reason.
 *   - `executeToolCall`: invoke `handler.run(parsed, ctx)` and time
 *     it. Returns the result record (output string, is_error flag,
 *     duration). The orchestrator owns persistence — we don't write
 *     to the store here.
 */
import type {
  ToolHandler,
  ToolHandlerContext,
  ToolCallRecord,
  ToolResultRecord,
  ToolResultEnvelope,
  ToolResultIssue,
} from './types';
import type { ToolCallWire } from '../llm-client/types';
import { debugLog } from '../../utils/debug.ts';
import { sanitizePathSepWhitespace } from './clean-path.ts';
import { tryParseLenient, type LenientParseResult } from './try-parse-lenient.ts';
import { normalizeThrownToolError } from './tool-error.ts';
import { attachGroupAbort } from './abort-link.ts';
import { recordDiagnosticEvent } from '../../utils/diagnostic-events.ts';
import { addCatalogRecovery, guidanceIssueMessage } from './tool-guidance.ts';
import { unknownOperationalToolIssue } from './tool-name-resolution.ts';
import { normalizeOptionalAbsence } from './argument-normalization.ts';
import { boundedToolIssueMessage } from './model-text-budget.ts';
import { utf8ByteLength } from './utf8-budget.ts';
import {
  duplicateToolCallIdNotice,
  type LcResultNotice,
} from './tool-result-content.ts';
import {
  CANONICAL_TOOL_NAMES,
  durationBucket,
  type CanonicalToolName,
  type PermissionDisposition,
} from '../../utils/support-report-base.ts';

export const INVALID_ARGUMENT_REMEDIES = Object.freeze({
  pathSeparatorWhitespace: 'Remove spaces that touch a path separator, then submit a new call.',
});

/** Default ceiling for one complete serialized tool result. */
export const DEFAULT_SERIALIZED_TOOL_RESULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Larger result ceilings for tools whose documented per-item output can exceed
 * the default. The ceiling still applies to the complete serialized result.
 */
export const SERIALIZED_TOOL_RESULT_MAX_BYTES = Object.freeze({
  lc_read_file: 64 * 1024 * 1024,
  lc_web_fetch: 64 * 1024 * 1024,
  lc_run_shell: 16 * 1024 * 1024,
});

export function serializedToolResultLimitBytes(toolName: string): number {
  return SERIALIZED_TOOL_RESULT_MAX_BYTES[
    toolName as keyof typeof SERIALIZED_TOOL_RESULT_MAX_BYTES
  ] ?? DEFAULT_SERIALIZED_TOOL_RESULT_MAX_BYTES;
}

export function serializeToolResultWithinLimit(
  value: unknown,
  limitBytes: number,
): { output?: string; measuredBytes: number } {
  const output = JSON.stringify(value ?? null);
  const measuredBytes = utf8ByteLength(output);
  return measuredBytes <= limitBytes ? { output, measuredBytes } : { measuredBytes };
}

export function toolResultTooLargeIssue(
  toolName: string,
  measuredBytes: number,
  limitBytes: number,
): ToolResultIssue {
  return {
    code: 'result_too_large',
    message: `The ${toolName} result is ${measuredBytes} UTF-8 bytes. The limit is ${limitBytes} bytes.`,
    retryable: false,
    remedy: 'Narrow the request or split the work into several calls.',
  };
}

/**
 * Map a wire tool name onto LC's finite, LC-owned tool vocabulary. An unknown
 * or user-supplied name never reaches the diagnostic ring as free text.
 */
export function canonicalToolName(name: unknown): CanonicalToolName {
  return typeof name === 'string' && (CANONICAL_TOOL_NAMES as readonly string[]).includes(name)
    ? name as CanonicalToolName
    : 'unknown';
}

/**
 * Record a permission flow that ended without the tool ever executing.
 *
 * A denied or unavailable prompt produces no execution event, so without this
 * the whole flow would be invisible to a report — the exact case the
 * permission diagnostic exists to explain. Nothing about the call is recorded
 * beyond its canonical name and the closed disposition: no arguments, paths,
 * commands, grants, or output.
 */
export function recordBlockedPermission(
  name: unknown,
  reason: 'denied' | 'unavailable' | 'aborted',
): void {
  recordDiagnosticEvent({
    subsystem: 'tool',
    operation: 'permission',
    outcome: reason === 'aborted' ? 'cancelled' : reason === 'denied' ? 'rejected' : 'error',
    code: reason === 'aborted'
      ? 'tool-cancelled'
      : reason === 'denied'
        ? 'tool-permission-denied'
        : 'tool-permission-unavailable',
    tool: canonicalToolName(name),
    permission: reason === 'denied' ? 'denied' : 'unknown',
  });
}
export { type LenientParseResult } from './try-parse-lenient.ts';
export { normalizeOptionalAbsence } from './argument-normalization.ts';
export {
  type DirPermResult,
  checkDirPermission,
  checkDirPermissionForDirs,
  directoryIsTargetTool,
  targetDirsFromArgs,
  targetPathsFromArgs,
} from './check-dir-permission.ts';
export { runWithPool, normalizeConcurrency } from './run-with-pool.ts';

// ═══════════════════════════════════════════════════════════════════
// Phase 2.5 — Per-call budgets (IPC-safe)
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute the remaining budget in milliseconds from an absolute
 * deadline. Returns a non-negative integer suitable for passing to
 * native IPC commands as `timeout_ms`.
 *
 * Phase 2.5 (GPT §6.3): JS owns the monotonic deadline; Rust receives
 * remaining milliseconds. This avoids cross-process clock drift and
 * ensures all sub-operations of one compound tool share one budget.
 *
 * @param deadlineMs Absolute deadline in `Date.now()` epoch milliseconds.
 *                   `undefined` or `0` means no budget — returns the
 *                   provided default.
 * @param defaultMs  Fallback timeout when no deadline is active.
 * @returns Remaining milliseconds, clamped to `[1, defaultMs]`.
 */
export function remainingMs(deadlineMs: number | undefined, defaultMs: number): number {
  if (!deadlineMs || deadlineMs <= 0) return defaultMs;
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) return 1; // already expired — give minimal budget
  return Math.min(remaining, defaultMs);
}

/**
 * Compute a per-call deadline from a conversation-level timeout config.
 * The result is stored on an immutable per-call context so compound tool
 * operations share one deadline.
 */
export function computeDeadlineMs(timeoutMs: number | undefined): number | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  return Date.now() + timeoutMs;
}

/**
 * Map a wire-shape `ToolCallWire` (from the OpenAI-compat stream
 * delta-merge) to the store-shape `ToolCallRecord` (what gets
 * persisted on the assistant message and passed to the runner).
 *
 * Same call, different concerns:
 *   - `ToolCallWire` carries the on-wire shape: `function: { name,
 *     arguments: <json-string> }`. The arguments string is the
 *     verbatim text from the model's stream.
 *   - `ToolCallRecord` carries the store shape: `name` and
 *     `arguments`. `arguments_parsed` is filled lazily by the
 *     runner after zod validation. It carries no execution status —
 *     that lives on the tool-result message.
 *
 * The orchestrator boundary is the only place this conversion
 * happens — runners and tools see `ToolCallRecord`, the wire parser
 * sees `ToolCallWire`, and they meet here.
 */
export function wireToRecord(wire: ToolCallWire): ToolCallRecord {
  // LM Studio (and some other servers) generate malformed JSON in
  // tool-call arguments when Windows paths are involved — they emit
  // "D:\\\DEV" (three backslashes) instead of "D:\\DEV" (two).
  // repairWindowsJson fixes this by doubling every lone backslash.
  // Without this, the broken arguments get stored, sent back in the
  // next request, and LM Studio's own parser returns 500.
  const originalArgs = wire.function.arguments;
  const args = repairWindowsJsonAfterParseFailure(originalArgs);
  if (import.meta.env?.DEV) {
    debugLog.warn(
      `[LC DEBUG] wireToRecord: args ${args === originalArgs ? 'parse OK' : 'repaired'} for`,
      wire.function.name,
      'args preview:',
      args.slice(0, 200),
    );
  }
  return {
    id: wire.id,
    name: wire.function.name,
    arguments: args,
    created_at: Date.now(),
  };
}

/**
 * Recursively walk a parsed object and try to JSON-parse any string
 * values.  Some models double-encode nested objects/arrays:
 *   `{ files: "[{\\"path\\":...}]" }` instead of `{ files: [{...}] }`.
 * The top-level JSON.parse decodes the outer layer, but nested
 * objects stay as strings; Zod then rejects them as type mismatches.
 * This pass unwraps one level of string-encoded JSON per field so
 * the tool schemas actually see the expected shapes.
 */
function deepParseStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) &&
        (trimmed.endsWith('}') || trimmed.endsWith(']'))) {
      try {
        return deepParseStrings(JSON.parse(value));
      } catch { /* not valid JSON, keep as string */ }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(deepParseStrings);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepParseStrings(v);
    }
    return out;
  }
  return value;
}

/**
 * Check every path-like field in a parsed tool-call argument object
 * for stray whitespace around path separators.  Walks the object
 * recursively but does **not** mutate the args — we want the model
 * to learn, not silently patch.
 *
 * Returns the original args unchanged, plus a list of the cleaned
 * (corrected) path strings so the caller can show the model what
 * to use on retry.
 */
export function sanitizeToolArgs(args: unknown): {
  args: unknown;
  correctedPaths: string[];
} {
  const correctedPaths: string[] = [];
  const PATH_KEY = /^(path|paths|file|files|searches|dir|root|roots)$/i;

  /** Walk `value`.  When `isPathCtx` is true, this branch came from
   *  a path-keyed parent — strings are checked, arrays/objects are
   *  recursed.  When false, we're inside a non-path value (e.g.
   *  `content`, `pattern`, `old_string`) — skip entirely. */
  const walk = (value: unknown, isPathCtx: boolean): void => {
    if (typeof value === 'string') {
      if (isPathCtx) {
        // Skip strings that look like JSON-encoded objects/arrays
        // (double-encoding from the model that deepParseStrings
        // couldn't fix).  These are never paths — they're content
        // blobs like write_file's `files` or edit's `files`.
        const t = value.trim();
        if ((t.startsWith('{') || t.startsWith('[')) &&
            (t.endsWith('}') || t.endsWith(']'))) {
          return;
        }
        const corrected = sanitizePathSepWhitespace(value);
        if (corrected !== value) {
          correctedPaths.push(corrected);
        }
      }
      return;
    }
    if (!isPathCtx) return; // don't recurse into non-path structures
    if (Array.isArray(value)) {
      for (const v of value) walk(v, true);
      return;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        const childIsPath = PATH_KEY.test(k);
        if (typeof v === 'string' && childIsPath) {
          walk(v, true);
        } else if (Array.isArray(v) && childIsPath) {
          for (const item of v) walk(item, true);
        } else if (Array.isArray(v)) {
          // Non-path-keyed array (shouldn't normally happen, but
          // be safe): don't recurse into its elements.
        } else if (v && typeof v === 'object') {
          // Only recurse into objects under path keys — e.g. the
          // objects inside `files: [{ path, content }]` where we
          // want to check `path` but skip `content`.
          walk(v, childIsPath);
        }
      }
    }
  };
  walk(args, true);
  return { args, correctedPaths };
}

/* ------------------------------------------------------------------ */
/*  validateToolCalls                                                   */
/* ------------------------------------------------------------------ */

export interface ValidatedCall {
  call: ToolCallRecord;
  parsed?: unknown;
  error?: ToolResultIssue[];
}

/**
 * Turn-scoped admission of tool calls by id.
 *
 * The provider protocol has exactly one result slot per tool_call id, and a
 * replayed id in a later re-stream must not execute again — side effects run
 * exactly once per id per turn. This computes, for one round's calls:
 *
 * - `prunedIndices`: indices of every occurrence that must NOT execute —
 *   ids already answered in an earlier round of this turn, plus the second
 *   and later occurrences of an id inside this round.
 * - `duplicateNotices`: a note per id whose later occurrence was pruned.
 *   Same-batch duplicates put it on the surviving result immediately;
 *   cross-round replays patch the earlier result for the next request that
 *   includes it.
 *
 * The caller prunes the persisted assistant `tool_calls` with
 * `prunedIndices` so the durable graph keeps at most one call and one
 * result per id, and executes only the surviving occurrences.
 */
export function admitToolCallsById(
  calls: readonly ToolCallRecord[],
  alreadyAnsweredIds: ReadonlySet<string>,
): { prunedIndices: ReadonlySet<number>; duplicateNotices: ReadonlyMap<string, LcResultNotice> } {
  const pruned = new Set<number>();
  const notices = new Map<string, LcResultNotice>();
  const seenThisRound = new Set<string>();
  for (let index = 0; index < calls.length; index++) {
    const id = calls[index].id;
    if (alreadyAnsweredIds.has(id) || seenThisRound.has(id)) {
      pruned.add(index);
      if (!notices.has(id)) {
        notices.set(id, alreadyAnsweredIds.has(id)
          ? duplicateToolCallIdNotice(id, 'earlier_round')
          : duplicateToolCallIdNotice(id, 'same_batch'));
      }
      continue;
    }
    seenThisRound.add(id);
  }
  return { prunedIndices: pruned, duplicateNotices: notices };
}

/**
 * Repair Windows-path backslash escaping bugs in JSON argument strings.
 *
 * The pattern doubles every `\` that is not already part of a valid JSON
 * escape (`\\`, `\"`, `\b`, `\f`, `\n`, `\r`, `\t`, `\u`) — a lone
 * backslash before any other character. Because an already-correct JSON
 * string only contains valid escapes and `\\` pairs, the repair is a no-op
 * (idempotent) on well-formed input and fixes the common model output
 * `{"path":"D:\DEV"}` (single backslashes) into `{"path":"D:\\DEV"}`.
 *
 * It must still only run after `JSON.parse` has already failed — the
 * parse-first ordering is the contract, and a future relaxation of the
 * pattern would silently corrupt valid arguments. See
 * docs/tools/tool-error-handling.md#repairwindowsjson-is-only-ever-a-fallback.
 */
export function repairWindowsJson(raw: string): string {
  // Models regularly emit Windows paths with single backslashes in
  // JSON strings (e.g. "D:\DEV\tests").  Some backslashes trigger
  // valid JSON escapes (\n → newline, \t → tab, \u0000 → NUL),
  // while others (\D, \h, \w) are invalid and cause JSON.parse to
  // fail outright.  Doubling every backslash that isn't already
  // part of a valid escape fixes both cases.
  //
  // This must be IDEMPOTENT — running it twice on already-correct
  // JSON (e.g. "D:\\DEV") must NOT corrupt it into "D:\\\DEV".
  // (?<!\\) ensures we skip the second \ in a \\ pair.
  return raw.replace(/(?<!\\)\\(?![\\"/bfnrtu])/g, '\\\\');
}

/**
 * The sole production gate for Windows JSON repair: parse first and return the
 * exact original string when it is already valid. Keeping the ordering in one
 * helper prevents future call sites from treating a destructive repair as a
 * normalizer.
 */
export function repairWindowsJsonAfterParseFailure(raw: string): string {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return repairWindowsJson(raw);
  }
}

// tryParseLenient and LenientParseResult are imported from ./try-parse-lenient.ts
// and shared by the tool runner and path-safety boundary.

/**
 * Validate every tool_call's `arguments` JSON against the tool's
 * zod input schema. Each input is a separate `safeParse` — a single
 * bad arg doesn't poison the others.
 *
 * The output array has one entry per input call (same order). The
 * caller iterates and dispatches: `error` → write a denial-result
 * tool message so the model can self-correct; `parsed` → resolve
 * handler and execute.
 *
 * Failures we surface as `error` (not throw):
 *   - `unknown_tool`: name not in the handler map. The model
 *     invented a name or the registry is stale.
 *   - `invalid_arguments`: JSON is malformed or the parsed value fails
 *     the tool schema. The issue message includes the correction details.
 */
export function validateToolCalls<I, O>(
  calls: ToolCallRecord[],
  handlers: ReadonlyMap<string, ToolHandler<I, O>>,
  exposedNames: ReadonlySet<string> = new Set(handlers.keys()),
): ValidatedCall[] {
  const validationMessage = (toolName: string, detail: string): string => {
    const catalogMessage = guidanceIssueMessage(toolName, 'invalid_arguments');
    return boundedToolIssueMessage(catalogMessage ? `${catalogMessage} Details: ${detail}` : detail);
  };

  return calls.map((call) => {
    const handler = handlers.get(call.name);
    if (!handler) {
      return {
        call,
        error: [unknownOperationalToolIssue(call.name, exposedNames)],
      };
    }
    let parsed: unknown = undefined;
    let corrected = false;

    const tryParse = (raw: string): LenientParseResult | null => {
      if (!raw || raw.length === 0) return { value: {}, corrected: false };
      const res = tryParseLenient(raw);
      if (res) {
        return {
          value: normalizeOptionalAbsence(res.value, handler.toJsonSchema(), handler.name) ?? {},
          corrected: res.corrected,
        };
      }
      return null;
    };

    {
      const result = tryParse(call.arguments);
      if (result) {
        parsed = result.value;
        corrected = result.corrected;
      }
    }
    debugLog.log(`[LC] raw args for ${call.name}:`, call.arguments);

    // Windows path backslash-escaping bug: models often write malformed JSON
    // with lone path backslashes. Repair is permitted only after raw JSON.parse
    // fails; schema failure on otherwise valid JSON is not a repair signal.
    const needsRepair = parsed === undefined;
    if (needsRepair) {
      const repaired = tryParse(repairWindowsJsonAfterParseFailure(call.arguments));
      if (repaired) {
        parsed = repaired.value;
        corrected = repaired.corrected;
      }
    }
    if (parsed === undefined) {
      // Still unparseable — give the model the original error.
      try { JSON.parse(call.arguments); } catch (e) {
        return {
          call,
          error: [addCatalogRecovery(call.name, {
            code: 'invalid_arguments',
            message: validationMessage(
              call.name,
              `Arguments are not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
            ),
            retryable: false,
          })],
        };
      }
      return {
        call,
        error: [addCatalogRecovery(call.name, {
          code: 'invalid_arguments',
          message: validationMessage(call.name, 'Arguments could not be parsed as JSON.'),
          retryable: false,
        })],
      };
    }

    // Lenient structural correction (for example, trimming trailing junk)
    // must not execute silently. Return the exact corrected JSON so the model
    // retries with valid input. The Windows-backslash fallback above is a
    // separate, parse-failure-only compatibility repair: it intentionally
    // becomes normal input here (and is commonly already repaired by
    // wireToRecord) so permission displays and execution use the real path.
    if (corrected) {
      const correctedJson = JSON.stringify(parsed);
      return {
        call,
        error: [addCatalogRecovery(call.name, {
          code: 'invalid_arguments',
          message: validationMessage(
            call.name,
            `Arguments were malformed and were repaired from:\n\n${call.arguments}\n\nto:\n\n${correctedJson}\n\nPlease retry with the corrected JSON exactly as shown above.`,
          ),
          retryable: false,
          suggested_call: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined,
        })],
      };
    }

    // Models sometimes insert extra spaces around path separators
    // (e.g. "C:\\temp\\what \\file.png").  Check for this and
    // return an error with the corrected paths so the model
    // learns the right format — rather than silently fixing.
    const checked = sanitizeToolArgs(parsed);
    if (checked.correctedPaths.length > 0) {
      const correctionMsg =
        'path_malformed: stray space(s) next to \\ or / in ' +
        'your path(s). Remove all spaces that touch a path ' +
        'separator. The correct paths are:\n  ' +
        checked.correctedPaths.map((p) => `"${p}"`).join('\n  ') +
        '\n\nRetry with these exact paths.';
      return { call, error: [addCatalogRecovery(call.name, {
        code: 'invalid_arguments',
        message: boundedToolIssueMessage(correctionMsg),
        retryable: false,
        remedy: INVALID_ARGUMENT_REMEDIES.pathSeparatorWhitespace,
      })] };
    }
    // parsed is unchanged (sanitizeToolArgs only detects, doesn't mutate).

    // 1st attempt: validate the args exactly as the model sent them.
    let result = handler.input.safeParse(parsed);

    // Fallback ONLY on failure: some models double-encode nested
    // objects/arrays as JSON strings (e.g. files: "[{...}]" instead
    // of files: [{...}]). Never applied when the raw shape is already
    // valid — so write_file content that *is* a JSON document stays
    // a string. This was previously unconditional and corrupted
    // legitimate JSON file content.
    if (!result.success) {
      const repaired = normalizeOptionalAbsence(
        deepParseStrings(parsed),
        handler.toJsonSchema(),
        handler.name,
      );
      const retry = handler.input.safeParse(repaired);
      if (retry.success) {
        result = retry;
      }
    }

    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message.trim()}`)
        .reduce((combined, issue) => (
          combined
            ? `${combined}${/[.!?]$/u.test(combined) ? ' ' : '. '}${issue}`
            : issue
        ), '');
      const numericCorrection = result.error.issues.length === 1
        ? correctedNumericCall(parsed, result.error.issues[0])
        : undefined;
      return {
        call,
        error: [addCatalogRecovery(call.name, {
          code: 'invalid_arguments',
          message: validationMessage(call.name, `Tool arguments failed validation: ${issues}`),
          retryable: false,
          ...(numericCorrection ? { suggested_call: numericCorrection } : {}),
        })],
      };
    }
    return { call, parsed: result.data };
  });
}

function correctedNumericCall(
  parsed: unknown,
  issue: { path: PropertyKey[]; code: string; maximum?: unknown; inclusive?: unknown },
): Record<string, unknown> | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  if (issue.code !== 'too_big' || typeof issue.maximum !== 'number' || issue.inclusive !== true) return undefined;
  if (issue.path.length === 0) return undefined;
  const copy = structuredClone(parsed) as Record<string, unknown>;
  let target: unknown = copy;
  for (let index = 0; index < issue.path.length - 1; index += 1) {
    const key = issue.path[index];
    if (!target || typeof target !== 'object') return undefined;
    target = (target as Record<PropertyKey, unknown>)[key];
  }
  const finalKey = issue.path[issue.path.length - 1];
  if (!target || typeof target !== 'object') return undefined;
  const current = (target as Record<PropertyKey, unknown>)[finalKey];
  if (typeof current !== 'number') return undefined;
  (target as Record<PropertyKey, unknown>)[finalKey] = issue.maximum;
  return copy;
}

/* ------------------------------------------------------------------ */
/*  resolveHandler                                                      */
/* ------------------------------------------------------------------ */

export type ResolveResult =
  | ToolHandler
  | { denied: true; reason: 'not_exposed' | 'unknown_tool' };

/**
 * Look up the handler for a tool name. The denial reasons are the
 * two cases where the caller should write a structured tool denial
 * result instead of executing:
 *
 *   - `not_exposed`: the tool's **category toggle is off**.  In LC's
 *     policy model this means: not exposed, no popup, no grant
 *     applies.  The `enabledTools` set is populated from
 *     `resolveExposure()` (Workspace and category membership — checkmarks and
 *     `dir_permissions` never remove a tool from this set).  So
 *     `not_exposed` here always means "category off."
 *
 *     Exposed-but-unchecked tools (category ON, checkbox OFF) ARE
 *     in `enabledTools` and pass through to the orchestrator, which
 *     routes them through the permission popup.  `resolveHandler`
 *     never sees that case — its only job is category admission.
 *
 *   - `unknown_tool`: name isn't in the registry. Should be rare —
 *     `validateToolCalls` already catches this for the case where
 *     the name doesn't exist at all. Kept here as belt-and-braces
 *     in case `enabledTools` was filtered and we now lack a handler.
 *
 * Precedence:
 *   1. unknown_tool → deny.
 *   2. not_exposed → deny.
 *   3. otherwise → return the handler.
 */
export function resolveHandler(
  call: ToolCallRecord,
  enabledTools: Set<string>,
  handlers: Map<string, ToolHandler>,
): ResolveResult {
  const handler = handlers.get(call.name);
  if (!handler) return { denied: true, reason: 'unknown_tool' };
  if (!enabledTools.has(call.name)) {
    return { denied: true, reason: 'not_exposed' };
  }
  return handler;
}

/* ------------------------------------------------------------------ */
/*  executeToolCall                                                     */
/* ------------------------------------------------------------------ */

/**
 * Phase 2.4: Detect if a value is a ToolResultEnvelope (duck-type check).
 */
function isEnvelope(v: unknown): v is ToolResultEnvelope {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.status === 'string'
    && Array.isArray(o.issues)
    && Array.isArray(o.warnings);
}

/**
 * Phase 2.4: Extract the first issue with a given code from an envelope.
 * Used by the orchestrator to detect `path_outside_roots` etc. without
 * string-scraping.
 */
export function getEnvelopeIssue(env: ToolResultEnvelope, code: string): ToolResultIssue | undefined {
  return env.issues.find(i => i.code === code);
}

/**
 * Phase 2.4: Extract a path from the first issue matching a code.
 * Returns undefined if no matching issue or the issue has no path.
 */
export function getEnvelopePath(env: ToolResultEnvelope, code: string): string | undefined {
  return getEnvelopeIssue(env, code)?.path;
}

/**
 * Run a single validated tool call. Returns the result record the
 * orchestrator will persist as a `role: 'tool'` message. We don't
 * write to the store here — persistence is the orchestrator's job.
 *
 * Phase 2.4: When the handler returns a `ToolResultEnvelope`, the
 * envelope is serialized as the output string and `is_error` is
 * derived from `status`. Plain successful handler return values are
 * serialized as JSON with `is_error: false`.
 *
 * Error handling: handler exceptions become a `ToolResultEnvelope`
 * with `status: 'error'` and a single issue describing the thrown value.
 */
export async function executeToolCall(
  call: ToolCallRecord,
  parsed: unknown,
  handler: ToolHandler,
  ctx: ToolHandlerContext,
  /**
   * The authoritative disposition that allowed this execution. It rides on the
   * execution event itself so the permission a report shows always belongs to
   * the execution beside it, rather than to whichever permission event happened
   * to be recorded most recently.
   */
  permission: PermissionDisposition = 'unknown',
): Promise<Omit<ToolResultRecord, 'tool_call_id'>> {
  // `call` is part of the API contract (matches the plan §5.2
  // signature) but the current implementation only needs the
  // pre-validated args + handler + ctx. Kept for forward-compat —
  // a future version may include per-call retry/backoff logic that
  // branches on `call.id` or `call.name`.
  void call;
  const start = performance.now();
  const detachAbort = attachGroupAbort(ctx.signal, ctx.identity.groupId, ctx.sandbox.abortGroup);
  try {
    if (ctx.signal.aborted) {
      throw { code: 'Aborted', message: 'Operation cancelled by user.' };
    }
    const output = await handler.run(parsed, ctx);

    // Phase 2.4: Detect envelope-style returns.
    if (isEnvelope(output)) {
      const env = output as ToolResultEnvelope;
      const limitBytes = serializedToolResultLimitBytes(handler.name);
      const serialized = serializeToolResultWithinLimit(env, limitBytes);
      if (serialized.output === undefined) {
        const durationMs = Math.round(performance.now() - start);
        const bounded: ToolResultEnvelope = {
          status: 'error',
          issues: [toolResultTooLargeIssue(handler.name, serialized.measuredBytes, limitBytes)],
          warnings: [],
          metrics: { durationMs },
        };
        recordDiagnosticEvent({
          subsystem: 'tool',
          operation: 'execute',
          outcome: 'error',
          code: 'tool-result-error',
          tool: canonicalToolName(call.name),
          permission,
          durationBucket: durationBucket(performance.now() - start),
        });
        return {
          output: JSON.stringify(bounded),
          is_error: true,
          duration_ms: durationMs,
        };
      }
      const stringified = serialized.output;
      recordDiagnosticEvent({
        subsystem: 'tool',
        operation: 'execute',
        outcome: env.status === 'ok' ? 'ok' : env.status === 'aborted' ? 'cancelled' : 'error',
        code: env.status === 'ok' ? 'tool-result-ok' : env.status === 'aborted' ? 'tool-cancelled' : 'tool-result-error',
        tool: canonicalToolName(call.name),
        permission,
        durationBucket: durationBucket(performance.now() - start),
      });
      if (import.meta.env?.DEV) {
        debugLog.warn('[LC DEBUG] executeToolCall (envelope):', call.name,
          'status:', env.status, 'len:', stringified.length);
      }
      return {
        output: stringified,
        is_error: env.status !== 'ok',
        duration_ms: Math.round(performance.now() - start),
      };
    }

    // Plain successful handler return value.
    const limitBytes = serializedToolResultLimitBytes(handler.name);
    const serialized = serializeToolResultWithinLimit(output, limitBytes);
    if (serialized.output === undefined) {
      const durationMs = Math.round(performance.now() - start);
      const bounded: ToolResultEnvelope = {
        status: 'error',
        issues: [toolResultTooLargeIssue(handler.name, serialized.measuredBytes, limitBytes)],
        warnings: [],
        metrics: { durationMs },
      };
      recordDiagnosticEvent({
        subsystem: 'tool',
        operation: 'execute',
        outcome: 'error',
        code: 'tool-result-error',
        tool: canonicalToolName(call.name),
        permission,
        durationBucket: durationBucket(performance.now() - start),
      });
      return {
        output: JSON.stringify(bounded),
        is_error: true,
        duration_ms: durationMs,
      };
    }
    const stringified = serialized.output;
    recordDiagnosticEvent({
      subsystem: 'tool',
      operation: 'execute',
      outcome: 'ok',
      code: 'tool-result-ok',
      tool: canonicalToolName(call.name),
      permission,
      durationBucket: durationBucket(performance.now() - start),
    });
    if (import.meta.env?.DEV) {
      debugLog.warn('[LC DEBUG] executeToolCall:', call.name, 'output type:', typeof output, 'stringified len:', stringified.length);
      debugLog.warn('[LC DEBUG] executeToolCall:', call.name, 'stringified preview:', stringified.slice(0, 500));
    }
    return {
      output: stringified,
      is_error: false,
      duration_ms: Math.round(performance.now() - start),
    };
  } catch (e) {
    const durationMs = Math.round(performance.now() - start);
    const normalized = normalizeThrownToolError(e);
    const issue = addCatalogRecovery(call.name, normalized.issue);
    const env: ToolResultEnvelope = {
      status: normalized.status,
      issues: [issue],
      warnings: [],
      metrics: { durationMs },
    };
    recordDiagnosticEvent({
      subsystem: 'tool',
      operation: 'execute',
      outcome: normalized.status === 'aborted' ? 'cancelled' : 'error',
      code: normalized.status === 'aborted' ? 'tool-cancelled' : 'tool-result-error',
      tool: canonicalToolName(call.name),
      permission,
      durationBucket: durationBucket(performance.now() - start),
      description: e,
    });

    return {
      output: JSON.stringify(env),
      is_error: true,
      duration_ms: durationMs,
    };
  } finally {
    detachAbort();
  }
}

/* ------------------------------------------------------------------ */
/*  runWithPool                                                         */
/* ------------------------------------------------------------------ */

/**
 * Execute items with bounded concurrency. Results are indexed by
 * position (not completion order), so `tool_call_id` round-trips
 * correctly.
 *
 * `onItem` fires synchronously after each item completes, while the
 * pool is still running. This lets callers persist / display results
 * immediately rather than waiting for all items to finish.
 */
// runWithPool is imported from ./run-with-pool.ts and re-exported above.
