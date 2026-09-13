import type { ToolResultIssue } from './types';
import { TOOL_NAME_ENTRIES, type ToolNameEntry } from './tool-guidance.ts';
import { boundedToolIssueMessage } from './model-text-budget.ts';

/** Maximum untrusted provider tool-name characters used for recovery work. */
export const OPERATIONAL_TOOL_NAME_MAX_CHARS = 80;

function boundedOperationalToolName(requested: string): { value: string; truncated: boolean } {
  let value = '';
  let characters = 0;
  for (const character of requested) {
    if (characters === OPERATIONAL_TOOL_NAME_MAX_CHARS) {
      return { value, truncated: true };
    }
    value += character;
    characters += 1;
  }
  return { value, truncated: false };
}

export type ToolNameCorrection = 'normalized' | 'alias' | 'unique_typo_match';

export type ToolNameResolution =
  | { kind: 'resolved'; requested: string; resolved: string; correction?: ToolNameCorrection }
  | { kind: 'not_exposed'; requested: string; resolved: string; correction?: ToolNameCorrection }
  | { kind: 'ambiguous'; requested: string; suggestions: Array<{ tool: string; purpose: string }> }
  | { kind: 'unknown'; requested: string; suggestions: Array<{ tool: string; purpose: string }> };

function folded(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function compact(value: string): string {
  return folded(value).replace(/[\s_-]+/g, '');
}

function withoutLcPrefix(value: string): string {
  const key = compact(value);
  return key.startsWith('lc') ? key.slice(2) : key;
}

export function normalizeRequestedToolName(value: string): string {
  const words = folded(value).replace(/[\s_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!words) return '';
  return words.startsWith('lc_') ? words : `lc_${words.replace(/^lc_?/, '')}`;
}

export function damerauLevenshtein(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const matrix = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
      }
    }
  }
  return matrix[a.length][b.length];
}

function exposedEntries(exposedNames: ReadonlySet<string>): ToolNameEntry[] {
  return TOOL_NAME_ENTRIES.filter((entry) => exposedNames.has(entry.name));
}

function suggestionRows(
  requested: string,
  candidates: readonly ToolNameEntry[],
  limit = 3,
): Array<{ tool: string; purpose: string }> {
  const requestKey = withoutLcPrefix(requested);
  return candidates
    .map((entry) => {
      const nameKey = withoutLcPrefix(entry.name);
      const prefix = nameKey.startsWith(requestKey) || requestKey.startsWith(nameKey) ? 0 : 1;
      return { entry, prefix, distance: damerauLevenshtein(requestKey, nameKey) };
    })
    .sort((a, b) => a.prefix - b.prefix
      || a.distance - b.distance
      || a.entry.name.localeCompare(b.entry.name, 'en-US'))
    .slice(0, Math.max(0, Math.min(3, limit)))
    .map(({ entry }) => ({ tool: entry.name, purpose: entry.purpose }));
}

function resolvedOrHidden(
  requested: string,
  entry: ToolNameEntry,
  exposedNames: ReadonlySet<string>,
  correction?: ToolNameCorrection,
): ToolNameResolution {
  return exposedNames.has(entry.name)
    ? { kind: 'resolved', requested, resolved: entry.name, ...(correction ? { correction } : {}) }
    : { kind: 'not_exposed', requested, resolved: entry.name, ...(correction ? { correction } : {}) };
}

export function resolveToolName(
  requested: string,
  exposedNames: ReadonlySet<string>,
): ToolNameResolution {
  const exact = TOOL_NAME_ENTRIES.find((entry) => entry.name === requested);
  if (exact) return resolvedOrHidden(requested, exact, exposedNames);

  const normalizedKey = withoutLcPrefix(requested);
  const normalized = TOOL_NAME_ENTRIES.filter((entry) => withoutLcPrefix(entry.name) === normalizedKey);
  if (normalized.length === 1) {
    return resolvedOrHidden(requested, normalized[0], exposedNames, 'normalized');
  }

  const alias = TOOL_NAME_ENTRIES.filter((entry) =>
    entry.aliases.some((value) => compact(value) === compact(requested)));
  if (alias.length === 1) {
    return resolvedOrHidden(requested, alias[0], exposedNames, 'alias');
  }
  if (alias.length > 1) {
    return { kind: 'ambiguous', requested, suggestions: suggestionRows(requested, alias) };
  }

  const exposed = exposedEntries(exposedNames);
  const prefix = exposed.filter((entry) => withoutLcPrefix(entry.name).startsWith(normalizedKey));
  if (prefix.length > 1) {
    return { kind: 'ambiguous', requested, suggestions: suggestionRows(requested, prefix) };
  }

  const ranked = exposed
    .map((entry) => ({
      entry,
      distance: damerauLevenshtein(normalizedKey, withoutLcPrefix(entry.name)),
    }))
    .sort((a, b) => a.distance - b.distance || a.entry.name.localeCompare(b.entry.name, 'en-US'));
  const first = ranked[0];
  const second = ranked[1];
  if (first && first.distance <= 2 && (!second || second.distance >= first.distance + 2)) {
    return resolvedOrHidden(requested, first.entry, exposedNames, 'unique_typo_match');
  }

  const suggestions = suggestionRows(requested, exposed);
  return suggestions.length > 0
    ? { kind: 'ambiguous', requested, suggestions }
    : { kind: 'unknown', requested, suggestions: [] };
}

export function unknownOperationalToolIssue(
  requested: string,
  exposedNames: ReadonlySet<string>,
): ToolResultIssue {
  const bounded = boundedOperationalToolName(requested);
  const operational = new Set(
    TOOL_NAME_ENTRIES
      .filter((entry) => entry.operational && exposedNames.has(entry.name))
      .map((entry) => entry.name),
  );
  const suggestions = suggestionRows(
    bounded.value,
    TOOL_NAME_ENTRIES.filter((entry) => operational.has(entry.name)),
  );
  const displayed = bounded.truncated
    ? `${bounded.value}… [tool name truncated at ${OPERATIONAL_TOOL_NAME_MAX_CHARS} characters]`
    : bounded.value;
  return {
    code: 'unknown_tool',
    message: boundedToolIssueMessage(
      `Unknown tool: ${displayed}. Submit a new call with an exposed tool name.`,
    ),
    retryable: false,
    ...(suggestions.length > 0 ? { suggestions } : {}),
  };
}
