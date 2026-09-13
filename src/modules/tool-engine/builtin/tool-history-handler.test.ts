/**
 * Handler-level coverage for `lc_tool_history`.
 *
 * The pre-search behavior of every non-`query` mode is pinned here so the
 * added search mode cannot quietly change list, `message_id`, or
 * `tool_call_id` retrieval (docs/tools/tool-history.md).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  toolHistory,
  UNRESOLVED_HISTORY_REDACTED_OUTPUT,
  WHITEBOARD_HISTORY_REDACTED_OUTPUT,
} from './tool_history.ts';
import type { ToolHistoryOutput } from './tool_history';
import type { ToolHistorySearchOutput } from './tool-history-search';
import { useConversations } from '../../../store/conversations.ts';
import { DEFAULT_PARAMS, type Conversation, type Message } from '../../../types.ts';
import type { ToolCallRecord, ToolHandlerContext } from '../types';
import { WHITEBOARD_TURN_REFS_FIXTURE } from '../../../whiteboard/contract-fixtures.ts';

const CONV_ID = 'conv-history';

function assistant(id: string, calls: ToolCallRecord[], at: number): Message {
  return { id, role: 'assistant', content: '', createdAt: at, sortOrder: at, tool_calls: calls };
}

function toolResult(id: string, callId: string, content: string, at: number, isError = false): Message {
  return {
    id,
    role: 'tool',
    content,
    createdAt: at,
    sortOrder: at,
    tool_call_id: callId,
    ...(isError ? { tool_is_error: true } : {}),
  };
}

function seed(messages: Message[]): void {
  const conv: Conversation = {
    id: CONV_ID,
    title: 'history',
    params: DEFAULT_PARAMS,
    messages,
    createdAt: 1,
    updatedAt: 1,
  };
  useConversations.setState({ byId: { [CONV_ID]: conv }, order: [CONV_ID] });
}

function context(): ToolHandlerContext {
  return {
    config: { convId: CONV_ID },
    signal: new AbortController().signal,
  } as unknown as ToolHandlerContext;
}

const FIXTURE: Message[] = [
  { id: 'u1', role: 'user', content: 'go', createdAt: 1, sortOrder: 1 },
  assistant('msg-a', [
    { created_at: 0, id: 'call-a1', name: 'lc_grep', arguments: '{"pattern":"deepseek"}' },
    { created_at: 0, id: 'call-a2', name: 'lc_read_file', arguments: '{"paths":["/tmp/notes.md"]}' },
  ], 2),
  toolResult('t1', 'call-a1', 'orchestrator.ts:256 DeepSeek thinking mode', 3),
  toolResult('t2', 'call-a2', 'notes about caching and prefixes', 4),
  { id: 'u2', role: 'user', content: 'more', createdAt: 5, sortOrder: 5 },
  assistant('msg-b', [
    { created_at: 0, id: 'call-b1', name: 'lc_run_shell', arguments: '{"command":"ls"}' },
  ], 6),
  toolResult('t3', 'call-b1', 'permission denied while listing', 7, true),
  { id: 'u3', role: 'user', content: 'continue', createdAt: 8, sortOrder: 8 },
  assistant('msg-current', [
    { created_at: 0, id: 'call-current', name: 'lc_tool_history', arguments: '{}' },
  ], 9),
  toolResult('t-current', 'call-current', 'active turn output', 10),
];

const PRIVATE_MODEL_MARKDOWN = '# Private model plan\n\nNever disclose this historical body.';
const PRIVATE_USER_MARKDOWN = '# Private user constraints\n\nKeep this historical body hidden.';
const ORPHANED_PRIVATE_OUTPUT = `${PRIVATE_MODEL_MARKDOWN}\n${PRIVATE_USER_MARKDOWN}`;

const WHITEBOARD_FIXTURE: Message[] = [
  { id: 'u1', role: 'user', content: 'go', createdAt: 1, sortOrder: 1 },
  {
    ...assistant('msg-whiteboard-read', [
      { created_at: 0, id: 'call-whiteboard-read', name: 'lc_whiteboard', arguments: '{"action":"read"}' },
      { created_at: 0, id: 'call-ordinary', name: 'lc_grep', arguments: '{"pattern":"safe ordinary query"}' },
    ], 2),
    whiteboard_refs: { ...WHITEBOARD_TURN_REFS_FIXTURE },
  },
  toolResult('t-whiteboard-read', 'call-whiteboard-read', JSON.stringify({
    refs: WHITEBOARD_TURN_REFS_FIXTURE,
    user_markdown: PRIVATE_USER_MARKDOWN,
    model_markdown: PRIVATE_MODEL_MARKDOWN,
  }), 3),
  toolResult('t-ordinary', 'call-ordinary', 'safe ordinary output', 4),
  {
    ...assistant('msg-whiteboard-replace', [{
      created_at: 0,
      id: 'call-whiteboard-replace',
      name: 'lc_whiteboard',
      arguments: JSON.stringify({ action: 'replace', content: PRIVATE_MODEL_MARKDOWN }),
    }], 5),
    whiteboard_refs: { ...WHITEBOARD_TURN_REFS_FIXTURE },
  },
  toolResult('t-whiteboard-replace', 'call-whiteboard-replace', JSON.stringify({
    refs: WHITEBOARD_TURN_REFS_FIXTURE,
    changed: true,
    model_markdown: PRIVATE_MODEL_MARKDOWN,
  }), 6),
  assistant('msg-orphaned', [
    { created_at: 0, id: 'different-call', name: 'lc_grep', arguments: '{"pattern":"public"}' },
  ], 7),
  toolResult('t-orphaned', 'orphaned-call', ORPHANED_PRIVATE_OUTPUT, 8),
  { id: 'u-current', role: 'user', content: 'continue', createdAt: 9, sortOrder: 9 },
  assistant('msg-current', [
    { created_at: 0, id: 'call-current', name: 'lc_tool_history', arguments: '{}' },
  ], 10),
  toolResult('t-current', 'call-current', 'active turn output', 11),
];

beforeEach(() => {
  seed(FIXTURE);
});

async function run(input: Parameters<typeof toolHistory.run>[0]) {
  return toolHistory.run(input, context());
}

describe('lc_tool_history — pre-search behavior is unchanged without query', () => {
  it('list mode still returns summary entries', async () => {
    const out = await run({}) as ToolHistoryOutput;
    assert.equal(out.total_archived, 3);
    assert.equal(out.returned, 3);
    assert.equal(out.results.length, 0);
    assert.deepEqual(out.summary?.map((s) => s.message_id), ['msg-a', 'msg-b']);
    assert.equal(out.coverage_pct, 100);
    assert.ok(!('hits' in out));
  });

  it('tool_name alone still filters the listing without retrieving payloads', async () => {
    const out = await run({ tool_name: 'lc_grep' }) as ToolHistoryOutput;
    assert.equal(out.total_archived, 1);
    assert.deepEqual(out.summary?.map((s) => s.message_id), ['msg-a']);
    assert.equal(out.results.length, 0);
  });

  it('message_id retrieval still returns full results', async () => {
    const out = await run({ message_id: 'msg-a' }) as ToolHistoryOutput;
    assert.equal(out.total_archived, 2);
    assert.equal(out.returned, 2);
    assert.deepEqual(out.results.map((r) => r.tool_call_id), ['call-a1', 'call-a2']);
    assert.equal(out.results[0].output, 'orchestrator.ts:256 DeepSeek thinking mode');
  });

  it('tool_call_id exact retrieval still returns exactly one result', async () => {
    const out = await run({ tool_call_id: 'call-b1' }) as ToolHistoryOutput;
    assert.equal(out.total_archived, 1);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].is_error, true);
    assert.equal(out.results[0].output, 'permission denied while listing');
  });

  it('a missing message_id still offers back real archived ids', async () => {
    const out = await run({ message_id: 'nope' }) as ToolHistoryOutput;
    assert.equal(out.total_archived, 0);
    assert.deepEqual(out.available_message_ids, ['msg-a', 'msg-b']);
  });

  it('still honors the existing response byte budget', async () => {
    const out = await run({ message_id: 'msg-a', max_result_bytes: 20 }) as ToolHistoryOutput;
    assert.equal(out.truncated, true);
    assert.ok((out.coverage_pct ?? 100) < 100);
  });

  it('normalizes the all-fields Luna shape before selecting a mode', async () => {
    const parsed = toolHistory.input.parse({
      message_id: 'msg-a',
      tool_name: 'lc_grep',
      tool_call_id: '',
      query: '',
      max_results: 50,
      max_result_bytes: 262144,
    });
    const out = await run(parsed) as ToolHistoryOutput;
    assert.equal(out.returned, 1);
    assert.equal(out.results[0].tool_call_id, 'call-a1');
  });

  it('does not expose results from the active assistant turn', async () => {
    const out = await run({ tool_call_id: 'call-current' }) as ToolHistoryOutput;
    assert.equal(out.returned, 0);
    assert.ok(!JSON.stringify(out).includes('active turn output'));
  });
});

describe('lc_tool_history — Whiteboard reference-only privacy', () => {
  beforeEach(() => {
    seed(WHITEBOARD_FIXTURE);
  });

  it('returns action-only arguments and one owning-turn reference object by message_id', async () => {
    const before = JSON.stringify(useConversations.getState().byId[CONV_ID].messages);
    const out = await run({ message_id: 'msg-whiteboard-read' }) as ToolHistoryOutput;
    const whiteboard = out.results.find((result) => result.tool_call_id === 'call-whiteboard-read');
    const ordinary = out.results.find((result) => result.tool_call_id === 'call-ordinary');

    assert.deepEqual(out.whiteboard_refs, WHITEBOARD_TURN_REFS_FIXTURE);
    assert.deepEqual(JSON.parse(whiteboard?.arguments ?? ''), { action: 'read' });
    assert.equal(whiteboard?.output, WHITEBOARD_HISTORY_REDACTED_OUTPUT);
    assert.equal(ordinary?.arguments, '{"pattern":"safe ordinary query"}');
    assert.equal(ordinary?.output, 'safe ordinary output');
    assert.doesNotMatch(JSON.stringify(out), /Private (?:model|user)/);
    assert.equal(JSON.stringify(useConversations.getState().byId[CONV_ID].messages), before);
  });

  it('returns the resolved owner and references for exact call retrieval', async () => {
    const out = await run({ tool_call_id: 'call-whiteboard-replace' }) as ToolHistoryOutput;
    assert.equal(out.message_id, 'msg-whiteboard-replace');
    assert.deepEqual(out.whiteboard_refs, WHITEBOARD_TURN_REFS_FIXTURE);
    assert.deepEqual(JSON.parse(out.results[0].arguments), { action: 'replace' });
    assert.equal(out.results[0].output, WHITEBOARD_HISTORY_REDACTED_OUTPUT);
    assert.doesNotMatch(JSON.stringify(out), /Never disclose/);
  });

  it('keeps list and broad search free of references and historical Markdown', async () => {
    const list = await run({}) as ToolHistoryOutput;
    assert.equal('whiteboard_refs' in list, false);
    assert.equal(list.results.length, 0);
    assert.doesNotMatch(JSON.stringify(list), /Private (?:model|user)|Never disclose/);

    const byName = await run({ query: 'lc_whiteboard' }) as ToolHistorySearchOutput;
    assert.equal(byName.returned, 2);
    assert.equal('whiteboard_refs' in byName, false);
    assert.ok(byName.hits.every((hit) => hit.tool_name === 'lc_whiteboard'));
    assert.doesNotMatch(JSON.stringify(byName), /Private (?:model|user)|Never disclose/);

    const byAction = await run({ query: 'replace' }) as ToolHistorySearchOutput;
    assert.deepEqual(byAction.hits.map((hit) => hit.tool_call_id), ['call-whiteboard-replace']);
    assert.ok(byAction.hits[0].matched_fields.includes('arguments'));

    const byPrivateContent = await run({ query: 'Never disclose' }) as ToolHistorySearchOutput;
    assert.equal(byPrivateContent.returned, 0);
  });

  it('fails closed for unresolved ownership and excludes it from every search field', async () => {
    const byMessage = await run({ message_id: 'msg-orphaned' }) as ToolHistoryOutput;
    assert.equal(byMessage.results[0].tool_name, 'unknown');
    assert.equal(byMessage.results[0].arguments, '');
    assert.equal(byMessage.results[0].output, UNRESOLVED_HISTORY_REDACTED_OUTPUT);
    assert.doesNotMatch(JSON.stringify(byMessage), /Private (?:model|user)/);

    const exact = await run({ tool_call_id: 'orphaned-call' }) as ToolHistoryOutput;
    assert.equal(exact.message_id, null);
    assert.equal('whiteboard_refs' in exact, false);
    assert.equal(exact.results[0].arguments, '');
    assert.equal(exact.results[0].output, UNRESOLVED_HISTORY_REDACTED_OUTPUT);

    for (const query of ['unknown', 'orphaned-call', 'Private model plan']) {
      const search = await run({ query }) as ToolHistorySearchOutput;
      assert.equal(search.returned, 0, `unresolved result leaked through query: ${query}`);
    }
  });
});

describe('lc_tool_history — search mode', () => {
  it('finds a match in stored output and returns a retrievable tool_call_id', async () => {
    const out = await run({ query: 'deepseek' }) as ToolHistorySearchOutput;
    assert.equal(out.returned, 1);
    assert.equal(out.hits[0].tool_call_id, 'call-a1');

    const exact = await run({ tool_call_id: out.hits[0].tool_call_id }) as ToolHistoryOutput;
    assert.equal(exact.results.length, 1);
    assert.equal(exact.results[0].output, 'orchestrator.ts:256 DeepSeek thinking mode');
  });

  it('searches arguments as well as output', async () => {
    const out = await run({ query: 'notes.md' }) as ToolHistorySearchOutput;
    assert.equal(out.returned, 1);
    assert.equal(out.hits[0].tool_call_id, 'call-a2');
    assert.ok(out.hits[0].matched_fields.includes('arguments'));
  });

  it('composes message_id and tool_name as filters', async () => {
    const scoped = await run({ query: 'caching', message_id: 'msg-a' }) as ToolHistorySearchOutput;
    assert.equal(scoped.eligible_calls, 2);
    assert.equal(scoped.returned, 1);

    const byTool = await run({ query: 'caching', tool_name: 'lc_read_file' }) as ToolHistorySearchOutput;
    assert.equal(byTool.eligible_calls, 1);
    assert.equal(byTool.returned, 1);

    const both = await run({
      query: 'caching', message_id: 'msg-a', tool_name: 'lc_grep',
    }) as ToolHistorySearchOutput;
    assert.equal(both.eligible_calls, 1);
    assert.equal(both.returned, 0);
    assert.equal(both.scan_coverage_pct, 100);
  });

  it('reports an error result honestly', async () => {
    const out = await run({ query: 'permission' }) as ToolHistorySearchOutput;
    assert.equal(out.hits[0].is_error, true);
    assert.equal(out.hits[0].message_id, 'msg-b');
  });

  it('rejects query combined with tool_call_id as invalid_arguments', async () => {
    await assert.rejects(
      () => run({ query: 'deepseek', tool_call_id: 'call-a1' }),
      (error: unknown) => {
        const issue = error as { code?: string; message?: string };
        assert.equal(issue.code, 'invalid_arguments');
        assert.match(issue.message ?? '', /mutually exclusive/);
        return true;
      },
    );
  });

  it('surfaces thrown input errors as invalid_arguments, not handler exceptions', async () => {
    // The message text is control input; the machine code must not claim a
    // retryable handler bug for a caller error the schema already describes.
    const seventeenTerms = Array.from({ length: 17 }, (_, i) => `term${i}`).join(' ');
    await assert.rejects(
      () => run({ query: seventeenTerms }),
      (error: unknown) => {
        const issue = error as { code?: string; message?: string };
        assert.equal(issue.code, 'invalid_arguments');
        assert.match(issue.message ?? '', /distinct terms/);
        return true;
      },
    );
  });

  it('treats empty optional strings as omitted', async () => {
    const empty = await run({ query: '' }) as ToolHistoryOutput;
    const whitespace = await run({ query: '   ', tool_call_id: '  ' }) as ToolHistoryOutput;
    assert.deepEqual(empty.summary?.map((entry) => entry.message_id), ['msg-a', 'msg-b']);
    assert.deepEqual(whitespace.summary?.map((entry) => entry.message_id), ['msg-a', 'msg-b']);
  });

  it('cannot reach another conversation', async () => {
    const other: Conversation = {
      id: 'conv-other',
      title: 'other',
      params: DEFAULT_PARAMS,
      messages: [
        assistant('msg-x', [{ created_at: 0, id: 'call-x', name: 'lc_grep', arguments: '{}' }], 1),
        toolResult('tx', 'call-x', 'deepseek secret from another conversation', 2),
      ],
      createdAt: 1,
      updatedAt: 1,
    };
    useConversations.setState((state) => ({
      byId: { ...state.byId, 'conv-other': other },
      order: [...state.order, 'conv-other'],
    }));

    const out = await run({ query: 'deepseek' }) as ToolHistorySearchOutput;
    assert.equal(out.returned, 1);
    assert.equal(out.hits[0].tool_call_id, 'call-a1');
    assert.ok(!JSON.stringify(out).includes('another conversation'));
  });

  it('returns honest zero coverage when the conversation has no archive', async () => {
    seed([{ id: 'u', role: 'user', content: 'hi', createdAt: 1, sortOrder: 1 }]);
    const out = await run({ query: 'deepseek' }) as ToolHistorySearchOutput;
    assert.equal(out.eligible_calls, 0);
    assert.equal(out.returned, 0);
    assert.equal(out.truncated, false);
    assert.equal(out.scan_coverage_pct, 100);
  });
});
