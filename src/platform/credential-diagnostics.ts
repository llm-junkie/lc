/**
 * Credential-bootstrap diagnostics.
 *
 * Scope is deliberately narrow. Profile resolution records either the chat
 * generation surface or the non-chat profile surface. Search startup records
 * its provider surface. Direct Settings reveals remain uninstrumented.
 *
 * What is recorded: a closed surface name and a closed outcome code. Never the
 * value, the keychain reference name, an account or project id, a header, or
 * any exception text.
 */

import { recordDiagnosticEvent } from '../utils/diagnostic-events.ts';
import type { CredentialSurface } from '../utils/support-report-base';

/** Bounded bootstrap outcomes, mapped to the closed diagnostic vocabulary. */
export type CredentialBootstrapOutcome =
  /** The keychain returned a usable value. */
  | 'loaded'
  /** The reference exists but the keychain holds no entry for it. */
  | 'missing'
  /** The keychain could not be read or written at all. */
  | 'unavailable';

/**
 * Record one credential resolution or bootstrap outcome.
 *
 * Callers that never touched the keychain (no reference configured) must not
 * call this: an absent reference is configuration state, which the report
 * already carries as `authConfiguration.surfaces[].state`.
 */
export function recordCredentialBootstrap(
  surface: CredentialSurface,
  outcome: CredentialBootstrapOutcome,
): void {
  recordDiagnosticEvent({
    subsystem: 'credential',
    operation: 'bootstrap',
    outcome: outcome === 'loaded' ? 'ok' : outcome === 'missing' ? 'rejected' : 'error',
    code: outcome === 'loaded'
      ? 'credential-keychain-ok'
      : outcome === 'missing'
        ? 'credential-missing'
        : 'credential-keychain-unavailable',
    credentialSurface: surface,
    credentialState: 'keychain-ref',
  });
}
