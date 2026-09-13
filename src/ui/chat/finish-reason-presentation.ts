const FINISH_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  // OpenAI / LM Studio
  stop: '✔ completed',
  length: '✂ truncated',
  tool_calls: '⚒ tooling',
  content_filter: '⦸ filtered',
  // Anthropic
  end_turn: '✔ completed',
  max_tokens: '✂ truncated',
  tool_use: '⚒ tooling',
  stop_sequence: '⏹ stopped',
  pause_turn: '⏸ paused',
  refusal: '⦸ refused',
  model_context_window_exceeded: '⤡ ctx exceeded',
  // LC internal (not from any API)
  tool_batch_limit: '⚠ tool batch limit',
  tool_round_limit: '⤒ tool-round limit',
  tool_timeout: '⚠ tool timeout',
  error: '✘ error',
  disconnected: '⏻ disconnected',
  // Recovered from the generation journal: LC exited while this answer was
  // still streaming. Distinct from `disconnected`, which is a clean page exit
  // or a server that dropped the stream.
  interrupted: '⏻ interrupted',
  infinite_reasoning_loop: '⚠ reasoning loop',
});

const WARNING_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'error',
  'disconnected',
  'interrupted',
  'tool_round_limit',
  'tool_batch_limit',
  'tool_timeout',
  'infinite_reasoning_loop',
  'refusal',
  'model_context_window_exceeded',
]);

const ACCENT_FINISH_REASONS = new Set(['tool_calls', 'tool_use']);

export function finishReasonLabel(reason: string | undefined): string {
  return reason ? (FINISH_REASON_LABELS[reason] ?? reason) : '-';
}

export function finishReasonTone(
  reason: string | undefined,
): 'warn' | 'accent' | undefined {
  if (!reason) return undefined;
  if (WARNING_FINISH_REASONS.has(reason)) return 'warn';
  if (ACCENT_FINISH_REASONS.has(reason)) return 'accent';
  return undefined;
}
