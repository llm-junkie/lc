/**
 * Thin facade for the LLM client module. Routes to the correct protocol
 * adapter (OpenAI / Anthropic / LM Studio REST) based on `apiVariant`.
 * ChatView calls ONE method with no protocol awareness.
 */

import { isTauri } from '../../utils/saveBlob.ts';
import { debugLog } from '../../utils/debug.ts';
import { devProxyUrl, stripTrailingSlash } from './proxy.ts';
import { tauriFetch } from './transport/fetch.ts';
import {
  tauriStreamFetch,
  type StreamFetch,
} from './transport/stream-fetch.ts';
import { SSE_READ_TIMEOUT_MS } from './transport/read-timeout.ts';
import { ToolCallAccumulator } from './tool-accumulator.ts';
import { listModels } from './models/list.ts';
import { resolveModelFetchUrl } from './models/url.ts';
import type { ChatStreamAdapter, AdapterRequestParams, StreamCallbacks, StreamResult } from './adapters/adapter';
import type { ChatMessage, ModelInfo } from './types';
import type { ProfileRequestHeaderSettings } from '../../types';
import {
  profileRequestHeaderSettings,
  withProfileRequestHeaders,
} from './request-headers.ts';
import { OpenAIAdapter } from './adapters/openai.ts';
import { OpenAIResponsesAdapter } from './adapters/openai-responses.ts';
import { AnthropicAdapter } from './adapters/anthropic.ts';
import { GeminiRestAdapter } from './adapters/gemini-rest.ts';
import { listGeminiModels } from './models/gemini.ts';
import { geminiText, record } from './gemini-state.ts';
import { LMStudioRestAdapter, type NativeTextItemType } from './adapters/lmstudio-rest.ts';
import { nextDiagnosticSequence, recordDiagnosticEvent } from '../../utils/diagnostic-events.ts';
import { classifyEndpoint } from '../../utils/support-report-base.ts';
import { usageReporterForBaseUrl } from './cache-usage.ts';
import {
  reasoningEffortLevel,
  recordActiveRequestSnapshot,
  toolDefinitionCount,
  type RequestModelFacts,
} from './request-snapshot.ts';
import {
  comparePrefix,
  describeRequest,
  type PrefixDiagnostic,
} from './prefix-diagnostics.ts';
import {
  providerContractProtocol,
  resolveBundledProviderContract,
  type ResolvedProviderContract,
} from './provider-contracts.ts';

/** Conversation/profile identity used only to scope prefix comparison chains. */
export interface PrefixDiagnosticScope {
  conversationId: string;
  profileId: string;
}

/**
 * Facts the caller knows and the request path does not, plus the hand-back for
 * the correlation number.
 */
export interface ChatRequestContext extends RequestModelFacts {
  /** Runtime-only generation key for the bounded diagnostic ring. */
  diagnosticSessionId?: string;
  /**
   * Receives this request's ephemeral correlation number as soon as it is
   * allocated — before the call is made.
   *
   * A callback rather than a return value because the caller needs the number
   * on the paths where `chatStream` throws: a network failure, an HTTP error, a
   * read timeout, and a cancellation all have to be able to record a terminal
   * stream event that pairs with the request that produced them. Wrapping the
   * thrown value instead would change the error identity the orchestrator
   * branches on.
   */
  onSequence?: (sequence: number) => void;
}

/**
 * Detect LM Studio REST API errors where the model rejects the
 * `reasoning` parameter (only supports 'off'/'on' but received
 * 'low'/'medium'/'high').  When we see this, we retry without
 * the reasoning field entirely.
 */
function isReasoningRejection(errorBody: string): boolean {
  try {
    const err = JSON.parse(errorBody) as { error?: { param?: string; code?: string; message?: string } };
    if (err.error?.param === 'reasoning') return true;
    if (err.error?.code === 'invalid_value' && err.error?.message?.toLowerCase().includes('reasoning')) return true;
  } catch { /* not JSON â€” can't detect */ }
  return false;
}

/**
 * How many corrected retries one native request may make. LC knows two
 * corrections, and a server reports one rejection at a time, so a third
 * attempt could never carry a correction the first two did not.
 */
const NATIVE_MAX_CORRECTIONS = 2;

/**
 * Detect LM Studio REST API errors where the server rejects the discriminator
 * on a text `input` item, e.g.
 *
 *   { "error": { "message": "Invalid discriminator value. Expected 'text' | 'image'",
 *                "code": "invalid_union", "param": "input" } }
 *
 * Shipped servers name `'text'` and the current native chat page documents
 * `'message'`, so the accepted value is read out of the rejection itself
 * rather than guessed. Returns the named text type, or null when the error is
 * about something else.
 */
function rejectedInputTextType(errorBody: string): NativeTextItemType | null {
  try {
    const err = JSON.parse(errorBody) as { error?: { param?: string; code?: string; message?: string } };
    if (err.error?.param !== 'input') return null;
    const message = err.error?.message ?? '';
    if (err.error?.code !== 'invalid_union' && !/invalid discriminator/i.test(message)) return null;
    if (/['"`]message['"`]/.test(message)) return 'message';
    if (/['"`]text['"`]/.test(message)) return 'text';
  } catch { /* not JSON â€” can't detect */ }
  return null;
}

/**
 * Strip non-standard fields from tool messages before sending to the
 * server.  LM Studio's OpenAI-compat parser rejects unknown fields on
 * tool messages with a 500 (observed with `tool_is_error` and
 * potentially `tool_duration_ms`).  Anthropic requests go through a
 * separate codepath (`convertToAnthropicRequest`) that maps
 * `tool_is_error` â†’ `is_error` on the Anthropic `tool_result` block,
 * so stripping is safe for both paths.
 *
 * The OpenAI REST API only defines three fields on tool messages:
 * `role`, `content`, and `tool_call_id`.  Everything else is stripped.
 */
function sanitizeToolMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'tool') return m;
    // Only keep the three standard OpenAI tool-message fields.
    const { role, content, tool_call_id } = m;
    const clean: ChatMessage = { role, content };
    if (tool_call_id !== undefined) clean.tool_call_id = tool_call_id;
    return clean;
  });
}

export interface LLMClientOptions extends ProfileRequestHeaderSettings {
  baseUrl: string;
  /** LM Studio ignores this but the OpenAI spec requires it on the wire. */
  apiKey?: string;
  /**
   * Which API variant to use. The endpoint path is appended to baseUrl:
   *   - openai:    /chat/completions  or  /responses
   *   - lm-studio: /chat
   *   - anthropic: /v1/messages (if baseUrl already ends with /vN, just /messages)
   * Defaults to "openai".
   */
  apiVariant?: string;
  /**
   * When apiVariant is "openai", selects between Chat Completions and
   * the Responses API.
   *   - "chat":      POST /chat/completions (default)
   *   - "responses": POST /responses
   * Ignored when apiVariant is "anthropic" or "lm-studio".
   */
  apiStyle?: 'chat' | 'responses';
  /**
   * How to route requests to this server. See `devProxyUrl`. Defaults
   * to "proxy".
   */
  routing?: string;
  /** Optional fetch override (useful for tests). */
  fetchImpl?: typeof fetch;
  /** Optional streaming fetch override (useful for cancellation tests). */
  streamFetchImpl?: StreamFetch;
  /** Optional models.dev compact cache for enrichment. */
  modelsCache?: import('./models/enrich.ts').CompactCache | null;
  /** Optional exact model-list URL or path. Empty means automatic resolution. */
  modelFetchUrl?: string;
  /** Frozen admission-time contract. Direct callers may omit it. */
  providerContract?: ResolvedProviderContract;
  providerContractStatus?: 'matched' | 'unmatched';
}

export class LLMClient {
  private adapter: ChatStreamAdapter;
  private readonly serverRoot: string;
  private readonly apiKey: string;
  /** Original base URL (before proxy rewrite) â€” used for models.dev lookup. */
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly streamFetchImpl: StreamFetch;
  private readonly modelsCache: import('./models/enrich.ts').CompactCache | null;
  private readonly modelFetchUrl?: string;
  private readonly requestHeaderSettings: ProfileRequestHeaderSettings;
  /** Closed routing vocabulary, retained for the request snapshot only. */
  private readonly routing: 'proxy' | 'direct' | 'unknown';
  private readonly providerContract?: ResolvedProviderContract;
  private readonly providerContractStatus?: 'matched' | 'unmatched';
  private readonly providerContractWireProtocol: ReturnType<typeof providerContractProtocol>;

  constructor(opts: LLMClientOptions) {
    const rawUrl = stripTrailingSlash(
      devProxyUrl(
        opts.baseUrl.trim(),
        (opts.routing as 'proxy' | 'direct' | undefined),
      ),
    );
    this.serverRoot = rawUrl;
    this.routing = opts.routing === 'proxy' || opts.routing === 'direct'
      ? opts.routing
      : 'unknown';
    // Keep the original (non-proxy-rewritten) URL for models.dev lookup.
    this.baseUrl = opts.baseUrl.trim().replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? '';
    this.modelsCache = opts.modelsCache ?? null;
    this.requestHeaderSettings = profileRequestHeaderSettings(opts);
    const resolvedModelFetchUrl = resolveModelFetchUrl(this.baseUrl, opts.modelFetchUrl);
    this.modelFetchUrl = resolvedModelFetchUrl
      ? devProxyUrl(resolvedModelFetchUrl, (opts.routing as 'proxy' | 'direct' | undefined))
      : undefined;

    const variant = (opts.apiVariant ?? 'openai') as string;
    const style = (opts.apiStyle ?? 'chat') as string;
    this.providerContract = opts.providerContract;
    this.providerContractStatus = opts.providerContractStatus;
    this.providerContractWireProtocol = providerContractProtocol(
      variant,
      style === 'responses' ? 'responses' : 'chat',
    );
    // The original (non-proxy-rewritten) base URL is handed to the protocol
    // adapters solely so router-reported cache counters can be labeled as
    // such. It never selects parsing behavior or names an upstream provider.
    this.adapter =
      variant === 'anthropic'  ? new AnthropicAdapter(
        this.baseUrl,
        opts.providerContract,
        opts.providerContractStatus,
      ) :
      variant === 'lm-studio'  ? new LMStudioRestAdapter() :
      variant === 'gemini'     ? new GeminiRestAdapter(this.baseUrl) :
      style === 'responses'    ? new OpenAIResponsesAdapter(this.baseUrl) :
      /* default */              new OpenAIAdapter(this.baseUrl);

    const defaultFetch = isTauri ? tauriFetch : fetch.bind(globalThis);
    const defaultStreamFetch = isTauri ? tauriStreamFetch : fetch.bind(globalThis);
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.streamFetchImpl = opts.streamFetchImpl ?? opts.fetchImpl ?? defaultStreamFetch;
  }

  /**
   * Build the full stream endpoint URL.
   *
   * For Anthropic, the canonical path is `/v1/messages`. Providers that
   * include `/vN` in the configured base receive `/messages`; providers
   * with a bare provider path receive `/v1/messages`.
   */
  private buildStreamUrl(): string {
    if (this.adapter instanceof AnthropicAdapter) {
      // If the base URL already ends with /vN (e.g. /v1, /v5), just
      // append /messages.  Otherwise supply the canonical /v1/messages.
      // This is future-proof: when a provider moves to /v5, the user
      // sets the base URL accordingly and we follow it.
      if (/\/v\d+$/i.test(this.serverRoot)) {
        return `${this.serverRoot}/messages`;
      }
      return `${this.serverRoot}/v1/messages`;
    }
    return `${this.serverRoot}${this.adapter.streamEndpoint}`;
  }

  /** List all models known to the server, under an optional parent lifecycle. */
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    // In Tauri, ordinary `tauriFetch` uses the non-cancellable proxy_request
    // command. Parent-owned work must use the streaming relay when a signal is
    // present, just like signal-bearing non-streaming generation requests.
    const requestFetch = signal ? this.streamFetchImpl as typeof fetch : this.fetchImpl;
    if (this.adapter.protocol === 'gemini-rest') {
      return listGeminiModels(this.modelFetchUrl ?? `${this.serverRoot}/models`, this.apiKey,
        requestFetch, signal, this.requestHeaderSettings, this.baseUrl);
    }
    return listModels(
      this.serverRoot,
      this.baseUrl,
      this.apiKey,
      requestFetch,
      this.modelsCache,
      this.modelFetchUrl,
      signal,
      this.requestHeaderSettings,
    );
  }

  /**
   * Stream a chat completion. Routes to the correct adapter's parseStream
   * based on the apiVariant chosen at construction time.
   *
   * Accepts the unified adapter request shape and callback object used by
   * every provider adapter.
   */
  async chatStream(
    params: AdapterRequestParams,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    timeoutMs?: number,
    prefixScope?: PrefixDiagnosticScope,
    context?: ChatRequestContext,
  ): Promise<StreamResult> {
    const providerContract = params.providerContract
      ?? this.providerContract
      ?? (params.providerContractStatus === 'unmatched'
        || this.providerContractStatus === 'unmatched'
        ? undefined
        : resolveBundledProviderContract({
            baseUrl: this.baseUrl,
            protocol: this.providerContractWireProtocol,
            modelId: params.model,
          }));
    const providerContractStatus = params.providerContractStatus
      ?? this.providerContractStatus
      ?? (providerContract ? 'matched' : 'unmatched');
    const requestParams: AdapterRequestParams = {
      ...params,
      baseUrl: this.baseUrl,
      messages: this.adapter.protocol === 'gemini-rest' ? params.messages : sanitizeToolMessages(params.messages),
      stream: true,
      ...(providerContract ? { providerContract } : {}),
      providerContractStatus,
    };
    const body = this.adapter.buildRequest(requestParams);
    const headers = withProfileRequestHeaders(
      this.adapter.buildHeaders(this.apiKey),
      this.requestHeaderSettings,
    );
    const url = this.buildStreamUrl() + (this.adapter.protocol === 'gemini-rest' ? '?alt=sse' : '');

    // Prefix diagnostics observe the FINAL provider-shaped body, read-only,
    // before it is sent. The comparison is started but not awaited here so it
    // cannot delay or reshape the request; its bounded conclusion is attached
    // to the result at the end. Any failure is swallowed — a diagnostic must
    // never change the outcome of the operation it observes.
    const prefixPromise = this.startPrefixComparison(body, params, prefixScope);

    // One ephemeral, ring-local number pairs this request with its own terminal
    // stream result. It is not a provider, request, message, conversation, or
    // profile identifier, and not a content hash (support-report.md).
    //
    // It is allocated before the call and handed to the caller immediately, so
    // every terminal path — including the ones that throw — can pair with this
    // request and only this request.
    const sequence = nextDiagnosticSequence();
    const shape = this.requestShape();
    context?.onSequence?.(sequence);

    // The shape of the request that is about to be sent, captured here because
    // this is the only place the final structured payload exists. Recorded for
    // failing requests too: those are the ones a report most needs to describe.
    const captureSnapshot = (sent: AdapterRequestParams, sentBody: unknown): void => {
      recordActiveRequestSnapshot({
        ...shape,
        routing: this.routing,
        cacheSurface: this.cacheSurface(),
        reasoningEnabled: sent.reasoningEnabled === true,
        reasoningEffort: sent.reasoningEnabled === true
          ? reasoningEffortLevel(sent.reasoningEffort)
          : 'none',
        ...(timeoutMs !== undefined ? { streamTimeoutMs: timeoutMs } : {}),
        toolDefinitionCount: toolDefinitionCount(sentBody, sent.tools),
        ...(context?.capabilities ? { capabilities: context.capabilities } : {}),
        ...(context?.contextWindowKnown !== undefined
          ? { contextWindowKnown: context.contextWindowKnown }
          : {}),
        at: Date.now(),
      }, context?.diagnosticSessionId);
    };
    captureSnapshot(requestParams, body);

    let res: Response;
    try {
      res = await this.streamFetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
        responseTimeoutMs: timeoutMs ?? SSE_READ_TIMEOUT_MS,
      });
    } catch (error) {
      recordDiagnosticEvent({
        subsystem: 'provider',
        operation: 'request',
        outcome: signal?.aborted ? 'cancelled' : 'error',
        code: signal?.aborted ? 'user-cancelled' : 'network-error',
        sequence,
        ...shape,
        description: error,
      });
      throw error;
    }

    // A native server can reject one request for two independent reasons LC
    // knows how to answer — the input discriminator and `reasoning` — and it
    // reports one of them at a time. Each attempt therefore corrects the error
    // the previous attempt drew, and two corrections exist, so two retries are
    // the most that can help.
    if (!res.ok && this.adapter instanceof LMStudioRestAdapter) {
      let sentParams = requestParams;
      for (let attempt = 0; attempt < NATIVE_MAX_CORRECTIONS && !res.ok; attempt++) {
        const errorText = await res.text();
        const correction = this.nativeCorrection(errorText, sentParams);
        if (!correction) {
          recordDiagnosticEvent({
            subsystem: 'provider',
            operation: 'request',
            outcome: 'error',
            code: 'http-error',
            httpStatus: res.status,
            sequence,
            ...shape,
          });
          throw new Error(`chat failed: ${res.status} ${res.statusText}\n${errorText}`);
        }
        recordDiagnosticEvent({
          subsystem: 'provider',
          operation: 'request',
          outcome: 'rejected',
          code: correction.code,
          httpStatus: res.status,
          sequence,
          retried: true,
          ...shape,
        });
        debugLog.warn(`[LC] chatStream: ${correction.reason}, retrying`);
        sentParams = correction.params;
        const retryBody = this.adapter.buildRequest(sentParams);
        // The retry is the request that is actually served, so it — not the
        // rejected attempt — is what `activeRequest` must describe.
        captureSnapshot(sentParams, retryBody);
        res = await this.streamFetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(retryBody),
          signal,
          responseTimeoutMs: timeoutMs ?? SSE_READ_TIMEOUT_MS,
        });
      }
    }

    if (!res.ok) {
      const text = await res.text();
      recordDiagnosticEvent({
        subsystem: 'provider',
        operation: 'request',
        outcome: 'error',
        code: 'http-error',
        httpStatus: res.status,
        sequence,
        ...shape,
      });
      throw new Error(`chat failed: ${res.status} ${res.statusText}\n${text}`);
    }
    if (!res.body) {
      recordDiagnosticEvent({ subsystem: 'provider', operation: 'request', outcome: 'error', code: 'missing-response-body', sequence, ...shape });
      throw new Error('Response has no body (streaming not supported)');
    }

    recordDiagnosticEvent({ subsystem: 'provider', operation: 'request', outcome: 'ok', sequence, ...shape });

    const toolAcc = new ToolCallAccumulator();
    const result = await this.adapter.parseStream(res.body, callbacks, timeoutMs ?? 300_000, toolAcc);
    if (result.gemini_interactions) {
      result.gemini_interactions = result.gemini_interactions.map((group) => ({
        ...group, origin: { baseUrl: this.baseUrl, model: params.model },
      }));
    }
    const prefix = await prefixPromise;
    return { ...result, ...(prefix ? { prefix } : {}), diagnosticSequence: sequence };
  }

  /**
   * The single correction a rejected native LM Studio request asks for, or
   * null when the rejection is not one LC can answer.
   *
   * Both corrections describe a request LC built wrongly for *this* server, so
   * each is applied once and the rebuilt request is the one that is served.
   * `input-shape-retry` changes adapter state, so every later request from
   * this client already carries the discriminator the server named.
   */
  private nativeCorrection(
    errorText: string,
    params: AdapterRequestParams,
  ): { params: AdapterRequestParams; code: 'input-shape-retry' | 'reasoning-retry'; reason: string } | null {
    if (!(this.adapter instanceof LMStudioRestAdapter)) return null;
    const accepted = rejectedInputTextType(errorText);
    if (accepted && accepted !== this.adapter.inputTextItemType) {
      this.adapter.useTextItemType(accepted);
      return { params, code: 'input-shape-retry', reason: `server expects input items typed '${accepted}'` };
    }
    if (params.reasoningEnabled && isReasoningRejection(errorText)) {
      return {
        params: { ...params, reasoningEnabled: false },
        code: 'reasoning-retry',
        reason: 'reasoning rejected by server',
      };
    }
    return null;
  }

  /**
   * Closed-vocabulary description of this client's request shape. Carries no
   * host, credential, header, or body — the endpoint becomes a class only.
   */
  private requestShape(): {
    protocol: 'openai' | 'anthropic' | 'lmstudio-rest' | 'gemini-rest';
    apiStyle: 'chat' | 'responses' | 'not-applicable';
    endpointClass: ReturnType<typeof classifyEndpoint>;
  } {
    const protocol = this.adapter.protocol;
    return {
      protocol,
      apiStyle: protocol !== 'openai'
        ? 'not-applicable'
        : this.adapter instanceof OpenAIResponsesAdapter ? 'responses' : 'chat',
      endpointClass: classifyEndpoint(this.baseUrl),
    };
  }

  /**
   * Which cache surface this request is sent to. Derived from the same router
   * classification the usage normalizer uses, so a routed request is never
   * described as provider-native. No upstream provider is ever inferred.
   */
  private cacheSurface(): 'provider-native' | 'router' | 'none' {
    if (usageReporterForBaseUrl(this.baseUrl) === 'router') return 'router';
    return this.adapter.protocol === 'lmstudio-rest' ? 'none' : 'provider-native';
  }

  /**
   * Start the read-only prefix comparison for this request.
   *
   * Returns `undefined` when no conversation/profile scope was supplied
   * (sub-agent calls, probes) or when the comparison fails for any reason.
   */
  private startPrefixComparison(
    body: unknown,
    params: AdapterRequestParams,
    scope?: PrefixDiagnosticScope,
  ): Promise<PrefixDiagnostic | undefined> {
    if (!scope) return Promise.resolve(undefined);
    try {
      const requestScope = {
        conversationId: scope.conversationId,
        profileId: scope.profileId,
        protocol: this.adapter.protocol,
        apiStyle: this.adapter.streamEndpoint,
        model: params.model,
      };
      return comparePrefix({
        segments: describeRequest(body, requestScope),
        scope: requestScope,
        viaRouter: usageReporterForBaseUrl(this.baseUrl) === 'router',
      }).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  /**
   * Non-streaming chat completion.
   *
   * When an endpoint returns SSE despite `stream: false`, the response
   * body is parsed locally — the request is never repeated because
   * generation requests are not idempotent.
   */
  async chatOnce(
    params: AdapterRequestParams,
    opts?: { signal?: AbortSignal; deadlineMs?: number },
  ): Promise<string> {
    const signal = opts?.signal;
    const deadline = opts?.deadlineMs;
    const requestParams: AdapterRequestParams = {
      ...params,
      baseUrl: this.baseUrl,
      messages: this.adapter.protocol === 'gemini-rest' ? params.messages : sanitizeToolMessages(params.messages),
      stream: false,
      providerContract: params.providerContract ?? this.providerContract
        ?? (params.providerContractStatus === 'unmatched' || this.providerContractStatus === 'unmatched'
          ? undefined : resolveBundledProviderContract({
            baseUrl: this.baseUrl, protocol: this.providerContractWireProtocol, modelId: params.model,
          })),
    };
    const body = this.adapter.buildRequest(requestParams);
    const headers = withProfileRequestHeaders(
      this.adapter.buildHeaders(this.apiKey),
      this.requestHeaderSettings,
    );
    const url = this.buildStreamUrl();

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (deadline != null && performance.now() > deadline) {
      throw new Error('chatOnce: deadline exceeded before request');
    }

    // In Tauri, ordinary `tauriFetch` is backed by the non-cancellable
    // `proxy_request` command. A signal-bearing generation request must use
    // the streaming relay even when the provider request itself has
    // `stream: false`; that relay owns a native cancellation token and its
    // Response body still exposes the complete JSON payload to `res.text()`.
    const requestFetch = signal ? this.streamFetchImpl : this.fetchImpl;
    const responseTimeoutMs = deadline != null
      ? Math.max(1, deadline - performance.now())
      : SSE_READ_TIMEOUT_MS;
    let res: Response;
    try {
      res = await requestFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
        ...(signal ? { responseTimeoutMs } : {}),
      });
    } catch (error) {
      recordDiagnosticEvent({
        subsystem: 'provider',
        operation: 'request',
        outcome: signal?.aborted ? 'cancelled' : 'error',
        code: signal?.aborted ? 'user-cancelled' : 'network-error',
        description: error,
      });
      throw error;
    }

    // Same two corrections, and the same one-at-a-time reporting, as the
    // streaming path above.
    if (!res.ok && this.adapter instanceof LMStudioRestAdapter) {
      let sentParams = requestParams;
      for (let attempt = 0; attempt < NATIVE_MAX_CORRECTIONS && !res.ok; attempt++) {
        const errorText = await res.text();
        const correction = this.nativeCorrection(errorText, sentParams);
        if (!correction) {
          recordDiagnosticEvent({ subsystem: 'provider', operation: 'request', outcome: 'error', code: 'http-error', httpStatus: res.status });
          throw new Error(`chat failed: ${res.status} ${res.statusText}\n${errorText}`);
        }
        recordDiagnosticEvent({ subsystem: 'provider', operation: 'request', outcome: 'rejected', code: correction.code, httpStatus: res.status });
        debugLog.warn(`[LC] chatOnce: ${correction.reason}, retrying`);
        sentParams = correction.params;
        const retryBody = this.adapter.buildRequest(sentParams);
        res = await requestFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(retryBody),
          signal,
          ...(signal ? { responseTimeoutMs } : {}),
        });
      }
    }

    if (!res.ok) {
      const text = await res.text();
      recordDiagnosticEvent({ subsystem: 'provider', operation: 'request', outcome: 'error', code: 'http-error', httpStatus: res.status });
      throw new Error(`chat failed: ${res.status} ${res.statusText}\n${text}`);
    }

    const rawText = await res.text();
    try {
      const json = JSON.parse(rawText);
      if (this.adapter.protocol === 'gemini-rest') {
        if (!record(json) || json.status !== 'completed' || !Array.isArray(json.steps)) {
          const detail = record(json) && record(json.error) && typeof json.error.message === 'string'
            ? json.error.message : 'incomplete or malformed response';
          throw new Error(`Gemini helper request failed: ${detail}`);
        }
        return json.steps.filter((step: unknown) => record(step) && step.type === 'model_output')
          .map((step: Record<string, unknown>) => geminiText(step.content)).join('');
      }
      if (this.adapter.protocol === 'anthropic') {
        const content = json?.content as Array<{ type: string; text?: string }> | undefined;
        return content?.find((c) => c.type === 'text')?.text ?? '';
      }
      if (this.adapter instanceof OpenAIResponsesAdapter) {
        const msg = (json?.output as Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>)
          ?.find((o) => o.type === 'message');
        const textBlock = msg?.content?.find((c) => c.type === 'output_text');
        const refusalBlock = msg?.content?.find((c) => c.type === 'refusal');
        return textBlock?.text ?? refusalBlock?.refusal ?? '';
      }
      const chat = json as {
        choices?: Array<{ message?: { content?: string; refusal?: string } }>;
      };
      return chat.choices?.[0]?.message?.content
        ?? chat.choices?.[0]?.message?.refusal
        ?? '';
    } catch (error) {
      if (this.adapter.protocol === 'gemini-rest' && !(error instanceof SyntaxError)) throw error;
      if (!rawText.trim()) return '';
    }

    const enc = new TextEncoder();
    const localBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(rawText));
        controller.close();
      },
    });
    let content = '';
    let refusal = '';
    const toolAcc = new ToolCallAccumulator();
    const streamTimeoutMs = deadline != null
      ? Math.max(1, deadline - performance.now())
      : 300_000;
    const result = await this.adapter.parseStream(
      localBody,
      {
        onDelta: (delta) => { content += delta; },
        onRefusal: (delta) => { refusal += delta; },
      },
      streamTimeoutMs,
      toolAcc,
    );
    if (this.adapter.protocol === 'gemini-rest') {
      if (result.finish_reason !== 'stop') throw new Error(result.error_message ?? 'Gemini helper response did not complete.');
      return result.content;
    }
    return content || refusal;
  }

  /**
   * Cheap health-check used by the UI to show a green/red dot.
   * Returns OK if /models responds 2xx.
   */
  async testConnection(): Promise<
    { ok: true; models: ModelInfo[] } | { ok: false; error: string }
  > {
    try {
      const models = await this.listModels();
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}

/**
 * Convert an arbitrary thrown value into a friendly, actionable error
 * message. We pay special attention to network and CORS failures, which
 * look identical to the caller (`TypeError: Failed to fetch`) but mean
 * very different things in practice.
 */
export function errorMessage(err: unknown): string {
  if (
    err instanceof TypeError &&
    /dynamically imported module|importing a module script failed/i.test(err.message)
  ) {
    return `${err.message} Reload LC; in a development session, restart the Vite dev server if the error persists.`;
  }
  if (err instanceof TypeError && /Failed to fetch|NetworkError|Load failed/i.test(err.message)) {
    return `${err.message} â€” is the LM Studio server reachable? If the host responds in a terminal but not in the browser, enable CORS in LM Studio (Developer â†’ Server settings) or load this app from the same origin.`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
