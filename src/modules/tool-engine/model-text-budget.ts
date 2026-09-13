import { truncateUtf8, utf8ByteLength } from './utf8-budget.ts';

/** Largest visible sub-agent answer one tool may place in a content field. */
export const TOOL_MODEL_TEXT_MAX_BYTES = 64 * 1024;

/** Largest thrown-error message copied into one model-visible issue. */
export const TOOL_ISSUE_MESSAGE_MAX_BYTES = 16 * 1024;

export const TOOL_ISSUE_TRUNCATION_MARKER =
  `\n… [error message truncated at ${TOOL_ISSUE_MESSAGE_MAX_BYTES} UTF-8 bytes]\n`;

export class ModelTextError extends Error {
  readonly code: 'InvalidModelOutput' | 'ModelOutputTooLarge';

  constructor(code: ModelTextError['code'], message: string) {
    super(message);
    this.name = 'ModelTextError';
    this.code = code;
  }
}

/** Require non-blank visible text that fits the tool payload byte budget. */
export function requireBoundedModelText(
  output: string,
  source: string,
  maxBytes = TOOL_MODEL_TEXT_MAX_BYTES,
): string {
  const visible = output.trim();
  if (!visible) {
    throw new ModelTextError(
      'InvalidModelOutput',
      `${source} returned no usable visible text. Select another model or narrow the request.`,
    );
  }

  const measuredBytes = utf8ByteLength(visible);
  if (measuredBytes > maxBytes) {
    throw new ModelTextError(
      'ModelOutputTooLarge',
      `${source} returned ${measuredBytes} UTF-8 bytes. The tool limit is ${maxBytes} bytes. Select another model or narrow the request.`,
    );
  }
  return visible;
}

/** Bound an arbitrary provider or native error before it enters a tool result. */
export function boundedToolIssueMessage(error: unknown): string {
  const raw = error instanceof Error
    ? (error.message || error.name || '(empty error message)')
    : typeof error === 'string'
      ? error
      : String(error);
  return truncateUtf8(
    raw,
    TOOL_ISSUE_MESSAGE_MAX_BYTES,
    TOOL_ISSUE_TRUNCATION_MARKER,
  ).text;
}
