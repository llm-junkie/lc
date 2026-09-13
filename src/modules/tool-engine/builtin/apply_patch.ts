import { z } from 'zod';
import type { ToolHandler } from '../types';

const APPLY_PATCH_DESCRIPTION = `Apply related changes to several files in one call.

The limit is 1 MiB per patch.
The limit is 32 MiB per target file.
The total limit is 64 MiB across the prepared plan.
First, read each existing target with lc_read_file.
Then send one patch in this shape.
Patch paths are filesystem paths in the patch language.
They are not JSON string literals.
*** Begin Patch
*** Update File: C:\\path\\app.ts
@@
 function run() {
-  return "old";
+  return "new";
 }
*** Add File: C:\\path\\new.txt
+new file content
*** Update File: C:\\path\\old.txt
*** Move to: C:\\path\\new-name.txt
*** Delete File: C:\\path\\remove.txt
*** End Patch

Rules:
- In an update hunk, a leading space keeps a line.
- A leading - removes a line.
- A leading + adds a line.
- A blank context line must still contain one leading space.
- Put the - and + lines for one replacement in the same @@ hunk.
- Use one bare @@ for the hunk.
- Do not put the old block and new block in separate hunks.
- Put Add File content directly after its header.
- Add File does not need @@.
- Move to must be immediately after Update File. It is not a standalone header.
- Add and Move never overwrite an existing destination.
- Use exact lines copied from the file when possible.
- A fallback match can succeed, but it returns a warning.
- After the call, inspect fully_applied.
- Also inspect every entry in files.
- If a hunk fails, read the file again before you retry.

If there is one simple file replacement, use lc_edit_file instead.`;

const PATCH_PARAMETER_DESCRIPTION = 'Start with *** Begin Patch. End with *** End Patch.';

export const APPLY_PATCH_INPUT_MESSAGES = Object.freeze({
  required: 'patch must contain text. Send one complete patch from *** Begin Patch through *** End Patch.',
  maximum: 'patch accepts at most 1048576 characters. Split unrelated changes into smaller patches.',
});

const schema = z.object({
  patch: z.string()
    .min(1, APPLY_PATCH_INPUT_MESSAGES.required)
    .max(1_048_576, APPLY_PATCH_INPUT_MESSAGES.maximum)
    .describe(PATCH_PARAMETER_DESCRIPTION),
}).strict();

type Input = z.infer<typeof schema>;

export interface ApplyPatchOutput {
  files: Array<{
    path: string;
    action: 'add' | 'update' | 'delete' | 'move';
    move_to: string | null;
    hunks_applied: number;
    lines_added: number;
    lines_removed: number;
    warnings: string[];
    error: string | null;
  }>;
  summary: string;
  fully_applied: boolean;
}

export const applyPatch: ToolHandler<Input, ApplyPatchOutput> = {
  name: 'lc_apply_patch',
  description: APPLY_PATCH_DESCRIPTION,
  uiDescription: 'Apply multi-file patches — create/update/delete/rename.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => {
    if (!ctx.nativePlanId) {
      throw new Error('lc_apply_patch requires successful native preflight');
    }
    const result = await ctx.sandbox.applyPatch({
      patch: input.patch,
      allowed_roots: ctx.config.allowedRoots,
      plan_id: ctx.nativePlanId,
      call_id: ctx.identity.operationId,
      group_id: ctx.identity.groupId,
    });
    return {
      ...result,
      files: result.files.map((file) => ({
        ...file,
        move_to: file.move_to ?? null,
        hunks_applied: file.hunks_applied ?? 0,
        lines_added: file.lines_added ?? 0,
        lines_removed: file.lines_removed ?? 0,
        warnings: file.warnings ?? [],
        error: file.error ?? null,
      })),
    };
  },
};

const CACHED_SCHEMA = {
  type: 'object' as const,
  properties: {
    patch: {
      type: 'string' as const,
      minLength: 1,
      maxLength: 1_048_576,
      description: PATCH_PARAMETER_DESCRIPTION,
    },
  },
  required: ['patch'],
  additionalProperties: false as const,
};
