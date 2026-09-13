/**
 * First-party Meta Responses evidence tests.
 *
 * Every numeric and shape claim here derives from the direct first-party Meta
 * session (`muse-spark-1.3-contributor` on `https://api.meta.ai/v1`): seven
 * successful medium/high/xhigh turns with multi-round tool use, plus `none`
 * and `max` validation errors. Fixtures are post-normalization LC archive
 * projections with synthetic IDs — see
 * `./meta-responses-first-party-fixtures.ts`. The OpenCode Zen relay archive
 * is never used as Meta evidence.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  META_FIRST_PARTY_BASE_URL,
  META_FIRST_PARTY_MODEL,
  META_FIRST_PARTY_TURN_USAGE,
  META_RESPONSES_MAX_400_MESSAGE,
  META_RESPONSES_NONE_400_MESSAGE,
  metaRawUsageEnvelope,
  metaReasoningItem,
  metaSingleResponseItems,
  metaToolLoopItems,
} from './meta-responses-first-party-fixtures.ts';
import { normalizeResponsesUsage } from './cache-usage.ts';
import {
  classifyResponsesReasoningCarrier,
  createResponsesReplayAccountingGroup,
  normalizeOpaqueReplayAccounting,
} from './replay-accounting.ts';
import { selectResponsesOutputItems } from '../chat-pipeline/provider-history-projection.ts';
import { resolveBundledProviderContract } from './provider-contracts.ts';
import type { ChatMessage } from './types';

const META_CONTRACT = resolveBundledProviderContract({
  baseUrl: META_FIRST_PARTY_BASE_URL,
  protocol: 'openai-responses',
  modelId: META_FIRST_PARTY_MODEL,
});

describe('Meta first-party Responses usage arithmetic', () => {
  it('resolves the exact first-party contract for the archive model', () => {
    assert.equal(META_CONTRACT?.contract.id, 'meta.responses');
    assert.equal(META_CONTRACT?.modelStatus, 'surface-default');
  });

  it('keeps provider reasoning counts as subsets of output totals', () => {
    assert.equal(META_FIRST_PARTY_TURN_USAGE.length, 7);
    for (const turn of META_FIRST_PARTY_TURN_USAGE) {
      assert.ok(
        turn.reasoning_tokens < turn.completion_tokens,
        `${turn.effort}: reasoning ${turn.reasoning_tokens} must stay below output ${turn.completion_tokens}`,
      );
    }
  });

  it('keeps cached-input details below the corresponding input totals', () => {
    for (const turn of META_FIRST_PARTY_TURN_USAGE) {
      assert.ok(
        turn.cached_tokens < turn.prompt_tokens,
        `${turn.effort}: cached ${turn.cached_tokens} must stay below input ${turn.prompt_tokens}`,
      );
    }
  });

  it('normalizes reconstructed envelopes without double-counting', () => {
    for (const turn of META_FIRST_PARTY_TURN_USAGE) {
      const normalized = normalizeResponsesUsage(metaRawUsageEnvelope(turn), 'provider');
      assert.equal(normalized?.prompt_tokens, turn.prompt_tokens);
      assert.equal(normalized?.completion_tokens, turn.completion_tokens);
      assert.equal(normalized?.reasoning?.tokens, turn.reasoning_tokens);
      assert.equal(normalized?.reasoning?.measurement, 'provider-counter');
      assert.equal(normalized?.cache?.readTokens, turn.cached_tokens);
    }
  });
});

describe('Meta first-party Responses carriers', () => {
  it('treats populated and empty summaries as encrypted carriers, never plaintext', () => {
    const populated = metaReasoningItem('rs_x:rs_xa', 1, [{ type: 'summary_text', text: 'Reading files.' }]);
    const empty = metaReasoningItem('rs_x:rs_xb', 2, []);
    // The archive pins the summary member shape: { type: 'summary_text', text }.
    assert.deepEqual(populated.summary, [{ type: 'summary_text', text: 'Reading files.' }]);
    assert.equal(
      classifyResponsesReasoningCarrier([populated], { baseUrl: META_FIRST_PARTY_BASE_URL }),
      'encrypted-content',
    );
    assert.equal(
      classifyResponsesReasoningCarrier([empty], { baseUrl: META_FIRST_PARTY_BASE_URL }),
      'encrypted-content',
    );
  });

  it('preserves the multi-round tool-loop order and group boundaries', () => {
    assert.ok(META_CONTRACT);
    const items = metaToolLoopItems();
    const message = {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_fixture_1', type: 'function', function: { name: 'lc_skill', arguments: '{}' } },
        { id: 'call_fixture_2', type: 'function', function: { name: 'lc_read_file', arguments: '{}' } },
      ],
      responses_output_items: items,
      provider_output_origin: { baseUrl: META_FIRST_PARTY_BASE_URL, model: META_FIRST_PARTY_MODEL },
    } as unknown as ChatMessage;
    for (const toolCallRewritten of [false, true]) {
      const selected = selectResponsesOutputItems(message, {
        baseUrl: META_FIRST_PARTY_BASE_URL,
        model: META_FIRST_PARTY_MODEL,
        toolCallRewritten,
        providerContract: META_CONTRACT,
      });
      const expected = toolCallRewritten
        ? items.filter((item) => item.type !== 'function_call')
        : items;
      assert.deepEqual(
        selected.map((item) => item.id),
        expected.map((item) => item.id),
        `provider order must survive with toolCallRewritten=${toolCallRewritten}`,
      );
    }
    const groups = normalizeOpaqueReplayAccounting(
      [
        {
          schemaVersion: 1, protocol: 'openai-responses', reasoningCarrier: 'encrypted-content',
          generatedReasoningTokens: 590, tokenStatus: 'provider-reported',
          locator: { kind: 'responses-item-ids', itemIds: ['rs_fixture_1:rs_fixture_1a', 'rs_fixture_1:rs_fixture_1b', 'fc_fixture_1'] },
          toolCallIds: ['call_fixture_1'],
        },
        {
          schemaVersion: 1, protocol: 'openai-responses', reasoningCarrier: 'encrypted-content',
          generatedReasoningTokens: 56, tokenStatus: 'provider-reported',
          locator: { kind: 'responses-item-ids', itemIds: ['rs_fixture_2:rs_fixture_2a', 'rs_fixture_2:rs_fixture_2b', 'fc_fixture_2'] },
          toolCallIds: ['call_fixture_2'],
        },
        {
          schemaVersion: 1, protocol: 'openai-responses', reasoningCarrier: 'encrypted-content',
          generatedReasoningTokens: 51, tokenStatus: 'provider-reported',
          locator: { kind: 'responses-item-ids', itemIds: ['rs_fixture_3:rs_fixture_3a', 'msg_fixture_3'] },
        },
      ],
      {
        responsesOutputItems: items,
        responsesBaseUrl: META_FIRST_PARTY_BASE_URL,
        responsesProviderContractId: 'meta.responses',
      },
    );
    assert.equal(groups?.length, 3);
    assert.deepEqual(
      groups?.map((group) => group.locator),
      [
        { kind: 'responses-item-ids', itemIds: ['rs_fixture_1:rs_fixture_1a', 'rs_fixture_1:rs_fixture_1b', 'fc_fixture_1'] },
        { kind: 'responses-item-ids', itemIds: ['rs_fixture_2:rs_fixture_2a', 'rs_fixture_2:rs_fixture_2b', 'fc_fixture_2'] },
        { kind: 'responses-item-ids', itemIds: ['rs_fixture_3:rs_fixture_3a', 'msg_fixture_3'] },
      ],
    );
  });

  it('binds response-local reasoning tokens to the encrypted group', () => {
    const items = metaSingleResponseItems();
    const group = createResponsesReplayAccountingGroup(
      items.filter((item) => item.type === 'reasoning'),
      { prompt_tokens: 13055, completion_tokens: 620, total_tokens: 13675, source: 'provider', reasoning: { status: 'reported', tokens: 304, measurement: 'provider-counter' } },
      [],
      false,
      META_FIRST_PARTY_BASE_URL,
      'meta.responses',
    );
    assert.equal(group?.reasoningCarrier, 'encrypted-content');
    assert.equal(group?.generatedReasoningTokens, 304);
    assert.equal(group?.tokenStatus, 'provider-reported');
  });
});

describe('Meta first-party error evidence', () => {
  it('records the exact none and max validation messages', () => {
    assert.match(META_RESPONSES_NONE_400_MESSAGE, /does not support "none" with this model/);
    assert.match(
      META_RESPONSES_MAX_400_MESSAGE,
      /unknown variant `max`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`/,
    );
  });
});

describe('Meta first-party origin isolation', () => {
  it('never replays first-party items to the Zen relay or lookalike hosts', () => {
    const message = {
      role: 'assistant',
      content: '',
      responses_output_items: metaSingleResponseItems(),
      provider_output_origin: { baseUrl: META_FIRST_PARTY_BASE_URL, model: META_FIRST_PARTY_MODEL },
    } as unknown as ChatMessage;
    for (const baseUrl of ['https://opencode.ai/zen/v1', 'https://foo.meta.ai/v1']) {
      assert.deepEqual(
        selectResponsesOutputItems(message, {
          baseUrl,
          model: META_FIRST_PARTY_MODEL,
          providerContractStatus: 'unmatched',
        }),
        [],
        `no Meta replay to ${baseUrl}`,
      );
      assert.equal(
        resolveBundledProviderContract({ baseUrl, protocol: 'openai-responses', modelId: META_FIRST_PARTY_MODEL }),
        undefined,
      );
    }
  });
});
