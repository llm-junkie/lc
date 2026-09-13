/**
 * Minimal IndexedDB wrapper for attachment blobs. localStorage is
 * synchronous and ~5MB-capped, which kills us on screenshot-heavy
 * conversations; IDB is async and effectively unlimited for our use case.
 *
 * Schema:
 *   db "lc"
 *     store "attachments" (keyPath: "id")
 *       value: { id, blob, mime, name, size, createdAt }
 *
 * On load we re-hydrate `dataUrl` lazily via `loadAttachmentDataUrl(id)`
 * so the persisted Conversation shape stays small.
 *
 * Every blob mutation that changes a row records exactly one durable-write
 * outcome in the same `storage-write-*` vocabulary as the conversation
 * database (store/db.ts); a mutation that finds nothing to change records
 * nothing, matching the conversation-side contract. Reads are deliberately
 * uninstrumented: hydration reads run per rendered bubble and would flood
 * the diagnostic ring.
 */

import { recordStorageOutcome } from '../store/storage-outcomes.ts';

const DB_NAME = 'lc';
const DB_VERSION = 1;
const STORE = 'attachments';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
  });
  return dbPromise;
}

export interface StoredAttachment {
  id: string;
  blob: Blob;
  mime: string;
  name: string;
  size: number;
  createdAt: number;
}

/**
 * Run one blob-store mutation and record exactly one durable-write outcome
 * when it changes a row. Mirrors `durableWrite` in store/db.ts: success and
 * failure both close the code, and a call that changes nothing records
 * nothing rather than claiming a write that did not happen.
 */
async function blobWrite(run: () => Promise<boolean>): Promise<void> {
  let changed: boolean;
  try {
    changed = await run();
  } catch (error) {
    recordStorageOutcome('durable-write', false);
    throw error;
  }
  if (changed) recordStorageOutcome('durable-write', true);
}

/** Persist a blob to IDB. Resolves once the transaction commits. */
export async function putAttachment(
  id: string,
  blob: Blob,
  meta: { mime: string; name: string; size: number },
): Promise<void> {
  const db = await openDb();
  await blobWrite(() => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({
      id,
      blob,
      mime: meta.mime,
      name: meta.name,
      size: meta.size,
      createdAt: Date.now(),
    });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error ?? new Error('IDB write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB write aborted'));
  }));
}

export interface AttachmentWrite {
  id: string;
  blob: Blob;
  mime: string;
  name: string;
  size: number;
}

/** Install one archive bundle's attachment bytes as one blob-store unit. */
export async function putAttachments(entries: readonly AttachmentWrite[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDb();
  await blobWrite(() => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const createdAt = Date.now();
    for (const entry of entries) store.put({ ...entry, createdAt });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error ?? new Error('IDB archive attachment write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB archive attachment write aborted'));
  }));
}

/** Load the complete stored row needed to compensate a failed archive import. */
export async function loadStoredAttachment(id: string): Promise<StoredAttachment | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve((req.result as StoredAttachment | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('IDB attachment snapshot failed'));
  });
}

export interface AttachmentRollbackRow {
  id: string;
  previous: StoredAttachment | null;
}

/** Restore overwritten rows (or remove newly introduced rows) in one unit. */
export async function restoreAttachmentRows(
  rows: readonly AttachmentRollbackRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = await openDb();
  await blobWrite(() => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const row of rows) {
      if (row.previous) store.put(row.previous);
      else store.delete(row.id);
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error ?? new Error('IDB attachment rollback failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB attachment rollback aborted'));
  }));
}

/**
 * Load a single attachment and return the raw Blob. Used by the
 * archive exporter (we want the bytes themselves, not a base64 string).
 * Returns null if the id is unknown or the blob is missing.
 */
export async function loadAttachment(id: string): Promise<Blob | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => {
      const rec = req.result as StoredAttachment | undefined;
      if (!rec?.blob) {
        resolve(null);
        return;
      }
      resolve(rec.blob);
    };
    req.onerror = () => reject(req.error ?? new Error('IDB read failed'));
  });
}

/** Load a single attachment and return a base64 data URL for `<img src=...>`. */
export async function loadAttachmentDataUrl(id: string): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => {
      const rec = req.result as StoredAttachment | undefined;
      if (!rec?.blob) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsDataURL(rec.blob);
    };
    req.onerror = () => reject(req.error ?? new Error('IDB read failed'));
  });
}

/** Delete a single attachment. No-op — and no storage event — if it doesn't exist. */
export async function deleteAttachment(id: string): Promise<void> {
  const db = await openDb();
  await blobWrite(() => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let changed = false;
    const read = store.get(id);
    read.onsuccess = () => {
      if (read.result !== undefined) {
        store.delete(id);
        changed = true;
      }
    };
    read.onerror = () => reject(read.error ?? new Error('IDB read failed'));
    tx.oncomplete = () => resolve(changed);
    tx.onerror = () => reject(tx.error ?? new Error('IDB delete failed'));
  }));
}

/** Bulk-delete by id list — used when a conversation is removed.
 *  Records nothing when no listed id exists. */
export async function deleteAttachments(ids: string[]): Promise<void> {
  // An empty list performs no transaction and therefore records nothing.
  if (ids.length === 0) return;
  const db = await openDb();
  await blobWrite(() => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let changed = false;
    for (const id of ids) {
      const read = store.get(id);
      read.onsuccess = () => {
        if (read.result !== undefined) {
          store.delete(id);
          changed = true;
        }
      };
      read.onerror = () => reject(read.error ?? new Error('IDB read failed'));
    }
    tx.oncomplete = () => resolve(changed);
    tx.onerror = () => reject(tx.error ?? new Error('IDB bulk delete failed'));
  }));
}

/**
 * Delete rows that no durable message references and that predate this process.
 *
 * The created-at check is repeated inside the write transaction. If an import
 * reuses an old orphan's ID after the startup scan, its replacement row has a
 * new timestamp and cannot be removed by the late sweep.
 */
export async function deleteUnreferencedAttachments(
  referencedIds: ReadonlySet<string>,
  createdBefore: number,
): Promise<void> {
  const db = await openDb();
  await blobWrite(() => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let changed = false;
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) return;
      const row = current.value as StoredAttachment;
      if (!referencedIds.has(row.id) && row.createdAt < createdBefore) {
        current.delete();
        changed = true;
      }
      current.continue();
    };
    cursor.onerror = () => reject(cursor.error ?? new Error('IDB orphan scan failed'));
    tx.oncomplete = () => resolve(changed);
    tx.onerror = () => reject(tx.error ?? new Error('IDB orphan cleanup failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB orphan cleanup aborted'));
  }));
}

/** Delete every attachment — used by "clear all conversations".
 *  Records nothing when the store is already empty. */
export async function clearAttachments(): Promise<void> {
  const db = await openDb();
  await blobWrite(() => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let changed = false;
    const count = store.count();
    count.onsuccess = () => {
      if (count.result > 0) {
        store.clear();
        changed = true;
      }
    };
    count.onerror = () => reject(count.error ?? new Error('IDB count failed'));
    tx.oncomplete = () => resolve(changed);
    tx.onerror = () => reject(tx.error ?? new Error('IDB clear failed'));
  }));
}
