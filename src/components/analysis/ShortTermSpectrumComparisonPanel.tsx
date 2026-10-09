import { useRef, useEffect } from "react";
import { useAnalysisStore, type STSpectrum } from "../../stores/analysis";
import { getEngine, getMicAnalyser, usePlayerStore } from "../../stores/player";
import { freqToX, smoothSpectrumLight, analyserCurvePoints, SPECTRUM_MIN_DB, SPECTRUM_MAX_DB, SPECTRUM_BOTTOM_AXIS_H, type SpectrumPoint } from "../../lib/spectroUtils";
import { AXIS_W, LEGEND_WIDTH, F_MIN, F_MAX } from "./SpectrogramPanel";
import { COLOR_SONG, COLOR_TAKE, COLOR_LIVE } from "./PianoKeyboard";

// Deliberately decoupled from SpectrogramPanel's MIN_DB/MAX_DB (-85..-20,
// tuned for the live waterfall's thermal LUT) — this panel needs the full
// vocal dynamic range, so it shares ShortTermSpectrumPanel's -100..0 dBFS span.
const PANEL_MIN_DB = SPECTRUM_MIN_DB;
const PANEL_MAX_DB = SPECTRUM_MAX_DB;
const DB_TICK_STEP = 10;
const FREQ_DECADES = [100, 1000, 10000];

function formatHz(f: number): string {
  return f >= 1000 ? `${f / 1000}k` : `${f}`;
}

/** Nearest-frame lookup — spectrum frames are coarse (~20fps) relative to rAF. */
function nearestFrame(spectrum: STSpectrum, t: number): Uint8Array | null {
  const { times, bytes, bins } = spectrum;
  if (times.length === 0) return null;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t)) lo -= 1;
  return bytes.subarray(lo * bins, (lo + 1) * bins);
}

/** Strokes a polyline through pre-normalized points, optionally smoothing
 * first — a light pass takes the edge off the singer's own live/take curve
 * (per-frame jitter is distracting when comparing your voice's shape to the
 * song) without flattening real harmonic peaks the way ShortTermSpectrumPanel's
 * much heavier formant-envelope smoothing would (that one's designed to be an
 * overlay on top of a raw curve, not a replacement for it). The Song
 * reference curve is left fully raw/precise on purpose. */
function strokePoints(
  ctx: CanvasRenderingContext2D,
  points: SpectrumPoint[],
  color: string,
  plotH: number,
  dpr: number,
  smooth: boolean,
): void {
  const drawn = smooth ? smoothSpectrumLight(points) : points;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * dpr;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < drawn.length; i++) {
    const y = plotH * (1 - drawn[i].normalized);
    if (i === 0) ctx.moveTo(drawn[i].x, y); else ctx.lineTo(drawn[i].x, y);
  }
  ctx.stroke();
}

/**
 * Builds normalized points from a precomputed frame (0-255 bytes encoded
 * over the spectrum's own minDb..maxDb, per compute_short_term_spectrum).
 * Decoded against its own stored range, then re-normalized to the panel's
 * display range (PANEL_MIN_DB..PANEL_MAX_DB) — the two currently coincide,
 * but this keeps rendering correct even if the encode range changes again.
 */
function storedCurvePoints(
  frame: Uint8Array,
  minDb: number,
  maxDb: number,
  rollW: number,
): SpectrumPoint[] {
  const bins = frame.length;
  const points: SpectrumPoint[] = [];
  for (let px = 0; px < rollW; px++) {
    // Stored bins are log-spaced from F_MIN (bin 0) to fMax, the same axis
    // xToFreq maps columns onto (low frequency at the left), so a column's
    // bin range is just its fractional position. Max-in-range, like the live
    // curve's per-column FFT bin lookup.
    const binLo = Math.max(0, Math.min(bins - 1, Math.floor((px / rollW) * bins)));
    const binHi = Math.max(binLo, Math.min(bins - 1, Math.floor(((px + 1) / rollW) * bins)));
    let peak = 0;
    for (let b = binLo; b <= binHi; b++) {
      if (frame[b] > peak) peak = frame[b];
    }
    const db = minDb + (peak / 255) * (maxDb - minDb);
    const normalized = Math.max(0, Math.min(1, (db - PANEL_MIN_DB) / (PANEL_MAX_DB - PANEL_MIN_DB)));
    points.push({ x: AXIS_W + px, y: 0, normalized });
  }
  return points;
}

export default function ShortTermSpectrumComparisonPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const songSTSpectrum = useAnalysisStore((s) => s.songSTSpectrum);
  const takeSTSpectrum = useAnalysisStore((s) => s.takeSTSpectrum);
  const isLoaded = useAnalysisStore((s) => s.isLoaded);
  const isRecording = usePlayerStore((s) => s.isRecording);
  const isMonitoring = usePlayerStore((s) => s.isMonitoring);
  const drawRef = useRef<() => void>(() => {});
  const liveScratch = useRef<Float32Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    drawRef.current = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth || 600;
      const cssH = canvas.clientHeight || 200;
      const W = Math.round(cssW * dpr);
      const H = Math.round(cssH * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }

      const rollW = W - AXIS_W - LEGEND_WIDTH;
      const plotH = H - SPECTRUM_BOTTOM_AXIS_H * dpr;
      const fMax = F_MAX;
      const live = isRecording || isMonitoring;
      const analyser = live ? getMicAnalyser() : null;

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#0f0f1e";
      ctx.fillRect(0, 0, W, H);

      // dB grid
      ctx.font = `${11 * dpr}px monospace`;
      ctx.textBaseline = "middle";
      const dbTicks: number[] = [PANEL_MIN_DB];
      for (let db = Math.ceil(PANEL_MIN_DB / DB_TICK_STEP) * DB_TICK_STEP; db < PANEL_MAX_DB; db += DB_TICK_STEP) {
        dbTicks.push(db);
      }
      dbTicks.push(PANEL_MAX_DB);
      for (const db of dbTicks) {
        const isEdge = db === PANEL_MIN_DB || db === PANEL_MAX_DB;
        const norm = (db - PANEL_MIN_DB) / (PANEL_MAX_DB - PANEL_MIN_DB);
        const y = plotH * (1 - norm);
        ctx.strokeStyle = isEdge ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(AXIS_W, y);
        ctx.lineTo(W - LEGEND_WIDTH, y);
        ctx.stroke();
        ctx.fillStyle = isEdge ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.6)";
        ctx.textAlign = "right";
        ctx.fillText(`${db}`, AXIS_W - 6, y);
      }

      // Hz decade grid
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const f of FREQ_DECADES) {
        if (f > fMax) continue;
        const x = AXIS_W + freqToX(f, rollW, F_MIN, fMax);
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, plotH);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fillText(formatHz(f), x, plotH + 3 * dpr);
      }

      const hasAnyData = songSTSpectrum || takeSTSpectrum || (live && analyser);
      if (!hasAnyData) {
        ctx.fillStyle = "#a0a0b060";
        ctx.font = `${11 * dpr}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No spectrum data", AXIS_W + rollW / 2, plotH / 2);
        return;
      }

      const currentTime = getEngine().getCurrentTime();

      if (songSTSpectrum) {
        const frame = nearestFrame(songSTSpectrum, currentTime);
        if (frame) {
          const points = storedCurvePoints(frame, songSTSpectrum.minDb, songSTSpectrum.maxDb, rollW);
          strokePoints(ctx, points, COLOR_SONG, plotH, dpr, false);
        }
      }

      if (live && analyser) {
        // Live singer take priority over a stored take, same as Piano Roll's live > take > song ribbon order.
        const binCount = analyser.frequencyBinCount;
        if (!liveScratch.current || liveScratch.current.length !== binCount) {
          liveScratch.current = new Float32Array(binCount);
        }
        analyser.getFloatFrequencyData(liveScratch.current);
        const points = analyserCurvePoints(liveScratch.current, analyser.context.sampleRate, rollW, F_MIN, fMax, AXIS_W);
        strokePoints(ctx, points, COLOR_LIVE, plotH, dpr, true);
      } else if (takeSTSpectrum) {
        const frame = nearestFrame(takeSTSpectrum, currentTime);
        if (frame) {
          const points = storedCurvePoints(frame, takeSTSpectrum.minDb, takeSTSpectrum.maxDb, rollW);
          strokePoints(ctx, points, COLOR_TAKE, plotH, dpr, true);
        }
      } else {
        ctx.fillStyle = "#a0a0b060";
        ctx.font = `${11 * dpr}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText("No take selected", AXIS_W + rollW / 2, plotH - 6 * dpr);
      }
    };

    drawRef.current();
  }, [songSTSpectrum, takeSTSpectrum, isRecording, isMonitoring]);

  useEffect(() => {
    if (!isLoaded && !isRecording && !isMonitoring) return;
    let rafId: number;
    const tick = () => { drawRef.current(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isLoaded, isRecording, isMonitoring]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="analysis-panel">
      <div className="analysis-panel__header">
        <span className="analysis-panel__label">Short-Term Spectrum</span>
        <div className="analysis-panel__legend">
          <span className="legend-dot legend-dot--song" />
          <span>Song</span>
          {(isRecording || isMonitoring) ? (
            <>
              <span className="legend-dot legend-dot--live" />
              <span>Live</span>
            </>
          ) : takeSTSpectrum && (
            <>
              <span className="legend-dot legend-dot--take" />
              <span>Your voice</span>
            </>
          )}
        </div>
      </div>
      <canvas ref={canvasRef} className="analysis-panel__canvas short-term-spectrum-panel__canvas" />
    </div>
  );
}
