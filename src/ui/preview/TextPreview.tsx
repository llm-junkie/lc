/**
 * Text / source-code preview modal. Click any non-image attachment row in
 * a user message bubble to open this. Shows the file's decoded content
 * (UTF-8) inside a code block with proper syntax highlighting, capped at
 * ~50 KB for display (with a note if truncated). The path footnote at the
 * bottom shows whatever name we have on the file.
 *
 * In a browser build the only path info we have is the basename (the
 * File API does not expose the full filesystem path). On Tauri we could
 * capture the real path via the dialog plugin's `open` command, but the
 * current composer uses a plain <input type="file"> so the footnote just
 * shows the file name.
 *
 * Highlighting: we reuse the same `Markdown` component the chat bubble
 * uses, wrapping the file content in a fenced code block tagged with
 * the detected language. That way the preview gets the same high-quality
 * token coloring (via rehype-prism-plus / refractor) as code in the
 * chat — ~190 languages, no duplicated parser. The bubble's CodeBlock
 * renderer also gives us a free copy button, so we drop the toolbar
 * copy that used to live above the code.
 *
 * Markdown files are special-cased: by default we show the raw text
 * (so the user sees the file exactly as written — no surprises from
 * the renderer, and no `□□□` boxes when the file contains emoji or
 * CJK characters the markdown code block can't render). A [Render]
 * toolbar button toggles to a rendered view via the same `Markdown`
 * pipeline the chat bubbles use. The user keeps the choice on every
 * open within the session — the view state is component-local and
 * resets to 'raw' when the modal closes/reopens.
 */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { formatBytes } from '../../utils/format.ts';
import { FileTypeIcon } from '../shared/FileTypeIcon.tsx';
import { langFromMime, langFromName } from '../../utils/attachments.ts';
import { Markdown } from '../../utils/markdown.tsx';
import { cn } from '../../utils/cn.ts';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';
import { useScrollLock } from '../../utils/scroll-lock.ts';

interface Props {
  name: string;
  mime: string;
  size: number;
  /** Pre-decoded text content. If absent, the modal shows a "unavailable" message. */
  content: string | null;
  /** Why content is null, if applicable — shown next to the unavailable message. */
  unavailableReason?: string;
  onClose: () => void;
}

const PREVIEW_LIMIT = 50_000;

/** Returns true when the file should be treated as markdown (so we
 *  default to the raw view + Render button instead of the code-block
 *  view). We match by extension only — more reliable than MIME for
 *  attachments, which often come through as `text/plain` or
 *  `application/octet-stream` because the OS / drag source didn't
 *  tag them. The extension also matches what the user sees in the
 *  filename row. */
function isMarkdownFile(name: string, mime: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return true;
  // Fall back to MIME only when extension is missing (rare for our
  // composer — every file has a name). `text/markdown` is the
  // spec-correct type but some tools send `text/x-markdown`.
  if (!name.includes('.') && (mime === 'text/markdown' || mime === 'text/x-markdown')) return true;
  return false;
}

function NumberedText({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <div className="text-preview-line-numbered">
      <div className="text-preview-line-numbers" aria-hidden="true">
        {lines.map((_, index) => <span key={index}>{index + 1}</span>)}
      </div>
      <pre className="text-preview-raw">{content}</pre>
    </div>
  );
}

export function TextPreview({ name, mime, size, content, unavailableReason, onClose }: Props) {
  // Esc to close, only while this is the innermost overlay — a diagram viewer
  // opened from inside this preview must close alone.
  useOverlayEscape(onClose);

  // Lock body scroll while open. Shared counter, so releasing out of order
  // cannot unlock the page under an overlay that is still up.
  useScrollLock();

  const truncated = content != null && content.length > PREVIEW_LIMIT;
  const displayed = content == null
    ? null
    : (truncated ? content.slice(0, PREVIEW_LIMIT) : content);
  const lang = langFromMime(mime) || langFromName(name);
  const isMd = isMarkdownFile(name, mime);
  // Default markdown files to the raw view — see the file-header
  // comment for the rationale (emoji / CJK chars render as boxes
  // inside a code block, and the user usually wants to *see the
  // file* before deciding to render it). State is component-local
  // and resets when the modal closes.
  const [view, setView] = useState<'raw' | 'rendered'>(isMd ? 'raw' : 'rendered');
  // For non-markdown files, `view` is irrelevant — the code-block
  // view is the only option. We compute a single boolean here so
  // the toolbar JSX doesn't have to branch on `isMd` everywhere.
  const showRenderToggle = isMd;

  return createPortal(
    <div className="text-preview" onClick={onClose} role="dialog" aria-modal="true" aria-label="Text preview">
      <div className="text-preview-panel" onClick={(e) => e.stopPropagation()}>
        <div className="text-preview-header">
          <div className="text-preview-title">
            <FileTypeIcon lang={lang} />
            <span className="text-preview-name" title={name}>{name}</span>
          </div>
          <button
            className="text-preview-close"
            onClick={onClose}
            aria-label="Close"
            type="button"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path
                fill="currentColor"
                d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
        </div>

        {content == null ? (
          <div className="text-preview-empty">
            <div className="text-preview-empty-title">Preview unavailable</div>
            <div className="text-preview-empty-sub">
              {unavailableReason ?? "This file's bytes are no longer available."}
            </div>
          </div>
        ) : (
          <>
            <div className="text-preview-toolbar">
              <span className="text-preview-meta">
                {formatBytes(size)}
                {lang && (
                  <>
                    <span className="text-preview-meta-sep">·</span>
                    <span className="text-preview-meta-lang">{lang}</span>
                  </>
                )}
              </span>
              {showRenderToggle && (
                <div className="text-preview-view-toggle" role="tablist" aria-label="Preview mode">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === 'raw'}
                    className={cn('text-preview-view-btn', view === 'raw' && 'is-active')}
                    onClick={() => setView('raw')}
                    title="Show the file as raw text"
                  >
                    Raw
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === 'rendered'}
                    className={cn('text-preview-view-btn', view === 'rendered' && 'is-active')}
                    onClick={() => setView('rendered')}
                    title="Render as markdown"
                  >
                    Render
                  </button>
                </div>
              )}
            </div>
            <div className={cn('text-preview-body', isMd && view === 'raw' && 'is-raw')}>
              {isMd && view === 'raw' ? (
                /* Raw view for markdown files: show the source with a
                   synchronized line-number gutter and no syntax highlighting. */
                <NumberedText content={displayed ?? ''} />
              ) : (
                /* Default code-block view (and the rendered view for
                   markdown). For markdown, we let the same Markdown
                   pipeline the chat bubbles use handle it — no
                   surrounding code fence, so the markdown actually
                   gets parsed. For other languages, we wrap in a
                   fenced code block so rehype-prism-plus tokenises it
                   and the CodeBlock renderer gives us the copy
                   button. */
                <Markdown lineNumbers>
                  {isMd
                    ? (displayed ?? '')
                    : `\`\`\`${lang}\n${displayed}\n\`\`\``}
                </Markdown>
              )}
            </div>
            {truncated && (
              <div className="text-preview-truncated">
                Preview truncated at {formatBytes(PREVIEW_LIMIT)} of {formatBytes(size)} — copy the file to see the rest.
              </div>
            )}
          </>
        )}

        <div className="text-preview-footnote">
          <span className="text-preview-footnote-name" title={name}>{name}</span>
          <span className="text-preview-footnote-sep">·</span>
          <span>{formatBytes(size)}</span>
          <span className="text-preview-footnote-sep">·</span>
          <span className="text-preview-footnote-hint">local file</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
