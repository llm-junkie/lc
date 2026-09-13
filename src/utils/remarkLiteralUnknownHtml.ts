import type { Root as MdastRoot } from 'mdast';
import { visit } from 'unist-util-visit';

/**
 * Passive formatting tags that raw model Markdown can retain. Browser-active
 * tags are escaped before `rehype-raw` sees them. Attributes are removed from
 * every retained raw tag; Markdown links use the guarded link component.
 */
const PASSIVE_RAW_HTML_TAGS = new Set([
  'a', 'abbr', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br',
  'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'i', 'ins', 'kbd', 'li', 'main',
  'mark', 'nav', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr',
]);

/** These model-emitted XML-ish tags intentionally render through custom
 * components in markdown.tsx. */
const SUPPORTED_CUSTOM_TAGS = new Set(['color', 'item', 'src', 'dest']);

const RAW_TAG = /<\/?\s*([A-Za-z][\w-]*)(?:\s[^<>]*?)?\/?>/g;

function isRenderableTag(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    PASSIVE_RAW_HTML_TAGS.has(normalized) ||
    SUPPORTED_CUSTOM_TAGS.has(normalized)
  );
}

function escapeLiteralTag(tag: string): string {
  return tag
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function passiveTag(tag: string, name: string): string {
  const normalized = name.toLowerCase();
  if (!isRenderableTag(normalized)) return escapeLiteralTag(tag);
  if (/^<\s*\//.test(tag)) return `</${normalized}>`;
  return `<${normalized}>`;
}

/** Return true only when rendering the image cannot start a network request. */
export function isPassiveMarkdownImageSource(src: string | undefined): boolean {
  if (!src) return false;
  const value = src.trim();
  return (
    /^blob:/i.test(value) ||
    /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value)
  );
}

/**
 * Treat unknown angle-bracket placeholders such as `<reviewer>`, `<files>`,
 * and `<yyyyMMddhhmm>` as literal prose instead of custom DOM elements.
 *
 * This runs on the mdast, where fenced and inline code have already become
 * `code` / `inlineCode` nodes. Only real raw-HTML nodes are touched, so code
 * samples remain byte-for-byte unchanged.
 */
export function remarkLiteralUnknownHtml() {
  return (tree: MdastRoot) => {
    visit(tree, 'html', (node) => {
      // A raw-HTML mdast node can contain more than one tag. Escape each
      // unknown tag independently so a valid wrapper such as `<div>` does not
      // smuggle nested model placeholders into React as custom elements.
      node.value = node.value.replace(RAW_TAG, passiveTag);
    });
  };
}
