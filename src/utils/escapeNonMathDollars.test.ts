/**
 * Regression tests for the `escapeNonMathDollars` transform.
 *
 * The transform runs on every streaming chunk before the markdown pipeline
 * (see `src/ui/chat/ChunkedMarkdown.tsx`). It must be total, O(n), and —
 * critically — its fence state must stay aligned with what `remark`/
 * `micromark` actually parse, otherwise a `\$` gets inserted into text that
 * remark still treats as code.
 *
 * Run with:
 *   node --test --experimental-strip-types src/utils/escapeNonMathDollars.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeNonMathDollars } from './escapeNonMathDollars.ts';

describe('escapeNonMathDollars — fast path and ordinary prose', () => {
  it('returns the input unchanged when there are no dollar signs', () => {
    const s = 'no dollars here, just prose and ``` fences ```';
    assert.equal(escapeNonMathDollars(s), s);
  });

  it('keeps a valid inline math pair verbatim', () => {
    assert.equal(escapeNonMathDollars('solve $x^2 + 1$ now'), 'solve $x^2 + 1$ now');
  });

  it('keeps display math verbatim (remark-math owns $$)', () => {
    assert.equal(escapeNonMathDollars('$$x + y$$'), '$$x + y$$');
  });

  it('escapes a lone $ with no closer on the line', () => {
    assert.equal(escapeNonMathDollars('price $45M total'), 'price \\$45M total');
  });

  it('keeps an already-escaped \\$ untouched', () => {
    assert.equal(escapeNonMathDollars('costs \\$5 total'), 'costs \\$5 total');
  });

  it('bounded scan: a $ with no closer within MAX_INLINE is escaped, not O(n²)', () => {
    const longLine = `x $${'y'.repeat(400)} end`;
    const out = escapeNonMathDollars(longLine);
    assert.ok(out.includes('\\$'), 'lone dollar past the inline cap must be escaped');
    assert.ok(out.length > 0);
  });

  it('escapes JavaScript template interpolation before a later dollar pair', () => {
    const input = 'label ${count}K; then solve $x + 1$';
    assert.equal(
      escapeNonMathDollars(input),
      'label \\${count}K; then solve $x + 1$',
    );
  });

  it('does not alter JavaScript templates inside inline code spans', () => {
    const input = 'Use `${count}K`, ``${other}``, then solve $x + 1$.';
    assert.equal(escapeNonMathDollars(input), input);
  });

  it('does not mistake escaped backticks for inline code delimiters', () => {
    const input = 'flag(\\`a${m[1]}__${m[2]}\\`)';
    const expected = 'flag(\\`a\\${m[1]}__\\${m[2]}\\`)';
    assert.equal(escapeNonMathDollars(input), expected);
  });

  it('matches CommonMark when escaped backticks appear inside a code span', () => {
    const input = '`flag(\\`a${m[1]}__${m[2]}\\`)`';
    const expected = '`flag(\\`a\\${m[1]}__\\${m[2]}\\`)`';
    assert.equal(escapeNonMathDollars(input), expected);
  });

  it('treats an unmatched backtick run as literal prose', () => {
    const input = 'the ` character is odd, and costs $5 to $10 per unit';
    const expected = 'the ` character is odd, and costs \\$5 to \\$10 per unit';
    assert.equal(escapeNonMathDollars(input), expected);
  });

  it('still protects templates and later real math after an unmatched run', () => {
    const input = 'a lone ` here, then ${count}K and later $x$ math';
    const expected = 'a lone ` here, then \\${count}K and later $x$ math';
    assert.equal(escapeNonMathDollars(input), expected);
  });

  it('still recognizes a later fence after an unmatched inline run', () => {
    const input = 'a lone `\n\n```txt\n$inside\n```\n\ncost $5';
    const expected = 'a lone `\n\n```txt\n$inside\n```\n\ncost \\$5';
    assert.equal(escapeNonMathDollars(input), expected);
  });
});

describe('escapeNonMathDollars — fenced code blocks', () => {
  it('does not escape a $ inside a bare fence', () => {
    const input = '```\ncode $1\n```\n$a$';
    const out = escapeNonMathDollars(input);
    assert.ok(!out.includes('\\$'), `no escaping inside the fence: ${JSON.stringify(out)}`);
    assert.ok(out.includes('$1'));
    // Math after the fence is still a valid pair and stays verbatim.
    assert.ok(out.includes('$a$'));
  });

  it('does not escape a $ inside an indented fence', () => {
    const input = '  ```\n code $1\n  ```\n$a$';
    const out = escapeNonMathDollars(input);
    assert.ok(!out.includes('\\$'), `indented fence must protect the dollar: ${JSON.stringify(out)}`);
  });

  it('does not escape a $ inside a tilde fence', () => {
    const input = '~~~js\ncode $1\n~~~\n$a$';
    const out = escapeNonMathDollars(input);
    assert.ok(!out.includes('\\$'), `tilde fence must protect the dollar: ${JSON.stringify(out)}`);
    assert.ok(out.includes('$a$'));
  });

  it('opener with an info string still opens the fence (audit example)', () => {
    // A fence line whose first non-space run is 3+ fence chars is an opener;
    // the trailing text is the info string / meta. `$math$` after the real
    // closer must stay math, never become `\$math\$`.
    const input = '```js const a="$1"\ncode\n```\n$math$';
    const out = escapeNonMathDollars(input);
    assert.ok(!out.includes('\\$math\\$'), `math after an info-string fence must not be escaped: ${JSON.stringify(out)}`);
    assert.ok(out.includes('$math$'));
    assert.ok(out.includes('$1'), 'info-string dollar stays untouched');
  });

  it('content-bearing closer line is code, not a closer — no stray backslash', () => {
    // CommonMark: a closing fence may only be followed by whitespace. A line
    // like "```js extra" does NOT close the block, so `$100 million` below it
    // is still code. The old toggle treated it as a closer and emitted
    // `\$100 million` — a stray backslash inside the rendered code block.
    const input = '```js\ncode\n```js extra\n$100 million\n```';
    const out = escapeNonMathDollars(input);
    assert.ok(
      !out.includes('\\$'),
      `dollar in code after a content-bearing closer line must not be escaped: ${JSON.stringify(out)}`,
    );
  });

  it('content after trailing spaces on a closer line is still code, not a closer', () => {
    // micromark consumes spaces after the fence run, then requires EOL/EOF
    // (`sequenceCloseAfter`). "```   extra" is therefore NOT a closer, so
    // `$100 million` below it stays code and must not gain a backslash.
    const input = '```js\ncode\n```   extra\n$100 million\n```';
    const out = escapeNonMathDollars(input);
    assert.ok(
      !out.includes('\\$'),
      `dollar after a spaced-but-content closer line must not be escaped: ${JSON.stringify(out)}`,
    );
  });

  it('a closer with only trailing spaces does close', () => {
    // Control: "```   " (spaces, no content) IS a valid closer, so the fence
    // really ends and the following lone dollar is prose and gets escaped.
    const input = '```\ncode\n```   \n$100 million';
    const out = escapeNonMathDollars(input);
    assert.ok(
      out.includes('\\$100 million'),
      `closer with only spaces must close the fence: ${JSON.stringify(out)}`,
    );
  });

  it('a different-char run inside a fence is code, not a closer', () => {
    const input = '```js\ncode\n~~~\n$b$\n```';
    const out = escapeNonMathDollars(input);
    assert.ok(!out.includes('\\$'), `tilde run inside a backtick fence must not escape dollars: ${JSON.stringify(out)}`);
  });

  it('a closing fence shorter than the opening fence does not close', () => {
    // CommonMark: the closing fence must be at least as long as the opening
    // one. A 3-backtick run inside a 4-backtick fence is content.
    const input = '````\ncode\n```\n$c$\n````';
    const out = escapeNonMathDollars(input);
    assert.ok(!out.includes('\\$'), `shorter fence run must not escape dollars: ${JSON.stringify(out)}`);
    assert.ok(out.includes('$c$'));
  });

  it('a real closer after an unpaired dollar inside the fence leaves it alone', () => {
    const input = '```\n$ unpaired\n```\n';
    const out = escapeNonMathDollars(input);
    assert.ok(!out.includes('\\$'), `unpaired dollar inside a fence must not be escaped: ${JSON.stringify(out)}`);
  });
});
