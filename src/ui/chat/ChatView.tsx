import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from 'react';
import {
  isConversationStructurallyLocked,
  ACTIVE_GENERATION_BLOCKING_OPERATION_MESSAGE,
  commitChatGenerationAdmission,
  generationAdmissionBlockReason,
  getStreamingOwner,
  isAnyStreaming,
  isConversationMessageHistoryComplete,
  isGenerationAdmissionBlocked,
  isGenerationBlockingOperationActive,
  residentConversationIds,
  markGenerationBlockingOperation,
  unmarkGenerationBlockingOperation,
  useConversations,
} from '../../store/conversations.ts';
import { useSettings } from '../../store/settings.ts';
import {
  EMPTY_CONVERSATION_UI,
  useConversationUi,
  type ConversationUiState,
} from '../../store/conversation-ui.ts';
import { useProfileStore } from '../../modules/server-profiles/index.ts';
import { useAppModels } from '../../modules/server-profiles/index.ts';
import {
  errorMessage,
  LLMClient,
  profileRequestHeaderSettings,
} from '../../modules/llm-client/index.ts';
import type { Attachment, Conversation, Message } from '../../types';
import {
  mergeFileLineChanges,
  summarizeFileLineChanges,
  type FileLineChange,
  type FileLineChanges,
} from '../../modules/tool-engine/file-line-changes.ts';
import { MessageBubble } from './MessageBubble.tsx';
import { PreviewOverlay, type PreviewTab } from '../tools/PreviewOverlay.tsx';
import { WhiteboardOverlay } from '../tools/WhiteboardOverlay.tsx';
import { requestWhiteboardOverlayExit } from '../tools/whiteboard-overlay-guard.ts';
import { WHITEBOARD_UI_TEXT } from '../tools/whiteboard-ui-text.ts';
import {
  createWhiteboardInitializationCoordinator,
  createWhiteboardToolsConfigChangeCoordinator,
} from '../tools/whiteboard-toggle.ts';
import { WorkspaceManager } from '../tools/WorkspaceManager.tsx';
import type { ToolCallItem } from '../tools/ToolsBody';
import { Composer } from './Composer.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { TokenMeter, type ServerTokenPreflight } from './TokenMeter.tsx';
import { SidePanel } from './SidePanel.tsx';
import { EmptyState } from './EmptyState.tsx';
import { useTranscriptScroll } from './useTranscriptScroll.ts';
import {
  initializeWhiteboard,
} from '../../store/whiteboard.ts';
import { toast } from '../../utils/toast.ts';
import { countToolDefinitionTokens } from '../../utils/tokens.ts';
import { messageHasVisibleReasoning } from '../../utils/reasoning-content.ts';
import { detectPresetName, snapshotGenerationParams } from '../../utils/presets.ts';
import { endpointForProfile } from '../../utils/reply-meta.ts';
import {
  buildTodoSnapshotIndex,
  FILE_IO_READ_ONLY_NAMES,
  resolveExposure,
} from '../../modules/tool-engine/index.ts';
import { cleanPath } from '../../modules/tool-engine/clean-path.ts';
import { resolveChatCredential } from '../../platform/chat-credential.ts';
import {
  resolveWorkspaceProviderPresentation,
  structuredToolPayload,
} from '../../modules/chat-pipeline/provider-capability.ts';
import { providerHistoryProtocol } from '../../modules/chat-pipeline/provider-history-projection.ts';
import { buildServerCountGenerationRequestForConversation } from './server-count-request.ts';
import { resolveGenerationPreflight } from './generation-preflight.ts';
import {
  clearGenerationAttention,
  getGenerationSessionView,
  setGenerationSessionTps,
  subscribeToGenerationSession,
} from '../../modules/chat-pipeline/generation-session-manager.ts';
import {
  previewNavigationIndex,
  previewSelectionForTabClick,
  previewShortcutTab,
  previewTabForPhase,
  previewTodoSnapshotsAtMessage,
} from './preview-shortcuts.ts';
import { captureGenerationExecutionState } from '../../modules/chat-pipeline/generation-snapshot.ts';
import {
  handoffAndRegisterGenerationSession,
  requestGenerationStop,
  settleGenerationSessionAfterTerminalFlush,
} from './generation-lifecycle.ts';

import {
  getPhase,
  onPhaseChange,
} from '../../store/responseStatus.ts';
import {
  buildSystemPrompt,
  countSystemPromptTokens,
  runStreamWithTools,
  DEFAULT_TOOL_BATCH_LIMIT,
} from '../../modules/chat-pipeline/index.ts';

const whiteboardInitializationCoordinator = createWhiteboardInitializationCoordinator({
  initialize: initializeWhiteboard,
  acquire: (conversationId) => markGenerationBlockingOperation(
    'whiteboard_initialization',
    'Initialize Whiteboard storage',
    undefined,
    conversationId,
  ),
  release: unmarkGenerationBlockingOperation,
});

const NON_COMPLETION_SCROLL_REASONS = new Set([
  'tool_calls',
  'tool_use',
  'pause_turn',
  'interrupted',
  'disconnected',
  'error',
  'tool_timeout',
  'infinite_reasoning_loop',
]);

function completedAssistantMessageId(messages: Message[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const finishReason = message.meta?.finish_reason;
    if (
      message.streaming
      || !finishReason
      || message.meta?.error_message
      || NON_COMPLETION_SCROLL_REASONS.has(finishReason)
    ) return undefined;
    return message.id;
  }
  return undefined;
}

function warnIncompleteConversationHistory(): void {
  toast.error('Conversation history is not fully loaded. Reselect this chat to retry before changing it.');
}

function reportGenerationError(conversationId: string, action: string, error: unknown): void {
  const title = useConversations.getState().byId[conversationId]?.title ?? 'Conversation';
  toast.error(`“${title}” — ${action} failed: ${errorMessage(error)}`);
}

function acquireChatGenerationAdmission(
  label: string,
  conversationId: string,
  profileId: string,
) {
  try {
    return markGenerationBlockingOperation(
      'chat_generation_admission',
      label,
      undefined,
      // Naming the target keeps the lease from locking every other
      // conversation's configuration and structure while this one admits.
      conversationId,
      profileId,
    );
  } catch (error) {
    const message = errorMessage(error);
    toast.info(/^(?:All \d+ generation slots are in use\.|This server profile is limited to)/.test(message)
      ? message
      : ACTIVE_GENERATION_BLOCKING_OPERATION_MESSAGE);
    return null;
  }
}

export function ChatView() {
  const conv = useConversations((s) => (s.activeId ? s.byId[s.activeId] : null));
  const loadedVersion = useConversations((s) => s.loadedVersion);
  useEffect(() => {
    if (conv?.id) clearGenerationAttention(conv.id);
  }, [conv?.id]);
  const toolsConfigChangeCoordinatorsRef = useRef(
    new Map<string, ReturnType<typeof createWhiteboardToolsConfigChangeCoordinator>>(),
  );
  // Scoped to the selected conversation: a background load must not blank
  // out the chat the user is reading.
  const loadingMessages = useConversations(
    (s) => (s.activeId ? s.loadingMessageIds.has(s.activeId) : false),
  );
  const persistenceFailure = useConversations((s) => {
    if (s.persistenceFailure && !s.persistenceFailure.conversationId) {
      return s.persistenceFailure;
    }
    return s.activeId ? (s.persistenceFailures[s.activeId] ?? null) : null;
  });
  const clearPersistenceFailure = useConversations((s) => s.clearPersistenceFailure);
  const clearConversationPersistenceFailure = useConversations(
    (s) => s.clearConversationPersistenceFailure,
  );
  const messageHistoryComplete = conv
    ? isConversationMessageHistoryComplete(conv)
    : true;
  const setParams = useConversations((s) => s.setParams);
  const appendMessage = useConversations((s) => s.appendMessage);
  const appendUserMessage = useConversations((s) => s.appendUserMessage);
  const replaceFromMessage = useConversations((s) => s.replaceFromMessage);
  const patchConversation = useConversations((s) => s.patchConversation);
  // Use the conversation's own serverId rather than a global profile.
  // Fall back to first toggled-on profile for the empty-state display.
  const profile = useProfileStore((s) =>
    s.profiles.find((p) => p.id === conv?.serverId)
    ?? s.profiles.find((p) => p.active),
  );
  // Panel presentation is a property of the conversation, not of the app: a
  // chat opened with the Workspace tab showing should still show it when the
  // user comes back, regardless of what they did in another chat meanwhile.
  const sidePanelOpen = useConversationUi(
    (s) => (conv ? (s.byId[conv.id] ?? EMPTY_CONVERSATION_UI).sidePanelOpen : false),
  );
  const sidePanelTab = useConversationUi(
    (s) => (conv ? (s.byId[conv.id] ?? EMPTY_CONVERSATION_UI).sidePanelTab : 'tools'),
  );
  // Same three-way contract the global toggle had, now per conversation:
  //   false        — explicit close (Escape, panel X)
  //   'params'/'tools' — open that tab, or close if it is already showing
  //   undefined/true   — flip the current state
  const toggleSidePanel = useCallback((open?: boolean | 'params' | 'tools') => {
    const id = useConversations.getState().activeId;
    if (!id) return;
    const ui = useConversationUi.getState();
    const current = ui.get(id);
    if (open === false) {
      ui.setSidePanel(id, false);
      return;
    }
    if (open === 'params' || open === 'tools') {
      if (!current.sidePanelOpen) ui.setSidePanel(id, true, open);
      else if (current.sidePanelTab !== open) ui.setSidePanel(id, true, open);
      else ui.setSidePanel(id, false);
      return;
    }
    ui.setSidePanel(id, !current.sidePanelOpen);
  }, []);
  const toolsDefaults = useSettings((s) => s.tools.default_allowed_roots);
  const pinComposer = useSettings((s) => s.pinComposer);
  const tokenMeterStyle = useSettings((s) => s.tokenMeterStyle);
  const autoPreviewReasoning = useSettings((s) => s.autoPreviewReasoning);
  const showOnlyLatestTodoList = useSettings((s) => s.showOnlyLatestTodoList);
  const toggleSidebar = useSettings((s) => s.toggleSidebar);
  const sidebarOpen = useSettings((s) => s.ui.sidebarOpen);
  // Token-meter ceiling, read straight from the model registry.
  //
  // Two things had to change here. The lookup matches BOTH `serverId` and
  // model id, because a duplicate model id on another profile is a different
  // model with its own context window. And it is a live subscription rather
  // than an imperative `getState()` copied into local state on
  // conversation/model change: an override-only edit changes neither of those
  // identities, so the old effect never re-ran and the meter kept the stale
  // ceiling until the chat was switched away and back.
  const modelMaxContext = useAppModels((s) =>
    s.models.find((m) => m.profileId === conv?.serverId && m.id === conv?.model)
      ?.maxContextLength ?? 0,
  );

  // Generation ownership lives in the session manager, not in this component.
  // A response outlives the chat view that started it, so `busy`, the token
  // rate, and the abort handle are read from the selected conversation's
  // session rather than stored here.
  const selectedConversationId = conv?.id;
  const subscribeToSelectedSession = useCallback(
    (listener: () => void) => (
      selectedConversationId
        ? subscribeToGenerationSession(selectedConversationId, listener)
        : () => {}
    ),
    [selectedConversationId],
  );
  const getSelectedSession = useCallback(
    () => getGenerationSessionView(selectedConversationId),
    [selectedConversationId],
  );
  const selectedSession = useSyncExternalStore(
    subscribeToSelectedSession,
    getSelectedSession,
    getSelectedSession,
  );
  const busy = selectedSession !== undefined;
  const tps = selectedSession?.tps ?? null;
  const generationAdmissionLocked = useConversations(() => (
    isGenerationAdmissionBlocked(conv?.id)
  ));
  const selectedConversationLocked = useConversations(() => (
    conv ? isConversationStructurallyLocked(conv.id) : true
  ));

  const refuseGenerationBlockingOperationOverlap = (conversationId: string) => {
    const reason = generationAdmissionBlockReason(conversationId);
    if (!reason) return false;
    toast.info(reason);
    return true;
  };

  useEffect(() => {
    if (!persistenceFailure) return;
    if (persistenceFailure.severity === 'warning') {
      toast.info(`Conversation storage warning: ${persistenceFailure.message}`);
    } else if (persistenceFailure.operation === 'load conversation messages') {
      toast.error(
        `Conversation history could not be loaded. Stored rows were left unchanged; `
        + `reselect this chat to retry. ${persistenceFailure.message}`,
      );
    } else {
      toast.error(
        `Conversation storage failed while trying to ${persistenceFailure.operation}. `
        + `Recent changes may not survive restart. ${persistenceFailure.message}`,
      );
    }
    clearPersistenceFailure(persistenceFailure.at);
    if (persistenceFailure.conversationId) {
      clearConversationPersistenceFailure(persistenceFailure.conversationId);
    }
  }, [clearConversationPersistenceFailure, clearPersistenceFailure, persistenceFailure]);

  // The complete edit draft lives in conversation UI state. ChatView only
  // projects its identity so the matching bubble replaces the Composer.
  const editingId = useConversationUi(
    (s) => (conv ? (s.byId[conv.id] ?? EMPTY_CONVERSATION_UI).editingMessageId : null),
  );
  const editSubmitting = useConversationUi(
    (s) => (conv ? (s.byId[conv.id] ?? EMPTY_CONVERSATION_UI).editSubmitting : false),
  );
  const presentationUi = useConversationUi(
    (state) => (conv ? (state.byId[conv.id] ?? EMPTY_CONVERSATION_UI) : EMPTY_CONVERSATION_UI),
  );
  const presentationConversationId = conv?.id;
  type PresentationKey =
    | 'workspaceManagerOpen'
    | 'workspaceSections'
    | 'workspaceExpandedDir'
    | 'previewOpenMessageId'
    | 'previewDismissedDuringStream'
    | 'previewPinned'
    | 'previewPinnedByUser'
    | 'previewActiveTab'
    | 'previewTabOverridden';
  const updatePresentation = useCallback(function updatePresentation<
    Key extends PresentationKey,
  >(key: Key, next: SetStateAction<ConversationUiState[Key]>) {
    if (!presentationConversationId) return;
    const current = useConversationUi.getState().get(presentationConversationId)[key];
    const value = typeof next === 'function'
      ? (next as (previous: ConversationUiState[Key]) => ConversationUiState[Key])(current)
      : next;
    useConversationUi.getState().setPresentation(presentationConversationId, { [key]: value });
  }, [presentationConversationId]);
  // Ultimate focus mode: hide sidebar + chat header entirely.
  const [headerHidden, setHeaderHidden] = useState(false);
  // Keep the owning conversation ID rather than a bare boolean. If an
  // unexpected external navigation changes the chat behind the modal, the
  // editor stays mounted against its original durable board until the user
  // explicitly resolves its discard guard.
  const [whiteboardConversationId, setWhiteboardConversationId] = useState<string | null>(null);
  const whiteboardOpen = whiteboardConversationId !== null;

  // Reasoning preview overlay. `openByUser` is the id of the bubble
  // whose reasoning the user explicitly opened (via the brain button on
  // the bubble's meta row), or null if the overlay is hidden by
  // choice. `dismissedDuringStream` is set when the user clicks ×
  // while reasoning is actively streaming — we keep the overlay
  // hidden for the rest of the current stream, even though the
  // streaming-reasoning effect below would otherwise re-show it.
  // The two together let us support both "auto-show on stream start"
  // and "user override stays sticky."
  const openByUser = presentationUi.previewOpenMessageId;
  const setOpenByUser = useCallback(
    (next: SetStateAction<string | null>) => updatePresentation('previewOpenMessageId', next),
    [updatePresentation],
  );
  const dismissedDuringStream = presentationUi.previewDismissedDuringStream;
  const setDismissedDuringStream = useCallback(
    (next: SetStateAction<boolean>) => updatePresentation('previewDismissedDuringStream', next),
    [updatePresentation],
  );
  // Pin mode: when true, the overlay stays open across stream
  // transitions (the auto-hide-on-finish behavior is bypassed)
  // and follows the newest action (live stream takes priority
  // over a manually-opened old bubble). Toggled via the pin
  // button in the overlay header, OR set implicitly when the
  // user clicks a bubble's brain icon (see the `pinnedByUser`
  // flag below). Reset to false by the × button so closing
  // always returns to the default auto-show/auto-hide
  // behavior.
  const pinned = presentationUi.previewPinned;
  const setPinned = useCallback(
    (next: SetStateAction<boolean>) => updatePresentation('previewPinned', next),
    [updatePresentation],
  );

  // Tracks whether the pin was set by an explicit user
  // gesture (pin button click) or implicitly by opening
  // reasoning from a bubble's brain icon. When false, the
  // pin button is disabled — the user can't unpin from
  // there, only by clicking ×. This avoids a UX trap: a
  // user reading a finished bubble's reasoning clicks the
  // brain icon, the overlay opens and auto-pins (so it
  // doesn't disappear on the next stream's auto-hide), but
  // if they then click the pin button the overlay would
  // close and they'd lose their place. Locking the button
  // forces them to use × to close (which is the explicit
  // "I want this gone" gesture) and prevents the
  // "brain → pin → vanish" footgun.
  const pinnedByUser = presentationUi.previewPinnedByUser;
  const setPinnedByUser = useCallback(
    (next: SetStateAction<boolean>) => updatePresentation('previewPinnedByUser', next),
    [updatePresentation],
  );
  // ChatView owns the only active preview tab. The override flag prevents
  // phase-driven switching after a direct shortcut, bubble action, or tab click.
  const overlayActiveTab = presentationUi.previewActiveTab;
  const setOverlayActiveTab = useCallback(
    (next: SetStateAction<PreviewTab>) => updatePresentation('previewActiveTab', next),
    [updatePresentation],
  );
  const overlayTabOverridden = presentationUi.previewTabOverridden;
  const setOverlayTabOverridden = useCallback(
    (next: SetStateAction<boolean>) => updatePresentation('previewTabOverridden', next),
    [updatePresentation],
  );
  const overlayStreamingMessageRef = useRef<string | null>(null);
// Tools UI state. `nmpOpen` drives the WorkspaceManager modal
  // (entered from the params panel's Workspace tab → Directories →
  // [Manage…] button). `toolsRunningRef` is set
  // while the orchestrator is mid-round so the overlay can
  // show the spinner on the Tools tab. Using a ref because the
  // overlay's render doesn't need to flip on each round —
  // we only care that the value is fresh when the overlay reads it.
  const nmpOpen = presentationUi.workspaceManagerOpen;
  const setNmpOpen = useCallback(
    (next: SetStateAction<boolean>) => updatePresentation('workspaceManagerOpen', next),
    [updatePresentation],
  );
  const setWorkspaceSection = useCallback((key: string, next: boolean) => {
    if (!presentationConversationId) return;
    const current = useConversationUi.getState().get(presentationConversationId);
    useConversationUi.getState().setPresentation(presentationConversationId, {
      workspaceSections: { ...current.workspaceSections, [key]: next },
    });
  }, [presentationConversationId]);
  const setWorkspaceExpandedDir = useCallback((path: string | null) => {
    if (!presentationConversationId) return;
    useConversationUi.getState().setPresentation(presentationConversationId, {
      workspaceExpandedDir: path,
    });
  }, [presentationConversationId]);
  useEffect(() => {
    if (busy) setNmpOpen(false);
  }, [busy, setNmpOpen]);
  // toolsRunning is driven by the responseStatus emitter (non-zustand)
  // so pulse toggles don't trigger full ChatView re-renders.  We still
  // use React state here because the overlayTools computation (which
  // marks tool items as isRunning) runs inside render.  The emitter
  // only fires at phase boundaries (tool loop start/stop), not per-
  // token, so this is cheap.
  const [toolsRunning, setToolsRunning] = useState(false);
  useEffect(() => {
    if (!conv?.id) {
      setToolsRunning(false);
      return;
    }
    const unsub = onPhaseChange(conv.id, (phase, changed) => {
      if (changed.includes('toolUse')) {
        setToolsRunning(
          phase.toolUse === 'running' || phase.toolUse === 'started',
        );
      }
    });
    // Sync initial.
    const initial = getPhase(conv.id);
    setToolsRunning(
      initial.toolUse === 'running' || initial.toolUse === 'started',
    );
    return unsub;
  }, [conv?.id]);

  // F11 → toggle focus mode (hide sidebar + chat header).
  useEffect(() => {
    const handler = () => {
      setHeaderHidden(h => !h);
      toggleSidebar(false);
    };
    window.addEventListener('lc:toggle-focus-mode', handler);
    return () => window.removeEventListener('lc:toggle-focus-mode', handler);
  }, [toggleSidebar]);

  // Auto-collapse sidebar when composer is focused at narrow widths.
  useEffect(() => {
    const el = document.getElementById('composer-input');
    if (!el) return;
    const onFocus = () => {
      if (window.matchMedia('(max-width: 720px)').matches && sidebarOpen) {
        toggleSidebar(false);
      }
    };
    el.addEventListener('focusin', onFocus);
    return () => el.removeEventListener('focusin', onFocus);
  }, [sidebarOpen, toggleSidebar]);

  // Apply/remove `header-hidden` class on .app so CSS can hide the sidebar.
  useEffect(() => {
    const app = document.querySelector('.app');
    if (app) app.classList.toggle('header-hidden', headerHidden);
  }, [headerHidden]);

  // Reset the per-stream dismissal flag whenever a new stream starts,
  // so the × only sticks for the stream it was clicked on.
  // Also clear the brain-click focus (openByUser) when a new
  // stream STARTS — the brain click is a "momentary read"
  // gesture, and a fresh stream is a new action that takes
  // over. We deliberately keep `pinned` set to true so the
  // pinned-mode resolver branch applies: after the stream
  // ends, the resolver falls through to `mostRecentReasoning`
  // (the just-finished message), so the overlay keeps
  // showing the new reasoning instead of reverting to the
  // brain-clicked one. The user can re-click the brain
  // mid-stream if they actually want to read the older
  // reasoning during the new stream — that re-sets
  // `openByUser`, and the priority `override > live` then
  // shows the clicked message.
  const streamingId = conv?.messages.find((m) => m.streaming)?.id ?? null;
  useEffect(() => {
    if (streamingId === null || streamingId === overlayStreamingMessageRef.current) return;
    overlayStreamingMessageRef.current = streamingId;
    setDismissedDuringStream(false);
    setOpenByUser(null);
    setOverlayActiveTab('reasoning');
    setOverlayTabOverridden(false);
  }, [
    setDismissedDuringStream,
    setOpenByUser,
    setOverlayActiveTab,
    setOverlayTabOverridden,
    streamingId,
  ]);
  // Conversation switches restore the destination's keyed presentation state.
  // Only prune unreferenced UI entries; generation and view ownership remain
  // attached to their conversations.
  const activeConvIdForReset = useConversations((s) => s.activeId);
  useEffect(() => {
    overlayStreamingMessageRef.current = null;
    // Bound the per-conversation UI state. Drafts for conversations nothing
    // references any more are released along with the blobs they staged.
    void useConversationUi.getState()
      .pruneNonResident(residentConversationIds(activeConvIdForReset));
    // The global image-batch and orchestrator caches are deliberately NOT
    // cleared here any more. A background generation's pending `read_image`
    // batches and tool-call mappings live in those caches, and wiping them on
    // a switch would make its next model turn miss pixels it had already
    // read. Generation-scoped disposal replaces the blanket clear in Phase 3;
    // until then both caches stay bounded by their own TTL and size limits.
  }, [activeConvIdForReset]);

  // Find the currently-streaming message (if any) — its reasoning
  // is what the overlay auto-shows.
  const streamingMsg = conv?.messages.find((m) => m.streaming);
  const todoSnapshots = useMemo(
    () => buildTodoSnapshotIndex(conv?.messages ?? []),
    // Message appends and branch replacements bump this counter. Streamed
    // text and reasoning deltas do not change a completed to-do snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conv?.id, loadedVersion],
  );

  useEffect(() => {
    setOverlayActiveTab((currentTab) => previewTabForPhase(
      currentTab,
      overlayTabOverridden,
      toolsRunning,
      streamingMsg ? messageHasVisibleReasoning(streamingMsg) : false,
    ));
  }, [overlayTabOverridden, setOverlayActiveTab, streamingMsg, toolsRunning]);

  // Decide which bubble's reasoning the overlay should show, in
  // priority order:
  //   - When PINNED: brain-clicked (override) wins, then the
  //     live stream, then the most recent assistant message
  //     with non-empty reasoning (mostRecentReasoning) as a
  //     final fallback for the pin-during-stream case where
  //     the stream has ended.
  //   - When UNPINNED: brain-clicked wins, then live stream.
  //   - Otherwise: nothing to show, overlay hides.
  //
  // Why override beats live: a brain click during a stream
  // is the user explicitly saying "I want to read THIS older
  // message, not the new action that's happening". A live
  // stream by default shows the new action, but the user's
  // brain-click is the override — they want to read.
  //
  // Why a new stream CLEARS the brain-click: see the effect
  // on `streamingId` change above. The brain click is a
  // "momentary read" — once a fresh action (new stream)
  // happens, the new action owns the overlay. After the
  // stream ends, the resolver falls through to
  // `mostRecentReasoning` (the just-finished message) so the
  // overlay keeps showing the new reasoning, not reverting
  // to the old brain-clicked one.
  const overrideMsg: Message | null = openByUser
    ? (conv?.messages.find((m) => m.id === openByUser) ?? null)
    : null;
  const messageMatchesActiveTab = useCallback((message: Message): boolean => {
    if (message.role !== 'assistant') return false;
    if (overlayActiveTab === 'reasoning') return messageHasVisibleReasoning(message);
    if (overlayActiveTab === 'tools') return Boolean(message.tool_calls?.length);
    return todoSnapshots.ownedByAssistantId.has(message.id);
  }, [overlayActiveTab, todoSnapshots.ownedByAssistantId]);
  const liveMsg =
    (autoPreviewReasoning || pinned) && streamingMsg && messageMatchesActiveTab(streamingMsg)
      ? streamingMsg
      : null;
  const mostRecentMatching: Message | null =
    conv?.messages
      .slice()
      .reverse()
      .find(messageMatchesActiveTab) ?? null;
  // Pinned-branch priority: brain-clicked > live > most-recent.
  // Unpinned-branch priority: brain-clicked > live.
  const activeMsg = pinned
    ? (overrideMsg ?? liveMsg ?? mostRecentMatching ?? null)
    : (overrideMsg ?? liveMsg ?? null);
  // The overlay is open if we have a message to show AND the
  // user didn't dismiss it. Pin mode ignores the dismissal
  // flag (the whole point of pinning is to stay visible
  // through dismissal events).
  const overlayOpen = !!activeMsg && (pinned || !dismissedDuringStream);
  const overlayStreaming =
    !!activeMsg && activeMsg.id === streamingMsg?.id && !!liveMsg;
  const overlayTodos = previewTodoSnapshotsAtMessage(
    todoSnapshots,
    activeMsg?.id,
    showOnlyLatestTodoList,
  );

  // Assemble the Tools tab rows from the active message's
  // tool_calls + the matching role: 'tool' result messages. We
  // need both because the call lives on the assistant message
  // and the result lives on the follow-up tool message — they
  // share `tool_call_id`. A call without a matching result is
  // marked `running` (it's either in-flight or the orchestrator
  // hasn't appended its result yet).
  const overlayTools: ToolCallItem[] = (() => {
    const am = activeMsg as Message | null;
    if (!am?.tool_calls) return [];
    const msgId = am.id;
    const msgIdx = conv?.messages.findIndex((m) => m.id === msgId) ?? -1;
    const resultsAfter = new Map<
      string,
      {
        output: string;
        is_error: boolean;
        duration_ms: number;
        permission?: NonNullable<Message['tool_permission']>;
      }
    >();
    if (msgIdx >= 0 && conv) {
      for (let i = msgIdx + 1; i < conv.messages.length; i++) {
        const m = conv.messages[i];
        if (m.role === 'tool' && m.tool_call_id) {
          resultsAfter.set(m.tool_call_id, {
            output: m.content,
            is_error: m.tool_is_error ?? false,
            duration_ms: m.tool_duration_ms ?? 0,
            permission: m.tool_permission,
          });
        }
      }
    }
    return am.tool_calls.map((call) => {
      const r = resultsAfter.get(call.id);
      return {
        call: {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          created_at: call.created_at,
        },
        result: r,
        isRunning:
          !r &&
          (toolsRunning ||
            (!!streamingMsg && streamingMsg.id === msgId)),
      };
    });
  })();

  const lineChangesByAssistantId = useMemo(() => {
    const byAssistantId = new Map<string, FileLineChanges>();
    if (!conv) return byAssistantId;

    let currentAssistant: Message | null = null;
    let currentCalls = new Map<string, NonNullable<Message['tool_calls']>[number]>();
    const collectedFiles = new Map<string, FileLineChange[]>();
    const collectedTotals = new Map<string, { added: number; removed: number }>();
    for (const message of conv.messages) {
      if (message.role === 'assistant') {
        currentAssistant = message;
        currentCalls = new Map(message.tool_calls?.map((call) => [call.id, call]) ?? []);
        continue;
      }
      if (message.role !== 'tool' || !currentAssistant || !message.tool_call_id) {
        if (message.role !== 'tool') currentAssistant = null;
        continue;
      }
      const call = currentCalls.get(message.tool_call_id);
      if (!call) continue;

      // Current rows already carry change types. Rebuild older rows from the
      // compact tool output only when a migration-free upgrade is needed.
      const storedFiles = message.tool_line_changes ?? [];
      const needsRebuild = storedFiles.length === 0
        || storedFiles.some((file) => !file.changeType);
      const rebuilt = needsRebuild
        ? summarizeFileLineChanges(call.name, message.content)
        : undefined;
      const factualFiles = rebuilt?.files ?? storedFiles;
      if (
        message.tool_lines_added === undefined
        && message.tool_lines_removed === undefined
        && !message.tool_line_changes?.length
        && factualFiles.length === 0
      ) continue;

      // Keep preview inputs compact and lazy. Parsing a 1 MiB patch on every
      // streaming token would make chat rendering needlessly expensive; the
      // modal resolves these recipes only for the selected file.
      const files = factualFiles.map((file) => ({
        ...file,
        previewSources: [{
          toolName: call.name,
          toolArguments: call.arguments,
          timestamp: message.createdAt,
          path: file.path,
          ...(file.moveTo ? { moveTo: file.moveTo } : {}),
          added: file.added,
          removed: file.removed,
          changeType: file.changeType,
        }],
      }));
      const allFiles = [...(collectedFiles.get(currentAssistant.id) ?? []), ...files];
      const previousTotals = collectedTotals.get(currentAssistant.id) ?? { added: 0, removed: 0 };
      const totals = {
        added: previousTotals.added + (message.tool_lines_added ?? rebuilt?.added ?? 0),
        removed: previousTotals.removed + (message.tool_lines_removed ?? rebuilt?.removed ?? 0),
      };
      collectedFiles.set(currentAssistant.id, allFiles);
      collectedTotals.set(currentAssistant.id, totals);
      byAssistantId.set(currentAssistant.id, { ...mergeFileLineChanges(allFiles), ...totals });
    }
    return byAssistantId;
  // Tool line changes are structural transcript data. Streaming text updates
  // must not rescan the settled transcript prefix after every token append.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv?.id, loadedVersion]);

  // When the user clicks ×, remember the dismissal for the
  // current stream so the auto-show effect below doesn't
  // immediately bring it back. (We only set the flag when
  // reasoning is actively streaming — if the user closes a
  // stale reasoning from a finished bubble, no flag is
  // needed.) Closing also unpins and clears the pin-source
  // flag: the × button is the explicit "I want the default
  // auto-show/auto-hide behavior back" action, and a user
  // closing the overlay has no reason to stay in pin mode
  // — regardless of whether the pin was set by the button
  // or implicitly by a brain click.
  const handleOverlayClose = useCallback(() => {
    if (overlayStreaming) {
      setDismissedDuringStream(true);
    }
    setOpenByUser(null);
    setPinned(false);
    setPinnedByUser(false);
    setOverlayActiveTab('reasoning');
    setOverlayTabOverridden(false);
  }, [
    overlayStreaming,
    setDismissedDuringStream,
    setOpenByUser,
    setOverlayActiveTab,
    setOverlayTabOverridden,
    setPinned,
    setPinnedByUser,
  ]);

  // Pin toggle. Two-way; the button is the only UI that flips
  // it (when the pin is user-toggleable — see the
  // `pinnedByUser` docstring for when it's not). The
  // `pinnedByUser` flag follows the toggle: pinning via the
  // button sets it true, unpinning via the button sets it
  // false. When the user unpins manually (clicks the pin
  // button while it's already on) we leave `openByUser`
  // as-is and reset `dismissedDuringStream` so the
  // overlay's normal auto-show logic takes over on the
  // next render.
  const handleOverlayPinToggle = useCallback(() => {
    setPinned((p) => {
      const next = !p;
      if (next) {
        // Pinning via the button: user-driven, the button
        // stays active so they can unpin from the same
        // affordance.
        setPinnedByUser(true);
      } else {
        // Unpinning: bring the dismissal flag back to a
        // clean slate so the next stream (if any)
        // auto-shows the overlay per the normal rule.
        setDismissedDuringStream(false);
        setPinnedByUser(false);
      }
      return next;
    });
  }, [setDismissedDuringStream, setPinned, setPinnedByUser]);

  // Pass-through props for each bubble so the bubble can request
  // showing its reasoning in the overlay. We pass one stable
  // callback per render — the bubble just calls it with its own id.
  // A brain click is treated as an implicit pin: the user is
  // *reading* a specific bubble's reasoning, so the overlay
  // should stay open across any new stream that might start
  // (and not get auto-hidden by the dismiss-during-stream
  // effect). `pinnedByUser` stays false so the pin button
  // is disabled — the only way out is ×, which is the
  // explicit "I'm done" gesture. See the `pinnedByUser`
  // docstring for the full UX rationale.
  const handleShowReasoning = useCallback((messageId: string) => {
    setOpenByUser(messageId);
    setDismissedDuringStream(false);
    setPinned(true);
    setPinnedByUser(false);
    setOverlayActiveTab('reasoning');
    setOverlayTabOverridden(true);
  }, [
    setDismissedDuringStream,
    setOpenByUser,
    setOverlayActiveTab,
    setOverlayTabOverridden,
    setPinned,
    setPinnedByUser,
  ]);

  // The tools button on the assistant bubble opens the reasoning
  // overlay at the Tools tab.
  const handleShowTools = useCallback((_messageId: string) => {
    setOpenByUser(_messageId);
    setDismissedDuringStream(false);
    setPinned(true);
    setPinnedByUser(false);
    setOverlayActiveTab('tools');
    setOverlayTabOverridden(true);
  }, [
    setDismissedDuringStream,
    setOpenByUser,
    setOverlayActiveTab,
    setOverlayTabOverridden,
    setPinned,
    setPinnedByUser,
  ]);

  const handleShowTodo = useCallback((messageId: string) => {
    setOpenByUser(messageId);
    setDismissedDuringStream(false);
    setPinned(true);
    setPinnedByUser(false);
    setOverlayActiveTab('todo');
    setOverlayTabOverridden(true);
  }, [
    setDismissedDuringStream,
    setOpenByUser,
    setOverlayActiveTab,
    setOverlayTabOverridden,
    setPinned,
    setPinnedByUser,
  ]);

  const handleOverlayTabChange = useCallback((tab: PreviewTab) => {
    const selection = previewSelectionForTabClick(tab, activeMsg?.id);
    setOpenByUser(selection.openMessageId);
    setOverlayActiveTab(selection.activeTab);
    setOverlayTabOverridden(selection.tabOverridden);
  }, [activeMsg?.id, setOpenByUser, setOverlayActiveTab, setOverlayTabOverridden]);

  const whiteboardTargetConversationId = conv?.id;
  const whiteboardEnabled = conv?.tools?.enabled === true
    && conv.tools.whiteboard_enabled === true;
  const handleOpenWhiteboard = useCallback(async () => {
    if (!whiteboardTargetConversationId || !whiteboardEnabled) return;
    try {
      // Idempotent fallback for legacy/imported metadata whose category was
      // already enabled before the first UI open.
      await initializeWhiteboard(whiteboardTargetConversationId);
      toggleSidePanel(false);
      setWhiteboardConversationId(whiteboardTargetConversationId);
    } catch (error) {
      toast.error(`${WHITEBOARD_UI_TEXT.couldNotOpen} ${errorMessage(error)}`);
    }
  }, [toggleSidePanel, whiteboardEnabled, whiteboardTargetConversationId]);

  const handleWhiteboardClosed = useCallback(() => {
    setWhiteboardConversationId(null);
    requestAnimationFrame(() => {
      const focusTarget = pinComposer
        ? document.querySelector<HTMLButtonElement>('.whiteboard-action-btn')
        : document.querySelector<HTMLElement>('.messages');
      focusTarget?.focus();
    });
  }, [pinComposer]);

  useEffect(() => {
    const onOpenWhiteboard = () => { void handleOpenWhiteboard(); };
    window.addEventListener('lc:open-whiteboard', onOpenWhiteboard);
    return () => window.removeEventListener('lc:open-whiteboard', onOpenWhiteboard);
  }, [handleOpenWhiteboard]);

  const { scrollRef, handleMessagesScroll, scrollToBottom } = useTranscriptScroll({
    conversationId: presentationConversationId,
    activeGenerationId: selectedSession?.generationId,
    activeGenerationAssistantId: selectedSession?.assistantMessageId,
    completedAssistantMessageId: completedAssistantMessageId(conv?.messages),
  });

  // ── Keyboard shortcuts for the preview overlay ────────────────────────

  // Ctrl+P: open overlay at Reasoning tab for the last assistant
  // message with reasoning.  Ctrl+Shift+P: Tools tab, last
  // assistant message with tool calls.  Both lock the pin
  // (mimicking a brain/tools click) so the overlay stays open.
  // When the overlay is already open, just switch the active tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!conv) return;
      const isMac = /Mac|iPhone|iPad/i.test(navigator.platform);
      const tab = previewShortcutTab(e, isMac);
      if (!tab) return;

      e.preventDefault();

      const revealPreview = () => {
        if (overlayOpen) {
          handleOverlayTabChange(tab);
          requestAnimationFrame(() => {
            (document.querySelector('.preview-overlay-body') as HTMLElement)?.focus();
          });
          return;
        }

        const reversed = [...conv.messages].reverse();
        const target = reversed.find((message) => message.role === 'assistant' && (
          tab === 'reasoning'
            ? messageHasVisibleReasoning(message)
            : tab === 'tools'
              ? Boolean(message.tool_calls?.length)
              : todoSnapshots.ownedByAssistantId.has(message.id)
        ));

        if (!target) return;
        if (tab === 'tools') {
          handleShowTools(target.id);
        } else if (tab === 'reasoning') {
          handleShowReasoning(target.id);
        } else {
          handleShowTodo(target.id);
        }
        requestAnimationFrame(() => {
          (document.querySelector('.preview-overlay-body') as HTMLElement)?.focus();
        });
      };

      if (whiteboardOpen) {
        void requestWhiteboardOverlayExit('preview-open').then((allowed) => {
          if (allowed) revealPreview();
        });
        return;
      }

      revealPreview();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    activeMsg,
    conv,
    handleOverlayTabChange,
    handleShowReasoning,
    handleShowTodo,
    handleShowTools,
    overlayOpen,
    todoSnapshots.ownedByAssistantId,
    whiteboardOpen,
  ]);

  // Ctrl+ArrowUp / Ctrl+ArrowDown: when the overlay is open, cycle
  // through previous / next assistant messages that have reasoning
  // or tool calls matching the current tab.
  useEffect(() => {
    if (!overlayOpen || !conv) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

      const assistantMsgs = conv.messages.filter((m) =>
        m.role === 'assistant' &&
        (overlayActiveTab === 'tools'
          ? m.tool_calls?.length
          : overlayActiveTab === 'todo'
            ? todoSnapshots.ownedByAssistantId.has(m.id)
            : messageHasVisibleReasoning(m)),
      );
      const curIdx = assistantMsgs.findIndex((m) => m.id === activeMsg?.id);
      const nextIdx = previewNavigationIndex(
        assistantMsgs.length,
        curIdx,
        e.key === 'ArrowDown' ? 'next' : 'previous',
      );
      if (nextIdx === undefined) return;

      e.preventDefault();
      const next = assistantMsgs[nextIdx];
      if (overlayActiveTab === 'tools') {
        handleShowTools(next.id);
      } else if (overlayActiveTab === 'todo') {
        handleShowTodo(next.id);
      } else {
        handleShowReasoning(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    activeMsg,
    conv,
    handleShowReasoning,
    handleShowTodo,
    handleShowTools,
    overlayActiveTab,
    overlayOpen,
    todoSnapshots.ownedByAssistantId,
  ]);

  // Stable callback for the side panel close button. (Kept near
  // the top of the component alongside the other state-related
  // callbacks so the hook order is obvious at a glance — the
  // entire component avoids an `if (!conv) return` early-exit
  // pattern; see the comment block where the early-return used
  // to be for why.)
  //
  // After closing the panel we hand focus back to the composer
  // textarea. The user typically opens the panel to tweak
  // params, then wants to keep typing in the same conversation
  // — bouncing focus to the body and back to the textarea is
  // the natural keyboard flow. The focus is queued with
  // `queueMicrotask` so the click target's own focus
  // state-change finishes propagating first; otherwise some
  // browsers re-focus the X button instead of the textarea.
  const handleCloseSidePanel = useCallback(() => {
    toggleSidePanel(false);
    queueMicrotask(() => {
      document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
    });
  }, [toggleSidePanel]);

  // Prevent Tab from cycling into chat bubble links/buttons.
  // After each render (when messages change), set tabIndex={-1}
  // on every focusable element inside the messages container so
  // Tab goes straight from header to composer.
  useEffect(() => {
    requestAnimationFrame(() => {
      const inner = document.querySelector('.messages-inner');
      if (!inner) return;
      const focusable = inner.querySelectorAll(
        'a, button, [tabindex]:not([tabindex="-1"]), ' +
        // Scrollable containers that browsers make focusable.
        '.md table, .md pre, .math-display',
      );
      for (const el of Array.from(focusable)) {
        // Don't suppress Tab inside the edit bubble — the user
        // needs to Tab between the textarea and Cancel/Save.
        if ((el as HTMLElement).closest('.bubble-user.is-editing')) continue;
        (el as HTMLElement).setAttribute('tabindex', '-1');
      }
      // Restore tabIndex on elements inside the edit bubble
      // (they may have been suppressed by a previous sweep).
      const editBubble = inner.querySelector('.bubble-user.is-editing');
      if (editBubble) {
        for (const el of Array.from(editBubble.querySelectorAll('[tabindex="-1"]'))) {
          (el as HTMLElement).removeAttribute('tabindex');
        }
      }
    });
  }, [conv?.messages.length, editingId]);

  // NOTE: there is intentionally NO early-return on `!conv` here.
  //
  // The rest of this component defines hooks (useCallback for
  // cancel/retry/editAndResend/handleEdit/etc.) and renders JSX
  // that references `conv.*` directly. If we returned `<EmptyState/>`
  // early when `conv` is null, those hooks wouldn't run on the
  // null branch — and on the next render where `conv` is non-null
  // again, React would see more hooks than the previous render
  // and throw "Rendered fewer hooks than expected." This is a
  // classic Rules-of-Hooks violation; the rule is "hooks must be
  // called in the same order on every render."
  //
  // The bug stayed dormant for as long as `activeId` didn't
  // oscillate null↔non-null within a single mount of ChatView.
  // Adding the collapsed-sidebar Active/Archive tab switch —
  // which calls `setActive(null)` when the target tab has no
  // prior pointer — exposed it: the user was in Active chat #3,
  // clicked the switch, main pane briefly hit the welcome screen
  // (fewer hooks), then on the way back re-mounted the full
  // hook tree. Crash.
  //
  // Fix: keep all hooks running on every render, then render
  // `<EmptyState/>` or the main chat UI at the very end based
  // on whether `conv` exists. The `conv ? <jsx> : null`
  // ternary in the final return lets TypeScript narrow `conv`
  // to `Conversation` inside the truthy branch, so the `conv.X`
  // references throughout the chat JSX are still sound without
  // any non-null assertion.

  const send = async (text: string, attachments: Attachment[]) => {
    // Read EVERYTHING fresh from the store — `conv` and `profile` are
    // render-closure captures that may be stale after a profile switch
    // if the ModelPicker hasn't triggered a re-render yet.
    const state = useConversations.getState();
    const convId = state.activeId;
    if (!convId) return false;
    const freshConv = state.byId[convId];
    if (!freshConv) return false;
    if (
      state.loadingMessageIds.has(convId)
      || getStreamingOwner(convId)
      || refuseGenerationBlockingOperationOverlap(convId)
    ) return false;
    if (!isConversationMessageHistoryComplete(freshConv)) {
      warnIncompleteConversationHistory();
      return false;
    }

    // The toggle is the active indicator — any toggled-on profile
    const serverId = freshConv.serverId
      ?? useProfileStore.getState().profiles.find((p) => p.active)?.id;
    const convProf = serverId
      ? useProfileStore.getState().profiles.find((p) => p.id === serverId)
      : undefined;
    if (!convProf) {
      toast.error('No server profile available. Open Settings to add or toggle one on.');
      return false;
    }
    if (!convProf.active) {
      toast.error(`Server "${convProf.name}" is toggled off.`);
      return false;
    }

    if (freshConv.archived) {
      useConversations.getState().unarchive(convId);
      toast.info(`"${freshConv.title}" moved back to Active`);
    }

    if (!freshConv.model) {
      toast.error('No model selected. Pick one in the top bar.');
      return false;
    }
    if (useAppModels.getState().models.length === 0) {
      toast.error('No models available. Ensure at least one server is toggled on and reachable.');
      return false;
    }

    const admission = acquireChatGenerationAdmission(`Send message in ${convId}`, convId, convProf.id);
    if (!admission) return false;

    // Resolve every mutable external/configuration input before the durable
    // send boundary. The running pipeline receives this frozen snapshot and
    // never adopts later Settings/Profile/Workspace edits between tool rounds.
    let resolvedKey: string;
    let executionState: Awaited<ReturnType<typeof captureGenerationExecutionState>>;
    try {
      resolvedKey = await resolveChatCredential(convProf);
      executionState = await captureGenerationExecutionState(freshConv, convProf, {
        apiKey: resolvedKey,
      });
    } catch (error) {
      unmarkGenerationBlockingOperation(admission.operationId);
      toast.error(`Send could not complete generation preflight: ${errorMessage(error)}`);
      return false;
    }

    try {
      commitChatGenerationAdmission(admission.operationId, convId);
    } catch (error) {
      unmarkGenerationBlockingOperation(admission.operationId);
      toast.info(errorMessage(error));
      return false;
    }

    // The enabled Whiteboard send boundary promotes and pins the pending user
    // copy in the same durable transaction as this message. Do not create the
    // assistant or start streaming until that transaction has completed.
    try {
      const user = await appendUserMessage(convId, {
        role: 'user',
        content: text,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      if (!user) {
        unmarkGenerationBlockingOperation(admission.operationId);
        return false;
      }
    } catch (error) {
      unmarkGenerationBlockingOperation(admission.operationId);
      toast.error(`Send could not save the conversation: ${errorMessage(error)}`);
      return false;
    }
    const assistant = appendMessage(convId, {
      role: 'assistant',
      content: '',
      streaming: true,
      meta: {
        model: freshConv.model,
        presetName: detectPresetName(freshConv.params),
        params: snapshotGenerationParams(freshConv.params, convProf.apiVariant),
        endpoint: endpointForProfile(convProf.apiVariant, convProf.apiStyle),
        serverName: convProf.name,
        baseUrl: convProf.baseUrl,
      },
    });
    if (!assistant) {
      unmarkGenerationBlockingOperation(admission.operationId);
      return true;
    }

    requestAnimationFrame(scrollToBottom);

    let started: Awaited<ReturnType<typeof handoffAndRegisterGenerationSession>>;
    try {
      started = await handoffAndRegisterGenerationSession(
        admission.operationId,
        convId,
        assistant.id,
      );
    } catch (error) {
      unmarkGenerationBlockingOperation(admission.operationId);
      toast.error(`Send could not start generation: ${errorMessage(error)}`);
      return true;
    }
    const { owner, controller } = started;

    try {
      const streamOpts = {
        convId,
        llmClient: new LLMClient({
          baseUrl: convProf.baseUrl,
          apiKey: resolvedKey,
          apiVariant: convProf.apiVariant,
          apiStyle: convProf.apiStyle,
          routing: convProf.routing,
          providerContract: executionState.snapshot.providerContract,
          providerContractStatus: executionState.snapshot.providerContractStatus,
          ...profileRequestHeaderSettings(convProf),
        }),
        model: freshConv.model,
        profile: {
          baseUrl: convProf.baseUrl,
          apiKey: resolvedKey,
          ...profileRequestHeaderSettings(convProf),
        },
        apiVariant: convProf.apiVariant,
        apiStyle: convProf.apiStyle,
        routing: convProf.routing,
        sseReadTimeoutMin: convProf.sse_read_timeout_min,
        generationId: owner.generationId,
        assistantMessageId: owner.assistantMessageId,
        snapshot: executionState.snapshot,
        runtimeSecrets: executionState.secrets,
        onTps: (value: number | null) => setGenerationSessionTps(convId, owner.generationId, value),
      };
      await runStreamWithTools(convId, controller.signal, streamOpts);
    } catch (err) {
      if (!controller.signal.aborted) reportGenerationError(convId, 'Send', err);
    } finally {
      // Ownership is what admission checks, so it is released only once the
      // terminal flush is durable. Freeing it while that flush is still queued
      // lets a replacement generation start and then be overwritten by the
      // previous one's transcript snapshot.
      await settleGenerationSessionAfterTerminalFlush(convId, owner.generationId);
    }
    return true;
  };

  const currentConvId = conv?.id;

  const cancel = useCallback(() => {
    // Guard: `conv` can be null on any render now (the early-
    // return was removed; see the comment block above). When
    // there's no active conversation there's nothing to cancel,
    // so this is a no-op. The callback captures only the stable
    // conversation ID, not the conversation object that is cloned
    // during streaming.
    if (!currentConvId) return;
    // Cancel addresses the session by conversation, so it can never reach a
    // different chat's generation.
    const stop = requestGenerationStop(currentConvId);
    if (stop.outcome === 'retrying-terminal-write') {
      toast.info('Retrying the final conversation storage write…');
    }
  }, [currentConvId]);

  const retry = useCallback(async (messageId: string) => {
    // Read the latest conversation from the Zustand store directly
    // instead of relying on `conv` from the component closure —
    // React may batch re-renders and the captured `conv.messages`
    // could be stale, causing the trim to miss old responses.
    const state = useConversations.getState();
    const c = state.activeId ? state.byId[state.activeId] : null;
    if (!c) return;
    if (!isConversationMessageHistoryComplete(c)) {
      warnIncompleteConversationHistory();
      return;
    }
    const idx = c.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;

    const convProf = useProfileStore.getState().profiles.find((p) => p.id === c.serverId);
    if (!convProf) {
      toast.error('No server profile available. Open Settings to add or toggle one on.');
      return;
    }
    if (!convProf.active) {
      toast.error(`Server "${convProf.name}" is toggled off.`);
      return;
    }
    if (!c.model) {
      toast.error('No model selected. Pick one in the top bar.');
      return;
    }
    if (useAppModels.getState().models.length === 0) {
      toast.error('No models available. Ensure at least one server is toggled on and reachable.');
      return;
    }

    // Reserve capacity synchronously, before the first await. Resolving the
    // credential first would let two rapid Retries both pass preflight and
    // then race for the slot; the reservation is what makes the second one a
    // no-op instead of a duplicated destructive action.
    const admission = acquireChatGenerationAdmission(`Retry response in ${c.id}`, c.id, convProf.id);
    if (!admission) return;

    // Resolve every asynchronous prerequisite before truncating history. A
    // failed Retry must leave both Zustand and Dexie byte-for-byte unchanged.
    const preflight = await resolveGenerationPreflight({
      conversationId: c.id,
      messageId,
      expectedProfile: convProf,
      admissionOperationId: admission.operationId,
      resolveApiKey: () => resolveChatCredential(convProf),
    }).catch((error) => {
      toast.error(`Retry could not complete generation preflight: ${errorMessage(error)}`);
      return null;
    });
    if (!preflight) return;
    const {
      conversation: latest,
      message: latestMsg,
      profile: latestProf,
      resolvedKey,
    } = preflight;
    let executionState: Awaited<ReturnType<typeof captureGenerationExecutionState>>;
    try {
      executionState = await captureGenerationExecutionState(latest, latestProf, {
        apiKey: resolvedKey,
      });
    } catch (error) {
      unmarkGenerationBlockingOperation(admission.operationId);
      toast.error(`Retry could not capture generation settings: ${errorMessage(error)}`);
      return;
    }

    try {
      commitChatGenerationAdmission(admission.operationId, latest.id);
    } catch (error) {
      unmarkGenerationBlockingOperation(admission.operationId);
      toast.info(errorMessage(error));
      return;
    }

    // Use replaceFromMessage (the same store action as editAndResend) only after
    // preflight succeeds, so the destructive boundary and stream start are
    // adjacent.
    try {
      const replaced = await replaceFromMessage(latest.id, messageId, {
        content: latestMsg.content,
        attachments: latestMsg.attachments,
      }, 'retry');
      if (!replaced) {
        unmarkGenerationBlockingOperation(admission.operationId);
        return;
      }
    } catch (error) {
      unmarkGenerationBlockingOperation(admission.operationId);
      toast.error(`Retry could not replace conversation history: ${errorMessage(error)}`);
      return;
    }
    const assistant = appendMessage(latest.id, {
      role: 'assistant',
      content: '',
      streaming: true,
      meta: {
        model: latest.model,
        presetName: detectPresetName(latest.params),
        params: snapshotGenerationParams(latest.params, latestProf.apiVariant),
        endpoint: endpointForProfile(latestProf.apiVariant, latestProf.apiStyle),
        serverName: latestProf.name,
        baseUrl: latestProf.baseUrl,
      },
    });
    if (!assistant) {
      unmarkGenerationBlockingOperation(admission.operationId);
      return;
    }

    let started: Awaited<ReturnType<typeof handoffAndRegisterGenerationSession>>;
    try {
      started = await handoffAndRegisterGenerationSession(
        admission.operationId,
        latest.id,
        assistant.id,
      );
    } catch (error) {
      unmarkGenerationBlockingOperation(admission.operationId);
      toast.error(`Retry could not start generation: ${errorMessage(error)}`);
      return;
    }
    const { owner, controller } = started;

    const streamOpts = {
      convId: latest.id,
      llmClient: new LLMClient({
        baseUrl: latestProf.baseUrl,
        apiKey: resolvedKey,
        apiVariant: latestProf.apiVariant,
        apiStyle: latestProf.apiStyle,
        routing: latestProf.routing,
        providerContract: executionState.snapshot.providerContract,
        providerContractStatus: executionState.snapshot.providerContractStatus,
        ...profileRequestHeaderSettings(latestProf),
      }),
      model: latest.model,
      profile: {
        baseUrl: latestProf.baseUrl,
        apiKey: resolvedKey,
        ...profileRequestHeaderSettings(latestProf),
      },
      apiVariant: latestProf.apiVariant,
      apiStyle: latestProf.apiStyle,
      routing: latestProf.routing,
      sseReadTimeoutMin: latestProf.sse_read_timeout_min,
      generationId: owner.generationId,
      assistantMessageId: owner.assistantMessageId,
      snapshot: executionState.snapshot,
      runtimeSecrets: executionState.secrets,
      onTps: (value: number | null) => setGenerationSessionTps(latest.id, owner.generationId, value),
    };
    void runStreamWithTools(latest.id, controller.signal, streamOpts)
      .catch((error) => {
        if (!controller.signal.aborted) reportGenerationError(latest.id, 'Retry', error);
      })
      .finally(async () => {
        await settleGenerationSessionAfterTerminalFlush(latest.id, owner.generationId);
      });
  }, [appendMessage, replaceFromMessage]);

  const editAndResend = useCallback(async (
    messageId: string,
    next: { content: string; attachments?: Attachment[] },
    editSessionId: string,
  ) => {
    const resumeEdit = () => {
      if (!currentConvId) return;
      useConversationUi.getState().resumeEditSubmission(
        currentConvId,
        messageId,
        editSessionId,
      );
    };
    // Read the latest snapshot once, but keep mutations addressed to the
    // conversation that owned this callback. This avoids stale message
    // arrays without allowing an active-conversation switch to retarget
    // the edit.
    const current = currentConvId
      ? useConversations.getState().byId[currentConvId]
      : undefined;
    if (!current) {
      resumeEdit();
      return;
    }
    if (!isConversationMessageHistoryComplete(current)) {
      warnIncompleteConversationHistory();
      resumeEdit();
      return;
    }
    const idx = current.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) {
      resumeEdit();
      return;
    }

    const convProf = useProfileStore.getState().profiles.find((p) => p.id === current.serverId);
    if (!convProf) {
      toast.error('No server profile available. Open Settings to add or toggle one on.');
      resumeEdit();
      return;
    }
    if (!convProf.active) {
      toast.error(`Server "${convProf.name}" is toggled off.`);
      resumeEdit();
      return;
    }
    if (!current.model) {
      toast.error('No model selected. Pick one in the top bar.');
      resumeEdit();
      return;
    }
    if (useAppModels.getState().models.length === 0) {
      toast.error('No models available. Ensure at least one server is toggled on and reachable.');
      resumeEdit();
      return;
    }

    // Reserve capacity synchronously, before the first await — see the Retry
    // path above for why the ordering matters.
    const admission = acquireChatGenerationAdmission(
      `Edit and resend in ${current.id}`,
      current.id,
      convProf.id,
    );
    if (!admission) {
      resumeEdit();
      return;
    }

    // Resolve every asynchronous prerequisite before deleting attachments or
    // replacing messages. A failed edit-and-resend must be non-destructive.
    const preflight = await resolveGenerationPreflight({
      conversationId: current.id,
      messageId,
      expectedProfile: convProf,
      admissionOperationId: admission.operationId,
      resolveApiKey: () => resolveChatCredential(convProf),
    }).catch((error) => {
      toast.error(`Edit and resend could not complete generation preflight: ${errorMessage(error)}`);
      return null;
    });
    if (!preflight) {
      resumeEdit();
      return;
    }
    const {
      conversation: latest,
      profile: latestProf,
      resolvedKey,
    } = preflight;
    let executionState: Awaited<ReturnType<typeof captureGenerationExecutionState>>;
    try {
      executionState = await captureGenerationExecutionState(latest, latestProf, {
        apiKey: resolvedKey,
      });
    } catch (error) {
      unmarkGenerationBlockingOperation(admission.operationId);
      resumeEdit();
      toast.error(`Edit and resend could not capture generation settings: ${errorMessage(error)}`);
      return;
    }

    try {
      commitChatGenerationAdmission(admission.operationId, latest.id);
    } catch (error) {
      unmarkGenerationBlockingOperation(admission.operationId);
      resumeEdit();
      toast.info(errorMessage(error));
      return;
    }

    try {
      const replaced = await replaceFromMessage(latest.id, messageId, next, 'edit-and-resend');
      if (!replaced) {
        unmarkGenerationBlockingOperation(admission.operationId);
        resumeEdit();
        return;
      }
      // The edited durable message now owns every attachment in `next`.
      // Closing earlier would orphan newly staged blobs if preflight or the
      // branch replacement failed; closing later would keep stale UI state
      // alive after the ownership transfer already committed.
      useConversationUi.getState().finishEdit(latest.id, messageId, editSessionId);
    } catch (error) {
      unmarkGenerationBlockingOperation(admission.operationId);
      resumeEdit();
      toast.error(`Edit and resend could not replace conversation history: ${errorMessage(error)}`);
      return;
    }
    if (latest.archived) {
      useConversations.getState().unarchive(latest.id);
      toast.info(`"${latest.title}" moved back to Active`);
    }
    const assistant = appendMessage(latest.id, {
      role: 'assistant',
      content: '',
      streaming: true,
      meta: {
        model: latest.model,
        presetName: detectPresetName(latest.params),
        params: snapshotGenerationParams(latest.params, latestProf.apiVariant),
        endpoint: endpointForProfile(latestProf.apiVariant, latestProf.apiStyle),
        serverName: latestProf.name,
        baseUrl: latestProf.baseUrl,
      },
    });
    if (!assistant) {
      unmarkGenerationBlockingOperation(admission.operationId);
      return;
    }

    let started: Awaited<ReturnType<typeof handoffAndRegisterGenerationSession>>;
    try {
      started = await handoffAndRegisterGenerationSession(
        admission.operationId,
        latest.id,
        assistant.id,
      );
    } catch (error) {
      unmarkGenerationBlockingOperation(admission.operationId);
      toast.error(`Edit and resend could not start generation: ${errorMessage(error)}`);
      return;
    }
    const { owner, controller } = started;

    const streamOpts = {
      convId: latest.id,
      llmClient: new LLMClient({
        baseUrl: latestProf.baseUrl,
        apiKey: resolvedKey,
        apiVariant: latestProf.apiVariant,
        apiStyle: latestProf.apiStyle,
        routing: latestProf.routing,
        providerContract: executionState.snapshot.providerContract,
        providerContractStatus: executionState.snapshot.providerContractStatus,
        ...profileRequestHeaderSettings(latestProf),
      }),
      model: latest.model,
      profile: {
        baseUrl: latestProf.baseUrl,
        apiKey: resolvedKey,
        ...profileRequestHeaderSettings(latestProf),
      },
      apiVariant: latestProf.apiVariant,
      apiStyle: latestProf.apiStyle,
      routing: latestProf.routing,
      sseReadTimeoutMin: latestProf.sse_read_timeout_min,
      generationId: owner.generationId,
      assistantMessageId: owner.assistantMessageId,
      snapshot: executionState.snapshot,
      runtimeSecrets: executionState.secrets,
      onTps: (value: number | null) => setGenerationSessionTps(latest.id, owner.generationId, value),
    };
    try {
      await runStreamWithTools(latest.id, controller.signal, streamOpts);
    } catch (error) {
      if (!controller.signal.aborted) reportGenerationError(latest.id, 'Edit and resend', error);
    } finally {
      await settleGenerationSessionAfterTerminalFlush(latest.id, owner.generationId);
    }
  }, [currentConvId, appendMessage, replaceFromMessage]);

  // Type the param via the `Conversation` type alias rather
  // than `typeof conv.params` — the latter reads `conv.params`
  // at the type level, which requires narrowing `conv` from
  // `Conversation | null` to `Conversation` first, and that
  // narrowing can't be done at parameter-annotation position
  // (only inside the function body). `Conversation['params']`
  // is the same type without requiring a non-null `conv` at
  // the annotation site.
  const onParamsChange = (next: Conversation['params']) => {
    // Guard: this callback is only ever wired to the chat
    // UI's ParamsPanel, which only renders when `conv`
    // exists — so in practice this never hits the null
    // branch. The guard is a defensive belt-and-braces so
    // a future refactor can't accidentally trigger a
    // null deref.
    if (!conv || isConversationStructurallyLocked(conv.id)) return;
    setParams(conv.id, next);
  };

  // Detect which preset the current params match. Memoized because it
  // runs on every ChatView render — which includes every streaming tick
  // when the last-message reference changes. `conv.params` itself is
  // reference-stable per conversation (only changes when the user edits
  // the params panel), so the memo is a near-perfect cache.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `conv?.params` is intentional; using the whole `conv` would invalidate the cache every streaming tick because the conversation container and messages array are shallow-copied.
  const presetName = useMemo(() => (conv ? detectPresetName(conv.params) : ''), [conv?.params]);

  // Memoize system prompt token count — only recalculates when the
  // prompt inputs actually change (tools config, system prompt text).
  // Previously ran on every streaming frame (~30-60×/s).
  const systemPromptTools = conv?.tools;
  const systemPromptText = conv?.params.system_prompt;
  const providerPresentation = resolveWorkspaceProviderPresentation(
    systemPromptTools,
    profile?.apiVariant,
  );
  const systemPromptTokens = useMemo(
    () => currentConvId
      ? countSystemPromptTokens({
          tools: systemPromptTools,
          params: { system_prompt: systemPromptText ?? '' },
        }, providerPresentation.workspacePromptEnabled)
      : 0,
    [currentConvId, systemPromptTools, systemPromptText, providerPresentation.workspacePromptEnabled],
  );
  const toolDefinitionTokens = useMemo(
    () => countToolDefinitionTokens(
      structuredToolPayload(systemPromptTools, profile?.apiVariant),
    ),
    [systemPromptTools, profile?.apiVariant],
  );

  // Exact server preflight for the token meter: the same adapter builders
  // generation calls render the next request, and the meter measures it
  // remotely only on exact countable contracts (Meta only, today). Memoized
  // so request identity — and the debounced fetch behind it — survives
  // re-renders until the conversation, target, or params actually change.
  // Nothing builds or fetches mid-turn: the meter suspends while streaming.
  // The key resolves like generation's own credential (keychain, no prompt);
  // until it resolves the meter keeps its local estimate.
  const [preflightKey, setPreflightKey] = useState<string | undefined>(undefined);
  /* eslint-disable react-hooks/exhaustive-deps -- `profile` identity churns
     per render; the three stable identity fields in the array below select
     the same credential. */
  useEffect(() => {
    let cancelled = false;
    setPreflightKey(undefined);
    const activeProfile = profile;
    if (!activeProfile) return undefined;
    resolveChatCredential(activeProfile).then(
      (key) => { if (!cancelled && key) setPreflightKey(key); },
      () => {},
    );
    return () => { cancelled = true; };
  }, [profile?.id, profile?.apiKeyRef, profile?.apiKey]);
  /* eslint-enable react-hooks/exhaustive-deps */
  const [serverPreflight, setServerPreflight] = useState<ServerTokenPreflight | undefined>();
  useEffect(() => {
    const controller = new AbortController();
    setServerPreflight(undefined);
    if (!preflightKey || !profile || !conv || busy) return () => controller.abort();
    const protocol = providerHistoryProtocol(profile.apiVariant, profile.apiStyle);
    if (protocol !== 'openai-responses' && protocol !== 'anthropic-messages') {
      return () => controller.abort();
    }
    const model = conv.model ?? '';
    void buildServerCountGenerationRequestForConversation(protocol, {
      conversation: conv,
      baseUrl: profile.baseUrl,
      apiVariant: profile.apiVariant,
      signal: controller.signal,
    }).then((generationRequest) => {
      if (!generationRequest || controller.signal.aborted) return;
      setServerPreflight({
        apiKey: preflightKey,
        // Opaque per-build identity: request contents and credentials never
        // become tracker keys, while any dependency change supersedes the
        // previous count even when two profiles share a URL.
        requestKey: crypto.randomUUID(),
        query: { baseUrl: profile.baseUrl, protocol, modelId: model },
        generationRequest,
      });
    }, () => {});
    return () => controller.abort();
  }, [preflightKey, profile, conv, busy]);

  // True while a stream is in flight AND we have a tps sample. Drives
  // the "N.N tok/s" pill in the chat header.
  const showTps = tps !== null && busy;

  // Per-message dispatchers. Stable references (useCallback with
  // `[]` or `handleShowReasoning` which is also
  // stable), so passing them to MessageBubble's props keeps the
  // props reference-equal across ChatView re-renders. Combined
  // with `React.memo(MessageBubble)`, this means a bubble that
  // didn't actually change (same `message` object, same
  // `editing` boolean, same callback references) skips its
  // render entirely — no markdown re-parse, no attachment
  // hydration, no DOM diff. The dispatchers take the message
  // id as their first arg; the bubble calls them with its
  // own `message.id`. Stable callback + per-bubble id binding
  // = the React.memo fast path.
  // The edit bubble mirrors the composer's Workspace / preset buttons.
  // Wrapped rather than inlined because MessageBubble is `memo`'d — an
  // inline arrow would give every bubble a fresh prop identity on each
  // ChatView render and defeat the memo for the whole list.
  const handleOpenWorkspace = useCallback(
    () => toggleSidePanel('tools'),
    [toggleSidePanel],
  );
  const handleOpenParams = useCallback(
    () => toggleSidePanel('params'),
    [toggleSidePanel],
  );
  // `retry` already takes `(id: string)`; we just use it directly.
  // Same with `handleShowReasoning`. `editAndResend` takes
  // `(id, next)`; wrap it in a stable adapter so the bubble
  // sees a single function reference.
  const handleEdit = useCallback(
    (
      id: string,
      next: { content: string; attachments?: Attachment[] },
      editSessionId: string,
    ) => void editAndResend(id, next, editSessionId),
    [editAndResend],
  );

  // The main chat UI. Inside this block, `conv` is guaranteed
  // non-null (we only render it when `conv` exists). All the
  // `conv.X` references below are sound at runtime; TypeScript
  // can't follow the ternary, so we cast `conv` to `NonNullable`
  // once at the top of the truthy branch.
  const chatUI = conv ? (
    <div className="chat-view">
      <header className={headerHidden ? 'chat-header chat-header-hidden' : 'chat-header'}>
        <div className="chat-title">
          <h1 title={conv.title}>{conv.title}</h1>
        </div>
        <div className="chat-actions">
          {/* TPS pill sits to the left of the model picker,
             so the visual right-side cluster reads:
             [title]  [TPS]  [ModelPicker]. It only renders while a generation
             is in-flight (see `showTps` in the parent), so
             the gap between title and model picker is
             normally empty. When the pill does appear it
             acts as a live status indicator — the
             user can see at a glance that the model is
             still streaming and how fast. */}
          {showTps && (
            <span className="tps" title="Approximate generation speed">
              ~{tps!.toFixed(1)} tok/s
            </span>
          )}
          <TokenMeter
            key={conv.id}
            conv={conv}
            maxContext={modelMaxContext}
            style={tokenMeterStyle}
            systemPromptTokens={systemPromptTokens}
            toolDefinitionTokens={toolDefinitionTokens}
            toolCallingSupported={providerPresentation.toolCallingSupported}
            todoSnapshotIndex={todoSnapshots}
            providerTarget={profile ? {
              protocol: providerHistoryProtocol(profile.apiVariant, profile.apiStyle),
              model: conv.model ?? '',
              baseUrl: profile.baseUrl,
            } : undefined}
            serverPreflight={serverPreflight}
          />
          <ModelPicker />
        </div>
      </header>

      {whiteboardConversationId && (
        <WhiteboardOverlay
          key={`whiteboard-${whiteboardConversationId}`}
          conversationId={whiteboardConversationId}
          onClosed={handleWhiteboardClosed}
        />
      )}

      <PreviewOverlay
        conversationId={conv.id}
        text={activeMsg && 'reasoning' in activeMsg ? activeMsg.reasoning ?? '' : ''}
        streaming={overlayStreaming}
        open={overlayOpen && !whiteboardOpen}
        pinned={pinned}
        // The pin button is only user-toggleable when the
        // pin was set by the pin button itself. When the
        // pin was set implicitly (brain click) the button
        // is disabled — see the `pinnedByUser` docstring
        // for the rationale. The × button is always
        // enabled and is the only way to release an
        // implicit pin.
        pinTogglable={pinnedByUser}
        onPin={handleOverlayPinToggle}
        onClose={handleOverlayClose}
        tools={overlayTools}
        todos={overlayTodos}
        activeTab={overlayActiveTab}
        onTabChange={handleOverlayTabChange}
      />

      {/* Ultimate focus-mode toggle: hides sidebar + chat header */}
      <div className="focus-mode-toggle-area">
        <button
          className="focus-mode-toggle-btn"
          tabIndex={-1}
          onClick={() => {
            setHeaderHidden(h => !h);
            toggleSidebar(false);
          }}
          title={headerHidden ? 'Show sidebar & header' : 'Hide sidebar & header'}
        >
          {headerHidden ? (
            <svg viewBox="0 0 42 42" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M15 10.5V15M15 15h-4.5M15 15l-6-6M7.2 20h9.6c1.12 0 1.68 0 2.108-.218a2 2 0 0 0 .874-.874C20 18.48 20 17.92 20 16.8V7.2c0-1.12 0-1.68-.218-2.108a2 2 0 0 0-.874-.874C18.48 4 17.92 4 16.8 4H7.2c-1.12 0-1.68 0-2.108.218a2 2 0 0 0-.874.874C4 5.52 4 6.08 4 7.2v9.6c0 1.12 0 1.68.218 2.108.192.392.482.682.874.874.428.218.988.218 2.108.218Z"/></svg>
          ) : (
            <svg viewBox="0 0 42 42" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 13.5V9M9 9h4.5M9 9l6 6M7.2 20h9.6c1.12 0 1.68 0 2.108-.218a2 2 0 0 0 .874-.874C20 18.48 20 17.92 20 16.8V7.2c0-1.12 0-1.68-.218-2.108a2 2 0 0 0-.874-.874C18.48 4 17.92 4 16.8 4H7.2c-1.12 0-1.68 0-2.108.218a2 2 0 0 0-.874.874C4 5.52 4 6.08 4 7.2v9.6c0 1.12 0 1.68.218 2.108.192.392.482.682.874.874.428.218.988.218 2.108.218Z"/></svg>
          )}
        </button>
      </div>

      <div className="messages" ref={scrollRef} tabIndex={-1} onScroll={handleMessagesScroll}>
        <div className="messages-inner" onKeyDown={(e) => {
          // Skip Tab cycling through chat bubbles — redirect to
          // composer (Tab) or model picker (Shift+Tab).
          // Exception: when editing a user message, let Tab
          // cycle naturally between the textarea and buttons.
          if (e.key === 'Tab') {
            if ((e.target as HTMLElement).closest('.bubble-user.is-editing')) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) {
              // Shift+Tab: focus the model picker trigger.
              (document.querySelector('.model-picker-trigger') as HTMLElement)?.focus();
            } else {
              // Tab: focus the composer textarea.
              document.getElementById('composer-input')?.focus();
            }
          }
        }}>
        {loadingMessages && conv.messages.length === 0 && (
          <div className="messages-empty">
            <div className="loading-spinner" />
            <p className="muted">Loading messages…</p>
          </div>
        )}
        {!loadingMessages && !messageHistoryComplete && (
          <div className="messages-empty">
            <p>Conversation history could not be loaded.</p>
            <p className="muted">Reselect this chat to retry. Stored messages have not been replaced.</p>
          </div>
        )}
        {!loadingMessages && messageHistoryComplete && conv.messages.length === 0 && (
          <div className="messages-empty">
            <img src="/icons/favicon.png" alt="" className="about-modal-logo" width="48" height="48" />
            <br />
            <p>Start the conversation by typing below.</p>
            <p className="muted">
              Model: <code>{conv.model ?? '—'}</code> · Server:{' '}
              <code>{profile?.name ?? '—'}</code>
            </p>
            <br />
            <p className="muted small">
              Tip: drag, paste, or click the attach button to add file(s) or image(s) to your message.
            </p>
          </div>
        )}
        {conv.messages
          .filter((m) => m.role !== 'tool')
          .map((m, i, arr) => {
          const isLast = i === arr.length - 1;
          return (
          <MessageBubble
            key={m.id}
            conversationId={conv.id}
            message={m}
            editing={editingId === m.id}
            onOpenWorkspace={handleOpenWorkspace}
            onOpenParams={handleOpenParams}
            onCancel={m.streaming ? cancel : undefined}
            onRetry={m.role === 'user' && !busy ? retry : undefined}
            onShowReasoning={
              m.role === 'assistant' && messageHasVisibleReasoning(m)
                ? handleShowReasoning
                : undefined
            }
            onShowTools={
              m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
                ? handleShowTools
                : undefined
            }
            todoCount={m.role === 'assistant'
              ? todoSnapshots.ownedByAssistantId.get(m.id)?.total
              : undefined}
            onShowTodo={m.role === 'assistant' ? handleShowTodo : undefined}
            onEdit={
              m.role === 'user' && !busy && !editSubmitting
                ? handleEdit
                : undefined
            }
            busy={isLast && m.role === 'assistant' && busy ? true : undefined}
            lineChanges={lineChangesByAssistantId.get(m.id)}
          />
          );
        })}
        <div className="messages-bottom-spacer" />
        </div>
      </div>

      {/* While a user-message edit is open, the edit bubble IS the
          input. The Composer would visually compete with the edit
          textarea, so we hide it until the user cancels or
          resends. */}
      {editingId === null && (
      <Composer
        // Deliberately not keyed by conversation any more. The remount that
        // key forced is what destroyed the draft on every switch; draft state
        // now lives in `conversation-ui`, addressed by this ID.
        conversationId={conv.id}
        onSend={send}
        onCancel={cancel}
        busy={busy}
        disabled={loadingMessages || !messageHistoryComplete}
        sendDisabled={generationAdmissionLocked}
        sendDisabledReason={generationAdmissionBlockReason(conv.id) ?? undefined}
        // At-a-glance indicator for which preset the
        // next message will run with — "Server default"
        // / "Writer" / "Custom" — so the user can see
        // the active mode without opening the params
        // panel. Clicking the chip opens the panel for
        // quick adjustment.
        presetName={presetName}
        presetParams={conv.params}
        onOpenParams={() => toggleSidePanel('params')}
        sidePanelOpen={sidePanelOpen}
        onOpenTools={() => toggleSidePanel('tools')}
        toolsPanelOpen={sidePanelOpen && sidePanelTab === 'tools'}
        toolsEnabled={providerPresentation.toolsIndicatorOn}
        hasActiveDirs={!!(conv.tools?.allowed_roots && conv.tools.allowed_roots.length > 0)}
        pinComposer={pinComposer}
        onOpenWhiteboard={
          conv.tools?.enabled && conv.tools.whiteboard_enabled
            ? () => { void handleOpenWhiteboard(); }
            : undefined
        }
        whiteboardOpen={whiteboardOpen}
      />
      )}

      <SidePanel
        key={`side-${conv.id}`}
        open={sidePanelOpen}
        activeTab={sidePanelTab}
        onTabChange={(tab) => toggleSidePanel(tab)}
        onClose={handleCloseSidePanel}
        workspaceSections={presentationUi.workspaceSections}
        onWorkspaceSectionChange={setWorkspaceSection}
        workspaceExpandedDir={presentationUi.workspaceExpandedDir}
        onWorkspaceExpandedDirChange={setWorkspaceExpandedDir}
        params={conv.params}
        onChange={onParamsChange}
        tools={conv.tools}
        onOpenWhiteboard={() => { void handleOpenWhiteboard(); }}
        onToolsChange={async (next) => {
          const ownWhiteboardInitialization = whiteboardInitializationCoordinator.isActive(conv.id);
          if (
            isConversationStructurallyLocked(conv.id)
            && !ownWhiteboardInitialization
          ) return false;
          // Keep a stable identity for the absent-config snapshot. The
          // Whiteboard first-enable gate uses identity to distinguish "no
          // intervening write" from a newer Workspace-off decision.
          const absentToolsSnapshot = {
            ...next,
            enabled: false,
            whiteboard_enabled: false,
          };
          let toolsConfigChangeCoordinator = toolsConfigChangeCoordinatorsRef.current.get(conv.id);
          if (!toolsConfigChangeCoordinator) {
            toolsConfigChangeCoordinator = createWhiteboardToolsConfigChangeCoordinator();
            toolsConfigChangeCoordinatorsRef.current.set(conv.id, toolsConfigChangeCoordinator);
          }
          try {
            return await whiteboardInitializationCoordinator.run(
              conv.id,
              (initialize) => toolsConfigChangeCoordinator.apply({
                next,
                getCurrent: () => {
                  const current = useConversations.getState().byId[conv.id];
                  if (!current) return null;
                  return current.tools ?? absentToolsSnapshot;
                },
                initialize,
                commit: (accepted) => patchConversation(conv.id, { tools: accepted }),
              }),
            );
          } catch (error) {
            // The category is never persisted on before both immutable
            // baselines exist. A failed initialization therefore leaves the
            // model tool and composer entry point hidden.
            toast.error(`${WHITEBOARD_UI_TEXT.couldNotInitialize} ${errorMessage(error)}`);
            return false;
          }
        }}
        apiVariant={profile?.apiVariant}
        customSkills={conv.custom_skills}
        onCustomSkillsChange={(next) => {
          if (isConversationStructurallyLocked(conv.id)) return;
          patchConversation(conv.id, { custom_skills: next });
        }}
        onOpenRootsEditor={() => {
          if (isConversationStructurallyLocked(conv.id)) return;
          setNmpOpen(true);
        }}
        locked={busy || selectedConversationLocked}
        onGetSystemPrompt={async () => {
          const c = useConversations.getState().byId[conv.id];
          if (!c) return '(no active conversation)';
          const tools = c.tools;
          const hasTools = resolveWorkspaceProviderPresentation(
            tools,
            profile?.apiVariant,
          ).workspacePromptEnabled;
          let text = hasTools
            ? await buildSystemPrompt(c)
            : (c.params.system_prompt?.trim() ?? '(no system prompt)');
          if (hasTools && tools) {
            const exposed = [...resolveExposure(tools).exposedHandlers].map((handler) => handler.name);
            text += `\n\n[Exposed tool definitions]\n${exposed.join('\n')}`;
          }
          return text;
        }}
      />
      <WorkspaceManager
        open={nmpOpen && !busy && !selectedConversationLocked}
        activeRoots={conv.tools?.allowed_roots ?? []}
        knownDirs={toolsDefaults}
        onChange={(next) => {
          if (isConversationStructurallyLocked(conv.id)) return;
          const baseTools = conv.tools ?? {
            enabled: false,
            tool_grants: [] as string[],
            web_access_grants_initialized: false,
            skills_initialized: false,
            file_io_enabled: false,
            shell_enabled: false,
            web_access_enabled: false,
            allowed_roots: [] as string[],
            dir_permissions: {} as Record<string, string[]>,
            max_tool_rounds_per_turn: 128,
            max_tool_calls_per_batch: DEFAULT_TOOL_BATCH_LIMIT,
            sse_read_timeout_min: useProfileStore.getState().profiles.find((p) => p.id === conv.serverId)?.sse_read_timeout_min ?? 5,
          };
          // Phase 1.4: Pre-seed dir_permissions for new roots with the
          // 7 read-only tools only. Mutating tools (write_file, edit,
          // apply_patch) require explicit user opt-in via popup or checkboxes.
          const nextDirPerms = { ...baseTools.dir_permissions };
          for (const r of next) {
            if (!nextDirPerms[r]) {
              nextDirPerms[r] = [...FILE_IO_READ_ONLY_NAMES];
            }
          }
          // Remove permissions for roots that were removed.
          for (const r of Object.keys(nextDirPerms)) {
            if (!next.includes(r)) delete nextDirPerms[r];
          }
          patchConversation(conv.id, {
            tools: {
              ...baseTools,
              enabled: baseTools.enabled,
              allowed_roots: next,
              dir_permissions: nextDirPerms,
            },
          });
        }}
        onClose={() => setNmpOpen(false)}
        onAddKnownDir={(path) => {
          if (isAnyStreaming() || isGenerationBlockingOperationActive()) return;
          const s = useSettings.getState();
          const current = s.tools.default_allowed_roots;
          if (!current.some((r) => cleanPath(r) === path)) {
            s.setTools({ ...s.tools, default_allowed_roots: [...current, path] });
          }
        }}
      />
    </div>
  ) : null;

  return chatUI ?? <EmptyState />;
}
