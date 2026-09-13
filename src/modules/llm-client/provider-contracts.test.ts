import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyProviderContractControls,
  effectiveProviderControls,
  effectiveProviderHistory,
  getProviderContractRegistry,
  loadProviderContractRegistry,
  parseProviderContractRegistry,
  resolveProviderContract,
  type ProviderContractRegistry,
} from './provider-contracts.ts';

const registry = getProviderContractRegistry();

function mutableCopy(value: ProviderContractRegistry): ProviderContractRegistry {
  return structuredClone(value);
}

describe('provider contract registry', () => {
  test('the bundled v1 database passes the strict schema and is immutable', () => {
    assert.equal(registry.schema_version, 1);
    assert.ok(registry.contracts.length >= 20);
    assert.equal(Object.isFrozen(registry), true);
    assert.equal(Object.isFrozen(registry.contracts[0].history), true);
    assert.equal(registry.invariants.unmatched_provider, 'protocol-fallback-unknown-semantics');
    assert.equal(registry.invariants.unregistered_exact_model, 'surface-facts-only');
  });

  test('the compatibility loader returns the same in-memory embedded registry', async () => {
    assert.equal(await loadProviderContractRegistry(), registry);
    assert.equal(await loadProviderContractRegistry(), registry);
  });

  test('models.dev is enrichment, never wire-contract authority', () => {
    const relation = registry.external_metadata.models_dev;
    assert.deepEqual(relation.generated_artifacts, [
      'https://models.dev/api.json',
      'https://models.dev/models.json',
      'https://models.dev/catalog.json',
    ]);
    assert.ok(relation.use_for.some((item) => item.includes('context and output limits')));
    assert.ok(relation.not_authoritative_for.some((item) => item.includes('reasoning replay')));
    assert.ok(relation.not_authoritative_for.some((item) => item.includes('usage paths')));
  });

  test('one origin resolves different wire surfaces without consulting the model name', () => {
    const chat = resolveProviderContract(registry, {
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-chat',
      modelId: 'gpt-5.6-luna',
    });
    const responses = resolveProviderContract(registry, {
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-responses',
      modelId: 'gpt-5.6-luna',
    });
    assert.equal(chat?.contract.id, 'openai.chat');
    assert.equal(responses?.contract.id, 'openai.responses');
    assert.equal(chat?.model, undefined);
    assert.equal(responses?.model, undefined);
    assert.equal(chat?.modelStatus, 'surface-default');
  });

  test('Kimi products remain distinct and model overrides are exact', () => {
    const platform = resolveProviderContract(registry, {
      baseUrl: 'https://api.moonshot.ai/v1',
      protocol: 'openai-chat',
      modelId: 'kimi-k3',
    });
    const codeChat = resolveProviderContract(registry, {
      baseUrl: 'https://api.kimi.com/coding/v1',
      protocol: 'openai-chat',
      modelId: 'k3',
    });
    const codeMessages = resolveProviderContract(registry, {
      baseUrl: 'https://api.kimi.com/coding',
      protocol: 'anthropic-messages',
      modelId: 'k3',
    });
    assert.equal(platform?.contract.id, 'moonshot.chat');
    assert.equal(platform?.model?.id, 'kimi-k3');
    assert.equal(codeChat?.contract.id, 'kimi-code.chat');
    assert.equal(codeMessages?.contract.id, 'kimi-code.messages');

    const unknown = resolveProviderContract(registry, {
      baseUrl: 'https://api.moonshot.ai/v1',
      protocol: 'openai-chat',
      modelId: 'kimi-k3-future',
    });
    assert.equal(unknown?.contract.model_policy, 'exact-registration');
    assert.equal(unknown?.model, undefined);
    assert.equal(unknown?.modelStatus, 'unregistered');
    assert.equal(effectiveProviderHistory(unknown!), unknown?.contract.history);
    assert.deepEqual(effectiveProviderControls(unknown!), unknown?.contract.controls);
  });

  test('contract controls pass effort through and apply only declared constants', () => {
    const resolved = resolveProviderContract(registry, {
      baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'openai-chat',
      modelId: 'future-deepseek-model',
    });
    assert.ok(resolved);
    const request: Record<string, unknown> = {};
    applyProviderContractControls(request, resolved, {
      reasoningEnabled: true,
      reasoningEffort: 'xhigh',
    });
    assert.deepEqual(request, {
      thinking: { type: 'enabled' },
      reasoning_effort: 'xhigh',
    });
  });

  test('an explicit mode contract sends disabled without a stray none effort', () => {
    const resolved = resolveProviderContract(registry, {
      baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'openai-chat',
      modelId: 'future-deepseek-model',
    });
    assert.ok(resolved);
    const request: Record<string, unknown> = {};
    applyProviderContractControls(request, resolved, {
      reasoningEnabled: false,
      reasoningEffort: 'none',
    });
    assert.deepEqual(request, { thinking: { type: 'disabled' } });
  });

  test('a model ID cannot make an unregistered relay impersonate a provider', () => {
    assert.equal(resolveProviderContract(registry, {
      baseUrl: 'https://relay.example/v1',
      protocol: 'openai-responses',
      modelId: 'gpt-5.6-luna',
    }), undefined);
  });

  test('MiniMax Messages is signed plaintext while MiniMax Responses stays unknown', () => {
    const messages = resolveProviderContract(registry, {
      baseUrl: 'https://api.minimax.io/anthropic',
      protocol: 'anthropic-messages',
      modelId: 'MiniMax-M2.7',
    });
    const responses = resolveProviderContract(registry, {
      baseUrl: 'https://api.minimax.io/v1',
      protocol: 'openai-responses',
      modelId: 'MiniMax-M3',
    });
    assert.equal(messages?.contract.carriers[0].kind, 'signed-plaintext');
    assert.equal(messages?.contract.carriers[0].meter, 'local-text');
    assert.equal(responses?.contract.carriers[0].kind, 'unknown');
    assert.equal(responses?.contract.streaming.live_meter, 'unknown-until-terminal');
  });

  test('QwenCloud shares the international DashScope wire contract without losing product identity', () => {
    const chat = resolveProviderContract(registry, {
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      protocol: 'openai-chat',
      modelId: 'qwen3.8-max',
    });
    const responses = resolveProviderContract(registry, {
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      protocol: 'openai-responses',
      modelId: 'qwen3.8-max',
    });
    const messages = resolveProviderContract(registry, {
      baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
      protocol: 'anthropic-messages',
      modelId: 'qwen3.8-max',
    });

    assert.equal(chat?.contract.id, 'alibaba.chat');
    assert.deepEqual(chat?.contract.additional_products, ['QwenCloud']);
    assert.deepEqual(
      chat?.contract.controls.filter((control) => control.semantic === 'retention').map((control) => control.path),
      ['preserve_thinking', 'clear_thinking'],
    );
    assert.equal(chat?.contract.usage.reasoning_relation, 'subset-of-output');

    assert.equal(responses?.contract.id, 'alibaba.responses');
    assert.equal(responses?.contract.history.replay, 'remote-handle');
    assert.equal(responses?.contract.carriers.find((carrier) => carrier.kind === 'summary')?.replay, 'none');
    assert.equal(
      responses?.contract.carriers.find((carrier) => carrier.kind === 'remote-handle')?.replay,
      'provider-managed',
    );
    assert.equal(responses?.contract.usage.reasoning_relation, 'subset-of-output');

    assert.equal(messages?.contract.id, 'alibaba.messages');
    assert.equal(messages?.contract.carriers[0].kind, 'plaintext');
    assert.equal(messages?.contract.carriers[0].meter, 'local-text');
    assert.deepEqual(messages?.contract.carriers[0].companion_paths, ['content[].signature']);
    assert.equal(messages?.contract.usage.reasoning_relation, 'inclusive-undifferentiated');
  });

  test('all records pin retention, Tool History independence, and unknown-not-zero', () => {
    for (const contract of registry.contracts) {
      assert.equal(contract.history.archive, 'all-returned', contract.id);
      assert.equal(contract.history.tool_history_independent, true, contract.id);
      assert.equal(contract.usage.missing_reasoning, 'unknown', contract.id);
      for (const model of contract.models ?? []) {
        if (!model.history) continue;
        assert.equal(model.history.archive, 'all-returned', `${contract.id}/${model.id}`);
        assert.equal(model.history.tool_history_independent, true, `${contract.id}/${model.id}`);
      }
    }
  });

  test('validation rejects glob model selectors', () => {
    const bad = mutableCopy(registry);
    const contract = bad.contracts.find((item) => item.id === 'moonshot.chat');
    assert.ok(contract?.models);
    contract.models.push({ id: 'kimi-*', reasoning: 'unknown' });
    assert.throws(() => parseProviderContractRegistry(bad), /model IDs must be exact/);
  });

  test('validation rejects duplicate commercial product names', () => {
    const bad = mutableCopy(registry);
    bad.contracts[0].additional_products = [bad.contracts[0].product];
    assert.throws(() => parseProviderContractRegistry(bad), /duplicate product name/);
  });

  test('validation rejects weakening the retention invariants', () => {
    const bad = mutableCopy(registry);
    Object.assign(bad.contracts[0].history, { tool_history_independent: false });
    assert.throws(() => parseProviderContractRegistry(bad));
  });

  test('validation rejects missing evidence and ambiguous matches', () => {
    const missingSource = mutableCopy(registry);
    missingSource.contracts[0].source_ids[0] = 'missing-source';
    assert.throws(() => parseProviderContractRegistry(missingSource), /references missing source/);

    const ambiguous = mutableCopy(registry);
    const duplicate = structuredClone(ambiguous.contracts[0]);
    duplicate.id = 'openai.chat.duplicate';
    ambiguous.contracts.push(duplicate);
    assert.throws(() => parseProviderContractRegistry(ambiguous), /same protocol\/origin\/path match/);
  });

  test('Meta first-party surfaces resolve only on the exact origin, path, and protocol', () => {
    const chat = resolveProviderContract(registry, {
      baseUrl: 'https://api.meta.ai/v1',
      protocol: 'openai-chat',
      modelId: 'muse-spark-1.3',
    });
    const responses = resolveProviderContract(registry, {
      baseUrl: 'https://api.meta.ai/v1',
      protocol: 'openai-responses',
      modelId: 'muse-spark-1.3',
    });
    const messages = resolveProviderContract(registry, {
      baseUrl: 'https://api.meta.ai/v1',
      protocol: 'anthropic-messages',
      modelId: 'muse-spark-1.3',
    });
    assert.equal(chat?.contract.id, 'meta.chat');
    assert.equal(responses?.contract.id, 'meta.responses');
    assert.equal(messages?.contract.id, 'meta.messages');
    assert.equal(chat?.modelStatus, 'surface-default');
    for (const resolved of [chat, responses, messages]) {
      assert.equal(resolved?.contract.status, 'partially-verified');
    }

    const bareMessages = resolveProviderContract(registry, {
      baseUrl: 'https://api.meta.ai',
      protocol: 'anthropic-messages',
    });
    assert.equal(bareMessages?.contract.id, 'meta.messages');
    assert.equal(resolveProviderContract(registry, {
      baseUrl: 'https://api.meta.ai',
      protocol: 'openai-chat',
    }), undefined);
    assert.equal(resolveProviderContract(registry, {
      baseUrl: 'https://api.meta.ai',
      protocol: 'openai-responses',
    }), undefined);
  });

  test('relays, lookalike origins, and model names never select a Meta contract', () => {
    assert.equal(resolveProviderContract(registry, {
      baseUrl: 'https://opencode.ai/zen/v1',
      protocol: 'openai-responses',
      modelId: 'muse-spark-1.3',
    }), undefined);
    assert.equal(resolveProviderContract(registry, {
      baseUrl: 'https://foo.meta.ai/v1',
      protocol: 'openai-chat',
      modelId: 'muse-spark-1.3',
    }), undefined);
    assert.equal(resolveProviderContract(registry, {
      baseUrl: 'https://api.meta.ai.evil.example/v1',
      protocol: 'anthropic-messages',
      modelId: 'muse-spark-1.3',
    }), undefined);
    assert.equal(resolveProviderContract(registry, {
      baseUrl: 'https://relay.example/v1',
      protocol: 'openai-chat',
      modelId: 'muse-spark-1.3',
    }), undefined);
  });

  test('Meta contract controls pass effort through and pin Responses constants', () => {
    const responses = resolveProviderContract(registry, {
      baseUrl: 'https://api.meta.ai/v1',
      protocol: 'openai-responses',
    });
    assert.ok(responses);
    const request: Record<string, unknown> = {};
    applyProviderContractControls(request, responses, {
      reasoningEnabled: true,
      reasoningEffort: 'max',
    });
    assert.deepEqual(request, {
      reasoning: { effort: 'max', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    });

    const messages = resolveProviderContract(registry, {
      baseUrl: 'https://api.meta.ai/v1',
      protocol: 'anthropic-messages',
    });
    assert.ok(messages);
    const adaptive: Record<string, unknown> = {};
    applyProviderContractControls(adaptive, messages, {
      reasoningEnabled: true,
      reasoningEffort: 'high',
    });
    assert.deepEqual(adaptive, {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    const disabled: Record<string, unknown> = {};
    applyProviderContractControls(disabled, messages, {
      reasoningEnabled: false,
      reasoningEffort: 'none',
    });
    assert.deepEqual(disabled, { thinking: { type: 'disabled' } });
  });
});
