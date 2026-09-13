/**
 * Profile store — owns server profiles.
 * Persisted to localStorage under `lc:profile-store`.
 *
 * Any profile with `active: true` is active. Use `getActiveProfiles()` to
 * get the derived list.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ServerProfile } from '../../types';
import { observableLocalStorage } from '../../store/local-storage.ts';

export const PROFILE_STORE_VERSION = 1 as const;

export interface ProfileState {
  profiles: ServerProfile[];

  /** Mutations — thin setters. Business logic lives in profile-manager. */
  setProfiles: (profiles: ServerProfile[]) => void;
  addProfile: (profile: ServerProfile) => void;
  updateProfile: (id: string, patch: Partial<ServerProfile>) => void;
  removeProfile: (id: string) => void;
}

export const useProfileStore = create<ProfileState>()(
  persist(
    (set) => ({
      profiles: [],

      setProfiles: (profiles) => set({ profiles }),
      addProfile: (profile) =>
        set((s) => ({ profiles: [...s.profiles, profile] })),
      updateProfile: (id, patch) =>
        set((s) => ({
          profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),
      removeProfile: (id) =>
        set((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) })),
    }),
    {
      name: 'lc:profile-store',
      storage: createJSONStorage(() => observableLocalStorage),
      // Version mismatches are rejected; this store has one current schema.
      version: PROFILE_STORE_VERSION,
      partialize: (state) => ({ profiles: state.profiles }),
    },
  ),
);

/**
 * Derived list of all currently toggled-on profiles.
 * The toggle is the active indicator — any profile with `active: true` is
 * active and its models are available.
 * Zero-overhead: reads the store synchronously, no subscription needed.
 */
export function getActiveProfiles(): ServerProfile[] {
  return useProfileStore.getState().profiles.filter((p) => p.active);
}
