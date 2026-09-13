/** System-prompt assembly and token counting. Tool schemas travel separately. */
import type { Conversation } from '../../types';
import { getHomeDir } from '../../utils/saveBlob.ts';
import { countTokens } from '../../utils/tokens.ts';
import { useSettings } from '../../store/settings.ts';
import { LC_TOOLS_SKILL_ID } from '../lc-tools-skill.ts';
import { formatPathForDisplay } from '../tool-engine/clean-path.ts';
import { resolveExposure } from '../tool-engine/policy.ts';
import { resolveToolBatchLimit, resolveToolRoundLimit } from './tool-batch-limit.ts';
import { WINDOWS_CMD_BUILTINS } from './windows-cmd.ts';

type SystemPromptInput = Pick<Conversation, 'tools'> & {
  params: Pick<Conversation['params'], 'system_prompt'>;
};

export { WINDOWS_CMD_BUILTINS } from './windows-cmd.ts';

/** Resolve the exact per-conversation shell allowlist used by the runtime. */
export function shellListFromConv(c: { tools?: { shell_allowlist?: string } }): string[] {
  const raw = c.tools?.shell_allowlist !== undefined
    ? c.tools.shell_allowlist
    : useSettings.getState().tools.shell_allowlist;
  return raw.split(/[,\n]+/).map((value) => value.trim()).filter(Boolean);
}

function toolLimitsSection(
  tools: Conversation['tools'] | undefined,
  hasExposedCategory: boolean,
  fileIoEnabled: boolean,
): string {
  if (!tools?.enabled || !hasExposedCategory) return '';
  const maxCallsPerBatch = resolveToolBatchLimit(tools.max_tool_calls_per_batch);
  const maxRoundsPerTurn = resolveToolRoundLimit(tools.max_tool_rounds_per_turn);
  const fileCallOrder = fileIoEnabled
    ? 'Batch only independent file calls.\n' +
      'Wait for each result before the next dependent file call.\n'
    : '';
  return '[Tool limits]\n' +
    `A batch can contain at most ${maxCallsPerBatch} tool calls.\n` +
    'LC runs accepted calls concurrently.\n' +
    fileCallOrder +
    'LC rejects an oversized batch without execution and ends the response.\n' +
    `A turn can contain at most ${maxRoundsPerTurn} tool-call rounds.\n` +
    'Split larger work across rounds.';
}

function osName(): string {
  const raw = (typeof navigator !== 'undefined' ? navigator.platform : '')?.toLowerCase() || 'unknown';
  if (raw.includes('win')) return 'Windows';
  if (raw.includes('mac')) return 'macOS';
  if (raw.includes('linux')) return 'Linux';
  return raw;
}

const NATIVE_WINDOWS_CMD_GUIDANCE =
  'LC has no `cmd` executable.\n' +
  'For Windows built-ins, `cmd` starts native `cmd.exe` with `/c`.';

export const WHITEBOARD_SYSTEM_PROMPT_RULES = Object.freeze([
  'Use lc_whiteboard to read the conversation boards and change only the model board.',
  'The user board is fixed for this turn. User edits made now appear in the next turn.',
  'Model board reads show your latest applied change in the current turn.',
] as const);

/** Generate shell guidance from the same effective allowlist sent to native execution. */
export function buildShellSection(shellList: string[], isWindows: boolean): string {
  const hasMaster = shellList.includes('*****') || shellList.includes('*******');
  const visible = shellList.filter((name) => name !== '*****' && name !== '*******');

  if (hasMaster) {
    if (isWindows) {
      return 'lc_run_shell allows any executable name.\n' +
        NATIVE_WINDOWS_CMD_GUIDANCE + '\n' +
        `Builtin names: \`${[...WINDOWS_CMD_BUILTINS].join(', ')}\`.\n` +
        'Use the canonical executable-plus-args form.\n' +
        'For example, use ' +
        '`{"cmd":"cmd","args":["/c","dir C:\\\\Users"]}`.';
    }
    return 'lc_run_shell allows any executable name. Use `cmd` for the executable name and `args` for its argument array.';
  }

  if (!isWindows) {
    return `lc_run_shell accepts these executable names: ${visible.join(', ') || '(none)'}.\n` +
      'Use `cmd` for one executable name.\n' +
      'Use `args` for its argument array.\n' +
      'LC invokes the executable directly.\n' +
      'Availability depends on the child PATH.';
  }

  const executables = visible.filter((name) => !WINDOWS_CMD_BUILTINS.has(name));
  const builtins = visible.filter((name) => WINDOWS_CMD_BUILTINS.has(name));
  let text = `Executable names invoked directly: ${executables.join(', ') || '(none)'}.`;
  if (builtins.length > 0) {
    text += `\nConfigured cmd.exe builtin names: ${builtins.join(', ')}.\n` +
      'These names are not standalone executables.\n' +
      NATIVE_WINDOWS_CMD_GUIDANCE + '\n' +
      'Invoke them as `{"cmd":"cmd","args":["/c","..."]}`.\n' +
      'The allowlist must also include `cmd`.';
  }
  return text;
}

/** Assemble prompt policy only. Structured definitions are sent once in req.tools. */
export function buildPromptText(
  conv: SystemPromptInput,
  homeDirectory: string,
  os = osName(),
): string {
  const isWindows = os === 'Windows';
  const sections: string[] = [];
  const roots = conv.tools?.allowed_roots ?? [];
  const displayedHomeDirectory = formatPathForDisplay(homeDirectory, isWindows);
  const displayedRoots = roots.map((root) => formatPathForDisplay(root, isWindows));
  const exposedNames = resolveExposure(conv.tools ?? {}).exposedNames;
  const fileEnabled = exposedNames.has('lc_read_file');
  const shellEnabled = exposedNames.has('lc_run_shell');
  const hasExposedCategory = exposedNames.size > 0;
  const rootsRelevant = fileEnabled || shellEnabled;
  const helpExposed = exposedNames.has('lc_tool_help');
  const askUserExposed = exposedNames.has('lc_ask_user');
  const lcToolsSkillExposed = exposedNames.has('lc_skill')
    && Boolean(conv.tools?.enabled_skill_ids?.includes(LC_TOOLS_SKILL_ID));

  let environment = `[Environment]\nOS: ${os}`;
  if (rootsRelevant) {
    if (fileEnabled) environment += `\nHome directory: ${displayedHomeDirectory}`;
    environment += `\nConfigured file roots: ${displayedRoots.length > 0 ? displayedRoots.join(', ') : '(none)'}`;
  }
  sections.push(environment);

  const authorization: string[] = [];
  if (fileEnabled) {
    authorization.push(
      'A valid File I/O request can target an ungranted directory.\n' +
      'The directory can be outside the configured roots.\n' +
      'LC can request approval for the exact canonical scope.\n' +
      'Approval can apply once or for the conversation.\n' +
      'Malformed or non-canonicalizable input can fail before approval.',
    );
  }
  if (shellEnabled) {
    authorization.push(
      'lc_run_shell.cwd uses a different authorization rule.\n' +
      'An explicit working directory must already exist inside an allowed root.\n' +
      'If cwd is omitted, LC uses the first configured root.\n' +
      'If no roots exist, LC uses the system temporary directory.',
    );
  }
  if (authorization.length > 0) sections.push('[Authorization]\n' + authorization.join('\n'));

  if (hasExposedCategory) {
    let toolUsage = '[Tool usage]\nCall exposed tools when useful.';
    if (conv.tools?.tool_history_enabled) {
      toolUsage += '\nLC archives completed-turn tool results.\n' +
        'Use lc_tool_history to retrieve them.';
    }
    if (helpExposed && lcToolsSkillExposed) {
      toolUsage += '\nUse lc_skill with lc:builtin:lc-tools for cross-tool choices and workflows. ' +
        'Use lc_tool_help for detailed guidance about one tool.';
    } else if (helpExposed) {
      toolUsage += '\nUse lc_tool_help for detailed guidance about one tool.';
    }
    if (askUserExposed) {
      toolUsage += '\nlc_ask_user pauses and returns user input for this turn.';
    }
    sections.push(toolUsage);
  }

  if (exposedNames.has('lc_whiteboard')) {
    sections.push('[Whiteboard]\n' + WHITEBOARD_SYSTEM_PROMPT_RULES.join('\n'));
  }

  const toolLimits = toolLimitsSection(conv.tools, hasExposedCategory, fileEnabled);
  if (toolLimits) sections.push(toolLimits);

  if (isWindows && rootsRelevant) {
    sections.push(
      '[Paths on Windows]\n' +
      'Use standard Windows backslashes.\n' +
      'Escape each backslash as \\\\ in JSON.\n' +
      'Example: C:\\\\Users\\\\name\\\\file.txt.',
    );
  }

  if (shellEnabled) {
    sections.push('[Shell capability]\n' + buildShellSection(shellListFromConv(conv), isWindows));
  }

  if (conv.tools?.enabled && conv.tools.skills_enabled) {
    const refreshLcTools = conv.tools.enabled_skill_ids?.includes(LC_TOOLS_SKILL_ID)
      ? `\nThe LC Tool Cheat Sheet skill contains current tool guidance.\nAt the start of a turn that needs this guidance, retrieve ${LC_TOOLS_SKILL_ID} with lc_skill.\nDo not reuse an older result from chat context or archived tool results because Workspace exposure may have changed.`
      : '';
    sections.push(
      '[Skills]\nUse lc_skill with {} to list the user-enabled Markdown skills.\n' +
      'Use lc_skill with {"id":"xxx"} to retrieve a skill before applying it.\n' +
      'Only skills enabled in the Workspace panel are available.\n' +
      'LC does not control user-provided skills.\n' +
      'These skills can mention unavailable tools.\n' +
      'Use only currently exposed tools.' +
      refreshLcTools,
    );
  }

  const custom = conv.params?.system_prompt?.trim();
  if (custom) sections.push(`[Custom system instructions]\n${custom}`);
  return sections.join('\n\n');
}

export async function buildSystemPrompt(conv: Conversation): Promise<string> {
  return buildPromptText(conv, await getHomeDir());
}

/** Select exactly the system content that request construction will send. */
export function selectSystemPromptText(
  conv: SystemPromptInput,
  includeWorkspacePolicy: boolean,
  homeDirectory = '/home/user',
  os = osName(),
): string {
  return includeWorkspacePolicy
    ? buildPromptText(conv, homeDirectory, os)
    : (conv.params.system_prompt?.trim() ?? '');
}

export function countSystemPromptTokens(
  conv: SystemPromptInput,
  includeWorkspacePolicy: boolean,
): number {
  return countTokens(selectSystemPromptText(conv, includeWorkspacePolicy));
}
