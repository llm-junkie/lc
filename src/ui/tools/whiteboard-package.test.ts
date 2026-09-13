import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import {
  strToU8,
  Unzip,
  UnzipInflate,
  Zip,
  ZipDeflate,
  ZipPassThrough,
  zipSync,
} from 'fflate';
import {
  WHITEBOARD_EXPORT_FIXTURE,
  WHITEBOARD_IMPORT_FILENAME_FIXTURES,
  WHITEBOARD_MAX_BYTES,
  WHITEBOARD_MAX_IMPORT_BYTES,
} from '../../whiteboard/contract-fixtures.ts';
import {
  assertWhiteboardPackageFilename,
  createWhiteboardPackage,
  isWhiteboardPackageFilename,
  readWhiteboardPackage,
  WhiteboardPackageError,
  whiteboardPackageFilename,
  type WhiteboardPackageErrorCode,
} from './whiteboard-package.ts';

const VALID_NAME: string = WHITEBOARD_EXPORT_FIXTURE.requestedFilename;
const ZIP_DATE = new Date(1980, 0, 1);

interface TestEntry {
  name: string;
  data: Uint8Array;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function regularZip(entries: readonly TestEntry[], level: 0 | 6 = 0): Uint8Array {
  return zipSync(
    Object.fromEntries(entries.map((entry) => [entry.name, entry.data])),
    { level, mtime: ZIP_DATE },
  );
}

function streamingZip(entries: readonly TestEntry[], compression: 'store' | 'deflate'): Uint8Array {
  const chunks: Uint8Array[] = [];
  let streamError: Error | null = null;
  const archive = new Zip((error, data) => {
    if (error) streamError = error;
    else chunks.push(data.slice());
  });

  for (const entry of entries) {
    const file: ZipDeflate | ZipPassThrough =
      compression === 'deflate'
        ? new ZipDeflate(entry.name, { level: 6 })
        : new ZipPassThrough(entry.name);
    file.mtime = ZIP_DATE;
    archive.add(file);
    file.push(entry.data, true);
  }
  archive.end();
  if (streamError) throw streamError;
  return concatBytes(chunks);
}

interface InspectedEntry {
  name: string;
  compression: number;
  originalSize: number | undefined;
  data: Uint8Array;
}

function inspectLocalEntries(bytes: Uint8Array): InspectedEntry[] {
  const entries: InspectedEntry[] = [];
  const unzip = new Unzip((file) => {
    const chunks: Uint8Array[] = [];
    const inspected: InspectedEntry = {
      name: file.name,
      compression: file.compression,
      originalSize: file.originalSize,
      data: new Uint8Array(),
    };
    entries.push(inspected);
    file.ondata = (error, data, final) => {
      if (error) throw error;
      chunks.push(data.slice());
      if (final) inspected.data = concatBytes(chunks);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.byteLength; offset += 31) {
    const end = Math.min(offset + 31, bytes.byteLength);
    unzip.push(bytes.subarray(offset, end), end === bytes.byteLength);
  }
  return entries;
}

function setUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function getUint16LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function getUint32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function findSignature(bytes: Uint8Array, signature: number, from = 0): number {
  for (let offset = from; offset <= bytes.byteLength - 4; offset += 1) {
    if (getUint32LE(bytes, offset) === signature) return offset;
  }
  throw new Error(`ZIP signature 0x${signature.toString(16)} not found`);
}

function patchFirstLocalOriginalSize(bytes: Uint8Array, originalSize: number): Uint8Array {
  const copy = bytes.slice();
  const localHeader = findSignature(copy, 0x04034b50);
  setUint32LE(copy, localHeader + 22, originalSize);
  return copy;
}

function rewriteFirstCentralFilename(bytes: Uint8Array, replacement: string): Uint8Array {
  const central = findSignature(bytes, 0x02014b50);
  const end = findSignature(bytes, 0x06054b50, central);
  const oldNameLength = getUint16LE(bytes, central + 28);
  const extraLength = getUint16LE(bytes, central + 30);
  const commentLength = getUint16LE(bytes, central + 32);
  const oldRecordEnd = central + 46 + oldNameLength + extraLength + commentLength;
  const replacementBytes = strToU8(replacement);
  const lengthChange = replacementBytes.byteLength - oldNameLength;
  const rewritten = new Uint8Array(bytes.byteLength + lengthChange);

  rewritten.set(bytes.subarray(0, central + 46));
  new DataView(rewritten.buffer).setUint16(central + 28, replacementBytes.byteLength, true);
  rewritten.set(replacementBytes, central + 46);
  rewritten.set(
    bytes.subarray(central + 46 + oldNameLength, oldRecordEnd),
    central + 46 + replacementBytes.byteLength,
  );
  rewritten.set(bytes.subarray(oldRecordEnd), oldRecordEnd + lengthChange);

  const rewrittenEnd = end + lengthChange;
  setUint32LE(rewritten, rewrittenEnd + 12, getUint32LE(bytes, end + 12) + lengthChange);
  return rewritten;
}

function rawLocalEntry(
  name: string,
  compression: number,
  compressed: Uint8Array,
  originalSize: number,
): Uint8Array {
  const nameBytes = strToU8(name);
  const entry = new Uint8Array(30 + nameBytes.byteLength + compressed.byteLength);
  const view = new DataView(entry.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(8, compression, true);
  view.setUint32(18, compressed.byteLength, true);
  view.setUint32(22, originalSize, true);
  view.setUint16(26, nameBytes.byteLength, true);
  entry.set(nameBytes, 30);
  entry.set(compressed, 30 + nameBytes.byteLength);
  return entry;
}

async function expectPackageError(
  data: Blob | ArrayBuffer | Uint8Array,
  code: WhiteboardPackageErrorCode,
  name = VALID_NAME,
): Promise<void> {
  await assert.rejects(
    readWhiteboardPackage({ name, data }),
    (error: unknown) =>
      error instanceof WhiteboardPackageError &&
      error.code === code &&
      error.message.length > 0 &&
      error.message.length < 100,
  );
}

describe('Whiteboard package filenames', () => {
  test('accepts only the frozen lowercase basename forms and real local timestamps', () => {
    for (const fixture of WHITEBOARD_IMPORT_FILENAME_FIXTURES) {
      assert.equal(isWhiteboardPackageFilename(fixture.name), fixture.accepted, fixture.name);
    }
    for (const invalid of [
      'lc-whiteboard-0000-01-01-0000.zip',
      'lc-whiteboard-2026-13-01-0000.zip',
      'lc-whiteboard-2026-04-31-0000.zip',
      'lc-whiteboard-2026-08-22-2400.zip',
      'lc-whiteboard-2026-08-22-1460.zip',
      'lc-whiteboard-2026-08-22-1430 (0001).zip',
      '../lc-whiteboard-2026-08-22-1430.zip',
    ]) {
      assert.equal(isWhiteboardPackageFilename(invalid), false, invalid);
    }
    assert.equal(isWhiteboardPackageFilename('lc-whiteboard-2024-02-29-2359.zip'), true);
  });

  test('formats the exact local timestamp and rejects unusable dates', () => {
    assert.equal(
      whiteboardPackageFilename(new Date(2026, 7, 22, 14, 30)),
      'lc-whiteboard-2026-08-22-1430.zip',
    );
    assert.throws(() => whiteboardPackageFilename(new Date(Number.NaN)), RangeError);
  });

  test('the import entry point cannot bypass basename validation', async () => {
    const validArchive = regularZip([
      { name: 'model.md', data: strToU8('model') },
      { name: 'user.md', data: strToU8('user') },
    ]);
    assert.throws(
      () => assertWhiteboardPackageFilename('renamed.zip'),
      (error: unknown) =>
        error instanceof WhiteboardPackageError
        && error.code === 'invalid_filename'
        && error.message.includes('lc-whiteboard-YYYY-MM-DD-HHmm.zip')
        && error.message.includes('lc-whiteboard-YYYY-MM-DD-HHmm (1).zip'),
    );
    await expectPackageError(validArchive, 'invalid_filename', 'renamed.zip');
  });
});

describe('Whiteboard package export', () => {
  test('contains exactly the two root Markdown entries and uses DEFLATE', async () => {
    const blob = createWhiteboardPackage({
      modelMarkdown: WHITEBOARD_EXPORT_FIXTURE.entries['model.md'],
      userMarkdown: WHITEBOARD_EXPORT_FIXTURE.entries['user.md'],
    });
    assert.equal(blob.type, 'application/zip');

    const entries = inspectLocalEntries(new Uint8Array(await blob.arrayBuffer()));
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['model.md', 'user.md'],
    );
    assert.deepEqual(
      entries.map((entry) => entry.compression),
      [8, 8],
    );
    assert.deepEqual(
      entries.map((entry) => new TextDecoder().decode(entry.data)),
      [WHITEBOARD_EXPORT_FIXTURE.entries['model.md'], WHITEBOARD_EXPORT_FIXTURE.entries['user.md']],
    );
  });

  test('captures immutable visible values at invocation time', async () => {
    const visible = { modelMarkdown: 'model at click', userMarkdown: 'user at click' };
    const blob = createWhiteboardPackage(visible);
    visible.modelMarkdown = 'later model';
    visible.userMarkdown = 'later user';

    assert.deepEqual(await readWhiteboardPackage({ name: VALID_NAME, data: blob }), {
      modelMarkdown: 'model at click',
      userMarkdown: 'user at click',
    });
  });

  test('bounds raw visible values before UTF-8 allocation and compression', async () => {
    const exact = 'a'.repeat(WHITEBOARD_MAX_BYTES);
    const blob = createWhiteboardPackage({ modelMarkdown: exact, userMarkdown: '' });
    assert.deepEqual(await readWhiteboardPackage({ name: VALID_NAME, data: blob }), {
      modelMarkdown: exact,
      userMarkdown: '',
    });

    for (const overLimit of [
      'a'.repeat(WHITEBOARD_MAX_BYTES + 1),
      'é'.repeat((WHITEBOARD_MAX_BYTES / 2) + 1),
    ]) {
      assert.throws(
        () => createWhiteboardPackage({ modelMarkdown: '', userMarkdown: overLimit }),
        (error: unknown) =>
          error instanceof WhiteboardPackageError && error.code === 'entry_too_large',
      );
    }
  });
});

describe('bounded streaming Whiteboard package import', () => {
  test('round-trips stored, DEFLATE, and streaming archives with unknown header sizes', async () => {
    const expected = { modelMarkdown: '# model', userMarkdown: '# user' };
    for (const archive of [
      regularZip(
        [
          { name: 'model.md', data: strToU8(expected.modelMarkdown) },
          { name: 'user.md', data: strToU8(expected.userMarkdown) },
        ],
        0,
      ),
      regularZip(
        [
          { name: 'model.md', data: strToU8(expected.modelMarkdown) },
          { name: 'user.md', data: strToU8(expected.userMarkdown) },
        ],
        6,
      ),
      streamingZip(
        [
          { name: 'model.md', data: strToU8(expected.modelMarkdown) },
          { name: 'user.md', data: strToU8(expected.userMarkdown) },
        ],
        'deflate',
      ),
    ]) {
      assert.deepEqual(await readWhiteboardPackage({ name: VALID_NAME, data: archive }), expected);
    }

    const streaming = streamingZip(
      [
        { name: 'model.md', data: strToU8(expected.modelMarkdown) },
        { name: 'user.md', data: strToU8(expected.userMarkdown) },
      ],
      'store',
    );
    assert.deepEqual(
      inspectLocalEntries(streaming).map((entry) => entry.originalSize),
      [undefined, undefined],
    );
    assert.deepEqual(await readWhiteboardPackage({ name: VALID_NAME, data: streaming }), expected);
  });

  test('uses local entries as authority when the central directory has a traversal alias', async () => {
    const archive = regularZip([
      { name: 'model.md', data: strToU8('model') },
      { name: 'user.md', data: strToU8('user') },
    ]);
    const centralAlias = rewriteFirstCentralFilename(archive, '../model.md');
    assert.deepEqual(await readWhiteboardPackage({ name: VALID_NAME, data: centralAlias }), {
      modelMarkdown: 'model',
      userMarkdown: 'user',
    });
  });

  test('rejects the compressed input before reading a Blob body', async () => {
    let bodyRead = false;
    const oversized = {
      size: WHITEBOARD_MAX_IMPORT_BYTES + 1,
      type: 'application/zip',
      arrayBuffer: async () => {
        bodyRead = true;
        return new ArrayBuffer(0);
      },
    };
    Object.setPrototypeOf(oversized, Blob.prototype);
    await expectPackageError(oversized as Blob, 'compressed_too_large');
    assert.equal(bodyRead, false);
  });

  test('rejects every frozen package rejection class', async (t: TestContext) => {
    const model = (content: string | Uint8Array): TestEntry => ({
      name: 'model.md',
      data: typeof content === 'string' ? strToU8(content) : content,
    });
    const user = (content: string | Uint8Array): TestEntry => ({
      name: 'user.md',
      data: typeof content === 'string' ? strToU8(content) : content,
    });

    const cases: Array<{
      name: string;
      code: WhiteboardPackageErrorCode;
      archive: () => Blob | ArrayBuffer | Uint8Array;
    }> = [
      {
        name: 'compressed input above 128 KiB',
        code: 'compressed_too_large',
        archive: () => new Uint8Array(WHITEBOARD_MAX_IMPORT_BYTES + 1),
      },
      {
        name: 'missing model.md',
        code: 'invalid_entries',
        archive: () => regularZip([user('user')]),
      },
      {
        name: 'missing user.md',
        code: 'invalid_entries',
        archive: () => regularZip([model('model')]),
      },
      {
        name: 'duplicate model.md',
        code: 'invalid_entries',
        archive: () => streamingZip([model('one'), model('two'), user('user')], 'store'),
      },
      {
        name: 'unexpected root entry',
        code: 'invalid_entries',
        archive: () =>
          regularZip([model('model'), user('user'), { name: 'notes.md', data: strToU8('no') }]),
      },
      {
        name: 'nested entry',
        code: 'invalid_entries',
        archive: () =>
          regularZip([model('model'), user('user'), { name: 'nested/x', data: strToU8('no') }]),
      },
      {
        name: 'directory entry',
        code: 'invalid_entries',
        archive: () =>
          regularZip([model('model'), user('user'), { name: 'folder/', data: new Uint8Array() }]),
      },
      {
        name: 'absolute entry',
        code: 'invalid_entries',
        archive: () =>
          regularZip([model('model'), user('user'), { name: '/absolute', data: strToU8('no') }]),
      },
      {
        name: 'traversal entry',
        code: 'invalid_entries',
        archive: () =>
          regularZip([model('model'), user('user'), { name: '../escape', data: strToU8('no') }]),
      },
      {
        name: 'entry output above 32 KiB',
        code: 'entry_too_large',
        archive: () => regularZip([model(new Uint8Array(WHITEBOARD_MAX_BYTES + 1)), user('user')]),
      },
      {
        name: 'combined output above 64 KiB',
        code: 'output_too_large',
        archive: () =>
          streamingZip(
            [
              model(new Uint8Array(WHITEBOARD_MAX_BYTES)),
              user(new Uint8Array(WHITEBOARD_MAX_BYTES + 1)),
            ],
            'deflate',
          ),
      },
      {
        name: 'invalid UTF-8',
        code: 'invalid_utf8',
        archive: () => regularZip([model(new Uint8Array([0xc3, 0x28])), user('user')]),
      },
      {
        name: 'malformed compression',
        code: 'invalid_package',
        archive: () => rawLocalEntry('model.md', 8, new Uint8Array([0x03, 0xff, 0x00]), 1),
      },
      {
        name: 'unsupported compression',
        code: 'invalid_package',
        archive: () => rawLocalEntry('model.md', 99, new Uint8Array([0]), 1),
      },
      {
        name: 'both documents empty',
        code: 'empty_documents',
        archive: () => regularZip([model(''), user('')]),
      },
    ];

    for (const fixture of cases) {
      await t.test(fixture.name, () => expectPackageError(fixture.archive(), fixture.code));
    }
  });

  test('does not trust an understated local originalSize hint', async () => {
    const archive = regularZip([
      { name: 'model.md', data: new Uint8Array(WHITEBOARD_MAX_BYTES + 1) },
      { name: 'user.md', data: strToU8('user') },
    ]);
    const understated = patchFirstLocalOriginalSize(archive, 1);
    assert.equal(inspectLocalEntries(understated)[0]?.originalSize, 1);
    await expectPackageError(understated, 'entry_too_large');
  });

  test('accepts exact byte limits and whitespace as document content', async () => {
    const archive = streamingZip(
      [
        { name: 'model.md', data: strToU8(' '.repeat(WHITEBOARD_MAX_BYTES)) },
        { name: 'user.md', data: strToU8('x'.repeat(WHITEBOARD_MAX_BYTES)) },
      ],
      'deflate',
    );
    const result = await readWhiteboardPackage({ name: VALID_NAME, data: archive });
    assert.equal(result.modelMarkdown.length, WHITEBOARD_MAX_BYTES);
    assert.equal(result.userMarkdown.length, WHITEBOARD_MAX_BYTES);
  });
});
