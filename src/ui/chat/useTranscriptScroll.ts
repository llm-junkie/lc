import { useCallback, useLayoutEffect, useRef } from 'react';
import { useConversationUi } from '../../store/conversation-ui.ts';

interface TranscriptScrollOptions {
  conversationId: string | undefined;
  activeGenerationId: string | undefined;
  activeGenerationAssistantId: string | undefined;
  completedAssistantMessageId: string | undefined;
}

interface TranscriptResizeAnchor {
  element: HTMLElement;
  offsetTop: number;
}

interface ObservedGeneration {
  conversationId: string;
  generationId: string;
  assistantMessageId: string;
}

export function useTranscriptScroll({
  conversationId,
  activeGenerationId,
  activeGenerationAssistantId,
  completedAssistantMessageId,
}: TranscriptScrollOptions) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const resizeAnchorRef = useRef<TranscriptResizeAnchor | null>(null);
  const observedGenerationRef = useRef<ObservedGeneration | null>(null);

  const captureResizeAnchor = useCallback(() => {
    const container = scrollRef.current;
    if (!container) {
      resizeAnchorRef.current = null;
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const probeX = containerRect.left + containerRect.width / 2;
    for (const offset of [1, 12, 32, 64]) {
      const probeY = Math.min(containerRect.top + offset, containerRect.bottom - 1);
      const hit = document.elementFromPoint(probeX, probeY);
      const bubble = hit instanceof Element ? hit.closest<HTMLElement>('.bubble') : null;
      if (
        bubble
        && container.contains(bubble)
        && bubble.parentElement?.classList.contains('messages-inner')
      ) {
        resizeAnchorRef.current = {
          element: bubble,
          offsetTop: bubble.getBoundingClientRect().top - containerRect.top,
        };
        return;
      }
    }

    // The probe can land on an overlay, a bubble margin, or the bottom spacer.
    // Fall back to the nearest real transcript bubble in those uncommon cases.
    const bubbles = Array.from(
      container.querySelectorAll<HTMLElement>('.messages-inner > .bubble'),
    );
    let firstVisible: HTMLElement | null = null;
    let nearestAbove: HTMLElement | null = null;
    let nearestBelow: HTMLElement | null = null;

    for (const bubble of bubbles) {
      const rect = bubble.getBoundingClientRect();
      if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
        firstVisible = bubble;
        break;
      }
      if (rect.bottom <= containerRect.top) {
        nearestAbove = bubble;
      } else if (rect.top >= containerRect.bottom) {
        nearestBelow = bubble;
        break;
      }
    }

    // At the absolute bottom, the fixed breathing-room spacer can fill the
    // viewport and leave the last real bubble just above it. Keep that bubble
    // as the resize anchor instead of treating the spacer as transcript data.
    const element = firstVisible ?? nearestAbove ?? nearestBelow;
    resizeAnchorRef.current = element
      ? { element, offsetTop: element.getBoundingClientRect().top - containerRect.top }
      : null;
  }, []);

  const handleMessagesScroll = useCallback(() => {
    if (!conversationId) return;
    const element = scrollRef.current;
    if (!element) return;
    const nextFollowOutput =
      element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    const current = useConversationUi.getState().get(conversationId);
    if (
      Math.abs(current.scrollTop - element.scrollTop) < 0.5
      && current.followOutput === nextFollowOutput
    ) return;
    useConversationUi.getState().setPresentation(conversationId, {
      scrollTop: element.scrollTop,
      followOutput: nextFollowOutput,
    });
    captureResizeAnchor();
  }, [captureResizeAnchor, conversationId]);

  // Stored scroll state is a conversation-switch restore point, not a second
  // controller for the currently visible scroll container. Feeding every
  // onScroll update back into the DOM races the explicit Send jump and can pull
  // the chat upward again.
  useLayoutEffect(() => {
    if (!conversationId) return;
    const element = scrollRef.current;
    if (!element) return;
    const savedScrollTop = useConversationUi.getState().get(conversationId).scrollTop;
    element.scrollTo({
      top: savedScrollTop,
      behavior: 'instant' as ScrollBehavior,
    });
    captureResizeAnchor();
  }, [captureResizeAnchor, conversationId]);

  // The older single-chat UI relied on native anchoring during width reflow.
  // Keep that stable visual behavior while preserving per-conversation scroll
  // state: if browser anchoring cannot select a real bubble (for example when
  // the bottom spacer fills the viewport), compensate only for container-size
  // changes. Content growth alone does not trigger this observer and therefore
  // cannot become streaming auto-follow.
  useLayoutEffect(() => {
    if (!conversationId) return;
    const container = scrollRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    let previousWidth = container.clientWidth;
    let previousHeight = container.clientHeight;

    const observer = new ResizeObserver(() => {
      const nextWidth = container.clientWidth;
      const nextHeight = container.clientHeight;
      if (nextWidth === previousWidth && nextHeight === previousHeight) return;
      previousWidth = nextWidth;
      previousHeight = nextHeight;

      const anchor = resizeAnchorRef.current;
      if (anchor?.element.isConnected && container.contains(anchor.element)) {
        const containerTop = container.getBoundingClientRect().top;
        const nextOffsetTop = anchor.element.getBoundingClientRect().top - containerTop;
        const offsetDelta = nextOffsetTop - anchor.offsetTop;
        if (Math.abs(offsetDelta) >= 0.5) {
          container.scrollTop += offsetDelta;
        }
      }

      captureResizeAnchor();
      const current = useConversationUi.getState().get(conversationId);
      const nextFollowOutput =
        container.scrollHeight - container.scrollTop - container.clientHeight < 48;
      if (
        Math.abs(current.scrollTop - container.scrollTop) >= 0.5
        || current.followOutput !== nextFollowOutput
      ) {
        useConversationUi.getState().setPresentation(conversationId, {
          scrollTop: container.scrollTop,
          followOutput: nextFollowOutput,
        });
      }
    });

    observer.observe(container);
    captureResizeAnchor();
    return () => observer.disconnect();
  }, [captureResizeAnchor, conversationId]);

  // A successfully completed foreground turn gets one calm, browser-native
  // smooth scroll after its final DOM has committed. Tracking both generation
  // and assistant IDs prevents a background completion, chat switch, cancelled
  // run, or already-completed transcript load from moving the visible chat.
  useLayoutEffect(() => {
    if (
      conversationId
      && activeGenerationId
      && activeGenerationAssistantId
    ) {
      observedGenerationRef.current = {
        conversationId,
        generationId: activeGenerationId,
        assistantMessageId: activeGenerationAssistantId,
      };
      return;
    }

    const observed = observedGenerationRef.current;
    observedGenerationRef.current = null;
    if (
      !conversationId
      || !observed
      || observed.conversationId !== conversationId
      || observed.assistantMessageId !== completedAssistantMessageId
    ) return;

    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({
      top: element.scrollHeight,
      behavior: 'smooth',
    });
  }, [
    activeGenerationAssistantId,
    activeGenerationId,
    completedAssistantMessageId,
    conversationId,
  ]);

  // One explicit post-Send jump makes the appended user bubble and empty
  // assistant placeholder visible. Streaming reasoning and answer updates do
  // not move the transcript; the user owns its position after this jump.
  // Synchronize the stored position in the same operation so no stale restore
  // can pull the active chat upward.
  const scrollToBottom = useCallback(() => {
    if (!conversationId) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({
      top: element.scrollHeight,
      behavior: 'instant' as ScrollBehavior,
    });
    captureResizeAnchor();
    useConversationUi.getState().setPresentation(conversationId, {
      scrollTop: element.scrollTop,
      followOutput: true,
    });
  }, [captureResizeAnchor, conversationId]);

  return { scrollRef, handleMessagesScroll, scrollToBottom };
}
