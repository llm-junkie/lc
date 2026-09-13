/**
 * Escape `$` signs that can never form a valid inline math pair,
 * using the same boundary logic as VS Code's built-in markdown-math
 * grammar (see `md-math-inline.tmLanguage.json`):
 *
 *   Valid opener: $ preceded by \\s|\\W|^ and not by another $
 *   Valid closer: $ followed  by \\s|\\W|$ and not by another $
 *   Content must be on the same line.
 *
 * A `$` without a matching closer is escaped to `\\$` so
 * `remark-math` treats it as literal text. This prevents prose
 * dollar amounts like `$45M` from being swallowed into giant
 * KaTeX inline-math blocks.
 *
 * Fenced code blocks are tracked so a `$` inside ``` or ~~~ is never
 * escaped. The fence grammar mirrors what `remark`/`micromark` parse:
 * a line whose first non-space run is 3+ fence characters OPENS a fence
 * (trailing text is the info string / meta and does not stop it), and a
 * line inside a fence CLOSES it only when the run is the same character,
 * is at least as long as the opening run, and is followed by only
 * spaces/tabs up to end of line or EOF (micromark's `sequenceCloseAfter`).
 * Diverging from that grammar here would insert a `\$` into text that
 * remark still parses as code.
 *
 * One deliberate simplification: micromark rejects an opener whose info
 * string contains the fence character (a backtick inside a backtick
 * fence). This scanner does not inspect the info string, so such a line
 * still opens here. The only effect is that a following `$` pair is left
 * for remark-math (the prose behavior), never escaped — it cannot produce
 * a stray `\$`, which is the failure mode this transform exists to
 * prevent.
 *
 * This module is pure (no JSX, no CSS) so the escape transform can be
 * unit-tested in the plain-node test leg.
 */
function hasExactBacktickCloser(
  text: string,
  start: number,
  runLength: number,
): boolean {
  let cursor = start;
  while (cursor < text.length) {
    const next = text.indexOf('`', cursor);
    if (next === -1) return false;

    let end = next + 1;
    while (end < text.length && text[end] === '`') end++;
    if (end - next === runLength) return true;
    cursor = end;
  }
  return false;
}

export function escapeNonMathDollars(text: string): string {
  // Fast path: with no dollar signs there is nothing to escape, so skip the
  // O(n) character scan entirely (the common case for most chunks).
  if (text.indexOf('$') === -1) return text;
  const MAX_INLINE = 300; // safety cap — inline math is never this long
  const out: string[] = [];
  let i = 0;
  const len = text.length;
  let inFence = false; // track ``` fenced code blocks
  let fenceChar = ''; // fence character of the open fence (` or ~)
  let fenceLen = 0; // run length of the open fence
  let inlineCodeTicks = 0; // matching backtick run for an inline code span

  while (i < len) {
    // FENCE OPEN/CLOSE — a run of 3+ backticks or 3+ tildes at the start of a
    // line (leading whitespace allowed). Mirrors reasoningChunks.isFenceLine
    // (/^\s*(`{3,}|~{3,})/) for openers so a `$` inside a ~~~ or indented
    // fence is not escaped. A single toggle also fixes the old open/close
    // split, which left inFence stuck `true` after a block (the closing fence
    // line was re-detected as an opener on the next pass).
    if (
      (text[i] === '`' || text[i] === '~') &&
      text[i + 1] === text[i] &&
      text[i + 2] === text[i] &&
      inlineCodeTicks === 0
    ) {
      // The marker must start the line (only whitespace since the previous
      // newline). Leading whitespace was already emitted to `out`.
      let atLineStart = true;
      for (let j = i - 1; j >= 0 && text[j] !== '\n'; j--) {
        if (text[j] !== ' ' && text[j] !== '\t') {
          atLineStart = false;
          break;
        }
      }
      if (atLineStart) {
        // Consume the full run of fence characters (fences may be 3+ long).
        const c = text[i];
        let run = i;
        while (run < len && text[run] === c) run++;
        const runLen = run - i;

        if (inFence) {
          // Inside a fence this run is a CLOSER only when it matches what
          // micromark (remark's parser) accepts: the same fence character,
          // at least as long as the opener, and followed by only
          // spaces/tabs up to end of line (or EOF). Anything else is code
          // content — toggling out here would escape `$` in text that
          // remark still parses as code, surfacing as stray `\$` in the
          // block.
          let isCloser = c === fenceChar && runLen >= fenceLen;
          if (isCloser) {
            let after = run;
            while (after < len && (text[after] === ' ' || text[after] === '\t')) after++;
            isCloser =
              after >= len || text[after] === '\n' || text[after] === '\r';
          }
          if (!isCloser) {
            out.push(text[i]);
            i++;
            continue;
          }
          inFence = false;
          fenceChar = '';
          fenceLen = 0;
          out.push(text.slice(i, run));
          i = run;
          continue;
        }

        // Outside a fence this run OPENS one; trailing text is the info
        // string / meta and does not stop it.
        inFence = true;
        fenceChar = c;
        fenceLen = runLen;
        out.push(text.slice(i, run));
        i = run;
        continue;
      }
    }

    // Pass through unchanged while inside a fenced code block
    if (inFence) {
      out.push(text[i]);
      i++;
      continue;
    }
    // Skip already-escaped \$ — micromark handles these natively
    // Remark-math never parses dollar signs inside inline code. Track
    // matching backtick runs so JavaScript templates in code spans remain
    // byte-for-byte unchanged.
    if (text[i] === '`') {
      let precedingBackslashes = 0;
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) {
        precedingBackslashes++;
      }
      if (inlineCodeTicks === 0 && precedingBackslashes % 2 === 1) {
        // An escaped backtick is ordinary prose punctuation, not an inline
        // code delimiter. Treating it as one would hide later `${...}` from
        // the prose-dollar guard and let remark-math consume the template.
        out.push('`');
        i++;
        continue;
      }

      let run = i;
      while (run < len && text[run] === '`') run++;
      const runLen = run - i;
      if (inlineCodeTicks === 0) {
        // CommonMark only opens a code span when a later backtick string has
        // exactly the same length. An unmatched run is literal prose; hiding
        // the rest of the chunk behind it would skip dollar escaping and can
        // also prevent later fenced-code lines from being recognized.
        if (!hasExactBacktickCloser(text, run, runLen)) {
          out.push(text.slice(i, run));
          i = run;
          continue;
        }
        inlineCodeTicks = runLen;
      } else if (runLen === inlineCodeTicks) {
        inlineCodeTicks = 0;
      }
      out.push(text.slice(i, run));
      i = run;
      continue;
    }
    if (inlineCodeTicks > 0) {
      out.push(text[i]);
      i++;
      continue;
    }

    if (text[i] === '\\' && text[i + 1] === '$') {
      out.push('\\$');
      i += 2;
      continue;
    }

    // JavaScript/TypeScript interpolation is prose, not LaTeX. Without this
    // guard, `${value}` can pair with a later dollar on the same line and
    // turn a long stretch of ordinary text into malformed KaTeX.
    if (text[i] === '$' && text[i + 1] === '{') {
      out.push('\\$');
      i++;
      continue;
    }

    // Only single $ (not $$, which remark-math handles separately)
    if (text[i] === '$' && text[i + 1] !== '$') {
      const prevChar = i === 0 ? '\n' : text[i - 1];
      const isPrevBoundary = /[\s\W]/.test(prevChar);
      const isPrevDollar = i > 0 && text[i - 1] === '$';

      if (isPrevBoundary && !isPrevDollar) {
        // Candidate math opener — look for a valid closer
        let j = i + 1;
        let found = false;
        const limit = Math.min(len, i + MAX_INLINE);

        while (j < limit) {
          // VS Code's `.` in the regex does not match newlines
          if (text[j] === '\n') break;

          if (text[j] === '$' && text[j + 1] !== '$') {
            const nextChar = j + 1 < len ? text[j + 1] : '\n';
            const isNextBoundary =
              /[\s\W]/.test(nextChar) || j + 1 >= len;

            if (isNextBoundary) {
              // Valid pair — emit verbatim
              out.push(text.slice(i, j + 1));
              i = j + 1;
              found = true;
              break;
            }
            // $ followed by \w (e.g. $2.8M) — keep looking
          }
          j++;
        }

        if (found) continue;
        // No valid closer found — escape this $
        out.push('\\$');
        i++;
        continue;
      }
    }

    out.push(text[i]);
    i++;
  }

  return out.join('');
}
