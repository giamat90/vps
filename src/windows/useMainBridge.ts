import { emit, listen } from "@tauri-apps/api/event";
import { useMainBridgeHost } from "@giamat90/mps-core/hooks";
import { closeDetachedPanel, closeDetachedWindows } from "../lib/tauri";
import { useAnalysisStore } from "../stores/analysis";
import { useDetachedStore } from "../stores/detached";
import { usePracticePanels } from "../stores/panels";
import { takesSilenced, usePlayerStore } from "../stores/player";
import { startMainBridge } from "./mainBridge";
import { DETACHABLE_PANELS, EVT_DOCKED } from "./protocol";
import { createSpectrumFeed } from "./spectrumFeed";
import { getLocalSpectrumSource } from "./spectrumRegistry";

/**
 * Lets the practice room feed panels that were dragged out into their own
 * windows. Costs nothing until one is opened; leaving the room closes them,
 * since they would otherwise keep showing a song that is no longer loaded.
 */
export function useMainBridge(): void {
  useMainBridgeHost(() => ({
    startBridge: () =>
      startMainBridge({
        player: usePlayerStore,
        analysis: useAnalysisStore,
        spectrum: createSpectrumFeed({
          source: getLocalSpectrumSource(),
          getPlayer: () => usePlayerStore.getState(),
          getAnalysis: () => useAnalysisStore.getState(),
        }),
        emit: (event, payload) => emit(event, payload),
        listen: (event, cb) => listen(event, (e) => cb(e.payload)),
        now: () => Date.now(),
        takesSilenced: () => takesSilenced(usePlayerStore.getState()),
      }),
    ids: DETACHABLE_PANELS,
    panels: usePracticePanels,
    detached: useDetachedStore,
    listenDocked: (cb) => listen<string>(EVT_DOCKED, (e) => cb(e.payload)),
    closePanel: closeDetachedPanel,
    closeAll: closeDetachedWindows,
  }));
}
