import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WHITEBOARD_CONSTRAINED_MODEL_FIXTURES,
  WHITEBOARD_ISSUE_FIXTURES,
  WHITEBOARD_MAX_BYTES as FIXTURE_MAX_BYTES,
  WHITEBOARD_MODEL_VISIBLE_TEXT_FIXTURE,
  WHITEBOARD_MUTATION_OUTPUT_FIXTURE,
  WHITEBOARD_READ_OUTPUT_FIXTURE,
  WHITEBOARD_TURN_REFS_FIXTURE,
  WHITEBOARD_INVALID_INPUT_FIXTURES,
  WHITEBOARD_VALID_INPUT_FIXTURES,
} from '../../whiteboard/contract-fixtures.ts';
import { normalizeOptionalAbsence } from './argument-normalization.ts';
import { utf8ByteLength } from './utf8-budget.ts';
import { HANDLERS_BY_NAME } from './registry.ts';
import { admitToolCallsById, validateToolCalls } from './runner.ts';
import {
  governWhiteboardCalls,
  type WhiteboardGovernableCall,
} from './whiteboard-governor.ts';
import {
  applyExactWhiteboardEdit,
  diagnoseWhiteboardEditNotFound,
  WHITEBOARD_DIAGNOSTIC_ITEM_MAX_BYTES,
  WHITEBOARD_INPUT_SCHEMA,
  WHITEBOARD_ISSUES,
  WHITEBOARD_MAX_BYTES,
  whiteboard,
  type WhiteboardInput,
} from './whiteboard.ts';
import type {
  ToolCallRecord,
  ToolHandlerContext,
  WhiteboardToolService,
  WhiteboardToolServiceErrorCode,
} from './types';

const REFS = { ...WHITEBOARD_TURN_REFS_FIXTURE };

function governableCall(
  index: number,
  options: {
    name?: string;
    input?: unknown;
    error?: unknown;
    id?: string;
  } = {},
): WhiteboardGovernableCall {
  const input = options.input ?? { action: 'read' };
  const call: ToolCallRecord = {
    created_at: 0,
    id: options.id ?? `whiteboard-governor-${index}`,
    name: options.name ?? 'lc_whiteboard',
    arguments: JSON.stringify(input),
  };
  return options.error === undefined
    ? { call, parsed: input }
    : { call, error: options.error };
}

interface TestIssue {
  code: string;
  remedy?: string;
  suggestions?: string[] | Array<{ tool: string; purpose: string }>;
  occurrence_count?: number;
  excerpts?: string[];
  limit_bytes?: number;
  measured_bytes?: number;
}

function firstIssue(result: { issues: TestIssue[] }): TestIssue {
  assert.equal(result.issues.length, 1);
  return result.issues[0];
}

function createHarness(options: {
  userMarkdown?: string;
  modelMarkdown?: string;
  readFailure?: WhiteboardToolServiceErrorCode;
  writeFailure?: WhiteboardToolServiceErrorCode;
  throwOnRead?: boolean;
  throwOnWrite?: boolean;
  signal?: AbortSignal;
} = {}) {
  let userMarkdown = options.userMarkdown ?? WHITEBOARD_READ_OUTPUT_FIXTURE.user_markdown;
  let modelMarkdown = options.modelMarkdown ?? WHITEBOARD_READ_OUTPUT_FIXTURE.model_markdown;
  let reads = 0;
  let writes = 0;
  let sandboxTouches = 0;
  let lastToolCallId: string | undefined;

  const service: WhiteboardToolService = {
    read: async () => {
      reads += 1;
      if (options.throwOnRead) throw new Error('read failed');
      if (options.readFailure) return { ok: false, code: options.readFailure };
      return {
        ok: true,
        value: { refs: { ...REFS }, userMarkdown, modelMarkdown },
      };
    },
    replaceModel: async ({ content, toolCallId }) => {
      writes += 1;
      lastToolCallId = toolCallId;
      if (options.throwOnWrite) throw new Error('write failed');
      if (options.writeFailure) return { ok: false, code: options.writeFailure };
      const changed = content !== modelMarkdown;
      modelMarkdown = content;
      return {
        ok: true,
        value: { refs: { ...REFS }, changed, modelMarkdown },
      };
    },
  };

  const sandbox = new Proxy({}, {
    get() {
      sandboxTouches += 1;
      throw new Error('lc_whiteboard must not use the sandbox bridge');
    },
  });
  const context = {
    sandbox,
    config: {},
    signal: options.signal ?? new AbortController().signal,
    identity: {
      groupId: 'generation-1',
      operationId: 'whiteboard-operation-1',
      modelToolCallId: 'whiteboard-call-2',
      conversationId: 'conv-whiteboard',
    },
    whiteboard: service,
  } as unknown as ToolHandlerContext;

  return {
    context,
    get reads() { return reads; },
    get writes() { return writes; },
    get sandboxTouches() { return sandboxTouches; },
    get modelMarkdown() { return modelMarkdown; },
    set userMarkdown(value: string) { userMarkdown = value; },
    get lastToolCallId() { return lastToolCallId; },
  };
}

describe('lc_whiteboard schema and model-visible contract', () => {
  it('accepts exactly the frozen flat forms and rejects every frozen invalid form', () => {
    for (const fixture of WHITEBOARD_VALID_INPUT_FIXTURES) {
      assert.equal(WHITEBOARD_INPUT_SCHEMA.safeParse(fixture.input).success, true, fixture.label);
    }
    for (const fixture of WHITEBOARD_INVALID_INPUT_FIXTURES) {
      assert.equal(WHITEBOARD_INPUT_SCHEMA.safeParse(fixture.input).success, false, fixture.label);
    }
  });

  it('emits one flat strict wire schema with the frozen field descriptions', () => {
    const schema = whiteboard.toJsonSchema();
    assert.deepEqual(schema.required, ['action']);
    assert.equal(schema.additionalProperties, false);
    assert.equal('anyOf' in schema, false);
    assert.equal('oneOf' in schema, false);
    assert.equal('allOf' in schema, false);
    for (const [field, description] of Object.entries(
      WHITEBOARD_MODEL_VISIBLE_TEXT_FIXTURE.schemaDescriptions,
    )) {
      const property = schema.properties[field] as { description?: string };
      assert.equal(property.description, description);
    }
    assert.equal(whiteboard.description, WHITEBOARD_MODEL_VISIBLE_TEXT_FIXTURE.description);
    assert.equal(whiteboard.toJsonSchema(), schema, 'the derived JSON schema is cached');
  });

  it('normalizes blank fields by action while preserving meaningful exact strings', () => {
    const schema = whiteboard.toJsonSchema();
    assert.deepEqual(
      normalizeOptionalAbsence(
        { action: 'read', content: '', old_string: '', new_string: '' },
        schema,
        whiteboard.name,
      ),
      { action: 'read' },
    );
    assert.deepEqual(
      normalizeOptionalAbsence(
        { action: 'replace', content: '', old_string: ' ', new_string: '' },
        schema,
        whiteboard.name,
      ),
      { action: 'replace', content: '' },
    );
    assert.deepEqual(
      normalizeOptionalAbsence(
        { action: 'replace', content: ' \n\t' },
        schema,
        whiteboard.name,
      ),
      { action: 'replace', content: ' \n\t' },
    );
    assert.deepEqual(
      normalizeOptionalAbsence(
        { action: 'edit', old_string: '  ', new_string: '' },
        schema,
        whiteboard.name,
      ),
      { action: 'edit', old_string: '  ', new_string: '' },
    );
    assert.deepEqual(
      normalizeOptionalAbsence(
        { action: 'edit', content: ' \t', old_string: 'needle', new_string: '' },
        schema,
        whiteboard.name,
      ),
      { action: 'edit', old_string: 'needle', new_string: '' },
    );
  });

  it('accepts provider-style blank placeholders but rejects nonblank fields from another action', () => {
    const compatibleCalls = [
      {
        arguments: { action: 'read', content: '', old_string: '', new_string: '' },
        expected: { action: 'read' },
      },
      {
        arguments: { action: 'replace', content: '# Notes', old_string: '', new_string: '' },
        expected: { action: 'replace', content: '# Notes' },
      },
      {
        arguments: { action: 'edit', content: '', old_string: 'old', new_string: 'new' },
        expected: { action: 'edit', old_string: 'old', new_string: 'new' },
      },
    ];

    for (const [index, fixture] of compatibleCalls.entries()) {
      const [validated] = validateToolCalls([{
        created_at: 0,
        id: `blank-whiteboard-${index}`,
        name: whiteboard.name,
        arguments: JSON.stringify(fixture.arguments),
      }], new Map([[whiteboard.name, whiteboard]]));
      assert.equal(validated.error, undefined);
      assert.deepEqual(validated.parsed, fixture.expected);
    }

    const [conflicting] = validateToolCalls([{
      created_at: 0,
      id: 'nonblank-whiteboard-conflict',
      name: whiteboard.name,
      arguments: JSON.stringify({ action: 'read', content: 'do not discard me' }),
    }], new Map([[whiteboard.name, whiteboard]]));
    assert.equal(conflicting.parsed, undefined);
    assert.equal(conflicting.error?.[0]?.code, 'invalid_arguments');
  });

  it('pins every stable issue message and retryable value to Phase 0', () => {
    for (const [code, fixture] of Object.entries(WHITEBOARD_ISSUE_FIXTURES)) {
      const issue = WHITEBOARD_ISSUES[code as keyof typeof WHITEBOARD_ISSUES];
      assert.equal(issue.code, code);
      assert.equal(issue.message, fixture.message);
      assert.equal(issue.retryable, fixture.retryable);
    }
  });

  it('returns the frozen invalid_arguments issue through live runner validation', () => {
    for (const [index, fixture] of WHITEBOARD_INVALID_INPUT_FIXTURES.entries()) {
      const parsed = WHITEBOARD_INPUT_SCHEMA.safeParse(fixture.input);
      assert.equal(parsed.success, false, fixture.label);
      if (parsed.success) continue;
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message.trim()}`)
        .reduce((combined, issue) => (
          combined
            ? `${combined}${/[.!?]$/u.test(combined) ? ' ' : '. '}${issue}`
            : issue
        ), '');
      const [validated] = validateToolCalls([{
        id: `invalid-whiteboard-${index}`,
        name: 'lc_whiteboard',
        arguments: JSON.stringify(fixture.input),
        created_at: index,
      }], HANDLERS_BY_NAME);
      assert.equal(validated.parsed, undefined, fixture.label);
      assert.deepEqual(validated.error, [{
        code: 'invalid_arguments',
        message: `${WHITEBOARD_ISSUE_FIXTURES.invalid_arguments.message} Details: Tool arguments failed validation: ${details}`,
        retryable: false,
        remedy: WHITEBOARD_ISSUE_FIXTURES.invalid_arguments.remedy,
      }], fixture.label);
      assert.doesNotMatch(validated.error?.[0]?.message ?? '', /\.\./, fixture.label);
    }
  });

  it('keeps live parse and repair detail beside the stable catalog message', () => {
    const cases = [
      {
        id: 'whiteboard-malformed-json',
        arguments: '{not json',
        detail: /Arguments (?:are not valid JSON|could not be parsed as JSON)/,
      },
      {
        id: 'whiteboard-corrected-json',
        arguments: '{"action":"read"} trailing text',
        detail: /Arguments were malformed and were repaired/,
      },
    ];

    for (const probe of cases) {
      const [validated] = validateToolCalls([{
        created_at: 0,
        id: probe.id,
        name: 'lc_whiteboard',
        arguments: probe.arguments,
      }], new Map([[whiteboard.name, whiteboard]]));
      const issue = validated.error?.[0];
      assert.equal(issue?.code, 'invalid_arguments');
      assert.ok((issue?.message ?? '').startsWith(
        `${WHITEBOARD_ISSUE_FIXTURES.invalid_arguments.message} Details:`,
      ));
      assert.match(issue?.message ?? '', probe.detail);
      assert.equal(issue?.remedy, WHITEBOARD_ISSUE_FIXTURES.invalid_arguments.remedy);
    }
  });
});

describe('lc_whiteboard pure exact-edit diagnostics', () => {
  it('changes one exact occurrence, deletes it, and identifies a no-op', () => {
    assert.deepEqual(applyExactWhiteboardEdit('alpha beta gamma', 'beta', 'BETA'), {
      kind: 'changed',
      content: 'alpha BETA gamma',
    });
    assert.deepEqual(applyExactWhiteboardEdit('alpha beta', ' beta', ''), {
      kind: 'changed',
      content: 'alpha',
    });
    assert.deepEqual(applyExactWhiteboardEdit('same', 'same', 'same'), {
      kind: 'unchanged',
      content: 'same',
    });
  });

  it('treats overlapping occurrences as non-unique and bounds location excerpts', () => {
    const result = applyExactWhiteboardEdit(`aaaa\n${'😀'.repeat(100)}`, 'aa', 'x');
    assert.equal(result.kind, 'not-unique');
    if (result.kind !== 'not-unique') return;
    assert.equal(result.occurrences, 3);
    assert.ok(result.excerpts.length <= 3);
    assert.ok(result.excerpts.every((item) => utf8ByteLength(item) <= WHITEBOARD_DIAGNOSTIC_ITEM_MAX_BYTES));
  });

  it('uses the deterministic trailing, surrounding, then first-line ladder', () => {
    assert.deepEqual(
      diagnoseWhiteboardEditNotFound('alpha  \nbeta\t', 'alpha\nbeta'),
      { suggestions: ['alpha  \nbeta\t'], totalMiss: false },
    );
    assert.deepEqual(
      diagnoseWhiteboardEditNotFound('  alpha\n\tbeta  ', 'alpha\nbeta'),
      { suggestions: ['  alpha\n\tbeta  '], totalMiss: false },
    );
    assert.deepEqual(
      diagnoseWhiteboardEditNotFound('prefix\n  alpha  \nother current', 'alpha\nmissing'),
      { suggestions: ['  alpha  '], totalMiss: false },
    );
    assert.deepEqual(
      diagnoseWhiteboardEditNotFound('model-only text', 'unrelated request'),
      { suggestions: [], totalMiss: true },
    );
  });

  it('keeps maximum-size repeated-line diagnostics bounded and linear', () => {
    const current = ' \n'.repeat(WHITEBOARD_MAX_BYTES / 2);
    const requested = '\t\n'.repeat(WHITEBOARD_MAX_BYTES / 4);
    const started = performance.now();
    const diagnostic = diagnoseWhiteboardEditNotFound(current, requested);
    const elapsed = performance.now() - started;

    assert.ok(diagnostic.suggestions.length <= 3);
    assert.ok(diagnostic.suggestions.every(
      (item) => utf8ByteLength(item) <= WHITEBOARD_DIAGNOSTIC_ITEM_MAX_BYTES,
    ));
    assert.ok(elapsed < 500, `max-size diagnostic took ${elapsed.toFixed(1)} ms`);
  });

  it('rejects an empty pure-helper match instead of treating every offset as a match', () => {
    assert.throws(() => applyExactWhiteboardEdit('content', '', 'x'), /non-empty/);
  });
});

describe('lc_whiteboard handler', () => {
  it('reads the pinned user content and latest model content in the exact public shape', async () => {
    const harness = createHarness();
    const result = await whiteboard.run({ action: 'read' }, harness.context);
    assert.deepEqual(result, {
      status: 'ok',
      data: WHITEBOARD_READ_OUTPUT_FIXTURE,
      issues: [],
      warnings: [],
    });
    assert.equal(harness.reads, 1);
    assert.equal(harness.writes, 0);
    assert.equal(harness.sandboxTouches, 0);
  });

  it('returns invalid_arguments before reading for an invalid direct invocation', async () => {
    const harness = createHarness();
    const invalid = { action: 'read', content: '' } as unknown as WhiteboardInput;
    const result = await whiteboard.run(invalid, harness.context);
    assert.equal(result.status, 'error');
    assert.equal(firstIssue(result).code, 'invalid_arguments');
    assert.equal(harness.reads, 0);
  });

  it('replaces, clears, and preserves whitespace-only Markdown exactly', async () => {
    const harness = createHarness({ modelMarkdown: 'start' });
    const replacement = '# Current model notes\n\nFocused tests passed.';
    const replaced = await whiteboard.run({ action: 'replace', content: replacement }, harness.context);
    assert.deepEqual(replaced.data, {
      ...WHITEBOARD_MUTATION_OUTPUT_FIXTURE,
      refs: REFS,
      model_bytes: utf8ByteLength(replacement),
    });
    assert.equal(harness.modelMarkdown, replacement);
    assert.equal(harness.lastToolCallId, 'whiteboard-call-2');

    const cleared = await whiteboard.run({ action: 'replace', content: '' }, harness.context);
    assert.deepEqual(cleared.data, { refs: REFS, changed: true, model_bytes: 0 });
    assert.equal(harness.modelMarkdown, '');

    const whitespace = await whiteboard.run({ action: 'replace', content: ' \n\t' }, harness.context);
    assert.deepEqual(whitespace.data, { refs: REFS, changed: true, model_bytes: 3 });
    assert.equal(harness.modelMarkdown, ' \n\t');
    assert.equal(harness.sandboxTouches, 0);
  });

  it('returns a compact no-op result without creating a provisional write', async () => {
    const harness = createHarness({ modelMarkdown: 'same' });
    const replace = await whiteboard.run({ action: 'replace', content: 'same' }, harness.context);
    assert.deepEqual(replace.data, { refs: REFS, changed: false, model_bytes: 4 });
    const edit = await whiteboard.run({
      action: 'edit',
      old_string: 'same',
      new_string: 'same',
    }, harness.context);
    assert.deepEqual(edit.data, { refs: REFS, changed: false, model_bytes: 4 });
    assert.equal(harness.writes, 0);
    assert.equal('model_markdown' in (edit.data ?? {}), false);
  });

  it('supports sequential exact edits, deletion, Unicode, and whitespace-only matches', async () => {
    const harness = createHarness({ modelMarkdown: 'one  😀 two' });
    const first = await whiteboard.run({ action: 'edit', old_string: '  ', new_string: '\t' }, harness.context);
    assert.equal(first.status, 'ok');
    const second = await whiteboard.run({ action: 'edit', old_string: '😀 ', new_string: '' }, harness.context);
    assert.equal(second.status, 'ok');
    assert.equal(harness.modelMarkdown, 'one\ttwo');
    assert.equal(harness.writes, 2);
  });

  it('returns bounded model-only suggestions and the distinct total-miss remedy', async () => {
    const near = createHarness({
      userMarkdown: 'PRIVATE USER BOARD',
      modelMarkdown: '  requested line  \ncurrent second line',
    });
    const nearResult = await whiteboard.run({
      action: 'edit',
      old_string: 'requested line\nstale second line',
      new_string: 'replacement',
    }, near.context);
    const nearIssue = firstIssue(nearResult);
    assert.equal(nearIssue.code, 'whiteboard_old_string_not_found');
    assert.deepEqual(nearIssue.suggestions, ['  requested line  ']);
    assert.doesNotMatch(JSON.stringify(nearIssue), /PRIVATE USER BOARD/);
    assert.equal(near.writes, 0);
    assert.equal(near.sandboxTouches, 0);

    const miss = createHarness({ modelMarkdown: 'nothing related' });
    const missResult = await whiteboard.run({
      action: 'edit',
      old_string: 'absent',
      new_string: 'replacement',
    }, miss.context);
    const missIssue = firstIssue(missResult);
    assert.deepEqual(missIssue.suggestions, []);
    assert.equal(
      missIssue.remedy,
      'The first line of old_string did not match a line in the model board. ' +
        'Call lc_whiteboard with action read before you retry the edit.',
    );
  });

  it('reports bounded occurrence data for a non-unique exact match', async () => {
    const harness = createHarness({ modelMarkdown: 'needle one\nneedle two\nneedle three\nneedle four' });
    const result = await whiteboard.run({
      action: 'edit',
      old_string: 'needle',
      new_string: 'pin',
    }, harness.context);
    const issue = firstIssue(result);
    assert.equal(issue.code, 'whiteboard_old_string_not_unique');
    assert.equal(issue.occurrence_count, 4);
    assert.equal(issue.excerpts?.length, 3);
    assert.ok(issue.excerpts?.every((item) => utf8ByteLength(item) <= 160));
    assert.equal(harness.writes, 0);
  });

  it('accepts exactly 32 KiB, measures Unicode bytes, and rejects overflow without truncation', async () => {
    assert.equal(WHITEBOARD_MAX_BYTES, FIXTURE_MAX_BYTES);
    const exact = '😀'.repeat(WHITEBOARD_MAX_BYTES / 4);
    assert.equal(utf8ByteLength(exact), WHITEBOARD_MAX_BYTES);
    const exactHarness = createHarness({ modelMarkdown: '' });
    const accepted = await whiteboard.run({ action: 'replace', content: exact }, exactHarness.context);
    assert.deepEqual(accepted.data, {
      refs: REFS,
      changed: true,
      model_bytes: WHITEBOARD_MAX_BYTES,
    });
    assert.equal(exactHarness.modelMarkdown, exact);

    const overHarness = createHarness({ modelMarkdown: 'unchanged' });
    const over = `${exact}x`;
    const rejected = await whiteboard.run({ action: 'replace', content: over }, overHarness.context);
    const issue = firstIssue(rejected);
    assert.equal(issue.code, 'whiteboard_too_large');
    assert.equal(issue.limit_bytes, WHITEBOARD_MAX_BYTES);
    assert.equal(issue.measured_bytes, WHITEBOARD_MAX_BYTES + 1);
    assert.equal(overHarness.modelMarkdown, 'unchanged');
    assert.equal(overHarness.writes, 0);
  });

  it('checks the final edited content against the byte limit', async () => {
    const harness = createHarness({ modelMarkdown: 'x' });
    const result = await whiteboard.run({
      action: 'edit',
      old_string: 'x',
      new_string: 'a'.repeat(WHITEBOARD_MAX_BYTES + 1),
    }, harness.context);
    assert.equal(firstIssue(result).code, 'whiteboard_too_large');
    assert.equal(harness.modelMarkdown, 'x');
    assert.equal(harness.writes, 0);
  });

  it('maps typed and thrown service failures to stable catalog-backed issues', async () => {
    for (const code of [
      'whiteboard_not_initialized',
      'whiteboard_version_missing',
      'whiteboard_read_failed',
    ] as const) {
      const harness = createHarness({ readFailure: code });
      const result = await whiteboard.run({ action: 'read' }, harness.context);
      const issue = firstIssue(result);
      assert.equal(issue.code, code);
      assert.equal(issue.remedy, WHITEBOARD_ISSUE_FIXTURES[code].remedy);
    }

    const readThrow = createHarness({ throwOnRead: true });
    assert.equal(
      firstIssue(await whiteboard.run({ action: 'read' }, readThrow.context)).code,
      'whiteboard_read_failed',
    );

    const writeFailure = createHarness({ modelMarkdown: 'old', writeFailure: 'whiteboard_write_failed' });
    assert.equal(
      firstIssue(await whiteboard.run({ action: 'replace', content: 'new' }, writeFailure.context)).code,
      'whiteboard_write_failed',
    );
    const writeThrow = createHarness({ modelMarkdown: 'old', throwOnWrite: true });
    assert.equal(
      firstIssue(await whiteboard.run({ action: 'replace', content: 'new' }, writeThrow.context)).code,
      'whiteboard_write_failed',
    );
  });

  it('fails closed when the capability is absent and aborts before service access', async () => {
    const absent = createHarness();
    const absentContext = { ...absent.context, whiteboard: undefined };
    assert.equal(
      firstIssue(await whiteboard.run({ action: 'read' }, absentContext)).code,
      'whiteboard_not_initialized',
    );

    const controller = new AbortController();
    controller.abort();
    const aborted = createHarness({ signal: controller.signal });
    const result = await whiteboard.run({ action: 'read' }, aborted.context);
    assert.equal(result.status, 'aborted');
    assert.equal(firstIssue(result).code, 'aborted');
    assert.equal(aborted.reads, 0);
    assert.equal(aborted.writes, 0);
  });
});

describe('lc_whiteboard batch governor', () => {
  it('allows one exact call beside unrelated tools and adds no per-turn limit', () => {
    const firstBatch = [
      governableCall(1),
      governableCall(2, { name: 'lc_read_file', input: { files: [{ path: 'notes.md' }] } }),
    ];
    const secondBatch = [governableCall(3, { input: { action: 'replace', content: 'next' } })];

    assert.equal(governWhiteboardCalls(firstBatch).size, 0);
    assert.equal(governWhiteboardCalls(secondBatch).size, 0);
  });

  it('rejects both read-write and two-write pairs', () => {
    const pairs = [
      [
        governableCall(4, { input: { action: 'read' } }),
        governableCall(5, { input: { action: 'replace', content: 'changed' } }),
      ],
      [
        governableCall(6, { input: { action: 'replace', content: 'first' } }),
        governableCall(7, { input: { action: 'edit', old_string: 'first', new_string: 'second' } }),
      ],
    ];

    for (const pair of pairs) {
      const results = governWhiteboardCalls(pair);
      assert.deepEqual([...results.keys()], pair.map((entry) => entry.call));
      assert.ok([...results.values()].every((result) => result.status === 'error'));
    }
  });

  it('rejects every exact-name call before execution and preserves sibling admission', () => {
    const first = governableCall(10, { input: { action: 'read' } });
    const sibling = governableCall(11, { name: 'lc_get_current_time', input: {} });
    const rejectedInput = governableCall(12, {
      input: { action: 'replace' },
      error: [{ code: 'invalid_arguments', message: 'content is required' }],
    });
    const third = governableCall(13, { input: { action: 'replace', content: 'later' } });
    const entries = [first, sibling, rejectedInput, third];

    const results = governWhiteboardCalls(entries);
    assert.deepEqual([...results.keys()], [first.call, rejectedInput.call, third.call]);
    assert.equal(results.has(sibling.call), false);

    let whiteboardExecutions = 0;
    let siblingExecutions = 0;
    for (const entry of entries) {
      if (results.has(entry.call)) continue;
      if (entry.call.name === 'lc_whiteboard') whiteboardExecutions += 1;
      else siblingExecutions += 1;
    }
    assert.equal(whiteboardExecutions, 0);
    assert.equal(siblingExecutions, 1);

    for (const result of results.values()) {
      assert.deepEqual(result, {
        status: 'error',
        issues: [{
          code: 'whiteboard_batch_conflict',
          ...WHITEBOARD_ISSUE_FIXTURES.whiteboard_batch_conflict,
        }],
        warnings: [],
      });
    }
  });

  it('counts only the exact canonical name', () => {
    const entries = [
      governableCall(20),
      governableCall(21, { name: 'LC_WHITEBOARD' }),
      governableCall(22, { name: 'lc_whiteboard ' }),
      governableCall(23, { name: 'whiteboard' }),
    ];

    assert.equal(governWhiteboardCalls(entries).size, 0);
  });

  it('runs after tool-call-id admission so a pruned duplicate has no result slot', () => {
    const first = governableCall(30, { id: 'same-whiteboard-id' });
    const duplicate = governableCall(31, {
      id: 'same-whiteboard-id',
      input: { action: 'replace', content: 'must not run' },
    });
    const entries = [first, duplicate];
    const idAdmission = admitToolCallsById(entries.map((entry) => entry.call), new Set());
    const surviving = entries.filter((_entry, index) => !idAdmission.prunedIndices.has(index));

    assert.deepEqual([...idAdmission.prunedIndices], [1]);
    assert.equal(surviving.length, 1);
    assert.equal(governWhiteboardCalls(surviving).size, 0);
  });
});

describe('frozen representative lc_whiteboard model-use workflows', () => {
  const fixture = (name: string) => {
    const found = WHITEBOARD_CONSTRAINED_MODEL_FIXTURES.find(
      (candidate) => candidate.name === name,
    );
    assert.ok(found, `missing frozen constrained-model fixture: ${name}`);
    return found;
  };

  it('reads, replaces, rereads, edits, and rereads the latest model state', async () => {
    const contract = fixture('read edit reread');
    assert.match(contract.expectedNextAction, /Read, send one exact edit/);
    const harness = createHarness({
      userMarkdown: '# User handoff\n\nKeep the public API stable.',
      modelMarkdown: '# Model handoff\n\nStatus: investigating',
    });

    const initial = await whiteboard.run({ action: 'read' }, harness.context);
    assert.equal(initial.status, 'ok');
    assert.equal(initial.data && 'model_markdown' in initial.data
      ? initial.data.model_markdown
      : undefined, '# Model handoff\n\nStatus: investigating');

    const replacedMarkdown = '# Model handoff\n\nStatus: focused tests passing';
    const replaced = await whiteboard.run({
      action: 'replace',
      content: replacedMarkdown,
    }, harness.context);
    assert.equal(replaced.status, 'ok');
    assert.equal(replaced.data && 'changed' in replaced.data ? replaced.data.changed : false, true);

    const afterReplace = await whiteboard.run({ action: 'read' }, harness.context);
    assert.equal(afterReplace.data && 'model_markdown' in afterReplace.data
      ? afterReplace.data.model_markdown
      : undefined, replacedMarkdown);

    const edited = await whiteboard.run({
      action: 'edit',
      old_string: 'focused tests passing',
      new_string: 'complete repository gates passing',
    }, harness.context);
    assert.equal(edited.status, 'ok');

    const afterEdit = await whiteboard.run({ action: 'read' }, harness.context);
    assert.equal(afterEdit.data && 'model_markdown' in afterEdit.data
      ? afterEdit.data.model_markdown
      : undefined, '# Model handoff\n\nStatus: complete repository gates passing');
    assert.equal(harness.reads, 5);
    assert.equal(harness.writes, 2);
  });

  it('recovers from a rejected multi-call batch with one later call', async () => {
    const contract = fixture('batch conflict recovery');
    const conflicted = [
      governableCall(100, { input: { action: 'read' } }),
      governableCall(101, { input: { action: 'replace', content: '# Must not run' } }),
    ];
    const rejected = governWhiteboardCalls(conflicted);
    assert.equal(rejected.size, 2);
    for (const result of rejected.values()) {
      const issue = firstIssue(result);
      assert.equal(issue.code, 'whiteboard_batch_conflict');
      assert.match(issue.remedy ?? '', /one intended whiteboard call in a later batch/);
      assert.match(contract.expectedNextAction, /one intended lc_whiteboard call/);
    }

    const later = governableCall(102, {
      input: { action: 'replace', content: '# Intended later change' },
    });
    assert.equal(governWhiteboardCalls([later]).size, 0);
    const harness = createHarness({ modelMarkdown: '# Original' });
    const applied = await whiteboard.run(
      { action: 'replace', content: '# Intended later change' },
      harness.context,
    );
    assert.equal(applied.status, 'ok');
    assert.equal(harness.modelMarkdown, '# Intended later change');
    assert.equal(harness.writes, 1);
  });

  it('continues from a committed change after a later provider failure', async () => {
    const contract = fixture('failure continuity');
    assert.match(contract.expectedNextAction, /applied change as retained/);
    const harness = createHarness({ modelMarkdown: '# Before provider failure' });
    const applied = await whiteboard.run({
      action: 'replace',
      content: '# Retained before provider failure',
    }, harness.context);
    assert.equal(applied.status, 'ok');

    // The provider terminal event is outside the tool capability. A later
    // turn receives the already committed storage state and reads before an
    // exact edit, as the frozen recovery fixture requires.
    const laterTurn = createHarness({ modelMarkdown: harness.modelMarkdown });
    const reread = await whiteboard.run({ action: 'read' }, laterTurn.context);
    assert.equal(reread.data && 'model_markdown' in reread.data
      ? reread.data.model_markdown
      : undefined, '# Retained before provider failure');
  });

  it('keeps the current user version pinned while the next turn inherits the saved edit', async () => {
    const contract = fixture('pinned user comprehension');
    assert.match(contract.expectedNextAction, /pinned user version/);
    const currentTurn = createHarness({
      userMarkdown: '# Pinned user board',
      modelMarkdown: '# Initial model board',
    });
    const pendingUserEdit = '# Saved while the current turn runs';

    await whiteboard.run({
      action: 'replace',
      content: '# Latest applied model board',
    }, currentTurn.context);
    const currentRead = await whiteboard.run({ action: 'read' }, currentTurn.context);
    assert.deepEqual(currentRead.data && 'user_markdown' in currentRead.data
      ? {
          user: currentRead.data.user_markdown,
          model: currentRead.data.model_markdown,
        }
      : undefined, {
      user: '# Pinned user board',
      model: '# Latest applied model board',
    });

    const nextTurn = createHarness({
      userMarkdown: pendingUserEdit,
      modelMarkdown: currentTurn.modelMarkdown,
    });
    const nextRead = await whiteboard.run({ action: 'read' }, nextTurn.context);
    assert.equal(nextRead.data && 'user_markdown' in nextRead.data
      ? nextRead.data.user_markdown
      : undefined, pendingUserEdit);
  });
});

it('limits the Whiteboard miss claim when a later requested line exists', async () => {
  const harness = createHarness({ userMarkdown: 'user board', modelMarkdown: 'alpha\nbeta' });
  const result = await whiteboard.run({
    action: 'edit', old_string: 'absent\nbeta', new_string: 'replacement',
  }, harness.context);
  assert.equal(result.status, 'error');
  assert.equal(firstIssue(result).remedy,
    'The first line of old_string did not match a line in the model board. ' +
    'Call lc_whiteboard with action read before you retry the edit.');
  assert.equal(harness.writes, 0);
  assert.equal(harness.modelMarkdown, 'alpha\nbeta');
  const reread = await whiteboard.run({ action: 'read' }, harness.context);
  assert.deepEqual(reread.data, {
    refs: REFS, user_markdown: 'user board', model_markdown: 'alpha\nbeta',
  });
});
