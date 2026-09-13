/**
 * Excalidraw diagram viewer.
 *
 * A full-viewport modal that renders an Excalidraw scene from JSON.
 * Opened by a small "pen" button overlaid on a `language-excalidraw`
 * code block in the chat bubble — see the `CodeBlock` component in
 * `src/utils/markdown.tsx`.
 *
 * Design notes
 * ------------
 *
 * **Why modal + explicit click, not auto-render.** Same reasoning as
 * Mermaid: Excalidraw is ~344 kB gzipped. Most code blocks aren't
 * diagrams. Click-to-render keeps the chat bubble light and only
 * pays the cost when the user actually wants the diagram.
 *
 * **Why deferred bundle loading.** Keeps Excalidraw out of the initial
 * bundle. The first open takes a short delay while the browser bundle loads;
 * subsequent opens are instant because the script and module are cached.
 *
 * **Why Excalidraw 0.18.1 is pinned.** This viewer is embedded inside a
 * constrained modal rather than running as the full Excalidraw application.
 * The dependency remains exact so the embedded layout and export contract do
 * not change unexpectedly. 0.18.1 is the latest 0.18.x release and includes
 * the Mermaid security patch from that release line.
 *
 * **Why the package CSS is loaded dynamically.** Excalidraw is a heavy
 * dependency, so both its ESM entry point and exported `index.css` are loaded
 * only when the modal opens. The package's production fonts are copied to
 * `public/excalidraw-assets`, and `EXCALIDRAW_ASSET_PATH` keeps font loading
 * self-hosted in the desktop/web build.
 *
 * **Why `viewModeEnabled`.** The diagram is LLM-generated content
 * displayed for review. Enabling view-only mode prevents accidental
 * edits, hides the toolbar clutter (undo/redo, shape picker, etc.),
 * and makes the experience read-focused. The user can always
 * copy-paste the JSON into excalidraw.com for editing.
 *
 * **Why the export controls behave this way.** SVG and PNG exports use a
 * fixed 4x scale and follow the active light/dark theme. A normal click
 * includes the scene background; Shift-click omits it for transparent output.
 * SVG geometry remains vector-based, while PNG is rendered to a 4x canvas.
 *
 * **Why no hand-rolled pan/zoom.** Unlike the Mermaid viewer (where
 * we render raw SVG and own the transform), Excalidraw's React
 * component has its own built-in pan/zoom/gesture system. We just
 * give it the full modal area and let it handle the rest.
 *
 * **Why fit on open.** The scene's saved zoom is not necessarily appropriate
 * for the current modal size. We request Excalidraw's built-in
 * `initialData.scrollToContent` behavior and also run a one-time fit from the
 * first restored-scene `onChange`, after the elements and viewer are ready.
 * The user can then zoom or pan normally.
 */

import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { useResolvedTheme } from '../shared/ThemeProvider.tsx';
import { lcExportFileName } from '../../utils/exportNames.ts';
import { saveBlobFile } from '../../utils/saveBlob.ts';
import { copyTextToClipboard } from '../../utils/clipboard.ts';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';
import { useScrollLock } from '../../utils/scroll-lock.ts';

interface Props {
  /** Excalidraw scene JSON string (as produced by the LLM skill). */
  source: string;
  /** Called when the user dismisses the modal (Esc, backdrop click, X). */
  onClose: () => void;
}

type Status =
  | { kind: 'loading' }
  | { kind: 'rendered'; elements: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> }
  | { kind: 'error'; message: string };

/** Excalidraw is a heavy dep. Loaded once and cached at module scope. */
type ExcalidrawModule = typeof import('@excalidraw/excalidraw');

interface ExcalidrawGlobals {
  EXCALIDRAW_ASSET_PATH?: string;
}

interface ViewerExcalidrawApi {
  getAppState: () => { zoom: { value: number } };
  updateScene: (sceneData: { appState: { zoom: { value: number } } }) => void;
  scrollToContent: (
    target?: unknown,
    options?: {
      fitToViewport?: boolean;
      viewportZoomFactor?: number;
      animate?: boolean;
    },
  ) => void;
}

function isViewerExcalidrawApi(value: unknown): value is ViewerExcalidrawApi {
  if (value == null || typeof value !== 'object') return false;
  const api = value as Record<string, unknown>;
  return typeof api.getAppState === 'function'
    && typeof api.updateScene === 'function'
    && typeof api.scrollToContent === 'function';
}

let excalidrawModule: ExcalidrawModule | null = null;
let excalidrawInitPromise: Promise<void> | null = null;
const EXPORT_SCALE = 4;
const FIT_TO_VIEWER_OPTIONS = {
  fitToViewport: true,
  viewportZoomFactor: 0.8,
  animate: false,
} as const;

async function getExcalidraw(): Promise<ExcalidrawModule> {
  if (!excalidrawInitPromise) {
    excalidrawInitPromise = (async () => {
      // Excalidraw 0.18.1 loads its ESM entry and stylesheet cleanly through
      // Vite. Its font loader still needs the self-hosted asset root.
      (window as Window & ExcalidrawGlobals).EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/';
      const [mod] = await Promise.all([
        import('@excalidraw/excalidraw'),
        import('@excalidraw/excalidraw/index.css'),
      ]);
      excalidrawModule = mod;
    })().catch((error) => {
      excalidrawInitPromise = null;
      excalidrawModule = null;
      throw error;
    });
  }
  await excalidrawInitPromise;
  return excalidrawModule!;
}

function getSafeBackgroundColor(appState?: Record<string, unknown>) {
  const color = appState?.viewBackgroundColor;

  if (
    typeof color === 'string' &&
    (color === 'transparent' || /^#[0-9a-f]{3,8}$/i.test(color))
  ) {
    return color;
  }

  return '#ffffff';
}

interface ExcalidrawRenderBoundaryProps {
  children: ReactNode;
}

interface ExcalidrawRenderBoundaryState {
  error: Error | null;
}

class ExcalidrawRenderBoundary extends Component<
  ExcalidrawRenderBoundaryProps,
  ExcalidrawRenderBoundaryState
> {
  state: ExcalidrawRenderBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ExcalidrawRenderBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="excalidraw-modal-error" role="alert">
          <strong>Couldn’t render this Excalidraw diagram.</strong>
          <span>{this.state.error.message}</span>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Check an element's `roundness` shape — `{ type: 2 | 3, value?: number }`.
 * `type` is validated as a finite number rather than against the current
 * `ROUNDNESS` enum, so a value from a newer Excalidraw still survives.
 */
function isRoundness(value: unknown): boolean {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Number.isFinite((value as { type?: unknown }).type);
}

/**
 * Sanitize a single LLM-generated Excalidraw element so it survives
 * Excalidraw's internal `restoreElements` / fractional-indexing validation.
 *
 * LLMs sometimes emit `version` or `versionNonce` as strings, produce
 * malformed `index` keys, or include unexpected fields that crash the
 * ordering system (e.g. "invalid order key: z08").  This function
 * coerces known numeric fields, keeps `roundness` only in its object
 * form, strips the `index` so Excalidraw regenerates valid
 * fractional-index keys, and drops any property that starts with `__`
 * (internal serialisation artefacts).
 */
function sanitizeElement(el: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(el)) {
    // Strip internal double-underscore keys the LLM may hallucinate.
    if (key.startsWith('__')) continue;

    switch (key) {
      case 'version':
        // Must be a finite integer ≥ 1.  Coerce strings / floats.
        out[key] = Number.isFinite(value) ? Math.max(1, Math.trunc(value as number)) : 1;
        break;
      case 'versionNonce':
        // Must be a finite non-negative integer.
        out[key] = Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0;
        break;
      case 'seed':
        // Must be a finite integer.
        out[key] = Number.isFinite(value) ? Math.trunc(value as number) : Math.floor(Math.random() * 2 ** 31);
        break;
      case 'updated':
        // Must be a finite number (timestamp).
        out[key] = Number.isFinite(value) ? value : Date.now();
        break;
      case 'index':
        // Drop the index entirely — Excalidraw regenerates valid
        // fractional-index keys during restore.  Keeping a malformed
        // one (e.g. "z08") is the #1 cause of restore crashes.
        break;
      case 'id':
        // Ensure it is a string (LLMs sometimes emit numbers).
        out[key] = typeof value === 'string' ? value : String(value);
        break;
      case 'angle':
      case 'strokeWidth':
      case 'roughness':
      case 'opacity':
      case 'fontSize':
      case 'autoResize':
      case 'isDeleted':
      case 'locked':
      case 'elbowed':
        // Numeric / boolean fields — pass through if already valid,
        // otherwise drop so Excalidraw applies its own defaults.
        if (typeof value === 'number' || typeof value === 'boolean') {
          out[key] = value;
        }
        break;
      case 'roundness':
        // Not numeric: `{ type: 2 | 3, value?: number }` for a rounded
        // shape, or `null` for sharp corners.  Grouping it with the
        // numeric fields above dropped every `roundness` object, so
        // Excalidraw restored rounded shapes with sharp corners.
        if (value === null || isRoundness(value)) {
          out[key] = value;
        }
        break;
      default:
        out[key] = value;
    }
  }

  // Ensure mandatory identity fields exist.
  if (!out.id) out.id = `el_${Math.random().toString(36).slice(2, 11)}`;
  if (!('version' in out)) out.version = 1;
  if (!('versionNonce' in out)) out.versionNonce = 0;

  return out;
}

function sanitizeElements(elements: unknown[]): Record<string, unknown>[] {
  return elements.map((el) => {
    if (el == null || typeof el !== 'object') return { id: `el_${Math.random().toString(36).slice(2, 11)}`, type: 'rectangle', version: 1, versionNonce: 0 };
    return sanitizeElement(el as Record<string, unknown>);
  });
}

/**
 * Parse the Excalidraw JSON source and extract the scene data.
 * Returns a Status — loading/error/rendered — so the UI can show
 * the appropriate state while the dynamic import is in flight.
 */
function useSceneData(source: string): Status {
  // Parse eagerly so parse errors show immediately — no need
  // to wait for the dynamic import to know the JSON is bad.
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (e) {
    return { kind: 'error', message: `Invalid JSON: ${(e as Error).message}` };
  }
  if (parsed == null || typeof parsed !== 'object') {
    return { kind: 'error', message: 'Expected a JSON object with Excalidraw scene data.' };
  }
  const obj = parsed as Record<string, unknown>;
  const rawElements = obj.elements;
  if (!Array.isArray(rawElements) || rawElements.length === 0) {
    return { kind: 'error', message: 'Scene JSON must contain a non-empty "elements" array.' };
  }
  return {
    kind: 'rendered',
    elements: sanitizeElements(rawElements),
    appState: typeof obj.appState === 'object' && obj.appState != null
      ? (obj.appState as Record<string, unknown>)
      : undefined,
    files: typeof obj.files === 'object' && obj.files != null
      ? (obj.files as Record<string, unknown>)
      : undefined,
  };
}

/**
 * Excalidraw renders several internal lists without `key` props
 * (LoadingMessage, App, LayerUI, Footer, Section, ToolButton, <g>,
 * DropdownMenu).  React dev-mode `console.error` becomes very noisy
 * when the viewer is open.  We temporarily filter out the key-warning
 * line while the modal is mounted so the console stays usable.
 */
function useSuppressExcalidrawKeyWarnings() {
  useEffect(() => {
    const original = console.error.bind(console);
    const KEY_WARNING = 'Each child in a list should have a unique "key" prop.';

    console.error = (...args: unknown[]) => {
      const first = typeof args[0] === 'string' ? args[0] : '';
      // Only suppress the "missing key" message — let all other
      // errors (including the follow-up "Check the render method
      // of …" lines) through, because they help identify the
      // component.  The noise reduction is still dramatic.
      if (first.includes(KEY_WARNING)) return;
      original(...args);
    };

    return () => {
      console.error = original;
    };
  }, []);
}

export function ExcalidrawViewer({ source, onClose }: Props) {
  const status = useSceneData(source);
  const theme = useResolvedTheme();
  const excalidrawApiRef = useRef<ViewerExcalidrawApi | null>(null);
  const sceneReadyRef = useRef(false);
  const initialFitScheduledRef = useRef(false);
  const initialFitFrameRef = useRef<number | null>(null);
  const initialFitCompleteRef = useRef<(() => void) | null>(null);
  const scheduleInitialFit = useCallback((api: ViewerExcalidrawApi | null) => {
    if (!api || initialFitScheduledRef.current) return;
    initialFitScheduledRef.current = true;

    // onChange fires after initialData has restored the scene. Wait two frames
    // so the modal's measured viewport is also available to Excalidraw.
    initialFitFrameRef.current = requestAnimationFrame(() => {
      initialFitFrameRef.current = requestAnimationFrame(() => {
        initialFitFrameRef.current = null;
        if (excalidrawApiRef.current === api) {
          api.scrollToContent(undefined, FIT_TO_VIEWER_OPTIONS);
          initialFitCompleteRef.current?.();
          initialFitCompleteRef.current = null;
        }
      });
    });
  }, []);
  const handleApiReady = useCallback((api: unknown) => {
    if (!isViewerExcalidrawApi(api)) return;
    excalidrawApiRef.current = api;
    if (sceneReadyRef.current) scheduleInitialFit(api);
  }, [scheduleInitialFit]);
  const handleSceneChange = useCallback((
    elements: readonly unknown[],
    onFitComplete: () => void,
  ) => {
    if (elements.length === 0) return;
    sceneReadyRef.current = true;
    initialFitCompleteRef.current = onFitComplete;
    scheduleInitialFit(excalidrawApiRef.current);
  }, [scheduleInitialFit]);

  useEffect(() => () => {
    if (initialFitFrameRef.current !== null) {
      cancelAnimationFrame(initialFitFrameRef.current);
      initialFitFrameRef.current = null;
    }
    initialFitCompleteRef.current = null;
    excalidrawApiRef.current = null;
  }, []);

  // Suppress noisy upstream key warnings while the embedded library is open.
  // library — these are upstream bugs we can't patch in the bundle.
  useSuppressExcalidrawKeyWarnings();

  // Esc to close, only while this is the innermost overlay. Registered on
  // `window` in capture by the hook, so it works whether or not the modal has
  // focus — same reach the old document-level listener had.
  useOverlayEscape(onClose);

  // Lock body scroll while the modal is open. Shared counter, so releasing
  // out of order cannot unlock the page under an overlay that is still up.
  useScrollLock();

  // ── Zoom (through Excalidraw's imperative API) ───────────────────────
  // Synthetic keyboard events are ignored by some WebViews and don't
  // reliably reach Excalidraw when the embedded canvas is view-only.
  const zoomBy = useCallback((factor: number) => {
    const api = excalidrawApiRef.current;
    if (!api) return;
    const current = api.getAppState().zoom.value;
    const next = Math.max(0.1, Math.min(30, current * factor));
    api.updateScene({
      appState: { zoom: { value: next as typeof current } },
    });
  }, []);
  const zoomIn = useCallback(() => zoomBy(1.1), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / 1.1), [zoomBy]);
  const zoomReset = useCallback(() => {
    excalidrawApiRef.current?.scrollToContent(undefined, {
      ...FIT_TO_VIEWER_OPTIONS,
    });
  }, []);

  // ── Copy source ──────────────────────────────────────────────
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const copySource = useCallback(async () => {
    try {
      await copyTextToClipboard(source);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 1500);
    }
  }, [source]);

  // ── Export state ─────────────────────────────────────────────
  type ExportKind = 'svg' | 'png';
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [exportError, setExportError] = useState(false);

  const doExport = useCallback(async (kind: ExportKind, transparent = false) => {
    setExporting(kind);
    setExportError(false);
    try {
      const mod = await getExcalidraw();
      const parsed = JSON.parse(source);
      const { elements, appState: rawAppState, files } = parsed;

      const exportAppState = {
        ...(rawAppState ?? {}),
        theme,
        exportBackground: !transparent,
        exportWithDarkMode: theme === 'dark',
        exportScale: EXPORT_SCALE,
      };

      let blob: Blob;
      if (kind === 'svg') {
        // SVG export uses Excalidraw's dedicated exporter so the saved
        // file keeps vector geometry and text.
        const svgExport = mod.exportToSvg;
        if (typeof svgExport !== 'function') {
          throw new Error('SVG export is unavailable.');
        }
        const svgEl = await svgExport({
          elements,
          appState: exportAppState,
          files: files ?? {},
          exportPadding: 16,
        });
        blob = new Blob([svgEl.outerHTML], { type: 'image/svg+xml' });
      } else {
        const canvas: HTMLCanvasElement = await mod.exportToCanvas({
          elements,
          appState: exportAppState,
          files: files ?? {},
          exportPadding: 16,
          getDimensions: (width: number, height: number) => ({
            width: width * EXPORT_SCALE,
            height: height * EXPORT_SCALE,
            scale: EXPORT_SCALE,
          }),
        });
        blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((b) => resolve(b!), 'image/png'));
      }

      await saveBlobFile(
        lcExportFileName('excalidraw-diagram', kind),
        blob,
        [{ name: kind === 'svg' ? 'SVG image' : 'PNG image', extensions: [kind] }],
      );
    } catch {
      setExportError(true);
    }
    setTimeout(() => {
      setExporting(null);
      setExportError(false);
    }, 1500);
  }, [source, theme]);

  // ── Dynamic Excalidraw wrapper ──────────────────────────────
  // Renders a placeholder while the chunk loads, then the real
  // component once it's available.  This is a single-pass dynamic
  // import — no flicker between "loading" and "rendered" because
  // the JSON parse (useSceneData) happens synchronously and the
  // async piece is just the component code itself.

  return createPortal(
    <div
      className="excalidraw-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="excalidraw-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Excalidraw diagram viewer"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Toolbar ─────────────────────────────────────── */}
        <div className="excalidraw-modal-toolbar">
          <button type="button" className="excalidraw-modal-btn"
            onClick={zoomIn} title="Zoom in" aria-label="Zoom in">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              strokeLinejoin="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          <button type="button" className="excalidraw-modal-btn"
            onClick={zoomOut} title="Zoom out" aria-label="Zoom out">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              strokeLinejoin="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          <button type="button" className="excalidraw-modal-btn"
            onClick={zoomReset} title="Fit to viewer" aria-label="Fit to viewer">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              strokeLinejoin="round" aria-hidden>
              <path d="M3 8V5a2 2 0 0 1 2-2h3" />
              <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" />
              <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
            </svg>
          </button>
          <button type="button" className="excalidraw-modal-btn"
            onClick={copySource}
            title={copyState === 'copied' ? 'Copied!' : copyState === 'error' ? "Couldn't copy" : 'Copy source'}
            aria-label={copyState === 'copied' ? 'Source copied' : 'Copy source to clipboard'}>
            {copyState === 'copied' ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                strokeLinejoin="round" aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                strokeLinejoin="round" aria-hidden>
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
          <button type="button" className="excalidraw-modal-btn"
            onClick={(event) => doExport('svg', event.shiftKey)}
            disabled={status.kind !== 'rendered' || exporting === 'svg'}
            title={exportError ? 'Export failed' : exporting === 'svg' ? 'SVG saved' : 'Download SVG (4x; Shift+click for transparent)'}
            aria-label="Download diagram as SVG">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              strokeLinejoin="round" aria-hidden>
              <path d="M12 3v12" />
              <path d="m7 10 5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
          </button>
          <button type="button" className="excalidraw-modal-btn"
            onClick={(event) => doExport('png', event.shiftKey)}
            disabled={status.kind !== 'rendered' || exporting === 'png'}
            title={exportError ? 'Export failed' : exporting === 'png' ? 'PNG saved' : 'Download PNG (4x; Shift+click for transparent)'}
            aria-label="Download diagram as PNG">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              strokeLinejoin="round" aria-hidden>
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="8.5" cy="9" r="1.5" />
              <path d="m3 16 5-5 4 4 3-3 6 6" />
            </svg>
          </button>
          <div className="excalidraw-modal-toolbar-spacer" />
          <button type="button" className="excalidraw-modal-btn"
            onClick={onClose} title="Close (Esc)" aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* ── Body ───────────────────────────────────────── */}
        <div className="excalidraw-modal-body">
          {status.kind === 'loading' && (
            <div className="excalidraw-modal-status">Loading Excalidraw…</div>
          )}
          {status.kind === 'error' && (
            <div className="excalidraw-modal-error">
              <div className="excalidraw-modal-error-title">
                Couldn't parse Excalidraw scene
              </div>
              <pre className="excalidraw-modal-error-message">{status.message}</pre>
            </div>
          )}
          {status.kind === 'rendered' && (
            <ExcalidrawCanvas
              elements={status.elements}
              appState={status.appState}
              files={status.files}
              onApiReady={handleApiReady}
              onSceneChange={handleSceneChange}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Inner component: wraps the dynamic import ─────────────────

interface CanvasProps {
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
  onApiReady: (api: unknown) => void;
  onSceneChange: (elements: readonly unknown[], onFitComplete: () => void) => void;
}

function ExcalidrawCanvas({ elements, appState, files, onApiReady, onSceneChange }: CanvasProps) {
  const theme = useResolvedTheme();
  const [mod, setMod] = useState<typeof import('@excalidraw/excalidraw') | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [autoFitReady, setAutoFitReady] = useState(false);

  const handleSceneChange = useCallback((nextElements: readonly unknown[]) => {
    onSceneChange(nextElements, () => setAutoFitReady(true));
  }, [onSceneChange]);

  useEffect(() => {
    let cancelled = false;
    getExcalidraw()
      .then((m) => {
        if (!cancelled) setMod(m);
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(`Failed to load Excalidraw: ${(e as Error).message}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadErr) {
    return (
      <div className="excalidraw-modal-error">
        <div className="excalidraw-modal-error-title">Failed to load Excalidraw</div>
        <pre className="excalidraw-modal-error-message">{loadErr}</pre>
      </div>
    );
  }

  if (!mod) {
    return <div className="excalidraw-modal-status">Loading Excalidraw…</div>;
  }

  const { Excalidraw, MainMenu } = mod;

  const initialData: ExcalidrawInitialDataState = {
    elements: elements as unknown as readonly OrderedExcalidrawElement[],
    appState: {
      viewBackgroundColor: getSafeBackgroundColor(appState),
    },
    files: files as unknown as BinaryFiles,
    scrollToContent: true,
  };

  return (
    <ExcalidrawRenderBoundary>
      <div className={`excalidraw-modal-canvas${autoFitReady ? ' is-ready' : ''}`}>
        <Excalidraw
          initialData={initialData}
          excalidrawAPI={onApiReady}
          onChange={handleSceneChange}
          viewModeEnabled
          zenModeEnabled={false}
          handleKeyboardGlobally={false}
          theme={theme}
        >
          <MainMenu>
            <MainMenu.DefaultItems.LoadScene />
            <MainMenu.DefaultItems.SaveToActiveFile />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
        {!autoFitReady && (
          <div className="excalidraw-modal-fit-status">Fitting diagram…</div>
        )}
      </div>
    </ExcalidrawRenderBoundary>
  );
}
