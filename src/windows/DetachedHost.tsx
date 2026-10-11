import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { createRemoteSpectrumSource } from "../audio/spectrumSource";
import DynamicsCurve from "../components/analysis/DynamicsCurve";
import PianoKeyboard from "../components/analysis/PianoKeyboard";
import PianoRoll from "../components/analysis/PianoRoll";
import ShortTermSpectrumComparisonPanel from "../components/analysis/ShortTermSpectrumComparisonPanel";
import TimingChart from "../components/analysis/TimingChart";
import VibratoCard from "../components/analysis/VibratoCard";
import CoachPanel from "../components/coaching/CoachPanel";
import LyricsPanel from "../components/lyrics/LyricsPanel";
import TakeList from "../components/recording/TakeList";
import DockHandle from "../components/panels/DockHandle";
import { dockPanel } from "../lib/tauri";
import { useAnalysisStore } from "../stores/analysis";
import { usePlayerStore } from "../stores/player";
import { startDetachedBridge } from "./detachedBridge";
import { installPlaybackTimeSource } from "./playbackClock";
import type { DetachablePanel } from "./protocol";
import { installSpectrumSource } from "./spectrumRegistry";

const TITLES: Record<DetachablePanel, string> = {
  pianoRoll: "Piano roll",
  lyrics: "Lyrics",
  takes: "Takes",
  spectrum: "Spectrum comparison",
  dynamics: "Dynamics",
  vibrato: "Vibrato",
  timing: "Timing",
  coach: "Coach",
};

/** Panels that have nothing to show until a take is selected in the main window. */
const NEEDS_A_TAKE: readonly DetachablePanel[] = ["vibrato", "timing"];

interface DetachedHostProps {
  panel: DetachablePanel;
}

function PanelBody({ panel, songId }: { panel: DetachablePanel; songId: string }) {
  switch (panel) {
    case "pianoRoll":
      return (
        <div className="detached-host__stack">
          <PianoKeyboard />
          <PianoRoll />
        </div>
      );
    case "lyrics":
      return <LyricsPanel songId={songId} />;
    case "takes":
      return <TakeList />;
    case "spectrum":
      return <ShortTermSpectrumComparisonPanel />;
    case "dynamics":
      return <DynamicsCurve />;
    case "vibrato":
      return <VibratoCard />;
    case "timing":
      return <TimingChart />;
    case "coach":
      return <CoachPanel />;
  }
}

/**
 * What a detached window shows: one panel, driven by the main window. There is
 * no audio engine here and no microphone; everything arrives from the bridge.
 */
function DetachedHost({ panel }: DetachedHostProps) {
  const song = usePlayerStore((s) => s.song);
  const hasTake = usePlayerStore((s) => s.activeTakeId !== null);

  useEffect(() => {
    let cancelled = false;
    let bridge: { dispose(): void } | null = null;

    // The spectrum panel asks its source for what only the main window can
    // measure; here that source is the stream the bridge hands to `onSpectrum`.
    const remote = createRemoteSpectrumSource();
    const uninstallSpectrum = panel === "spectrum" ? installSpectrumSource(remote.source) : () => {};

    startDetachedBridge({
      panelId: panel,
      player: usePlayerStore,
      analysis: useAnalysisStore,
      emit: (event, payload) => emit(event, payload),
      listen: (event, cb) => listen(event, (e) => cb(e.payload)),
      now: () => Date.now(),
      onSpectrum: remote.apply,
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
      uninstallSpectrum();
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
        <DockHandle />
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
        ) : NEEDS_A_TAKE.includes(panel) && !hasTake ? (
          <p className="detached-host__waiting">Select a take in the main window to see this.</p>
        ) : (
          <PanelBody panel={panel} songId={song.id} />
        )}
      </div>
    </div>
  );
}

export default DetachedHost;
