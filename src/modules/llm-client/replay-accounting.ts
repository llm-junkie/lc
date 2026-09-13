import type { NormalizedUsage } from './cache-usage';
import { resolveBundledProviderContract } from './provider-contracts.ts';
import type {
  AnthropicReplayBlock,
  OpaqueReplayAccountingGroup,
  OpaqueReplayReasoningCarrier,
  ResponsesOutputItem,
} from './types';

const MAX_GROUPS = 256;
const MAX_LOCATORS_PER_GROUP = 512;
const MAX_PROVIDER_ID_CHARS = 512;

const CARRIERS = new Set<OpaqueReplayReasoningCarrier>([
  'encrypted-content',
  'signed-thinking',
  'redacted-thinking',
  'mixed-anthropic-thinking',
  'plaintext',
  'none',
  'unknown',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Exact Messages contract behind a stored base URL, if any. Centralizes the
 * Meta summary-carrier rule so group creation, revalidation, and projection
 * agree even where only a URL (not a resolved contract) is in hand. Only the
 * exact first-party origin resolves; every other host keeps legacy behavior.
 */
function messagesContractIdForBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return resolveBundledProviderContract({ baseUrl, protocol: 'anthropic-messages' })?.contract.id;
  } catch {
    return undefined;
  }
}

/** Exact Responses contract behind a stored base URL, if any. */
function responsesContractIdForBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return resolveBundledProviderContract({ baseUrl, protocol: 'openai-responses' })?.contract.id;
  } catch {
    return undefined;
  }
}

function providerId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PROVIDER_ID_CHARS;
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function replayResponseItem(value: unknown): value is ResponsesOutputItem {
  if (!isRecord(value) || !providerId(value.id)) return false;
  if (value.type === 'reasoning') {
    return (value.encrypted_content === undefined || typeof value.encrypted_content === 'string')
      && (value.content === undefined || (Array.isArray(value.content)
        && value.content.every((part) => isRecord(part)
          && part.type === 'reasoning_text' && typeof part.text === 'string')));
  }
  if (value.type === 'message') {
    return value.role === 'assistant' && Array.isArray(value.content);
  }
  return value.type === 'function_call'
    && typeof value.call_id === 'string'
    && typeof value.name === 'string'
    && typeof value.arguments === 'string';
}

function replayAnthropicBlock(value: unknown): value is AnthropicReplayBlock {
  if (!isRecord(value)) return false;
  if (value.type === 'thinking') {
    return typeof value.thinking === 'string'
      && (value.signature === undefined || typeof value.signature === 'string');
  }
  return value.type === 'redacted_thinking' && typeof value.data === 'string';
}

export function isOpaqueReasoningCarrier(carrier: OpaqueReplayReasoningCarrier): boolean {
  return carrier === 'encrypted-content'
    || carrier === 'signed-thinking'
    || carrier === 'redacted-thinking'
    || carrier === 'mixed-anthropic-thinking';
}

export function classifyResponsesReasoningCarrier(
  items: readonly ResponsesOutputItem[],
  options: { baseUrl?: string; providerContractId?: string } = {},
): OpaqueReplayReasoningCarrier {
  let plaintext = false;
  let encrypted = false;
  for (const item of items) {
    if (item.type !== 'reasoning') continue;
    if (typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0) {
      encrypted = true;
    }
    if (item.content?.some((part) => typeof part.text === 'string' && part.text.length > 0)) {
      plaintext = true;
    }
  }
  const providerContractId = options.providerContractId
    ?? responsesContractIdForBaseUrl(options.baseUrl);
  // DeepSeek documents reasoning_text as its Responses replay carrier and
  // rejects encrypted_content inside reasoning input items. Some real
  // responses nevertheless include both fields. Preserve that raw output,
  // but classify the replayable carrier from the exact provider contract.
  if (providerContractId === 'deepseek.responses' && plaintext) return 'plaintext';
  if (encrypted) return 'encrypted-content';
  return plaintext ? 'plaintext' : 'none';
}

export function classifyAnthropicReasoningCarrier(
  blocks: readonly AnthropicReplayBlock[],
  options: { baseUrl?: string; providerContractId?: string } = {},
): OpaqueReplayReasoningCarrier {
  // MiniMax's documented Anthropic-compatible response exposes the complete
  // reasoning in `thinking` and accompanies it with a fixed-size 64-hex
  // signature. That value cannot contain an encrypted copy of an arbitrarily
  // long reasoning stream; it is replay-integrity state. Recognize the shape
  // itself so MiniMax remains plaintext through compatible relays. The
  // official hosts are retained as a documented fallback if their signature
  // encoding changes, while every other signature remains conservatively
  // opaque.
  const documentedMiniMaxEndpoint = (() => {
    if (!options.baseUrl) return false;
    try {
      const hostname = new URL(options.baseUrl).hostname.toLowerCase();
      return hostname === 'api.minimax.io' || hostname === 'api.minimaxi.com';
    } catch {
      return false;
    }
  })();
  let signed = false;
  let redacted = false;
  let plaintext = false;
  // An explicit contract wins; otherwise resolve the exact Messages contract
  // behind the base URL so direct classifier callers agree with group
  // creation and revalidation. Only the exact first-party origin resolves.
  const providerContractId = options.providerContractId
    ?? messagesContractIdForBaseUrl(options.baseUrl);
  for (const block of blocks) {
    if (block.type === 'thinking') {
      const signature = block.signature ?? '';
      const miniMaxReplaySignature = /^[0-9a-f]{64}$/i.test(signature);
      if (!documentedMiniMaxEndpoint && !miniMaxReplaySignature && signature.length > 0) signed = true;
      // Meta Messages documents `thinking` as a reasoning summary while
      // `redacted_thinking` carries the encrypted continuation state. An
      // unsigned summary must never read as locally countable chain of
      // thought, or the TokenMeter would measure the summary's characters
      // instead of binding terminal `thinking_tokens` to the opaque block.
      // https://ai.developer.meta.com/docs/protocols/messages
      else if (block.thinking.length > 0 && providerContractId !== 'meta.messages') {
        plaintext = true;
      }
    } else if (block.data.length > 0) {
      redacted = true;
    }
  }
  if (signed && redacted) return 'mixed-anthropic-thinking';
  if (signed) return 'signed-thinking';
  if (redacted) return 'redacted-thinking';
  return plaintext ? 'plaintext' : 'none';
}

function reasoningTokens(usage: NormalizedUsage | undefined): number | undefined {
  const reasoning = usage?.reasoning;
  if (!reasoning || reasoning.status !== 'reported') return undefined;
  return tokenCount(reasoning.tokens) ? reasoning.tokens : undefined;
}

export function createResponsesReplayAccountingGroup(
  items: readonly ResponsesOutputItem[],
  usage: NormalizedUsage | undefined,
  toolCallIds: readonly string[] = [],
  includeEmpty = false,
  baseUrl?: string,
  providerContractId?: string,
): OpaqueReplayAccountingGroup | undefined {
  const itemIds = items.map((item) => item.id).filter(providerId);
  const calls = toolCallIds.filter(providerId).slice(0, MAX_LOCATORS_PER_GROUP);
  if (!includeEmpty && itemIds.length === 0 && calls.length === 0) return undefined;
  const reasoningCarrier = classifyResponsesReasoningCarrier(items, {
    baseUrl,
    providerContractId: providerContractId ?? responsesContractIdForBaseUrl(baseUrl),
  });
  const tokens = isOpaqueReasoningCarrier(reasoningCarrier) ? reasoningTokens(usage) : undefined;
  return {
    schemaVersion: 1,
    protocol: 'openai-responses',
    reasoningCarrier,
    ...(tokens !== undefined ? { generatedReasoningTokens: tokens } : {}),
    tokenStatus: tokens !== undefined ? 'provider-reported' : 'unreported',
    locator: { kind: 'responses-item-ids', itemIds },
    ...(calls.length > 0 ? { toolCallIds: calls } : {}),
  };
}

export function createAnthropicReplayAccountingGroup(
  blocks: readonly AnthropicReplayBlock[],
  blockOffset: number,
  usage: NormalizedUsage | undefined,
  toolCallIds: readonly string[] = [],
  includeEmpty = false,
  baseUrl?: string,
  providerContractId?: string,
): OpaqueReplayAccountingGroup | undefined {
  const calls = toolCallIds.filter(providerId).slice(0, MAX_LOCATORS_PER_GROUP);
  if (!includeEmpty && blocks.length === 0 && calls.length === 0) return undefined;
  const reasoningCarrier = classifyAnthropicReasoningCarrier(blocks, {
    baseUrl,
    providerContractId: providerContractId ?? messagesContractIdForBaseUrl(baseUrl),
  });
  const tokens = isOpaqueReasoningCarrier(reasoningCarrier) ? reasoningTokens(usage) : undefined;
  return {
    schemaVersion: 1,
    protocol: 'anthropic-messages',
    reasoningCarrier,
    ...(tokens !== undefined ? { generatedReasoningTokens: tokens } : {}),
    tokenStatus: tokens !== undefined ? 'provider-estimate' : 'unreported',
    locator: {
      kind: 'anthropic-block-indexes',
      blockIndexes: blocks.map((_block, index) => blockOffset + index),
    },
    ...(calls.length > 0 ? { toolCallIds: calls } : {}),
  };
}

/**
 * Validate imported/persisted metadata against the exact replay arrays. Any
 * malformed or stale group is dropped rather than guessed or partially kept.
 */
export function normalizeOpaqueReplayAccounting(
  raw: unknown,
  state: {
    responsesOutputItems?: readonly ResponsesOutputItem[];
    responsesBaseUrl?: string;
    responsesProviderContractId?: string;
    anthropicOutputBlocks?: readonly AnthropicReplayBlock[];
    anthropicBaseUrl?: string;
    anthropicProviderContractId?: string;
  },
): OpaqueReplayAccountingGroup[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_GROUPS) return undefined;
  const responseItems = Array.isArray(state.responsesOutputItems)
    ? state.responsesOutputItems.filter(replayResponseItem)
    : [];
  const responseIds = new Map(responseItems.map((item) => [item.id, item]));
  const anthropicBlocks: Array<AnthropicReplayBlock | undefined> = Array.isArray(state.anthropicOutputBlocks)
    ? state.anthropicOutputBlocks.map((block) => replayAnthropicBlock(block) ? block : undefined)
    : [];
  const seenResponseIds = new Set<string>();
  const seenBlockIndexes = new Set<number>();
  const normalized: OpaqueReplayAccountingGroup[] = [];

  for (const candidate of raw) {
    if (!isRecord(candidate)
      || candidate.schemaVersion !== 1
      || (candidate.protocol !== 'openai-responses' && candidate.protocol !== 'anthropic-messages')
      || typeof candidate.reasoningCarrier !== 'string'
      || !CARRIERS.has(candidate.reasoningCarrier as OpaqueReplayReasoningCarrier)
      || (candidate.tokenStatus !== 'provider-reported'
        && candidate.tokenStatus !== 'provider-estimate'
        && candidate.tokenStatus !== 'unreported')
      || !isRecord(candidate.locator)) {
      continue;
    }

    const toolCallIds = candidate.toolCallIds === undefined
      ? undefined
      : Array.isArray(candidate.toolCallIds)
        && candidate.toolCallIds.length <= MAX_LOCATORS_PER_GROUP
        && candidate.toolCallIds.every(providerId)
        && new Set(candidate.toolCallIds).size === candidate.toolCallIds.length
        ? [...candidate.toolCallIds]
        : null;
    if (toolCallIds === null) continue;

    const carrier = candidate.reasoningCarrier as OpaqueReplayReasoningCarrier;
    const opaque = isOpaqueReasoningCarrier(carrier);
    const generated = candidate.generatedReasoningTokens;
    if (candidate.tokenStatus === 'unreported') {
      if (generated !== undefined) continue;
    } else if (!opaque || !tokenCount(generated)) {
      continue;
    }
    if (candidate.protocol === 'openai-responses' && candidate.tokenStatus === 'provider-estimate') continue;
    if (candidate.protocol === 'anthropic-messages' && candidate.tokenStatus === 'provider-reported') continue;

    if (candidate.protocol === 'openai-responses') {
      if (candidate.locator.kind !== 'responses-item-ids'
        || !Array.isArray(candidate.locator.itemIds)
        || candidate.locator.itemIds.length > MAX_LOCATORS_PER_GROUP
        || !candidate.locator.itemIds.every(providerId)
        || new Set(candidate.locator.itemIds).size !== candidate.locator.itemIds.length
        || candidate.locator.itemIds.some((id) => !responseIds.has(id) || seenResponseIds.has(id))) {
        continue;
      }
      const items = candidate.locator.itemIds.map((id) => responseIds.get(id)!);
      const classifiedCarrier = classifyResponsesReasoningCarrier(items, {
        baseUrl: state.responsesBaseUrl,
        providerContractId: state.responsesProviderContractId
          ?? responsesContractIdForBaseUrl(state.responsesBaseUrl),
      });
      // Runs persisted before DeepSeek's exact Responses carrier was applied
      // stored mixed plaintext/encrypted items as opaque. Canonicalize those
      // groups without losing their response/tool boundary; the provider token
      // count no longer belongs to an opaque carrier after migration.
      const migratesDeepSeekPlaintext = carrier === 'encrypted-content'
        && classifiedCarrier === 'plaintext';
      if (classifiedCarrier !== carrier && !migratesDeepSeekPlaintext) continue;
      candidate.locator.itemIds.forEach((id) => seenResponseIds.add(id));
      normalized.push({
        schemaVersion: 1,
        protocol: 'openai-responses',
        reasoningCarrier: classifiedCarrier,
        ...(!migratesDeepSeekPlaintext && generated !== undefined
          ? { generatedReasoningTokens: generated as number }
          : {}),
        tokenStatus: migratesDeepSeekPlaintext
          ? 'unreported'
          : candidate.tokenStatus as 'provider-reported' | 'unreported',
        locator: { kind: 'responses-item-ids', itemIds: [...candidate.locator.itemIds] },
        ...(toolCallIds?.length ? { toolCallIds } : {}),
      });
      continue;
    }

    if (candidate.locator.kind !== 'anthropic-block-indexes'
      || !Array.isArray(candidate.locator.blockIndexes)
      || candidate.locator.blockIndexes.length > MAX_LOCATORS_PER_GROUP
      || !candidate.locator.blockIndexes.every((index) => Number.isSafeInteger(index)
        && index >= 0
        && index < anthropicBlocks.length
        && anthropicBlocks[index] !== undefined)
      || new Set(candidate.locator.blockIndexes).size !== candidate.locator.blockIndexes.length
      || candidate.locator.blockIndexes.some((index) => seenBlockIndexes.has(index))) {
      continue;
    }
    const blocks = candidate.locator.blockIndexes.map((index) => anthropicBlocks[index]!);
    const classifiedCarrier = classifyAnthropicReasoningCarrier(blocks, {
      baseUrl: state.anthropicBaseUrl,
      providerContractId: state.anthropicProviderContractId
        ?? messagesContractIdForBaseUrl(state.anthropicBaseUrl),
    });
    // Archives created before MiniMax's fixed-size replay signature was
    // distinguished from Anthropic's encrypted signature stored these groups
    // as opaque. Canonicalize them on validation so their response boundaries
    // and tool-call ordering survive, while the obsolete provider estimate is
    // no longer attached to a locally countable carrier.
    const migratesMiniMaxPlaintext = carrier === 'signed-thinking'
      && classifiedCarrier === 'plaintext';
    if (classifiedCarrier !== carrier && !migratesMiniMaxPlaintext) continue;
    candidate.locator.blockIndexes.forEach((index) => seenBlockIndexes.add(index));
    normalized.push({
      schemaVersion: 1,
      protocol: 'anthropic-messages',
      reasoningCarrier: classifiedCarrier,
      ...(!migratesMiniMaxPlaintext && generated !== undefined
        ? { generatedReasoningTokens: generated as number }
        : {}),
      tokenStatus: migratesMiniMaxPlaintext
        ? 'unreported'
        : candidate.tokenStatus as 'provider-estimate' | 'unreported',
      locator: { kind: 'anthropic-block-indexes', blockIndexes: [...candidate.locator.blockIndexes] },
      ...(toolCallIds?.length ? { toolCallIds } : {}),
    });
  }

  // A pre-fix Anthropic run could inherit a stale `apiStyle: responses` value
  // and write an empty Responses boundary beside every valid Anthropic group.
  // Once at least one Anthropic group validates and there are no Responses
  // items, those empty cross-protocol groups carry no state or ordering that
  // the active message can use. Remove them during canonicalization.
  const canonical = responseItems.length === 0
    && normalized.some((group) => group.protocol === 'anthropic-messages')
    ? normalized.filter((group) => group.protocol !== 'openai-responses'
      || group.locator.kind !== 'responses-item-ids'
      || group.locator.itemIds.length > 0)
    : normalized;
  return canonical.length > 0 ? canonical : undefined;
}
