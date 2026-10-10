import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import PianoKeyboard from "../components/analysis/PianoKeyboard";
import PianoRoll from "../components/analysis/PianoRoll";
import LyricsPanel from "../components/lyrics/LyricsPanel";
import { dockPanel } from "../lib/tauri";
import { useAnalysisStore } from "../stores/analysis";
import { usePlayerStore } from "../stores/player";
import { startDetachedBridge } from "./detachedBridge";
import { installPlaybackTimeSource } from "./playbackClock";
import type { DetachablePanel } from "./protocol";

const TITLES: Record<DetachablePanel, string> = {
  pianoRoll: "Piano roll",
  lyrics: "Lyrics",
};

interface DetachedHostProps {
  panel: DetachablePanel;
}

/**
 * What a detached window shows: one panel, driven by the main window. There is
 * no audio engine here and no microphone; everything arrives from the bridge.
 */
function DetachedHost({ panel }: DetachedHostProps) {
  const song = usePlayerStore((s) => s.song);

  useEffect(() => {
    let cancelled = false;
    let bridge: { dispose(): void } | null = null;

    startDetachedBridge({
      panelId: panel,
      player: usePlayerStore,
      analysis: useAnalysisStore,
      emit: (event, payload) => emit(event, payload),
      listen: (event, cb) => listen(event, (e) => cb(e.payload)),
      now: () => Date.now(),
      installTimeSource: installPlaybackTimeSource,
      loadSongAnalysis: (songId) => useAnalysisStore.getState().loadSongAnalysis(songId),
      loadTakeAnalysis: (take) => useAnalysisStore.getState().loadTakeAnalysis(take),
      clearTakeAnalysis: () => useAnalysisStore.getState().clearTakeAnalysis(),
    })
      .then((b) => {
        if (cancelled) b.dispose();
        else bridge = b;
      })
      .catch((e: unknown) => console.error("[detached] could not connect to the main window:", e));

    return () => {
      cancelled = true;
      bridge?.dispose();
    };
  }, [panel]);

  return (
    <div className="detached-host">
      <header className="detached-host__bar">
        <span className="detached-host__title">
          {TITLES[panel]}
          {song ? ` — ${song.title}` : ""}
        </span>
        <button
          type="button"
          className="detached-host__dock"
          onClick={() => dockPanel().catch((e: unknown) => console.error("[detached] could not dock:", e))}
        >
          Dock
        </button>
      </header>

      <div className="detached-host__body">
        {!song ? (
          <p className="detached-host__waiting">Waiting for the main window…</p>
        ) : panel === "pianoRoll" ? (
          <div className="detached-host__stack">
            <PianoKeyboard />
            <PianoRoll />
          </div>
        ) : (
          <LyricsPanel songId={song.id} />
        )}
      </div>
    </div>
  );
}

export default DetachedHost;
