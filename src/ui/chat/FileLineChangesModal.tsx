import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FileChangeType,
  FileDiffLineType,
  FileLineChange,
  FileLineChanges,
} from '../../modules/tool-engine/file-line-changes';
import { materializeFileChangePreview } from '../../modules/tool-engine/file-line-changes.ts';
import { langFromName } from '../../utils/attachments.ts';
import { formatDateTime } from '../../utils/format.ts';
import { FileTypeIcon } from '../shared/FileTypeIcon.tsx';

interface Props {
  changes: FileLineChanges;
  messageId: string;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}

const CHANGE_LABELS: Record<FileChangeType, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
};

function fileName(path: string): string {
  const pieces = path.split(/[\\/]/);
  return pieces.at(-1) || path;
}

function parentPath(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : '';
}

function displayType(file: FileLineChange): FileChangeType {
  if (file.changeType) return file.changeType;
  if (file.moveTo) return 'renamed';
  return 'modified';
}

function diffPrefix(type: FileDiffLineType): string {
  if (type === 'added') return '+';
  if (type === 'removed') return '−';
  return ' ';
}

function formatChangeTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function FileLineChangesModal({ changes, messageId, onClose, onOpenFile }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const selected = changes.files[selectedIndex];
  const selectedPreview = useMemo(
    () => selected ? materializeFileChangePreview(selected) : undefined,
    [selected],
  );

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    if (selectedIndex >= changes.files.length) setSelectedIndex(0);
  }, [changes.files.length, selectedIndex]);

  const selectedPath = selected?.moveTo ?? selected?.path;
  const selectedName = selectedPath ? fileName(selectedPath) : '';
  const selectedParent = selectedPath ? parentPath(selectedPath) : '';
  const selectedType = selected ? displayType(selected) : 'modified';

  return (
    <div
      className="modal-backdrop file-line-changes-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal-card file-line-changes-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`file-line-changes-title-${messageId}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="file-line-changes-header">
          <div className="file-line-changes-heading">
            <h3 id={`file-line-changes-title-${messageId}`}>Changes</h3>
            <span className="file-line-changes-summary-label">
              {changes.files.length === 1 ? '1 file' : `${changes.files.length} files`}
            </span>
            <span className="file-line-changes-summary-counts" aria-label="Total line changes">
              <span className="bubble-lines-added">+{changes.added}</span>
              <span className="bubble-lines-removed">−{changes.removed}</span>
            </span>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close file changes"
            title="Close"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path
                fill="currentColor"
                d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
        </header>

        {changes.files.length > 0 ? (
          <div className="file-line-changes-layout">
            <aside className="file-line-changes-list" aria-label="Changed files">
              {changes.files.map((file, index) => {
                const path = file.moveTo ?? file.path;
                const name = fileName(path);
                const parent = parentPath(path);
                const type = displayType(file);
                return (
                  <button
                    type="button"
                    className={`file-line-change-row${selectedIndex === index ? ' is-selected' : ''}`}
                    key={`${file.path}-${file.moveTo ?? ''}`}
                    aria-pressed={selectedIndex === index}
                    onClick={() => setSelectedIndex(index)}
                    title={file.moveTo ? `${file.path} → ${file.moveTo}` : file.path}
                  >
                    <span className="file-line-change-icon" aria-hidden>
                      <FileTypeIcon lang={langFromName(name)} size={17} />
                    </span>
                    <span className="file-line-change-labels">
                      <span className="file-line-change-name">{name}</span>
                      <span className="file-line-change-parent">
                        {file.moveTo ? `${file.path} → ${file.moveTo}` : parent || file.path}
                      </span>
                    </span>
                    <span className="file-line-change-row-meta">
                      <span className={`file-line-change-type is-${type}`}>{CHANGE_LABELS[type]}</span>
                      <span className="file-line-change-counts" aria-label={`${file.added} lines added, ${file.removed} lines removed`}>
                        <span className="bubble-lines-added">+{file.added}</span>
                        <span className="bubble-lines-removed">−{file.removed}</span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </aside>

            {selected && (
              <section className="file-change-preview" aria-label={`Change preview for ${selectedPath}`}>
                <header className="file-change-preview-header">
                  <div className="file-change-preview-title">
                    <span className="file-change-preview-icon" aria-hidden>
                      <FileTypeIcon lang={langFromName(selectedName)} size={18} />
                    </span>
                    <span>
                      <strong>{selectedName}</strong>
                      {selectedParent && <small>{selectedParent}</small>}
                    </span>
                  </div>
                  <div className="file-change-preview-actions">
                    <span className={`file-line-change-type is-${selectedType}`}>{CHANGE_LABELS[selectedType]}</span>
                    {selectedPath !== '(unknown file)' && selectedType !== 'deleted' && (
                      <button type="button" className="file-change-open-button" onClick={() => onOpenFile(selectedPath)}>
                        Open file
                      </button>
                    )}
                  </div>
                </header>

                <div className="file-change-preview-body">
                  {selectedPreview?.previewUnavailableReason && (
                    <div className="file-change-preview-note" role="note">
                      {selectedPreview.previewUnavailableReason}
                    </div>
                  )}

                  {selectedPreview?.hunks?.length ? selectedPreview.hunks.map((hunk, hunkIndex) => (
                    <div className="file-change-hunk" key={`${hunk.label}-${hunkIndex}`}>
                      {(hunk.toolName || Number.isFinite(hunk.timestamp)) && (
                        <div className="file-change-hunk-header">
                          {hunk.toolName && (
                            <span className="file-change-hunk-tool">{hunk.toolName}</span>
                          )}
                          {Number.isFinite(hunk.timestamp) && (
                            <span className="file-change-hunk-meta">
                              <time
                                dateTime={new Date(hunk.timestamp!).toISOString()}
                                title={formatDateTime(hunk.timestamp!)}
                              >
                                {formatChangeTimestamp(hunk.timestamp!)}
                              </time>
                            </span>
                          )}
                        </div>
                      )}
                      <div className="file-change-diff" role="table" aria-label={`${hunk.label} diff`}>
                        {hunk.lines.map((line, lineIndex) => (
                          <div
                            className={`file-change-diff-line is-${line.type}`}
                            role="row"
                            key={`${lineIndex}-${line.type}`}
                          >
                            <span className="file-change-diff-gutter" aria-hidden>{diffPrefix(line.type)}</span>
                            <code role="cell">{line.content || ' '}</code>
                          </div>
                        ))}
                      </div>
                      {hunk.truncated && (
                        <div className="file-change-preview-truncated">
                          This long hunk was truncated for preview performance.
                        </div>
                      )}
                    </div>
                  )) : (
                    <div className="file-change-preview-empty">
                      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <path d="M14 2v6h6M8 13h8M8 17h5" />
                      </svg>
                      <strong>No textual preview available</strong>
                      <span>The change summary is still available for this file.</span>
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>
        ) : (
          <div className="file-line-changes-empty">
            <strong>Per-file details are unavailable</strong>
            <span>This conversation only contains the aggregate line counts.</span>
          </div>
        )}
      </section>
    </div>
  );
}
