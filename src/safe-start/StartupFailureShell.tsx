import type { StartupFailureCode } from '../startup/startup-state';

export default function StartupFailureShell({ code }: { code: StartupFailureCode }) {
  return (
    <main className="safe-start-shell">
      <div className="safe-start-card compact" role="alert">
        <header className="safe-start-header">
          <div className="safe-start-badge neutral">Startup stopped</div>
          <h1>LC could not complete this startup</h1>
          <p>
            No private exception details are shown. Close LC and try again. After a second consecutive
            incomplete launch, LC will open Safe Start automatically.
          </p>
        </header>
        <dl className="safe-start-facts">
          <div><dt>Failure code</dt><dd>{code}</dd></div>
        </dl>
      </div>
    </main>
  );
}
