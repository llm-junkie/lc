import type { Conversation, Message, ServerProfile } from '../../types';
import {
  getStreamingOwner,
  isConversationMessageHistoryComplete,
  isGenerationBlockingOperationOwner,
  unmarkGenerationBlockingOperation,
  useConversations,
} from '../../store/conversations.ts';
import { useAppModels, useProfileStore } from '../../modules/server-profiles/index.ts';

export interface GenerationPreflightResult {
  conversation: Conversation & { model: string };
  message: Message;
  messageIndex: number;
  profile: ServerProfile;
  resolvedKey: string;
}

interface GenerationPreflightOptions {
  conversationId: string;
  messageId: string;
  expectedProfile: ServerProfile;
  admissionOperationId: string;
  resolveApiKey: () => Promise<string>;
}

type ReleaseGenerationAdmission = (operationId: string) => boolean;

function hasSelectedModel(
  conversation: Conversation | undefined,
): conversation is Conversation & { model: string } {
  return typeof conversation?.model === 'string' && conversation.model.length > 0;
}

function releaseOwnedChatGenerationAdmission(operationId: string): boolean {
  if (!isGenerationBlockingOperationOwner(operationId, 'chat_generation_admission')) {
    return false;
  }
  return unmarkGenerationBlockingOperation(operationId);
}

/**
 * Keep a provisional admission only when its asynchronous preflight succeeds.
 * The single `finally` release site covers both a null result and an exception.
 */
export async function runGenerationPreflightWithAdmission<T>(
  operationId: string,
  preflight: () => Promise<T | null>,
  release: ReleaseGenerationAdmission = releaseOwnedChatGenerationAdmission,
): Promise<T | null> {
  let result: T | null = null;
  try {
    result = await preflight();
    return result;
  } finally {
    if (result === null) release(operationId);
  }
}

/**
 * Resolve an asynchronous generation prerequisite, then re-read every mutable
 * input before Retry/Edit crosses its destructive history boundary. A null or
 * thrown result releases the caller's provisional admission without changing
 * conversation history.
 */
export async function resolveGenerationPreflight({
  conversationId,
  messageId,
  expectedProfile,
  admissionOperationId,
  resolveApiKey,
}: GenerationPreflightOptions): Promise<GenerationPreflightResult | null> {
  return runGenerationPreflightWithAdmission(admissionOperationId, async () => {
    if (!isGenerationBlockingOperationOwner(
      admissionOperationId,
      'chat_generation_admission',
    )) {
      return null;
    }

    const resolvedKey = await resolveApiKey();
    const state = useConversations.getState();
    const conversation = state.byId[conversationId];
    const messageIndex = conversation?.messages.findIndex((message) => message.id === messageId) ?? -1;
    const message = messageIndex >= 0 ? conversation?.messages[messageIndex] : undefined;
    const profile = useProfileStore.getState().profiles.find(
      (candidate) => candidate.id === conversation?.serverId,
    );

    if (!hasSelectedModel(conversation) || !isConversationMessageHistoryComplete(conversation)
      || !message || profile !== expectedProfile || !profile.active
      || useAppModels.getState().models.length === 0
      || getStreamingOwner(conversation.id)
      || !isGenerationBlockingOperationOwner(
        admissionOperationId,
        'chat_generation_admission',
      )) {
      return null;
    }

    return { conversation, message, messageIndex, profile, resolvedKey };
  });
}
