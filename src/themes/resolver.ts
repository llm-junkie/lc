/**
 * Theme resolver: spine→full computation, CSS generation, injection.
 */

import type { ThemeFile, ThemeTokens, CustomTheme } from './types';
import { BUILTIN_THEMES } from './builtin.ts';
import { useSettings } from '../store/settings.ts';
import type { CodeTheme } from '../store/settings';

/* ------------------------------------------------------------------ */
/*  Spine → full token computation                                    */
/* ------------------------------------------------------------------ */

/**
 * Convert a hex color to its r, g, b components (0-255).
 */
function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) return null;
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

/**
 * Lighten or darken a hex color by a signed offset per channel.
 * Positive offset = lighter, negative = darker. Clamped to 0-255.
 */
function shiftHex(hex: string, offset: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  const clamp = (v: number) => Math.max(0, Math.min(255, v + offset));
  return `#${clamp(c.r).toString(16).padStart(2, '0')}${clamp(c.g).toString(16).padStart(2, '0')}${clamp(c.b).toString(16).padStart(2, '0')}`;
}

/**
 * Blend a color toward a target by a given ratio.
 * ratio 0 = original, ratio 1 = target.
 */
function blendToward(hex: string, targetHex: string, ratio: number): string {
  const c = parseHex(hex);
  const t = parseHex(targetHex);
  if (!c || !t) return hex;
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * ratio);
  return `#${lerp(c.r, t.r).toString(16).padStart(2, '0')}${lerp(c.g, t.g).toString(16).padStart(2, '0')}${lerp(c.b, t.b).toString(16).padStart(2, '0')}`;
}
function towardWhite(hex: string, ratio: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * ratio);
  return `#${lerp(c.r, 255).toString(16).padStart(2, '0')}${lerp(c.g, 255).toString(16).padStart(2, '0')}${lerp(c.b, 255).toString(16).padStart(2, '0')}`;
}

/**
 * Given a spine (8-10 key tokens) and a built-in base, produce a full
 * glass + solid token pair.
 */
function resolveSpine(spine: NonNullable<ThemeFile['spine']>, base: 'light' | 'dark'): { glass: ThemeTokens; solid: ThemeTokens } {
  const basePair = BUILTIN_THEMES[base];
  const isDark = base === 'dark';

  // Start with the full base glass map.
  const glass = { ...basePair.glass };

  // Override explicit spine values.
  for (const [k, v] of Object.entries(spine)) {
    if (v !== undefined) glass[k] = v;
  }

  // Auto-compute text-muted if not provided: darker on dark, lighter on light.
  if (!spine['--text-muted']) {
    const text = glass['--text'];
    glass['--text-muted'] = isDark ? shiftHex(text, -60) : shiftHex(text, +60);
  }

  // Auto-compute text-faint: one more step in the same direction.
  if (!spine['--text-faint']) {
    const muted = glass['--text-muted']!;
    glass['--text-faint'] = isDark ? shiftHex(muted, -40) : shiftHex(muted, +40);
  }

  // Auto-compute border from elev-1 (slightly lighter than elev-1 on dark,
  // slightly darker on light — enough to be clearly visible).
  if (!spine['--border']) {
    glass['--border'] = isDark
      ? shiftHex(glass['--bg-elev-1'], +20)
      : shiftHex(glass['--bg-elev-1'], -16);
  }

  // Auto-compute border-strong from border.
  if (!spine['--border-strong']) {
    glass['--border-strong'] = isDark
      ? shiftHex(glass['--border'], +12)
      : shiftHex(glass['--border'], -8);
  }

  // --- Derived glass tokens ---
  const e1 = glass['--bg-elev-1']!;
  const e2 = glass['--bg-elev-2']!;
  const e3 = glass['--bg-elev-3']!;
  const accent = glass['--accent']!;

  // bg-elev-4: translucent version of e1 (last elevation before white).
  glass['--bg-elev-4'] = isDark ? `${e1}d7` : `rgba(255, 255, 255, 0.76)`;

  // Code block bg = github-dark (independent of theme).
  // code-bg: for inline code, use elev-2.
  glass['--code-bg'] = e2;

  // Scrollbar: subtle contrast against bg.
  glass['--scrollbar-thumb'] = isDark
    ? 'rgba(255, 255, 255, 0.12)'
    : 'rgba(0, 0, 0, 0.15)';

  // Glass overlays: auto-computed.
  glass['--glass-bg'] = 'transparent';
  glass['--glass-bg-focus'] = 'var(--bg-elev-4)';
  if (isDark) {
    glass['--glass-bg-hover'] = `rgba(70, 70, 101, 0.181)`;
    glass['--glass-bg-strong'] = `rgba(70, 70, 101, 0.312)`;
    glass['--glass-border'] = 'var(--border)';
    glass['--overlay-bg'] = 'rgba(0, 0, 0, 0.55)';
    glass['--modal-shadow'] = '0 20px 60px rgba(0, 0, 0, 0.45)';
    glass['--card-shadow'] = '0 2px 12px rgba(0, 0, 0, 0.15)';
    glass['--bubble-file-bg'] = 'rgba(255, 255, 255, 0.04)';
    glass['--bubble-file-hover-bg'] = 'rgba(255, 255, 255, 0.08)';
    glass['--sidebar-footer-border'] = 'rgba(255, 255, 255, 0.06)';
    glass['--sidebar-footer-bg'] =
      'linear-gradient(to bottom, rgba(255, 255, 255, 0.02) 0%, rgba(255, 255, 255, 0.08) 100%)';
  } else {
    glass['--glass-bg-hover'] = 'rgba(255, 255, 255, 0.45)';
    glass['--glass-bg-strong'] = 'rgba(255, 255, 255, 0.52)';
    glass['--glass-border'] = 'rgba(0, 0, 0, 0.08)';
    glass['--overlay-bg'] = 'rgba(0, 0, 0, 0.55)';
    glass['--modal-shadow'] = '0 20px 60px rgba(0, 0, 0, 0.35)';
    glass['--card-shadow'] = '0 2px 12px rgba(0, 0, 0, 0.08)';
    glass['--bubble-file-bg'] = 'transparent';
    glass['--bubble-file-hover-bg'] = 'rgba(0, 0, 0, 0.04)';
    glass['--sidebar-footer-border'] = 'rgba(0, 0, 0, 0.08)';
    glass['--sidebar-footer-bg'] =
      'linear-gradient(to bottom, rgba(0, 0, 0, 0.06) 0%, rgba(0, 0, 0, 0.01) 100%)';
  }

  // Skill tags — tinted versions of the accent.
  if (isDark) {
    glass['--tag-reasoning-bg'] = 'rgba(139, 92, 246, 0.15)';
    glass['--tag-reasoning-fg'] = '#a78bfa';
    glass['--tag-vision-bg'] = 'rgba(34, 197, 94, 0.15)';
    glass['--tag-vision-fg'] = 'var(--success)';
    glass['--tag-tools-bg'] = 'rgba(59, 130, 246, 0.15)';
    glass['--tag-tools-fg'] = '#60a5fa';
    glass['--variant-lmstudio-bg'] = 'rgba(167, 139, 250, 0.08)';
    glass['--variant-lmstudio-fg'] = '#a78bfa';
    glass['--variant-gemini-bg'] = 'rgba(34, 197, 94, 0.08)';
    glass['--variant-gemini-fg'] = '#4ade80';
    glass['--variant-openai-bg'] = 'rgba(96, 165, 250, 0.08)';
    glass['--variant-openai-fg'] = '#60a5fa';
  } else {
    glass['--tag-reasoning-bg'] = 'rgba(139, 92, 246, 0.12)';
    glass['--tag-reasoning-fg'] = '#7c3aed';
    glass['--tag-vision-bg'] = 'rgba(34, 197, 94, 0.12)';
    glass['--tag-vision-fg'] = 'var(--success)';
    glass['--tag-tools-bg'] = 'rgba(59, 130, 246, 0.12)';
    glass['--tag-tools-fg'] = '#2563eb';
    glass['--variant-lmstudio-bg'] = 'rgba(167, 139, 250, 0.08)';
    glass['--variant-lmstudio-fg'] = '#7c3aed';
    glass['--variant-gemini-bg'] = 'rgba(34, 197, 94, 0.08)';
    glass['--variant-gemini-fg'] = '#15803d';
    glass['--variant-openai-bg'] = 'rgba(96, 165, 250, 0.08)';
    glass['--variant-openai-fg'] = '#2563eb';
  }

  // Accent-derived tokens (only if spine didn't provide them).
  if (!spine['--accent-soft']) {
    glass['--accent-soft'] = isDark
      ? `rgba(129, 140, 248, 0.16)`
      : `rgba(79, 70, 229, 0.12)`;
  }
  if (!spine['--accent-hover']) {
    glass['--accent-hover'] = isDark ? towardWhite(accent, 0.15) : shiftHex(accent, -8);
  }

  // Tool status indicators.
  glass['--tool-status-ok-bg'] = isDark
    ? 'rgba(34, 197, 94, 0.15)'
    : 'rgba(22, 163, 74, 0.12)';
  glass['--tool-status-error-bg'] = isDark
    ? 'rgba(220, 38, 38, 0.15)'
    : 'rgba(220, 38, 38, 0.1)';
  glass['--tool-status-running-bg'] = isDark
    ? 'rgba(129, 140, 248, 0.18)'
    : 'rgba(79, 70, 229, 0.12)';

  // User bubble: accent-tinted surface (only if spine didn't provide them).
  if (!('--user-bubble' in spine)) {
    glass['--user-bubble'] = isDark
      ? `rgba(99, 102, 241, 0.12)`
      : towardWhite(accent, 0.92);
  }
  if (!('--user-bubble-gradient' in spine)) {
    glass['--user-bubble-gradient'] = isDark
      ? `linear-gradient(135deg, rgba(99, 102, 241, 0.18) 0%, rgba(139, 92, 246, 0.12) 100%)`
      : `linear-gradient(135deg, rgba(99, 102, 241, 0.10) 0%, rgba(139, 92, 246, 0.08) 100%)`;
  }
  if (!('--user-bubble-border' in spine)) {
    glass['--user-bubble-border'] = isDark
      ? `rgba(139, 92, 246, 0.15)`
      : `rgba(139, 92, 246, 0.2)`;
  }

  // Danger/success soft: keep them independent of spine accent.
  glass['--danger-soft'] = isDark
    ? 'rgba(248, 113, 113, 0.12)'
    : 'rgba(220, 38, 38, 0.1)';
  glass['--success-soft'] = isDark
    ? 'rgba(74, 222, 128, 0.14)'
    : 'rgba(22, 163, 74, 0.12)';

  // Code blocks — keep base theme defaults unless spine explicitly overrides.
  // (base glass already has correct --code-block-bg / --code-block-fg from spread)

  // Theme-independent.
  glass['--accent-fg'] = '#ffffff';
  glass['--toggle-thumb'] = '#ffffff';
  glass['--checkbox-check'] = '#ffffff';
  glass['--empty-state-gradient-end'] = '#ec4899';

  // Assistant bubble is transparent (inherits elev-2 via .bubble-assistant rule).
  glass['--assistant-bubble'] = 'transparent';

  // --- Solid tokens ---
  const solid = { ...basePair.solid };

  // sb3 = elev-2, sb2 = elev-3, sb1 = above elev-3.
  solid['--solid-bg-3'] = e2;
  solid['--solid-bg-2'] = e3;
  solid['--solid-bg-1'] = isDark ? shiftHex(e3, +6) : '#ffffff';
  solid['--solid-bg-bubble-file'] = e2;

  // Solid accent — derive from glass accent, compute hover opaquely.
  solid['--solid-accent'] = accent;
  solid['--solid-accent-hover'] = isDark ? towardWhite(accent, 0.15) : shiftHex(accent, -8);

  // Solid borders — derive from glass borders.
  solid['--solid-border-1'] = glass['--border'];
  solid['--solid-border-2'] = glass['--border-strong'];

  // Solid user bubble — blend toward background for dark (darker + muted).
  solid['--solid-user-bubble'] = isDark
    ? blendToward(accent, e2, 0.78)
    : towardWhite(accent, 0.92);
  solid['--solid-user-bubble-border'] = isDark
    ? blendToward(accent, e2, 0.38)
    : towardWhite(accent, 0.78);

  return { glass, solid };
}

/* ------------------------------------------------------------------ */
/*  Full theme resolution (spine or full)                             */
/* ------------------------------------------------------------------ */

/**
 * Given a ThemeFile, produce the glass + solid token maps.
 * For spine mode, auto-computes from the base.
 * For full mode, validates and merges with base as fallback.
 */
export function resolveThemeTokens(source: ThemeFile): { glass: ThemeTokens; solid: ThemeTokens } | null {
  let resolved: { glass: ThemeTokens; solid: ThemeTokens } | null = null;

  if (source.mode === 'spine' && source.spine && source.base) {
    resolved = resolveSpine(source.spine, source.base);
  } else if (source.mode === 'full' && source.glass && source.solid) {
    // Full mode: use provided maps directly. Merge with base for any missing keys.
    const baseGlass = source.base ? BUILTIN_THEMES[source.base].glass : BUILTIN_THEMES.dark.glass;
    const baseSolid = source.base ? BUILTIN_THEMES[source.base].solid : BUILTIN_THEMES.dark.solid;
    resolved = {
      glass: { ...baseGlass, ...source.glass },
      solid: { ...baseSolid, ...source.solid },
    };
  }

  // Native-material floor: the theme's own `--bg` at the same 90%
  // alpha the built-in constants in index.css use, so under
  // Mica/Acrylic/vibrancy the tint follows this theme's palette
  // instead of the neutral built-in floor. Only derivable for a hex
  // `--bg`; anything else (rgb()/var()/named) leaves the
  // `[data-base]`-gated built-in constant in force.
  if (resolved) {
    const bg = parseHex(resolved.glass['--bg'] ?? '');
    if (bg) resolved.glass['--native-floor'] = `rgba(${bg.r}, ${bg.g}, ${bg.b}, 0.9)`;
  }

  return resolved;
}

/* ------------------------------------------------------------------ */
/*  CSS generation & injection                                        */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'custom-theme-css';

/**
 * Build a CSS string that sets all custom properties on a given scope selector.
 */
function tokensToCSS(scope: string, tokens: ThemeTokens): string {
  const lines = Object.entries(tokens).map(([k, v]) => `    ${k}: ${v};`);
  return `${scope} {\n${lines.join('\n')}\n  }`;
}

/**
 * Inject (or update) the custom theme <style> tag.
 *
 * Writes two blocks:
 *   1. :root[data-theme="custom"]     — glass tokens
 *   2. :root.solid[data-theme="custom"] — solid tokens
 *
 * The solid block inherits all glass tokens (the CSS cascade handles that;
 * solid.css already gates on `:root.solid`), so we only override the
 * `--solid-*` tokens in the solid block.
 */
export function injectCustomThemeCSS(glass: ThemeTokens, solid: ThemeTokens, name: string): void {
  const css =
    `/* Custom theme: ${name} */\n` +
    tokensToCSS(':root[data-theme="custom"]', glass) +
    '\n' +
    tokensToCSS(':root.solid[data-theme="custom"]', solid);

  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

/**
 * Set `data-theme="custom"` on the root, inject the theme CSS,
 * and set color-scheme to match the base (dark vs light).
 */
export function applyCustomTheme(theme: CustomTheme): boolean {
  const resolved = resolveThemeTokens(theme.source);
  if (!resolved) return false;
  injectCustomThemeCSS(resolved.glass, resolved.solid, theme.name);
  document.documentElement.dataset.theme = 'custom';
  // Drive native form controls to match the base palette.
  const isDark = theme.source.base === 'dark';
  // The base marker CSS gates light-only rules on. Without it a light-base
  // custom theme renders the light palette with the dark theme's harder edge
  // treatment, because `[data-theme='light']` cannot match `custom`. See the
  // `[data-base]` note in `src/index.css`.
  document.documentElement.dataset.base = isDark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';

  // Apply the suggested code theme.
  const suggestedCodeTheme: CodeTheme =
    theme.source.codeTheme as CodeTheme | undefined
    ?? (theme.source.base === 'light' ? 'one-light' : 'one-dark');
  // console.log('[applyCustomTheme] setting codeTheme:', suggestedCodeTheme, 'source:', theme.source.codeTheme);
  useSettings.getState().setCodeTheme(suggestedCodeTheme);

  return true;
}

/**
 * Remove the custom theme <style> tag and revert to a built-in theme.
 */
export function removeCustomTheme(): void {
  const el = document.getElementById(STYLE_ID);
  if (el) el.remove();
  document.documentElement.style.colorScheme = '';
}

/**
 * Apply a built-in theme by setting data-theme (and the matching data-base).
 */
export function applyBuiltinTheme(mode: 'light' | 'dark'): void {
  removeCustomTheme();
  document.documentElement.dataset.theme = mode;
  // For a built-in theme the base is the theme. Kept in lockstep with
  // `data-theme` at every write site — see the `[data-base]` note in
  // `src/index.css`.
  document.documentElement.dataset.base = mode;
  document.documentElement.style.colorScheme = '';
}
