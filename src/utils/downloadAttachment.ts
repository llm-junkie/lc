/**
 * Per-attachment download helper. Loads the original bytes from
 * IndexedDB and saves them to a user-chosen file via the native OS
 * save dialog (Tauri) or an anchor download (web dev mode).
 *
 * The flow mirrors the existing `saveBlobFile` plumbing in saveBlob.ts
 * but is attachment-aware: it owns the IDB lookup, the error-toast
 * surfacing, and the "user clicked the missing-file button anyway"
 * guard (returns `unavailable` so the caller can update UI).
 */

import type { Attachment } from '../types';
import { loadAttachment } from './idb.ts';
import { saveBlobFile } from './saveBlob.ts';
import { toast } from './toast.ts';

/** Result of a download attempt — the UI uses this to update
 *  inline state if needed (currently just a future-proofing shape;
 *  callers don't have to look at it). */
export type DownloadResult =
  | { kind: 'saved'; path?: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

/**
 * Download an attachment's bytes to a user-chosen file. Returns a
 * structured result rather than throwing so the UI can show inline
 * feedback; toast.error is also fired on `unavailable` / `error` so
 * the user always gets a signal even if the caller ignores the result.
 */
export async function downloadAttachment(a: Attachment): Promise<DownloadResult> {
  let blob: Blob | null;
  try {
    blob = await loadAttachment(a.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    toast.error(`Could not read ${a.name}: ${msg}`);
    return { kind: 'error', message: msg };
  }
  if (!blob) {
    // Bytes are gone from IDB, for example after a manual storage clear
    // or when an archive carried attachment metadata without file bytes.
    toast.error(`${a.name} is no longer available for download.`);
    return { kind: 'unavailable' };
  }

  const ext = a.name.includes('.') ? a.name.split('.').pop()!.toLowerCase() : '';
  const filter = ext
    ? [{ name: `${ext.toUpperCase()} file`, extensions: [ext] }]
    : [{ name: 'File', extensions: ['*'] }];

  try {
    const saved = await saveBlobFile(a.name, blob, filter);
    if (!saved) return { kind: 'cancelled' };
    return { kind: 'saved' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    toast.error(`Could not save ${a.name}: ${msg}`);
    return { kind: 'error', message: msg };
  }
}
