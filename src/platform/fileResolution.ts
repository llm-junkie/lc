/**
 * Platform-aware file resolution helpers.
 *
 * Extracted from App.tsx per Phase 6.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useConversations } from '../store/conversations.ts';
import { isTauri, getHomeDir } from '../utils/saveBlob.ts';
import { toast } from '../utils/toast.ts';

// ── Module-level utilities ────────────────────────────────────────────

/** Normalise separators to the OS-native form.
 *  On Windows: `/` → `\`.  On Unix: `\` → `/`. */
export function toNativePath(p: string): string {
  const isWin = typeof navigator !== 'undefined' && /win/i.test((navigator as { platform?: string }).platform ?? '');
  return isWin ? p.replace(/\//g, '\\') : p.replace(/\\/g, '/');
}

/** Check whether a path is within (or equal to) at least one
 *  of the granted roots.  Normalises separators before comparing
 *  so "C:/temp/what" and "C:\\temp\\what" are treated as equal. */
export function isWithinRoots(p: string, roots: string[]): boolean {
  if (roots.length === 0) return false;
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const np = norm(p);
  return roots.some((r) => {
    const nr = norm(r);
    return np === nr || np.startsWith(nr + '/');
  });
}

/** Maps common file extensions to MIME types for preview routing. */
function guessMime(path: string): string {
  const ext = path.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    svg: 'image/svg+xml', ico: 'image/x-icon',
    pdf: 'application/pdf',
    md: 'text/markdown', markdown: 'text/markdown',
    txt: 'text/plain', log: 'text/plain', csv: 'text/csv',
    json: 'application/json', xml: 'application/xml',
    html: 'text/html', htm: 'text/html',
    css: 'text/css', js: 'text/javascript', ts: 'text/typescript',
    jsx: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
    tsx: 'text/typescript',
    py: 'text/x-python', rs: 'text/x-rust', go: 'text/x-go',
    java: 'text/x-java', cpp: 'text/x-c++src', c: 'text/x-csrc',
    h: 'text/x-chdr', hpp: 'text/x-c++hdr', cs: 'text/x-csharp',
    rb: 'text/x-ruby', php: 'text/x-php', swift: 'text/x-swift',
    kt: 'text/x-kotlin', scala: 'text/x-scala',
    sh: 'text/x-sh', bash: 'text/x-sh', zsh: 'text/x-sh',
    bat: 'text/x-bat', cmd: 'text/x-bat', ps1: 'text/x-powershell',
    yaml: 'text/x-yaml', yml: 'text/x-yaml',
    toml: 'text/x-toml', ini: 'text/x-ini', cfg: 'text/x-ini',
    vue: 'text/x-vue', svelte: 'text/x-svelte',
  };
  return map[ext] || 'application/octet-stream';
}

function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript';
}

/** Extensions we can display as text even if MIME is octet-stream. */
function isTextExt(path: string): boolean {
  const ext = path.toLowerCase().split('.').pop() || '';
  const textExts = new Set([
    'md', 'markdown', 'txt', 'log', 'csv', 'json', 'xml', 'html', 'htm',
    'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'java', 'cpp',
    'c', 'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'scala',
    'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'yaml', 'yml', 'toml', 'ini',
    'cfg', 'vue', 'svelte', 'lua', 'r', 'm', 'mm', 'mjs', 'cjs',
  ]);
  return textExts.has(ext);
}

/** Whether a file at the given path can be previewed (image or text). */
export function isPreviewablePath(path: string): boolean {
  const mime = guessMime(path);
  if (mime.startsWith('image/') && !mime.includes('svg')) return true;
  if (isTextMime(mime)) return true;
  if (isTextExt(path)) return true;
  return false;
}

// ── File resolution hook ──────────────────────────────────────────────

export type PreviewState =
  | { type: 'image'; src: string; name: string; size: number }
  | { type: 'text'; name: string; mime: string; size: number; content: string | null; reason?: string }
  | null;

export function useFileResolution() {
  const [preview, setPreview] = useState<PreviewState>(null);

  // Object URLs retain their Blob until explicitly revoked. Revoke on
  // replacement as well as unmount so opening previews repeatedly cannot
  // accumulate image buffers in the WebView process.
  useEffect(() => {
    if (preview?.type !== 'image') return;
    const src = preview.src;
    return () => URL.revokeObjectURL(src);
  }, [preview]);

  /** Resolve a filename to an absolute path.
   *  Resolution order:
   *    1. Absolute filename → verify existence, return as-is.
   *    2. prePath + filename — ONLY if prePath is within granted roots.
   *    3. Each allowed_root + filename.
   *    4. Home directory (fallback when no roots configured). */
  const resolveFilePath = async (filename: string, prePath?: string): Promise<string | null> => {
    const fileExists = async (p: string): Promise<boolean> => {
      try {
        const res = await invoke<{ exists: boolean; is_dir: boolean; canonical: string | null }>(
          'tool_check_path',
          { req: { path: p } },
        );
        return res?.exists === true;
      } catch {
        return false;
      }
    };

    // Absolute path on any platform.
    if (/^[A-Za-z]:[\\/]/.test(filename) || filename.startsWith('/') || filename.startsWith('\\\\')) {
      if (await fileExists(filename)) return toNativePath(filename);
      return null;
    }

    const state = useConversations.getState();
    const activeConv = state.activeId ? state.byId[state.activeId] : undefined;
    const roots: string[] = activeConv?.tools?.allowed_roots ?? [];

    // Try the context path from the bubble text first — but ONLY if
    // it's within the granted roots (or is the home directory).
    if (prePath) {
      const allowed = isWithinRoots(prePath, roots);
      const isHome = isTauri && (await (async () => {
        try {
          const home = await getHomeDir();
          return home !== '~' && isWithinRoots(prePath, [home]);
        } catch { return false; }
      })());
      if (allowed || isHome) {
        const sep = prePath.endsWith('\\') || prePath.endsWith('/') ? '' : '/';
        const candidate = `${prePath}${sep}${filename}`;
        if (await fileExists(candidate)) return toNativePath(candidate);
      }
    }

    // Try each workspace root.
    for (const root of roots) {
      const sep = root.endsWith('\\') || root.endsWith('/') ? '' : '/';
      const candidate = `${root}${sep}${filename}`;
      if (await fileExists(candidate)) return toNativePath(candidate);
    }

    // No roots matched. If we have no roots at all, try the home directory.
    if (roots.length === 0 && isTauri) {
      try {
        const home = await getHomeDir();
        if (home && home !== '~') {
          const sep = home.endsWith('\\') || home.endsWith('/') ? '' : '/';
          const candidate = `${home}${sep}${filename}`;
          if (await fileExists(candidate)) return toNativePath(candidate);
        }
      } catch {
        // getHomeDir failed, ignore.
      }
    }
    return null;
  };

  /** Scan all granted roots for a file with the given basename.
   *  Delegates to the Rust `tool_glob_files` command which uses
   *  `walkdir` + `globset` for full recursive search with
   *  automatic skip of noise directories (node_modules, .git,
   *  target, etc.).  All roots are searched in parallel; results
   *  are deduplicated so a file accessible via multiple roots
   *  appears only once. */
  const findFileInRoots = async (filename: string): Promise<string[]> => {
    const state = useConversations.getState();
    const activeConv = state.activeId ? state.byId[state.activeId] : undefined;
    const roots: string[] = activeConv?.tools?.allowed_roots ?? [];
    if (roots.length === 0) return [];

    // Escape glob-special characters so a literal filename like
    // "[draft].md" or "report{final}.txt" is matched exactly.
    const escaped = filename.replace(/[[\]{}*?]/g, '\\$&');
    const pattern = `**/${escaped}`;

    const batches = await Promise.all(
      roots.map(async (root) => {
        try {
          const res = await invoke<{
            matches: Array<{ path: string; is_dir: boolean }>;
            truncated: boolean;
            pattern_used: string;
          }>('tool_glob_files', {
            req: { pattern, root, allowed_roots: roots },
          });
          return (res?.matches ?? [])
            .filter((m) => !m.is_dir)
            .map((m) => m.path);
        } catch {
          return [] as string[];
        }
      }),
    );

    // Flatten and deduplicate — a file accessible under more than
    // one root (nested roots, symlinks) should appear only once.
    return [...new Set(batches.flat())];
  };

  /** Read already-resolved absolute path → show Lightbox or TextPreview. */
  const previewFile = async (resolvedPath: string): Promise<boolean> => {
    try {
      const file = (await invoke<{ bytes: number[]; mime: string; name: string; size: number }>(
        'read_dropped_file',
        { path: resolvedPath },
      ));
      if (!file) {
        toast.error(`Could not read file: ${resolvedPath}`);
        return false;
      }
      const bytes = new Uint8Array(file.bytes);
      const mime = file.mime || guessMime(resolvedPath);
      const name = file.name || resolvedPath.split(/[\\/]/).pop() || resolvedPath;

      if (mime.startsWith('image/') && !mime.includes('svg')) {
        const blob = new Blob([bytes], { type: mime });
        const src = URL.createObjectURL(blob);
        setPreview({ type: 'image', src, name, size: file.size });
        return true;
      } else if (isTextMime(mime) || isTextExt(resolvedPath)) {
        const content = new TextDecoder().decode(bytes);
        setPreview({
          type: 'text',
          name,
          mime,
          size: file.size,
          content: content.length <= 1_000_000 ? content : null,
          reason: content.length > 1_000_000 ? 'File is too large to preview (> 1 MB)' : undefined,
        });
        return true;
      } else {
        toast.error(`Preview not supported for: ${name}`);
        return false;
      }
    } catch {
      toast.error(`Could not read file: ${resolvedPath}`);
      return false;
    }
  };

  return { preview, setPreview, resolveFilePath, findFileInRoots, previewFile };
}
