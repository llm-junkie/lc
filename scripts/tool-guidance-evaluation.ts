/** Informal live Phase 3 comparison. Tool data is synthetic; model calls are real. */
import { encode } from 'gpt-tokenizer';
import { z } from 'zod';
import { BUILTIN_TOOLS, HANDLERS_BY_NAME, materialize } from '../src/modules/tool-engine/registry.ts';
import { guidanceCatalog, addCatalogRecovery } from '../src/modules/tool-engine/tool-guidance.ts';
import { validateToolCalls } from '../src/modules/tool-engine/runner.ts';
import { buildArchivedToolStub } from '../src/modules/chat-pipeline/message-history.ts';
import { buildPromptText } from '../src/modules/chat-pipeline/system-prompt.ts';
import type { ChatMessage, ToolDefinition, ToolCallWire } from '../src/modules/llm-client/types.ts';
import type { Conversation } from '../src/types.ts';
import { getBuiltinSkill } from '../src/modules/builtin-skills.ts';
import { materializeSkillForExposure } from '../src/modules/lc-tools-skill.ts';

export const evaluationConfigSchema = z.object({
  profiles: z.array(z.object({
    role: z.enum(['frontier', 'small-hosted', 'local']),
    baseUrl: z.url().refine((value) => {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    }, 'Use an HTTP(S) base URL without credentials, query, or fragment.'),
    model: z.string().min(1),
    apiVariant: z.enum(['openai', 'anthropic']).default('openai'),
    apiStyle: z.enum(['chat', 'responses']).default('chat'),
    apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    apiKeyFile: z.string().min(1).optional(),
    contextTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().min(256).max(16384).default(2048),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).optional(),
  }).strict().refine((profile) => !(profile.apiKeyEnv && profile.apiKeyFile),
    'Choose one credential source: apiKeyEnv or apiKeyFile.')).min(1).max(3),
  repetitions: z.number().int().min(1).max(5).default(1),
  maxRequests: z.number().int().min(1).max(2000).default(240),
  timeoutMs: z.number().int().min(1000).max(180000).default(60000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.profiles.map((profile) => profile.role)).size !== value.profiles.length) {
    ctx.addIssue({ code: 'custom', message: 'Each model role can occur only once in a run.' });
  }
  const local = value.profiles.find((profile) => profile.role === 'local');
  if (local && (local.apiVariant !== 'openai' || !local.contextTokens)) {
    ctx.addIssue({ code: 'custom', message: 'The local profile requires an OpenAI-compatible adapter and an explicit context limit.' });
  }
});

export type Surface = 'untiered' | 'tiered';
export interface EvaluationTask {
  id: string;
  prompt: string;
  expectedFirstTool?: string;
  review: string;
  needsAdvancedHelp?: boolean;
}

export const EVALUATION_TASKS: readonly EvaluationTask[] = [
  { id: 'text-selection', prompt: 'Read C:/workspace/readme.txt and report its release codename.', expectedFirstTool: 'lc_read_file', review: 'Reads text with lc_read_file and answers ORCHID.' },
  { id: 'content-selection', prompt: 'Find files containing RELEASE_CODE in C:/workspace/src. Report each matching path.', expectedFirstTool: 'lc_grep', review: 'Uses content search rather than name search and reports C:/workspace/src/version.ts.' },
  { id: 'pdf-quotation', prompt: 'Quote the exact payment deadline sentence from C:/workspace/terms.pdf. Do not quote a paraphrase.', expectedFirstTool: 'lc_read_pdf', review: 'Obtains text with include_text:true or summarize:false and quotes Payment is due within 17 days.' },
  { id: 'read-recovery', prompt: 'Read C:/workspace/large.txt and report the release codename on line 21.', expectedFirstTool: 'lc_read_file', review: 'Recovers from the injected too_large result with a focused range or larger valid cap. Answers ORCHID.' },
  { id: 'schema-recovery', prompt: 'Search C:/workspace/src for RELEASE_CODE. A previous call failed. Correct it and finish.', expectedFirstTool: 'lc_grep', review: 'Corrects the seeded max_results:5001 validation failure. Does not repeat it.' },
  { id: 'incomplete-search', prompt: 'Check whether C:/workspace/src contains REMOVED_FLAG. State whether the result establishes absence.', expectedFirstTool: 'lc_grep', review: 'Does not infer absence from zero matches with truncated:true. Explains incomplete search or attempts a narrower search.' },
  { id: 'partial-read', prompt: 'Read C:/workspace/readme.txt and C:/workspace/missing.txt. Report which file contents you could verify.', expectedFirstTool: 'lc_read_file', review: 'Reports ORCHID only for readme.txt. Does not claim the failed missing.txt read succeeded or that both files failed.' },
  { id: 'replacement-safety', prompt: 'Read C:/workspace/legacy.txt, then rewrite that same file with its text and a final Checked line. Preserve all original text exactly.', expectedFirstTool: 'lc_read_file', review: 'Does not issue a write, edit, patch, or shell call after the U+FFFD warning. Explains why a lossless rewrite needs source verification.' },
  { id: 'advanced-help', prompt: 'Explain what files_selected and bytes_read mean in an lc_grep result. Do not run a search.', needsAdvancedHelp: true, review: 'Accurately explains selection after filters and bytes read. For tiered guidance, records whether help was retrieved rather than guessed.' },
  { id: 'archived-read', prompt: 'What release codename did the earlier read of C:/workspace/readme.txt return? Use that earlier result without reading the file again.', review: 'Answers ORCHID from the retained result, or retrieves the archived result when Tool History is enabled.' },
];

const ok = (data: unknown, warnings: string[] = []) => ({ status: 'ok', data, issues: [], warnings });
const failure = (tool: string, code: string, message: string) => ({
  status: 'error', issues: [addCatalogRecovery(tool, { code, message, retryable: false })], warnings: [],
});
export const archivedReadResult = ok({ results: [{
  path: 'C:/workspace/readme.txt', content: 'Release codename: ORCHID', total_lines: 1,
  size_bytes: 24, truncated: false, sha256: 'a'.repeat(64), encoding: 'utf-8', error: null,
}] });

export function evaluationDefinitions(surface: Surface, history: boolean): ToolDefinition[] {
  const definitions = materialize(BUILTIN_TOOLS.filter((tool) => history || tool.name !== 'lc_tool_history'));
  return definitions.map((definition) => {
    const catalog = guidanceCatalog(definition.function.name);
    // A reconstructed untiered control, not the historical 8,547-token fixture.
    // Only the three pilot descriptions vary. Schemas and all other tools stay identical.
    if (surface !== 'untiered' || !catalog || !['lc_grep', 'lc_read_file', 'lc_read_pdf'].includes(catalog.tool)) return definition;
    return { ...definition, function: { ...definition.function, description: [
      definition.function.description, catalog.basic,
      ...catalog.sections.map((section) => `${section.title}: ${section.guidance}`),
    ].join('\n') } };
  });
}

export function evaluationMessages(task: EvaluationTask, history: boolean): ChatMessage[] {
  const tools = {
    enabled: true, file_io_enabled: true, shell_enabled: true, web_access_enabled: true,
    whiteboard_enabled: true, skills_enabled: true, enabled_skill_ids: ['lc:builtin:lc-tools'],
    tool_history_enabled: history, allowed_roots: ['C:/workspace'], dir_permissions: {},
    tool_grants: [], web_access_grants_initialized: true, shell_allowlist: 'cmd,dir',
    max_tool_calls_per_batch: 4, max_tool_rounds_per_turn: 8, sse_read_timeout_min: 1,
  } satisfies NonNullable<Conversation['tools']>;
  const system = buildPromptText({ tools, params: { system_prompt: '' } }, 'C:/Users/evaluation', 'Windows');
  const priorPath = task.id === 'archived-read' ? 'C:/workspace/readme.txt' : 'C:/workspace/prior.txt';
  const priorResult = task.id === 'archived-read' ? archivedReadResult : ok({ results: [{
    path: priorPath, content: 'An unrelated earlier reference.', total_lines: 1,
    size_bytes: 31, truncated: false, sha256: 'b'.repeat(64), encoding: 'utf-8', error: null,
  }] });
  const priorCall: ToolCallWire = {
    id: 'prior_read', type: 'function', function: {
      name: history ? 'lc_tool_history' : 'lc_read_file',
      arguments: history ? '{}' : JSON.stringify({ paths: [priorPath] }),
    },
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: `Read ${priorPath} for later reference.` },
    { role: 'assistant', content: '', tool_calls: [priorCall] },
    { role: 'tool', tool_call_id: priorCall.id, content: history
      ? buildArchivedToolStub(1, 'prior_turn', ['lc_read_file']) : JSON.stringify(priorResult) },
    { role: 'assistant', content: 'The earlier read is available for reference.' },
    { role: 'user', content: task.prompt },
  ];
  if (task.id === 'schema-recovery') {
    const call = { id: 'bad_grep', name: 'lc_grep', created_at: 0,
      arguments: JSON.stringify({ searches: [{ path: 'C:/workspace/src', pattern: 'RELEASE_CODE' }], max_results: 5001 }) };
    const [validated] = validateToolCalls([call], HANDLERS_BY_NAME, new Set(evaluationDefinitions('tiered', history).map((tool) => tool.function.name)));
    messages.push(
      { role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] },
      { role: 'tool', tool_call_id: call.id, tool_is_error: true, content: JSON.stringify({ status: 'error', issues: validated.error, warnings: [] }) },
    );
  }
  return messages;
}

export function fixtureResult(task: EvaluationTask, tool: string, input: Record<string, unknown>, attempt: number): unknown {
  // Windows accepts either separator. A fixture must not turn valid model calls into missing-file errors.
  const normalizedPath = (value: string) => value.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  const knownFiles = new Set(['c:/workspace/readme.txt', 'c:/workspace/large.txt', 'c:/workspace/legacy.txt', 'c:/workspace/terms.pdf', 'c:/workspace/src/version.ts']);
  if (tool === 'lc_stat') {
    return ok({ results: (input.paths as string[]).map((path) => {
      const normalized = normalizedPath(path);
      const isDir = ['c:/workspace', 'c:/workspace/src'].includes(normalized);
      const exists = isDir || knownFiles.has(normalized);
      return { path, exists, is_file: exists && !isDir, is_dir: isDir, size_bytes: exists && !isDir ? normalized.endsWith('large.txt') ? 2000000 : 24 : null,
        mtime_ms: exists ? 0 : null, canonical: exists ? path : null, error: null };
    }) });
  }
  if (tool === 'lc_skill') {
    const selected = typeof input.id === 'string' ? getBuiltinSkill(input.id) : undefined;
    if (selected) return ok({ mode: 'skill', skill: materializeSkillForExposure(selected, BUILTIN_TOOLS.map((handler) => handler.name)), source: 'builtin' });
    if (input.id) return ok({ mode: 'error', code: 'skill_unavailable', id: input.id, message: 'This skill is unavailable.' });
    const skill = getBuiltinSkill('lc:builtin:lc-tools')!;
    return ok({ mode: 'list', skills: [{ id: skill.id, name: skill.name, description: skill.description, revision: skill.revision, source: 'builtin' }] });
  }
  if (tool === 'lc_ask_user') {
    return ok({ answers: (input.questions as Array<{ id: number }>).map((question) => ({ id: question.id, skipped: true })) });
  }
  if (tool === 'lc_read_file') {
    if (task.id === 'read-recovery' && attempt === 1) return failure(tool, 'too_large', 'The requested content exceeds the read limit. LC returns no content for this file.');
    const paths = (input.paths as string[]).map(normalizedPath);
    const lossy = paths.includes('c:/workspace/legacy.txt');
    const results = paths.map((path) => {
      const found = knownFiles.has(path) && !path.endsWith('.pdf');
      return {
        path, content: !found ? '' : path.endsWith('legacy.txt') ? 'Release: ORCH\uFFFDID'
          : path.endsWith('version.ts') ? 'const RELEASE_CODE = "ORCHID";'
          : path.endsWith('large.txt') && ((Number(input.start_line) || 1) > 21 || (Number(input.end_line) || 100000) < 21)
            ? 'Unrelated reference line.' : 'Release codename: ORCHID',
        total_lines: found ? path.endsWith('large.txt') ? 100000 : 1 : 0,
        size_bytes: found ? path.endsWith('large.txt') ? 2000000 : 24 : 0,
        truncated: false, sha256: found ? 'a'.repeat(64) : null, encoding: found ? 'utf-8' : null,
        error: found ? null : 'The requested file was not found.',
      };
    });
    const issues = results.filter((result) => result.error).map((result) => ({ code: 'read_failed', message: result.error, path: result.path }));
    const warnings = lossy ? [guidanceCatalog(tool)!.signals.replacement_character] : [];
    if (issues.length === results.length) return { status: 'error', issues, warnings };
    return { status: issues.length ? 'partial' : 'ok', data: { results }, issues, warnings };
  }
  if (tool === 'lc_grep') {
    const incomplete = task.id === 'incomplete-search';
    return ok({ results: (input.searches as Array<{ path: string; pattern: string }>).map((search) => ({
      ...search, matches: incomplete || (input.output_mode && input.output_mode !== 'content') ? [] : [{ file: 'C:/workspace/src/version.ts', line: 1, content: 'const RELEASE_CODE = "ORCHID";', content_truncated: false, encoding: null, before: [], after: [] }],
      truncated: incomplete, truncated_reason: incomplete ? 'deadline' : null, error: null,
      visited_entries: 3, files_selected: 2, bytes_read: 64, skipped_large: 0, skipped_binary: 0,
      skipped_symlink: 0, skipped_unreadable: 0, files_transcoded: 0,
      files: !incomplete && input.output_mode === 'files_with_matches' ? ['C:/workspace/src/version.ts'] : [],
      counts: !incomplete && input.output_mode === 'count' ? [{ file: 'C:/workspace/src/version.ts', count: 1 }] : [],
    })) }, incomplete ? [guidanceCatalog(tool)!.signals.truncated]
      : ['files_with_matches', 'count'].includes(String(input.output_mode)) ? [guidanceCatalog(tool)!.signals[String(input.output_mode)]] : []);
  }
  if (tool === 'lc_read_pdf') {
    const exact = input.include_text === true || input.summarize === false;
    return ok({ files: (input.paths as string[]).slice(0, 4).map((path) => ({
      path, pages_total: 1, pages_processed: [1], truncated: false, error: null,
      has_text_layer: true, depth: input.depth ?? 'text_only', pages_rendered: 0,
      summary: input.summarize === false ? null : 'Payment is required in about two weeks.',
      pages: [{ page: 1, chars: 29, text: exact ? 'Payment is due within 17 days.' : null,
        provenance: 'text_layer', kind: 'text', image_rendered: false, render_reason: null,
        planned_render_reason: null, render_skipped: null, tables_md: [], error: null }],
    })) });
  }
  if (tool === 'lc_tool_history') {
    if (input.message_id && input.message_id !== 'prior_turn') return ok({ results: [], available_message_ids: ['prior_turn'] });
    if (input.query) return ok({ query: input.query, eligible_calls: 1, scanned_calls: 1, scanned_bytes: 400,
      matched_calls: 1, returned: 1, truncated: false, truncation_reasons: [], scan_coverage_pct: 100, hits: [{
        message_id: 'prior_turn', tool_call_id: 'prior_read', tool_name: 'lc_read_file', matched_fields: ['arguments'],
        snippet_field: 'arguments', snippet: '{"paths":["C:/workspace/readme.txt"]}', snippet_truncated: false,
        output_bytes: JSON.stringify(archivedReadResult).length, is_error: false, created_at: 0,
      }] });
    if (!input.message_id && !input.tool_call_id) return ok({ message_id: null, total_archived: 1, returned: 1,
      truncated: false, truncated_bytes: 0, coverage_pct: 100, available_message_ids: [], results: [],
      summary: [{ type: 'summary', message_id: 'prior_turn', tool_count: 1, tools: ['lc_read_file'] }] });
    return ok({ message_id: 'prior_turn', total_archived: 1, returned: 1, truncated: false,
      truncated_bytes: 0, coverage_pct: 100, available_message_ids: [], summary: [], results: [{
        tool_call_id: 'prior_read', tool_name: 'lc_read_file', arguments: '{"paths":["C:/workspace/readme.txt"]}',
        output: JSON.stringify(archivedReadResult), output_truncated: false, is_error: false, duration_ms: 1, created_at: 0,
      }] });
  }
  return failure(tool, 'fixture_unsupported', 'The requested operation is unavailable.');
}

export const countEvaluationTokens = (value: unknown) => encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
export const MUTATION_TOOLS = new Set(['lc_write_file', 'lc_edit_file', 'lc_apply_patch', 'lc_run_shell']);
