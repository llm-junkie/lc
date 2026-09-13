import type { ChatMessage, OpaqueReplayAccountingGroup, ResponsesOutputItem } from '../llm-client/types';
import { geminiCounter, geminiText, selectGeminiGroups } from '../llm-client/gemini-state.ts';
import { isAnthropicOwnApi } from '../llm-client/anthropic-version.ts';
import {
  canReplayAnthropicOutputBlocks,
  canReplayProviderOutputState,
} from '../llm-client/provider-state.ts';
import {
  classifyAnthropicReasoningCarrier,
  classifyResponsesReasoningCarrier,
  isOpaqueReasoningCarrier,
  normalizeOpaqueReplayAccounting,
} from '../llm-client/replay-accounting.ts';
import {
  effectiveProviderHistory,
  type ResolvedProviderContract,
} from '../llm-client/provider-contracts.ts';

export type ProviderHistoryProtocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'lmstudio-rest'
  | 'gemini-interactions';

export interface ProviderHistoryTarget {
  protocol: ProviderHistoryProtocol;
  model: string;
  baseUrl?: string;
  /** True only for the assistant bubble still inside its tool-use turn. */
  currentToolTurn?: boolean;
  /**
   * Tool History replaced completed call/result items with an archive marker.
   * This flag affects call selection only. It must never authorize removal of
   * a compatible provider reasoning carrier.
   */
  toolCallRewritten?: boolean;
  /** Whether the next request exposes tools, independent of this message. */
  requestHasTools?: boolean;
  /** Exact origin/protocol contract resolved for the next request. */
  providerContract?: ResolvedProviderContract;
  /** A completed lookup with no exact origin/protocol match. */
  providerContractStatus?: 'matched' | 'unmatched';
  /** Persisted source identity for canonical/Responses provider output. */
  sourceOrigin?: { baseUrl: string; model: string };
}

export function providerHistoryProtocol(
  apiVariant?: string,
  apiStyle?: 'chat' | 'responses',
): ProviderHistoryProtocol {
  if (apiVariant === 'anthropic') return 'anthropic-messages';
  if (apiVariant === 'gemini') return 'gemini-interactions';
  if (apiVariant === 'lm-studio') return 'lmstudio-rest';
  return apiStyle === 'responses' ? 'openai-responses' : 'openai-chat';
}

export interface ProviderHistoryProjection {
  geminiInteractions?: ChatMessage['gemini_interactions'];
  responsesOutputItems?: ResponsesOutputItem[];
  anthropicOutputBlocks?: NonNullable<ChatMessage['anthropic_output_blocks']>;
  accountingGroups?: OpaqueReplayAccountingGroup[];
  replyTexts: string[];
  plaintextReasoningTexts: string[];
  opaqueReasoningTokens: number;
  opaqueReasoningMeasurement?: 'provider-counter' | 'provider-estimate' | 'mixed';
  opaqueReasoningUnknown: boolean;
  remoteStateUnknown: boolean;
  useCanonicalReply: boolean;
  useCanonicalReasoning: boolean;
}

export function isDeepSeekEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes('deepseek');
  } catch {
    return baseUrl.toLowerCase().includes('deepseek');
  }
}

function reasoningText(item: Extract<ResponsesOutputItem, { type: 'reasoning' }>): string {
  return item.content?.map((part) => part.text).join('') ?? '';
}

/** Carrier selection shared by Responses request serialization and TokenMeter. */
export function selectResponsesOutputItems(
  message: ChatMessage,
  target: Pick<ProviderHistoryTarget,
    'baseUrl' | 'model' | 'toolCallRewritten' | 'providerContract' | 'providerContractStatus' | 'sourceOrigin'>,
): ResponsesOutputItem[] {
  const resolved = target.providerContract;
  const history = resolved ? effectiveProviderHistory(resolved) : undefined;
  const sourceOrigin = message.provider_output_origin ?? target.sourceOrigin;
  if (target.providerContractStatus === 'unmatched'
    && !canReplayProviderOutputState({
      origin: sourceOrigin,
      targetBaseUrl: target.baseUrl,
      targetModel: target.model,
    })) return [];
  if (resolved && sourceOrigin && !canReplayProviderOutputState({
    origin: sourceOrigin,
    targetBaseUrl: target.baseUrl,
    targetModel: target.model,
    allowModelSwitch: true,
  })) return [];
  const isDeepSeek = target.providerContractStatus !== 'unmatched'
    && isDeepSeekEndpoint(target.baseUrl);
  const hasToolCalls = (message.tool_calls?.length ?? 0) > 0;
  return (message.responses_output_items ?? []).filter((item) => {
    if (item.type === 'function_call') return !target.toolCallRewritten;
    if (item.type !== 'reasoning') return true;
    if (target.providerContractStatus === 'unmatched') return true;
    if (resolved) {
      if (history?.replay === 'none' || history?.replay === 'remote-handle') return false;
      const hasPlaintext = reasoningText(item).trim().length > 0;
      const hasEncrypted = typeof item.encrypted_content === 'string'
        && item.encrypted_content.length > 0;
      return resolved.contract.carriers.some((carrier) => {
        if (carrier.replay !== 'exact' && carrier.replay !== 'plaintext') return false;
        if (hasPlaintext) {
          if (carrier.kind === 'plaintext'
            || carrier.kind === 'signed-plaintext'
            || carrier.kind === 'unknown') return true;
        }
        if (hasEncrypted) return carrier.kind === 'encrypted' || carrier.kind === 'unknown';
        if (hasPlaintext) return false;
        return carrier.kind === 'summary' || carrier.kind === 'unknown';
      });
    }
    // Legacy direct callers retain the previous structural fallback. Real
    // LLMClient requests carry a matched/unmatched contract status above.
    const hasPlaintext = reasoningText(item).trim().length > 0;
    if (isDeepSeek) return hasToolCalls && hasPlaintext;
    return hasPlaintext
      || (typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0);
  });
}

export type AnthropicThinkingRetention = 'all' | 'last-turn-only' | 'unknown';

/**
 * Known deviation: this predicts server-side retention from model names.
 * Anthropic owns that filtering; the meter must show uncertainty when effective
 * occupancy is not authoritatively reported. Compatible servers remain unknown.
 */
export function anthropicThinkingRetention(
  baseUrl: string | undefined,
  model: string,
): AnthropicThinkingRetention {
  if (!isAnthropicOwnApi(baseUrl)) return 'unknown';
  const name = model.toLowerCase();
  if (/\b(?:fable[- ]?5|mythos(?:[- ]?5|[- ]?preview))\b/.test(name)) return 'all';
  if (/\bhaiku\b/.test(name)) return 'last-turn-only';
  const family = name.includes('opus') ? 'opus' : name.includes('sonnet') ? 'sonnet' : undefined;
  if (!family) return 'unknown';
  const match = name.match(new RegExp(`${family}[- .]?(\\d+)(?:[- .](\\d+))?`));
  if (!match) return 'unknown';
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  if (family === 'opus' && (major > 4 || (major === 4 && minor >= 5))) return 'all';
  if (family === 'sonnet' && (major > 4 || (major === 4 && minor >= 6))) return 'all';
  return 'last-turn-only';
}

export function selectAnthropicReplayState(
  message: ChatMessage,
  target: Pick<ProviderHistoryTarget,
    'baseUrl' | 'model' | 'providerContract' | 'providerContractStatus'>,
): {
  blocks?: NonNullable<ChatMessage['anthropic_output_blocks']>;
  groups?: OpaqueReplayAccountingGroup[];
} {
  const blocks = message.anthropic_output_blocks;
  if (!blocks?.length || !canReplayAnthropicOutputBlocks({
    origin: message.anthropic_output_origin,
    targetBaseUrl: target.baseUrl,
    targetModel: target.model,
    allowModelSwitch: target.providerContract !== undefined,
  })) return {};
  const groups = normalizeOpaqueReplayAccounting(message.opaque_replay_accounting, {
    responsesOutputItems: message.responses_output_items,
    anthropicOutputBlocks: blocks,
    anthropicBaseUrl: message.anthropic_output_origin?.baseUrl,
    anthropicProviderContractId: target.providerContract?.contract.id,
  })?.filter((group) => group.protocol === 'anthropic-messages');
  return { blocks: blocks.map((block) => ({ ...block })), ...(groups?.length ? { groups } : {}) };
}

function selectedGroupsForResponses(
  message: ChatMessage,
  items: readonly ResponsesOutputItem[],
  target: Pick<ProviderHistoryTarget,
    'baseUrl' | 'providerContract' | 'toolCallRewritten'>,
): OpaqueReplayAccountingGroup[] {
  const selectedIds = new Set(items.map((item) => item.id));
  const itemsById = new Map((message.responses_output_items ?? []).map((item) => [item.id, item]));
  return (normalizeOpaqueReplayAccounting(message.opaque_replay_accounting, {
    responsesOutputItems: message.responses_output_items,
    responsesBaseUrl: target.baseUrl,
    responsesProviderContractId: target.providerContract?.contract.id,
    anthropicOutputBlocks: message.anthropic_output_blocks,
  }) ?? []).flatMap((group): OpaqueReplayAccountingGroup[] => {
    if (group.protocol !== 'openai-responses'
      || group.locator.kind !== 'responses-item-ids') return [];
    const retainedIds = group.locator.itemIds.filter((id) => selectedIds.has(id));
    if (retainedIds.length === group.locator.itemIds.length) return [group];
    if (!target.toolCallRewritten || retainedIds.length === 0) return [];

    // Tool History rebuilds function_call items with the synthetic archive ID.
    // Keep accounting bound to the provider reasoning carrier that remains on
    // the wire; removed original calls must not make that carrier disappear.
    const retainedItems = retainedIds
      .map((id) => itemsById.get(id))
      .filter((item): item is ResponsesOutputItem => item !== undefined);
    if (classifyResponsesReasoningCarrier(retainedItems, {
      baseUrl: target.baseUrl,
      providerContractId: target.providerContract?.contract.id,
    }) !== group.reasoningCarrier) return [];
    const projected: OpaqueReplayAccountingGroup = {
      ...group,
      locator: { kind: 'responses-item-ids', itemIds: retainedIds },
    };
    delete projected.toolCallIds;
    return [projected];
  });
}

function opaqueTotals(
  groups: readonly OpaqueReplayAccountingGroup[],
): Pick<ProviderHistoryProjection, 'opaqueReasoningTokens' | 'opaqueReasoningMeasurement'> {
  let opaqueReasoningTokens = 0;
  let providerCounter = false;
  let providerEstimate = false;
  for (const group of groups) {
    if (!isOpaqueReasoningCarrier(group.reasoningCarrier)
      || group.generatedReasoningTokens === undefined) continue;
    opaqueReasoningTokens += group.generatedReasoningTokens;
    if (group.tokenStatus === 'provider-reported') providerCounter = true;
    if (group.tokenStatus === 'provider-estimate') providerEstimate = true;
  }
  const opaqueReasoningMeasurement = providerCounter && providerEstimate
    ? 'mixed'
    : providerEstimate ? 'provider-estimate' : providerCounter ? 'provider-counter' : undefined;
  return {
    opaqueReasoningTokens,
    ...(opaqueReasoningMeasurement ? { opaqueReasoningMeasurement } : {}),
  };
}

/** Pure per-assistant projection used by request assembly and TokenMeter. */
export function projectAssistantProviderHistory(
  message: ChatMessage,
  target: ProviderHistoryTarget,
): ProviderHistoryProjection {
  const base: ProviderHistoryProjection = {
    replyTexts: [],
    plaintextReasoningTexts: [],
    opaqueReasoningTokens: 0,
    opaqueReasoningUnknown: false,
    remoteStateUnknown: false,
    useCanonicalReply: true,
    useCanonicalReasoning: false,
  };

  if (target.protocol === 'gemini-interactions') {
    const groups = selectGeminiGroups(message, {
      baseUrl: target.baseUrl, model: target.model,
      allowModelSwitch: target.providerContract?.contract.id === 'google.gemini-interactions',
    });
    let opaqueReasoningUnknown = false;
    let opaqueReasoningTokens = 0;
    for (const group of groups) {
      const thoughts = group.steps.filter((step) => step.type === 'thought');
      if (thoughts.length) {
        const tokens = geminiCounter(group.usage, 'total_thought_tokens');
        const indexes = group.steps.flatMap((step, index) => step.type === 'thought' ? [index] : []);
        const bound = group.thoughtStepIndexes?.length === indexes.length
          && indexes.every((index, position) => group.thoughtStepIndexes?.[position] === index);
        if (!group.complete || !bound || group.origin.model !== target.model
          || tokens === undefined || thoughts.some((step) => !step.signature)) opaqueReasoningUnknown = true;
        else opaqueReasoningTokens += tokens;
      }
      for (const step of group.steps) {
        if (step.type === 'model_output') base.replyTexts.push(geminiText(step.content));
      }
    }
    if (groups.length !== (message.gemini_interactions?.length ?? 0)) opaqueReasoningUnknown = true;
    if (!groups.length && message.reasoning_content) opaqueReasoningUnknown = true;
    return { ...base, geminiInteractions: groups, opaqueReasoningTokens, opaqueReasoningUnknown,
      ...(opaqueReasoningTokens ? { opaqueReasoningMeasurement: 'provider-counter' as const } : {}),
      useCanonicalReply: groups.length === 0 };
  }
  // Gemini summaries are display-only, even when switching to a plaintext-reasoning provider.
  if (message.gemini_interactions?.length) return base;

  if (target.protocol === 'lmstudio-rest') {
    return {
      ...base,
      useCanonicalReply: false,
      remoteStateUnknown: typeof message.lmstudio_response_id === 'string'
        && message.lmstudio_response_id.length > 0,
    };
  }

  if (target.protocol === 'openai-responses') {
    const items = selectResponsesOutputItems(message, target);
    const unmatchedSameOrigin = target.providerContractStatus === 'unmatched'
      && canReplayProviderOutputState({
        origin: message.provider_output_origin ?? target.sourceOrigin,
        targetBaseUrl: target.baseUrl,
        targetModel: target.model,
      });
    const groups = selectedGroupsForResponses(message, items, target);
    const coveredOpaqueIds = new Set(groups.flatMap((group) => (
      isOpaqueReasoningCarrier(group.reasoningCarrier)
        && group.locator.kind === 'responses-item-ids'
        ? group.locator.itemIds
        : []
    )));
    let opaqueReasoningUnknown = false;
    for (const item of items) {
      if (item.type === 'message') {
        for (const part of item.content) {
          if (part.type === 'output_text') base.replyTexts.push(part.text);
          else base.replyTexts.push(part.refusal);
        }
      } else if (item.type === 'reasoning') {
        const carrier = classifyResponsesReasoningCarrier([item], {
          baseUrl: target.baseUrl,
          providerContractId: target.providerContract?.contract.id,
        });
        if (carrier === 'plaintext') {
          const text = reasoningText(item);
          if (text) base.plaintextReasoningTexts.push(text);
        } else if (isOpaqueReasoningCarrier(carrier)) {
          if (!coveredOpaqueIds.has(item.id)) opaqueReasoningUnknown = true;
        } else if (target.providerContract?.contract.carriers.some(
          (contractCarrier) => contractCarrier.meter === 'unknown',
        )) {
          opaqueReasoningUnknown = true;
        }
      }
    }
    const totals = opaqueTotals(groups);
    if (groups.some((group) => isOpaqueReasoningCarrier(group.reasoningCarrier)
      && group.tokenStatus === 'unreported')) opaqueReasoningUnknown = true;
    const hasReplay = items.length > 0;
    const hasSelectedReasoning = items.some((item) => item.type === 'reasoning');
    const history = target.providerContract
      ? effectiveProviderHistory(target.providerContract)
      : undefined;
    const locallyMeteredCarrier = target.providerContract?.contract.carriers.some(
      (carrier) => carrier.meter === 'local-text',
    ) ?? false;
    const canonicalReasoningRequired = history?.replay === 'all-prior'
      || history?.replay === 'provider-filtered'
      || (history?.replay === 'tool-request-all-prior' && target.requestHasTools === true)
      || (history?.replay === 'same-turn' && target.currentToolTurn === true);
    if (!hasSelectedReasoning && message.reasoning_content?.trim()
      && (history?.replay === 'unknown'
        || target.providerContract?.contract.streaming.live_meter === 'unknown-until-terminal')) {
      opaqueReasoningUnknown = true;
    }
    if (target.providerContractStatus === 'unmatched' && !unmatchedSameOrigin
      && (message.reasoning_content?.trim()
        || message.responses_output_items?.some((item) => item.type === 'reasoning'))) {
      opaqueReasoningUnknown = true;
    }
    return {
      ...base,
      ...totals,
      responsesOutputItems: items,
      ...(groups.length ? { accountingGroups: groups } : {}),
      opaqueReasoningUnknown,
      remoteStateUnknown: history?.replay === 'remote-handle',
      useCanonicalReply: !hasReplay,
      useCanonicalReasoning: target.providerContract
        ? locallyMeteredCarrier && canonicalReasoningRequired && !hasSelectedReasoning
        : unmatchedSameOrigin
          ? !hasSelectedReasoning
          : target.providerContractStatus !== 'unmatched'
            && isDeepSeekEndpoint(target.baseUrl)
            && (message.tool_calls?.length ?? 0) > 0
            && !hasSelectedReasoning,
    };
  }

  if (target.protocol === 'anthropic-messages') {
    const selected = selectAnthropicReplayState(message, target);
    const blocks = selected.blocks ?? [];
    const allGroups = selected.groups ?? [];
    const unmatchedSameOrigin = target.providerContractStatus === 'unmatched'
      && canReplayProviderOutputState({
        origin: message.anthropic_output_origin,
        targetBaseUrl: target.baseUrl,
        targetModel: target.model,
      });
    // Provider retention controls effective context accounting only. It does
    // not filter the blocks LC serializes. In particular, Tool History changes
    // call/result representation and has no bearing on reasoning retention.
    const contractReplay = target.providerContract
      ? effectiveProviderHistory(target.providerContract).replay
      : undefined;
    const providerRetention = unmatchedSameOrigin
      ? 'all'
      : contractReplay === 'all-prior' || contractReplay === 'provider-filtered'
      ? 'all'
      : contractReplay === 'same-turn'
        ? (target.currentToolTurn ? 'all' : 'last-turn-only')
        : target.currentToolTurn
          ? 'all'
          : anthropicThinkingRetention(target.baseUrl, target.model);
    const contextCountedGroups = providerRetention === 'all' ? allGroups : [];
    const countedOpaqueIndexes = new Set(contextCountedGroups.flatMap((group) => (
      isOpaqueReasoningCarrier(group.reasoningCarrier)
        && group.locator.kind === 'anthropic-block-indexes'
        ? group.locator.blockIndexes
        : []
    )));
    let opaqueReasoningUnknown = false;
    blocks.forEach((block, index) => {
      const carrier = target.providerContract
        ? (target.providerContract.contract.carriers.some((item) => item.kind === 'plaintext'
            || item.kind === 'signed-plaintext')
          ? 'plaintext'
          : classifyAnthropicReasoningCarrier([block], {
            baseUrl: target.baseUrl,
            providerContractId: target.providerContract.contract.id,
          }))
        : classifyAnthropicReasoningCarrier([block], { baseUrl: target.baseUrl });
      if (carrier === 'plaintext') {
        if (block.type === 'thinking' && block.thinking) {
          base.plaintextReasoningTexts.push(block.thinking);
        }
        return;
      }
      if (!isOpaqueReasoningCarrier(carrier)) {
        return;
      }
      if (block.type === 'thinking' && (!block.signature || block.signature.length === 0)) {
        if (block.thinking) base.plaintextReasoningTexts.push(block.thinking);
        return;
      }
      if (providerRetention === 'unknown'
        || (providerRetention === 'all' && !countedOpaqueIndexes.has(index))) {
        opaqueReasoningUnknown = true;
      }
    });
    if (contextCountedGroups.some((group) => isOpaqueReasoningCarrier(group.reasoningCarrier)
      && group.tokenStatus === 'unreported')) opaqueReasoningUnknown = true;
    const totals = opaqueTotals(contextCountedGroups);
    if (blocks.length === 0 && message.reasoning_content?.trim()
      && contractReplay === 'unknown') opaqueReasoningUnknown = true;
    if (blocks.length === 0 && message.reasoning_content?.trim()
      && target.providerContract?.contract.streaming.live_meter === 'unknown-until-terminal') {
      opaqueReasoningUnknown = true;
    }
    if (target.providerContractStatus === 'unmatched' && !unmatchedSameOrigin
      && (message.reasoning_content?.trim() || message.anthropic_output_blocks?.length)) {
      opaqueReasoningUnknown = true;
    }
    return {
      ...base,
      ...totals,
      anthropicOutputBlocks: blocks,
      ...(allGroups.length ? { accountingGroups: allGroups } : {}),
      opaqueReasoningUnknown,
      // Anthropic serializes canonical bubble text once; signed summaries are
      // display forms of the opaque block and are not counted as extra input.
      // Tool History rebuilds the paired tool call but preserves provider
      // blocks unchanged. Canonical reasoning is only the DeepSeek fallback
      // for older/cross-protocol rows that have no provider block to replay.
      useCanonicalReply: true,
      useCanonicalReasoning: blocks.length === 0 && (target.providerContract
        ? target.providerContract.contract.carriers.some((carrier) => carrier.meter === 'local-text')
          && (contractReplay === 'all-prior'
            || contractReplay === 'provider-filtered'
            || (contractReplay === 'tool-request-all-prior' && target.requestHasTools === true)
            || (contractReplay === 'same-turn' && target.currentToolTurn === true))
        : target.providerContractStatus !== 'unmatched'
          && (message.tool_calls?.length ?? 0) > 0
          && isDeepSeekEndpoint(target.baseUrl)),
    };
  }

  // Registered Chat history follows the contract. Legacy direct callers keep
  // the old tool-turn fallback; a completed unmatched lookup stays uncertain
  // rather than borrowing semantics from a provider-looking URL or model ID.
  const replay = target.providerContract
    ? effectiveProviderHistory(target.providerContract).replay
    : undefined;
  const replayRequired = replay === 'all-prior' || replay === 'provider-filtered'
    || (replay === 'tool-request-all-prior' && target.requestHasTools === true)
    || (replay === 'same-turn' && target.currentToolTurn === true);
  const canonicalCarrierIsLocal = target.providerContract?.contract.carriers.every(
    (carrier) => carrier.meter === 'local-text',
  ) ?? true;
  const unmatchedSameOrigin = target.providerContractStatus === 'unmatched'
    && canReplayProviderOutputState({
      origin: target.sourceOrigin,
      targetBaseUrl: target.baseUrl,
      targetModel: target.model,
    });
  return {
    ...base,
    useCanonicalReasoning: (replayRequired && canonicalCarrierIsLocal)
      || unmatchedSameOrigin
      || (replay === undefined && target.providerContractStatus !== 'unmatched'
        && (message.tool_calls?.length ?? 0) > 0),
    opaqueReasoningUnknown: (replay === 'unknown'
      || (target.providerContractStatus === 'unmatched' && !unmatchedSameOrigin)
      || (replayRequired && !canonicalCarrierIsLocal))
      && !!message.reasoning_content?.trim(),
  };
}
