import type { Message } from '../../types';
import {
  admitWhiteboardModelTurn,
  applyWhiteboardModelMutation,
  readWhiteboardModelTurn,
  settleWhiteboardModelTurnAndRepair,
} from '../../store/whiteboard-conversation.ts';
import {
  initializeWhiteboard,
  WhiteboardGenerationClosedError,
  WhiteboardNotInitializedError,
  WhiteboardVersionMissingError,
} from '../../store/whiteboard.ts';
import {
  isStreamingOwner,
  runConversationWrite,
  useConversations,
} from '../../store/conversations.ts';
import type {
  WhiteboardToolMutationState,
  WhiteboardToolServiceErrorCode,
  WhiteboardToolServiceResult,
  WhiteboardToolSnapshot,
} from '../tool-engine/types';
import {
  createWhiteboardGenerationLifecycle,
  type WhiteboardGenerationLifecycle,
} from './whiteboard-lifecycle.ts';

export interface WhiteboardGenerationAddress {
  conversationId: string;
  generationId: string;
  assistantMessageId: string;
}

function sourceUserForAssistant(
  messages: readonly Message[],
  assistantMessageId: string,
): { source: Message; assistant: Message } | null {
  const assistantIndex = messages.findIndex(
    (message) => message.id === assistantMessageId && message.role === 'assistant',
  );
  if (assistantIndex < 0) return null;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return { source: messages[index], assistant: messages[assistantIndex] };
    }
  }
  return null;
}

function serviceFailure(
  error: unknown,
  fallback: Extract<
    WhiteboardToolServiceErrorCode,
    'whiteboard_read_failed' | 'whiteboard_write_failed'
  >,
): { ok: false; code: WhiteboardToolServiceErrorCode } {
  if (error instanceof WhiteboardGenerationClosedError) {
    return { ok: false, code: 'aborted' };
  }
  if (error instanceof WhiteboardNotInitializedError) {
    return { ok: false, code: 'whiteboard_not_initialized' };
  }
  if (error instanceof WhiteboardVersionMissingError) {
    return { ok: false, code: 'whiteboard_version_missing' };
  }
  return { ok: false, code: fallback };
}

function publishAdmission(
  address: WhiteboardGenerationAddress,
  source: Message,
  assistant: Message,
): void {
  useConversations.setState((state) => {
    const conversation = state.byId[address.conversationId];
    if (!conversation) return state;
    let changed = false;
    const messages = conversation.messages.map((message) => {
      if (message.id === source.id) {
        changed = true;
        return { ...message, user_board: source.user_board };
      }
      if (message.id === assistant.id) {
        changed = true;
        return { ...message, whiteboard_refs: assistant.whiteboard_refs };
      }
      return message;
    });
    if (!changed) return state;
    return {
      byId: {
        ...state.byId,
        [address.conversationId]: { ...conversation, messages },
      },
    };
  });
}

export interface WhiteboardGenerationRuntimeDependencies {
  admitModelTurn: typeof admitWhiteboardModelTurn;
  initialize: typeof initializeWhiteboard;
}

const DEFAULT_RUNTIME_DEPENDENCIES: WhiteboardGenerationRuntimeDependencies = {
  admitModelTurn: admitWhiteboardModelTurn,
  initialize: initializeWhiteboard,
};

function publishRefs(address: WhiteboardGenerationAddress, refs: Message['whiteboard_refs']): void {
  useConversations.setState((state) => {
    const conversation = state.byId[address.conversationId];
    if (!conversation) return state;
    const messageIndex = conversation.messages.findIndex(
      (message) => message.id === address.assistantMessageId && message.role === 'assistant',
    );
    if (messageIndex < 0) return state;
    const messages = [...conversation.messages];
    messages[messageIndex] = { ...messages[messageIndex], whiteboard_refs: refs };
    return {
      byId: {
        ...state.byId,
        [address.conversationId]: { ...conversation, messages },
      },
    };
  });
}

function publishTerminalMessages(
  address: WhiteboardGenerationAddress,
  messages: Message[],
): void {
  useConversations.setState((state) => {
    const conversation = state.byId[address.conversationId];
    if (!conversation) return state;
    return {
      byId: {
        ...state.byId,
        [address.conversationId]: {
          ...conversation,
          messages,
          messageCount: messages.length,
          updatedAt: Date.now(),
        },
      },
      loadedVersion: state.loadedVersion + 1,
    };
  });
}

/**
 * Admit one exposed Whiteboard turn and bind its pure tool capability to the
 * generation-owned storage row. The caller must invoke `settle` in every
 * terminal path; the returned lifecycle makes that operation idempotent.
 */
export async function admitWhiteboardGeneration(
  address: WhiteboardGenerationAddress,
  dependencies: WhiteboardGenerationRuntimeDependencies = DEFAULT_RUNTIME_DEPENDENCIES,
): Promise<WhiteboardGenerationLifecycle> {
  const conversation = useConversations.getState().byId[address.conversationId];
  const owner = conversation
    ? sourceUserForAssistant(conversation.messages, address.assistantMessageId)
    : null;
  if (!owner) {
    throw new WhiteboardVersionMissingError(
      'The Whiteboard generation source or assistant message is unavailable.',
    );
  }

  const admissionInput = {
    conversationId: address.conversationId,
    generationId: address.generationId,
    sourceUserMessage: owner.source,
    assistantMessage: owner.assistant,
    metadata: conversation,
  };
  const admission = await runConversationWrite(
    address.conversationId,
    'admit Whiteboard model turn',
    async () => {
      try {
        return await dependencies.admitModelTurn(admissionInput);
      } catch (error) {
        if (!(error instanceof WhiteboardNotInitializedError)) throw error;
        // Admission needs both owner heads before the model can receive a tool.
        // Repair once, then let a repeated failure surface instead of looping.
        // Keep the repair and retry inside this one lane task so no checkpoint
        // or metadata mutation can interleave between them.
        await dependencies.initialize(address.conversationId);
        return dependencies.admitModelTurn(admissionInput);
      }
    },
  );
  publishAdmission(address, admission.sourceUserMessage, admission.assistantMessage);

  return createWhiteboardGenerationLifecycle({
    isActive: () => isStreamingOwner(address.conversationId, address.generationId),
    read: async ({ signal }): Promise<WhiteboardToolServiceResult<WhiteboardToolSnapshot>> => {
      if (signal.aborted) return { ok: false, code: 'aborted' };
      try {
        const state = await readWhiteboardModelTurn({
          conversationId: address.conversationId,
          generationId: address.generationId,
          assistantMessageId: address.assistantMessageId,
        });
        return { ok: true, value: state };
      } catch (error) {
        return serviceFailure(error, 'whiteboard_read_failed');
      }
    },
    replaceModel: async ({ content, toolCallId, signal }): Promise<
      WhiteboardToolServiceResult<WhiteboardToolMutationState>
    > => {
      if (signal.aborted) return { ok: false, code: 'aborted' };
      try {
        const result = await runConversationWrite(
          address.conversationId,
          'apply Whiteboard model mutation',
          () => applyWhiteboardModelMutation({
            conversationId: address.conversationId,
            generationId: address.generationId,
            assistantMessageId: address.assistantMessageId,
            toolCallId,
            content,
          }),
        );
        // Publish immediately even when ownership disappears just after the
        // transaction. The lifecycle queue suppresses that worker's ordinary
        // result, while terminal receipt repair uses these authoritative refs.
        publishRefs(address, result.refs);
        return {
          ok: true,
          value: {
            refs: result.refs,
            changed: result.mutation.changed,
            modelMarkdown: result.mutation.working.content,
          },
        };
      } catch (error) {
        return serviceFailure(error, 'whiteboard_write_failed');
      }
    },
    settle: async (reason) => {
      const current = useConversations.getState().byId[address.conversationId];
      if (!current) {
        throw new Error('The Whiteboard conversation disappeared before settlement.');
      }
      const terminal = await runConversationWrite(
        address.conversationId,
        'settle Whiteboard model turn',
        () => settleWhiteboardModelTurnAndRepair({
          conversationId: address.conversationId,
          generationId: address.generationId,
          assistantMessageId: address.assistantMessageId,
          messages: current.messages,
          reason,
        }),
      );
      publishTerminalMessages(address, terminal.messages);
    },
  });
}
