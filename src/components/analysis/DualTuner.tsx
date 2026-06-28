import { useRef, useEffect, useState } from "react";
import { PitchDetector } from "../../audio/pitchDetector";
import { useAnalysisStore } from "../../stores/analysis";
import { usePlayerStore, getMonitorStream, getRecorderStream } from "../../stores/player";
import { pitchAtTime, centsDeviation } from "../../audio/analysisUtils";

// ─── horizontal bar tuner constants ──────────────────────────────────────────

const TRACK_CX    = 150;
const PX_PER_CENT = 3; // 300 viewBox units / 100 cents

// Zone boundaries matching needle color thresholds
const X_YEL_L = TRACK_CX - 30 * PX_PER_CENT; // 60
const X_GRN_L = TRACK_CX - 15 * PX_PER_CENT; // 105
const X_GRN_R = TRACK_CX + 15 * PX_PER_CENT; // 195
const X_YEL_R = TRACK_CX + 30 * PX_PER_CENT; // 240

function centsToX(c: number): number {
  return TRACK_CX + Math.max(-50, Math.min(50, c)) * PX_PER_CENT;
}

export default function DualTuner() {
  const isRecording  = usePlayerStore((s) => s.isRecording);
  const isMonitoring = usePlayerStore((s) => s.isMonitoring);
  const currentTime  = usePlayerStore((s) => s.currentTime);
  const songPitch    = useAnalysisStore((s) => s.songPitch);
  const takePitch    = useAnalysisStore((s) => s.takePitch);
  const appendLivePitch = useAnalysisStore((s) => s.appendLivePitch);
  const clearLivePitch  = useAnalysisStore((s) => s.clearLivePitch);

  const [liveCents, setLiveCents] = useState<number | null>(null);
  const detectorRef = useRef<PitchDetector | null>(null);
  const rafRef      = useRef<number>(0);

  const currentTimeRef   = useRef(currentTime);
  const songPitchRef     = useRef(songPitch);
  const appendLiveRef    = useRef(appendLivePitch);
  const clearLiveRef     = useRef(clearLivePitch);
  useEffect(() => { currentTimeRef.current = currentTime; },    [currentTime]);
  useEffect(() => { songPitchRef.current = songPitch; },        [songPitch]);
  useEffect(() => { appendLiveRef.current = appendLivePitch; }, [appendLivePitch]);
  useEffect(() => { clearLiveRef.current = clearLivePitch; },   [clearLivePitch]);

  useEffect(() => {
    const isActive = isRecording || isMonitoring;
    if (!isActive) {
      if (detectorRef.current) { detectorRef.current.stop(); detectorRef.current = null; }
      cancelAnimationFrame(rafRef.current);
      clearLiveRef.current();
      setLiveCents(null);
      return;
    }

    const stream = isMonitoring ? getMonitorStream() : getRecorderStream();
    if (!stream) return;

    clearLiveRef.current();

    const det = new PitchDetector();
    det.start(stream);
    detectorRef.current = det;

    let rafActive = true;
    const tick = () => {
      const reading = det.getCurrentPitch();
      if (reading) {
        const t   = currentTimeRef.current;
        const ref = pitchAtTime(songPitchRef.current, t);
        if (ref && ref.frequency > 0) {
          setLiveCents(centsDeviation(reading.frequency, ref.frequency));
        } else {
          setLiveCents(reading.cents);
        }
        if (reading.frequency > 0) {
          appendLiveRef.current({ time: t, frequency: reading.frequency, confidence: 1.0 });
        }
      }
      if (rafActive) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => { rafActive = false; cancelAnimationFrame(rafRef.current); };
  }, [isRecording, isMonitoring]);

  // ─── derive display values ────────────────────────────────────────────────

  let cents: number | null = null;

  if (isRecording || isMonitoring) {
    cents = liveCents;
  } else if (takePitch.length > 0) {
    const tp = pitchAtTime(takePitch, currentTime);
    const sp = pitchAtTime(songPitch, currentTime);
    if (tp && sp && tp.confidence > 0.4 && sp.confidence > 0.4) {
      cents = centsDeviation(tp.frequency, sp.frequency);
    }
  }

  const active = cents !== null;
  const abs    = Math.abs(cents ?? 0);
  const needleColor = !active ? "#404060" : abs < 15 ? "#4ade80" : abs < 30 ? "#fbbf24" : "#e94560";
  const nx = centsToX(cents ?? 0);

  // ─── render ───────────────────────────────────────────────────────────────

  return (
    <div className="dual-tuner">
      <svg
        viewBox="0 0 300 8"
        className="dual-tuner__gauge"
        preserveAspectRatio="none"
      >
        {/* Track background */}
        <rect x={0} y={0} width={300} height={8} fill="#0a0a18" />

        {/* Colored zones */}
        <rect x={0}       y={0} width={X_YEL_L}            height={8} fill="#e9456038" />
        <rect x={X_YEL_L} y={0} width={X_GRN_L - X_YEL_L} height={8} fill="#fbbf2438" />
        <rect x={X_GRN_L} y={0} width={X_GRN_R - X_GRN_L} height={8} fill="#4ade8050" />
        <rect x={X_GRN_R} y={0} width={X_YEL_R - X_GRN_R} height={8} fill="#fbbf2438" />
        <rect x={X_YEL_R} y={0} width={300 - X_YEL_R}      height={8} fill="#e9456038" />

        {/* Centre mark */}
        <line x1={TRACK_CX} y1={0} x2={TRACK_CX} y2={8} stroke="#ffffff40" strokeWidth={1} />

        {/* Needle */}
        {active && (
          <rect x={nx - 1.5} y={0} width={3} height={8} rx={1} fill={needleColor} />
        )}
      </svg>
    </div>
  );
}
