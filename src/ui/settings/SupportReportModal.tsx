import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { recordDiagnosticEvent } from '../../utils/diagnostic-events.ts';
import { createCurrentSupportReport } from '../../utils/support-report-collector.ts';
import {
  copySupportReport,
  saveSupportReport,
  supportReportPreviewText,
} from '../../utils/support-report-delivery.ts';
import type { SupportReportSnapshot } from '../../utils/support-report-base';
import { useOrderedOverlayLayer, useOverlayEscape } from '../../utils/overlay-stack.ts';
import { toast } from '../../utils/toast.ts';
import { LC_ISSUES_URL, openSupportLink } from './support-links.ts';

interface Props {
  open: boolean;
  onClose: () => void;
}

function formattedBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function SupportReportModal({ open, onClose }: Props) {
  const [includeModelIdentifiers, setIncludeModelIdentifiers] = useState(false);
  const [includeErrorDescriptions, setIncludeErrorDescriptions] = useState(false);
  const [snapshot, setSnapshot] = useState<SupportReportSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useOverlayEscape(onClose, open);
  const orderedLayerRef = useOrderedOverlayLayer(open);

  useEffect(() => {
    if (open) return;
    generation.current++;
    setIncludeModelIdentifiers(false);
    setIncludeErrorDescriptions(false);
    setSnapshot(null);
    setError(null);
    setLoading(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = ++generation.current;
    setLoading(true);
    setError(null);
    void createCurrentSupportReport({ includeModelIdentifiers, includeErrorDescriptions })
      .then((next) => {
        if (id !== generation.current) return;
        setSnapshot(next);
        setLoading(false);
        recordDiagnosticEvent({
          subsystem: 'ui',
          operation: 'support-report',
          outcome: 'ok',
          code: 'report-created',
        });
      })
      .catch((cause) => {
        if (id !== generation.current) return;
        setSnapshot(null);
        setLoading(false);
        setError('LC could not create the report. Your data was not changed.');
        recordDiagnosticEvent({
          subsystem: 'ui',
          operation: 'support-report',
          outcome: 'error',
          code: 'report-failed',
          description: cause,
        });
      });
  }, [open, includeModelIdentifiers, includeErrorDescriptions]);

  if (!open) return null;

  const preview = snapshot ? supportReportPreviewText(snapshot) : '';

  return createPortal(
    <div
      ref={orderedLayerRef}
      className="modal-backdrop support-report-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="support-report-title"
      onClick={onClose}
    >
      <div className="modal-card support-report-modal" onClick={(event) => event.stopPropagation()}>
        <div className="support-report-header">
          <h3 id="support-report-title">Support report <span className="support-report-title-hint">Shift F1</span></h3>
          <button type="button" className="icon-btn" aria-label="Close support report" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path
                fill="currentColor"
                d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
        </div>
        <p className="support-report-intro">
          Review the exact JSON that Copy and Save will use. LC never uploads this report.
        </p>

        <div className="support-report-options" aria-label="Optional report data">
          <label>
            <input
              type="checkbox"
              checked={includeModelIdentifiers}
              onChange={(event) => setIncludeModelIdentifiers(event.target.checked)}
            />
            Include exact model identifiers
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeErrorDescriptions}
              onChange={(event) => setIncludeErrorDescriptions(event.target.checked)}
            />
            Include sanitized error descriptions
          </label>
        </div>

        <p className="support-report-privacy-note">
          Conversations, prompts, reasoning, attachments, tool inputs/results, skill content, private paths,
          credentials, exact endpoint hosts, and provider response bodies are excluded.
        </p>

        <div className="support-report-preview-head">
          <span>Final JSON preview</span>
          <span>{snapshot ? `${snapshot.filename} · ${formattedBytes(snapshot.byteLength)}` : ''}</span>
        </div>
        {loading ? (
          <div className="support-report-status" role="status">Creating a bounded local report…</div>
        ) : error ? (
          <div className="support-report-status is-error" role="alert">{error}</div>
        ) : (
          <pre className="support-report-preview" aria-label="Final support report JSON">{preview}</pre>
        )}

        <div className="support-report-actions">
          <button
            type="button"
            className="ghost-btn small"
            onClick={() => void openSupportLink(LC_ISSUES_URL)}
          >
            Report issue
          </button>
          <div className="support-report-action-group">
            <button type="button" className="ghost-btn small" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="ghost-btn small"
              disabled={!snapshot || loading}
              onClick={async () => {
                if (!snapshot) return;
                try {
                  await copySupportReport(snapshot);
                  recordDiagnosticEvent({ subsystem: 'ui', operation: 'support-report', outcome: 'ok', code: 'report-copied' });
                  toast.success('Support report copied.');
                } catch {
                  toast.error('Could not copy the support report.');
                }
              }}
            >
              Copy
            </button>
            <button
              type="button"
              className="primary-btn small"
              disabled={!snapshot || loading}
              onClick={async () => {
                if (!snapshot) return;
                try {
                  if (await saveSupportReport(snapshot)) {
                    recordDiagnosticEvent({ subsystem: 'ui', operation: 'support-report', outcome: 'ok', code: 'report-saved' });
                    toast.success('Support report saved.');
                  }
                } catch {
                  toast.error('Could not save the support report.');
                }
              }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
