/**
 * Markdown renderer wrapper. Centralised so the highlighting implementation
 * can evolve without touching every consumer.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import type { PhrasingContent, Root as MdastRoot } from 'mdast';
import type { Root as HastRoot } from 'hast';
import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypePrism from 'rehype-prism-plus';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { visit } from 'unist-util-visit';
import { refractor } from 'refractor';
import 'katex/dist/katex.min.css';
import './markdown-theme.css';
import { cn } from './cn.ts';
import { escapeNonMathDollars } from './escapeNonMathDollars.ts';
import {
  isPassiveMarkdownImageSource,
  remarkLiteralUnknownHtml,
} from './remarkLiteralUnknownHtml.ts';
import { useRafCommittedValue } from './raf-committed-value.ts';
import { MermaidViewer } from '../ui/preview/MermaidViewer.tsx';
import { ExcalidrawViewer } from '../ui/preview/ExcalidrawViewer.tsx';

interface Props {
  children: string;
  /** Add a synchronized line-number gutter to rendered code blocks. */
  lineNumbers?: boolean;
  /** Runs after the debounced Markdown value has committed to the DOM. */
  onCommitted?: (markdown: string) => void;
}

const LineNumbersContext = createContext(false);

/**
 * Catch-all for non-standard HTML tags that the model may emit
 * (e.g. <color>, <item> from Android resource snippets).  Renders
 * children inline without a wrapper element, suppressing React's
 * "unrecognized tag" console warning.
 */
function Passthrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

/**
 * Model Markdown must not start network requests as a render side effect.
 * Inline image bytes and existing local blob URLs are passive. All other
 * sources become guarded links that require the normal user confirmation.
 */
function PassiveImage({ src, alt, title }: ComponentProps<'img'>) {
  if (isPassiveMarkdownImageSource(src)) {
    return <img src={src} alt={alt ?? ''} title={title} loading="lazy" />;
  }
  const label = alt?.trim() || 'image';
  if (!src) return <span>[Image: {label}]</span>;
  return (
    <span>
      [Image: {label}. <Link href={src}>Open source</Link>]
    </span>
  );
}

/** Window event name fired when a user clicks a link in any markdown
 *  surface. The app-level listener (in App.tsx) decides what to do —
 *  currently: open the Quick Preview overlay. The event-bus pattern
 *  matches the existing `lc:new-chat` / `lc:open-settings` /
 *  `lc:focus-composer` events (see src/utils/shortcuts.ts) and keeps
 *  the markdown renderer decoupled from whichever screen happens to
 *  be hosting the chat. */
export const LINK_CLICK_EVENT = 'lc:link-click';

/** Fired when a user clicks a filename in a markdown bubble.
 *  `detail` is `{ filename: string, prePath?: string }`.
 *  `prePath` is the closest preceding path found in the same bubble's
 *  text — used to resolve the filename contextually rather than
 *  scanning all granted roots. */
export const FILE_CLICK_EVENT = 'lc:file-click';

/** Common file extensions that indicate something is a filename
 *  worth making clickable. Covers source, config, doc, image,
 *  and script extensions. */
/** Extensions accepted by the file-picker / attachment uploader.
 *  The clickable-filename feature is extension-agnostic (see
 *  `looksLikeFilename`).  This set is only used by Composer.tsx
 *  and attachment-related utilities. */
export const FILE_EXTENSIONS = new Set([
  'md', 'py', 'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html', 'htm',
  'rs', 'go', 'java', 'cpp', 'c', 'h', 'hpp', 'cs', 'swift', 'php',
  'rb', 'kt', 'scala', 'lua', 'r', 'm', 'mm', 'mjs', 'cjs',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp',
  'pdf', 'txt', 'log', 'csv', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'sh', 'bat', 'cmd', 'ps1', 'bash', 'zsh',
  'vue', 'svelte', 'astro',
  '7z', 'zip', 'tar', 'gz', 'bz2', 'xz', 'rar', 'zst',
]);

function looksLikeFilename(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 120) return false;

  // Must have a dot with something on both sides.
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return false;

  const ext = trimmed.slice(dot + 1).toLowerCase();
  // Extension must be 2-10 alphanumeric chars with at least one letter
  // (rejects purely-numeric "extensions" like ".0", ".1", ".12").
  if (!/^(?=.*[a-z])[a-z0-9]{2,10}$/.test(ext)) return false;

  const name = trimmed.slice(0, dot);
  if (!name || name.length < 1) return false;

  // Purely-numeric "extensions" like ".0" or ".12" are already
  // rejected by the extension regex above (must be 2-10 chars with
  // at least one letter).  Numeric NAMES (e.g. "125564650.jpg")
  // are valid — camera photos, generated files, etc.
  return true;
}

/**
 * Compiled once — matches plain-text filename patterns so the remark
 * plugin below can detect filenames that the model wrote *without*
 * backticks.  Extension-agnostic: accepts any 2-10 letter extension,
 * rejects purely-numeric "names" (so "version 2.0" doesn't match).
 */
const FILENAME_RE = /\b[\w.-]{1,120}\.(?=[a-z0-9]*[a-z])[a-z0-9]{2,10}\b/gi;

/**
 * Remark plugin — visits every text node in the markdown AST and
 * replaces plain-text filename mentions with inlineCode nodes so
 * they get the same clickable treatment as backtick-wrapped ones.
 * Inline-code and code-block contents are distinct AST node types, so this
 * text-node visitor only sees prose.
 */
function remarkFilenames() {
  return (tree: MdastRoot) => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent) return;
      const value: string = node.value;
      FILENAME_RE.lastIndex = 0;
      const parts: Array<{ type: 'text' | 'inlineCode'; value: string }> = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = FILENAME_RE.exec(value)) !== null) {
        if (m.index > last) {
          parts.push({ type: 'text', value: value.slice(last, m.index) });
        }
        parts.push({ type: 'inlineCode', value: m[0] });
        last = FILENAME_RE.lastIndex;
      }
      if (parts.length === 0 || index === undefined) return;
      // Append trailing text.
      if (last < value.length) {
        parts.push({ type: 'text', value: value.slice(last) });
      }
      // Replace the single text node with the split parts.
      const newNodes: PhrasingContent[] = parts.map((p) =>
        p.type === 'inlineCode'
          ? { type: 'inlineCode', value: p.value }
          : { type: 'text', value: p.value },
      );
      parent.children.splice(index, 1, ...newNodes);
      // Return the new index so visit skips the nodes we just inserted.
      return index + newNodes.length;
    });
  };
}

/**
 * Scan backwards from `filename`'s position in `fullText` to find
 * the closest preceding path-like token.  Returns the raw token
 * (may include surrounding backticks / quotes — the caller in
 * App.tsx will clean it).  Returns null when no path is found
 * within a reasonable lookback window.
 *
 * Matches three path shapes:
 *   1. Windows absolute  — C:\foo\bar
 *   2. Unix absolute     — /home/foo
 *   3. Relative multi-segment — foo/bar, ./baz
 *
 * The lookback window is 2000 characters before the filename.
 */
function extractPrecedingPath(fullText: string, filename: string): string | null {
  const idx = fullText.indexOf(filename);
  if (idx <= 0) return null;
  const lookback = fullText.slice(Math.max(0, idx - 2000), idx);
  // Exclude common delimiters so we don't capture trailing
  // punctuation (colons, commas, parentheses, brackets, etc.)
  // that appear right after a path in prose like
  // "…inside C:\temp\what: Markdown files…".
  const re = /(?:[A-Za-z]:[\\/][^\s<>"|?*\r\n`:,;)\]>]+|\/[^\s<>"|?*\r\n`:,;)\]>]+|(?:\.{0,2}[\\/])?[\w.-]+(?:[\\/][\w.-]+)+)/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(lookback)) !== null) {
    last = m[0];
  }
  return last;
}

/**
 * Custom inline <code> renderer. If the code content looks like a
 * filename (has a known extension like .md, .py, .png etc.), render
 * it as a clickable element. Click fires `lms:file-click` — the
 * app shows a confirm dialog with "Show in Explorer" + "Preview".
 *
 * On click we walk up to the parent `.bubble-body` and scan its
 * text content for the closest preceding path so the resolver can
 * try it first instead of blindly scanning granted roots.
 */
function InlineCode({ children }: { children?: ReactNode }) {
  const text = extractText(children);
  if (!looksLikeFilename(text)) {
    return <code>{children}</code>;
  }
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    // Walk up to the bubble body to get the rendered text.
    const bubble = (e.currentTarget as HTMLElement).closest('.bubble-body');
    const bubbleText = bubble?.textContent ?? '';
    const prePath = extractPrecedingPath(bubbleText, text);
    window.dispatchEvent(
      new CustomEvent(FILE_CLICK_EVENT, {
        detail: { filename: text, prePath: prePath || undefined },
      }),
    );
  };
  return (
    <code
      className="md-filename"
      onClick={handleClick}
      title="Click to reveal or preview this file"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') handleClick(e as unknown as React.MouseEvent);
      }}
    >
      {children}
    </code>
  );
}


/**
 * Sanitize code-block language identifiers before they reach
 * rehype-prism-plus.  Models sometimes output truncated or
 * hallucinated language names (e.g. `k` instead of `kotlin`,
 * `math` for a LaTeX block) that cause refractor to throw.
 *
 * We query refractor's live language registry so any language
 * that hasn't been registered gets blanked — no need to maintain
 * a blocklist.  The registry check is an O(1) Set lookup.
 */
/**
 * Languages that are NOT Prism grammars but MUST pass through the
 * sanitizer so downstream code (e.g. CodeBlock's "render diagram"
 * buttons) can detect them.  Mermaid is a registered Prism grammar
 * so it already passes, but Excalidraw is not — without this
 * whitelist the sanitizer blanks the lang tag and the render
 * button never appears.
 */
const PASSTHROUGH_LANGS = new Set(['excalidraw']);

function isKnownLang(lang: string): boolean {
  if (PASSTHROUGH_LANGS.has(lang)) return true;
  // Single-char "languages" are almost always noise (e.g. `c`, `k`).
  // We also reject names that don't look like language identifiers
  // to defend against path fragments / random tokens.
  if (lang.length === 1) return false;
  if (!/^[a-zA-Z][\w.#+-]{1,19}$/.test(lang)) return false;
  return refractor.registered(lang);
}

function remarkSanitizeLang() {
  return (tree: MdastRoot) => {
    visit(tree, 'code', (node) => {
      const lang = node.lang;
      if (!lang) return;
      if (!isKnownLang(lang)) {
        node.lang = '';
      }
    });
  };
}

function rehypeSanitizeLang() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'code') return;
      const cls: string[] = Array.isArray(node.properties?.className) ? node.properties.className : [];
      const filtered = cls.filter((c: string) => {
        if (typeof c !== 'string') return true;
        const lang = c.replace(/^language-/, '');
        return isKnownLang(lang);
      });
      if (filtered.length !== cls.length) {
        node.properties = { ...node.properties, className: filtered };
      }
    });
  };
}

// ── Shared plugin configuration ──────────────────────────────────
// Exported so ChunkedMarkdown can reuse the same markdown pipeline
// without the rAF debounce or the outer .md wrapper div.

export const MARKDOWN_REMARK_PLUGINS = [
  remarkGfm,
  remarkMath,
  remarkSanitizeLang,
  remarkLiteralUnknownHtml,
  remarkFilenames,
];

export const MARKDOWN_REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  // KaTeX must run BEFORE rehypeSanitizeLang and rehypePrism.
  // remark-math emits `<code class="math-inline">` /
  // `<code class="math-display">` elements.  Both rehypeSanitizeLang
  // (which strips unknown language-* classes) and rehypePrism
  // (which syntax-highlights every <code>) will destroy the math
  // content before KaTeX can render it.  By placing rehypeKatex
  // first, it consumes and replaces the math code elements with
  // rendered KaTeX spans, and the remaining plugins only see
  // non-math code blocks.
  [rehypeKatex, { output: 'htmlAndMathml', throwOnError: false }],
  rehypeSanitizeLang,
  // ignoreMissing: true — skip unknown languages (e.g. `excalidraw`,
  // `mermaid`) instead of throwing.  The `remarkSanitizeLang` plugin
  // already strips unknown Prism languages, but diagram-type lang
  // tags like `excalidraw` must survive through so CodeBlock can
  // detect them and show the "render diagram" button.
  [rehypePrism, { ignoreMissing: true }],
];

export const MARKDOWN_COMPONENTS: Components = {
  pre: CodeBlock,
  code: InlineCode,
  img: PassiveImage,
  a: ({ href, children: linkChildren, ...rest }: ComponentProps<'a'>) => (
    <Link href={href} {...rest}>
      {linkChildren}
    </Link>
  ),
  // The model sometimes outputs non-standard HTML tags
  // (e.g. <color>, <item> from XML/Android resource
  // snippets).  Without an entry here, React warns
  // "The tag <color> is unrecognized in this browser".
  // We render them as harmless <span> so the text
  // content survives without console noise.
  // Cast via Partial<> — react-markdown v10's Components
  // type only allows standard HTML tag names.
  ...({
    color: Passthrough,
    item: Passthrough,
    src: Passthrough,
    dest: Passthrough,
  } as Partial<Record<string, React.ComponentType<unknown>>>),
};

export { escapeNonMathDollars };

export function Markdown({ children, lineNumbers = false, onCommitted }: Props) {
  // When the message is being streamed, react-markdown re-parses the whole
  // string on every keystroke. We debounce with rAF to keep input snappy.
  const debounced = useRafCommittedValue(children, onCommitted);

  return (
    <LineNumbersContext.Provider value={lineNumbers}>
      <div className="md">
        <ReactMarkdown
          remarkPlugins={MARKDOWN_REMARK_PLUGINS}
          rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
          components={MARKDOWN_COMPONENTS}
        >
          {escapeNonMathDollars(debounced)}
        </ReactMarkdown>
      </div>
    </LineNumbersContext.Provider>
  );
}

/**
 * Custom <a> renderer. The default react-markdown link just renders
 * a plain <a href="...">; on click the browser navigates. We
 * intercept to require explicit user confirmation before opening
 * external links — helpful for two reasons:
 *
 *   - Safety: a model-emitted URL like `https://malicious.example/`
 *     won't pop a new tab the moment the user clicks. They see
 *     the URL in a card and decide.
 *   - Tauri consistency: in the Tauri build the click can't
 *     directly trigger an OS handoff (that needs a Rust command);
 *     routing through a confirmation card makes the Tauri/web
 *     click model the same.
 *
 * Behavior:
 *   - Plain click  → fire `lms:link-click`. App.tsx renders the
 *                    confirmation overlay. The URL is NOT opened
 *                    yet — the user must click Continue on the
 *                    card.
 *   - Ctrl/Cmd/    → let the browser handle natively (the
 *     middle-click   browser's standard "open in new tab" — and
 *                    the link's `target="_blank"` ensures the
 *                    new tab gets `noopener noreferrer`).
 *                    Ctrl-click bypasses the confirmation on
 *                    purpose; it's a power-user "I know what
 *                    I'm doing" gesture.
 *   - Anchor /     → fall through to the browser's default
 *     mailto:        behavior. We only handle http/https.
 */
function Link({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    // Honor the browser's standard "open in new tab/window"
    // modifier keys. Meta = Cmd on macOS, Ctrl elsewhere; the
    // browser handles the rest. Shift+click is treated as a
    // normal click here (no "new window" semantic on the web;
    // on macOS that's Cmd+click anyway).
    if (e.metaKey || e.ctrlKey || e.button === 1 /* middle click */) {
      return;
    }
    // External (http/https) links only. Anchor (#fragment) and
    // mailto: links fall through to the browser's default
    // navigation behavior.
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    e.stopPropagation();
    // Fire the confirmation overlay. App.tsx listens for this
    // and renders the card. The URL is NOT opened here —
    // opening happens when the user clicks Continue (in the
    // Tauri path the open goes through `tauri-plugin-opener`,
    // which is a Rust call; in the web path it's `window.open`,
    // which the browser would block if invoked from outside a
    // user gesture — so we let the click on the Continue
    // button carry the gesture instead).
    window.dispatchEvent(
      new CustomEvent<{ url: string }>(LINK_CLICK_EVENT, { detail: { url: href } }),
    );
  };
  return (
    <a
      href={href}
      onClick={handleClick}
      // target="_blank" + rel are set as defaults so a Ctrl+click
      // (which we *don't* intercept) still opens a safe new tab.
      // React-markdown doesn't add these by default.
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}

/**
 * Custom <pre> renderer that wraps the code in a container with a copy button.
 * `children` is the <code> element produced by rehype-prism-plus/refractor.
 *
 * If the code block's info string is `mermaid` or `svg` (className includes
 * `language-mermaid` or `language-svg`), we also render a small "Render diagram" eye
 * button next to the copy button. Clicking it opens a full-viewport
 * MermaidViewer modal — see `src/ui/preview/MermaidViewer.tsx`. The
 * modal is rendered inline (it's `position: fixed` and covers the
 * whole viewport, so it doesn't need a portal).
 */
function RenderEyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 8.25c-2.0711 0-3.75 1.6789-3.75 3.75s1.6789 3.75 3.75 3.75 3.75-1.6789 3.75-3.75S14.0711 8.25 12 8.25ZM9.75 12c0-1.2426 1.0074-2.25 2.25-2.25s2.25 1.0074 2.25 2.25-1.0074 2.25-2.25 2.25S9.75 13.2426 9.75 12Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 3.25c-4.5141 0-7.5547 2.7042-9.3194 4.9969l-.0318.0413c-.3991.5183-.7667.9957-1.0161 1.5602-.267.6045-.3827 1.2633-.3827 2.1516 0 .8883.1156 1.5471.3827 2.1516.2494.5645.617 1.0419 1.0161 1.5602l.0318.0413c1.7647 2.2927 4.8053 4.9969 9.3194 4.9969s7.5547-2.7042 9.3194-4.9969l.0318-.0413c.3991-.5183.7667-.9957 1.0161-1.5602.267-.6045.3827-1.2633.3827-2.1516 0-.8883-.1156-1.5471-.3827-2.1516-.2494-.5645-.617-1.0419-1.0161-1.5602l-.0318-.0413C19.5547 5.9542 16.5141 3.25 12 3.25Zm-8.1308 5.9118C5.4986 7.0449 8.1504 4.75 12 4.75s6.5014 2.2949 8.1308 4.4118c.4386.5698.6955.9103.8644 1.2927.158.3575.2548.7944.2548 1.5455s-.0968 1.188-.2548 1.5455c-.1689.3824-.4258.7229-.8644 1.2927C18.5014 16.9551 15.8496 19.25 12 19.25s-6.5014-2.2949-8.1308-4.4118c-.4386-.5698-.6955-.9103-.8644-1.2927-.158-.3575-.2548-.7944-.2548-1.5455s-.0968-1.188-.2548-1.5455c-.1689-.3824-.4258-.7229-.8644-1.2927C5.4986 7.0449 8.1504 4.75 12 4.75Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [resizedHeight, setResizedHeight] = useState<number | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [svgViewerOpen, setSvgViewerOpen] = useState(false);
  const [excalidrawViewerOpen, setExcalidrawViewerOpen] = useState(false);
  const codeBlockRef = useRef<HTMLDivElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const resizeStartRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const showLineNumbers = useContext(LineNumbersContext);
  const copyTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
  }, []);

  // Extract the raw text from the nested <code> element.
  const codeText = extractText(children);
  // Mermaid / SVG / Excalidraw detection: rehype-prism-plus assigns the
  // info string as a `language-xxx` class on the <code> element.
  const className = extractClassName(children);
  const isMermaid = /\blanguage-mermaid\b/.test(className);
  const isSvg = /\blanguage-svg\b/.test(className);
  // Excalidraw detection: either an explicit `excalidraw` code fence,
  // or a `json` block whose content looks like an Excalidraw scene.
  const isExcalidraw =
    /\blanguage-excalidraw\b/.test(className) ||
    (/\blanguage-json\b/.test(className) && /"type"\s*:\s*"excalidraw"/.test(codeText));

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: select the text in THIS code block (scoped via ref — a global
      // query would grab the first code block in the document, not this one).
      const el = preRef.current;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };

  const codePre = <pre ref={preRef}>{children}</pre>;
  const codeContent = showLineNumbers ? (
    <div className="code-block-content">
      <div className="code-line-numbers" aria-hidden="true">
        {Array.from({ length: Math.max(1, codeText.split('\n').length) }, (_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </div>
      {codePre}
    </div>
  ) : codePre;

  const clampHeight = (height: number) => Math.min(500, Math.max(46, height));
  const getCurrentHeight = () => codeBlockRef.current?.getBoundingClientRect().height ?? 46;
  const handleResizeStart = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStartRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: getCurrentHeight(),
    };
    setResizedHeight(getCurrentHeight());
  };
  const handleResizeMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const resizeStart = resizeStartRef.current;
    if (!resizeStart || resizeStart.pointerId !== event.pointerId) return;
    setResizedHeight(clampHeight(resizeStart.startHeight + event.clientY - resizeStart.startY));
  };
  const handleResizeEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (resizeStartRef.current?.pointerId !== event.pointerId) return;
    resizeStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const currentHeight = getCurrentHeight();
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setResizedHeight(clampHeight(currentHeight + (event.key === 'ArrowDown' ? 24 : -24)));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setResizedHeight(event.key === 'Home' ? 46 : 500);
    }
  };

  return (
    <div ref={codeBlockRef} className="code-block" style={resizedHeight == null ? undefined : { height: resizedHeight }}>
      <button
        type="button"
        className={cn('code-copy-btn', copied && 'copied')}
        onClick={onCopy}
        title={copied ? 'Copied!' : 'Copy code'}
        aria-label={copied ? 'Copied!' : 'Copy code'}
      >
        {copied ? (
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
            <path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
            <path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z" />
          </svg>
        )}
      </button>
      {isMermaid && (
        <button
          type="button"
          className="code-render-btn"
          onClick={() => setViewerOpen(true)}
          title="Render Mermaid diagram"
          aria-label="Render Mermaid diagram"
        >
          <RenderEyeIcon />
        </button>
      )}
      {isSvg && (
        <button
          type="button"
          className="code-render-btn"
          onClick={() => setSvgViewerOpen(true)}
          title="Render SVG"
          aria-label="Render SVG"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M12 8.25c-2.0711 0-3.75 1.6789-3.75 3.75s1.6789 3.75 3.75 3.75 3.75-1.6789 3.75-3.75S14.0711 8.25 12 8.25ZM9.75 12c0-1.2426 1.0074-2.25 2.25-2.25s2.25 1.0074 2.25 2.25-1.0074 2.25-2.25 2.25S9.75 13.2426 9.75 12Z"
              fill="currentColor"
            />
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M12 3.25c-4.5141 0-7.5547 2.7042-9.3194 4.9969l-.0318.0413c-.3991.5183-.7667.9957-1.0161 1.5602-.267.6045-.3827 1.2633-.3827 2.1516 0 .8883.1156 1.5471.3827 2.1516.2494.5645.617 1.0419 1.0161 1.5602l.0318.0413c1.7647 2.2927 4.8053 4.9969 9.3194 4.9969s7.5547-2.7042 9.3194-4.9969l.0318-.0413c.3991-.5183.7667-.9957 1.0161-1.5602.267-.6045.3827-1.2633.3827-2.1516 0-.8883-.1156-1.5471-.3827-2.1516-.1689-.3824-.4258-.7229-.8644-1.2927C19.5547 5.9542 16.5141 3.25 12 3.25Zm-8.1308 5.9118C5.4986 7.0449 8.1504 4.75 12 4.75s6.5014 2.2949 8.1308 4.4118c.4386.5698.6955.9103.8644 1.2927.158.3575.2548.7944.2548 1.5455s-.0968 1.188-.2548 1.5455c-.1689.3824-.4255.7229-.8644 1.2927C18.5014 16.9551 15.8496 19.25 12 19.25s-6.5014-2.2949-8.1308-4.4118c-.4386-.5698-.6955-.9103-.8644-1.2927-.158-.3575-.2548-.7944-.2548-1.5455s.0968-1.188.2548-1.5455c.1689-.3824-.4255-.7229-.8644-1.2927C5.4986 7.0449 8.1504 4.75 12 4.75Z"
              fill="currentColor"
            />
          </svg>
        </button>
      )}
      {isExcalidraw && (
        <button
          type="button"
          className="code-render-btn"
          onClick={() => setExcalidrawViewerOpen(true)}
          title="Render Excalidraw diagram"
          aria-label="Render Excalidraw diagram"
        >
          {/* Pencil / draw icon — conveys "drawing / whiteboard" */}
          <RenderEyeIcon />
        </button>
      )}
      <div className="code-block-scroll">{codeContent}</div>
      <button
        type="button"
        className="code-block-resize"
        aria-label="Resize code block"
        title="Drag to resize. Use arrow keys to adjust. Double-click to reset."
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        onKeyDown={handleResizeKeyDown}
        onDoubleClick={() => setResizedHeight(null)}
      />
      {isMermaid && viewerOpen && (
        <MermaidViewer source={codeText} onClose={() => setViewerOpen(false)} />
      )}
      {isSvg && svgViewerOpen && (
        <MermaidViewer
          source={codeText}
          sourceType="svg"
          onClose={() => setSvgViewerOpen(false)}
        />
      )}
      {isExcalidraw && excalidrawViewerOpen && (
        <ExcalidrawViewer source={codeText} onClose={() => setExcalidrawViewerOpen(false)} />
      )}
    </div>
  );
}

/**
 * Read `props` off a React element node, typed as the slice we actually
 * use. `ReactNode` is a discriminated union and only a few variants
 * (ReactElement, fragments) carry `props` — we narrow with the `'props' in
 * node` check and treat the result as `unknown`-shaped until we
 * explicitly pluck the fields we want. This is the safe alternative to
 * `as any`.
 */
type ElementProps = { children?: ReactNode; className?: unknown };
function getElementProps(node: ReactNode): ElementProps | null {
  if (node == null || typeof node !== 'object' || !('props' in node)) return null;
  const props = (node as { props?: unknown }).props;
  if (props == null || typeof props !== 'object') return null;
  return props as ElementProps;
}

function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  const props = getElementProps(node);
  return props ? extractText(props.children) : '';
}

/** Pull the `className` off a React element node (if any). */
function extractClassName(node: ReactNode): string {
  if (node == null || typeof node !== 'object') return '';
  if (Array.isArray(node)) {
    for (const child of node) {
      const c = extractClassName(child);
      if (c) return c;
    }
    return '';
  }
  const props = getElementProps(node);
  return typeof props?.className === 'string' ? props.className : '';
}
