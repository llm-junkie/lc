/**
 * Reasoning + Tools preview overlay.
 *
 * Floats at the top of the conversation window (above the messages
 * container, anchored like the composer-wrap), so its height changes
 * NEVER affect the messages container's scrollHeight. This is the
 * structural fix for the "scroll gets stuck at the bottom after a
 * long stream" bug — the old in-bubble `<details>` collapsed mid-
 * render and corrupted the parent's cached scroll bounds.
 *
 * Three-tab layout:
 *   - [Reasoning] — model's thinking text, rendered as Markdown.
 *   - [Tools]     — list of tool calls with status / args / result.
 *   - [To do list] — the task snapshot at the selected message.
 *
 * The active tab follows the stream's natural phase:
 *   - reasoning incoming → default to Reasoning tab.
 *   - reasoning ended + tool_calls landed → default to Tools tab.
 *   - User manual click → sticky override for this stream session
 *     (so they're not yanked back while reading an older turn).
 *   - Reset on stream end / message change.
 *
 * Visibility:
 *   - auto-shows the moment reasoning OR tool activity starts in
 *     the current conversation
 *   - auto-hides when reasoning finishes (transitions to content)
 *     UNLESS tools are in flight, in which case the tab is the
 *     Tools tab and we keep showing
 *   - can be re-opened by clicking a bubble's 🧠 or 🛠 button
 *   - has a manual × close button for force-hide
 *   - has a 📌 pin button (plan §7.1 unchanged from v1)
 */

import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../../store/settings.ts';
import { onPhaseChange, getPhase } from '../../store/responseStatus.ts';
import { COMPLETED_REASONING_INITIAL_WINDOW_CHARS } from '../../utils/reasoningPreview.ts';
import { ReasoningBody } from '../chat/ReasoningBody.tsx';
import { useThrottledWhile } from '../chat/useThrottledWhile.ts';
import { ToolsBody, type ToolCallItem } from './ToolsBody.tsx';
import { TodoBody, TODO_UI_TEXT } from './TodoBody.tsx';
import { todoSnapshotToPlainText, type TodoSnapshot } from '../../modules/tool-engine/index.ts';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';

/** Floor for the overlay height. Matches the prior CSS
 *  `max-height: 175px` so the default appearance doesn't
 *  change for users who never resize. */
const OVERLAY_MIN_HEIGHT = 175;
/** Ceiling for the overlay height. 60vh keeps the overlay
 *  from covering the composer at the bottom of the chat. */
const OVERLAY_MAX_HEIGHT_VH = 60;

export type PreviewTab = 'reasoning' | 'tools' | 'todo';

interface Props {
  /** Conversation whose generation owns the pulse indicators. */
  conversationId: string;
  /** Reasoning text to display. Empty string means "nothing to show". */
  text: string;
  /** True while the model is still emitting reasoning tokens. */
  streaming: boolean;
  /** Whether the overlay should be visible right now. */
  open: boolean;
  /** Whether the overlay is pinned open. */
  pinned: boolean;
  /** Whether the user is allowed to *toggle* the pin from
   *  the pin button. False when the pin was set implicitly
   *  (e.g. by clicking a bubble's brain icon). */
  pinTogglable: boolean;
  /** User clicked the 📌 button — toggle pinned. */
  onPin: () => void;
  /** User clicked the × — they want the overlay gone. */
  onClose: () => void;
  /** Tool calls to display in the Tools tab. Each item has
   *  the call, an optional result, and a `running` flag. */
  tools?: ToolCallItem[];
  /** Todo snapshots visible in the selected assistant message's user turn. */
  todos?: readonly TodoSnapshot[];
  /** The active tab is owned by ChatView. */
  activeTab: PreviewTab;
  onTabChange: (tab: PreviewTab) => void;
}

export function PreviewOverlay({
  conversationId,
  text,
  streaming,
  open,
  pinned,
  pinTogglable,
  onPin,
  onClose,
  tools,
  todos,
  activeTab,
  onTabChange,
}: Props) {
  useOverlayEscape(onClose, open);

  // Publish reasoning and run layout-dependent auto-scroll on one cadence.
  // The raw value remains available to Copy without driving Markdown renders.
  const displayText = useThrottledWhile(text, 42, streaming);

  // The body is wrapped in this ref so the auto-scroll effect
  // (below) can keep the bottom pinned during streaming — but
  // only when the user hasn't scrolled up to read.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [reasoningWindow, setReasoningWindow] = useState({
    source: '',
    chars: COMPLETED_REASONING_INITIAL_WINDOW_CHARS,
  });

  // A different completed reasoning starts with a fresh window. During a live
  // stream this completed-reasoning budget is unused, so avoid resetting it
  // for every throttled token update.
  let completedWindowChars = COMPLETED_REASONING_INITIAL_WINDOW_CHARS;
  if (!streaming) {
    if (reasoningWindow.source === displayText) {
      completedWindowChars = reasoningWindow.chars;
    } else {
      setReasoningWindow({
        source: displayText,
        chars: COMPLETED_REASONING_INITIAL_WINDOW_CHARS,
      });
    }
  }

  // Closing ends the overlay session. Reset while the expensive body is
  // unmounted so reopening cannot briefly mount the previous large window.
  useEffect(() => {
    if (open) return;
    setReasoningWindow({
      source: '',
      chars: COMPLETED_REASONING_INITIAL_WINDOW_CHARS,
    });
  }, [open]);

  // Resize logic (unchanged from v1).
  const storedHeight = useSettings((s) => s.previewOverlayHeight);
  const setStoredHeight = useSettings((s) => s.setPreviewOverlayHeight);
  const [liveHeight, setLiveHeight] = useState<number>(storedHeight);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  // ---- Pulse indicator refs -----------------------------------------
  // The pulse dots on the Reasoning and Tools tabs are toggled
  // imperatively via the responseStatus event emitter — zero React
  // re-renders.  This avoids the per-token render thrash that froze
  // the UI during fast streaming.
  const reasoningPulseRef = useRef<HTMLSpanElement | null>(null);
  const toolsPulseRef = useRef<HTMLSpanElement | null>(null);

  // Subscribe to the response-status emitter to update the pulse indicators.
  useEffect(() => {
    const unsub = onPhaseChange(conversationId, (phase, changed) => {
      // --- Reasoning pulse ---
      if (changed.includes('reasoning')) {
        const dot = reasoningPulseRef.current;
        if (dot) {
          const active = phase.reasoning === 'running' || phase.reasoning === 'started';
          dot.style.display = active ? 'inline-block' : 'none';
        }
      }
      // --- Tools pulse ---
      if (changed.includes('toolUse')) {
        const dot = toolsPulseRef.current;
        if (dot) {
          const active = phase.toolUse === 'running' || phase.toolUse === 'started';
          dot.style.display = active ? 'inline-block' : 'none';
        }
      }
    });
    // Sync initial state (in case the emitter already fired before
    // this component mounted).
    const initial = getPhase(conversationId);
    const toolDot = toolsPulseRef.current;
    if (toolDot) {
      toolDot.style.display = initial.toolUse === 'running' || initial.toolUse === 'started'
        ? 'inline-block'
        : 'none';
    }
    return unsub;
  }, [conversationId]);

  useEffect(() => {
    if (dragRef.current === null) {
      setLiveHeight(storedHeight);
    }
  }, [storedHeight]);

  const overlayRef = useRef<HTMLDivElement | null>(null);

  // Focus management: when the overlay closes, kick focus out of
  // any descendants that might still hold it.
  useEffect(() => {
    if (open) return;
    const active = document.activeElement;
    if (active && active instanceof Element && overlayRef.current?.contains(active)) {
      document.querySelector<HTMLElement>('.messages')?.focus();
    }
  }, [open]);

  const computeMax = () =>
    Math.max(OVERLAY_MIN_HEIGHT, Math.floor((window.innerHeight * OVERLAY_MAX_HEIGHT_VH) / 100));

  const clamp = (px: number) => {
    const max = computeMax();
    return Math.min(max, Math.max(OVERLAY_MIN_HEIGHT, Math.floor(px)));
  };

  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startHeight: liveHeight,
    };
  };

  const handleResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    const deltaY = e.clientY - drag.startY;
    const next = clamp(drag.startHeight + deltaY);
    setLiveHeight(next);
  };

  const handleResizeEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    dragRef.current = null;
    setStoredHeight(liveHeight);
  };

  const handleResizeDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setLiveHeight(OVERLAY_MIN_HEIGHT);
    setStoredHeight(OVERLAY_MIN_HEIGHT);
  };

  // The count drives the badge without observing result-content changes.
  const toolCount = tools?.length ?? 0;
  const todoCount = todos?.at(-1)?.total ?? 0;

  // Auto-scroll the body to the bottom during streaming — only
  // when the user is already near the bottom.
  useEffect(() => {
    if (!open || !streaming || activeTab !== 'reasoning') return;
    const el = bodyRef.current;
    if (!el) return;
    const tick = () => {
      rafRef.current = null;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance > 80) return;
      el.scrollTop = el.scrollHeight;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [displayText, open, streaming, activeTab]);

  // Scroll to bottom when the overlay opens (re-opening shows
  // finished reasoning — no streaming to drive the auto-scroll above).
  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (!el) return;
    // Keep following the bottom briefly while content-visibility resolves the
    // newly mounted chunks' intrinsic sizes. This only runs for a closedâ†’open
    // transition, so switching tabs later preserves the reader's position.
    const scrollToEnd = () => {
      el.scrollTop = el.scrollHeight;
    };
    let frames = 0;
    let raf = requestAnimationFrame(function followOpeningLayout() {
      scrollToEnd();
      frames += 1;
      if (frames < 12) {
        raf = requestAnimationFrame(followOpeningLayout);
      }
    });
    const settleTimer = window.setTimeout(scrollToEnd, 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
    };
  }, [open]);

  // Copy state — flash a checkmark for 1.5s after copying.
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    let content: string;
    if (activeTab === 'reasoning') {
      content = text || '';
    } else if (activeTab === 'tools') {
      // Tools tab: build a plain-text summary of all tool calls.
      const items = tools ?? [];
      content = items
        .map((t) => {
          const status = t.isRunning ? 'running' : t.result ? (t.result.is_error ? 'error' : 'ok') : 'pending';
          const args = t.call.arguments ? ` ${t.call.arguments}` : '';
          const result = t.result ? ` → ${t.result.output}` : '';
          return `[${status}] ${t.call.name}${args}${result}`;
        })
        .join('\n') || '(no tool calls)';
    } else {
      content = todos?.length
        ? todos.map(todoSnapshotToPlainText).join('\n\n')
        : TODO_UI_TEXT.copyEmpty;
    }
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — ignore */ }
  };

  return (
    <div
      ref={overlayRef}
      /* `is-open` only. This element used to also carry `is-streaming` and
         `is-pinned`; neither had a rule in `index.css` or `solid.css`, in any
         mode, and had not since the panel was renamed from `.reasoning-overlay`
         The previous rename moved index.css and the component but left
         solid.css behind, and the one rule that styled `is-streaming` died with
         the old class name.

         Both states are still signalled, just not from here: pinned by
         `.preview-overlay-pin.is-active` plus `aria-pressed` on the pin button,
         streaming by the tab auto-switch, the body auto-scroll, and
         `ReasoningBody`'s own streaming affordance. An unstyled state class on
         a live element is exactly the condition that let the original rot go
         unnoticed for months, so these are removed rather than left dangling. */
      className={`preview-overlay ${open ? 'is-open' : ''}`}
      role="region"
      aria-label="Reasoning, tools, and to do preview"
      inert={!open}
    >
      <div
        className="preview-overlay-inner"
        style={{ height: `${liveHeight}px`, minHeight: `${OVERLAY_MIN_HEIGHT}px` }}
      >
        <div className="preview-overlay-head">
          <div className="preview-overlay-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'reasoning'}
              aria-label="Reasoning"
              title="Reasoning"
              className={`preview-overlay-tab ${activeTab === 'reasoning' ? 'is-active' : ''}`}
              onClick={() => onTabChange('reasoning')}
            >
              <span className="preview-overlay-tab-icon" aria-hidden>
                  <svg viewBox="2 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.5 4a3 3 0 0 0-3 3v.5A3 3 0 0 0 5 10v1a3 3 0 0 0 1.5 2.6V14a3 3 0 0 0 3 3h.5" />
                    <path d="M14.5 4a3 3 0 0 1 3 3v.5A3 3 0 0 1 19 10v1a3 3 0 0 1-1.5 2.6V14a3 3 0 0 1-3 3H14" />
                    <path d="M12 8v6" />
                    <path d="M9.5 11h5" />
                    <path d="M10 14h4" />
                  </svg>
              </span>
              <span className="preview-overlay-tab-label">Reasoning</span>
              <span
                ref={reasoningPulseRef}
                className="preview-overlay-tab-pulse"
                style={{ display: 'none' }}
                aria-hidden
              />
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'tools'}
              aria-label="Tools"
              title="Tools"
              className={`preview-overlay-tab ${activeTab === 'tools' ? 'is-active' : ''}`}
              onClick={() => onTabChange('tools')}
            >
              <span className="preview-overlay-tab-icon" aria-hidden>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M5.33 3.271a3.5 3.5 0 0 1 4.254 4.963l10.709 10.71-1.414 1.414-10.71-10.71a3.502 3.502 0 0 1-4.962-4.255L5.444 7.63a1.5 1.5 0 1 0 2.121-2.121L5.329 3.27zm10.367 1.884l3.182-1.768 1.414 1.414-1.768 3.182-1.768.354-2.12 2.121-1.415-1.414 2.121-2.121.354-1.768zm-6.718 8.132l1.414 1.414-5.303 5.303a1 1 0 0 1-1.492-1.327l.078-.087 5.303-5.303z" />
                  </svg>
              </span>
              <span className="preview-overlay-tab-label">Tools</span>
              <span
                ref={toolsPulseRef}
                className="preview-overlay-tab-pulse"
                style={{ display: 'none' }}
                aria-hidden
              />
              {toolCount > 0 && (
                <span className="preview-overlay-tab-badge">{toolCount}</span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'todo'}
              aria-label={TODO_UI_TEXT.region}
              title={TODO_UI_TEXT.region}
              className={`preview-overlay-tab ${activeTab === 'todo' ? 'is-active' : ''}`}
              onClick={() => onTabChange('todo')}
            >
              <span className="preview-overlay-tab-icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6h11M9 12h11M9 18h11" />
                  <path d="m3.5 6 1.2 1.2L7 4.8M3.5 12l1.2 1.2L7 10.8M3.5 18l1.2 1.2L7 16.8" />
                </svg>
              </span>
              <span className="preview-overlay-tab-label">{TODO_UI_TEXT.region}</span>
              {todoCount > 0 && (
                <span className="preview-overlay-tab-badge">{todoCount}</span>
              )}
            </button>
          </div>
          <button
            type="button"
            className={`preview-overlay-pin${pinned ? ' is-active' : ''}${pinned && !pinTogglable ? ' is-locked' : ''}`}
            onClick={onPin}
            disabled={pinned && !pinTogglable}
            aria-label={
              pinned && !pinTogglable
                ? 'Pinned (locked) — close to release'
                : pinned
                ? 'Unpin preview'
                : 'Pin preview'
            }
            aria-pressed={pinned}
            title={
              pinned && !pinTogglable
                ? 'Pinned (locked). The user opened this from a bubble — close to release.'
                : pinned
                ? 'Unpin — close to hide, will auto-hide on stream end'
                : 'Pin — keep open across streams, follow the newest action'
            }
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M7.99927 3V8.5C6.17801 9.86834 5 12.0466 5 14.5V15H12H19V14.5C19 12.0466 17.822 9.86834 16.0007 8.5V3M6 3H18M12 10V21" />
            </svg>
          </button>
          <button
            type="button"
            className="preview-overlay-copy"
            onClick={handleCopy}
            aria-label="Copy active tab"
            title="Copy active tab content"
          >
            {copied ? (
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="preview-overlay-close"
            onClick={onClose}
            aria-label="Close preview"
            title="Close"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 6 L18 18 M18 6 L6 18" />
            </svg>
          </button>
        </div>
        <div className="preview-overlay-body" ref={bodyRef} tabIndex={-1}>
          {open && (activeTab === 'reasoning' ? (
            <ReasoningBody
              text={displayText}
              streaming={streaming}
              completedWindowChars={completedWindowChars}
              onCompletedWindowCharsChange={(chars) => {
                setReasoningWindow({ source: displayText, chars });
              }}
            />
          ) : activeTab === 'tools' ? (
            <ToolsBody items={tools ?? []} />
          ) : (
            <TodoBody snapshots={todos} />
          ))}
        </div>
        <div
          className="preview-overlay-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize preview"
          title="Drag to resize. Double-click to reset to default."
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onDoubleClick={handleResizeDoubleClick}
        />
      </div>
    </div>
  );
}
