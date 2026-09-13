/**
 * Pure lc_whiteboard schema, exact-edit engine, and tool handler.
 *
 * Persistence and generation ownership are supplied through the typed
 * Whiteboard capability on ToolHandlerContext. This module intentionally has
 * no React, IndexedDB, or native-sandbox dependency.
 */

import { z } from 'zod';
import type { JsonSchema } from '../llm-client/types';
import type { WhiteboardTurnReferences } from '../../types';
import { WHITEBOARD_ISSUE_MESSAGES, addCatalogRecovery } from './tool-guidance.ts';
import { takeUtf8Prefix, utf8ByteLength } from './utf8-budget.ts';
import type {
  ToolHandler,
  ToolHandlerContext,
  ToolResultIssue,
  ToolStatus,
  WhiteboardToolServiceErrorCode,
  WhiteboardToolSnapshot,
} from './types';

export const WHITEBOARD_TOOL_NAME = 'lc_whiteboard';
export const WHITEBOARD_MAX_BYTES = 32 * 1024;
export const WHITEBOARD_DIAGNOSTIC_ITEM_LIMIT = 3;
export const WHITEBOARD_DIAGNOSTIC_ITEM_MAX_BYTES = 160;

const ACTION_DESCRIPTION =
  'Select one form. Read uses action only. Replace adds content. Edit adds old_string and new_string.';
const CONTENT_DESCRIPTION =
  'For replace only, send the complete model-board Markdown. An empty string clears the board.';
const OLD_STRING_DESCRIPTION =
  'For edit only, send one non-empty exact string that occurs once in the model board.';
const NEW_STRING_DESCRIPTION =
  'For edit only, send the exact replacement. An empty string deletes the matched text.';

export const WHITEBOARD_TOTAL_MISS_REMEDY =
  'The first line of old_string did not match a line in the model board. ' +
  'Call lc_whiteboard with action read before you retry the edit.';

export const WHITEBOARD_INPUT_SCHEMA = z.object({
  action: z.enum(['read', 'replace', 'edit']).describe(ACTION_DESCRIPTION),
  content: z.string().optional().describe(CONTENT_DESCRIPTION),
  old_string: z.string().optional().describe(OLD_STRING_DESCRIPTION),
  new_string: z.string().optional().describe(NEW_STRING_DESCRIPTION),
}).strict().superRefine((input, context) => {
  const hasContent = input.content !== undefined;
  const oldString = input.old_string;
  const hasOldString = oldString !== undefined;
  const hasNewString = input.new_string !== undefined;

  if (input.action === 'read') {
    if (hasContent || hasOldString || hasNewString) {
      context.addIssue({
        code: 'custom',
        message: 'read accepts only action. Remove content, old_string, and new_string.',
      });
    }
    return;
  }

  if (input.action === 'replace') {
    if (!hasContent) {
      context.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'replace requires content. Send the complete model-board Markdown.',
      });
    }
    if (hasOldString || hasNewString) {
      context.addIssue({
        code: 'custom',
        message: 'replace accepts no edit fields. Remove old_string and new_string.',
      });
    }
    return;
  }

  if (!hasOldString) {
    context.addIssue({
      code: 'custom',
      path: ['old_string'],
      message: 'edit requires old_string. Send one non-empty exact match.',
    });
  } else if (oldString.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['old_string'],
      message: 'old_string must be non-empty. Whitespace-only exact matches are valid.',
    });
  }
  if (!hasNewString) {
    context.addIssue({
      code: 'custom',
      path: ['new_string'],
      message: 'edit requires new_string. Use an empty string to delete the match.',
    });
  }
  if (hasContent) {
    context.addIssue({
      code: 'custom',
      message: 'edit accepts no content field. Remove content.',
    });
  }
});

export type WhiteboardInput = z.infer<typeof WHITEBOARD_INPUT_SCHEMA>;

export interface WhiteboardReadOutput {
  refs: WhiteboardTurnReferences;
  user_markdown: string;
  model_markdown: string;
}

export interface WhiteboardMutationOutput {
  refs: WhiteboardTurnReferences;
  changed: boolean;
  model_bytes: number;
}

export type WhiteboardOutput = WhiteboardReadOutput | WhiteboardMutationOutput;

export type WhiteboardToolIssue = Omit<ToolResultIssue, 'suggestions'> & {
  /** Exact model-board candidates; never contains user-board text. */
  suggestions?: string[];
  occurrence_count?: number;
  excerpts?: string[];
  limit_bytes?: number;
  measured_bytes?: number;
};

export interface WhiteboardToolEnvelope<T = WhiteboardOutput> {
  status: ToolStatus;
  data?: T;
  issues: WhiteboardToolIssue[];
  warnings: string[];
}

export const WHITEBOARD_ISSUES = Object.freeze({
  invalid_arguments: Object.freeze({
    code: 'invalid_arguments',
    retryable: false,
    message: WHITEBOARD_ISSUE_MESSAGES.invalid_arguments,
  }),
  whiteboard_not_initialized: Object.freeze({
    code: 'whiteboard_not_initialized',
    retryable: true,
    message: WHITEBOARD_ISSUE_MESSAGES.whiteboard_not_initialized,
  }),
  whiteboard_version_missing: Object.freeze({
    code: 'whiteboard_version_missing',
    retryable: false,
    message: WHITEBOARD_ISSUE_MESSAGES.whiteboard_version_missing,
  }),
  whiteboard_read_failed: Object.freeze({
    code: 'whiteboard_read_failed',
    retryable: true,
    message: WHITEBOARD_ISSUE_MESSAGES.whiteboard_read_failed,
  }),
  whiteboard_write_failed: Object.freeze({
    code: 'whiteboard_write_failed',
    retryable: true,
    message: WHITEBOARD_ISSUE_MESSAGES.whiteboard_write_failed,
  }),
  whiteboard_old_string_not_found: Object.freeze({
    code: 'whiteboard_old_string_not_found',
    retryable: false,
    message: WHITEBOARD_ISSUE_MESSAGES.whiteboard_old_string_not_found,
  }),
  whiteboard_old_string_not_unique: Object.freeze({
    code: 'whiteboard_old_string_not_unique',
    retryable: false,
    message: WHITEBOARD_ISSUE_MESSAGES.whiteboard_old_string_not_unique,
  }),
  whiteboard_too_large: Object.freeze({
    code: 'whiteboard_too_large',
    retryable: false,
    message: WHITEBOARD_ISSUE_MESSAGES.whiteboard_too_large,
  }),
  whiteboard_batch_conflict: Object.freeze({
    code: 'whiteboard_batch_conflict',
    retryable: false,
    message: WHITEBOARD_ISSUE_MESSAGES.whiteboard_batch_conflict,
  }),
  aborted: Object.freeze({
    code: 'aborted',
    retryable: false,
    message: WHITEBOARD_ISSUE_MESSAGES.aborted,
  }),
} as const);

type WhiteboardIssueCode = keyof typeof WHITEBOARD_ISSUES;

export type ExactWhiteboardEditResult =
  | { kind: 'changed'; content: string }
  | { kind: 'unchanged'; content: string }
  | { kind: 'not-found'; suggestions: string[]; totalMiss: boolean }
  | { kind: 'not-unique'; occurrences: number; excerpts: string[] };

interface LineSlice {
  start: number;
  end: number;
  text: string;
}

function lineSlices(text: string): LineSlice[] {
  const lines: LineSlice[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    lines.push({ start, end: index, text: text.slice(start, index) });
    start = index + 1;
  }
  lines.push({ start, end: text.length, text: text.slice(start) });
  return lines;
}

function boundedUnique(items: Iterable<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const bounded = takeUtf8Prefix(item, WHITEBOARD_DIAGNOSTIC_ITEM_MAX_BYTES);
    if (seen.has(bounded)) continue;
    seen.add(bounded);
    result.push(bounded);
    if (result.length === WHITEBOARD_DIAGNOSTIC_ITEM_LIMIT) break;
  }
  return result;
}

function matchingBlocks(
  current: string,
  requested: string,
  normalize: (line: string) => string,
): string[] {
  const currentLines = lineSlices(current);
  const requestedLines = lineSlices(requested).map((line) => normalize(line.text));
  if (requestedLines.length > currentLines.length) return [];

  // KMP keeps diagnostics linear even when a large whitespace-only pattern
  // can begin at nearly every line. The prior window-by-window comparison
  // could become quadratic and materialize thousands of large candidates.
  const prefixLengths = new Array<number>(requestedLines.length).fill(0);
  for (let index = 1, matched = 0; index < requestedLines.length; index += 1) {
    while (matched > 0 && requestedLines[index] !== requestedLines[matched]) {
      matched = prefixLengths[matched - 1];
    }
    if (requestedLines[index] === requestedLines[matched]) matched += 1;
    prefixLengths[index] = matched;
  }

  const matches: string[] = [];
  let matched = 0;
  for (let index = 0; index < currentLines.length; index += 1) {
    const currentLine = normalize(currentLines[index].text);
    while (matched > 0 && currentLine !== requestedLines[matched]) {
      matched = prefixLengths[matched - 1];
    }
    if (currentLine === requestedLines[matched]) matched += 1;
    if (matched !== requestedLines.length) continue;

    const start = index - requestedLines.length + 1;
    const first = currentLines[start];
    const last = currentLines[index];
    matches.push(current.slice(first.start, last.end));
    if (matches.length === WHITEBOARD_DIAGNOSTIC_ITEM_LIMIT) break;
    matched = prefixLengths[matched - 1];
  }
  return boundedUnique(matches);
}

/** Deterministic, TypeScript-only suggestions for a failed exact edit. */
export function diagnoseWhiteboardEditNotFound(current: string, oldString: string): {
  suggestions: string[];
  totalMiss: boolean;
} {
  const trailingWhitespace = (line: string) => line.trimEnd();
  const trailingMatches = matchingBlocks(current, oldString, trailingWhitespace);
  if (trailingMatches.length > 0) {
    return { suggestions: trailingMatches, totalMiss: false };
  }

  const surroundingWhitespace = (line: string) => line.trim();
  const surroundingMatches = matchingBlocks(current, oldString, surroundingWhitespace);
  if (surroundingMatches.length > 0) {
    return { suggestions: surroundingMatches, totalMiss: false };
  }

  const requestedFirstLine = surroundingWhitespace(lineSlices(oldString)[0].text);
  const firstLineMatches = boundedUnique(
    lineSlices(current)
      .filter((line) => surroundingWhitespace(line.text) === requestedFirstLine)
      .map((line) => line.text),
  );
  return {
    suggestions: firstLineMatches,
    totalMiss: firstLineMatches.length === 0,
  };
}

function occurrenceExcerpt(content: string, index: number): string {
  const lineStart = index === 0 ? 0 : content.lastIndexOf('\n', index - 1) + 1;
  const prior = content.slice(0, lineStart);
  const line = prior.length === 0 ? 1 : prior.split('\n').length;
  const column = Array.from(content.slice(lineStart, index)).length + 1;
  const prefix = `line ${line}, column ${column}: `;
  const budget = Math.max(0, WHITEBOARD_DIAGNOSTIC_ITEM_MAX_BYTES - utf8ByteLength(prefix));
  return prefix + takeUtf8Prefix(content.slice(index), budget);
}

/** Apply an exact one-occurrence edit without interpreting Markdown. */
export function applyExactWhiteboardEdit(
  current: string,
  oldString: string,
  newString: string,
): ExactWhiteboardEditResult {
  if (oldString.length === 0) {
    throw new RangeError('oldString must be non-empty.');
  }

  const first = current.indexOf(oldString);
  if (first < 0) {
    const diagnostic = diagnoseWhiteboardEditNotFound(current, oldString);
    return { kind: 'not-found', ...diagnostic };
  }

  const positions = [first];
  let cursor = first + 1;
  while (cursor <= current.length - oldString.length) {
    const next = current.indexOf(oldString, cursor);
    if (next < 0) break;
    positions.push(next);
    cursor = next + 1;
  }
  if (positions.length > 1) {
    return {
      kind: 'not-unique',
      occurrences: positions.length,
      excerpts: positions
        .slice(0, WHITEBOARD_DIAGNOSTIC_ITEM_LIMIT)
        .map((position) => occurrenceExcerpt(current, position)),
    };
  }

  const content = current.slice(0, first) + newString + current.slice(first + oldString.length);
  return content === current
    ? { kind: 'unchanged', content }
    : { kind: 'changed', content };
}

function ok<T>(data: T): WhiteboardToolEnvelope<T> {
  return { status: 'ok', data, issues: [], warnings: [] };
}

function issueWithRecovery(code: WhiteboardIssueCode): WhiteboardToolIssue {
  const recovered = addCatalogRecovery(
    WHITEBOARD_TOOL_NAME,
    { ...WHITEBOARD_ISSUES[code] },
  );
  const { suggestions: _toolNameSuggestions, ...issue } = recovered;
  return issue;
}

function failed<T = never>(issue: WhiteboardToolIssue): WhiteboardToolEnvelope<T> {
  return {
    status: issue.code === 'aborted' ? 'aborted' : 'error',
    issues: [issue],
    warnings: [],
  };
}

function serviceFailure<TOutput = never>(
  result: { ok: false; code: WhiteboardToolServiceErrorCode },
): WhiteboardToolEnvelope<TOutput> {
  return failed(issueWithRecovery(result.code));
}

function readOutput(snapshot: WhiteboardToolSnapshot): WhiteboardReadOutput {
  return {
    refs: snapshot.refs,
    user_markdown: snapshot.userMarkdown,
    model_markdown: snapshot.modelMarkdown,
  };
}

async function readVisibleState(context: ToolHandlerContext): Promise<
  | { ok: true; snapshot: WhiteboardToolSnapshot }
  | { ok: false; envelope: WhiteboardToolEnvelope }
> {
  if (context.signal.aborted) {
    return { ok: false, envelope: failed(issueWithRecovery('aborted')) };
  }
  if (!context.whiteboard) {
    return { ok: false, envelope: failed(issueWithRecovery('whiteboard_not_initialized')) };
  }
  try {
    const result = await context.whiteboard.read({ signal: context.signal });
    if (result.ok === false) return { ok: false, envelope: serviceFailure(result) };
    if (context.signal.aborted) {
      return { ok: false, envelope: failed(issueWithRecovery('aborted')) };
    }
    return { ok: true, snapshot: result.value };
  } catch {
    const code: WhiteboardToolServiceErrorCode = context.signal.aborted
      ? 'aborted'
      : 'whiteboard_read_failed';
    return { ok: false, envelope: failed(issueWithRecovery(code)) };
  }
}

async function replaceModel(
  context: ToolHandlerContext,
  current: WhiteboardToolSnapshot,
  content: string,
): Promise<WhiteboardToolEnvelope<WhiteboardMutationOutput>> {
  const measuredBytes = utf8ByteLength(content);
  if (measuredBytes > WHITEBOARD_MAX_BYTES) {
    return failed({
      ...issueWithRecovery('whiteboard_too_large'),
      limit_bytes: WHITEBOARD_MAX_BYTES,
      measured_bytes: measuredBytes,
    });
  }

  if (content === current.modelMarkdown) {
    return ok({
      refs: current.refs,
      changed: false,
      model_bytes: measuredBytes,
    });
  }

  if (context.signal.aborted) return failed(issueWithRecovery('aborted'));
  try {
    const result = await context.whiteboard!.replaceModel({
      content,
      toolCallId: context.identity.modelToolCallId,
      signal: context.signal,
    });
    if (result.ok === false) return serviceFailure<WhiteboardMutationOutput>(result);
    return ok({
      refs: result.value.refs,
      changed: result.value.changed,
      model_bytes: utf8ByteLength(result.value.modelMarkdown),
    });
  } catch {
    const code: WhiteboardToolServiceErrorCode = context.signal.aborted
      ? 'aborted'
      : 'whiteboard_write_failed';
    return failed(issueWithRecovery(code));
  }
}

const CACHED_SCHEMA = Object.freeze(WHITEBOARD_INPUT_SCHEMA.toJSONSchema()) as unknown as JsonSchema;

export const whiteboard: ToolHandler<WhiteboardInput, WhiteboardToolEnvelope> = {
  name: WHITEBOARD_TOOL_NAME,
  description:
    'Read both conversation boards or change only the model board.\n' +
    'Send one whiteboard call per batch and wait for its result.\n' +
    'Read before mutation only when you do not know the current exact model content.\n' +
    'The user board is fixed for this turn.\n' +
    'Model reads include your latest applied change in this turn.\n' +
    'Each board has a 32 KiB UTF-8 limit.',
  uiDescription: 'Read both conversation boards or change the model board.',
  input: WHITEBOARD_INPUT_SCHEMA,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (untrustedInput, context) => {
    const parsed = WHITEBOARD_INPUT_SCHEMA.safeParse(untrustedInput);
    if (!parsed.success) return failed(issueWithRecovery('invalid_arguments'));

    const visible = await readVisibleState(context);
    if (visible.ok === false) return visible.envelope;
    if (parsed.data.action === 'read') return ok(readOutput(visible.snapshot));

    if (parsed.data.action === 'replace') {
      return replaceModel(context, visible.snapshot, parsed.data.content!);
    }

    const edit = applyExactWhiteboardEdit(
      visible.snapshot.modelMarkdown,
      parsed.data.old_string!,
      parsed.data.new_string!,
    );
    if (edit.kind === 'not-found') {
      const issue = issueWithRecovery('whiteboard_old_string_not_found');
      return failed({
        ...issue,
        ...(edit.totalMiss
          ? {
              remedy: WHITEBOARD_TOTAL_MISS_REMEDY,
            }
          : {}),
        suggestions: edit.suggestions,
      });
    }
    if (edit.kind === 'not-unique') {
      return failed({
        ...issueWithRecovery('whiteboard_old_string_not_unique'),
        occurrence_count: edit.occurrences,
        excerpts: edit.excerpts,
      });
    }
    return replaceModel(context, visible.snapshot, edit.content);
  },
};
