/**
 * Exact server token-count preflight for the first-party Meta Model API.
 *
 * Meta exposes two server tokenizers that count the fully rendered input —
 * including Meta-injected steering, tool scaffolding, media processing, and
 * reconstructed history — with the target model's own tokenizer:
 *
 *   - `POST /v1/responses/input_tokens` for the Responses protocol, taking
 *     the supported fields of a `/v1/responses` body (at minimum `model` and
 *     `input`) and returning `{ object: "response.input_tokens",
 *     input_tokens }`.
 *   - `POST /v1/messages/count_tokens` for the Anthropic-compatible Messages
 *     protocol, taking the same Anthropic-shaped body as `/v1/messages` and
 *     returning `{ input_tokens }`.
 *
 * Sources: the saved first-party Token counting page
 * (`https://dev.meta.ai/docs/token-counting`).
 *
 * Routing is by exact resolved contract ID only. There is no count endpoint
 * for `meta.chat`, and no Meta count call is ever made for a relay, a
 * lookalike origin, or an unmatched provider. Mock tests here verify LC's
 * routing, body construction, parsing, and failure behavior — not Meta's live
 * response. TokenMeter UI wiring (debounce, staleness, display) is a separate
 * lifecycle change; this module owns transport, timeout, abort, credential
 * privacy, and the server/local distinction.
 */

import type { ProviderContractQuery } from './provider-contracts';
import { resolveBundledProviderContract } from './provider-contracts.ts';

/** Exact Meta contracts with a server tokenizer, and nothing else. */
const COUNT_ROUTES = {
  'meta.responses': { path: '/responses/input_tokens' as const },
  'meta.messages': { path: '/messages/count_tokens' as const },
} as const;

type CountableMetaContractId = keyof typeof COUNT_ROUTES;

function isCountableMetaContractId(value: string): value is CountableMetaContractId {
  return (Object.keys(COUNT_ROUTES) as string[]).includes(value);
}

export interface ServerTokenCountRoute {
  contractId: CountableMetaContractId;
  /** Fully joined count URL for the configured base URL. */
  url: string;
}

export type ServerTokenCountUnavailable =
  | { kind: 'unsupported' };

export type ServerTokenCountFailure =
  | { kind: 'http'; status: number; bodySnippet: string }
  | { kind: 'malformed'; bodySnippet: string }
  | { kind: 'aborted' }
  | { kind: 'timeout' }
  | { kind: 'transport'; message: string };

export type ServerTokenCountResult =
  | { ok: true; inputTokens: number; route: ServerTokenCountRoute; model: string }
  | { ok: false; error: ServerTokenCountUnavailable | ServerTokenCountFailure };

/**
 * Resolve the count route from the registry query, never from a bare
 * contract-ID string: a caller-supplied ID is not proof that the base URL
 * behind it is the exact first-party origin. Relays, lookalikes, and
 * unmatched providers resolve to nothing and perform no fetch.
 */
export function serverTokenCountRoute(
  query: ProviderContractQuery,
): ServerTokenCountRoute | undefined {
  const contractId = resolveBundledProviderContract(query)?.contract.id;
  if (!contractId || !isCountableMetaContractId(contractId)) return undefined;
  let root: string;
  try {
    root = new URL(query.baseUrl).toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
  if (contractId === 'meta.responses') {
    // Generation appends `/responses` to the configured base directly, so a
    // bare origin is not a verified Responses surface and has no count route.
    if (!/\/v\d+$/i.test(root)) return undefined;
    return { contractId, url: `${root}/responses/input_tokens` };
  }
  // Mirrors the Messages generation joining: a configured `/vN` base takes
  // the endpoint path, otherwise LC supplies the canonical `/v1` prefix.
  const prefix = /\/v\d+$/i.test(root) ? root : `${root}/v1`;
  return { contractId, url: `${prefix}/messages/count_tokens` };
}

/**
 * Build the count body from the already-rendered generation request so the
 * count represents the same input, history, and tools. Only documented
 * tokenization inputs cross; transport fields (`stream`, `store`) never do.
 */
export function buildServerTokenCountBody(
  route: ServerTokenCountRoute,
  generationRequest: Record<string, unknown>,
): Record<string, unknown> {
  if (route.contractId === 'meta.responses') {
    const body: Record<string, unknown> = {};
    for (const key of [
      'model',
      'input',
      'instructions',
      'tools',
      'tool_choice',
      'parallel_tool_calls',
      'reasoning',
      'include',
      'previous_response_id',
    ]) {
      if (generationRequest[key] !== undefined) body[key] = generationRequest[key];
    }
    return body;
  }
  const { stream: _stream, ...rest } = generationRequest;
  void _stream;
  return rest;
}

const MAX_BODY_SNIPPET_CHARS = 500;

function snippet(value: string): string {
  return value.length > MAX_BODY_SNIPPET_CHARS
    ? `${value.slice(0, MAX_BODY_SNIPPET_CHARS)}…`
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Classify a fetch/read rejection. `AbortSignal.timeout()` rejects with a
 * DOMException named `TimeoutError`, not `AbortError`; reporting it as a
 * transport failure would hide slow-server behavior, and reporting it as a
 * caller abort would misattribute it. Timeout stays distinct so retry policy
 * and diagnostics can tell "the caller cancelled" apart from "the server was
 * too slow".
 */
function classifyAbort(error: unknown): { kind: 'aborted' } | { kind: 'timeout' } | undefined {
  const name = error instanceof DOMException ? error.name : (error as { name?: unknown })?.name;
  if (name === 'AbortError') return { kind: 'aborted' };
  if (name === 'TimeoutError') return { kind: 'timeout' };
  return undefined;
}

/** Parse one count response. The API key never appears in any result. */
export function parseServerTokenCountResponse(
  route: ServerTokenCountRoute,
  payload: unknown,
): { inputTokens: number } | { malformed: string } {
  if (!isRecord(payload)) return { malformed: 'non-object response' };
  const inputTokens = payload.input_tokens;
  if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0) {
    return { malformed: 'missing or invalid input_tokens' };
  }
  if (route.contractId === 'meta.responses' && payload.object !== 'response.input_tokens') {
    return { malformed: 'missing response.input_tokens object marker' };
  }
  return { inputTokens };
}

export interface RequestServerTokenCountOptions {
  /** Registry query for the generation route; resolved internally. */
  query: ProviderContractQuery;
  /** The already-rendered generation request body. */
  generationRequest: Record<string, unknown>;
  apiKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * POST the rendered request to the matching Meta count endpoint. Never throws:
 * every outcome — including unsupported routes, HTTP failures, malformed
 * bodies, caller aborts, timeouts, and transport errors — is a typed result. No credential is
 * ever copied into a result, a diagnostic, or a thrown value.
 */
export async function requestServerTokenCount(
  options: RequestServerTokenCountOptions,
): Promise<ServerTokenCountResult> {
  const route = serverTokenCountRoute(options.query);
  if (!route || !options.apiKey) return { ok: false, error: { kind: 'unsupported' } };
  let response: Response;
  try {
    const timeoutSignal = options.timeoutMs !== undefined
      ? AbortSignal.timeout(options.timeoutMs)
      : undefined;
    const signal = options.signal && timeoutSignal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : options.signal ?? timeoutSignal ?? undefined;
    response = await (options.fetchImpl ?? fetch)(route.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(buildServerTokenCountBody(route, options.generationRequest)),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const abort = classifyAbort(error);
    if (abort) return { ok: false, error: abort };
    return { ok: false, error: { kind: 'transport', message: (error as Error)?.message ?? 'fetch failed' } };
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    const abort = classifyAbort(error);
    if (abort) return { ok: false, error: abort };
    return { ok: false, error: { kind: 'transport', message: (error as Error)?.message ?? 'read failed' } };
  }
  if (!response.ok) {
    return { ok: false, error: { kind: 'http', status: response.status, bodySnippet: snippet(text) } };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: 'malformed', bodySnippet: snippet(text) } };
  }
  const parsed = parseServerTokenCountResponse(route, payload);
  if ('malformed' in parsed) {
    return { ok: false, error: { kind: 'malformed', bodySnippet: parsed.malformed } };
  }
  return { ok: true, inputTokens: parsed.inputTokens, route, model: options.query.modelId ?? '' };
}
