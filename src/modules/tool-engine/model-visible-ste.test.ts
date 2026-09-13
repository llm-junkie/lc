import { readFileSync as readPdfNativeText } from 'node:fs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation } from '../../types';
import { WHITEBOARD_INVALID_INPUT_FIXTURES } from '../../whiteboard/contract-fixtures.ts';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

const { useSettings } = await import('../../store/settings.ts');
const {
  interruptedToolResultContent,
  restartedToolResultMessage,
} = await import('../../store/conversations.ts');
const { BUILTIN_TOOLS, materialize } = await import('./registry.ts');
const { APPLY_PATCH_INPUT_MESSAGES } = await import('./builtin/apply_patch.ts');
const { buildPromptText, buildShellSection } = await import('../chat-pipeline/system-prompt.ts');
const { formatToolBatchLimitMessage } = await import('../chat-pipeline/tool-batch-limit.ts');
const { validateApprovedPatchPreflight } = await import('../chat-pipeline/patch-authorization.ts');
const {
  PILOT_GUIDANCE_CATALOGS,
  TOOL_NAME_ENTRIES,
} = await import('./tool-guidance.ts');
const {
  buildToolHelpData,
  TOOL_HELP_INPUT_MESSAGES,
  TOOL_HELP_MESSAGES,
} = await import('./tool-help.ts');
const { unknownOperationalToolIssue } = await import('./tool-name-resolution.ts');
const { INVALID_ARGUMENT_REMEDIES, toolResultTooLargeIssue } = await import('./runner.ts');
const { normalizeThrownToolError } = await import('./tool-error.ts');
const { READ_FILE_ISSUE_MESSAGES } = await import('./builtin/read_file.ts');
const { pageHeader, parsePageRange } = await import('./builtin/pdf-chunking.ts');
const PDF_SUMMARY_SYSTEM_PROMPT = readPdfNativeText('src-tauri/src/tools/pdf/summary-prompt.txt', 'utf8');
const PDF_REDUCE_SYSTEM_PROMPT = readPdfNativeText('src-tauri/src/tools/pdf/reduce-prompt.txt', 'utf8');
const { READ_IMAGE_WARNINGS } = await import('./read-image-result.ts');
const { READ_IMAGE_SYSTEM_PROMPT } = await import('./builtin/read_image.ts');
const {
  WEB_RESEARCH_SYNTHESIS_GUIDANCE,
  WEB_RESEARCH_SYSTEM_PROMPT,
} = await import('./builtin/web_research.ts');
const {
  SEARCH_MAX_QUERY_CHARACTERS,
  SEARCH_MAX_QUERY_TERMS,
  parseSearchQuery,
} = await import('./builtin/tool-history-search.ts');
const {
  CURRENT_TIME_TZ_LIMIT_MESSAGE,
  invalidTimezoneWarning,
} = await import('./builtin/get_current_time.ts');
const {
  SKILL_ID_LIMIT_MESSAGE,
  SKILL_RESULT_TOO_LARGE_MESSAGE,
  SKILL_UNAVAILABLE_MESSAGE,
  skillListLimitMessage,
} = await import('./builtin/skill.ts');
const {
  contendedReadNotice,
  duplicateToolCallIdNotice,
  LC_RESULT_NOTICES,
  repeatedToolCallNotice,
} = await import('./tool-result-content.ts');
const { getBuiltinSkill } = await import('../builtin-skills.ts');
const { materializeSkillForExposure } = await import('../lc-tools-skill.ts');
const {
  completionEvidenceWarning,
  TODO_PROJECTION_TEXT,
  TODO_WRITE_SCHEMA,
  todoOmittedInProgressNotesNotice,
  todoOmittedNotesNotice,
} = await import('./todo-state.ts');
const { TODO_UI_TEXT } = await import('../../ui/tools/TodoBody.tsx');
const { ASK_USER_BATCH_ISSUE, ASK_USER_INPUT_SCHEMA } = await import('./ask-user.ts');
const { ASK_USER_ISSUES } = await import('./builtin/ask_user.ts');
const { ASK_USER_UI_TEXT } = await import('../../ui/tools/AskUserModal.tsx');
const {
  WHITEBOARD_INPUT_SCHEMA,
  WHITEBOARD_TOTAL_MISS_REMEDY,
} = await import('./whiteboard.ts');
const {
  UNRESOLVED_HISTORY_REDACTED_OUTPUT,
  WHITEBOARD_HISTORY_REDACTED_OUTPUT,
} = await import('./builtin/tool_history.ts');
const {
  WHITEBOARD_DYNAMIC_UI_TEXT,
  WHITEBOARD_UI_TEXT,
} = await import('../../ui/tools/whiteboard-ui-text.ts');
const {
  WHITEBOARD_PACKAGE_ERROR_MESSAGES,
  whiteboardPackageFilename,
} = await import('../../ui/tools/whiteboard-package.ts');
const {
  APPLIED_AFTER_TERMINATION_WARNING,
  WHITEBOARD_TERMINAL_ISSUE_TEXT,
} = await import('../../store/whiteboard-conversation.ts');

const PROCEDURAL_START = /^(?:Accept|Add|After|Allow|Always|Apply|Ask|Avoid|Before|Call|Change|Check|Choose|Close|Combine|Confirm|Continue|Convert|Copy|Correct|Create|Delete|Discover|Do|Drop|Edit|Enlarge|Ensure|Enter|Escape|Fetch|Find|First|Follow|Get|Give|Ignore|Include|Inspect|Invoke|Keep|Limit|List|Mark|Move|Narrow|Never|Omit|Open|Pass|Prefer|Prepare|Provide|Put|Read|Reduce|Remove|Replace|Report|Retrieve|Retry|Return|Run|Search|Select|Send|Set|Shorten|Skip|Split|Start|Stop|Then|Treat|Try|Use|Verify|Wait|Write)\b/i;

const STRUCTURED_VALUE_LINE = /^(?:OS|Home directory|Configured file roots|Executable names invoked directly|Configured cmd\.exe builtin names|Builtin names|Excluded directory basenames|Excluded extensions|Reasons):\s*(.+)$/;

function isStructuredValueLine(line: string): boolean {
  const match = STRUCTURED_VALUE_LINE.exec(line);
  if (!match) return false;

  const value = match[1].replace(/\.$/, '').trim();
  if (/^`[^`]+`$/.test(value)) return true;

  return value.split(/,\s*/).every((item) =>
    /^(?:`[^`]+`|"[^"]+"|\(none\)|[A-Za-z0-9_.:/\\-]+)$/.test(item.trim()),
  );
}

function isTechnicalExampleLine(line: string): boolean {
  const match = /^Example:\s*(.+)$/.exec(line);
  return match !== null && /^(?:[A-Za-z]:[\\/]|\/|lc_[a-z_]+\(\{)/.test(match[1]);
}

function wordCount(value: string): number {
  const normalized = value
    .replace(/`[^`]*`/g, ' literal ')
    .replace(/"[^"]*"/g, ' literal ')
    .replace(/\b\d+(?:[.,]\d+)*(?:\s+(?:bytes?|characters?|entries|files?|MiB|milliseconds?|paths?|results?|seconds?|todos?))?\b/gi, ' value ');
  return normalized.match(/[\p{L}\p{N}_][\p{L}\p{N}_+./:-]*/gu)?.length ?? 0;
}

function proseSentences(value: string): string[] {
  const withoutPatchExample = value.replace(
    /\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/g,
    '',
  );
  const sectionHeading = /^\[[^\]]+\]$/;
  const codeExample = /^lc_[a-z_]+\(\{/;

  return withoutPatchExample
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^-\s+/, ''))
    .filter((line) => line
      && !sectionHeading.test(line)
      && line !== 'Rules:'
      && !isStructuredValueLine(line)
      && !isTechnicalExampleLine(line)
      && !codeExample.test(line))
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function assertStructuralSte(label: string, value: string): void {
  const prose = value.replace(/\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/g, '');
  assert.doesNotMatch(prose, /;/, `${label} contains a prose semicolon`);
  assert.doesNotMatch(prose, /\b(?:e\.g\.|i\.e\.|etc\.)/i, `${label} contains an abbreviated prose term`);

  for (const sentence of proseSentences(value)) {
    const count = wordCount(sentence);
    const limit = PROCEDURAL_START.test(sentence) ? 20 : 25;
    assert.ok(
      count <= limit,
      `${label} exceeds the ${limit}-word limit (${count}): ${sentence}`,
    );
  }
}

function schemaDescriptions(value: unknown, path = 'parameters'): Array<[string, string]> {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const found: Array<[string, string]> = [];
  if (typeof record.description === 'string') found.push([path, record.description]);
  for (const [key, child] of Object.entries(record)) {
    found.push(...schemaDescriptions(child, `${path}.${key}`));
  }
  return found;
}

const tools = {
  enabled: true,
  file_io_enabled: true,
  shell_enabled: true,
  web_access_enabled: true,
  tool_grants: [],
  web_access_grants_initialized: true,
  tool_history_enabled: true,
  skills_enabled: true,
  whiteboard_enabled: true,
  enabled_skill_ids: ['lc:builtin:lc-tools'],
  allowed_roots: ['c:/workspace', 'd:/outside'],
  dir_permissions: {},
  shell_allowlist: 'cmd,dir,findstr,tasklist',
  max_tool_calls_per_batch: 4,
  max_tool_rounds_per_turn: 32,
  sse_read_timeout_min: 5,
} satisfies NonNullable<Conversation['tools']>;

describe('model-visible structural STE', () => {
  test('checks generated workspace prompt variants', () => {
    const conv = { tools, params: { system_prompt: '' } };
    assertStructuralSte('Windows workspace prompt', buildPromptText(conv, 'c:/Users/name', 'Windows'));
    assertStructuralSte('Linux workspace prompt', buildPromptText(conv, '/home/name', 'Linux'));
    assertStructuralSte('Windows unrestricted shell prompt', buildShellSection(['*******'], true));
    assertStructuralSte('POSIX unrestricted shell prompt', buildShellSection(['*******'], false));
  });

  test('checks all materialized tool and parameter descriptions', () => {
    for (const tool of materialize(BUILTIN_TOOLS)) {
      const label = tool.function.name;
      assertStructuralSte(label, tool.function.description);
      for (const [path, description] of schemaDescriptions(tool.function.parameters)) {
        assertStructuralSte(`${label} ${path}`, description);
      }
    }
  });

  test('checks every dynamic search-provider description', () => {
    const initialTools = useSettings.getState().tools;
    const variants = [
      {
        web_search_provider: 'auto',
        brave_search_api_key: '',
        brave_search_api_key_ref: undefined,
        searxng_base_url: '',
        marginalia_api_key: '',
        marginalia_api_key_ref: undefined,
      },
      { web_search_provider: 'brave', brave_search_api_key: 'bsa-key' },
      { web_search_provider: 'searxng', searxng_base_url: 'http://localhost:8080' },
      { web_search_provider: 'marginalia', marginalia_api_key: 'public' },
    ] as const;

    try {
      for (const variant of variants) {
        useSettings.setState({
          tools: { ...initialTools, ...variant } as typeof initialTools,
        });
        for (const name of ['lc_web_search', 'lc_web_research']) {
          const handler = BUILTIN_TOOLS.find((tool) => tool.name === name);
          assert.ok(handler);
          const description = typeof handler.description === 'function'
            ? handler.description()
            : handler.description;
          assertStructuralSte(`${name} ${variant.web_search_provider}`, description);
        }
      }
    } finally {
      useSettings.setState({ tools: initialTools });
    }
  });

  test('checks catalogs, help results, recovery, warnings, suggestions, and limits', () => {
    for (const catalog of PILOT_GUIDANCE_CATALOGS.values()) {
      assertStructuralSte(`${catalog.tool} purpose`, catalog.purpose);
      assertStructuralSte(`${catalog.tool} essential`, catalog.essential);
      assertStructuralSte(`${catalog.tool} basic`, catalog.basic);
      for (const section of catalog.sections) {
        assertStructuralSte(`${catalog.tool} ${section.title}`, section.guidance);
      }
      for (const [code, message] of Object.entries(catalog.issueMessages ?? {})) {
        assertStructuralSte(`${catalog.tool} ${code} issue`, message);
      }
      for (const [code, recovery] of Object.entries(catalog.recovery)) {
        assertStructuralSte(`${catalog.tool} ${code} remedy`, recovery.remedy);
      }
      for (const [signal, warning] of Object.entries(catalog.signals)) {
        assertStructuralSte(`${catalog.tool} ${signal} warning`, warning);
      }
    }

    for (const entry of TOOL_NAME_ENTRIES) {
      assertStructuralSte(`${entry.name} suggestion purpose`, entry.purpose);
    }
    for (const [mode, message] of Object.entries(TOOL_HELP_MESSAGES)) {
      assertStructuralSte(`lc_tool_help ${mode}`, message);
    }
    for (const [field, message] of Object.entries(TOOL_HELP_INPUT_MESSAGES)) {
      assertStructuralSte(`lc_tool_help ${field}`, message);
    }
    for (const [field, message] of Object.entries(APPLY_PATCH_INPUT_MESSAGES)) {
      assertStructuralSte(`lc_apply_patch ${field}`, message);
    }
    for (const [name, remedy] of Object.entries(INVALID_ARGUMENT_REMEDIES)) {
      assertStructuralSte(`invalid_arguments ${name}`, remedy);
    }
    const oversizedResult = toolResultTooLargeIssue('lc_stat', 4_194_305, 4_194_304);
    assertStructuralSte('result_too_large issue', oversizedResult.message);
    assert.equal(
      oversizedResult.remedy,
      'Narrow the request or split the work into several calls.',
    );
    assertStructuralSte('result_too_large remedy', oversizedResult.remedy ?? '');
    for (const [code, message] of Object.entries(READ_FILE_ISSUE_MESSAGES)) {
      assertStructuralSte(`lc_read_file ${code} issue`, message);
    }
    for (const [name, warning] of Object.entries(READ_IMAGE_WARNINGS)) {
      assertStructuralSte(`lc_read_image ${name} warning`, warning);
    }
    assertStructuralSte('lc_get_current_time tz limit', CURRENT_TIME_TZ_LIMIT_MESSAGE);
    assertStructuralSte('lc_get_current_time invalid tz warning', invalidTimezoneWarning('Europe/Brussels'));
    assertStructuralSte('tool batch limit issue', formatToolBatchLimitMessage(17, 16));
    for (const [label, result] of [
      ['diagnostic', validateApprovedPatchPreflight(['D:/work/a.txt'], {
        plan_id: '',
        affected_paths: ['D:/work/a.txt'],
        actions: [],
        diagnostics: ['The patch hunk is invalid.'],
      })],
      ['changed targets', validateApprovedPatchPreflight(['D:/work/a.txt'], {
        plan_id: 'plan',
        affected_paths: ['D:/work/b.txt'],
        actions: [],
        diagnostics: [],
      })],
      ['missing plan', validateApprovedPatchPreflight(['D:/work/a.txt'], {
        plan_id: '',
        affected_paths: ['D:/work/a.txt'],
        actions: [],
        diagnostics: [],
      })],
    ] as const) {
      assert.equal(result.ok, false);
      if (!result.ok) assertStructuralSte(`apply_patch preflight ${label}`, result.message);
    }
    for (const reason of ['aborted', 'generation_ended', 'timeout'] as const) {
      const recovered = JSON.parse(interruptedToolResultContent(reason, 'lc_write_file')) as {
        issues: Array<{ message: string }>;
      };
      assertStructuralSte(`interrupted ${reason} tool result`, recovered.issues[0]?.message ?? '');
    }
    assertStructuralSte('restarted tool result', restartedToolResultMessage('lc_write_file'));
    assertStructuralSte('lc_read_image sub-agent system prompt', READ_IMAGE_SYSTEM_PROMPT);
    assertStructuralSte('lc_read_pdf map system prompt', PDF_SUMMARY_SYSTEM_PROMPT);
    assertStructuralSte('lc_read_pdf reduce system prompt', PDF_REDUCE_SYSTEM_PROMPT);
    assertStructuralSte('lc_read_pdf rendered page header', pageHeader({
      page: 1,
      chars: 0,
      provenance: 'none',
      image_rendered: true,
      render_reason: 'no text layer',
      tables_md: ['| Value |'],
    }));
    assertStructuralSte('lc_read_pdf missing page image header', pageHeader({
      page: 2,
      chars: 10,
      provenance: 'text_layer',
      image_rendered: false,
      render_reason: null,
      planned_render_reason: 'large figure',
      render_skipped: 'image limit reached',
    }));
    assertStructuralSte('lc_web_research synthesis guidance', WEB_RESEARCH_SYNTHESIS_GUIDANCE);
    assertStructuralSte('lc_web_research system prompt', WEB_RESEARCH_SYSTEM_PROMPT);
    assertStructuralSte('lc_skill id limit', SKILL_ID_LIMIT_MESSAGE);
    assertStructuralSte('lc_skill list limit', skillListLimitMessage(101));
    assertStructuralSte('lc_skill result limit', SKILL_RESULT_TOO_LARGE_MESSAGE);
    assertStructuralSte('lc_skill unavailable', SKILL_UNAVAILABLE_MESSAGE);
    assertStructuralSte(
      'lc_run_shell Windows builtin issue',
      normalizeThrownToolError({
        code: 'WindowsBuiltinRequiresCmd',
        message: { builtin: 'rmdir' },
      }).issue.message,
    );
    const resultNotices = {
      repeatedToolCall: repeatedToolCallNotice('lc_read_file', 2),
      duplicateToolCallId: duplicateToolCallIdNotice('call-1', 'same_batch'),
      reusedToolCallId: duplicateToolCallIdNotice('call-2', 'earlier_round'),
      contendedRead: contendedReadNotice(['D:/work/a.txt']),
      ...LC_RESULT_NOTICES,
    };
    for (const [name, notice] of Object.entries(resultNotices)) {
      assertStructuralSte(`LC result notice ${name}`, notice);
    }
    assertStructuralSte(
      'lc_read_pdf exact-text warning',
      readPdfNativeText('src-tauri/src/tools/pdf/summary.rs', 'utf8').match(/const SUMMARY_WARNING: &str = "([^"]+)";/)?.[1] ?? '',
    );
    const invalidSelections = [
      ['pages', '1,'.repeat(201)],
      ['force_render', '1,'.repeat(201)],
      ['pages', '1,,2'],
      ['force_render', '1,,2'],
      ['pages', 'auto'],
      ['force_render', 'auto'],
      ['pages', '0'],
      ['force_render', '0'],
      ['pages', '1000001'],
      ['force_render', '1000001'],
      ['pages', '1-2001'],
      ['force_render', '1-2001'],
    ] as const;
    for (const [field, value] of invalidSelections) {
      const result = parsePageRange(value, field);
      assert.equal(result.kind, 'invalid');
      if (result.kind === 'invalid') {
        assertStructuralSte(`lc_read_pdf ${field} selection issue`, result.message);
      }
    }
    assertStructuralSte('lc_ask_user mixed batch issue', ASK_USER_BATCH_ISSUE.message);
    assertStructuralSte('lc_ask_user mixed batch remedy', ASK_USER_BATCH_ISSUE.remedy);
    for (const [name, issue] of Object.entries(ASK_USER_ISSUES)) {
      assertStructuralSte(`lc_ask_user ${name} issue`, issue.message);
      assertStructuralSte(`lc_ask_user ${name} remedy`, issue.remedy);
    }
    for (const [name, message] of Object.entries(ASK_USER_UI_TEXT)) {
      assertStructuralSte(`lc_ask_user ${name} UI`, message);
    }

    const exposed = new Set(['lc_read_file', 'lc_read_pdf', 'lc_grep', 'lc_tool_help']);
    const samples = [
      buildToolHelpData({ tool: 'lc_read_file' }, exposed),
      buildToolHelpData({ tool: 'lc_grep', query: 'encoding' }, exposed),
      buildToolHelpData({ tool: 'lc_read_pdf', query: 'no-such-topic' }, exposed),
      buildToolHelpData({ tool: 'lc_read' }, exposed),
      buildToolHelpData({ tool: 'lc_write_file' }, exposed),
    ];
    for (const [index, sample] of samples.entries()) {
      if (sample.guidance) assertStructuralSte(`help sample ${index} guidance`, sample.guidance);
      for (const match of sample.matches ?? []) {
        assertStructuralSte(`help sample ${index} ${match.section}`, match.guidance);
      }
      if (sample.message) assertStructuralSte(`help sample ${index} message`, sample.message);
      for (const suggestion of sample.suggestions ?? []) {
        assertStructuralSte(`help sample ${index} suggestion`, suggestion.purpose);
      }
    }

    const unknown = unknownOperationalToolIssue('lc_red_flie', exposed);
    assertStructuralSte('unknown operational tool', unknown.message);
    for (const suggestion of unknown.suggestions ?? []) {
      assertStructuralSte('unknown operational suggestion', suggestion.purpose);
    }

    const skill = getBuiltinSkill('lc:builtin:lc-tools');
    assert.ok(skill);
    const liveSkill = materializeSkillForExposure(skill, [...TOOL_NAME_ENTRIES.map((entry) => entry.name)]);
    assertStructuralSte('lc:builtin:lc-tools', liveSkill.content);
  });

  test('checks todo validation, projection, and UI text', () => {
    const invalidSamples = [
      { todos: [] },
      { todos: Array.from({ length: 21 }, (_, index) => ({ id: index + 1, title: 'Task', status: 'not-started' })) },
      { todos: [{ id: 1.5, title: 'Fractional ID', status: 'not-started' }] },
      { todos: [{ id: 1, title: 'First', status: 'not-started' }, { id: 1, title: 'Second', status: 'not-started' }] },
      { todos: [{ id: 1, title: 'Blocked', status: 'blocked' }] },
      { todos: [{ id: 0, title: 'Invalid ID', status: 'not-started' }] },
      { todos: [{ id: Number.MAX_SAFE_INTEGER + 1, title: 'Unsafe ID', status: 'not-started' }] },
      { todos: [{ id: 1, title: '', status: 'not-started' }] },
      { todos: [{ id: 1, title: 'x'.repeat(121), status: 'not-started' }] },
      { todos: [{ id: 1, title: 'Task', status: 'not-started', note: '' }] },
      { todos: [{ id: 1, title: 'Task', status: 'not-started', note: 'x'.repeat(241) }] },
      { todos: [{ id: 1, title: 'Done', status: 'completed', completion_evidence: '\u200b' }] },
      { todos: [{ id: 1, title: 'Done', status: 'completed', completion_evidence: 'x'.repeat(241) }] },
    ];
    const issueMessages = new Set<string>();
    for (const sample of invalidSamples) {
      const parsed = TODO_WRITE_SCHEMA.safeParse(sample);
      assert.equal(parsed.success, false);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) issueMessages.add(issue.message);
      }
    }
    assert.equal(issueMessages.size, 13, 'every LC-authored to-do validation message must be exercised');
    for (const [index, message] of [...issueMessages].entries()) {
      assertStructuralSte(`lc_todo_write validation ${index}`, message);
    }
    for (const [name, message] of Object.entries(TODO_PROJECTION_TEXT)) {
      assertStructuralSte(`lc_todo_write projection ${name}`, message);
    }
    assertStructuralSte('lc_todo_write omitted note warning', todoOmittedNotesNotice(3));
    assertStructuralSte('lc_todo_write omitted active note warning', todoOmittedInProgressNotesNotice(3));
    assertStructuralSte('lc_todo_write single completion warning', completionEvidenceWarning([1]) ?? '');
    assertStructuralSte('lc_todo_write multiple completion warning', completionEvidenceWarning([1, 2]) ?? '');
    assertStructuralSte(
      'lc_todo_write maximum completion warning',
      completionEvidenceWarning(Array.from({ length: 20 }, (_, index) => index + 1)) ?? '',
    );
    for (const [name, message] of Object.entries(TODO_UI_TEXT)) {
      assertStructuralSte(`lc_todo_write UI ${name}`, message);
    }
  });

  test('checks ask-user validation messages', () => {
    const invalidSamples = [
      { questions: [] },
      { questions: Array.from({ length: 4 }, (_, index) => ({
        id: index + 1,
        question: `Question ${index + 1}?`,
        choices: [{ title: 'A' }, { title: 'B' }],
      })) },
      { questions: [{ id: 1.5, question: 'Choose.', choices: [{ title: 'A' }, { title: 'B' }] }] },
      { questions: [{ id: 0, question: 'Choose.', choices: [{ title: 'A' }, { title: 'B' }] }] },
      { questions: [{ id: Number.MAX_SAFE_INTEGER + 1, question: 'Choose.', choices: [{ title: 'A' }, { title: 'B' }] }] },
      { questions: [{ id: 1, question: '', choices: [{ title: 'A' }, { title: 'B' }] }] },
      { questions: [{ id: 1, question: 'x'.repeat(241), choices: [{ title: 'A' }, { title: 'B' }] }] },
      { questions: [{ id: 1, question: 'Choose.', choices: [{ title: 'A' }] }] },
      { questions: [{ id: 1, question: 'Choose.', choices: Array.from({ length: 6 }, (_, index) => ({ title: `Choice ${index}` })) }] },
      { questions: [{ id: 1, question: 'Choose.', choices: [{ title: '' }, { title: 'B' }] }] },
      { questions: [{ id: 1, question: 'Choose.', choices: [{ title: 'x'.repeat(81) }, { title: 'B' }] }] },
      { questions: [{ id: 1, question: 'Choose.', choices: [{ title: 'A', description: '' }, { title: 'B' }] }] },
      { questions: [{ id: 1, question: 'Choose.', choices: [{ title: 'A', description: 'x'.repeat(161) }, { title: 'B' }] }] },
      { questions: [{ id: 1, question: 'Choose.', choices: [{ title: 'A' }, { title: ' A ' }] }] },
      {
        questions: [
          { id: 1, question: 'First?', choices: [{ title: 'A' }, { title: 'B' }] },
          { id: 1, question: 'Second?', choices: [{ title: 'C' }, { title: 'D' }] },
        ],
      },
    ];
    const issueMessages = new Set<string>();
    for (const sample of invalidSamples) {
      const parsed = ASK_USER_INPUT_SCHEMA.safeParse(sample);
      assert.equal(parsed.success, false);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) issueMessages.add(issue.message);
      }
    }
    assert.equal(issueMessages.size, 15, 'every LC-authored ask-user validation message must be exercised');
    for (const [index, message] of [...issueMessages].entries()) {
      assertStructuralSte(`lc_ask_user validation ${index}`, message);
    }
  });

  test('checks remediation-owned edit and search validation messages', () => {
    const cases = [
      { tool: 'lc_edit_file', input: {} },
      {
        tool: 'lc_edit_file',
        input: {
          path: 'D:/flat.txt',
          old_string: 'old',
          new_string: 'new',
          files: [{ path: 'D:/batch.txt', old_string: 'old', new_string: 'new' }],
        },
      },
      { tool: 'lc_web_search', input: { query: '   ' } },
      { tool: 'lc_web_research', input: { query: '   ' } },
    ];

    for (const probe of cases) {
      const handler = BUILTIN_TOOLS.find((candidate) => candidate.name === probe.tool);
      assert.ok(handler, probe.tool);
      const parsed = handler.input.safeParse(probe.input);
      assert.equal(parsed.success, false, probe.tool);
      if (parsed.success) continue;
      for (const [index, issue] of parsed.error.issues.entries()) {
        assertStructuralSte(`${probe.tool} validation ${index}`, issue.message);
      }
    }
  });

  test('checks LC-authored schema boundary and conditional messages', () => {
    const path = 'D:/work/file.txt';
    const search = { path: 'D:/work', pattern: 'x' };
    const edit = { path, old_string: 'a', new_string: 'b' };
    const write = { path, content: 'x' };
    const probes = [
      ['lc_read_file', { paths: [] }],
      ['lc_read_file', { paths: Array(101).fill(path), start_line: 0, end_line: 0, max_bytes: 33_554_433 }],
      ['lc_read_file', { paths: [path], start_line: 4_294_967_296, end_line: 4_294_967_296 }],
      ['lc_read_image', { paths: [] }],
      ['lc_read_image', { paths: Array(21).fill(path), max_bytes: 52_428_801, downscale: 0.01 }],
      ['lc_read_image', { paths: [path], downscale: 1.1 }],
      ['lc_read_pdf', { paths: [], max_bytes: 104_857_601 }],
      ['lc_apply_patch', { patch: '' }],
      ['lc_apply_patch', { patch: 'x'.repeat(1_048_577) }],
      ['lc_write_file', { files: [] }],
      ['lc_write_file', { files: Array(101).fill(write) }],
      ['lc_list_dir', { paths: [] }],
      ['lc_list_dir', { paths: Array(101).fill('D:/work'), max_entries: 10_001 }],
      ['lc_stat', { paths: [] }],
      ['lc_stat', { paths: Array(101).fill(path) }],
      ['lc_grep', { searches: [] }],
      ['lc_grep', { searches: Array(101).fill(search), max_results: 5_001, context_lines: 11, max_matches_per_file: 5_001 }],
      ['lc_grep', { searches: [search], context_lines: 1, output_mode: 'count' }],
      ['lc_edit_file', { files: [] }],
      ['lc_edit_file', { files: Array(101).fill(edit) }],
      ['lc_glob_files', { pattern: '*', root: 'D:/work', max_results: 5_001 }],
      ['lc_web_fetch', { url: 'https://example.com', max_bytes: 33_554_433, timeout_ms: 30_001 }],
      ['lc_web_search', { query: 'x', max_results: 11 }],
      ['lc_web_research', { query: 'x', max_results: 11, preferred_domains: Array(6).fill('example.com') }],
      ['lc_run_shell', { cmd: 'echo', timeout_ms: 120_001, stdin: '漢'.repeat(349_526) }],
      ['lc_tool_history', { query: 'x'.repeat(SEARCH_MAX_QUERY_CHARACTERS + 1), max_results: 101, max_result_bytes: 524_289 }],
    ] as const;

    const covered = new Set<string>();
    for (const [tool, input] of probes) {
      const handler = BUILTIN_TOOLS.find((candidate) => candidate.name === tool);
      assert.ok(handler, tool);
      const parsed = handler.input.safeParse(input);
      assert.equal(parsed.success, false, tool);
      if (parsed.success) continue;
      covered.add(tool);
      for (const [index, issue] of parsed.error.issues.entries()) {
        assertStructuralSte(`${tool} schema issue ${index}`, issue.message);
      }
    }
    assert.deepEqual([...covered].sort(), [
      'lc_apply_patch',
      'lc_edit_file',
      'lc_glob_files',
      'lc_grep',
      'lc_list_dir',
      'lc_read_file',
      'lc_read_image',
      'lc_read_pdf',
      'lc_run_shell',
      'lc_stat',
      'lc_tool_history',
      'lc_web_fetch',
      'lc_web_research',
      'lc_web_search',
      'lc_write_file',
    ]);

    for (const query of [
      'x'.repeat(SEARCH_MAX_QUERY_CHARACTERS + 1),
      Array.from({ length: SEARCH_MAX_QUERY_TERMS + 1 }, (_, index) => `term${index}`).join(' '),
    ]) {
      assert.throws(
        () => parseSearchQuery(query),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assertStructuralSte('lc_tool_history search issue', error.message);
          return true;
        },
      );
    }
  });

  test('checks every Whiteboard validation, recovery, redaction, package, and UI string', () => {
    const validationMessages = new Set<string>();
    for (const fixture of WHITEBOARD_INVALID_INPUT_FIXTURES) {
      const parsed = WHITEBOARD_INPUT_SCHEMA.safeParse(fixture.input);
      assert.equal(parsed.success, false, fixture.label);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) validationMessages.add(issue.message);
      }
    }
    for (const [index, message] of [...validationMessages].entries()) {
      assertStructuralSte(`lc_whiteboard validation ${index}`, message);
    }

    assertStructuralSte('lc_whiteboard total-miss remedy', WHITEBOARD_TOTAL_MISS_REMEDY);
    assertStructuralSte(
      'lc_tool_history Whiteboard redaction',
      WHITEBOARD_HISTORY_REDACTED_OUTPUT,
    );
    assertStructuralSte(
      'lc_tool_history unresolved-owner redaction',
      UNRESOLVED_HISTORY_REDACTED_OUTPUT,
    );
    assertStructuralSte(
      'lc_whiteboard applied-after-termination warning',
      APPLIED_AFTER_TERMINATION_WARNING,
    );
    for (const [name, message] of Object.entries(WHITEBOARD_TERMINAL_ISSUE_TEXT)) {
      assertStructuralSte(`lc_whiteboard terminal ${name}`, message);
    }

    for (const [name, message] of Object.entries(WHITEBOARD_PACKAGE_ERROR_MESSAGES)) {
      assertStructuralSte(`Whiteboard package ${name}`, message);
    }
    assert.throws(
      () => whiteboardPackageFilename(new Date(Number.NaN)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assertStructuralSte('Whiteboard export date limit', error.message);
        return true;
      },
    );

    for (const [name, message] of Object.entries(WHITEBOARD_UI_TEXT)) {
      assertStructuralSte(`Whiteboard UI ${name}`, message);
    }
    for (const [index, message] of WHITEBOARD_DYNAMIC_UI_TEXT.entries()) {
      assertStructuralSte(`Whiteboard dynamic UI ${index}`, message);
    }
  });

  test('rejects known procedural and label-prefix bypasses', () => {
    for (const verb of ['Shorten', 'Give', 'Reduce', 'Try', 'Drop', 'Combine', 'Correct']) {
      assert.throws(
        () => assertStructuralSte(
          `${verb} probe`,
          `${verb} this input before retrying because the current value exceeds the documented boundary and can make the complete model-visible result too large today.`,
        ),
        /20-word limit/,
      );
    }
    assert.throws(
      () => assertStructuralSte(
        'write probe',
        'Write the converted file back to disk as UTF-8 text before you continue with the remaining migration steps in this operation now.',
      ),
      /20-word limit/,
    );
    assert.throws(
      () => assertStructuralSte(
        'check probe',
        'Check the truncated flag on every result because a truncated response can omit important matches from the remaining files in this search batch today.',
      ),
      /20-word limit/,
    );
    assert.throws(
      () => assertStructuralSte(
        'label probe',
        'Rules: The sandbox rejects every request that targets a directory outside the configured roots and returns a detailed error before any files can be opened by the requested tool in the current session.',
      ),
      /25-word limit/,
    );
    assert.throws(
      () => assertStructuralSte(
        'example probe',
        'Example: The sandbox rejects every request that targets a directory outside the configured roots and returns a detailed error before any files can be opened by the requested tool in the current session.',
      ),
      /25-word limit/,
    );
    assert.doesNotThrow(() => assertStructuralSte(
      'structured values',
      '[Environment]\nOS: Windows\nConfigured file roots: C:\\workspace, D:\\outside\nReasons: "cancelled", "deadline".',
    ));
  });
});

test('checks native edit and text-admission recovery messages', () => {
  const editSource = readPdfNativeText('src-tauri/src/tools/edit.rs', 'utf8');
  const editFunction = editSource.slice(editSource.indexOf('fn diagnose_miss('), editSource.indexOf('#[derive(Debug, Deserialize)]'));
  const literals = (source: string): string[] => [...source.replace(/\/\/[^\r\n]*/g, '').matchAll(/"((?:\\.|[^"\\])*)"/gs)]
    .map((match) => JSON.parse('"' + match[1].replace(/\\\r?\n\s*/g, '') + '"') as string);
  const hints = literals(editFunction);
  assert.equal(hints.length, 4, 'Check every native miss diagnostic.');
  for (const [index, hint] of hints.entries()) assertStructuralSte('native edit hint ' + index, hint);
  const nativeText = readPdfNativeText('src-tauri/src/tools/fs_ops.rs', 'utf8');
  for (const variant of ['Binary', 'NotUtf8']) {
    const branch = new RegExp('NotText::' + variant + ' => concat!\\(([\\s\\S]*?)\\),').exec(nativeText);
    assert.ok(branch, variant);
    const fragments = literals(branch[1]);
    assert.ok(fragments.length > 0);
    assertStructuralSte('native text admission ' + variant, fragments.join(''));
  }
});

test('edit descriptions disclose the native match-location cap', () => {
  const definition = materialize(BUILTIN_TOOLS).find((tool) => tool.function.name === 'lc_edit_file');
  assert.ok(definition);
  assert.match(definition.function.description, /match_lines identifies at most 20 matching locations\./);
});
