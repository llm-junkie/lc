/** Synthetic documentation projections, 2026-09-04. No live/provider acceptance claim.
 * Sources: https://ai.google.dev/gemini-api/docs/streaming and
 * https://ai.google.dev/api/interactions-api#CreateInteraction-function_calling.
 * All IDs, signatures, outputs, and usage amounts below are test data.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiRestAdapter, validateGeminiBaseUrl } from './gemini-rest.ts';
import { LLMClient } from '../client.ts';
import { ToolCallAccumulator } from '../tool-accumulator.ts';
import { resolveBundledProviderContract } from '../provider-contracts.ts';
import { GEMINI_MAX_CHARS, geminiInput, normalizeGeminiUsage, validateGeminiGroups, type GeminiInteractionGroup } from '../gemini-state.ts';
import { projectAssistantProviderHistory } from '../../chat-pipeline/provider-history-projection.ts';
import { TurnUsageAccumulator } from '../../chat-pipeline/turn-usage-accumulator.ts';
import { persistedMessageSnapshot } from '../../../store/db.ts';
import { endpointForProfile, endpointLetter, endpointTone } from '../../../utils/reply-meta.ts';
import type { AdapterRequestParams } from './adapter';
import type { ChatMessage } from '../types';
import { presentUsage } from '../../../ui/chat/usage-detail.ts';
import { DEFAULT_PARAMS, type Conversation } from '../../../types.ts';
import { loadMessages, replaceMessages, saveMeta } from '../../../store/db.ts';
import { buildArchive, readArchive } from '../../../utils/exportArchive.ts';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
const model = 'gemini-3.8-flash';
const contract = resolveBundledProviderContract({ baseUrl, modelId: model, protocol: 'gemini-interactions' })!;
const params: AdapterRequestParams = { model, baseUrl, stream: true, reasoningEnabled: true,
  reasoningEffort: 'high', providerContract: contract, messages: [{ role: 'user', content: 'Hello' }] };
const usage = { total_input_tokens: 100, total_output_tokens: 25, total_thought_tokens: 10,
  total_tokens: 135, total_cached_tokens: 30, total_tool_use_tokens: 50 };
const adapter = () => new GeminiRestAdapter(baseUrl);
function group(id = 'a', steps: GeminiInteractionGroup['steps'] = []): GeminiInteractionGroup {
  return { schemaVersion: 1, responseId: id, origin: { baseUrl, model }, steps, complete: true, usage,
    thoughtStepIndexes: steps.flatMap((step, index) => step.type === 'thought' ? [index] : []) };
}
function stream(events: Record<string, unknown>[], width = 11): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events.map((event) => `event: ${event.event_type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += width) controller.enqueue(bytes.slice(offset, offset + width));
    controller.close();
  } });
}
function events(tool = false): Record<string, unknown>[] {
  return [
    { event_type: 'interaction.created', interaction: { id: 'test-response', model, status: 'in_progress' } },
    { event_type: 'step.start', index: 0, step: { type: 'thought', extra: 'retained' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'Summary café' } } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'synthetic opaque +/==' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: tool ? { type: 'function_call', id: 'call-1', name: 'read' } : { type: 'model_output' } },
    { event_type: 'step.delta', index: 1, delta: tool ? { type: 'arguments_delta', arguments: '{"path":' } : { type: 'text', text: 'Héllo 🌍' } },
    ...(tool ? [{ event_type: 'step.delta', index: 1, delta: { type: 'arguments_delta', arguments: '"x"}' } }] : []),
    { event_type: 'step.stop', index: 1 },
    { event_type: 'interaction.completed', interaction: { id: 'test-response', status: tool ? 'requires_action' : 'completed', usage } },
  ];
}

test('Gemini exact root, native controls, JSON schema, and protocol badges', () => {
  assert.equal(contract.contract.status, 'partially-verified');
  for (const suffix of ['/openai', '/interactions', '/models/x']) {
    assert.equal(resolveBundledProviderContract({ baseUrl: baseUrl + suffix, protocol: 'gemini-interactions' }), undefined);
    assert.throws(() => validateGeminiBaseUrl(baseUrl + suffix));
  }
  assert.equal(resolveBundledProviderContract({ baseUrl: baseUrl + '/', protocol: 'gemini-interactions' })?.contract.id, contract.contract.id);
  assert.equal(resolveBundledProviderContract({ baseUrl, protocol: 'openai-chat' }), undefined);
  for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const body = adapter().buildRequest({ ...params, reasoningEffort: effort, temperature: 0.4, topP: 0.8, topK: 20 });
    assert.deepEqual(body.generation_config, { thinking_level: effort, thinking_summaries: 'auto' });
    assert.equal(body.store, false);
    assert.equal(body.previous_interaction_id, undefined);
  }
  assert.deepEqual(adapter().buildRequest({ ...params, reasoningEnabled: false }).generation_config, { thinking_summaries: 'auto' });
  assert.equal(adapter().buildRequest({ ...params, providerContract: undefined, providerContractStatus: 'unmatched' }).generation_config, undefined);
  const format = { type: 'text' as const, mime_type: 'application/json' as const, schema: { type: 'object' } };
  assert.deepEqual(adapter().buildRequest({ ...params, responseFormat: format }).response_format, format);
  assert.equal(endpointForProfile('gemini', 'responses'), '/interactions');
  for (const [path, badge, tone] of [
    ['/interactions', 'I', 'gemini'], ['/chat', 'C', 'lmstudio'],
    ['/chat/completions', 'CC', 'openai'], ['/responses', 'R', 'openai'], ['/messages', 'M', 'anthropic'],
  ] as const) {
    assert.equal(endpointLetter(path), badge); assert.equal(endpointTone(path), tone);
  }
  assert.equal(endpointLetter(undefined), 'O');
});

test('native SSE preserves signatures, summaries, UTF-8, and argument fragments', async () => {
  for (const tool of [false, true]) {
    let content = ''; let reasoning = '';
    const result = await adapter().parseStream(stream(events(tool), 1), {
      onDelta: (text) => { content += text; }, onReasoning: (text) => { reasoning += text; },
    }, 1000, new ToolCallAccumulator());
    assert.equal(result.finish_reason, tool ? 'tool_calls' : 'stop');
    assert.equal(reasoning, 'Summary café');
    assert.equal(content, tool ? '' : 'Héllo 🌍');
    assert.equal(result.gemini_interactions?.[0].steps[0].signature, 'synthetic opaque +/==');
    assert.equal(result.gemini_interactions?.[0].steps[0].extra, 'retained');
    assert.equal(result.usage?.completion_tokens, 35);
    assert.equal(result.usage?.total_tokens, 135);
    if (tool) assert.equal(result.tool_calls?.[0].function.arguments, '{"path":"x"}');
  }
});

test('stateless streams accept empty or absent interaction IDs and keep unique local groups', async () => {
  const groups: GeminiInteractionGroup[] = [];
  for (const id of ['', undefined, null]) {
    const fixture = events().map((event) => event.interaction
      ? { ...event, interaction: { ...event.interaction as Record<string, unknown>, id } } : event);
    let content = '';
    const result = await adapter().parseStream(stream(fixture), {
      onDelta: (delta) => { content += delta; },
    }, 1000, new ToolCallAccumulator());
    assert.equal(result.finish_reason, 'stop', result.error_message ?? 'Expected a complete response.');
    assert.equal(content, 'Héllo 🌍');
    assert.equal(result.usage?.total_tokens, 135);
    const retained = result.gemini_interactions![0];
    assert.match(retained.responseId, /^local-/);
    assert.equal(retained.complete, true);
    assert.equal(retained.steps[0].signature, 'synthetic opaque +/==');
    groups.push(retained);
  }
  assert.equal(new Set(groups.map((entry) => entry.responseId)).size, groups.length);
  const saved = persistedMessageSnapshot({ id: 'stateless', role: 'assistant', content: '', createdAt: 1,
    gemini_interactions: groups });
  assert.deepEqual(saved.gemini_interactions, groups);
  assert.deepEqual(geminiInput([{ role: 'assistant', content: saved.content,
    gemini_interactions: saved.gemini_interactions }], { baseUrl, model }), groups.flatMap((entry) => entry.steps));
});

test('opaque interaction IDs survive metadata restatements and use the whole-state size bound', async () => {
  const longId = `v1_${'x'.repeat(2048)}`;
  for (const [initialId, terminalId, expectedId] of [
    ['created-id', '', 'created-id'],
    ['', 'terminal-id', 'terminal-id'],
    [longId, longId, longId],
  ]) {
    const fixture = events().map((event) => event.interaction
      ? { ...event, interaction: { ...event.interaction as Record<string, unknown>,
        id: event.event_type === 'interaction.created' ? initialId : terminalId } } : event);
    const result = await adapter().parseStream(stream(fixture, 1024), { onDelta() {} }, 1000, new ToolCallAccumulator());
    assert.equal(result.finish_reason, 'stop', result.error_message ?? 'Expected a complete response.');
    assert.equal(result.gemini_interactions?.[0].responseId, expectedId);
    const saved = persistedMessageSnapshot({ id: 'opaque-id', role: 'assistant', content: '', createdAt: 1,
      gemini_interactions: result.gemini_interactions });
    assert.equal(saved.gemini_interactions?.[0].responseId, expectedId);
  }
  assert.throws(() => validateGeminiGroups([group('x'.repeat(GEMINI_MAX_CHARS))]), /size limit/);
});

test('partial streams retain state but cannot execute calls or replay', async () => {
  const result = await adapter().parseStream(stream(events(true).slice(0, -2)), { onDelta() {} }, 1000, new ToolCallAccumulator());
  assert.equal(result.finish_reason, 'disconnected');
  assert.equal(result.tool_calls, undefined);
  assert.equal(result.gemini_interactions?.[0].complete, false);
  assert.throws(() => geminiInput([{ role: 'assistant', content: '', gemini_interactions: result.gemini_interactions }], { baseUrl, model }));
});

test('whole native response groups precede parallel results and subsequent responses', () => {
  const first = group('a', [{ type: 'thought', signature: 'test-a' },
    { type: 'function_call', id: 'a1', name: 'read', arguments: {} },
    { type: 'model_output', content: [{ type: 'text', text: 'between' }] },
    { type: 'function_call', id: 'a2', name: 'read', arguments: {} }]);
  const second = group('b', [{ type: 'thought', signature: 'test-b' },
    { type: 'function_call', id: 'b1', name: 'read', arguments: {} }]);
  const messages: ChatMessage[] = [{ role: 'assistant', content: 'between', gemini_interactions: [first, second] },
    { role: 'tool', tool_call_id: 'a2', content: 'two' }, { role: 'tool', tool_call_id: 'a1', content: 'one', tool_is_error: true },
    { role: 'user', name: 'lc-tool-images', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] },
    { role: 'tool', tool_call_id: 'b1', content: 'three' }];
  const input = geminiInput(messages, { baseUrl, model });
  assert.deepEqual(input.slice(0, 4), first.steps);
  assert.deepEqual(input.slice(4, 6).map((step) => step.call_id), ['a1', 'a2']);
  assert.equal(input[4].is_error, true);
  assert.equal(input[6].type, 'user_input');
  assert.deepEqual(input.slice(7, 9), second.steps);
  assert.equal(input[9].call_id, 'b1');
  const restored = persistedMessageSnapshot({ id: 'message', createdAt: 1, role: 'assistant', content: 'between', gemini_interactions: [first, second] });
  assert.deepEqual(restored.gemini_interactions, [first, second]);
  const wire: ChatMessage = { ...restored, tool_calls: undefined };
  const projection = projectAssistantProviderHistory(wire, { protocol: 'gemini-interactions', baseUrl, model,
    providerContract: contract, toolCallRewritten: true });
  assert.equal(projection.opaqueReasoningTokens, 20);
  assert.equal(projection.plaintextReasoningTexts.length, 0);
  assert.deepEqual(projection.geminiInteractions, [first, second]);
  const stale = projectAssistantProviderHistory({ ...wire, gemini_interactions: [{ ...first, thoughtStepIndexes: [2] }] },
    { protocol: 'gemini-interactions', baseUrl, model, providerContract: contract });
  assert.equal(stale.opaqueReasoningTokens, 0);
  assert.equal(stale.opaqueReasoningUnknown, true);
  const switched = projectAssistantProviderHistory(wire, { protocol: 'gemini-interactions', baseUrl,
    model: 'gemini-2.5-flash', providerContract: contract });
  assert.deepEqual(switched.geminiInteractions, [first, second]);
  assert.equal(switched.opaqueReasoningTokens, 0);
  assert.equal(switched.opaqueReasoningUnknown, true);
  assert.equal(projectAssistantProviderHistory(wire, { protocol: 'gemini-interactions', baseUrl: 'https://relay.test/v1beta', model }).geminiInteractions?.length, 0);
  assert.equal(projectAssistantProviderHistory(wire, { protocol: 'openai-chat', model }).useCanonicalReasoning, false);
  assert.throws(() => validateGeminiGroups([first, first]), /Invalid/);
});

test('usage snapshots settle once and missing counters stay partial', () => {
  const accumulator = new TurnUsageAccumulator();
  const normalized = normalizeGeminiUsage(usage)!;
  accumulator.addResponse('a', normalized);
  accumulator.addResponse('a', normalized);
  const partial = normalizeGeminiUsage({ total_tokens: 40 })!;
  assert.equal(partial.reasoning?.status, 'not-reported');
  accumulator.addResponse('b', partial);
  assert.equal(accumulator.snapshot('complete')?.total_tokens, 175);
  assert.equal(accumulator.snapshot('complete')?.terminalCoverage, 'partial');
  assert.equal(normalizeGeminiUsage({ total_input_tokens: 100, total_output_tokens: 25, total_thought_tokens: 0, total_tokens: 125, total_tool_use_tokens: 50 })?.total_tokens, 125);
});

test('LLMClient joins versioned URL once and chatOnce handles JSON/SSE without retries', async () => {
  let requests = 0;
  const client = new LLMClient({ baseUrl: baseUrl + '/', apiVariant: 'gemini', apiStyle: 'responses', apiKey: 'test-key', routing: 'direct',
    fetchImpl: async (url, init) => {
      requests++;
      const request = JSON.parse(String(init?.body));
      assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'test-key');
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      assert.deepEqual(request.generation_config, { thinking_level: 'high', thinking_summaries: 'auto' });
      assert.equal(String(url), baseUrl + '/interactions' + (request.stream ? '?alt=sse' : ''));
      return requests === 1 ? Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'json answer' }] }] })
        : new Response(stream(events()));
    } });
  assert.equal(await client.chatOnce({ ...params, providerContract: undefined }), 'json answer');
  assert.equal(await client.chatOnce(params), 'Héllo 🌍');
  assert.equal((await client.chatStream(params, { onDelta() {} })).finish_reason, 'stop');
  assert.equal(requests, 3);
});

test('invalid native completion never executes a tool and preserves interrupted arguments', async () => {
  const fixtures = [
    events(true).filter((event) => !(recordDelta(event)?.type === 'thought_signature')),
    events(true).map((event) => event.index === 1 ? { ...event, index: 2 } : event),
    [...events(true).slice(0, -1), { event_type: 'interaction.completed', interaction: { status: 'failed' } }],
  ];
  for (const fixture of fixtures) {
    const result = await adapter().parseStream(stream(fixture), { onDelta() {} }, 1000, new ToolCallAccumulator());
    assert.equal(result.finish_reason, 'error');
    assert.equal(result.tool_calls, undefined);
    assert.equal(result.gemini_interactions?.[0].complete, false);
  }
  const partial = await adapter().parseStream(stream(events(true).slice(0, 7)), { onDelta() {} }, 1000, new ToolCallAccumulator());
  assert.deepEqual(partial.gemini_interactions?.[0].incompleteDeltas,
    [{ index: 1, delta: { type: 'arguments_delta', arguments: '{"path":' } }]);
});

function recordDelta(event: Record<string, unknown>) { return event.delta as Record<string, unknown> | undefined; }

test('terminal-only steps and usage snapshots are authoritative, including signature-only thought', async () => {
  let answer = ''; let summary = '';
  const result = await adapter().parseStream(stream([
    { event_type: 'interaction.created', interaction: { usage: { total_input_tokens: 90 } } },
    { event_type: 'interaction.completed', interaction: { id: 'terminal', status: 'completed', usage,
      steps: [{ type: 'thought', signature: 'synthetic-empty-summary' },
        { type: 'model_output', content: [{ type: 'text', text: 'Terminal answer' }], extra: { retained: true } }] } },
  ]), { onDelta: (delta) => { answer += delta; }, onReasoning: (delta) => { summary += delta; } }, 1000, new ToolCallAccumulator());
  assert.equal(result.finish_reason, 'stop');
  assert.equal(answer, 'Terminal answer');
  assert.equal(summary, '');
  assert.equal(result.usage?.prompt_tokens, 100);
  assert.deepEqual(result.gemini_interactions?.[0].steps[1].extra, { retained: true });
});

test('partial native usage remains visibly incomplete after persistence', () => {
  const partial = normalizeGeminiUsage({ total_output_tokens: 12, total_tokens: 32 })!;
  const saved = persistedMessageSnapshot({ id: 'partial', createdAt: 1, role: 'assistant', content: '', usage: partial });
  assert.deepEqual(saved.usage?.tokenCoverage, { input: 'unreported', output: 'partial', total: 'reported' });
  const report = presentUsage(saved.usage).report!;
  assert.ok(report.groups.flat().some((row) => row.value === 'unreported'));
  assert.ok(report.groups.flat().some((row) => row.value === '≥12'));
});

test('helper and rejected effort errors surface after one native request', async () => {
  for (const response of [
    () => Response.json({ error: { message: 'unsupported thinking_level: xhigh' } }, { status: 400 }),
    () => Response.json({ status: 'failed', error: { message: 'native generation failed' } }),
    () => new Response(stream(events().slice(0, -1))),
  ]) {
    let requests = 0;
    const client = new LLMClient({ baseUrl, apiVariant: 'gemini', routing: 'direct', fetchImpl: async () => { requests++; return response(); } });
    await assert.rejects(client.chatOnce({ ...params, reasoningEffort: 'xhigh' }));
    assert.equal(requests, 1);
  }
});

test('native discovery pages preserve IDs, limits, auth and reject repeated tokens', async () => {
  let requests = 0;
  const client = new LLMClient({ baseUrl, apiVariant: 'gemini', apiKey: 'test', routing: 'direct', fetchImpl: async (url, init) => {
    requests++;
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'test');
    assert.equal(String(url), baseUrl + '/models' + (requests === 1 ? '' : '?pageToken=next'));
    return Response.json({ models: [{ name: `models/model-${requests}-preview`, displayName: 'Model', inputTokenLimit: 1000, outputTokenLimit: 200 }],
      ...(requests === 1 ? { nextPageToken: 'next' } : {}) });
  } });
  const models = await client.listModels();
  assert.deepEqual(models.map((entry) => entry.id), ['model-1-preview', 'model-2-preview']);
  assert.equal(models[0].source, 'gemini-rest');
  assert.equal(models[0].max_output_tokens, 200);
  const looping = new LLMClient({ baseUrl, apiVariant: 'gemini', fetchImpl: async () => Response.json({ models: [], nextPageToken: 'same' }) });
  await assert.rejects(looping.listModels(), /repeated/);
});

test('native replay survives IndexedDB and archive import; malformed state fails before restoration', async () => {
  const groups = [group('durable', [{ type: 'thought', signature: 'synthetic signature', summary: [] },
    { type: 'model_output', content: [{ type: 'text', text: 'saved answer' }] }])];
  const conversation: Conversation = { id: crypto.randomUUID(), title: 'Native test', createdAt: 1, updatedAt: 2, messageCount: 1,
    params: { ...DEFAULT_PARAMS }, model, messages: [{ id: 'saved', role: 'assistant', content: 'saved answer',
      createdAt: 2, gemini_interactions: groups, usage: normalizeGeminiUsage(usage), meta: { endpoint: '/interactions', baseUrl, model } }] };
  await saveMeta(conversation);
  await replaceMessages(conversation.id, conversation.messages);
  const [loaded] = await loadMessages(conversation.id);
  assert.deepEqual(loaded.gemini_interactions, groups);
  const archive = await buildArchive([{ ...conversation, messages: [loaded] }]);
  const [imported] = await readArchive({ arrayBuffer: () => archive.arrayBuffer() } as File);
  assert.deepEqual(imported.conversation.messages[0].gemini_interactions, groups);
  assert.equal(imported.conversation.messages[0].meta?.endpoint, '/interactions');
  const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  const payload = JSON.parse(strFromU8(entries['conversations.json']));
  payload.conversations[0].messages[0].gemini_interactions = [{ schemaVersion: 999 }];
  entries['conversations.json'] = strToU8(JSON.stringify(payload));
  const malformed = zipSync(entries);
  await assert.rejects(readArchive({ arrayBuffer: async () => malformed.buffer } as File), /Invalid Gemini replay state/);
});
