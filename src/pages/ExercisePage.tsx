import { useEffect, useState } from "react";
import PianoRoll from "../components/analysis/PianoRoll";
import PianoKeyboard from "../components/analysis/PianoKeyboard";
import SpectrogramPanel from "../components/analysis/SpectrogramPanel";
import DualTuner from "../components/analysis/DualTuner";
import MicSelector from "../components/recording/MicSelector";
import MonitorButton from "../components/recording/MonitorButton";
import ExerciseTakeList from "../components/recording/ExerciseTakeList";
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
  const isRecording           = usePlayerStore((s) => s.isRecording);
  const isMonitoring          = usePlayerStore((s) => s.isMonitoring);
  const startExercise         = usePlayerStore((s) => s.startExercise);
  const stopExercise          = usePlayerStore((s) => s.stopExercise);
  const startExerciseRecording = usePlayerStore((s) => s.startExerciseRecording);
  const stopExerciseRecording  = usePlayerStore((s) => s.stopExerciseRecording);
  const addExerciseTake        = useExerciseStore((s) => s.addExerciseTake);
  const fetchExerciseTakes     = useExerciseStore((s) => s.fetchExerciseTakes);

  const [recError, setRecError] = useState<string | null>(null);

  useEffect(() => {
    startExercise();
    void fetchExerciseTakes();
    return () => stopExercise();
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

  return (
    <div className="exercise-page">
      <header className="exercise-page__header">
        <button className="exercise-page__back" onClick={onBack}>
          &larr; Back
        </button>
        <h1 className="exercise-page__title">Free Exercise</h1>
        <DualTuner />
        <span className={`exercise-page__timer${isRecording || isMonitoring ? " exercise-page__timer--active" : ""}`}>
          {formatElapsed(currentTime)}
        </span>
      </header>

      <div className="exercise-page__roll">
        <PianoKeyboard />
        <PianoRoll />
      </div>

      <div className="exercise-page__spectro">
        <SpectrogramPanel />
      </div>

      <div className="exercise-page__controls">
        <MicSelector />
        <MonitorButton />
        <button
          className={`exercise-rec-btn${isRecording ? " exercise-rec-btn--active" : ""}`}
          onClick={() => void handleRecord()}
        >
          {isRecording ? "⏹ Stop" : "⏺ Record"}
        </button>
        {recError && <span className="exercise-page__error">{recError}</span>}
      </div>

      <div className="exercise-page__takes">
        <h2 className="exercise-page__takes-title">Recordings</h2>
        <ExerciseTakeList />
      </div>
    </div>
  );
}

export default ExercisePage;
