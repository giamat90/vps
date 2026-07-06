import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import PianoRoll from "../components/analysis/PianoRoll";
import PianoKeyboard from "../components/analysis/PianoKeyboard";
import SpectrogramPanel from "../components/analysis/SpectrogramPanel";
import ShortTermSpectrumPanel from "../components/analysis/ShortTermSpectrumPanel";
import DynamicsCurve from "../components/analysis/DynamicsCurve";
import VibratoCard from "../components/analysis/VibratoCard";
import MicSelector from "../components/recording/MicSelector";
import MonitorButton from "../components/recording/MonitorButton";
import ExerciseTakeList from "../components/recording/ExerciseTakeList";
import { AUDIO_EXTENSIONS } from "../components/upload/DropZone";
import { usePlayerStore } from "../stores/player";
import { useExerciseStore } from "../stores/exercise";

interface ExercisePageProps {
  onBack: () => void;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function ExercisePage({ onBack }: ExercisePageProps) {
  const currentTime           = usePlayerStore((s) => s.currentTime);
  const isPlaying              = usePlayerStore((s) => s.isPlaying);
  const isRecording           = usePlayerStore((s) => s.isRecording);
  const isMonitoring          = usePlayerStore((s) => s.isMonitoring);
  const startExercise         = usePlayerStore((s) => s.startExercise);
  const stopExercise          = usePlayerStore((s) => s.stopExercise);
  const startExerciseRecording = usePlayerStore((s) => s.startExerciseRecording);
  const stopExerciseRecording  = usePlayerStore((s) => s.stopExerciseRecording);
  const playExerciseTrack      = usePlayerStore((s) => s.playExerciseTrack);
  const pauseExerciseTrack     = usePlayerStore((s) => s.pauseExerciseTrack);
  const addExerciseTake        = useExerciseStore((s) => s.addExerciseTake);
  const fetchExerciseTakes     = useExerciseStore((s) => s.fetchExerciseTakes);
  const loadedTrackId          = useExerciseStore((s) => s.loadedTrackId);
  const isImporting            = useExerciseStore((s) => s.isImporting);
  const clearLoadedTrack       = useExerciseStore((s) => s.clearLoadedTrack);
  const importExerciseFile     = useExerciseStore((s) => s.importExerciseFile);

  const [recError, setRecError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const trackContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    startExercise();
    void fetchExerciseTakes();
    return () => {
      clearLoadedTrack();
      stopExercise();
    };
  }, []);

  const handleRecord = async () => {
    setRecError(null);
    if (isRecording) {
      try {
        const take = await stopExerciseRecording();
        addExerciseTake(take);
      } catch (e) {
        setRecError(e instanceof Error ? e.message : String(e));
      }
    } else {
      try {
        await startExerciseRecording();
      } catch (e) {
        setRecError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const handleImport = async () => {
    setImportError(null);
    const container = trackContainerRef.current;
    if (!container) return;
    const selected = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    });
    if (!selected) return;
    try {
      await importExerciseFile(selected, container);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  };

  const trackLoaded = loadedTrackId !== null;
  const disableRecord = trackLoaded || isImporting;
  const disableLoadOrImport = isRecording || isImporting;

  return (
    <div className="exercise-page">
      <header className="exercise-page__header">
        <button className="exercise-page__back" onClick={onBack}>
          &larr; Back
        </button>
        <h1 className="exercise-page__title">Free Exercise</h1>
        <span className={`exercise-page__timer${isRecording || isMonitoring || trackLoaded ? " exercise-page__timer--active" : ""}`}>
          {formatElapsed(currentTime)}
        </span>
      </header>

      <div className="exercise-page__keyboard">
        <PianoKeyboard />
      </div>

      {/* Always rendered (not conditionally) so it has real dimensions
          before loadExerciseTrack() creates a WaveSurfer instance against it —
          a hidden/zero-size container would size the waveform canvas to 0. */}
      <div ref={trackContainerRef} className="exercise-page__track-strip" />

      {trackLoaded && (
        <div className="exercise-page__transport">
          <button onClick={() => (isPlaying ? pauseExerciseTrack() : playExerciseTrack())}>
            {isPlaying ? "⏸ Pause" : "▶ Play"}
          </button>
          <button onClick={() => clearLoadedTrack()}>Unload</button>
        </div>
      )}

      <div className="exercise-page__analysis">
        <div className="exercise-page__roll">
          <PianoRoll />
        </div>

        <div className="exercise-page__spectro">
          <SpectrogramPanel />
        </div>

        <div className="exercise-page__spectro">
          <ShortTermSpectrumPanel />
        </div>

        <div className="exercise-page__dynamics">
          <DynamicsCurve />
        </div>

        <VibratoCard />
      </div>

      <div className="exercise-page__controls">
        <MicSelector />
        <MonitorButton />
        <button
          className={`exercise-rec-btn${isRecording ? " exercise-rec-btn--active" : ""}`}
          onClick={() => void handleRecord()}
          disabled={disableRecord}
          title={trackLoaded ? "Unload the loaded track to record" : undefined}
        >
          {isRecording ? "⏹ Stop" : "⏺ Record"}
        </button>
        <button
          className="exercise-page__import-btn"
          onClick={() => void handleImport()}
          disabled={disableLoadOrImport}
          title={isRecording ? "Stop recording to import a file" : undefined}
        >
          {isImporting ? "Importing…" : "📂 Load track…"}
        </button>
        {recError && <span className="exercise-page__error">{recError}</span>}
        {importError && <span className="exercise-page__error">{importError}</span>}
      </div>

      <div className="exercise-page__takes">
        <h2 className="exercise-page__takes-title">Recordings</h2>
        <ExerciseTakeList trackContainerRef={trackContainerRef} />
      </div>
    </div>
  );
}

export default ExercisePage;
