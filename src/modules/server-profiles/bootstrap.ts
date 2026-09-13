/**
 * Model bootstrap hook — initializes the app-models store on first launch
 * and keeps it in sync when profiles change.
 *
 * Extracted from App.tsx per Phase 6.
 */
import { useEffect } from 'react';
import { useAppModels, useProfileStore } from '../../modules/server-profiles/index.ts';

export function useModelBootstrap(normalReady: boolean) {
  // Bootstrap the global app-models store on first launch.
  // bootstrap() commits cacheGroups() synchronously after normal startup is
  // ready, then starts the live refresh. Do not refresh during storage initialization.
  useEffect(() => {
    if (!normalReady) return;
    useAppModels.getState().bootstrap();
  }, [normalReady]);

  // Keep the global model store in sync when profiles change.
  useEffect(() => {
    if (!normalReady) return;
    return useProfileStore.subscribe((curr, prev) => {
      if (curr.profiles !== prev.profiles) {
        useAppModels.getState().bootstrap();
      }
    });
  }, [normalReady]);
}
