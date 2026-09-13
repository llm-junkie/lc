/**
 * Link-open confirmation overlay.
 *
 * Replaces the previous QuickPreview (iframe-based preview) which
 * couldn't work for sites that send `X-Frame-Options: DENY` /
 * `Content-Security-Policy: frame-ancestors 'none'` — github,
 * streamlit, twitter, and most "real" sites. The browser enforces
 * those headers unconditionally on iframe loads, and the only way
 * to bypass is a server-side proxy (Tauri-only) which is out of
 * scope for the moment.
 *
 * Behavior: when the user clicks a link in any markdown surface,
 * the click handler in `utils/markdown.tsx` does NOT open the
 * URL — it only dispatches `lc:link-click` with the URL. App.tsx
 * catches that and renders this overlay. The user sees:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ ⚠  You are about to open:                │
 *   │ ┌──────────────────────────────────┐ ┌─┐ │
 *   │ │ https://github.com/...           │ │Copy│
 *   │ └──────────────────────────────────┘ └─┘ │
 *   │              [Cancel]  [Continue]       │
 *   └──────────────────────────────────────────┘
 *
 *   - Cancel   → closes the overlay, nothing else happens.
 *   - Continue → closes the overlay AND opens the URL
 *                (Tauri: `openUrl` to OS default browser;
 *                web: `window.open` in a new tab).
 *   - Esc      → same as Cancel.
 *   - Click    → same as Cancel.
 *   - Copy     → copies the URL to clipboard.
 *
 * The actual open is performed in App.tsx (where we have the
 * `isTauri` check and the opener-plugin import wired up
 * centrally) and is passed in as a callback so this component
 * stays platform-agnostic.
 *
 * File is named `QuickPreview.tsx` to avoid touching App.tsx's
 * import path; the component itself is generic and could be
 * renamed later.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useOrderedOverlayLayer,
  useOverlayEscape,
  useOverlayKeys,
} from '../../utils/overlay-stack.ts';
import { useScrollLock } from '../../utils/scroll-lock.ts';

interface Props {
  url: string;
  /** Called when the user clicks Continue. The overlay closes
   *  itself; the parent is responsible for actually opening the
   *  URL. */
  onContinue: () => void;
  /** Called when the user dismisses (Cancel, Esc, backdrop). */
  onClose: () => void;
}

export function LinkOpenConfirm({ url, onContinue, onClose }: Props) {
  // Tiny local state for the copy button's "Copied!" flash.
  // Doesn't need to be lifted — no other component cares.
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

  // Esc → cancel. Enter → continue (the primary action — the user is
  // confirming "yes I see it, open it"). The autoFocus on the Continue button
  // also means Tab lands on Cancel first (default focus order in this modal),
  // so Enter on the Continue button is the same path as keyboard Enter here.
  //
  // Escape cancels, Enter confirms — both only while this is the innermost
  // overlay. Enter matters as much as Escape here: the F1 sheet can be opened
  // on top of this confirmation, and Enter must not silently open the link
  // from behind it.
  useOverlayKeys({ Escape: onClose, Enter: onContinue });
  const orderedLayerRef = useOrderedOverlayLayer();

  // Lock body scroll while open. Shared counter, so releasing out of order
  // cannot unlock the page under an overlay that is still up.
  useScrollLock();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      // Clipboard write can fail in non-secure contexts or when
      // permissions are blocked. Fall back to selecting the
      // input so the user can hit Ctrl+C themselves.
      const input = document.querySelector<HTMLInputElement>('.link-open-confirm-url-input');
      if (input) {
        input.focus();
        input.select();
      }
    }
  };

  return createPortal(
    <div
      ref={orderedLayerRef}
      className="link-open-confirm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Confirm opening link"
    >
      <div
        className="link-open-confirm-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="link-open-confirm-warning">
          <svg
            className="link-open-confirm-warning-icon"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>You are about to open:</span>
        </div>

        <div className="link-open-confirm-url-row">
          <input
            type="text"
            className="link-open-confirm-url-input"
            value={url}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.currentTarget.select()}
            aria-label="Link URL (read-only)"
            title="Read-only — click to select, then copy"
          />
          <button
            type="button"
            className="link-open-confirm-copy"
            onClick={handleCopy}
            title="Copy URL"
            aria-label="Copy URL"
          >
            {copyState === 'copied' ? (
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <path
                  fill="currentColor"
                  d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"
                />
              </svg>
            ) : (
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
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15V5a2 2 0 0 1 2-2h10" />
              </svg>
            )}
            <span>{copyState === 'copied' ? 'Copied' : 'Copy'}</span>
          </button>
        </div>

        <div className="link-open-confirm-actions">
          <button
            type="button"
            className="link-open-confirm-cancel"
            onClick={onClose}
            title="Cancel (Esc)"
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary-btn link-open-confirm-continue"
            onClick={onContinue}
            autoFocus
            title="Continue (Enter)"
          >
            Continue
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * File-reveal confirmation overlay.
 *
 *   ┌────────────────────────────────────────────┐
 *   │ 📄  broken_gear.md                     [×] │
 *   │ Found matches (3):                         │
 *   │ ┌────────────────────────────────────────┐ │
 *   │ │ C:\temp\what\broken_gear.md            │ │ ← click to select
 *   │ │ D:\other\broken_gear.md                │ │
 *   │ │ E:\backup\broken_gear.md               │ │
 *   │ └────────────────────────────────────────┘ │
 *   │ ────────────────────────────────────────── │
 *   │ ┌────────────────────────────────────────┐ │
 *   │ │ C:\temp\what\broken_gear.md            │ │ ← resolved path
 *   │ └────────────────────────────────────────┘ │
 *   │  [Find…]    [Preview] [Show in Explorer]   │
 *   └────────────────────────────────────────────┘
 *
 * States:
 *  - Resolving (busy) → spinner, buttons disabled.
 *  - Resolved  → full path shown, Preview (if previewable) + Show enabled.
 *  - Unresolved → "Can't resolve path" + [Find in granted dirs] button.
 *  - Find empty → "No matches found in granted directories.", buttons disabled.
 *  - Found     → click-to-select list with accent highlight on picked row.
 */
interface FileClickProps {
  filename: string;
  /** The full absolute path once resolved, or null if unresolved. */
  resolvedPath: string | null;
  /** Whether the resolved file type can be previewed. */
  previewable?: boolean;
  /** When `onFind` returned results, these are full paths of matching files. */
  foundPaths?: string[];
  /** Called when the user clicks "Show in Explorer". */
  onShow: () => void;
  /** Called when the user clicks "Preview". */
  onPreview: () => void;
  onClose: () => void;
  /** Set to true while a resolve/find operation is in progress. */
  busy?: boolean;
  /** Trigger the root scan. Called when user clicks "Find in granted dirs". */
  onFind?: () => void;
  /** Called when the user selects a path from the found list. */
  onSelectPath?: (path: string) => void;
}

export function FileClickConfirm({
  filename,
  resolvedPath,
  previewable,
  foundPaths,
  onShow,
  onPreview,
  onClose,
  busy,
  onFind,
  onSelectPath,
}: FileClickProps) {
  const effectivePath = resolvedPath;
  // foundPaths comes from parent; we track local selection here.
  const [picked, setPicked] = useState<string | null>(null);
  const canAct = (effectivePath !== null || picked !== null) && !busy;
  // Only show the Find button when we've never attempted a scan.
  const showFindBtn = effectivePath === null && !busy && foundPaths === undefined && onFind;
  // Whether a scan was attempted and returned nothing.
  const searchedEmpty = foundPaths !== undefined && foundPaths.length === 0;

  // Esc to dismiss, only while this is the innermost overlay.
  useOverlayEscape(onClose);
  const orderedLayerRef = useOrderedOverlayLayer();

  // Lock body scroll while open. Shared counter, so releasing out of order
  // cannot unlock the page under an overlay that is still up.
  useScrollLock();

  // Auto-select when exactly one match is found.
  useEffect(() => {
    if (foundPaths && foundPaths.length === 1 && picked === null && !busy) {
      const p = foundPaths[0];
      setPicked(p);
      onSelectPath?.(p);
    }
  }, [foundPaths, picked, busy, onSelectPath]);

  return createPortal(
    <div
      ref={orderedLayerRef}
      className="link-open-confirm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="File actions"
    >
      <div
        className="link-open-confirm-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="link-open-confirm-header">
          <div className="link-open-confirm-warning">
            <svg
              className="link-open-confirm-warning-icon"
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <polyline points="13 2 13 9 20 9" />
            </svg>
            <span>{filename}</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={busy}
            title="Close (Esc)"
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

        {/* Found paths click-to-select list */}
        {foundPaths && foundPaths.length > 0 && (
          <>
            <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginTop: 2 }}>
              Found matches{foundPaths.length > 1 ? ` (${foundPaths.length})` : ''}:
            </div>
            <div className="file-find-list">
              {foundPaths.map((p) => (
                <div
                  key={p}
                  className={`file-find-item${picked === p ? ' is-picked' : ''}`}
                  onClick={() => {
                    setPicked(p);
                    onSelectPath?.(p);
                  }}
                  title={p}
                >
                  {p}
                </div>
              ))}
            </div>
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '4px 0 0' }} />
            <div className="link-open-confirm-url-row">
              <input
                id="file-resolved-path"
                type="text"
                className="link-open-confirm-url-input"
                value={effectivePath ?? ''}
                placeholder="Select a match above…"
                readOnly
                title={effectivePath ?? ''}
              />
            </div>
          </>
        )}

        {/* Resolved path display (standalone, no list) */}
        {effectivePath && !foundPaths && (
          <div className="link-open-confirm-url-row">
            <input
              id="file-resolved-path"
              type="text"
              className="link-open-confirm-url-input"
              value={effectivePath}
              readOnly
              title={effectivePath}
            />
          </div>
        )}

        {/* Unresolved — never attempted Find */}
        {effectivePath === null && !busy && foundPaths === undefined && (
          <div className="link-open-confirm-warning" style={{ justifyContent: 'center', padding: '8px 0', flexDirection: 'column', gap: 6 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Can't resolve path
            </span>
          </div>
        )}

        {/* Unresolved — Find was attempted, nothing found */}
        {effectivePath === null && !busy && searchedEmpty && (
          <div className="link-open-confirm-warning" style={{ justifyContent: 'center', padding: '8px 0', flexDirection: 'column', gap: 6 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              No matches found in granted directories.
            </span>
          </div>
        )}

        {/* Busy spinner */}
        {busy && effectivePath === null && foundPaths === undefined && (
          <div style={{ textAlign: 'center', padding: '12px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Resolving…
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, justifyContent: 'space-between', marginTop: 8 }}>
          {/* "Find in granted directories" button — only when unresolved */}
          {showFindBtn ? (
            <button
              type="button"
              className="link-open-confirm-preview"
              onClick={onFind}
              title="Scan all granted directories for this filename"
            >
              Find in granted dirs
            </button>
          ) : <span />}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="link-open-confirm-preview"
              onClick={onPreview}
              disabled={!canAct || previewable === false}
              title={
                !canAct ? 'File could not be resolved'
                : previewable === false ? 'Preview not supported for this file type'
                : 'Preview file contents'
              }
            >
              Preview
            </button>
            <button
              type="button"
              className="primary-btn link-open-confirm-continue"
              onClick={onShow}
              disabled={!canAct}
              autoFocus={canAct}
              title={canAct ? 'Show in Explorer' : 'File could not be resolved'}
            >
              Show in Explorer
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
