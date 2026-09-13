/**
 * Ephemeral tool UI state — isolated from the main stores so
 * frequent toggles (pulse indicator, running flag) don't cause
 * full ChatView re-renders.  Only PreviewOverlay subscribes.
 */
import { create } from 'zustand';

interface ToolActivityState {
  toolsRunning: boolean;
  setToolsRunning: (v: boolean) => void;
}

export const useToolActivity = create<ToolActivityState>((set) => ({
  toolsRunning: false,
  setToolsRunning: (v) => set({ toolsRunning: v }),
}));
