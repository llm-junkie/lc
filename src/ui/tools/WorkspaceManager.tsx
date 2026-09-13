/**
 * WorkspaceManager — per-conversation directory manager.
 *
 * Single-column checkbox list:
 *   - Shows known directories from global settings as checkboxes.
 *     Checked = active in this conversation, unchecked = known but not active.
 *   - Bottom: "Add a new directory" — absolute-path input + Browse + Add.
 *     Browse fills the input via native dir picker; "Add" commits all
 *     checks + the new path (if any) in one click.
 *
 * Portalled to `document.body` for the same reason as `ToolPermissionModal`
 * and `AllowedRootsEditor`: the app uses `backdrop-filter` on several
 * ancestors and `position: fixed` inside such a parent would be scoped
 * to that parent rather than the viewport.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { isTauri } from '../../utils/saveBlob.ts';
import { cleanPath, isAbsolutePath } from '../../modules/tool-engine/clean-path.ts';
import { checkPath } from '../../modules/tool-engine/path-safety.ts';
import { errorMessage } from '../../modules/llm-client/index.ts';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Currently active directories for this conversation. */
  activeRoots: string[];
  /** Called with the new set of active directories on commit. */
  onChange: (roots: string[]) => void;
  /** Known directories from global settings. */
  knownDirs: string[];
  /** Called when the user adds a brand-new directory via the input/Browse. */
  onAddKnownDir?: (path: string) => void;
}

export function WorkspaceManager({
  open,
  onClose,
  activeRoots,
  onChange,
  knownDirs,
  onAddKnownDir,
}: Props) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Checked set — seeded from activeRoots on open. Managed locally so
  // toggles are instant; only flushed to onChange on "Add" click.
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // Normalise known dirs for display (strip trailing separators).
  const cleanKnownDirs = useMemo(
    () => knownDirs.map((d) => cleanPath(d)).filter(Boolean),
    [knownDirs],
  );

  // Reset state whenever the modal opens.
  useEffect(() => {
    if (open) {
      setDraft('');
      setError(null);
      setChecked(new Set(activeRoots.map((r) => cleanPath(r)).filter(Boolean)));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes, but only while this is the innermost overlay.
  useOverlayEscape(onClose, open);

  const toggle = useCallback((path: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const browse = useCallback(async () => {
    if (!isTauri) {
      setError('Browse requires the desktop app — paste a path instead.');
      return;
    }
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === 'string' && picked) {
        setDraft(cleanPath(picked));
        setError(null);
      }
    } catch (e) {
      setError(`Browse failed: ${errorMessage(e)}`);
    }
  }, []);

  const commit = useCallback(async () => {
    let newPath: string | null = null;
    const trimmed = draft.trim();
    if (trimmed) {
      const cleaned = cleanPath(trimmed);
      if (!cleaned) {
        setError('Enter a path.');
        return;
      }
      if (!isAbsolutePath(cleaned)) {
        setError(
          `Path must be absolute (e.g. ${navigator.platform.toLowerCase().includes('win') ? 'C:\\Users\\me\\Projects' : '/Users/me/projects'}).`,
        );
        return;
      }
      const res = await checkPath(cleaned);
      if (!res.exists) {
        setError(`Directory does not exist: ${cleaned}`);
        return;
      }
      if (!res.is_dir) {
        setError(`Path is a file, not a directory: ${cleaned}`);
        return;
      }
      newPath = res.canonical ?? cleaned;
    }

    // Build final active roots: checked known dirs + new path (if any).
    const finalRoots = new Set(checked);
    if (newPath) {
      finalRoots.add(newPath);
      // Also add to known dirs so it persists for future use.
      onAddKnownDir?.(newPath);
    }
    onChange(Array.from(finalRoots));
    onClose();
  }, [draft, checked, onChange, onAddKnownDir, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') void commit();
    },
    [commit],
  );

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="nmp-title"
      onClick={onClose}
    >
      <div
        className="modal-card workspace-manager"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="workspace-manager-header">
          <h3 id="nmp-title">Add directories</h3>
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

        <div className="workspace-manager-columns">
          <section className="workspace-manager-column workspace-manager-column--full">
            <h4>Known directories</h4>
            <ul
              className="workspace-manager-list"
              style={{}}
            >
              {cleanKnownDirs.length === 0 && (
                <li className="workspace-manager-empty">
                  None. Add in Settings → AGENTIC TOOLS.
                </li>
              )}
              {cleanKnownDirs.map((p) => (
                <li
                  key={p}
                  className="workspace-manager-list-item"
                >
                  <label className="workspace-manager-check-row">
                    <input
                      type="checkbox"
                      checked={checked.has(p)}
                      onChange={() => toggle(p)}
                    />
                    <code>{p}</code>
                  </label>
                </li>
              ))}
            </ul>
            <p className="workspace-manager-hint">
              Checked directories will be active in this conversation.
            </p>
          </section>
        </div>

        <div className="workspace-manager-separator" />

        <div className="workspace-manager-input-block">
          <span className="workspace-manager-input-label">
            Add a different directory
          </span>
          <div className="workspace-manager-input-row">
            <input
              id="workspace-allowed-roots-input"
              type="text"
              className="allowed-roots-input"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Absolute path…"
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
              onClick={() => void commit()}
            >
              Add
            </button>
          </div>
          {error && <p className="allowed-roots-error">{error}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
