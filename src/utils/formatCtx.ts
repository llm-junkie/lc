/**
 * Compact context-window label: 131072 → "131k", 900 → "900".
 *
 * Shared by the chat model picker and the model-visibility rows so a context
 * window never reads two different ways in two places. Extracted from
 * `ModelPicker.tsx`, where it was a file-local helper.
 */
export function formatCtx(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
