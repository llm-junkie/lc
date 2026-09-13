/**
 * LM Studio Native REST API client — model load / unload operations.
 * NOT part of the adapter pattern — used by ModelPicker for Load/Unload buttons.
 *
 * Reference (since LM Studio 0.4.0): https://lmstudio.ai/docs/developer/rest
 */

import { devProxyUrl } from '../proxy.ts';
import { isTauri } from '../../../utils/saveBlob.ts';
import { tauriFetch } from '../transport/fetch.ts';
import type { ProfileRequestHeaderSettings } from '../../../types';
import {
  profileRequestHeaderSettings,
  withProfileRequestHeaders,
} from '../request-headers.ts';

export type ModelState = 'loaded' | 'not-loaded' | 'loading';

export interface LMStudioLoadConfig {
  context_length?: number;
  eval_batch_size?: number;
  flash_attention?: boolean;
  num_experts?: number;
  offload_kv_cache_to_gpu?: boolean;
  parallel?: number;
}

export interface LMStudioLoadedInstance {
  id: string;
  config?: LMStudioLoadConfig;
}

export interface LMStudioReasoningConfig {
  /** Allowed public reasoning settings for this model. */
  allowed_options?: Array<'off' | 'on' | 'low' | 'medium' | 'high' | 'max'>;
  /** Default reasoning setting when none is specified. */
  default?: 'off' | 'on' | 'low' | 'medium' | 'high' | 'max';
}

export interface LMStudioCapabilities {
  vision?: boolean;
  trained_for_tool_use?: boolean;
  /** models.dev enrichment: tool/function-calling support (OpenAI convention). */
  tools?: boolean;
  reasoning?: LMStudioReasoningConfig;
  /**
   * FUTURE: when LM Studio ships custom client-side tool support on
   * the native REST path (`/chat`), the server will report
   * it here. The orchestrator reads this flag and prefers the REST path for tool turns
   * when it's `true`. Until then, the field is undefined and we fall
   * back to the OpenAI-compat path for tool turns regardless of the
   * user's `apiVariant` choice. Additive: existing server responses
   * that don't include the field deserialize to undefined, the
   * auto-switch treats it as "not supported", and the REST path is
   * preferred only when the field is explicitly `true`. Zero risk of
   * misinterpreting a missing field.
   */
  rest_custom_tools?: boolean;
}

export interface LMStudioModelDetail {
  /** Always present. */
  type: 'llm' | 'embedding' | string;
  /** Current LM Studio native REST model identifier. */
  key: string;
  display_name?: string;
  architecture?: string | null;
  max_context_length?: number;
  /**
   * Largest completion the model will produce, when the server reports one.
   *
   * Mirrors `ModelInfo.max_output_tokens`: `getModelDetail` resolves a model
   * from whichever server list is available and treats the two shapes
   * interchangeably, exactly as it already does for `max_context_length`.
   */
  max_output_tokens?: number;
  loaded_instances?: LMStudioLoadedInstance[];
  reasoning_config?: LMStudioReasoningConfig | null;
  capabilities?: LMStudioCapabilities | null;
  /** Synthesised convenience fields (populated by `decorate`). */
  state?: ModelState;
  loaded_context_length?: number;
}

export interface LMStudioModelListResponse {
  models: LMStudioModelDetail[];
}

export interface LMStudioLoadRequest {
  model: string;
  context_length?: number;
  flash_attention?: boolean;
  num_experts?: number;
  offload_kv_cache_to_gpu?: boolean;
}

export interface LMStudioLoadResponse {
  type: 'llm' | 'embedding' | string;
  instance_id: string;
  load_time_seconds: number;
  status: 'loaded' | string;
  load_config?: LMStudioLoadConfig;
}

function decorate(m: LMStudioModelDetail): LMStudioModelDetail {
  const loaded = m.loaded_instances ?? [];
  const state: ModelState = loaded.length > 0 ? 'loaded' : 'not-loaded';
  const ctx = loaded[0]?.config?.context_length;
  return {
    ...m,
    state,
    loaded_context_length: ctx,
  };
}

export class LMStudioNative {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly requestHeaderSettings: ProfileRequestHeaderSettings;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: {
    baseUrl: string;
    apiKey?: string;
    routing?: 'proxy' | 'direct';
    fetchImpl?: typeof fetch;
  } & ProfileRequestHeaderSettings) {
    const apiBase = opts.baseUrl.trim().replace(/\/+$/, '');
    if (!/\/api\/v\d+$/i.test(apiBase)) {
      throw new Error('LM Studio native REST Base URL must end with /api/vN.');
    }
    this.baseUrl = devProxyUrl(apiBase, opts.routing ?? 'proxy');
    this.apiKey = opts.apiKey ?? '';
    this.requestHeaderSettings = profileRequestHeaderSettings(opts);
    if (opts.fetchImpl) {
      this.fetchImpl = opts.fetchImpl;
    } else if (isTauri) {
      this.fetchImpl = tauriFetch;
    } else {
      this.fetchImpl = fetch.bind(globalThis);
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return withProfileRequestHeaders(h, this.requestHeaderSettings);
  }

  async listModelsDetailed(): Promise<LMStudioModelDetail[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/models`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`LMStudio listModels: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as LMStudioModelListResponse;
    const list = json.models ?? [];
    return list.map(decorate);
  }

  async loadModel(modelId: string, opts?: { contextLength?: number }): Promise<void> {
    const body: LMStudioLoadRequest = {
      model: modelId,
      context_length: opts?.contextLength,
    };
    const res = await this.fetchImpl(`${this.baseUrl}/models/load`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`loadModel ${modelId}: ${res.status} ${text}`);
    }
  }

  async unloadModel(instanceId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/models/unload`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ instance_id: instanceId }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`unloadModel ${instanceId}: ${res.status} ${text}`);
    }
  }
}
