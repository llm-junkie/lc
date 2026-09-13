import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEARCH_MAX_SCANNED_CALLS,
  SEARCH_MAX_SCANNED_BYTES,
  SEARCH_MAX_QUERY_CHARACTERS,
  SEARCH_MAX_QUERY_TERMS,
  SEARCH_MAX_SNIPPET_BYTES,
  SEARCH_YIELD_INTERVAL_CALLS,
  ToolHistorySearchInputError,
  foldText,
  parseSearchQuery,
  searchToolHistory,
  type ToolHistorySearchCandidate,
} from './tool-history-search.ts';
import { utf8ByteLength } from '../utf8-budget.ts';

function candidate(over: Partial<ToolHistorySearchCandidate> = {}): ToolHistorySearchCandidate {
  return {
    message_id: 'msg-1',
    tool_call_id: 'call-1',
    tool_name: 'lc_grep',
    arguments: '{}',
    output: '',
    is_error: false,
    created_at: 1_000,
    ...over,
  };
}

async function search(
  candidates: ToolHistorySearchCandidate[],
  query: string,
  options: Parameters<typeof searchToolHistory>[2] = {},
) {
  return searchToolHistory(candidates, parseSearchQuery(query), options);
}

describe('tool-history search — query validation', () => {
  it('rejects an empty query instead of treating it as list mode', () => {
    assert.throws(() => parseSearchQuery(''), ToolHistorySearchInputError);
  });

  it('rejects a whitespace-only query', () => {
    assert.throws(() => parseSearchQuery('   \t\n  '), ToolHistorySearchInputError);
  });

  it('keeps distinct terms in first-appearance order without duplicates', () => {
    const parsed = parseSearchQuery('beta Alpha beta GAMMA');
    assert.deepEqual(parsed.terms, ['beta', 'alpha', 'gamma']);
  });

  it('collapses whitespace runs in the phrase', () => {
    assert.equal(parseSearchQuery('foo   bar').phrase, 'foo bar');
  });

  it('accepts the exact query-character cap and rejects cap + 1 with a true remedy', () => {
    const exact = 'x'.repeat(SEARCH_MAX_QUERY_CHARACTERS);
    assert.equal(parseSearchQuery(exact).raw.length, SEARCH_MAX_QUERY_CHARACTERS);

    const oversized = `${exact}x`;
    assert.throws(
      () => parseSearchQuery(oversized),
      (error) => error instanceof ToolHistorySearchInputError
        && error.message.includes('Shorten query')
        && error.message.includes(String(SEARCH_MAX_QUERY_CHARACTERS)),
    );
    assert.doesNotThrow(() => parseSearchQuery(oversized.slice(0, SEARCH_MAX_QUERY_CHARACTERS)));

    const astralExact = '😀'.repeat(SEARCH_MAX_QUERY_CHARACTERS);
    assert.equal(parseSearchQuery(astralExact).raw, astralExact);
    assert.throws(() => parseSearchQuery(`${astralExact}😀`), ToolHistorySearchInputError);
  });

  it('accepts 16 distinct terms and rejects the seventeenth with a true remedy', () => {
    const terms = Array.from({ length: SEARCH_MAX_QUERY_TERMS + 1 }, (_, index) => `term${index}`);
    assert.equal(parseSearchQuery(terms.slice(0, SEARCH_MAX_QUERY_TERMS).join(' ')).terms.length, SEARCH_MAX_QUERY_TERMS);
    assert.throws(
      () => parseSearchQuery(terms.join(' ')),
      (error) => error instanceof ToolHistorySearchInputError
        && error.message.includes('Narrow query')
        && error.message.includes(String(SEARCH_MAX_QUERY_TERMS)),
    );
    assert.doesNotThrow(() => parseSearchQuery(terms.slice(0, SEARCH_MAX_QUERY_TERMS).join(' ')));
  });
});

describe('tool-history search — Unicode folding', () => {
  it('folds case in a locale-independent way', () => {
    assert.equal(foldText('ÄÖÜ Straße ΣΊΣΥΦΟΣ').folded, 'äöü straße σίσυφοσ');
  });

  it('maps every folded character back to a real original offset', () => {
    const source = 'aÉ😀z';
    const folded = foldText(source);
    for (let i = 0; i < folded.start.length; i++) {
      assert.ok(folded.start[i] >= 0 && folded.start[i] < source.length);
      assert.ok(folded.end[i] > folded.start[i] && folded.end[i] <= source.length);
    }
  });

  it('matches composed and decomposed forms of the same text', async () => {
    const decomposed = 'café receipt';
    const result = await search([candidate({ output: decomposed })], 'café');
    assert.equal(result.returned, 1);
    assert.deepEqual(result.hits[0].matched_fields, ['output']);
  });

  it('is case-insensitive across scripts', async () => {
    const result = await search([candidate({ output: 'ΣΊΣΥΦΟΣ rolled the ROCK' })], 'rock');
    assert.equal(result.returned, 1);
  });
});

describe('tool-history search — matching and filters', () => {
  it('reports every field that matched', async () => {
    const result = await search([candidate({
      tool_call_id: 'call-alpha',
      tool_name: 'lc_alpha_tool',
      arguments: '{"needle":"alpha"}',
      output: 'alpha appeared here',
    })], 'alpha');
    assert.deepEqual(result.hits[0].matched_fields, ['tool_call_id', 'tool_name', 'arguments', 'output']);
  });

  it('returns no fabricated hits on a miss and reports full coverage', async () => {
    const result = await search([candidate({ output: 'nothing relevant' })], 'absent');
    assert.equal(result.returned, 0);
    assert.equal(result.matched_calls, 0);
    assert.equal(result.hits.length, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.eligible_calls, 1);
    assert.equal(result.scanned_calls, 1);
    assert.equal(result.scan_coverage_pct, 100);
  });

  it('gives every hit a tool_call_id usable for exact retrieval', async () => {
    const candidates = [
      candidate({ tool_call_id: 'call-a', output: 'needle a' }),
      candidate({ tool_call_id: 'call-b', output: 'needle b' }),
    ];
    const result = await search(candidates, 'needle');
    const ids = new Set(candidates.map((c) => c.tool_call_id));
    assert.equal(result.hits.length, 2);
    for (const hit of result.hits) assert.ok(ids.has(hit.tool_call_id));
  });
});

describe('tool-history search — ranking', () => {
  it('ranks an exact tool_call_id above everything else', async () => {
    const result = await search([
      candidate({ tool_call_id: 'other', output: 'call-target call-target call-target' }),
      candidate({ tool_call_id: 'call-target', output: 'unrelated' }),
    ], 'call-target');
    assert.equal(result.hits[0].tool_call_id, 'call-target');
  });

  it('ranks an exact tool name above a body mention', async () => {
    const result = await search([
      candidate({ tool_call_id: 'a', tool_name: 'lc_grep', output: 'lc_read_file was mentioned' }),
      candidate({ tool_call_id: 'b', tool_name: 'lc_read_file', output: 'unrelated' }),
    ], 'lc_read_file');
    assert.equal(result.hits[0].tool_call_id, 'b');
  });

  it('ranks an exact phrase above scattered terms', async () => {
    const result = await search([
      candidate({ tool_call_id: 'scattered', output: 'alpha somewhere and later beta' }),
      candidate({ tool_call_id: 'phrase', output: 'the alpha beta pair' }),
    ], 'alpha beta');
    assert.equal(result.hits[0].tool_call_id, 'phrase');
  });

  it('ranks all-terms above partial-term matches', async () => {
    const result = await search([
      candidate({ tool_call_id: 'partial', output: 'alpha only' }),
      candidate({ tool_call_id: 'complete', output: 'alpha here, beta far away' }),
    ], 'alpha beta');
    assert.equal(result.hits[0].tool_call_id, 'complete');
  });

  it('ranks by distinct matched term count', async () => {
    const result = await search([
      candidate({ tool_call_id: 'one', output: 'alpha' }),
      candidate({ tool_call_id: 'two', output: 'alpha beta' }),
    ], 'alpha beta gamma');
    assert.equal(result.hits[0].tool_call_id, 'two');
  });

  it('breaks remaining ties with the newer result first', async () => {
    const result = await search([
      candidate({ tool_call_id: 'older', output: 'needle', created_at: 10 }),
      candidate({ tool_call_id: 'newer', output: 'needle', created_at: 99 }),
    ], 'needle');
    assert.deepEqual(result.hits.map((h) => h.tool_call_id), ['newer', 'older']);
  });

  it('breaks a full tie by tool_call_id lexical order', async () => {
    const result = await search([
      candidate({ tool_call_id: 'call-z', output: 'needle', created_at: 5 }),
      candidate({ tool_call_id: 'call-a', output: 'needle', created_at: 5 }),
    ], 'needle');
    assert.deepEqual(result.hits.map((h) => h.tool_call_id), ['call-a', 'call-z']);
  });

  it('is deterministic across repeated runs of the same input', async () => {
    const candidates = Array.from({ length: 40 }, (_, i) => candidate({
      tool_call_id: `call-${String(i).padStart(3, '0')}`,
      output: i % 2 === 0 ? 'needle alpha' : 'needle',
      created_at: 1000 + (i % 5),
    }));
    const first = await search(candidates, 'needle alpha');
    const second = await search(candidates, 'needle alpha');
    assert.deepEqual(first.hits, second.hits);
  });
});

describe('tool-history search — snippets', () => {
  it('quotes verbatim original text with no invented ellipsis or marker', async () => {
    const output = `${'x'.repeat(400)}NEEDLE${'y'.repeat(400)}`;
    const result = await search([candidate({ output })], 'needle');
    const { snippet } = result.hits[0];
    assert.ok(output.includes(snippet), 'snippet must be a literal substring of the stored field');
    assert.ok(!snippet.includes('…'));
    assert.ok(!snippet.includes('[truncated]'));
  });

  it('preserves original casing in the snippet', async () => {
    const result = await search([candidate({ output: 'The NeEdLe Is Here' })], 'needle');
    assert.ok(result.hits[0].snippet.includes('NeEdLe'));
  });

  it('names the field the snippet came from', async () => {
    const result = await search([candidate({
      arguments: '{"pattern":"needle"}',
      output: 'no match in output',
    })], 'needle');
    assert.equal(result.hits[0].snippet_field, 'arguments');
  });

  it('keeps snippets inside the byte budget and valid UTF-8 for multibyte text', async () => {
    const output = `${'あ'.repeat(500)}針${'い'.repeat(500)}`;
    const result = await search([candidate({ output })], '針');
    const { snippet } = result.hits[0];
    assert.ok(utf8ByteLength(snippet) <= SEARCH_MAX_SNIPPET_BYTES);
    assert.equal(snippet, Buffer.from(snippet, 'utf8').toString('utf8'));
    assert.ok(!/[\uD800-\uDFFF]/.test(snippet.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')));
    assert.ok(output.includes(snippet));
  });

  it('never splits an astral character in a snippet', async () => {
    const output = `${'😀'.repeat(400)}needle${'😀'.repeat(400)}`;
    const result = await search([candidate({ output })], 'needle');
    const { snippet } = result.hits[0];
    assert.ok(utf8ByteLength(snippet) <= SEARCH_MAX_SNIPPET_BYTES);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(snippet));
    assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(snippet));
  });

  it('marks a snippet truncated only when the byte cap cut its context window', async () => {
    // The context window is bounded in characters, so an ASCII window always
    // fits the byte cap; a multibyte window of the same length does not.
    const ascii = await search([candidate({ output: `${'z'.repeat(2000)}needle${'z'.repeat(2000)}` })], 'needle');
    assert.equal(ascii.hits[0].snippet_truncated, false);
    assert.ok(utf8ByteLength(ascii.hits[0].snippet) <= SEARCH_MAX_SNIPPET_BYTES);

    const multibyte = await search([candidate({ output: `${'あ'.repeat(2000)}needle${'あ'.repeat(2000)}` })], 'needle');
    assert.equal(multibyte.hits[0].snippet_truncated, true);
    assert.ok(utf8ByteLength(multibyte.hits[0].snippet) <= SEARCH_MAX_SNIPPET_BYTES);
  });
});

describe('tool-history search — bounds and honesty', () => {
  it('stops at the scanned-call limit and reports partial coverage', async () => {
    const candidates = Array.from({ length: SEARCH_MAX_SCANNED_CALLS + 25 }, (_, i) => candidate({
      tool_call_id: `call-${i}`,
      output: 'needle',
    }));
    const result = await search(candidates, 'needle', {
      // This case owns the deterministic call-limit boundary. The independent
      // time-limit case below advances the injectable clock explicitly.
      now: () => 0,
    });
    assert.equal(result.scanned_calls, SEARCH_MAX_SCANNED_CALLS);
    assert.equal(result.eligible_calls, SEARCH_MAX_SCANNED_CALLS + 25);
    assert.equal(result.truncated, true);
    assert.ok(result.truncation_reasons?.includes('scan-call-limit'));
    assert.ok(result.scan_coverage_pct < 100);
  });

  it('caps returned hits and reports the result-count limit', async () => {
    const candidates = Array.from({ length: 30 }, (_, i) => candidate({
      tool_call_id: `call-${String(i).padStart(3, '0')}`,
      output: 'needle',
    }));
    const result = await search(candidates, 'needle', { maxResults: 5 });
    assert.equal(result.returned, 5);
    assert.equal(result.matched_calls, 30);
    assert.ok(result.truncation_reasons?.includes('result-count-limit'));
  });

  it('clamps max_results to the hard maximum', async () => {
    const candidates = Array.from({ length: 80 }, (_, i) => candidate({
      tool_call_id: `call-${String(i).padStart(3, '0')}`,
      output: 'needle',
    }));
    const result = await search(candidates, 'needle', { maxResults: 5_000 });
    assert.equal(result.returned, 50);
  });

  it('stops on the response byte budget and reports it', async () => {
    const candidates = Array.from({ length: 20 }, (_, i) => candidate({
      tool_call_id: `call-${String(i).padStart(3, '0')}`,
      output: `${'q'.repeat(600)} needle ${'q'.repeat(600)}`,
    }));
    const result = await search(candidates, 'needle', { maxResults: 50, maxResponseBytes: 900 });
    assert.ok(result.returned >= 1, 'the first hit should fit this budget');
    assert.ok(result.returned < 20);
    assert.ok(result.truncation_reasons?.includes('result-byte-limit'));
  });

  it('returns no hit when the first hit exceeds the response byte budget', async () => {
    const result = await search(
      [candidate({ output: 'needle' })],
      'needle',
      { maxResponseBytes: 1 },
    );
    assert.equal(result.returned, 0);
    assert.deepEqual(result.hits, []);
    assert.ok(result.truncation_reasons.includes('result-byte-limit'));
  });

  it('does not exceed the total scan byte limit inside a candidate', async () => {
    const large = `needle${'x'.repeat(1024 * 1024 + 100)}`;
    const candidates = Array.from({ length: 4 }, (_, index) => candidate({
      message_id: `message-${index}`,
      tool_call_id: `call-${index}`,
      arguments: large,
      output: large,
    }));
    const result = await search(candidates, 'needle', { maxResults: 50, now: () => 0 });
    assert.ok(result.scanned_bytes <= SEARCH_MAX_SCANNED_BYTES);
    assert.ok(result.truncation_reasons.includes('scan-byte-limit'));
  });

  it('reports time-limit with honest coverage rather than a proven miss', async () => {
    const candidates = Array.from({ length: SEARCH_YIELD_INTERVAL_CALLS * 4 }, (_, i) => candidate({
      tool_call_id: `call-${i}`,
      output: 'needle',
    }));
    let clock = 0;
    const result = await search(candidates, 'needle', {
      // Jump past the deadline at the first yield checkpoint.
      now: () => {
        clock += 1_000;
        return clock;
      },
    });
    assert.ok(result.truncation_reasons?.includes('time-limit'));
    assert.ok(result.scanned_calls < candidates.length);
    assert.ok(result.scan_coverage_pct < 100);
    assert.equal(result.truncated, true);
  });

  it('yields cooperatively so a long scan cannot block the renderer', async () => {
    const candidates = Array.from({ length: SEARCH_YIELD_INTERVAL_CALLS * 3 }, (_, i) => candidate({
      tool_call_id: `call-${i}`,
      output: 'needle',
    }));
    let yields = 0;
    await search(candidates, 'needle', {
      yieldToEventLoop: async () => {
        yields++;
      },
    });
    assert.ok(yields >= 2, `expected cooperative yields, saw ${yields}`);
  });

  it('handles a single very large output without exceeding snippet bounds', async () => {
    const output = `${'a'.repeat(3_000_000)}needle${'b'.repeat(3_000_000)}`;
    const result = await search([candidate({ output })], 'needle');
    assert.equal(result.scanned_calls, 1);
    assert.ok(utf8ByteLength(result.hits[0]?.snippet ?? '') <= SEARCH_MAX_SNIPPET_BYTES);
    assert.ok(result.truncation_reasons?.includes('scan-byte-limit'));
  });

  it('reports 100% coverage when nothing was eligible', async () => {
    const result = await search([], 'needle');
    assert.equal(result.eligible_calls, 0);
    assert.equal(result.scan_coverage_pct, 100);
    assert.equal(result.truncated, false);
  });

  it('echoes the original query text back', async () => {
    const result = await search([candidate({ output: 'needle' })], 'NeEdLe');
    assert.equal(result.query, 'NeEdLe');
  });
});
