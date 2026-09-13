/**
 * Sanitize a string for use as a filename. Strips characters that are
 * illegal on Windows/macOS/Linux filesystems and caps the length so
 * long chat titles don't blow past OS path limits.
 *
 * Shared between the single-conversation export and the bulk
 * conversations export so the filename style is consistent.
 */
export function sanitizeFileName(s: string): string {
  return s.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 64) || 'conversation';
}

/**
 * Format the local wall-clock time used by every LC-generated export.
 * Keeping the minute in the filename avoids same-day exports looking
 * indistinguishable while matching the timestamp shown to the user.
 */
export function formatExportTimestamp(date = new Date()): string {
  if (!Number.isFinite(date.getTime())) return '1970-01-01-0000';

  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}-${hours}${minutes}`;
}

/** Build an LC-owned export filename with its timestamp immediately before the extension. */
export function lcExportFileName(
  descriptor: string,
  extension: string,
  date = new Date(),
): string {
  const normalizedExtension = extension.replace(/^\.+/, '');
  return `lc-${descriptor}-${formatExportTimestamp(date)}.${normalizedExtension}`;
}
