import { useState } from "react";
import { usePlayerStore } from "../../stores/player";

function MonitorButton() {
  const isMonitoring    = usePlayerStore((s) => s.isMonitoring);
  const isRecording     = usePlayerStore((s) => s.isRecording);
  const startMonitoring = usePlayerStore((s) => s.startMonitoring);
  const stopMonitoring  = usePlayerStore((s) => s.stopMonitoring);
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
        disabled={isRecording}
        title={isMonitoring ? "Stop microphone monitor" : "Monitor mic in piano roll (no recording)"}
      >
        🎤
      </button>
      {error && <span className="monitor-btn__error">{error}</span>}
    </div>
  );
}

export default MonitorButton;
