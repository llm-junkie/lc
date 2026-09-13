/**
 * `countTokens` — accuracy on ordinary text, and bounded cost on the
 * pathological input that froze LC in production.
 *
 * A `lc_run_shell` result carrying `python -c "print('x' * 2000000)"` reaches
 * the frontend as ~1 MiB with no whitespace. BPE cost is superlinear in the
 * length of one unbroken run, so encoding it verbatim blocks the main thread
 * for minutes — on every render, because TokenMeter counts every message.
 * See docs/architecture.md, "Token counting is hostile-input hardened".
 *
 * Run with:
 *   npx tsx --test src/utils/tokens.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from 'gpt-tokenizer';
import { countTokens } from './tokens.ts';

describe('countTokens — ordinary text', () => {
  it('returns 0 for empty input', () => {
    assert.equal(countTokens(''), 0);
  });

  it('matches the raw encoder exactly', () => {
    // The guard must be inert for anything a user or model normally writes.
    const samples = [
      'hello world',
      'The quick brown fox jumps over the lazy dog. '.repeat(500),
      JSON.stringify({ tool: 'lc_read_file', paths: ['D:\\DEV\\home\\tests\\what'] }),
      '# Heading\n\n- bullet\n- bullet\n\n```ts\nconst x = 1;\n```\n',
    ];
    for (const s of samples) {
      assert.equal(countTokens(s), encode(s).length, `changed the count for: ${s.slice(0, 40)}`);
    }
  });

  it('leaves a run at the sampling threshold untouched', () => {
    const atLimit = 'x'.repeat(1024);
    assert.equal(countTokens(atLimit), encode(atLimit).length);
  });

  it('counts tokenizer-looking sentinels as ordinary text', () => {
    const samples = [
      'literal <|endoftext|> marker',
      'comparison: <|fim_prefix|> and <|fim_suffix|>',
    ];
    const literalOptions = { disallowedSpecial: new Set<string>() };
    for (const sample of samples) {
      assert.equal(
        countTokens(sample),
        encode(sample, literalOptions).length,
        `did not count the sentinel as ordinary text: ${sample.slice(0, 60)}`,
      );
    }

    // A repeated sentinel also exercises the long-unbroken-run estimator. It
    // is intentionally approximate, but it must remain bounded and nonzero.
    assert.ok(countTokens(`<|endoftext|>${'<|fim_prefix|>'.repeat(100)}`) > 0);
  });
});

describe('countTokens — long unbroken runs', () => {
  it('stays fast on the input that froze the app', () => {
    // 200 K unbroken chars took ~30 s to encode verbatim; 1 MiB took minutes.
    // The bound is deliberately loose — the point is orders of magnitude.
    const blob = 'x'.repeat(200_000);
    const started = performance.now();
    const tokens = countTokens(blob);
    const elapsed = performance.now() - started;
    assert.ok(tokens > 0, 'still returns a count');
    assert.ok(elapsed < 2_000, `expected well under 2 s, took ${elapsed.toFixed(0)} ms`);
  });

  it('handles the exact production input without throwing', () => {
    // What the frontend actually received: `python -c "print('x' * 2000000)"`
    // capped by Rust at OUTPUT_CAP_BYTES. Unguarded, encode() spun for
    // 7 min 55 s and then threw `RangeError: Maximum call stack size exceeded`
    // from `tokensArray.push(...tokens)` — the merged run is too large to
    // spread into push. Both failure modes have to be gone.
    const produced = 'x'.repeat(1024 * 1024);
    const started = performance.now();
    const tokens = countTokens(produced);
    const elapsed = performance.now() - started;
    assert.ok(tokens > 0, 'returns a count instead of throwing');
    assert.ok(elapsed < 2_000, `expected well under 2 s, took ${elapsed.toFixed(0)} ms`);
  });

  it('handles an 8 MiB live-reasoning completion without overflowing V8', () => {
    // An unbounded `\S{1025,}` replacement protected the tokenizer itself but
    // recursively matched this entire run and overflowed in String.replace.
    const reasoning = 'x'.repeat(8 * 1024 * 1024);
    const started = performance.now();
    const tokens = countTokens(reasoning);
    const elapsed = performance.now() - started;
    assert.ok(tokens > 0, 'returns a completion estimate instead of throwing');
    assert.ok(elapsed < 2_000, `expected well under 2 s, took ${elapsed.toFixed(0)} ms`);
  });

  it('stays bounded immediately below, at, and above the sampling boundary', () => {
    for (const mebibytes of [1, 2, 4, 8]) {
      const totalChars = mebibytes * 1024 * 1024;
      for (const runChars of [1023, 1024, 1025]) {
        const block = `${'x'.repeat(runChars)} `;
        const text = block.repeat(Math.ceil(totalChars / block.length)).slice(0, totalChars);
        const started = performance.now();
        const tokens = countTokens(text);
        const elapsed = performance.now() - started;
        assert.ok(tokens > 0);
        assert.ok(
          elapsed < 2_000,
          `${mebibytes} MiB with ${runChars}-character runs took ${elapsed.toFixed(0)} ms`,
        );
        const exact = encode(text).length;
        const relativeError = Math.abs(tokens - exact) / exact;
        assert.ok(
          relativeError < 0.02,
          `expected the bounded estimate within 2%, got ${(relativeError * 100).toFixed(2)}%`,
        );
      }
    }
  });

  it('keeps a normal field exact through the full-text threshold', () => {
    const text = 'ordinary prose with punctuation. '.repeat(8_192).slice(0, 256 * 1024);
    assert.equal(text.length, 256 * 1024);
    assert.equal(countTokens(text), encode(text).length);
  });

  it('keeps a representative mixed-density estimate within 5%', () => {
    const block = `${'hello world '.repeat(64)}${'你 '.repeat(512)}`;
    const text = block.repeat(1_000).slice(0, 300 * 1_024);
    const exact = encode(text).length;
    const estimate = countTokens(text);
    const relativeError = Math.abs(estimate - exact) / exact;
    assert.ok(
      relativeError < 0.05,
      `representative mixed density produced ${(relativeError * 100).toFixed(2)}% error`,
    );
  });

  it('scales the estimate with the length of the run', () => {
    const short = countTokens('x'.repeat(1024));
    const long = countTokens('x'.repeat(1024 * 100));
    const ratio = long / short;
    assert.ok(ratio > 90 && ratio < 110, `expected ~100x, got ${ratio.toFixed(1)}x`);
  });

  it('counts the text surrounding a blob as usual', () => {
    const prose = 'the quick brown fox. ';
    const withBlob = `${prose}${'x'.repeat(50_000)} ${prose}`;
    const tokens = countTokens(withBlob);
    // Prose on both sides plus the estimated blob — never fewer than the prose
    // alone, and the blob must actually contribute.
    assert.ok(tokens > countTokens(`${prose} ${prose}`) + 1_000);
  });

  it('handles several blobs in one string', () => {
    const many = Array.from({ length: 5 }, () => 'y'.repeat(20_000)).join('\n');
    const started = performance.now();
    const tokens = countTokens(many);
    const elapsed = performance.now() - started;
    assert.ok(tokens > 0);
    assert.ok(elapsed < 2_000, `expected well under 2 s, took ${elapsed.toFixed(0)} ms`);
  });

  it('is not confused by regex state across calls', () => {
    // The whitespace scanner is a module-level /g regex. A stale lastIndex
    // would make the second call skip an oversized run.
    const blob = 'z'.repeat(30_000);
    const first = countTokens(blob);
    const second = countTokens(blob);
    assert.equal(first, second);
  });
});
