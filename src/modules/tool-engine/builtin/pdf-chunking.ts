/**
 * Runtime page-range parsing for `lc_read_pdf`, plus the original pure
 * chunk helpers retained as test references for the native migration.
 *
 * Split out from the handler so the grammar and the budget arithmetic
 * are unit-testable without a Tauri bridge or an LLM.
 */

/** Original internal page shape used by the migration reference fixtures. */
export interface PdfPage {
  page: number;
  chars: number;
  provenance: 'text_layer' | 'none';
  kind?: string;
  image_rendered: boolean;
  render_reason: string | null;
  /** Set when the page needed pixels but did not get them. */
  planned_render_reason?: string | null;
  render_skipped?: string | null;
  /**
   * Tables recovered from the page. Cell **text** comes from the text
   * layer and is exact; the row/column **structure** is spatially
   * inferred and can be wrong.
   */
  tables_md?: string[];
  text?: string;
  /** Transient — stripped before the tool result is persisted. */
  data_url?: string;
  error?: string;
}

/**
 * Result of parsing a page-range expression.
 *
 * Three outcomes, deliberately distinct. An earlier revision collapsed
 * "invalid" into "omitted" by returning `undefined` for both, so
 * `pages: "abc"` silently became *every page* — the opposite of what
 * the caller asked for, and unbounded work on a large document.
 */
export type PageRangeResult =
  | { kind: 'omitted' }
  | { kind: 'ok'; pages: number[] }
  | { kind: 'invalid'; message: string };

/**
 * Which input an expression came from. Only shapes the error text —
 * the grammar is identical for both.
 */
export type PageRangeField = 'pages' | 'force_render';

/**
 * How each field is named in its own error messages.
 *
 * `force_render` used to borrow the `pages` wording, so an invalid
 * value was reported as `Invalid "force_render" value: Page selection
 * is empty. Omit it to read every page.` — advice that is false for
 * that field, because omitting `force_render` renders *no* extra
 * pages rather than every page.
 */
const FIELD_LABEL: Record<PageRangeField, string> = {
  pages: 'Page selection',
  force_render: 'Render selection',
};

const FIELD_SYNTAX_REMEDY: Record<PageRangeField, string> = {
  pages: 'Use one-based pages such as "1-5,12", or omit pages to read every page.',
  force_render: 'Use one-based pages such as "1-5,12", or omit force_render to force no extra pages.',
};

/** Longest accepted expression. Guards the parser itself. */
export const MAX_RANGE_EXPR_CHARS = 400;
/** Largest number of pages one expression may name. */
export const MAX_RANGE_PAGES = 2000;
/** Largest page number accepted, before the document length is known. */
const MAX_PAGE_NUMBER = 1_000_000;

/**
 * Parse a 1-based page range expression: `"1-5,12,40-55"`.
 *
 * Fails closed. A malformed fragment, a zero or negative page, an
 * over-long expression, or a selection whose expanded cardinality
 * exceeds `MAX_RANGE_PAGES` all return `invalid` — never a silent
 * fallback to "all pages". Cardinality is computed from the range
 * bounds *before* enumeration, so `"1-1000000000"` is rejected without
 * allocating a billion entries.
 *
 * An empty or whitespace-only value is `omitted`, not `invalid`. It
 * names no page, so it cannot be misread as a selection — the risk
 * that motivates failing closed applies to expressions like `"abc"`
 * that *look* like an attempt. Models routinely fill every declared
 * optional string with `""` instead of leaving it out, and rejecting
 * that taught one model the rule "force_render must be non-empty": it
 * then pinned the value to `"1"` and rasterized page 1 on every
 * subsequent read.
 */
export function parsePageRange(
  expr: string | undefined | null,
  field: PageRangeField = 'pages',
): PageRangeResult {
  if (expr == null) return { kind: 'omitted' };
  const trimmed = expr.trim();
  if (!trimmed) return { kind: 'omitted' };
  const label = FIELD_LABEL[field];
  if (trimmed.length > MAX_RANGE_EXPR_CHARS) {
    return {
      kind: 'invalid',
      message: `${label} is ${trimmed.length} characters, over the ${MAX_RANGE_EXPR_CHARS} limit.`,
    };
  }

  // Pass 1: validate every fragment and total the cardinality without
  // materializing anything.
  const spans: Array<[number, number]> = [];
  let cardinality = 0;
  for (const frag of trimmed.split(',')) {
    const part = frag.trim();
    if (!part) {
      return {
        kind: 'invalid',
        message: `Empty fragment in ${label.toLowerCase()} "${trimmed}". ${FIELD_SYNTAX_REMEDY[field]}`,
      };
    }
    // Digits-only fragments fail closed on size (a document cannot have
    // more than MAX_PAGE_NUMBER pages); anything else is a grammar error
    // in which the offending text is quoted and the expected form named.
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    const single = /^(\d+)$/.exec(part);
    let a: number;
    let b: number;
    if (range) {
      a = Number(range[1]);
      b = Number(range[2]);
      if (a > b) [a, b] = [b, a];
    } else if (single) {
      a = Number(single[1]);
      b = a;
    } else {
      return {
        kind: 'invalid',
        message: `"${part}" in the ${label.toLowerCase()} is neither a page number nor a page range. ${FIELD_SYNTAX_REMEDY[field]}`,
      };
    }
    if (a < 1) {
      return {
        kind: 'invalid',
        message: `Pages are numbered from 1, so "${part}" is not valid for the ${label.toLowerCase()}.`,
      };
    }
    if (b > MAX_PAGE_NUMBER) {
      return {
        kind: 'invalid',
        // Quote the caller's own fragment, never the parsed bound:
        // Number() loses precision above 2^53 and saturates near 10^308,
        // both reachable inside the 400-character expression cap, and a
        // message that prints "page 1e+30" or "page Infinity" names no
        // page the caller wrote.
        message: `${label} fragment "${part}" names a page beyond any plausible document (limit ${MAX_PAGE_NUMBER}).`,
      };
    }
    cardinality += b - a + 1;
    if (cardinality > MAX_RANGE_PAGES) {
      return {
        kind: 'invalid',
        message:
          `${label} covers more than ${MAX_RANGE_PAGES} pages. ` +
          'Narrow the range and retry with smaller selections.',
      };
    }
    spans.push([a, b]);
  }

  // Pass 2: enumerate, now that the size is known to be bounded.
  const out = new Set<number>();
  for (const [a, b] of spans) {
    for (let p = a; p <= b; p++) out.add(p);
  }
  if (out.size === 0) {
    return { kind: 'invalid', message: `${label} resolved to no pages.` };
  }
  return { kind: 'ok', pages: [...out].sort((x, y) => x - y) };
}

/** Rough token estimate. Good enough for budgeting; not a tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Everything a page contributes to a chunk's text budget: its header
 * line, its extracted text, and any recovered table markdown.
 *
 * An earlier revision counted only `text`, so a page carrying several
 * large tables could blow the budget invisibly.
 */
export function pageCost(p: PdfPage): number {
  let n = estimateTokens(pageHeader(p));
  n += estimateTokens(p.text ?? '');
  for (const t of p.tables_md ?? []) n += estimateTokens(t) + 8;
  return n;
}

export interface ChunkOptions {
  /** Target text tokens per chunk. */
  textBudget?: number;
  /** Max pages carrying an image in one chunk. */
  imagesPerChunk?: number;
  /** Repeat the last page of the previous chunk at the head of the next. */
  overlap?: boolean;
  /** Tokens reserved for the per-chunk instruction preamble. */
  reserved?: number;
}

/**
 * Group pages into chunks sized to a token budget.
 *
 * Page-by-page is the wrong granularity — a page break is typographic,
 * not semantic, and tables and arguments cross it. Chunks carry a
 * one-page overlap by default so an element split across a boundary
 * appears whole in at least one chunk.
 *
 * The overlap is dropped rather than honored when carrying it would
 * itself exceed the budget: a large tail page would otherwise make the
 * next chunk over-budget before it holds any new content.
 *
 * A single page larger than the whole budget still forms its own chunk
 * — that overflow is unavoidable without splitting mid-page.
 */
export function chunkPages(pages: PdfPage[], opts: ChunkOptions = {}): PdfPage[][] {
  const textBudget = opts.textBudget ?? 6000;
  const imagesPerChunk = opts.imagesPerChunk ?? 4;
  const overlap = opts.overlap ?? true;
  const reserved = opts.reserved ?? 0;
  const budget = Math.max(1, textBudget - reserved);

  const chunks: PdfPage[][] = [];
  let current: PdfPage[] = [];
  let tokens = 0;
  let images = 0;

  for (const p of pages) {
    const cost = pageCost(p);
    const hasImg = Boolean(p.data_url);
    const wouldExceed =
      current.length > 0 && (tokens + cost > budget || (hasImg && images + 1 > imagesPerChunk));

    if (wouldExceed) {
      chunks.push(current);
      const tail = overlap ? current[current.length - 1] : undefined;
      // Only carry the overlap when it leaves room for this page too;
      // otherwise the new chunk starts over budget on arrival.
      const tailCost = tail ? pageCost(tail) : 0;
      const keepTail = tail != null && tailCost + cost <= budget;
      current = keepTail ? [tail!] : [];
      tokens = keepTail ? tailCost : 0;
      images = keepTail && tail!.data_url ? 1 : 0;
    }

    current.push(p);
    tokens += cost;
    if (hasImg) images++;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Group partial summaries for the reduce pass.
 *
 * Many chunk summaries can themselves exceed a model's context, so the
 * reduce is hierarchical: partials are batched to a budget and reduced
 * level by level until one group remains. Returns the batches for the
 * next level.
 */
export function groupForReduce(partials: string[], budget = 6000): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const p of partials) {
    const cost = estimateTokens(p) + 8;
    if (current.length > 0 && tokens + cost > budget) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
    current.push(p);
    tokens += cost;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Strip transient fields before a page record is persisted as a tool
 * result. `data_url` must never reach the conversation — the images go
 * to the summarizing sub-agent and stop there.
 */
export function stripTransient(p: PdfPage): PdfPage {
  const { data_url: _drop, ...rest } = p;
  return rest;
}

/**
 * Preamble for one page inside a sub-agent chunk.
 *
 * Provenance is spelled out because the summarizer must know which
 * spans came from the file and which were re-derived from pixels — and
 * because table *structure* is inferred even when the cell text is not.
 */
export function pageHeader(p: PdfPage): string {
  const bits = [`--- Page ${p.page} ---`];
  if (p.provenance === 'text_layer') {
    bits.push('(text below is from the PDF text layer)');
  } else {
    bits.push('(no text layer — anything reported for this page is read from the image)');
  }
  if (p.image_rendered) {
    bits.push(`(page image attached. Reason: ${p.render_reason ?? 'unknown'})`);
  } else if (p.planned_render_reason) {
    // The page wanted pixels and did not get them. Saying so prevents the
    // summarizer from treating an absent image as an absent figure.
    const skipReason = p.render_skipped ? ` Reason: ${p.render_skipped}.` : '';
    bits.push(
      `(LC needed a page image for ${p.planned_render_reason}. ` +
        `LC did not produce it.${skipReason} Visual content on this page is NOT represented.)`,
    );
  }
  if (p.tables_md?.length) {
    bits.push(
      `(${p.tables_md.length} table(s): cell text is from the text layer, ` +
        'row/column structure is inferred and may be wrong)',
    );
  }
  return bits.join(' ');
}
