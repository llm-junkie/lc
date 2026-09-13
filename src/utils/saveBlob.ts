/**
 * Cross-platform file save helper. Tauri opens the native OS save
 * dialog through the dialog plugin, then writes bytes with `write_blob_file`.
 * Plain strings become UTF-8 Blob bytes before this same write path.
 * The web build falls back to an anchor-download.
 *
 * Shared blob plumbing for export and other native file operations.
 */

import { save as tauriSave } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Call a Tauri Rust command via the raw `__TAURI_INTERNALS__` bridge.
 * Returns `undefined` if not running in Tauri or if the invoke
 * function is unavailable — callers can guard with `if (result !== undefined)`.
 */
export async function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown | undefined> {
  if (!isTauri) return undefined;
  const invoke = (window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: unknown) => Promise<unknown> };
  }).__TAURI_INTERNALS__?.invoke;
  if (!invoke) return undefined;
  return invoke(cmd, args ?? {});
}

/** Cached home directory, fetched once via IPC on first use. */
let homeDirCache: string | null = null;
export async function getHomeDir(): Promise<string> {
  if (homeDirCache !== null) return homeDirCache;
  try {
    homeDirCache = (await tauriInvoke('get_home_dir')) as string;
  } catch {
    // Fallback for web builds or if the command is unavailable.
  }
  if (!homeDirCache) homeDirCache = '~';
  return homeDirCache;
}

/**
 * Save data (a Blob or a plain string) to a user-chosen file.  Tauri:
 * opens the native save dialog and writes the bytes via a Rust
 * command.  Web: anchor-download (the browser picks the location
 * based on user settings).
 *
 * Returns `true` if the file was actually saved, `false` if the user
 * cancelled the dialog (Tauri) or the operation was otherwise a
 * no-op.
 */
export async function saveBlobFile(
  defaultName: string,
  data: Blob | string,
  filters: Array<{ name: string; extensions: string[] }>,
): Promise<boolean> {
  const blob = typeof data === 'string'
    ? new Blob([data], { type: 'text/plain;charset=utf-8' })
    : data;

  if (isTauri) {
    const path = await tauriSave({ defaultPath: defaultName, filters });
    if (!path) return false;
    const buf = await blob.arrayBuffer();
    const bytes = Array.from(new Uint8Array(buf));
    await invoke('write_blob_file', { path, bytes });
    return true;
  }
  // Web fallback: anchor download. The URL is revoked synchronously right
  // after click() — the browser snapshots it at click time — rather than
  // on an arbitrary 1 s wall clock; same deterministic pattern as
  // src/themes/io.ts.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}
