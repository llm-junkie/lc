import { WRITE_FILE_GUIDANCE } from '../tool-guidance.ts';
/**
 * write_file — create, overwrite, or append to a UTF-8 text file.
 *
 * Requires permission. Atomic via `create_new(true)`; returns
 * `AlreadyExists` error when mode=create hits an existing file.
 */
import { z } from 'zod';
import type { ToolHandler } from '../types';
import type { JsonSchema } from '../../llm-client/types';
import { FILESYSTEM_BATCH_MAX_ENTRIES } from './tool-contract-metadata.ts';

const schema = z.object({
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    /** SHA-256 from a prior lc_read_file — rejects the write if the file changed since. */
    expected_sha256: z.string().optional(),
  }).strict()).min(
    1,
    'files must contain at least one entry. Add a file and retry.',
  ).max(
    FILESYSTEM_BATCH_MAX_ENTRIES,
    `files accepts at most ${FILESYSTEM_BATCH_MAX_ENTRIES} entries. Split the write into batches of ${FILESYSTEM_BATCH_MAX_ENTRIES} or fewer files.`,
  ),
  mode: z.enum(['create', 'overwrite', 'append']).optional(),
}).strict();

export type WriteFileInput = z.infer<typeof schema>;

export interface WriteFileEntry {
  path: string;
  bytes_written: number;
  mode: 'create' | 'overwrite' | 'append';
  lines_added: number;
  /** Null means the prior file was not measured within the scan budget. */
  lines_removed: number | null;
  error: string | null;
}

export interface WriteFileOutput {
  results: WriteFileEntry[];
}

const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;

export const writeFile: ToolHandler<WriteFileInput, WriteFileOutput> = {
  name: 'lc_write_file',
  description: WRITE_FILE_GUIDANCE.essential,
  uiDescription: 'Write/append content to files. Per-file content.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    const files = input.files.map((file) => ({
      ...file,
      expected_sha256: file.expected_sha256?.trim() || undefined,
    }));
    const result = await ctx.sandbox.writeFile({
      ...input,
      files,
      mode: input.mode ?? 'create',
      allowed_roots: ctx.config.allowedRoots,
    });
    return {
      results: result.results.map((entry) => ({
        ...entry,
        lines_added: entry.lines_added ?? 0,
        lines_removed: entry.lines_removed ?? null,
        error: entry.error ?? null,
      })),
    };
  },
};
