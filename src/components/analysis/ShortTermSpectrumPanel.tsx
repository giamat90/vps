import { useRef, useEffect } from "react";
import { getMicAnalyser, getEngine, usePlayerStore } from "../../stores/player";
import { useExerciseStore } from "../../stores/exercise";
import { SPECTRO_COLORMAP, freqToX as freqToXShared, xToFreq as xToFreqShared, smoothSpectrumEnvelope } from "../../lib/spectroUtils";
import { AXIS_W, LEGEND_WIDTH, F_MIN, F_MAX, MIN_DB, MAX_DB } from "./SpectrogramPanel";
import { computeMagnitudeSpectrumDb } from "../../lib/fft";
import { estimateFormants, type FormantEstimate } from "../../lib/formants";

// Matches the mic analyser's fftSize (see getMicAnalyser in stores/player.ts)
// so live and buffer-snapshot data are the same resolution.
const FFT_SIZE = 8192;

// ─── constants ───────────────────────────────────────────────────────────────

const BOTTOM_AXIS_H = 16; // px (dpr-scaled) reserved at bottom for Hz labels
const DB_TICK_STEP   = 10;
const FREQ_DECADES    = [100, 1000, 10000];

// One color per formant slot (F1/F2/F3) so overlapping lines stay distinguishable.
const FORMANT_COLORS = ["#ffcf5c", "#5cffe0", "#ff5ca8"];

// ─── frequency axis (shared log math, inverted for horizontal placement) ─────

function freqToX(f: number, rollW: number, fMax: number): number {
  return freqToXShared(f, rollW, F_MIN, fMax);
}

function xToFreq(x: number, rollW: number, fMax: number): number {
  return xToFreqShared(x, rollW, F_MIN, fMax);
}

function formatHz(f: number): string {
  return f >= 1000 ? `${f / 1000}k` : `${f}`;
}


export default function ShortTermSpectrumPanel() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const isRecording  = usePlayerStore((s) => s.isRecording);
  const isMonitoring = usePlayerStore((s) => s.isMonitoring);
  const loadedTrackId = useExerciseStore((s) => s.loadedTrackId);
  // A loaded track snapshots its decoded buffer at the current playhead —
  // works whether playing, paused, or scrubbed, unlike a live AnalyserNode.
  const trackActive  = loadedTrackId !== null;
  const drawRef      = useRef<() => void>(() => {});
  const loggedRef    = useRef(false);
  const prevFormant  = useRef<FormantEstimate>({ f1: null, f2: null, f3: null });
  const timeScratch  = useRef<Float32Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    if (!loggedRef.current) {
      loggedRef.current = true;
      console.log('[ShortTermSpectrum] panel active, height-colored stroke, sharing FLOOR/CEILING from spectrogram');
    }
  }, []);

  useEffect(() => {
    console.log('[ShortTermSpectrum] envelope overlay: moving-average, window 15-40 columns');
  }, []);

  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr  = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth  || 600;
      const cssH = canvas.clientHeight || 200;
      const W    = Math.round(cssW * dpr);
      const H    = Math.round(cssH * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width  = W;
        canvas.height = H;
      }

      const rollW  = W - AXIS_W - LEGEND_WIDTH;
      const bottomH = BOTTOM_AXIS_H * dpr;
      const plotH  = H - bottomH;

      let sr: number | null = null;
      let freqData: Float32Array | null = null;
      let timeData: Float32Array | null = null;
      if (trackActive) {
        const engineSr = getEngine().getExerciseTrackSampleRate();
        const samples = getEngine().getExerciseTrackSamples(FFT_SIZE);
        if (engineSr && samples) {
          sr = engineSr;
          timeData = samples;
          freqData = computeMagnitudeSpectrumDb(samples, FFT_SIZE);
        }
      } else {
        const analyser = getMicAnalyser();
        if (analyser) {
          const binCount = analyser.frequencyBinCount;
          const data = new Float32Array(binCount);
          analyser.getFloatFrequencyData(data);
          if (!timeScratch.current || timeScratch.current.length !== analyser.fftSize) {
            timeScratch.current = new Float32Array(analyser.fftSize);
          }
          analyser.getFloatTimeDomainData(timeScratch.current);
          sr = analyser.context.sampleRate;
          freqData = data;
          timeData = timeScratch.current;
        }
      }

      const active    = (isRecording || isMonitoring || trackActive) && sr !== null && freqData !== null;
      const nyquist   = (sr ?? 48000) / 2;
      const fMax      = Math.min(F_MAX, nyquist);

      // 1. full clear (no trail)
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#0f0f1e";
      ctx.fillRect(0, 0, W, H);

      // ── dB grid + left labels ───────────────────────────────────────────
      ctx.font         = `${11 * dpr}px monospace`;
      ctx.textBaseline = "middle";
      const dbTicks: number[] = [MIN_DB];
      for (let db = Math.ceil(MIN_DB / DB_TICK_STEP) * DB_TICK_STEP; db < MAX_DB; db += DB_TICK_STEP) {
        dbTicks.push(db);
      }
      dbTicks.push(MAX_DB);
      for (const db of dbTicks) {
        const isEdge     = db === MIN_DB || db === MAX_DB;
        const normalized = (db - MIN_DB) / (MAX_DB - MIN_DB);
        const y = plotH * (1 - normalized);

        ctx.strokeStyle = isEdge ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.08)";
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(AXIS_W, y);
        ctx.lineTo(W - LEGEND_WIDTH, y);
        ctx.stroke();

        ctx.fillStyle = isEdge ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.6)";
        ctx.textAlign = "right";
        ctx.fillText(`${db}`, AXIS_W - 6, y);
      }

      // ── decade grid + bottom Hz labels ──────────────────────────────────
      ctx.textAlign    = "center";
      ctx.textBaseline = "top";
      for (const f of FREQ_DECADES) {
        if (f > fMax) continue;
        const x = AXIS_W + freqToX(f, rollW, fMax);
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, plotH);
        ctx.stroke();

        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fillText(formatHz(f), x, plotH + 3 * dpr);
      }

      if (!active) {
        ctx.fillStyle    = "#a0a0b040";
        ctx.font         = `${11 * dpr}px sans-serif`;
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Enable Monitor or Record to see spectrum", AXIS_W + rollW / 2, plotH / 2);
        return;
      }

      // ── per-frame snapshot: same source feeding the spectrogram ──────────
      const data = freqData!;
      const binCount = data.length;
      const binHz   = sr! / (binCount * 2);
      const maxBin  = binCount - 1;
      const dbRange = MAX_DB - MIN_DB;

      const points: { x: number; y: number; normalized: number }[] = [];
      for (let px = 0; px < rollW; px++) {
        const f = xToFreq(px, rollW, fMax);
        const fLo = xToFreq(Math.max(0, px - 0.5), rollW, fMax);
        const fHi = xToFreq(Math.min(rollW, px + 0.5), rollW, fMax);
        const binLo = Math.max(0, Math.floor(Math.min(fLo, fHi) / binHz));
        const binHi = Math.min(maxBin, Math.ceil(Math.max(fLo, fHi) / binHz));
        let db = -Infinity;
        for (let b = binLo; b <= binHi; b++) {
          if (data[b] > db) db = data[b];
        }
        if (db === -Infinity) db = data[Math.min(maxBin, Math.max(0, Math.round(f / binHz)))];

        const normalized = Math.max(0, Math.min(1, (db - MIN_DB) / dbRange));
        const y = plotH * (1 - normalized);
        points.push({ x: AXIS_W + px, y, normalized });
      }

      // 3. stroke as individually colored segments
      for (let i = 1; i < points.length; i++) {
        const idx = Math.floor(points[i].normalized * 255);
        const R = SPECTRO_COLORMAP[idx * 3];
        const G = SPECTRO_COLORMAP[idx * 3 + 1];
        const B = SPECTRO_COLORMAP[idx * 3 + 2];
        ctx.strokeStyle = `rgb(${R},${G},${B})`;
        ctx.lineWidth   = 1.5 * dpr;
        ctx.beginPath();
        ctx.moveTo(points[i - 1].x, points[i - 1].y);
        ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();
      }

      // 4. area fill under curve, thermal gradient, reduced opacity
      if (points.length > 1) {
        const gradient = ctx.createLinearGradient(0, 0, 0, plotH);
        for (let s = 0; s <= 10; s++) {
          const t = s / 10;
          const idx = Math.floor(t * 255);
          const R = SPECTRO_COLORMAP[idx * 3];
          const G = SPECTRO_COLORMAP[idx * 3 + 1];
          const B = SPECTRO_COLORMAP[idx * 3 + 2];
          gradient.addColorStop(1 - t, `rgba(${R},${G},${B},${t})`);
        }

        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(points[0].x, plotH);
        for (const p of points) ctx.lineTo(p.x, p.y);
        ctx.lineTo(points[points.length - 1].x, plotH);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      // ── smoothed spectral envelope overlay, drawn on top of the comb ────
      if (points.length > 1) {
        const envelopePoints = smoothSpectrumEnvelope(points);
        envelopePoints.forEach((p) => { p.y = plotH * (1 - p.normalized); });

        ctx.beginPath();
        ctx.moveTo(envelopePoints[0].x, envelopePoints[0].y);
        for (let i = 1; i < envelopePoints.length; i++) {
          ctx.lineTo(envelopePoints[i].x, envelopePoints[i].y);
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2 * dpr;
        ctx.setLineDash([]);
        ctx.stroke();
      }

      // ── formant markers: one dashed vertical line + Hz label per detected
      // formant (F1/F2/F3), same LPC estimator the spectrogram uses ──────────
      if (timeData) {
        const formant = estimateFormants(timeData, sr!, prevFormant.current);
        prevFormant.current = formant;

        ctx.font         = `${11 * dpr}px monospace`;
        ctx.textAlign    = "center";
        ctx.textBaseline = "bottom";
        [formant.f1, formant.f2, formant.f3].forEach((f, i) => {
          if (f === null || f > fMax) return;
          const x = AXIS_W + freqToX(f, rollW, fMax);
          const color = FORMANT_COLORS[i];

          ctx.strokeStyle = color;
          ctx.lineWidth   = 1.5 * dpr;
          ctx.setLineDash([4 * dpr, 3 * dpr]);
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, plotH);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = color;
          ctx.fillText(`F${i + 1} ${Math.round(f)}Hz`, x, plotH - 3 * dpr - i * 12 * dpr);
        });
      }
    };
  }, [isRecording, isMonitoring, trackActive]);

  useEffect(() => {
    let rafId: number;
    const tick = () => { drawRef.current(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

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
        <span className="analysis-panel__hint">
          {isRecording || isMonitoring || trackActive ? "live" : "off"}
        </span>
      </div>
      <canvas ref={canvasRef} className="analysis-panel__canvas short-term-spectrum-panel__canvas" />
    </div>
  );
}
