/**
 * Fallback token maps for custom themes with a dark or light base.
 * The built-in runtime palettes live in index.css and solid.css. These
 * maps are derived from those palettes but are not exact mirrors.
 *
 * In particular, LIGHT_GLASS retains the dark code-block background and
 * foreground. The built-in light CSS uses a light pair. See
 * theme/theme-system.md before changing either default.
 *
 * Solid tokens are from :root.solid[data-theme='dark'] and
 *   :root.solid[data-theme='light'] in src/themes/solid.css.
 */

import type { BuiltinThemes, ThemeTokens } from './types';

/* ------------------------------------------------------------------ */
/*  Dark theme — glass                                                 */
/* ------------------------------------------------------------------ */

const DARK_GLASS: ThemeTokens = {
  '--bg': '#0d0d10',
  '--bg-elev-1': '#18181b',
  '--bg-elev-2': '#1f1f23',
  '--bg-elev-3': '#27272a',
  '--bg-elev-4': '#2d2d3ad7',
  '--border': '#33333a',
  '--border-strong': '#37373f',
  '--text': '#fafafa',
  '--text-muted': '#a1a1aa',
  '--text-faint': '#71717a',
  '--accent': '#818cf8',
  '--accent-hover': '#a5b4fc',
  '--accent-soft': 'rgba(129, 140, 248, 0.16)',
  '--danger': '#f87171',
  '--danger-soft': 'rgba(248, 113, 113, 0.12)',
  '--success': '#4ade80',
  '--success-soft': 'rgba(74, 222, 128, 0.14)',
  '--warning': '#fbbf24',
  '--user-bubble': 'rgba(99, 102, 241, 0.12)',
  '--assistant-bubble': 'transparent',
  '--code-bg': '#18181b',
  '--scrollbar-thumb': 'rgba(255, 255, 255, 0.12)',
  '--user-bubble-gradient':
    'linear-gradient(135deg, rgba(99, 102, 241, 0.18) 0%, rgba(139, 92, 246, 0.12) 100%)',
  '--user-bubble-border': 'rgba(139, 92, 246, 0.15)',
  '--code-block-bg': '#0d1117',
  '--code-block-fg': '#c9d1d9',
  '--accent-fg': '#ffffff',
  '--toggle-thumb': '#ffffff',
  '--checkbox-check': '#ffffff',
  '--empty-state-gradient-end': '#ec4899',
  '--glass-bg': 'transparent',
  '--glass-bg-hover': 'rgba(70, 70, 101, 0.181)',
  '--glass-bg-focus': 'var(--bg-elev-4)',
  '--glass-bg-strong': 'rgba(70, 70, 101, 0.312)',
  '--glass-border': 'var(--border)',
  '--overlay-bg': 'rgba(0, 0, 0, 0.55)',
  '--modal-shadow': '0 20px 60px rgba(0, 0, 0, 0.45)',
  '--card-shadow': '0 2px 12px rgba(0, 0, 0, 0.15)',
  '--bubble-file-bg': 'rgba(255, 255, 255, 0.04)',
  '--bubble-file-hover-bg': 'rgba(255, 255, 255, 0.08)',
  '--sidebar-footer-border': 'rgba(255, 255, 255, 0.06)',
  '--sidebar-footer-bg':
    'linear-gradient(to bottom, rgba(255, 255, 255, 0.02) 0%, rgba(255, 255, 255, 0.08) 100%)',
  '--tag-reasoning-bg': 'rgba(139, 92, 246, 0.15)',
  '--tag-reasoning-fg': '#a78bfa',
  '--tag-vision-bg': 'rgba(34, 197, 94, 0.15)',
  '--tag-vision-fg': 'var(--success)',
  '--tag-tools-bg': 'rgba(59, 130, 246, 0.15)',
  '--tag-tools-fg': '#60a5fa',
  '--variant-lmstudio-bg': 'rgba(167, 139, 250, 0.08)',
  '--variant-lmstudio-fg': '#a78bfa',
  '--variant-openai-bg': 'rgba(96, 165, 250, 0.08)',
  '--variant-openai-fg': '#60a5fa',
  '--variant-anthropic-bg': 'rgba(251, 191, 36, 0.08)',
  '--variant-anthropic-fg': '#fbbf24',
  '--tool-status-ok-bg': 'rgba(34, 197, 94, 0.15)',
  '--tool-status-ok-fg': 'var(--success)',
  '--tool-status-error-bg': 'rgba(220, 38, 38, 0.15)',
  '--tool-status-error-fg': 'var(--danger)',
  '--tool-status-running-bg': 'rgba(129, 140, 248, 0.18)',
};

/* ------------------------------------------------------------------ */
/*  Light theme — glass                                                */
/* ------------------------------------------------------------------ */

const LIGHT_GLASS: ThemeTokens = {
  '--bg': '#e4e4e8',
  '--bg-elev-1': '#ededf2',
  '--bg-elev-2': '#f5f5f9',
  '--bg-elev-3': '#fbfbff',
  '--bg-elev-4': 'rgba(255, 255, 255, 0.76)',
  '--border': '#d6d6d6',
  '--border-strong': '#c3c3c3',
  '--text': '#18181b',
  '--text-muted': '#5e5e67',
  '--text-faint': '#8a8a93',
  '--accent': '#4f46e5',
  '--accent-hover': '#4338ca',
  '--accent-soft': 'rgba(79, 70, 229, 0.12)',
  '--danger': '#dc2626',
  '--danger-soft': 'rgba(220, 38, 38, 0.1)',
  '--success': '#16a34a',
  '--success-soft': 'rgba(22, 163, 74, 0.12)',
  '--warning': '#d97706',
  '--user-bubble': '#eef2ff',
  '--assistant-bubble': 'transparent',
  '--code-bg': '#f4f4f5',
  '--scrollbar-thumb': 'rgba(0, 0, 0, 0.15)',
  '--user-bubble-gradient':
    'linear-gradient(135deg, rgba(99, 102, 241, 0.10) 0%, rgba(139, 92, 246, 0.08) 100%)',
  '--user-bubble-border': 'rgba(139, 92, 246, 0.2)',
  '--code-block-bg': '#0d1117',
  '--code-block-fg': '#c9d1d9',
  '--accent-fg': '#ffffff',
  '--toggle-thumb': '#ffffff',
  '--checkbox-check': '#ffffff',
  '--empty-state-gradient-end': '#ec4899',
  '--glass-bg': 'transparent',
  '--glass-bg-hover': 'rgba(255, 255, 255, 0.45)',
  '--glass-bg-focus': 'var(--bg-elev-4)',
  '--glass-bg-strong': 'rgba(255, 255, 255, 0.52)',
  '--glass-border': 'rgba(0, 0, 0, 0.08)',
  '--overlay-bg': 'rgba(0, 0, 0, 0.55)',
  '--modal-shadow': '0 20px 60px rgba(0, 0, 0, 0.35)',
  '--card-shadow': '0 2px 12px rgba(0, 0, 0, 0.08)',
  '--bubble-file-bg': 'rgba(255, 255, 255, 0.255)',
  '--bubble-file-hover-bg': 'rgba(255, 255, 255, 0.555)',
  '--sidebar-footer-border': 'rgba(0, 0, 0, 0.08)',
  '--sidebar-footer-bg':
    'linear-gradient(to bottom, rgba(0, 0, 0, 0.06) 0%, rgba(0, 0, 0, 0.01) 100%)',
  '--tag-reasoning-bg': 'rgba(139, 92, 246, 0.12)',
  '--tag-reasoning-fg': '#7c3aed',
  '--tag-vision-bg': 'rgba(34, 197, 94, 0.12)',
  '--tag-vision-fg': 'var(--success)',
  '--tag-tools-bg': 'rgba(59, 130, 246, 0.12)',
  '--tag-tools-fg': '#2563eb',
  '--variant-lmstudio-bg': 'rgba(167, 139, 250, 0.08)',
  '--variant-lmstudio-fg': '#7c3aed',
  '--variant-openai-bg': 'rgba(96, 165, 250, 0.08)',
  '--variant-openai-fg': '#2563eb',
  '--variant-anthropic-bg': 'rgba(245, 158, 11, 0.08)',
  '--variant-anthropic-fg': '#d97706',
  '--tool-status-ok-bg': 'rgba(22, 163, 74, 0.12)',
  '--tool-status-ok-fg': 'var(--success)',
  '--tool-status-error-bg': 'rgba(220, 38, 38, 0.1)',
  '--tool-status-error-fg': 'var(--danger)',
  '--tool-status-running-bg': 'rgba(79, 70, 229, 0.12)',
};

/* ------------------------------------------------------------------ */
/*  Dark theme — solid                                                 */
/* ------------------------------------------------------------------ */

const DARK_SOLID: ThemeTokens = {
  '--solid-bg-1': '#36363c',
  '--solid-bg-2': '#2e2e33',
  '--solid-bg-3': '#212125',
  '--solid-bg-bubble-file': '#1f1f23',
  '--solid-border-1': '#2a2a30',
  '--solid-border-2': '#3a3a42',
  '--solid-user-bubble': 'rgb(50, 52, 95)',
  '--solid-user-bubble-border': 'rgb(99, 102, 241)',
  '--solid-accent': '#818cf8',
  '--solid-accent-hover': '#a5b4fc',
};

/* ------------------------------------------------------------------ */
/*  Light theme — solid                                                */
/* ------------------------------------------------------------------ */

const LIGHT_SOLID: ThemeTokens = {
  '--solid-bg-1': '#fbfbff',
  '--solid-bg-2': '#efeff3',
  '--solid-bg-3': '#e4e4e8',
  '--solid-bg-bubble-file': '#f5f5f7',
  '--solid-border-1': '#e4e4e7',
  '--solid-border-2': '#d4d4d8',
  '--solid-user-bubble': '#eef2ff',
  '--solid-user-bubble-border': '#c7d2fe',
  '--solid-accent': '#4f46e5',
  '--solid-accent-hover': '#4338ca',
};

/* ------------------------------------------------------------------ */
/*  Export                                                             */
/* ------------------------------------------------------------------ */

export const BUILTIN_THEMES: BuiltinThemes = {
  light: { glass: LIGHT_GLASS, solid: LIGHT_SOLID },
  dark: { glass: DARK_GLASS, solid: DARK_SOLID },
};

/** Ordered list of built-in theme keys. */
export const BUILTIN_KEYS = ['light', 'dark'] as const;
