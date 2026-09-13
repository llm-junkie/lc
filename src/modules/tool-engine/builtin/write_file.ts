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
  description:
    'Write or append content to one or more UTF-8 text files.\n' +
    'Each files entry contains its own path and content.\n' +
    `A call accepts at most ${FILESYSTEM_BATCH_MAX_ENTRIES} files.\n` +
    'Use separate entries to write different content to different files.\n' +
    'Batch entries commit independently. A later failure does not roll back earlier changes.\n' +
    'The single top-level mode applies to every files entry.\n' +
    'Do not put mode inside a files entry.\n' +
    'mode="create" is the default and fails if the file exists.\n' +
    'mode="overwrite" replaces an existing file or creates a missing file.\n' +
    'mode="append" appends content to the target.\n' +
    'LC creates missing parent directories.\n' +
    'A path in a new subfolder needs no separate directory step.\n' +
    'When overwriting a file that you read, pass expected_sha256.\n' +
    'Use the sha256 value that lc_read_file returned.\n' +
    'If the existing content changed, LC rejects the write.\n' +
    'This rejection prevents silent loss of those changes.\n' +
    'If expected_sha256 is supplied and the file was deleted, create and overwrite modes proceed.\n' +
    'Under the same condition, append mode refuses.\n' +
    'Example: lc_write_file({ files: [{ path: "...", content: "..." }], mode: "overwrite" })',
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
