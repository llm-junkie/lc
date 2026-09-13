import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  anthropicThinkingRetention,
  projectAssistantProviderHistory,
} from './provider-history-projection.ts';
import type { ChatMessage } from '../llm-client/types';
import {
  createAnthropicReplayAccountingGroup,
  createResponsesReplayAccountingGroup,
} from '../llm-client/replay-accounting.ts';
import { resolveBundledProviderContract } from '../llm-client/provider-contracts.ts';

const responseUsage = (tokens: number) => ({
  prompt_tokens: 1,
  completion_tokens: tokens + 1,
  total_tokens: tokens + 2,
  source: 'provider' as const,
  reasoning: { status: 'reported' as const, tokens, measurement: 'provider-counter' as const },
});

describe('shared provider-history projection', () => {
  it('keeps ordered Meta Messages reasoning identical with Tool History on and off', () => {
    const metaContract = resolveBundledProviderContract({
      baseUrl: 'https://api.meta.ai/v1',
      protocol: 'anthropic-messages',
      modelId: 'muse-spark-1.3-contributor',
    });
    const message = {
      role: 'assistant',
      content: 'Working on it.',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'lc_test', arguments: '{}' } }],
      anthropic_output_blocks: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'redacted_thinking', data: 'encrypted' },
      ],
      anthropic_output_origin: { baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3-contributor' },
      anthropic_block_order: [
        { kind: 'thinking', index: 0 },
        { kind: 'redacted_thinking', index: 1 },
        { kind: 'text', index: 2 },
        { kind: 'tool_use', index: 3 },
      ],
      opaque_replay_accounting: [
        createAnthropicReplayAccountingGroup(
          [
            { type: 'thinking', thinking: 'plan' },
            { type: 'redacted_thinking', data: 'encrypted' },
          ],
          0,
          { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22, source: 'provider' },
          ['toolu_1'],
          true,
          'https://api.meta.ai/v1',
          'meta.messages',
        )!,
      ],
    } as unknown as ChatMessage;
    const base = {
      protocol: 'anthropic-messages' as const,
      model: 'muse-spark-1.3-contributor',
      baseUrl: 'https://api.meta.ai/v1',
      providerContract: metaContract,
    };
    const off = projectAssistantProviderHistory(message, { ...base, toolCallRewritten: false });
    const on = projectAssistantProviderHistory(message, { ...base, toolCallRewritten: true });
    // Summaries stay display-only: nothing lands in locally counted plaintext.
    assert.deepEqual(off.plaintextReasoningTexts, []);
    assert.deepEqual(on.plaintextReasoningTexts, []);
    assert.deepEqual(off.anthropicOutputBlocks, on.anthropicOutputBlocks);
    assert.deepEqual(
      (off.accountingGroups ?? []).map((group) => group.reasoningCarrier),
      ['redacted-thinking'],
    );
    assert.deepEqual(off.accountingGroups, on.accountingGroups);
  });
  it('uses the resolved Chat contract rather than the assistant tool-call shape', () => {
    const deepSeekContract = resolveBundledProviderContract({
      baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'openai-chat',
      modelId: 'deepseek-chat',
    });
    const projection = projectAssistantProviderHistory({
      role: 'assistant', content: 'answer', reasoning_content: 'prior reasoning',
    }, {
      protocol: 'openai-chat',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      requestHasTools: true,
      providerContract: deepSeekContract,
    });
    assert.equal(projection.useCanonicalReasoning, true);
  });

  it('keeps exact-registration unknown models uncertain instead of borrowing a model rule', () => {
    const contract = resolveBundledProviderContract({
      baseUrl: 'https://api.moonshot.ai/v1',
      protocol: 'openai-chat',
      modelId: 'kimi-future',
    });
    assert.equal(contract?.modelStatus, 'unregistered');
    const projection = projectAssistantProviderHistory({
      role: 'assistant', content: '', reasoning_content: 'retained but unverified',
    }, {
      protocol: 'openai-chat',
      model: 'kimi-future',
      baseUrl: 'https://api.moonshot.ai/v1',
      requestHasTools: true,
      providerContract: contract,
    });
    assert.equal(projection.useCanonicalReasoning, false);
    assert.equal(projection.opaqueReasoningUnknown, true);
  });
  it('selects an encrypted Responses group once and does not count its readable summary', () => {
    const items: NonNullable<ChatMessage['responses_output_items']> = [{
      id: 'reasoning',
      type: 'reasoning',
      encrypted_content: 'cipher',
      summary: [{ type: 'summary_text', text: 'visible summary' }],
    }, {
      id: 'message',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'reply', annotations: [] }],
    }];
    const accounting = createResponsesReplayAccountingGroup(items, responseUsage(500))!;
    const projection = projectAssistantProviderHistory({
      role: 'assistant',
      content: 'reply',
      reasoning_content: 'visible summary',
      responses_output_items: items,
      opaque_replay_accounting: [accounting],
    }, { protocol: 'openai-responses', model: 'any', baseUrl: 'https://api.openai.com/v1' });
    assert.equal(projection.opaqueReasoningTokens, 500);
    assert.equal(projection.opaqueReasoningUnknown, false);
    assert.deepEqual(projection.plaintextReasoningTexts, []);
    assert.deepEqual(projection.replyTexts, ['reply']);
    assert.equal(projection.useCanonicalReply, false);
    assert.equal(projection.useCanonicalReasoning, false);
  });

  it('marks an encrypted Responses carrier without accounting as unknown', () => {
    const projection = projectAssistantProviderHistory({
      role: 'assistant',
      content: '',
      responses_output_items: [{
        id: 'reasoning', type: 'reasoning', encrypted_content: 'cipher', summary: [],
      }],
    }, { protocol: 'openai-responses', model: 'any' });
    assert.equal(projection.opaqueReasoningTokens, 0);
    assert.equal(projection.opaqueReasoningUnknown, true);
  });

  it('retains accounted Responses reasoning when Tool History rebuilds the call structure', () => {
    const items: NonNullable<ChatMessage['responses_output_items']> = [
      { id: 'r', type: 'reasoning', encrypted_content: 'cipher', summary: [] },
      {
        id: 'c', type: 'function_call', call_id: 'call-1', name: 'tool', arguments: '{}',
        status: 'completed',
      },
    ];
    const accounting = createResponsesReplayAccountingGroup(items, responseUsage(50), ['call-1'])!;
    const projection = projectAssistantProviderHistory({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'tool', arguments: '{}' } }],
      responses_output_items: items,
      opaque_replay_accounting: [accounting],
    }, {
      protocol: 'openai-responses', model: 'any', toolCallRewritten: true,
    });
    assert.deepEqual(projection.responsesOutputItems, [items[0]]);
    const projectedAccounting = {
      ...accounting,
      locator: { kind: 'responses-item-ids', itemIds: ['r'] },
    };
    delete projectedAccounting.toolCallIds;
    assert.deepEqual(projection.accountingGroups, [projectedAccounting]);
    assert.equal(projection.opaqueReasoningTokens, 50);
    assert.equal(projection.opaqueReasoningUnknown, false);
  });

  it('keeps DeepSeek Responses reasoning as locally countable plaintext', () => {
    const providerContract = resolveBundledProviderContract({
      baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'openai-responses',
      modelId: 'deepseek-v4-flash',
    });
    const item = {
      id: 'plain', type: 'reasoning' as const,
      content: [{ type: 'reasoning_text' as const, text: 'plain thought' }],
      encrypted_content: 'auxiliary-value',
      summary: [],
    };
    const projection = projectAssistantProviderHistory({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'tool', arguments: '{}' } }],
      responses_output_items: [item],
    }, {
      protocol: 'openai-responses', model: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',
      providerContract,
      providerContractStatus: 'matched',
    });
    assert.deepEqual(projection.responsesOutputItems, [item]);
    assert.deepEqual(projection.plaintextReasoningTexts, ['plain thought']);
    assert.equal(projection.opaqueReasoningTokens, 0);
    assert.equal(projection.opaqueReasoningUnknown, false);
  });

  it('keeps plaintext reasoning from any Responses-compatible server across Tool History', () => {
    const items: NonNullable<ChatMessage['responses_output_items']> = [{
      id: 'plain', type: 'reasoning',
      content: [{ type: 'reasoning_text', text: 'compatible server thought' }],
      summary: [],
    }, {
      id: 'call-item', type: 'function_call', call_id: 'call-1', name: 'tool', arguments: '{}',
      status: 'completed',
    }];
    const accounting = createResponsesReplayAccountingGroup(items, responseUsage(12), ['call-1'])!;
    const projection = projectAssistantProviderHistory({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'tool', arguments: '{}' } }],
      responses_output_items: items,
      opaque_replay_accounting: [accounting],
    }, {
      protocol: 'openai-responses',
      model: 'qwen/qwen3.8-27b',
      baseUrl: 'https://compatible.example/v1',
      toolCallRewritten: true,
    });
    assert.deepEqual(projection.responsesOutputItems, [items[0]]);
    assert.deepEqual(projection.plaintextReasoningTexts, ['compatible server thought']);
    assert.equal(projection.useCanonicalReasoning, false);
    assert.deepEqual(
      projection.accountingGroups?.[0]?.locator,
      { kind: 'responses-item-ids', itemIds: ['plain'] },
    );
  });

  it('replays unlisted Responses state only to the exact source endpoint and model', () => {
    const item: NonNullable<ChatMessage['responses_output_items']>[number] = {
      id: 'reasoning', type: 'reasoning', encrypted_content: 'opaque', summary: [],
    };
    const message: ChatMessage = {
      role: 'assistant',
      content: '',
      responses_output_items: [item],
      provider_output_origin: { baseUrl: 'https://relay.example/v1', model: 'future-model' },
    };
    const same = projectAssistantProviderHistory(message, {
      protocol: 'openai-responses',
      model: 'future-model',
      baseUrl: 'https://relay.example/v1',
      providerContractStatus: 'unmatched',
    });
    assert.deepEqual(same.responsesOutputItems, [item]);
    assert.equal(same.opaqueReasoningUnknown, true);

    const switched = projectAssistantProviderHistory(message, {
      protocol: 'openai-responses',
      model: 'different-model',
      baseUrl: 'https://relay.example/v1',
      providerContractStatus: 'unmatched',
    });
    assert.deepEqual(switched.responsesOutputItems, []);
    assert.equal(switched.opaqueReasoningUnknown, true);
  });

  it('replays unlisted Chat plaintext only to the exact source endpoint and model', () => {
    const message: ChatMessage = {
      role: 'assistant', content: '', reasoning_content: 'provider-returned reasoning',
    };
    const same = projectAssistantProviderHistory(message, {
      protocol: 'openai-chat',
      model: 'future-model',
      baseUrl: 'https://relay.example/v1',
      sourceOrigin: { baseUrl: 'https://relay.example/v1', model: 'future-model' },
      providerContractStatus: 'unmatched',
    });
    assert.equal(same.useCanonicalReasoning, true);
    assert.equal(same.opaqueReasoningUnknown, false);

    const switched = projectAssistantProviderHistory(message, {
      protocol: 'openai-chat',
      model: 'different-model',
      baseUrl: 'https://relay.example/v1',
      sourceOrigin: { baseUrl: 'https://relay.example/v1', model: 'future-model' },
      providerContractStatus: 'unmatched',
    });
    assert.equal(switched.useCanonicalReasoning, false);
    assert.equal(switched.opaqueReasoningUnknown, true);
  });

  it('applies Anthropic current-turn, keep-all, strip, unknown, and provenance gates', () => {
    const blocks: NonNullable<ChatMessage['anthropic_output_blocks']> = [
      { type: 'thinking', thinking: 'summary', signature: 'sig' },
      { type: 'redacted_thinking', data: 'cipher' },
    ];
    const accounting = createAnthropicReplayAccountingGroup(blocks, 0, {
      ...responseUsage(800),
      reasoning: { status: 'reported', tokens: 800, measurement: 'provider-estimate' },
    }, ['toolu_1'])!;
    const message: ChatMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'tool', arguments: '{}' } }],
      anthropic_output_blocks: blocks,
      anthropic_output_origin: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-4-5' },
      opaque_replay_accounting: [accounting],
    };
    const target = {
      protocol: 'anthropic-messages' as const,
      model: 'claude-opus-4-5',
      baseUrl: 'https://api.anthropic.com/v1',
    };
    assert.equal(projectAssistantProviderHistory(message, { ...target, currentToolTurn: true }).opaqueReasoningTokens, 800);
    assert.equal(projectAssistantProviderHistory(message, target).opaqueReasoningTokens, 800);
    assert.equal(projectAssistantProviderHistory(message, {
      ...target, model: 'claude-sonnet-4-5',
    }).opaqueReasoningTokens, 0, 'a last-turn-only model strips prior completed thinking');
    const compatible = projectAssistantProviderHistory({
      ...message,
      anthropic_output_origin: { baseUrl: 'https://compatible.example/v1', model: 'custom' },
    }, { protocol: 'anthropic-messages', model: 'custom', baseUrl: 'https://compatible.example/v1' });
    assert.equal(compatible.opaqueReasoningUnknown, true);
    const unmatchedCompatible = projectAssistantProviderHistory({
      ...message,
      anthropic_output_origin: { baseUrl: 'https://compatible.example/v1', model: 'custom' },
    }, {
      protocol: 'anthropic-messages',
      model: 'custom',
      baseUrl: 'https://compatible.example/v1',
      providerContractStatus: 'unmatched',
    });
    assert.deepEqual(unmatchedCompatible.anthropicOutputBlocks, blocks);
    assert.equal(unmatchedCompatible.opaqueReasoningTokens, 800);
    const switched = projectAssistantProviderHistory(message, {
      ...target, model: 'claude-opus-5',
    });
    assert.equal(switched.anthropicOutputBlocks?.length ?? 0, 0);
    assert.equal(switched.opaqueReasoningUnknown, false);
  });

  it('locally counts MiniMax Anthropic signed thinking as plaintext', () => {
    const baseUrl = 'https://api.gmi-serving.com/v1';
    const blocks: NonNullable<ChatMessage['anthropic_output_blocks']> = [{
      type: 'thinking',
      thinking: 'complete MiniMax reasoning',
      signature: '1c3a0ae890922669e9815a201f9b645abdaafe8d8b5a65a5e48f90830c6e0750',
    }];
    const accounting = createAnthropicReplayAccountingGroup(
      blocks,
      0,
      responseUsage(800),
      ['toolu_1'],
      false,
      baseUrl,
    )!;
    const projection = projectAssistantProviderHistory({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'tool', arguments: '{}' } }],
      anthropic_output_blocks: blocks,
      anthropic_output_origin: { baseUrl, model: 'MiniMax-M2.7' },
      opaque_replay_accounting: [accounting],
    }, {
      protocol: 'anthropic-messages',
      model: 'MiniMax-M2.7',
      baseUrl,
      currentToolTurn: true,
    });
    assert.deepEqual(projection.plaintextReasoningTexts, ['complete MiniMax reasoning']);
    assert.equal(projection.accountingGroups?.[0]?.reasoningCarrier, 'plaintext');
    assert.equal(projection.opaqueReasoningTokens, 0);
    assert.equal(projection.opaqueReasoningUnknown, false);
  });

  it('retains Anthropic replay blocks across Tool History and limits canonical fallback', () => {
    const toolCall = {
      id: 'toolu_1', type: 'function' as const,
      function: { name: 'tool', arguments: '{}' },
    };
    const officialBlocks: NonNullable<ChatMessage['anthropic_output_blocks']> = [{
      type: 'thinking', thinking: 'display summary', signature: 'opaque-claude-signature',
    }];
    const officialAccounting = createAnthropicReplayAccountingGroup(
      officialBlocks,
      0,
      { ...responseUsage(80), reasoning: {
        status: 'reported', tokens: 80, measurement: 'provider-estimate',
      } },
      [toolCall.id],
    )!;
    const official = projectAssistantProviderHistory({
      role: 'assistant',
      content: '',
      reasoning_content: 'display summary',
      tool_calls: [toolCall],
      anthropic_output_blocks: officialBlocks,
      anthropic_output_origin: {
        baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5',
      },
      opaque_replay_accounting: [officialAccounting],
    }, {
      protocol: 'anthropic-messages',
      model: 'claude-sonnet-5',
      baseUrl: 'https://api.anthropic.com/v1',
      toolCallRewritten: true,
    });
    assert.deepEqual(official.anthropicOutputBlocks, officialBlocks);
    assert.equal(official.opaqueReasoningTokens, 80);
    assert.equal(official.useCanonicalReasoning, false);

    const miniMaxBaseUrl = 'https://api.gmi-serving.com/v1';
    const miniMaxBlocks: NonNullable<ChatMessage['anthropic_output_blocks']> = [{
      type: 'thinking',
      thinking: 'complete MiniMax reasoning',
      signature: '1c3a0ae890922669e9815a201f9b645abdaafe8d8b5a65a5e48f90830c6e0750',
    }];
    const miniMax = projectAssistantProviderHistory({
      role: 'assistant',
      content: '',
      reasoning_content: 'complete MiniMax reasoning',
      tool_calls: [toolCall],
      anthropic_output_blocks: miniMaxBlocks,
      anthropic_output_origin: { baseUrl: miniMaxBaseUrl, model: 'MiniMax-M3' },
      opaque_replay_accounting: [createAnthropicReplayAccountingGroup(
        miniMaxBlocks,
        0,
        responseUsage(80),
        [toolCall.id],
        false,
        miniMaxBaseUrl,
      )!],
    }, {
      protocol: 'anthropic-messages',
      model: 'MiniMax-M3',
      baseUrl: miniMaxBaseUrl,
      toolCallRewritten: true,
    });
    assert.deepEqual(miniMax.anthropicOutputBlocks, miniMaxBlocks);
    assert.deepEqual(miniMax.plaintextReasoningTexts, ['complete MiniMax reasoning']);
    assert.equal(miniMax.useCanonicalReasoning, false);

    const deepSeek = projectAssistantProviderHistory({
      role: 'assistant',
      content: '',
      reasoning_content: 'required plaintext reasoning',
      tool_calls: [toolCall],
    }, {
      protocol: 'anthropic-messages',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      toolCallRewritten: true,
    });
    assert.equal(deepSeek.useCanonicalReasoning, true);
  });

  it('marks LM Studio previous_response_id occupancy as remote and unmeasured', () => {
    const projection = projectAssistantProviderHistory({
      role: 'assistant', content: 'visible output', lmstudio_response_id: 'response-1',
    }, { protocol: 'lmstudio-rest', model: 'local' });
    assert.equal(projection.remoteStateUnknown, true);
    assert.equal(projection.useCanonicalReply, false);
  });
});

describe('Anthropic prior-thinking retention table', () => {
  it('distinguishes documented keep-all, last-turn-only, and unknown targets', () => {
    assert.equal(anthropicThinkingRetention('https://api.anthropic.com/v1', 'claude-opus-4-5'), 'all');
    assert.equal(anthropicThinkingRetention('https://api.anthropic.com/v1', 'claude-sonnet-4-6'), 'all');
    assert.equal(anthropicThinkingRetention('https://api.anthropic.com/v1', 'claude-sonnet-4-5'), 'last-turn-only');
    assert.equal(anthropicThinkingRetention('https://api.anthropic.com/v1', 'claude-haiku-4-5'), 'last-turn-only');
    assert.equal(anthropicThinkingRetention('https://compatible.example/v1', 'claude-opus-4-5'), 'unknown');
  });
});
