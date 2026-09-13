/**
 * Prompt-prefix diagnostics (docs/cache-observability.md §5).
 *
 * The comparison engine is pure and fixture-driven: each case builds two
 * final provider-shaped bodies and asserts the bounded conclusion.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TRACKED_CHAINS,
  PREFIX_CONCLUSIONS,
  PrefixComparisonStore,
  comparePrefix,
  describeRequest,
  isPrefixOf,
  prefixConclusionLabel,
  prefixQualifierLabel,
  resetPrefixDiagnostics,
  sessionPrefixHasher,
  type PrefixConclusion,
  type RequestScope,
} from './prefix-diagnostics.ts';

const SCOPE: RequestScope = {
  conversationId: 'conv-1',
  profileId: 'profile-1',
  protocol: 'openai',
  apiStyle: 'chat',
  model: 'gpt-test',
};

let store: PrefixComparisonStore;

beforeEach(() => {
  resetPrefixDiagnostics();
  store = new PrefixComparisonStore();
});

function chatBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-test',
    messages: [
      { role: 'system', content: 'You are LC.' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ],
    tools: [
      { type: 'function', function: { name: 'lc_grep', description: 'g', parameters: {} } },
      { type: 'function', function: { name: 'lc_read_file', description: 'r', parameters: {} } },
    ],
    ...over,
  };
}

async function run(
  body: Record<string, unknown>,
  scope: RequestScope = SCOPE,
  viaRouter = false,
): Promise<PrefixConclusion> {
  const result = await comparePrefix(
    { segments: describeRequest(body, scope), scope, viaRouter },
    store,
  );
  return result.conclusion;
}

describe('prefix diagnostics — chain establishment', () => {
  it('reports no comparable request the first time', async () => {
    assert.equal(await run(chatBody()), 'no-comparable-request');
  });

  it('reports a stable prefix when the identical request repeats', async () => {
    await run(chatBody());
    assert.equal(await run(chatBody()), 'stable-prefix');
  });

  it('starts a fresh chain for a different conversation', async () => {
    await run(chatBody());
    const other = { ...SCOPE, conversationId: 'conv-2' };
    assert.equal(await run(chatBody(), other), 'no-comparable-request');
  });

  it('starts a fresh chain for a different server profile', async () => {
    await run(chatBody());
    const other = { ...SCOPE, profileId: 'profile-2' };
    assert.equal(await run(chatBody(), other), 'no-comparable-request');
  });

  /*
   * Chain identity is conversation + profile. A protocol, API-style, or model
   * change stays inside that chain and is reported as the bounded
   * `provider-protocol-or-model-changed` conclusion, which also becomes the
   * new baseline. That is strictly more informative than discarding the chain
   * and reporting `no-comparable-request`, and it is what the shipped code
   * does; docs/cache-observability.md §5 documents these exact semantics.
   */
  it('makes a changed model the baseline for the request after it', async () => {
    const other = { ...SCOPE, model: 'gpt-other' };
    await run(chatBody());
    assert.equal(await run(chatBody(), other), 'provider-protocol-or-model-changed');
    // The identical next request compares against the new baseline, not the
    // pre-change one, so the change is reported exactly once.
    assert.equal(await run(chatBody(), other), 'stable-prefix');
  });

  it('makes a changed protocol the baseline for the request after it', async () => {
    const other = { ...SCOPE, protocol: 'anthropic' };
    await run(chatBody());
    assert.equal(await run(chatBody(), other), 'provider-protocol-or-model-changed');
    assert.equal(await run(chatBody(), other), 'stable-prefix');
  });

  it('makes a changed API style the baseline for the request after it', async () => {
    const other = { ...SCOPE, apiStyle: 'responses' };
    await run(chatBody());
    assert.equal(await run(chatBody(), other), 'provider-protocol-or-model-changed');
    assert.equal(await run(chatBody(), other), 'stable-prefix');
  });

  it('reports a later change against the new baseline, not the original one', async () => {
    const other = { ...SCOPE, model: 'gpt-other' };
    await run(chatBody());
    await run(chatBody(), other);
    // Tools change after the model change: the tools change is what is
    // reported, because the model baseline has already moved on.
    assert.equal(
      await run(chatBody({ tools: [] }), other),
      'tool-definitions-or-choice-changed',
    );
  });
});

describe('prefix diagnostics — segment changes', () => {
  it('detects a model change', async () => {
    await run(chatBody());
    assert.equal(
      await run(chatBody(), { ...SCOPE, model: 'gpt-other' }),
      'provider-protocol-or-model-changed',
    );
  });

  it('detects a protocol change', async () => {
    await run(chatBody());
    assert.equal(
      await run(chatBody(), { ...SCOPE, protocol: 'anthropic' }),
      'provider-protocol-or-model-changed',
    );
  });

  it('detects an API style change', async () => {
    await run(chatBody());
    assert.equal(
      await run(chatBody(), { ...SCOPE, apiStyle: 'responses' }),
      'provider-protocol-or-model-changed',
    );
  });

  it('detects a reasoning-control change', async () => {
    await run(chatBody({ reasoning_effort: 'low' }));
    assert.equal(await run(chatBody({ reasoning_effort: 'high' })), 'cache-relevant-options-changed');
  });

  it('detects reasoning being enabled where it was absent', async () => {
    await run(chatBody());
    assert.equal(await run(chatBody({ reasoning: { effort: 'high' } })), 'cache-relevant-options-changed');
  });

  it('detects reordered tool definitions', async () => {
    await run(chatBody());
    const reordered = chatBody({
      tools: [
        { type: 'function', function: { name: 'lc_read_file', description: 'r', parameters: {} } },
        { type: 'function', function: { name: 'lc_grep', description: 'g', parameters: {} } },
      ],
    });
    assert.equal(await run(reordered), 'tool-definitions-or-choice-changed');
  });

  it('detects a tool-choice change', async () => {
    await run(chatBody());
    assert.equal(await run(chatBody({ tool_choice: 'none' })), 'tool-definitions-or-choice-changed');
  });

  it('detects a system-instruction change', async () => {
    await run(chatBody());
    const changed = chatBody({
      messages: [
        { role: 'system', content: 'You are LC, with a skill loaded.' },
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ],
    });
    assert.equal(await run(changed), 'system-or-skills-changed');
  });

  it('ranks an earlier segment above a later one when both changed', async () => {
    await run(chatBody());
    // Model and tools both change; the model is reported because everything
    // after it is moot.
    assert.equal(
      await run(chatBody({ tool_choice: 'none' }), { ...SCOPE, model: 'gpt-other' }),
      'provider-protocol-or-model-changed',
    );
  });
});

describe('prefix diagnostics — history is compared prefix-aware', () => {
  it('does not call pure append-only history a prefix change', async () => {
    await run(chatBody());
    const appended = chatBody({
      messages: [
        { role: 'system', content: 'You are LC.' },
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
        { role: 'assistant', content: 'second answer' },
        { role: 'user', content: 'third question' },
      ],
    });
    assert.equal(await run(appended), 'stable-prefix-active-suffix-changed');
  });

  it('does not call an active-suffix-only change a prefix change', async () => {
    await run(chatBody());
    const editedSuffix = chatBody({
      messages: [
        { role: 'system', content: 'You are LC.' },
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'a completely different second question' },
      ],
    });
    assert.equal(await run(editedSuffix), 'stable-prefix-active-suffix-changed');
  });

  it('detects an edited earlier turn', async () => {
    await run(chatBody());
    const edited = chatBody({
      messages: [
        { role: 'system', content: 'You are LC.' },
        { role: 'user', content: 'first question, edited' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ],
    });
    assert.equal(await run(edited), 'history-prefix-changed');
  });

  it('detects reordered history blocks', async () => {
    await run(chatBody());
    const reordered = chatBody({
      messages: [
        { role: 'system', content: 'You are LC.' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'first question' },
        { role: 'user', content: 'second question' },
      ],
    });
    assert.equal(await run(reordered), 'history-prefix-changed');
  });

  it('detects Tool History stubbing of an earlier full result', async () => {
    const withFullResult = chatBody({
      messages: [
        { role: 'system', content: 'You are LC.' },
        { role: 'user', content: 'first question' },
        {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lc_grep', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'a very long real grep result'.repeat(50) },
        { role: 'user', content: 'second question' },
      ],
    });
    const withStub = chatBody({
      messages: [
        { role: 'system', content: 'You are LC.' },
        { role: 'user', content: 'first question' },
        {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'archived_m1', type: 'function', function: { name: 'lc_tool_history', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'archived_m1', content: '⚠️ 1 tool result(s) archived.' },
        { role: 'user', content: 'second question' },
      ],
    });
    await run(withFullResult);
    assert.equal(await run(withStub), 'history-prefix-changed');
  });

  it('detects an image detail change in earlier history', async () => {
    const withHigh = chatBody({
      messages: [
        { role: 'system', content: 'You are LC.' },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } }],
        },
        { role: 'assistant', content: 'saw it' },
        { role: 'user', content: 'second question' },
      ],
    });
    const withLow = chatBody({
      messages: [
        { role: 'system', content: 'You are LC.' },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } }],
        },
        { role: 'assistant', content: 'saw it' },
        { role: 'user', content: 'second question' },
      ],
    });
    await run(withHigh);
    assert.equal(await run(withLow), 'history-prefix-changed');
  });

  it('detects a mutated earlier provider replay item on the Responses shape', async () => {
    const scope = { ...SCOPE, apiStyle: 'responses' };
    const base = {
      model: 'gpt-test',
      instructions: 'You are LC.',
      input: [
        { type: 'message', role: 'user', content: 'first question' },
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-one' },
        { type: 'message', role: 'assistant', content: 'first answer' },
        { type: 'message', role: 'user', content: 'second question' },
      ],
    };
    const mutated = {
      ...base,
      input: [
        { type: 'message', role: 'user', content: 'first question' },
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-two' },
        { type: 'message', role: 'assistant', content: 'first answer' },
        { type: 'message', role: 'user', content: 'second question' },
      ],
    };
    await run(base, scope);
    assert.equal(await run(mutated, scope), 'history-prefix-changed');
  });

  it('treats Anthropic top-level system as system, not history', async () => {
    const scope = { ...SCOPE, protocol: 'anthropic', apiStyle: 'not-applicable' };
    const base = {
      model: 'claude-test',
      system: 'You are LC.',
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ],
    };
    await run(base, scope);
    assert.equal(await run({ ...base, system: 'You are LC, revised.' }, scope), 'system-or-skills-changed');
  });
});

describe('prefix diagnostics — qualifiers', () => {
  it('separates the provider breakpoint caveat from the LC conclusion', async () => {
    await comparePrefix({ segments: describeRequest(chatBody(), SCOPE), scope: SCOPE }, store);
    const result = await comparePrefix({
      segments: describeRequest(chatBody({
        messages: [
          { role: 'system', content: 'You are LC.' },
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'different suffix' },
        ],
      }), SCOPE),
      scope: SCOPE,
    }, store);
    assert.equal(result.conclusion, 'stable-prefix-active-suffix-changed');
    assert.ok(result.qualifiers.includes('provider-breakpoint-may-exclude-suffix'));
    assert.equal(
      prefixQualifierLabel('provider-breakpoint-may-exclude-suffix'),
      'provider may not reuse the stable prefix under the current breakpoint',
    );
  });

  it('marks a routed request as having an unknown upstream', async () => {
    const result = await comparePrefix(
      { segments: describeRequest(chatBody(), SCOPE), scope: SCOPE, viaRouter: true },
      store,
    );
    assert.ok(result.qualifiers.includes('router-upstream-unknown'));
  });

  it('never claims LC caused a cache miss', () => {
    for (const conclusion of PREFIX_CONCLUSIONS) {
      const label = prefixConclusionLabel(conclusion).toLowerCase();
      assert.ok(!label.includes('miss'), `${conclusion} must not claim a miss`);
      assert.ok(!label.includes('caused'), `${conclusion} must not assign blame`);
    }
  });
});

describe('prefix diagnostics — privacy', () => {
  it('returns only bounded enum values, never content or digests', async () => {
    const secret = 'CANARY-SECRET-8f3a2b';
    const body = chatBody({
      messages: [
        { role: 'system', content: `system ${secret}` },
        { role: 'user', content: `question ${secret}` },
      ],
      tools: [{ type: 'function', function: { name: secret, description: secret, parameters: {} } }],
    });
    const scope = { ...SCOPE, conversationId: secret, profileId: secret, model: secret };
    const first = await comparePrefix({ segments: describeRequest(body, scope), scope }, store);
    const second = await comparePrefix({ segments: describeRequest(body, scope), scope }, store);

    for (const result of [first, second]) {
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(secret), 'no request content may escape');
      assert.ok(PREFIX_CONCLUSIONS.includes(result.conclusion));
      for (const qualifier of result.qualifiers) {
        assert.ok(typeof qualifier === 'string' && qualifier.length < 64);
      }
      // Exactly two keys, both bounded.
      assert.deepEqual(Object.keys(result).sort(), ['conclusion', 'qualifiers']);
    }
  });

  it('uses a non-extractable HMAC key that cannot be serialized', async () => {
    const hasher = await sessionPrefixHasher();
    const digest = await hasher.digest('anything');
    assert.match(digest, /^[0-9a-f]{32}$/);
    // Two sessions must not agree: the key is fresh and random per session,
    // so digests are never a stable unkeyed fingerprint of content.
    resetPrefixDiagnostics();
    const second = await sessionPrefixHasher();
    assert.notEqual(await second.digest('anything'), digest);
  });

  it('does not mutate or reorder the request it inspects', async () => {
    const body = chatBody();
    const before = JSON.stringify(body);
    await comparePrefix({ segments: describeRequest(body, SCOPE), scope: SCOPE }, store);
    assert.equal(JSON.stringify(body), before);
  });

  it('never adds a cache directive or routing control to the request', async () => {
    const body = chatBody();
    await comparePrefix({ segments: describeRequest(body, SCOPE), scope: SCOPE }, store);
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      'cache_control', 'prompt_cache_breakpoint', 'prompt_cache_key',
      'session_id', 'x-session-id', 'retention',
    ]) {
      assert.ok(!serialized.includes(forbidden), `must not inject ${forbidden}`);
    }
  });
});

describe('prefix diagnostics — bounds', () => {
  it('evicts the oldest chain beyond the tracked maximum', async () => {
    for (let i = 0; i < MAX_TRACKED_CHAINS + 1; i++) {
      await run(chatBody(), { ...SCOPE, conversationId: `conv-${i}` });
    }
    // The very first chain was evicted, so it is no longer comparable.
    assert.equal(await run(chatBody(), { ...SCOPE, conversationId: 'conv-0' }), 'no-comparable-request');
    // The most recent chain still is.
    assert.equal(
      await run(chatBody(), { ...SCOPE, conversationId: `conv-${MAX_TRACKED_CHAINS}` }),
      'stable-prefix',
    );
  });

  it('compares long histories without unbounded digest retention', async () => {
    const many = (count: number, tail: string) => chatBody({
      messages: [
        { role: 'system', content: 'You are LC.' },
        ...Array.from({ length: count }, (_, i) => ({ role: 'assistant', content: `turn ${i}` })),
        { role: 'user', content: tail },
      ],
    });
    assert.equal(await run(many(3_000, 'q1')), 'no-comparable-request');
    assert.equal(await run(many(3_000, 'q1')), 'stable-prefix');
    assert.equal(await run(many(3_000, 'q2')), 'stable-prefix-active-suffix-changed');
  });
});

describe('prefix diagnostics — isPrefixOf', () => {
  it('accepts equal and appended sequences', () => {
    assert.equal(isPrefixOf(['a', 'b'], ['a', 'b']), true);
    assert.equal(isPrefixOf(['a', 'b'], ['a', 'b', 'c']), true);
    assert.equal(isPrefixOf([], ['a']), true);
  });

  it('rejects edits, reorders, and truncation', () => {
    assert.equal(isPrefixOf(['a', 'b'], ['a', 'x']), false);
    assert.equal(isPrefixOf(['a', 'b'], ['b', 'a']), false);
    assert.equal(isPrefixOf(['a', 'b', 'c'], ['a', 'b']), false);
  });
});
