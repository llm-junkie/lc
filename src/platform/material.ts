/**
 * Material runtime: bridges the pure resolver to the real environment.
 *
 * Responsibilities:
 *   - Discover the compiled desktop platform via the Rust
 *     `desktop_platform` command (never `navigator.platform`).
 *   - Ask Rust to activate the native material when the request and
 *     platform call for one, receiving a confirmed success/failure.
 *   - Apply the resolved state to the document root as data attributes
 *     (`data-platform`, `data-material-request`, `data-material-active`)
 *     plus the legacy `.solid` class for the flat-surface override CSS.
 *
 * Safety: until `applyMaterialResolution` runs, the document has no
 * `data-material-active` attribute and `src/index.css` keeps
 * `html`/`body`/`#root`/`.app` opaque. An activation that never
 * completes therefore leaves a fully painted, readable app.
 */

import {
  resolveMaterial,
  type ActiveMaterial,
  type AppPlatform,
  type MaterialMode,
  type MaterialResolution,
  type NativeActivation,
} from './material-resolver.ts';

interface TauriInternals {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function tauriInvoke(): TauriInternals['invoke'] | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
    ?.invoke;
}

/** Latest resolution, for support diagnostics. Null before the first
 *  successful `resolveAndApplyMaterial`. */
let currentResolution: MaterialResolution | null = null;

export function getCurrentMaterial(): MaterialResolution | null {
  return currentResolution;
}

/** Apply a resolution to the document root. Split out of the async
 *  path so tests (and the fallback below) can drive it directly. */
export function applyMaterialResolution(resolution: MaterialResolution): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.platform = resolution.platform;
  root.dataset.materialRequest = resolution.request;
  root.dataset.materialActive = resolution.active;
  root.classList.toggle('solid', resolution.solidSurfaces);
  currentResolution = resolution;
}

/** Map the raw activation payload from Rust to the typed shape;
 *  anything malformed counts as "not active" so CSS stays matte. */
function normalizeActivation(raw: unknown): NativeActivation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { backend, active, reason } = raw as Record<string, unknown>;
  return {
    backend: typeof backend === 'string' ? backend : 'matte',
    active: active === true,
    reason: typeof reason === 'string' ? reason : null,
  };
}

/**
 * Resolve and apply the material state for the current environment.
 *
 * The web build and Linux never invoke the native-activation command
 * (Linux keeps its opaque window by design), so those paths work with
 * zero Tauri round-trips and cannot fail into transparency.
 */
export async function resolveAndApplyMaterial(
  request: MaterialMode,
  dark: boolean,
): Promise<MaterialResolution> {
  const invoke = tauriInvoke();
  let platform: AppPlatform = 'web';
  let native: NativeActivation | null = null;

  if (invoke) {
    try {
      const raw = await invoke('desktop_platform');
      if (raw === 'windows' || raw === 'macos' || raw === 'linux') {
        platform = raw;
      }
    } catch {
      // Platform probe failed — stay matte rather than guess.
      const fallback: MaterialResolution = {
        platform: 'web',
        request,
        active: 'matte',
        nativeActive: false,
        solidSurfaces: true,
        fallbackReason: 'platform-probe-failed',
      };
      applyMaterialResolution(fallback);
      return fallback;
    }

    if (platform !== 'linux' && request !== 'solid') {
      try {
        native = normalizeActivation(
          await invoke('activate_window_material', { requested: request, dark }),
        );
      } catch {
        native = { backend: 'matte', active: false, reason: 'activation-command-failed' };
      }
    }
  }

  const resolution = resolveMaterial({ platform, request, native });
  applyMaterialResolution(resolution);
  return resolution;
}

/** Re-exported for consumers that only need the types. */
export type { ActiveMaterial, AppPlatform, MaterialMode, MaterialResolution };
