import { useEffect, useState } from 'react';
import { useSettings } from '../../store/settings.ts';
import type { ThemeMode } from '../../types';
import { applyCustomTheme, removeCustomTheme } from '../../themes/resolver.ts';
import { isTauri } from '../../utils/saveBlob.ts';
import { useApplyMaterial } from '../../utils/useApplyMaterial.ts';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Returns the user's OS-level dark/light preference via CSS media query.
 *  Fast and synchronous, but unreliable on Linux/webkit2gtk where the
 *  WebView may not pick up the desktop color scheme correctly. */
function systemThemeBrowser(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Detect the system theme using the most reliable method available.
 *  On Tauri, delegates to the Rust `dark-light` crate which checks
 *  platform-specific sources (portal, registry, `AppleInterfaceStyle`).
 *  Falls back to the CSS media query when Tauri is unavailable. */
async function detectSystemTheme(): Promise<'light' | 'dark'> {
  if (isTauri) {
    try {
      const theme = await invoke('detect_system_theme');
      if (theme === 'dark' || theme === 'light') return theme;
    } catch {
      // Best-effort — fall through to CSS detection.
    }
  }
  return systemThemeBrowser();
}

/** Resolve the stored `ThemeMode` to the actual `'light' | 'dark'`
 *  that's currently being rendered. When `mode === 'system'` we
 *  fall through to `prefers-color-scheme`; otherwise the stored
 *  value is authoritative. Used by the sidebar's quick-theme
 *  toggle icon — that icon has to reflect what the user actually
 *  sees, not the raw stored value (otherwise resetting settings
 *  from `theme: 'light'` to `theme: 'system'` on a dark system
 *  leaves the icon pointing at the old state). */
export function useResolvedTheme(): 'light' | 'dark' {
  const theme = useSettings((s) => s.theme);
  const activeCustomThemeId = useSettings((s) => s.activeCustomThemeId);
  const customThemes = useSettings((s) => s.customThemes);

  // Track system changes too — a user with `theme: 'system'`
  // who flips their OS dark-mode at runtime should see the
  // sidebar icon follow along.
  const [system, setSystem] = useState<'light' | 'dark'>(systemThemeBrowser);
  useEffect(() => {
    // On mount, try the more accurate Rust detection (Linux portals
    // etc.) and update if it differs from the browser's guess.
    detectSystemTheme().then((t) => setSystem(t)).catch(() => {});
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // When a custom theme is active, use its base.
  if (activeCustomThemeId) {
    const ct = customThemes.find((t) => t.id === activeCustomThemeId);
    if (ct) return ct.source.base ?? 'dark';
  }

  return theme === 'system' ? system : theme;
}

/** Sync the Tauri window chrome (title bar) to the active theme. */
async function syncWindowChrome(base: 'light' | 'dark') {
  if (!isTauri) return;
  try {
    await getCurrentWindow().setTheme(base);
  } catch {
    // Best-effort — older Tauri or unsupported platforms.
  }
}

async function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  const actual = mode === 'system' ? await detectSystemTheme() : mode;
  root.dataset.theme = actual;
  // `data-base` is the resolved light/dark base, which for a built-in theme
  // is the same value. It exists so CSS can ask "is this a light base?"
  // without asking "is data-theme exactly 'light'?" — the latter is false for
  // a light-base CUSTOM theme. Every path that
  // writes `data-theme` must also write this one. See the `[data-base]` note
  // in `src/index.css`.
  root.dataset.base = actual;
  // Tauri window chrome follows the resolved base.
  void syncWindowChrome(actual);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSettings((s) => s.theme);
  const activeCustomThemeId = useSettings((s) => s.activeCustomThemeId);
  const customThemes = useSettings((s) => s.customThemes);

  // Material runtime gate — resolves the active material (native
  // Mica/Acrylic/vibrancy, CSS glass, or matte) and mirrors it to
  // `data-material-*` attributes plus the `.solid` class.
  useApplyMaterial();

  // Enable theme transitions after the initial paint, so the app
  // doesn't fade in slowly on startup.
  useEffect(() => {
    const root = document.documentElement;
    // Double rAF: first queues before the next paint, second fires
    // after that paint has flushed — transitions are harmless by then.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        root.classList.add('theme-ready');
      });
    });
  }, []);

  useEffect(() => {
    // Custom theme takes priority.
    if (activeCustomThemeId) {
      const ct = customThemes.find((t) => t.id === activeCustomThemeId);
      if (ct) {
        applyCustomTheme(ct);
        void syncWindowChrome(ct.source.base ?? 'dark');
        return;
      }
    }

    // Built-in theme.
    removeCustomTheme();
    applyTheme(theme);

    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { applyTheme('system'); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme, activeCustomThemeId, customThemes]);

  return <>{children}</>;
}
