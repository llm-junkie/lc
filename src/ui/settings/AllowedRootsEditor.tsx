/** Default allowed-directories editor.  Used from Settings → Tools.
 *  Lets the user curate a list of directory paths that can be quickly
 *  granted per-conversation via the WorkspaceManager.  Autosaves on
 *  every add/remove — no explicit Save button. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isTauri } from '../../utils/saveBlob.ts';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { cleanPath, isAbsolutePath } from '../../modules/tool-engine/clean-path.ts';
import { errorMessage } from '../../modules/llm-client/index.ts';
import { copyTextToClipboard } from '../../utils/clipboard.ts';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';

export interface AllowedRootsEditorProps {
  open: boolean;
  /** Current known directories (initial value when the editor opens). */
  roots: string[];
  /** Called on every add/remove. No separate Save button. */
  onChange: (next: string[]) => void;
  onClose: () => void;
}

const LIST_MAX_HEIGHT = 260;

/** How long the "Copied" flash stays up on a row, in ms. */
const COPIED_FLASH_MS = 1400;

/** Case-insensitive, digit-aware A→Z ordering for the displayed list.
 *  Paths differing only in case are neighbours, and `proj2` sorts before
 *  `proj10` the way a person would expect. */
const PATH_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
});

export function AllowedRootsEditor({
  open,
  roots,
  onChange,
  onClose,
}: AllowedRootsEditorProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);

  // Sorted for display only — the stored order is left alone. Entries can
  // also be appended from the chat workspace picker, which never goes
  // through this editor, so ordering the view is what actually holds.
  const sortedRoots = useMemo(
    () => [...roots].sort(PATH_COLLATOR.compare),
    [roots],
  );

  // Reset the input draft whenever the editor opens.
  useEffect(() => {
    if (open) {
      setDraft('');
      setError(null);
      setCopied(null);
    }
  }, [open]);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // Esc closes — autosave (current state is already live via onChange).
  // Only acts while this is the innermost overlay.
  useOverlayEscape(onClose, open);

  const addPath = useCallback(
    (rawPath: string) => {
      const path = cleanPath(rawPath);
      if (!path) return false;
      if (!isAbsolutePath(path)) {
        setError(
          `Path must be absolute (e.g. ${navigator.platform.toLowerCase().includes('win') ? 'C:\\Users\\me\\Projects' : '/Users/me/projects'}).`,
        );
        return false;
      }
      if (roots.some((r) => cleanPath(r) === path)) {
        setError('That path is already in the list.');
        return false;
      }
      onChange([...roots, path]);
      setError(null);
      return true;
    },
    [roots, onChange],
  );

  const addFromInput = useCallback(() => {
    if (addPath(draft)) setDraft('');
  }, [addPath, draft]);

  const remove = useCallback(
    (path: string) => {
      onChange(roots.filter((p) => p !== path));
    },
    [roots, onChange],
  );

  const copy = useCallback(async (path: string) => {
    try {
      await copyTextToClipboard(path);
      setError(null);
      setCopied(path);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(
        () => setCopied(null),
        COPIED_FLASH_MS,
      );
    } catch (e) {
      setError(`Copy failed: ${errorMessage(e)}`);
    }
  }, []);

  const browse = useCallback(async () => {
    if (!isTauri) {
      setError('Browse requires the desktop app — paste a path instead.');
      return;
    }
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === 'string' && picked) {
        if (addPath(picked)) setDraft('');
      }
    } catch (e) {
      setError(`Browse failed: ${errorMessage(e)}`);
    }
  }, [addPath]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="known-dirs-title"
      onClick={onClose}
    >
      <div
        className="modal-card allowed-roots-editor"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="workspace-manager-header">
          <h3 id="known-dirs-title">Manage known directories</h3>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path
                fill="currentColor"
                d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
        </header>
        <p className="allowed-roots-editor-help">
          Pre-set directories you can quickly grant access to in any
          conversation. The model does NOT automatically see these — you must
          select them per conversation.
        </p>
        <ul
          className="settings-allowed-roots-list"
          style={{ maxHeight: LIST_MAX_HEIGHT }}
        >
          {sortedRoots.length === 0 && (
            <li className="settings-allowed-roots-empty">
              None. Browse or add one below.
            </li>
          )}
          {sortedRoots.map((path) => (
            <li className="settings-allowed-roots-list-item" key={path}>
              <button
                type="button"
                className="settings-allowed-roots-copy"
                onClick={() => void copy(path)}
                title="Copy path"
                aria-label={`Copy ${path}`}
              >
                <code>{path}</code>
                {copied === path ? (
                  <span className="settings-allowed-roots-copied">Copied</span>
                ) : (
                  <svg
                    className="settings-allowed-roots-copy-icon"
                    viewBox="0 0 24 24"
                    width="13"
                    height="13"
                    aria-hidden
                  >
                    <path
                      fill="currentColor"
                      d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"
                    />
                  </svg>
                )}
              </button>
              <button
                type="button"
                className="workspace-manager-remove"
                onClick={() => remove(path)}
                aria-label={`Remove ${path}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="settings-allowed-roots-add-row">
          <input
            id="settings-allowed-roots-input"
            type="text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addFromInput();
            }}
            placeholder="Absolute path…"
            className="allowed-roots-input"
          />
          <button
            type="button"
            className="permission-modal-btn btn-fw"
            onClick={browse}
          >
            Browse…
          </button>
          <button
            type="button"
            className="permission-modal-btn permission-modal-btn-primary btn-fw"
            onClick={addFromInput}
            disabled={!draft.trim()}
          >
            Add
          </button>
        </div>
        {error && <p className="allowed-roots-error">{error}</p>}
      </div>
    </div>,
    document.body,
  );
}
