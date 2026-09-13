/**
 * Custom theme types.
 * A theme can be either:
 *   - `spine`: 8-10 key tokens, everything else auto-computed from a built-in base
 *   - `full`: complete glass + solid token maps, no inheritance
 */

export interface ThemeSpine {
  '--bg': string;
  '--bg-elev-1': string;
  '--bg-elev-2': string;
  '--bg-elev-3': string;
  '--accent': string;
  '--text': string;
  '--text-muted'?: string;
  '--text-faint'?: string;
  '--border'?: string;
  '--border-strong'?: string;
  '--accent-hover'?: string;
  '--accent-soft'?: string;
  '--user-bubble'?: string;
  '--user-bubble-gradient'?: string;
  '--user-bubble-border'?: string;
}

/** Current portable custom-theme format. Import accepts this exact version. */
export const THEME_FILE_VERSION = 1 as const;

export interface ThemeFile {
  name: string;
  version: typeof THEME_FILE_VERSION;
  mode: 'spine' | 'full';
  base?: 'light' | 'dark';

  /** Suggested Prism code theme (see `CodeTheme` in settings).
   *  Applied automatically when the user activates this UI theme
   *  and `codeTheme` is set to 'system'. */
  codeTheme?: string;

  /** Spine mode: key tokens override the base theme. */
  spine?: ThemeSpine;

  /** Full mode: complete glass token map (~45 tokens). */
  glass?: Record<string, string>;

  /** Full mode: complete solid token map (~10 tokens). */
  solid?: Record<string, string>;
}

export interface CustomTheme {
  id: string;
  name: string;
  source: ThemeFile;
  importedAt: number;
}

/** All CSS custom properties set by a built-in theme (glass mode). */
export type ThemeTokens = Record<string, string>;

/** Both glass and solid token maps for a single theme. */
export interface ThemeTokenPair {
  glass: ThemeTokens;
  solid: ThemeTokens;
}

/** Built-in theme name → glass+solid token maps. */
export type BuiltinThemes = Record<'light' | 'dark', ThemeTokenPair>;
