/**
 * TokenMeter — donut-ring context-window gauge for the chat header.
 *
 * Renders an SVG ring showing proportion of tokens used vs the
 * model's max context.  Click reveals a detailed tooltip with
 * breakdown: conversation text plus explicit policy-derived tool categories.
 * When Tool History is on, each figure is shown alongside its
 * "unarchived" value in parens — what it would count with history off.
 */

import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Conversation, Message } from '../../types';
import { countTokens } from '../../utils/tokens.ts';
import {
  buildTodoSnapshotIndex,
  categoryOf,
  formatTodoRequestProjection,
  resolveExposure,
  type TodoSnapshotIndex,
} from '../../modules/tool-engine/index.ts';
import {
  archiveToolCallId,
  ARCHIVED_TOOL_ARGUMENTS,
  ARCHIVED_TOOL_NAME,
} from '../../modules/chat-pipeline/message-history.ts';
import {
  buildToolHistoryProjection,
  findLastUserMessageIndex,
  type ToolHistoryProjection,
} from '../../modules/chat-pipeline/tool-history-projection.ts';
import { isStreaming } from '../../store/conversations.ts';
import { totalProviderCacheTokens, UNREPORTED } from './usage-detail.ts';
import {
  projectAssistantProviderHistory,
  type ProviderHistoryTarget,
} from '../../modules/chat-pipeline/provider-history-projection.ts';
import { resolveBundledProviderContract } from '../../modules/llm-client/provider-contracts.ts';
import { useServerTokenCount } from './useServerTokenCount.ts';

interface Props {
  conv: Conversation;
  /** Model max context length (from capabilities). 0 = unknown. */
  maxContext: number;
  style: 'donut' | 'cake';
  /** Token count of the system prompt (pre-computed by ChatView). */
  systemPromptTokens?: number;
  /** Token cost of the provider's separately structured tool payload. */
  toolDefinitionTokens?: number;
  /** Provider protocol capability used by the wire path. */
  toolCallingSupported: boolean;
  /** To-do index shared with the transcript render. */
  todoSnapshotIndex?: TodoSnapshotIndex;
  /** Exact adapter target whose next request the meter predicts. */
  providerTarget?: Omit<ProviderHistoryTarget, 'currentToolTurn' | 'toolCallRewritten'>;
  /**
   * Optional server preflight input. When the exact resolved contract owns
   * a server tokenizer, the meter measures the rendered input remotely and
   * reports it as the authoritative total; categories stay local. Omit to
   * keep pure local estimation. Never carries secrets beyond the API key
   * needed for the Authorization header.
   */
  serverPreflight?: ServerTokenPreflight;
}

export interface ServerTokenPreflight {
  apiKey: string;
  requestKey: string;
  query: { baseUrl: string; protocol: 'openai-responses' | 'anthropic-messages'; modelId?: string };
  generationRequest: Record<string, unknown>;
  debounceMs?: number;
  timeoutMs?: number;
}

export interface TokenBreakdown {
  totalUsed: number;
  max: number;
  system: number;
  toolDefinitions: number;
  userInput: number;
  reasoning: number;
  foundationTools: number;
  io: number;
  webAccess: number;
  whiteboard: number;
  helpHistorySkills: number;
  otherTools: number;
  replies: number;
  /** Fraction 0–1 for the donut fill. */
  pct: number;
  /** False means `totalUsed` is a known lower bound, not an exact total. */
  exact: boolean;
  unknownContributions: Array<'opaque-reasoning' | 'remote-state'>;
  opaqueReasoningMeasurement?: 'provider-counter' | 'provider-estimate' | 'mixed';
  /**
   * True when `totalUsed` is the provider's own tokenizer measurement of
   * the rendered input. Category rows remain local accounting and are
   * clearly identified as such; they need not sum to the server total.
   */
  serverMeasuredInput?: boolean;
}

interface CachedMessageField {
  text: string;
  tokens: number;
  /** Live append accounting is approximate until the turn becomes idle. */
  exact: boolean;
}

interface CachedMessageTokens {
  content?: CachedMessageField;
  reasoning?: CachedMessageField;
  refusal?: CachedMessageField;
  toolCalls?: {
    source: NonNullable<Message['tool_calls']>;
    tokens: ToolTokenTotals;
    /** Live tool-call arguments are approximate until the turn becomes idle. */
    exact: boolean;
  };
}

interface CachedArchivedProjection {
  conversationId: string;
  prefix: readonly Message[];
  projection: ToolHistoryProjection;
  helpHistorySkillsTokens: number;
}

export interface TokenCountMemo {
  readonly byMessage: Map<string, CachedMessageTokens>;
  readonly count: (text: string) => number;
  readonly maxMessages: number;
  archivedProjection?: CachedArchivedProjection;
}

/**
 * Cache token counts by message ID and field text. Streaming replaces the
 * active assistant object even when only content or reasoning changed, so the
 * other field must survive that replacement. The cap bounds stale IDs left by
 * edits that truncate a conversation without changing its ID.
 */
export function createTokenCountMemo(
  count: (text: string) => number = countTokens,
  maxMessages = 4096,
): TokenCountMemo {
  return { byMessage: new Map(), count, maxMessages };
}

/** Old-text suffix reconsidered for tokenizer boundary effects on append. */
const LIVE_APPEND_OVERLAP_CHARS = 2_048;
/** Maximum sample from one part of an unusually large provider delta. */
const LIVE_APPEND_SAMPLE_CHARS = 8_192;

function countBoundedLiveText(
  text: string,
  count: (value: string) => number,
): number {
  if (text.length <= LIVE_APPEND_SAMPLE_CHARS * 2) return count(text);
  const head = text.slice(0, LIVE_APPEND_SAMPLE_CHARS);
  const tail = text.slice(-LIVE_APPEND_SAMPLE_CHARS);
  const sampledChars = head.length + tail.length;
  const sampledTokens = count(head) + count(tail);
  return Math.round(sampledTokens * text.length / sampledChars);
}

function looksAppendOnly(previous: string, next: string): boolean {
  if (next.length < previous.length) return false;
  if (previous.length === 0) return true;
  // Streaming is contractually append-only. Bounded sentinels catch ordinary
  // replacements without turning this check into another full-prefix scan.
  const edge = Math.min(64, previous.length);
  return previous.slice(0, edge) === next.slice(0, edge)
    && previous.slice(previous.length - edge) === next.slice(previous.length - edge, previous.length);
}

function countLiveAppend(
  previous: CachedMessageField,
  nextText: string,
  count: (value: string) => number,
): number {
  if (!looksAppendOnly(previous.text, nextText)) {
    return countBoundedLiveText(nextText, count);
  }

  const suffixStart = previous.text.length;
  const suffixChars = nextText.length - suffixStart;
  if (suffixChars <= 0) return previous.tokens;

  const overlapStart = Math.max(0, suffixStart - LIVE_APPEND_OVERLAP_CHARS);
  const oldBoundary = previous.text.slice(overlapStart);
  const directSuffixChars = Math.min(suffixChars, LIVE_APPEND_SAMPLE_CHARS);
  const newBoundary = nextText.slice(overlapStart, suffixStart + directSuffixChars);
  let tokens = previous.tokens - count(oldBoundary) + count(newBoundary);

  const remainingChars = suffixChars - directSuffixChars;
  if (remainingChars > 0) {
    const remaining = nextText.slice(suffixStart + directSuffixChars);
    tokens += countBoundedLiveText(remaining, count);
  }
  return Math.max(0, tokens);
}

function countMessageField(
  message: Message,
  field: 'content' | 'reasoning' | 'refusal',
  memo?: TokenCountMemo,
  liveAppend = false,
): number {
  const text = field === 'content'
    ? message.content
    : field === 'reasoning'
      ? (message.reasoning ?? '')
      : (message.refusal ?? '');
  if (text.length === 0) return 0;
  if (!memo) return countTokens(text);

  const key = `${message.role}:${message.id}`;
  const cached = memo.byMessage.get(key) ?? {};
  const hit = cached[field];
  if (hit?.text === text) {
    if (!liveAppend && !hit.exact) {
      const tokens = memo.count(text);
      cached[field] = { text, tokens, exact: true };
      memo.byMessage.delete(key);
      memo.byMessage.set(key, cached);
      return tokens;
    }
    // Refresh insertion order so the size cap behaves as an LRU.
    memo.byMessage.delete(key);
    memo.byMessage.set(key, cached);
    return hit.tokens;
  }

  const tokens = liveAppend
    ? (hit
        ? countLiveAppend(hit, text, memo.count)
        : countBoundedLiveText(text, memo.count))
    : memo.count(text);
  cached[field] = { text, tokens, exact: !liveAppend };
  memo.byMessage.delete(key);
  memo.byMessage.set(key, cached);
  while (memo.byMessage.size > memo.maxMessages) {
    const oldest = memo.byMessage.keys().next().value;
    if (oldest === undefined) break;
    memo.byMessage.delete(oldest);
  }
  return tokens;
}

function matchesArchivedPrefix(
  cached: CachedArchivedProjection | undefined,
  conversationId: string,
  messages: readonly Message[],
  boundary: number,
): cached is CachedArchivedProjection {
  if (!cached || cached.conversationId !== conversationId || cached.prefix.length !== boundary) {
    return false;
  }
  for (let index = 0; index < boundary; index += 1) {
    if (cached.prefix[index] !== messages[index]) return false;
  }
  return true;
}

const DONUT_R = 9;
const DONUT_SW = 4.5;
// Cake geometry: a filled pie (r=5 + sw=10 → outer radius 10, no hole).
// CAKE_R MUST equal the circle's actual r — the dash math below uses it
// as the path length. (Was once 7 while the circle rendered at r=5,
// inflating the shown fill by 7/5 — 46.6% looked like ~65%.)
const CAKE_R = 5;
const DONUT_CIRC = 2 * Math.PI * DONUT_R;
const CAKE_CIRC = 2 * Math.PI * CAKE_R;
// Tools whose output is base64-encoded binary — tokenize as a fixed
// estimate (~1K tokens per image for vision models) instead of
// counting every base64 character as a text token.
const BINARY_OUTPUT_TOOL = 'lc_read_image';

/** Keep token buckets derived from the canonical policy categories. */
type ToolTokenBucket =
  | 'foundationTools'
  | 'io'
  | 'webAccess'
  | 'whiteboard'
  | 'helpHistorySkills'
  | 'otherTools';

type ToolTokenTotals = Record<ToolTokenBucket, number>;

function emptyToolTokenTotals(): ToolTokenTotals {
  return {
    foundationTools: 0,
    io: 0,
    webAccess: 0,
    whiteboard: 0,
    helpHistorySkills: 0,
    otherTools: 0,
  };
}

function tokenBucket(toolName: string): ToolTokenBucket {
  switch (categoryOf(toolName)) {
    case 'foundation':
      return 'foundationTools';
    case 'file_io':
    case 'shell':
      return 'io';
    case 'web_access':
      return 'webAccess';
    case 'whiteboard':
      return 'whiteboard';
    case 'tool_help':
    case 'tool_history':
    case 'skills':
      return 'helpHistorySkills';
    default:
      return 'otherTools';
  }
}

/** Stable text projection of one structured tool call for local estimation. */
function toolCallTokenText(id: string, name: string, args: string): string {
  return `${id}\n${name}\n${args}`;
}

function countMessageToolCalls(
  message: Message,
  memo: TokenCountMemo | undefined,
  live: boolean,
): ToolTokenTotals {
  const calls = message.tool_calls;
  if (!calls?.length) return emptyToolTokenTotals();

  const key = `${message.role}:${message.id}`;
  const cachedMessage = memo?.byMessage.get(key);
  const cached = cachedMessage?.toolCalls;
  if (cached?.source === calls && (live || cached.exact)) {
    if (memo && cachedMessage) {
      memo.byMessage.delete(key);
      memo.byMessage.set(key, cachedMessage);
    }
    return cached.tokens;
  }

  const texts = new Map<ToolTokenBucket, string[]>();
  for (const call of calls) {
    const bucket = tokenBucket(call.name);
    const bucketTexts = texts.get(bucket) ?? [];
    bucketTexts.push(toolCallTokenText(call.id, call.name, call.arguments));
    texts.set(bucket, bucketTexts);
  }

  const totals = emptyToolTokenTotals();
  const count = memo?.count ?? countTokens;
  for (const [bucket, bucketTexts] of texts) {
    const text = bucketTexts.join('\n');
    totals[bucket] = live ? countBoundedLiveText(text, count) : count(text);
  }

  if (memo) {
    const entry = cachedMessage ?? {};
    entry.toolCalls = { source: calls, tokens: totals, exact: !live };
    memo.byMessage.delete(key);
    memo.byMessage.set(key, entry);
    while (memo.byMessage.size > memo.maxMessages) {
      const oldest = memo.byMessage.keys().next().value;
      if (oldest === undefined) break;
      memo.byMessage.delete(oldest);
    }
  }
  return totals;
}

function addToolTotals(target: ToolTokenTotals, source: ToolTokenTotals): void {
  target.foundationTools += source.foundationTools;
  target.io += source.io;
  target.webAccess += source.webAccess;
  target.whiteboard += source.whiteboard;
  target.helpHistorySkills += source.helpHistorySkills;
  target.otherTools += source.otherTools;
}

export function computeTokenBreakdown(
  conv: Conversation,
  maxContext: number,
  systemPromptTokens: number | undefined,
  /** Whether Tool History archiving applies (mirrors the orchestrator). */
  historyEnabled: boolean,
  /** True while the conversation's turn is still generating (stream or
   *  tool loop). Passed in from the store's whole-turn marker. */
  turnActive: boolean,
  /** Structured definitions sent separately from the system message. */
  toolDefinitionTokens = 0,
  /** Optional render-owned memo for reference-stable settled messages. */
  tokenMemo?: TokenCountMemo,
  /** Optional index already built by the transcript render. */
  todoSnapshotIndex?: TodoSnapshotIndex,
  /** Active adapter projection. Omitted by legacy callers/tests. */
  providerTarget?: Omit<ProviderHistoryTarget, 'currentToolTurn' | 'toolCallRewritten'>,
): TokenBreakdown {
  if (providerTarget?.protocol === 'gemini-interactions') historyEnabled = false;
  const nativePreviousAssistant = providerTarget?.protocol === 'lmstudio-rest'
    ? [...conv.messages].reverse().find((message) => message.role === 'assistant'
      && !!message.lmstudio_response_id)
    : undefined;
  const system = nativePreviousAssistant ? 0 : systemPromptTokens ?? 200;
  const toolDefinitions = toolDefinitionTokens;
  let userInput = 0;
  let reasoning = 0;
  const toolTokens = emptyToolTokenTotals();
  let replies = 0;
  const unknownContributions = new Set<'opaque-reasoning' | 'remote-state'>();
  const opaqueMeasurements = new Set<'provider-counter' | 'provider-estimate'>();
  const latestNativeUserId = providerTarget?.protocol === 'lmstudio-rest'
    ? [...conv.messages].reverse().find((message) => message.role === 'user')?.id
    : undefined;

  // The whole-turn owner spans reasoning, visible content, and tool-loop
  // re-streams. Only the newest assistant can change while it is active.
  let liveAssistantId: string | undefined;
  if (turnActive) {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'assistant') {
        liveAssistantId = conv.messages[i].id;
        break;
      }
    }
  }

  // ── Tool History: detect turn boundary ──
  // A developing turn retains its own full tool exchanges. Once idle, every
  // completed exchange is represented by Tool History's marker and stub.
  const archiveBoundary = historyEnabled
    ? (turnActive ? findLastUserMessageIndex(conv.messages) : conv.messages.length)
    : -1;

  let projection: ToolHistoryProjection;
  if (historyEnabled && archiveBoundary > 0) {
    const cached = tokenMemo?.archivedProjection;
    if (matchesArchivedPrefix(cached, conv.id, conv.messages, archiveBoundary)) {
      projection = cached.projection;
      toolTokens.helpHistorySkills += cached.helpHistorySkillsTokens;
    } else {
      projection = buildToolHistoryProjection(conv.messages, archiveBoundary, true);
      const archivedTexts: string[] = [];
      for (const [assistantId, stub] of projection.archivedStubs) {
        archivedTexts.push(toolCallTokenText(
          archiveToolCallId(assistantId),
          ARCHIVED_TOOL_NAME,
          ARCHIVED_TOOL_ARGUMENTS,
        ));
        archivedTexts.push(stub);
      }
      const helpHistorySkillsTokens = countBoundedLiveText(
        archivedTexts.join('\n'),
        tokenMemo?.count ?? countTokens,
      );
      toolTokens.helpHistorySkills += helpHistorySkillsTokens;
      if (tokenMemo) {
        tokenMemo.archivedProjection = {
          conversationId: conv.id,
          prefix: conv.messages.slice(0, archiveBoundary),
          projection,
          helpHistorySkillsTokens,
        };
      }
    }
  } else {
    projection = buildToolHistoryProjection(conv.messages, archiveBoundary, historyEnabled);
  }

  // The cached archive prefix deliberately survives changes in the active
  // suffix. Overlay call names from that suffix so a newly completed live
  // result is categorized immediately without rebuilding the large prefix.
  const activeCallNames = new Map<string, string>();
  if (historyEnabled && archiveBoundary >= 0) {
    for (let index = archiveBoundary; index < conv.messages.length; index += 1) {
      const message = conv.messages[index];
      if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
      const seenInMessage = new Set<string>();
      for (const call of message.tool_calls) {
        if (seenInMessage.has(call.id)) continue;
        seenInMessage.add(call.id);
        activeCallNames.set(call.id, call.name);
      }
    }
  }

  const exposure = resolveExposure(conv.tools ?? {});
  if (historyEnabled && exposure.exposedNames.has('lc_todo_write')) {
    const snapshot = (todoSnapshotIndex ?? buildTodoSnapshotIndex(conv.messages)).latest;
    if (snapshot && snapshot.sourceMessageIndex < archiveBoundary) {
      const projection = formatTodoRequestProjection(snapshot);
      if (projection) userInput += countTokens(projection);
    }
  }

  for (const m of conv.messages) {
    if (m.role === 'user') {
      if (providerTarget?.protocol === 'lmstudio-rest' && m.id !== latestNativeUserId) continue;
      userInput += countMessageField(m, 'content', tokenMemo);
      continue;
    }
    if (m.role === 'tool') {
      if (providerTarget?.protocol === 'lmstudio-rest') continue;
      if (projection.archivedToolMessageIds.has(m.id)) continue;
      const toolName = m.tool_call_id
        ? (activeCallNames.get(m.tool_call_id) ?? projection.callNames.get(m.tool_call_id))
        : undefined;
      // Base64 binary outputs (read_image) are sent to vision models
      // which charge a fixed per-image token cost (~1K), not per-base64-char.
      // Counting every character as a text token would inflate the meter to
      // >1M for a 1.5MB PNG and make it useless.
      const est = toolName === BINARY_OUTPUT_TOOL
        ? 1024
        : countMessageField(m, 'content', tokenMemo);
      toolTokens[toolName ? tokenBucket(toolName) : 'otherTools'] += est;
      continue;
    }
    if (m.role !== 'assistant') continue;

    if (providerTarget?.protocol === 'lmstudio-rest') {
      if (m.id === nativePreviousAssistant?.id) unknownContributions.add('remote-state');
      continue;
    }

    // Provider usage does not replace locally countable conversation fields.
    // Only response-bound opaque reasoning accounting supplies a representation
    // that cannot be tokenized locally, and only after the shared projection
    // confirms that its exact carrier survives the next request.
    const liveAppend = m.id === liveAssistantId;
    if (providerTarget) {
      const providerProjection = projectAssistantProviderHistory({
        role: 'assistant',
        content: m.content,
        refusal: m.refusal,
        reasoning_content: m.reasoning,
        reasoning_details: m.reasoning_details,
        tool_calls: m.tool_calls?.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
        responses_output_items: m.responses_output_items,
        gemini_interactions: m.gemini_interactions,
        provider_output_origin: m.meta?.baseUrl && m.meta.model
          ? { baseUrl: m.meta.baseUrl, model: m.meta.model }
          : undefined,
        anthropic_output_blocks: m.anthropic_output_blocks,
        anthropic_output_origin: m.meta?.baseUrl && m.meta.model
          ? { baseUrl: m.meta.baseUrl, model: m.meta.model }
          : undefined,
        opaque_replay_accounting: m.opaque_replay_accounting,
        lmstudio_response_id: m.lmstudio_response_id,
      }, {
        ...providerTarget,
        sourceOrigin: m.meta?.baseUrl && m.meta.model
          ? { baseUrl: m.meta.baseUrl, model: m.meta.model }
          : undefined,
        currentToolTurn: turnActive && m.id === liveAssistantId,
        toolCallRewritten: projection.archivedStubs.has(m.id),
      });
      if (providerProjection.useCanonicalReply || (liveAppend && providerTarget.protocol === 'gemini-interactions')) {
        replies += countMessageField(m, 'content', tokenMemo, liveAppend);
        replies += countMessageField(m, 'refusal', tokenMemo, liveAppend);
      } else {
        replies += countMessageField({ ...m, content: providerProjection.replyTexts.join('\n') }, 'content', tokenMemo);
      }
      reasoning += (tokenMemo?.count ?? countTokens)(
        providerProjection.plaintextReasoningTexts.join('\n'),
      );
      if (providerProjection.useCanonicalReasoning) {
        reasoning += countMessageField(m, 'reasoning', tokenMemo, liveAppend);
      }
      reasoning += providerProjection.opaqueReasoningTokens;
      if (providerProjection.opaqueReasoningMeasurement === 'provider-counter'
        || providerProjection.opaqueReasoningMeasurement === 'mixed') {
        opaqueMeasurements.add('provider-counter');
      }
      if (providerProjection.opaqueReasoningMeasurement === 'provider-estimate'
        || providerProjection.opaqueReasoningMeasurement === 'mixed') {
        opaqueMeasurements.add('provider-estimate');
      }
      if (providerProjection.opaqueReasoningUnknown) unknownContributions.add('opaque-reasoning');
      if (providerProjection.remoteStateUnknown) unknownContributions.add('remote-state');
    } else {
      // Backward-compatible default for pure callers that have not selected an
      // adapter projection.
      replies += countMessageField(m, 'content', tokenMemo, liveAppend);
      replies += countMessageField(m, 'refusal', tokenMemo, liveAppend);
      reasoning += countMessageField(m, 'reasoning', tokenMemo, liveAppend);
    }

    if (m.tool_calls?.length && !projection.archivedStubs.has(m.id)) {
      addToolTotals(toolTokens, countMessageToolCalls(m, tokenMemo, liveAppend));
    }
  }

  const totalUsed = system
    + toolDefinitions
    + userInput
    + reasoning
    + replies
    + toolTokens.foundationTools
    + toolTokens.io
    + toolTokens.webAccess
    + toolTokens.whiteboard
    + toolTokens.helpHistorySkills
    + toolTokens.otherTools;
  // Unknown model: assume a modern context window rather than the 32k of a
  // 2023 local model. This is display/accounting only — it is never written
  // back as detected metadata, and it is not a limit anything enforces. If
  // the real window matters, set a context override on the model.
  const max = maxContext > 0 ? maxContext : 256000;
  const pct = Math.min(totalUsed / max, 1);

  return {
    totalUsed,
    max,
    userInput,
    reasoning,
    ...toolTokens,
    replies,
    pct,
    system,
    toolDefinitions,
    exact: unknownContributions.size === 0,
    unknownContributions: [...unknownContributions],
    ...(opaqueMeasurements.size > 0 ? {
      opaqueReasoningMeasurement: opaqueMeasurements.size > 1
        ? 'mixed'
        : opaqueMeasurements.has('provider-estimate')
          ? 'provider-estimate'
          : 'provider-counter',
    } : {}),
  };
}

function formatK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export function tokenMeterReasoningLabel(
  measurement: TokenBreakdown['opaqueReasoningMeasurement'],
): string {
  // Both measurement kinds came from the provider. Keep their technical
  // distinction in accounting metadata, not the user-facing row label.
  return measurement ? 'Reasoning (reported)' : 'Reasoning';
}

/**
 * Overlay an exact server input measurement onto a local breakdown. The
 * server total becomes the authoritative occupancy; category rows stay local
 * and must be labeled as such by the caller. The opaque-reasoning unknown
 * drops out because the server tokenizer measured the rendered input that
 * already contains the replayed carrier. Every other unknown stays.
 */
export function applyServerTokenCount(
  stats: TokenBreakdown,
  inputTokens: number | undefined,
): TokenBreakdown {
  if (inputTokens === undefined) return stats;
  const unknownContributions = stats.unknownContributions.filter(
    (contribution) => contribution !== 'opaque-reasoning',
  );
  return {
    ...stats,
    totalUsed: inputTokens,
    pct: Math.min(inputTokens / stats.max, 1),
    exact: unknownContributions.length === 0,
    unknownContributions,
    serverMeasuredInput: true,
  };
}

export function TokenMeter({
  conv,
  maxContext,
  style,
  systemPromptTokens,
  toolDefinitionTokens,
  toolCallingSupported,
  todoSnapshotIndex,
  providerTarget,
  serverPreflight,
}: Props) {
  // Whole-turn "active" signal: true from send until the final
  // finish/error/abort, spanning gaps between tool-call rounds (unlike the
  // per-message `streaming` flag, which flickers off between tool-call rounds
  // and would wrongly archive the active turn mid-flight). Mirrors the
  // bubble's border-animation lifecycle. Fresh on each render because
  // ChatView re-renders on `busy` (turn start/end) and on every token.
  const turnActive = isStreaming(conv.id);
  const historyEnabled = providerTarget?.protocol !== 'gemini-interactions' && toolCallingSupported && resolveExposure(conv.tools ?? { enabled: false })
    .exposedNames.has('lc_tool_history');

  const [showTooltip, setShowTooltip] = useState(false);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 });
  const tokenMemo = useMemo(() => ({
    conversationId: conv.id,
    counts: createTokenCountMemo(),
  }), [conv.id]).counts;
  const targetBaseUrl = providerTarget?.baseUrl;
  const targetModel = providerTarget?.model;
  const targetProtocol = providerTarget?.protocol;
  const suppliedProviderContract = providerTarget?.providerContract;
  const suppliedProviderContractStatus = providerTarget?.providerContractStatus;
  // Contract lookup is keyed only by configuration, never by streaming text.
  // The same resolved object is reused for every delta in this render cycle.
  const resolvedProviderTarget = useMemo(() => {
    if (!targetProtocol || targetModel === undefined) return undefined;
    const providerContract = suppliedProviderContract
      ?? (suppliedProviderContractStatus === 'unmatched'
        ? undefined
        : resolveBundledProviderContract({
            baseUrl: targetBaseUrl ?? '',
            protocol: targetProtocol === 'lmstudio-rest'
              ? 'lmstudio-native-chat'
              : targetProtocol,
            modelId: targetModel,
          }));
    return {
      protocol: targetProtocol,
      model: targetModel,
      baseUrl: targetBaseUrl,
      requestHasTools: (toolDefinitionTokens ?? 0) > 0,
      ...(providerContract ? { providerContract } : {}),
      providerContractStatus: providerContract
        ? 'matched' as const
        : suppliedProviderContractStatus ?? 'unmatched' as const,
    };
  }, [
    suppliedProviderContract,
    suppliedProviderContractStatus,
    targetBaseUrl,
    targetModel,
    targetProtocol,
    toolDefinitionTokens,
  ]);

  // Canonical conversation-context accounting with Tool History's current
  // compaction state applied. Drives the donut and the primary figures.
  const stats = computeTokenBreakdown(
    conv,
    maxContext,
    systemPromptTokens,
    historyEnabled,
    turnActive,
    toolDefinitionTokens,
    tokenMemo,
    todoSnapshotIndex,
    resolvedProviderTarget,
  );
  // Raw accounting — the same conversation with Tool History off. It is only
  // consumed by the tooltip, so keep the history-sized recount off the normal
  // render path while that tooltip is closed.
  const raw = historyEnabled && showTooltip
    ? computeTokenBreakdown(
        conv,
        maxContext,
        systemPromptTokens,
        false,
        turnActive,
        toolDefinitionTokens,
        tokenMemo,
        todoSnapshotIndex,
        resolvedProviderTarget,
      )
    : stats;
  // Exact server preflight never runs mid-turn: the live overlay already
  // counts the active stream, and a count fired per streaming tick would be
  // stale before it resolves. Suspended work falls back to local silently.
  const serverCount = useServerTokenCount(
    !serverPreflight || turnActive
      ? undefined
      : {
        key: serverPreflight.requestKey,
        query: serverPreflight.query,
        generationRequest: serverPreflight.generationRequest,
        apiKey: serverPreflight.apiKey,
        enabled: true,
        ...(serverPreflight.debounceMs !== undefined ? { debounceMs: serverPreflight.debounceMs } : {}),
        ...(serverPreflight.timeoutMs !== undefined ? { timeoutMs: serverPreflight.timeoutMs } : {}),
      },
  );
  const displayStats = serverCount.status === 'ready' && serverCount.inputTokens !== undefined
    ? applyServerTokenCount(stats, serverCount.inputTokens)
    : stats;

  // Resolve tooltip anchor position. When the trigger element is
  // hidden (e.g. focus mode hides the chat header via display:none),
  // getBoundingClientRect returns all zeros. Fall back to viewport
  // top-centre so the tooltip is still visible.
  const resolveTooltipPos = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) {
      return { top: r.bottom + 6, left: r.left + r.width / 2 };
    }
    // Element is hidden — position at top-centre of viewport.
    return { top: 8, left: window.innerWidth / 2 };
  }, []);

  const onClick = useCallback(() => {
    setTooltipPos(resolveTooltipPos());
    setShowTooltip((v) => !v);
  }, [resolveTooltipPos]);

  // Click-away: close the tooltip when clicking outside.
  useEffect(() => {
    if (!showTooltip) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current && !triggerRef.current.contains(target) &&
        tooltipRef.current && !tooltipRef.current.contains(target)
      ) {
        setShowTooltip(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showTooltip]);

  // Keyboard shortcut: Ctrl+T toggles the token-meter tooltip.
  //
  // Any *other* shortcut dismisses it. The tooltip is a transient popover
  // rendered in a portal at z-index 100, which is above `.settings-overlay`
  // (60) and `.side-overlay` (50) — so if it survives the keystroke that
  // opened one of those, it floats on top of the panel the user just asked
  // for. Escape dismisses it too; it had no Escape handler at all, so the
  // only way to close it was another click or Ctrl+T.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isToggle =
        e.key === 't' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
      if (isToggle) {
        e.preventDefault();
        setTooltipPos(resolveTooltipPos());
        setShowTooltip((v) => !v);
        return;
      }
      // Escape, or anything that looks like a global/app shortcut.
      if (e.key === 'Escape' || e.ctrlKey || e.metaKey || /^F\d+$/.test(e.key)) {
        setShowTooltip(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [resolveTooltipPos]);

  const {
    pct,
    totalUsed,
    max,
    system,
    userInput,
    reasoning,
    foundationTools,
    io,
    webAccess,
    whiteboard,
    helpHistorySkills,
    otherTools,
    replies,
    exact,
    unknownContributions,
    opaqueReasoningMeasurement,
    serverMeasuredInput,
  } = displayStats;

  // Cumulative cache tokens the providers reported for this conversation.
  // Only computed while the tooltip is open. `undefined` means no reply
  // reported a counter, which renders as `unreported` — not as `0`, which would read
  // as "no caching happened".
  const providerCache = useMemo(
    () => (showTooltip ? totalProviderCacheTokens(conv.messages) : undefined),
    [showTooltip, conv.messages],
  );

  // Color interpolation: green (0%) → amber (50%) → red (100%).
  const color = useMemo(() => {
    const t = Math.min(pct, 1);
    if (t <= 0.5) {
      // green → amber
      const s = t / 0.5; // 0→1
      return `hsl(${Math.round(120 - 75 * s)}, 70%, 45%)`; // 120°=green → 45°=amber
    }
    // amber → red
    const s = (t - 0.5) / 0.5; // 0→1
    return `hsl(${Math.round(45 - 45 * s)}, 70%, 45%)`; // 45°=amber → 0°=red
  }, [pct]);

  const donutOffset = DONUT_CIRC * (1 - pct);
  const cakeOffset = CAKE_CIRC * (1 - pct);
  const isCake = style === 'cake';

  return (
    <>
      <span
        ref={triggerRef}
        className="token-meter"
        onClick={onClick}
        role="button"
        tabIndex={0}
        aria-label={exact
          ? `Context window ${(pct * 100).toFixed(1)}%`
          : `Known context ${(pct * 100).toFixed(1)}%; true total is higher and unknown`}
        title={exact
          ? `Context window ${(pct * 100).toFixed(1)}% — click for breakdown`
          : `Known context lower bound ${(pct * 100).toFixed(1)}% — unmeasured provider state`}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      >
        <svg width="22" height="22" viewBox="0 0 23 23" aria-hidden>
          {isCake ? (
            <>
              {/* Cake: filled circle with wedge cut out.
                  r=5 + sw=10 fills out to radius 10 (no hole).
                  Both circles reference CAKE_R so the dash math
                  (CAKE_CIRC) can never drift from the path length. */}
              <circle
                cx="11" cy="11" r={CAKE_R}
                fill="none"
                stroke="var(--bg-elev-3)"
                strokeWidth="10"
              />
              {pct > 0 && (
                <circle
                  cx="11" cy="11" r={CAKE_R}
                  fill="none"
                  stroke={color}
                  strokeWidth="10"
                  strokeDasharray={CAKE_CIRC}
                  strokeDashoffset={cakeOffset}
                  transform="rotate(-90 11 11)"
                />
              )}
            </>
          ) : (
            <>
              {/* Donut: ring only, no fill — thicker ring, smaller hole. */}
              <circle
                cx="11" cy="11" r={DONUT_R}
                fill="none"
                stroke="var(--bg-elev-3)"
                strokeWidth={DONUT_SW}
              />
              {pct > 0 && (
                <circle
                  cx="11" cy="11" r={DONUT_R}
                  fill="none"
                  stroke={color}
                  strokeWidth={DONUT_SW}
                  strokeDasharray={DONUT_CIRC}
                  strokeDashoffset={donutOffset}
                  strokeLinecap="round"
                  transform="rotate(-90 11 11)"
                />
              )}
            </>
          )}
        </svg>
        {!exact && <span aria-hidden className="token-meter-warning">!</span>}
      </span>

      {showTooltip && createPortal(
        <div
          ref={tooltipRef}
          className="token-meter-tooltip context-token-meter-tooltip"
          style={{
            position: 'fixed',
            top: tooltipPos.top,
            left: tooltipPos.left,
            transform: 'translateX(-50%)',
            zIndex: 100,
          }}
        >
          <div className="token-meter-tooltip-title">
            <span>{exact ? 'Context window' : 'Known context'}</span>
            <span>{exact ? `${(pct * 100).toFixed(2)}%` : 'lower bound'}</span>
          </div>
          <div className="token-meter-tooltip-used">
            {formatK(totalUsed)}
            {historyEnabled && raw.totalUsed > totalUsed && (
              <span className="token-meter-arch">({formatK(raw.totalUsed)})</span>
            )}
            {' / '}
            {formatK(max)}
          </div>
          {serverMeasuredInput && (
            <div className="token-meter-tooltip-extra">
              <div className="token-meter-row">
                <span className="token-meter-dot" style={{ background: '#2dd4bf' }} />
                <span className="token-meter-label">Input measured by server</span>
                <span className="token-meter-value">categories local</span>
              </div>
            </div>
          )}
          <div className="token-meter-tooltip-rows">
            <TokenRow label="System" value={system} raw={raw.system} showArch={historyEnabled} color="var(--text-faint)" />
            <TokenRow label="Tool definitions" value={stats.toolDefinitions} raw={raw.toolDefinitions} showArch={historyEnabled} color="#94a3b8" />
            <TokenRow label="User input" value={userInput} raw={raw.userInput} showArch={historyEnabled} color="var(--text-muted)" />
            <TokenRow
              label={tokenMeterReasoningLabel(opaqueReasoningMeasurement)}
              value={reasoning}
              raw={raw.reasoning}
              showArch={historyEnabled}
              color="#a78bfa"
              unknown={unknownContributions.includes('opaque-reasoning')}
            />
            <TokenRow label="Replies" value={replies} raw={raw.replies} showArch={historyEnabled} color="var(--text-faint)" />
            <TokenRow label="Foundation tools" value={foundationTools} raw={raw.foundationTools} showArch={historyEnabled} color="#f472b6" />
            <TokenRow label="File I/O &amp; shell" value={io} raw={raw.io} showArch={historyEnabled} color="#60a5fa" />
            <TokenRow label="Web Access" value={webAccess} raw={raw.webAccess} showArch={historyEnabled} color="#4ade80" />
            <TokenRow label="Whiteboard" value={whiteboard} raw={raw.whiteboard} showArch={historyEnabled} color="#22d3ee" />
            <TokenRow label="Help, history &amp; skills" value={helpHistorySkills} raw={raw.helpHistorySkills} showArch={historyEnabled} color="#fbbf24" />
            {(otherTools > 0 || raw.otherTools > 0) && (
              <TokenRow label="Other tools" value={otherTools} raw={raw.otherTools} showArch={historyEnabled} color="#fb923c" />
            )}
          </div>
          {!exact && (
            <div className="token-meter-tooltip-extra">
              {unknownContributions.includes('opaque-reasoning') && (
                <div className="token-meter-row">
                  <span className="token-meter-dot" style={{ background: '#f59e0b' }} />
                  <span className="token-meter-label">Opaque reasoning</span>
                  <span className="token-meter-value">{UNREPORTED}</span>
                </div>
              )}
              {unknownContributions.includes('remote-state') && (
                <div className="token-meter-row">
                  <span className="token-meter-dot" style={{ background: '#f59e0b' }} />
                  <span className="token-meter-label">Remote provider state</span>
                  <span className="token-meter-value">unmeasured</span>
                </div>
              )}
            </div>
          )}
          {/*
            Below the rule on purpose. Everything above describes retained
            conversation context; this is the sum of what providers reported
            about replies already received. The two are never added together.

            Always shown, including as `unreported`: hiding the row made "no
            provider reported a cache counter" indistinguishable from "this
            meter has no such row", which is the question the row exists to
            answer.
          */}
          <div className="token-meter-tooltip-extra">
            <div className="token-meter-row">
              <span className="token-meter-dot" style={{ background: '#2dd4bf' }} />
              <span className="token-meter-label">Provider cache (total)</span>
              <span className="token-meter-value">
                {providerCache === undefined ? UNREPORTED : formatK(providerCache)}
              </span>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function TokenRow({ label, value, raw, showArch, color, unknown = false }: {
  label: string;
  value: number;
  /** History-off value — shown in parens when archiving reduced this bucket. */
  raw?: number;
  /** Whether Tool History is on (parens are only meaningful then). */
  showArch?: boolean;
  color: string;
  /** The numeric value is only the locally/provider-measured lower bound. */
  unknown?: boolean;
}) {
  return (
    <div className="token-meter-row">
      <span className="token-meter-dot" style={{ background: color }} />
      <span className="token-meter-label">{label}</span>
      <span className="token-meter-value">
        {unknown ? (value > 0 ? `≥${formatK(value)}` : UNREPORTED) : formatK(value)}
        {showArch && raw !== undefined && raw > value && (
          <span className="token-meter-arch">({formatK(raw)})</span>
        )}
      </span>
    </div>
  );
}
