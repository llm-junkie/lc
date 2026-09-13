/**
 * Build the generation-shaped request a server token count should measure,
 * using the same adapter builders as generation calls. The low-level builder
 * accepts already projected messages. The conversation builder below applies
 * LC's durable history, provenance, attachment, Tool History, and Workspace
 * prompt rules first. `buildServerTokenCountBody` then keeps only documented
 * tokenization inputs (`stream`/`store` never cross).
 *
 * The contract is resolved here from the same inputs, so the counted shape
 * always matches what generation would send for this target. Unresolvable
 * targets yield undefined (no count) rather than a guessed shape.
 *
 * Any build failure returns undefined so the meter keeps its local estimate.
 * A future composer message and in-memory tool-returned image batches do not
 * exist in the settled durable conversation and are not part of this preflight.
 */

import type { Conversation } from '../../types';
import { buildMessageContent, hydrateAttachments } from '../../utils/attachments.ts';
import type { AdapterRequestParams } from '../../modules/llm-client/adapters/adapter';
import { AnthropicAdapter } from '../../modules/llm-client/adapters/anthropic.ts';
import { OpenAIResponsesAdapter } from '../../modules/llm-client/adapters/openai-responses.ts';
import { resolveBundledProviderContract } from '../../modules/llm-client/provider-contracts.ts';
import type { ChatMessage, ToolDefinition } from '../../modules/llm-client/types';
import { resolveExposure } from '../../modules/tool-engine/policy.ts';
import { buildSystemPrompt } from '../../modules/chat-pipeline/system-prompt.ts';
import {
  resolveWorkspaceProviderPresentation,
  structuredToolPayload,
} from '../../modules/chat-pipeline/provider-capability.ts';
import { projectAssistantProviderHistory } from '../../modules/chat-pipeline/provider-history-projection.ts';
import {
  buildToolHistoryProjection,
} from '../../modules/chat-pipeline/tool-history-projection.ts';
import {
  archiveToolCallId,
  ARCHIVED_TOOL_ARGUMENTS,
  ARCHIVED_TOOL_NAME,
} from '../../modules/chat-pipeline/message-history.ts';

export type ServerCountProtocol = 'openai-responses' | 'anthropic-messages';

export interface ServerCountRequestInput {
  messages: ChatMessage[];
  model: string;
  baseUrl: string;
  tools?: ToolDefinition[];
  /** Visible system text; prepended as a system message when non-empty. */
  systemText?: string;
  reasoningEnabled: boolean;
  reasoningEffort?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

export function buildServerCountGenerationRequest(
  protocol: ServerCountProtocol,
  input: ServerCountRequestInput,
): Record<string, unknown> | undefined {
  const providerContract = resolveBundledProviderContract({
    baseUrl: input.baseUrl,
    protocol,
    modelId: input.model,
  });
  if (!providerContract) return undefined;
  const messages = input.systemText?.trim()
    ? [{ role: 'system', content: input.systemText } as ChatMessage, ...input.messages]
    : input.messages;
  const params: AdapterRequestParams = {
    model: input.model,
    messages,
    stream: false,
    baseUrl: input.baseUrl,
    tools: input.tools,
    reasoningEnabled: input.reasoningEnabled,
    reasoningEffort: input.reasoningEffort,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    topP: input.topP,
    providerContract,
    providerContractStatus: 'matched',
  };
  try {
    if (protocol === 'openai-responses') {
      const request = new OpenAIResponsesAdapter(input.baseUrl).buildRequest(params);
      return request as unknown as Record<string, unknown>;
    }
    const request = new AnthropicAdapter(
      input.baseUrl,
      providerContract,
      'matched',
    ).buildRequest(params);
    return request as unknown as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export interface ServerCountConversationInput {
  conversation: Conversation;
  baseUrl: string;
  apiVariant?: string;
  signal?: AbortSignal;
}

/**
 * Render the settled conversation through the same history/provenance rules
 * as the next generation. Unlike passing store messages straight to an
 * adapter, this restores provider origins before carrier gating, applies Tool
 * History, hydrates durable attachments, and supplies the complete Workspace
 * system prompt. That keeps the count request from omitting same-provider
 * opaque state or disclosing foreign-provider state.
 *
 * The composer draft is intentionally absent: it is not part of the durable
 * conversation yet. While idle, every completed tool exchange is projected
 * as archived because the next user send moves it behind the active boundary.
 */
export async function buildServerCountGenerationRequestForConversation(
  protocol: ServerCountProtocol,
  input: ServerCountConversationInput,
): Promise<Record<string, unknown> | undefined> {
  const { conversation, signal } = input;
  const model = conversation.model ?? '';
  if (!model || signal?.aborted) return undefined;
  const providerContract = resolveBundledProviderContract({
    baseUrl: input.baseUrl,
    protocol,
    modelId: model,
  });
  if (!providerContract) return undefined;

  const presentation = resolveWorkspaceProviderPresentation(
    conversation.tools,
    input.apiVariant,
  );
  const requestTools = structuredToolPayload(conversation.tools, input.apiVariant);
  const systemText = presentation.workspacePromptEnabled
    ? await buildSystemPrompt(conversation)
    : (conversation.params.system_prompt?.trim() ?? '');
  if (signal?.aborted) return undefined;

  const storedMessages = conversation.messages.filter(
    (message) => message.role !== 'system' && !message.streaming,
  );
  const hydrated = [] as Array<{
    message: Conversation['messages'][number];
    attachments: Awaited<ReturnType<typeof hydrateAttachments>>;
  }>;
  for (const message of storedMessages) {
    hydrated.push({
      message,
      attachments: await hydrateAttachments(message.attachments ?? []),
    });
    if (signal?.aborted) return undefined;
  }

  const historyEnabled = presentation.toolCallingSupported
    && resolveExposure(conversation.tools ?? { enabled: false })
      .exposedNames.has('lc_tool_history');
  const archiveBoundary = historyEnabled ? storedMessages.length : -1;
  const archivedStubs = historyEnabled
    ? buildToolHistoryProjection(storedMessages, archiveBoundary, true).archivedStubs
    : new Map<string, string>();
  const requestMessages: ChatMessage[] = [];
  if (systemText) requestMessages.push({ role: 'system', content: systemText });

  for (let index = 0; index < hydrated.length; index += 1) {
    const { message, attachments } = hydrated[index];
    const projected: ChatMessage = {
      role: message.role,
      content: buildMessageContent(message.content, attachments),
    };
    const archivedToolTurn = historyEnabled
      && index < archiveBoundary
      && message.role === 'assistant'
      && !!message.tool_calls?.length
      && archivedStubs.has(message.id);
    if (message.refusal) projected.refusal = message.refusal;
    const sourceOrigin = message.meta?.baseUrl && message.meta.model
      ? { baseUrl: message.meta.baseUrl, model: message.meta.model }
      : undefined;

    if (message.role === 'assistant') {
      const history = projectAssistantProviderHistory({
        role: 'assistant',
        content: message.content,
        tool_calls: message.tool_calls?.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
        responses_output_items: message.responses_output_items,
        provider_output_origin: sourceOrigin,
        anthropic_output_blocks: message.anthropic_output_blocks,
        anthropic_output_origin: sourceOrigin,
        opaque_replay_accounting: message.opaque_replay_accounting,
        lmstudio_response_id: message.lmstudio_response_id,
      }, {
        protocol,
        baseUrl: input.baseUrl,
        model,
        toolCallRewritten: archivedToolTurn,
        requestHasTools: (requestTools?.length ?? 0) > 0,
        providerContract,
        providerContractStatus: 'matched',
        sourceOrigin,
      });
      if (history.responsesOutputItems?.length) {
        projected.responses_output_items = history.responsesOutputItems;
      }
      if (history.anthropicOutputBlocks?.length) {
        projected.anthropic_output_blocks = history.anthropicOutputBlocks;
        projected.anthropic_output_origin = sourceOrigin;
      }
      if (message.anthropic_block_order?.length) {
        projected.anthropic_block_order = message.anthropic_block_order;
      }
      if (history.accountingGroups?.length) {
        projected.opaque_replay_accounting = history.accountingGroups;
      }
      if (sourceOrigin) projected.provider_output_origin = sourceOrigin;
      if (message.reasoning_details?.length) {
        projected.reasoning_details = message.reasoning_details;
      }
      if (history.useCanonicalReasoning && message.reasoning?.trim()) {
        projected.reasoning_content = message.reasoning;
      }
      if (message.tool_calls?.length) {
        projected.tool_calls = archivedToolTurn
          ? [{
            id: archiveToolCallId(message.id),
            type: 'function',
            function: { name: ARCHIVED_TOOL_NAME, arguments: ARCHIVED_TOOL_ARGUMENTS },
          }]
          : message.tool_calls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
          }));
      }
    }

    if (message.role === 'tool' && message.tool_call_id) {
      if (historyEnabled && index < archiveBoundary) continue;
      projected.tool_call_id = message.tool_call_id;
      if (message.tool_is_error) projected.tool_is_error = true;
    }
    requestMessages.push(projected);
    if (archivedToolTurn) {
      requestMessages.push({
        role: 'tool',
        tool_call_id: archiveToolCallId(message.id),
        content: archivedStubs.get(message.id)!,
      });
    }
  }

  return buildServerCountGenerationRequest(protocol, {
    messages: requestMessages,
    model,
    baseUrl: input.baseUrl,
    tools: requestTools,
    reasoningEnabled: conversation.params.reasoning_enabled === true,
    reasoningEffort: conversation.params.reasoning_effort,
    maxTokens: conversation.params.max_tokens_enabled !== false
      ? conversation.params.max_tokens
      : undefined,
    temperature: conversation.params.temperature_enabled !== false
      ? conversation.params.temperature
      : undefined,
    topP: conversation.params.top_p_enabled !== false
      ? conversation.params.top_p
      : undefined,
  });
}
