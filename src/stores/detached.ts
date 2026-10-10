import { create } from "zustand";
import { isDetachablePanel, type DetachablePanel } from "../windows/protocol";

interface DetachedState {
  /** Panels currently shown in a window of their own. Never persisted: every session starts docked. */
  detached: Partial<Record<DetachablePanel, boolean>>;
  markDetached: (panel: DetachablePanel) => void;
  markDocked: (panel: string) => void;
  reset: () => void;
}

export const useDetachedStore = create<DetachedState>((set) => ({
  detached: {},

  markDetached: (panel) => set((s) => ({ detached: { ...s.detached, [panel]: true } })),

  markDocked: (panel) => {
    if (!isDetachablePanel(panel)) return;
    set((s) => {
      const { [panel]: _gone, ...rest } = s.detached;
      return { detached: rest };
    });
  },

  reset: () => set({ detached: {} }),
}));
