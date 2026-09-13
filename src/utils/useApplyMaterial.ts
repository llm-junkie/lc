/**
 * Material runtime gate — replaces the old `useApplySolidTheme`.
 *
 * Resolves the active material for the persisted `materialMode` and the
 * resolved dark/light base (so the native tint follows the theme), then
 * hands the resolution to `applyMaterialDocumentState`, which mirrors it
 * to `data-material-*` attributes and the `.solid` class.
 *
 * Until the first resolution completes, the document keeps its opaque
 * default — a slow or failed activation therefore never leaves an
 * unpainted surface (see `src/platform/material.ts`).
 */

import { useEffect, useState } from 'react';
import { useSettings } from '../store/settings.ts';
import { resolveAndApplyMaterial } from '../platform/material.ts';

function systemThemeBrowser(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useApplyMaterial(): void {
  const materialMode = useSettings((s) => s.materialMode);
  const theme = useSettings((s) => s.theme);
  const activeCustomThemeId = useSettings((s) => s.activeCustomThemeId);
  const customThemes = useSettings((s) => s.customThemes);
  const [system, setSystem] = useState<'light' | 'dark'>(systemThemeBrowser);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    // Match useResolvedTheme: a custom theme uses its base, otherwise
    // the stored mode with system falling through to the OS.
    let base = theme === 'system' ? system : theme;
    if (activeCustomThemeId) {
      const ct = customThemes.find((t) => t.id === activeCustomThemeId);
      if (ct?.source.base) base = ct.source.base;
    }
    resolveAndApplyMaterial(materialMode, base === 'dark').catch(() => {
      // resolveAndApplyMaterial already falls back to matte on any
      // failure; a rejection here can only mean the apply itself threw,
      // which applyMaterialResolution guards against. Nothing to do.
    });
  }, [materialMode, theme, activeCustomThemeId, customThemes, system]);
}
