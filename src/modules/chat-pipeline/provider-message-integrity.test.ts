/**
 * Phase 0B.7 — Provider-message integrity across stream failures
 *
 * Characterizes the message-ordering invariants required by all
 * provider APIs (OpenAI Chat Completions, OpenAI Responses, Anthropic
 * Messages).  Validates simulated conversation histories against
 * these invariants after tool-loop completion, stream failures,
 * and partial re-streams.
 *
 * DeepSeek C1 — tool results must always have a valid preceding
 * assistant tool-call identity in the conversation history.
 *
 * Run with:
 *   node --test --experimental-strip-types src/modules/chat-pipeline/provider-message-integrity.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveToolCallId,
  ARCHIVED_TOOL_ARGUMENTS,
  ARCHIVED_TOOL_NAME,
} from './message-history.ts';

/* ═══════════════════════════════════════════════════════════════
   Types (mirrors the domain types without importing React/Tauri)
   ═══════════════════════════════════════════════════════════════ */

interface SimMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: SimToolCall[];
  tool_call_id?: string;
  tool_is_error?: boolean;
  streaming?: boolean;
}

interface SimToolCall {
  id: string;
  name: string;
  arguments: string;
}

/* ═══════════════════════════════════════════════════════════════
   Invariant checkers — pure functions
   ═══════════════════════════════════════════════════════════════ */

/** Every tool message must reference a valid preceding assistant tool-call. */
function checkNoOrphanedToolResults(msgs: SimMessage[]): string | null {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'tool' || !m.tool_call_id) continue;

    // Find the most recent preceding assistant with matching tool-call id.
    let found = false;
    for (let j = i - 1; j >= 0; j--) {
      const am = msgs[j];
      if (am.role === 'assistant' && am.tool_calls?.some((tc) => tc.id === m.tool_call_id)) {
        found = true;
        break;
      }
    }
    if (!found) {
      return `orphaned tool result at index ${i}: tool_call_id=${m.tool_call_id} has no preceding assistant with matching tool_calls entry`;
    }
  }
  return null;
}

/** No two tool messages share the same tool_call_id (no duplicates). */
function checkNoDuplicateToolResults(msgs: SimMessage[]): string | null {
  const seen = new Set<string>();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'tool' || !m.tool_call_id) continue;
    if (seen.has(m.tool_call_id)) {
      return `duplicate tool result at index ${i}: tool_call_id=${m.tool_call_id} appears more than once`;
    }
    seen.add(m.tool_call_id);
  }
  return null;
}

/** Every assistant tool_call must have a corresponding tool result
 *  (or be the last message — about to be executed). */
function checkEveryToolCallHasResult(msgs: SimMessage[]): string | null {
  const pending = new Set<string>();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        pending.add(tc.id);
      }
    }
    if (m.role === 'tool' && m.tool_call_id) {
      pending.delete(m.tool_call_id);
    }
  }
  if (pending.size > 0) {
    return `unresolved tool calls: ${[...pending].join(', ')} — no tool result messages found`;
  }
  return null;
}

/** No streaming messages should appear in the final conversation. */
function checkNoStreamingMessages(msgs: SimMessage[]): string | null {
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].streaming) {
      return `streaming message at index ${i} should not be present in final state`;
    }
  }
  return null;
}

/** Tool messages must appear after their owning assistant message
 *  and before the next user or assistant message (tool results are
 *  tied to the preceding turn). */
function checkToolResultOrdering(msgs: SimMessage[]): string | null {
  const currentTurnToolCallIds = new Set<string>();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.tool_calls) {
      // Starting a new turn: any pending tool results from previous
      // turn should be resolved by now.
      if (currentTurnToolCallIds.size > 0) {
        return `unresolved tool calls from previous turn at index ${i}: ${[...currentTurnToolCallIds].join(', ')}`;
      }
      for (const tc of m.tool_calls) {
        currentTurnToolCallIds.add(tc.id);
      }
    }
    if (m.role === 'tool' && m.tool_call_id) {
      if (!currentTurnToolCallIds.has(m.tool_call_id)) {
        return `tool result at index ${i} with tool_call_id=${m.tool_call_id} appears without a preceding assistant turn`;
      }
      currentTurnToolCallIds.delete(m.tool_call_id);
    }
    if (m.role === 'user') {
      // User message starts a new turn. Previous turn's tool calls
      // should be resolved.
      if (currentTurnToolCallIds.size > 0) {
        return `unresolved tool calls before user message at index ${i}: ${[...currentTurnToolCallIds].join(', ')}`;
      }
      currentTurnToolCallIds.clear();
    }
  }
  return null;
}

/** Run all checks; return array of error strings (empty = valid). */
function validateConversation(msgs: SimMessage[]): string[] {
  const errors: string[] = [];
  const checks: Array<[string, (m: SimMessage[]) => string | null]> = [
    ['no orphaned tool results', checkNoOrphanedToolResults],
    ['no duplicate tool results', checkNoDuplicateToolResults],
    ['every tool call has result', checkEveryToolCallHasResult],
    ['no streaming messages', checkNoStreamingMessages],
    ['tool result ordering', checkToolResultOrdering],
  ];
  for (const [name, fn] of checks) {
    const err = fn(msgs);
    if (err) errors.push(`${name}: ${err}`);
  }
  return errors;
}

/* ═══════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════ */

let seq = 0;
function nextId(prefix: string): string {
  return `${prefix}-${++seq}`;
}

/* ═══════════════════════════════════════════════════════════════
   Tests
   ═══════════════════════════════════════════════════════════════ */

describe('Phase 0B.7 — Provider-message integrity', () => {
  it('uses a distinct stable tool-call ID for each archived assistant message', () => {
    const first = archiveToolCallId('assistant-1');
    const second = archiveToolCallId('assistant-2');
    assert.notEqual(first, second);
    assert.equal(first, archiveToolCallId('assistant-1'));

    const punctuationIds = [
      archiveToolCallId('assistant/a'),
      archiveToolCallId('assistant?a'),
      archiveToolCallId('assistant-x2f-a'),
      archiveToolCallId('assistant--a'),
    ];
    assert.equal(new Set(punctuationIds).size, punctuationIds.length);
    for (const id of punctuationIds) assert.match(id, /^archived_[A-Za-z0-9_-]+$/);
  });

  it('keeps an archived turn valid when its tool_calls collapse to the marker', () => {
    // The marker replaces N real calls with one, so the stub must answer the
    // synthetic id and no orphan tool_call_id may survive the substitution.
    const msgId = 'assistant-1';
    const archiveId = archiveToolCallId(msgId);
    const conv: SimMessage[] = [
      { id: 'u1', role: 'user', content: 'search' },
      { id: msgId, role: 'assistant', content: '', tool_calls: [
        { id: archiveId, name: ARCHIVED_TOOL_NAME, arguments: ARCHIVED_TOOL_ARGUMENTS },
      ]},
      { id: 't1', role: 'tool', content: '⚠️ 2 tool result(s) archived.', tool_call_id: archiveId },
      { id: 'u2', role: 'user', content: 'next' },
    ];
    assert.deepEqual(validateConversation(conv), []);
  });

  it('parses the marker arguments as an object', () => {
    // They ride the wire as a JSON string and Anthropic needs an input object.
    assert.deepEqual(JSON.parse(ARCHIVED_TOOL_ARGUMENTS), {});
  });

  describe('Valid conversation patterns', () => {
    it('simple text-only turn: user → assistant', () => {
      const conv: SimMessage[] = [
        { id: 'u1', role: 'user', content: 'hi' },
        { id: 'a1', role: 'assistant', content: 'hello' },
      ];
      assert.deepEqual(validateConversation(conv), []);
    });

    it('single tool call: user → assistant (tool_calls) → tool result', () => {
      const tcId = nextId('tc');
      const conv: SimMessage[] = [
        { id: 'u1', role: 'user', content: 'read file x' },
        { id: 'a1', role: 'assistant', content: '', tool_calls: [
          { id: tcId, name: 'lc_read_file', arguments: '{"paths":["x"]}' },
        ]},
        { id: 't1', role: 'tool', content: 'content', tool_call_id: tcId },
      ];
      assert.deepEqual(validateConversation(conv), []);
    });

    it('multi-tool turn: user → assistant (3 tool_calls) → 3 tool results', () => {
      const tc1 = nextId('tc');
      const tc2 = nextId('tc');
      const tc3 = nextId('tc');
      const conv: SimMessage[] = [
        { id: 'u1', role: 'user', content: 'do three things' },
        { id: 'a1', role: 'assistant', content: '', tool_calls: [
          { id: tc1, name: 'lc_read_file', arguments: '{}' },
          { id: tc2, name: 'lc_grep', arguments: '{}' },
          { id: tc3, name: 'lc_stat', arguments: '{}' },
        ]},
        { id: 't1', role: 'tool', content: 'r1', tool_call_id: tc1 },
        { id: 't2', role: 'tool', content: 'r2', tool_call_id: tc2 },
        { id: 't3', role: 'tool', content: 'r3', tool_call_id: tc3 },
      ];
      assert.deepEqual(validateConversation(conv), []);
    });

    it('multi-turn with tool loops: user → asst → tools → asst → tools → asst', () => {
      const tc1 = nextId('tc');
      const tc2 = nextId('tc');
      const conv: SimMessage[] = [
        { id: 'u1', role: 'user', content: 'do it' },
        { id: 'a1', role: 'assistant', content: '', tool_calls: [
          { id: tc1, name: 'lc_read_file', arguments: '{}' },
        ]},
        { id: 't1', role: 'tool', content: 'r1', tool_call_id: tc1 },
        { id: 'a2', role: 'assistant', content: 'got it', tool_calls: [
          { id: tc2, name: 'lc_write_file', arguments: '{}' },
        ]},
        { id: 't2', role: 'tool', content: 'r2', tool_call_id: tc2 },
        { id: 'a3', role: 'assistant', content: 'done!' },
      ];
      assert.deepEqual(validateConversation(conv), []);
    });
  });

  describe('Orphaned tool results (no preceding assistant with matching tool_calls)', () => {
    it('tool result without any preceding assistant', () => {
      const conv: SimMessage[] = [
        { id: 'u1', role: 'user', content: 'hi' },
        { id: 't1', role: 'tool', content: 'orphan', tool_call_id: 'nonexistent' },
      ];
      const errors = validateConversation(conv);
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => e.includes('orphaned')));
    });

    it('tool result referencing wrong assistant', () => {
      const tc1 = nextId('tc');
      const conv: SimMessage[] = [
        { id: 'u1', role: 'user', content: 'do A' },
        { id: 'a1', role: 'assistant', content: '', tool_calls: [
          { id: tc1, name: 'lc_read_file', arguments: '{}' },
        ]},
        { id: 't1', role: 'tool', content: 'r1', tool_call_id: 'wrong-id' },
      ];
      const errors = validateConversation(conv);
      assert.ok(errors.length > 0);
    });
  });

  describe('Duplicate tool results', () => {
    it('same tool_call_id appears twice', () => {
      const tc1 = nextId('tc');
      const conv: SimMessage[] = [
        { id: 'u1', role: 'user', content: 'x' },
        { id: 'a1', role: 'assistant', content: '', tool_calls: [
          { id: tc1, name: 'lc_read_file', arguments: '{}' },
        ]},
        { id: 't1', role: 'tool', content: 'r1', tool_call_id: tc1 },
        { id: 't2', role: 'tool', content: 'r2', tool_call_id: tc1 }, // duplicate!
      ];
      const errors = validateConversation(conv);
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => e.includes('duplicate')));
    });
  });

  describe('Unresolved tool calls (assistant with tool_calls but no tool result)', () => {
    it('assistant has tool_calls but no following tool message', () => {
      const tc1 = nextId('tc');
      const conv: SimMessage[] = [
        { id: 'u1', role: 'user', content: 'x' },
        { id: 'a1', role: 'assistant', content: '', tool_calls: [
          { id: tc1, name: 'lc_read_file', arguments: '{}' },
        ]},
        { id: 'a2', role: 'assistant', content: 'done!' }, // no tool result between
      ];
      const errors = validateConversation(conv);
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => e.includes('unresolved')));
    });
  });

  describe('Stream failure scenarios', () => {
    it('tool result persisted but stream failed before re-stream → orphaned', () => {
      // Simulate: the tool loop executed tools and persisted results,
      // but the re-stream failed. The conversation now has tool results
      // but no final assistant message to close the turn.
      const tc1 = nextId('tc');
      const conv: SimMessage[] = [
        { id: 'u1', role: 'user', content: 'read file' },
        { id: 'a1', role: 'assistant', content: '', tool_calls: [
          { id: tc1, name: 'lc_read_file', arguments: '{}' },
        ]},
        { id: 't1', role: 'tool', content: 'file contents here', tool_call_id: tc1 },
        // No final assistant message — stream crashed before re-stream
      ];
      // This is actually valid: the last message is tool, and all
      // tool calls are resolved.  The next request will include the
      // tool result and the model will continue.
      const errors = validateConversation(conv);
      assert.deepEqual(errors, [],
        'tool results without final assistant are valid — model can continue');
    });

    it('stream failed mid-tool-execution: some results persisted, others missing', () => {
      const tc1 = nextId('tc');
      const tc2 = nextId('tc');
      const conv: SimMessage[] = [
        { id: 'u1', role: 'user', content: 'do two things' },
        { id: 'a1', role: 'assistant', content: '', tool_calls: [
          { id: tc1, name: 'lc_read_file', arguments: '{}' },
          { id: tc2, name: 'lc_grep', arguments: '{}' },
        ]},
        { id: 't1', role: 'tool', content: 'r1', tool_call_id: tc1 },
        // tc2 result never persisted — stream crashed during execution
      ];
      const errors = validateConversation(conv);
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => e.includes('unresolved')));
    });

    it('stream failed after tool results but before finalizeLast', () => {
      // The assistant message may still have streaming: true if the
      // finalize didn't occur. This is a cleanup concern.
      const tc1 = nextId('tc');
      const conv: SimMessage[] = [
        { id: 'u1', role: 'user', content: 'x' },
        { id: 'a1', role: 'assistant', content: '...', tool_calls: [
          { id: tc1, name: 'lc_read_file', arguments: '{}' },
        ]},
        { id: 't1', role: 'tool', content: 'r1', tool_call_id: tc1 },
        { id: 'a2', role: 'assistant', content: '', streaming: true }, // unfinished
      ];
      const errors = validateConversation(conv);
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => e.includes('streaming')));
    });
  });

  describe('Provider-valid ordering (OpenAI / Anthropic specs)', () => {
    it('OpenAI: tool role must immediately follow assistant with tool_calls', () => {
      // OpenAI spec: messages must alternate user/assistant/tool.
      // After an assistant with tool_calls, the next messages must be
      // tool messages until all tool_calls are resolved.
      const tc1 = nextId('tc');
      const tc2 = nextId('tc');

      // VALID: tools follow assistant directly
      const valid: SimMessage[] = [
        { id: 'u1', role: 'user', content: 'x' },
        { id: 'a1', role: 'assistant', content: '', tool_calls: [
          { id: tc1, name: 'a', arguments: '{}' },
          { id: tc2, name: 'b', arguments: '{}' },
        ]},
        { id: 't1', role: 'tool', content: 'r1', tool_call_id: tc1 },
        { id: 't2', role: 'tool', content: 'r2', tool_call_id: tc2 },
      ];
      assert.deepEqual(validateConversation(valid), []);

      // INVALID: user message interleaved between tool results
      const invalid: SimMessage[] = [
        { id: 'u1', role: 'user', content: 'x' },
        { id: 'a1', role: 'assistant', content: '', tool_calls: [
          { id: tc1, name: 'a', arguments: '{}' },
        ]},
        { id: 't1', role: 'tool', content: 'r1', tool_call_id: tc1 },
        { id: 'u2', role: 'user', content: 'interrupting!' }, // breaks tool sequence
        { id: 't2', role: 'tool', content: 'too late', tool_call_id: tc1 }, // orphaned
      ];
      const errors = validateConversation(invalid);
      assert.ok(errors.length > 0);
    });
  });

});
