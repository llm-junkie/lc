import type { StartupFailureCode } from './startup-state';
import type { StartupLifecycle } from './startup-runtime';

const SETTINGS_STORAGE_KEY = 'lc:settings';

export class SettingsStartupError extends Error {
  readonly code: Extract<
    StartupFailureCode,
    'settings-storage-unavailable' | 'settings-malformed'
  >;

  constructor(code: SettingsStartupError['code']) {
    super(code);
    this.name = 'SettingsStartupError';
    this.code = code;
  }
}

/**
 * Validate only the persisted envelope needed to import the normal settings
 * store safely. No values are copied, migrated, normalized, or written.
 */
export function validatePersistedSettings(
  storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): void {
  if (!storage) throw new SettingsStartupError('settings-storage-unavailable');
  let raw: string | null;
  try {
    raw = storage.getItem(SETTINGS_STORAGE_KEY);
  } catch {
    throw new SettingsStartupError('settings-storage-unavailable');
  }
  if (raw === null) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('invalid envelope');
    }
    const envelope = parsed as Record<string, unknown>;
    if (typeof envelope.state !== 'object' || envelope.state === null || Array.isArray(envelope.state)) {
      throw new Error('invalid state');
    }
    if (envelope.version !== undefined && !Number.isFinite(envelope.version)) {
      throw new Error('invalid version');
    }
  } catch {
    throw new SettingsStartupError('settings-malformed');
  }
}

export type StartupSurface<TNormal, TSafe, TFailure> =
  | { mode: 'normal'; module: TNormal }
  | { mode: 'safe-start'; module: TSafe }
  | { mode: 'startup-failure'; module: TFailure; code: StartupFailureCode };

/**
 * Select and load exactly one application graph. The Safe Start branch does
 * not call settings validation or the normal App loader.
 *
 * The loader chain is TOTAL: if the failure shell itself cannot be imported,
 * the caller-provided inline fallback (compiled into the entry chunk) renders
 * instead, so a broken chunk graph can never leave a visible blank window
 * (docs/security.md Safe Start recovery boundary).
 */
export async function loadStartupSurface<TNormal, TSafe, TFailure>(
  startup: StartupLifecycle,
  loaders: {
    validateSettings?: () => void;
    loadNormal: () => Promise<TNormal>;
    loadSafeStart: () => Promise<TSafe>;
    loadStartupFailure: () => Promise<TFailure>;
    /** Cannot-fail fallback living inside the entry chunk. */
    loadInlineFallback: () => TFailure | Promise<TFailure>;
  },
): Promise<StartupSurface<TNormal, TSafe, TFailure>> {
  const failureSurface = async (
    code: StartupFailureCode,
  ): Promise<StartupSurface<TNormal, TSafe, TFailure>> => {
    try {
      return { mode: 'startup-failure', module: await loaders.loadStartupFailure(), code };
    } catch {
      return { mode: 'startup-failure', module: await loaders.loadInlineFallback(), code };
    }
  };

  if (startup.mode === 'safe-start') {
    try {
      return { mode: 'safe-start', module: await loaders.loadSafeStart() };
    } catch {
      // The Safe Start marker stays active; the failure surface shows the
      // bounded code and the next launch still returns to Safe Start.
      return failureSurface('startup-interface-unavailable');
    }
  }

  try {
    (loaders.validateSettings ?? validatePersistedSettings)();
    startup.phase('settings-validated');
  } catch (error) {
    const code = error instanceof SettingsStartupError
      ? error.code
      : 'settings-storage-unavailable';
    startup.failure(code);
    return failureSurface(code);
  }

  try {
    return { mode: 'normal', module: await loaders.loadNormal() };
  } catch {
    const code = 'normal-app-import-failed';
    startup.failure(code);
    return failureSurface(code);
  }
}
