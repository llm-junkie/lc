/**
 * Bounded lexical search over the active conversation's archived tool calls.
 *
 * This module is deliberately pure: it takes an already-collected array of
 * candidates and returns a bounded result. It opens no store, performs no
 * network/embedding/model call, touches no database, and keeps no index or
 * secondary state. `tool_history.ts` owns store access and calls in here.
 *
 * Every scan, string, and response size has an explicit bound
 * (docs/README.md standing constraint 8, docs/tools/tool-history.md).
 * Matching is deterministic and lexical only.
 */

import { takeUtf8Prefix, utf8ByteLength } from '../utf8-budget.ts';

/* ------------------------------------------------------------------ */
/*  Hard bounds                                                        */
/* ------------------------------------------------------------------ */

/** Archived calls eligible to be examined in one search. */
export const SEARCH_MAX_SCANNED_CALLS = 2_000;
/** UTF-8 bytes examined across a whole search. */
export const SEARCH_MAX_SCANNED_BYTES = 8 * 1024 * 1024;
/** UTF-8 bytes examined within a single field of a single call. */
export const SEARCH_MAX_FIELD_SCAN_BYTES = 1024 * 1024;
/** Wall-clock fail-safe. Checked at bounded intervals, never mid-field. */
export const SEARCH_MAX_ELAPSED_MS = 1_500;
/** Hard ceiling on `max_results`, independent of what the model asks for. */
export const SEARCH_MAX_RESULTS = 50;
export const SEARCH_DEFAULT_MAX_RESULTS = 10;
/** UTF-8 bytes of a single snippet. */
export const SEARCH_MAX_SNIPPET_BYTES = 512;
/** Original characters kept on each side of the matched span. */
export const SEARCH_SNIPPET_CONTEXT_CHARS = 120;
/** Calls scanned between cooperative yields and elapsed-time checks. */
export const SEARCH_YIELD_INTERVAL_CALLS = 32;
/** Maximum distinct query terms accepted. */
export const SEARCH_MAX_QUERY_TERMS = 16;
/** Maximum characters accepted from the raw query before normalization. */
export const SEARCH_MAX_QUERY_CHARACTERS = 512;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export const SEARCH_FIELDS = ['tool_call_id', 'tool_name', 'arguments', 'output'] as const;
export type ToolHistorySearchField = (typeof SEARCH_FIELDS)[number];

export const SEARCH_TRUNCATION_REASONS = [
  'scan-call-limit',
  'scan-byte-limit',
  'time-limit',
  'result-count-limit',
  'result-byte-limit',
] as const;
export type ToolHistoryTruncationReason = (typeof SEARCH_TRUNCATION_REASONS)[number];

/** One archived call, already filtered by `message_id` / `tool_name`. */
export interface ToolHistorySearchCandidate {
  message_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: string;
  output: string;
  is_error: boolean;
  created_at?: number | null;
}

export interface ToolHistorySearchHit {
  message_id: string;
  tool_call_id: string;
  tool_name: string;
  matched_fields: ToolHistorySearchField[];
  /**
   * Which field `snippet` was taken from. `matched_fields` can name several;
   * this removes the ambiguity without embedding a label inside the snippet
   * text, where it could be mistaken for stored output (tool-history.md).
   */
  snippet_field: ToolHistorySearchField;
  /** Verbatim original text. No ellipsis or marker is ever inserted. */
  snippet: string;
  /** True when the snippet is a byte-bounded prefix of its context window. */
  snippet_truncated: boolean;
  output_bytes: number;
  is_error: boolean;
  created_at: number | null;
}

export interface ToolHistorySearchOutput {
  query: string;
  eligible_calls: number;
  scanned_calls: number;
  scanned_bytes: number;
  matched_calls: number;
  returned: number;
  truncated: boolean;
  truncation_reasons: ToolHistoryTruncationReason[];
  scan_coverage_pct: number;
  hits: ToolHistorySearchHit[];
}

export interface ToolHistorySearchOptions {
  maxResults?: number;
  maxResponseBytes?: number;
  /** Injectable for deterministic tests. */
  now?: () => number;
  /** Injectable for deterministic tests; defaults to a macrotask yield. */
  yieldToEventLoop?: () => Promise<void>;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/*  Unicode normalization with an original-offset map                  */
/* ------------------------------------------------------------------ */

/**
 * Text normalized and lowercased per cluster, with original-string offsets.
 *
 * Each cluster contains one code point and its following Unicode combining
 * marks. NFKC and locale-independent lowercasing apply separately to each
 * cluster. This supports composition within a cluster, such as `e`+`U+0301`.
 * It does not provide whole-string NFKC equivalence or compose Hangul Jamo
 * across clusters. The offset map lets snippets quote the original text.
 */
export interface FoldedText {
  folded: string;
  /** `start[i]` — original UTF-16 index where folded character `i` began. */
  start: number[];
  /** `end[i]` — original UTF-16 index just past folded character `i`. */
  end: number[];
}

const COMBINING_MARK = /\p{M}/u;

export function foldText(text: string): FoldedText {
  const folded: string[] = [];
  const start: number[] = [];
  const end: number[] = [];

  let index = 0;
  while (index < text.length) {
    const base = String.fromCodePoint(text.codePointAt(index)!);
    const clusterStart = index;
    index += base.length;
    let cluster = base;
    // Attach trailing combining marks so NFKC can compose them.
    while (index < text.length) {
      const next = String.fromCodePoint(text.codePointAt(index)!);
      if (!COMBINING_MARK.test(next)) break;
      cluster += next;
      index += next.length;
    }
    const clusterEnd = index;

    let normalized: string;
    try {
      normalized = cluster.normalize('NFKC').toLowerCase();
    } catch {
      // A lone surrogate cannot be normalized; fold it to itself.
      normalized = cluster.toLowerCase();
    }
    for (const character of normalized) {
      folded.push(character);
      start.push(clusterStart);
      end.push(clusterEnd);
    }
  }

  return { folded: folded.join(''), start, end };
}

/**
 * `folded` is built from an array of whole code points, so an index into the
 * joined string can land inside a surrogate pair. Index maps are per code
 * point, so translate a string index to a map index before using them.
 */
function foldedMapIndex(folded: FoldedText, stringIndex: number): number {
  let mapIndex = 0;
  let cursor = 0;
  while (cursor < stringIndex && mapIndex < folded.start.length) {
    cursor += String.fromCodePoint(folded.folded.codePointAt(cursor)!).length;
    mapIndex++;
  }
  return Math.min(mapIndex, Math.max(0, folded.start.length - 1));
}

/* ------------------------------------------------------------------ */
/*  Query parsing                                                      */
/* ------------------------------------------------------------------ */

export interface ParsedQuery {
  /** Original text, bounded, for echoing back in the response. */
  raw: string;
  /** Folded whole query, used for exact-ID/name and phrase matching. */
  phrase: string;
  /** Distinct folded terms, in first-appearance order. */
  terms: string[];
}

export class ToolHistorySearchInputError extends Error {}

export function parseSearchQuery(query: string): ParsedQuery {
  const queryCharacters = Array.from(query).length;
  if (queryCharacters > SEARCH_MAX_QUERY_CHARACTERS) {
    throw new ToolHistorySearchInputError(
      `query is ${queryCharacters} characters. Shorten query to ${SEARCH_MAX_QUERY_CHARACTERS} characters or fewer.`,
    );
  }
  const raw = query;
  // Runs of whitespace collapse so an incidental double space in the query
  // still phrase-matches ordinary single-spaced text. Candidate text is not
  // rewritten, so a phrase spanning irregular whitespace falls back to term
  // matching rather than silently matching something the user did not type.
  const phrase = foldText(raw).folded.trim().replace(/\s+/g, ' ');
  if (!phrase) {
    throw new ToolHistorySearchInputError(
      'query must contain at least one non-whitespace character. Omit query to list archived calls.',
    );
  }
  const terms: string[] = [];
  for (const term of phrase.split(/\s+/)) {
    if (!term || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length > SEARCH_MAX_QUERY_TERMS) {
      throw new ToolHistorySearchInputError(
        `query contains more than ${SEARCH_MAX_QUERY_TERMS} distinct terms. Narrow query to ${SEARCH_MAX_QUERY_TERMS} or fewer distinct terms.`,
      );
    }
  }
  return { raw, phrase, terms };
}

/* ------------------------------------------------------------------ */
/*  Matching                                                           */
/* ------------------------------------------------------------------ */

interface FieldMatch {
  field: ToolHistorySearchField;
  /** Folded-string index of the earliest match in this field. */
  foldedIndex: number;
  /** Folded length of the matched span. */
  foldedLength: number;
  /** Distinct query terms found anywhere in this field. */
  matchedTerms: Set<string>;
  /** True when the whole folded phrase appears in this field. */
  phrase: boolean;
  folded: FoldedText;
  original: string;
}

function matchField(
  field: ToolHistorySearchField,
  original: string,
  query: ParsedQuery,
): FieldMatch | null {
  const folded = foldText(original);
  const haystack = folded.folded;

  const matchedTerms = new Set<string>();
  let earliestIndex = Number.MAX_SAFE_INTEGER;
  let earliestLength = 0;

  const phraseIndex = haystack.indexOf(query.phrase);
  if (phraseIndex >= 0) {
    earliestIndex = phraseIndex;
    earliestLength = query.phrase.length;
  }

  for (const term of query.terms) {
    const at = haystack.indexOf(term);
    if (at < 0) continue;
    matchedTerms.add(term);
    // A phrase match already anchors the snippet; only take an earlier term
    // position when no phrase matched, so the anchor stays deterministic.
    if (phraseIndex < 0 && at < earliestIndex) {
      earliestIndex = at;
      earliestLength = term.length;
    }
  }

  if (matchedTerms.size === 0 && phraseIndex < 0) return null;
  if (earliestIndex === Number.MAX_SAFE_INTEGER) return null;

  return {
    field,
    foldedIndex: earliestIndex,
    foldedLength: earliestLength,
    matchedTerms,
    phrase: phraseIndex >= 0,
    folded,
    original,
  };
}

interface ScoredCandidate {
  candidate: ToolHistorySearchCandidate;
  matches: FieldMatch[];
  exactToolCallId: boolean;
  exactToolName: boolean;
  phrase: boolean;
  allTerms: boolean;
  distinctTerms: number;
}

/**
 * Ranking order from tool-history.md. Returns <0 when `a` should sort before `b`.
 * Every tier is a total order, so equal inputs can never reorder.
 */
export function compareScored(a: ScoredCandidate, b: ScoredCandidate): number {
  const flag = (x: boolean): number => (x ? 1 : 0);
  return (
    flag(b.exactToolCallId) - flag(a.exactToolCallId)
    || flag(b.exactToolName) - flag(a.exactToolName)
    || flag(b.phrase) - flag(a.phrase)
    || flag(b.allTerms) - flag(a.allTerms)
    || b.distinctTerms - a.distinctTerms
    || (b.candidate.created_at ?? 0) - (a.candidate.created_at ?? 0)
    || (a.candidate.tool_call_id < b.candidate.tool_call_id
      ? -1
      : a.candidate.tool_call_id > b.candidate.tool_call_id
        ? 1
        : 0)
  );
}

/* ------------------------------------------------------------------ */
/*  Snippets                                                           */
/* ------------------------------------------------------------------ */

/** Back off a UTF-16 index so it never splits a surrogate pair. */
function safeSliceStart(text: string, index: number): number {
  const clamped = Math.max(0, Math.min(text.length, index));
  if (clamped > 0 && clamped < text.length) {
    const code = text.charCodeAt(clamped);
    if (code >= 0xdc00 && code <= 0xdfff) return clamped - 1;
  }
  return clamped;
}

function safeSliceEnd(text: string, index: number): number {
  const clamped = Math.max(0, Math.min(text.length, index));
  if (clamped > 0 && clamped < text.length) {
    const code = text.charCodeAt(clamped - 1);
    if (code >= 0xd800 && code <= 0xdbff) return clamped - 1;
  }
  return clamped;
}

/**
 * Bounded verbatim context around the matched span. The returned text is a
 * literal substring of the stored field — nothing is inserted, so it can
 * never be mistaken for content LC synthesized.
 */
export function buildSnippet(match: FieldMatch): { snippet: string; truncated: boolean } {
  const startMapIndex = foldedMapIndex(match.folded, match.foldedIndex);
  const endMapIndex = foldedMapIndex(
    match.folded,
    match.foldedIndex + Math.max(1, match.foldedLength),
  );

  const matchStart = match.folded.start[startMapIndex] ?? 0;
  const matchEnd = match.folded.end[Math.max(0, endMapIndex - 1)] ?? matchStart;

  const windowStart = safeSliceStart(match.original, matchStart - SEARCH_SNIPPET_CONTEXT_CHARS);
  const windowEnd = safeSliceEnd(match.original, matchEnd + SEARCH_SNIPPET_CONTEXT_CHARS);
  const window = match.original.slice(windowStart, Math.max(windowStart, windowEnd));

  const bounded = takeUtf8Prefix(window, SEARCH_MAX_SNIPPET_BYTES);
  return { snippet: bounded, truncated: bounded.length < window.length };
}

/* ------------------------------------------------------------------ */
/*  Search                                                             */
/* ------------------------------------------------------------------ */

function defaultYield(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampMaxResults(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SEARCH_DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(SEARCH_MAX_RESULTS, Math.trunc(value)));
}

/**
 * Scan `candidates` in the order given, rank the matches, and return a
 * bounded response. Partial coverage is always reported honestly: a miss
 * under a reached limit is never presented as a proven no-match (tool-history.md).
 */
export async function searchToolHistory(
  candidates: readonly ToolHistorySearchCandidate[],
  query: ParsedQuery,
  options: ToolHistorySearchOptions = {},
): Promise<ToolHistorySearchOutput> {
  const now = options.now ?? Date.now;
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;
  const maxResults = clampMaxResults(options.maxResults);
  const maxResponseBytes = Math.max(1, Math.trunc(options.maxResponseBytes ?? 65536));
  const startedAt = now();

  const reasons = new Set<ToolHistoryTruncationReason>();
  const scored: ScoredCandidate[] = [];
  let scannedCalls = 0;
  let scannedBytes = 0;

  for (let index = 0; index < candidates.length; index++) {
    // Bounds are checked before each call so the stopping point is a
    // deterministic function of the input for the call and byte limits.
    if (scannedCalls >= SEARCH_MAX_SCANNED_CALLS) {
      reasons.add('scan-call-limit');
      break;
    }
    if (scannedBytes >= SEARCH_MAX_SCANNED_BYTES) {
      reasons.add('scan-byte-limit');
      break;
    }
    if (index > 0 && index % SEARCH_YIELD_INTERVAL_CALLS === 0) {
      // Yield so a large history cannot block the renderer, then re-check the
      // wall clock. This is the one fail-safe whose stopping point may vary.
      await yieldToEventLoop();
      if (options.signal?.aborted) {
        reasons.add('time-limit');
        break;
      }
      if (now() - startedAt >= SEARCH_MAX_ELAPSED_MS) {
        reasons.add('time-limit');
        break;
      }
    }

    const candidate = candidates[index];
    scannedCalls++;

    const matches: FieldMatch[] = [];
    for (const field of SEARCH_FIELDS) {
      const remainingScanBytes = SEARCH_MAX_SCANNED_BYTES - scannedBytes;
      if (remainingScanBytes <= 0) {
        reasons.add('scan-byte-limit');
        break;
      }
      const whole = candidate[field] ?? '';
      const scanned = takeUtf8Prefix(
        whole,
        Math.min(SEARCH_MAX_FIELD_SCAN_BYTES, remainingScanBytes),
      );
      if (scanned.length < whole.length) reasons.add('scan-byte-limit');
      scannedBytes += utf8ByteLength(scanned);
      const match = matchField(field, scanned, query);
      if (match) matches.push(match);
    }
    if (matches.length === 0) continue;

    const allMatchedTerms = new Set<string>();
    for (const match of matches) {
      for (const term of match.matchedTerms) allMatchedTerms.add(term);
    }

    scored.push({
      candidate,
      matches,
      exactToolCallId: foldText(candidate.tool_call_id).folded.trim() === query.phrase,
      exactToolName: foldText(candidate.tool_name).folded.trim() === query.phrase,
      phrase: matches.some((match) => match.phrase),
      allTerms: query.terms.every((term) => allMatchedTerms.has(term)),
      distinctTerms: allMatchedTerms.size,
    });
  }

  if (scannedCalls < candidates.length && reasons.size === 0) {
    // Defensive: the loop only exits early when a bound was reached.
    reasons.add('scan-call-limit');
  }

  scored.sort(compareScored);

  const hits: ToolHistorySearchHit[] = [];
  let responseBytes = 0;
  for (const entry of scored) {
    if (hits.length >= maxResults) {
      reasons.add('result-count-limit');
      break;
    }
    // Field priority is the documented `SEARCH_FIELDS` order, so the anchor
    // is stable regardless of which fields happened to match.
    const anchor = SEARCH_FIELDS.map((field) => entry.matches.find((match) => match.field === field))
      .find((match): match is FieldMatch => match !== undefined)!;
    const { snippet, truncated } = buildSnippet(anchor);

    const hit: ToolHistorySearchHit = {
      message_id: entry.candidate.message_id,
      tool_call_id: entry.candidate.tool_call_id,
      tool_name: entry.candidate.tool_name,
      matched_fields: SEARCH_FIELDS.filter((field) =>
        entry.matches.some((match) => match.field === field)),
      snippet_field: anchor.field,
      snippet,
      snippet_truncated: truncated,
      output_bytes: utf8ByteLength(entry.candidate.output ?? ''),
      is_error: entry.candidate.is_error,
      created_at: entry.candidate.created_at ?? null,
    };

    const hitBytes = utf8ByteLength(JSON.stringify(hit));
    if (responseBytes + hitBytes > maxResponseBytes) {
      reasons.add('result-byte-limit');
      break;
    }
    responseBytes += hitBytes;
    hits.push(hit);
  }

  const eligible = candidates.length;
  const orderedReasons = SEARCH_TRUNCATION_REASONS.filter((reason) => reasons.has(reason));

  return {
    query: query.raw,
    eligible_calls: eligible,
    scanned_calls: scannedCalls,
    scanned_bytes: scannedBytes,
    matched_calls: scored.length,
    returned: hits.length,
    truncated: orderedReasons.length > 0,
    truncation_reasons: orderedReasons,
    scan_coverage_pct: eligible === 0 ? 100 : roundPercent((scannedCalls / eligible) * 100),
    hits,
  };
}
