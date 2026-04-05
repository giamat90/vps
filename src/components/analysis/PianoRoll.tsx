import { useRef, useEffect } from "react";
import { useAnalysisStore } from "../../stores/analysis";
import { usePlayerStore } from "../../stores/player";
import { frequencyToMidi } from "../../lib/constants";

const WINDOW_S = 10;
const MIDI_MIN = 45;
const MIDI_MAX = 88;

export default function PianoRoll() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const songPitch = useAnalysisStore((s) => s.songPitch);
  const takePitch = useAnalysisStore((s) => s.takePitch);
  const isLoaded = useAnalysisStore((s) => s.isLoaded);
  const currentTime = usePlayerStore((s) => s.currentTime);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.offsetWidth || 600;
    const H = canvas.offsetHeight || 120;
    canvas.width = W;
    canvas.height = H;

    ctx.clearRect(0, 0, W, H);

    if (!isLoaded || songPitch.length === 0) {
      ctx.fillStyle = "#a0a0b060";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No pitch data", W / 2, H / 2);
      return;
    }

    const timeToX = (t: number) =>
      ((t - currentTime + WINDOW_S / 2) / WINDOW_S) * W;

    const midiToY = (midi: number) =>
      (1 - (midi - MIDI_MIN) / (MIDI_MAX - MIDI_MIN)) * H;

    // Piano key grid lines
    for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
      const isBlack = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      ctx.strokeStyle = isBlack ? "#ffffff07" : "#ffffff12";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      const y = midiToY(m);
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    // Playhead cursor at center
    const cx = W / 2;
    ctx.strokeStyle = "#ffffff20";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, H);
    ctx.stroke();
    ctx.setLineDash([]);

    const t0 = currentTime - WINDOW_S / 2;
    const t1 = currentTime + WINDOW_S / 2;

    // Song pitch — gray dots
    ctx.fillStyle = "#7a7a90";
    for (const p of songPitch) {
      if (p.time < t0 || p.time > t1 || p.confidence < 0.5 || p.frequency <= 0) continue;
      const midi = frequencyToMidi(p.frequency);
      if (midi < MIDI_MIN || midi > MIDI_MAX) continue;
      ctx.beginPath();
      ctx.arc(timeToX(p.time), midiToY(midi), 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Take pitch — accent red dots
    if (takePitch.length > 0) {
      ctx.fillStyle = "#e94560";
      for (const p of takePitch) {
        if (p.time < t0 || p.time > t1 || p.confidence < 0.5 || p.frequency <= 0) continue;
        const midi = frequencyToMidi(p.frequency);
        if (midi < MIDI_MIN || midi > MIDI_MAX) continue;
        ctx.beginPath();
        ctx.arc(timeToX(p.time), midiToY(midi), 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [songPitch, takePitch, currentTime, isLoaded]);

  return (
    <div className="analysis-panel">
      <div className="analysis-panel__header">
        <span className="analysis-panel__label">Pitch Contour</span>
        <div className="analysis-panel__legend">
          <span className="legend-dot legend-dot--song" />
          <span>Song</span>
          {takePitch.length > 0 && (
            <>
              <span className="legend-dot legend-dot--take" />
              <span>Take</span>
            </>
          )}
        </div>
      </div>
      <canvas ref={canvasRef} className="analysis-panel__canvas" />
    </div>
  );
}
