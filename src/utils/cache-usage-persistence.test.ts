/**
 * Persistence and archive round-trip coverage for provider cache usage.
 *
 * Cache usage must survive save, reload, archive export, and archive import
 * (docs/cache-observability.md §4). This exercises the **real** paths:
 *
 *   - `store/db.ts` `messageToRow`/`rowToMessage`, both through the exported
 *     `persistedMessageSnapshot` and through an actual Dexie round trip; and
 *   - `buildArchive` / `readArchive`, the functions export and import call.
 *
 * The previous version of this file round-tripped through local mirrors of
 * `JSON.stringify`/`parse`. Those tests proved the mirror, not the pipeline —
 * a field dropped in `messageToRow` would have passed them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { compressSync, strFromU8, strToU8 } from 'fflate';

import type { Conversation, Message } from '../types';
import type { AnthropicBlockOrderEntry } from '../modules/llm-client/types';
import type { NormalizedUsage } from '../modules/llm-client/cache-usage';
import type { PrefixDiagnostic } from '../modules/llm-client/prefix-diagnostics';

const [dbModule, archiveModule, typesModule] = await Promise.all([
  import('../store/db.ts'),
  import('./exportArchive.ts'),
  import('../types.ts'),
]);

const {
  loadMessages,
  persistedMessageSnapshot,
  replaceMessages,
  saveMeta,
  updateMessage,
} = dbModule;
const { buildArchive, readArchive } = archiveModule;
const { DEFAULT_PARAMS } = typesModule;

const RICH_USAGE: NormalizedUsage = {
  prompt_tokens: 17_620,
  completion_tokens: 340,
  total_tokens: 17_960,
  source: 'provider',
  cache: {
    status: 'reported',
    readTokens: 15_000,
    writeTokens: 2_500,
    missTokens: 0,
    writeTokensByTtl: { ephemeral5m: 2_000, ephemeral1h: 500 },
    reportedBy: 'provider',
    anomalies: ['ttl-breakdown-mismatch'],
  },
};

const PREFIX: PrefixDiagnostic = {
  conclusion: 'stable-prefix-active-suffix-changed',
  qualifiers: ['provider-breakpoint-may-exclude-suffix'],
};

function assistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-cache',
    role: 'assistant',
    content: 'answer',
    createdAt: 1_700_000_000_000,
    sortOrder: 2,
    ...overrides,
  };
}

function conversation(id: string, messages: Message[]): Conversation {
  return {
    id,
    title: 'cache chat',
    model: 'test-model',
    serverId: 'local',
    params: { ...DEFAULT_PARAMS },
    createdAt: 1,
    updatedAt: 2,
    messageCount: messages.length,
    messages,
  };
}

/** The exact shape a Dexie row round trip produces, via the shipped mapping. */
function throughRowMapping(message: Message): Message {
  return persistedMessageSnapshot(message);
}

/** A real IndexedDB write and read, not a mapping shortcut. */
async function throughDexie(message: Message): Promise<Message> {
  const id = `cache-persist-${crypto.randomUUID()}`;
  await saveMeta(conversation(id, [message]));
  await replaceMessages(id, [message]);
  const [loaded] = await loadMessages(id);
  return loaded;
}

/** A real zip export and import, not a JSON mirror. */
async function throughArchive(messages: Message[]): Promise<Message[]> {
  const id = `cache-archive-${crypto.randomUUID()}`;
  const blob = await buildArchive([conversation(id, messages)]);
  const imported = await readArchive({ arrayBuffer: () => blob.arrayBuffer() } as File);
  return imported[0].conversation.messages;
}

describe('cache usage survives the real Dexie mapping', () => {
  it('round-trips raw text that begins with the compression sentinel', async () => {
    const content = `Z:${strFromU8(compressSync(strToU8('different text')), true)}`;
    assert.notEqual(content, 'different text');

    const mapped = throughRowMapping(assistantMessage({ content }));
    assert.equal(mapped.content, content);

    const stored = await throughDexie(assistantMessage({
      id: `m-sentinel-${crypto.randomUUID()}`,
      content,
    }));
    assert.equal(stored.content, content);
  });

  it('round-trips every cache field through the row mapping', async () => {
    const mapped = throughRowMapping(assistantMessage({ usage: RICH_USAGE }));
    assert.deepEqual(mapped.usage, RICH_USAGE);

    const stored = await throughDexie(assistantMessage({ usage: RICH_USAGE }));
    assert.deepEqual(stored.usage, RICH_USAGE);
    assert.deepEqual(stored.usage?.cache?.writeTokensByTtl, { ephemeral5m: 2_000, ephemeral1h: 500 });
  });

  it('preserves an explicit zero read across a save and reload', async () => {
    const usage: NormalizedUsage = {
      prompt_tokens: 500,
      completion_tokens: 40,
      total_tokens: 540,
      source: 'provider',
      cache: { status: 'reported', readTokens: 0, writeTokens: 0, missTokens: 0, reportedBy: 'provider' },
    };
    const stored = await throughDexie(assistantMessage({ usage }));
    assert.equal(stored.usage?.cache?.readTokens, 0);
    assert.equal(stored.usage?.cache?.status, 'reported');
  });

  it('keeps not-reported distinguishable from a reported zero after reload', async () => {
    const stored = await throughDexie(assistantMessage({
      usage: {
        prompt_tokens: 10, completion_tokens: 2, total_tokens: 12,
        source: 'provider', cache: { status: 'not-reported', reportedBy: 'provider' },
      },
    }));
    assert.equal(stored.usage?.cache?.status, 'not-reported');
    assert.equal(stored.usage?.cache?.readTokens, undefined);
  });

  it('keeps the router label so provenance is not lost on reload', async () => {
    const stored = await throughDexie(assistantMessage({
      usage: {
        prompt_tokens: 4_096, completion_tokens: 256, total_tokens: 4_352, source: 'provider',
        cache: { status: 'reported', readTokens: 3_072, writeTokens: 512, reportedBy: 'router' },
      },
    }));
    assert.equal(stored.usage?.cache?.reportedBy, 'router');
  });

  it('keeps an LC estimate an estimate, never a provider report', async () => {
    const stored = await throughDexie(assistantMessage({
      usage: { prompt_tokens: 0, completion_tokens: 128, total_tokens: 128, source: 'lc-estimate' },
    }));
    assert.equal(stored.usage?.source, 'lc-estimate');
    assert.equal(stored.usage?.cache, undefined);
  });

  it('round-trips the bounded LC prefix conclusion beside the provider report', async () => {
    const stored = await throughDexie(assistantMessage({ usage: RICH_USAGE, prefix: PREFIX }));
    assert.deepEqual(stored.prefix, PREFIX);
    // The two evidence classes stay separate columns, not one merged blob.
    assert.equal(stored.usage?.source, 'provider');
  });

  it('leaves a message without usage untouched', async () => {
    const stored = await throughDexie(assistantMessage());
    assert.equal(stored.usage, undefined);
    assert.equal(stored.prefix, undefined);
    assert.equal(stored.content, 'answer');
  });

  it('updateMessage strips hydrated attachment data URLs from patched attachments', async () => {
    const id = `update-att-${crypto.randomUUID()}`;
    await saveMeta(conversation(id, [assistantMessage({ id: 'm-att' })]));
    await replaceMessages(id, [assistantMessage({ id: 'm-att' })]);
    await updateMessage('m-att', {
      attachments: [{
        id: 'att-1',
        name: 'notes.txt',
        mime: 'text/plain',
        isImage: false,
        size: 5,
        stored: 'idb',
        dataUrl: 'data:text/plain;base64,SGVsbG8=',
      }],
    });
    const [row] = await loadMessages(id);
    assert.equal(row.attachments?.[0]?.dataUrl, undefined);
    assert.equal(row.attachments?.[0]?.stored, 'idb');
  });
});

describe('cache usage survives the real archive export and import', () => {
  it('round-trips every cache field and the prefix conclusion', async () => {
    const [restored] = await throughArchive([assistantMessage({ usage: RICH_USAGE, prefix: PREFIX })]);
    assert.deepEqual(restored.usage, RICH_USAGE);
    assert.deepEqual(restored.prefix, PREFIX);
  });

  it('preserves explicit zeroes and not-reported through a real archive', async () => {
    const [zeroed, notReported] = await throughArchive([
      assistantMessage({
        id: 'm-zero',
        sortOrder: 1,
        usage: {
          prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'provider',
          cache: { status: 'reported', readTokens: 0, reportedBy: 'provider' },
        },
      }),
      assistantMessage({
        id: 'm-absent',
        sortOrder: 2,
        usage: {
          prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, source: 'provider',
          cache: { status: 'not-reported' },
        },
      }),
    ]);
    assert.equal(zeroed.usage?.cache?.readTokens, 0);
    assert.equal(notReported.usage?.cache?.status, 'not-reported');
    assert.equal(notReported.usage?.cache?.readTokens, undefined);
  });

  it('preserves the router label so provenance is not lost on import', async () => {
    const [restored] = await throughArchive([assistantMessage({
      usage: {
        prompt_tokens: 4_096, completion_tokens: 256, total_tokens: 4_352, source: 'provider',
        cache: { status: 'reported', readTokens: 3_072, writeTokens: 512, reportedBy: 'router' },
      },
    })]);
    assert.equal(restored.usage?.cache?.reportedBy, 'router');
  });

  it('preserves an LC estimate as an estimate, never as a provider report', async () => {
    const [restored] = await throughArchive([assistantMessage({
      usage: { prompt_tokens: 0, completion_tokens: 128, total_tokens: 128, source: 'lc-estimate' },
    })]);
    assert.equal(restored.usage?.source, 'lc-estimate');
    assert.equal(restored.usage?.cache, undefined);
  });

  it('imports an old archive without cache fields unchanged', async () => {
    // Exactly the pre-cache persisted shape: a plain total, no `cache`, no
    // `source`. These must not gain fields on the way through.
    const [restored] = await throughArchive([assistantMessage({
      id: 'm-legacy',
      createdAt: 1_600_000_000_000,
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } as NormalizedUsage,
    })]);
    assert.deepEqual(restored.usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    assert.equal(restored.usage?.cache, undefined);
    assert.equal(restored.usage?.source, undefined);
  });

  it('imports an old archive message with no usage at all unchanged', async () => {
    const [restored] = await throughArchive([assistantMessage({ id: 'm-plain' })]);
    assert.equal(restored.usage, undefined);
    assert.equal(restored.prefix, undefined);
    assert.equal(restored.content, 'answer');
  });

  it('drops transient state and exports no cache key, session key, or digest', async () => {
    const id = `cache-forbidden-${crypto.randomUUID()}`;
    const blob = await buildArchive([conversation(id, [assistantMessage({
      usage: RICH_USAGE,
      prefix: PREFIX,
      streaming: true,
    })])]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const serialized = new TextDecoder().decode(bytes);

    const [restored] = await readArchive({ arrayBuffer: () => blob.arrayBuffer() } as File)
      .then((imported) => imported[0].conversation.messages);
    assert.equal(restored.streaming, undefined, 'transient streaming state must not survive export');

    for (const forbidden of [
      'prompt_cache_key', 'session_id', 'x-session-id', 'cache_control',
      'prompt_cache_breakpoint', 'digest', 'hmac',
    ]) {
      assert.ok(
        !serialized.toLowerCase().includes(forbidden),
        `archive must not contain ${forbidden}`,
      );
    }
  });
});

describe('provider continuation state survives persistence', () => {
  const stateful = (): Message => assistantMessage({
    id: `m-state-${crypto.randomUUID()}`,
    usage: {
      prompt_tokens: 100,
      completion_tokens: 900,
      total_tokens: 1_000,
      source: 'provider',
      scope: 'assistant-turn',
      coverage: { responseCount: 2, providerReportedResponses: 2, estimatedResponses: 0 },
      terminalCoverage: 'complete',
      reasoning: {
        status: 'reported', tokens: 700, reportedResponses: 2, responseCount: 2,
        measurements: ['provider-counter', 'provider-estimate'],
      },
      cache: {
        status: 'partially-reported', readTokens: 10, reportedBy: 'provider',
        coverage: { reportedResponses: 1, responseCount: 2 },
      },
    },
    responses_output_items: [
      { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'opaque_1' },
    ],
    anthropic_output_blocks: [
      { type: 'thinking', thinking: 'private', signature: 'sig_1' },
      { type: 'redacted_thinking', data: 'opaque_2' },
    ],
    opaque_replay_accounting: [
      {
        schemaVersion: 1,
        protocol: 'openai-responses',
        reasoningCarrier: 'encrypted-content',
        generatedReasoningTokens: 400,
        tokenStatus: 'provider-reported',
        locator: { kind: 'responses-item-ids', itemIds: ['rs_1'] },
      },
      {
        schemaVersion: 1,
        protocol: 'anthropic-messages',
        reasoningCarrier: 'mixed-anthropic-thinking',
        generatedReasoningTokens: 300,
        tokenStatus: 'provider-estimate',
        locator: { kind: 'anthropic-block-indexes', blockIndexes: [0, 1] },
      },
    ],
    reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'MiniMax thought' }],
    lmstudio_response_id: 'resp_3',
  });

  it('round-trips signed/redacted Anthropic state and LM Studio response IDs through Dexie', async () => {
    const mapped = throughRowMapping(stateful());
    assert.deepEqual(mapped.anthropic_output_blocks, [
      { type: 'thinking', thinking: 'private', signature: 'sig_1' },
      { type: 'redacted_thinking', data: 'opaque_2' },
    ]);
    assert.equal(mapped.lmstudio_response_id, 'resp_3');
    assert.deepEqual(mapped.reasoning_details, [
      { type: 'reasoning.text', index: 0, text: 'MiniMax thought' },
    ]);
    assert.equal(mapped.usage?.scope, 'assistant-turn');
    assert.equal(mapped.opaque_replay_accounting?.length, 2);

    const stored = await throughDexie(stateful());
    assert.deepEqual(stored.anthropic_output_blocks, mapped.anthropic_output_blocks);
    assert.equal(stored.lmstudio_response_id, 'resp_3');
    assert.deepEqual(stored.reasoning_details, mapped.reasoning_details);
    assert.deepEqual(stored.usage, mapped.usage);
    assert.deepEqual(stored.opaque_replay_accounting, mapped.opaque_replay_accounting);
  });

  it('preserves relayed MiniMax plaintext-thinking accounting and provenance', async () => {
    const baseUrl = 'https://api.gmi-serving.com/v1';
    const message = assistantMessage({
      id: `m-minimax-${crypto.randomUUID()}`,
      meta: { baseUrl, model: 'MiniMax-M2.7' },
      anthropic_output_blocks: [{
        type: 'thinking',
        thinking: 'complete readable reasoning',
        signature: '1c3a0ae890922669e9815a201f9b645abdaafe8d8b5a65a5e48f90830c6e0750',
      }],
      opaque_replay_accounting: [{
        schemaVersion: 1,
        protocol: 'anthropic-messages',
        reasoningCarrier: 'plaintext',
        tokenStatus: 'unreported',
        locator: { kind: 'anthropic-block-indexes', blockIndexes: [0] },
      }],
    });
    const mapped = throughRowMapping(message);
    assert.equal(mapped.opaque_replay_accounting?.[0]?.reasoningCarrier, 'plaintext');
    const stored = await throughDexie(message);
    assert.deepEqual(stored.opaque_replay_accounting, mapped.opaque_replay_accounting);
    const [restored] = await throughArchive([message]);
    assert.equal(restored.opaque_replay_accounting?.[0]?.reasoningCarrier, 'plaintext');
  });

  it('canonicalizes mixed-field DeepSeek reasoning without losing replay boundaries', async () => {
    const message = assistantMessage({
      id: `m-deepseek-${crypto.randomUUID()}`,
      meta: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
      responses_output_items: [{
        id: 'rs_1',
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: 'complete reasoning' }],
        encrypted_content: 'auxiliary-value',
        summary: [],
      }, {
        id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'tool', arguments: '{}',
        status: 'completed',
      }],
      opaque_replay_accounting: [{
        schemaVersion: 1,
        protocol: 'openai-responses',
        reasoningCarrier: 'encrypted-content',
        generatedReasoningTokens: 80,
        tokenStatus: 'provider-reported',
        locator: { kind: 'responses-item-ids', itemIds: ['rs_1', 'fc_1'] },
        toolCallIds: ['call_1'],
      }],
    });
    const expected = [{
      schemaVersion: 1 as const,
      protocol: 'openai-responses' as const,
      reasoningCarrier: 'plaintext' as const,
      tokenStatus: 'unreported' as const,
      locator: { kind: 'responses-item-ids' as const, itemIds: ['rs_1', 'fc_1'] },
      toolCallIds: ['call_1'],
    }];

    assert.deepEqual(throughRowMapping(message).opaque_replay_accounting, expected);
    assert.deepEqual((await throughDexie(message)).opaque_replay_accounting, expected);
    const [restored] = await throughArchive([message]);
    assert.deepEqual(restored.opaque_replay_accounting, expected);
    assert.equal(restored.responses_output_items?.[0]?.type, 'reasoning');
    assert.equal(
      restored.responses_output_items?.[0]?.type === 'reasoning'
        ? restored.responses_output_items[0].encrypted_content
        : undefined,
      'auxiliary-value',
      'the raw provider item remains archived',
    );
  });

  it('round-trips provider continuation state through archive export/import', async () => {
    const [restored] = await throughArchive([stateful()]);
    assert.equal(restored.lmstudio_response_id, 'resp_3');
    assert.equal(restored.anthropic_output_blocks?.[0]?.type, 'thinking');
    assert.equal(restored.anthropic_output_blocks?.[1]?.type, 'redacted_thinking');
    assert.equal(restored.usage?.scope, 'assistant-turn');
    assert.equal(restored.opaque_replay_accounting?.length, 2);
  });

  it('persists continuation state written by the stream-finalization patch path', async () => {
    const id = `provider-state-${crypto.randomUUID()}`;
    const message = stateful();
    delete message.anthropic_output_blocks;
    delete message.lmstudio_response_id;
    delete message.reasoning_details;
    await saveMeta(conversation(id, [message]));
    await replaceMessages(id, [message]);
    await updateMessage(message.id, {
      anthropic_output_blocks: [{ type: 'thinking', thinking: 'later', signature: 'sig_later' }],
      lmstudio_response_id: 'resp_later',
      reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'later thought' }],
    });
    const [restored] = await loadMessages(id);
    assert.deepEqual(restored.anthropic_output_blocks, [
      { type: 'thinking', thinking: 'later', signature: 'sig_later' },
    ]);
    assert.equal(restored.lmstudio_response_id, 'resp_later');
    assert.deepEqual(restored.reasoning_details, [
      { type: 'reasoning.text', index: 0, text: 'later thought' },
    ]);
  });

  it('clears stale accounting when replay state is replaced without a paired accounting patch', async () => {
    const id = `provider-state-clear-${crypto.randomUUID()}`;
    const message = stateful();
    await saveMeta(conversation(id, [message]));
    await replaceMessages(id, [message]);
    await updateMessage(message.id, { responses_output_items: [] });
    const [restored] = await loadMessages(id);
    assert.equal(restored.responses_output_items, undefined);
    assert.deepEqual(
      restored.opaque_replay_accounting?.map((group) => group.protocol),
      ['anthropic-messages'],
    );
  });

  it('drops malformed imported accounting and usage fields without inventing values', () => {    const malformed: Omit<Message, 'opaque_replay_accounting' | 'usage'> & {
      opaque_replay_accounting?: unknown;
      usage?: unknown;
    } = stateful();
    malformed.opaque_replay_accounting = [{
      schemaVersion: 1,
      protocol: 'openai-responses',
      reasoningCarrier: 'encrypted-content',
      generatedReasoningTokens: -1,
      tokenStatus: 'provider-reported',
      locator: { kind: 'responses-item-ids', itemIds: ['rs_1'] },
    }];
    malformed.usage = {
      prompt_tokens: 1,
      completion_tokens: 'not-a-number',
      total_tokens: 1,
    };
    const restored = throughRowMapping(malformed as unknown as Message);
    assert.equal(restored.opaque_replay_accounting, undefined);
    assert.equal(restored.usage, undefined);
  });
});

describe('Anthropic block order survives persistence and archive', () => {
  const ORDER: AnthropicBlockOrderEntry[] = [
    { kind: 'text', index: 0, responseIndex: 0, text: 'Working on it.' },
    { kind: 'thinking', index: 1, responseIndex: 0 },
    { kind: 'tool_use', index: 2, responseIndex: 0 },
  ];
  const BLOCKS = [{ type: 'thinking', thinking: 'plan' }];

  function ordered(id: string): Message {
    return assistantMessage({
      id,
      content: 'Working on it.',
      anthropic_output_blocks: BLOCKS as Message['anthropic_output_blocks'],
      anthropic_block_order: ORDER.map((entry) => ({ ...entry })),
    });
  }

  it('round-trips through the row mapping and snapshot', () => {
    assert.deepEqual(throughRowMapping(ordered('m-order-map')).anthropic_block_order, ORDER);
  });

  it('round-trips through Dexie and archive export/import', async () => {
    assert.deepEqual((await throughDexie(ordered('m-order-idb'))).anthropic_block_order, ORDER);
    const [restored] = await throughArchive([ordered('m-order-zip')]);
    assert.deepEqual(restored.anthropic_block_order, ORDER);
  });

  it('drops malformed orders instead of replaying them', () => {
    const bad = ordered('m-order-bad');
    (bad as unknown as Record<string, unknown>).anthropic_block_order = [
      { kind: 'text', index: 0, text: 'hi' },
      { kind: 'nope', index: 1 },
    ];
    assert.equal(throughRowMapping(bad).anthropic_block_order, undefined);
  });

  it('updateMessage clears stale order on block replacement', async () => {
    const id = `block-order-clear-${crypto.randomUUID()}`;
    await saveMeta(conversation(id, [ordered('m-order-stale')]));
    await replaceMessages(id, [ordered('m-order-stale')]);
    await updateMessage('m-order-stale', {
      anthropic_output_blocks: [{ type: 'thinking', thinking: 'later' }],
    });
    const [restored] = await loadMessages(id);
    assert.equal(restored.anthropic_block_order, undefined);
  });

  it('updateMessage keeps order patched alongside blocks', async () => {
    const id = `block-order-keep-${crypto.randomUUID()}`;
    await saveMeta(conversation(id, [ordered('m-order-kept')]));
    await replaceMessages(id, [ordered('m-order-kept')]);
    const replacement: AnthropicBlockOrderEntry[] = [
      { kind: 'thinking', index: 0, responseIndex: 0 },
      { kind: 'text', index: 1, responseIndex: 0, text: 'later' },
    ];
    await updateMessage('m-order-kept', {
      anthropic_output_blocks: [{ type: 'thinking', thinking: 'later' }],
      anthropic_block_order: replacement,
    });
    const [restored] = await loadMessages(id);
    assert.deepEqual(restored.anthropic_block_order, replacement);
  });
});
