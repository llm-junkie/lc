/**
 * Settings store: UI preferences, theme, per-user configuration.
 * Server profiles and their toggle state live in the profile store.
 *
 * Any profile with `active: true` is active.
 * Use `getActiveProfiles()` from the profile store.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ThemeMode } from '../types';
import type { CustomTheme } from '../themes/types';
import { observableLocalStorage } from './local-storage.ts';
import { migrateSolidTheme } from '../platform/material-resolver.ts';
import type { MaterialMode } from '../platform/material-resolver';

export const SETTINGS_STORE_VERSION = 2 as const;

/** Search backend for `lc_web_search` / `lc_web_research`.
 *  `auto` resolves by priority; the rest pin one explicitly. */
export type WebSearchProvider = 'auto' | 'brave' | 'searxng' | 'marginalia';

/** The concrete providers, in `auto` priority order.
 *
 *  Brave first: best general index, and the user registered for it.
 *  SearXNG second: self-hosting is a deliberate act, and it aggregates
 *  mainstream engines. Marginalia last: the narrowest index by design. */
export const WEB_SEARCH_PRIORITY = ['brave', 'searxng', 'marginalia'] as const;
export type ConcreteWebSearchProvider = (typeof WEB_SEARCH_PRIORITY)[number];

/** Preset code-block syntax-highlighting themes.
 *  'system' follows the app's resolved data-base light/dark attribute.
 *  See `src/utils/useCodeTheme.ts` for the CSS file mapping. */
export type CodeTheme = 'system'
  | 'one-dark' | 'one-light'
  | 'a11y-dark' | 'atom-dark' | 'base16-ateliersulphurpool.light'
  | 'cb' | 'coldark-cold' | 'coldark-dark' | 'coy-without-shadows'
  | 'darcula' | 'dracula'
  | 'duotone-dark' | 'duotone-earth' | 'duotone-forest'
  | 'duotone-light' | 'duotone-sea' | 'duotone-space'
  | 'github'
  | 'gruvbox-dark' | 'gruvbox-light'
  | 'holi-theme' | 'hopscotch'
  | 'lucario'
  | 'material-dark' | 'material-light' | 'material-oceanic'
  | 'night-owl' | 'nord'
  | 'pojoaque'
  | 'shades-of-purple' | 'solarized-dark-atom' | 'synthwave84'
  | 'vs' | 'vsc-dark-plus'
  | 'xonokai'
  | 'z-touch';

/** Platform-specific default shell binary allowlists. */
export const SHELL_DEFAULT_WINDOWS =
  'cmd,powershell,dir,type,findstr,where,tasklist,echo,cd,python3,python,git,node';
export const SHELL_DEFAULT_LINUX =
  'sh,bash,dash,cat,echo,printf,head,tail,grep,wc,find,test,true,false,pwd,date,python3,git,node,ls,cp,mv,rm,mkdir';
export const SHELL_DEFAULT_MACOS =
  'sh,bash,zsh,cat,echo,printf,head,tail,grep,wc,find,test,true,false,pwd,date,python3,git,node,ls,cp,mv,rm,mkdir';

/** Return the platform-appropriate default shell allowlist. */
export function getDefaultShellAllowlist(): string {
  const raw = (typeof navigator !== 'undefined' ? navigator.platform : '')?.toLowerCase() || 'unknown';
  if (raw.includes('win')) return SHELL_DEFAULT_WINDOWS;
  if (raw.includes('mac')) return SHELL_DEFAULT_MACOS;
  return SHELL_DEFAULT_LINUX; // Linux and unknown
}

/** Return a fresh copy of the default settings state (data properties
 *  only — no mutation functions). Used by the store initialization
 *  and by `resetSettings()` so the two stay in sync. */
export function getDefaultSettingsData(): Omit<
  SettingsState,
  | 'setTheme' | 'setAssistantName' | 'setTools'
  | 'setZoom' | 'setPinComposer' | 'setTokenMeterStyle'
  | 'setAutoPreviewReasoning' | 'setShowOnlyLatestTodoList' | 'setAutoArchiveDays'
  | 'setMaxConcurrentGenerations'
  | 'setPreviewOverlayHeight' | 'toggleSidebar' | 'toggleSidePanel'
  | 'requestOpenAgenticTools' | 'setMaterialMode' | 'setCodeTheme' | 'setCustomThemeOpen'
  | 'setThemeFilter' | 'setCustomThemes' | 'addCustomThemes'
  | 'removeCustomTheme' | 'setActiveCustomTheme'
> {
  return {
    theme: 'system' as ThemeMode,
    assistantName: 'Assistant',
    zoom: 1.0,
    pinComposer: false,
    tokenMeterStyle: 'donut' as const,
    autoPreviewReasoning: true,
    showOnlyLatestTodoList: true,
    autoArchiveDays: 0,
    maxConcurrentGenerations: 2 as 1 | 2 | 3,
    tools: {
      shell_allowlist: getDefaultShellAllowlist(),
      default_allowed_roots: [] as string[],
      web_fetch_rate_per_min: 50,
      brave_search_api_key: '',
      brave_search_api_key_ref: '' as string | undefined,
      searxng_base_url: '',
      marginalia_api_key: '',
      marginalia_api_key_ref: '' as string | undefined,
      web_search_provider: 'auto' as WebSearchProvider,
      vision_model: '',
      web_research_model: '',
      pdf_summarize_model: '',
    },
    previewOverlayHeight: 175,
    materialMode: 'auto' as MaterialMode,
    codeTheme: 'system' as CodeTheme,
    customThemes: [],
    activeCustomThemeId: null,
    customThemeOpen: false,
    themeFilter: 'all' as 'all' | 'light' | 'dark',
    ui: {
      sidebarOpen: true,
      sidePanelOpen: false,
      sidePanelTab: 'tools' as const,
      openAgenticTools: false,
    },
  };
}

interface SettingsState {
  theme: ThemeMode;
  /** Display name for the assistant in message bubbles. */
  assistantName: string;
  /** Global tools config. Per-conversation overrides live on
   *  `Conversation.tools`; new conversations inherit these defaults. */
  tools: {
    /** Default shell binaries allowed by `run_shell`. Comma- or
     *  newline-separated basenames. */
    shell_allowlist: string;
    /** Default roots inherited by new conversations. */
    default_allowed_roots: string[];
    /** Max web_fetch calls per conversation per minute. */
    web_fetch_rate_per_min: number;
    /** Brave Search API key for web_search. Configure at
     *  https://brave.com/search/api/. */
    brave_search_api_key: string;
    /** Key-store ref for the Brave Search API key. Set when the key is stored
     *  in the encrypted local key store (same as profile apiKeyRef). */
    brave_search_api_key_ref?: string;
    /** Base URL of a self-hosted SearXNG instance, e.g.
     *  `http://localhost:8080`. A supported value uses `http` or `https` and
     *  contains no URL credentials. It is stored in the clear and shown
     *  unmasked so the user can spot a typo. There is no usable
     *  public instance: SearXNG ships `search.formats: [html]`, so the
     *  operator must enable `json` themselves. */
    searxng_base_url: string;
    /** Marginalia API key. `public` works without signup but is shared
     *  globally and rate-limited to roughly 3 queries/minute. */
    marginalia_api_key: string;
    /** Keychain ref for the Marginalia API key. */
    marginalia_api_key_ref?: string;
    /** Which provider serves `lc_web_search` / `lc_web_research`.
     *  `auto` picks the first configured of brave → searxng → marginalia.
     *  Kept separate from the credentials so switching provider never
     *  requires deleting a key. See docs/search-providers.md §2.1
     *  "Settings surface". */
    web_search_provider: WebSearchProvider;
    /** Model for vision/image analysis (e.g. qwen/qwen3.6-27b).
     *  Falls back to the chat model if empty. */
    vision_model: string;
    /** Model for web research (e.g. qwen/qwen3.6-27b).
     *  Falls back to the chat model if empty. */
    web_research_model: string;
    /** Model that summarizes PDF text for `lc_read_pdf`. Used for every
     *  summary call whose payload carries no page image; chunks that do
     *  carry one go to `vision_model` instead.
     *  Falls back to the chat model if empty. */
    pdf_summarize_model: string;
  };
  /**
   * UI zoom factor applied to the whole document via `body.style.zoom`.
   *  1.0 = 100% (default). Values 0.8 / 0.9 / 1.0 / 1.1 / 1.25 are exposed
   *  in the settings panel as discrete chips so users can pick a level that
   *  fits their screen density without risking off-by-one slider drift.
   */
  zoom: number;
  /**
   * When true, the composer input and action row are always visible
   * (as if focused/hovered), instead of fading in only on hover/focus.
   */
  pinComposer: boolean;
  /** Visual style for the TokenMeter donut/cake widget. */
  tokenMeterStyle: 'donut' | 'cake';
  /**
   * When true (default), the reasoning preview overlay auto-opens
   * whenever the model streams reasoning.  When false, the overlay
   * only opens via the manual 🧠 button (or stays open if pinned).
   */
  autoPreviewReasoning: boolean;
  /** When true, the preview overlay's To do list tab renders only the
   *  newest snapshot in the selected turn. False preserves the full ordered
   *  update history. */
  showOnlyLatestTodoList: boolean;
  /**
   * Auto-archive conversations whose last `updatedAt` is older than
   * this many days. 0 = disabled (the default). When set to N>0, a
   * sweep runs on app start and on every setting change; already-
   * archived conversations are skipped so the sweep is idempotent.
   * A conversation counts as "stale" if its `updatedAt` is more than
   * `autoArchiveDays * 86400_000` ms in the past. Active chats only —
   * the sweep never re-archives something the user already pulled
   * out of the archive.
   */
  autoArchiveDays: number;
  /** Rollback-capable application generation cap; hard maximum is three. */
  maxConcurrentGenerations: 1 | 2 | 3;
  /** User-chosen height of the preview overlay in pixels
   *  (clamped 175px–60vh). Persisted across sessions. */
  previewOverlayHeight: number;
  ui: {
    sidebarOpen: boolean;
    /** One sliding panel, two tabs. `sidePanelOpen` controls
     *  visibility; `sidePanelTab` selects Params vs Tools. The
     *  active tab is persisted so re-opening brings the user
     *  back to whichever tab they last used. The composer has
     *  two chips (Server default / 🧰 Tools) that open the
     *  same panel to different tabs. */
    sidePanelOpen: boolean;
    sidePanelTab: 'params' | 'tools';
    /**
     * Transient flag: when true, the next time SettingsPage opens
     * it should auto-expand the "Agentic tools" section and
     * collapse everything else. Consumed (reset to false) by
     * SettingsPage on open. Not persisted.
     */
    openAgenticTools: boolean;
  };

  /* mutations */
  setTheme: (mode: ThemeMode) => void;
  setAssistantName: (name: string) => void;
  setZoom: (z: number) => void;
  setPinComposer: (v: boolean) => void;
  setTokenMeterStyle: (v: 'donut' | 'cake') => void;
  setAutoPreviewReasoning: (v: boolean) => void;
  setShowOnlyLatestTodoList: (v: boolean) => void;
  setAutoArchiveDays: (days: number) => void;
  setMaxConcurrentGenerations: (capacity: 1 | 2 | 3) => void;
  setTools: (tools: SettingsState['tools']) => void;
  /**
   * Resize the preview overlay to a specific pixel height.
   * Called by the PreviewOverlay component's bottom-edge
   * drag handle, once per `pointermove` while dragging (and
   * once on double-click to snap back to the default). The
   * value is stored verbatim here; the clamp is applied at
   * the call site (the overlay knows its own min/max bounds
   * — see PreviewOverlay.handleResizeStart / dblclick),
   * not here, so the store stays agnostic of the bounds and
   * the bounds can change without changing the persisted shape.
   */
  setPreviewOverlayHeight: (px: number) => void;
  toggleSidebar: (open?: boolean) => void;
  /**
   * Open/close the side panel and (optionally) pick a tab.
   *
   *   - `toggleSidePanel()`          — toggle the current panel.
   *   - `toggleSidePanel('params')`  — open at the Params tab
   *                                    (or close if already on
   *                                    Params — toggle semantics).
   *   - `toggleSidePanel('tools')`   — open at the Tools tab.
   *   - `toggleSidePanel(false)`     — force close regardless
   *                                    of which tab is active
   *                                    (used by Escape).
   */
  toggleSidePanel: (open?: boolean | 'params' | 'tools') => void;
  /**
   * Called from the Workspace panel's "Open Settings > AGENTIC TOOLS"
   * button. Closes the side panel and sets a transient flag that
   * SettingsPage consumes on its next open to auto-expand the
   * Agentic tools section.
   */
  requestOpenAgenticTools: () => void;
  /**
   * User-controllable window/surface material preference.
   *
   *   - `'auto'` (default) — native material where the platform
   *     supports one (Mica/Acrylic on Windows, vibrancy on macOS);
   *     deliberate matte on Linux.
   *   - `'glass'` — prefer glass; keeps a readable fallback when
   *     native blur is unavailable (migrated from `solidTheme: 'off'`).
   *   - `'solid'` — opaque surfaces on every platform (migrated from
   *     `solidTheme: 'on'`).
   *
   * Resolved once per change by `utils/useApplyMaterial.ts`, which
   * mirrors the resolution to `data-material-*` attributes and the
   * `.solid` class consumed by `src/themes/solid.css`.
   */
  materialMode: MaterialMode;
  setMaterialMode: (mode: MaterialMode) => void;
  /** Code block syntax-highlighting theme. 'system' follows the
   *  app data-theme (dark → one-dark, light → one-light). */
  codeTheme: CodeTheme;
  setCodeTheme: (theme: CodeTheme) => void;
  /** Imported custom themes. */
  customThemes: CustomTheme[];
  /** ID of the currently active custom theme, or null if using built-in. */
  activeCustomThemeId: string | null;
  /** Whether the Custom Theme modal is open. */
  customThemeOpen: boolean;
  setCustomThemeOpen: (open: boolean) => void;
  /** Active theme filter for cycle + list. */
  themeFilter: 'all' | 'light' | 'dark';
  setThemeFilter: (filter: 'all' | 'light' | 'dark') => void;
  /** Replace the full custom theme list (e.g. after import). */
  setCustomThemes: (themes: CustomTheme[]) => void;
  /** Add imported themes, deduplicating by name (latest wins). */
  addCustomThemes: (themes: CustomTheme[]) => void;
  /** Remove a custom theme by id. */
  removeCustomTheme: (id: string) => void;
  /** Set the active custom theme (null = built-in). */
  setActiveCustomTheme: (id: string | null) => void;
}

export const DEFAULT_BASE_URL = 'http://127.0.0.1:1234/v1';
// `devProxyUrl()` in `src/modules/llm-client/proxy.ts` auto-rewrites this to the proxy format
// at runtime. No need to store the proxy URL — the user sees a clean
// host:port in the Settings UI.

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...getDefaultSettingsData(),

      setTheme: (theme) => set({ theme }),
      setAssistantName: (assistantName) => set({ assistantName: assistantName.trim() || 'Assistant' }),
      setTools: (tools) => set({ tools }),
      setZoom: (zoom) => set({ zoom }),
      setPinComposer: (pinComposer) => set({ pinComposer }),
      setTokenMeterStyle: (tokenMeterStyle) => set({ tokenMeterStyle }),
      setAutoPreviewReasoning: (autoPreviewReasoning) => set({ autoPreviewReasoning }),
      setShowOnlyLatestTodoList: (showOnlyLatestTodoList) => set({ showOnlyLatestTodoList }),
      setAutoArchiveDays: (autoArchiveDays) => set({ autoArchiveDays: Math.max(0, Math.floor(autoArchiveDays) || 0) }),
      setMaxConcurrentGenerations: (maxConcurrentGenerations) => set({
        maxConcurrentGenerations: Math.max(1, Math.min(3, maxConcurrentGenerations)) as 1 | 2 | 3,
      }),
      // No clamp here — the PreviewOverlay's drag handler
      // already clamps the value at its 175px floor and 60vh
      // ceiling before calling us. Storing a value the
      // overlay then ignores (because the clamp re-asserts)
      // would be a silent footgun; trusting the call site
      // keeps the data and the visible state in agreement.
      // If something other than the overlay ever calls this
      // (a future "set to default" button, e.g.), the
      // `Math.max(0, ...)` below keeps the value non-
      // negative; out-of-bounds positives are accepted and
      // the overlay will clamp on render.
      setPreviewOverlayHeight: (px) => set({ previewOverlayHeight: Math.max(0, Math.floor(px) || 0) }),
      toggleSidebar: (open) =>
        set((s) => ({ ui: { ...s.ui, sidebarOpen: open ?? !s.ui.sidebarOpen } })),
      // Side-panel toggle. See the signature comment for the four
      // call shapes. The `tab` argument is sticky — opening to
      // Tools means the panel remembers Tools as the active tab
      // even after the user closes & re-opens.
      toggleSidePanel: (open) =>
        set((s) => {
          if (open === false) {
            // Explicit close (Escape).
            return { ui: { ...s.ui, sidePanelOpen: false } };
          }
          if (open === 'params' || open === 'tools') {
            // Panel closed → open to requested tab.
            // Panel open on a different tab → switch to requested tab.
            // Panel open on the same tab → close.
            if (!s.ui.sidePanelOpen) {
              return { ui: { ...s.ui, sidePanelOpen: true, sidePanelTab: open } };
            }
            if (s.ui.sidePanelTab !== open) {
              return { ui: { ...s.ui, sidePanelTab: open } };
            }
            return { ui: { ...s.ui, sidePanelOpen: false } };
          }
          // No argument or `true` — toggle the current state.
          return {
            ui: {
              ...s.ui,
              sidePanelOpen: !s.ui.sidePanelOpen,
            },
          };
        }),
      requestOpenAgenticTools: () =>
        set((s) => ({
          ui: {
            ...s.ui,
            openAgenticTools: true,
          },
        })),
      setMaterialMode: (mode) => set({ materialMode: mode }),
      setCodeTheme: (theme) => set({ codeTheme: theme }),
      setCustomThemeOpen: (open) => set({ customThemeOpen: open }),
      setThemeFilter: (filter) => set({ themeFilter: filter }),
      setCustomThemes: (themes) => set({ customThemes: themes }),
      addCustomThemes: (incoming) =>
        set((s) => {
          const byName = new Map(s.customThemes.map((t) => [t.name, t]));
          for (const t of incoming) byName.set(t.name, t);
          return { customThemes: [...byName.values()] };
        }),
      removeCustomTheme: (id) =>
        set((s) => ({
          customThemes: s.customThemes.filter((t) => t.id !== id),
          activeCustomThemeId: s.activeCustomThemeId === id ? null : s.activeCustomThemeId,
        })),
      setActiveCustomTheme: (id) => set({ activeCustomThemeId: id }),

    }),
    {
      name: 'lc:settings',
      // Version mismatches are rejected by Zustand's persist layer; this
      // Version mismatches are rejected; this is the only supported schema.
      version: SETTINGS_STORE_VERSION,
      // v1 → v2: `solidTheme: 'auto'|'on'|'off'` became
      // `materialMode: 'auto'|'solid'|'glass'` with the effective
      // preference preserved. The legacy key is deleted so it cannot
      // leak back through the shallow merge below.
      migrate: (persisted, version) => {
        const saved = (persisted ?? {}) as Record<string, unknown>;
        if (version < 2) {
          const migrated = migrateSolidTheme(saved.solidTheme);
          if (migrated) saved.materialMode = migrated;
          delete saved.solidTheme;
        }
        if (
          saved.materialMode !== 'auto'
          && saved.materialMode !== 'glass'
          && saved.materialMode !== 'solid'
        ) {
          saved.materialMode = 'auto';
        }
        return saved as Partial<SettingsState>;
      },
      storage: createJSONStorage(() => observableLocalStorage),
      // Keep decrypted search-provider keys out of localStorage. When a
      // keychain ref exists the ciphertext on disk is the record of the key,
      // and a plaintext copy here would defeat the point of encrypting it —
      // see platform/search-key-cache.ts for where the live value is held.
      // Without a ref (web build, or a failed keychain write) the store is
      // the only place the key can live, so it is persisted as before.
      //
      // Every keyed provider must appear here. A provider added to the
      // settings shape but missed here silently writes its plaintext key to
      // disk, which is the exact failure settings-brave-key.test.ts exists
      // to catch.
      partialize: (state) => {
        const tools = { ...state.tools };
        if (tools.brave_search_api_key_ref) tools.brave_search_api_key = '';
        if (tools.marginalia_api_key_ref) tools.marginalia_api_key = '';
        return { ...state, tools };
      },
      // Zustand's default merge is shallow, so a persisted `tools` object
      // *replaces* the default one wholesale — every key added to `tools`
      // after a user's settings were written back would arrive `undefined`
      // for them, while TypeScript still claims it is present. That is not a
      // hypothetical: it crashed the settings panel the first time
      // `web_search_provider` was read from pre-existing localStorage.
      //
      // Nesting `tools` one level deeper fixes the whole category. Bumping
      // the store version would not: mismatches are rejected, which would
      // discard the user's settings rather than extend them.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...saved,
          tools: { ...current.tools, ...(saved.tools ?? {}) },
        };
      },
    },
  ),
);
