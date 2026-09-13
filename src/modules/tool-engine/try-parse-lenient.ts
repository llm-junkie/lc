/**
 * Lenient JSON parser for model-generated tool-call arguments.
 *
 * Models occasionally append trailing text after valid JSON (e.g.
 * `{"paths":["D:\\"]"]}` where `"]}` is extra).  This module
 * tries at most 50 candidate endings after the initial parse fails.
 * Scanning and parsing remain dependent on the input length.
 *
 * Extracted from runner.ts so it can be unit-tested without pulling
 * in the full tool-engine import chain (Tauri, debug, zod, etc.).
 */

/** Result of a lenient JSON parse attempt. */
export interface LenientParseResult {
  /** The parsed value (always an object or array for tool args). */
  value: unknown;
  /** True if the JSON was repaired (truncated, trailing junk stripped).
   *  Repaired JSON must be returned to the model for explicit retry —
   *  never executed silently. */
  corrected: boolean;
}

/**
 * Try to parse a JSON string that may have trailing junk from the
 * model (e.g. `{"paths":["D:\\"]"]}` where `"]}` is extra).
 *
 * After the initial parse fails, scan backward for at most 50 `}` or `]`
 * positions. Try parsing each prefix that ends at one of those positions.
 * MAX_RETRIES bounds the attempt count, not the input-length work of
 * scanning, slicing, or parsing each prefix.
 *
 * Returns null only when no candidate parse point produces valid
 * JSON.  When a truncated parse succeeds, `corrected` is true and
 * the caller must return the corrected JSON to the model rather
 * than executing it silently.
 */
export function tryParseLenient(raw: string): LenientParseResult | null {
  if (!raw || raw.length === 0) return { value: {}, corrected: false };

  // Fast path: the full string is valid JSON (common case).
  try { return { value: JSON.parse(raw), corrected: false }; } catch { /* continue */ }

  // Collect candidate end positions: every '}' and ']' from the end.
  // A model typically appends junk after the closing brace/bracket.
  const MAX_RETRIES = 50;
  const candidates: number[] = [];
  for (let i = raw.length - 1; i >= 0 && candidates.length < MAX_RETRIES; i--) {
    const ch = raw[i];
    if (ch === '}' || ch === ']') {
      candidates.push(i + 1); // slice end is exclusive
    }
  }

  // Try each candidate end position.
  for (const end of candidates) {
    try {
      const parsed = JSON.parse(raw.slice(0, end));
      return { value: parsed, corrected: true };
    } catch { /* try next candidate */ }
  }

  return null;
}
