import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyAnthropicReasoningCarrier,
  classifyResponsesReasoningCarrier,
  createAnthropicReplayAccountingGroup,
  createResponsesReplayAccountingGroup,
  normalizeOpaqueReplayAccounting,
} from './replay-accounting.ts';
import type {
  AnthropicReplayBlock,
  OpaqueReplayAccountingGroup,
  ResponsesOutputItem,
} from './types';

const usage = (tokens?: number) => ({
  prompt_tokens: 10,
  completion_tokens: 20,
  total_tokens: 30,
  source: 'provider' as const,
  ...(tokens === undefined ? {} : {
    reasoning: {
      status: 'reported' as const,
      tokens,
      measurement: 'provider-counter' as const,
    },
  }),
});

describe('opaque replay carrier classification and binding', () => {
  it('classifies encrypted_content even when a readable summary exists', () => {
    const items: ResponsesOutputItem[] = [{
      id: 'reasoning-1',
      type: 'reasoning',
      encrypted_content: 'ciphertext',
      summary: [{ type: 'summary_text', text: 'short summary' }],
    }];
    assert.equal(classifyResponsesReasoningCarrier(items), 'encrypted-content');
    const group = createResponsesReplayAccountingGroup(items, usage(400));
    assert.equal(group?.generatedReasoningTokens, 400);
    assert.deepEqual(group?.locator, { kind: 'responses-item-ids', itemIds: ['reasoning-1'] });
  });

  it('uses DeepSeek plaintext when a returned item also has encrypted_content', () => {
    const items: ResponsesOutputItem[] = [{
      id: 'reasoning-1',
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: 'complete chain of thought' }],
      encrypted_content: 'auxiliary-value',
      summary: [],
    }];
    assert.equal(classifyResponsesReasoningCarrier(items), 'encrypted-content');
    assert.equal(classifyResponsesReasoningCarrier(items, {
      baseUrl: 'https://api.deepseek.com/v1',
    }), 'plaintext');

    const group = createResponsesReplayAccountingGroup(
      items,
      usage(400),
      ['call-1'],
      false,
      'https://api.deepseek.com/v1',
    )!;
    assert.equal(group.reasoningCarrier, 'plaintext');
    assert.equal(group.generatedReasoningTokens, undefined);
    assert.equal(group.tokenStatus, 'unreported');

    const legacy = {
      ...group,
      reasoningCarrier: 'encrypted-content' as const,
      generatedReasoningTokens: 400,
      tokenStatus: 'provider-reported' as const,
    };
    assert.deepEqual(normalizeOpaqueReplayAccounting([legacy], {
      responsesOutputItems: items,
      responsesProviderContractId: 'deepseek.responses',
    }), [group]);
  });

  it('can preserve an empty Responses boundary for canonical final text', () => {
    assert.deepEqual(createResponsesReplayAccountingGroup([], usage(), [], true), {
      schemaVersion: 1,
      protocol: 'openai-responses',
      reasoningCarrier: 'none',
      tokenStatus: 'unreported',
      locator: { kind: 'responses-item-ids', itemIds: [] },
    });
  });

  it('binds multiple encrypted items to one response-level count without splitting it', () => {
    const items: ResponsesOutputItem[] = [
      { id: 'r1', type: 'reasoning', encrypted_content: 'cipher-1', summary: [] },
      { id: 'r2', type: 'reasoning', encrypted_content: 'cipher-2', summary: [] },
    ];
    const group = createResponsesReplayAccountingGroup(items, usage(900))!;
    assert.equal(group.generatedReasoningTokens, 900);
    assert.deepEqual(group.locator, { kind: 'responses-item-ids', itemIds: ['r1', 'r2'] });
  });

  it('keeps an encrypted carrier with missing usage explicitly unreported', () => {
    const group = createResponsesReplayAccountingGroup([{
      id: 'r1', type: 'reasoning', encrypted_content: 'cipher', summary: [],
    }], usage())!;
    assert.equal(group.tokenStatus, 'unreported');
    assert.equal(group.generatedReasoningTokens, undefined);
  });

  it('classifies signed, empty signed, redacted, mixed, and unsigned plaintext blocks structurally', () => {
    const signed: AnthropicReplayBlock = { type: 'thinking', thinking: 'summary', signature: 'sig' };
    const emptySigned: AnthropicReplayBlock = { type: 'thinking', thinking: '', signature: 'sig' };
    const redacted: AnthropicReplayBlock = { type: 'redacted_thinking', data: 'encrypted' };
    const plaintext: AnthropicReplayBlock = { type: 'thinking', thinking: 'plain' };
    assert.equal(classifyAnthropicReasoningCarrier([signed]), 'signed-thinking');
    assert.equal(classifyAnthropicReasoningCarrier([emptySigned]), 'signed-thinking');
    assert.equal(classifyAnthropicReasoningCarrier([redacted]), 'redacted-thinking');
    assert.equal(classifyAnthropicReasoningCarrier([signed, redacted]), 'mixed-anthropic-thinking');
    assert.equal(classifyAnthropicReasoningCarrier([plaintext]), 'plaintext');
  });

  it('treats MiniMax Anthropic thinking as plaintext despite its replay signature', () => {
    const block: AnthropicReplayBlock = {
      type: 'thinking',
      thinking: 'complete readable reasoning',
      signature: '1c3a0ae890922669e9815a201f9b645abdaafe8d8b5a65a5e48f90830c6e0750',
    };
    for (const baseUrl of [
      'https://api.minimax.io/anthropic',
      'https://api.minimaxi.com/anthropic',
      'https://api.gmi-serving.com/v1',
    ]) {
      assert.equal(classifyAnthropicReasoningCarrier([block], { baseUrl }), 'plaintext');
      const group: OpaqueReplayAccountingGroup | undefined = createAnthropicReplayAccountingGroup(
        [block], 0, usage(700), [], false, baseUrl,
      );
      if (!group) throw new Error('MiniMax reasoning block must create an accounting group');
      assert.equal(group.reasoningCarrier, 'plaintext');
      assert.equal(group.generatedReasoningTokens, undefined);
      assert.equal(group.tokenStatus, 'unreported');
      assert.deepEqual(normalizeOpaqueReplayAccounting([group], {
        anthropicOutputBlocks: [block],
        anthropicBaseUrl: baseUrl,
      }), [group]);
    }
    assert.equal(classifyAnthropicReasoningCarrier([block]), 'plaintext');
    assert.equal(classifyAnthropicReasoningCarrier([{
      ...block,
      signature: 'WaUjzkypQ2mUEVM36O2TxuC06KN8xyfbJwyem2dw3URve/op91XWHOEBLLqIOMfFG/UvLEczmEsUjavL',
    }], { baseUrl: 'https://compatible.example/v1' }), 'signed-thinking');

    const legacySignedGroup = {
      schemaVersion: 1,
      protocol: 'anthropic-messages' as const,
      reasoningCarrier: 'signed-thinking' as const,
      generatedReasoningTokens: 700,
      tokenStatus: 'provider-estimate' as const,
      locator: { kind: 'anthropic-block-indexes', blockIndexes: [0] },
    };
    assert.deepEqual(normalizeOpaqueReplayAccounting(
      [{
        schemaVersion: 1,
        protocol: 'openai-responses',
        reasoningCarrier: 'none',
        tokenStatus: 'unreported',
        locator: { kind: 'responses-item-ids', itemIds: [] },
      }, legacySignedGroup],
      { anthropicOutputBlocks: [block] },
    ), [{
      schemaVersion: 1,
      protocol: 'anthropic-messages',
      reasoningCarrier: 'plaintext',
      tokenStatus: 'unreported',
      locator: { kind: 'anthropic-block-indexes', blockIndexes: [0] },
    }]);
  });

  it('binds one Anthropic provider estimate to ordered signed/redacted indexes', () => {
    const blocks: AnthropicReplayBlock[] = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'redacted_thinking', data: 'encrypted' },
    ];
    const anthropicUsage = {
      ...usage(700),
      reasoning: { status: 'reported' as const, tokens: 700, measurement: 'provider-estimate' as const },
    };
    const group = createAnthropicReplayAccountingGroup(blocks, 3, anthropicUsage)!;
    assert.equal(group.tokenStatus, 'provider-estimate');
    assert.equal(group.generatedReasoningTokens, 700);
    assert.deepEqual(group.locator, { kind: 'anthropic-block-indexes', blockIndexes: [3, 4] });
  });
});

describe('opaque replay accounting validation', () => {
  it('fails closed for missing locators, protocol/status mismatches, and malformed tokens', () => {
    const items: ResponsesOutputItem[] = [
      { id: 'r1', type: 'reasoning', encrypted_content: 'cipher', summary: [] },
    ];
    const valid = createResponsesReplayAccountingGroup(items, usage(12))!;
    assert.deepEqual(normalizeOpaqueReplayAccounting([valid], { responsesOutputItems: items }), [valid]);
    assert.equal(normalizeOpaqueReplayAccounting([
      { ...valid, locator: { kind: 'responses-item-ids', itemIds: ['missing'] } },
    ], { responsesOutputItems: items }), undefined);
    assert.equal(normalizeOpaqueReplayAccounting([
      { ...valid, tokenStatus: 'provider-estimate' },
    ], { responsesOutputItems: items }), undefined);
    assert.equal(normalizeOpaqueReplayAccounting([
      { ...valid, generatedReasoningTokens: 1.5 },
    ], { responsesOutputItems: items }), undefined);
  });

  it('never promotes a model name or endpoint into an encrypted carrier', () => {
    assert.equal(classifyResponsesReasoningCarrier([{
      id: 'plain', type: 'reasoning', content: [{ type: 'reasoning_text', text: 'plain' }], summary: [],
    }]), 'plaintext');
    assert.equal(classifyResponsesReasoningCarrier([]), 'none');
  });
});

describe('Meta Messages summary carrier', () => {
  const summary: AnthropicReplayBlock = { type: 'thinking', thinking: 'readable summary' };
  const redacted: AnthropicReplayBlock = { type: 'redacted_thinking', data: 'encrypted' };
  const meta = { providerContractId: 'meta.messages' };

  it('never counts an unsigned summary as local plaintext under the exact contract', () => {
    // https://ai.developer.meta.com/docs/protocols/messages
    assert.equal(classifyAnthropicReasoningCarrier([summary], meta), 'none');
    assert.equal(classifyAnthropicReasoningCarrier([summary, redacted], meta), 'redacted-thinking');
  });

  it('keeps legacy structural behavior for every other caller', () => {
    assert.equal(classifyAnthropicReasoningCarrier([summary]), 'plaintext');
    assert.equal(classifyAnthropicReasoningCarrier([summary], { baseUrl: 'https://foo.meta.ai/v1' }), 'plaintext');
    assert.equal(
      classifyAnthropicReasoningCarrier([summary], { providerContractId: 'anthropic.messages' }),
      'plaintext',
    );
  });

  it('resolves the exact origin through the URL fallback', () => {
    assert.equal(
      classifyAnthropicReasoningCarrier([summary], { baseUrl: 'https://api.meta.ai/v1' }),
      'none',
    );
    assert.equal(
      classifyAnthropicReasoningCarrier([summary], { baseUrl: 'https://api.meta.ai' }),
      'none',
    );
  });

  it('binds terminal thinking_tokens to the encrypted block, not the summary', () => {
    const mixed = createAnthropicReplayAccountingGroup(
      [summary, redacted], 0, usage(700), [], false, 'https://api.meta.ai/v1',
    )!;
    assert.equal(mixed.reasoningCarrier, 'redacted-thinking');
    assert.equal(mixed.generatedReasoningTokens, 700);
    assert.equal(mixed.tokenStatus, 'provider-estimate');

    const summaryOnly = createAnthropicReplayAccountingGroup(
      [summary], 0, usage(700), [], false, 'https://api.meta.ai/v1',
    )!;
    assert.equal(summaryOnly.reasoningCarrier, 'none');
    assert.equal(summaryOnly.generatedReasoningTokens, undefined);
    assert.equal(summaryOnly.tokenStatus, 'unreported');
  });

  it('revalidates Meta archives consistently across reloads', () => {
    const blocks = [summary, redacted];
    const group = createAnthropicReplayAccountingGroup(
      blocks, 0, usage(700), [], true, 'https://api.meta.ai/v1',
    )!;
    assert.deepEqual(normalizeOpaqueReplayAccounting([group], {
      anthropicOutputBlocks: blocks,
      anthropicBaseUrl: 'https://api.meta.ai/v1',
    }), [group]);
    // A stale pre-fix group that stored the summary as plaintext does not survive.
    const stale = {
      ...group,
      reasoningCarrier: 'plaintext' as const,
      generatedReasoningTokens: undefined,
      tokenStatus: 'unreported' as const,
    };
    assert.equal(normalizeOpaqueReplayAccounting([stale], {
      anthropicOutputBlocks: blocks,
      anthropicBaseUrl: 'https://api.meta.ai/v1',
    }), undefined);
  });
});
