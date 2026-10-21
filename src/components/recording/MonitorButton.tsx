import { useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { useExerciseStore } from "../../stores/exercise";

function MonitorButton() {
  const isMonitoring    = usePlayerStore((s) => s.isMonitoring);
  const isRecording     = usePlayerStore((s) => s.isRecording);
  const startMonitoring = usePlayerStore((s) => s.startMonitoring);
  const stopMonitoring  = usePlayerStore((s) => s.stopMonitoring);
  const isCountingIn    = usePlayerStore((s) => s.isCountingIn);
  const countInBars     = usePlayerStore((s) => s.countInBars);
  const exerciseMode    = usePlayerStore((s) => s.exerciseMode);
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
        disabled={isRecording || (isCountingIn && !isMonitoring)}
        title={
          isMonitoring
            ? isCountingIn ? "Cancel count-in and stop microphone monitor" : "Stop microphone monitor"
            : countInBars > 0 && !exerciseMode
            ? `Monitor mic with a ${countInBars}-bar count-in, then play the song (no recording)`
            : trackLoaded
            ? "Monitor mic against the loaded track (no recording)"
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
