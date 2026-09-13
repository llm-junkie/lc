import { loadReferencedAttachmentIds } from './db.ts';
import { deleteUnreferencedAttachments } from '../utils/idb.ts';

/**
 * Reclaim staged attachment blobs whose in-memory draft owner disappeared when
 * the previous process ended. Durable message references are authoritative.
 *
 * This assumes LC has one live app instance per IndexedDB origin. Before
 * multi-window or shared-browser-tab operation is supported, staged owners
 * need an instance lease/marker so a newer instance cannot collect another
 * live instance's in-memory drafts.
 */
export async function reclaimRestartOrphanedAttachments(
  processStartedAt: number,
): Promise<void> {
  const referenced = await loadReferencedAttachmentIds();
  await deleteUnreferencedAttachments(referenced, processStartedAt);
}
