/**
 * Chat pipeline orchestrator — the multi-turn streaming + tool-loop engine.
 *
 * Extracted from ChatView.tsx. Encapsulates:
 *   - runStream()    — model streaming (Anthropic / LM Studio REST / OpenAI-compat)
 *   - runToolLoop()  — tool call validation, permission flow, execution, re-stream
 *   - buildToolCtx() — per-round ToolHandlerContext construction
 *
 * ChatView calls `send()` which delegates to `runStreamWithTools()` for the
 * full send → stream → tool-loop → finalize lifecycle.
 */
import type {
  Attachment,
  ProfileRequestHeaderSettings,
  SkillDefinition,
  ToolPermissionAudit,
} from '../../types';
import { debugLog } from '../../utils/debug.ts';
import type { ChatMessage, ChatRequest, ToolCallWire } from '../llm-client/types';
import { MAX_ANTHROPIC_BLOCK_ORDER } from '../llm-client/types.ts';
import type {
  ToolCallRecord,
  ToolHandlerContext,
  ToolHandler,
  ToolExecutionIdentity,
  ToolResultRecord,
  ToolResultIssue,
  WhiteboardToolService,
} from '../tool-engine/types';
import { abortedEnvelope, errorEnvelope } from '../tool-engine/types.ts';
import type { AdapterRequestParams, StreamResult } from '../llm-client/adapters/adapter';
import type { NormalizedUsage } from '../llm-client/cache-usage';
import type { PrefixDiagnostic } from '../llm-client/prefix-diagnostics';
import {
  LLMClient,
  errorMessage,
  profileRequestHeaderSettings,
  resolveReasoningSetting,
} from '../llm-client/index.ts';
import {
  HANDLERS_BY_NAME,
  createTauriBridge,
  resolveExposure,
  canonicalizeLockTargets,
  resolveFileAuthorization,
  type FileAuthorizationResult,
  authorizeFileCall,
  authorizeNonFileCall,
  FILE_IO_MUTATING_NAMES,
  appendTodoProjectionToContent,
  resolveTodoRequestProjection,
  ASK_USER_BATCH_ISSUE,
  ASK_USER_TOOL_NAME,
} from '../tool-engine/index.ts';
import { buildGrantSnapshot, categoryOf } from '../tool-engine/index.ts';
import { promptDedupeKey } from '../tool-engine/index.ts';
import { approvedScopesCoverRequired, grantTool, grantToolOnRoots } from '../tool-engine/grant-state.ts';
import {
  getImageBatch,
  deleteImageBatch,
  disposeGenerationImageBatches,
} from '../tool-engine/builtin/read_image.ts';
import { summarizeFileLineChanges } from '../tool-engine/file-line-changes.ts';
import { wireToRecord } from '../tool-engine/runner.ts';
import { pathResolutionFailureMessage } from '../tool-engine/clean-path.ts';
import { normalizeThrownToolError } from '../tool-engine/tool-error.ts';
import { validateToolCalls, resolveHandler, executeToolCall, recordBlockedPermission, directoryIsTargetTool, targetPathsFromArgs, runWithPool, repairWindowsJsonAfterParseFailure, admitToolCallsById, type ValidatedCall } from '../tool-engine/runner.ts';
import { createToolHelpGovernorState, governToolHelpCalls } from '../tool-engine/tool-help-governor.ts';
import { governWhiteboardCalls } from '../tool-engine/whiteboard-governor.ts';
import { unknownOperationalToolIssue } from '../tool-engine/tool-name-resolution.ts';
import { addCatalogRecovery } from '../tool-engine/tool-guidance.ts';
import {
  contendedReadNotice,
  broadReadWaitNotice,
  LC_RESULT_NOTICES,
  prependLcResultNotice,
  repeatedToolCallNotice,
  type LcResultNotice,
} from '../tool-engine/tool-result-content.ts';
import { repairUnansweredToolCalls } from '../../store/conversations.ts';
import { normalizePathForMatch } from '../tool-engine/clean-path.ts';
import { CONTENDABLE_READ_NAMES, fileTargetsOf, findContendedFilePaths } from './batch-contention.ts';
import { resolveDirForApprovedScope, resolveLockTarget, resolvePathForScope, resolveStatPathForScope } from '../tool-engine/path-safety.ts';
import { showPermissionModal } from '../../ui/tools/ToolPermissionModal.tsx';
import { showAskUserModal } from '../../ui/tools/AskUserModal.tsx';
import { createToolRoundLifecycle } from './tool-round-lifecycle.ts';
import {
  setGenerationSessionPhase,
} from './generation-session-manager.ts';
import { applicationMutationCoordinator } from './mutation-coordinator.ts';
import {
  finalizeStreamingOwner,
  isStreamingOwner,
  persistNonWhiteboardStreamingAssistant,
  registerGenerationTerminalPrerequisite,
  useConversations,
} from '../../store/conversations.ts';
import {
  useProfileStore,
  useAppModels,
  resolveModelServerAuth,
  selectModelRecord,
  selectMetadataOverride,
  type ModelRegistrySnapshot,
} from '../server-profiles/index.ts';
import { useSettings } from '../../store/settings.ts';
import { resolveSearchProvider } from '../tool-engine/search-provider.ts';
import { buildMessageContent, hydrateAttachments } from '../../utils/attachments.ts';
import { detectPresetName } from '../../utils/presets.ts';
import { buildSystemPrompt, shellListFromConv } from './system-prompt.ts';
import { isWindowsPlatform, normalizeWindowsShellCall } from './windows-cmd.ts';
import { createGenerationPhaseTracker } from './phase-tracker.ts';
import { TokenCounter } from './token-counter.ts';
import { TurnUsageAccumulator } from './turn-usage-accumulator.ts';
import { projectAssistantProviderHistory, providerHistoryProtocol } from './provider-history-projection.ts';
import {
  createAnthropicReplayAccountingGroup,
  createResponsesReplayAccountingGroup,
  normalizeOpaqueReplayAccounting,
} from '../llm-client/replay-accounting.ts';
import {
  INFINITE_REASONING_LOOP,
  ReasoningLoopDetector,
  type ReasoningLoopDetectorOptions,
} from '../../utils/reasoning-loop-detector.ts';
import { DEFAULT_TOOL_BATCH_LIMIT, exceedsToolBatchLimit, formatToolBatchLimitMessage, resolveToolBatchLimit, resolveToolRoundLimit } from './tool-batch-limit.ts';
import { appendImageDeliveryWarning, archiveToolCallId, ARCHIVED_TOOL_ARGUMENTS, ARCHIVED_TOOL_NAME, imageBatchIdForDelivery, resolveImageDelivery, buildImageTurnParts, stripInternalImageResultFields } from './message-history.ts';
import { buildToolHistoryProjection, findLastUserMessageIndex } from './tool-history-projection.ts';
import { resolveWorkspaceProviderPresentation, structuredToolPayload } from './provider-capability.ts';
import { permissionDispositionFor, permissionPopupRequired } from './approval-control.ts';
import { recordDiagnosticEvent } from '../../utils/diagnostic-events.ts';
import { durationBucket, type PermissionDisposition } from '../../utils/support-report-base.ts';
import {
  coordinateApplyPatch,
  type PatchAdmission,
  type PatchApproval,
} from './apply-patch-coordinator.ts';
import type {
  WhiteboardGenerationLifecycle,
  WhiteboardTerminalReason,
} from './whiteboard-lifecycle';
import { admitWhiteboardGeneration } from './whiteboard-turn-runtime.ts';
import {
  captureGenerationExecutionState,
  clearGenerationModelDetailCache,
  getCachedModelDetail,
  type GenerationExecutionSnapshot,
  type GenerationRuntimeSecrets,
} from './generation-snapshot.ts';

function diagnosticFinishCode(reason: string | undefined) {
  const normalized = reason?.toLowerCase();
  if (normalized === 'stop' || normalized === 'end_turn' || normalized === 'chat.end') return 'finish-stop' as const;
  if (normalized === 'length' || normalized === 'max_tokens') return 'finish-length' as const;
  if (normalized === 'tool_calls' || normalized === 'tool_use') return 'finish-tool-calls' as const;
  if (normalized === 'disconnected') return 'finish-disconnected' as const;
  if (normalized === 'refusal') return 'finish-refusal' as const;
  return 'finish-other' as const;
}

function diagnosticHttpStatus(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/chat failed:\s*(\d{3})/i);
  if (!match) return undefined;
  const status = Number(match[1]);
  return status >= 100 && status <= 599 ? status : undefined;
}

function isDiagnosticTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /idle timeout|read timed out|timed out/i.test(message);
}

function normalizedToolArgumentsKey(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== 'object') return input;
    const source = input as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = normalize(source[key]);
    return sorted;
  };
  return JSON.stringify(normalize(value)) ?? '';
}

function structuredToolError(
  tool_call_id: string,
  issues: ToolResultIssue[],
  duration_ms = 0,
): { tool_call_id: string; output: string; is_error: true; duration_ms: number } {
  return {
    tool_call_id,
    output: JSON.stringify(errorEnvelope(issues, duration_ms)),
    is_error: true,
    duration_ms,
  };
}


// ── Types ──────────────────────────────────────────────────────────

export interface PipelineOptions {
  /** The conversation id this pipeline operates on. */
  convId: string;
  /** LLMClient for API calls. */
  llmClient: LLMClient;
  /** Model name for the current request. */
  model: string;
  /** Server profile baseUrl + apiKey for sub-agent LLM calls. */
  profile: { baseUrl: string; apiKey: string } & ProfileRequestHeaderSettings;
  /** API variant for the profile. */
  apiVariant?: string;
  /** API style when apiVariant is "openai": "chat" or "responses". */
  apiStyle?: 'chat' | 'responses';
  /** Routing mode for the profile. */
  routing?: string;
  /** SSE read timeout override (minutes). */
  sseReadTimeoutMin?: number;
  /** Abort signal for cancellation. */
  signal: AbortSignal;
  /** Stable owner for every mutation performed by this generation. */
  generationId: string;
  /** Assistant message created for this generation. */
  assistantMessageId: string;
  /** Immutable admitted configuration. Production callers always supply it. */
  snapshot?: GenerationExecutionSnapshot;
  /** Resolved credentials that must never enter the serializable snapshot. */
  runtimeSecrets?: GenerationRuntimeSecrets;
  /** The only live generation config: grants approved by this generation. */
  _authorizationOverlay?: { tools?: import('../../types.ts').Conversation['tools'] };
  /** True when the active chat model supports vision (image_url parts).
   *  Set by runStream after fetching model capabilities — used by
   *  buildToolCtx to pass to tool handlers for early short-circuiting. */
  modelIsVision?: boolean;
  /** Shared box carrying runStream's vision resolution back to the caller.
   *  runStream receives a spread COPY of these options, so a plain field
   *  assignment there is invisible here; the box is passed by reference
   *  (same trick as `_injectedImages`). Without it the tool loop had to
   *  re-derive vision from the model ID alone, which is exactly the lookup
   *  that let a duplicate ID on another profile override the user. */
  _visionResolved?: { current: boolean | undefined };
  /** Called periodically during streaming with live tokens-per-second. */
  onTps?: (tps: number | null) => void;
  /** Deterministic lifecycle-test seam; production uses detector defaults. */
  reasoningLoopDetectorOptions?: ReasoningLoopDetectorOptions;
}

export interface StreamCallbacks {
  /** Called with batched content deltas (rAF-flushed). */
  onDelta: (text: string) => void;
  /** Called with batched reasoning deltas (rAF-flushed). */
  onReasoning: (text: string) => void;
  /** Called when the provider begins emitting a tool/function call. */
  onToolCall?: () => void;
  /** Called with batched model refusal deltas. */
  onRefusal?: (text: string) => void;
  /** Called when the stream completes successfully. */
  onDone: (result: StreamDoneResult) => void;
  /** Called on error (including user abort). */
  onError: (error: string, aborted: boolean) => void;
  /** Called to get the latest TPS for live display. */
  onTps?: (tps: number | null) => void;
}

export interface StreamDoneResult {
  content: string;
  /** Carries provider cache counters and the provider/LC-estimate provenance. */
  usage?: NormalizedUsage;
  /** Bounded LC-side prefix conclusion for the request that produced this reply. */
  prefix?: PrefixDiagnostic;
  finishReason?: string;
  providerFinishReason?: string;
  durationMs: number;
  tps: number;
  tokenCounter: TokenCounter;
  /** Non-null when tool calls were received and the caller should invoke runToolLoop. */
  toolCalls?: ToolCallWire[];
  refusal?: string;
}

export interface ToolLoopResult {
  toolRounds: number;
  stopReason: 'no_tool_calls' | 'aborted' | 'max_tool_rounds' | 'tool_timeout';
}

type GenerationAddress = Pick<PipelineOptions, 'convId' | 'generationId' | 'assistantMessageId'>;
type SubAgentCallParams = Parameters<NonNullable<ToolHandlerContext['llmCall']>>[0];

function generationIsActive(owner: GenerationAddress): boolean {
  return isStreamingOwner(owner.convId, owner.generationId);
}

function generationStillExists(owner: GenerationAddress): boolean {
  return isStreamingOwner(owner.convId, owner.generationId, true);
}

function finalizeGeneration(
  owner: GenerationAddress,
  patch?: Partial<import('../../types.ts').Message>,
): boolean {
  return finalizeStreamingOwner(owner.convId, owner.generationId, patch);
}

function ownedAssistant(owner: GenerationAddress) {
  return useConversations.getState().byId[owner.convId]?.messages
    .find((message) => message.id === owner.assistantMessageId && message.role === 'assistant');
}

function whiteboardTerminalReason(
  owner: GenerationAddress,
  signal: AbortSignal,
): WhiteboardTerminalReason {
  if (signal.aborted) return 'aborted';
  const assistant = ownedAssistant(owner);
  if (
    assistant?.meta?.finish_reason === 'tool_timeout'
    || /timed?\s*out|timeout/i.test(assistant?.meta?.error_message ?? '')
  ) {
    return 'timeout';
  }
  return 'generation_ended';
}

/**
 * Execute one non-streaming sub-agent request without losing the generation's
 * cancellation signal at the LLMClient boundary.
 */
export function runSubAgentChatOnce(
  client: Pick<LLMClient, 'chatOnce'>,
  model: string,
  params: SubAgentCallParams,
  maxOutputTokens?: number,
): Promise<string> {
  return client.chatOnce({
    model,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userContent },
    ],
    stream: false,
    maxTokens: params.max_tokens,
    // The sub-agent model's own reported ceiling, for APIs that require a
    // limit even when the caller sets none. Only the Anthropic adapter reads
    // it — every other adapter keys on `maxTokens` alone — so a caller that
    // sends no ceiling still sends none anywhere else. Without it those calls
    // fall back to a hard-coded 4,096, which the main request path already
    // had to stop doing: adaptive thinking shares that budget, so a thinking
    // model spends it reasoning and returns no visible text at all.
    maxOutputTokens,
    reasoningEnabled: params.reasoningEnabled ?? true,
    reasoningEffort: params.reasoningEffort ?? 'medium',
  }, { signal: params.signal });
}

// ── Helpers ────────────────────────────────────────────────────────

function parseStopSeqs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── buildToolCtx ───────────────────────────────────────────────────

/**
 * Build the immutable per-call ToolHandlerContext.
 *
 * Phase 2.1: Accepts a `ToolExecutionIdentity` so every tool handler
 * receives a traceable, abortable group ID. The orchestrator
 * generates this per model tool call in `runToolLoop`.
 */
function buildToolCtx(
  c: ReturnType<typeof useConversations.getState>['byId'][string] | undefined,
  signal: AbortSignal,
  profileRef: { current: (PipelineOptions['profile'] & { apiVariant?: string }) | null },
  modelRef: { current: string },
  llmCallRef: { current: ToolHandlerContext['llmCall'] },
  modelIsVision: boolean,
  apiStyle?: string,
  apiVariant?: string,
  generationId?: string,
  identity?: ToolExecutionIdentity,
  askUser?: ToolHandlerContext['askUser'],
  whiteboard?: WhiteboardToolService,
  snapshot?: GenerationExecutionSnapshot,
  runtimeSecrets?: GenerationRuntimeSecrets,
): ToolHandlerContext {
  const toolRuntime = snapshot?.toolRuntime;
  const requestHeaderConfig: ProfileRequestHeaderSettings =
    snapshot?.profile ?? profileRef.current ?? {};
  const searchProvider = toolRuntime
    ? (toolRuntime.searchProvider
      ? {
          ...toolRuntime.searchProvider,
          apiKey: runtimeSecrets?.searchProviderApiKey ?? '',
        }
      : null)
    : undefined;
  return {
    sandbox: createTauriBridge(),
    config: {
      allowedRoots: c?.tools?.allowed_roots ?? [],
      shellAllowlist: [...(toolRuntime?.shellAllowlist ?? shellListFromConv(c ?? {}))],
      webFetchRatePerMin: 50,
      maxShellTimeoutMs: 120_000,
      maxWebFetchBytes: 32 * 1024 * 1024,
      maxWebFetchTimeoutMs: 30_000,
      // Generations reuse the captured route and adjacent runtime secret.
      // Only callers without a snapshot resolve current settings and keys here.
      searchProvider: searchProvider === undefined
        ? resolveSearchProvider(useSettings.getState().tools)
        : searchProvider,
      visionModel: toolRuntime?.visionModel ?? useSettings.getState().tools.vision_model,
      webResearchModel: toolRuntime?.webResearchModel ?? useSettings.getState().tools.web_research_model,
      pdfSummarizeModel: toolRuntime?.pdfSummarizeModel ?? useSettings.getState().tools.pdf_summarize_model,
      llmServerUrl: profileRef.current?.baseUrl ?? '',
      llmModel: modelRef.current ?? '',
      llmApiKey: profileRef.current?.apiKey ?? '',
      llmApiStyle: apiStyle ?? 'chat',
      llmApiVariant: apiVariant ?? profileRef.current?.apiVariant ?? 'openai',
      llmIncludeLcIdentifierHeader: requestHeaderConfig.includeLcIdentifierHeader === true,
      llmLcIdentifierHeader: requestHeaderConfig.lcIdentifierHeader
        ? { ...requestHeaderConfig.lcIdentifierHeader }
        : undefined,
      llmIncludeAdditionalRequestHeaders: requestHeaderConfig.includeAdditionalRequestHeaders === true,
      llmRequestHeaders: requestHeaderConfig.requestHeaders?.map((header) => ({ ...header })) ?? [],
      modelIsVision,
      convId: c?.id,
      skillIds: c?.tools?.enabled_skill_ids ?? [],
      exposedToolNames: [...(snapshot?.exposedToolNames ?? resolveExposure(c?.tools ?? {}).exposedNames)],
      customSkills: (snapshot?.conversation.custom_skills ?? c?.custom_skills ?? []) as SkillDefinition[],
    },
    signal,
    // The round's base context carries a placeholder identity: every executed
    // call replaces it with a minted per-call identity before dispatch. Keeping
    // the conversation and generation accurate here means a context that somehow
    // reaches a handler unminted is still attributable rather than anonymous.
    identity: identity ?? {
      groupId: '',
      operationId: '',
      modelToolCallId: '',
      conversationId: c?.id ?? '',
      generationId: generationId ?? '',
    },
    ...(askUser ? { askUser } : {}),
    ...(whiteboard ? { whiteboard } : {}),
    llmCall: llmCallRef.current,
  };
}

/** Clear the shared model-detail cache after application-wide config changes. */
export function clearDetailCache(): void {
  clearGenerationModelDetailCache();
}

// ── Image injection helpers ────────────────────────────────────────

/**
 * Phase 3.4: Side-channel map of tool_call_id → batch_id.
 * The batch ID is no longer embedded in the persisted tool content
 * (it leaks to the model context). Instead, after the tool result
 * is computed, we register the mapping here and strip the internal
 * fields before persisting.
 */
const imageBatchIdByToolCall = new Map<string, string>();

function imageToolCallKey(owner: GenerationAddress, toolCallId: string): string {
  return `${owner.convId}\0${owner.generationId}\0${toolCallId}`;
}

function snapshottedConversation(
  opts: Pick<PipelineOptions, 'convId' | 'snapshot' | '_authorizationOverlay'>,
) {
  const live = useConversations.getState().byId[opts.convId];
  if (!live) return undefined;
  const snapshot = opts.snapshot?.conversation;
  if (!snapshot) return live;
  return {
    ...live,
    title: snapshot.title,
    serverId: snapshot.serverId,
    model: snapshot.model,
    params: snapshot.params,
    tools: opts._authorizationOverlay?.tools ?? snapshot.tools,
    custom_skills: snapshot.custom_skills,
    // Transcript content stays live and generation-fenced; configuration does not.
    messages: live.messages,
  };
}

/** Register a batch ID for a tool call (called before result stripping). */
function registerImageBatchId(
  owner: GenerationAddress,
  toolCallId: string,
  output: string,
): string {
  // `read_image` always emits its transient id, including all-error batches.
  // Register only a batch that actually expected pixel delivery; this makes
  // a later empty cache lookup proof of a cache miss rather than a read with
  // no successful images.
  const batchId = imageBatchIdForDelivery(output);
  if (batchId) {
    imageBatchIdByToolCall.set(imageToolCallKey(owner, toolCallId), batchId);
    return batchId;
  }
  return '';
}

/** Pull the in-memory image batch associated with a current tool call. */
function extractImageBatchId(owner: GenerationAddress, toolCallId?: string): string | null {
  if (!toolCallId) return null;
  return imageBatchIdByToolCall.get(imageToolCallKey(owner, toolCallId)) ?? null;
}

function disposeGenerationImageBatchMappings(owner: GenerationAddress): void {
  const prefix = `${owner.convId}\0${owner.generationId}\0`;
  for (const key of imageBatchIdByToolCall.keys()) {
    if (key.startsWith(prefix)) imageBatchIdByToolCall.delete(key);
  }
}

/**
 * Clear only provider model-detail lookup state. Generation-owned image state
 * is never globally cleared; its terminal owner disposes it explicitly.
 */
export function clearOrchestratorCaches(): void {
  clearGenerationModelDetailCache();
}

/**
 * Resolve whether the model for this turn accepts image parts.
 *
 * Layers, lowest to highest:
 *
 *   server detail  <  registry detected metadata  <  user override
 *
 * Two things matter here. Identity is the exact `profileId + modelId`: a
 * model with the same ID on another profile is a different model, and must
 * not lend this one a capability. And the override is applied with `??`, not
 * `||` — an explicit `vision = No` is a real answer that has to beat a server
 * reporting `true`, whereas an absent override means "no opinion" and lets
 * the detected layer through. The previous code ORed server detail with an
 * ID-only store lookup, which made an explicit No unreachable.
 */
export function resolveRuntimeVision(
  registry: ModelRegistrySnapshot,
  profileId: string | undefined,
  modelId: string,
  detailVision: boolean | undefined,
): boolean {
  const detected = selectModelRecord(registry, profileId, modelId)?.detected;
  const detectedVision = detailVision === true || detected?.capabilities.vision === true;
  return selectMetadataOverride(registry, profileId, modelId)?.v ?? detectedVision;
}

// ── runStream ──────────────────────────────────────────────────────

/**
 * Stream a model response into the conversation.  This is the
 * provider-turn function — one HTTP request, one response.
 *
 * When `returnToolCalls` is true and tool_calls are present in the
 * response, the caller (runToolLoop) takes over finalization.
 */
async function runStream(
  opts: PipelineOptions & {
    returnToolCalls?: boolean;
    _autoContinue?: number;
    /** True when this stream is a tool-loop re-stream (not the initial turn). */
    _isToolLoopReStream?: boolean;
    /** Batch ids delivered as image_url parts this session (for cleanup). */
    _injectedImages?: Set<string>;
    /** One response-boundary accumulator owned by runStreamWithTools. */
    _turnUsageAccumulator?: TurnUsageAccumulator;
    callbacks: StreamCallbacks;
    tokenCounter: TokenCounter;
  },
): Promise<ToolCallWire[] | void> {
  const { convId, llmClient: client, model: effectiveModel, profile: prof, apiVariant, apiStyle, signal } = opts;
  const { callbacks, tokenCounter, returnToolCalls } = opts;
  const owner: GenerationAddress = opts;
  const phases = createGenerationPhaseTracker(owner.convId, owner.generationId);
  const responseUsageId = crypto.randomUUID();
  tokenCounter.reset();

  if (!generationIsActive(owner)) return;
  const c = snapshottedConversation(opts);
  if (!c) return;
  const providerPresentation = opts.snapshot?.workspace
    ?? resolveWorkspaceProviderPresentation(c.tools, apiVariant);

  // Resolve effective model early — needed for the vision-capability
  // check during message building (before we inject image_url parts).
  const effectiveModel2 = opts.snapshot?.conversation.model ?? effectiveModel;
  if (!effectiveModel2) {
    callbacks.onError('No model selected for this chat.', false);
    return;
  }

  // Admitted generations use the model metadata captured before their durable
  // send boundary. Legacy/test callers without a snapshot retain the bounded
  // best-effort cache fallback.
  const modelDetail = opts.snapshot
    ? (opts.snapshot.modelDetail ?? undefined)
    : (await getCachedModelDetail(
        {
          profileId: c.serverId ?? prof.baseUrl,
          baseUrl: prof.baseUrl,
          apiKey: prof.apiKey,
          apiVariant,
          apiStyle,
          routing: opts.routing,
        },
        effectiveModel2,
        signal,
      )) ?? undefined;
  if (!generationIsActive(owner) || signal.aborted) return;
  // `c.serverId` is the profile identity for this conversation — the same
  // one `convProf` is resolved from below for the actual request.
  const modelIsVision = resolveRuntimeVision(
    opts.snapshot?.modelRegistry ?? useAppModels.getState(),
    c.serverId,
    effectiveModel2,
    modelDetail?.capabilities?.vision,
  );
  opts.modelIsVision = modelIsVision; // flows to runToolLoop → buildToolCtx
  // `opts` is a spread copy of the caller's streamOpts, so publish the
  // resolution through the shared box the caller owns. Nothing downstream
  // may re-derive this from the model ID alone.
  if (opts._visionResolved) opts._visionResolved.current = modelIsVision;

  // Build the message array for the API request.
  const hydrated: Array<{ m: typeof c.messages[number]; atts: Attachment[] }> = [];
  for (const m of c.messages) {
    if (m.role === 'system') continue;
    if (m.streaming) continue;
    hydrated.push({ m, atts: await hydrateAttachments(m.attachments ?? []) });
    if (!generationIsActive(owner) || signal.aborted) return;
  }

  // ── Tool History: detect turn boundary ──
  // Find the most recent user message. Messages after it are the
  // active turn (full results). Messages before it are archived
  // (replaced with stubs when tool_history is enabled).
  const historyEnabled = apiVariant !== 'gemini' && providerPresentation.toolCallingSupported && resolveExposure(c.tools ?? { enabled: false })
    .exposedNames.has('lc_tool_history');
  const historyMessages = hydrated.map(({ m }) => m);
  const lastUserIdx = findLastUserMessageIndex(historyMessages);
  const activeHistoryProtocol = providerHistoryProtocol(apiVariant, apiStyle);

  // TokenMeter consumes this same projection, so the displayed compaction and
  // the request builder cannot drift into separate ownership algorithms.
  const archivedStubs: ReadonlyMap<string, string> = historyEnabled && lastUserIdx > 0
    ? buildToolHistoryProjection(historyMessages, lastUserIdx, true).archivedStubs
    : new Map();
  // ── End Tool History pre-processing ──

  const reqMessages: ChatMessage[] = [];
  let latestRealUserRequestMessage: ChatMessage | undefined;
  // Tool-returned images are delivered as their own user turn. Putting them
  // inside the tool result would be structurally nicer, but no protocol LC
  // targets accepts it across the board — see docs/streaming.md, "Adapter
  // constraints proven against live endpoints"
  // "Stage 1 (reverted)" for the two 400s that forced this back.
  const pendingImageTurns: Array<{
    batchId: string;
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;
  }> = [];
  const flushPendingImages = () => {
    if (pendingImageTurns.length === 0) return;
    reqMessages.push({
      role: 'user',
      ...(apiVariant === 'gemini' ? { name: 'lc-tool-images' } : {}),
      content: pendingImageTurns.flatMap((turn) => turn.content),
    });
    // Record delivery so later tool-call rounds suppress it.
    for (const turn of pendingImageTurns) opts._injectedImages?.add(turn.batchId);
    pendingImageTurns.length = 0;
  };
  const hasTools = providerPresentation.workspacePromptEnabled;
  const requestTools = opts.snapshot?.structuredTools
    ? [...opts.snapshot.structuredTools]
    : structuredToolPayload(c.tools, apiVariant);
  const systemContent = opts.snapshot?.systemPrompt ?? (hasTools
    ? await buildSystemPrompt(c)
    : (c.params.system_prompt?.trim() ?? ''));
  if (!generationIsActive(owner) || signal.aborted) return;
  if (systemContent) {
    reqMessages.push({ role: 'system', content: systemContent });
  }
  let toolResultAssistantId: string | undefined;
  for (let idx = 0; idx < hydrated.length; idx++) {
    const { m, atts } = hydrated[idx];
    // Do not insert a synthetic user turn between sibling tool results.
    if (m.role !== 'tool') {
      flushPendingImages();
      toolResultAssistantId = m.role === 'assistant' ? m.id : undefined;
    }
    const content = buildMessageContent(m.content, atts);
    const msg: ChatMessage = { role: m.role, content };
    let useCanonicalReasoning = false;
    const archivedToolTurn = historyEnabled
      && idx < lastUserIdx
      && m.role === 'assistant'
      && !!m.tool_calls?.length
      && archivedStubs.has(m.id);
    if (m.refusal) msg.refusal = m.refusal;
    const anthropicOutputOrigin = m.meta?.baseUrl && m.meta.model
      ? { baseUrl: m.meta.baseUrl, model: m.meta.model }
      : undefined;
    if (m.role === 'assistant') {
      const providerProjection = projectAssistantProviderHistory({
        role: 'assistant',
        content: m.content,
        tool_calls: m.tool_calls?.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
        responses_output_items: m.responses_output_items,
        gemini_interactions: m.gemini_interactions,
        provider_output_origin: anthropicOutputOrigin,
        anthropic_output_blocks: m.anthropic_output_blocks,
        opaque_replay_accounting: m.opaque_replay_accounting,
        anthropic_output_origin: anthropicOutputOrigin,
        lmstudio_response_id: m.lmstudio_response_id,
      }, {
        protocol: activeHistoryProtocol,
        baseUrl: prof.baseUrl,
        model: effectiveModel2,
        toolCallRewritten: archivedToolTurn,
        requestHasTools: (requestTools?.length ?? 0) > 0,
        providerContract: opts.snapshot?.providerContract,
        providerContractStatus: opts.snapshot?.providerContractStatus,
        sourceOrigin: anthropicOutputOrigin,
      });
      useCanonicalReasoning = providerProjection.useCanonicalReasoning;
      if (providerProjection.geminiInteractions?.length) {
        msg.gemini_interactions = providerProjection.geminiInteractions;
      }
      if (providerProjection.responsesOutputItems?.length) {
        msg.responses_output_items = providerProjection.responsesOutputItems;
      }
      if (providerProjection.anthropicOutputBlocks?.length) {
        msg.anthropic_output_blocks = providerProjection.anthropicOutputBlocks;
        msg.anthropic_output_origin = anthropicOutputOrigin;
      }
      // The recorded provider block order travels alongside the blocks so
      // the normal request path serializes the provider's layout instead of
      // the legacy reasoning-first shape. Serialization degrades safely when
      // gating withheld blocks, so no filtering happens here.
      if (m.anthropic_block_order?.length) {
        msg.anthropic_block_order = m.anthropic_block_order;
      }
      if (providerProjection.accountingGroups?.length) {
        msg.opaque_replay_accounting = providerProjection.accountingGroups;
      }
    }
    if (m.role === 'assistant' && m.lmstudio_response_id) {
      msg.lmstudio_response_id = m.lmstudio_response_id;
    }
    if (m.role === 'assistant' && anthropicOutputOrigin) {
      msg.provider_output_origin = anthropicOutputOrigin;
    }
    if (m.role === 'assistant' && m.reasoning_details?.length) {
      msg.reasoning_details = m.reasoning_details;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      // Tool History: for archived turns, replace real tool_call IDs with a
      // single synthetic marker call so the matching stub tool message
      // (pushed below) satisfies the server's "every tool_call_id must have
      // a response" requirement. The marker names a real tool on purpose —
      // see ARCHIVED_TOOL_NAME.
      if (archivedToolTurn) {
        const archiveCallId = archiveToolCallId(m.id);
        msg.tool_calls = [{
          id: archiveCallId,
          type: 'function' as const,
          function: { name: ARCHIVED_TOOL_NAME, arguments: ARCHIVED_TOOL_ARGUMENTS },
        }];
      } else {
        msg.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
    }
    // Reasoning retention is independent of tool-call retention. Contracts
    // such as Kimi all-prior and DeepSeek tools-on-next-request must serialize
    // canonical plaintext from assistant turns that did not themselves call a
    // tool as well as turns that did.
    if (m.role === 'assistant' && useCanonicalReasoning && m.reasoning?.trim()) {
      msg.reasoning_content = m.reasoning;
    }
    if (m.role === 'tool' && m.tool_call_id) {
      // Tool History: skip archived tool results (before the most
      // recent user message) — they'll be replaced by a single
      // synthetic stub appended after the owning assistant message.
      if (historyEnabled && idx < lastUserIdx) continue;
      msg.tool_call_id = m.tool_call_id;
      if (m.tool_is_error) msg.tool_is_error = true;
    }
    reqMessages.push(msg);
    if (m.role === 'user') latestRealUserRequestMessage = msg;

    // Tool History: after pushing an archived assistant message
    // (with tool_calls), append the synthetic stub.
    if (historyEnabled && m.role === 'assistant' && m.tool_calls?.length && archivedStubs.has(m.id)) {
      const archiveCallId = archiveToolCallId(m.id);
      reqMessages.push({
        role: 'tool',
        tool_call_id: archiveCallId,
        content: archivedStubs.get(m.id)!,
      });
    }

    // lc_read_image (analyze:false): deliver the cached base64 as real
    // image_url parts. The tool result itself only carries metadata —
    // this synthetic user turn is what the vision model actually sees.
    // In-memory only: after an app reload the batch is gone (by design).
    //
    // Skip image injection when the model lacks vision capability
    // — their API rejects `image_url` content parts with a 400
    // error.  Append a tool message warning the model to use
    // `analyze: true` (sub-agent text description) instead.
    if (
      m.role === 'tool'
      && m.tool_call_id
      && toolResultAssistantId === owner.assistantMessageId
    ) {
      const batchId = extractImageBatchId(owner, m.tool_call_id);
      const images = batchId ? getImageBatch(batchId) : undefined;
      if (batchId) {
        // `_injectedImages` persists across tool-call rounds via
        // the caller's ref, so membership means "already sent on an earlier
        // request". `reqMessages` is rebuilt every round and the batch
        // stays cached until the loop ends, so without this the same pixels
        // would be resent on every turn.
        const delivery = resolveImageDelivery({
          batchId,
          imageCount: images?.length ?? 0,
          modelIsVision,
          alreadyInjected: opts._injectedImages,
        });
        if (delivery === 'inject' && images) {
          pendingImageTurns.push({
            batchId,
            content: buildImageTurnParts(m.tool_call_id, images),
          });
        } else if (delivery === 'blocked-no-vision') {
          // Mutate the already-pushed object so there remains exactly one
          // tool result for this call ID.
          msg.content = appendImageDeliveryWarning(m.content, delivery);
          deleteImageBatch(batchId);
        } else if (delivery === 'blocked-cache-miss') {
          // A non-empty batch was registered, so an empty lookup is not an
          // ordinary read error. Preserve the tool/model pairing while making
          // the dropped payload and the literal recovery call visible.
          msg.content = appendImageDeliveryWarning(m.content, delivery);
        }
      }
      // 'skip-already-sent' → the model saw these pixels on an earlier
      // round; the tool result metadata stays, the images do not repeat.
      // 'blocked-cache-miss' → the tool result carries an actionable retry.
      // 'none' → this tool call produced no deliverable batch.
    }
  }
  flushPendingImages();

  const todoExposed = resolveExposure(c.tools ?? {}).exposedNames.has('lc_todo_write');
  if (todoExposed && historyEnabled && latestRealUserRequestMessage) {
    const projection = resolveTodoRequestProjection(c.messages, reqMessages);
    if (projection) {
      latestRealUserRequestMessage.content = appendTodoProjectionToContent(
        latestRealUserRequestMessage.content,
        projection,
      );
    }
  }

  // DEBUG: log request messages before building the request
  if (import.meta.env?.DEV) {
    const toolMsgs = reqMessages.filter(m => m.role === 'tool');
    const asstMsgs = reqMessages.filter(m => m.role === 'assistant' && m.tool_calls?.length);
    debugLog.warn('[LC DEBUG] runStream: built', reqMessages.length, 'reqMessages,', toolMsgs.length, 'tool messages,', asstMsgs.length, 'asst w/ tool_calls');
    for (const am of asstMsgs) {
      for (const tc of (am.tool_calls ?? [])) {
        debugLog.warn('[LC DEBUG] runStream asst tool_call args RAW:', JSON.stringify(tc.function.arguments));
        debugLog.warn('[LC DEBUG] runStream asst tool_call args LEN:', tc.function.arguments.length, 'name:', tc.function.name);
      }
    }
    for (const tm of toolMsgs) {
      debugLog.warn('[LC DEBUG] runStream tool msg CONTENT RAW (first 200):', JSON.stringify(typeof tm.content === 'string' ? tm.content.slice(0, 200) : String(tm.content).slice(0, 200)));
      debugLog.warn('[LC DEBUG] runStream tool msg CONTENT RAW (last 200):', JSON.stringify(typeof tm.content === 'string' ? tm.content.slice(-200) : String(tm.content).slice(-200)));
      debugLog.warn('[LC DEBUG] runStream tool msg keys:', JSON.stringify(Object.keys(tm)));
    }
  }

  // Check for a fresh profile (resolve at stream time).  effectiveModel2
  // and modelDetail are already resolved above for the vision check.
  const convProf = opts.snapshot?.profile
    ?? useProfileStore.getState().profiles.find((p) => p.id === c.serverId);
  if (!convProf) {
    callbacks.onError('Server profile is gone. Pick another from settings.', false);
    return;
  }

  // Build the OpenAI-compat request.
  const req: ChatRequest = {
    model: effectiveModel2,
    messages: reqMessages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (c.params.temperature_enabled !== false) req.temperature = c.params.temperature;
  if (c.params.top_p_enabled !== false) req.top_p = c.params.top_p;
  if (c.params.top_k_enabled !== false) req.top_k = c.params.top_k || undefined;
  if (c.params.max_tokens_enabled !== false) req.max_tokens = c.params.max_tokens;
  if (c.params.repeat_penalty_enabled !== false) req.repeat_penalty = c.params.repeat_penalty;

  const stopSeqs = parseStopSeqs(c.params.stop);
  if (stopSeqs.length > 0) req.stop = stopSeqs;

  // Tool definitions are resolved from foundation and optional category membership.
  req.tools = requestTools;

  const requestParams: AdapterRequestParams = {
    model: req.model,
    messages: req.messages,
    stream: true,
    maxTokens: req.max_tokens,
    // The model's own ceiling, for APIs that require a limit even when the
    // user's override is off. Adapters whose API treats it as optional ignore
    // it, so "no toggle, no touch" still holds everywhere it can.
    maxOutputTokens: modelDetail?.max_output_tokens,
    temperature: req.temperature,
    topP: req.top_p,
    topK: req.top_k,
    repeatPenalty: req.repeat_penalty,
    stopSequences: req.stop,
    tools: req.tools,
    reasoningEnabled: c.params.reasoning_enabled === true,
    reasoningEffort: c.params.reasoning_effort,
    providerContract: opts.snapshot?.providerContract,
    providerContractStatus: opts.snapshot?.providerContractStatus,
    streamOptions: req.stream_options,
  };

  // ── Streaming callbacks with rAF batching ──────────────────────
  // Keep user cancellation separate from the detector's internal abort.
  const streamController = new AbortController();
  const forwardExternalAbort = () => {
    if (!streamController.signal.aborted) streamController.abort();
  };
  if (signal.aborted) {
    forwardExternalAbort();
  } else {
    signal.addEventListener('abort', forwardExternalAbort, { once: true });
  }
  const streamSignal = streamController.signal;
  const stopForwardingExternalAbort = () => {
    signal.removeEventListener('abort', forwardExternalAbort);
  };

  const reasoningLoopDetector = new ReasoningLoopDetector(opts.reasoningLoopDetectorOptions);
  let reasoningLoopActive = true;
  const disableReasoningLoopDetector = () => {
    reasoningLoopActive = false;
  };

  let contentBuf = '';
  let reasoningBuf = '';
  let refusalBuf = '';
  let rafId: number | null = null;
  let reasoningEmitted = false;
  let textEmitted = false;
  const responseContentChunks: string[] = [];
  const responseReasoningChunks: string[] = [];
  const responseRefusalChunks: string[] = [];

  const applyStopSeqs = (delta: string): string => {
    if (stopSeqs.length === 0) return delta;
    let text = delta;
    for (const seq of stopSeqs) {
      const idx = text.indexOf(seq);
      if (idx !== -1) text = text.slice(0, idx);
    }
    return text;
  };

  const onDelta = (delta: string) => {
    if (!generationIsActive(owner)) return;
    const text = applyStopSeqs(delta);
    if (!text) return;
    if (reasoningLoopActive && text.trim()) {
      reasoningLoopDetector.feedContent(text);
      disableReasoningLoopDetector();
    }
    if (!textEmitted) {
      textEmitted = true;
      if (reasoningEmitted) phases.reasoning.finished();
      phases.textResponse.started();
      phases.textResponse.running();
    }
    contentBuf += text;
    responseContentChunks.push(text);
    tokenCounter.feedContent(text);
    scheduleFlush();
  };
  const onReasoning = (delta: string) => {
    if (!generationIsActive(owner)) return;
    if (!delta) return;
    if (reasoningLoopActive) {
      const detectorState = reasoningLoopDetector.feedReasoning(delta, performance.now());
      if (detectorState.triggered) streamController.abort();
    }
    if (!reasoningEmitted) {
      reasoningEmitted = true;
      phases.reasoning.started();
      phases.reasoning.running();
    }
    reasoningBuf += delta;
    responseReasoningChunks.push(delta);
    tokenCounter.feedReasoning(delta);
    scheduleFlush();
  };
  const onToolCall = () => {
    if (!generationIsActive(owner)) return;
    if (!reasoningLoopActive) return;
    reasoningLoopDetector.feedToolCall();
    disableReasoningLoopDetector();
  };
  const onRefusal = (delta: string) => {
    if (!generationIsActive(owner)) return;
    if (!delta) return;
    if (reasoningLoopActive && delta.trim()) {
      reasoningLoopDetector.feedContent(delta);
      disableReasoningLoopDetector();
    }
    refusalBuf += delta;
    responseRefusalChunks.push(delta);
    scheduleFlush();
  };
  const providerCallbacks = providerPresentation.expectsToolCalls
    ? { onDelta, onReasoning, onToolCall, onRefusal }
    : { onDelta, onReasoning, onRefusal };

  const flush = () => {
    rafId = null;
    if (!generationIsActive(owner)) {
      contentBuf = '';
      reasoningBuf = '';
      refusalBuf = '';
      return;
    }
    if (contentBuf) {
      callbacks.onDelta(contentBuf);
      contentBuf = '';
    }
    if (reasoningBuf) {
      callbacks.onReasoning(reasoningBuf);
      reasoningBuf = '';
    }
    if (refusalBuf) {
      callbacks.onRefusal?.(refusalBuf);
      refusalBuf = '';
    }
    callbacks.onTps?.(tokenCounter.currentTps());
  };
  const scheduleFlush = () => {
    if (rafId == null) rafId = requestAnimationFrame(flush);
  };
  const flushNow = () => {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    flush();
  };

  const responseLocalEstimate = (): NormalizedUsage | undefined => {
    const contentText = responseContentChunks.join('') + responseRefusalChunks.join('');
    const reasoningText = responseReasoningChunks.join('');
    if (!contentText && !reasoningText) return undefined;
    const estimated = tokenCounter.terminalTokens(contentText, reasoningText);
    if (estimated <= 0) return undefined;
    return {
      prompt_tokens: 0,
      completion_tokens: estimated,
      total_tokens: estimated,
      source: 'lc-estimate',
      reasoning: { status: 'not-reported' },
    };
  };

  // ── Execute the stream ─────────────────────────────────────────
  let lastUsage: NormalizedUsage | undefined;
  const streamTimeoutMs = (
    c.tools?.sse_read_timeout_min
    ?? opts.snapshot?.profile.sseReadTimeoutMin
    ?? ('sse_read_timeout_min' in convProf ? convProf.sse_read_timeout_min : undefined)
    ?? 5
  ) * 60_000;

  // The correlation number of the request this run last issued. Captured
  // before the call rather than read off the result, so a network failure, an
  // HTTP error, a read timeout, and a cancellation all still pair their
  // terminal stream event with the request that caused them — which is why it
  // is declared out here, where the catch block can reach it. A retried or
  // fallback request overwrites it, which is correct: the terminal event
  // belongs to the request that actually ran.
  let requestSequence: number | undefined;
  const capabilities = modelDetail?.capabilities;
  const requestContext = {
    diagnosticSessionId: owner.generationId,
    onSequence: (value: number) => { requestSequence = value; },
    capabilities: {
      ...(typeof capabilities?.vision === 'boolean' ? { vision: capabilities.vision } : {}),
      ...(typeof capabilities?.reasoning === 'boolean' ? { reasoning: capabilities.reasoning } : {}),
      ...(typeof capabilities?.tools === 'boolean'
        ? { tools: capabilities.tools }
        : typeof capabilities?.trained_for_tool_use === 'boolean'
          ? { tools: capabilities.trained_for_tool_use }
          : {}),
    },
    contextWindowKnown: typeof modelDetail?.max_context_length === 'number'
      || typeof modelDetail?.loaded_context_length === 'number',
  };

  try {
    // Determine API path.
    const useAnthropic = (apiVariant ?? 'openai') === 'anthropic';
    const useNative = !useAnthropic && (apiVariant ?? 'openai') === 'lm-studio';
    const canUseNative = useNative;

    let result: StreamResult | undefined;
    let nativeStats: StreamResult['stats'];
    let nativeSuccess = false;
    let nativeFinishReason: string | undefined;
    let nativeProviderFinishReason: string | undefined;
    let nativeErrorMessage: string | undefined;
    let nativeResponseId: string | undefined;

    // Scopes the prefix comparison chain. Changing conversation or profile
    // starts a new chain rather than reporting a spurious change.
    const prefixScope = { conversationId: convId, profileId: c.serverId ?? '' };

    if (useAnthropic) {
      // ── Anthropic Messages API path ──
      // `requestParams.reasoningEnabled` is derived from the OpenAI-shaped
      // fields above, which this path never populates, so the toggle is read
      // from the conversation directly. It used to be hard-coded `true`, which
      // sent `thinking` even when the user had reasoning switched off —
      // an override LC was never asked for.
      result = await client.chatStream(
        {
          ...requestParams,
          reasoningEnabled: c.params.reasoning_enabled === true,
          reasoningEffort: c.params.reasoning_effort,
        },
        providerCallbacks,
        streamSignal,
        streamTimeoutMs,
        prefixScope,
        requestContext,
      );
    } else {
      // ── LM Studio native + OpenAI-compat path ──
      if (canUseNative) {
        const nativeReasoning = c.params.reasoning_enabled && c.params.reasoning_effort
          ? resolveReasoningSetting(modelDetail, c.params.reasoning_effort)
          : undefined;
        const nativeResult = await client.chatStream(
          {
            ...requestParams,
            messages: reqMessages,
            tools: undefined,
            reasoningEnabled: nativeReasoning !== undefined,
            reasoningEffort: nativeReasoning,
          },
          { onDelta, onReasoning, onRefusal },
          streamSignal,
          streamTimeoutMs,
          // Native LM Studio deliberately runs no prefix comparison, but its
          // request still has to be correlatable: `nativeResult` is destructured
          // into loose fields below, which used to drop the sequence entirely.
          undefined,
          requestContext,
        );
        nativeStats = nativeResult.stats;
        nativeFinishReason = nativeResult.finish_reason;
        nativeProviderFinishReason = nativeResult.provider_finish_reason;
        nativeErrorMessage = nativeResult.error_message;
        nativeResponseId = nativeResult.lmstudio_response_id;
        nativeSuccess = true;
      }
      if (!nativeSuccess) {
        result = await client.chatStream(
          requestParams, providerCallbacks, streamSignal, streamTimeoutMs, prefixScope, requestContext,
        );
      }
    }

    stopForwardingExternalAbort();

    // ── Post-stream finalization ─────────────────────────────────
    flushNow();
    if (!generationIsActive(owner)) return;
    phases.textResponse.finished();
    phases.reasoning.finished();
    if (result?.usage) lastUsage = result.usage;

    if (nativeStats) {
      // Native LM Studio REST reports real counts but has no cache surface,
      // so `cache` stays absent rather than claiming `not-reported`.
      lastUsage = {
        prompt_tokens: nativeStats.input_tokens,
        completion_tokens: nativeStats.total_output_tokens,
        total_tokens: nativeStats.input_tokens + nativeStats.total_output_tokens,
        source: 'provider',
        ...(Number.isSafeInteger(nativeStats.reasoning_output_tokens)
          && nativeStats.reasoning_output_tokens >= 0
          ? {
            reasoning: {
              status: 'reported' as const,
              tokens: nativeStats.reasoning_output_tokens,
              measurement: 'provider-counter' as const,
            },
          }
          : {}),
      };
    }
    if (!lastUsage) {
      const streamedContent = responseContentChunks.join('');
      const contentText = streamedContent || result?.content || '';
      const refusalText = responseRefusalChunks.join('');
      const reasoningText = responseReasoningChunks.join('');
      const estimated = tokenCounter.terminalTokens(contentText + refusalText, reasoningText);
      // Locally counted, not reported. Marked so no surface can present this
      // as a provider figure (docs/README.md standing constraint 4).
      lastUsage = {
        prompt_tokens: 0,
        completion_tokens: estimated,
        total_tokens: estimated,
        source: 'lc-estimate',
        reasoning: { status: 'not-reported' },
      };
    }

    // Response usage remains response-local through diagnostics and replay
    // binding. Only the footer-facing message field receives the turn sum.
    opts._turnUsageAccumulator?.addResponse(responseUsageId, lastUsage);
    const messageUsage = opts._turnUsageAccumulator?.snapshot('partial') ?? lastUsage;

    const durationMs = tokenCounter.durationMs();
    const avgTps = nativeStats
      ? Math.round(nativeStats.tokens_per_second)
      : tokenCounter.averageTps();

    const reasoningLoopDetected = reasoningLoopDetector.state().triggered;
    const maxToolCallsPerBatch = resolveToolBatchLimit(c.tools?.max_tool_calls_per_batch);
    const toolCallCount = providerPresentation.expectsToolCalls
      ? result?.tool_calls?.length ?? 0
      : 0;
    const providerFinishReason = nativeSuccess
      ? nativeFinishReason
      : (result?.finish_reason ?? (signal.aborted ? undefined : 'disconnected'));
    const providerToolTurnComplete = providerFinishReason === 'tool_calls'
      || providerFinishReason === 'tool_use'
      || providerFinishReason === 'function_call';
    const toolBatchLimitExceeded = returnToolCalls
      && providerToolTurnComplete
      && exceedsToolBatchLimit(toolCallCount, maxToolCallsPerBatch);
    const toolBatchLimitError = toolBatchLimitExceeded
      ? formatToolBatchLimitMessage(toolCallCount, maxToolCallsPerBatch)
      : undefined;
    if (toolBatchLimitExceeded) {
      debugLog.warn('[LC] rejecting oversized tool batch', {
        conversationId: convId,
        callCount: toolCallCount,
        maxCallsPerBatch: maxToolCallsPerBatch,
      });
    }
    const streamFinishReason = reasoningLoopDetected
      ? INFINITE_REASONING_LOOP
      : toolBatchLimitExceeded
        ? 'tool_batch_limit'
        : providerFinishReason;
    const streamErrorMessage = reasoningLoopDetected
      ? 'LC stopped the stream after detecting a repeating reasoning-only loop.'
      : toolBatchLimitError
        ? toolBatchLimitError
        : (nativeSuccess ? nativeErrorMessage : result?.error_message);
    recordDiagnosticEvent({
      subsystem: 'stream',
      operation: 'completion',
      outcome: reasoningLoopDetected || toolBatchLimitExceeded
        ? 'rejected'
        : streamErrorMessage
          ? 'error'
          : 'ok',
      code: reasoningLoopDetected ? 'reasoning-loop' : diagnosticFinishCode(streamFinishReason),
      // Pairs this terminal result with its own request using the ephemeral
      // ring sequence only — no provider, request, or conversation identifier.
      // `requestSequence` covers the native path too, where the stream result
      // is destructured and its own sequence would otherwise be lost.
      ...(requestSequence !== undefined ? { sequence: requestSequence } : {}),
      durationBucket: durationBucket(durationMs),
      usageReported: lastUsage?.source === 'provider',
      ...(lastUsage ? {
        promptTokens: lastUsage.prompt_tokens,
        completionTokens: lastUsage.completion_tokens,
        totalTokens: lastUsage.total_tokens,
      } : {}),
      ...(lastUsage?.cache ? {
        cacheStatus: lastUsage.cache.status,
        cacheReportedBy: lastUsage.cache.reportedBy ?? 'unknown',
        ...(lastUsage.cache.readTokens !== undefined ? { cacheReadTokens: lastUsage.cache.readTokens } : {}),
        ...(lastUsage.cache.writeTokens !== undefined ? { cacheWriteTokens: lastUsage.cache.writeTokens } : {}),
        ...(lastUsage.cache.missTokens !== undefined ? { cacheMissTokens: lastUsage.cache.missTokens } : {}),
      } : {}),
      ...(result?.prefix ? {
        prefixConclusion: result.prefix.conclusion,
        prefixQualifiers: result.prefix.qualifiers,
      } : {}),
      ...(streamErrorMessage ? { description: streamErrorMessage } : {}),
    });
    const skipFinalize = !reasoningLoopDetected
      && !toolBatchLimitExceeded
      && returnToolCalls
      && providerToolTurnComplete
      && toolCallCount > 0;
    const responseStatePatch: Partial<import('../../types.ts').Message> = {};
    if (result?.refusal !== undefined) responseStatePatch.refusal = result.refusal;
    const priorState = ownedAssistant(owner);
    if (apiVariant === 'gemini' && result?.gemini_interactions?.length) {
      const prior = priorState?.gemini_interactions ?? [];
      const seen = new Set(prior.map((group) => group.responseId));
      responseStatePatch.gemini_interactions = [
        ...prior,
        ...result.gemini_interactions.filter((group) => !seen.has(group.responseId)).map((group) => ({
          ...group, origin: { baseUrl: prof.baseUrl, model: effectiveModel2 },
          complete: group.complete && !toolBatchLimitExceeded && (providerToolTurnComplete || toolCallCount === 0),
        })),
      ];
    }
    const priorAccounting = normalizeOpaqueReplayAccounting(
      priorState?.opaque_replay_accounting,
      {
        responsesOutputItems: priorState?.responses_output_items,
        responsesBaseUrl: prof.baseUrl,
        responsesProviderContractId: opts.snapshot?.providerContract?.contract.id,
        anthropicOutputBlocks: priorState?.anthropic_output_blocks,
        anthropicBaseUrl: priorState?.meta?.baseUrl,
      },
    ) ?? [];
    const nextAccounting = [...priorAccounting];
    // Do not persist Responses function_call items when LC rejects the
    // batch. There will be no matching function_call_output items, so saving
    // them would make the next Responses request structurally invalid.
    const usesResponsesProtocol = (apiVariant ?? 'openai') === 'openai'
      && apiStyle === 'responses';
    if (!toolBatchLimitExceeded
      && (usesResponsesProtocol || (result?.responses_output_items?.length ?? 0) > 0)) {
      const safeOutputItems = providerToolTurnComplete || toolCallCount === 0
        ? result?.responses_output_items ?? []
        : result?.responses_output_items?.filter((item) => item.type !== 'function_call') ?? [];
      const priorItems = priorState?.responses_output_items ?? [];
      const seen = new Set(priorItems.map((item) => item.id));
      const appendedItems = safeOutputItems.filter((item) => !seen.has(item.id));
      if (appendedItems.length > 0) {
        responseStatePatch.responses_output_items = [...priorItems, ...appendedItems];
      }
      // Keep an explicit boundary even when a compatible Responses server
      // omitted output items. Without it a later canonical final reply would
      // be attached to the preceding tool-call response during re-expansion.
      const group = createResponsesReplayAccountingGroup(
        appendedItems,
        lastUsage,
        result?.tool_calls?.map((call) => call.id),
        usesResponsesProtocol,
        prof.baseUrl,
        opts.snapshot?.providerContract?.contract.id,
      );
      if (group) nextAccounting.push(group);
    }
    if (!toolBatchLimitExceeded && (apiVariant ?? 'openai') === 'anthropic') {
      const priorBlocks = priorState?.anthropic_output_blocks ?? [];
      const appendedBlocks = result?.anthropic_output_blocks ?? [];
      if (appendedBlocks.length > 0) {
        responseStatePatch.anthropic_output_blocks = [...priorBlocks, ...appendedBlocks];
      }
      // Merge this response's recorded provider block order behind earlier
      // responses, rebasing stream-local indexes so the turn keeps one
      // coherent sequence. Past the bound the order is dropped and later
      // requests fall back to the legacy layout; blocks themselves survive.
      const appendedOrder = result?.anthropic_block_order ?? [];
      if (appendedOrder.length > 0) {
        const priorOrder = priorState?.anthropic_block_order ?? [];
        const responseIndex = priorAccounting.filter(
          (entry) => entry.protocol === 'anthropic-messages',
        ).length;
        const base = priorOrder.length > 0
          ? Math.max(...priorOrder.map((entry) => entry.index)) + 1
          : 0;
        const merged = [
          ...priorOrder,
          ...appendedOrder.map((entry) => ({
            ...entry,
            index: entry.index + base,
            responseIndex,
          })),
        ];
        responseStatePatch.anthropic_block_order = merged.length <= MAX_ANTHROPIC_BLOCK_ORDER
          ? merged
          : undefined;
      }
      const group = createAnthropicReplayAccountingGroup(
        appendedBlocks,
        priorBlocks.length,
        lastUsage,
        result?.tool_calls?.map((call) => call.id),
        true,
        prof.baseUrl,
      );
      if (group) nextAccounting.push(group);
    }
    if (nextAccounting.length > priorAccounting.length) {
      const responsesOutputItems = responseStatePatch.responses_output_items
        ?? priorState?.responses_output_items;
      const anthropicOutputBlocks = responseStatePatch.anthropic_output_blocks
        ?? priorState?.anthropic_output_blocks;
      responseStatePatch.opaque_replay_accounting = normalizeOpaqueReplayAccounting(
        nextAccounting,
        {
          responsesOutputItems,
          responsesBaseUrl: prof.baseUrl,
          responsesProviderContractId: opts.snapshot?.providerContract?.contract.id,
          anthropicOutputBlocks,
          anthropicBaseUrl: prof.baseUrl,
        },
      );
    }
    if (!toolBatchLimitExceeded && result?.reasoning_details?.length) {
      responseStatePatch.reasoning_details = result.reasoning_details;
    }
    if (nativeResponseId) responseStatePatch.lmstudio_response_id = nativeResponseId;
    // Tool-loop callers finalize the assistant message after this function
    // returns. Persist provider state before that hand-off so Responses
    // history survives the tool execution gap as well.
    if (generationIsActive(owner)) {
      useConversations.getState().patchMessage(convId, owner.assistantMessageId, {
        ...responseStatePatch,
        usage: messageUsage,
        meta: {
          ...priorState?.meta,
          model: effectiveModel2,
          baseUrl: prof.baseUrl,
          totalTokens: messageUsage.completion_tokens,
        },
      });
    }
    if (!skipFinalize) {
      finalizeGeneration(owner, {
        usage: messageUsage,
        // LC's own inference about its request, kept separate from `usage`,
        // which is what the provider reported.
        ...(result?.prefix ? { prefix: result.prefix } : {}),
        ...responseStatePatch,
        meta: {
          model: effectiveModel2 || undefined,
          baseUrl: prof.baseUrl,
          presetName: detectPresetName(c.params),
          avgTps,
          totalTokens: messageUsage.completion_tokens,
          durationMs,
          finish_reason: streamFinishReason,
          provider_finish_reason: nativeSuccess ? nativeProviderFinishReason : result?.provider_finish_reason,
          error_message: streamErrorMessage,
        },
      });
    }
    callbacks.onDone({
      content: result?.content ?? '',
      usage: messageUsage,
      ...(result?.prefix ? { prefix: result.prefix } : {}),
      finishReason: streamFinishReason,
      providerFinishReason: nativeSuccess ? nativeProviderFinishReason : result?.provider_finish_reason,
      durationMs,
      tps: avgTps,
      tokenCounter,
      toolCalls: providerPresentation.expectsToolCalls && returnToolCalls
        && !reasoningLoopDetected && !toolBatchLimitExceeded && providerToolTurnComplete
        ? result?.tool_calls
        : undefined,
      refusal: result?.refusal,
    });

    return returnToolCalls && providerPresentation.expectsToolCalls
      ? (reasoningLoopDetected || toolBatchLimitExceeded || !providerToolTurnComplete
        ? []
        : result?.tool_calls ?? [])
      : undefined;
  } catch (e) {
    stopForwardingExternalAbort();
    flushNow();
    if (!generationIsActive(owner)) return;
    phases.textResponse.finished();
    phases.reasoning.finished();
    const partialResponseUsage = responseLocalEstimate();
    if (partialResponseUsage) {
      opts._turnUsageAccumulator?.addResponse(responseUsageId, partialResponseUsage);
    }
    const partialUsage = opts._turnUsageAccumulator?.snapshot('partial') ?? partialResponseUsage;
    if (reasoningLoopDetector.state().triggered) {
      recordDiagnosticEvent({
        subsystem: 'stream',
        operation: 'completion',
        outcome: 'rejected',
        code: 'reasoning-loop',
        ...(requestSequence !== undefined ? { sequence: requestSequence } : {}),
      });
      const avgTps = tokenCounter.currentTps();
      const durationMs = tokenCounter.durationMs();
      finalizeGeneration(owner, {
        usage: partialUsage,
        meta: {
          model: effectiveModel2 || undefined,
          presetName: detectPresetName(c.params),
          avgTps: Math.round(avgTps),
          totalTokens: partialUsage?.completion_tokens,
          durationMs,
          finish_reason: INFINITE_REASONING_LOOP,
          error_message: 'LC stopped the stream after detecting a repeating reasoning-only loop.',
        },
      });
      callbacks.onError('infinite reasoning loop detected', false);
    } else if (signal.aborted) {
      recordDiagnosticEvent({
        subsystem: 'stream',
        operation: 'completion',
        outcome: 'cancelled',
        code: 'user-cancelled',
        ...(requestSequence !== undefined ? { sequence: requestSequence } : {}),
      });
      const avgTps = tokenCounter.currentTps();
      const durationMs = tokenCounter.durationMs();
      finalizeGeneration(owner, {
        usage: partialUsage,
        meta: {
          model: effectiveModel2 || undefined,
          presetName: detectPresetName(c.params),
          avgTps: Math.round(avgTps),
          totalTokens: partialUsage?.completion_tokens,
          durationMs,
          finish_reason: 'disconnected',
        },
      });
      callbacks.onError('aborted', true);
    } else {
      const msg = errorMessage(e);
      const status = diagnosticHttpStatus(e);
      recordDiagnosticEvent({
        subsystem: 'stream',
        operation: 'completion',
        outcome: isDiagnosticTimeout(e) ? 'timeout' : 'error',
        code: isDiagnosticTimeout(e) ? 'read-timeout' : status ? 'http-error' : 'network-error',
        ...(status !== undefined ? { httpStatus: status } : {}),
        ...(requestSequence !== undefined ? { sequence: requestSequence } : {}),
        description: e,
      });
      finalizeGeneration(owner, {
        usage: partialUsage,
        meta: {
          model: effectiveModel2 || undefined,
          presetName: detectPresetName(c.params),
          totalTokens: partialUsage?.completion_tokens,
          finish_reason: 'error',
          error_message: msg,
        },
      });
      callbacks.onError(msg, false);
    }
  }
}

// ── runToolLoop ────────────────────────────────────────────────────

async function runToolLoop(
  convId: string,
  initialCalls: ToolCallRecord[],
  signal: AbortSignal,
  profileRef: { current: PipelineOptions['profile'] | null },
  modelRef: { current: string },
  llmCallRef: { current: ToolHandlerContext['llmCall'] },
  streamOpts: Omit<PipelineOptions, 'signal'>,
  _injectedImageRef: { current: Set<string> },
  whiteboardLifecycle?: WhiteboardGenerationLifecycle,
  turnUsageAccumulator?: TurnUsageAccumulator,
): Promise<ToolLoopResult> {
  const owner: GenerationAddress = streamOpts;
  const phases = createGenerationPhaseTracker(owner.convId, owner.generationId);
  let pendingInteractions = 0;
  const withInteractionPhase = async <Result,>(
    phase: 'waiting-permission' | 'waiting-user',
    run: () => Promise<Result>,
  ): Promise<Result> => {
    pendingInteractions += 1;
    setGenerationSessionPhase(owner.convId, owner.generationId, phase);
    try {
      return await run();
    } finally {
      pendingInteractions -= 1;
      if (pendingInteractions === 0 && generationIsActive(owner)) {
        setGenerationSessionPhase(owner.convId, owner.generationId, 'using-tools');
      }
    }
  };
  let calls = initialCalls;
  let toolRounds = 0;
  const windowsPlatform = isWindowsPlatform();

  // Tool_call ids already answered by an earlier round of this turn. A
  // provider replaying an old id must not execute it again — exactly-once
  // spans re-stream boundaries, not just one batch.
  const answeredCallIds = new Set<string>();
  const helpGovernor = createToolHelpGovernorState();
  let disposeActiveRound: (() => void) | undefined;
  const settleWhiteboardBeforeRepair = async (reason: WhiteboardTerminalReason) => {
    if (!whiteboardLifecycle) return true;
    const settled = await whiteboardLifecycle.settle(reason);
    if (!settled) {
      debugLog.warn('[LC] Whiteboard terminal settlement failed; preserving its unanswered calls for crash recovery.');
    }
    return settled;
  };

  // Track normalized calls in declaration order across the turn. Worker
  // completion order must not decide which result receives a repeat notice.
  const dupeSeen = new Map<string, number>();

  phases.toolUse.started();
  phases.toolUse.running();
  await new Promise(r => setTimeout(r, 0));
  if (signal.aborted || !generationIsActive(owner)) {
    return { toolRounds, stopReason: 'aborted' };
  }

  try {
    while (calls.length > 0) {
      const c = snapshottedConversation(streamOpts);
      if (!c) return { toolRounds, stopReason: 'aborted' };
      const maxToolRounds = resolveToolRoundLimit(c.tools?.max_tool_rounds_per_turn);
      if (toolRounds >= maxToolRounds) return { toolRounds, stopReason: 'max_tool_rounds' };
      toolRounds++;
      if (signal.aborted || !generationIsActive(owner)) {
        return { toolRounds, stopReason: 'aborted' };
      }

      // Normalize the narrow cmd.exe adapter before validation, permission,
      // execution diagnostics, and persistence. The approval UI therefore
      // shows the exact /d /u /c command that will execute.
      calls = calls.map((call) => normalizeWindowsShellCall(call, windowsPlatform));
      const suppressInteractiveBatch = calls.length !== 1
        && calls.some((call) => call.name === ASK_USER_TOOL_NAME);

      // Resolve exposure before validation so unknown-name suggestions contain
      // only operational tools that the model can call in this turn.
      const exposure = resolveExposure(c.tools ?? { enabled: true });
      const enabled = new Set(exposure.exposedNames);

      // 1. Validate, admit by tool_call id, then govern surviving help calls. The provider protocol has
      //    exactly one result slot per id: an id answered in an earlier round
      //    of this turn must not execute again, and a duplicate inside this
      //    round executes once. Pruned occurrences stay out of the persisted
      //    assistant tool_calls and out of the pool, so the durable graph
      //    holds at most one call and one result per id.
      const validatedAll = validateToolCalls(calls, HANDLERS_BY_NAME, exposure.exposedNames);
      const admission = admitToolCallsById(validatedAll.map((vc) => vc.call), answeredCallIds);
      const prunedIndices = admission.prunedIndices;
      const duplicateNotices = admission.duplicateNotices;
      const validated: ValidatedCall[] = validatedAll.filter((_vc, index) => !prunedIndices.has(index));
      // A provider replay that reuses an answered call id has no result slot in
      // this round. Do not charge a help attempt whose result will be pruned.
      // Interactive isolation rejects the complete declared batch before any
      // sibling is accepted. Do not consume hidden help counters for guidance
      // that this branch will replace with an isolation error.
      const helpAdmissions = governToolHelpCalls(
        suppressInteractiveBatch ? [] : validated,
        exposure.exposedNames,
        helpGovernor,
      );
      const whiteboardAdmissions = governWhiteboardCalls(validated);
      const repeatNotices = new Map<string, LcResultNotice>();
      if (!suppressInteractiveBatch) {
        for (const vc of validated) {
          if (
            vc.error
            || vc.parsed === undefined
            || !enabled.has(vc.call.name)
            || helpAdmissions.has(vc.call)
            || whiteboardAdmissions.has(vc.call)
          ) continue;
          const key = `${vc.call.name}::${normalizedToolArgumentsKey(vc.parsed)}`;
          const count = (dupeSeen.get(key) ?? 0) + 1;
          dupeSeen.set(key, count);
          if (count >= 2) {
            repeatNotices.set(vc.call.id, repeatedToolCallNotice(vc.call.name, count));
          }
        }
      }
      if (prunedIndices.size > 0) {
        // The current round's rows are the trailing `calls.length` entries of
        // the persisted assistant tool_calls (append-merged by the re-stream
        // finalize). Keep every prior round's rows and only the surviving
        // current rows, so one call row and one result row exist per id.
        const existing = ownedAssistant(owner)?.tool_calls ?? [];
        const priorCount = Math.max(0, existing.length - calls.length);
        const prior = existing.slice(0, priorCount);
        const surviving = calls.filter((_call, index) => !prunedIndices.has(index));
        useConversations.getState().patchMessage(convId, owner.assistantMessageId, {
          tool_calls: [...prior, ...surviving],
        });
        calls = surviving;
        // Cross-round replay: an id answered in an earlier round has no
        // worker in this round, so its notice cannot ride a result row.
        // Patch the earlier round's existing result instead — one row per
        // id preserved. The notice is store-visible: it rides the persisted
        // result into every later request (the next user turn sends it to
        // the model), but an all-pruned terminal round makes no further
        // model request in this generation.
        for (const [id, notice] of duplicateNotices) {
          // A same-batch survivor receives its notice when it completes.
          // Its provider ID may also belong to an unrelated prior turn.
          if (!answeredCallIds.has(id)) continue;
          const currentMessages = useConversations.getState().byId[convId]?.messages ?? [];
          const priorResult = [...currentMessages].reverse()
            .find((m) => m.role === 'tool' && m.tool_call_id === id && !m.content.includes(notice));
          if (priorResult) {
            useConversations.getState().patchMessage(convId, priorResult.id, {
              content: prependLcResultNotice(priorResult.content, notice),
            });
          }
        }
        // A round whose calls were all pruned (the provider replayed only old
        // ids) contributes nothing to execute; stop rather than re-stream
        // forever. The round cap still bounds a provider that alternates
        // replays with new ids.
        if (calls.length === 0) {
          return { toolRounds, stopReason: 'no_tool_calls' };
        }
      }

      const soleInteractiveRound = !suppressInteractiveBatch
        && calls.length === 1
        && validated.length === 1
        && validated[0].call.name === ASK_USER_TOOL_NAME
        && validated[0].error === undefined
        && enabled.has(ASK_USER_TOOL_NAME);

      // Reads in this batch that race a mutation of the same file. Flagged on
      // the result so the model knows which value not to trust.
      const contendedPaths = findContendedFilePaths(validated);

      // Phase 1.3: compute the authoritative grant snapshot.
      const grantsSnapshot = buildGrantSnapshot(c.tools ?? { enabled: true });

      // 3. Build base context (Phase 1.5: immutable snapshot per round).
      //    Workers receive a frozen copy; they do NOT mutate this directly.
      //
      //    Phase 2.5: Compute a per-round deadline so all sub-operations
      //    of compound tools share one budget. Each native IPC call receives
      //    remaining milliseconds via `remainingMs(deadlineMs, defaultMs)`.
      const roundDeadlineMs = soleInteractiveRound
        ? undefined
        : Date.now() + (c.tools?.sse_read_timeout_min
          ? c.tools.sse_read_timeout_min * 60_000
          : 120_000);
      const roundLifecycle = createToolRoundLifecycle(signal, roundDeadlineMs);
      disposeActiveRound = roundLifecycle.dispose;
      const roundSignal = roundLifecycle.signal;
      const askUser = soleInteractiveRound
        ? (input: Parameters<NonNullable<ToolHandlerContext['askUser']>>[0]) => {
            const interactionId = crypto.randomUUID();
            return withInteractionPhase('waiting-user', () => showAskUserModal(
              input,
              {
                id: c.id,
                title: c.title,
                modelId: streamOpts.snapshot?.conversation.model ?? modelRef.current,
              },
              signal,
              {
              identity: {
                interactionId,
                conversationId: c.id,
                conversationTitle: c.title,
                generationId: owner.generationId,
                assistantMessageId: owner.assistantMessageId,
                toolCallId: calls[0]?.id ?? interactionId,
                kind: 'ask-user',
                requestedAt: Date.now(),
              },
              validateOwnership: () => generationIsActive(owner),
              },
            ));
          }
        : undefined;
      const baseCtx = buildToolCtx(
        c,
        roundSignal,
        profileRef,
        modelRef,
        llmCallRef,
        streamOpts._visionResolved?.current ?? streamOpts.modelIsVision ?? false,
        streamOpts.apiStyle,
        streamOpts.apiVariant,
        owner.generationId,
        undefined,
        askUser,
        whiteboardLifecycle?.service,
        streamOpts.snapshot,
        streamOpts.runtimeSecrets,
      );
      if (roundDeadlineMs !== undefined) baseCtx.config.deadlineMs = roundDeadlineMs;

      // Phase 1.5: Snapshot the tools config at round start.
      // Workers use this snapshot; they do not re-read the store mid-execution.
      const toolsSnapshot = Object.freeze({ ...c.tools }) as typeof c.tools;

      // 4. Execute each accepted call in parallel, bounded by the Workspace
      //    tool-batch setting. Oversized batches are rejected in runStream.
      //    Permission modals are serialized via a lock — only one modal
      //    can render at a time; concurrent calls queue up behind it.
      // Phase 1.5: Prompt deduplication cache.
      // Non-shell calls with the same dedupe key may share one persistent or
      // blocking decision. `allow_once` is different: it authorizes exactly
      // the logical call displayed in that popup, so the next queued call must
      // consume its own decision. Shell calls always get unique keys.
      type AuditedPermissionResult = Awaited<ReturnType<typeof showPermissionModal>> & {
        audit: ToolPermissionAudit;
        /** Time spent waiting behind an earlier global interaction. */
        queueWaitMs: number;
      };
      const openAuditedModal = (
        call: ToolCallRecord,
        requestedAt: number,
        dirs?: string[],
      ) => {
        const promptId = crypto.randomUUID();
        const scopes = [...(dirs ?? [])];
        let queueWaitStartedAt = 0;
        let queueWaitMs = 0;
        // Repair Windows-path backslash escaping before showing the modal so
        // the user sees the exact path that execution will receive.
        const fixedCall = {
          ...call,
          arguments: repairWindowsJsonAfterParseFailure(call.arguments),
        };
        return withInteractionPhase('waiting-permission', () => showPermissionModal(
          fixedCall,
          scopes,
          roundSignal,
          {
          identity: {
            interactionId: promptId,
            conversationId: c.id,
            conversationTitle: c.title,
            generationId: owner.generationId,
            assistantMessageId: owner.assistantMessageId,
            toolCallId: call.id,
            kind: 'permission',
            requestedAt,
          },
          modelId: streamOpts.snapshot?.conversation.model ?? modelRef.current,
          validateOwnership: () => generationIsActive(owner),
          onQueueWaitStart: () => {
            roundLifecycle.pauseDeadline();
            queueWaitStartedAt = Date.now();
          },
          onQueueWaitEnd: () => {
            try {
              if (queueWaitStartedAt > 0) {
                queueWaitMs += Math.max(0, Date.now() - queueWaitStartedAt);
                queueWaitStartedAt = 0;
              }
            } finally {
              roundLifecycle.resumeDeadline();
            }
          },
          },
        )).then((result): AuditedPermissionResult => ({
          ...result,
          queueWaitMs,
          audit: {
            prompt_id: promptId,
            requested_at: requestedAt,
            ...(result.shownAt != null ? { shown_at: result.shownAt } : {}),
            resolved_at: result.resolvedAt ?? Date.now(),
            decision: result.decision,
            displayed_call: {
              tool_call_id: call.id,
              tool_name: call.name,
            },
            scopes,
          },
        }));
      };
      const modalCache = new Map<string, { tail: Promise<AuditedPermissionResult> }>();
      const resolveModal = (dedupeKey: string, call: ToolCallRecord, dirs?: string[]) => {
        // Capture when this logical call requested authorization, before it
        // queues behind an earlier same-scope popup. `shown_at - requested_at`
        // must include the complete serialization/host wait.
        const requestedAt = Date.now();
        const cached = modalCache.get(dedupeKey);
        if (!cached) {
          const first = openAuditedModal(call, requestedAt, dirs);
          modalCache.set(dedupeKey, { tail: first });
          return first;
        }
        // Chain callers in arrival order. A persistent approval (or a shared
        // fail-closed decision) covers the same dedupe scope. An allow-once
        // result was consumed by the call shown in that popup and cannot be
        // replayed as authorization for a sibling call.
        // Every caller keeps the FIFO wait shared with earlier callers.
        // A separate popup adds its own FIFO wait without counting visible time.
        const next = cached.tail.then((result) =>
          result.decision === 'allow_once'
            ? openAuditedModal(call, requestedAt, dirs).then((nextResult) => ({
                ...nextResult,
                queueWaitMs: result.queueWaitMs + nextResult.queueWaitMs,
              }))
            : result);
        cached.tail = next;
        return next;
      };

      // Tool-result messages are the durable join point for popup evidence.
      // Deduplicated calls receive the same audit (and therefore prompt id),
      // while shell calls keep their one-popup-per-call identity.
      const permissionAudits = new Map<string, ToolPermissionAudit>();

      // Phase 1.7: File-level locking for mutating operations. Same-file
      // aliases serialize; independent writes/edits may proceed in parallel.
      // Patch calls additionally hold a global reservation from native
      // preflight through execution, then lock every canonical target.
      //
      // The manager is application-owned rather than built per round. A
      // per-round manager gives each generation its own lock domain, so two
      // conversations writing one file would contend only at the native OS
      // lock — which blocks and cannot be aborted, because the mutating native
      // tools register no cancellation token. Sharing one domain puts the
      // abortable JavaScript wait first.
      /** Extract file target paths from parsed tool args. */
      const extractFileTargets = (parsed: unknown): string[] => {
        if (!parsed || typeof parsed !== 'object') return [];
        const p = parsed as Record<string, unknown>;
        const targets: string[] = [];
        // write_file / edit: { files: [{ path, ... }] }
        if (Array.isArray(p.files)) {
          for (const f of p.files as Array<{ path?: string }>) {
            if (typeof f.path === 'string' && f.path) targets.push(f.path);
          }
        }
        // Single path field
        if (typeof p.path === 'string' && p.path) targets.push(p.path);
        return targets;
      };

      /** Execute a tool call, acquiring file locks for mutating operations. */
      const executeWithLock = async (
        call: ToolCallRecord,
        parsed: unknown,
        handler: ToolHandler,
        ctx: ToolHandlerContext,
        permission: PermissionDisposition,
      ) => {
        let reservation: Awaited<ReturnType<
          typeof applicationMutationCoordinator.acquireWrite
        >> | undefined;
        if (call.name === 'lc_run_shell') {
          reservation = await applicationMutationCoordinator.acquireShell(ctx.signal);
        } else if (FILE_IO_MUTATING_NAMES.has(call.name)) {
          // write_file/edit targets come straight from the model, so two
          // spellings of one file would otherwise take independent locks.
          const targets = await canonicalizeLockTargets(
            extractFileTargets(parsed),
            resolveLockTarget,
          );
          reservation = await applicationMutationCoordinator.acquireWrite(targets, ctx.signal);
        } else if (CONTENDABLE_READ_NAMES.has(call.name)) {
          const targets = await canonicalizeLockTargets(
            fileTargetsOf(call.name, parsed),
            resolveLockTarget,
          );
          reservation = await applicationMutationCoordinator.acquireExactRead(targets, ctx.signal);
        } else if (call.name === 'lc_list_dir' || call.name === 'lc_glob_files' || call.name === 'lc_grep') {
          reservation = await applicationMutationCoordinator.acquireBroadRead(ctx.signal);
        }
        if (!reservation) return executeToolCall(call, parsed, handler, ctx, permission);
        try {
          const result = await executeToolCall(call, parsed, handler, ctx, permission);
          if (
            reservation.contended
            && (call.name === 'lc_list_dir' || call.name === 'lc_glob_files' || call.name === 'lc_grep')
          ) {
            result.output = prependLcResultNotice(result.output, broadReadWaitNotice());
          }
          return result;
        } finally {
          reservation.release();
        }
      };

      // The Workspace setting is both the hard per-response batch ceiling
      // (checked before this function is reached) and the execution pool
      // width for an accepted batch.
      const concurrency = resolveToolBatchLimit(c?.tools?.max_tool_calls_per_batch);

      // Persist each tool result immediately as it completes, rather
      // than waiting for all tools to finish.  Without this the UI
      // stalls until the slowest tool in the batch returns.
      const onToolComplete = (r: { tool_call_id: string; output: string; is_error: boolean; duration_ms: number }) => {
        if (roundSignal.aborted || !generationIsActive(owner)) return;
        if (import.meta.env?.DEV) {
          debugLog.warn('[LC DEBUG] runToolLoop tool result:', {
            tool_call_id: r.tool_call_id,
            is_error: r.is_error,
            duration_ms: r.duration_ms,
            outputLen: r.output?.length ?? 0,
            outputPreview: r.output?.slice(0, 500),
          });
        }
        // Phase 3.4: register image batch ID in side-channel map and
        // strip internal fields before persisting to model context.
        registerImageBatchId(owner, r.tool_call_id, r.output);
        const cleanOutput = stripInternalImageResultFields(r.output);
        const toolName = validated.find((v) => v.call.id === r.tool_call_id)?.call.name;
        if (
          toolName === 'lc_whiteboard'
          && whiteboardLifecycle
          && !whiteboardLifecycle.ordinaryResultsAllowed()
        ) {
          return;
        }
        const lineChanges = toolName
          ? summarizeFileLineChanges(toolName, r.output)
          : undefined;
        const toolPermission = permissionAudits.get(r.tool_call_id);
        useConversations.getState().appendMessage(convId, {
          role: 'tool', content: cleanOutput, tool_call_id: r.tool_call_id, tool_is_error: r.is_error, tool_duration_ms: r.duration_ms,
          ...(toolPermission ? { tool_permission: toolPermission } : {}),
          ...(lineChanges
            ? {
                tool_lines_added: lineChanges.added,
                tool_lines_removed: lineChanges.removed,
                tool_line_changes: lineChanges.files,
              }
            : {}),
        });
      };

      // A Stop while this round's pool is running must not leave accepted
      // tool_call ids unanswered. The pool promise itself never settles
      // when a handler ignores its abort signal, so the loop races the pool
      // against the abort and repairs the unanswered ids in the race winner,
      // then abandons the never-settling workers. Completed-and-persisted
      // results stay; every id still missing one gets a terminal,
      // non-replayed result.
      const roundCallIds = calls.map((c) => c.id);
      const abortSettler = new Promise<'aborted'>((resolve) => {
        const settle = () => resolve('aborted');
        if (signal.aborted) settle();
        else signal.addEventListener('abort', settle, { once: true });
      });

      const runAcceptedCallCore = async (vc: ValidatedCall, _idx: number) => {
          const { call, parsed, error } = vc;
        // Phase 2.1: Mint per-call execution identity.
        // Each model tool call gets a unique groupId; each native
        // child within it gets a unique operationId (minted by the
        // tool handler itself when it makes native IPC calls).
        const callIdentity: ToolExecutionIdentity = {
          groupId: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          modelToolCallId: call.id,
          conversationId: convId,
          generationId: owner.generationId,
        };
        // Phase 1.5: immutable per-call context — start from base snapshot,
        // then attach per-call identity (Phase 2.1).
        let ctx: ToolHandlerContext = {
          ...baseCtx,
          identity: callIdentity,
        };
        // Sanitize call.arguments so all downstream consumers
        // permission and execution paths see clean JSON —
        // not model-hallucinated garbage like D:\"]].
        // Only attempt repair when the args actually fail to parse —
        // the ordering (parse first, repair only on failure) is the
        // contract; repairWindowsJson must never run on well-formed input.
        if (!error && parsed) {
          try {
            call.arguments = JSON.stringify(JSON.parse(call.arguments));
          } catch {
            call.arguments = repairWindowsJsonAfterParseFailure(call.arguments);
            try { call.arguments = JSON.stringify(JSON.parse(call.arguments)); } catch { /* keep repaired raw */ }
          }
        }
        if (roundSignal.aborted) {
          return {
            tool_call_id: call.id,
            output: JSON.stringify(abortedEnvelope(0)),
            is_error: true,
            duration_ms: 0,
          };
        }
        const governedWhiteboard = whiteboardAdmissions.get(call);
        if (governedWhiteboard) {
          return {
            tool_call_id: call.id,
            output: JSON.stringify(governedWhiteboard),
            is_error: true,
            duration_ms: 0,
          };
        }
        const governedHelp = helpAdmissions.get(call);
        if (governedHelp) {
          return {
            tool_call_id: call.id,
            output: JSON.stringify(governedHelp),
            is_error: false,
            duration_ms: 0,
          };
        }
        if (error) {
          return structuredToolError(call.id, error);
        }
        const handler = resolveHandler(call, enabled, HANDLERS_BY_NAME);
        const admission: PatchAdmission = 'denied' in handler
          ? {
              allowed: false,
              issue: handler.reason === 'unknown_tool'
                ? { ...unknownOperationalToolIssue(call.name, enabled), retryable: false }
                : {
                    code: handler.reason,
                    message: `Tool "${call.name}" is not exposed in this conversation. Enable its category in the Workspace panel.`,
                    retryable: false,
                  },
            }
          : { allowed: true };

        if (call.name === 'lc_apply_patch') {
          const patchInput = parsed as { patch: string };
          // The patch coordinator runs its own authorize/approve flow, so the
          // disposition is captured from that flow rather than the popup path
          // below — the report must describe the decision this call acted on.
          let patchPermission: PermissionDisposition = 'unknown';
          let patchQueueWaitMs = 0;
          const outcome = await coordinateApplyPatch<Omit<ToolResultRecord, 'tool_call_id'>>({
            admission,
            patch: patchInput.patch,
            initialAllowedRoots: baseCtx.config.allowedRoots,
            reserve: () => applicationMutationCoordinator.reservePatch(roundSignal),
            discover: (patch) => baseCtx.sandbox.applyPatchTargets({ patch }),
            resolveTargetScope: (target) => resolvePathForScope(target, false),
            authorize: (canonicalScopes) => {
              const fileAuthorization = resolveFileAuthorization(
                call.name,
                canonicalScopes,
                true,
                grantsSnapshot,
              );
              const decision = authorizeFileCall(call.name, exposure, grantsSnapshot, fileAuthorization);
              const issue = decision.issues?.[0];
              if (issue) {
                return {
                  state: 'rejected' as const,
                  issue: {
                    code: issue.code,
                    message: issue.message,
                    path: issue.paths?.[0],
                    retryable: false,
                  },
                };
              }
              if (decision.state === 'pregranted') {
                patchPermission = 'not-required';
                return { state: 'pregranted' as const };
              }
              const requiredScopes = fileAuthorization.ungrantedDirs.length > 0
                ? [...fileAuthorization.ungrantedDirs]
                : [...fileAuthorization.missingGrantRoots];
              return { state: 'prompt' as const, requiredScopes };
            },
            requestApproval: async (requiredScopes): Promise<PatchApproval> => {
              const approval = await resolveModal(
                promptDedupeKey(call.name, call.id, requiredScopes),
                call,
                requiredScopes,
              );
              permissionAudits.set(call.id, approval.audit);
              patchQueueWaitMs = approval.queueWaitMs;
              if (approval.decision === 'allow_once' || approval.decision === 'allow_session') {
                patchPermission = permissionDispositionFor('file_io', true, approval.decision);
                return { decision: approval.decision, grantedDirs: approval.grantedDirs };
              }
              const blocked = approval.decision === 'unavailable' ? 'unavailable' : 'deny';
              patchPermission = permissionDispositionFor('file_io', true, blocked);
              // The tool never executes, so this is the only chance to record
              // that a permission decision is what stopped it.
              recordBlockedPermission(call.name, blocked === 'unavailable' ? 'unavailable' : 'denied');
              return { decision: blocked };
            },
            canonicalizeApprovedScope: resolveDirForApprovedScope,
            persistSessionScopes: async (approvedScopes) => {
              if (roundSignal.aborted || !generationIsActive(owner)) {
                return {
                  ok: false as const,
                  issue: {
                    code: 'aborted',
                    message: 'Operation cancelled by user.',
                    retryable: true,
                  },
                };
              }
              const store = useConversations.getState();
              const current = store.byId[convId];
              if (!current) {
                return {
                  ok: false as const,
                  issue: {
                    code: 'conversation_not_found',
                    message: 'The conversation no longer exists.',
                    retryable: false,
                  },
                };
              }
              const existing = current.tools ?? toolsSnapshot ?? {
                enabled: true,
                tool_grants: [] as string[],
                web_access_grants_initialized: false,
                skills_initialized: false,
                file_io_enabled: false,
                shell_enabled: false,
                web_access_enabled: false,
                tool_history_enabled: false,
                allowed_roots: [] as string[],
                dir_permissions: {} as Record<string, string[]>,
                max_tool_rounds_per_turn: 128,
                max_tool_calls_per_batch: DEFAULT_TOOL_BATCH_LIMIT,
                sse_read_timeout_min: streamOpts.snapshot?.profile.sseReadTimeoutMin
                  ?? useProfileStore.getState().profiles
                    .find((p) => p.id === c.serverId)?.sse_read_timeout_min ?? 5,
              };
              const updated = grantToolOnRoots(existing, call.name, approvedScopes);
              store.patchConversation(convId, { tools: updated });
              streamOpts._authorizationOverlay = { tools: updated };
              return { ok: true as const, allowedRoots: updated.allowed_roots ?? [] };
            },
            preflight: (patch, allowedRoots) => baseCtx.sandbox.applyPatchPreflight({
              patch,
              allowed_roots: allowedRoots,
            }),
            execute: ({ allowedRoots, planId }) => {
              if ('denied' in handler) throw new Error('unreachable denied patch execution');
              return executeToolCall(call, parsed!, handler, {
                ...baseCtx,
                identity: callIdentity,
                nativePlanId: planId,
                config: {
                  ...baseCtx.config,
                  allowedRoots,
                  ...(baseCtx.config.deadlineMs !== undefined
                    ? { deadlineMs: baseCtx.config.deadlineMs + patchQueueWaitMs }
                    : {}),
                },
              }, patchPermission);
            },
            normalizeError: (nativeError) => {
              const { issue } = normalizeThrownToolError(nativeError);
              return {
                code: issue.code,
                message: issue.message,
                path: issue.path,
                retryable: issue.retryable ?? true,
              };
            },
          });
          if (roundSignal.aborted || !generationIsActive(owner)) {
            return {
              tool_call_id: call.id,
              output: JSON.stringify(abortedEnvelope(0)),
              is_error: true,
              duration_ms: 0,
            };
          }
          if (outcome.status === 'rejected') {
            return structuredToolError(call.id, [outcome.issue]);
          }

          const r = outcome.value;
          const repeatNotice = repeatNotices.get(call.id);
          if (repeatNotice) r.output = prependLcResultNotice(r.output, repeatNotice);
          return { tool_call_id: call.id, ...r };
        }

        if ('denied' in handler) {
          return structuredToolError(call.id, [handler.reason === 'unknown_tool'
            ? unknownOperationalToolIssue(call.name, enabled)
            : {
                code: handler.reason,
                message: `Tool "${call.name}" is not exposed in this conversation. Enable its category in the Workspace panel.`,
                retryable: false,
              }]);
        }

        const fileCheckArgs = (parsed ?? {}) as Record<string, unknown>;

        // Permission check for destructive tools.
        if (call.name === 'lc_run_shell') {
          const shellInput = parsed as { cmd?: string };
          const cmd = shellInput.cmd?.trim();
          if (cmd) {
            const allowlist = baseCtx.config.shellAllowlist;
            // Secret master virtual binary: if "*****" is in the
            // allowlist, skip the binary name check. The grandmaster
            // "*******" implies the master behavior (any binary) too.
            const hasMaster = allowlist.includes('*****') || allowlist.includes('*******');
            if (!hasMaster) {
              const firstToken = cmd.split(/\s+/)[0] ?? cmd;
              const basename = firstToken.replace(/\\/g, '/').split('/').pop() ?? firstToken;
              if (!allowlist.includes(basename)) {
                return structuredToolError(call.id, [{
                  code: 'shell_binary_not_allowed',
                  message: `Command "${basename}" is not in the shell binary allowlist. Allowed: ${allowlist.join(', ')}. Edit the allowlist in Settings → Tools → Shell binary.`,
                  retryable: false,
                }]);
              }
            }
          }
        }

        // Phase 1.3: apply the authoritative policy model.
        // Shell always prompts (always_prompt), except under the grandmaster
        // "*******" override applied by permissionPopupRequired() in
        // approval-control.ts (see needsPopup below). Web Access prompts when
        // unchecked (per tool_grants). File I/O prompts when the target
        // directory lacks a grant in dir_permissions.
        const toolCat = categoryOf(call.name);
        if (!toolCat) {
          return structuredToolError(call.id, [unknownOperationalToolIssue(call.name, enabled)]);
        }

        // Pre-compute File I/O grant status from the normalized policy
        // snapshot. Pre-granted read-only tools skip the popup.
        let fileAuthorization: FileAuthorizationResult | undefined;
        let fileUngrantedDirs: string[] = [];
        if (toolCat === 'file_io') {
          const rawTargetPaths = targetPathsFromArgs(call.name, fileCheckArgs);
          // resolvePathForScope/resolveStatPathForScope already return the
          // canonical directory scope for each raw target. Do not pass these
          // through file authorization as file paths, or it will take the
          // parent a second time (e.g. `D:\\...\\what` becomes `D:\\...\\tests`
          // and `E:\\tmp` becomes the invalid drive-relative `E:`).
          const canonicalScopeDirs: string[] = [];
          const statIsTarget = call.name === 'lc_stat';
          const directoryIsTarget = directoryIsTargetTool(call.name) || statIsTarget;
          for (const rawPath of rawTargetPaths) {
            const canonical = statIsTarget
              ? await resolveStatPathForScope(rawPath)
              : await resolvePathForScope(rawPath, directoryIsTarget);
            if (!canonical) {
              return {
                tool_call_id: call.id,
                output: JSON.stringify({
                  status: 'error',
                  issues: [addCatalogRecovery(call.name, {
                    code: 'path_resolution_failed',
                    message: pathResolutionFailureMessage(rawPath),
                    path: rawPath,
                    retryable: true,
                  })],
                  warnings: [],
                }),
                is_error: true,
                duration_ms: 0,
              };
            }
            if (!canonicalScopeDirs.includes(canonical)) canonicalScopeDirs.push(canonical);
          }
          fileAuthorization = resolveFileAuthorization(
            call.name,
            canonicalScopeDirs,
            true,
            grantsSnapshot,
          );
          if (!fileAuthorization.allGranted) {
            fileUngrantedDirs = fileAuthorization.ungrantedDirs.length > 0
              ? [...fileAuthorization.ungrantedDirs]
              : [...fileAuthorization.missingGrantRoots];
          }
        }

        // Secret grandmaster virtual binary: "*******" (7 stars) in
        // the shell allowlist auto-approves shell calls — it
        // suppresses the always-prompt popup. It implies the master
        // "*****" behavior (any binary); all other sandboxing still
        // applies on the Rust side.
        const policyDecision = toolCat === 'file_io'
          ? authorizeFileCall(call.name, exposure, grantsSnapshot, fileAuthorization!)
          : authorizeNonFileCall(call.name, exposure, grantsSnapshot);
        if (policyDecision.issues && policyDecision.issues.length > 0) {
          return structuredToolError(call.id, policyDecision.issues.map((issue) => addCatalogRecovery(call.name, {
            code: issue.code,
            message: issue.message,
            ...(issue.paths?.[0] ? { path: issue.paths[0] } : {}),
            retryable: false,
          })));
        }
        const needsPopup = permissionPopupRequired(
          toolCat,
          policyDecision.state,
          baseCtx.config.shellAllowlist,
        );
        // The authoritative disposition for this call. It is handed to the
        // executor so the execution event carries it, rather than being
        // recorded separately and then hidden by the execution event.
        let permission: PermissionDisposition = permissionDispositionFor(toolCat, needsPopup);

        if (needsPopup) {
          // Phase 1.5: dedupe non-shell modals by scope.
          // File I/O modals include target dirs for scope-based dedup.
          const dedupeKey = toolCat === 'file_io'
            ? promptDedupeKey(call.name, call.id, fileUngrantedDirs)
            : promptDedupeKey(call.name, call.id);
          const result = toolCat === 'file_io'
            ? await resolveModal(dedupeKey, call, fileUngrantedDirs)
            : await resolveModal(dedupeKey, call);
          if (result.queueWaitMs > 0 && ctx.config.deadlineMs !== undefined) {
            ctx = {
              ...ctx,
              config: {
                ...ctx.config,
                deadlineMs: ctx.config.deadlineMs + result.queueWaitMs,
              },
            };
          }
          permissionAudits.set(call.id, result.audit);
          permission = permissionDispositionFor(toolCat, true, result.decision);
          if (result.decision === 'aborted' || roundSignal.aborted || !generationIsActive(owner)) {
            recordBlockedPermission(call.name, 'aborted');
            return {
              tool_call_id: call.id,
              output: JSON.stringify(abortedEnvelope(0)),
              is_error: true,
              duration_ms: 0,
            };
          }
          // Denied and unavailable flows never execute, so they are recorded
          // here or they are not represented at all.
          if (result.decision === 'unavailable') {
            recordBlockedPermission(call.name, 'unavailable');
            return structuredToolError(call.id, [{
              code: 'permission_ui_unavailable',
              message: 'The permission prompt was unavailable, so this tool call was blocked without executing it.',
              retryable: true,
            }]);
          }
          if (result.decision === 'deny') {
            recordBlockedPermission(call.name, 'denied');
            return structuredToolError(call.id, [{
              code: 'denied_by_user',
              message: 'The user denied permission for this tool call.',
              retryable: false,
            }]);
          }
          const approvedFileRoots: string[] = [];
          if (toolCat === 'file_io') {
            if (!approvedScopesCoverRequired(fileUngrantedDirs, result.grantedDirs)) {
              return structuredToolError(call.id, [{
                code: 'grant_required',
                message: 'All required directory scopes must be approved before this batch can run.',
                retryable: true,
              }]);
            }
            // The modal result is only an approval signal. Derive persisted
            // roots from the exact canonical target scopes that triggered the
            // popup; never trust a returned/enclosing root to broaden access.
            // A scope the call is about to create (writing into a new
            // subdirectory) resolves to its own canonical form, not to an
            // enclosing ancestor — see resolveDirForApprovedScope.
            for (const requiredDir of fileUngrantedDirs) {
              const canonical = await resolveDirForApprovedScope(requiredDir);
              if (canonical && !approvedFileRoots.includes(canonical)) approvedFileRoots.push(canonical);
            }
            if (approvedFileRoots.length === 0) {
              return structuredToolError(call.id, [{
                code: 'path_outside_roots',
                message: 'The approved directory scope could not be resolved.',
                retryable: true,
              }]);
            }
          }
          if (roundSignal.aborted || !generationIsActive(owner)) {
            return {
              tool_call_id: call.id,
              output: JSON.stringify(abortedEnvelope(0)),
              is_error: true,
              duration_ms: 0,
            };
          }
          if (result.decision === 'allow_session') {
          const existing = toolsSnapshot ?? {
              enabled: true, tool_grants: [] as string[],
              web_access_grants_initialized: false,
              skills_initialized: false,
              file_io_enabled: false, shell_enabled: false, web_access_enabled: false, tool_history_enabled: false,
              allowed_roots: [] as string[], dir_permissions: {} as Record<string, string[]>,
              max_tool_rounds_per_turn: 128,
              max_tool_calls_per_batch: DEFAULT_TOOL_BATCH_LIMIT,
              sse_read_timeout_min: streamOpts.snapshot?.profile.sseReadTimeoutMin
                ?? useProfileStore.getState().profiles.find((p) => p.id === c.serverId)?.sse_read_timeout_min ?? 5,
            };
            // Phase 1.3: write to tool_grants (Web Access) or dir_permissions (File I/O).
            // NEVER write shell to any grant field.
            if (toolCat === 'web_access') {
              const store = useConversations.getState();
              const current = store.byId[convId];
              if (!current) {
                return structuredToolError(call.id, [{
                  code: 'conversation_not_found',
                  message: 'The conversation no longer exists.',
                  retryable: false,
                }]);
              }
              const latest = current.tools ?? existing;
              const updated = grantTool(latest, call.name);
              store.patchConversation(convId, { tools: updated });
              streamOpts._authorizationOverlay = { tools: updated };
            } else if (toolCat === 'file_io') {
              const store = useConversations.getState();
              const current = store.byId[convId];
              if (!current) {
                return structuredToolError(call.id, [{
                  code: 'conversation_not_found',
                  message: 'The conversation no longer exists.',
                  retryable: false,
                }]);
              }
              const latest = current.tools ?? existing;
              const updated = grantToolOnRoots(latest, call.name, approvedFileRoots);
              store.patchConversation(convId, { tools: updated });
              streamOpts._authorizationOverlay = { tools: updated };
              // Execute this call with the newly granted roots.
              ctx = { ...ctx, config: { ...ctx.config, allowedRoots: updated.allowed_roots ?? [] } };
            }
            // Shell (toolCat === 'shell'): grant NOT persisted. allow_session
            // acts like allow_once — authorizes only this call.
            // Phase 1.5: clone the per-call context instead of mutating it.
            if (toolCat !== 'file_io') {
              ctx = { ...ctx, config: { ...ctx.config } };
            }
          }
          if (result.decision === 'allow_once' && toolCat === 'file_io') {
            const tempRoots = [...baseCtx.config.allowedRoots];
            for (const canonical of approvedFileRoots) {
              if (!tempRoots.includes(canonical)) tempRoots.push(canonical);
            }
            ctx = { ...ctx, config: { ...ctx.config, allowedRoots: tempRoots } };
          }
        }

        if (roundSignal.aborted || !generationIsActive(owner)) {
          return {
            tool_call_id: call.id,
            output: JSON.stringify(abortedEnvelope(0)),
            is_error: true,
            duration_ms: 0,
          };
        }
        const r = await executeWithLock(call, parsed!, handler, ctx, permission);

        if (roundSignal.aborted || !generationIsActive(owner)) {
          return {
            tool_call_id: call.id,
            output: JSON.stringify(abortedEnvelope(r.duration_ms)),
            is_error: true,
            duration_ms: r.duration_ms,
          };
        }

        const repeatNotice = repeatNotices.get(call.id);
        if (repeatNotice) r.output = prependLcResultNotice(r.output, repeatNotice);

        // This read ran concurrently with a write to the same file, so it may
        // predate the change. Say so rather than let it be trusted as current.
        if (contendedPaths.size > 0 && CONTENDABLE_READ_NAMES.has(call.name)) {
          const raced = fileTargetsOf(call.name, parsed)
            .filter((path) => contendedPaths.has(normalizePathForMatch(path)));
          if (raced.length > 0) {
            r.output = prependLcResultNotice(r.output, contendedReadNotice(raced));
          }
        }

        return { tool_call_id: call.id, ...r };
      };

      const applyDuplicateIdNotice = <Result extends { tool_call_id: string; output: string }>(
        result: Result,
      ): Result => {
        const notice = duplicateNotices.get(result.tool_call_id);
        if (notice) result.output = prependLcResultNotice(result.output, notice);
        return result;
      };
      // Apply admission framing outside every execution branch. Validation,
      // policy, governor, permission, and patch failures must retain the same
      // duplicate-id notice as a successful call.
      const runAcceptedCall = async (vc: ValidatedCall, index: number) =>
        applyDuplicateIdNotice(await runAcceptedCallCore(vc, index));

      const poolRun = suppressInteractiveBatch
        ? (() => {
            const suppressedResults = validated.map((vc) => {
              const governedWhiteboard = whiteboardAdmissions.get(vc.call);
              if (governedWhiteboard) {
                return applyDuplicateIdNotice({
                  tool_call_id: vc.call.id,
                  output: JSON.stringify(governedWhiteboard),
                  is_error: true as const,
                  duration_ms: 0,
                });
              }
              if (vc.error) return applyDuplicateIdNotice(structuredToolError(vc.call.id, vc.error));
              if (!enabled.has(vc.call.name)) {
                return applyDuplicateIdNotice(structuredToolError(vc.call.id, [{
                  code: 'not_exposed',
                  message: `Tool "${vc.call.name}" is not exposed in this conversation. Enable its category in the Workspace panel.`,
                  retryable: false,
                }]));
              }
              return applyDuplicateIdNotice(structuredToolError(
                vc.call.id,
                [{ ...ASK_USER_BATCH_ISSUE }],
              ));
            });
            for (const result of suppressedResults) onToolComplete(result);
            return Promise.resolve(suppressedResults);
          })()
        : runWithPool(validated, concurrency, runAcceptedCall, onToolComplete);

      let poolOutcome:
        | { outcome: 'settled'; settledResults: Awaited<typeof poolRun> }
        | { outcome: 'aborted' }
        | { outcome: 'timeout' };
      try {
        poolOutcome = await Promise.race([
          poolRun.then((settledResults) => ({ outcome: 'settled' as const, settledResults })),
          abortSettler.then(() => ({ outcome: 'aborted' as const })),
          roundLifecycle.timeout.then(() => ({ outcome: 'timeout' as const })),
        ]);
      } catch (poolError) {
        roundLifecycle.dispose();
        disposeActiveRound = undefined;
        // A worker or eager-persistence callback can fail outside the handler's
        // structured error boundary. Repair every missing accepted id before
        // propagating the failure so the next provider request is still valid.
        try {
          const whiteboardSettled = await settleWhiteboardBeforeRepair(
            signal.aborted ? 'aborted' : 'generation_ended',
          );
          repairUnansweredToolCalls(
            convId,
            roundCallIds,
            owner.assistantMessageId,
            signal.aborted ? 'aborted' : 'generation_ended',
            whiteboardSettled
              ? undefined
              : { skipToolNames: new Set(['lc_whiteboard']) },
          );
        } catch (repairError) {
          debugLog.warn('[LC] runToolLoop: aggregate-failure repair of unanswered tool calls failed:', repairError);
        }
        throw poolError;
      }
      if (poolOutcome.outcome === 'timeout' || roundLifecycle.timedOut()) {
        try {
          const whiteboardSettled = await settleWhiteboardBeforeRepair('timeout');
          repairUnansweredToolCalls(
            convId,
            roundCallIds,
            owner.assistantMessageId,
            'timeout',
            whiteboardSettled
              ? undefined
              : { skipToolNames: new Set(['lc_whiteboard']) },
          );
        } catch (repairError) {
          debugLog.warn('[LC] runToolLoop: timeout repair of unanswered tool calls failed:', repairError);
        } finally {
          roundLifecycle.dispose();
          disposeActiveRound = undefined;
        }
        return { toolRounds, stopReason: 'tool_timeout' };
      }
      if (poolOutcome.outcome === 'aborted' || signal.aborted || !generationIsActive(owner)) {
        // The abort path: a hung worker's promise is deliberately abandoned.
        // Results that were already persisted stay; every accepted call id
        // still missing one gets a terminal, non-replayed result here, at the
        // race winner, so the durable graph has no unanswered tool_call_id.
        try {
          const whiteboardSettled = await settleWhiteboardBeforeRepair('aborted');
          repairUnansweredToolCalls(
            convId,
            roundCallIds,
            owner.assistantMessageId,
            'aborted',
            whiteboardSettled
              ? undefined
              : { skipToolNames: new Set(['lc_whiteboard']) },
          );
        } catch (repairError) {
          debugLog.warn('[LC] runToolLoop: repair of unanswered tool calls failed:', repairError);
        } finally {
          roundLifecycle.dispose();
          disposeActiveRound = undefined;
        }
        return { toolRounds, stopReason: 'aborted' };
      }
      const results = poolOutcome.settledResults;
      roundLifecycle.dispose();
      disposeActiveRound = undefined;
      // Every accepted id in this round now has a persisted result. The next
      // round must not re-execute any of them.
      for (const id of roundCallIds) answeredCallIds.add(id);

      // 5. Re-stream (results are already persisted via onToolComplete).
      //
      // Warn the model before the hard round limit so it has time
      // to wrap up gracefully instead of being silently cut off.
      const remainingToolRounds = maxToolRounds - toolRounds;
      if (remainingToolRounds <= 1) {
        const msgs = useConversations.getState().byId[convId]?.messages;
        const lastTool = msgs && [...msgs].reverse().find(m => m.role === 'tool');
        if (lastTool) {
          const warning = remainingToolRounds <= 0
            ? LC_RESULT_NOTICES.toolRoundLimitReached
            : LC_RESULT_NOTICES.oneToolRoundRemains;
          useConversations.getState().patchMessage(convId, lastTool.id, {
            content: prependLcResultNotice(lastTool.content, warning),
          });
        }
      }

      debugLog.warn('[LC DEBUG] runToolLoop: about to re-stream with', results.length, 'tool results, convId:', convId);
      phases.toolUse.finished();
      let nextCalls: ToolCallWire[] | void;
      let nextProviderFinishReason: string | undefined;
      try {
        nextCalls = await runStream({
        convId,
        llmClient: new LLMClient({
          baseUrl: streamOpts.profile.baseUrl,
          apiKey: streamOpts.profile.apiKey,
          apiVariant: streamOpts.apiVariant,
          apiStyle: streamOpts.apiStyle,
          routing: streamOpts.routing,
          providerContract: streamOpts.snapshot?.providerContract,
          providerContractStatus: streamOpts.snapshot?.providerContractStatus,
          ...profileRequestHeaderSettings(streamOpts.profile),
        }),
        model: modelRef.current,
        profile: streamOpts.profile,
        apiVariant: streamOpts.apiVariant,
        apiStyle: streamOpts.apiStyle,
        routing: streamOpts.routing,
        sseReadTimeoutMin: streamOpts.sseReadTimeoutMin,
        signal,
        generationId: owner.generationId,
        assistantMessageId: owner.assistantMessageId,
        returnToolCalls: true,
        _isToolLoopReStream: true,
        _injectedImages: _injectedImageRef.current,
        _visionResolved: streamOpts._visionResolved,
        _turnUsageAccumulator: turnUsageAccumulator,
        callbacks: {
          onDelta: (() => {
            let first = true;
            return (text: string) => {
              // Insert a newline separator between sub-turn content
              // fragments. The model produces a complete fragment per
              // tool-call sub-turn, and fragments rarely end with \n,
              // so without this they smash together like:
              //   "### 1. Foo### 2. BarNow let's..."
              if (first && text) {
                first = false;
                const lastAsst = ownedAssistant(owner);
                if (lastAsst?.content && !lastAsst.content.endsWith('\n')) {
                  useConversations.getState().appendToMessage(convId, owner.assistantMessageId, '\n');
                }
              }
              useConversations.getState().appendToMessage(convId, owner.assistantMessageId, text);
            };
          })(),
          onReasoning: (() => {
            let first = true;
            return (text: string) => {
              // Insert a double-newline separator before the first
              // reasoning delta of each tool-loop re-stream so the
              // reasoning-chunking logic in ReasoningBody can split
              // at natural "thought phase" boundaries.  This mirrors
              // the content separator in onDelta above.
              if (first && text) {
                first = false;
                const lastAsst = ownedAssistant(owner);
                const existing = lastAsst?.reasoning ?? '';
                if (existing && !existing.endsWith('\n\n')) {
                  useConversations.getState().appendReasoningToMessage(convId, owner.assistantMessageId, '\n\n');
                }
              }
              useConversations.getState().appendReasoningToMessage(convId, owner.assistantMessageId, text);
            };
            })(),
          onRefusal: (text) => {
            useConversations.getState().appendRefusalToMessage(convId, owner.assistantMessageId, text);
          },
          onDone: (streamResult) => {
            nextProviderFinishReason = streamResult.providerFinishReason;
          },
          onError: (_msg, _aborted) => {
            // Stream error; outer try/catch in runStream handles finalize.
          },
          onTps: streamOpts.onTps,
        },
        tokenCounter: new TokenCounter(),
      });
      } catch (err) {
        debugLog.warn('[LC DEBUG] runToolLoop: re-stream FAILED:', err);
        throw err;
      }

      if (signal.aborted || !generationIsActive(owner)) {
        return { toolRounds, stopReason: 'aborted' };
      }
      if (!nextCalls || nextCalls.length === 0) return { toolRounds, stopReason: 'no_tool_calls' };

      const lastAsst = ownedAssistant(owner);
      const normalizedNextCalls = nextCalls
        .map(wireToRecord)
        .map((call) => normalizeWindowsShellCall(call, windowsPlatform));
      useConversations.getState().finalizeMessage(convId, owner.assistantMessageId, {
        tool_calls: normalizedNextCalls,
        meta: {
          model: modelRef.current || undefined,
          presetName: lastAsst?.meta?.presetName,
          finish_reason: 'tool_calls',
          provider_finish_reason: nextProviderFinishReason,
        },
      });
      calls = normalizedNextCalls;
      if (calls.length > 0) {
        // Reset TPS meter — tool execution pauses text generation
        streamOpts.onTps?.(0);
        phases.toolUse.started();
        phases.toolUse.running();
        await new Promise(r => setTimeout(r, 0));
      }
    }
    return { toolRounds, stopReason: 'no_tool_calls' };
  } finally {
    disposeActiveRound?.();
    if (!signal.aborted) phases.toolUse.finished();
  }
}

// ── runStreamWithTools ─────────────────────────────────────────────

/**
 * Shared streaming + tool-loop wrapper. Streams, attaches tool_calls,
 * loops, and bails out when done.
 */
async function runStreamWithTools(
  convId: string,
  signal: AbortSignal,
  streamOpts: Omit<PipelineOptions, 'signal'>,
  _autoContinue = 0,
): Promise<void> {
  const owner: GenerationAddress = streamOpts;
  const phases = createGenerationPhaseTracker(owner.convId, owner.generationId);
  const profileRef = { current: streamOpts.profile };
  const modelRef = { current: streamOpts.model };
  const llmCallRef: { current: ToolHandlerContext['llmCall'] } = { current: undefined };
  const injectedImageRef = { current: new Set<string>() };
  let whiteboardLifecycle: WhiteboardGenerationLifecycle | undefined;
  const turnUsageAccumulator = new TurnUsageAccumulator();
  const streamStart = performance.now();
  // Shared with every runStream below (including the tool-loop re-streams),
  // so the resolved vision capability travels by reference instead of being
  // guessed again from the model ID.
  streamOpts._visionResolved ??= { current: undefined };

  try {
    if (!streamOpts.snapshot) {
      const admitted = useConversations.getState().byId[convId];
      const admittedProfile = admitted
        ? useProfileStore.getState().profiles.find((profile) => profile.id === admitted.serverId)
        : undefined;
      if (admitted && admittedProfile) {
        const execution = await captureGenerationExecutionState(admitted, admittedProfile);
        streamOpts.snapshot = execution.snapshot;
        streamOpts.runtimeSecrets = execution.secrets;
      }
    }
    phases.reset();
    const admittedConversation = snapshottedConversation(streamOpts);
    const admittedWorkspace = streamOpts.snapshot?.workspace
      ?? resolveWorkspaceProviderPresentation(admittedConversation?.tools, streamOpts.apiVariant);
    const admittedTools = new Set(
      streamOpts.snapshot?.exposedToolNames
      ?? resolveExposure(admittedConversation?.tools ?? {}).exposedNames,
    );
    const whiteboardExposed = admittedWorkspace.toolCallingSupported
      && admittedTools.has('lc_whiteboard');
    if (whiteboardExposed) {
      whiteboardLifecycle = await admitWhiteboardGeneration({
        conversationId: convId,
        generationId: owner.generationId,
        assistantMessageId: owner.assistantMessageId,
      });
      registerGenerationTerminalPrerequisite(
        convId,
        owner.generationId,
        () => whiteboardLifecycle!.settle(whiteboardTerminalReason(owner, signal)),
      );
    } else {
      await persistNonWhiteboardStreamingAssistant({
        conversationId: convId,
        generationId: owner.generationId,
        assistantMessageId: owner.assistantMessageId,
      });
    }
    if (signal.aborted || !generationIsActive(owner)) {
      await whiteboardLifecycle?.settle('aborted');
      return;
    }

    // Wire up sub-agent LLM call function.
  llmCallRef.current = async (params) => {
    await new Promise((r) => setTimeout(r, 0));
    let subUrl = streamOpts.profile.baseUrl;
    let subProfileId = streamOpts.snapshot?.profile.id
      ?? admittedConversation?.serverId
      ?? streamOpts.profile.baseUrl;
    let subKey = streamOpts.profile.apiKey;
    let subVariant: string | undefined = streamOpts.apiVariant;
    let subStyle: 'chat' | 'responses' | undefined = streamOpts.apiStyle;
    let subRouting: string | undefined = streamOpts.routing;
    let subRequestHeaderSettings = profileRequestHeaderSettings(streamOpts.profile);
    let subModel = streamOpts.model;
    let subDetail = streamOpts.snapshot?.modelDetail ?? undefined;
    const requestedModel = params.model;
    const isHelperModelRef = requestedModel?.includes('::') === true;
    const frozenHelperRoute = isHelperModelRef && requestedModel
      ? streamOpts.snapshot?.toolRuntime.helperRoutes[requestedModel]
      : undefined;
    if (requestedModel) {
      // Only resolve when the model ref is a packed profileId::modelId
      // (user explicitly picked a sub-agent model from a specific profile).
      // Bare model IDs come from the "Same as chat model" fallback and
      // should use the chat profile's config — resolving could pick the
      // wrong profile when the same model exists in multiple profiles
      // with different API styles (e.g. one OpenAI/R and one OpenAI/CC).
      if (isHelperModelRef) {
        const r = frozenHelperRoute
          ? {
              ...frozenHelperRoute,
              apiKey: streamOpts.runtimeSecrets?.helperApiKeys[requestedModel] ?? '',
            }
          : streamOpts.snapshot
            ? null
            : await resolveModelServerAuth(requestedModel);
        if (r) {
          subProfileId = r.profileId;
          subUrl = r.baseUrl;
          subKey = r.apiKey;
          subVariant = r.apiVariant;
          subStyle = r.apiStyle;
          subRouting = r.routing;
          subRequestHeaderSettings = profileRequestHeaderSettings(r);
          subModel = r.modelId;
          subDetail = frozenHelperRoute?.modelDetail ?? undefined;
        }
      } else {
        // Same as chat model — keep the chat profile's apiStyle.
        subModel = requestedModel;
        subDetail = streamOpts.snapshot?.modelDetail ?? undefined;
      }
    }
    const subClient = new LLMClient({
      baseUrl: subUrl,
      apiKey: subKey,
      apiVariant: subVariant,
      apiStyle: subStyle,
      routing: subRouting,
      providerContract: isHelperModelRef
        ? frozenHelperRoute?.providerContract
        : streamOpts.snapshot?.providerContract,
      providerContractStatus: isHelperModelRef
        ? frozenHelperRoute?.providerContractStatus
        : streamOpts.snapshot?.providerContractStatus,
      ...subRequestHeaderSettings,
    });
    // Anthropic is the only adapter that reads the model's own ceiling, so
    // only Anthropic pays to look it up: a cache miss costs a live model-list
    // round trip, and spending that on providers that would discard the answer
    // taxes every sub-agent call for nothing. Lookup failure is already
    // best-effort — an undefined ceiling leaves each adapter on its default.
    if (!streamOpts.snapshot && subVariant === 'anthropic') {
      subDetail = (await getCachedModelDetail({
        profileId: subProfileId,
        baseUrl: subUrl,
        apiKey: subKey,
        apiVariant: subVariant,
        apiStyle: subStyle,
        routing: subRouting,
        ...subRequestHeaderSettings,
      }, subModel, params.signal)) ?? undefined;
    }
    return runSubAgentChatOnce(subClient, subModel, params, subDetail?.max_output_tokens);
  };

  const tokenCounter = new TokenCounter();

  let initialProviderFinishReason: string | undefined;
  const toolCalls = await runStream({
    ...streamOpts,
    signal,
    returnToolCalls: true,
    _autoContinue,
    _injectedImages: injectedImageRef.current,
    callbacks: {
      onDelta: (text) => {
        useConversations.getState().appendToMessage(convId, owner.assistantMessageId, text);
      },
      onReasoning: (text) => {
        useConversations.getState().appendReasoningToMessage(convId, owner.assistantMessageId, text);
      },
      onRefusal: (text) => {
        useConversations.getState().appendRefusalToMessage(convId, owner.assistantMessageId, text);
      },
      onDone: (result) => {
        initialProviderFinishReason = result.providerFinishReason;
        // Handled inline in runStream's finalize.
      },
      onError: (_msg, _aborted) => {
        // Handled inline in runStream's catch.
      },
      onTps: streamOpts.onTps,
    },
    tokenCounter,
    _turnUsageAccumulator: turnUsageAccumulator,
  });

  if (toolCalls && toolCalls.length > 0 && generationIsActive(owner)) {
    // Reset TPS meter — tool execution pauses text generation
    streamOpts.onTps?.(0);
    const c = snapshottedConversation(streamOpts);
    const records = toolCalls
      .map(wireToRecord)
      .map((call) => normalizeWindowsShellCall(call));
    const lastAsstMeta = ownedAssistant(owner)?.meta;
    useConversations.getState().finalizeMessage(convId, owner.assistantMessageId, {
      tool_calls: records,
      meta: {
        model: c?.model || undefined,
        presetName: lastAsstMeta?.presetName,
        finish_reason: 'tool_calls',
        provider_finish_reason: initialProviderFinishReason,
      },
    });
    // Adopt the exact-identity resolution runStream already made (server
    // detail + registry detected metadata + the user's explicit override)
    // so runToolLoop can forward it to buildToolCtx → read_image handler.
    // runStream sets opts.modelIsVision on a spread copy; the shared box is
    // how that value reaches streamOpts without re-deriving it here.
    streamOpts.modelIsVision = streamOpts._visionResolved?.current
      ?? streamOpts.modelIsVision
      ?? false;
    const loopResult = await runToolLoop(
      convId,
      records,
      signal,
      profileRef,
      modelRef,
      llmCallRef,
      streamOpts,
      injectedImageRef,
      whiteboardLifecycle,
      turnUsageAccumulator,
    );
    if (loopResult.stopReason !== 'no_tool_calls') {
      const c2 = snapshottedConversation(streamOpts);
      const lastAsstMeta2 = ownedAssistant(owner)?.meta;
      const toolFinishReason = loopResult.stopReason === 'aborted' ? 'disconnected'
        : loopResult.stopReason === 'max_tool_rounds' ? 'tool_round_limit'
        : loopResult.stopReason === 'tool_timeout' ? 'tool_timeout'
        : 'stop';
      finalizeGeneration(owner, {
        meta: {
          model: c2?.model || undefined,
          presetName: lastAsstMeta2?.presetName,
          finish_reason: toolFinishReason,
          error_message: toolFinishReason === 'tool_round_limit'
            ? `Maximum tool-call rounds per turn (${loopResult.toolRounds}) reached.`
            : toolFinishReason === 'tool_timeout'
              ? 'The tool round exceeded its deadline. Unfinished calls were cancelled and recorded as timed out.'
            : undefined,
        },
      });
    }
  }

  // ── Final turn scope ──────────────────────────────────────────────
  // The per-response counters and whole-turn wall time become terminal
  // together. Failures, cancellation, and limits keep completed rounds but
  // explicitly mark the aggregate partial.
  {
    const lastAsst = ownedAssistant(owner);
    if (generationStillExists(owner) && lastAsst) {
      const totalDuration = performance.now() - streamStart;
      const finish = lastAsst.meta?.finish_reason;
      const partial = signal.aborted
        || !!lastAsst.meta?.error_message
        || finish === 'error'
        || finish === 'disconnected'
        || finish === 'tool_round_limit'
        || finish === 'tool_timeout'
        || finish === INFINITE_REASONING_LOOP;
      const finalUsage = turnUsageAccumulator.snapshot(partial ? 'partial' : 'complete');
      useConversations.getState().patchMessage(convId, owner.assistantMessageId, {
        ...(finalUsage ? { usage: finalUsage } : {}),
        meta: {
          ...lastAsst.meta,
          ...(finalUsage ? { totalTokens: finalUsage.completion_tokens } : {}),
          durationMs: totalDuration,
        },
      });
    }
  }
  } catch (error) {
    if (!signal.aborted) {
      const partialUsage = turnUsageAccumulator.snapshot('partial');
      finalizeGeneration(owner, {
        ...(partialUsage ? { usage: partialUsage } : {}),
        meta: {
          model: modelRef.current || undefined,
          ...(partialUsage ? { totalTokens: partialUsage.completion_tokens } : {}),
          durationMs: performance.now() - streamStart,
          finish_reason: 'error',
          error_message: errorMessage(error),
        },
      });
    }
    throw error;
  } finally {
    if (whiteboardLifecycle) {
      const settled = await whiteboardLifecycle.settle(
        whiteboardTerminalReason(owner, signal),
      );
      if (!settled) {
        debugLog.warn('[LC] Whiteboard terminal settlement remains pending for crash recovery.');
      }
    }
    // Images were only needed while this tool-loop session was alive.
    for (const id of injectedImageRef.current) deleteImageBatch(id);
    // The side-channel IDs point only at those in-memory batches. Once the
    // session is over they cannot be used again, so do not retain tool-call
    // IDs until the user happens to switch conversations.
    disposeGenerationImageBatchMappings(owner);
    disposeGenerationImageBatches(owner.convId, owner.generationId);
    phases.clear();
  }
}

// ── Public API ─────────────────────────────────────────────────────

export { runStreamWithTools, runStream, runToolLoop, buildToolCtx };
