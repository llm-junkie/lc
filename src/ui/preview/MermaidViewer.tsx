/**
 * Mermaid/SVG diagram viewer.
 *
 * A full-viewport modal that renders a Mermaid diagram with pan, zoom,
 * recenter-fit, and 4x SVG/PNG export. Opened by a small "eye" button overlaid
 * on a `language-mermaid` code block in the chat bubble — see the
 * `CodeBlock` component in `src/utils/markdown.tsx`.
 *
 * Design notes
 * ------------
 *
 * **Why modal + explicit click, not auto-render.** Mermaid is ~200KB
 * minified. Most code blocks in a chat aren't diagrams. Click-to-render
 * keeps the chat bubble light, lets the user see the source as code
 * first, and only pays the mermaid cost when the user actually wants
 * the diagram.
 *
 * **Why hand-rolled pan/zoom (no svg-pan-zoom).** svg-pan-zoom is fine,
 * but for full control over the toolbar (zoom in/out buttons, recenter,
 * SVG export) it's simpler to own the transform ourselves. We put the
 * mermaid SVG inside a `<div>` and apply CSS `transform: translate()
 * scale()` to it. Three numbers (tx, ty, scale), no SVG viewBox math,
 * and the transform composes naturally with the modal's flex layout.
 *
 * **Why the export controls behave this way.** SVG and PNG are generated
 * from one normalized SVG representation so the two formats match. Both use
 * a 4x export scale and the active Mermaid theme; Shift-click omits the
 * theme-matched background for transparent output. SVG keeps vector geometry,
 * while PNG is rasterized to a 4x canvas.
 *
 * **Why dynamic import of mermaid.** Keeps mermaid out of the initial
 * bundle. The first open takes ~100-200ms while the chunk loads;
 * subsequent opens are instant (browser + ESM module cache).
 *
 * **Why `dangerouslySetInnerHTML` for the SVG.** Mermaid's `render()`
 * returns a self-contained `<svg>...</svg>` string. We inject it into
 * a `<div>` verbatim. The input source is the user's text, but
 * mermaid's `securityLevel: 'strict'` strips `onclick=` / `<script>` /
 * etc. from the generated SVG, and the modal runs in a body with
 * `overflow: hidden` — so the XSS surface is small.
 */

import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { errorMessage } from '../../modules/llm-client/index.ts';
import { useResolvedTheme } from '../shared/ThemeProvider.tsx';
import { cn } from '../../utils/cn.ts';
import { lcExportFileName } from '../../utils/exportNames.ts';
import { saveBlobFile } from '../../utils/saveBlob.ts';
import { useOverlayEscape } from '../../utils/overlay-stack.ts';
import { useScrollLock } from '../../utils/scroll-lock.ts';

interface Props {
  /** Mermaid source, or a complete SVG document when sourceType is `svg`. */
  source: string;
  /** Selects whether the source should be rendered by Mermaid or as raw SVG. */
  sourceType?: 'mermaid' | 'svg';
  /** Called when the user dismisses the modal (Esc, backdrop click, X). */
  onClose: () => void;
}

type Status =
  | { kind: 'loading' }
  | { kind: 'rendered'; svg: string; naturalWidth: number; naturalHeight: number }
  | { kind: 'error'; message: string };

type ColorScheme = 'dark' | 'light';

type PointerPosition = { x: number; y: number };
type Gesture =
  | {
      kind: 'pan';
      pointerId: number;
      startX: number;
      startY: number;
      startTx: number;
      startTy: number;
    }
  | {
      kind: 'pinch';
      startDistance: number;
      startCenterX: number;
      startCenterY: number;
      startScale: number;
      startTx: number;
      startTy: number;
    };

type ExportState = 'idle' | 'svg' | 'png' | 'error';

/** Mermaid is a heavy dep. Loaded once and cached at module scope. */
let mermaidModule: typeof import('mermaid') | null = null;
let mermaidInitPromise: Promise<void> | null = null;
const MERMAID_EXPORT_SCALE = 4;
/** Tracks the colour scheme used for the last `initialize()` call so
 *  we can re-init when the user switches dark ↔ light. */
let lastColorScheme: ColorScheme | null = null;

/**
 * Build the mermaid theme-variables record for a given scheme.
 * Extracted so `initializeMermaid` can pass it directly and we
 * don't duplicate the large colour tables.
 */
function buildThemeVars(isDark: boolean): Record<string, string> {
  // VS Code uses mermaid's `base` theme with curated colour
  // variables so diagrams look clean and professional in both
  // light and dark modes.  We replicate that approach here:
  // a restrained palette with soft backgrounds, clear borders,
  // and readable contrast — not the heavy default `dark` theme
  // that ships with mermaid out of the box.
  return isDark
    ? {
        background: 'transparent',
        primaryColor: '#2d3a4f',
        primaryBorderColor: '#4a6a8a',
        primaryTextColor: '#d4dde8',
        secondaryColor: '#2f3542',
        secondaryBorderColor: '#4a5060',
        secondaryTextColor: '#c0c6d0',
        tertiaryColor: '#252a34',
        tertiaryBorderColor: '#3a4050',
        tertiaryTextColor: '#a8b0bc',
        lineColor: '#5a6a7e',
        mainBkg: '#252a34',
        nodeBorder: '#4a5a6a',
        nodeTextColor: '#d0d6e0',
        edgeLabelBackground: '#252a34',
        actorBorder: '#4a5a6a',
        actorBkg: '#2a3040',
        actorTextColor: '#d0d6e0',
        actorLineColor: '#5a6a7e',
        signalColor: '#c8d0d8',
        signalTextColor: '#c8d0d8',
        labelBoxBkgColor: '#2a3040',
        labelBoxBorderColor: '#4a5a6a',
        labelTextColor: '#d0d6e0',
        loopTextColor: '#d0d6e0',
        noteBorderColor: '#5a6e50',
        noteBkgColor: '#2a3528',
        noteTextColor: '#c0d0b8',
        activationBorderColor: '#4a6a8a',
        activationBkgColor: '#1e2a3a',
        sequenceNumberColor: '#1a1e26',
        sectionBkgColor: '#252a34',
        altSectionBkgColor: '#1e222c',
        sectionBkgColor2: '#252a34',
        taskBorderColor: '#4a5a6a',
        taskBkgColor: '#2a3040',
        taskTextColor: '#d0d6e0',
        taskTextLightColor: '#a0a8b4',
        taskTextOutsideColor: '#d0d6e0',
        taskTextClickableColor: '#6ab0ff',
        activeTaskBorderColor: '#4a6a8a',
        activeTaskBkgColor: '#2d3a4f',
        gridColor: '#3a4050',
        doneTaskBorderColor: '#4a6050',
        doneTaskBkgColor: '#2a3528',
        todayLineColor: '#c06060',
        classText: '#d0d6e0',
        labelColor: '#d0d6e0',
        entityBorder: '#4a6a8a',
        pie1: '#4a6a8a',
        pie2: '#5a7a5a',
        pie3: '#8a6a4a',
        pie4: '#7a5a6a',
        pie5: '#5a6a7a',
        pie6: '#6a7a4a',
        pie7: '#4a5a7a',
        pie8: '#7a6a5a',
        pie9: '#5a4a6a',
        pie10: '#3a6a6a',
        pie11: '#6a4a4a',
        pie12: '#4a4a6a',
        errorBkgColor: '#2a1a1a',
        errorTextColor: '#e08080',
        titleColor: '#d0d6e0',
        relationColor: '#5a6a7e',
      }
    : {
        background: 'transparent',
        primaryColor: '#e8edf5',
        primaryBorderColor: '#7a9ab8',
        primaryTextColor: '#1a2a3a',
        secondaryColor: '#f0f3f8',
        secondaryBorderColor: '#8a9aaa',
        secondaryTextColor: '#2a3a4a',
        tertiaryColor: '#f5f7fa',
        tertiaryBorderColor: '#9aaaba',
        tertiaryTextColor: '#3a4a5a',
        lineColor: '#7a8a9a',
        mainBkg: '#f5f7fa',
        nodeBorder: '#8a9aaa',
        nodeTextColor: '#1a2a3a',
        edgeLabelBackground: '#f5f7fa',
        actorBorder: '#8a9aaa',
        actorBkg: '#eef1f6',
        actorTextColor: '#1a2a3a',
        actorLineColor: '#7a8a9a',
        signalColor: '#2a3a4a',
        signalTextColor: '#2a3a4a',
        labelBoxBkgColor: '#eef1f6',
        labelBoxBorderColor: '#8a9aaa',
        labelTextColor: '#1a2a3a',
        loopTextColor: '#1a2a3a',
        noteBorderColor: '#8aaa80',
        noteBkgColor: '#eaf5e8',
        noteTextColor: '#2a3a2a',
        activationBorderColor: '#7a9ab8',
        activationBkgColor: '#e0e8f2',
        sequenceNumberColor: '#e8ecf2',
        sectionBkgColor: '#f5f7fa',
        altSectionBkgColor: '#eef1f6',
        sectionBkgColor2: '#f5f7fa',
        taskBorderColor: '#8a9aaa',
        taskBkgColor: '#eef1f6',
        taskTextColor: '#1a2a3a',
        taskTextLightColor: '#5a6a7a',
        taskTextOutsideColor: '#1a2a3a',
        taskTextClickableColor: '#2a6ab0',
        activeTaskBorderColor: '#7a9ab8',
        activeTaskBkgColor: '#e8edf5',
        gridColor: '#c8cdd5',
        doneTaskBorderColor: '#8aaa80',
        doneTaskBkgColor: '#eaf5e8',
        todayLineColor: '#c06060',
        classText: '#1a2a3a',
        labelColor: '#1a2a3a',
        entityBorder: '#7a9ab8',
        pie1: '#7a9ab8',
        pie2: '#8aaa80',
        pie3: '#c0a060',
        pie4: '#b08090',
        pie5: '#8090a0',
        pie6: '#90a070',
        pie7: '#6078a0',
        pie8: '#b09070',
        pie9: '#8070a0',
        pie10: '#509090',
        pie11: '#a06060',
        pie12: '#6060a0',
        errorBkgColor: '#fae8e8',
        errorTextColor: '#a04040',
        titleColor: '#1a2a3a',
        relationColor: '#7a8a9a',
      };
}

/**
 * (Re-)initialise mermaid.  Called once on first load and again
 * whenever the app's colour scheme changes (dark ↔ light) so the
 * diagrams always match the current theme.
 */
function initializeMermaid(mod: typeof import('mermaid'), scheme: ColorScheme) {
  if (lastColorScheme === scheme) return; // already current

  const isDark = scheme === 'dark';

  mod.default.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    // Prefer SVG <text> over HTML <foreignObject> labels globally so
    // standalone SVG files and PNG rasterization remain portable.
    htmlLabels: false,
    theme: 'base',
    fontFamily: 'inherit',
    fontSize: 16,
    themeVariables: buildThemeVars(isDark),

    // ── flowchart / graph layout ──────────────────────────
    // These mirror VS Code's markdown-preview mermaid config:
    // smooth cubic-bezier connectors instead of right-angle
    // "staircase" lines, SVG <text> labels instead of
    // <foreignObject> (which renders inconsistently across
    // browsers and export targets), and generous padding so
    // nodes don't feel crammed.
    flowchart: {
      htmlLabels: false,        // SVG text — crisp, consistent across zoom levels
      curve: 'basis',           // smooth curves (not the angular default)
      padding: 20,              // breathing room around the whole diagram
      nodeSpacing: 60,          // horizontal gap between nodes
      rankSpacing: 60,          // vertical gap between ranks
      useMaxWidth: false,       // let the SVG grow to its natural size
    },

    // ── sequence diagram layout ───────────────────────────
    sequence: {
      diagramMarginX: 60,
      diagramMarginY: 15,
      actorMargin: 70,
      width: 160,
      height: 70,
      boxMargin: 12,
      boxTextMargin: 6,
      noteMargin: 12,
      messageMargin: 45,
      mirrorActors: true,
      useMaxWidth: false,
    },

    // ── custom CSS injected into every rendered SVG ──────
    // VS Code applies similar rules through its markdown
    // preview stylesheet.  These give the diagrams their
    // polished "designed" look: rounded node corners,
    // slightly heavier edge strokes, dashed cluster
    // borders, and clean label backgrounds.
    themeCSS: `
      .node rect,
      .node polygon,
      .node path:not([stroke-dasharray]),
      .cluster rect {
        rx: 6px;
        ry: 6px;
      }
      .node rect,
      .node circle,
      .node ellipse,
      .node polygon {
        stroke-width: 1.5px;
      }
      .edgePath .path {
        stroke-width: 1.5px;
      }
      .cluster rect {
        stroke-width: 1.5px;
        stroke-dasharray: 4 4;
      }
      .edgeLabel rect {
        rx: 4px;
        ry: 4px;
      }
      .edgeLabel span,
      .edgeLabel foreignObject {
        font-size: 13px;
      }
      .actor {
        stroke-width: 1.5px;
      }
      .actor-line {
        stroke-width: 1px;
        stroke-dasharray: 2 4;
      }
      .messageLine0,
      .messageLine1 {
        stroke-width: 1.5px;
      }
      .note {
        stroke-width: 1.5px;
      }
      .label {
        font-size: 14px;
      }
    `,
  });

  // Only record a successful initialization. If Mermaid rejects the
  // configuration, the next attempt must be allowed to retry.
  lastColorScheme = scheme;
}

async function getMermaid(scheme: ColorScheme): Promise<typeof import('mermaid')> {
  if (!mermaidInitPromise) {
    const loadPromise = (async () => {
      const mod = await import('mermaid');
      initializeMermaid(mod, scheme);
      mermaidModule = mod;
    })();
    mermaidInitPromise = loadPromise.catch((err) => {
      // A failed import or initialization should not permanently poison
      // the cached promise for the rest of the application session.
      mermaidInitPromise = null;
      mermaidModule = null;
      lastColorScheme = null;
      throw err;
    });
  }
  await mermaidInitPromise;
  // Re-initialise if the theme has changed since the last open.
  if (!mermaidModule) throw new Error('Mermaid failed to load');
  initializeMermaid(mermaidModule, scheme);
  return mermaidModule;
}

/** Copy text even when the WebView denies the async clipboard API. */
async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the WebView selection-based copy path.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    if (!document.execCommand('copy')) {
      throw new Error('Clipboard copy was denied');
    }
  } finally {
    textarea.remove();
  }
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

interface ExportSvg {
  text: string;
  width: number;
  height: number;
}

function positiveNumber(value: string | null | undefined): number | null {
  const parsed = value === null || value === undefined ? NaN : Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

interface ParsedSvgSource {
  svg: string;
  naturalWidth: number;
  naturalHeight: number;
}

/**
 * Remove executable or network-capable SVG features before the source is
 * injected into the viewer. SVG is markup, so rendering it with
 * dangerouslySetInnerHTML needs a small allow-by-default cleanup pass even
 * though the source normally comes from an assistant code block.
 */
function sanitizeSvg(svg: Element): void {
  const blockedTags = new Set([
    'script',
    'foreignobject',
    'iframe',
    'object',
    'embed',
    'audio',
    'video',
  ]);
  const elements = [svg, ...Array.from(svg.querySelectorAll('*'))];

  for (const element of elements) {
    if (blockedTags.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();

      if (name.startsWith('on') || name === 'srcdoc') {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === 'href' || name === 'xlink:href') {
        const isInternalReference = value.startsWith('#');
        const isSafeRasterData = /^data:image\/(?:png|gif|jpe?g|webp);/i.test(value);
        if (!isInternalReference && !isSafeRasterData) {
          element.removeAttribute(attribute.name);
        }
        continue;
      }

      if (
        name === 'style' &&
        /url\s*\(\s*(?:['"]?)(?:https?:|data:|javascript:|\/\/)/i.test(value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }

    if (element.localName.toLowerCase() === 'style' && element.textContent) {
      element.textContent = element.textContent
        .replace(/@import[^;]+;?/gi, '')
        .replace(/url\s*\(\s*(?:['"]?)(?:https?:|data:|javascript:|\/\/)[^)]+\)/gi, 'none');
    }
  }
}

function parseSvgSource(source: string): ParsedSvgSource {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (svg.tagName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) {
    throw new Error('Source is not a valid SVG document');
  }

  sanitizeSvg(svg);

  const viewBoxParts = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const hasViewBox =
    viewBoxParts.length === 4 &&
    viewBoxParts.every(Number.isFinite) &&
    viewBoxParts[2] > 0 &&
    viewBoxParts[3] > 0;
  const naturalWidth = hasViewBox
    ? viewBoxParts[2]
    : positiveNumber(svg.getAttribute('width')) ?? 800;
  const naturalHeight = hasViewBox
    ? viewBoxParts[3]
    : positiveNumber(svg.getAttribute('height')) ?? 600;

  if (!hasViewBox) {
    svg.setAttribute('viewBox', `0 0 ${naturalWidth} ${naturalHeight}`);
  }
  if (!positiveNumber(svg.getAttribute('width'))) {
    svg.setAttribute('width', String(naturalWidth));
  }
  if (!positiveNumber(svg.getAttribute('height'))) {
    svg.setAttribute('height', String(naturalHeight));
  }

  return {
    svg: new XMLSerializer().serializeToString(svg),
    naturalWidth,
    naturalHeight,
  };
}

/**
 * Make Mermaid's live SVG portable as a standalone file.
 *
 * exportScale enlarges the standalone SVG dimensions while retaining its
 * original viewBox, so the artwork stays vector-based. A null background
 * deliberately omits the synthetic background rectangle for transparent
 * SVG/PNG exports.
 */
function buildExportSvg(
  svgText: string,
  naturalWidth: number,
  naturalHeight: number,
  background: string | null,
  fontFamily: string,
  titleText = 'Mermaid diagram',
  exportScale = MERMAID_EXPORT_SCALE,
): ExportSvg {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (svg.tagName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) {
    throw new Error('The viewer returned invalid SVG');
  }

  const viewBoxParts = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const hasViewBox =
    viewBoxParts.length === 4 &&
    viewBoxParts.every(Number.isFinite) &&
    viewBoxParts[2] > 0 &&
    viewBoxParts[3] > 0;
  const width = positiveNumber(String(naturalWidth)) ??
    (hasViewBox ? viewBoxParts[2] : null) ??
    positiveNumber(svg.getAttribute('width')) ??
    800;
  const height = positiveNumber(String(naturalHeight)) ??
    (hasViewBox ? viewBoxParts[3] : null) ??
    positiveNumber(svg.getAttribute('height')) ??
    600;
  const viewBox = hasViewBox
    ? viewBoxParts
    : [0, 0, width, height];

  svg.setAttribute('xmlns', SVG_NAMESPACE);
  svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  svg.setAttribute('width', String(width * exportScale));
  svg.setAttribute('height', String(height * exportScale));
  svg.setAttribute('viewBox', viewBox.join(' '));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const existingStyle = svg.getAttribute('style') ?? '';
  svg.setAttribute(
    'style',
    `${existingStyle};font-family:${fontFamily};shape-rendering:geometricPrecision;text-rendering:geometricPrecision`,
  );
  svg.querySelectorAll('text, tspan').forEach((element) => {
    if (!element.getAttribute('font-family')) {
      element.setAttribute('font-family', fontFamily);
    }
  });

  const title = parsed.createElementNS(SVG_NAMESPACE, 'title');
  title.textContent = titleText;
  svg.insertBefore(title, svg.firstChild);

  if (background !== null) {
    const backgroundRect = parsed.createElementNS(SVG_NAMESPACE, 'rect');
    backgroundRect.setAttribute('x', String(viewBox[0]));
    backgroundRect.setAttribute('y', String(viewBox[1]));
    backgroundRect.setAttribute('width', String(viewBox[2]));
    backgroundRect.setAttribute('height', String(viewBox[3]));
    backgroundRect.setAttribute('fill', background);
    backgroundRect.setAttribute('aria-hidden', 'true');
    svg.insertBefore(backgroundRect, title.nextSibling);
  }

  return {
    text: `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}`,
    width,
    height,
  };
}

function getExportAppearance(
  stage: HTMLDivElement | null,
  scheme: ColorScheme,
): { background: string; fontFamily: string } {
  const rootStyle = getComputedStyle(document.documentElement);
  const stageStyle = stage ? getComputedStyle(stage) : null;
  const backgroundVariable = rootStyle.getPropertyValue('--bg').trim();
  const background =
    stageStyle?.backgroundColor && stageStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
      ? stageStyle.backgroundColor
      : backgroundVariable || (scheme === 'dark' ? '#1f232b' : '#ffffff');
  return {
    background,
    fontFamily: stageStyle?.fontFamily || rootStyle.fontFamily || 'sans-serif',
  };
}

/** Rasterize the normalized SVG at 4x, optionally preserving transparency. */
async function rasterizeSvgToPng(exported: ExportSvg, background: string | null): Promise<Blob> {
  const svgBlob = new Blob([exported.text], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('SVG could not be rasterized'));
      image.src = url;
    });

    const requestedScale = MERMAID_EXPORT_SCALE;
    const maxDimensionScale = Math.min(
      8192 / exported.width,
      8192 / exported.height,
    );
    const scale = Math.min(requestedScale, maxDimensionScale);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(exported.width * scale));
    canvas.height = Math.max(1, Math.ceil(exported.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    if (background !== null) {
      context.fillStyle = background;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const png = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    if (!png) throw new Error('PNG encoding failed');
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Scoped render boundary for the diagram stage.
 *
 * Without this, a render-time throw anywhere under the stage reaches the app
 * root's `ErrorBoundary` (`App.tsx`), which by design does NOT recover — it
 * replaces the whole application with a reload screen. Losing the session to a
 * failure in a diagram *preview* is the wrong trade, and `ExcalidrawViewer`
 * already made the opposite one (`ExcalidrawRenderBoundary`); this is the same
 * insurance for the other viewer.
 *
 * The render-boundary contract is honest that the path is unlikely rather than
 * merely unobserved: Mermaid renders asynchronously to an SVG *string* and it is
 * injected through `dangerouslySetInnerHTML`, with parse and render errors
 * already caught around the async call, so React never evaluates model-supplied
 * markup as elements. What is left is the DOM rejecting the injected SVG, or a
 * throw from the pan/zoom subtree. Cheap to contain, so contained.
 */
export class MermaidRenderBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mermaid-modal-error" role="alert">
          <div className="mermaid-modal-error-title">Couldn&apos;t render this diagram</div>
          <pre className="mermaid-modal-error-message">{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export function MermaidViewer({ source, sourceType = 'mermaid', onClose }: Props) {
  const theme = useResolvedTheme();
  const sourceLabel = sourceType === 'svg' ? 'SVG' : 'Mermaid';
  const sourceFileName = sourceType === 'svg' ? 'svg-diagram' : 'mermaid-diagram';
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  // The current SVG, or `null` if not yet rendered. Pulled out
  // so the `useMemo` and `useLayoutEffect` dep arrays can
  // reference a stable identifier instead of a complex ternary.
  const renderedSvg = status.kind === 'rendered' ? status.svg : null;

  // Memoize the `dangerouslySetInnerHTML` object so React's
  // `Object.is` prop comparison sees a stable reference. Without
  // this, the parent re-rendering (e.g. when zoom/pan state
  // changes) would re-set the canvas's innerHTML on every
  // render — re-parsing the SVG and causing a visible flicker.
  // See https://react.dev/reference/react-dom/components/common#dangerously-setting-the-inner-html
  const canvasInnerHtml = useMemo<{ __html: string } | undefined>(
    () => (renderedSvg === null ? undefined : { __html: renderedSvg }),
    [renderedSvg],
  );

  // Pan/zoom state, in CSS pixels of the stage container.
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  // (No more "hasUserPannedOrZoomed" flag — the recenter button
  //  is always enabled. Even if the diagram is already at
  //  fit-to-view, clicking recenter is a no-op, not a confusing
  //  disabled state. Removed 2026-06-16.)

  // Visual feedback for the "copy source" button — shows a
  // checkmark for ~1.5s after a successful copy, then reverts.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>(
    'idle',
  );
  const [exportState, setExportState] = useState<ExportState>('idle');

  // Refs that don't trigger re-renders. Used by the wheel, resize,
  // and pointer handlers for gesture math.
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, PointerPosition>());
  const gestureRef = useRef<Gesture | null>(null);
  const autoFitRef = useRef(true);
  const transformRef = useRef({ scale, tx, ty });
  const copyResetTimerRef = useRef<number | null>(null);
  const exportResetTimerRef = useRef<number | null>(null);

  // Stable mirror of `status` so callbacks can read the latest
  // value without depending on `status` and being recreated when
  // it changes. Recreation would re-fire the render effect (which
  // has `fitToView` in its deps) and re-run mermaid's expensive
  // render — causing the flicker this hook is here to prevent.
  const statusRef = useRef(status);
  useLayoutEffect(() => {
    statusRef.current = status;
  }, [status]);

  useLayoutEffect(() => {
    transformRef.current = { scale, tx, ty };
  }, [scale, tx, ty]);

  // Render the mermaid source on mount. We give mermaid a unique
  // ID per render — the library uses it as a DOM id during parsing.
  // Using a counter avoids collisions if two viewers are open at
  // once (shouldn't happen, but cheap insurance).

  /**
   * Compute scale + translate that fits the canvas into the stage.
   *
   * Stable identity (`[]` deps) — reads the latest status from
   * `statusRef`. The dep is intentionally empty so the render
   * effect below (which calls this via `useLayoutEffect`) doesn't
   * re-run the mermaid render when status changes. Re-running
   * would (a) call mermaid.render() twice with the same ID, which
   * is wasteful and can hit DOM-id collisions in mermaid's
   * internal temp-element, and (b) cause a visible flicker as
   * the canvas repaints between the two renders.
   */
  const fitToView = useCallback(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const cur = statusRef.current;
    if (cur.kind !== 'rendered') return;
    const stageRect = stage.getBoundingClientRect();
    if (stageRect.width <= 0 || stageRect.height <= 0) return;
    // Canvas's natural pixel size is the viewBox width/height —
    // mermaid renders the SVG at 1:1 with its viewBox units (we
    // don't set explicit width/height on the inner container).
    const naturalW = cur.naturalWidth || canvas.offsetWidth;
    const naturalH = cur.naturalHeight || canvas.offsetHeight;
    if (
      !Number.isFinite(naturalW) ||
      !Number.isFinite(naturalH) ||
      naturalW <= 0 ||
      naturalH <= 0
    ) {
      return;
    }
    // Fit to BOTH axes (the smaller of the two scales wins, so
    // the diagram is guaranteed to fit inside the stage on the
    // constrained axis). Earlier this used width-only fit,
    // which left tall diagrams (e.g. vertical flowcharts, deep
    // git graphs) clipped at the bottom of the stage. The
    // `min(sx, sy)` form handles wide-and-short, tall-and-narrow,
    // and everything in between correctly.
    const sidePadding = 32;
    const sx = Math.max(1, stageRect.width - sidePadding * 2) / naturalW;
    const sy = Math.max(1, stageRect.height - sidePadding * 2) / naturalH;
    const s = Math.max(0.05, Math.min(20, sx, sy));
    autoFitRef.current = true;
    setScale(s);
    // Center the (now definitely-fits) canvas in the stage.
    setTx((stageRect.width - naturalW * s) / 2);
    setTy((stageRect.height - naturalH * s) / 2);
  }, []);

  // Render the mermaid source. Runs exactly once per `source` —
  // `fitToView` is intentionally NOT in the deps (its identity
  // is stable, and including it would re-fire the effect on
  // every status change, which is the bug we just fixed).
  useEffect(() => {
    const renderId = `mmd-${Math.random().toString(36).slice(2, 10)}`;
    let cancelled = false;
    autoFitRef.current = true;
    setStatus({ kind: 'loading' });

    if (sourceType === 'svg') {
      try {
        const parsed = parseSvgSource(source);
        if (!cancelled) {
          setStatus({ kind: 'rendered', ...parsed });
        }
      } catch (err) {
        if (!cancelled) {
          setStatus({ kind: 'error', message: errorMessage(err) });
        }
      }
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const mermaid = await getMermaid(theme);
        const { svg } = await mermaid.default.render(renderId, source);
        if (cancelled) return;
        // The mermaid SVG string doesn't always include width/
        // height attributes, but the viewBox is always present.
        // We extract the viewBox dimensions for fit-to-view math;
        // the actual rendered size will be set by the SVG's
        // viewBox + the wrapping div's CSS.
        const m = svg.match(/viewBox\s*=\s*["']([^"']+)["']/i);
        let naturalWidth = 0;
        let naturalHeight = 0;
        if (m) {
          const parts = m[1].split(/[\s,]+/).map(Number);
          if (
            parts.length === 4 &&
            Number.isFinite(parts[2]) &&
            Number.isFinite(parts[3]) &&
            parts[2] > 0 &&
            parts[3] > 0
          ) {
            naturalWidth = parts[2];
            naturalHeight = parts[3];
          }
        }
        setStatus({ kind: 'rendered', svg, naturalWidth, naturalHeight });
      } catch (err) {
        if (cancelled) return;
        const message = errorMessage(err);
        setStatus({ kind: 'error', message });
      }
    })();
    return () => {
      cancelled = true;
      // Mermaid.render() creates <div id={renderId}> in the document and
      // removes it on success. On parse failure it leaks the error element
      // (the 💣 "Syntax error in text / mermaid version x.y.z" row that
      // accumulates in the chat after closing the viewer on bad code).
      // Clean it up explicitly so failed renders don't accumulate DOM cruft.
      document.getElementById(renderId)?.remove();
    };
  }, [source, sourceType, theme]);

  // Fit-to-view after the rendered SVG is in the DOM and layout
  // has settled. `useLayoutEffect` (not `useEffect`) so the fit
  // happens BEFORE the browser paints — without this, the user
  // would see one frame of the un-fitted SVG (potentially
  // overflowing or shrunken) and then a snap to fit, which is
  // exactly the "flicker" the user reported. `renderedSvg` is
  // declared at the top of the component (alongside the
  // `canvasInnerHtml` memo) so this dep array and the memo's
  // dep array reference the same identifier. In practice this
  // fires once per mount — opening a new code block creates a
  // new component instance.
  useLayoutEffect(() => {
    if (renderedSvg === null) return;
    fitToView();
  }, [renderedSvg, fitToView]);

  // Keep the automatically fitted diagram centered when the app window
  // or modal changes size. Once the user has zoomed or panned, preserve
  // that intentional transform instead of unexpectedly resetting it.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    let frame: number | null = null;
    const scheduleFit = () => {
      if (!autoFitRef.current || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (autoFitRef.current) fitToView();
      });
    };

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(scheduleFit);
      observer.observe(stage);
      return () => {
        observer.disconnect();
        if (frame !== null) window.cancelAnimationFrame(frame);
      };
    }

    window.addEventListener('resize', scheduleFit);
    return () => {
      window.removeEventListener('resize', scheduleFit);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [fitToView]);

  // Esc to close, only while this is the innermost overlay. The focus trap
  // below is a separate concern and keeps its own listener.
  useOverlayEscape(onClose);

  // Focus trap + focus restore.
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    modalRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const modal = modalRef.current;
      if (!modal) return;
      const focusable = Array.from(modal.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        e.preventDefault();
        modal.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
    };
    // Runs once per mount: the trap reads live DOM, and re-running it would
    // re-capture `previousFocus` from whatever is focused mid-session.
  }, []);

  // Lock body scroll while the modal is open. The shared counter captures the
  // page's own overflow at the first lock, so a page already scroll-locked by
  // something else is still restored correctly — and unlike the six
  // independent copies this replaces, release order does not matter.
  useScrollLock();

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      if (exportResetTimerRef.current !== null) {
        window.clearTimeout(exportResetTimerRef.current);
      }
    };
  }, []);

  /**
   * Zoom by a factor, keeping the point at `anchor` (stage-local
   * coords) fixed under the cursor. If no anchor is given, zoom
   * about the stage center.
   */
  const zoomBy = useCallback(
    (factor: number, anchor?: { x: number; y: number }) => {
      const stage = stageRef.current;
      if (!stage) return;
      autoFitRef.current = false;
      const rect = stage.getBoundingClientRect();
      const ax = anchor ? anchor.x - rect.left : rect.width / 2;
      const ay = anchor ? anchor.y - rect.top : rect.height / 2;
      setScale((s) => {
        const next = Math.max(0.05, Math.min(20, s * factor));
        // Keep the point under the anchor fixed. The canvas-local
        // point that's at (ax, ay) in stage coords is
        //   p = ((ax - tx) / s, (ay - ty) / s)
        // We want the same p at the new scale to map back to
        // (ax, ay), so:
        //   tx' = ax - p.x * s'  =  ax - (ax - tx) * (s' / s)
        //   ty' = ay - p.y * s'  =  ay - (ay - ty) * (s' / s)
        setTx((curTx) => ax - (ax - curTx) * (next / s));
        setTy((curTy) => ay - (ay - curTy) * (next / s));
        return next;
      });
    },
    [],
  );

  const onWheel = useCallback(
    (e: WheelEvent) => {
      // Ctrl/Cmd+wheel = zoom (the same gesture browser pages use
      // for zoom — feels natural). Plain wheel = pan. We
      // preventDefault in both cases so the modal doesn't scroll
      // the underlying chat or accidentally zoom the page.
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        zoomBy(factor, { x: e.clientX, y: e.clientY });
      } else {
        autoFitRef.current = false;
        setTx((cur) => cur - e.deltaX);
        setTy((cur) => cur - e.deltaY);
      }
    },
    [zoomBy],
  );

  // Attach wheel listener as non-passive so preventDefault works.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only respond to primary button or touch.
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      const points = [...pointersRef.current.values()];
      const transform = transformRef.current;
      if (points.length === 1) {
        gestureRef.current = {
          kind: 'pan',
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          startTx: transform.tx,
          startTy: transform.ty,
        };
        return;
      }

      if (points.length >= 2) {
        autoFitRef.current = false;
        const [a, b] = points;
        const stageRect = stageRef.current?.getBoundingClientRect();
        const left = stageRect?.left ?? 0;
        const top = stageRect?.top ?? 0;
        gestureRef.current = {
          kind: 'pinch',
          startDistance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
          startCenterX: (a.x + b.x) / 2 - left,
          startCenterY: (a.y + b.y) / 2 - top,
          startScale: transform.scale,
          startTx: transform.tx,
          startTy: transform.ty,
        };
      }
    },
    [],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const point = pointersRef.current.get(e.pointerId);
    if (!point) return;
    point.x = e.clientX;
    point.y = e.clientY;

    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.kind === 'pinch' && pointersRef.current.size >= 2) {
      const points = [...pointersRef.current.values()].slice(0, 2);
      const [a, b] = points;
      const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      const stageRect = stageRef.current?.getBoundingClientRect();
      const left = stageRect?.left ?? 0;
      const top = stageRect?.top ?? 0;
      const centerX = (a.x + b.x) / 2 - left;
      const centerY = (a.y + b.y) / 2 - top;
      const nextScale = Math.max(
        0.05,
        Math.min(20, gesture.startScale * (distance / gesture.startDistance)),
      );
      const ratio = nextScale / gesture.startScale;
      setScale(nextScale);
      setTx(centerX - (gesture.startCenterX - gesture.startTx) * ratio);
      setTy(centerY - (gesture.startCenterY - gesture.startTy) * ratio);
      return;
    }

    if (gesture.kind === 'pan' && gesture.pointerId === e.pointerId) {
      autoFitRef.current = false;
      setTx(gesture.startTx + (e.clientX - gesture.startX));
      setTy(gesture.startTy + (e.clientY - gesture.startY));
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    const gesture = gestureRef.current;
    if (gesture?.kind === 'pinch' && pointersRef.current.size === 1) {
      const [pointerId, point] = [...pointersRef.current.entries()][0];
      const transform = transformRef.current;
      gestureRef.current = {
        kind: 'pan',
        pointerId,
        startX: point.x,
        startY: point.y,
        startTx: transform.tx,
        startTy: transform.ty,
      };
    } else if (pointersRef.current.size === 0) {
      gestureRef.current = null;
    }

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
        // Already released — ignore.
    }
  }, []);

  /**
   * Copy the original mermaid source to the clipboard as plain
   * text. This is the source-sharing and editing path; the toolbar
   * exports normalized standalone SVG and PNG directly. Raw Mermaid SVG
   * can use `<foreignObject>`, which some standalone SVG renderers
   * (browsers, Figma, and design tools) may treat differently
   * from the normalized export. Copy the source when you want
   * to edit it in Mermaid-aware tooling or share the definition.
   *
   * Sets `copyState` for ~1.5s so the button can swap to a
   * checkmark as visual confirmation.
   */
  const copySource = useCallback(async () => {
    try {
      await copyTextToClipboard(source);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      copyResetTimerRef.current = null;
      setCopyState('idle');
    }, 1500);
  }, [source]);

  const showExportFeedback = useCallback((next: ExportState) => {
    setExportState(next);
    if (exportResetTimerRef.current !== null) {
      window.clearTimeout(exportResetTimerRef.current);
    }
    exportResetTimerRef.current = window.setTimeout(() => {
      exportResetTimerRef.current = null;
      setExportState('idle');
    }, 1800);
  }, []);

  const exportSvg = useCallback(async (transparent = false) => {
    if (status.kind !== 'rendered') return;
    try {
      const appearance = getExportAppearance(stageRef.current, theme);
      const exportBackground = transparent ? null : appearance.background;
      const exported = buildExportSvg(
        status.svg,
        status.naturalWidth,
        status.naturalHeight,
        exportBackground,
        appearance.fontFamily,
        sourceType === 'svg' ? 'SVG image' : 'Mermaid diagram',
      );
      const saved = await saveBlobFile(
        lcExportFileName(sourceFileName, 'svg'),
        new Blob([exported.text], { type: 'image/svg+xml;charset=utf-8' }),
        [{ name: 'SVG image', extensions: ['svg'] }],
      );
      showExportFeedback(saved ? 'svg' : 'error');
    } catch {
      showExportFeedback('error');
    }
  }, [showExportFeedback, sourceFileName, sourceType, status, theme]);

  const exportPng = useCallback(async (transparent = false) => {
    if (status.kind !== 'rendered') return;
    try {
      const appearance = getExportAppearance(stageRef.current, theme);
      const exportBackground = transparent ? null : appearance.background;
      const exported = buildExportSvg(
        status.svg,
        status.naturalWidth,
        status.naturalHeight,
        exportBackground,
        appearance.fontFamily,
        sourceType === 'svg' ? 'SVG image' : 'Mermaid diagram',
      );
      const png = await rasterizeSvgToPng(exported, exportBackground);
      const saved = await saveBlobFile(
        lcExportFileName(sourceFileName, 'png'),
        png,
        [{ name: 'PNG image', extensions: ['png'] }],
      );
      showExportFeedback(saved ? 'png' : 'error');
    } catch {
      showExportFeedback('error');
    }
  }, [showExportFeedback, sourceFileName, sourceType, status, theme]);

  /**
   * Export uses one normalized, theme-aware SVG with explicit 4x dimensions
   * and portable SVG text labels. PNG is rasterized from that same SVG, so
   * both formats match the viewer. Passing transparent omits the
   * theme-matched background for Shift-click exports.
   */

  return createPortal(
    <div
      className="mermaid-modal-backdrop"
      onClick={(e) => {
        // Backdrop click closes, but clicks inside the stage or
        // toolbar should not. The modal contents stopPropagation.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="mermaid-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Diagram viewer"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mermaid-modal-toolbar">
          <button
            type="button"
            className="mermaid-modal-btn"
            onClick={() => zoomBy(1.25)}
            title="Zoom in"
            aria-label="Zoom in"
          >
            {/* Lucide-style "zoom in" — circle + diagonal handle
                + plus sign. Stroked (not filled) so it scales
                cleanly at 18px and matches the rest of the
                toolbar's icon family. */}
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          <button
            type="button"
            className="mermaid-modal-btn"
            onClick={() => zoomBy(1 / 1.25)}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          <button
            type="button"
            className="mermaid-modal-btn"
            onClick={fitToView}
            title="Fit to viewer"
            aria-label="Fit to viewer"
          >
            {/* Maximize-style icon: four corner brackets pointing
                outward. Reads as "fit / fill the frame". */}
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M3 8V5a2 2 0 0 1 2-2h3" />
              <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" />
              <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
            </svg>
          </button>
          <button
            type="button"
            className={cn('mermaid-modal-btn', copyState === 'copied' && 'is-copied')}
            onClick={copySource}
            // The title changes with state to give the user
            // feedback even without watching the icon swap.
            title={
              copyState === 'copied'
                ? 'Copied!'
                : copyState === 'error'
                  ? "Couldn't copy — check clipboard permissions"
                  : `Copy ${sourceLabel} source`
            }
            aria-label={
              copyState === 'copied'
                ? 'Source copied to clipboard'
                : `Copy ${sourceLabel} source to clipboard`
            }
          >
            {copyState === 'copied' ? (
              // Brief checkmark feedback after a successful copy.
              // Reverts to the copy icon after ~1.5s.
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              // "Copy" / "duplicate" icon: two overlapping
              // rounded squares. Standard convention for
              // "copy to clipboard" actions.
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className={cn(
              'mermaid-modal-btn',
              exportState === 'svg' && 'is-exported',
              exportState === 'error' && 'is-export-error',
            )}
            onClick={(event) => {
              setExportState('svg');
              void exportSvg(event.shiftKey);
            }}
            disabled={status.kind !== 'rendered' || exportState === 'svg' || exportState === 'png'}
            title={
              exportState === 'error'
                ? 'Export failed'
                : exportState === 'svg'
                  ? 'SVG saved'
                  : 'Download SVG (4x; Shift+click for transparent)'
            }
            aria-label="Download diagram as SVG"
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M12 3v12" />
              <path d="m7 10 5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
          </button>
          <button
            type="button"
            className={cn(
              'mermaid-modal-btn',
              exportState === 'png' && 'is-exported',
              exportState === 'error' && 'is-export-error',
            )}
            onClick={(event) => {
              setExportState('png');
              void exportPng(event.shiftKey);
            }}
            disabled={status.kind !== 'rendered' || exportState === 'png'}
            title={
              exportState === 'error'
                ? 'Export failed'
                : exportState === 'png'
                  ? 'Preparing PNG…'
                  : 'Download PNG (4x; Shift+click for transparent)'
            }
            aria-label="Download diagram as PNG"
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="8.5" cy="9" r="1.5" />
              <path d="m3 16 5-5 4 4 3-3 6 6" />
            </svg>
          </button>
          <div className="mermaid-modal-toolbar-spacer" />
          <button
            type="button"
            className="mermaid-modal-btn"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div
          ref={stageRef}
          className="mermaid-modal-stage"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {status.kind === 'loading' && (
            <div className="mermaid-modal-status">Rendering diagram…</div>
          )}
          {status.kind === 'error' && (
            <div className="mermaid-modal-error" role="alert">
              <div className="mermaid-modal-error-title">
                Couldn't parse {sourceLabel} source
              </div>
              <pre className="mermaid-modal-error-source">{source}</pre>
              <pre className="mermaid-modal-error-message">{status.message}</pre>
            </div>
          )}
          {status.kind === 'rendered' && (
            <MermaidRenderBoundary>
              <div
                ref={canvasRef}
                className="mermaid-modal-canvas"
                style={{
                  transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                  transformOrigin: '0 0',
                  width: status.naturalWidth || undefined,
                  height: status.naturalHeight || undefined,
                }}
                // Memoize the object so React's prop comparison
                // (`Object.is`) doesn't see a "new" value on every
                // re-render of the parent. Without this, every
                // state change (zoom, pan, etc.) would re-set the
                // canvas's `innerHTML` and re-parse the SVG —
                // visible flicker.
                dangerouslySetInnerHTML={canvasInnerHtml}
              />
            </MermaidRenderBoundary>
          )}
        </div>
      </div>
    </div>,
    // Render into `document.body` so the modal escapes the
    // chat bubble's CSS containing block. `.bubble-user` and
    // `.bubble-assistant` both have `backdrop-filter: blur(10px)`
    // for the glassmorphic look, and per the CSS spec that
    // makes `position: fixed` resolve against the bubble
    // instead of the viewport — which is why the modal was
    // trapped at bubble-size when the user clicked the eye
    // button on a mermaid code block inside a chat message.
    // Portaling to `document.body` puts the modal in the
    // top-level stacking context so it covers the whole
    // window. (The same trick is used by ReasoningOverlay
    // and TextPreview, which are rendered at the App level
    // and don't have this issue.)
    document.body,
  );
}
