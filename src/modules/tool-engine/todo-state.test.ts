import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '../../types';
import type { ChatMessage } from '../llm-client/types';
import { todoWrite } from './builtin/todo_write.ts';
import { materialize } from './registry.ts';
import { countTokens } from '../../utils/tokens.ts';
import { buildPromptText } from '../chat-pipeline/system-prompt.ts';
import { buildArchivedToolStub } from '../chat-pipeline/message-history.ts';
import { resolveExposure } from './policy.ts';
import {
  decodeStoredToolResultEnvelope,
  LC_RESULT_NOTICES,
  MAX_LEADING_LC_RESULT_NOTICES,
  MAX_STORED_TOOL_RESULT_BYTES,
} from './tool-result-content.ts';
import {
  buildTodoSnapshotIndex,
  formatTodoRequestProjection,
  parseTodoWriteInput,
  resolveTodoRequestProjection,
  TODO_WRITE_SCHEMA,
  type TodoWriteInput,
} from './todo-state.ts';

let sequence = 0;
function message(input: Partial<Message> & Pick<Message, 'role' | 'content'>): Message {
  sequence += 1;
  return {
    id: `message-${sequence}`,
    createdAt: sequence,
    ...input,
  } as Message;
}

function assistantTodo(
  id: string,
  calls: Array<{ id: string; input: unknown }>,
): Message {
  return message({
    id,
    role: 'assistant',
    content: '',
    tool_calls: calls.map((call) => ({
      created_at: 0,
      id: call.id,
      name: 'lc_todo_write',
      arguments: JSON.stringify(call.input),
    })),
  });
}

function result(callId: string, input: TodoWriteInput, prefix = ''): Message {
  const completed = input.todos.filter((todo) => todo.status === 'completed').length;
  const blocked = input.todos.filter((todo) => todo.status === 'blocked').length;
  return message({
    role: 'tool',
    content: prefix + JSON.stringify({
      status: 'ok',
      data: { completed, blocked, total: input.todos.length },
      issues: [],
      warnings: [],
    }),
    tool_call_id: callId,
  });
}

const first: TodoWriteInput = {
  todos: [
    {
      id: 7,
      title: 'Inspect the state',
      status: 'completed',
      completion_evidence: 'Reviewed the current implementation.',
    },
    { id: 42, title: 'Implement the change', status: 'in-progress', note: 'Keep IDs stable.' },
  ],
};

describe('lc_todo_write strict state contract', () => {
  it('accepts stable sparse IDs and returns only counts in the envelope', async () => {
    const parsed = TODO_WRITE_SCHEMA.parse(first);
    const output = await todoWrite.run(parsed, {} as never);
    assert.deepEqual(output, {
      status: 'ok',
      data: { completed: 1, blocked: 0, total: 2 },
      issues: [],
      warnings: [],
    });
    assert.equal(JSON.stringify(output).includes('Inspect the state'), false);
  });

  it('accepts multiple active tasks and rejects other invalid list states', () => {
    assert.equal(TODO_WRITE_SCHEMA.safeParse({ ...first, extra: true }).success, false);
    assert.equal(parseTodoWriteInput({ ...first, extra: null }), undefined);
    assert.equal(TODO_WRITE_SCHEMA.safeParse({
      todos: [{ ...first.todos[0], extra: true }],
    }).success, false);
    assert.equal(parseTodoWriteInput({
      todos: [{ ...first.todos[0], extra: '   ' }],
    }), undefined);
    assert.equal(TODO_WRITE_SCHEMA.safeParse({
      todos: [
        { id: 1, title: 'A', status: 'in-progress' },
        { id: 2, title: 'B', status: 'in-progress' },
      ],
    }).success, true);
    assert.equal(TODO_WRITE_SCHEMA.safeParse({
      todos: [{ id: 1, title: 'Blocked', status: 'blocked' }],
    }).success, false);
    assert.equal(TODO_WRITE_SCHEMA.safeParse({
      todos: [{ id: 1, title: 'Blocked', status: 'blocked', note: 'Reason' }],
    }).success, true);
    assert.equal(TODO_WRITE_SCHEMA.safeParse({
      todos: [{ id: Number.MAX_SAFE_INTEGER + 1, title: 'Unsafe', status: 'not-started' }],
    }).success, false);
    assert.equal(TODO_WRITE_SCHEMA.safeParse({
      todos: [{ id: 1, title: 'Done', status: 'completed', completion_evidence: '\u200b\u2060' }],
    }).success, false);
  });

  it('normalizes optional null and whitespace text values as absent', () => {
    assert.deepEqual(parseTodoWriteInput({
      todos: [{ id: 1, title: '  Keep the title  ', status: 'not-started', note: null }],
    }), {
      todos: [{ id: 1, title: 'Keep the title', status: 'not-started' }],
    });
    assert.deepEqual(parseTodoWriteInput({
      todos: [{
        id: 1,
        title: 'Task',
        status: 'not-started',
        note: '   ',
        completion_evidence: '   ',
      }],
    }), {
      todos: [{ id: 1, title: 'Task', status: 'not-started' }],
    });
  });

  it('warns once when completed tasks omit completion evidence', async () => {
    const parsed = TODO_WRITE_SCHEMA.parse({
      todos: [
        { id: 3, title: 'Done without evidence', status: 'completed' },
        { id: 8, title: 'Done with evidence', status: 'completed', completion_evidence: 'The focused test passed.' },
        { id: 13, title: 'Also done without evidence', status: 'completed' },
        { id: 21, title: 'Still active', status: 'in-progress' },
      ],
    });
    const output = await todoWrite.run(parsed, {} as never);
    assert.deepEqual(output.warnings, [
      'Completed todo IDs 3, 13 have no completion evidence. Add completion_evidence to make these statuses transparent.',
    ]);
  });
});

describe('todo snapshot selection and request projection', () => {
  it('uses declared call order, not result completion order', () => {
    const second: TodoWriteInput = {
      todos: [{ id: 9, title: 'Second list', status: 'in-progress' }],
    };
    const assistant = assistantTodo('assistant-batch', [
      { id: 'call-first', input: first },
      { id: 'call-second', input: second },
    ]);
    const index = buildTodoSnapshotIndex([
      assistant,
      result('call-second', second),
      result('call-first', first),
    ]);
    const snapshot = index.latest;
    assert.equal(snapshot?.toolCallId, 'call-second');
    assert.equal(snapshot?.todos[0].title, 'Second list');
    assert.deepEqual(
      index.turnSnapshotsByAssistantId.get(assistant.id)?.map((item) => item.toolCallId),
      ['call-first', 'call-second'],
    );
  });

  it('builds point-in-time UI state without future snapshot leakage', () => {
    const second: TodoWriteInput = {
      todos: [{ id: 99, title: 'Future list', status: 'not-started' }],
    };
    const firstAssistant = assistantTodo('assistant-point-first', [{ id: 'call-point-first', input: first }]);
    const middle = message({ id: 'assistant-point-middle', role: 'assistant', content: 'Working.' });
    const secondAssistant = assistantTodo('assistant-point-second', [{ id: 'call-point-second', input: second }]);
    const index = buildTodoSnapshotIndex([
      firstAssistant,
      result('call-point-first', first),
      middle,
      secondAssistant,
      result('call-point-second', second),
    ]);
    assert.equal(index.ownedByAssistantId.has(middle.id), false);
    assert.equal(index.effectiveByAssistantId.get(middle.id)?.todos[0].title, 'Inspect the state');
    assert.equal(index.effectiveByAssistantId.get(firstAssistant.id)?.todos[0].title, 'Inspect the state');
    assert.equal(index.effectiveByAssistantId.get(secondAssistant.id)?.todos[0].title, 'Future list');
    assert.deepEqual(
      index.turnSnapshotsByAssistantId.get(firstAssistant.id)?.map((item) => item.toolCallId),
      ['call-point-first'],
    );
    assert.deepEqual(
      index.turnSnapshotsByAssistantId.get(middle.id)?.map((item) => item.toolCallId),
      ['call-point-first'],
    );
    assert.deepEqual(
      index.turnSnapshotsByAssistantId.get(secondAssistant.id)?.map((item) => item.toolCallId),
      ['call-point-first', 'call-point-second'],
    );
  });

  it('keeps only the latest state of each same-turn UI list', () => {
    const completed: TodoWriteInput = {
      todos: [...first.todos].reverse().map((todo) => ({
        id: todo.id,
        title: todo.title,
        status: 'completed' as const,
      })),
    };
    const firstAssistant = assistantTodo('assistant-state-first', [{ id: 'call-state-first', input: first }]);
    const secondAssistant = assistantTodo('assistant-state-second', [{ id: 'call-state-second', input: completed }]);
    const index = buildTodoSnapshotIndex([
      message({ role: 'user', content: 'Run the work.' }),
      firstAssistant,
      result('call-state-first', first),
      secondAssistant,
      result('call-state-second', completed),
    ]);

    assert.deepEqual(
      index.turnSnapshotsByAssistantId.get(firstAssistant.id)?.map((item) => item.toolCallId),
      ['call-state-first'],
    );
    assert.deepEqual(
      index.turnSnapshotsByAssistantId.get(secondAssistant.id)?.map((item) => item.toolCallId),
      ['call-state-second'],
    );
    assert.equal(index.turnSnapshotsByAssistantId.get(secondAssistant.id)?.[0]?.completed, 2);
    assert.deepEqual(
      index.turnSnapshotsByAssistantId.get(secondAssistant.id)?.[0]?.todos.map((todo) => todo.id),
      [42, 7],
    );
  });

  it('accepts a refined title but keeps an unrelated list that reuses the IDs', () => {
    const initial: TodoWriteInput = { todos: [
      { id: 1, title: 'First task', status: 'completed' },
      { id: 2, title: 'Second task', status: 'in-progress' },
      { id: 3, title: 'Third task', status: 'not-started' },
    ] };
    const refined: TodoWriteInput = { todos: [
      { id: 1, title: 'First task', status: 'completed' },
      { id: 2, title: 'Second task', status: 'completed' },
      { id: 3, title: 'Third task with refined scope', status: 'in-progress' },
    ] };
    const unrelated: TodoWriteInput = { todos: [
      { id: 1, title: 'Independent alpha', status: 'in-progress' },
      { id: 2, title: 'Independent beta', status: 'not-started' },
      { id: 3, title: 'Independent gamma', status: 'not-started' },
    ] };
    const assistant = assistantTodo('assistant-refined-title', [
      { id: 'call-title-initial', input: initial },
      { id: 'call-title-refined', input: refined },
      { id: 'call-title-unrelated', input: unrelated },
    ]);
    const index = buildTodoSnapshotIndex([
      message({ role: 'user', content: 'Run both plans.' }),
      assistant,
      result('call-title-initial', initial),
      result('call-title-refined', refined),
      result('call-title-unrelated', unrelated),
    ]);

    assert.deepEqual(
      index.turnSnapshotsByAssistantId.get(assistant.id)?.map((item) => item.toolCallId),
      ['call-title-refined', 'call-title-unrelated'],
    );
  });

  it('keeps only the latest forward-growing list when inserted tasks renumber later IDs', () => {
    const inputs: TodoWriteInput[] = [
      { todos: [
        { id: 1, title: 'Run independent tool batch', status: 'completed' },
        { id: 2, title: 'Verify write', status: 'in-progress' },
        { id: 3, title: 'Test whiteboard', status: 'in-progress' },
        { id: 4, title: 'Clean up smoke files', status: 'not-started' },
        { id: 5, title: 'Test ask user', status: 'not-started' },
        { id: 6, title: 'Report final results', status: 'not-started' },
      ] },
      { todos: [
        { id: 1, title: 'Run independent tool batch', status: 'completed' },
        { id: 2, title: 'Verify write', status: 'in-progress' },
        { id: 3, title: 'Test whiteboard', status: 'in-progress' },
        { id: 4, title: 'Test append and overwrite', status: 'not-started' },
        { id: 5, title: 'Clean up smoke files', status: 'not-started' },
        { id: 6, title: 'Test ask user', status: 'not-started' },
        { id: 7, title: 'Report final results', status: 'not-started' },
      ] },
      { todos: [
        { id: 1, title: 'Run independent tool batch', status: 'completed' },
        { id: 2, title: 'Verify write', status: 'completed' },
        { id: 3, title: 'Test whiteboard', status: 'completed' },
        { id: 4, title: 'Test append and overwrite', status: 'in-progress' },
        { id: 5, title: 'Test history search', status: 'not-started' },
        { id: 6, title: 'Clean up smoke files', status: 'not-started' },
        { id: 7, title: 'Test ask user', status: 'not-started' },
        { id: 8, title: 'Report final results', status: 'not-started' },
      ] },
      { todos: [
        { id: 1, title: 'Run independent tool batch', status: 'completed' },
        { id: 2, title: 'Verify write', status: 'completed' },
        { id: 3, title: 'Test whiteboard with read-back', status: 'completed' },
        { id: 4, title: 'Test append and overwrite', status: 'completed' },
        { id: 5, title: 'Test history search', status: 'completed' },
        { id: 6, title: 'Test skills', status: 'completed' },
        { id: 7, title: 'Clean up smoke files', status: 'in-progress' },
        { id: 8, title: 'Test ask user', status: 'not-started' },
        { id: 9, title: 'Report final results', status: 'not-started' },
      ] },
    ];
    const assistant = assistantTodo('assistant-growing-list', inputs.map((input, index) => ({
      id: `call-growing-${index + 1}`,
      input,
    })));
    const index = buildTodoSnapshotIndex([
      message({ role: 'user', content: 'Smoke-test the tools.' }),
      assistant,
      ...inputs.map((input, inputIndex) => result(`call-growing-${inputIndex + 1}`, input)),
    ]);

    const snapshots = index.turnSnapshotsByAssistantId.get(assistant.id);
    assert.deepEqual(snapshots?.map((snapshot) => snapshot.toolCallId), ['call-growing-4']);
    assert.equal(snapshots?.[0]?.total, 9);
    assert.equal(snapshots?.[0]?.todos[8]?.title, 'Report final results');
  });

  it('keeps a shorter nested list separate while its parent list grows', () => {
    const parent: TodoWriteInput = { todos: [
      { id: 1, title: 'Prepare release', status: 'in-progress' },
      { id: 2, title: 'Validate package', status: 'not-started' },
      { id: 3, title: 'Publish release', status: 'not-started' },
    ] };
    const nested: TodoWriteInput = { todos: [
      { id: 1, title: 'Run unit tests', status: 'in-progress' },
      { id: 2, title: 'Run lint', status: 'not-started' },
    ] };
    const grownParent: TodoWriteInput = { todos: [
      { id: 1, title: 'Prepare release', status: 'completed' },
      { id: 2, title: 'Validate package', status: 'in-progress' },
      { id: 3, title: 'Document release', status: 'not-started' },
      { id: 4, title: 'Publish release', status: 'not-started' },
    ] };
    const assistant = assistantTodo('assistant-parent-and-nested', [
      { id: 'call-parent', input: parent },
      { id: 'call-nested', input: nested },
      { id: 'call-grown-parent', input: grownParent },
    ]);
    const index = buildTodoSnapshotIndex([
      message({ role: 'user', content: 'Prepare the release.' }),
      assistant,
      result('call-parent', parent),
      result('call-nested', nested),
      result('call-grown-parent', grownParent),
    ]);

    assert.deepEqual(
      index.turnSnapshotsByAssistantId.get(assistant.id)?.map((snapshot) => snapshot.toolCallId),
      ['call-grown-parent', 'call-nested'],
    );
  });

  it('starts a new UI snapshot group at each user turn', () => {
    const second: TodoWriteInput = {
      todos: [{ id: 99, title: 'Next turn list', status: 'not-started' }],
    };
    const firstAssistant = assistantTodo('assistant-turn-first', [{ id: 'call-turn-first', input: first }]);
    const secondAssistant = assistantTodo('assistant-turn-second', [{ id: 'call-turn-second', input: second }]);
    const index = buildTodoSnapshotIndex([
      message({ role: 'user', content: 'First turn.' }),
      firstAssistant,
      result('call-turn-first', first),
      message({ role: 'user', content: 'Second turn.' }),
      secondAssistant,
      result('call-turn-second', second),
    ]);

    assert.deepEqual(
      index.turnSnapshotsByAssistantId.get(firstAssistant.id)?.map((item) => item.toolCallId),
      ['call-turn-first'],
    );
    assert.deepEqual(
      index.turnSnapshotsByAssistantId.get(secondAssistant.id)?.map((item) => item.toolCallId),
      ['call-turn-second'],
    );
  });

  it('does not assign a previous-turn UI list to a new assistant with no todo call', () => {
    const firstAssistant = assistantTodo('assistant-prior-list', [{ id: 'call-prior-list', input: first }]);
    const latestAssistant = message({
      id: 'assistant-without-list',
      role: 'assistant',
      content: 'This turn did not create or update a to-do list.',
    });
    const index = buildTodoSnapshotIndex([
      message({ role: 'user', content: 'First turn.' }),
      firstAssistant,
      result('call-prior-list', first),
      message({ role: 'user', content: 'Second turn.' }),
      latestAssistant,
    ]);

    assert.equal(index.turnSnapshotsByAssistantId.get(latestAssistant.id), undefined);
    assert.equal(
      index.effectiveByAssistantId.get(latestAssistant.id)?.sourceAssistantId,
      firstAssistant.id,
      'model-context state may remain effective, but the preview UI must not use it',
    );
  });

  it('accepts known LC notices and ignores a later failed update', () => {
    const assistant = assistantTodo('assistant-good', [{ id: 'call-good', input: first }]);
    const notice = `${LC_RESULT_NOTICES.oneToolRoundRemains}\n\n`;
    const failed = assistantTodo('assistant-failed', [{ id: 'call-failed', input: {
      todos: [{ id: 1, title: 'Lost update', status: 'not-started' }],
    } }]);
    const failedResult = message({
      role: 'tool',
      tool_call_id: 'call-failed',
      tool_is_error: true,
      content: JSON.stringify({ status: 'error', issues: [{ code: 'invalid_arguments', message: 'Bad input', retryable: false }], warnings: [] }),
    });
    const snapshot = buildTodoSnapshotIndex([
      assistant,
      result('call-good', first, notice),
      failed,
      failedResult,
    ]).latest;
    assert.equal(snapshot?.sourceAssistantId, 'assistant-good');
  });

  it('bounds stored result notices and bytes', () => {
    const envelope = JSON.stringify({
      status: 'ok',
      data: { completed: 1, blocked: 0, total: 2 },
      issues: [],
      warnings: [],
    });
    const notice = `${LC_RESULT_NOTICES.oneToolRoundRemains}\n\n`;
    assert.equal(decodeStoredToolResultEnvelope(envelope)?.status, 'ok');
    assert.equal(
      decodeStoredToolResultEnvelope(notice.repeat(MAX_LEADING_LC_RESULT_NOTICES) + envelope)?.status,
      'ok',
    );
    assert.equal(
      decodeStoredToolResultEnvelope(notice.repeat(MAX_LEADING_LC_RESULT_NOTICES + 1) + envelope),
      undefined,
    );
    assert.equal(
      decodeStoredToolResultEnvelope('[LC] Unknown stored notice.\n\n' + envelope),
      undefined,
    );
    assert.equal(decodeStoredToolResultEnvelope('{"status":"ok"}'), undefined);
    assert.equal(
      decodeStoredToolResultEnvelope('x'.repeat(MAX_STORED_TOOL_RESULT_BYTES + 1)),
      undefined,
    );
  });

  it('rejects a result whose counts do not prove the stored call', () => {
    const assistant = assistantTodo('assistant-mismatch', [{ id: 'call-mismatch', input: first }]);
    const mismatched = message({
      role: 'tool',
      tool_call_id: 'call-mismatch',
      content: JSON.stringify({
        status: 'ok',
        data: { completed: 0, blocked: 0, total: 2 },
        issues: [],
        warnings: [],
      }),
    });
    assert.equal(buildTodoSnapshotIndex([assistant, mismatched]).latest, undefined);
  });

  it('does not scan beyond the 4,096-message bound', () => {
    const stored = [
      assistantTodo('assistant-old', [{ id: 'call-old', input: first }]),
      result('call-old', first),
      ...Array.from({ length: 4_096 }, (_, index) => message({
        role: 'system',
        content: `padding-${index}`,
      })),
    ];
    assert.equal(buildTodoSnapshotIndex(stored).latest, undefined);
  });

  it('projects only after the finalized request hides the source call', () => {
    const stored = [
      assistantTodo('assistant-project', [{ id: 'call-project', input: first }]),
      result('call-project', first),
      message({ role: 'user', content: 'Continue.' }),
    ];
    const surviving: ChatMessage[] = [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-project',
        type: 'function',
        function: { name: 'lc_todo_write', arguments: JSON.stringify(first) },
      }],
    }];
    assert.equal(resolveTodoRequestProjection(stored, surviving), undefined);

    const projected = resolveTodoRequestProjection(stored, [
      { role: 'user', content: 'Continue.' },
    ]);
    assert.match(projected ?? '', /saved LC task state/);
    assert.match(projected ?? '', /"id":42/);
    assert.equal((projected?.match(/Inspect the state/g) ?? []).length, 1);
  });

  it('suppresses an old projection after a successful active update', () => {
    const active: TodoWriteInput = {
      todos: [{ id: 42, title: 'Active update', status: 'in-progress' }],
    };
    const oldAssistant = assistantTodo('assistant-old-project', [{ id: 'call-old-project', input: first }]);
    const activeAssistant = assistantTodo('assistant-active-project', [{ id: 'call-active-project', input: active }]);
    const stored = [
      oldAssistant,
      result('call-old-project', first),
      message({ role: 'user', content: 'Continue.' }),
      activeAssistant,
      result('call-active-project', active),
    ];
    const requestMessages: ChatMessage[] = [{ role: 'user', content: 'Continue.' }, {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-active-project',
        type: 'function',
        function: { name: 'lc_todo_write', arguments: JSON.stringify(active) },
      }],
    }];
    assert.equal(resolveTodoRequestProjection(stored, requestMessages), undefined);
  });

  it('bounds active and blocked notes and omits completed details', () => {
    const input: TodoWriteInput = {
      todos: [
        {
          id: 1,
          title: 'Done',
          status: 'completed',
          note: 'Do not project this.',
          completion_evidence: 'Do not project this evidence.',
        },
        { id: 20, title: 'Active one', status: 'in-progress', note: 'Active note one.' },
        { id: 21, title: 'Active two', status: 'in-progress', note: 'Active note two.' },
        ...Array.from({ length: 6 }, (_, index) => ({
          id: index + 2,
          title: `Blocked ${index + 1}`,
          status: 'blocked' as const,
          note: `Reason ${index + 1}`,
        })),
      ],
    };
    const assistant = assistantTodo('assistant-blocked', [{ id: 'call-blocked', input }]);
    const snapshot = buildTodoSnapshotIndex([assistant, result('call-blocked', input)]).latest;
    assert.ok(snapshot);
    const projection = formatTodoRequestProjection(snapshot);
    assert.doesNotMatch(projection ?? '', /Do not project this/);
    assert.match(projection ?? '', /Active note one/);
    assert.doesNotMatch(projection ?? '', /Active note two/);
    assert.match(projection ?? '', /omitted 1 in-progress note/);
    assert.match(projection ?? '', /Reason 5/);
    assert.doesNotMatch(projection ?? '', /Reason 6/);
    assert.match(projection ?? '', /omitted 1 blocked note/);
  });

  it('does not project a completed list', () => {
    const input: TodoWriteInput = {
      todos: [{ id: 1, title: 'Closed', status: 'completed' }],
    };
    const assistant = assistantTodo('assistant-closed', [{ id: 'call-closed', input }]);
    const snapshot = buildTodoSnapshotIndex([assistant, result('call-closed', input)]).latest;
    assert.ok(snapshot);
    assert.equal(formatTodoRequestProjection(snapshot), undefined);
  });

  it('measures complete request fixtures and projection budgets', () => {
    const toolsConfig = {
      enabled: true,
      file_io_enabled: false,
      shell_enabled: false,
      web_access_enabled: false,
      tool_history_enabled: true,
      skills_enabled: false,
      tool_grants: [],
      web_access_grants_initialized: true,
      allowed_roots: [],
      dir_permissions: {},
      max_tool_rounds_per_turn: 128,
      max_tool_calls_per_batch: 16,
      sse_read_timeout_min: 5,
    };
    const prompt = buildPromptText({
      tools: toolsConfig,
      params: { system_prompt: '' },
    }, '/home/user', 'Linux');
    const definitions = materialize([...resolveExposure(toolsConfig).exposedHandlers]);
    const request = (content: string, extraMessages: ChatMessage[] = []) => JSON.stringify({
      model: 'todo-fixture',
      messages: [
        { role: 'system', content: prompt },
        ...extraMessages,
        { role: 'user', content },
      ],
      tools: definitions,
      stream: true,
    });
    const title = (prefix: string) => `${prefix} ${'review the current implementation state '.repeat(5)}`
      .slice(0, 120)
      .trim();
    const note = (prefix: string) => `${prefix} ${'wait for the required project input '.repeat(9)}`
      .slice(0, 240)
      .trim();
    const typicalInput: TodoWriteInput = {
      todos: Array.from({ length: 8 }, (_, index) => ({
        id: index * 7 + 1,
        title: `Task ${index + 1}`,
        status: index === 2 ? 'in-progress' as const : 'not-started' as const,
        ...(index === 2 ? { note: 'Continue from the verified result.' } : {}),
      })),
    };
    const maximumInput: TodoWriteInput = {
      todos: Array.from({ length: 20 }, (_, index) => ({
        id: index + 1,
        title: title(`Task ${index + 1}`),
        status: index < 6 ? 'blocked' as const : 'not-started' as const,
        ...(index < 6 ? { note: note(`Blocker ${index + 1}`) } : {}),
      })),
    };
    const adversarialInput: TodoWriteInput = {
      todos: Array.from({ length: 20 }, (_, index) => ({
        id: index + 1,
        title: '漢'.repeat(120),
        status: 'not-started' as const,
      })),
    };
    const projectionFor = (input: TodoWriteInput, id: string) => {
      const assistant = assistantTodo(`assistant-${id}`, [{ id: `call-${id}`, input }]);
      const snapshot = buildTodoSnapshotIndex([assistant, result(`call-${id}`, input)]).latest;
      assert.ok(snapshot);
      return formatTodoRequestProjection(snapshot)!;
    };
    const typicalProjection = projectionFor(typicalInput, 'typical');
    const maximumProjection = projectionFor(maximumInput, 'maximum');
    const adversarialProjection = projectionFor(adversarialInput, 'adversarial');
    const archivedMessages: ChatMessage[] = [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'archived-todo-source',
        type: 'function',
        function: { name: 'lc_tool_history', arguments: '{"message_id":"assistant-source"}' },
      }],
    }, {
      role: 'tool',
      tool_call_id: 'archived-todo-source',
      content: buildArchivedToolStub(1, 'assistant-source', ['lc_todo_write']),
    }];
    const survivingRequest = request('Continue.', [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-typical',
        type: 'function',
        function: { name: 'lc_todo_write', arguments: JSON.stringify(typicalInput) },
      }],
    }, {
      role: 'tool',
      tool_call_id: 'call-typical',
      content: JSON.stringify({
        status: 'ok',
        data: { completed: 0, blocked: 0, total: 8 },
        issues: [],
        warnings: [],
      }),
    }]);
    const measurements = {
      noSnapshotRequest: countTokens(request('Continue.')),
      survivingCallRequest: countTokens(survivingRequest),
      typicalProjection: countTokens(typicalProjection),
      typicalProjectedRequest: countTokens(request(`Continue.\n\n${typicalProjection}`, archivedMessages)),
      maximumProjection: countTokens(maximumProjection),
      maximumProjectedRequest: countTokens(request(`Continue.\n\n${maximumProjection}`, archivedMessages)),
      adversarialProjection: countTokens(adversarialProjection),
      adversarialProjectedRequest: countTokens(request(`Continue.\n\n${adversarialProjection}`, archivedMessages)),
    };

    assert.deepEqual(measurements, {
      noSnapshotRequest: 1_402,
      survivingCallRequest: 1_637,
      typicalProjection: 183,
      typicalProjectedRequest: 1_712,
      maximumProjection: 927,
      maximumProjectedRequest: 2_494,
      adversarialProjection: 2_731,
      adversarialProjectedRequest: 4_297,
    });
    assert.ok(measurements.typicalProjection <= 250);
    assert.ok(measurements.maximumProjection <= 1_000);
    assert.equal((survivingRequest.match(/Task 3/g) ?? []).length, 1);
  });
});
