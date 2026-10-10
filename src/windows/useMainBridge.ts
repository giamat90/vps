import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { closeDetachedPanel, closeDetachedWindows } from "../lib/tauri";
import { useAnalysisStore } from "../stores/analysis";
import { useDetachedStore } from "../stores/detached";
import { usePracticePanels } from "../stores/panels";
import { usePlayerStore } from "../stores/player";
import { startMainBridge } from "./mainBridge";
import { panelsToClose } from "./panelsToClose";
import { EVT_DOCKED } from "./protocol";
import { createSpectrumFeed } from "./spectrumFeed";
import { getLocalSpectrumSource } from "./spectrumRegistry";

/**
 * Lets the practice room feed panels that were dragged out into their own
 * windows. Costs nothing until one is opened; leaving the room closes them,
 * since they would otherwise keep showing a song that is no longer loaded.
 */
export function useMainBridge(): void {
  useEffect(() => {
    let cancelled = false;
    let bridge: { dispose(): void } | null = null;

    const spectrum = createSpectrumFeed({
      source: getLocalSpectrumSource(),
      getPlayer: () => usePlayerStore.getState(),
      getAnalysis: () => useAnalysisStore.getState(),
    });

    startMainBridge({
      player: usePlayerStore,
      analysis: useAnalysisStore,
      spectrum,
      emit: (event, payload) => emit(event, payload),
      listen: (event, cb) => listen(event, (e) => cb(e.payload)),
      now: () => Date.now(),
    })
      .then((b) => {
        if (cancelled) b.dispose();
        else bridge = b;
      })
      .catch((e: unknown) => console.error("[detached] could not start the window bridge:", e));

    const unlistenDocked = listen<string>(EVT_DOCKED, (e) => useDetachedStore.getState().markDocked(e.payload));

    // Hiding a panel that lives in its own window closes that window.
    let previousVisible = usePracticePanels.getState().visible;
    const unsubscribePanels = usePracticePanels.subscribe((state) => {
      const next = state.visible;
      for (const id of panelsToClose(previousVisible, next, useDetachedStore.getState().detached)) {
        closeDetachedPanel(id).catch((e: unknown) => console.warn(`[detached] could not close the ${id} window:`, e));
      }
      previousVisible = next;
    });

    return () => {
      cancelled = true;
      unsubscribePanels();
      bridge?.dispose();
      unlistenDocked
        .then((unlisten) => unlisten())
        .catch((e: unknown) => console.warn("[detached] could not stop listening for docked panels:", e));
      closeDetachedWindows().catch((e: unknown) => console.warn("[detached] could not close detached windows:", e));
      useDetachedStore.getState().reset();
    };
  }, []);
}
