/**
 * Cross-platform file picker.
 *
 * Wraps the two ways the app can ask the user to pick files for
 * attachment:
 *
 *   - Tauri (desktop): use `tauri-plugin-dialog`'s `open()` with a
 *     proper `filters` array. The native dialog renders a filter
 *     dropdown that's correctly understood by every webview Tauri
 *     uses — WebView2 (Windows), WebKit (macOS), and WebKitGTK
 *     (Linux). Previously, a single `<input type="file">` with a
 *     long `accept="…"` attribute was used, but on Linux the GTK
 *     file dialog only honored the `image/*` part and silently
 *     filtered out every other supported type. The native dialog
 *     plugin's filters API maps to the platform's native filter
 *     dropdown, so the same dialog code shows all supported types
 *     on every platform.
 *
 *   - Web (fallback): synthesizes a one-shot `<input type="file">`
 *     with the same canonical `accept` attribute, appends it to
 *     the DOM, clicks it, and resolves with the picked `File`s
 *     once the user confirms or cancels. The synthesized element
 *     is removed in a `finally` so the DOM doesn't accumulate
 *     hidden inputs.
 *
 *   In both cases, this function returns `Promise<File[]>` — a
 *   possibly-empty array (empty = user cancelled). Caller should
 *   always treat "empty" as a soft no-op (the pickers dismiss
 *   silently, no toast).
 *
 *   The path can also be `null` even on non-cancel, e.g. Tauri
 *   dialog plugin returns `null` on close. We normalize that to
 *   an empty array.
 */

import { invoke } from '@tauri-apps/api/core';
import { open as tauriOpen } from '@tauri-apps/plugin-dialog';
import { ALLOWED_EXTENSIONS } from './attachments.ts';
import { isTauri } from './saveBlob.ts';

interface TauriDroppedFile {
  name: string;
  mime: string;
  size: number;
  /** Bytes as a JSON-serialised `Vec<u8>` (each element 0–255). */
  bytes: number[];
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

/** Logical groups used for the native dialog filter dropdown.
 *
 *  We previously lumped every non-image extension into a single
 *  "Text & source" filter — on the Windows native dialog that
 *  rendered as one extremely wide dropdown item
 *  ("Text & source (*.log;*.md;*.markdown;…)" with 60+ extensions)
 *  that overflowed even on an ultrawide monitor. The native dialog
 *  truncates filter strings visually but the truncation cuts off
 *  the extension list in a way the user can't act on, so the
 *  practical effect is "the filter is unscrollable and unreadable."
 *
 *  Splitting by language family gives us short, self-explanatory
 *  dropdown items — each one is well within ultrawide width. The
 *  categories are stable (a file doesn't move between groups) and
 *  the union of `extensions` here is exactly
 *  `ALLOWED_EXTENSIONS − IMAGE_EXTENSIONS`. Adding a new supported
 *  type means: extend `ALLOWED_TEXT_EXT` + `ALLOWED_EXTENSIONS` in
 *  `attachments.ts`, then drop the new ext into the appropriate
 *  group below. If you don't add it to any group the file picker
 *  silently stops accepting it via the native dialog — the drag-
 *  drop path and the validation in `isAllowedAttachment` are still
 *  driven by the allowlist, but the user can't see it in the
 *  dropdown.
 *
 *  The groups don't include an "all files" entry — that's added
 *  explicitly in `pickFilesTauri` as the last filter so the user
 *  can still pick a file with an extension that isn't in any of
 *  these buckets (a personal `.note`, an exotic data format, etc.).
 *  Note: rfd (the file-dialog crate the Tauri plugin delegates to)
 *  only auto-appends an "All files" filter when the filter list is
 *  EMPTY — so just being thorough, we have to add one ourselves. */
const TEXT_FILTER_GROUPS: ReadonlyArray<{ name: string; extensions: readonly string[] }> = [
  { name: 'Web (HTML/CSS/JS/TS)', extensions: ['html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'] },
  { name: 'Python', extensions: ['py', 'pyi', 'pyx', 'pyc'] },
  { name: 'C / C++ / Objective-C', extensions: ['c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hxx', 'm', 'mm'] },
  { name: 'JVM & .NET', extensions: ['java', 'kt', 'kts', 'kotlin', 'scala', 'gradle', 'cs', 'csproj', 'sln', 'swift'] },
  { name: 'Rust, Go & other languages', extensions: ['rs', 'go', 'rb', 'php', 'dart', 'lua', 'vim', 'sql', 'proto', 'tex', 'mdx'] },
  { name: 'Scripts & shell', extensions: ['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd'] },
  { name: 'Data & config', extensions: ['json', 'yaml', 'yml', 'toml', 'xml', 'env', 'ini', 'cfg', 'conf'] },
  { name: 'Docs & logs', extensions: ['md', 'markdown', 'txt', 'log', 'diff', 'patch'] },
];

/** Catch-all filter for files with extensions that aren't in any
 *  of the language-family groups. rfd renders the extension list
 *  as `*.<ext>;` per entry — passing a single `*` becomes `*.*` in
 *  the dialog, which is the Windows "All files" wildcard. */
const ALL_FILES_FILTER = { name: 'All files', extensions: ['*'] };

/**
 * Build a proper `accept` string for the web `<input type="file">`
 * fallback. We use MIME types where they're well-defined and the
 * extension as a fallback for older browsers that don't recognise
 * the MIME. The set is a curated subset of `ALLOWED_EXTENSIONS`:
 * the file picker dropdown has to stay readable, so we keep the
 * most common image types and use a single `text/*` for the rest
 * (the browser will list every text MIME type registered on the
 * system, which covers our language types in practice).
 */
function buildWebAcceptAttribute(): string {
  const images = IMAGE_EXTENSIONS.map((ext) => `image/${ext === 'jpg' ? 'jpeg' : ext}`).join(',');
  // `text/*` covers every text MIME type the OS knows about. The
  // remaining language types (Rust, Go, Kotlin, …) don't have a
  // single canonical MIME, so the extension fallback list below
  // catches them.
  const extensions = ALLOWED_EXTENSIONS.filter((e) => !IMAGE_EXTENSIONS.includes(e))
    .map((e) => `.${e}`);
  return [images, 'text/*', ...extensions].join(',');
}

/** Tauri-only: read a file's bytes via the existing `read_dropped_file`
 *  Rust command. Same path the drag-drop handler uses, so we get
 *  consistent MIME guessing and a `File` we can hand to the
 *  composer's `addFiles` flow unchanged. */
async function readTauriFile(path: string): Promise<File> {
  const dropped = await invoke<TauriDroppedFile>('read_dropped_file', { path });
  const blob = new Blob([new Uint8Array(dropped.bytes)], {
    type: dropped.mime || 'application/octet-stream',
  });
  return new File([blob], dropped.name, {
    type: dropped.mime,
    lastModified: Date.now(),
  });
}

/**
 * Tauri path: open the native dialog, read each picked path's bytes —
 * except PDFs, whose paths are returned unread (see `resolvePickedPaths`).
 */
async function pickFilesTauri(): Promise<PickedFiles> {
  // One filter per logical group. Images stays as its own filter
  // (most common use case) and the text/source allowlist is
  // distributed across the language-family groups in
  // `TEXT_FILTER_GROUPS`. We tack on `ALL_FILES_FILTER` at the end
  // so the user can pick a file with an extension that doesn't
  // match any of the language buckets (a personal `.note`, an
  // exotic data format, an old `.adoc`, etc.). rfd only auto-
  // appends its own "All files" entry when the filter list is
  // empty, so we add one explicitly.
  //
  // Picking an out-of-bucket file is still safe: the file goes
  // through `isAllowedAttachment` in the composer, which falls
  // back to MIME matching (any `text/*`, or
  // `application/(json|xml|yaml|toml|script|x-sh)`) before the
  // extension allowlist, so a `.rst` with `text/plain` MIME still
  // attaches cleanly. A genuine binary (mp4, exe, …) gets pushed
  // to the `skipped` list and surfaces as a single toast — no
  // crash, no junk sent to the API.
  //
  // We spread the readonly group arrays into fresh mutable copies
  // because `DialogFilter.extensions` is typed as `string[]`, not
  // `readonly string[]`. The source arrays in `TEXT_FILTER_GROUPS`
  // stay readonly so a future caller can't accidentally mutate the
  // shared filter definition.
  const filters = [
    { name: 'Images', extensions: [...IMAGE_EXTENSIONS] },
    ...TEXT_FILTER_GROUPS.map((g) => ({ name: g.name, extensions: [...g.extensions] })),
    { name: ALL_FILES_FILTER.name, extensions: [...ALL_FILES_FILTER.extensions] },
  ];
  return resolvePickedPaths(
    () => tauriOpen({ multiple: true, filters }) as Promise<string | string[] | null>,
    readTauriFile,
  );
}

/**
 * Split picked paths into attachable files and PDF paths.
 *
 * Dependency-injected so a test can prove the ordering: `readFile` must
 * never be called for a PDF. That ordering is the whole point — reading
 * a large PDF into memory only to reject it downstream is pure waste,
 * and the absolute path is lost once the bytes become a `File`, which
 * carries only a basename. Handing the path back is what makes the
 * resulting notice actionable instead of a dead end.
 */
export async function resolvePickedPaths(
  openDialog: () => Promise<string | string[] | null>,
  readFile: (path: string) => Promise<File>,
): Promise<PickedFiles> {
  const result = await openDialog();
  if (!result) return { files: [], pdfPaths: [] };
  const paths = Array.isArray(result) ? result : [result];
  const { pdfPaths, otherPaths } = partitionNativePdfPaths(paths);
  return { files: await Promise.all(otherPaths.map(readFile)), pdfPaths };
}

/**
 * Split native filesystem paths before any bytes are read. Shared by the
 * native picker and both chat drop surfaces so edit mode cannot regress to
 * loading a large PDF only to reject it as an attachment.
 */
export function partitionNativePdfPaths(paths: readonly string[]): {
  pdfPaths: string[];
  otherPaths: string[];
} {
  const pdfPaths: string[] = [];
  const otherPaths: string[] = [];
  for (const path of paths) {
    (/\.pdf$/i.test(path.trim()) ? pdfPaths : otherPaths).push(path);
  }
  return { pdfPaths, otherPaths };
}

/** Web fallback: synthesise a one-shot `<input type="file">` and
 *  return the picked files. Resolves to `[]` on cancel. */
function pickFilesWeb(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = buildWebAcceptAttribute();
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    input.style.top = '0';
    input.style.width = '1px';
    input.style.height = '1px';
    input.style.opacity = '0';
    // The dialog is modal; the change event fires on confirm,
    // and `blur`/focus is unreliable across browsers. We use
    // change + a manual `cancel` path: if the input is removed
    // without firing change, we treat that as cancel.
    let cancelTimer: number | null = null;
    const cleanup = () => {
      if (cancelTimer !== null) {
        clearTimeout(cancelTimer);
        cancelTimer = null;
      }
      window.removeEventListener('focus', onFocusBack);
      if (input.parentNode) input.parentNode.removeChild(input);
    };
    let settled = false;
    const onChange = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const files = input.files ? Array.from(input.files) : [];
      resolve(files);
    };
    const onFocusBack = () => {
      // Cancel detection: after the dialog closes the window
      // regains focus. Defer one tick so the change event can
      // fire first; if it does, we never get here.
      cancelTimer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve([]);
      }, 500);
    };
    input.addEventListener('change', onChange);
    window.addEventListener('focus', onFocusBack);
    document.body.appendChild(input);
    input.click();
  });
}

/** What a picker returned. */
export interface PickedFiles {
  /** Files to attach. Never contains a PDF on the native path. */
  files: File[];
  /**
   * Absolute paths of PDFs the user selected. PDFs are read through
   * `lc_read_pdf`, not attached, so their bytes are never loaded.
   *
   * Always empty on the web path — a browser `File` exposes no path,
   * so there is nothing to hand to the tool.
   */
  pdfPaths: string[];
}

/**
 * Show a file picker, let the user select one or more files, and
 * return the picked files as `File` objects plus any PDF paths.
 * Returns empty collections on cancel.
 *
 * In Tauri: uses the native dialog plugin's `open()` with proper
 * `filters` so the platform's file dialog (including GTK on Linux)
 * shows all supported file types in the filter dropdown. PDFs are
 * separated out by path without reading their bytes.
 *
 * In web: uses a synthesised `<input type="file">` with a
 * canonical `accept` attribute derived from the same allowlist.
 */
export function pickFiles(): Promise<PickedFiles> {
  return isTauri
    ? pickFilesTauri()
    : pickFilesWeb().then((files) => ({ files, pdfPaths: [] }));
}
