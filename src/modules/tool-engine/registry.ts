/**
 * Tool registry — the project's complete set of built-in tools.
 *
 * Consumers use `BUILTIN_TOOLS` as the canonical registry and let
 * `resolveExposure()` select the currently exposed handlers before
 * mapping them to the wire format with `materialize()`.
 */
import type { ToolDefinition } from '../llm-client/types';
import type { ToolHandler } from './types';
export {
  FILE_IO_NAMES,
  FILE_IO_MUTATING_NAMES,
  FILE_IO_READ_ONLY_NAMES,
  FOUNDATION_NAMES,
  WEB_ACCESS_NAMES,
  OPERATIONAL_TOOL_NAMES,
  SKILLS_NAMES,
  TOOL_HELP_NAMES,
  WHITEBOARD_NAMES,
} from './registry-names.ts';

import { readFile } from './builtin/read_file.ts';
import { readImage } from './builtin/read_image.ts';
import { readPdf } from './builtin/read_pdf.ts';
import { writeFile } from './builtin/write_file.ts';
import { listDir } from './builtin/list_dir.ts';
import { webFetch } from './builtin/web_fetch.ts';
import { getCurrentTime } from './builtin/get_current_time.ts';
import { runShell } from './builtin/run_shell.ts';
import { todoWrite } from './builtin/todo_write.ts';
import { askUser } from './builtin/ask_user.ts';
import { whiteboard } from './whiteboard.ts';
import { grep } from './builtin/grep.ts';
import { edit } from './builtin/edit.ts';
import { webSearch } from './builtin/web_search.ts';
import { webResearch } from './builtin/web_research.ts';
import { globFiles } from './builtin/glob_files.ts';
import { stat } from './builtin/stat.ts';
import { applyPatch } from './builtin/apply_patch.ts';
import { toolHistory } from './builtin/tool_history.ts';
import { skill } from './builtin/skill.ts';
import { toolHelp } from './builtin/tool_help.ts';

/**
 * The full built-in registry. Typed as `ToolHandler[]`
 * because the array is heterogeneous — each tool has its own
 * `I`/`O` generics. The per-tool `input` and `output` types are
 * still enforced *inside* each tool's `run` implementation (via
 * the zod schema + the `O` return type), and the runner uses
 * `HANDLERS_BY_NAME` to look up the specific `ToolHandler` for
 * each tool call, where the generics stay accurate.
 */
export const BUILTIN_TOOLS: ToolHandler[] = [
  readImage,
  readPdf,
  readFile,
  writeFile,
  listDir,
  webFetch,
  getCurrentTime,
  runShell,
  todoWrite,
  askUser,
  whiteboard,
  grep,
  edit,
  webSearch,
  webResearch,
  stat,
  globFiles,
  applyPatch,
  toolHelp,
  toolHistory,
  skill,
];

/** Map by name for O(1) lookup. The runner hits this on every call. */
export const HANDLERS_BY_NAME: Map<string, ToolHandler> = new Map(
  BUILTIN_TOOLS.map((t) => [t.name, t]),
);

/**
 * Project a list of in-process handlers to the wire format. Strips
 * client-only implementation details (strict OpenAI-compat engines
 * reject unknown fields with a 400).
 */
export function materialize(tools: ToolHandler[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: typeof t.description === 'function' ? t.description() : t.description,
      parameters: t.toJsonSchema(),
    },
  }));
}

/**
 * Filter the global registry by the active exposure set.
 * Returns only tools whose category is currently exposed.
 */
export function enabledTools(perConvEnabled: Set<string>): ToolHandler[] {
  return BUILTIN_TOOLS.filter((t) => perConvEnabled.has(t.name));
}
