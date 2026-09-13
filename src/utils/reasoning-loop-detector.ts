/**
 * Lightweight, provider-independent detector for a reasoning-only output
 * loop. This module deliberately has no LC, transport, or UI dependencies;
 * it can be replayed against captured reasoning streams before integration.
 */

export const INFINITE_REASONING_LOOP = 'infinite_reasoning_loop' as const;

export interface ReasoningLoopDetectorOptions {
  /** Continuous reasoning-only grace period before matching begins. */
  armAfterMs?: number;
  /** Internal normalized text block size, in UTF-16 code units. */
  blockSize?: number;
  /** Number of blocks to establish before the final confirmation repeat. */
  requiredBlocks?: number;
}

export interface ReasoningLoopDetectorState {
  armed: boolean;
  triggered: boolean;
  matchedBlocks: number;
  reasoningChars: number;
  finishReason?: typeof INFINITE_REASONING_LOOP;
  triggeredAtMs?: number;
}

const DEFAULT_ARM_AFTER_MS = 60_000;
const DEFAULT_BLOCK_SIZE = 128;
const DEFAULT_REQUIRED_BLOCKS = 5;
const WHITESPACE = /\s/;

function buildPrefixTable(pattern: string): number[] {
  const prefix = new Array<number>(pattern.length).fill(0);
  let matched = 0;
  for (let i = 1; i < pattern.length;) {
    if (pattern[i] === pattern[matched]) {
      prefix[i] = ++matched;
      i++;
    } else if (matched > 0) {
      matched = prefix[matched - 1];
    } else {
      i++;
    }
  }
  return prefix;
}

/**
 * Detects a repeated sequence of normalized reasoning blocks.
 *
 * Once armed, the detector captures block 001. When that exact block appears
 * later, it captures the following block as 002, then searches for the
 * growing sequence again. After the required blocks are established, the
 * complete sequence must repeat once more before triggering. This is KMP-style
 * streaming matching: it does not retain or rescan the full reasoning
 * transcript, and it is independent of provider SSE chunk boundaries.
 */
export class ReasoningLoopDetector {
  private readonly armAfterMs: number;
  private readonly blockSize: number;
  private readonly requiredBlocks: number;

  private reasoningOnlySinceMs: number | undefined;
  private armed = false;
  private triggered = false;
  private reasoningChars = 0;
  private normalizedTail = '';
  private pendingSpace = false;

  private pattern = '';
  private prefixTable: number[] = [];
  private matchedPatternChars = 0;
  private nextBlock = '';
  private matchedBlocks = 0;
  private triggeredAtMs: number | undefined;

  constructor(options: ReasoningLoopDetectorOptions = {}) {
    this.armAfterMs = options.armAfterMs ?? DEFAULT_ARM_AFTER_MS;
    this.blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    this.requiredBlocks = options.requiredBlocks ?? DEFAULT_REQUIRED_BLOCKS;
    if (!Number.isFinite(this.armAfterMs) || this.armAfterMs < 0) {
      throw new RangeError('armAfterMs must be a finite non-negative number');
    }
    if (!Number.isInteger(this.blockSize) || this.blockSize < 1) {
      throw new RangeError('blockSize must be a positive integer');
    }
    if (!Number.isInteger(this.requiredBlocks) || this.requiredBlocks < 2) {
      throw new RangeError('requiredBlocks must be an integer of at least 2');
    }
  }

  /** Feed one reasoning delta with a caller-provided monotonic timestamp. */
  feedReasoning(text: string, nowMs: number): ReasoningLoopDetectorState {
    if (this.triggered || !text) return this.state();
    if (!Number.isFinite(nowMs)) throw new RangeError('nowMs must be finite');

    if (this.reasoningOnlySinceMs === undefined) {
      this.reasoningOnlySinceMs = nowMs;
    }
    this.reasoningChars += text.length;
    if (!this.armed && nowMs - this.reasoningOnlySinceMs < this.armAfterMs) {
      // The anchor deliberately starts after the grace period. Normalizing the
      // pre-arm transcript cannot affect a later match, and doing so creates
      // one short-lived string per input character on long reasoning streams.
      return this.state();
    }
    if (!this.armed) {
      this.armed = true;
      // The anchor must begin after the grace period, not in the history
      // accumulated while the detector was only observing the stream.
      this.normalizedTail = '';
      this.pendingSpace = false;
    }

    for (let i = 0; i < text.length && !this.triggered; i++) {
      const char = text[i];
      if (WHITESPACE.test(char)) {
        this.pendingSpace = this.normalizedTail.length > 0;
        continue;
      }
      if (this.pendingSpace) {
        this.consumeNormalizedChar(' ');
        this.pendingSpace = false;
      }
      this.consumeNormalizedChar(char);
    }

    if (this.triggered) this.triggeredAtMs = nowMs;
    return this.state();
  }

  /** Any visible answer text cancels the reasoning-only detector. */
  feedContent(text: string): ReasoningLoopDetectorState {
    if (text.trim() && !this.triggered) this.reset();
    return this.state();
  }

  /** Any tool call means the model is making observable progress. */
  feedToolCall(): ReasoningLoopDetectorState {
    if (!this.triggered) this.reset();
    return this.state();
  }

  /** Reset for a new assistant/provider turn. */
  reset(): void {
    this.reasoningOnlySinceMs = undefined;
    this.armed = false;
    this.triggered = false;
    this.reasoningChars = 0;
    this.normalizedTail = '';
    this.pendingSpace = false;
    this.pattern = '';
    this.prefixTable = [];
    this.matchedPatternChars = 0;
    this.nextBlock = '';
    this.matchedBlocks = 0;
    this.triggeredAtMs = undefined;
  }

  state(): ReasoningLoopDetectorState {
    return {
      armed: this.armed,
      triggered: this.triggered,
      matchedBlocks: this.matchedBlocks,
      reasoningChars: this.reasoningChars,
      ...(this.triggered ? { finishReason: INFINITE_REASONING_LOOP, triggeredAtMs: this.triggeredAtMs } : {}),
    };
  }

  private consumeNormalizedChar(char: string): void {
    this.normalizedTail += char;
    if (this.normalizedTail.length > this.blockSize) {
      this.normalizedTail = this.normalizedTail.slice(-this.blockSize);
    }
    if (!this.armed) return;

    // Capture the initial anchor block after the grace period.
    if (!this.pattern) {
      if (this.normalizedTail.length < this.blockSize) return;
      this.pattern = this.normalizedTail;
      this.prefixTable = buildPrefixTable(this.pattern);
      this.matchedPatternChars = 0;
      this.matchedBlocks = 1;
      this.normalizedTail = '';
      return;
    }

    // After a repeated pattern is found, capture the next block and extend
    // the pattern. The next block is deliberately not compared until the
    // extended pattern appears again, matching the proposed 001→005 scheme.
    if (this.nextBlock.length > 0 || this.matchedPatternChars === -1) {
      this.nextBlock += char;
      if (this.nextBlock.length < this.blockSize) return;
      this.pattern += this.nextBlock;
      this.matchedBlocks++;
      this.nextBlock = '';
      this.matchedPatternChars = 0;
      this.prefixTable = buildPrefixTable(this.pattern);
      return;
    }

    while (this.matchedPatternChars > 0 && char !== this.pattern[this.matchedPatternChars]) {
      this.matchedPatternChars = this.prefixTable[this.matchedPatternChars - 1];
    }
    if (char === this.pattern[this.matchedPatternChars]) {
      this.matchedPatternChars++;
    }
    if (this.matchedPatternChars === this.pattern.length) {
      // Capturing block 005 is only the setup phase. Require the complete
      // 001+002+003+004+005 sequence to repeat before aborting.
      if (this.matchedBlocks >= this.requiredBlocks) {
        this.triggered = true;
        return;
      }
      this.matchedPatternChars = -1;
      this.nextBlock = '';
    }
  }
}
