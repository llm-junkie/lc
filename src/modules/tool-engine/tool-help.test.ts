import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admitToolCallsById,
  executeToolCall,
  validateToolCalls,
  type ValidatedCall,
} from './runner.ts';
import { HANDLERS_BY_NAME } from './registry.ts';
import {
  buildToolHelpData,
  buildToolHelpEnvelope,
  TOOL_HELP_MAX_OUTPUT_BYTES,
  type ToolHelpInput,
} from './tool-help.ts';
import {
  createToolHelpGovernorState,
  governToolHelpCalls,
  TOOL_HELP_GUIDANCE_LIMIT,
  TOOL_HELP_LOOKUP_LIMIT,
  TOOL_HELP_TOTAL_LIMIT,
} from './tool-help-governor.ts';
import {
  PILOT_GUIDANCE_CATALOGS,
  TOOL_NAME_ENTRIES,
  type ToolGuidanceCatalog,
} from './tool-guidance.ts';
import {
  OPERATIONAL_TOOL_NAME_MAX_CHARS,
  resolveToolName,
  unknownOperationalToolIssue,
} from './tool-name-resolution.ts';
import type { ToolCallRecord } from './types';
import type { ToolHandlerContext } from './types';
import { buildArchivedToolStub } from '../chat-pipeline/message-history.ts';
import { readFile } from './builtin/read_file.ts';
import { grep } from './builtin/grep.ts';
import { readPdf } from './builtin/read_pdf.ts';
import { addCatalogRecovery } from './tool-guidance.ts';
import { WHITEBOARD_GUIDANCE } from './tool-guidance.ts';
import {
  WHITEBOARD_ISSUE_FIXTURES,
  WHITEBOARD_MODEL_VISIBLE_TEXT_FIXTURE,
} from '../../whiteboard/contract-fixtures.ts';

const exposed = new Set([
  'lc_read_file',
  'lc_read_pdf',
  'lc_grep',
  'lc_write_file',
  'lc_tool_help',
]);

function call(index: number, input: ToolHelpInput): ValidatedCall {
  const record: ToolCallRecord = {
    id: `help-${index}`,
    name: 'lc_tool_help',
    arguments: JSON.stringify(input),
    created_at: index,
  };
  return { call: record, parsed: input };
}

function dataOf(result: ReturnType<typeof buildToolHelpEnvelope>) {
  assert.equal(result.status, 'ok');
  assert.ok(result.data);
  return result.data;
}

describe('lc_tool_help contract', () => {
  test('uses the frozen Whiteboard description and recovery remedies', () => {
    assert.equal(WHITEBOARD_GUIDANCE.essential, WHITEBOARD_MODEL_VISIBLE_TEXT_FIXTURE.description);
    for (const [code, fixture] of Object.entries(WHITEBOARD_ISSUE_FIXTURES)) {
      assert.equal(WHITEBOARD_GUIDANCE.issueMessages?.[code], fixture.message, code);
      assert.equal(WHITEBOARD_GUIDANCE.recovery[code]?.remedy, fixture.remedy, code);
    }
  });

  test('returns bounded basic help without absent optional fields', () => {
    const envelope = buildToolHelpEnvelope({ tool: 'lc_read_file' }, exposed);
    const data = dataOf(envelope);
    assert.equal(data.mode, 'basic');
    assert.equal(data.resolved_tool, 'lc_read_file');
    assert.ok(data.guidance);
    assert.ok(data.available_keywords && data.available_keywords.length <= 12);
    assert.equal(JSON.stringify(envelope).includes(':null'), false);
    assert.equal('status' in data, false);
    assert.equal('revision' in data, false);
    assert.ok(new TextEncoder().encode(JSON.stringify(envelope)).byteLength <= TOOL_HELP_MAX_OUTPUT_BYTES);
  });

  test('searches only one resolved catalog with deterministic ranking', () => {
    const first = dataOf(buildToolHelpEnvelope({ tool: 'lc_grep', query: 'encoding u_fffd' }, exposed));
    const second = dataOf(buildToolHelpEnvelope({ tool: 'lc_grep', query: '  ENCODING   U-FFFD ' }, exposed));
    assert.deepEqual(first, second);
    assert.equal(first.mode, 'matched');
    assert.ok(first.matches && first.matches.length <= 3);
    assert.equal(first.matches?.[0].section, 'Encoding and replacement characters');
    assert.equal(JSON.stringify(first).includes('PDF'), false);
  });

  test('returns no_match without guidance for an unknown query or staged catalog', () => {
    const unknownQuery = dataOf(buildToolHelpEnvelope({ tool: 'lc_read_pdf', query: 'zzzxxyy' }, exposed));
    assert.equal(unknownQuery.mode, 'no_match');
    assert.equal('guidance' in unknownQuery, false);
    assert.equal('matches' in unknownQuery, false);

    const staged = dataOf(buildToolHelpEnvelope({ tool: 'lc_write_file' }, exposed));
    assert.equal(staged.mode, 'no_match');
    assert.match(staged.message ?? '', /pilot/);
  });

  test('corrects only confident help names and discloses the correction', () => {
    const normalized = dataOf(buildToolHelpEnvelope({ tool: 'Read File' }, exposed));
    assert.equal(normalized.resolved_tool, 'lc_read_file');
    assert.equal(normalized.correction, 'normalized');

    const alias = dataOf(buildToolHelpEnvelope({ tool: 'content search' }, exposed));
    assert.equal(alias.resolved_tool, 'lc_grep');
    assert.equal(alias.correction, 'alias');

    const typo = dataOf(buildToolHelpEnvelope({ tool: 'lc_red_file' }, exposed));
    assert.equal(typo.resolved_tool, 'lc_read_file');
    assert.equal(typo.correction, 'unique_typo_match');

    const ambiguous = dataOf(buildToolHelpEnvelope({ tool: 'lc_read' }, exposed));
    assert.equal(ambiguous.mode, 'ambiguous');
    assert.ok(ambiguous.suggestions && ambiguous.suggestions.length <= 3);
    assert.equal('guidance' in ambiguous, false);
  });

  test('resolves every canonical name and curated alias against the complete registry', () => {
    const allNames = new Set(TOOL_NAME_ENTRIES.map((entry) => entry.name));
    assert.deepEqual(allNames, new Set(HANDLERS_BY_NAME.keys()));
    for (const entry of TOOL_NAME_ENTRIES) {
      const exact = resolveToolName(entry.name, allNames);
      assert.ok(exact.kind === 'resolved');
      assert.equal(exact.resolved, entry.name);
      assert.equal(exact.correction, undefined);
      for (const alias of entry.aliases) {
        const resolved = resolveToolName(alias, allNames);
        assert.ok(resolved.kind === 'resolved', `${alias} must resolve`);
        assert.equal(resolved.resolved, entry.name);
        assert.ok(resolved.correction === 'alias' || resolved.correction === 'normalized');
      }
    }
  });

  test('does not expose detailed guidance for an unexposed tool', () => {
    const data = dataOf(buildToolHelpEnvelope(
      { tool: 'lc_read_file', query: 'encoding' },
      new Set(['lc_grep', 'lc_tool_help']),
    ));
    assert.equal(data.mode, 'not_exposed');
    assert.equal(data.resolved_tool, 'lc_read_file');
    assert.equal('guidance' in data, false);
    assert.equal('matches' in data, false);
    assert.equal('available_keywords' in data, false);
  });

  test('gates Whiteboard help by exposure and resolves its name without execution', () => {
    const hidden = dataOf(buildToolHelpEnvelope(
      { tool: 'whiteboard', query: 'turn versions' },
      exposed,
    ));
    assert.equal(hidden.mode, 'not_exposed');
    assert.equal(hidden.resolved_tool, 'lc_whiteboard');
    assert.equal('guidance' in hidden, false);

    const visible = dataOf(buildToolHelpEnvelope(
      { tool: 'whiteboard', query: 'turn versions' },
      new Set([...exposed, 'lc_whiteboard']),
    ));
    assert.equal(visible.mode, 'matched');
    assert.equal(visible.resolved_tool, 'lc_whiteboard');
    assert.equal(visible.correction, 'normalized');
    assert.equal(visible.matches?.[0]?.section, 'Turn versions');
  });

  test('rejects input bounds and unknown properties without a retryable replay', () => {
    const inputs = [
      { tool: '' },
      { tool: 'x'.repeat(81) },
      { tool: 'lc_grep', query: ` ${'x'.repeat(161)} ` },
      { tool: 'lc_grep', query: 'one two three four five six seven eight nine' },
      { tool: 'lc_grep', extra: true },
    ];
    for (let index = 0; index < inputs.length; index += 1) {
      const [validated] = validateToolCalls([{
        id: `invalid-${index}`,
        name: 'lc_tool_help',
        arguments: JSON.stringify(inputs[index]),
        created_at: index,
      }], HANDLERS_BY_NAME, exposed);
      assert.equal(validated.error?.[0].code, 'invalid_arguments');
      assert.equal(validated.error?.[0].retryable, false);
    }

    const [blankQuery] = validateToolCalls([{
      id: 'blank-query',
      name: 'lc_tool_help',
      arguments: JSON.stringify({ tool: 'lc_grep', query: '   ' }),
      created_at: 1,
    }], HANDLERS_BY_NAME, exposed);
    assert.equal(blankQuery.error, undefined);
  });

  test('keeps every catalog recovery help query resolvable', () => {
    for (const catalog of PILOT_GUIDANCE_CATALOGS.values()) {
      for (const recovery of Object.values(catalog.recovery)) {
        if (!recovery.helpQuery) continue;
        const result = buildToolHelpData(
          { tool: catalog.tool, query: recovery.helpQuery },
          new Set([...exposed, catalog.tool]),
        );
        assert.equal(result.mode, 'matched', `${catalog.tool}: ${recovery.helpQuery}`);
      }
    }
  });
});

describe('tool help governor', () => {
  test('admits duplicates in batch order and returns no repeated guidance', () => {
    const state = createToolHelpGovernorState();
    const calls = [
      call(1, { tool: 'lc_read_file', query: 'encoding' }),
      call(2, { tool: 'Read-File', query: '  ENCODING  ' }),
    ];
    const results = governToolHelpCalls(calls, exposed, state);
    assert.equal(results.get(calls[0].call)?.data?.mode, 'matched');
    const duplicate = results.get(calls[1].call)?.data;
    assert.equal(duplicate?.mode, 'already_returned');
    assert.equal('guidance' in (duplicate ?? {}), false);
    assert.equal('matches' in (duplicate ?? {}), false);
    assert.equal(state.total, 2);
    assert.equal(state.guidance, 1);
  });

  test('enforces total, guidance, and unresolved limits with saturation', () => {
    const totalState = createToolHelpGovernorState();
    const totalCalls = Array.from({ length: TOOL_HELP_TOTAL_LIMIT + 2 }, (_value, index) =>
      call(index, { tool: 'lc_grep', query: `zzzx-${index}` }));
    const totalResults = governToolHelpCalls(totalCalls, exposed, totalState);
    assert.equal(totalResults.get(totalCalls[TOOL_HELP_TOTAL_LIMIT].call)?.data?.mode, 'limit_reached');
    assert.equal(totalResults.get(totalCalls[TOOL_HELP_TOTAL_LIMIT + 1].call)?.data?.mode, 'limit_reached');
    assert.equal(totalState.total, TOOL_HELP_TOTAL_LIMIT);

    const guidanceState = createToolHelpGovernorState();
    const guidanceCalls = [
      call(20, { tool: 'lc_read_file' }),
      call(21, { tool: 'lc_grep' }),
      call(22, { tool: 'lc_read_pdf' }),
      call(23, { tool: 'lc_grep', query: 'regex' }),
    ];
    const guidanceResults = governToolHelpCalls(guidanceCalls, exposed, guidanceState);
    assert.equal(guidanceState.guidance, TOOL_HELP_GUIDANCE_LIMIT);
    const guidanceLimit = guidanceResults.get(guidanceCalls[3].call)?.data;
    assert.equal(guidanceLimit?.mode, 'limit_reached');
    assert.equal('guidance' in (guidanceLimit ?? {}), false);
    assert.equal('matches' in (guidanceLimit ?? {}), false);

    const lookupState = createToolHelpGovernorState();
    const lookupCalls = [
      call(30, { tool: 'lc_read_file', query: 'zzzxxyy' }),
      call(31, { tool: 'lc_grep', query: 'qqqvvv' }),
      call(32, { tool: 'lc_read' }),
    ];
    const lookupResults = governToolHelpCalls(lookupCalls, exposed, lookupState);
    assert.equal(lookupState.unresolved, TOOL_HELP_LOOKUP_LIMIT);
    const lookupLimit = lookupResults.get(lookupCalls[2].call)?.data;
    assert.equal(lookupLimit?.mode, 'limit_reached');
    assert.ok((lookupLimit?.suggestions?.length ?? 0) <= 3);
  });

  test('counts schema-invalid attempts only against the total limit', () => {
    const state = createToolHelpGovernorState();
    const invalid = Array.from({ length: TOOL_HELP_TOTAL_LIMIT }, (_value, index): ValidatedCall => ({
      call: call(40 + index, { tool: '' }).call,
      error: [{ code: 'invalid_arguments', message: 'invalid', retryable: false }],
    }));
    governToolHelpCalls(invalid, exposed, state);
    const final = call(50, { tool: 'lc_grep' });
    const result = governToolHelpCalls([final], exposed, state).get(final.call)?.data;
    assert.equal(result?.mode, 'limit_reached');
    assert.equal(state.total, TOOL_HELP_TOTAL_LIMIT);
    assert.equal(state.guidance, 0);
    assert.equal(state.unresolved, 0);
  });

  test('does not charge a help call whose replayed id is pruned', () => {
    const state = createToolHelpGovernorState();
    const first = call(60, { tool: 'lc_read_file' });
    governToolHelpCalls([first], exposed, state);
    assert.equal(state.total, 1);
    assert.equal(state.guidance, 1);

    const replayBase = call(61, { tool: 'lc_grep' });
    const replay: ValidatedCall = {
      ...replayBase,
      call: { ...replayBase.call, id: first.call.id },
    };
    const admission = admitToolCallsById([replay.call], new Set([first.call.id]));
    const surviving = [replay].filter((_entry, index) => !admission.prunedIndices.has(index));
    const results = governToolHelpCalls(surviving, exposed, state);

    assert.equal(surviving.length, 0);
    assert.equal(results.size, 0);
    assert.equal(state.total, 1);
    assert.equal(state.guidance, 1);
  });

  test('preserves rank when the highest match exceeds the byte bound', () => {
    const catalogs = PILOT_GUIDANCE_CATALOGS as Map<string, ToolGuidanceCatalog>;
    const original = catalogs.get('lc_grep');
    assert.ok(original);
    catalogs.set('lc_grep', {
      ...original,
      sections: [
        {
          title: 'Oversized first match',
          aliases: ['bounded probe'],
          guidance: 'x'.repeat(TOOL_HELP_MAX_OUTPUT_BYTES),
        },
        {
          title: 'Smaller lower-ranked match',
          aliases: ['bounded probe'],
          guidance: 'lower-ranked guidance',
        },
      ],
      keywords: ['bounded probe'],
    });

    try {
      const data = buildToolHelpData({ tool: 'lc_grep', query: 'bounded probe' }, exposed);
      assert.equal(data.mode, 'no_match');
      assert.equal('matches' in data, false);
      assert.match(data.message ?? '', /No help section matched/);

      const state = createToolHelpGovernorState();
      const governed = call(62, { tool: 'lc_grep', query: 'bounded probe' });
      const result = governToolHelpCalls([governed], exposed, state).get(governed.call)?.data;
      assert.equal(result?.mode, 'no_match');
      assert.equal(state.guidance, 0);
      assert.equal(state.unresolved, 1);
    } finally {
      catalogs.set('lc_grep', original);
    }
  });
});

describe('operational tool-name recovery', () => {
  test('returns bounded suggestions without resolving an operational call', () => {
    const resolution = resolveToolName('lc_read', exposed);
    assert.equal(resolution.kind, 'ambiguous');
    const issue = unknownOperationalToolIssue('lc_red_flie', exposed);
    assert.equal(issue.code, 'unknown_tool');
    assert.equal(issue.retryable, false);
    assert.ok(issue.suggestions && issue.suggestions.length <= 3);
    assert.equal('suggested_call' in issue, false);
    assert.ok(issue.suggestions?.every((item) => item.tool && item.purpose));
  });

  test('does not dispatch a corrected mutating tool name', () => {
    let runs = 0;
    const writeHandler = HANDLERS_BY_NAME.get('lc_write_file');
    assert.ok(writeHandler);
    const instrumented = new Map(HANDLERS_BY_NAME);
    instrumented.set('lc_write_file', {
      ...writeHandler,
      run: async () => {
        runs += 1;
        return { results: [] };
      },
    });
    const [validated] = validateToolCalls([{
      id: 'misspelled-write',
      name: 'lc_wirte_file',
      arguments: JSON.stringify({
        files: [{ path: 'D:/repo/changed.txt', content: 'changed' }],
      }),
      created_at: 1,
    }], instrumented, exposed);

    if (validated.parsed !== undefined) {
      throw new Error('a corrected mutating name reached dispatch');
    }
    assert.equal(validated.error?.[0].code, 'unknown_tool');
    assert.equal(runs, 0);
  });

  test('bounds an untrusted operational tool name before recovery ranking', () => {
    const issue = unknownOperationalToolIssue(
      '界'.repeat(OPERATIONAL_TOOL_NAME_MAX_CHARS * 1_000),
      exposed,
    );
    assert.equal(issue.code, 'unknown_tool');
    assert.match(issue.message, /tool name truncated at 80 characters/);
    assert.ok(new TextEncoder().encode(issue.message).byteLength <= 16 * 1024);
    assert.ok((issue.suggestions?.length ?? 0) <= 3);
  });

  test('returns exact numeric corrections and catalog-owned recovery', () => {
    const [validated] = validateToolCalls([{
      id: 'grep-limit',
      name: 'lc_grep',
      arguments: JSON.stringify({
        searches: [{ path: 'D:/repo', pattern: 'x' }],
        max_results: 5_001,
      }),
      created_at: 1,
    }], HANDLERS_BY_NAME, exposed);
    const issue = validated.error?.[0];
    assert.equal(issue?.code, 'invalid_arguments');
    assert.equal(issue?.retryable, false);
    assert.deepEqual(issue?.suggested_call, {
      searches: [{ path: 'D:/repo', pattern: 'x' }],
      max_results: 5_000,
    });
    assert.ok(issue?.remedy);
    assert.equal(issue?.help, undefined);

    const terminal = addCatalogRecovery('lc_read_file', {
      code: 'encoding_not_utf8',
      message: 'The content is not valid UTF-8.',
      retryable: false,
    });
    assert.match(terminal.remedy ?? '', /LC has no conversion tool/);
    assert.equal(terminal.help, undefined);
  });

  test('maps PDF selection failures to field-specific remedies and help calls', async () => {
    const context = {
      sandbox: {},
      config: { exposedToolNames: [...exposed] },
      signal: new AbortController().signal,
      identity: { groupId: 'g', operationId: 'o', modelToolCallId: 'pdf', conversationId: 'c' },
    } as unknown as ToolHandlerContext;
    const cases = [
      {
        input: { paths: ['D:/doc.pdf'], pages: 'auto' },
        code: 'invalid_page_selection',
        remedy: 'Omit pages to read every page. Otherwise, use one-based pages such as "1-5,12".',
        help: { tool: 'lc_read_pdf', query: 'page ranges' },
      },
      ...['auto', 'never'].map((force_render) => ({
        input: { paths: ['D:/doc.pdf'], force_render },
        code: 'invalid_render_selection',
        remedy: 'Omit force_render to force no extra pages. Otherwise, use one-based pages such as "1-5,12".',
        help: { tool: 'lc_read_pdf', query: 'force render' },
      })),
      {
        input: { paths: ['D:/doc.pdf'], summarize: false, depth: 'full' },
        code: 'invalid_arguments',
        remedy: 'Correct the named PDF field and submit a new call.',
        help: { tool: 'lc_read_pdf', query: 'summary-free reads' },
      },
    ];
    for (const sample of cases) {
      const result = await executeToolCall(
        { id: 'pdf', name: 'lc_read_pdf', arguments: '{}', created_at: 1 },
        sample.input,
        readPdf,
        context,
      );
      const envelope = JSON.parse(result.output) as { issues: Array<Record<string, unknown>> };
      assert.equal(envelope.issues[0].code, sample.code);
      assert.equal(envelope.issues[0].retryable, false);
      assert.equal(envelope.issues[0].remedy, sample.remedy);
      assert.deepEqual(envelope.issues[0].help, sample.help);
    }

    const generic = addCatalogRecovery('lc_read_pdf', {
      code: 'invalid_arguments',
      message: 'depth has an invalid value.',
      retryable: false,
    });
    assert.equal(generic.remedy, 'Correct the named PDF field and submit a new call.');
    assert.deepEqual(generic.help, { tool: 'lc_read_pdf', query: 'summary-free reads' });
  });

  test('maps a native encoding failure to terminal catalog recovery', async () => {
    const context = {
      sandbox: {
        readFile: async () => ({
          results: [{
            path: 'D:/repo/legacy.txt', content: '', total_lines: 0,
            size_bytes: 0, truncated: false, error_code: 'encoding_not_utf8',
            error: 'native diagnostic',
          }],
        }),
      },
      config: { allowedRoots: ['D:/repo'], exposedToolNames: [...exposed] },
      signal: new AbortController().signal,
      identity: { groupId: 'g', operationId: 'o', modelToolCallId: 'read', conversationId: 'c' },
    } as unknown as ToolHandlerContext;
    const result = await executeToolCall(
      { id: 'read', name: 'lc_read_file', arguments: '{}', created_at: 1 },
      { paths: ['D:/repo/legacy.txt'] },
      readFile,
      context,
    );
    const envelope = JSON.parse(result.output) as Record<string, unknown> & {
      issues: Array<Record<string, unknown>>;
    };
    assert.equal(envelope.status, 'error');
    assert.equal('data' in envelope, false);
    assert.deepEqual(envelope.issues[0], {
      code: 'encoding_not_utf8',
      message: 'The content is not valid UTF-8. LC returns no content for this file.',
      path: 'D:/repo/legacy.txt',
      retryable: false,
      remedy: 'LC has no conversion tool. Ask the user to convert the file to UTF-8.',
    });
  });

  test('maps a native grep code without parsing its message', async () => {
    const context = {
      sandbox: {
        grep: async () => ({
          results: [{
            path: 'D:/repo', pattern: '[', matches: [], truncated: false,
            error_code: 'invalid_regex', error: 'regex engine diagnostic',
            visited_entries: 0, files_selected: 0, bytes_read: 0,
            skipped_large: 0, skipped_binary: 0, skipped_symlink: 0,
            skipped_unreadable: 0, files_transcoded: 0,
          }],
        }),
      },
      config: { allowedRoots: ['D:/repo'], maxShellTimeoutMs: 30_000 },
      signal: new AbortController().signal,
      identity: { groupId: 'g', operationId: 'o', modelToolCallId: 'grep', conversationId: 'c' },
    } as unknown as ToolHandlerContext;
    const result = await executeToolCall(
      { id: 'grep', name: 'lc_grep', arguments: '{}', created_at: 1 },
      { searches: [{ path: 'D:/repo', pattern: '[' }] },
      grep,
      context,
    );
    const envelope = JSON.parse(result.output) as { issues: Array<Record<string, unknown>> };
    assert.deepEqual(envelope.issues[0], {
      code: 'invalid_regex',
      message: 'regex engine diagnostic',
      path: 'D:/repo',
      retryable: false,
      remedy: 'Correct the regular expression and submit a new call.',
      help: { tool: 'lc_grep', query: 'regex' },
    });
  });

  test('keeps recovery on only the failed path in a partial read batch', async () => {
    const context = {
      sandbox: {
        readFile: async () => ({
          results: [
            {
              path: 'D:/repo/good.txt', content: 'good', total_lines: 1,
              size_bytes: 4, truncated: false, sha256: 'abc', encoding: 'utf-8',
            },
            {
              path: 'D:/repo/legacy.txt', content: '', total_lines: 0,
              size_bytes: 0, truncated: false, error_code: 'encoding_not_utf8',
              error: 'native diagnostic',
            },
          ],
        }),
      },
      config: { allowedRoots: ['D:/repo'] },
      signal: new AbortController().signal,
      identity: { groupId: 'g', operationId: 'o', modelToolCallId: 'read-2', conversationId: 'c' },
    } as unknown as ToolHandlerContext;
    const result = await executeToolCall(
      { id: 'read-2', name: 'lc_read_file', arguments: '{}', created_at: 1 },
      { paths: ['D:/repo/good.txt', 'D:/repo/legacy.txt'] },
      readFile,
      context,
    );
    const envelope = JSON.parse(result.output) as {
      status: string;
      data: { results: unknown[] };
      issues: Array<Record<string, unknown>>;
    };
    assert.equal(envelope.status, 'partial');
    assert.equal(envelope.data.results.length, 2);
    assert.equal(envelope.issues.length, 1);
    assert.equal(envelope.issues[0].path, 'D:/repo/legacy.txt');
  });
});

describe('triggered pilot safety guidance', () => {
  const context = (sandbox: unknown) => ({
    sandbox,
    config: { allowedRoots: ['D:/repo'], maxShellTimeoutMs: 30_000 },
    signal: new AbortController().signal,
    identity: { groupId: 'g', operationId: 'o', modelToolCallId: 'c', conversationId: 'conv' },
  }) as unknown as ToolHandlerContext;

  test('warns on every read result that contains U+FFFD', async () => {
    const result = await readFile.run(
      { paths: ['D:/repo/a.txt'] },
      context({
        readFile: async () => ({
          results: [{
            path: 'D:/repo/a.txt', content: 'bad\uFFFDtext', total_lines: 1,
            size_bytes: 8, truncated: false, sha256: 'abc', encoding: 'utf-8',
          }],
        }),
      }),
    );
    assert.ok('results' in result);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /Do not write this text back automatically/);
  });

  test('warns on grep truncation and replacement characters', async () => {
    const result = await grep.run(
      { searches: [{ path: 'D:/repo', pattern: 'x' }] },
      context({
        grep: async () => ({
          results: [{
            path: 'D:/repo', pattern: 'x',
            matches: [{
              file: 'D:/repo/a.txt', line: 1, content: 'x\uFFFD',
              before: [], after: [],
            }],
            truncated: true, truncated_reason: 'results', error: undefined,
            visited_entries: 1, files_selected: 1, bytes_read: 5,
            skipped_large: 0, skipped_binary: 0, skipped_symlink: 0,
            skipped_unreadable: 0, files_transcoded: 0,
          }],
        }),
      }),
    );
    assert.ok('results' in result);
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings.join('\n'), /result is incomplete/);
    assert.match(result.warnings.join('\n'), /contains U\+FFFD/);
  });

  test('warns when grep completeness is not determined', async () => {
    const result = await grep.run(
      { searches: [{ path: 'D:/repo', pattern: 'x' }] },
      context({
        grep: async () => ({
          results: [{
            path: 'D:/repo', pattern: 'x', matches: [],
            truncated: null, truncated_reason: 'results', error: undefined,
            visited_entries: 2, files_selected: 2, bytes_read: 5,
            skipped_large: 0, skipped_binary: 0, skipped_symlink: 0,
            skipped_unreadable: 0, files_transcoded: 0,
          }],
        }),
      }),
    );
    assert.ok('results' in result);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /could not determine completeness/i);
  });
});

describe('tool help history stubbing', () => {
  test('uses the normal generic archive stub', () => {
    const stub = buildArchivedToolStub(1, 'message-1', ['lc_tool_help']);
    assert.match(stub, /1 tool result\(s\)/);
    assert.match(stub, /message_id="message-1"/);
    assert.match(stub, /Tools called: lc_tool_help\./);
    assert.doesNotMatch(stub, /guidance|keyword|encoding/i);
  });
});
