/**
 * Storage usage estimation utilities.
 *
 * Conversations now live in IndexedDB (via Dexie), not localStorage.
 * `navigator.storage.estimate()` covers ALL browser storage buckets
 * (IndexedDB + localStorage + Cache API + Service Workers), so it's
 * the primary metric. `getLocalStorageUsage()` is kept as a sync
 * fallback for environments where the Estimate API isn't available.
 *
 * Chromium/WebView2 caps the total storage pool at ~60% of disk free
 * space (dynamic), not a fixed 10 MB — so the quota warning at 80%
 * is a much softer signal than it was with localStorage-only.
 */

export interface StorageUsage {
  totalBytes: number;
  totalFormatted: string;
  /** Browser-reported total quota (dynamic in Chromium). */
  quotaBytes: number;
  /** Quota in human-readable form (e.g. "2.3 GB"). */
  quotaFormatted: string;
  /** 0–100 percentage of quota used. */
  percentUsed: number;
}

/** Chromium/WebView2 fallback quota when estimate() is unavailable. */
const FALLBACK_QUOTA = 100 * 1024 * 1024; // 100 MB — conservative

/**
 * Estimate total storage usage across ALL browser storage buckets.
 * Uses `navigator.storage.estimate()` (Chrome 61+, WebView2).
 * Falls back to `getLocalStorageUsage()` if the API is missing or
 * returns zero (which happens in some sandboxed environments).
 */
export async function getStorageUsage(): Promise<StorageUsage> {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    try {
      const est = await navigator.storage.estimate();
      const total = est.usage ?? 0;
      const quota = est.quota ?? FALLBACK_QUOTA;
      if (total > 0 || quota > FALLBACK_QUOTA) {
        return {
          totalBytes: total,
          totalFormatted: formatBytes(total),
          quotaBytes: quota,
          quotaFormatted: formatBytes(quota),
          percentUsed: quota > 0 ? Math.round((total / quota) * 100) : 0,
        };
      }
    } catch {
      // Fall through to localStorage fallback.
    }
  }
  return getLocalStorageUsageFallback();
}

/** Sync localStorage-only estimation — kept as fallback. */
function getLocalStorageUsageFallback(): StorageUsage {
  let totalBytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const value = localStorage.getItem(key) ?? '';
      totalBytes += value.length * 2; // UTF-16 char = 2 bytes
    }
  } catch {
    return { totalBytes: 0, totalFormatted: '0 B', quotaBytes: FALLBACK_QUOTA, quotaFormatted: formatBytes(FALLBACK_QUOTA), percentUsed: 0 };
  }
  return {
    totalBytes,
    totalFormatted: formatBytes(totalBytes),
    quotaBytes: FALLBACK_QUOTA,
    quotaFormatted: formatBytes(FALLBACK_QUOTA),
    percentUsed: FALLBACK_QUOTA > 0 ? Math.round((totalBytes / FALLBACK_QUOTA) * 100) : 0,
  };
}

/**
 * Synchronous localStorage-only usage helper.
 * Prefer `getStorageUsage()` which includes IndexedDB.
 */
export function getLocalStorageUsage(): StorageUsage {
  return getLocalStorageUsageFallback();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  if (gb < 1024) return `${gb.toFixed(1)} GB`;
  return `${(gb / 1024).toFixed(1)} TB`;
}
