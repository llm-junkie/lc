import { useCallback, useRef, useState, useEffect } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react';
import { fileToAttachment, isAllowedAttachment, hydrateAttachments } from '../../utils/attachments.ts';
import {
  beginConversationUiWork,
  EMPTY_CONVERSATION_UI,
  useConversationUi,
} from '../../store/conversation-ui.ts';
import type { Attachment, GenerationParams } from '../../types';
import { cn } from '../../utils/cn.ts';
import { presetLabel } from '../../utils/presets.ts';
import { toast } from '../../utils/toast.ts';
import { formatBytes } from '../../utils/format.ts';
import { isTauri } from '../../utils/saveBlob.ts';
import { partitionNativePdfPaths, pickFiles } from '../../utils/pickFiles.ts';
import { errorMessage } from '../../modules/llm-client/index.ts';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { onPhaseChange, getPhase } from '../../store/responseStatus.ts';
import { isPdfName, pdfDropNotice, type DroppedPdf } from './pdf-drop-notice.ts';
import { activePdfDropContext } from './pdf-drop-context.ts';
import { WhiteboardIcon } from '../tools/WhiteboardIcon.tsx';
import { WHITEBOARD_UI_TEXT } from '../tools/whiteboard-ui-text.ts';

const basename = (p: string): string => p.split(/[\\/]/).pop() || p;

interface Props {
  /**
   * The conversation this composer drafts for.
   *
   * Draft text and staged attachments live in `conversation-ui`, keyed by this
   * ID, rather than in component state. The component used to be remounted per
   * conversation, which destroyed the draft on every switch and orphaned any
   * attachment blob it was holding.
   */
  conversationId: string;
  /** Resolves true once the user message crossed its durable send boundary. */
  onSend: (text: string, attachments: Attachment[]) => boolean | Promise<boolean>;
  onCancel: () => void;
  busy: boolean;
  disabled?: boolean;
  /** Capacity/config admission may block Send without disabling draft editing. */
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  placeholder?: string;
  /**
   * Name of the parameter preset currently in effect for
   * this conversation (e.g. "Server default", "Writer",
   * "Custom"). Rendered as a small action button in the
   * row below the composer, before the keyboard hints —
   * so the user can see which preset will apply to the
   * next message without opening the params panel. When
   * `onOpenParams` is also provided, clicking the button
   * opens the params panel for quick adjustment.
   */
  presetName?: string;
  /** Live params for that preset. Only the reasoning fields are read —
   *  they put the effort on the button (`"Custom · xhigh"`) so it reads
   *  the same as the params chip on a reply. */
  presetParams?: Pick<GenerationParams, 'reasoning_effort' | 'reasoning_enabled'>;
  onOpenParams?: () => void;
  sidePanelOpen?: boolean;
  /** Open the side panel at the Tools tab. Provided when the
   *  parent mounts the ParamsPanel with Tools support. The
   *  button is only rendered when this handler exists so
   *  older parents that don't pass it don't get a dead chip. */
  onOpenTools?: () => void;
  /** When true, the Tools chip shows an "open" accent so the
   *  user knows the panel is currently at Tools. */
  toolsPanelOpen?: boolean;
  /** Whether tools are enabled for the current conversation. */
  toolsEnabled?: boolean;
  /** Whether the current conversation has any active directories set. */
  hasActiveDirs?: boolean;
  /** When true, the composer input and action row are always visible. */
  pinComposer?: boolean;
  /** Open the conversation Whiteboard. Omitted when the category is hidden. */
  onOpenWhiteboard?: () => void;
  /** Whether the Whiteboard overlay currently owns the foreground. */
  whiteboardOpen?: boolean;
}

export function Composer({
  conversationId,
  onSend,
  onCancel,
  busy,
  disabled,
  sendDisabled,
  sendDisabledReason,
  placeholder,
  presetName,
  presetParams,
  onOpenParams,
  sidePanelOpen,
  onOpenTools,
  toolsPanelOpen,
  toolsEnabled,
  hasActiveDirs,
  pinComposer,
  onOpenWhiteboard,
  whiteboardOpen,
}: Props) {
  const text = useConversationUi(
    (state) => (state.byId[conversationId] ?? EMPTY_CONVERSATION_UI).draftText,
  );
  const attachments = useConversationUi(
    (state) => (state.byId[conversationId] ?? EMPTY_CONVERSATION_UI).draftAttachments,
  );
  const setText = useCallback(
    (next: string) => useConversationUi.getState().setDraftText(conversationId, next),
    [conversationId],
  );
  const [hydrated, setHydrated] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Phase-driven stop-button label.  Subscribes to the emitter
  // so the button text reflects the current model activity.
  const [stopLabel, setStopLabel] = useState('Stop');
  useEffect(() => {
    const unsub = onPhaseChange(conversationId, (phase) => {
      if (phase.reasoning === 'running' || phase.reasoning === 'started') {
        setStopLabel('Thinking…');
      } else if (phase.toolUse === 'running' || phase.toolUse === 'started') {
        setStopLabel('Using tools…');
      } else if (phase.textResponse === 'running' || phase.textResponse === 'started') {
        setStopLabel('Writing…');
      } else {
        setStopLabel('Stop');
      }
    });
    const initial = getPhase(conversationId);
    if (initial.reasoning === 'running' || initial.reasoning === 'started') {
      setStopLabel('Thinking…');
    } else if (initial.toolUse === 'running' || initial.toolUse === 'started') {
      setStopLabel('Using tools…');
    } else if (initial.textResponse === 'running' || initial.textResponse === 'started') {
      setStopLabel('Writing…');
    }
    return unsub;
  }, [conversationId]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Shared file-ingest path. Defined here (above the Tauri effect)
  // and wrapped in useCallback so the Tauri drag-drop effect can
  // reach it with a stable reference. The old code captured
  // `addFiles` by closure at the wrong scope, which left the Tauri
  // listener pointing at a stale function after the component
  // re-mounted (e.g. on conversation switch) — a real bug.
  const addFiles = useCallback(async (files: FileList | File[]) => {
    if (disabled) return;
    const work = beginConversationUiWork(conversationId);
    if (!work) return;
    try {
      setError(null);
      const list = Array.from(files);
      const accepted: Attachment[] = [];
      const skipped: string[] = [];
    // PDFs are partitioned out of the generic skip list: they get the
    // tool hint, everything else keeps the "unsupported" message. A
    // mixed drop must not suggest lc_read_pdf for the .exe.
      const skippedPdfs: DroppedPdf[] = [];
      for (const f of list) {
        if (!isAllowedAttachment(f)) {
          if (isPdfName(f.name)) skippedPdfs.push({ name: f.name });
          else skipped.push(f.name);
          continue;
        }
        try {
          accepted.push(await fileToAttachment(f));
        } catch (e) {
          const msg = errorMessage(e);
          toast.error(msg);
        }
      }
      // These arrive without a path (file picker / HTML5 drop), so the
      // notice falls back to naming the tool rather than the file.
      const pdfNotice = pdfDropNotice(skippedPdfs, activePdfDropContext());
      if (pdfNotice) toast.error(pdfNotice);
      if (skipped.length) {
        const sample = skipped.length === 1
          ? `Skipped "${skipped[0]}": unsupported file type. Only images and common text/source files are supported.`
          : `Skipped ${skipped.length} unsupported files: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''}. Only images and common text/source files are supported.`;
        toast.error(sample);
      }
      if (accepted.length) {
        useConversationUi.getState().addDraftAttachments(
          conversationId,
          accepted,
          work.uiLifetime,
        );
      }
    } finally {
      work.finish();
    }
  }, [conversationId, disabled]);

  // Tauri-specific: the webview doesn't fire native HTML5 drop events
  // for files dragged from the OS. Instead, Tauri intercepts the drop
  // in the Rust side and emits a `tauri://drag-drop` event with the
  // absolute file paths. We listen for it, read each file's bytes
  // via the custom `read_dropped_file` Rust command, and feed the
  // resulting `File` objects into the same `addFiles` flow as the
  // web path. Same UX, different wiring.
  useEffect(() => {
    if (!isTauri || disabled) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const handler = await listen<{ paths: string[]; position?: { x: number; y: number } }>(
        'tauri://drag-drop',
        async (e) => {
          const paths = e.payload?.paths ?? [];
          if (paths.length === 0) return;

          // Short-circuit PDFs before `read_dropped_file`. They are never
          // attachments, and reading first would pull the whole file into
          // memory only to discard it — a 400 MB PDF for nothing. Doing it
          // here also keeps the absolute path, which `addFiles` cannot see:
          // by the time it runs, only `File.name` survives.
          const { pdfPaths, otherPaths } = partitionNativePdfPaths(paths);
          if (pdfPaths.length > 0) {
            const notice = pdfDropNotice(
              pdfPaths.map((p) => ({ name: basename(p), path: p })),
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
              const msg = errorMessage(err);
              toast.error(`Could not read ${p}: ${msg}`);
            }
          }
          if (files.length > 0 && !cancelled) {
            await addFiles(files);
            textareaRef.current?.focus();
          }
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
  }, [addFiles, disabled]);

  // Auto-grow textarea up to ~12 lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 320) + 'px';
  }, [text]);

  // Auto-focus the textarea on mount.
  useEffect(() => {
    queueMicrotask(() => textareaRef.current?.focus());
  }, []);

  // Re-hydrate attachment previews whenever the attachment list changes.
  useEffect(() => {
    let cancelled = false;
    if (attachments.length === 0) {
      setHydrated([]);
      return;
    }
    hydrateAttachments(attachments).then((list) => {
      if (!cancelled) setHydrated(list);
    });
    return () => {
      cancelled = true;
    };
  }, [attachments]);

  // Open the file picker. Routes through `pickFiles()`, which uses
  // Tauri's native dialog plugin when running in the Tauri shell
  // (so the platform's native filter dropdown shows every supported
  // file type — important on Linux, where a plain `<input>`'s `accept`
  // attribute is only partially honored) and a one-shot synthesized
  // `<input type="file">` in the web build. Resolves to an empty
  // array on cancel; we silently no-op in that case.
  const openFilePicker = async () => {
    try {
      const { files, pdfPaths } = await pickFiles();
      // The native picker hands back PDF *paths* without reading their
      // bytes, so the notice can name the file the model should open.
      if (pdfPaths.length > 0) {
        const notice = pdfDropNotice(
          pdfPaths.map((p) => ({ name: basename(p), path: p })),
          activePdfDropContext(),
        );
        if (notice) toast.error(notice);
      }
      if (files.length > 0) {
        await addFiles(files);
      }
    } catch (err) {
      const msg = errorMessage(err);
      toast.error(`Could not open file picker: ${msg}`);
    } finally {
      textareaRef.current?.focus();
    }
  };

  const submit = async () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || busy || disabled || sendDisabled) return;
    // `takeDraft` clears without deleting blobs: an accepted send transfers
    // their ownership to the persisted message.
    const {
      text: submittedText,
      attachments: submittedAttachments,
      uiLifetime,
    } =
      useConversationUi.getState().takeDraft(conversationId);
    setError(null);
    try {
      const accepted = await onSend(trimmed, submittedAttachments);
      if (!accepted) {
        // A failed durable send must not eat the draft. `restoreDraft` merges
        // underneath anything the user added while the boundary was pending.
        useConversationUi.getState()
          .restoreDraft(conversationId, submittedText, submittedAttachments, uiLifetime);
      }
    } catch {
      useConversationUi.getState()
        .restoreDraft(conversationId, submittedText, submittedAttachments, uiLifetime);
    } finally {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length === 0) return;
    e.preventDefault();
    await addFiles(imageFiles);
    textareaRef.current?.focus();
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) {
      await addFiles(e.dataTransfer.files);
      textareaRef.current?.focus();
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.types.includes('Files')) setDragOver(true);
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const removeAtt = async (id: string) => {
    // The draft is the blob's only owner until a send transfers it, so the
    // store deletes the bytes as part of dropping the reference.
    await useConversationUi.getState().removeDraftAttachment(conversationId, id);
    textareaRef.current?.focus();
  };

  return (
    <div
      className={cn('composer-wrap', dragOver && 'drag-over', sidePanelOpen && 'side-panel-open', pinComposer && 'pinned')}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      title="Press 'Enter' to send and 'Shift+Enter' for enter a newline"
    >
      {error && (
        <div className="composer-error" role="alert">
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {hydrated.length > 0 && (
        <div className="attachment-strip">
          {hydrated.map((a) => (
            <div key={a.id} className="attachment-thumb" title={`${a.name} · ${formatBytes(a.size)}`}>
              {a.isImage && a.dataUrl ? (
                <img src={a.dataUrl} alt={a.name} />
              ) : (
                <div className="attachment-file">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                    <path d="M9 13h6" />
                    <path d="M9 17h6" />
                  </svg>
                  <span className="attachment-name">{a.name}</span>
                </div>
              )}
              <button
                className="attachment-remove"
                onClick={() => removeAtt(a.id)}
                aria-label={`Remove ${a.name}`}
                tabIndex={-1}
                type="button"
                disabled={disabled}
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
          ))}
        </div>
      )}

      <div className={cn('composer', busy && 'busy')}>
        <textarea
          ref={textareaRef}
          id="composer-input"
          name="message"
          value={text}
          rows={1}
          placeholder={placeholder ?? 'Send a message…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          disabled={disabled}
        />
        {busy ? (
          <button
            className="primary-btn danger composer-send"
            onClick={onCancel}
            type="button"
            title={stopLabel}
            aria-label={stopLabel}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            className="primary-btn composer-send"
            onClick={() => { void submit(); }}
            disabled={disabled || sendDisabled || (text.trim().length === 0 && attachments.length === 0)}
            type="button"
            title={sendDisabled ? (sendDisabledReason ?? 'Generation capacity is full') : 'Send'}
            aria-label="Send"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
              <path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        )}
      </div>

      <div className="composer-action-row">
        {onOpenTools && (
          <button
            type="button"
            className={
              'composer-action-btn tools-action-btn' +
              (toolsPanelOpen ? ' is-active' : '')
            }
            style={
              toolsEnabled && hasActiveDirs
                ? { color: '#ef4444' }
                : toolsEnabled && !hasActiveDirs
                  ? { color: '#f59e0b' }
                  : undefined
            }
            onClick={onOpenTools}
            tabIndex={-1}
            title={
              toolsPanelOpen
                ? 'Workspace panel is open — click to switch to Params'
                : 'Open the Workspace panel'
            }
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
            <span className="composer-action-label">Workspace</span>
          </button>
        )}
        {presetName && onOpenParams ? (
          <button
            type="button"
            className="composer-action-btn"
            onClick={onOpenParams}
            tabIndex={-1}
            title={`Active preset: ${presetLabel(presetName, presetParams)} — open the params panel`}
            aria-label={`Active preset: ${presetLabel(presetName, presetParams)} — open the params panel`}
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
              <circle cx="15" cy="6" r="1.8" fill="var(--bg-elev-1)" />
              <circle cx="8" cy="12" r="1.8" fill="var(--bg-elev-1)" />
              <circle cx="17" cy="18" r="1.8" fill="var(--bg-elev-1)" />
            </svg>
            <span className="composer-action-label">{presetLabel(presetName, presetParams)}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="composer-action-btn attach-action-btn"
          onClick={openFilePicker}
          tabIndex={-1}
          disabled={disabled}
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
          <span className="composer-action-label">Attach</span>
        </button>
        {onOpenWhiteboard && (
          <button
            type="button"
            className={cn('composer-action-btn', 'whiteboard-action-btn', whiteboardOpen && 'is-active')}
            onClick={onOpenWhiteboard}
            aria-label={WHITEBOARD_UI_TEXT.open}
            aria-pressed={whiteboardOpen}
            title={WHITEBOARD_UI_TEXT.open}
          >
            <WhiteboardIcon />
            <span className="composer-action-label">{WHITEBOARD_UI_TEXT.title}</span>
          </button>
        )}
      </div>
    </div>
  );
}
