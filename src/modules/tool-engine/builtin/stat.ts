import { z } from 'zod';
import type { ToolHandler } from '../types';
import type { StatEntry, StatResult } from '../sandbox-bridge';

const schema = z.object({
  paths: z.array(z.string().min(1)).min(
    1,
    'paths must contain at least one path. Add a path and retry.',
  ).max(
    100,
    'paths accepts at most 100 entries. Split the stat request into batches of 100 or fewer paths.',
  ).describe(
    'Absolute paths to inspect. A call accepts at most 100 paths.'),
});

type Input = z.infer<typeof schema>;

export const stat: ToolHandler<Input, StatResult> = {
  name: 'lc_stat',
  description:
    'Get file or directory metadata without reading content.\n' +
    'For each path, the result reports existence and type.\n' +
    'Applicable metadata includes size and modification time.\n' +
    'Every declared metadata and error field is present.\n' +
    'A field contains null when its value is not applicable or unavailable.\n' +
    'Use lc_stat instead of lc_read_file when you need only metadata.',
  uiDescription: 'Get file/directory metadata without reading content.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    const result = await ctx.sandbox.stat({
      paths: input.paths,
      allowed_roots: ctx.config.allowedRoots,
    });
    // Map bridge result entries to a friendly output shape, preserving
    // structured errors (outside-root vs not-found vs io-error).
    const results = result.results.map((e: StatEntry) => ({
      path: e.path,
      exists: e.exists,
      is_file: e.is_file ?? false,
      is_dir: e.is_dir ?? false,
      size_bytes: e.size_bytes ?? null,
      mtime_ms: e.mtime_ms ?? null,
      canonical: e.canonical ?? null,
      error: e.error ?? null,
    }));
    return { results };
  },
};

const CACHED_SCHEMA = {
  type: 'object' as const,
  properties: {
    paths: {
      type: 'array' as const,
      items: { type: 'string' as const, minLength: 1 },
      minItems: 1,
      maxItems: 100,
      description: 'Absolute paths to inspect. A call accepts at most 100 paths.',
    },
  },
  required: ['paths'],
  additionalProperties: false as const,
};
