import * as React from 'react';
import {
  STARTUP_INCOMPLETE_LIMIT,
  type StartupDiagnosticSnapshot,
} from '../startup/startup-state.ts';
import type { StartupLifecycle } from '../startup/startup-runtime';
import {
  openApplicationDataDirectory,
  resetSavedWindowGeometry,
} from '../startup/startup-platform.ts';
import {
  copySupportReport,
  saveSupportReport,
  supportReportPreviewText,
} from '../utils/support-report-delivery.ts';
import type { SupportReportSnapshot } from '../utils/support-report-base';
import { createSafeStartSupportReport } from './safe-start-support-report.ts';
import { recordDiagnosticEvent } from '../utils/diagnostic-events.ts';
import type { DiagnosticCode } from '../utils/support-report-base';

/**
 * Record a Safe Start recovery action. Only the closed action code and its
 * outcome are kept; the report never carries a path, a window rectangle, or
 * any user text (docs/support-report.md).
 */
function recordRecoveryAction(code: DiagnosticCode, ok: boolean): void {
  recordDiagnosticEvent({
    subsystem: 'ui',
    operation: 'recovery-action',
    outcome: ok ? 'ok' : 'error',
    code,
  });
}

interface SafeStartShellProps {
  startup: StartupLifecycle;
}

const { useState } = React;

function phaseLabel(phase: StartupDiagnosticSnapshot['lastCompletedPhase']): string {
  return phase === 'unknown' ? 'No startup phase was recorded' : phase;
}

function SupportReportPanel({ startup }: { startup: StartupLifecycle }) {
  const [snapshot, setSnapshot] = useState<SupportReportSnapshot | null>(null);
  const [includeDescriptions, setIncludeDescriptions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const create = async () => {
    setBusy(true);
    setStatus('');
    try {
      setSnapshot(await createSafeStartSupportReport(
        startup.snapshot(),
        { includeErrorDescriptions: includeDescriptions },
      ));
    } catch {
      setSnapshot(null);
      setStatus('LC could not create the report. Your data was not changed.');
    } finally {
      setBusy(false);
    }
  };

  if (!snapshot) {
    return (
      <section className="safe-start-section" aria-labelledby="safe-start-report-title">
        <h2 id="safe-start-report-title">Support report</h2>
        <p>
          Create a bounded, redacted JSON report without opening settings or conversation storage.
          LC never uploads it.
        </p>
        <label className="safe-start-checkbox">
          <input
            type="checkbox"
            checked={includeDescriptions}
            onChange={(event) => setIncludeDescriptions(event.target.checked)}
          />
          Include sanitized diagnostic descriptions
        </label>
        <button type="button" className="safe-start-primary" disabled={busy} onClick={() => void create()}>
          {busy ? 'Creating report…' : 'Create support report'}
        </button>
        {status && <p className="safe-start-error" role="alert">{status}</p>}
      </section>
    );
  }

  const preview = supportReportPreviewText(snapshot);
  return (
    <section className="safe-start-section" aria-labelledby="safe-start-report-title">
      <div className="safe-start-row">
        <h2 id="safe-start-report-title">Support report</h2>
        <button type="button" className="safe-start-link" onClick={() => setSnapshot(null)}>Close preview</button>
      </div>
      <p>Review the exact JSON bytes that Copy and Save will use. LC never uploads this report.</p>
      <pre className="safe-start-report-preview" aria-label="Final support report JSON">{preview}</pre>
      <div className="safe-start-actions">
        <button
          type="button"
          onClick={() => void copySupportReport(snapshot)
            .then(() => setStatus('Support report copied.'))
            .catch(() => setStatus('Could not copy the support report.'))}
        >
          Copy
        </button>
        <button
          type="button"
          className="safe-start-primary"
          onClick={() => void saveSupportReport(snapshot)
            .then((saved) => setStatus(saved ? 'Support report saved.' : ''))
            .catch(() => setStatus('Could not save the support report.'))}
        >
          Save
        </button>
      </div>
      {status && <p className="safe-start-status" role="status">{status}</p>}
    </section>
  );
}

export default function SafeStartShell({ startup }: SafeStartShellProps) {
  const snapshot = startup.snapshot();
  const [actionStatus, setActionStatus] = useState('');
  // The headline must state the recorded cause: an explicit --safe-start or a
  // failed retry can open the shell with fewer than two incomplete launches.
  const headline = snapshot.incompleteStartCount >= STARTUP_INCOMPLETE_LIMIT
    ? 'Two consecutive desktop launches ended before LC became ready.'
    : 'LC paused normal startup for recovery.';

  return (
    <main className="safe-start-shell">
      <div className="safe-start-card">
        <header className="safe-start-header">
          <div className="safe-start-badge">Safe Start</div>
          <h1>LC paused normal startup</h1>
          <p>
            {headline} This recovery session does not open your conversations, load models, run tools,
            or modify application data.
          </p>
        </header>

        <dl className="safe-start-facts">
          <div><dt>Last completed phase</dt><dd>{phaseLabel(snapshot.lastCompletedPhase)}</dd></div>
          <div><dt>Incomplete starts</dt><dd>{snapshot.incompleteStartCount}</dd></div>
          <div><dt>Failure code</dt><dd>{snapshot.failureCode ?? 'not-recorded'}</dd></div>
        </dl>

        <section className="safe-start-section" aria-labelledby="safe-start-retry-title">
          <h2 id="safe-start-retry-title">Retry normal startup</h2>
          <p>
            Retry once in this launch. LC will not resume a generation or retry an interrupted tool call.
            If startup fails again, the next launch returns to Safe Start.
          </p>
          <button
            type="button"
            className="safe-start-primary"
            onClick={() => {
              recordRecoveryAction('safe-start-retry', true);
              startup.requestNormalRetry();
              window.location.reload();
            }}
          >
            Retry normal start once
          </button>
        </section>

        <SupportReportPanel startup={startup} />

        <section className="safe-start-section" aria-labelledby="safe-start-recovery-title">
          <h2 id="safe-start-recovery-title">Narrow recovery actions</h2>
          <p>These actions do not delete or repair the conversation database.</p>
          <div className="safe-start-actions vertical">
            <button
              type="button"
              onClick={() => {
                const confirmed = window.confirm(
                  'Reset only the saved main-window size and position?\n\n'
                  + 'This does not change conversations, messages, settings, profiles, keys, grants, skills, or workspace files.',
                );
                if (!confirmed) return;
                void resetSavedWindowGeometry()
                  .then(() => {
                    recordRecoveryAction('safe-start-reset-geometry', true);
                    setActionStatus('Saved main-window geometry was reset.');
                  })
                  .catch(() => {
                    recordRecoveryAction('safe-start-reset-geometry', false);
                    setActionStatus('Could not reset saved main-window geometry.');
                  });
              }}
            >
              Reset saved main-window geometry…
            </button>
            <button
              type="button"
              onClick={() => void openApplicationDataDirectory()
                .then(() => {
                  recordRecoveryAction('safe-start-open-data-dir', true);
                  setActionStatus('Opened the LC application data directory.');
                })
                .catch(() => {
                  recordRecoveryAction('safe-start-open-data-dir', false);
                  setActionStatus('Could not open the LC application data directory.');
                })}
            >
              Open application data directory
            </button>
          </div>
          {actionStatus && <p className="safe-start-status" role="status">{actionStatus}</p>}
        </section>

        <p className="safe-start-guarantee">
          Safe Start never automatically deletes, rewrites, migrates, or resets conversations, messages,
          attachments, profiles, API keys, tool grants, workspace roots or files, skills, portable settings,
          or the conversation database.
        </p>
      </div>
    </main>
  );
}
