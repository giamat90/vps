import { useAnalysisStore } from "../../stores/analysis";
import { usePlayerStore } from "../../stores/player";
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

/**
 * Only draws the gauge. The live reading comes from the headless
 * LivePitchFeed, so this works the same in a detached window.
 */
export default function DualTuner() {
  const isRecording  = usePlayerStore((s) => s.isRecording);
  const isMonitoring = usePlayerStore((s) => s.isMonitoring);
  const isPlaying    = usePlayerStore((s) => s.isPlaying);
  const currentTime  = usePlayerStore((s) => s.currentTime);
  const songPitch    = useAnalysisStore((s) => s.songPitch);
  const takePitch    = useAnalysisStore((s) => s.takePitch);
  const liveCents    = useAnalysisStore((s) => s.liveCents);

  // ─── derive display values ────────────────────────────────────────────────

  let cents: number | null = null;

  if (isRecording || (isMonitoring && isPlaying)) {
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
