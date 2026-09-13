import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { convertToAnthropicRequest } from './adapters/anthropic.ts';
import { normalizeAnthropicUsage } from './cache-usage.ts';
import type { ChatMessage } from './types';
import {
  META_MESSAGES_FIRST_PARTY_BLOCK_COUNTS,
  META_MESSAGES_FIRST_PARTY_GROUP_TOKENS,
  META_MESSAGES_FIRST_PARTY_THINKING_TOTAL,
  META_MESSAGES_FIRST_PARTY_TURN_USAGE,
  META_MESSAGES_MAX_400_MESSAGE,
  META_MESSAGES_NONE_400_MESSAGE,
  metaMessagesErrorBody,
  metaMessagesRawUsageEnvelope,
  metaMessagesToolLoopTurn,
  metaRedactedBlock,
} from './meta-messages-first-party-fixtures.ts';
import { resolveBundledProviderContract } from './provider-contracts.ts';

const META_BASE = 'https://api.meta.ai/v1';
const META_MODEL = 'muse-spark-1.3-contributor';

describe('Meta Messages first-party archive evidence', () => {
  it('pins the redacted block count, group count, and thinking total', () => {
    assert.equal(META_MESSAGES_FIRST_PARTY_TURN_USAGE.length, 8);
    assert.equal(
      META_MESSAGES_FIRST_PARTY_BLOCK_COUNTS.reduce((sum, n) => sum + n, 0),
      28,
    );
    assert.equal(
      META_MESSAGES_FIRST_PARTY_GROUP_TOKENS.reduce((sum, row) => sum + row.length, 0),
      19,
    );
    assert.equal(META_MESSAGES_FIRST_PARTY_THINKING_TOTAL, 3654);
    META_MESSAGES_FIRST_PARTY_GROUP_TOKENS.forEach((row, index) => {
      assert.equal(
        row.reduce((sum, n) => sum + n, 0),
        META_MESSAGES_FIRST_PARTY_TURN_USAGE[index].thinking_tokens,
        `group row ${index} must sum to its turn total`,
      );
    });
  });

  it('keeps provider-bound thinking a subset of output usage', () => {
    for (const turn of META_MESSAGES_FIRST_PARTY_TURN_USAGE) {
      assert.ok(
        turn.thinking_tokens < turn.completion_tokens,
        `thinking ${turn.thinking_tokens} must stay below output ${turn.completion_tokens}`,
      );
    }
  });

  it('pins the redacted_thinking block shape without copying payloads', () => {
    const block = metaRedactedBlock(1);
    assert.deepEqual(Object.keys(block), ['type', 'data']);
    assert.equal(block.type, 'redacted_thinking');
    assert.ok(block.data.length > 0, 'placeholder proves the archive blob was non-empty');
  });

  it('reports cache reads beside input totals without settling composition', () => {
    for (const turn of META_MESSAGES_FIRST_PARTY_TURN_USAGE) {
      const normalized = normalizeAnthropicUsage(
        metaMessagesRawUsageEnvelope(turn),
        'provider',
        { providerContractId: 'meta.messages' },
      );
      assert.ok(normalized);
      assert.equal(normalized?.reasoning?.tokens, turn.thinking_tokens);
      assert.equal(normalized?.cache?.readTokens, turn.cached_tokens);
    }
  });

  it('keeps the Messages none/max error envelopes distinct from Responses', () => {
    assert.equal(
      META_MESSAGES_NONE_400_MESSAGE,
      '`thinking.type: "disabled"` is not supported with this model.',
    );
    assert.equal(META_MESSAGES_MAX_400_MESSAGE, 'unsupported `output_config.effort` value `max`');
    for (const message of [META_MESSAGES_NONE_400_MESSAGE, META_MESSAGES_MAX_400_MESSAGE]) {
      const parsed = JSON.parse(metaMessagesErrorBody(message)) as {
        error: Record<string, unknown>;
        type: string;
      };
      assert.deepEqual(Object.keys(parsed).sort(), ['error', 'type']);
      assert.deepEqual(Object.keys(parsed.error).sort(), ['message', 'type']);
      assert.equal(parsed.error.message, message);
    }
  });

  it('replays the mirrored multi-round turn in exact provider order', () => {
    const contract = resolveBundledProviderContract({
      baseUrl: META_BASE,
      protocol: 'anthropic-messages',
      modelId: META_MODEL,
    });
    assert.ok(contract);
    const turn = metaMessagesToolLoopTurn();
    const blocks = turn.blocks;
    assert.equal(blocks.length, 5);
    const message = {
      role: 'assistant',
      content: turn.text,
      anthropic_output_blocks: blocks,
      anthropic_output_origin: { baseUrl: META_BASE, model: META_MODEL },
      tool_calls: turn.callIds.map((id, n) => ({
        id,
        type: 'function',
        function: { name: `tool_${n}`, arguments: '{}' },
      })),
      opaque_replay_accounting: turn.groupTokens.map((tokens, n) => ({
        schemaVersion: 1 as const,
        protocol: 'anthropic-messages' as const,
        reasoningCarrier: 'redacted-thinking' as const,
        generatedReasoningTokens: tokens,
        tokenStatus: 'provider-estimate' as const,
        locator: {
          kind: 'anthropic-block-indexes' as const,
          blockIndexes: n === 0 ? [0, 1] : n === 1 ? [2, 3] : [4],
        },
        toolCallIds: n < 2 ? [turn.callIds[n]] : [],
      })),
      anthropic_block_order: turn.order,
    } as unknown as ChatMessage;
    const req = convertToAnthropicRequest(
      [
        { role: 'user', content: 'start' },
        message,
        { role: 'tool', content: 'r1', tool_call_id: 'call_fixture_1' },
        { role: 'tool', content: 'r2', tool_call_id: 'call_fixture_2' },
        { role: 'user', content: 'continue' },
      ],
      META_MODEL,
      { baseUrl: META_BASE, providerContract: contract, providerContractStatus: 'matched' },
    );
    const kinds = (index: number) => ((req.messages[index].content ?? []) as Array<{ type: string }>)
      .map((block) => block.type);
    assert.deepEqual(kinds(1), ['redacted_thinking', 'redacted_thinking', 'tool_use']);
    assert.deepEqual(kinds(3), ['redacted_thinking', 'redacted_thinking', 'tool_use']);
    assert.deepEqual(kinds(5), ['redacted_thinking', 'text']);
  });
});
