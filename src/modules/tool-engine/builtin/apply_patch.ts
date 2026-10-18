import { APPLY_PATCH_GUIDANCE } from '../tool-guidance.ts';
import { z } from 'zod';
import type { ToolHandler } from '../types';


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
  description: APPLY_PATCH_GUIDANCE.essential,
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
