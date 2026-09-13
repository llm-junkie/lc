/**
 * Reasoning chunking — splits a large reasoning text into stable
 * chunks so that only the last (growing) chunk needs to be re-parsed
 * by the Markdown pipeline during streaming.  Unchanged chunks are
 * skipped via React.memo.
 *
 * Chunk boundaries (priority order):
 *   1. Tool-call breaks — the orchestrator inserts \n\n before new
 *      reasoning after each tool cycle.  These become natural hard
 *      chunk boundaries.
 *   2. Atomic blocks — fenced code, $$ math, and markdown tables are
 *      never split; each lives in its own chunk.
 *   3. Paragraph breaks (\n\n) — natural prose boundaries.  When a
 *      prose segment exceeds ~TARGET_WORDS, we split at the next \n\n.
 *   4. Soft word cap — a single paragraph longer than TARGET_WORDS
 *      stays whole (no mid-paragraph hard split).
 */

// ── Constants ─────────────────────────────────────────────────────
const TARGET_WORDS = 500;
/** Maximum source suffix that the live append splitter can process. */
export const LIVE_MARKDOWN_RESCAN_LIMIT_CHARS = 32_768;

// ── Helpers ───────────────────────────────────────────────────────

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function isFenceLine(line: string): boolean {
  return /^\s*(`{3,}|~{3,})/.test(line);
}

function isMathBlockDelim(line: string): boolean {
  return line.trim() === '$$';
}

function isTableSeparator(line: string): boolean {
  // e.g. | --- | :--- | ---: | :---: |
  return /^\s*\|?\s*(:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function hasTablePipes(line: string): boolean {
  return line.includes('|');
}

// ── Block extractors ──────────────────────────────────────────────

/** Extract a fenced code block starting at lines[i]. Returns the
 *  joined block text and the index of the next unprocessed line. */
function extractFencedBlock(
  lines: string[],
  i: number,
): { text: string; nextIndex: number } {
  const fenceMatch = lines[i].match(/^\s*(`{3,}|~{3,})/)!;
  const fenceChar = fenceMatch[1][0];
  const fenceLen = fenceMatch[1].length;
  const blockLines: string[] = [lines[i]];
  i++;
  while (i < lines.length) {
    blockLines.push(lines[i]);
    const close = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
      i++;
      break;
    }
    i++;
  }
  return { text: blockLines.join('\n'), nextIndex: i };
}

/** Extract a $$ math block starting at lines[i]. */
function extractMathBlock(
  lines: string[],
  i: number,
): { text: string; nextIndex: number } {
  const blockLines: string[] = [lines[i]];
  i++;
  while (i < lines.length) {
    blockLines.push(lines[i]);
    if (lines[i].trim() === '$$') {
      i++;
      break;
    }
    i++;
  }
  return { text: blockLines.join('\n'), nextIndex: i };
}

/** Extract a markdown table starting at lines[i].  Consumes lines
 *  until a blank line or a non-table line. */
function extractTable(
  lines: string[],
  i: number,
): { text: string; nextIndex: number } {
  const tableLines: string[] = [];
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === '') break;
    // After the separator line, still accept pipe lines
    if (tableLines.length > 0 && !hasTablePipes(l)) break;
    tableLines.push(l);
    i++;
  }
  return { text: tableLines.join('\n'), nextIndex: i };
}

// ── Main splitter ─────────────────────────────────────────────────

export function splitReasoningIntoChunks(text: string): string[] {
  if (!text) return [];

  const lines = text.split('\n');
  const chunks: string[] = [];

  // Current prose accumulator (paragraphs grouped together)
  let proseLines: string[] = [];
  let proseWords = 0;

  function flushProse() {
    // Trim trailing blank lines
    while (
      proseLines.length > 0 &&
      proseLines[proseLines.length - 1].trim() === ''
    ) {
      proseLines.pop();
    }
    if (proseLines.length > 0) {
      chunks.push(proseLines.join('\n'));
    }
    proseLines = [];
    proseWords = 0;
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code block ──
    if (isFenceLine(line)) {
      flushProse();
      const fb = extractFencedBlock(lines, i);
      chunks.push(fb.text);
      i = fb.nextIndex;
      continue;
    }

    // ── Math block ──
    if (isMathBlockDelim(line)) {
      flushProse();
      const mb = extractMathBlock(lines, i);
      chunks.push(mb.text);
      i = mb.nextIndex;
      continue;
    }

    // ── Table ──
    if (
      hasTablePipes(line) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      flushProse();
      const tb = extractTable(lines, i);
      chunks.push(tb.text);
      i = tb.nextIndex;
      continue;
    }

    // ── Blank line = paragraph boundary ──
    if (line.trim() === '') {
      // If we've accumulated enough words, flush before adding the
      // blank line so the next paragraph starts a new chunk.
      if (proseLines.length > 0 && proseWords >= TARGET_WORDS) {
        flushProse();
      }
      // Keep blank lines as separators within the current prose chunk
      if (proseLines.length > 0) {
        proseLines.push(line);
      }
      i++;
      continue;
    }

    // ── Normal text line ──
    proseLines.push(line);
    proseWords += countWords(line);
    i++;
  }

  // Flush remaining prose
  flushProse();

  return chunks.length > 0 ? chunks : [''];
}

/** Cache for append-aware splitting. `tailStart` points to the last chunk. */
export interface ReasoningChunkState {
  source: string;
  chunks: string[];
  tailStart: number;
  /** Source characters omitted from the live chunks after a bounded fallback. */
  omittedLiveChars: number;
  /** True when the final chunk is a bounded plain-text candidate. */
  boundedTail: boolean;
}

const APPEND_SENTINEL_CHARS = 64;

function looksAppendOnly(previous: string, next: string): boolean {
  if (next.length < previous.length) return false;
  if (next.length === previous.length) return next === previous;

  const sentinel = Math.min(APPEND_SENTINEL_CHARS, previous.length);
  return (
    next.slice(0, sentinel) === previous.slice(0, sentinel) &&
    next.slice(previous.length - sentinel, previous.length) ===
      previous.slice(previous.length - sentinel)
  );
}

function boundedTailStart(text: string, limit: number): number {
  let start = Math.max(0, text.length - Math.max(1, limit));
  if (
    start > 0
    && text.charCodeAt(start) >= 0xdc00
    && text.charCodeAt(start) <= 0xdfff
  ) {
    start += 1;
  }
  return start;
}

function createReasoningChunkState(
  text: string,
  maxTailChars?: number,
): ReasoningChunkState {
  if (maxTailChars !== undefined && text.length > maxTailChars) {
    const tailStart = boundedTailStart(text, maxTailChars);
    return {
      source: text,
      chunks: [text.slice(tailStart)],
      tailStart,
      omittedLiveChars: tailStart,
      boundedTail: true,
    };
  }
  const chunks = splitReasoningIntoChunks(text);
  const lastChunk = chunks[chunks.length - 1] ?? '';
  const tailStart = lastChunk ? Math.max(0, text.lastIndexOf(lastChunk)) : 0;
  return {
    source: text,
    chunks,
    tailStart,
    omittedLiveChars: 0,
    boundedTail: false,
  };
}

/**
 * Split an append-only reasoning stream without rescanning its settled prefix.
 *
 * The current tail is re-split because an unfinished fence, table, math block,
 * or prose paragraph can still change shape. Earlier chunks are reused by
 * identity, allowing React.memo to skip their Markdown pipeline. Replacements
 * and stream resets fall back to a full, exact split.
 */
export function updateReasoningChunkState(
  text: string,
  previous?: ReasoningChunkState,
  maxTailChars?: number,
): ReasoningChunkState {
  if (!previous || !looksAppendOnly(previous.source, text)) {
    return createReasoningChunkState(text, maxTailChars);
  }
  if (previous.boundedTail && maxTailChars === undefined) {
    return createReasoningChunkState(text);
  }
  if (text === previous.source) return previous;

  const stableChunks = previous.chunks.slice(0, -1);
  if (maxTailChars !== undefined) {
    const boundedStart = boundedTailStart(text, maxTailChars);
    if (previous.boundedTail || boundedStart > previous.tailStart) {
      return {
        source: text,
        chunks: [...stableChunks, text.slice(boundedStart)],
        tailStart: boundedStart,
        omittedLiveChars:
          previous.omittedLiveChars + Math.max(0, boundedStart - previous.tailStart),
        boundedTail: true,
      };
    }
  }

  const tailSource = text.slice(previous.tailStart);
  const tailChunks = splitReasoningIntoChunks(tailSource);
  const chunks = [...stableChunks, ...tailChunks];
  const lastChunk = tailChunks[tailChunks.length - 1] ?? '';
  const localTailStart = lastChunk
    ? Math.max(0, tailSource.lastIndexOf(lastChunk))
    : 0;

  return {
    source: text,
    chunks,
    tailStart: previous.tailStart + localTailStart,
    omittedLiveChars: previous.omittedLiveChars,
    boundedTail: false,
  };
}
