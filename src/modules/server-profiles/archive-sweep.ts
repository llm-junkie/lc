/**
 * Auto-archive sweep hook — periodically moves idle conversations
 * to the archive when the auto-archive-days setting is enabled.
 *
 * Extracted from App.tsx per Phase 6.
 */
import { useEffect } from 'react';
import { useSettings } from '../../store/settings.ts';
import { autoArchiveSweep } from '../../store/conversations.ts';
import { toast } from '../../utils/toast.ts';

export function useAutoArchiveSweep(normalReady: boolean) {
  const autoArchiveDays = useSettings((s) => s.autoArchiveDays);

  useEffect(() => {
    if (!normalReady) return;
    if (!Number.isFinite(autoArchiveDays) || autoArchiveDays <= 0) return;
    const n = autoArchiveSweep(autoArchiveDays);
    if (n > 0) {
      toast.info(
        `Auto-archived ${n} conversation${n === 1 ? '' : 's'} ` +
        `(idle > ${autoArchiveDays} day${autoArchiveDays === 1 ? '' : 's'})`,
      );
    }
    // Re-sweep every 60s while the app is open.
    const interval = setInterval(() => autoArchiveSweep(autoArchiveDays), 60_000);
    return () => clearInterval(interval);
  }, [autoArchiveDays, normalReady]);
}
