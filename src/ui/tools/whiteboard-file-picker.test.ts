import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  readNativeWhiteboardPackageFile,
  WHITEBOARD_NATIVE_FILE_ERROR_CODES,
  type NativeWhiteboardFileInvoker,
} from './whiteboard-file-picker.ts';
import {
  WHITEBOARD_PACKAGE_MAX_COMPRESSED_BYTES,
  WhiteboardPackageError,
} from './whiteboard-package.ts';
import { WHITEBOARD_UI_TEXT } from './whiteboard-ui-text.ts';

describe('native Whiteboard package picker', () => {
  test('uses the bounded native command with the frozen compressed-input cap', async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const invokeFile: NativeWhiteboardFileInvoker = async (command, args) => {
      calls.push({ command, args });
      return {
        name: 'lc-whiteboard-2026-08-22-1530.zip',
        mime: 'application/zip',
        size: 4,
        bytes: [0x50, 0x4b, 0x03, 0x04],
      };
    };

    const file = await readNativeWhiteboardPackageFile('C:\\packages\\board.zip', invokeFile);

    assert.deepEqual(calls, [{
      command: 'read_bounded_file',
      args: {
        path: 'C:\\packages\\board.zip',
        maxBytes: WHITEBOARD_PACKAGE_MAX_COMPRESSED_BYTES,
      },
    }]);
    assert.equal(file.name, 'lc-whiteboard-2026-08-22-1530.zip');
    assert.equal(file.type, 'application/zip');
    assert.equal(file.size, 4);
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04]);
  });

  test('defensively rejects an oversized native response before copying its bytes', async () => {
    const invokeFile: NativeWhiteboardFileInvoker = async () => ({
      name: 'lc-whiteboard-2026-08-22-1530.zip',
      mime: 'application/zip',
      size: WHITEBOARD_PACKAGE_MAX_COMPRESSED_BYTES + 1,
      bytes: [],
    });

    await assert.rejects(
      readNativeWhiteboardPackageFile('oversized.zip', invokeFile),
      (error: unknown) =>
        error instanceof WhiteboardPackageError && error.code === 'compressed_too_large',
    );
  });

  test('defensively rejects oversized native bytes even when reported size is stale', async () => {
    const invokeFile: NativeWhiteboardFileInvoker = async () => ({
      name: 'lc-whiteboard-2026-08-22-1530.zip',
      mime: 'application/zip',
      size: 0,
      bytes: new Array(WHITEBOARD_PACKAGE_MAX_COMPRESSED_BYTES + 1).fill(0),
    });

    await assert.rejects(
      readNativeWhiteboardPackageFile('oversized.zip', invokeFile),
      (error: unknown) =>
        error instanceof WhiteboardPackageError && error.code === 'compressed_too_large',
    );
  });

  test('maps the bounded native ceiling code to the package size error', async () => {
    const invokeFile: NativeWhiteboardFileInvoker = async () => {
      throw WHITEBOARD_NATIVE_FILE_ERROR_CODES.tooLarge;
    };

    await assert.rejects(
      readNativeWhiteboardPackageFile('oversized.zip', invokeFile),
      (error: unknown) =>
        error instanceof WhiteboardPackageError && error.code === 'compressed_too_large',
    );
  });

  test('does not expose native filesystem errors through the import UI', async () => {
    const invokeFile: NativeWhiteboardFileInvoker = async () => {
      throw WHITEBOARD_NATIVE_FILE_ERROR_CODES.readFailed;
    };

    await assert.rejects(
      readNativeWhiteboardPackageFile('missing.zip', invokeFile),
      (error: unknown) =>
        error instanceof Error && error.message === WHITEBOARD_UI_TEXT.nativePackageReadFailed,
    );
  });
});
