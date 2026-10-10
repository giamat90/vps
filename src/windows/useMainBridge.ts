import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { closeDetachedWindows } from "../lib/tauri";
import { useAnalysisStore } from "../stores/analysis";
import { useDetachedStore } from "../stores/detached";
import { usePlayerStore } from "../stores/player";
import { startMainBridge } from "./mainBridge";
import { EVT_DOCKED } from "./protocol";

/**
 * Lets the practice room feed panels that were dragged out into their own
 * windows. Costs nothing until one is opened; leaving the room closes them,
 * since they would otherwise keep showing a song that is no longer loaded.
 */
export function useMainBridge(): void {
  useEffect(() => {
    let cancelled = false;
    let bridge: { dispose(): void } | null = null;

    startMainBridge({
      player: usePlayerStore,
      analysis: useAnalysisStore,
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

    return () => {
      cancelled = true;
      bridge?.dispose();
      unlistenDocked
        .then((unlisten) => unlisten())
        .catch((e: unknown) => console.warn("[detached] could not stop listening for docked panels:", e));
      closeDetachedWindows().catch((e: unknown) => console.warn("[detached] could not close detached windows:", e));
      useDetachedStore.getState().reset();
    };
  }, []);
}
