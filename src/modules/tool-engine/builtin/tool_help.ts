import { z } from 'zod';
import type { JsonSchema } from '../../llm-client/types';
import {
  buildToolHelpEnvelope,
  distinctHelpQueryTerms,
  TOOL_HELP_INPUT_MESSAGES,
  TOOL_HELP_MAX_QUERY_TERMS,
  type ToolHelpData,
  type ToolHelpInput,
} from '../tool-help.ts';
import type { ToolHandler, ToolResultEnvelope } from '../types';

const schema = z.object({
  tool: z.string()
    .trim()
    .min(1, TOOL_HELP_INPUT_MESSAGES.tool)
    .max(80, TOOL_HELP_INPUT_MESSAGES.tool),
  query: z.string()
    .trim()
    .max(160, TOOL_HELP_INPUT_MESSAGES.queryCharacters)
    .optional(),
}).strict().superRefine((value, ctx) => {
  const query = value.query ?? '';
  if (distinctHelpQueryTerms(query).length > TOOL_HELP_MAX_QUERY_TERMS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['query'],
      message: TOOL_HELP_INPUT_MESSAGES.queryTerms,
    });
  }
});

const CACHED_SCHEMA = Object.freeze(schema.toJSONSchema()) as unknown as JsonSchema;

export const toolHelp: ToolHandler<ToolHelpInput, ToolResultEnvelope<ToolHelpData>> = {
  name: 'lc_tool_help',
  description:
    'Get bounded guidance for one exposed tool. Omit query to get basic help. ' +
    'Provide query to search sections for only that resolved tool. query accepts 160 trimmed characters and eight distinct terms. ' +
    'LC can correct one confident name mistake and discloses the correction. ' +
    'It never executes an operational call under the corrected name. The tool performs no filesystem, shell, network, or model operation.',
  uiDescription: 'Get bounded guidance for one exposed tool.',
  input: schema,
  toJsonSchema: () => CACHED_SCHEMA,
  run: async (input, ctx) => buildToolHelpEnvelope(
    { tool: input.tool.trim(), ...(input.query?.trim() ? { query: input.query.trim() } : {}) },
    new Set(ctx.config.exposedToolNames ?? []),
  ),
};
