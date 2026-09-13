/**
 * Pure, bounded startup state machine.
 *
 * This module deliberately has no browser, React, store, database, provider,
 * tool, or Tauri dependencies. Persistence and diagnostic side effects live in
 * `startup-runtime.ts`, which makes every transition independently testable.
 */

export const STARTUP_STORAGE_KEY = 'lc:startup-diagnostics:v1';
export const STARTUP_INCOMPLETE_LIMIT = 2 as const;

export const STARTUP_PHASES = [
  'renderer-created',
  'settings-validated',
  'storage-opened',
  'conversation-metadata-loaded',
  'shell-mounted',
  'ready',
] as const;
export type StartupPhase = (typeof STARTUP_PHASES)[number];

export const STARTUP_FAILURE_CODES = [
  'startup-marker-malformed',
  'startup-marker-unavailable',
  'settings-storage-unavailable',
  'settings-malformed',
  'normal-app-import-failed',
  'conversation-storage-unavailable',
  'conversation-metadata-unavailable',
  'shell-mount-failed',
  // The recovery surface itself could not be imported. Rendered by the
  // inline entry-chunk fallback so a broken chunk graph never shows a blank
  // window (docs/security.md Safe Start recovery boundary).
  'startup-interface-unavailable',
  'startup-failure-unknown',
] as const;
export type StartupFailureCode = (typeof STARTUP_FAILURE_CODES)[number];

export type SafeStartState = 'not-available' | 'inactive' | 'active' | 'unknown';

export interface StartupMarker {
  readonly version: 1;
  readonly status: 'idle' | 'starting';
  readonly lastCompletedPhase: StartupPhase | 'unknown';
  readonly incompleteStartCount: number;
  readonly safeStartState: SafeStartState;
  readonly failureCode?: StartupFailureCode;
  readonly retryNormalOnce: boolean;
  readonly retryAttempt: boolean;
}

export interface StartupDiagnosticSnapshot {
  lastCompletedPhase: StartupPhase | 'unknown';
  incompleteStartCount: number;
  safeStartState: SafeStartState;
  failureCode?: StartupFailureCode;
}

export interface StartupParseResult {
  marker: StartupMarker;
  malformed: boolean;
}

export interface BeginStartupOptions {
  /** Automatic failure counting is restricted to packaged desktop builds. */
  automaticSafeStart: boolean;
  /** False for HMR and ordinary reloads in the same renderer process. */
  newProcess: boolean;
  /** Cross-platform Tauri command-line override (`--safe-start`). */
  manualSafeStart?: boolean;
  /** Process-scoped one-shot retry used when marker persistence is degraded. */
  manualNormalRetry?: boolean;
}

export interface BeginStartupResult {
  mode: 'normal' | 'safe-start';
  marker: StartupMarker;
  /** False means phase/readiness calls are intentionally in-memory no-ops. */
  trackAttempt: boolean;
  retryAttempt: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === 'string' && values.includes(value) ? value : undefined;
}

function boundedCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(STARTUP_INCOMPLETE_LIMIT, Math.max(0, Math.trunc(value)));
}

export function initialStartupMarker(
  safeStartState: SafeStartState = 'not-available',
): StartupMarker {
  return {
    version: 1,
    status: 'idle',
    lastCompletedPhase: 'unknown',
    incompleteStartCount: 0,
    safeStartState,
    retryNormalOnce: false,
    retryAttempt: false,
  };
}

/** Parse the persisted allowlisted marker. Unknown keys are never retained. */
export function parseStartupMarker(raw: string | null): StartupParseResult {
  if (raw === null || raw === '') return { marker: initialStartupMarker(), malformed: false };
  if (raw.length > 4 * 1024) return { marker: initialStartupMarker(), malformed: true };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) {
      return { marker: initialStartupMarker(), malformed: true };
    }

    const phase = parsed.lastCompletedPhase === 'unknown'
      ? 'unknown'
      : oneOf(parsed.lastCompletedPhase, STARTUP_PHASES);
    const count = boundedCount(parsed.incompleteStartCount);
    const safeStartState = oneOf(
      parsed.safeStartState,
      ['not-available', 'inactive', 'active', 'unknown'] as const,
    );
    if (!phase || count === undefined || !safeStartState) {
      return { marker: initialStartupMarker(), malformed: true };
    }

    // P0-A wrote a diagnostics-only v1 shape. Missing transition fields are
    // accepted as a legacy idle marker so the P0-B upgrade cannot create an
    // artificial incomplete startup.
    const status = oneOf(parsed.status, ['idle', 'starting'] as const) ?? 'idle';
    const failureCode = oneOf(parsed.failureCode, STARTUP_FAILURE_CODES);
    return {
      malformed: false,
      marker: {
        version: 1,
        status,
        lastCompletedPhase: phase,
        incompleteStartCount: count,
        safeStartState,
        ...(failureCode ? { failureCode } : {}),
        retryNormalOnce: parsed.retryNormalOnce === true,
        retryAttempt: parsed.retryAttempt === true,
      },
    };
  } catch {
    return { marker: initialStartupMarker(), malformed: true };
  }
}

export function serializeStartupMarker(marker: StartupMarker): string {
  return JSON.stringify({
    version: 1,
    status: marker.status,
    lastCompletedPhase: marker.lastCompletedPhase,
    incompleteStartCount: boundedCount(marker.incompleteStartCount) ?? 0,
    safeStartState: marker.safeStartState,
    ...(marker.failureCode ? { failureCode: marker.failureCode } : {}),
    retryNormalOnce: marker.retryNormalOnce,
    retryAttempt: marker.retryAttempt,
  });
}

export function startupSnapshot(marker: StartupMarker): StartupDiagnosticSnapshot {
  return {
    lastCompletedPhase: marker.lastCompletedPhase,
    incompleteStartCount: marker.incompleteStartCount,
    safeStartState: marker.safeStartState,
    ...(marker.failureCode ? { failureCode: marker.failureCode } : {}),
  };
}

export function beginStartup(
  previous: StartupMarker,
  options: BeginStartupOptions,
): BeginStartupResult {
  const automatic = options.automaticSafeStart;
  const manual = options.manualSafeStart === true;

  // Web/dev launches remain observable in memory but never participate in
  // persisted automatic failure detection.
  if (!automatic && !manual) {
    return {
      mode: 'normal',
      marker: initialStartupMarker('not-available'),
      trackAttempt: false,
      retryAttempt: false,
    };
  }

  let incompleteStartCount = previous.incompleteStartCount;
  const previousIncomplete = options.newProcess && previous.status === 'starting';
  if (previousIncomplete) {
    incompleteStartCount = Math.min(STARTUP_INCOMPLETE_LIMIT, incompleteStartCount + 1);
  }

  // A retry token has precedence over both automatic and command-line Safe
  // Start. It is consumed in this transition and marked as a retry attempt so
  // any later reload/fresh launch returns to Safe Start instead of looping.
  if (previous.retryNormalOnce || options.manualNormalRetry === true) {
    return {
      mode: 'normal',
      trackAttempt: true,
      retryAttempt: true,
      marker: {
        version: 1,
        status: 'starting',
        lastCompletedPhase: 'renderer-created',
        incompleteStartCount,
        safeStartState: 'inactive',
        retryNormalOnce: false,
        retryAttempt: true,
      },
    };
  }

  const failedRetry = previous.status === 'starting' && previous.retryAttempt;
  const automaticRecovery = automatic
    && (incompleteStartCount >= STARTUP_INCOMPLETE_LIMIT || failedRetry);
  if (manual || automaticRecovery) {
    return {
      mode: 'safe-start',
      trackAttempt: true,
      retryAttempt: false,
      marker: {
        ...previous,
        status: 'idle',
        // Keep the real count (bounded above, never clamped up): a failed
        // retry from a manual --safe-start has exactly one failed launch to
        // report, and the recovery shell derives its headline from these
        // facts instead of assuming two. automaticRecovery already implies
        // the count is at the limit or the retry failed, so no clamp is
        // needed on this branch.
        incompleteStartCount,
        safeStartState: 'active',
        retryNormalOnce: false,
        retryAttempt: false,
      },
    };
  }

  // Same-renderer StrictMode/HMR/reload continuations must not turn one native
  // launch into multiple attempts. A completed process reload is deliberately
  // untracked; an in-flight normal attempt keeps its original marker.
  if (!options.newProcess) {
    if (previous.status === 'starting') {
      return {
        mode: 'normal',
        marker: previous,
        trackAttempt: true,
        retryAttempt: previous.retryAttempt,
      };
    }
    return {
      mode: 'normal',
      marker: previous,
      trackAttempt: false,
      retryAttempt: false,
    };
  }

  return {
    mode: 'normal',
    trackAttempt: true,
    retryAttempt: false,
    marker: {
      version: 1,
      status: 'starting',
      lastCompletedPhase: 'renderer-created',
      incompleteStartCount,
      safeStartState: 'inactive',
      retryNormalOnce: false,
      retryAttempt: false,
    },
  };
}

export function advanceStartupPhase(marker: StartupMarker, phase: StartupPhase): StartupMarker {
  if (marker.status !== 'starting') return marker;
  if (phase === 'ready') return markStartupReady(marker);
  const currentIndex = marker.lastCompletedPhase === 'unknown'
    ? -1
    : STARTUP_PHASES.indexOf(marker.lastCompletedPhase);
  const nextIndex = STARTUP_PHASES.indexOf(phase);
  if (nextIndex <= currentIndex) return marker;
  return { ...marker, lastCompletedPhase: phase };
}

export function markStartupFailure(
  marker: StartupMarker,
  failureCode: StartupFailureCode,
): StartupMarker {
  if (marker.status !== 'starting' || marker.failureCode === failureCode) return marker;
  return { ...marker, failureCode };
}

export function markStartupReady(marker: StartupMarker): StartupMarker {
  if (
    marker.status === 'idle'
    && marker.lastCompletedPhase === 'ready'
    && marker.incompleteStartCount === 0
    && marker.safeStartState === 'inactive'
    && !marker.failureCode
    && !marker.retryNormalOnce
    && !marker.retryAttempt
  ) return marker;
  return {
    version: 1,
    status: 'idle',
    lastCompletedPhase: 'ready',
    incompleteStartCount: 0,
    safeStartState: 'inactive',
    retryNormalOnce: false,
    retryAttempt: false,
  };
}

export function requestNormalStartRetry(marker: StartupMarker): StartupMarker {
  if (marker.retryNormalOnce) return marker;
  return {
    ...marker,
    status: 'idle',
    safeStartState: 'active',
    retryNormalOnce: true,
    retryAttempt: false,
  };
}
