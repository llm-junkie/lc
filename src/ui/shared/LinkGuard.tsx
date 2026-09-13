import { useEffect, useState } from 'react';
import { LinkOpenConfirm, FileClickConfirm } from '../preview/QuickPreview.tsx';
import { LINK_CLICK_EVENT, FILE_CLICK_EVENT } from '../../utils/markdown.tsx';
import { isTauri } from '../../utils/saveBlob.ts';
import { toast } from '../../utils/toast.ts';
import { debugLog } from '../../utils/debug.ts';

export interface LinkGuardProps {
  /** Called when the user clicks Continue on a link confirmation. */
  onOpenUrl: (url: string) => void;
  /** Called to resolve a filename to an absolute path. */
  resolveFilePath: (filename: string, prePath?: string) => Promise<string | null>;
  /** Called to scan granted roots for a file. */
  onFindFile: (filename: string) => Promise<string[]>;
  /** Whether a given path is previewable. */
  isPreviewable: (path: string) => boolean;
  /** Called when the user clicks "Show in Explorer". */
  onShowInExplorer: (path: string) => void;
  /** Called when the user clicks "Preview". */
  onPreviewFile: (path: string) => void;
}

/**
 * LinkGuard — manages link-open and file-click confirmation dialogs.
 *
 * Listens for custom DOM events fired by markdown surfaces (chat bubbles,
 * reasoning overlay, text-preview rendered view) and presents confirmation
 * overlays before opening external links or previewing files.
 *
 * Extracted from App.tsx per Phase 5 (Part B, Step B3).
 */
export function LinkGuard({
  onOpenUrl,
  resolveFilePath,
  onFindFile,
  isPreviewable,
  onShowInExplorer,
  onPreviewFile,
}: LinkGuardProps) {
  const [linkOpenUrl, setLinkOpenUrl] = useState<string | null>(null);

  const [fileClick, setFileClick] = useState<{
    filename: string;
    prePath?: string;
    resolvedPath: string | null;
    previewable: boolean;
    foundPaths?: string[];
  } | null>(null);

  const [fileResolving, setFileResolving] = useState(false);

  // --- Event listeners ---
  useEffect(() => {
    const onLinkClick = (e: Event) => {
      const detail = (e as CustomEvent<{ url: string }>).detail;
      if (detail?.url) setLinkOpenUrl(detail.url);
    };

    const onFileClick = async (e: Event) => {
      const detail = (e as CustomEvent<{ filename: string; prePath?: string }>).detail;
      if (!detail?.filename) return;
      const f = detail.filename;
      const prePath = detail.prePath;
      setFileClick({ filename: f, prePath, resolvedPath: null, previewable: false });
      setFileResolving(true);
      const resolved = await resolveFilePath(f, prePath);
      const previewable = resolved ? isPreviewable(resolved) : false;
      setFileResolving(false);
      setFileClick((prev) => prev ? { ...prev, resolvedPath: resolved, previewable } : null);
    };

    window.addEventListener(LINK_CLICK_EVENT, onLinkClick);
    window.addEventListener(FILE_CLICK_EVENT, onFileClick);
    return () => {
      window.removeEventListener(LINK_CLICK_EVENT, onLinkClick);
      window.removeEventListener(FILE_CLICK_EVENT, onFileClick);
    };
  }, [resolveFilePath, isPreviewable]);

  // --- Render ---
  return (
    <>
      {linkOpenUrl && (
        <LinkOpenConfirm
          url={linkOpenUrl}
          onContinue={() => {
            const url = linkOpenUrl;
            setLinkOpenUrl(null);
            onOpenUrl(url);
          }}
          onClose={() => setLinkOpenUrl(null)}
        />
      )}
      {fileClick && (
        <FileClickConfirm
          filename={fileClick.filename}
          resolvedPath={fileClick.resolvedPath}
          foundPaths={fileClick.foundPaths}
          previewable={fileClick.previewable}
          busy={fileResolving}
          onFind={async () => {
            setFileResolving(true);
            try {
              const paths = await onFindFile(fileClick.filename);
              setFileClick((prev) => prev ? { ...prev, foundPaths: paths } : null);
            } catch (err) {
              debugLog.error('findFileInRoots failed', err);
              setFileClick((prev) => prev ? { ...prev, foundPaths: [] } : null);
            } finally {
              setFileResolving(false);
            }
          }}
          onSelectPath={(path) => {
            setFileClick((prev) => prev ? { ...prev, resolvedPath: path, previewable: isPreviewable(path) } : null);
          }}
          onShow={async () => {
            const resolved = fileClick.resolvedPath;
            if (!resolved) return;
            setFileClick(null);
            if (!isTauri) {
              toast.info('File Explorer reveal is only available in the Tauri app');
              return;
            }
            onShowInExplorer(resolved);
          }}
          onPreview={async () => {
            const resolved = fileClick.resolvedPath;
            if (!resolved) return;
            if (!isTauri) {
              setFileClick(null);
              toast.info('File preview is only available in the Tauri app');
              return;
            }
            setFileClick(null);
            onPreviewFile(resolved);
          }}
          onClose={() => setFileClick(null)}
        />
      )}
    </>
  );
}
