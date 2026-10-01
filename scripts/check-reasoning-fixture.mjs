// Copyright 2026 LC Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
// Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.

/** Verify the actual first SSE reasoning field from `fixture:providers`. */
import assert from 'node:assert/strict';
import { decodeSSE } from '../src/modules/llm-client/transport/sse-decoder.ts';

if (process.argv.includes('--help')) {
  console.log('Usage: npm run check:reasoning-fixture\nStart npm run fixture:providers first. LC_AUDIT_FIXTURE_URL defaults to http://127.0.0.1:4786.');
} else {
  assert.equal(process.argv.length, 2, 'No arguments expected; configure LC_AUDIT_FIXTURE_URL if needed.');
  const fixtureRoot = (process.env.LC_AUDIT_FIXTURE_URL || 'http://127.0.0.1:4786').replace(/\/+$/, '');
  const response = await fetch(`${fixtureRoot}/openai/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5_000),
    body: JSON.stringify({
      model: 'audit-openai-chat', stream: true,
      messages: [{ role: 'user', content: 'AUDIT_LONG_REASONING_MATH' }],
    }),
  });
  assert.equal(response.status, 200);
  assert.ok(response.body, 'Expected an SSE response body.');
  const events = decodeSSE(response.body, { validateJSON: true, idleTimeoutMs: 5_000 });
  try {
    const { value, done } = await events.next();
    assert.equal(done, false, 'Provider ended before its first SSE event.');
    assert.equal(value.type, 'event', 'Expected a valid JSON event.');
    const event = JSON.parse(value.event.data);
    const reasoning = event.choices?.[0]?.delta?.reasoning_content;
    // An independent literal catches missing or substituted delimiters too.
    assert.equal(reasoning, '$$\n' + 'x+y\n'.repeat(1000));
    assert.equal(event.choices[0].finish_reason, null);
    console.log(JSON.stringify({ chars: reasoning.length, prefix: reasoning.slice(0, 7), exactIntendedInput: true }));
  } finally {
    await events.return();
  }
}
