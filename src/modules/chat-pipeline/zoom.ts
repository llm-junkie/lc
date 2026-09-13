/**
 * Zoom lifecycle hook — syncs CSS zoom scale to the Tauri webview.
 *
 * Extracted from App.tsx per Phase 6.
 */
import { useEffect, useRef } from 'react';
import { useSettings } from '../../store/settings.ts';
import { updateWindowMinSizeForZoom, maybeResizeWindowForZoom } from '../../utils/windowState.ts';
import { isTauri } from '../../utils/saveBlob.ts';

/**
 * Last zoom value forwarded to `set_webview_zoom`. Module-scoped
 * micro-cache — redundant zoom-change events (the useEffect on
 * `[zoom]` re-fires for unrelated reasons, e.g. when the persisted
 * settings store rehydrates on mount with the same zoom as before)
 * used to round-trip through the Tauri IPC bridge for nothing.
 * Skip the IPC when the requested zoom matches the last value.
 */
let lastAppliedZoom: number | null = null;

async function updateWebviewZoom(zoom: number) {
  if (!isTauri) return;
  if (lastAppliedZoom === zoom) return;
  lastAppliedZoom = zoom;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_webview_zoom', { zoom });
  } catch {
    // Best-effort — ignore out-of-range or missing permission.
  }
}

export function useZoomLifecycle() {
  const zoom = useSettings((s) => s.zoom);
  const prevZoomRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    void updateWebviewZoom(zoom);
    void updateWindowMinSizeForZoom(zoom);
    void maybeResizeWindowForZoom(zoom, prevZoomRef.current);
    prevZoomRef.current = zoom;
  }, [zoom]);
}
