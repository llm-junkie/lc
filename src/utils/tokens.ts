/**
 * Thin wrapper around gpt-tokenizer for accurate local token counting.
 * Uses gpt-tokenizer's default export encoding, o200k_base (the package's
 * main entry re-exports o200k_base). Token counts are local estimates.
 */

import { encode } from 'gpt-tokenizer';
import type { ToolDefinition } from '../modules/llm-client/types';

/**
 * Longest whitespace-free run handed to the BPE encoder verbatim. Beyond this
 * the run is sampled and extrapolated instead of encoded.
 *
 * BPE cost is superlinear in the length of a single run with no whitespace to
 * split it on — the merge loop rescans the run. Measured, one unbroken run
 * costs roughly 4x per doubling:
 *
 * | unbroken chars | encode() |
 * |---|---|
 * | 10,000 | 0.13 s |
 * | 40,000 | 1.7 s |
 * | 80,000 | 6.8 s |
 * | 160,000 | 19.8 s |
 *
 * The same byte count as ordinary prose encodes in ~3 ms, so the cliff is the
 * *shape* of the text, not its size. Tool output is untrusted and unbounded —
 * `lc_run_shell` alone returns up to 1 MiB per stream — and `TokenMeter`
 * counts every message on every render. A single result like
 * `python -c "print('x' * 2000000)"` therefore froze the whole app. At the
 * 1 MiB cap, `encode()` blocked for 7 min 55 s and then threw
 * `RangeError: Maximum call stack size exceeded` from `tokensArray.push(...)`,
 * so waiting it out would only have moved the failure into a React render.
 * See docs/architecture.md, "Token counting is hostile-input hardened".
 */
const MAX_UNBROKEN_RUN = 1024;

/** Largest field scanned and encoded in full by one synchronous count. */
export const MAX_FULL_TOKEN_TEXT_CHARS = 256 * 1024;
/** Fixed tokenizer workload above {@link MAX_FULL_TOKEN_TEXT_CHARS}. */
const LARGE_TEXT_SAMPLE_WINDOWS = 8;
const LARGE_TEXT_SAMPLE_WINDOW_CHARS = 2 * 1024;

/** Finds run boundaries without retrying a fixed-width proof at every offset. */
const NEXT_WHITESPACE = /\s/g;

/**
 * Conversation text is untrusted prose, not a tokenizer control stream.
 * Encode strings such as `<|endoftext|>` as ordinary visible text instead of
 * letting gpt-tokenizer's default "disallow every special token" policy throw
 * from a render-time token count.
 */
const LITERAL_TEXT_OPTIONS = { disallowedSpecial: new Set<string>() };

/**
 * Count tokens in a plain string using o200k_base.
 *
 * Exact for normal text through {@link MAX_FULL_TOKEN_TEXT_CHARS}. A larger field is
 * estimated from evenly spaced bounded windows. A whitespace-free run longer than
 * {@link MAX_UNBROKEN_RUN} — base64, minified assets, a shell command that
 * prints a megabyte of one character — is estimated from its leading sample
 * scaled to the full run. These two bounds keep synchronous tokenizer work
 * independent of a hostile field's total size. The large-field windows are a
 * bounded estimate, not a worst-case accuracy guarantee for adversarial text
 * whose token density changes only outside those windows.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  if (text.length <= MAX_FULL_TOKEN_TEXT_CHARS) return countBoundedText(text);

  let sampledTokens = 0;
  let sampledChars = 0;
  const lastStart = text.length - LARGE_TEXT_SAMPLE_WINDOW_CHARS;
  for (let index = 0; index < LARGE_TEXT_SAMPLE_WINDOWS; index += 1) {
    const start = Math.round(
      lastStart * index / (LARGE_TEXT_SAMPLE_WINDOWS - 1),
    );
    const sample = text.slice(start, start + LARGE_TEXT_SAMPLE_WINDOW_CHARS);
    sampledTokens += countBoundedText(sample);
    sampledChars += sample.length;
  }
  return Math.max(1, Math.round(sampledTokens * text.length / sampledChars));
}

/** Count one field or sample whose total size already has an explicit bound. */
function countBoundedText(text: string): number {
  let estimated = 0;
  let copiedThrough = 0;
  let runStart = 0;
  const boundedParts: string[] = [];

  const sampleOversizedRun = (runEnd: number) => {
    const runLength = runEnd - runStart;
    if (runLength <= MAX_UNBROKEN_RUN) return;
    const sample = text.slice(runStart, runStart + MAX_UNBROKEN_RUN);
    const density = encode(sample, LITERAL_TEXT_OPTIONS).length / MAX_UNBROKEN_RUN;
    estimated += Math.round(density * (runLength - MAX_UNBROKEN_RUN));
    // The sample stays inline so it still merges with its surroundings.
    boundedParts.push(text.slice(copiedThrough, runStart), sample);
    copiedThrough = runEnd;
  };

  // Do not search for a fixed `\S{1025}` proof. On repeated 1,024-character
  // runs, that pattern retries at every offset and turns an 8 MiB scan into a
  // six-second UI-thread block. One whitespace scan measures every run exactly
  // once and also avoids the recursive failure of an unbounded `\S{1025,}`.
  NEXT_WHITESPACE.lastIndex = 0;
  let whitespace: RegExpExecArray | null;
  while ((whitespace = NEXT_WHITESPACE.exec(text)) !== null) {
    sampleOversizedRun(whitespace.index);
    runStart = whitespace.index + whitespace[0].length;
  }
  sampleOversizedRun(text.length);

  NEXT_WHITESPACE.lastIndex = 0;
  if (boundedParts.length === 0) {
    return encode(text, LITERAL_TEXT_OPTIONS).length;
  }
  boundedParts.push(text.slice(copiedThrough));
  const bounded = boundedParts.join('');
  return encode(bounded, LITERAL_TEXT_OPTIONS).length + estimated;
}

// No chat-prompt counter lives here. Full-request counting goes through
// `countTokens` (per message) and `countToolDefinitionTokens`; a dedicated
// `encodeChat` path would need the same unbroken-run sampling guard and a
// model argument (gpt-tokenizer throws without one). See
// docs/architecture.md, "Token counting is hostile-input hardened".

/**
 * Count the structured tool payload that travels beside the messages.
 * Provider wrappers vary, so use the serialized payload itself; this also
 * keeps the estimate based on the serialized payload when the same JSON is
 * supplied alongside the prompt.
 */
export function countToolDefinitionTokens(tools?: ToolDefinition[]): number {
  if (!tools?.length) return 0;
  return countTokens(JSON.stringify(tools));
}
