/**
 * grep — search files under a directory for a text pattern.
 *
 * Read-only, sandboxed by `resolve_under_roots` (same as `list_dir`
 * and `read_file`).  The Rust side walks the directory tree, skips
 * known junk directories and binary files, and returns absolute file
 * paths with line numbers and matching content.
 */
import { z } from 'zod';
import type { ToolHandler, ToolResultEnvelope, ToolResultIssue } from '../types';
import type { JsonSchema } from '../../llm-client/types';
import type { GrepTruncationReason } from '../sandbox-bridge';
import {
  FILESYSTEM_BATCH_MAX_ENTRIES,
} from './tool-contract-metadata.ts';
import { GREP_GUIDANCE, addCatalogRecovery, guidanceSignal } from '../tool-guidance.ts';

export { FIXED_GREP_EXCLUDED_EXTENSIONS, FIXED_SEARCH_EXCLUDED_DIRS } from './tool-contract-metadata.ts';

const schema = z.object({
  /** Searches to perform. Each entry has its own path + pattern. */
  searches: z.array(z.object({
    path: z.string(),
    pattern: z.string(),
    /**
     * Per-search include override: replaces the batch-wide "include"
     * for this search when present.
     */
    include: z.string().optional(),
  })).min(
    1,
    'searches must contain at least one entry. Add a path-pattern search and retry.',
  ).max(
    FILESYSTEM_BATCH_MAX_ENTRIES,
    `searches accepts at most ${FILESYSTEM_BATCH_MAX_ENTRIES} entries. Split the search into batches of ${FILESYSTEM_BATCH_MAX_ENTRIES} or fewer path-pattern pairs.`,
  ),
  /**
   * Glob pattern to filter files (e.g. "*.ts", "*.{ts,tsx}",
   * "src/**\/*.ts"). Applies to every search in the batch unless a
   * search sets its own "include". Optional.
   */
  include: z.string().optional(),
  /** Glob pattern to skip files (e.g. "*.min.js"). Same dialect as "include". Optional. */
  exclude: z.string().optional(),
  /** Case-insensitive search. Default: false. */
  ignore_case: z.boolean().optional(),
  /** Maximum matches to return. Default 1000, hard cap 5000. */
  max_results: z.number().int().positive().max(
    5000,
    'max_results must be at most 5000. Use 5000 or a smaller result limit.',
  ).optional(),
  /** Lines of context before and after each match. Default 0, at most 10. */
  context_lines: z.number().int().min(0).max(
    10,
    'context_lines must be at most 10. Use 10 or a smaller context window.',
  ).optional(),
  /** Output shape. Default "content". */
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  /**
   * Sampling cap on matches per file. Default: no per-file cap. A
   * further match sets truncated and names per_file_matches.
   */
  max_matches_per_file: z.number().int().positive().max(
    5000,
    'max_matches_per_file must be at most 5000',
  ).optional(),
  /**
   * Search inside the always-pruned directories (node_modules, .git,
   * dist, ...). Default false.
   */
  include_excluded_dirs: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if ((value.context_lines ?? 0) > 0 && (value.output_mode ?? 'content') !== 'content') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['context_lines'],
      message: 'context_lines applies only to output_mode "content". Drop it or use output_mode "content".',
    });
  }
});

export type GrepInput = z.infer<typeof schema>;

export interface GrepPublicContextLine {
  line: number;
  content: string;
  content_truncated: boolean;
}

export interface GrepPublicMatch {
  file: string;
  line: number;
  content: string;
  content_truncated: boolean;
  encoding: 'utf-16le' | 'utf-16be' | null;
  before: GrepPublicContextLine[];
  after: GrepPublicContextLine[];
}

export interface GrepPublicSearchResult {
  path: string;
  pattern: string;
  matches: GrepPublicMatch[];
  truncated: boolean | null;
  truncated_reason: GrepTruncationReason | null;
  error: string | null;
  error_code?: string;
  visited_entries: number;
  files_selected: number;
  bytes_read: number;
  skipped_large: number;
  skipped_binary: number;
  skipped_symlink: number;
  skipped_unreadable: number;
  files_transcoded: number;
  files: string[];
  counts: Array<{ file: string; count: number }>;
}

export interface GrepPublicResult {
  results: GrepPublicSearchResult[];
  warnings: string[];
}

export interface GrepPublicData {
  results: GrepPublicSearchResult[];
}

export type GrepRunResult = GrepPublicResult | ToolResultEnvelope<GrepPublicData>;

const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;

function grepIssue(search: GrepPublicSearchResult): ToolResultIssue | undefined {
  if (!search.error) return undefined;
  const code = search.error_code ?? 'read_failed';
  return addCatalogRecovery('lc_grep', {
    code,
    message: search.error,
    path: search.path,
    ...(code === 'invalid_regex' ? { retryable: false } : {}),
  });
}

export const grep: ToolHandler<GrepInput, GrepRunResult> = {
  name: 'lc_grep',
  description: GREP_GUIDANCE.essential,
  uiDescription: 'Search file contents. Per-path patterns.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    // Use the shell timeout cap as a reasonable deadline for grep
    // (it walks the filesystem so it can be long-running).
    const deadlineMs = ctx.config.maxShellTimeoutMs || 30_000;
    const result = await ctx.sandbox.grep({
      ...input,
      include: input.include?.trim() ? input.include : undefined,
      allowed_roots: ctx.config.allowedRoots,
      call_id: ctx.identity.operationId,
      group_id: ctx.identity.groupId,
      deadline_ms: deadlineMs,
    });
    const results = result.results.map((search) => ({
        ...search,
        matches: search.matches.map((match) => ({
          ...match,
          content_truncated: match.content_truncated ?? false,
          encoding: match.encoding ?? null,
          before: (match.before ?? []).map((line) => ({
            ...line,
            content_truncated: line.content_truncated ?? false,
          })),
          after: (match.after ?? []).map((line) => ({
            ...line,
            content_truncated: line.content_truncated ?? false,
          })),
        })),
        truncated_reason: search.truncated_reason ?? null,
        error: search.error ?? null,
        files: search.files ?? [],
        counts: search.counts ?? [],
      }));
    const warnings: string[] = [];
    if (results.some((search) => search.truncated === true)) {
      const warning = guidanceSignal('lc_grep', 'truncated');
      if (warning) warnings.push(warning);
    }
    if (results.some((search) => search.truncated === null)) {
      const warning = guidanceSignal('lc_grep', 'completeness_unknown');
      if (warning) warnings.push(warning);
    }
    if (results.some((search) => search.matches.some((match) =>
      match.content.includes('\uFFFD')
      || match.before.some((line) => line.content.includes('\uFFFD'))
      || match.after.some((line) => line.content.includes('\uFFFD'))))) {
      const warning = guidanceSignal('lc_grep', 'replacement_character');
      if (warning) warnings.push(warning);
    }
    const issues = results.flatMap((search) => {
      const issue = grepIssue(search);
      return issue ? [issue] : [];
    });
    if (issues.length > 0 && issues.length === results.length) {
      return { status: 'error', issues, warnings };
    }
    if (issues.length > 0) {
      return { status: 'partial', data: { results }, issues, warnings };
    }
    return { results, warnings };
  },
};
