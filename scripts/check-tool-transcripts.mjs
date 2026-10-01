// Copyright 2026 LC Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
// Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.

/**
 * Check exported LC tool-call/result pairing and report historical recovery.
 * No archived command is executed. Failed tools and unchanged arguments are
 * observations, not gate failures or proof of a current product defect.
 * Run `npm run check:tool-transcripts -- --fixture` for known-answer controls.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeLcResultJson, repeatedToolCallNotice } from '../src/modules/tool-engine/tool-result-content.ts';
import { CHAT_ARCHIVE, ensureExtracted, extractedDir } from './fixture-lc-archives.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const failedStatuses = new Set(['error', 'partial', 'aborted', 'timeout']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
  return value;
}

function argumentsOf(call) {
  try { return canonical(JSON.parse(call.arguments)); }
  catch { return call.arguments; }
}

function scan(conversation) {
  assert.ok(isObject(conversation) && Array.isArray(conversation.messages), 'Expected an LC conversation with messages.');
  const calls = [];
  const results = new Map();
  let turn = 0;
  let round = 0;
  let toolResults = 0;
  let duplicateResultIds = 0;
  for (const message of conversation.messages) {
    assert.ok(isObject(message), 'Expected a message object.');
    if (message.role === 'user') turn += 1;
    if (message.role === 'assistant') {
      round += 1;
      assert.ok(message.tool_calls === undefined || Array.isArray(message.tool_calls), 'Expected a tool-call array.');
      for (const call of message.tool_calls ?? []) {
        assert.ok(isObject(call) && typeof call.id === 'string' && typeof call.name === 'string'
          && typeof call.arguments === 'string', 'Expected stored LC tool-call fields.');
        calls.push({ ...call, turn, round, model: message.meta?.model ?? conversation.model });
      }
    }
    if (message.role === 'tool') {
      assert.ok(typeof message.tool_call_id === 'string' && typeof message.content === 'string', 'Expected stored LC tool-result fields.');
      const key = JSON.stringify([turn, message.tool_call_id]);
      if (results.has(key)) duplicateResultIds += 1;
      results.set(key, message);
      toolResults += 1;
    }
  }

  const callKeys = new Set(calls.map((call) => JSON.stringify([call.turn, call.id])));
  const missingResults = [...callKeys].filter((key) => !results.has(key)).length;
  const orphanResults = [...results.keys()].filter((key) => !callKeys.has(key)).length;
  const decoded = new Map();
  let undecodedResults = 0;
  let noticeResults = 0;
  for (const [key, result] of results) {
    const value = decodeLcResultJson(result.content);
    if (!value || !isObject(value.data)) { undecodedResults += 1; continue; }
    decoded.set(key, value.data);
    if (value.notices.length) noticeResults += 1;
  }

  // Index later rounds once; large exports should not repeatedly scan suffixes.
  const nextCalls = new Map();
  const laterCalls = new Map();
  for (let end = calls.length; end > 0;) {
    let start = end - 1;
    while (start > 0 && calls[start - 1].round === calls[end - 1].round) start -= 1;
    for (let index = start; index < end; index += 1) {
      const call = calls[index];
      nextCalls.set(index, laterCalls.get(JSON.stringify([call.turn, call.name])));
    }
    for (let index = end - 1; index >= start; index -= 1) {
      const call = calls[index];
      laterCalls.set(JSON.stringify([call.turn, call.name]), call);
    }
    end = start;
  }

  const rejected = [];
  const entryErrors = [];
  for (const [index, call] of calls.entries()) {
    const data = decoded.get(JSON.stringify([call.turn, call.id]));
    if (!data) continue;
    // Older exports keep handler fields at the root; envelopes nest them.
    const payload = isObject(data.data) ? data.data : data;
    const failedEntries = ['results', 'images', 'files'].flatMap((key) =>
      Array.isArray(payload[key]) ? payload[key] : [],
    ).filter((entry) => typeof entry?.error === 'string' && entry.error.length > 0);
    if (failedEntries.length) entryErrors.push({ id: call.id, tool: call.name, count: failedEntries.length });
    if (!failedStatuses.has(data.status)) continue;
    // A sibling in the same batch cannot be a response to this result.
    const next = nextCalls.get(index);
    const previousArgs = argumentsOf(call);
    const nextArgs = next ? argumentsOf(next) : undefined;
    const keys = new Set([
      ...Object.keys(isObject(previousArgs) ? previousArgs : {}),
      ...Object.keys(isObject(nextArgs) ? nextArgs : {}),
    ]);
    rejected.push({
      id: call.id, tool: call.name, turn: call.turn, model: call.model, status: data.status,
      issueCodes: Array.isArray(data.issues) ? data.issues.map((issue) => issue?.code).filter((code) => typeof code === 'string') : [],
      nextSameTool: next?.id ?? null,
      repeatedArguments: next ? JSON.stringify(previousArgs) === JSON.stringify(nextArgs) : null,
      changedFields: next ? [...keys].filter((key) => JSON.stringify(previousArgs?.[key]) !== JSON.stringify(nextArgs?.[key])) : [],
    });
  }
  return {
    id: conversation.id, title: conversation.title,
    models: [...new Set(calls.map((call) => call.model).filter(Boolean))],
    calls: calls.length, toolResults,
    duplicateCallIds: calls.length - callKeys.size, duplicateResultIds,
    missingResults, orphanResults, undecodedResults, noticeResults, entryErrors, rejected,
  };
}

function hasPairingFailure(result) {
  return result.missingResults + result.orphanResults + result.undecodedResults + result.duplicateResultIds > 0;
}

function fixtureControls() {
  const call = (id, args = '{"paths":[],"encoding":"utf8"}') => ({ id, name: 'lc_read_file', arguments: args });
  const assistant = (...tool_calls) => ({ role: 'assistant', tool_calls });
  const result = (id, content = '{"status":"ok","data":{"results":[]}}') => ({ role: 'tool', tool_call_id: id, content });
  const failure = '{"status":"error","issues":[{"code":"invalid_arguments"}]}';
  const messages = [
    { role: 'user' }, assistant(call('a')), result('a', failure),
    assistant(call('b')), result('b'),
  ];
  const run = (items) => scan({ id: 'control', model: 'fixture', messages: items });
  assert.equal(run(messages).rejected[0].repeatedArguments, true);
  const reordered = structuredClone(messages);
  reordered[3].tool_calls[0].arguments = '{"encoding":"utf8","paths":[]}';
  assert.equal(run(reordered).rejected[0].repeatedArguments, true);
  reordered[3].tool_calls[0].arguments = '{"paths":["C:/fixture"],"encoding":"utf8"}';
  assert.equal(run(reordered).rejected[0].repeatedArguments, false);
  assert.deepEqual(run(reordered).rejected[0].changedFields, ['paths']);
  assert.equal(run([...messages.slice(0, 3), { role: 'user' }, ...messages.slice(3)]).rejected[0].nextSameTool, null);
  const siblings = [{ role: 'user' }, assistant(call('a'), call('b')), result('a', failure), result('b')];
  assert.equal(run(siblings).rejected[0].nextSameTool, null);
  assert.equal(run([...siblings, assistant(call('c')), result('c')]).rejected[0].nextSameTool, 'c');
  assert.equal(run(messages.slice(0, -1)).missingResults, 1);
  assert.equal(hasPairingFailure(run(messages.slice(0, -1))), true);
  assert.equal(run([result('orphan')]).orphanResults, 1);
  assert.equal(run([assistant(call('a')), result('a'), result('a')]).duplicateResultIds, 1);
  assert.equal(run([assistant(call('a'), call('a')), result('a')]).duplicateCallIds, 1);
  const reused = [assistant(call('a')), result('a'), { role: 'user' }, assistant(call('a'))];
  assert.equal(run(reused).missingResults, 1, 'A previous turn must not supply this result.');
  assert.equal(run([...reused, result('a')]).duplicateCallIds, 0);
  for (const content of ['{"results":[{"error":"legacy failure"}]}', '{"status":"partial","data":{"files":[{"error":"nested failure"}]}}']) {
    assert.equal(run([assistant(call('a')), result('a', content)]).entryErrors[0].count, 1);
  }
  assert.equal(run([assistant(call('a')), result('a', `${repeatedToolCallNotice('lc_read_file', 2)}\n\n${failure}`)]).noticeResults, 1);
  assert.equal(run([assistant(call('a')), result('a', '[unknown] notice\n\n{}')]).undecodedResults, 1);
  assert.equal(run([assistant(call('a')), result('a', 'null')]).undecodedResults, 1);
  assert.equal(hasPairingFailure(run(messages)), false, 'A tool error is not a pairing failure.');
  console.log('PASS tool transcript controls: ordering, turn boundaries, framing, pairing, and legacy/envelope entries.');
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: npm run check:tool-transcripts -- [conversations.json | --fixture]\nDefault: committed LC archive, extracted on demand. JSON report goes to stdout.');
} else if (args.length === 1 && args[0] === '--fixture') {
  fixtureControls();
} else {
  assert.ok(args.length <= 1 && !args[0]?.startsWith('--'), 'Use one JSON path or --fixture.');
  let source;
  if (args[0]) source = resolve(args[0]);
  else {
    await ensureExtracted();
    source = join(extractedDir(CHAT_ARCHIVE), 'conversations.json');
  }
  const bytes = readFileSync(source);
  const archive = JSON.parse(bytes.toString('utf8'));
  assert.ok(isObject(archive) && Array.isArray(archive.conversations), 'Expected an LC bulk export with conversations.');
  const results = archive.conversations.map(scan);
  const pairingFailures = results.filter(hasPairingFailure).length;
  console.log(JSON.stringify({
    source: relative(root, source).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    exportedAt: archive.exportedAt, pairingFailures, results,
  }, null, 2));
  if (pairingFailures) process.exitCode = 1;
}
