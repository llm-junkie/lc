/**
 * Pure material resolver.
 *
 * Maps (platform, requested material mode, native activation result) to
 * the single active material the whole UI renders under. No DOM, no
 * Tauri imports — everything here is unit-testable in isolation and is
 * the ONLY place appearance mode logic is decided. CSS and React
 * components consume the resolution; they never infer it themselves.
 *
 * Terminology (kept distinct on purpose):
 *   - "native material"  — behind-window system material (Mica /
 *     Acrylic / AppKit vibrancy) applied by the Rust side to the
 *     actual window. Only when this is CONFIRMED active may the root
 *     surfaces go transparent.
 *   - "css-glass"        — internal WebView translucency
 *     (`backdrop-filter` + low-alpha fills). Independent of the native
 *     material; the window itself stays opaque underneath.
 *   - "matte"           — deliberately opaque flat surfaces (the
 *     `:root.solid` override CSS).
 */

/** Desktop platform compiled into the Tauri binary, or `web`. */
export type AppPlatform = 'windows' | 'macos' | 'linux' | 'web';

/** Persisted user preference (migrated from the old `solidTheme`). */
export type MaterialMode = 'auto' | 'glass' | 'solid';

/** Backends the Rust side can report as confirmed-active. */
export type NativeBackend = 'mica' | 'acrylic' | 'vibrancy';

/** The single resolved material the UI renders under. */
export type ActiveMaterial = NativeBackend | 'css-glass' | 'matte';

/** Result of the Rust `activate_window_material` command. */
export interface NativeActivation {
  backend: string;
  active: boolean;
  reason?: string | null;
}

export interface MaterialResolution {
  platform: AppPlatform;
  request: MaterialMode;
  active: ActiveMaterial;
  /** True only when a behind-window native material is confirmed. */
  nativeActive: boolean;
  /** True when the `:root.solid` flat-surface overrides must apply. */
  solidSurfaces: boolean;
  /** Bounded machine-readable explanation when `active` is matte. */
  fallbackReason: string | null;
}

function isNativeBackend(backend: string): backend is NativeBackend {
  return backend === 'mica' || backend === 'acrylic' || backend === 'vibrancy';
}

/**
 * Resolve the active material. Rules, in priority order:
 *
 *  1. `solid` is honored on every platform: opaque matte surfaces, no
 *     native material consulted.
 *  2. The web build keeps its existing CSS-glass behavior — no Tauri
 *     APIs are touched.
 *  3. A confirmed native activation wins on Windows/macOS.
 *  4. Linux resolves `auto` to matte (no compositor blur is relied
 *     upon) but `glass` to CSS-glass — the opaque native window keeps
 *     even unblurred translucency readable.
 *  5. Any failure or rejection resolves to matte, never to raw
 *     transparency.
 */
export function resolveMaterial(input: {
  platform: AppPlatform;
  request: MaterialMode;
  native?: NativeActivation | null;
}): MaterialResolution {
  const { platform, request, native } = input;

  if (request === 'solid') {
    return {
      platform,
      request,
      active: 'matte',
      nativeActive: false,
      solidSurfaces: true,
      fallbackReason: 'user-solid',
    };
  }

  if (platform === 'web') {
    return {
      platform,
      request,
      active: 'css-glass',
      nativeActive: false,
      solidSurfaces: false,
      fallbackReason: null,
    };
  }

  if (native?.active === true && isNativeBackend(native.backend)) {
    return {
      platform,
      request,
      active: native.backend,
      nativeActive: true,
      solidSurfaces: false,
      fallbackReason: null,
    };
  }

  if (platform === 'linux' && request === 'glass') {
    return {
      platform,
      request,
      active: 'css-glass',
      nativeActive: false,
      solidSurfaces: false,
      fallbackReason: null,
    };
  }

  return {
    platform,
    request,
    active: 'matte',
    nativeActive: false,
    solidSurfaces: true,
    fallbackReason: native?.reason ?? (platform === 'linux' ? 'linux-auto-matte' : 'native-unavailable'),
  };
}

/** Legacy `solidTheme` → `materialMode` mapping used by the settings
 *  migration and the portable-settings import. `null` for values that
 *  were never valid. */
export function migrateSolidTheme(solidTheme: unknown): MaterialMode | null {
  if (solidTheme === 'auto') return 'auto';
  if (solidTheme === 'off') return 'glass';
  if (solidTheme === 'on') return 'solid';
  return null;
}
