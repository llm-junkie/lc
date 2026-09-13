/** Accumulates streaming tool-call deltas into complete tool-call
 *  objects.  Handles out-of-order arrival (by index), late deltas
 *  after finalize (no-op), and missing id/name slots (reported as
 *  structured protocol issues, never silently dropped). */

import { debugLog } from '../../utils/debug.ts';
export interface ToolCallDelta {
  /** Stable across deltas for the same call. May be absent in early deltas. */
  index: number;
  /** Final call id (only present in the first non-empty delta for that index). */
  id?: string;
  type?: 'function';
  function?: {
    /** May arrive in a delta after `id`. */
    name?: string;
    /** Streamed as a JSON-text fragment. Concatenate deltas verbatim. */
    arguments?: string;
  };
}

export interface ToolCallWire {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Structured issue for an incomplete or malformed tool-call slot. */
export interface ToolAccumulatorIssue {
  code: 'incomplete_tool_slot';
  index: number;
  hasId: boolean;
  hasName: boolean;
  message: string;
}

interface InternalSlot {
  id?: string;
  name?: string;
  args: string;
  /** True once args accumulation stopped because of the length cap. */
  argsCapped?: boolean;
}

/**
 * Hard cap on accumulated tool-call argument text per slot. A provider
 * emitting an unbounded argument stream (or many split deltas) cannot grow a
 * slot past this many characters; further fragments are counted and reported
 * as `incomplete_tool_slot` issues at finalize so the loss is explicit, never
 * a silently truncated argument string. The limit is 2,097,152 JavaScript
 * UTF-16 code units (the unit used by `string.length`), far beyond any built-in
 * tool's schema budget.
 */
export const TOOL_CALL_ARGS_MAX_CHARS = 2 * 1024 * 1024;

export class ToolCallAccumulator {
  private readonly buf = new Map<number, InternalSlot>();
  // Set after the first finalize() so late-arriving deltas don't mutate
  // the buffer. See class docstring for the SSE trailing-event edge case.
  #finalized = false;
  #cached: readonly ToolCallWire[] = [];
  /** Protocol issues detected during finalize(). Populated on first call. */
  #issues: readonly ToolAccumulatorIssue[] = [];

  /**
   * Structured issues for incomplete tool-call slots detected during
   * `finalize()`.  Empty if all slots were complete.  Callers should
   * surface these as protocol warnings — they indicate a provider
   * stream that was cut short or emitted malformed events.
   */
  get issues(): readonly ToolAccumulatorIssue[] {
    // Force finalize if not yet done so issues are populated.
    if (!this.#finalized) this.finalize();
    return this.#issues;
  }

  /**
   * Absorb one delta. Concatenates `function.arguments` strings
   * verbatim (per OpenAI spec), captures first-seen `id` and
   * `function.name`. Order-independent — deltas for index=1 may
   * arrive before deltas for index=0; the map is per-index.
   *
   * No-op after `finalize()` has been called.
   */
  ingest(delta: ToolCallDelta): void {
    if (this.#finalized) return;
    const slot = this.buf.get(delta.index) ?? { args: '' };
    if (delta.id && !slot.id) slot.id = delta.id;
    if (delta.function?.name && !slot.name) slot.name = delta.function.name;
    if (delta.function?.arguments) {
      if (slot.argsCapped || slot.args.length >= TOOL_CALL_ARGS_MAX_CHARS) {
        // A non-empty delta arriving at or past the cap means the true
        // stream is larger — mark capped so finalize drops the slot rather
        // than executing a possibly-truncated argument string.
        slot.argsCapped = true;
      } else {
        const fragment = delta.function.arguments;
        const room = TOOL_CALL_ARGS_MAX_CHARS - slot.args.length;
        slot.args += fragment.slice(0, room);
        // The cap is inclusive: accumulated text that lands exactly on it
        // with nothing further is complete and valid. A fragment that had
        // to be truncated, or one arriving after the cap was reached, means
        // the stream continued past it.
        if (fragment.length > room || slot.args.length > TOOL_CALL_ARGS_MAX_CHARS) {
          slot.argsCapped = true;
        }
      }
    }
    this.buf.set(delta.index, slot);
  }

  /**
   * Produce the final ToolCall array sorted by numeric index.
   * Entries missing `id` or `name` are recorded as structured
   * protocol issues (accessible via `this.issues`) and omitted
   * from the returned array. `arguments` defaults to `'{}'`
   * when the accumulated string is empty.
   *
   * Idempotent: a second call returns the same cached array.
   * Post-`finalize` `ingest()` calls are no-ops.
   *
   * The returned array is `Object.freeze`d for defensive immutability.
   */
  finalize(): readonly ToolCallWire[] {
    if (this.#finalized) return this.#cached;

    const issues: ToolAccumulatorIssue[] = [];
    const out: ToolCallWire[] = [];

    // Sort by numeric index (not Map insertion order) so output order
    // is deterministic regardless of delta arrival sequence.
    const sorted = [...this.buf.entries()].sort((a, b) => a[0] - b[0]);
    for (const [index, slot] of sorted) {
      if (!slot.id || !slot.name) {
        const issue: ToolAccumulatorIssue = {
          code: 'incomplete_tool_slot',
          index,
          hasId: !!slot.id,
          hasName: !!slot.name,
          message: `tool_call[${index}] missing ${!slot.id ? 'id' : ''}${!slot.id && !slot.name ? ' and ' : ''}${!slot.name ? 'name' : ''} at stream end — slot dropped`,
        };
        debugLog.warn(`[LC] ${issue.message}`);
        issues.push(issue);
        continue;
      }
      if (slot.argsCapped) {
        const issue: ToolAccumulatorIssue = {
          code: 'incomplete_tool_slot',
          index,
          hasId: true,
          hasName: true,
          message: `tool_call[${index}] argument stream exceeded ${TOOL_CALL_ARGS_MAX_CHARS} characters — the arguments were truncated at the cap and are not valid JSON`,
        };
        debugLog.warn(`[LC] ${issue.message}`);
        issues.push(issue);
        // A capped argument string is not the model's real input. Emitting it
        // would execute a silently truncated call; emitting nothing would
        // pretend the call never happened. Drop the call and surface the issue
        // so the provider's own malformed stream is visible.
        continue;
      }
      out.push({
        id: slot.id,
        type: 'function',
        function: { name: slot.name, arguments: slot.args || '{}' },
      });
    }
    const frozen = Object.freeze(out) as readonly ToolCallWire[];
    this.#cached = frozen;
    this.#issues = Object.freeze(issues) as readonly ToolAccumulatorIssue[];
    this.#finalized = true;
    return frozen;
  }
}
