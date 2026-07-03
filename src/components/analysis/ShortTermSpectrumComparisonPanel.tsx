import { useRef, useEffect } from "react";
import { useAnalysisStore, type STSpectrum } from "../../stores/analysis";
import { getEngine, getMicAnalyser, usePlayerStore } from "../../stores/player";
import { freqToX, xToFreq } from "../../lib/spectroUtils";
import { AXIS_W, LEGEND_WIDTH, F_MIN, F_MAX } from "./SpectrogramPanel";
import { COLOR_SONG, COLOR_TAKE, COLOR_LIVE } from "./PianoKeyboard";

// Deliberately decoupled from SpectrogramPanel's MIN_DB/MAX_DB (-85..-20,
// tuned for the live waterfall's thermal LUT) — this panel needs the full
// vocal dynamic range, not a tight display window, so it uses its own wider
// -100..0 dBFS span. Also matches the mic AnalyserNode's widened
// minDecibels/maxDecibels (see stores/player.ts).
const PANEL_MIN_DB = -100;
const PANEL_MAX_DB = 0;
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

/**
 * Draws a precomputed frame (0-255 bytes encoded over the spectrum's own
 * minDb..maxDb, per compute_short_term_spectrum) as a polyline. Decoded
 * against its own stored range, then re-normalized to the panel's display
 * range (PANEL_MIN_DB..PANEL_MAX_DB) — the two currently coincide, but this
 * keeps rendering correct even if the encode range changes again later.
 */
function drawStoredCurve(
  ctx: CanvasRenderingContext2D,
  frame: Uint8Array,
  minDb: number,
  maxDb: number,
  color: string,
  rollW: number,
  plotH: number,
  fMax: number,
  dpr: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * dpr;
  ctx.lineJoin = "round";
  ctx.beginPath();
  const bins = frame.length;
  const logFMin = Math.log(F_MIN);
  const logFMax = Math.log(fMax);
  for (let px = 0; px < rollW; px++) {
    // Column → frequency → source bin (log axis, so columns near F_MIN are
    // denser in bins than columns near F_MAX).
    const t = px / (rollW - 1);
    const f = Math.exp(logFMax - t * (logFMax - logFMin));
    const bt = Math.log(f / F_MIN) / Math.log(fMax / F_MIN);
    const bi = Math.max(0, Math.min(bins - 1, Math.round(bt * (bins - 1))));
    const db = minDb + (frame[bi] / 255) * (maxDb - minDb);
    const norm = Math.max(0, Math.min(1, (db - PANEL_MIN_DB) / (PANEL_MAX_DB - PANEL_MIN_DB)));
    const x = AXIS_W + px;
    const y = plotH * (1 - norm);
    if (px === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** Draws a live curve straight from the mic AnalyserNode (dBFS already). */
function drawLiveCurve(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  sr: number,
  color: string,
  rollW: number,
  plotH: number,
  fMax: number,
  dpr: number,
): void {
  const binCount = data.length;
  const binHz = sr / (binCount * 2);
  const maxBin = binCount - 1;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * dpr;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let px = 0; px < rollW; px++) {
    const fLo = xToFreq(Math.max(0, px - 0.5), rollW, F_MIN, fMax);
    const fHi = xToFreq(Math.min(rollW, px + 0.5), rollW, F_MIN, fMax);
    const binLo = Math.max(0, Math.floor(Math.min(fLo, fHi) / binHz));
    const binHi = Math.min(maxBin, Math.ceil(Math.max(fLo, fHi) / binHz));
    let db = -Infinity;
    for (let b = binLo; b <= binHi; b++) {
      if (data[b] > db) db = data[b];
    }
    if (db === -Infinity) db = data[Math.min(maxBin, Math.max(0, binLo))];
    const norm = Math.max(0, Math.min(1, (db - PANEL_MIN_DB) / (PANEL_MAX_DB - PANEL_MIN_DB)));
    const x = AXIS_W + px;
    const y = plotH * (1 - norm);
    if (px === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
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
        const y = H * (1 - norm);
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
        ctx.lineTo(x, H);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fillText(formatHz(f), x, H - 12 * dpr);
      }

      const hasAnyData = songSTSpectrum || takeSTSpectrum || (live && analyser);
      if (!hasAnyData) {
        ctx.fillStyle = "#a0a0b060";
        ctx.font = `${11 * dpr}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No spectrum data", AXIS_W + rollW / 2, H / 2);
        return;
      }

      const currentTime = getEngine().getCurrentTime();

      if (songSTSpectrum) {
        const frame = nearestFrame(songSTSpectrum, currentTime);
        if (frame) {
          drawStoredCurve(ctx, frame, songSTSpectrum.minDb, songSTSpectrum.maxDb, COLOR_SONG, rollW, H, fMax, dpr);
        }
      }

      if (live && analyser) {
        // Live singer take priority over a stored take, same as Piano Roll's live > take > song ribbon order.
        const binCount = analyser.frequencyBinCount;
        if (!liveScratch.current || liveScratch.current.length !== binCount) {
          liveScratch.current = new Float32Array(binCount);
        }
        analyser.getFloatFrequencyData(liveScratch.current);
        drawLiveCurve(ctx, liveScratch.current, analyser.context.sampleRate, COLOR_LIVE, rollW, H, fMax, dpr);
      } else if (takeSTSpectrum) {
        const frame = nearestFrame(takeSTSpectrum, currentTime);
        if (frame) {
          drawStoredCurve(ctx, frame, takeSTSpectrum.minDb, takeSTSpectrum.maxDb, COLOR_TAKE, rollW, H, fMax, dpr);
        }
      } else {
        ctx.fillStyle = "#a0a0b060";
        ctx.font = `${11 * dpr}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText("No take selected", AXIS_W + rollW / 2, H - 6 * dpr);
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
