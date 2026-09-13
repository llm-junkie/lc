/** Minimal Tauri bridge used before the normal application graph is loaded. */

interface TauriInternals {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function tauriInternals(): TauriInternals | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
}

export function isTauriRuntime(): boolean {
  return tauriInternals() !== undefined;
}

export function isPackagedTauriRuntime(): boolean {
  return isTauriRuntime() && import.meta.env.PROD;
}

export async function manualSafeStartRequested(): Promise<boolean> {
  const invoke = tauriInternals()?.invoke;
  if (!invoke) return false;
  try {
    const result = await invoke('startup_launch_options');
    return typeof result === 'object'
      && result !== null
      && (result as { safeStart?: unknown }).safeStart === true;
  } catch {
    return false;
  }
}

export async function resetSavedWindowGeometry(): Promise<void> {
  const invoke = tauriInternals()?.invoke;
  if (!invoke) throw new Error('Window-state reset is available only in the desktop app.');
  await invoke('reset_window_state');
}

export async function openApplicationDataDirectory(): Promise<void> {
  const invoke = tauriInternals()?.invoke;
  if (!invoke) throw new Error('The application data directory is available only in the desktop app.');
  await invoke('open_app_data_directory');
}
