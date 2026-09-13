import { z } from 'zod';
import type { ToolHandler } from '../types';
import {
  COMMON_GLOB_DIALECT,
  FIXED_SEARCH_EXCLUDED_DIRS,
  GREP_COMPLETENESS_CONTRACT,
} from './tool-contract-metadata.ts';

const EXCLUDED_DIRS_COPY = FIXED_SEARCH_EXCLUDED_DIRS.map((name) => `\`${name}\``).join(', ');

const schema = z.object({
  pattern: z.string().min(1).describe(
    'Provide a glob pattern. Examples are "**/*.{ts,tsx}" and "src/**/*.test.ts". ' +
    'The pattern supports *, **, ?, [abc], and {a,b} brace expansion.'),
  root: z.string().min(1).describe(
    'Set the root directory for recursive search.'),
  include_hidden: z.boolean().optional().describe(
    'Set true to include names that start with a dot. The default is false.'),
  max_results: z.number().int().positive().max(
    5000,
    'max_results must be at most 5000. Use 5000 or a smaller result limit.',
  ).optional().describe(
    'Set the maximum returned results. The default is 1000.'),
});

type Input = z.infer<typeof schema>;

export interface GlobFilesOutput {
  matches: Array<{
    path: string;
    is_dir: boolean;
    size_bytes: number | null;
  }>;
  truncated: boolean;
  pattern_used: string;
  visited_entries: number;
}

export const globFiles: ToolHandler<Input, GlobFilesOutput> = {
  name: 'lc_glob_files',
  description:
    'Find files and directories recursively with a glob pattern.\n' +
    'The search starts under one root directory.\n' +
    'The root must resolve before LC starts the call.\n' +
    'If the root does not exist, LC rejects the whole call.\n' +
    'The path_resolution_failed error names the root.\n' +
    'In comparison, lc_read_file reports a missing path for one entry.\n' +
    'If the root is uncertain, call lc_stat first.\n' +
    `${COMMON_GLOB_DIALECT}\n` +
    'Matching uses root-relative paths normalized to "/".\n' +
    'Traversal always prunes fixed directory basenames.\n' +
    `Excluded directory basenames: ${EXCLUDED_DIRS_COPY}\n` +
    'Therefore, zero matches does not prove that an excluded path is absent.\n' +
    'Each match includes is_dir to distinguish directories from files.\n' +
    'If include_hidden=false, LC suppresses a matching dot-prefixed basename.\n' +
    'Traversal still enters hidden directories.\n' +
    'Therefore, ordinary descendants such as .github/workflows/build.yml can match.\n' +
    'truncated means that traversal stopped because of a limit or cancellation.\n' +
    'Possible limits are result count, visited entries, and deadline.\n' +
    'For the result limit, LC sets truncated only after it finds one more match.\n' +
    'Therefore, truncated=false means that the listing is complete.\n' +
    `${GREP_COMPLETENESS_CONTRACT}\n` +
    'Cancellation returns a normal result.\n' +
    'That result preserves matches collected before cancellation.\n' +
    'Use lc_glob_files to locate files by name pattern.\n' +
    'This avoids manual directory enumeration with lc_list_dir and lc_grep.',
  uiDescription: 'Find files matching a glob pattern recursively.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    const result = await ctx.sandbox.globFiles({
      pattern: input.pattern,
      root: input.root,
      allowed_roots: ctx.config.allowedRoots,
      include_hidden: input.include_hidden,
      max_results: input.max_results,
      call_id: ctx.identity.operationId,
      group_id: ctx.identity.groupId,
      deadline_ms: ctx.config.maxShellTimeoutMs || 30_000,
    });
    return {
      ...result,
      matches: result.matches.map((match) => ({
        ...match,
        size_bytes: match.size_bytes ?? null,
      })),
      visited_entries: result.visited_entries ?? 0,
    };
  },
};

const CACHED_SCHEMA = {
  type: 'object' as const,
  properties: {
    pattern: {
      type: 'string' as const,
      minLength: 1,
      description: 'Provide a glob pattern. Examples are "**/*.{ts,tsx}" and "src/**/*.test.ts". The pattern supports *, **, ?, [abc], and {a,b} brace expansion.',
    },
    root: {
      type: 'string' as const,
      minLength: 1,
      description: 'Set the root directory for recursive search.',
    },
    include_hidden: {
      type: 'boolean' as const,
      description: 'Set true to include names that start with a dot. The default is false.',
    },
    max_results: {
      type: 'integer' as const,
      minimum: 1,
      maximum: 5000,
      description: 'Set the maximum returned results. The default is 1000.',
    },
  },
  required: ['pattern', 'root'],
  additionalProperties: false as const,
};
