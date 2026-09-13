/**
 * Coverage for the PDF schema, page-range grammar, profile handoff, and
 * native delegation. The pure chunk fixtures remain a migration oracle.
 *
 * Extraction and summarization run in Rust. Native tests cover rendering
 * against independent fixtures, map/reduce, protocols, and cancellation.
 *
 * Several tests here exist because the behavior they pin was wrong:
 * `parsePageRange("abc")` used to return `undefined`, which the bridge
 * read as "every page"; a large overlap page could push a chunk over
 * budget; and full depth rendered before checking whether any model
 * could see the images.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  readPdf,
  visionAvailable,
} from './read_pdf.ts';
import type { ReadPdfOutput } from './read_pdf';
import {
  chunkPages,
  estimateTokens,
  groupForReduce,
  pageCost,
  pageHeader,
  parsePageRange,
  stripTransient,
  MAX_RANGE_PAGES,
  type PageRangeField,
  type PdfPage,
} from './pdf-chunking.ts';
import { createMockBridge, type ReadPdfArgs, type ReadPdfResult } from '../sandbox-bridge.ts';
import type { ToolHandlerContext } from '../types';

/* ------------------------------------------------------------------ */
/*  parsePageRange — must fail closed                                  */
/* ------------------------------------------------------------------ */

describe('parsePageRange', () => {
  const ok = (e: string) => {
    const r = parsePageRange(e);
    assert.equal(r.kind, 'ok', `expected ok for ${e}, got ${JSON.stringify(r)}`);
    return (r as { kind: 'ok'; pages: number[] }).pages;
  };
  const invalid = (e: string | undefined, field?: PageRangeField) => {
    const r = parsePageRange(e, field);
    assert.equal(r.kind, 'invalid', `expected invalid for ${e}, got ${JSON.stringify(r)}`);
    return (r as { kind: 'invalid'; message: string }).message;
  };

  it('treats an omitted or empty value as absent', () => {
    assert.equal(parsePageRange(undefined).kind, 'omitted');
    assert.equal(parsePageRange(null).kind, 'omitted');
    // Models fill every declared optional string rather than leaving it
    // out. An empty value names no page, so it cannot be misread as a
    // selection — the risk that "abc" carries. Rejecting it produced a
    // retry loop and taught a model to pin force_render to "1".
    assert.equal(parsePageRange('').kind, 'omitted');
    assert.equal(parsePageRange('   ').kind, 'omitted');
    assert.equal(parsePageRange('', 'force_render').kind, 'omitted');
    assert.equal(parsePageRange('\t \n', 'force_render').kind, 'omitted');
  });

  it('words every rejection for the field the value came from', () => {
    // force_render used to borrow the pages wording, which told the
    // caller that omitting force_render reads every page. It does the
    // opposite: it renders no extra pages. Every message shape the
    // shared parser can produce must carry the caller's own label —
    // testing the helper alone cannot see wording that is wrong for
    // the second caller, so pin each shape for each field.
    const long = '1,'.repeat(500);
    assert.match(invalid(long, 'pages'), /^Page selection/);
    assert.match(invalid(long, 'force_render'), /^Render selection/);
    assert.doesNotMatch(invalid(long, 'force_render'), /read every page/);

    // Grammar errors quote the offending fragment and name the field.
    assert.match(
      invalid('abc', 'pages'),
      /^"abc" in the page selection is neither a page number nor a page range\. Use one-based pages such as "1-5,12", or omit pages to read every page\.$/,
    );
    assert.match(
      invalid('abc', 'force_render'),
      /^"abc" in the render selection is neither a page number nor a page range\. Use one-based pages such as "1-5,12", or omit force_render to force no extra pages\.$/,
    );

    // Page-zero errors carry the field they came from.
    assert.match(invalid('0', 'pages'), /not valid for the page selection\.$/);
    assert.match(invalid('0', 'force_render'), /not valid for the render selection\.$/);

    // Beyond-plausible-document errors lead with the field label and quote
    // the caller's own fragment — never the parsed bound, which Number()
    // can render as 1e+30 or Infinity for long digit runs.
    assert.match(
      invalid('1-1000000000', 'pages'),
      /^Page selection fragment "1-1000000000" names a page beyond any plausible document \(limit 1000000\)\.$/,
    );
    assert.match(
      invalid('1-1000000000', 'force_render'),
      /^Render selection fragment "1-1000000000" names a page beyond any plausible document \(limit 1000000\)\.$/,
    );

    // Cardinality errors keep the per-field label and a remedy true for both.
    assert.match(invalid('1-999999', 'pages'), /^Page selection covers more than 2000 pages\. Narrow the range and retry with smaller selections\.$/);
    assert.match(invalid('1-999999', 'force_render'), /^Render selection covers more than 2000 pages\. Narrow the range and retry with smaller selections\.$/);

    // Empty-fragment errors name the field.
    assert.match(invalid('1,,2', 'force_render'), /^Empty fragment in render selection/);
  });

  it('parses singles, ranges, and mixtures', () => {
    assert.deepEqual(ok('3'), [3]);
    assert.deepEqual(ok('1-4'), [1, 2, 3, 4]);
    assert.deepEqual(ok('1-3,7,10-11'), [1, 2, 3, 7, 10, 11]);
  });

  it('sorts, de-duplicates, and accepts an inverted range', () => {
    assert.deepEqual(ok('5,1-3,2,5'), [1, 2, 3, 5]);
    assert.deepEqual(ok('9-7'), [7, 8, 9]);
  });

  it('rejects garbage instead of silently reading everything', () => {
    // The regression: this used to return undefined → "all pages".
    assert.match(invalid('abc'), /neither a page number nor a page range/);
    assert.match(invalid('1-'), /neither a page number nor a page range/);
    assert.match(invalid('1..3'), /neither a page number nor a page range/);
    assert.match(invalid('-5'), /neither a page number nor a page range/);
    assert.match(invalid('1,,2'), /Empty fragment in page selection/);
  });

  it('rejects page zero rather than dropping it', () => {
    assert.match(invalid('0'), /numbered from 1/);
    // A mixed expression fails as a whole — silently honoring only the
    // valid half would read pages the caller did not ask for.
    assert.match(invalid('0,2'), /numbered from 1/);
  });

  it('rejects an enormous range by arithmetic, without enumerating it', () => {
    const started = Date.now();
    // Just under the per-page-number ceiling so the cardinality check
    // is what rejects it. Expanding this would hang the webview.
    const msg = invalid('1-999999');
    assert.match(msg, new RegExp(`${MAX_RANGE_PAGES}`));
    assert.ok(Date.now() - started < 250, 'must reject by arithmetic, not by expanding');
  });

  it('rejects an implausibly large page number outright', () => {
    // Caught by the page-number ceiling before cardinality is computed.
    assert.equal(parsePageRange('1-1000000000').kind, 'invalid');
  });

  it('quotes the caller\'s fragment when Number() would lose it', () => {
    // Number() loses precision above 2^53 and saturates to Infinity near
    // 10^308; both fit inside the 400-character expression cap. The
    // beyond-limit message must quote what the caller wrote, never the
    // parsed value, so neither "1e+30" nor "Infinity" can reach the model.
    const digits31 = '1' + '0'.repeat(30);
    assert.equal(
      invalid(digits31, 'pages'),
      `Page selection fragment "${digits31}" names a page beyond any plausible document (limit 1000000).`,
    );
    const nines320 = '9'.repeat(320);
    assert.equal(
      invalid(`1-${nines320}`, 'force_render'),
      `Render selection fragment "1-${nines320}" names a page beyond any plausible document (limit 1000000).`,
    );
  });

  it('rejects an over-long expression', () => {
    assert.match(invalid('1,'.repeat(500)), /over the .* limit|not a page/);
  });

  it('accepts a large but bounded selection', () => {
    assert.equal(ok(`1-${MAX_RANGE_PAGES}`).length, MAX_RANGE_PAGES);
  });
});

/* ------------------------------------------------------------------ */
/*  chunking budgets                                                   */
/* ------------------------------------------------------------------ */

function page(n: number, text: string, extra: Partial<PdfPage> = {}): PdfPage {
  return {
    page: n,
    chars: text.length,
    provenance: 'text_layer',
    image_rendered: false,
    render_reason: null,
    text,
    ...extra,
  };
}

describe('pageCost', () => {
  it('counts the header and table markdown, not just text', () => {
    const bare = page(1, 'hello');
    const withTable = page(1, 'hello', { tables_md: ['| a | b |\n|---|---|\n| 1 | 2 |'] });
    assert.ok(
      pageCost(withTable) > pageCost(bare),
      'table markdown must consume budget',
    );
    assert.ok(pageCost(bare) > estimateTokens('hello'), 'header must consume budget');
  });
});

describe('chunkPages', () => {
  const within = (chunks: PdfPage[][], budget: number) => {
    for (const c of chunks) {
      const total = c.reduce((n, p) => n + pageCost(p), 0);
      // A single page bigger than the budget is unavoidable without
      // splitting mid-page; anything else must fit.
      if (c.length > 1) {
        assert.ok(total <= budget, `chunk of ${c.length} pages cost ${total} > ${budget}`);
      }
    }
  };

  it('keeps everything in one chunk when it fits', () => {
    const chunks = chunkPages([page(1, 'a'.repeat(100)), page(2, 'b'.repeat(100))], {
      textBudget: 1000,
    });
    assert.equal(chunks.length, 1);
  });

  it('keeps every multi-page chunk within budget', () => {
    const pages = [1, 2, 3, 4, 5, 6].map((n) => page(n, 'x'.repeat(1000)));
    const chunks = chunkPages(pages, { textBudget: 500 });
    within(chunks, 500);
  });

  it('drops the overlap rather than exceeding budget with a large tail page', () => {
    // The regression: a fat tail page carried as overlap put the next
    // chunk over budget before it held any new content.
    const pages = [page(1, 'x'.repeat(1600)), page(2, 'y'.repeat(1600)), page(3, 'z'.repeat(1600))];
    const chunks = chunkPages(pages, { textBudget: 500 });
    within(chunks, 500);
  });

  it('overlaps by one page when the budget allows', () => {
    // ~405 tokens per page against a 1000 budget: two fit, a third
    // forces a split, and tail + next still fits so the overlap is kept.
    const pages = [1, 2, 3, 4].map((n) => page(n, 'x'.repeat(1500)));
    const chunks = chunkPages(pages, { textBudget: 1000, overlap: true });
    assert.ok(chunks.length > 1);
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1][chunks[i - 1].length - 1].page;
      assert.equal(chunks[i][0].page, prevTail, 'boundary page should repeat');
    }
  });

  it('loses no page when overlap is off', () => {
    const pages = [1, 2, 3, 4].map((n) => page(n, 'x'.repeat(1000)));
    const chunks = chunkPages(pages, { textBudget: 500, overlap: false });
    assert.deepEqual(chunks.flat().map((p) => p.page), [1, 2, 3, 4]);
  });

  it('accounts for reserved instruction tokens', () => {
    const pages = [1, 2].map((n) => page(n, 'x'.repeat(1200)));
    const chunks = chunkPages(pages, { textBudget: 700, reserved: 400 });
    assert.ok(chunks.length > 1, 'reserved tokens must tighten the budget');
  });

  it('splits on the image budget even when text fits', () => {
    const pages = [1, 2, 3, 4, 5].map((n) =>
      page(n, 'tiny', { data_url: 'data:image/png;base64,AAAA', image_rendered: true }),
    );
    const chunks = chunkPages(pages, { textBudget: 100000, imagesPerChunk: 2 });
    assert.ok(chunks.length >= 3);
  });

  it('gives an over-budget page its own chunk rather than dropping it', () => {
    const chunks = chunkPages([page(1, 'x'.repeat(80_000))], { textBudget: 100 });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0][0].page, 1);
  });

  it('returns no chunks for no pages', () => {
    assert.deepEqual(chunkPages([]), []);
  });
});

describe('groupForReduce', () => {
  it('batches partials to a budget so a reduce cannot blow context', () => {
    const partials = Array.from({ length: 20 }, () => 'x'.repeat(4000));
    const groups = groupForReduce(partials, 6000);
    assert.ok(groups.length > 1, 'expected several batches');
    for (const g of groups) {
      if (g.length > 1) {
        const cost = g.reduce((n, p) => n + estimateTokens(p) + 8, 0);
        assert.ok(cost <= 6000, `batch cost ${cost} over budget`);
      }
    }
    assert.equal(groups.flat().length, 20, 'no partial dropped');
  });
});

/* ------------------------------------------------------------------ */
/*  provenance helpers                                                 */
/* ------------------------------------------------------------------ */

describe('stripTransient', () => {
  it('removes the data URL but keeps the decision metadata', () => {
    const p = page(1, 'hello', { data_url: 'data:image/png;base64,AAAA', image_rendered: true, render_reason: 'chart' });
    const clean = stripTransient(p);
    assert.equal(clean.data_url, undefined);
    assert.equal(clean.image_rendered, true);
    assert.equal(clean.render_reason, 'chart');
  });
});

describe('pageHeader', () => {
  it('marks ordinary text-layer provenance explicitly', () => {
    assert.match(pageHeader(page(1, 'x')), /from the PDF text layer/);
  });

  it('flags a page with no text layer as read from pixels', () => {
    const h = pageHeader({ ...page(4, ''), provenance: 'none' });
    assert.match(h, /Page 4/);
    assert.match(h, /read from the image/i);
  });

  it('describes table structure as inferred, not exact', () => {
    const h = pageHeader(page(3, 'x', { tables_md: ['| a |'] }));
    assert.match(h, /cell text is from the text layer/);
    assert.match(h, /structure is inferred/);
    assert.ok(!/exact, quotable/.test(h), 'structure must not be called exact');
  });

  it('says so when a needed page image was not produced', () => {
    const h = pageHeader(
      page(9, 'x', { planned_render_reason: 'chart', render_skipped: 'render_budget' }),
    );
    assert.match(h, /needed a page image for chart\. LC did not produce it/);
    assert.match(h, /NOT represented/);
  });
});

/* ------------------------------------------------------------------ */
/*  vision gate                                                        */
/* ------------------------------------------------------------------ */

describe('visionAvailable', () => {
  it('trusts an explicitly configured vision model', () => {
    assert.equal(visionAvailable({ visionModel: 'qwen-vl', modelIsVision: false }), true);
  });

  it('falls back to the chat model and refuses when it cannot see', () => {
    assert.equal(visionAvailable({ visionModel: '', modelIsVision: false }), false);
    assert.equal(visionAvailable({ visionModel: '   ', modelIsVision: false }), false);
  });

  it('allows when the chat model is vision-capable or unknown', () => {
    assert.equal(visionAvailable({ visionModel: '', modelIsVision: true }), true);
    assert.equal(visionAvailable({ visionModel: '', modelIsVision: undefined }), true);
  });
});

function nativeContext(onCall: (args: ReadPdfArgs) => void = () => { }, overrides: Record<string, unknown> = {}): ToolHandlerContext {
  const result: ReadPdfResult = { files: [], warnings: [] };
  return {
    sandbox: createMockBridge({ readPdf: async args => { onCall(args); return result; } }),
    config: {
      allowedRoots: ['D:/docs'], visionModel: '', pdfSummarizeModel: '',
      llmServerUrl: 'http://localhost:1234/v1', llmModel: 'same-id',
      llmApiStyle: 'responses', llmApiVariant: 'openai', llmApiKey: 'fixture-key',
      llmIncludeLcIdentifierHeader: true,
      llmIncludeAdditionalRequestHeaders: true,
      llmRequestHeaders: [{ name: 'X-Fixture', value: 'owner-profile' }],
      ...overrides,
    },
    signal: new AbortController().signal,
    identity: { operationId: 'op', groupId: 'group' },
    llmCall: async () => { throw new Error('PDF summarization must stay native'); },
  } as unknown as ToolHandlerContext;
}

describe('native PDF handoff', () => {
  it('preserves active profile, headers, page validation, and cancellation identity', async () => {
    let args: ReadPdfArgs | undefined;
    const out: ReadPdfOutput = await readPdf.run({ paths: ['D:/docs/a.pdf'], pages: '3,1-2', depth: 'full' }, nativeContext(a => { args = a; }));
    assert.deepEqual(out, { files: [], warnings: [] });
    assert.deepEqual(args?.pages, [1, 2, 3]);
    assert.equal(args?.include_text, false);
    assert.equal(args?.summarize, true);
    assert.equal(args?.text_model?.api_style, 'responses');
    assert.equal(args?.text_model?.api_key, 'fixture-key');
    assert.equal(args?.vision_model?.model, 'same-id');
    assert.ok(args?.text_model?.request_headers.some(([key, value]) => key === 'X-Fixture' && value === 'owner-profile'));
    assert.equal(args?.call_id, 'op'); assert.equal(args?.group_id, 'group');
    assert.ok(args?.deadline_ms && args.deadline_ms <= 300_000);
  });

  it('always requests text for summarize:false and never resolves either model', async () => {
    for (const include_text of [true, false, undefined]) {
      let args: ReadPdfArgs | undefined;
      const input = { paths: ['D:/docs/a.pdf'], summarize: false, include_text, force_render: '   ' };
      await readPdf.run(input, nativeContext(a => { args = a; }, { pdfSummarizeModel: 'unresolvable-text-model', visionModel: 'unresolvable-vision-model' }));
      assert.equal(args?.include_text, true); assert.equal(args?.summarize, false);
      assert.equal(args?.text_model, undefined); assert.equal(args?.vision_model, undefined);
      assert.equal(args?.force_render, undefined); assert.equal(input.include_text, include_text);
    }
  });

  it('text-only reads do not resolve an unused vision model', async () => {
    await readPdf.run({ paths: ['D:/docs/a.pdf'] }, nativeContext(args => assert.equal(args.vision_model, undefined), { visionModel: 'unresolvable-vision-model' }));
  });

  it('rejects conflicting rendering options and malformed selections before native work', async () => {
    for (const extra of [{ summarize: false, depth: 'full' as const }, { summarize: false, force_render: '1' }, { pages: 'abc' }, { force_render: 'auto' }]) {
      await assert.rejects(readPdf.run({ paths: ['D:/docs/a.pdf'], ...extra }, nativeContext(() => assert.fail('must not invoke native'))));
    }
  });

  it('passes the capability verdict to native and respects the original deadline', async () => {
    await readPdf.run({ paths: ['D:/docs/a.pdf'], depth: 'full' }, nativeContext(args => {
      assert.equal(args.vision_available, false); assert.equal(args.vision_model, undefined);
      assert.equal(args.depth, 'full');
    }, { modelIsVision: false }));
    await assert.rejects(readPdf.run({ paths: ['D:/docs/a.pdf'] }, nativeContext(() => assert.fail('expired'), { deadlineMs: Date.now() - 1 })), { code: 'Timeout' });
    const ctx = nativeContext(() => assert.fail('aborted')); const controller = new AbortController(); controller.abort(); ctx.signal = controller.signal;
    await assert.rejects(readPdf.run({ paths: ['D:/docs/a.pdf'] }, ctx), { code: 'Aborted' });
  });
});
