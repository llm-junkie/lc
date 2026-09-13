/**
 * File → Attachment conversion for the composer.
 *
 * Attachment bytes are persisted to IndexedDB (see `./idb.ts`).
 * Conversation message rows in Dexie store their attachment metadata
 * (see `../store/db.ts`). A transient `dataUrl` is filled in lazily via
 * `loadAttachmentDataUrl(id)` before render.
 *
 * We still cap file size to keep memory pressure in check — 25 MB covers
 * any reasonable screenshot, including multi-megapixel PNGs.
 */

import type { Attachment } from '../types';
import type { ContentPart, ImageUrlPart } from '../modules/llm-client/types';
import {
  loadAttachmentDataUrl,
  putAttachment,
  deleteAttachment,
} from './idb.ts';
import { uid } from './uid.ts';

/**
 * Module-scoped UTF-8 decoder. Hoisted out of `decodeDataUrlAsUtf8`
 * (Gemini v1 perf §6.A) so the per-decode path doesn't allocate a new
 * `TextDecoder` on every file drop / paste. `TextDecoder` itself is
 * cheap to construct, but the allocation + GC churn on a hot drag-drop
 * loop is unnecessary.
 *
 * `fatal: false` (the default) means invalid UTF-8 sequences are
 * replaced with U+FFFD rather than throwing — matching the behavior
 * of the prior inline `new TextDecoder('utf-8', { fatal: false })`.
 */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * Decode a base64 `data:` URL's payload as UTF-8 text.
 *
 * The naive `atob(dataUrl.slice(comma + 1))` is wrong for any text that
 * isn't pure ASCII: `atob` returns a binary string (one code unit = one
 * byte, 0–255), and the browser then displays those bytes as if they
 * were already-decoded Unicode code points. A four-byte emoji like
 * `⚙️` (UTF-8: `0xE2 0x9A 0x99 0xEF 0xB8 0x8F`) shows up as
 * `â˜™ï¸` (six Latin-1 characters) — classic mojibake.
 *
 * The fix is to go through the bytes explicitly: base64-decode, then
 * run a UTF-8 decoder. The decoder folds multi-byte sequences into the
 * right code points, so emoji, CJK, combining marks, etc. all render
 * correctly. The decoder is also fault-tolerant — invalid sequences
 * become U+FFFD (`�`) rather than throwing, so a binary file the
 * caller mistakenly labels as text won't crash the preview.
 */
export function decodeDataUrlAsUtf8(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const b64 = dataUrl.slice(comma + 1);
  let bytes: Uint8Array;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return null;
  }
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    // TextDecoder is universally available in browsers and modern
    // Tauri webviews, but keep the fallback so an exotic runtime
    // doesn't crash the preview.
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
}

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_MIME = /^(image\/(png|jpe?g|gif|webp|bmp))$/i;
// Text / source-code formats we accept as text attachments. Anything that
// isn't here AND isn't an image is rejected.
const ALLOWED_TEXT_EXT = /\.(txt|md|markdown|json|ya?ml|toml|xml|html?|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|py|pyi|pyx|pyc|rb|rs|go|java|kt|kts|swift|m|mm|c|cc|cpp|cxx|h|hpp|hxx|cs|csproj|sln|php|sh|bash|zsh|ps1|bat|cmd|sql|dart|lua|vim|diff|patch|log|env|ini|cfg|conf|gradle|kotlin|scala|swift|tex|mdx|proto|toml)$/i;

/**
 * Text files that carry no extension at all.
 *
 * Every rule above keys off an extension or a MIME type, and these have
 * neither: `LICENSE` has no `.ext` for `ALLOWED_TEXT_EXT` to match, and
 * neither the browser nor our Rust `guess_mime_from_name` can name a MIME
 * for it, so it arrives as `application/octet-stream`. Both gates in
 * `isTextFile` miss and a plain `LICENSE` gets rejected as if it were a
 * binary — which is the bug this set fixes.
 *
 * These are convention names, not user names: they are ubiquitous in
 * source trees and always plain text. Matched on the whole basename,
 * case-insensitively (`LICENSE`, `License`, and `license` are all the
 * same file). Dotfiles are included for the same reason — a leading dot
 * is not an extension.
 */
const EXTENSIONLESS_TEXT_NAMES: ReadonlySet<string> = new Set([
  // Legal / project metadata
  'authors', 'changelog', 'changes', 'codeowners', 'contributing',
  'contributors', 'copying', 'copyright', 'history', 'install',
  'license', 'licence', 'maintainers', 'manifest', 'news', 'notice',
  'readme', 'security', 'todo', 'version',
  // Build / task runners
  'brewfile', 'containerfile', 'dockerfile', 'gemfile', 'gnumakefile',
  'jenkinsfile', 'justfile', 'makefile', 'procfile', 'rakefile',
  'vagrantfile',
  // Common extensionless dotfiles
  '.babelrc', '.dockerignore', '.editorconfig', '.eslintrc',
  '.gitattributes', '.gitignore', '.gitmodules', '.npmignore', '.npmrc',
  '.nvmrc', '.prettierrc',
]);

/**
 * The license family with a qualifier: `LICENSE-MIT`, `COPYING.LESSER`,
 * `NOTICE-third-party`. The qualifier is a variant marker, not a file
 * extension, so the extension rule can never match these.
 */
const LICENSE_FAMILY = /^(licen[cs]e|notice|copying|copyright)[-._]/i;

/**
 * Extensions that are never text, and therefore veto every name rule
 * below. Without this the family pattern would read `LICENSE.exe` as a
 * license variant and hand a binary to the UTF-8 decoder.
 *
 * A denylist is the right shape here rather than "the qualifier must not
 * look like an extension": real variants are open-ended (`COPYING.LESSER`,
 * `LICENSE.APACHE-2.0`, `NOTICE.3RDPARTY`) and cannot be enumerated, while
 * the binary formats someone might collide with can be. Anything not
 * listed stays accepted, so the common cases keep working.
 *
 * `pyc` is deliberately absent — it is genuinely binary, but it predates
 * this list in `ALLOWED_EXTENSIONS`, and removing it here would be a
 * silent behaviour change to an unrelated rule.
 */
const BINARY_EXT: ReadonlySet<string> = new Set([
  // executables, libraries, installers
  'exe', 'dll', 'so', 'dylib', 'msi', 'msix', 'app', 'appimage', 'deb',
  'rpm', 'apk', 'aab', 'dmg', 'pkg', 'bin', 'o', 'obj', 'a', 'lib',
  'pdb', 'wasm', 'node', 'jar', 'war', 'ear', 'class', 'nupkg',
  // archives
  'zip', 'gz', 'tar', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'lz',
  'lzma', 'cab', 'iso', 'img',
  // audio / video
  'mp3', 'mp4', 'm4a', 'm4v', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm',
  'wav', 'flac', 'ogg', 'oga', 'ogv', 'aac', 'opus', 'mpg', 'mpeg',
  // images we do not accept as attachments (the ones we do are handled
  // by `isImageFile`, which runs first)
  'psd', 'ai', 'eps', 'tif', 'tiff', 'ico', 'icns', 'heic', 'heif',
  'avif', 'raw', 'cr2', 'nef', 'arw', 'svgz',
  // office / portable documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
  'odp', 'rtf',
  // fonts
  'ttf', 'otf', 'ttc', 'woff', 'woff2', 'eot',
  // databases / opaque data
  'db', 'sqlite', 'sqlite3', 'mdb', 'accdb', 'dat', 'pack', 'idx',
  'bak', 'dmp',
]);

/**
 * The dot-suffix of a basename, lowercased, or `''` when there is none.
 *
 * A leading dot is part of the name (`.gitignore` is a dotfile, not a
 * `gitignore` extension), so only a dot at index > 0 counts.
 */
function dotSuffix(base: string): string {
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1) : '';
}

/**
 * Does this filename name a well-known extensionless text file?
 *
 * Exported so the same judgement is available to callers that see a name
 * before they see a `File` (and so it is directly testable).
 */
export function isKnownExtensionlessTextName(name: string): boolean {
  // `File.name` is a bare basename, but Tauri hands us names built from
  // a path — split on both separators so a stray directory prefix can't
  // defeat the match.
  const base = (name.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (!base) return false;
  // A binary extension wins over any name below: `LICENSE.exe` is an
  // executable someone named after a license, not a license.
  if (BINARY_EXT.has(dotSuffix(base))) return false;
  return EXTENSIONLESS_TEXT_NAMES.has(base) || LICENSE_FAMILY.test(base);
}

/**
 * Canonical list of allowed file extensions (no leading dot). Kept in
 * sync with `ALLOWED_TEXT_EXT` above by construction — both are
 * derived from the same set, just one is the regex form for fast
 * matching, the other is the plain array for dialog filters.
 *
 * Exported because the file-picker UI (Tauri's native dialog plugin
 * and the web `<input type="file">` accept attribute) needs the
 * extension list, and we want a single source of truth so adding a
 * new supported type means changing one constant.
 */
export const ALLOWED_EXTENSIONS: readonly string[] = [
  // images (the dialog filter groups them as "Images")
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
  // text & source
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'toml', 'xml',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'py', 'pyi', 'pyx', 'pyc',
  'rb', 'rs', 'go', 'java', 'kt', 'kts', 'swift',
  'm', 'mm', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hxx',
  'cs', 'csproj', 'sln', 'php',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'sql', 'dart', 'lua', 'vim', 'diff', 'patch', 'log',
  'env', 'ini', 'cfg', 'conf',
  'gradle', 'kotlin', 'scala', 'tex', 'mdx', 'proto',
];


function isImageFile(file: File): boolean {
  return ALLOWED_MIME.test(file.type) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
}

function isTextFile(file: File): boolean {
  // Match by MIME if the browser provided one (text/*, application/json,
  // application/xml, application/x-yaml, etc.), or fall back to
  // extension matching for files with no MIME info.
  if (/^text\//i.test(file.type)) return true;
  if (/^application\/(json|xml|.*yaml|.*toml|.*script|x-sh)/i.test(file.type)) return true;
  if (ALLOWED_TEXT_EXT.test(file.name)) return true;
  // Last: the conventional extensionless names, which by definition
  // reach neither of the rules above.
  return isKnownExtensionlessTextName(file.name);
}

export function isAllowedAttachment(file: File): boolean {
  return isImageFile(file) || isTextFile(file);
}

/**
 * Convert a File to an Attachment. The blob is written to IndexedDB.
 * The returned metadata can be stored with conversation messages in Dexie.
 * Use `hydrateAttachment(a)` right before rendering to fill in `dataUrl`.
 */
export async function fileToAttachment(file: File): Promise<Attachment> {
  const isImage = isImageFile(file);
  if (!isImage && !isTextFile(file)) {
    throw new Error(
      `Unsupported file type: ${file.type || file.name}. Only images and common text/source files are supported.`,
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    throw new Error(`File is too large (${mb} MB). Limit is 25 MB.`);
  }
  const id = uid();
  const mime = file.type || guessMimeFromName(file.name);
  await putAttachment(id, file, { mime, name: file.name, size: file.size });
  return { id, name: file.name, mime, isImage, size: file.size, stored: 'idb' };
}

/** Populate the transient `dataUrl` field by reading from IDB. */
export async function hydrateAttachment(a: Attachment): Promise<Attachment> {
  if (a.dataUrl) return a;
  const dataUrl = await loadAttachmentDataUrl(a.id);
  return { ...a, dataUrl: dataUrl ?? undefined };
}

/** Hydrate an array in parallel. */
export async function hydrateAttachments(list: Attachment[]): Promise<Attachment[]> {
  return Promise.all(list.map(hydrateAttachment));
}

/** Remove an attachment's blob from IDB. */
export async function removeAttachmentBlob(id: string): Promise<void> {
  await deleteAttachment(id);
}

function guessMimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const image = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  }[ext];
  if (image) return image;
  // A recognised extensionless name is text, and saying so beats
  // recording `application/octet-stream` for a file we just accepted
  // as text.
  if (isKnownExtensionlessTextName(name)) return 'text/plain';
  return 'application/octet-stream';
}

/**
 * Build a multimodal content array from a user message with attachments.
 * If there are no images, returns the original string content. Callers
 * must have hydrated attachments first.
 */
export function buildMessageContent(
  text: string,
  attachments: Attachment[] = [],
): string | ContentPart[] {
  const imageParts: ImageUrlPart[] = attachments
    .filter((a) => a.isImage && a.dataUrl)
    .map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl! } }));

  // For non-image (text/source) attachments, read the bytes from IDB and
  // inline the content as a fenced code block. This lets the model use
  // the file as context (e.g. "explain this Python file") without us
  // having to invent a new wire format.
  const textParts: { type: 'text'; text: string }[] = [];
  for (const a of attachments) {
    if (a.isImage) continue;
    // We have the dataUrl; strip the `data:<mime>;base64,` prefix and
    // decode. For very small files we could decode fully; for source
    // code, we cap at a reasonable length so we don't blow the model's
    // context window.
    if (!a.dataUrl) continue;
    const decoded = decodeDataUrlAsUtf8(a.dataUrl);
    if (decoded == null) continue;
    // Truncate huge files to 200 KB to keep context manageable.
    const capped = decoded.length > 200_000 ? decoded.slice(0, 200_000) + '\n… [truncated]' : decoded;
    const lang = langFromMime(a.mime) || langFromName(a.name);
    textParts.push({
      type: 'text',
      text: `[Attached file: ${a.name}]\n\`\`\`${lang}\n${capped}\n\`\`\``,
    });
  }

  if (imageParts.length === 0 && textParts.length === 0) return text;
  const parts: ContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  parts.push(...textParts);
  parts.push(...imageParts);
  return parts;
}

export function langFromMime(mime: string): string {
  if (!mime) return '';
  if (/python/i.test(mime)) return 'python';
  if (/typescript/i.test(mime)) return 'typescript';
  if (/javascript/i.test(mime)) return 'javascript';
  if (/json/i.test(mime)) return 'json';
  if (/xml/i.test(mime)) return 'xml';
  if (/html/i.test(mime)) return 'html';
  if (/css/i.test(mime)) return 'css';
  if (/markdown/i.test(mime)) return 'markdown';
  if (/shell|shellscript/i.test(mime)) return 'bash';
  if (/yaml/i.test(mime)) return 'yaml';
  if (/toml/i.test(mime)) return 'toml';
  if (/sql/i.test(mime)) return 'sql';
  if (/rust/i.test(mime)) return 'rust';
  if (/go/i.test(mime)) return 'go';
  if (/java/i.test(mime)) return 'java';
  if (/c\+\+|cpp/i.test(mime)) return 'cpp';
  return '';
}

export function langFromName(name: string): string {
  // Extensionless names first — `Makefile.pop('.')` yields the whole
  // name, which would never hit the extension map below.
  const base = (name.split(/[\\/]/).pop() ?? '').toLowerCase();
  const byName: Record<string, string> = {
    makefile: 'makefile', gnumakefile: 'makefile',
    dockerfile: 'dockerfile', containerfile: 'dockerfile',
    gemfile: 'ruby', rakefile: 'ruby', brewfile: 'ruby',
    vagrantfile: 'ruby', jenkinsfile: 'groovy',
    '.gitignore': 'gitignore', '.dockerignore': 'gitignore',
    '.editorconfig': 'ini', '.npmrc': 'ini', '.nvmrc': 'text',
    '.babelrc': 'json', '.prettierrc': 'json', '.eslintrc': 'json',
  };
  if (byName[base]) return byName[base];
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    py: 'python', pyi: 'python', ts: 'typescript', tsx: 'tsx',
    js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
    rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin',
    swift: 'swift', m: 'objc', mm: 'objc', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp',
    cxx: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash',
    zsh: 'bash', ps1: 'powershell', bat: 'batch', cmd: 'batch', sql: 'sql',
    dart: 'dart', lua: 'lua', vim: 'vim', tex: 'latex', proto: 'protobuf',
    toml: 'toml', yaml: 'yaml', yml: 'yaml', json: 'json', xml: 'xml',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass',
    less: 'less', md: 'markdown', mdx: 'mdx', log: 'text', env: 'text',
    ini: 'ini', cfg: 'ini', conf: 'ini', gradle: 'gradle', scala: 'scala',
    diff: 'diff', patch: 'diff',
  };
  return map[ext] ?? '';
}
