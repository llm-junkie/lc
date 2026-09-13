import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canReplayAnthropicOutputBlocks,
  canReplayProviderOutputState,
} from './provider-state.ts';

describe('opaque Anthropic provider-state provenance', () => {
  const origin = {
    baseUrl: 'https://api.anthropic.com/v1/',
    model: 'claude-sonnet-5',
  };

  it('allows the same normalized endpoint and model', () => {
    assert.equal(canReplayAnthropicOutputBlocks({
      origin,
      targetBaseUrl: 'https://api.anthropic.com/v1',
      targetModel: 'claude-sonnet-5',
    }), true);
  });

  it('rejects a provider switch, a model switch, and missing provenance', () => {
    assert.equal(canReplayAnthropicOutputBlocks({
      origin,
      targetBaseUrl: 'https://api.minimax.io/anthropic',
      targetModel: origin.model,
    }), false);
    assert.equal(canReplayAnthropicOutputBlocks({
      origin,
      targetBaseUrl: origin.baseUrl,
      targetModel: 'claude-opus-5',
    }), false);
    assert.equal(canReplayAnthropicOutputBlocks({
      targetBaseUrl: origin.baseUrl,
      targetModel: origin.model,
    }), false);
  });

  it('retains state when Tool History rebuilds its paired tool call', () => {
    assert.equal(canReplayAnthropicOutputBlocks({
      origin,
      targetBaseUrl: origin.baseUrl,
      targetModel: origin.model,
      toolCallRewritten: true,
    }), true);
  });
});

describe('generic provider-output provenance', () => {
  const origin = { baseUrl: 'https://relay.example/v1/', model: 'future-model' };

  it('requires the exact endpoint and model for an unlisted surface', () => {
    assert.equal(canReplayProviderOutputState({
      origin,
      targetBaseUrl: 'https://relay.example/v1',
      targetModel: 'future-model',
    }), true);
    assert.equal(canReplayProviderOutputState({
      origin,
      targetBaseUrl: 'https://other.example/v1',
      targetModel: 'future-model',
    }), false);
    assert.equal(canReplayProviderOutputState({
      origin,
      targetBaseUrl: 'https://relay.example/v1',
      targetModel: 'different-model',
    }), false);
  });

  it('allows only a verified surface to delegate model switching', () => {
    assert.equal(canReplayProviderOutputState({
      origin,
      targetBaseUrl: 'https://relay.example/v1',
      targetModel: 'different-model',
      allowModelSwitch: true,
    }), true);
  });
});
