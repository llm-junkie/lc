/** Renders model reasoning. Used by PreviewOverlay's Reasoning tab. Completed
 * values above the initial budget start as a bounded tail and can be expanded
 * progressively without losing the reader's scroll position. */

import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import {
  buildReasoningChunkStarts,
  isCompletedReasoningOverBudget,
  selectCompletedReasoningWindow,
} from '../../utils/reasoningPreview.ts';
import { ChunkedMarkdown } from './ChunkedMarkdown.tsx';

export interface ReasoningBodyProps {
  text: string;
  /** When true, constrain the live preview to a fixed render budget. */
  streaming?: boolean;
  /** Completed-reasoning render budget for this overlay session. */
  completedWindowChars: number;
  /** Expands the completed-reasoning budget without remounting the overlay. */
  onCompletedWindowCharsChange: (chars: number) => void;
}

interface PendingScrollAnchor {
  element: HTMLElement;
  anchorChunkIndex: number | null;
  anchorTop: number;
  scrollHeight: number;
  scrollTop: number;
  scrollLeft: number;
}

function ReasoningBodyBase({
  text,
  streaming = false,
  completedWindowChars,
  onCompletedWindowCharsChange,
}: ReasoningBodyProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollAnchorRef = useRef<PendingScrollAnchor | null>(null);

  const completedOverBudget = useMemo(
    () => !streaming && isCompletedReasoningOverBudget(text),
    [streaming, text],
  );
  const chunkStarts = useMemo(
    () => completedOverBudget ? buildReasoningChunkStarts(text) : undefined,
    [completedOverBudget, text],
  );
  const preview = useMemo(
    () => completedOverBudget
      ? selectCompletedReasoningWindow(
          text,
          completedWindowChars,
          chunkStarts,
        )
      : { mode: 'markdown' as const, text, omittedLeadingChars: 0 },
    [chunkStarts, completedOverBudget, completedWindowChars, text],
  );

  // Expanding prepends content. Keep a stable visible chunk at the same pixel
  // position. The scroll-height fallback only applies if React cannot retain
  // that chunk node for an unexpected reason.
  useLayoutEffect(() => {
    const pending = pendingScrollAnchorRef.current;
    if (!pending) return;
    pendingScrollAnchorRef.current = null;

    let usedFallback = false;
    const restoreAnchor = () => {
      const anchorElement = pending.anchorChunkIndex === null
        ? null
        : rootRef.current?.querySelector<HTMLElement>(
            `[data-reasoning-chunk-index="${pending.anchorChunkIndex}"]`,
          ) ?? null;
      if (anchorElement) {
        pending.element.scrollTop +=
          anchorElement.getBoundingClientRect().top - pending.anchorTop;
      } else if (!usedFallback) {
        usedFallback = true;
        pending.element.scrollTop =
          pending.scrollTop +
          (pending.element.scrollHeight - pending.scrollHeight);
      }
      pending.element.scrollLeft = pending.scrollLeft;
    };

    // The first correction runs before paint. Brief follow-ups absorb delayed
    // intrinsic-size corrections from content-visibility; they stop after a
    // small bounded number of frames and only run after an explicit expansion.
    restoreAnchor();
    let frames = 0;
    let raf = requestAnimationFrame(function followIntrinsicSizeChanges() {
      restoreAnchor();
      frames += 1;
      if (frames < 12) {
        raf = requestAnimationFrame(followIntrinsicSizeChanges);
      }
    });
    const settleTimer = window.setTimeout(restoreAnchor, 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
    };
  }, [preview.omittedLeadingChars]);

  if (!text) {
    return (
      <div className="reasoning-body-empty">
        No reasoning for this turn.
      </div>
    );
  }

  if (completedOverBudget) {
    const visibleChars = preview.text.length;
    const hasEarlier = preview.omittedLeadingChars > 0;
    const firstChunkIndex = preview.mode === 'markdown'
      ? Math.max(0, chunkStarts?.indexOf(preview.omittedLeadingChars) ?? 0)
      : 0;
    // Double the actual visible window as well as the nominal budget. This
    // guarantees that an unusually large atomic chunk cannot make a click a
    // no-op while still preserving chunk-aligned boundaries.
    const nextWindowChars = Math.min(
      text.length,
      Math.max(completedWindowChars * 2, visibleChars * 2),
    );

    const handleShowEarlier = () => {
      const element = rootRef.current?.closest<HTMLElement>(
        '.preview-overlay-body',
      );
      if (element) {
        const bodyTop = element.getBoundingClientRect().top;
        const controlsHeight =
          rootRef.current
            ?.querySelector<HTMLElement>('.reasoning-window-controls')
            ?.getBoundingClientRect().height ?? 0;
        const anchorElement = Array.from(
          rootRef.current?.querySelectorAll<HTMLElement>(
            '.reasoning-markdown-chunk',
          ) ?? [],
        ).find((chunk) => (
          chunk.getBoundingClientRect().bottom > bodyTop + controlsHeight
        )) ?? null;
        pendingScrollAnchorRef.current = {
          element,
          anchorChunkIndex: anchorElement
            ? Number(anchorElement.dataset.reasoningChunkIndex)
            : null,
          anchorTop: anchorElement?.getBoundingClientRect().top ?? bodyTop,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
          scrollLeft: element.scrollLeft,
        };
      }
      onCompletedWindowCharsChange(nextWindowChars);
    };

    return (
      <div ref={rootRef} className="reasoning-progressive-markdown">
        {hasEarlier && (
          <div className="reasoning-window-controls">
            <button
              type="button"
              className="reasoning-window-expand"
              onClick={handleShowEarlier}
              aria-label="Extend reasoning preview to twice the current window"
            >
              CLICK TO EXTEND PREVIEW WINDOW
            </button>
          </div>
        )}
        {preview.mode === 'plain-tail' ? (
          <div className="reasoning-live-window">
            <div className="reasoning-live-notice" role="status">
              This completed reasoning ends with a Markdown block larger than
              the preview window, so its bounded tail is shown as plain text.
              Copy still includes the complete reasoning.
            </div>
            <pre className="reasoning-live-plain">{preview.text}</pre>
          </div>
        ) : (
          <ChunkedMarkdown
            text={preview.text}
            streaming={false}
            chunkKeyOffset={firstChunkIndex}
          />
        )}
      </div>
    );
  }

  return (
    <ChunkedMarkdown
      text={preview.text}
      streaming={streaming}
      liveSurface={streaming ? 'reasoning' : undefined}
    />
  );
}

export const ReasoningBody = memo(ReasoningBodyBase);
