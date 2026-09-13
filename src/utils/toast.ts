/**
 * Tiny in-app toast/notification system. Replaces the `alert()` calls
 * scattered through Settings/ModelPicker/etc.
 *
 * Usage:
 *   import { toast } from './toast';
 *   toast.success('Server reachable');
 *   toast.error('Load failed: ...');
 *   toast.info('Reconnecting…');
 *
 * The `<Toaster />` component (in `src/ui/shared/Toaster.tsx`) is the visual
 * host — it subscribes to this store and renders the queue.
 */

import { create } from 'zustand';
import { uid } from './uid.ts';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: string;
  kind: ToastKind;
  title?: string;
  message: string;
  /** Auto-dismiss after this many ms. 0 = sticky. */
  ttl: number;
  /** Unix ms. */
  createdAt: number;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id' | 'createdAt'>) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const DEFAULTS: Record<ToastKind, number> = {
  info: 3500,
  success: 3000,
  error: 6000,
};

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = uid();
    const ttl = t.ttl ?? DEFAULTS[t.kind];
    set((s) => ({
      toasts: [...s.toasts, { id, createdAt: Date.now(), ...t, ttl }],
    }));
    if (ttl > 0) {
      setTimeout(() => get().dismiss(id), ttl);
    }
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** Ergonomic helpers so call sites read naturally. */
export const toast = {
  info: (message: string, opts?: Partial<Omit<Toast, 'id' | 'createdAt' | 'message' | 'kind'>>) =>
    useToasts.getState().push({ kind: 'info', message, ttl: DEFAULTS.info, ...opts }),
  success: (message: string, opts?: Partial<Omit<Toast, 'id' | 'createdAt' | 'message' | 'kind'>>) =>
    useToasts.getState().push({ kind: 'success', message, ttl: DEFAULTS.success, ...opts }),
  error: (message: string, opts?: Partial<Omit<Toast, 'id' | 'createdAt' | 'message' | 'kind'>>) =>
    useToasts.getState().push({ kind: 'error', message, ttl: DEFAULTS.error, ...opts }),
  /** Manually dismiss a toast (e.g. an in-flight "Testing…" that's about to be replaced). */
  dismiss: (id: string) => useToasts.getState().dismiss(id),
  clear: () => useToasts.getState().clear(),
};
