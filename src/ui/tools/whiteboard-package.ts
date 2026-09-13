import { strToU8, Unzip, UnzipInflate, zipSync } from 'fflate';

const MODEL_ENTRY = 'model.md';
const USER_ENTRY = 'user.md';
const REQUIRED_ENTRIES = new Set([MODEL_ENTRY, USER_ENTRY]);
const INPUT_CHUNK_BYTES = 512;

export const WHITEBOARD_PACKAGE_MAX_COMPRESSED_BYTES = 128 * 1024;
export const WHITEBOARD_PACKAGE_MAX_ENTRY_BYTES = 32 * 1024;
export const WHITEBOARD_PACKAGE_MAX_OUTPUT_BYTES = 64 * 1024;

export type WhiteboardPackageErrorCode =
  | 'invalid_filename'
  | 'compressed_too_large'
  | 'invalid_package'
  | 'invalid_entries'
  | 'entry_too_large'
  | 'output_too_large'
  | 'invalid_utf8'
  | 'empty_documents';

export const WHITEBOARD_PACKAGE_ERROR_MESSAGES: Readonly<
  Record<WhiteboardPackageErrorCode, string>
> = Object.freeze({
  invalid_filename: 'Restore the name to lc-whiteboard-YYYY-MM-DD-HHmm.zip or lc-whiteboard-YYYY-MM-DD-HHmm (1).zip.',
  compressed_too_large: 'The Whiteboard package exceeds 128 KiB.',
  invalid_package: 'The Whiteboard package is invalid or unsupported.',
  invalid_entries: 'The Whiteboard package must contain only model.md and user.md.',
  entry_too_large: 'A Whiteboard document exceeds 32 KiB.',
  output_too_large: 'The Whiteboard documents exceed 64 KiB combined.',
  invalid_utf8: 'The Whiteboard documents are not valid UTF-8.',
  empty_documents: 'The Whiteboard package contains no document content.',
});

export class WhiteboardPackageError extends Error {
  readonly code: WhiteboardPackageErrorCode;

  constructor(code: WhiteboardPackageErrorCode) {
    super(WHITEBOARD_PACKAGE_ERROR_MESSAGES[code]);
    this.name = 'WhiteboardPackageError';
    this.code = code;
  }
}

export interface WhiteboardPackageDocuments {
  modelMarkdown: string;
  userMarkdown: string;
}

export type WhiteboardPackageData = Blob | ArrayBuffer | Uint8Array;

export interface WhiteboardPackageInput {
  name: string;
  data: WhiteboardPackageData;
}

const PACKAGE_FILENAME_PATTERN =
  /^lc-whiteboard-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?: \(([1-9]\d{0,3})\))?\.zip$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

export function isWhiteboardPackageFilename(name: string): boolean {
  const match = PACKAGE_FILENAME_PATTERN.exec(name);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);

  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59
  );
}

export function assertWhiteboardPackageFilename(name: string): void {
  if (!isWhiteboardPackageFilename(name)) {
    throw new WhiteboardPackageError('invalid_filename');
  }
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

export function whiteboardPackageFilename(at: Date = new Date()): string {
  const year = at.getFullYear();
  if (!Number.isFinite(at.getTime()) || year < 1 || year > 9999) {
    throw new RangeError('Whiteboard export date must have a four-digit calendar year.');
  }

  return (
    `lc-whiteboard-${String(year).padStart(4, '0')}-` +
    `${twoDigits(at.getMonth() + 1)}-${twoDigits(at.getDate())}-` +
    `${twoDigits(at.getHours())}${twoDigits(at.getMinutes())}.zip`
  );
}

/** Captures both supplied visible values synchronously into one immutable ZIP Blob. */
export function createWhiteboardPackage(documents: WhiteboardPackageDocuments): Blob {
  const encodeDocument = (markdown: string): Uint8Array => {
    // Every UTF-16 code unit needs at least one UTF-8 byte. Rejecting this
    // cheap upper-bound first keeps TextEncoder and compression bounded even
    // when a caller supplies an arbitrarily large raw editor value.
    if (markdown.length > WHITEBOARD_PACKAGE_MAX_ENTRY_BYTES) {
      throw new WhiteboardPackageError('entry_too_large');
    }
    const bytes = strToU8(markdown);
    if (bytes.byteLength > WHITEBOARD_PACKAGE_MAX_ENTRY_BYTES) {
      throw new WhiteboardPackageError('entry_too_large');
    }
    return bytes;
  };
  const modelBytes = encodeDocument(documents.modelMarkdown);
  const userBytes = encodeDocument(documents.userMarkdown);
  const archive = zipSync(
    {
      [MODEL_ENTRY]: modelBytes,
      [USER_ENTRY]: userBytes,
    },
    { level: 6, mtime: new Date(1980, 0, 1) },
  );
  return new Blob([archive], { type: 'application/zip' });
}

function packageError(code: WhiteboardPackageErrorCode): WhiteboardPackageError {
  return new WhiteboardPackageError(code);
}

function copyBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy;
  }
  return new Uint8Array(data.slice(0));
}

function joinChunks(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function decodeDocument(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw packageError('invalid_utf8');
  }
}

function parseWhiteboardPackage(bytes: Uint8Array): WhiteboardPackageDocuments {
  const seen = new Set<string>();
  const completed = new Map<string, Uint8Array>();
  let totalOutputBytes = 0;
  let failure: WhiteboardPackageError | null = null;

  const fail = (code: WhiteboardPackageErrorCode): void => {
    failure ??= packageError(code);
  };

  const unzip = new Unzip((file) => {
    if (failure) return;

    if (!REQUIRED_ENTRIES.has(file.name) || seen.has(file.name)) {
      fail('invalid_entries');
      return;
    }
    seen.add(file.name);

    if (
      typeof file.originalSize === 'number' &&
      file.originalSize > WHITEBOARD_PACKAGE_MAX_ENTRY_BYTES
    ) {
      fail('entry_too_large');
      return;
    }

    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    file.ondata = (error, data, final) => {
      if (failure) return;
      if (error) {
        fail('invalid_package');
        return;
      }

      const nextTotalBytes = totalOutputBytes + data.byteLength;
      if (nextTotalBytes > WHITEBOARD_PACKAGE_MAX_OUTPUT_BYTES) {
        fail('output_too_large');
        return;
      }
      const nextEntryBytes = entryBytes + data.byteLength;
      if (nextEntryBytes > WHITEBOARD_PACKAGE_MAX_ENTRY_BYTES) {
        fail('entry_too_large');
        return;
      }

      if (data.byteLength > 0) chunks.push(data.slice());
      entryBytes = nextEntryBytes;
      totalOutputBytes = nextTotalBytes;
      if (final) completed.set(file.name, joinChunks(chunks, entryBytes));
    };

    try {
      file.start();
    } catch {
      fail('invalid_package');
    }
  });
  unzip.register(UnzipInflate);

  try {
    if (bytes.byteLength === 0) {
      unzip.push(bytes, true);
    } else {
      for (let offset = 0; offset < bytes.byteLength && !failure; offset += INPUT_CHUNK_BYTES) {
        const end = Math.min(offset + INPUT_CHUNK_BYTES, bytes.byteLength);
        unzip.push(bytes.subarray(offset, end), end === bytes.byteLength);
      }
    }
  } catch {
    fail('invalid_package');
  }

  if (failure) throw failure;
  if (
    seen.size !== REQUIRED_ENTRIES.size ||
    completed.size !== REQUIRED_ENTRIES.size ||
    !completed.has(MODEL_ENTRY) ||
    !completed.has(USER_ENTRY)
  ) {
    throw packageError('invalid_entries');
  }

  const modelMarkdown = decodeDocument(completed.get(MODEL_ENTRY)!);
  const userMarkdown = decodeDocument(completed.get(USER_ENTRY)!);
  if (modelMarkdown.length === 0 && userMarkdown.length === 0) {
    throw packageError('empty_documents');
  }
  return { modelMarkdown, userMarkdown };
}

/** Validates the basename before reading any package data, then validates the ZIP fully. */
export async function readWhiteboardPackage(
  input: WhiteboardPackageInput,
): Promise<WhiteboardPackageDocuments> {
  assertWhiteboardPackageFilename(input.name);

  let bytes: Uint8Array;
  if (input.data instanceof Blob) {
    if (input.data.size > WHITEBOARD_PACKAGE_MAX_COMPRESSED_BYTES) {
      throw packageError('compressed_too_large');
    }
    bytes = new Uint8Array(await input.data.arrayBuffer());
  } else {
    if (input.data.byteLength > WHITEBOARD_PACKAGE_MAX_COMPRESSED_BYTES) {
      throw packageError('compressed_too_large');
    }
    bytes = copyBytes(input.data);
  }

  if (bytes.byteLength > WHITEBOARD_PACKAGE_MAX_COMPRESSED_BYTES) {
    throw packageError('compressed_too_large');
  }
  return parseWhiteboardPackage(bytes);
}
