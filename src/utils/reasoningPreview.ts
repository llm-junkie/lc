import {
  LIVE_MARKDOWN_RESCAN_LIMIT_CHARS,
  splitReasoningIntoChunks,
} from './reasoningChunks.ts';

/** Maximum Markdown size for the one chunk that can still change. */
export const LIVE_MARKDOWN_TAIL_LIMIT_CHARS = 4_096;
/** Maximum source characters represented in one live render window. */
export const LIVE_MARKDOWN_WINDOW_CHARS = LIVE_MARKDOWN_RESCAN_LIMIT_CHARS;
export const COMPLETED_REASONING_INITIAL_WINDOW_CHARS = 6_400;

export type ReasoningPreview =
  | { mode: 'markdown'; text: string; omittedLeadingChars: number }
  | { mode: 'plain-tail'; text: string; omittedLeadingChars: number };

export function isCompletedReasoningOverBudget(text: string): boolean {
  return text.length > COMPLETED_REASONING_INITIAL_WINDOW_CHARS;
}

function selectPlainTail(text: string, windowChars: number): ReasoningPreview {
  let start = Math.max(0, text.length - windowChars);
  // Do not begin with the low half of a UTF-16 surrogate pair.
  if (
    start > 0 &&
    text.charCodeAt(start) >= 0xdc00 &&
    text.charCodeAt(start) <= 0xdfff
  ) {
    start += 1;
  }
  return {
    mode: 'plain-tail',
    text: text.slice(start),
    omittedLeadingChars: start,
  };
}

export interface LiveMarkdownChunkPreview {
  chunkIndex: number;
  mode: 'markdown' | 'plain-tail';
  text: string;
}

export interface LiveMarkdownChunkWindow {
  chunks: LiveMarkdownChunkPreview[];
  omittedEarlierChunks: number;
  omittedGrowingTailChars: number;
}

/**
 * Select a bounded suffix of append-aware chunks for live rendering.
 *
 * Settled chunks keep Markdown. Only an oversized final growing chunk becomes
 * plain text. The returned chunk indexes remain stable as the window advances.
 */
export function selectLiveMarkdownChunkWindow(
  chunks: readonly string[],
  windowChars = LIVE_MARKDOWN_WINDOW_CHARS,
  tailMarkdownLimit = LIVE_MARKDOWN_TAIL_LIMIT_CHARS,
): LiveMarkdownChunkWindow {
  if (chunks.length === 0) {
    return {
      chunks: [],
      omittedEarlierChunks: 0,
      omittedGrowingTailChars: 0,
    };
  }

  const lastIndex = chunks.length - 1;
  const growingTail = chunks[lastIndex] ?? '';
  const tailPreview = growingTail.length > tailMarkdownLimit
    ? selectPlainTail(growingTail, windowChars)
    : { mode: 'markdown' as const, text: growingTail, omittedLeadingChars: 0 };
  const visible: LiveMarkdownChunkPreview[] = [{
    chunkIndex: lastIndex,
    mode: tailPreview.mode,
    text: tailPreview.text,
  }];
  let remainingChars = Math.max(0, windowChars - tailPreview.text.length);

  for (let index = lastIndex - 1; index >= 0; index -= 1) {
    const chunk = chunks[index] ?? '';
    if (chunk.length > remainingChars) break;
    visible.unshift({ chunkIndex: index, mode: 'markdown', text: chunk });
    remainingChars -= chunk.length;
  }

  return {
    chunks: visible,
    omittedEarlierChunks: visible[0]?.chunkIndex ?? 0,
    omittedGrowingTailChars: tailPreview.omittedLeadingChars,
  };
}

/** Return exact source offsets for the existing Markdown-safe reasoning
 * chunks. If the splitter ever produces an unlocatable chunk, fall back to
 * offset zero so the preview shows too much rather than cutting Markdown. */
export function buildReasoningChunkStarts(text: string): number[] {
  const starts: number[] = [];
  let cursor = 0;

  for (const chunk of splitReasoningIntoChunks(text)) {
    if (!chunk) continue;
    const start = text.indexOf(chunk, cursor);
    if (start < 0) return [0];
    starts.push(start);
    cursor = start + chunk.length;
  }

  return starts.length > 0 ? starts : [0];
}

/** Select no more than `windowChars` from the end when a Markdown-safe chunk
 * boundary is available. If the final atomic chunk is larger than the whole
 * budget, fall back to an exact plain-text tail instead of mounting it all. */
export function selectCompletedReasoningWindow(
  text: string,
  windowChars: number,
  chunkStarts = buildReasoningChunkStarts(text),
): ReasoningPreview {
  if (windowChars >= text.length) {
    return { mode: 'markdown', text, omittedLeadingChars: 0 };
  }

  const idealStart = Math.max(0, text.length - Math.max(1, windowChars));
  let low = 0;
  let high = chunkStarts.length - 1;
  let start: number | undefined;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = chunkStarts[mid];
    if (candidate >= idealStart) {
      start = candidate;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  if (start === undefined) {
    return selectPlainTail(text, windowChars);
  }

  return {
    mode: 'markdown',
    text: text.slice(start),
    omittedLeadingChars: start,
  };
}

/** Progressively window a completed reasoning value above the initial budget. */
export function selectCompletedReasoningPreview(text: string): ReasoningPreview {
  if (!isCompletedReasoningOverBudget(text)) {
    return { mode: 'markdown', text, omittedLeadingChars: 0 };
  }

  return selectCompletedReasoningWindow(
    text,
    COMPLETED_REASONING_INITIAL_WINDOW_CHARS,
  );
}
