import { GLOB_FILES_GUIDANCE } from '../tool-guidance.ts';
import { z } from 'zod';
import type { ToolHandler } from '../types';


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
}).strict();

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
  description: GLOB_FILES_GUIDANCE.essential,
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
