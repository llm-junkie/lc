/**
 * Token counter — accumulates content and reasoning tokens during a
 * stream and computes tokens-per-second.
 *
 * Extracted from ChatView's `tpsAccumRef` + `lastTickRef` + `bumpTps()`.
 */
import {
  countTokens,
  MAX_FULL_TOKEN_TEXT_CHARS,
} from '../../utils/tokens.ts';

/** Keeps terminal estimates independent of provider-controlled delta sizes. */
class CanonicalTokenEstimator {
  private static readonly SEGMENT_CHARS = MAX_FULL_TOKEN_TEXT_CHARS * 2;
  private pending = '';
  private settledTokens = 0;
  private receivedChars = 0;

  reset(): void {
    this.pending = '';
    this.settledTokens = 0;
    this.receivedChars = 0;
  }

  feed(text: string): void {
    if (!text) return;
    this.receivedChars += text.length;
    this.pending += text;
    while (this.pending.length >= CanonicalTokenEstimator.SEGMENT_CHARS) {
      const segment = this.pending.slice(0, CanonicalTokenEstimator.SEGMENT_CHARS);
      this.pending = this.pending.slice(CanonicalTokenEstimator.SEGMENT_CHARS);
      this.settledTokens += countTokens(segment);
    }
  }

  chars(): number {
    return this.receivedChars;
  }

  estimate(): number {
    return this.settledTokens + countTokens(this.pending);
  }
}

export class TokenCounter {
  private contentTokens = 0;
  private reasoningTokens = 0;
  private readonly terminalContent = new CanonicalTokenEstimator();
  private readonly terminalReasoning = new CanonicalTokenEstimator();
  private startTime = 0;
  private lastTick: { t: number; tokens: number; tokensAtLastTick: number } | null = null;
  /** Sum of per-tick TPS samples for averaging. */
  private tpsSum = 0;
  private tpsCount = 0;

  reset(): void {
    this.contentTokens = 0;
    this.reasoningTokens = 0;
    this.terminalContent.reset();
    this.terminalReasoning.reset();
    this.startTime = performance.now();
    this.lastTick = null;
    this.tpsSum = 0;
    this.tpsCount = 0;
  }

  private bumpTps(tokenCount: number): void {
    const now = performance.now();
    const ref = this.lastTick ?? { t: now, tokens: 0, tokensAtLastTick: 0 };
    const dt = (now - ref.t) / 1000;
    const totalTokens = ref.tokens + tokenCount;
    if (dt >= 1) {
      const tokensSinceLastTick = totalTokens - ref.tokensAtLastTick;
      if (tokensSinceLastTick > 0) {
        const rate = tokensSinceLastTick / dt;
        this.tpsSum += rate;
        this.tpsCount += 1;
      }
      this.lastTick = { t: now, tokens: totalTokens, tokensAtLastTick: totalTokens };
    } else {
      this.lastTick = { t: ref.t, tokens: totalTokens, tokensAtLastTick: ref.tokensAtLastTick };
    }
  }

  feedContent(text: string): void {
    const tokens = countTokens(text);
    this.contentTokens += tokens;
    this.terminalContent.feed(text);
    this.bumpTps(tokens);
  }

  feedReasoning(text: string): void {
    const tokens = countTokens(text);
    this.reasoningTokens += tokens;
    this.terminalReasoning.feed(text);
    this.bumpTps(tokens);
  }

  /** Current live TPS (from the accumulator average). */
  currentTps(): number {
    if (this.tpsCount === 0) {
      // No full-second tick yet — compute from raw elapsed time.
      const elapsed = (performance.now() - this.startTime) / 1000;
      const total = this.contentTokens + this.reasoningTokens;
      return elapsed > 0 ? total / elapsed : 0;
    }
    return this.tpsSum / this.tpsCount;
  }

  /** Average TPS computed from total tokens / duration (preferred for final display). */
  averageTps(): number {
    const total = this.contentTokens + this.reasoningTokens;
    const elapsed = (performance.now() - this.startTime) / 1000;
    return elapsed > 0 ? Math.round(total / elapsed) : 0;
  }

  totals(): { contentTokens: number; reasoningTokens: number } {
    return { contentTokens: this.contentTokens, reasoningTokens: this.reasoningTokens };
  }

  totalTokens(): number {
    return this.contentTokens + this.reasoningTokens;
  }

  /** Estimate canonical completion text without depending on transport chunks. */
  terminalTokens(contentText: string, reasoningText = ''): number {
    const canonicalChars = contentText.length + reasoningText.length;
    if (canonicalChars <= MAX_FULL_TOKEN_TEXT_CHARS) {
      return countTokens(contentText + reasoningText);
    }

    const streamedChars = this.terminalContent.chars() + this.terminalReasoning.chars();
    if (streamedChars === canonicalChars) {
      return this.terminalContent.estimate() + this.terminalReasoning.estimate();
    }

    // A provider adapter that returns text it did not stream is unusual. Keep
    // the terminal value canonical even on that fallback path.
    return countTokens(contentText + reasoningText);
  }

  /** Duration in milliseconds since reset(). */
  durationMs(): number {
    return performance.now() - this.startTime;
  }
}
