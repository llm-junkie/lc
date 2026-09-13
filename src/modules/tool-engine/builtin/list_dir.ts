/**
 * list_dir — list a directory's entries.
 */
import { z } from 'zod';
import type { ToolHandler } from '../types';
import type { JsonSchema } from '../../llm-client/types';
import { COMMON_GLOB_DIALECT, FILESYSTEM_BATCH_MAX_ENTRIES } from './tool-contract-metadata.ts';

const HARD_CAP_LIST_ENTRIES = 5000;

const schema = z.object({
  paths: z.array(z.string()).min(
    1,
    'paths must contain at least one path. Add a directory path and retry.',
  ).max(
    FILESYSTEM_BATCH_MAX_ENTRIES,
    `paths accepts at most ${FILESYSTEM_BATCH_MAX_ENTRIES} entries. Split the listing into batches of ${FILESYSTEM_BATCH_MAX_ENTRIES} or fewer directories.`,
  ),
  pattern: z.string().optional(),
  include_hidden: z.boolean().optional(),
  max_entries: z.number().int().positive().max(
    HARD_CAP_LIST_ENTRIES,
    `max_entries must be at most ${HARD_CAP_LIST_ENTRIES}. Use ${HARD_CAP_LIST_ENTRIES} or a smaller entry limit.`,
  ).optional(),
});

export type ListDirInput = z.infer<typeof schema>;

export interface ListDirEntry {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  size: number | null;
  mtime: number | null;
}

export interface ListDirResult {
  path: string;
  entries: ListDirEntry[];
  truncated: boolean;
  error: string | null;
}

export interface ListDirOutput {
  results: ListDirResult[];
}

const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;

export const listDir: ToolHandler<ListDirInput, ListDirOutput> = {
  name: 'lc_list_dir',
  description:
    'List entries of one or more directories.\n' +
    `Pass at most ${FILESYSTEM_BATCH_MAX_ENTRIES} directory paths in the paths array.\n` +
    'Use pattern to filter one entry name with a glob pattern.\n' +
    'Every directory in the batch must resolve before LC starts the call.\n' +
    'If one directory does not exist, LC rejects the whole call.\n' +
    'The path_resolution_failed error names that directory.\n' +
    'In comparison, lc_read_file reports a missing path for one entry.\n' +
    'If a path is uncertain, call lc_stat first.\n' +
    `${COMMON_GLOB_DIALECT}\n` +
    'lc_list_dir does not search recursively.\n' +
    'include_hidden=false omits only dot-prefixed entries.\n' +
    'lc_list_dir has no fixed skip list from lc_grep or lc_glob_files.\n' +
    'Therefore, ordinary names such as node_modules, dist, and vendor remain listable.\n' +
    'max_entries defaults to 1000 and has a hard limit of 5000 per directory.\n' +
    'Each directory result includes a truncated flag.',
  uiDescription: 'List directories. Batch multiple paths.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    const result = await ctx.sandbox.listDir({
      paths: input.paths,
      pattern: input.pattern?.trim() ? input.pattern : undefined,
      include_hidden: input.include_hidden,
      max_entries: input.max_entries,
      allowed_roots: ctx.config.allowedRoots,
    });
    return {
      results: result.results.map((item) => ({
        ...item,
        entries: item.entries.map((entry) => ({
          ...entry,
          size: entry.size ?? null,
          mtime: entry.mtime ?? null,
        })),
        error: item.error ?? null,
      })),
    };
  },
};
