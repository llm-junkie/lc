/** Browser persistence adapter and side-effect boundary for Safe Start. */

import { recordDiagnosticEvent } from '../utils/diagnostic-events.ts';
import { runLocalStorageMutation } from '../store/local-storage.ts';
import {
  STARTUP_STORAGE_KEY,
  advanceStartupPhase,
  beginStartup,
  initialStartupMarker,
  markStartupFailure,
  markStartupReady,
  parseStartupMarker,
  requestNormalStartRetry,
  serializeStartupMarker,
  startupSnapshot,
  type BeginStartupResult,
  type StartupDiagnosticSnapshot,
  type StartupFailureCode,
  type StartupMarker,
  type StartupPhase,
} from './startup-state.ts';

const PROCESS_SESSION_KEY = 'lc:startup-process:v1';
const RETRY_SESSION_KEY = 'lc:safe-start-retry-normal:v1';

export interface StartupPersistence {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StartupControllerOptions {
  persistence?: StartupPersistence;
  sessionPersistence?: StartupPersistence;
  automaticSafeStart: boolean;
  newProcess: boolean;
  manualSafeStart?: boolean;
  manualNormalRetry?: boolean;
}

export interface StartupLifecycle {
  readonly mode: 'normal' | 'safe-start';
  readonly retryAttempt: boolean;
  phase(phase: StartupPhase): void;
  failure(code: StartupFailureCode): void;
  ready(): void;
  snapshot(): StartupDiagnosticSnapshot;
  requestNormalRetry(): void;
}

function markerEqual(left: StartupMarker, right: StartupMarker): boolean {
  return serializeStartupMarker(left) === serializeStartupMarker(right);
}

export class StartupController implements StartupLifecycle {
  readonly mode: 'normal' | 'safe-start';
  readonly retryAttempt: boolean;
  private marker: StartupMarker;
  private readonly persistence?: StartupPersistence;
  private readonly sessionPersistence?: StartupPersistence;
  private readonly trackAttempt: boolean;
  private persistenceAvailable: boolean;

  constructor(options: StartupControllerOptions) {
    this.persistence = options.persistence;
    this.sessionPersistence = options.sessionPersistence;
    this.persistenceAvailable = options.persistence !== undefined;

    let previous = initialStartupMarker();
    let malformed = false;
    if (this.persistence) {
      try {
        const parsed = parseStartupMarker(this.persistence.getItem(STARTUP_STORAGE_KEY));
        previous = parsed.marker;
        malformed = parsed.malformed;
      } catch {
        this.persistenceAvailable = false;
      }
    }

    // Without reliable persistence we cannot distinguish a fresh desktop
    // launch from a reload across failures, so automatic recovery is disabled
    // for this attempt. A manual --safe-start request still works in memory.
    const automaticSafeStart = options.automaticSafeStart && this.persistenceAvailable;
    const transition: BeginStartupResult = beginStartup(previous, {
      automaticSafeStart,
      newProcess: options.newProcess,
      manualSafeStart: options.manualSafeStart,
      manualNormalRetry: options.manualNormalRetry,
    });
    this.mode = transition.mode;
    this.retryAttempt = transition.retryAttempt;
    this.trackAttempt = transition.trackAttempt;
    this.marker = transition.marker;

    if (!this.persistenceAvailable) {
      this.marker = {
        ...this.marker,
        safeStartState: this.mode === 'safe-start' ? 'active' : 'not-available',
        failureCode: 'startup-marker-unavailable',
      };
    } else if (malformed && this.mode === 'normal') {
      this.marker = { ...this.marker, failureCode: 'startup-marker-malformed' };
    }

    this.persist();
    if (this.trackAttempt && this.mode === 'normal') this.recordPhaseEvent();
  }

  private replace(next: StartupMarker): boolean {
    if (markerEqual(this.marker, next)) return false;
    this.marker = next;
    this.persist();
    return true;
  }

  private persist(): void {
    const persistence = this.persistence;
    if (!persistence || !this.persistenceAvailable || !this.trackAttempt) return;
    const saved = runLocalStorageMutation(() => {
      persistence.setItem(STARTUP_STORAGE_KEY, serializeStartupMarker(this.marker));
    });
    if (!saved) {
      this.persistenceAvailable = false;
      this.marker = {
        ...this.marker,
        safeStartState: this.mode === 'safe-start' ? 'active' : 'not-available',
        failureCode: 'startup-marker-unavailable',
      };
    }
  }

  private recordPhaseEvent(): void {
    recordDiagnosticEvent({
      subsystem: 'startup',
      operation: 'phase',
      outcome: 'ok',
      code: 'startup-phase',
    });
  }

  phase(phase: StartupPhase): void {
    if (!this.trackAttempt || this.mode !== 'normal') return;
    const changed = this.replace(advanceStartupPhase(this.marker, phase));
    if (changed) this.recordPhaseEvent();
  }

  failure(code: StartupFailureCode): void {
    if (!this.trackAttempt || this.mode !== 'normal') return;
    if (!this.replace(markStartupFailure(this.marker, code))) return;
    recordDiagnosticEvent({
      subsystem: 'startup',
      operation: 'phase',
      outcome: 'error',
      code,
    });
  }

  ready(): void {
    if (!this.trackAttempt || this.mode !== 'normal') return;
    if (!this.replace(markStartupReady(this.marker))) return;
    this.recordPhaseEvent();
  }

  snapshot(): StartupDiagnosticSnapshot {
    return startupSnapshot(this.marker);
  }

  requestNormalRetry(): void {
    if (this.mode !== 'safe-start') return;
    this.replace(requestNormalStartRetry(this.marker));
    try {
      this.sessionPersistence?.setItem(RETRY_SESSION_KEY, '1');
    } catch {
      // The durable marker remains the primary retry path.
    }
  }
}

function browserPersistence(name: 'localStorage' | 'sessionStorage'): StartupPersistence | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window[name];
  } catch {
    return undefined;
  }
}

/**
 * Returns whether this is the first renderer document in the native process.
 * sessionStorage survives page reload/HMR but is discarded with the webview.
 * When it is unavailable, callers must disable automatic counting.
 */
export function claimDesktopProcess(
  storage = browserPersistence('sessionStorage'),
): { newProcess: boolean; reliable: boolean } {
  if (!storage) return { newProcess: false, reliable: false };
  try {
    if (storage.getItem(PROCESS_SESSION_KEY) === '1') {
      return { newProcess: false, reliable: true };
    }
    storage.setItem(PROCESS_SESSION_KEY, '1');
    return { newProcess: true, reliable: true };
  } catch {
    return { newProcess: false, reliable: false };
  }
}

export function createBrowserStartupController(options: {
  packagedTauri: boolean;
  manualSafeStart?: boolean;
}): StartupController {
  const sessionPersistence = browserPersistence('sessionStorage');
  const process = claimDesktopProcess(sessionPersistence);
  let manualNormalRetry: boolean;
  try {
    manualNormalRetry = sessionPersistence?.getItem(RETRY_SESSION_KEY) === '1';
    if (manualNormalRetry) sessionPersistence?.setItem(RETRY_SESSION_KEY, '0');
  } catch {
    manualNormalRetry = false;
  }
  return new StartupController({
    persistence: browserPersistence('localStorage'),
    sessionPersistence,
    automaticSafeStart: options.packagedTauri && process.reliable,
    newProcess: process.newProcess,
    manualSafeStart: options.manualSafeStart,
    manualNormalRetry,
  });
}

export function readPersistedStartupDiagnostics(
  storage = browserPersistence('localStorage'),
): StartupDiagnosticSnapshot {
  if (!storage) return startupSnapshot(initialStartupMarker());
  try {
    const parsed = parseStartupMarker(storage.getItem(STARTUP_STORAGE_KEY));
    if (parsed.malformed) {
      return startupSnapshot({
        ...initialStartupMarker(),
        failureCode: 'startup-marker-malformed',
      });
    }
    return startupSnapshot(parsed.marker);
  } catch {
    return startupSnapshot({
      ...initialStartupMarker(),
      failureCode: 'startup-marker-unavailable',
    });
  }
}
