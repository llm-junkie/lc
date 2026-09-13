/**
 * The message shown when a PDF reaches the composer.
 *
 * PDFs are read through `lc_read_pdf`, never through the attachment
 * pipeline — a dropped 200-page document would otherwise be inlined as
 * an uncontrolled wall of text with no summarization or page selection.
 *
 * That leaves the gesture itself needing an answer: dragging a PDF onto
 * the composer is the most natural way to say "read this", and a bare
 * "unsupported file type" would be wrong once the tool exists. So the
 * notice routes the user to the tool — but only when the tool can
 * actually run, and only when a path exists to give it.
 *
 * The last part matters. A browser `File` carries no filesystem path,
 * and its bytes are discarded on rejection, so telling the user to
 * "ask the model to read it" would be advice the model cannot follow.
 * The pathless branch says what will actually work instead.
 *
 * Kept free of React and Tauri imports so the branching is unit-testable.
 */

export interface PdfDropContext {
  /** Whether `lc_read_pdf` is exposed for the active conversation. */
  toolExposed: boolean;
  /** Absolute roots the File I/O tools may read from. */
  allowedRoots: string[];
}

export interface DroppedPdf {
  /** Basename, always known. */
  name: string;
  /**
   * Absolute path. Present for OS drags and the native file picker,
   * which deal in paths; absent for the web picker and HTML5 drops,
   * which hand over `File` objects that expose no path.
   */
  path?: string;
}

/** Normalize for comparison: forward slashes, no trailing separator, lowercase. */
function normalize(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows paths are case-insensitive; folding here only risks
  // accepting a root the user did configure, never widening beyond the
  // configured set.
  return s.toLowerCase();
}

/** Is `path` inside `root` (or equal to it)? */
export function isUnderRoot(path: string, root: string): boolean {
  const p = normalize(path);
  const r = normalize(root);
  if (!r) return false;
  return p === r || p.startsWith(r + '/');
}

export function isPdfName(name: string): boolean {
  return /\.pdf$/i.test(name.trim());
}

/** Directory portion of a path. */
function dirname(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i > 0 ? norm.slice(0, i) : norm;
}

function subject(pdfs: DroppedPdf[]): string {
  return pdfs.length === 1
    ? `"${pdfs[0].name}"`
    : `${pdfs.length} PDFs (${pdfs.slice(0, 3).map((p) => p.name).join(', ')}${
        pdfs.length > 3 ? '…' : ''
      })`;
}

/**
 * Build the notice for one or more skipped PDFs, or `null` when none
 * were skipped.
 *
 * Deliberately avoids the word "unsupported": the app *does* support
 * PDFs, just not as attachments, and saying otherwise while naming the
 * tool that reads them reads like a bug.
 */
export function pdfDropNotice(pdfs: DroppedPdf[], ctx: PdfDropContext): string | null {
  if (pdfs.length === 0) return null;
  const subj = subject(pdfs);

  if (!ctx.toolExposed) {
    return (
      `Skipped ${subj} — PDFs need the lc_read_pdf tool, ` +
      `which isn't enabled for this conversation.`
    );
  }

  const withPath = pdfs.filter((p) => p.path);
  const pathless = pdfs.filter((p) => !p.path);

  // No path anywhere: the bytes are gone and the model has nothing to
  // open. Say what actually works rather than pointing at a tool that
  // cannot reach the file.
  if (withPath.length === 0) {
    return (
      `Skipped ${subj} — PDFs can't be attached, and a file chosen this way ` +
      `has no path to give the model. Drag it in from a folder window, or ` +
      `type its full path and ask the model to read it.`
    );
  }

  const readable = withPath.filter((p) =>
    ctx.allowedRoots.some((r) => isUnderRoot(p.path!, r)),
  );
  const outside = withPath.filter(
    (p) => !ctx.allowedRoots.some((r) => isUnderRoot(p.path!, r)),
  );

  if (readable.length === 0) {
    const dirs = [...new Set(outside.map((p) => dirname(p.path!)))];
    return (
      `Skipped ${subj} — PDFs are read with lc_read_pdf, but ` +
      `${dirs.length === 1 ? dirs[0] : `${dirs.length} folders`} ` +
      `${dirs.length === 1 ? "isn't" : "aren't"} an allowed root. ` +
      `Add ${dirs.length === 1 ? 'it' : 'them'} in Tools settings.`
    );
  }

  // Mixed: name the readable paths AND account for the ones that are
  // not reachable, so nothing is silently dropped from the message.
  const lines = [
    `Skipped ${subj} — PDFs can't be attached. Ask the model to read ` +
      `${readable.length === 1 ? 'it' : 'them'}:`,
    ...readable.map((p) => p.path!),
  ];
  if (outside.length > 0) {
    const dirs = [...new Set(outside.map((p) => dirname(p.path!)))];
    lines.push(
      `${outside.length} more (${outside.map((p) => p.name).join(', ')}) ` +
        `${outside.length === 1 ? 'is' : 'are'} outside your allowed roots — ` +
        `add ${dirs.join(', ')} in Tools settings to read ${outside.length === 1 ? 'it' : 'them'}.`,
    );
  }
  if (pathless.length > 0) {
    lines.push(
      `${pathless.length} more (${pathless.map((p) => p.name).join(', ')}) ` +
        `arrived without a path and can't be reached; drag ${pathless.length === 1 ? 'it' : 'them'} ` +
        `in from a folder window instead.`,
    );
  }
  return lines.join('\n');
}
