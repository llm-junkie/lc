import type { Message } from '../types';

/** Exact non-whitespace test used at bounded construction/load boundaries. */
export function hasVisibleReasoningText(value: string | undefined): boolean {
  return value !== undefined && /\S/.test(value);
}

/**
 * Read the append-aware presence bit, falling back for legacy/in-memory
 * messages that did not pass through the current stream or storage boundary.
 */
export function messageHasVisibleReasoning(
  message: Pick<Message, 'reasoning' | 'reasoningHasVisibleContent'>,
): boolean {
  return message.reasoningHasVisibleContent
    ?? hasVisibleReasoningText(message.reasoning);
}

/** Append one reasoning delta while preserving exact whitespace semantics. */
export function appendReasoningDelta(
  message: Pick<Message, 'reasoning' | 'reasoningHasVisibleContent'>,
  delta: string,
): Pick<Message, 'reasoning' | 'reasoningHasVisibleContent'> {
  return {
    reasoning: (message.reasoning ?? '') + delta,
    reasoningHasVisibleContent:
      messageHasVisibleReasoning(message) || hasVisibleReasoningText(delta),
  };
}
