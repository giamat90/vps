import { useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { useExerciseStore } from "../../stores/exercise";

function MonitorButton() {
  const isMonitoring    = usePlayerStore((s) => s.isMonitoring);
  const isRecording     = usePlayerStore((s) => s.isRecording);
  const startMonitoring = usePlayerStore((s) => s.startMonitoring);
  const stopMonitoring  = usePlayerStore((s) => s.stopMonitoring);
  // A loaded Free Exercise track (past take or import) takes unconditional
  // priority over live mic input in getCurrentTime()/SpectrogramPanel/
  // ShortTermSpectrumPanel — starting monitor without unloading it first left
  // the UI frozen on the loaded track instead of switching to live mic data.
  // Same guard RecordButton-equivalent already applies in ExercisePage.
  const trackLoaded    = useExerciseStore((s) => s.loadedTrackId !== null);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setError(null);
    try {
      if (isMonitoring) {
        await stopMonitoring();
      } else {
        await startMonitoring();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mic unavailable");
    }
  };

  return (
    <div className="monitor-btn-wrapper">
      <button
        className={`monitor-btn${isMonitoring ? " monitor-btn--active" : ""}`}
        onClick={handleClick}
        disabled={isRecording || trackLoaded}
        title={
          trackLoaded
            ? "Unload the loaded track to monitor"
            : isMonitoring
            ? "Stop microphone monitor"
            : "Monitor mic in piano roll (no recording)"
        }
      >
        🎤
      </button>
      {error && <span className="monitor-btn__error">{error}</span>}
    </div>
  );
}

export default MonitorButton;
