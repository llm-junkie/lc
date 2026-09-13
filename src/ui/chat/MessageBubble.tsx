import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  beginConversationUiWork,
  EMPTY_CONVERSATION_UI,
  useConversationUi,
} from '../../store/conversation-ui.ts';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Attachment, Message } from '../../types';
import type { FileLineChanges } from '../../modules/tool-engine/file-line-changes';
import { ChunkedMarkdown } from './ChunkedMarkdown.tsx';
import { formatDateTime, formatBytes } from '../../utils/format.ts';
import { cn } from '../../utils/cn.ts';
import { hydrateAttachments, fileToAttachment, isAllowedAttachment, langFromMime, langFromName, decodeDataUrlAsUtf8 } from '../../utils/attachments.ts';
import { downloadAttachment } from '../../utils/downloadAttachment.ts';
import { partitionNativePdfPaths, pickFiles } from '../../utils/pickFiles.ts';
import { isTauri } from '../../utils/saveBlob.ts';
import { errorMessage } from '../../modules/llm-client/index.ts';
import { Lightbox } from '../preview/Lightbox.tsx';
import { TextPreview } from '../preview/TextPreview.tsx';
import { FileTypeIcon } from '../shared/FileTypeIcon.tsx';
import { useSettings } from '../../store/settings.ts';
import { onPhaseChange, getPhase } from '../../store/responseStatus.ts';
import { toast } from '../../utils/toast.ts';
import { FileLineChangesModal } from './FileLineChangesModal.tsx';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';
import { presentUsage } from './usage-detail.ts';
import { UsageChip } from './UsageChip.tsx';
import { GenerationParamsChip } from './GenerationParamsChip.tsx';
import { ModelMetaChip } from './ModelMetaChip.tsx';
import { useThrottledWhile } from './useThrottledWhile.ts';
import { useShiftHeld } from './use-shift-held.ts';
import { isPdfName, pdfDropNotice, type DroppedPdf } from './pdf-drop-notice.ts';
import { activePdfDropContext } from './pdf-drop-context.ts';
import { finishReasonLabel, finishReasonTone } from './finish-reason-presentation.ts';
import { TODO_UI_TEXT } from '../tools/TodoBody.tsx';
import { runLocalStorageMutation } from '../../store/local-storage.ts';

const basename = (path: string): string => path.split(/[\\/]/).pop() || path;
const EMPTY_ATTACHMENTS: Attachment[] = [];
const EMPTY_ATTACHMENT_IDS: string[] = [];

interface Props {
  conversationId: string;
  message: Message;
  /** Aggregate line changes from successful mutating file tools in this turn. */
  lineChanges?: FileLineChanges;
  onCancel?: () => void;
  onRetry?: (id: string) => void;
  /**
   * If provided, user messages become editable. The callback receives the
   * new content + (optionally) new attachments; ChatView then re-runs the
   * stream from that point.
   */
  onEdit?: (
    id: string,
    next: { content: string; attachments?: Attachment[] },
    editSessionId: string,
  ) => void;
  /**
   * Whether this bubble is the one currently in edit mode. Lifted up
   * to ChatView (which owns `editingId` and the corresponding Composer
   * visibility) so that the edit textarea can be the *only* input
   * surface in the chat while a user message is being edited.
   */
  editing?: boolean;
  /**
   * Open the side panel at the Workspace / Parameters tab. Rendered as
   * two icon-only buttons on the edit row, mirroring the composer's
   * pair — while an edit is open the composer is unmounted, so without
   * these there is no way to reach either panel mid-edit.
   */
  onOpenWorkspace?: () => void;
  onOpenParams?: () => void;
/**
   * Fired when the user clicks the 🧠 button on an assistant bubble's
   * meta row. Only provided for assistant bubbles that have reasoning,
   * so the button is only rendered when there's something to show.
   * ChatView handles the actual overlay open/close.
   */
  onShowReasoning?: (id: string) => void;
  /**
   * Fired when the user clicks the 🛠 button on an assistant bubble's
   * meta row. Only provided for assistant bubbles that have
   * `tool_calls`, so the button is only rendered when there's
   * something to show. Opens the global overlay at the Tools tab.
   */
  onShowTools?: (id: string) => void;
  /** Number of items in the successful todo snapshot owned by this message. */
  todoCount?: number;
  /** Open the shared preview at the todo tab for this message. */
  onShowTodo?: (id: string) => void;
  /** True while the app is busy (streaming or running tools). */
  busy?: boolean;
}

export function MessageBubbleBase({
  conversationId,
  message,
  lineChanges,
  onCancel: _onCancel,
  onRetry,
  onEdit,
  editing = false,
  onOpenWorkspace,
  onOpenParams,
  onShowReasoning,
  onShowTools,
  todoCount,
  onShowTodo,
  busy = false,
}: Props) {
  const isSystem = message.role === 'system';
  const activeAssistant = message.role === 'assistant' && (busy || !!message.streaming);
  const assistantName = useSettings((s) => s.assistantName);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string; name: string; size: number } | null>(null);
  const [textPreview, setTextPreview] = useState<{ name: string; mime: string; size: number; content: string | null; reason?: string } | null>(null);
  const messageAttachments = message.attachments ?? EMPTY_ATTACHMENTS;
  const draft = useConversationUi((state) => {
    const entry = state.byId[conversationId] ?? EMPTY_CONVERSATION_UI;
    return entry.editingMessageId === message.id ? entry.editDraftText : message.content;
  });
  const attachments = useConversationUi((state) => {
    const entry = state.byId[conversationId] ?? EMPTY_CONVERSATION_UI;
    return entry.editingMessageId === message.id ? entry.editAttachments : messageAttachments;
  });
  const editSessionId = useConversationUi((state) => {
    const entry = state.byId[conversationId] ?? EMPTY_CONVERSATION_UI;
    return entry.editingMessageId === message.id ? entry.editSessionId : null;
  });
  const editSubmitting = useConversationUi((state) => {
    const entry = state.byId[conversationId] ?? EMPTY_CONVERSATION_UI;
    return entry.editingMessageId === message.id && entry.editSubmitting;
  });
  const editAttachmentIds = useConversationUi((state) => {
    const entry = state.byId[conversationId] ?? EMPTY_CONVERSATION_UI;
    return entry.editingMessageId === message.id
      ? entry.editAttachmentIds
      : EMPTY_ATTACHMENT_IDS;
  });
  const [usageOpen, setUsageOpen] = useState(false);
  const [lineChangesOpen, setLineChangesOpen] = useState(false);
  const [filePreviewActive, setFilePreviewActive] = useState(false);
  const newIds = useMemo(() => new Set(editAttachmentIds), [editAttachmentIds]);
  /** True while files are hovering the edit textarea (HTML5 drag only). */
  const [dragOver, setDragOver] = useState(false);
  const [hydrated, setHydrated] = useState<Attachment[]>([]);
  const [copied, setCopied] = useState(false);
  // Shift-key gate for the re-send button — mirrors the sidebar
  // conv-action-delete pattern so the user can't accidentally
  // re-send a message with a stray click.
  const shiftDown = useShiftHeld(message.role === 'user' && Boolean(onRetry));
  const retryHintRef = useRef(0);
  // Finish-reason overlay state — captures the raw reason + optional
  // error_message so the overlay can show the full, untruncated text.
  const [finishOverlay, setFinishOverlay] = useState<{
    reason: string;
    label: string;
    errorMessage?: string;
  } | null>(null);

  // ---- Phase-driven UI state -------------------------------------
  // Subscribes to the responseStatus emitter so the cursor,
  // "Thinking…" / "Calling tools…" indicators, and "Stop
  // generating" button reflect the ACTUAL model phase, not the
  // `message.streaming` proxy (which toggles false during tool
  // tool-call rounds and causes the cursor blink animation to
  // restart on every remount).
  const [phaseActive, setPhaseActive] = useState({
    reasoning: false,
    tools: false,
    text: false,
  });
  useEffect(() => {
    if (!activeAssistant) {
      setPhaseActive({ reasoning: false, tools: false, text: false });
      return;
    }
    const unsub = onPhaseChange(conversationId, (phase) => {
      setPhaseActive({
        reasoning: phase.reasoning === 'running' || phase.reasoning === 'started',
        tools: phase.toolUse === 'running' || phase.toolUse === 'started',
        text: phase.textResponse === 'running' || phase.textResponse === 'started',
      });
    });
    const initial = getPhase(conversationId);
    setPhaseActive({
      reasoning: initial.reasoning === 'running' || initial.reasoning === 'started',
      tools: initial.toolUse === 'running' || initial.toolUse === 'started',
      text: initial.textResponse === 'running' || initial.textResponse === 'started',
    });
    return unsub;
  }, [activeAssistant, conversationId]);

  // Esc closes the changes modal, only while it is the innermost overlay.
  // The `filePreviewActive` guard predates the overlay stack and is kept:
  // that preview is tracked by local state here rather than by a component
  // with its own stack entry.
  useOverlayEscape(() => {
    if (!filePreviewActive) setLineChangesOpen(false);
  }, lineChangesOpen);

  useEffect(() => {
    const onPreviewClosed = (event: Event) => {
      const messageId = (event as CustomEvent<{ messageId?: string }>).detail?.messageId;
      if (messageId === message.id) {
        setFilePreviewActive(false);
        setLineChangesOpen(true);
      }
    };
    window.addEventListener('lc:preview-file-closed', onPreviewClosed);
    return () => window.removeEventListener('lc:preview-file-closed', onPreviewClosed);
  }, [message.id]);

  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Scroll speed for the slow-scroll button, in px/sec. Persisted to
  // localStorage so it survives across sessions. Default 12.
  const [scrollSpeed, setScrollSpeed] = useState(() => {
    try {
      const v = localStorage.getItem('lc:scroll-speed');
      return v ? Math.max(1, Number(v)) : 12;
    } catch {
      return 12;
    }
  });
  const [showSpeedInput, setShowSpeedInput] = useState(false);
  const [speedInputPos, setSpeedInputPos] = useState<{ top: number; left: number } | null>(null);

  // No-op. The V button is kept in the UI for visibility, and the
  // right-click speed input popup still works, but left-click does
  // nothing — all auto-scroll/smooth-scroll logic was removed. The
  // .messages container scrolls natively.
  const slowScrollIntoView = useCallback(() => {
    // intentionally empty
  }, []);

  // Per-message click handlers that bind `message.id` from
  // props. Wrapped in useCallback so the JSX `onClick={...}`
  // values are reference-stable across renders — that's
  // what `React.memo` checks. Without these wrappers, the
  // inline arrow `() => onRetry?.(message.id)` would create
  // a new function on every render and memo would never
  // match. The wrapper depends on the prop function (which
  // ChatView now passes as a stable `useCallback`) AND on
  // `message.id` (which is stable as long as the same
  // message object is in the list — see `patchLastMessage`
  // in the store: only the last index gets a new object
  // per streaming tick).
  const handleRetryClick = useCallback(
    (e: React.MouseEvent) => {
      if (!e.shiftKey) {
        const now = Date.now();
        if (now - retryHintRef.current > 1500) {
          retryHintRef.current = now;
          toast.info("Hold 'Shift' to activate 'Re-send' button");
        }
        return;
      }
      onRetry?.(message.id);
    },
    [onRetry, message.id],
  );
const handleShowReasoningClick = useCallback(
    () => onShowReasoning?.(message.id),
    [onShowReasoning, message.id],
  );

  const handleShowToolsClick = useCallback(
    () => onShowTools?.(message.id),
    [onShowTools, message.id],
  );
  const handleShowTodoClick = useCallback(
    () => onShowTodo?.(message.id),
    [onShowTodo, message.id],
  );

  // Tool button visibility: only when the assistant message
  // actually has tool_calls attached. Count badge when 2+ so the
  // user knows there's more than one to read.
  const toolCalls = message.tool_calls;
  const toolCount = toolCalls?.length ?? 0;

  // Right-click on the scroll button shows a speed input positioned
  // just below the button, right-aligned.
  const onButtonContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      // Place popup below the button, right-aligned. Clamp to viewport.
      const POPUP_WIDTH = 160;
      const left = Math.max(8, Math.min(rect.right - POPUP_WIDTH, window.innerWidth - POPUP_WIDTH - 8));
      const top = Math.max(8, rect.bottom + 4);
      setSpeedInputPos({ top, left });
    }
    setShowSpeedInput(true);
  };

  // Click outside closes the speed input.
  useEffect(() => {
    if (!showSpeedInput) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.scroll-speed-input-popup')) {
        setShowSpeedInput(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showSpeedInput]);

  // Hydrate attachments from IDB when the message renders.
  useEffect(() => {
    let cancelled = false;
    if (message.attachments?.length) {
      hydrateAttachments(message.attachments).then((list) => {
        if (!cancelled) setHydrated(list);
      });
    } else {
      setHydrated([]);
    }
    return () => {
      cancelled = true;
    };
  }, [message.attachments]);

  const startEdit = () => {
    useConversationUi.getState().beginEdit(
      conversationId,
      message.id,
      message.content,
      message.attachments ?? [],
    );
  };

  const cancelEdit = () => {
    if (!editSessionId) return;
    void useConversationUi.getState().cancelEdit(
      conversationId,
      message.id,
      editSessionId,
    );
  };

  // The edit attachment list remains visible while the complete draft lives
  // in conversation UI state, independent of this bubble's mount lifetime.

  const commitEdit = () => {
    const next = draft.trim();
    if (!next || !editSessionId || !onEdit) return;
    // Strip the transient dataUrl before handing the attachments
    // to the store. The dataUrl is only here so the edit-textarea
    // preview can show thumbnails; the store keeps it in memory
    // (so the next render of the *current* message still has
    // thumbnails via the hydration effect) but we don't want to
    // pass it across the wire — the persist layer would otherwise
    // write a megabyte-scale base64 string back into localStorage
    // on the next commit. The dataUrl will be rehydrated from IDB
    // the next time the message renders.
    const lean = attachments.map((a) => { 
      const { dataUrl: _dataUrl, ...rest } = a; 
      return rest; 
    }); 
    if (!useConversationUi.getState().startEditSubmission(
      conversationId,
      message.id,
      editSessionId,
    )) return;
    onEdit(message.id, { content: next, attachments: lean }, editSessionId);
  };

  // Shared file-ingest path for the edit draft: the attach button, an
  // HTML5 drop, and the Tauri drop all land here. Mirrors the
  // composer's `addFiles` — same `isAllowedAttachment` gate, same
  // skipped-file message — and additionally records each new id in
  // `newIds` so `cancelEdit` can delete the blobs it created.
  const addFiles = useCallback(async (files: FileList | File[]) => {
    const editState = useConversationUi.getState().get(conversationId);
    const sessionId = editState.editSessionId;
    if (
      !sessionId
      || editState.editSubmitting
    ) return;
    const work = beginConversationUiWork(conversationId);
    if (!work) return;
    try {
      const accepted: Attachment[] = [];
      const skipped: string[] = [];
      const skippedPdfs: DroppedPdf[] = [];
      for (const f of Array.from(files)) {
        if (!isAllowedAttachment(f)) {
          if (isPdfName(f.name)) skippedPdfs.push({ name: f.name });
          else skipped.push(f.name);
          continue;
        }
        try {
          accepted.push(await fileToAttachment(f));
        } catch (e) {
          toast.error(errorMessage(e));
        }
      }
      const pdfNotice = pdfDropNotice(skippedPdfs, activePdfDropContext());
      if (pdfNotice) toast.error(pdfNotice);
      if (skipped.length) {
        toast.error(
          skipped.length === 1
            ? `Skipped "${skipped[0]}": unsupported file type. Only images and common text/source files are supported.`
            : `Skipped ${skipped.length} unsupported files: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''}. Only images and common text/source files are supported.`,
        );
      }
      if (accepted.length) {
        useConversationUi.getState().addEditAttachments(
          conversationId,
          message.id,
          sessionId,
          work.uiLifetime,
          accepted,
        );
      }
    } finally {
      work.finish();
    }
  }, [conversationId, message.id]);

  // Open the file picker for the edit-mode attach button. Routes
  // through `pickFiles()` so the platform-native dialog (Tauri) /
  // browser dialog (web) is used — and so the filter set is
  // consistent with the composer's main attach button (defined
  // once in `utils/attachments.ts`, never duplicated).
  const openFilePicker = useCallback(async () => {
    try {
      const { files, pdfPaths } = await pickFiles();
      if (pdfPaths.length > 0) {
        const notice = pdfDropNotice(
          pdfPaths.map((path) => ({ name: basename(path), path })),
          activePdfDropContext(),
        );
        if (notice) toast.error(notice);
      }
      if (files.length > 0) await addFiles(files);
    } catch (err) {
      toast.error(`Could not open file picker: ${errorMessage(err)}`);
    }
  }, [addFiles]);

  // Tauri drop support. The webview never fires HTML5 drop events for
  // files dragged from the OS; Tauri intercepts the drop natively and
  // emits `tauri://drag-drop` with absolute paths. PDFs are partitioned
  // before any byte read; only attachment candidates go through the
  // `read_dropped_file` command. Same wiring as the composer.
  //
  // Gated on `editing`, and that is enough to keep the two from both
  // claiming one drop: the event is global, but ChatView unmounts the
  // Composer for the whole time a bubble edit is open, so its listener
  // is not registered while this one is. Only one bubble can be
  // editing at a time (ChatView holds a single `editingId`).
  useEffect(() => {
    if (!isTauri || !editing || editSubmitting) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const handler = await listen<{ paths: string[] }>(
        'tauri://drag-drop',
        async (e) => {
          const paths = e.payload?.paths ?? [];
          if (paths.length === 0) return;
          setDragOver(false);
          const { pdfPaths, otherPaths } = partitionNativePdfPaths(paths);
          if (pdfPaths.length > 0) {
            const notice = pdfDropNotice(
              pdfPaths.map((path) => ({ name: basename(path), path })),
              activePdfDropContext(),
            );
            if (notice) toast.error(notice);
          }
          if (otherPaths.length === 0) return;
          const files: File[] = [];
          for (const p of otherPaths) {
            try {
              const dropped = await invoke<{ name: string; mime: string; size: number; bytes: number[] }>(
                'read_dropped_file',
                { path: p },
              );
              const blob = new Blob([new Uint8Array(dropped.bytes)], {
                type: dropped.mime || 'application/octet-stream',
              });
              files.push(new File([blob], dropped.name, {
                type: dropped.mime,
                lastModified: Date.now(),
              }));
            } catch (err) {
              toast.error(`Could not read ${p}: ${errorMessage(err)}`);
            }
          }
          if (files.length > 0 && !cancelled) await addFiles(files);
        },
      );
      if (cancelled) {
        handler();
        return;
      }
      unlisten = handler;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [editing, editSubmitting, addFiles]);

  // HTML5 drop path — the web build, and the only path that can show a
  // hover state in either build (Tauri's native drag never reaches the
  // DOM, so `dragOver` simply stays false there).
  const onEditDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) await addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const onEditDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.types.includes('Files')) setDragOver(true);
  }, []);

  const onEditDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  // Remove an attachment from the edit draft and delete its blob
  // from IDB so we don't leak it. If the user cancels the edit,
  // the remaining "new" attachments are also cleaned up via the
  // newIds set in cancelEdit.
  const removeAtt = async (id: string) => {
    if (!editSessionId) return;
    await useConversationUi.getState().removeEditAttachment(
      conversationId,
      message.id,
      editSessionId,
      id,
    );
  };

  const handleCloseLightbox = useCallback(() => setLightbox(null), []);

  // Throttle Markdown re-parsing during streaming. Must be called
  // unconditionally (Rules of Hooks) — always compute the value,
  // even when the content branch isn't the active render path.
  const displayContent = useThrottledWhile(toText(message.content), 42, !!message.streaming);

  return (
    <div ref={bubbleRef} className={cn('bubble', `bubble-${message.role}`, isSystem && 'bubble-system', editing && 'is-editing', activeAssistant && 'is-writing')}>
      <div className="bubble-meta">
{onShowReasoning && (
          <button
            type="button"
            className="bubble-icon-btn bubble-preview-toggle bubble-reasoning-toggle"
            onClick={handleShowReasoningClick}
            title="Show reasoning"
            aria-label="Show reasoning"
          >
            <svg viewBox="2 2 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {/* Brain-style icon: a head outline with a thought
                  squiggle inside. Two loops at the top suggest the
                  cerebral hemispheres, a small sparkle below hints at
                  the active thinking. Drawn inline so we don't pull
                  in another icon library. */}
              <path d="M9.5 4a3 3 0 0 0-3 3v.5A3 3 0 0 0 5 10v1a3 3 0 0 0 1.5 2.6V14a3 3 0 0 0 3 3h.5" />
              <path d="M14.5 4a3 3 0 0 1 3 3v.5A3 3 0 0 1 19 10v1a3 3 0 0 1-1.5 2.6V14a3 3 0 0 1-3 3H14" />
              <path d="M12 8v6" />
              <path d="M9.5 11h5" />
              <path d="M10 14h4" />
            </svg>
          </button>
        )}
        {onShowTools && toolCount > 0 && (
          <button
            type="button"
            className="bubble-icon-btn bubble-preview-toggle bubble-tools-toggle"
            onClick={handleShowToolsClick}
            title={`Show ${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}`}
            aria-label={`Show ${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}`}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
              {/* Tools glyph — wrench + screwdriver crossed
                  (D:\Downloads\tools.svg from SVG Repo).
                  Solid fill (no stroke) — the source SVG is
                  designed to render this way at 24×24. */}
              <path d="M5.33 3.271a3.5 3.5 0 0 1 4.254 4.963l10.709 10.71-1.414 1.414-10.71-10.71a3.502 3.502 0 0 1-4.962-4.255L5.444 7.63a1.5 1.5 0 1 0 2.121-2.121L5.329 3.27zm10.367 1.884l3.182-1.768 1.414 1.414-1.768 3.182-1.768.354-2.12 2.121-1.415-1.414 2.121-2.121.354-1.768zm-6.718 8.132l1.414 1.414-5.303 5.303a1 1 0 0 1-1.492-1.327l.078-.087 5.303-5.303z" />
            </svg>
            {toolCount >= 2 && (
              <span className="bubble-icon-btn-badge">{toolCount}</span>
            )}
          </button>
        )}
        {todoCount !== undefined && onShowTodo && (
          <button
            type="button"
            className="bubble-icon-btn bubble-preview-toggle bubble-todo-toggle"
            onClick={handleShowTodoClick}
            title={TODO_UI_TEXT.show}
            aria-label={TODO_UI_TEXT.show}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 6h11M9 12h11M9 18h11" />
              <path d="m3.5 6 1.2 1.2L7 4.8M3.5 12l1.2 1.2L7 10.8M3.5 18l1.2 1.2L7 16.8" />
            </svg>
            {todoCount >= 2 && (
              <span className="bubble-icon-btn-badge">{todoCount}</span>
            )}
          </button>
        )}
        <span className="bubble-role">
          {message.role === 'user' ? 'You' : message.role === 'assistant' ? assistantName : 'System'}
        </span>
        <span className="bubble-time">{formatDateTime(message.createdAt)}</span>
        {message.role === 'assistant' && lineChanges && (
          <button
            type="button"
            className="bubble-line-changes"
            onClick={() => setLineChangesOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={lineChangesOpen}
            aria-label={`Show file changes: ${lineChanges.added} lines added, ${lineChanges.removed} lines removed`}
          >
            <span className="bubble-lines-added">+{lineChanges.added}</span>{' '}
            <span className="bubble-lines-removed">-{lineChanges.removed}</span>
          </button>
        )}
      </div>

      {lineChangesOpen && lineChanges && createPortal(
        <FileLineChangesModal
          changes={lineChanges}
          messageId={message.id}
          onClose={() => setLineChangesOpen(false)}
          onOpenFile={(path) => {
            setFilePreviewActive(true);
            window.dispatchEvent(new CustomEvent('lc:preview-file', {
              detail: {
                path,
                returnToFileChanges: message.id,
              },
            }));
          }}
        />,
        document.body,
      )}

      {/* File list. In view mode, driven by `hydrated` (bytes resolved
          from IDB) and rows are clickable for preview. In edit mode,
          driven by conversation-owned `attachments` (so newly-picked files
          survive navigation) and each row gets a × button + a "New" badge
          for files added during this edit session. The strip also
          stays visible even when `attachments` is empty during edit
          (handled below) so the user can see the attach button
          worked and the new file's row appears. */}
      {(editing ? attachments.length > 0 : hydrated.length > 0) && (
        <div className="bubble-files" role="list" aria-label="Attached files">
          {(editing ? attachments : hydrated).map((a) => {
            if (editing) {
              const lang = a.isImage ? '' : (langFromMime(a.mime) || langFromName(a.name));
              const isNew = newIds.has(a.id);
              return (
                <div
                  key={a.id}
                  role="listitem"
                  className={cn('bubble-file', 'is-editing', isNew && 'is-new')}
                >
                  <span className="bubble-file-icon" aria-hidden>
                    {a.isImage ? (
                      <svg viewBox="0 0 24 24" width="16" height="16">
                        <path
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M21 15l-5-5-7 7-3-3-3 3"
                        />
                        <circle cx="9" cy="9" r="1.5" fill="currentColor" />
                      </svg>
                    ) : (
                      <FileTypeIcon lang={lang} size={14} />
                    )}
                  </span>
                  <span className="bubble-file-name" title={a.name}>
                    {a.name}
                    {isNew && <span className="bubble-file-new-tag">New</span>}
                  </span>
                  <span className="bubble-file-size">{formatBytes(a.size)}</span>
                  <button
                    type="button"
                    className="bubble-file-remove"
                    aria-label={`Remove ${a.name}`}
                    title={`Remove ${a.name}`}
                    onClick={() => { void removeAtt(a.id); }}
                    disabled={editSubmitting}
                  >
                    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
                      <path
                        d="M2 2 L10 10 M10 2 L2 10"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              );
            }
            // View mode (existing behavior).
            const haveBytes = !!a.dataUrl;
            const lang = a.isImage ? '' : (langFromMime(a.mime) || langFromName(a.name));
            const onClick = () => {
              if (!haveBytes) {
                setTextPreview({
                  name: a.name, mime: a.mime, size: a.size,
                  content: null,
                  reason: 'The attachment bytes are no longer available.',
                });
                return;
              }
              if (a.isImage) {
                setLightbox({ src: a.dataUrl!, alt: a.name, name: a.name, size: a.size });
              } else {
                // Use the shared UTF-8 decoder so emoji and CJK
                // characters in source files / markdown don't
                // mojibake on display (the old `atob(...)` path
                // re-interpreted each byte as a Latin-1 codepoint,
                // turning `⚙️` into garbled characters).
                const content = decodeDataUrlAsUtf8(a.dataUrl!);
                setTextPreview({ name: a.name, mime: a.mime, size: a.size, content });
              }
            };
            return (
              // Row is a <div> instead of a <button> because it now
              // contains two real <button>s (preview + download).
              // Nesting <button> in <button> is invalid HTML and
              // silently breaks keyboard nav. The outer click area
              // is the preview button on the left; the download
              // button is its own element on the right.
              <div
                key={a.id}
                role="listitem"
                className={cn('bubble-file', !haveBytes && 'is-missing')}
              >
                <button
                  type="button"
                  className="bubble-file-preview"
                  title={haveBytes
                    ? (a.isImage ? `Click to preview image: ${a.name}` : `Click to preview file: ${a.name}`)
                    : `${a.name} — preview unavailable`}
                  onClick={onClick}
                  disabled={!haveBytes}
                >
                  <span className="bubble-file-icon" aria-hidden>
                    {a.isImage ? (
                      <svg viewBox="0 0 24 24" width="16" height="16">
                        <path
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M21 15l-5-5-7 7-3-3-3 3"
                        />
                        <circle cx="9" cy="9" r="1.5" fill="currentColor" />
                      </svg>
                    ) : (
                      <FileTypeIcon lang={lang} size={14} />
                    )}
                  </span>
                  <span className="bubble-file-name" title={a.name}>{a.name}</span>
                  <span className="bubble-file-size">{formatBytes(a.size)}</span>
                  {!haveBytes && <span className="bubble-file-missing-tag">unavailable</span>}
                </button>
                <button
                  type="button"
                  className="bubble-file-download"
                  title={haveBytes ? `Download ${a.name}` : `${a.name} — download unavailable`}
                  aria-label={haveBytes ? `Download ${a.name}` : `${a.name} — download unavailable`}
                  disabled={!haveBytes}
                  onClick={() => { void downloadAttachment(a); }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 4v12" />
                    <path d="M6 12l6 6 6-6" />
                    <path d="M5 20h14" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Reasoning is no longer rendered inside the bubble — it lives
          in the global ReasoningOverlay (see ChatView) so its height
          changes never touch the messages container's scrollHeight. */}

      <div className="bubble-body">
        {editing ? (
          <div
            className={cn('bubble-edit', dragOver && 'drag-over')}
            onDrop={(e) => { void onEditDrop(e); }}
            onDragOver={onEditDragOver}
            onDragLeave={onEditDragLeave}
          >
            <textarea
              autoFocus
              disabled={editSubmitting}
              value={draft}
              onChange={(e) => {
                if (!editSessionId) return;
                useConversationUi.getState().setEditDraftText(
                  conversationId,
                  message.id,
                  editSessionId,
                  e.target.value,
                );
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  commitEdit();
                } else if (e.key === 'Escape') {
                  cancelEdit();
                }
              }}
              />
            <div className="bubble-edit-actions">
              {onOpenWorkspace && (
                <button
                  className="bubble-icon-btn"
                  type="button"
                  onClick={onOpenWorkspace}
                  title="Open the Workspace panel"
                  aria-label="Open the Workspace panel"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="currentColor"
                    aria-hidden
                  >
                    <path d="M5.33 3.271a3.5 3.5 0 0 1 4.254 4.963l10.709 10.71-1.414 1.414-10.71-10.71a3.502 3.502 0 0 1-4.962-4.255L5.444 7.63a1.5 1.5 0 1 0 2.121-2.121L5.329 3.27zm10.367 1.884l3.182-1.768 1.414 1.414-1.768 3.182-1.768.354-2.12 2.121-1.415-1.414 2.121-2.121.354-1.768zm-6.718 8.132l1.414 1.414-5.303 5.303a1 1 0 0 1-1.492-1.327l.078-.087 5.303-5.303z" />
                  </svg>
                </button>
              )}
              {onOpenParams && (
                <button
                  className="bubble-icon-btn"
                  type="button"
                  onClick={onOpenParams}
                  title="Open the params panel"
                  aria-label="Open the params panel"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M4 6h10" />
                    <path d="M17 6h3" />
                    <path d="M4 12h3" />
                    <path d="M10 12h10" />
                    <path d="M4 18h12" />
                    <path d="M19 18h1" />
                    <circle cx="15" cy="6" r="1.8" fill="var(--bg)" />
                    <circle cx="8" cy="12" r="1.8" fill="var(--bg)" />
                    <circle cx="17" cy="18" r="1.8" fill="var(--bg)" />
                  </svg>
                </button>
              )}
              <button
                className="bubble-icon-btn"
                type="button"
                onClick={() => { void openFilePicker(); }}
                disabled={editSubmitting}
                title="Attach file(s) or image(s)"
                aria-label="Attach file(s) or image(s)"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <span className="spacer" />
              <button
                className="ghost-btn small"
                type="button"
                onClick={cancelEdit}
                disabled={editSubmitting}
              >
                Cancel
              </button>
              <button
                className="primary-btn small"
                type="button"
                onClick={commitEdit}
                disabled={draft.trim().length === 0 || editSubmitting}
              >
                Save & re-send
              </button>
            </div>
          </div>
) : isSystem ? (
          <pre className="system-prompt">{toText(message.content)}</pre>
        ) : message.content ? (
          <ChunkedMarkdown
            text={displayContent}
            streaming={!!message.streaming}
            liveSurface="response"
          />
        ) : activeAssistant && phaseActive.reasoning ? (
          <span className="thinking-indicator">
            <svg className="thinking-brain-icon" viewBox="2 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9.5 4a3 3 0 0 0-3 3v.5A3 3 0 0 0 5 10v1a3 3 0 0 0 1.5 2.6V14a3 3 0 0 0 3 3h.5" />
              <path d="M14.5 4a3 3 0 0 1 3 3v.5A3 3 0 0 1 19 10v1a3 3 0 0 1-1.5 2.6V14a3 3 0 0 1-3 3H14" />
              <path d="M12 8v6" />
              <path d="M9.5 11h5" />
              <path d="M10 14h4" />
            </svg>
            Thinking…
          </span>
        ) : activeAssistant && phaseActive.tools ? (
          <span className="thinking-indicator">
            <svg className="tooling-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
              <path d="M5.33 3.271a3.5 3.5 0 0 1 4.254 4.963l10.709 10.71-1.414 1.414-10.71-10.71a3.502 3.502 0 0 1-4.962-4.255L5.444 7.63a1.5 1.5 0 1 0 2.121-2.121L5.329 3.27zm10.367 1.884l3.182-1.768 1.414 1.414-1.768 3.182-1.768.354-2.12 2.121-1.415-1.414 2.121-2.121.354-1.768zm-6.718 8.132l1.414 1.414-5.303 5.303a1 1 0 0 1-1.492-1.327l.078-.087 5.303-5.303z" />
            </svg>
            Tooling…
          </span>
        ) : activeAssistant && phaseActive.text ? (
          <span className="thinking-indicator">
            <span className="thinking-dot" />
            Writing…
          </span>
        ) : null}
        {message.refusal && !editing && (
          <div className="bubble-refusal" role="alert">
            <span className="bubble-refusal-label">Refused</span>
            <span>{message.refusal}</span>
          </div>
        )}
        {/* During tool execution, show the indicator below any
            existing content the model already produced. */}
        {activeAssistant && phaseActive.tools && message.content && !editing && (
          <div className="tool-calling-footer">
            <svg className="tooling-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
              <path d="M5.33 3.271a3.5 3.5 0 0 1 4.254 4.963l10.709 10.71-1.414 1.414-10.71-10.71a3.502 3.502 0 0 1-4.962-4.255L5.444 7.63a1.5 1.5 0 1 0 2.121-2.121L5.329 3.27zm10.367 1.884l3.182-1.768 1.414 1.414-1.768 3.182-1.768.354-2.12 2.121-1.415-1.414 2.121-2.121.354-1.768zm-6.718 8.132l1.414 1.414-5.303 5.303a1 1 0 0 1-1.492-1.327l.078-.087 5.303-5.303z" />
            </svg> Tooling…
          </div>
        )}
      </div>

      {/* Action row (re-send / edit / copy). Shown whenever the
          message has a way to act on it — assistant messages with
          content, or user messages that have EITHER content or
          attachments. The old gate `&& message.content` hid the
          whole row for user messages that carried only attachments,
          leaving the user unable to re-send, edit, or copy an
          attachments-only message. The Copy button is the only
          action that requires non-empty content (copying an empty
          string is useless), so it's gated separately below. */}
      {!message.streaming && !editing && (onRetry || message.role === 'assistant') && (message.content || message.refusal || (message.attachments && message.attachments.length > 0)) && (
        <div className="bubble-actions">
          {message.role === 'user' && onRetry && (
            <IconButton
              onClick={handleRetryClick}
              className={shiftDown ? 'is-armed' : undefined}
              title={shiftDown ? 'Re-send' : 'Hold Shift to re-send'}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <path fill="currentColor" d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
              </svg>
            </IconButton>
          )}
          {message.role === 'user' && onEdit && (
            <IconButton onClick={startEdit} title="Edit">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
              </svg>
            </IconButton>
          )}
          {message.role === 'user' && message.content && (
            <IconButton onClick={() => copyToClipboard(message.content, setCopied)} title="Copy message">
              {copied ? (
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                  <path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                  <path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z" />
                </svg>
              )}
            </IconButton>
          )}
          {message.role === 'assistant' && (
            <IconButton
              buttonRef={buttonRef}
              className="bubble-scroll-to-bottom-btn"
              onClick={slowScrollIntoView}
              onContextMenu={onButtonContextMenu}
              title="Scroll to bottom (right-click to change speed)"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </IconButton>
          )}
          {message.role === 'assistant' && (
            <IconButton
              onClick={(e) => {
                // Shift+left-click copies reasoning + response in markdown.
                if (e.shiftKey && message.reasoning) {
                  const md = `## Thinking\n\n${message.reasoning}\n\n## Response\n\n${message.content}`;
                  copyToClipboard(md, setCopied);
                } else {
                  copyToClipboard(message.content, setCopied);
                }
              }}
              title="Copy response (Shift+left-click for thinking + response)"
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
            </IconButton>
          )}
        </div>
      )}

      {finishOverlay && createPortal(
        <div className="finish-reason-overlay-backdrop" onClick={() => setFinishOverlay(null)}>
          <div
            className="finish-reason-overlay"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Finish reason details"
          >
            <div className="finish-reason-overlay-header">
              <span className="finish-reason-overlay-title">{finishOverlay.label}</span>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setFinishOverlay(null)}
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                  />
                </svg>
              </button>
            </div>
            {finishOverlay.reason || finishOverlay.errorMessage ? (
              <pre className="finish-reason-overlay-reason">{[finishOverlay.reason, finishOverlay.errorMessage].filter(Boolean).join('\n\n')}</pre>
            ) : null}
            <div className="finish-reason-overlay-note">This is the raw end signal and its error message when present. Values vary across API endpoints:{' '}
              <span className="finish-reason-overlay-link" role="link" tabIndex={0}
                onClick={() => window.dispatchEvent(new CustomEvent('lc:link-click', { detail: { url: 'https://developers.openai.com/api/reference/overview' } }))}
                onKeyDown={(e) => { if (e.key === 'Enter') window.dispatchEvent(new CustomEvent('lc:link-click', { detail: { url: 'https://developers.openai.com/api/reference/overview' } })); }}
              >OpenAI</span>
              {' | '}
              <span className="finish-reason-overlay-link" role="link" tabIndex={0}
                onClick={() => window.dispatchEvent(new CustomEvent('lc:link-click', { detail: { url: 'https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons' } }))}
                onKeyDown={(e) => { if (e.key === 'Enter') window.dispatchEvent(new CustomEvent('lc:link-click', { detail: { url: 'https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons' } })); }}
              >Anthropic</span>
              {' | '}
              <span className="finish-reason-overlay-link" role="link" tabIndex={0}
                onClick={() => window.dispatchEvent(new CustomEvent('lc:link-click', { detail: { url: 'https://ai.google.dev/gemini-api/docs/api-errors' } }))}
                onKeyDown={(e) => { if (e.key === 'Enter') window.dispatchEvent(new CustomEvent('lc:link-click', { detail: { url: 'https://ai.google.dev/gemini-api/docs/api-errors' } })); }}
              >Gemini REST</span>
              {' | '}
              <span className="finish-reason-overlay-link" role="link" tabIndex={0}
                onClick={() => window.dispatchEvent(new CustomEvent('lc:link-click', { detail: { url: 'https://lmstudio.ai/docs/developer/rest/streaming-events' } }))}
                onKeyDown={(e) => { if (e.key === 'Enter') window.dispatchEvent(new CustomEvent('lc:link-click', { detail: { url: 'https://lmstudio.ai/docs/developer/rest/streaming-events' } })); }}
              >LM Studio REST</span>.
              <span style={{ display: 'block', marginTop: 8 }} />
              LC custom statuses:
              <ol className="finish-reason-overlay-lc-statuses">
                <li><code>⤒ tool-round limit</code> — reached the maximum tool-call rounds for the turn.</li>
                <li><code>⏻ disconnected</code> — stopped before server end signal | manual stop | idle timeout.</li>
                <li><code>⚠ reasoning loop</code> — stopped after LC detected a repeating reasoning stream.</li>
                <li><code>&#9888; tool batch limit</code> — contained more calls than the Workspace limit; no calls were executed and the response ended.</li>
              </ol>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {showSpeedInput && speedInputPos && createPortal(
        <div
          className="scroll-speed-input-popup"
          style={{ top: speedInputPos.top, left: speedInputPos.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <label>
            Speed (px/sec)
            <input
              type="number"
              min={1}
              max={500}
              value={scrollSpeed}
              autoFocus
              onChange={(e) => {
                const v = Math.max(1, Math.min(500, Number(e.target.value) || 1));
                setScrollSpeed(v);
                runLocalStorageMutation(() => {
                  localStorage.setItem('lc:scroll-speed', String(v));
                });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                  setShowSpeedInput(false);
                }
              }}
            />
          </label>
        </div>,
        document.body
      )}
      {message.role === 'assistant' && (() => {
        // Keep the four footer chips renderable even for older or partially
        // persisted replies. These are display-only fallbacks; the message
        // stored in the conversation is never changed.
        const presetChip = message.meta?.presetName || '-';
        const paramsSnapshot = message.meta?.params;
        const model = message.meta?.model || '-';
        const endpoint = message.meta?.endpoint;
        const serverName = message.meta?.serverName || '-';
        const baseUrl = message.meta?.baseUrl;
        const totalToks = message.usage?.scope === 'assistant-turn'
          ? message.usage.completion_tokens
          : message.meta?.totalTokens ?? message.usage?.completion_tokens;
        const hasToks = totalToks != null && totalToks > 0;
        const durStr = message.meta?.durationMs != null
          ? `${(message.meta.durationMs / 1000).toFixed(1)}s`
          : '';
        // Provider-reported tokens and cache counters, LC estimates, and LC's
        // prefix inference are formatted together but stay attributed apart.
        const usageDetail = presentUsage(message.usage, message.prefix, {
          hasToolCalls: (message.tool_calls?.length ?? 0) > 0,
        });

        // One chip, bare figures: output · cache · duration. The popover names
        // them, so the chip carries no labels. The cache figure reads `n/a`
        // when no counter was reported — never `0`, which would imply the
        // provider cached nothing.
        const chipParts: string[] = [];
        if (hasToks && message.usage?.tokenCoverage?.output !== 'unreported') {
          chipParts.push(`${message.usage?.tokenCoverage?.output === 'partial' ? '≥' : ''}${totalToks}`);
        }
        if (usageDetail.report) chipParts.push(usageDetail.report.cacheValue);
        if (durStr) chipParts.push(durStr);
        const usageChipText = chipParts.join(' · ');
        const tokenChipText = usageChipText || '-';
        const finish = message.meta?.finish_reason;
        const finishChip = finishReasonLabel(finish);
        const finishTone = finishReasonTone(finish);
        return (
          <div className="bubble-usage">
            <button
              type="button"
              className="bubble-usage-toggle"
              title={usageOpen ? 'Hide reply metadata' : 'Show reply metadata'}
              aria-label={usageOpen ? 'Hide reply metadata' : 'Show reply metadata'}
              onClick={() => setUsageOpen((v) => !v)}
            >
              <svg viewBox="0 0 14 14" width="10" height="10" aria-hidden
                style={{ transform: usageOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>
                <path d="M4.5 6L8 9.5 11.5 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className="bubble-usage-label" />
            </button>
            {usageOpen && (
              <div className="bubble-usage-chips">
                <GenerationParamsChip presetName={presetChip} params={paramsSnapshot} />
                <ModelMetaChip
                  model={model}
                  endpoint={endpoint}
                  serverName={serverName}
                  baseUrl={baseUrl}
                />
                {tokenChipText && (usageDetail.report ? (
                  <UsageChip
                    report={usageDetail.report}
                    chipText={tokenChipText}
                    details={usageDetail.details}
                  />
                ) : (
                  // When usage is unavailable, keep the fourth chip visible
                  // as a simple placeholder.
                  <span
                    className="bubble-meta-chip"
                    title={usageDetail.details.join('\n') || 'Output tokens, duration'}
                  >
                    {tokenChipText}
                  </span>
                ))}
                {lineChanges && (
                  <button
                    type="button"
                    className="bubble-line-changes"
                    onClick={() => setLineChangesOpen(true)}
                    aria-haspopup="dialog"
                    aria-expanded={lineChangesOpen}
                    aria-label={`Show file changes: ${lineChanges.added} lines added, ${lineChanges.removed} lines removed`}
                  >
                    <span className="bubble-lines-added">+{lineChanges.added}</span>{' '}
                    <span className="bubble-lines-removed">-{lineChanges.removed}</span>
                  </button>
                )}
                {finish ? (
                  <button
                    type="button"
                    className={`bubble-meta-chip clickable ${finishTone === 'warn' ? 'bubble-meta-chip-warn' : finishTone === 'accent' ? 'bubble-meta-chip-accent' : ''}`}
                    title="Click for details"
                    onClick={() => setFinishOverlay({
                      reason: message.meta?.provider_finish_reason ?? finish!,
                      label: finishChip,
                      errorMessage: message.meta?.error_message,
                    })}
                  >
                    {finishChip}
                  </button>
                ) : (
                  <span className="bubble-meta-chip" title="Completion status unavailable">
                    {finishChip}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {lightbox && (
        <Lightbox
          src={lightbox.src}
          alt={lightbox.alt}
          name={lightbox.name}
          size={lightbox.size}
          onClose={handleCloseLightbox}
        />
      )}
      {textPreview && (
        <TextPreview
          name={textPreview.name}
          mime={textPreview.mime}
          size={textPreview.size}
          content={textPreview.content}
          unavailableReason={textPreview.reason}
          onClose={() => setTextPreview(null)}
        />
      )}
    </div>
  );
}


/** Compact icon button used in the bubble action bar. */
function IconButton({
  onClick,
  onContextMenu,
  buttonRef,
  title,
  className,
  children,
}: {
  onClick: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={className ? `bubble-icon-btn ${className}` : 'bubble-icon-btn'}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

/** Copy text to clipboard and flash a checkmark for 1.5s. */
async function copyToClipboard(text: string, setCopied: (v: boolean) => void) {
  try {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  } catch {
    // ignore
  }
}

/**
 * Memoized MessageBubble. Wraps the implementation in
 * `React.memo` so that bubbles whose props are
 * reference-equal across ChatView re-renders skip
 * re-rendering entirely. This is the fix for the
 * "switching to a long conv freezes the UI" symptom —
 * without memo, every conv-list-item click re-parses the
 * markdown body of every bubble (via `react-markdown` +
 * `rehype-prism-plus`) on the main thread, which costs
 * 1–5 seconds for a 100–200 message conversation.
 *
 * `React.memo` does a shallow prop comparison by default.
 * For this to actually skip renders, every prop must be
 * reference-stable across ChatView re-renders when the
 * bubble "didn't really change":
 *
 *  - `message`: reference-stable per index. The store's
 *    `patchLastMessage` only mutates the last message on
 *    every streaming tick, so earlier messages keep the
 *    same object reference. Cross-conversation switch gives
 *    fresh references (new conv = new messages array), but
 *    within a conversation the references are stable
 *    across the streaming updates that hit every other
 *    tick.
 *  - `editing`: primitive boolean, equal-by-value.
 *  - `onCancel` / `onRetry` / `onEdit` / `onShowReasoning` / `onOpenWorkspace` /
 *    `onOpenParams`: all wrapped in
 *    `useCallback` in ChatView. Each bubble's per-bubble
 *    id binding (`handleRetryClick`, `handleShowReasoningClick`)
 *    is also `useCallback`-wrapped, depending on
 *    `[onRetry, message.id]` / `[onShowReasoning, message.id]`
 *    — both stable when the bubble "didn't really change."
 *
 * The streaming bubble (the LAST one in the list) WILL
 * re-render on every token — that's intentional, it has
 * to. Its `message` object changes per chunk (see
 * `patchLastMessage` in the store: it creates a brand-new
 * object on every streaming delta), so memo's check fails
 * and the bubble re-renders. Earlier bubbles in the
 * same conversation do NOT re-render during streaming —
 * their `message` references are stable.
 */
export const MessageBubble = memo(MessageBubbleBase);
MessageBubble.displayName = 'MessageBubble';

/**
 * Coerce a message's `content` to a string for display. The
 * `Message.content` field is typed as `string`, but on the wire /
 * in some store paths the API may pass an object or array
 * (multimodal content parts, a ContentPart array, etc.). Without
 * this guard React renders an object child as `[object Object]`,
 * which is the symptom this fixes.
 *
 *   - string → return as-is
 *   - object / array → JSON.stringify with 2-space indent so the
 *     user sees the actual data instead of `[object Object]`
 *   - null / undefined → empty string
 *   - everything else → String(value) as a last resort
 */
export function toText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return '[unserializable]';
    }
  }
  return String(content);
}
