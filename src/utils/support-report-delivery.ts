/** One-payload delivery helpers for support-report preview, copy, and save. */

import { saveBlobFile } from './saveBlob.ts';
import type { SupportReportSnapshot } from './support-report-base';

export type ClipboardWrite = (text: string) => Promise<void>;
export type SupportReportSave = (
  defaultName: string,
  data: string,
  filters: Array<{ name: string; extensions: string[] }>,
) => Promise<boolean>;

/** The preview consumes this exact immutable string directly. */
export function supportReportPreviewText(snapshot: SupportReportSnapshot): string {
  return snapshot.serialized;
}

export async function copySupportReport(
  snapshot: SupportReportSnapshot,
  write: ClipboardWrite = (text) => navigator.clipboard.writeText(text),
): Promise<void> {
  await write(snapshot.serialized);
}

export async function saveSupportReport(
  snapshot: SupportReportSnapshot,
  save: SupportReportSave = saveBlobFile,
): Promise<boolean> {
  return save(snapshot.filename, snapshot.serialized, [{ name: 'JSON', extensions: ['json'] }]);
}

export function supportReportBytes(snapshot: SupportReportSnapshot): Uint8Array {
  return new TextEncoder().encode(snapshot.serialized);
}
