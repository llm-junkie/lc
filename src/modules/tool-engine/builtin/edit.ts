/**
 * edit_file — replace an exact string in a file with new text.
 *
 * The model provides old_string and new_string.  Rust verifies that
 * old_string appears exactly once (line-ending-agnostic) and applies
 * the replacement atomically (temp file + rename).  If old_string
 * appears zero or multiple times the edit is rejected so the model
 * can adjust its context.
 *
 * Accepts two call shapes (both normalised to the batch form):
 *   Flat   — lc_edit_file({ path: "...", old_string: "...", new_string: "..." })
 *   Batch  — lc_edit_file({ files: [{ path: "...", old_string: "...", new_string: "..." }, ...] })
 *
 * The schema uses a single flat object (all optional) to avoid
 * `anyOf` / `allOf` in the JSON Schema — those keywords cause
 * LM Studio and other OpenAI-compat backends to silently fail.
 * The Zod refinement validates the exclusive forms before `run()`.
 */
import { z } from 'zod';
import type { ToolHandler } from '../types';
import type { JsonSchema } from '../../llm-client/types';
import { FILESYSTEM_BATCH_MAX_ENTRIES } from './tool-contract-metadata.ts';

const fileEntrySchema = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
}).strict();

/** All fields stay optional in JSON Schema; the Zod refinement validates the two forms. */
const schema = z.object({
  /** Flat form: single file path. */
  path: z.string().optional(),
  /** Flat form: exact text to replace. */
  old_string: z.string().optional(),
  /** Flat form: replacement text. */
  new_string: z.string().optional(),
  /** Batch form: one or more file edits. */
  files: z.array(fileEntrySchema).min(
    1,
    'files must contain at least one entry. Add a file edit or use the flat path/old_string/new_string form.',
  ).max(
    FILESYSTEM_BATCH_MAX_ENTRIES,
    `files accepts at most ${FILESYSTEM_BATCH_MAX_ENTRIES} entries. Split the edit into batches of ${FILESYSTEM_BATCH_MAX_ENTRIES} or fewer files.`,
  ).optional(),
  /** If true, create each file if it doesn't exist. Default: false. */
  create_if_missing: z.boolean().optional(),
}).strict().superRefine((input, context) => {
  const hasBatch = input.files !== undefined;
  const hasPath = input.path !== undefined;
  const hasOldString = input.old_string !== undefined;
  const hasNewString = input.new_string !== undefined;
  const hasFlatField = hasPath || hasOldString || hasNewString;

  if (hasBatch) {
    if (hasFlatField) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'files cannot be combined with path, old_string, or new_string. Remove every flat-form field.',
      });
    }
    return;
  }

  if (!hasPath) {
    context.addIssue({
      code: 'custom',
      path: ['path'],
      message: 'the flat form requires path. Send one file path or use the files batch form.',
    });
  }
  if (!hasOldString) {
    context.addIssue({
      code: 'custom',
      path: ['old_string'],
      message: 'the flat form requires old_string. Send the exact text to replace.',
    });
  }
  if (!hasNewString) {
    context.addIssue({
      code: 'custom',
      path: ['new_string'],
      message: 'the flat form requires new_string. Use an empty string to delete the match.',
    });
  }
});

export type EditInput = z.infer<typeof schema> & {
  // After normalisation, this is always the batch shape.
};

export interface EditEntry {
  path: string;
  replaced: boolean;
  occurrences: number;
  file_exists: boolean;
  bytes_before: number;
  bytes_after: number;
  lines_added: number;
  lines_removed: number;
  /** True when `create_if_missing` created the file instead of replacing text. */
  created: boolean;
  /** Why the edit did not apply, or what to fix. Present when the file was
   *  readable but old_string did not match exactly; error entries (missing
   *  file, binary, too large, …) carry `error` instead. */
  hint: string | null;
  /** 1-based start lines of each match when `occurrences > 1` (max 20). */
  match_lines: number[];
  /** 1-based start lines that matched only under relaxed whitespace comparison. */
  near_match_lines: number[];
  error: string | null;
}

export interface EditOutput {
  results: EditEntry[];
}

const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;

/** Normalise flat-form input to the internal batch shape. */
function normalize(input: z.infer<typeof schema>): { files: z.infer<typeof fileEntrySchema>[]; create_if_missing?: boolean } {
  if (input.files && input.files.length > 0) {
    return { files: input.files, create_if_missing: input.create_if_missing };
  }
  if (input.path && input.old_string !== undefined && input.new_string !== undefined) {
    return {
      files: [{ path: input.path, old_string: input.old_string, new_string: input.new_string }],
      create_if_missing: input.create_if_missing,
    };
  }
  // The public runner validates the conditional shape before execution.
  // Keep this guard for direct internal misuse without making it a second
  // model-facing validation implementation.
  throw new Error('lc_edit_file received an unvalidated input shape.');
}

export const edit: ToolHandler<EditInput, EditOutput> = {
  name: 'lc_edit_file',
  description:
    'Replace exact strings in files.\n' +
    'For one file, use the flat form.\n' +
    'lc_edit_file({ path: "...", old_string: "...", new_string: "..." })\n' +
    'For multiple files, use the batch form.\n' +
    'lc_edit_file({ files: [{ path: "...", old_string: "...", new_string: "..." }, ...] })\n' +
    `A batch accepts from 1 through ${FILESYSTEM_BATCH_MAX_ENTRIES} files.\n` +
    'Do not combine the flat and batch forms.\n' +
    'old_string must appear exactly once in each file.\n' +
    'Include from 3 through 5 lines of context to make the match unambiguous.\n' +
    'Matching ignores differences between line-ending formats.\n' +
    'Copy the file indentation exactly.\n' +
    'Each edit is atomic through a temporary file and rename.\n' +
    'Batch entries commit independently. A later failure does not roll back earlier changes.\n' +
    'Use lc_edit_file for targeted changes instead of rewriting entire files.\n' +
    'If occurrences is 0, the result includes a hint and near_match_lines.\n' +
    'near_match_lines identifies lines that differ only in whitespace.\n' +
    'If occurrences is greater than 1, match_lines identifies at most 20 matching locations.\n' +
    'Use those lines to add context without another file read.\n' +
    'A pre-match failure reports error instead.\n' +
    'Pre-match failures include a missing, binary, or oversized file.\n' +
    'To create a new file, use lc_write_file.\n' +
    'The single top-level create_if_missing flag applies to every batch entry.\n' +
    'Do not put create_if_missing inside a files entry.\n' +
    'If create_if_missing is true, LC writes new_string as the complete missing file.\n' +
    'In this case, LC ignores old_string.',
  uiDescription: 'Replace exact strings in files. Flat or batch.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    const norm = normalize(input);
    const result = await ctx.sandbox.edit({ ...norm, allowed_roots: ctx.config.allowedRoots });
    return {
      results: result.results.map((entry) => ({
        ...entry,
        lines_added: entry.lines_added ?? 0,
        lines_removed: entry.lines_removed ?? 0,
        created: entry.created ?? false,
        hint: entry.hint ?? null,
        match_lines: entry.match_lines ?? [],
        near_match_lines: entry.near_match_lines ?? [],
        error: entry.error ?? null,
      })),
    };
  },
};
