/**
 * Canonical category membership. Kept free of runtime dependencies so
 * persistence and policy helpers can normalize grants without loading native
 * tool handlers.
 * The full handler order remains canonical in registry.ts.
 */

import type { ToolName as LlmClientToolName } from '../llm-client/types';

export const FILE_IO_NAMES = [
  'lc_read_file', 'lc_read_image', 'lc_read_pdf', 'lc_write_file', 'lc_list_dir',
  'lc_grep', 'lc_edit_file', 'lc_glob_files', 'lc_stat', 'lc_apply_patch',
] as const;

/** File I/O tools that are initialized when a new root is created. */
export const FILE_IO_READ_ONLY_NAMES = [
  'lc_read_file',
  'lc_read_image',
  'lc_read_pdf',
  'lc_list_dir',
  'lc_stat',
  'lc_glob_files',
  'lc_grep',
] as const;

/** File I/O tools that always require explicit approval. */
export const FILE_IO_MUTATING_NAMES = [
  'lc_write_file',
  'lc_edit_file',
  'lc_apply_patch',
] as const;

/** Foundation tools are present whenever Workspace is active. */
export const FOUNDATION_NAMES = [
  'lc_todo_write', 'lc_ask_user', 'lc_get_current_time',
] as const;

/** The Whiteboard category owns one conversation-state tool. */
export const WHITEBOARD_NAMES = ['lc_whiteboard'] as const;

/** Lists the Web Access tools. */
export const WEB_ACCESS_NAMES = [
  'lc_web_fetch', 'lc_web_search', 'lc_web_research',
] as const;

/** The Skills category exposes the single read-only discovery tool. */
export const SKILLS_NAMES = ['lc_skill'] as const;

/** Tools that perform the user's requested operation instead of retrieval guidance. */
export const OPERATIONAL_TOOL_NAMES = [
  ...FILE_IO_NAMES,
  'lc_run_shell',
  ...WEB_ACCESS_NAMES,
  ...WHITEBOARD_NAMES,
] as const;

/** Read-only guidance tool. Exposure is derived from operational categories. */
export const TOOL_HELP_NAMES = ['lc_tool_help'] as const;

/**
 * Compile the exported llm-client name contract against the canonical lists.
 * The runtime registry comparison remains in tool-policy.test.ts.
 */
export const LLM_CLIENT_TOOL_NAMES = [
  ...FOUNDATION_NAMES,
  ...FILE_IO_NAMES,
  ...WEB_ACCESS_NAMES,
  ...WHITEBOARD_NAMES,
  'lc_run_shell',
  ...TOOL_HELP_NAMES,
  'lc_tool_history',
  ...SKILLS_NAMES,
] as const satisfies readonly LlmClientToolName[];

type LlmClientOnlyToolName = Exclude<
  LlmClientToolName,
  (typeof LLM_CLIENT_TOOL_NAMES)[number]
>;

export const LLM_CLIENT_TOOL_NAMES_ARE_EXACT:
  LlmClientOnlyToolName extends never ? true : never = true;
