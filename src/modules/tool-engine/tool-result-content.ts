import type { ToolResultEnvelope } from './types';

export const MAX_STORED_TOOL_RESULT_BYTES = 64 * 1024;
export const MAX_LEADING_LC_RESULT_NOTICES = 256;

declare const lcResultNoticeBrand: unique symbol;
export type LcResultNotice = string & { readonly [lcResultNoticeBrand]: true };

function asLcResultNotice(value: string): LcResultNotice {
  return value as LcResultNotice;
}

function oneLine(value: string): string {
  return value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export const LC_RESULT_NOTICES = Object.freeze({
  toolRoundLimitReached: asLcResultNotice(
    '[LC] Tool-call round limit reached. Finish the response without calling more tools.',
  ),
  oneToolRoundRemains: asLcResultNotice(
    '[LC] One tool-call round remains. Begin wrapping up.',
  ),
});

export function repeatedToolCallNotice(toolName: string, repeatCount: number): LcResultNotice {
  if (!Number.isSafeInteger(repeatCount) || repeatCount < 2) {
    throw new RangeError('repeatCount must be a safe integer of 2 or more');
  }
  return asLcResultNotice(
    `[LC] Same call repeated ${repeatCount}× (${oneLine(toolName)}).`,
  );
}

export function duplicateToolCallIdNotice(
  toolCallId: string,
  scope: 'same_batch' | 'earlier_round',
): LcResultNotice {
  const encodedId = JSON.stringify(toolCallId);
  return asLcResultNotice(scope === 'earlier_round'
    ? `[LC] tool_call id ${encodedId} was already answered earlier in this turn. LC did not execute the replay.`
    : `[LC] Duplicate tool_call id ${encodedId} in one batch. LC kept the first occurrence and did not execute later duplicates.`);
}

export function contendedReadNotice(paths: readonly string[]): LcResultNotice {
  if (paths.length === 0) throw new RangeError('paths must contain at least one path');
  return asLcResultNotice(
    `[LC] Read alongside a write to ${paths.map(oneLine).join(', ')} in the same batch — `
    + 'this result may predate that write. Re-read before relying on it, '
    + 'and do not batch a read of a file with a change to it.',
  );
}

export function broadReadWaitNotice(): LcResultNotice {
  return asLcResultNotice(
    '[LC] This broad filesystem read waited for another conversation\'s mutation to finish.',
  );
}

const KNOWN_LC_RESULT_NOTICES = [
  /^\[LC\] Same call repeated (?:[2-9]|[1-9]\d+)× \([^\r\n]+\)\.$/,
  /^\[LC\] Duplicate tool_call id "(?:\\.|[^"\\])*" in one batch\. LC kept the first occurrence and did not execute later duplicates\.$/s,
  /^\[LC\] tool_call id "(?:\\.|[^"\\])*" was already answered earlier in this turn\. LC did not execute the replay\.$/s,
  /^\[LC\] Read alongside a write to [^\r\n]+ in the same batch — this result may predate that write\. Re-read before relying on it, and do not batch a read of a file with a change to it\.$/,
  /^\[LC\] This broad filesystem read waited for another conversation's mutation to finish\.$/,
  /^\[LC\] Tool-call round limit reached\. Finish the response without calling more tools\.$/s,
  /^\[LC\] One tool-call round remains\. Begin wrapping up\.$/s,
] as const;

function isKnownLcResultNotice(value: string): boolean {
  return KNOWN_LC_RESULT_NOTICES.some((pattern) => pattern.test(value));
}

export interface DecodedLcResultJson {
  data: unknown;
  notices: LcResultNotice[];
}

/** Add one LC-owned framing notice without changing the serialized payload. */
export function prependLcResultNotice(content: string, notice: LcResultNotice): string {
  return `${notice}\n\n${content}`;
}

/** Separate recognized LC-owned framing notices from a serialized payload. */
export function splitLcResultContent(
  content: string,
): { payload: string; notices: LcResultNotice[] } | undefined {
  let payload = content;
  const notices: LcResultNotice[] = [];
  while (payload.startsWith('[LC] ')) {
    if (notices.length >= MAX_LEADING_LC_RESULT_NOTICES) return undefined;
    const boundary = payload.indexOf('\n\n');
    if (boundary < 0) return undefined;
    const notice = payload.slice(0, boundary);
    if (!isKnownLcResultNotice(notice)) return undefined;
    notices.push(asLcResultNotice(notice));
    payload = payload.slice(boundary + 2);
  }
  return { payload, notices };
}

/** Parse JSON after recognized LC-owned framing notices. */
export function decodeLcResultJson(content: string): DecodedLcResultJson | undefined {
  const split = splitLcResultContent(content);
  if (!split) return undefined;
  try {
    return { data: JSON.parse(split.payload) as unknown, notices: split.notices };
  } catch {
    return undefined;
  }
}

/** Serialize JSON and restore its recognized LC-owned framing notices. */
export function encodeLcResultJson(
  data: unknown,
  notices: readonly LcResultNotice[],
): string {
  const payload = JSON.stringify(data);
  if (payload === undefined) throw new TypeError('data must be JSON-serializable');
  return notices.length > 0 ? `${notices.join('\n\n')}\n\n${payload}` : payload;
}

/** Parse a stored result after removing bounded LC-owned notice paragraphs. */
export function decodeStoredToolResultEnvelope(
  content: string,
): ToolResultEnvelope | undefined {
  if (content.length > MAX_STORED_TOOL_RESULT_BYTES) return undefined;
  if (new TextEncoder().encode(content).byteLength > MAX_STORED_TOOL_RESULT_BYTES) {
    return undefined;
  }

  const parsed = decodeLcResultJson(content)?.data;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const envelope = parsed as Record<string, unknown>;
  if (
    typeof envelope.status !== 'string'
    || !Array.isArray(envelope.issues)
    || !Array.isArray(envelope.warnings)
  ) {
    return undefined;
  }
  return envelope as unknown as ToolResultEnvelope;
}
