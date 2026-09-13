import { invoke } from '@tauri-apps/api/core';
import { open as tauriOpen } from '@tauri-apps/plugin-dialog';
import { isTauri } from '../../utils/saveBlob.ts';
import {
  WHITEBOARD_PACKAGE_MAX_COMPRESSED_BYTES,
  WhiteboardPackageError,
} from './whiteboard-package.ts';
import { WHITEBOARD_UI_TEXT } from './whiteboard-ui-text.ts';

interface NativePickedFile {
  name: string;
  mime: string;
  size: number;
  bytes: number[];
}

export type NativeWhiteboardFileInvoker = (
  command: string,
  args: Readonly<{ path: string; maxBytes: number }>,
) => Promise<NativePickedFile>;

export const WHITEBOARD_NATIVE_FILE_ERROR_CODES = Object.freeze({
  emptyPath: 'bounded_file_empty_path',
  invalidLimit: 'bounded_file_invalid_limit',
  notFile: 'bounded_file_not_file',
  tooLarge: 'bounded_file_too_large',
  readFailed: 'bounded_file_read_failed',
  sizeUnsupported: 'bounded_file_size_unsupported',
});

const invokeNativeWhiteboardFile: NativeWhiteboardFileInvoker = (command, args) =>
  invoke<NativePickedFile>(command, args);

/** Read the native selection through the same pre-allocation cap used by ZIP validation. */
export async function readNativeWhiteboardPackageFile(
  path: string,
  invokeFile: NativeWhiteboardFileInvoker = invokeNativeWhiteboardFile,
): Promise<File> {
  let picked: NativePickedFile;
  try {
    picked = await invokeFile('read_bounded_file', {
      path,
      maxBytes: WHITEBOARD_PACKAGE_MAX_COMPRESSED_BYTES,
    });
  } catch (error) {
    const code = typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : '';
    if (code === WHITEBOARD_NATIVE_FILE_ERROR_CODES.tooLarge) {
      throw new WhiteboardPackageError('compressed_too_large');
    }
    throw new Error(WHITEBOARD_UI_TEXT.nativePackageReadFailed, { cause: error });
  }
  if (
    !Number.isSafeInteger(picked.size)
    || picked.size < 0
    || picked.size > WHITEBOARD_PACKAGE_MAX_COMPRESSED_BYTES
    || picked.bytes.length > WHITEBOARD_PACKAGE_MAX_COMPRESSED_BYTES
  ) {
    throw new WhiteboardPackageError('compressed_too_large');
  }

  const blob = new Blob([new Uint8Array(picked.bytes)], {
    type: picked.mime || 'application/zip',
  });
  return new File([blob], picked.name, {
    type: picked.mime || 'application/zip',
    lastModified: Date.now(),
  });
}

function pickWebPackage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    input.style.width = '1px';
    input.style.height = '1px';
    input.style.opacity = '0';
    let settled = false;
    let cancelTimer: number | null = null;
    const cleanup = () => {
      if (cancelTimer !== null) window.clearTimeout(cancelTimer);
      window.removeEventListener('focus', onFocusBack);
      input.remove();
    };
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(file);
    };
    const onFocusBack = () => {
      cancelTimer = window.setTimeout(() => finish(null), 500);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    window.addEventListener('focus', onFocusBack);
    document.body.appendChild(input);
    input.click();
  });
}

/** Pick exactly one Whiteboard package without routing it through attachments. */
export async function pickWhiteboardPackageFile(): Promise<File | null> {
  if (!isTauri) return pickWebPackage();
  const path = await tauriOpen({
    multiple: false,
    filters: [{ name: WHITEBOARD_UI_TEXT.packageFilter, extensions: ['zip'] }],
  });
  if (!path || Array.isArray(path)) return null;
  return readNativeWhiteboardPackageFile(path);
}
