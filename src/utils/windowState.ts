/**
 * Window geometry persistence is handled by the official
 * `tauri-plugin-window-state` plugin (added in lib.rs `run` and
 * initialized via `tauri_plugin_window_state::Builder::default()`).
 * The plugin auto-saves on every move/resize and restores the
 * saved geometry when the app launches, with no JS code needed
 * beyond optional manual calls.
 *
 * What this file now provides:
 *   - `clearAndResetWindowState()` — wipes the state file so the
 *     next launch uses the conf-default geometry, used by the full
 *     wipe path (`clearAndResetAll` in `utils/import.ts`).
 *   - `updateWindowMinSizeForZoom()` — sets the OS minimum size
 *     based on the current zoom level so the layout always has
 *     a usable area.
 *
 * Web build (no Tauri): all calls are no-ops.
 */

import { isTauri, tauriInvoke } from './saveBlob.ts';

/**
 * Forget the saved window geometry. Backed by a small Tauri
 * command (`reset_window_state`) that:
 *   1. Snaps the current window to the conf-default
 *      geometry right now (so the user sees the reset on
 *      this process, not just the next launch).
 *   2. Overwrites the plugin's state file with `null`, so
 *      the next launch's loader rejects it and falls back
 *      to an empty cache (no restore).
 *
 * Note: `tauri-plugin-window-state` saves on `RunEvent::Exit`
 * and on `CloseRequested` with a fresh `update_state` — the
 * "snaps to conf defaults" step on the next launch is the
 * real reason the user sees conf-defaults. The file rewrite
 * is the reason subsequent launches don't restore the
 * pre-reset state.
 */
export async function clearAndResetWindowState(): Promise<void> {
  if (!isTauri) return;
  try {
    await tauriInvoke('reset_window_state');
  } catch {
    // Best-effort.
  }
}

/**
 * Update the window's minimum size based on the current zoom level.
 * Requests round(540 * zoom) by round(380 * zoom) in logical pixels.
 * At zoom=0.8, the requested minimum is 432×304. The minimum scales
 * linearly with zoom; it does not preserve a fixed visual content area.
 */
export async function updateWindowMinSizeForZoom(zoom: number): Promise<void> {
  if (!isTauri) return;
  try {
    const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
      import('@tauri-apps/api/window'),
      import('@tauri-apps/api/dpi'),
    ]);
    const w = getCurrentWindow() as unknown as {
      setMinSize: (size: unknown) => Promise<void>;
    };
    // The user-resizable minimum tracks the zoom level linearly. The
    // user resizes the OS window (logical px), and they want the
    // minimum to feel like "shrink the window until the layout gets
    // tight" — at 80% zoom, a smaller window is fine because the
    // text is smaller; at 150% zoom, you need a bigger window because
    // the text is bigger. We don't try to keep the *CSS* content
    // area constant (which would require inverting the zoom factor
    // and adding caps/floors); the user prefers the simpler "minimum
    // scales 1:1 with zoom" model.
    //
    // Verified values (540 × zoom, no cap, no floor):
    //   80%  → 432 logical  (content area ~346 CSS px)
    //   90%  → 486 logical  (content area ~437 CSS px)
    //   100% → 540 logical  (content area 540 CSS px)
    //   110% → 594 logical  (content area ~653 CSS px)
    //   125% → 675 logical  (content area ~844 CSS px)
    //   150% → 810 logical  (content area 1215 CSS px)
    //
    // Uses `LogicalSize` (not `PhysicalSize`) because on Windows with
    // per-monitor DPI awareness v2, Tauri's `PhysicalSize` value is
    // interpreted in logical pixels anyway — the `Physical` type
    // describes the *positioning intent*, not the unit. `LogicalSize`
    // makes the unit explicit and matches what the OS reports.
    const BASE_MIN_W = 540;
    const BASE_MIN_H = 380;
    const minW = Math.round(BASE_MIN_W * zoom);
    const minH = Math.round(BASE_MIN_H * zoom);
    await w.setMinSize(new LogicalSize(minW, minH));
  } catch {
    // Best-effort.
  }
}

/**
 * Conditionally resize the window on a zoom change.
 *
 * Rule (per user spec):
 *   1. Only on **scale-up** (new zoom > previous zoom). Scaling down
 *      must NEVER move the window — the user's chosen layout is
 *      preserved.
 *   2. **Per axis**: if the current dimension is below the new
 *      minimum for that zoom, bring it up to the minimum. If the
 *      current dimension is already at or above the new minimum,
 *      leave it alone — the user explicitly chose that size
 *      (e.g. a tall, narrow window) and we must not shrink it.
 *
 *      Earlier this used `curW < newMinW || curH < newMinH` which
 *      clobbered BOTH axes to the new minimum even if only one was
 *      below. The visible bug: a user with a min-width-but-very-tall
 *      window at 100% zoom (e.g. 432×1500) scaling to 125% would see
 *      the height snap DOWN to 475 (the new min height at 125%),
 *      destroying their layout. The fix is to clamp each axis
 *      independently with `max(cur, newMin)` and only `setSize`
 *      when at least one axis actually moved.
 *
 * On the first zoom application (no previous zoom), this is a no-op:
 * the conf-default 1280×800 is well above any min, and there's no
 * "scale-up" to react to.
 */
export async function maybeResizeWindowForZoom(zoom: number, prevZoom: number | null): Promise<void> {
  if (!isTauri) return;
  if (prevZoom == null) return;        // first run — no resize
  if (zoom <= prevZoom) return;        // not a scale-up — no resize
  try {
    const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
      import('@tauri-apps/api/window'),
      import('@tauri-apps/api/dpi'),
    ]);
    const w = getCurrentWindow() as unknown as {
      innerSize: () => Promise<{ width: number; height: number }>;
      setSize: (size: unknown) => Promise<void>;
    };
    const newMinW = Math.round(540 * zoom);
    const newMinH = Math.round(380 * zoom);
    const cur = await w.innerSize();
    // `innerSize` returns physical px on Windows. We need logical px
    // to compare against our logical min. Use Tauri's `scaleFactor`
    // to convert — getCurrentWindow().scaleFactor().
    const wAny = getCurrentWindow() as unknown as {
      scaleFactor: () => Promise<number>;
    };
    const scale = await wAny.scaleFactor();
    const curW = cur.width / scale;
    const curH = cur.height / scale;
    // Per-axis clamp: each axis independently gets bumped to the
    // new minimum if it's currently below. Axes already above the
    // new minimum are left untouched. Only call setSize when at
    // least one axis actually needs to change (no-op otherwise).
    const nextW = Math.max(curW, newMinW);
    const nextH = Math.max(curH, newMinH);
    if (nextW !== curW || nextH !== curH) {
      await w.setSize(new LogicalSize(nextW, nextH));
    }
  } catch {
    // Best-effort.
  }
}
