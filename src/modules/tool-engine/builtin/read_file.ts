/**
 * read_file — read one or more admitted text files by absolute path.
 *
 * Sandboxed by `resolve_under_roots` in `fs_ops.rs`. Supports
 * line-range slicing (including streamed ranges from large files),
 * BOM-marked UTF-16 transcoding, NUL-byte binary detection, and SHA-256
 * integrity hashing.
 */
import { z } from 'zod';
import type { ToolHandler, ToolResultEnvelope, ToolResultIssue } from '../types';
import type { JsonSchema } from '../../llm-client/types';
import { FILESYSTEM_BATCH_MAX_ENTRIES } from './tool-contract-metadata.ts';
import {
  READ_FILE_GUIDANCE,
  addCatalogRecovery,
  guidanceSignal,
} from '../tool-guidance.ts';

const HARD_CAP_READ_BYTES = 32 * 1024 * 1024;
const MAX_LINE_NUMBER = 4_294_967_295;

const schema = z.object({
  paths: z.array(z.string()).min(
    1,
    'paths must contain at least one path. Add a file path and retry.',
  ).max(
    FILESYSTEM_BATCH_MAX_ENTRIES,
    `paths accepts at most ${FILESYSTEM_BATCH_MAX_ENTRIES} entries. Split the read into batches of ${FILESYSTEM_BATCH_MAX_ENTRIES} or fewer paths.`,
  ),
  start_line: z.number().int().positive(
    'start_line must be a positive 1-based line number. Use 1 or larger, or omit start_line to begin at line 1.',
  ).max(
    MAX_LINE_NUMBER,
    `start_line must be at most ${MAX_LINE_NUMBER}. Use a smaller 1-based line number or omit start_line to begin at line 1.`,
  ).optional(),
  end_line: z.number().int().positive(
    'end_line must be a positive 1-based line number. Use 1 or larger, or omit end_line to read to the end.',
  ).max(
    MAX_LINE_NUMBER,
    `end_line must be at most ${MAX_LINE_NUMBER}. Use a smaller 1-based line number or omit end_line to read to the end.`,
  ).optional(),
  max_bytes: z.number().int().positive().max(
    HARD_CAP_READ_BYTES,
    `max_bytes must be at most ${HARD_CAP_READ_BYTES} (32 MiB). Use a smaller byte limit or omit it to keep the default 1 MiB cap.`,
  ).optional(),
});

export type ReadFileInput = z.infer<typeof schema>;

export interface ReadFileEntry {
  path: string;
  content: string;
  total_lines: number;
  size_bytes: number;
  truncated: boolean;
  sha256: string | null;
  /**
   * The encoding the content was decoded from on success, or null on error:
   * `utf-8` unchanged, or `utf-16le` / `utf-16be` when the file was
   * transcoded from a BOM-marked source.
   */
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | null;
  /** Stable native code for an error entry. Absent on success. */
  error_code?: string;
  error: string | null;
}

export interface ReadFileData {
  results: ReadFileEntry[];
}

export interface ReadFileOutput extends ReadFileData {
  warnings: string[];
}

export type ReadFileResult = ReadFileOutput | ToolResultEnvelope<ReadFileData>;

const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;

export const READ_FILE_ISSUE_MESSAGES = Object.freeze({
  encoding_not_utf8: 'The content is not valid UTF-8. LC returns no content for this file.',
  binary_detected: 'The file contains binary data. LC returns no content for this file.',
  too_large: 'The requested content exceeds the read limit. LC returns no content for this file.',
});

function normalizedEntryError(entry: { error_code?: string; error?: string }): string | null {
  const message = entry.error_code
    ? READ_FILE_ISSUE_MESSAGES[entry.error_code as keyof typeof READ_FILE_ISSUE_MESSAGES]
    : undefined;
  return message ?? entry.error ?? null;
}

function readIssue(entry: ReadFileEntry): ToolResultIssue | undefined {
  if (!entry.error) return undefined;
  const code = entry.error_code ?? 'read_failed';
  return addCatalogRecovery('lc_read_file', {
    code,
    message: entry.error,
    path: entry.path,
    ...(['encoding_not_utf8', 'binary_detected', 'too_large'].includes(code)
      ? { retryable: false }
      : {}),
  });
}

export const readFile: ToolHandler<ReadFileInput, ReadFileResult> = {
  name: 'lc_read_file',
  description: READ_FILE_GUIDANCE.essential,
  uiDescription: 'Read UTF-8 text files. Batch multiple paths.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    const result = await ctx.sandbox.readFile({
      ...input,
      allowed_roots: ctx.config.allowedRoots,
      call_id: ctx.identity.operationId,
      group_id: ctx.identity.groupId,
    });
    const results = result.results.map((entry) => ({
        ...entry,
        sha256: entry.sha256 ?? null,
        encoding: entry.encoding ?? null,
        error: normalizedEntryError(entry),
      }));
    const warnings: string[] = [];
    if (results.some((entry) => entry.content.includes('\uFFFD'))) {
      const warning = guidanceSignal('lc_read_file', 'replacement_character');
      if (warning) warnings.push(warning);
    }
    const issues = results.flatMap((entry) => {
      const issue = readIssue(entry);
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
