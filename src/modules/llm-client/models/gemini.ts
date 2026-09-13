import type { ModelInfo } from '../types';
import type { ProfileRequestHeaderSettings } from '../../../types';
import { geminiHeaders } from '../adapters/gemini-rest.ts';
import { geminiCounter, record } from '../gemini-state.ts';
import { withProfileRequestHeaders } from '../request-headers.ts';
import { MODEL_LIST_MAX_ENTRIES, readBoundedResponseText } from './limits.ts';
import { recordDiagnosticEvent } from '../../../utils/diagnostic-events.ts';
import { classifyEndpoint, countBucket } from '../../../utils/support-report-base.ts';
import { resolveBundledProviderContract } from '../provider-contracts.ts';

/** Native models.list pagination; compatible endpoints never enter this path. */
export async function listGeminiModels(url: string, apiKey: string, fetchImpl: typeof fetch,
  signal?: AbortSignal, settings: ProfileRequestHeaderSettings = {}, baseUrl = url.replace(/\/models(?:\?.*)?$/, '')): Promise<ModelInfo[]> {
  const models = new Map<string, ModelInfo>();
  const tokens = new Set<string>();
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < 128; page++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // Preserve the configured discovery URL (including proxy-relative URLs).
      const nextUrl = pageToken ? `${url}${url.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(pageToken)}` : url;
      const response = await fetchImpl(nextUrl, { headers: withProfileRequestHeaders(geminiHeaders(apiKey), settings), signal });
      if (!response.ok) throw new Error(`Gemini model discovery failed: HTTP ${response.status}.`);
      const payload: unknown = JSON.parse(await readBoundedResponseText(response));
      if (!record(payload) || !Array.isArray(payload.models)) throw new Error('Malformed Gemini model list.');
      for (const model of payload.models) {
        if (!record(model) || typeof model.name !== 'string' || model.name.length > 1024) continue;
        const id = model.name.replace(/^models\//, '');
        if (!id) continue;
        const input = geminiCounter(model, 'inputTokenLimit');
        const output = geminiCounter(model, 'outputTokenLimit');
        const registered = resolveBundledProviderContract({ baseUrl, protocol: 'gemini-interactions', modelId: id })?.model;
        models.set(id, { id, object: 'model', source: 'gemini-rest',
          ...(registered ? { capabilities: {
            ...registered.capabilities,
            ...(registered.reasoning === 'always' || registered.reasoning === 'optional' ? { reasoning: true } : {}),
          } } : {}),
          ...(typeof model.displayName === 'string' ? { display_name: model.displayName.slice(0, 1024) } : {}),
          ...(input !== undefined ? { max_context_length: input } : {}),
          ...(output !== undefined ? { max_output_tokens: output } : {}),
        });
        if (models.size > MODEL_LIST_MAX_ENTRIES) throw new Error('Gemini model list exceeds its entry limit.');
      }
      if (!payload.nextPageToken) {
        recordDiagnosticEvent({ subsystem: 'model', operation: 'model-list', outcome: 'ok', code: 'model-list-ok',
          endpointClass: classifyEndpoint(url), returnedCountBucket: countBucket(models.size), metadataSource: 'discovered' });
        return [...models.values()];
      }
      if (typeof payload.nextPageToken !== 'string' || payload.nextPageToken.length > 4096
        || tokens.has(payload.nextPageToken)) throw new Error('Invalid or repeated Gemini pagination token.');
      pageToken = payload.nextPageToken;
      tokens.add(pageToken);
    }
    throw new Error('Gemini model list exceeds its page limit.');
  } catch (error) {
    recordDiagnosticEvent({ subsystem: 'model', operation: 'model-list', outcome: 'error', code: 'model-list-failed',
      endpointClass: classifyEndpoint(url), metadataSource: 'unknown' });
    throw error;
  }
}
