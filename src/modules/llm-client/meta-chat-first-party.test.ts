import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeChatCompletionsUsage } from './cache-usage.ts';
import {
  META_CHAT_FIRST_PARTY_REASONING_TOTAL,
  META_CHAT_FIRST_PARTY_TURN_USAGE,
  metaChatRawUsageEnvelope,
} from './meta-chat-first-party-fixtures.ts';
import { resolveBundledProviderContract } from './provider-contracts.ts';

describe('Meta Chat first-party archive evidence', () => {
  it('pins the historical reasoning total across the seven turns', () => {
    assert.equal(META_CHAT_FIRST_PARTY_TURN_USAGE.length, 7);
    assert.equal(META_CHAT_FIRST_PARTY_REASONING_TOTAL, 15505);
  });

  it('keeps provider-reported reasoning a subset of completion usage', () => {
    for (const turn of META_CHAT_FIRST_PARTY_TURN_USAGE) {
      assert.ok(
        turn.reasoning_tokens < turn.completion_tokens,
        `reasoning ${turn.reasoning_tokens} must stay below completion ${turn.completion_tokens}`,
      );
    }
  });

  it('keeps cached input below the input total', () => {
    for (const turn of META_CHAT_FIRST_PARTY_TURN_USAGE) {
      assert.ok(
        turn.cached_tokens < turn.prompt_tokens,
        `cached ${turn.cached_tokens} must stay below input ${turn.prompt_tokens}`,
      );
    }
  });

  it('normalizes reconstructed envelopes without inventing a carrier', () => {
    for (const turn of META_CHAT_FIRST_PARTY_TURN_USAGE) {
      const normalized = normalizeChatCompletionsUsage(metaChatRawUsageEnvelope(turn), 'provider');
      assert.ok(normalized);
      assert.equal(normalized?.reasoning?.status, 'reported');
      assert.equal(normalized?.reasoning?.tokens, turn.reasoning_tokens);
      assert.equal(normalized?.cache?.readTokens, turn.cached_tokens);
    }
  });

  it('declares no replayable reasoning carrier on the Chat contract', () => {
    const resolved = resolveBundledProviderContract({
      baseUrl: 'https://api.meta.ai/v1',
      protocol: 'openai-chat',
      modelId: 'muse-spark-1.3-contributor',
    });
    assert.equal(resolved?.contract.id, 'meta.chat');
    assert.equal(resolved?.contract.history.replay, 'none');
    assert.ok(
      resolved?.contract.carriers.every((carrier) => carrier.replay === 'none'),
      'no Chat carrier may replay',
    );
  });
});
