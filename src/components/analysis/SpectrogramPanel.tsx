import { useRef, useEffect } from "react";
import { getMicAnalyser, getEngine, usePlayerStore } from "../../stores/player";
import { useExerciseStore } from "../../stores/exercise";
import { SPECTRO_COLORMAP } from "../../lib/spectroUtils";
import { estimateFormants, type FormantEstimate } from "../../lib/formants";
import { computeMagnitudeSpectrumDb } from "../../lib/fft";

// Matches the mic analyser's fftSize (see getMicAnalyser in stores/player.ts)
// so live and buffer-snapshot data are the same resolution.
const FFT_SIZE = 8192;

// ─── constants ───────────────────────────────────────────────────────────────

export const AXIS_W   = 56;
const WINDOW_S = 10;   // seconds visible across full roll width
export const F_MIN    = 30;
export const F_MAX    = 20000;

export const MIN_DB = -85; // floor -85dB — matches VoceVista dynamic range
export const MAX_DB = -20; // ceiling -20dB — loud bins reach top of thermal LUT

const FREQ_TICKS = [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

// ─── frequency ↔ canvas-row LUT (Float32 for bilinear interpolation) ─────────

function buildFreqBinLut(
  H: number,
  fftSize: number,
  sampleRate: number,
): { low: Uint16Array; high: Uint16Array } {
  const nyquist = sampleRate / 2;
  const fMax    = Math.min(F_MAX, nyquist);
  const binHz   = sampleRate / fftSize;
  const maxBin  = fftSize / 2 - 1;
  const logFMin = Math.log(F_MIN);
  const logFMax = Math.log(fMax);
  const low     = new Uint16Array(H);
  const high    = new Uint16Array(H);
  for (let py = 0; py < H; py++) {
    const tLo   = Math.max(0, (py - 0.5) / (H - 1));
    const tHi   = Math.min(1, (py + 0.5) / (H - 1));
    const fHigh = Math.exp(logFMax + tLo * (logFMin - logFMax));
    const fLow  = Math.exp(logFMax + tHi * (logFMin - logFMax));
    const binLow  = Math.max(0, Math.floor(fLow / binHz));
    let   binHigh = Math.min(maxBin, Math.ceil(fHigh / binHz));
    if (binHigh < binLow + 1) binHigh = Math.min(maxBin, binLow + 1);
    low[py]  = binLow;
    high[py] = binHigh;
  }
  return { low, high };
}

// ─── frequency axis ───────────────────────────────────────────────────────────

export function freqToY(f: number, H: number, fMax: number): number {
  const logFMin = Math.log(F_MIN);
  const logFMax = Math.log(fMax);
  return ((logFMax - Math.log(f)) / (logFMax - logFMin)) * H;
}

function formatHz(f: number): string {
  return f >= 1000 ? `${f / 1000}k` : `${f}`;
}

function drawFreqAxis(ctx: CanvasRenderingContext2D, H: number, sampleRate: number, dpr: number): void {
  const nyquist = sampleRate / 2;
  const fMax    = Math.min(F_MAX, nyquist);

  ctx.fillStyle = "#16213e";
  ctx.fillRect(0, 0, AXIS_W, H);

  ctx.strokeStyle = "#333";
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(AXIS_W - 1, 0);
  ctx.lineTo(AXIS_W - 1, H);
  ctx.stroke();

  ctx.font         = `${11 * dpr}px monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign    = "right";

  // 20k label pinned at top edge
  if (fMax >= 20000) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText("20k", AXIS_W - 6, 8 * dpr);
  }

  for (const f of FREQ_TICKS) {
    if (f > fMax || f === 20000) continue;
    const y = freqToY(f, H, fMax);
    if (y < 4 || y > H - 4) continue;

    const anchor    = f === 1000 || f === 5000;
    ctx.strokeStyle = anchor ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.3)";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(AXIS_W, y);
    ctx.lineTo(AXIS_W + 8, y);
    ctx.stroke();

    ctx.fillStyle = anchor ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.85)";
    ctx.fillText(formatHz(f), AXIS_W - 6, y);
  }
}

// ─── dB legend ────────────────────────────────────────────────────────────────

export const LEGEND_WIDTH  = 52;   // px reserved on right for legend
const BAR_WIDTH     = 10;   // px width of gradient bar
const LEGEND_MARGIN = 6;    // px gap between bar and labels
const LEGEND_TICKS  = [-20, -30, -40, -50, -60, -70, -80, -85];

function drawDbLegend(ctx: CanvasRenderingContext2D, W: number, H: number, dpr: number): void {
  const barX = W - LEGEND_WIDTH;

  // Inset the bar vertically so the min/max labels have room to render
  // fully instead of clipping at the canvas edge — this is what made
  // the legend feel "too tall" with the extremes barely visible.
  const padY  = 12 * dpr;
  const barTop = padY;
  const barH   = H - padY * 2;

  // Step 1: thermal gradient bar (only within the inset region)
  for (let r = 0; r < barH; r++) {
    const normalized = 1 - r / barH; // top = loud
    const curved = Math.pow(normalized, 0.38); // same gamma
    const idx = Math.floor(curved * 255);
    const R = SPECTRO_COLORMAP[idx * 3];
    const G = SPECTRO_COLORMAP[idx * 3 + 1];
    const B = SPECTRO_COLORMAP[idx * 3 + 2];
    ctx.fillStyle = `rgb(${R},${G},${B})`;
    ctx.fillRect(barX, barTop + r, BAR_WIDTH, 1);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth   = 1;
  ctx.strokeRect(barX, barTop, BAR_WIDTH, barH);

  // Step 2: dB tick labels — normalized against the existing floor/ceiling
  // constants (MIN_DB/MAX_DB) so the legend always matches them. Min/max
  // are bolded and brightened so the range endpoints stand out clearly.
  for (const dbValue of LEGEND_TICKS) {
    const isEdge     = dbValue === MAX_DB || dbValue === MIN_DB;
    const normalized = (dbValue - MIN_DB) / (MAX_DB - MIN_DB); // 0..1
    const y = barTop + (1 - normalized) * barH; // flip: loud = top

    ctx.strokeStyle = isEdge ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(barX - 2, y);
    ctx.lineTo(barX + BAR_WIDTH, y);
    ctx.stroke();

    ctx.fillStyle = isEdge ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.7)";
    ctx.font = isEdge ? `bold ${11 * dpr}px monospace` : `${9.5 * dpr}px monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`${dbValue}`, barX + BAR_WIDTH + LEGEND_MARGIN, y);
  }
}

// ─── component ───────────────────────────────────────────────────────────────

export default function SpectrogramPanel() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<OffscreenCanvas | HTMLCanvasElement | null>(null);
  const isRecording  = usePlayerStore((s) => s.isRecording);
  const isMonitoring = usePlayerStore((s) => s.isMonitoring);
  const isPlaying    = usePlayerStore((s) => s.isPlaying);
  const loadedTrackId = useExerciseStore((s) => s.loadedTrackId);
  // A loaded track snapshots its decoded buffer at the current playhead —
  // unlike a live AnalyserNode, this works whether playing, paused, or
  // scrubbed, so "active" (i.e. showing something at all) doesn't depend on
  // isPlaying. Whether the waterfall keeps *scrolling* still does — see
  // shouldScroll below.
  const trackActive  = loadedTrackId !== null;
  const shouldScroll = isRecording || isMonitoring || (trackActive && isPlaying);

  const lastCapture = useRef(0);
  const shiftAccum  = useRef(0);
  const fftScratch  = useRef<Float32Array<ArrayBuffer> | null>(null);
  const timeScratch = useRef<Float32Array<ArrayBuffer> | null>(null);
  const colNorms    = useRef<Float32Array | null>(null);
  const freqLut     = useRef<{ low: Uint16Array; high: Uint16Array; H: number; sr: number } | null>(null);
  const drawRef     = useRef<() => void>(() => {});
  const prevFormant = useRef<FormantEstimate>({ f1: null, f2: null, f3: null });
  const srRef       = useRef(48000);

  useEffect(() => {
    console.log('[Spectrogram] thermal LUT active, gamma=0.4, blur=3-tap');
  }, []);

  useEffect(() => {
    console.log('[Spectrogram] dB range: floor=-85, ceiling=-20, span=65dB');
  }, []);

  useEffect(() => {
    console.log('[Spectrogram] LUT: nearest-neighbor, gamma=0.35');
  }, []);

  useEffect(() => {
    console.log('[Spectrogram] LUT: max-in-range, gamma=0.38');
  }, []);

  useEffect(() => {
    console.log('[Spectrogram] soft gate: threshold=0.15');
  }, []);

  useEffect(() => {
    console.log('[Spectrogram] dB legend: -85 to -20 dB, width=48px');
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
      const rollW = W - AXIS_W - LEGEND_WIDTH;

      // Resize main canvas and invalidate offscreen if dimensions changed
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width     = W;
        canvas.height    = H;
        freqLut.current  = null;
        offscreenRef.current = null;
      }

      // Lazily create offscreen — sized to roll area only (rollW × H)
      if (
        !offscreenRef.current ||
        offscreenRef.current.width  !== rollW ||
        offscreenRef.current.height !== H
      ) {
        try {
          offscreenRef.current = new OffscreenCanvas(rollW, H);
        } catch {
          const fb = document.createElement("canvas");
          fb.width  = rollW;
          fb.height = H;
          offscreenRef.current = fb;
        }
        const oc = offscreenRef.current;
        const ic = oc instanceof OffscreenCanvas
          ? oc.getContext("2d")
          : (oc as HTMLCanvasElement).getContext("2d");
        if (ic) { ic.fillStyle = "#000"; ic.fillRect(0, 0, rollW, H); }
      }

      const offscreen = offscreenRef.current;
      const offCtx = offscreen instanceof OffscreenCanvas
        ? offscreen.getContext("2d")
        : (offscreen as HTMLCanvasElement).getContext("2d");
      if (!offCtx) return;

      const active = isRecording || isMonitoring || trackActive;

      // ── capture + scroll (~30 fps) ──────────────────────────────────────────
      const now = performance.now();
      if (now - lastCapture.current >= 33) {
        lastCapture.current = now;

        // Resolve this frame's data source: a loaded track snapshots its
        // decoded buffer at the current playhead (works paused or playing);
        // otherwise fall back to the live mic AnalyserNode.
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
            analyser.smoothingTimeConstant = 0.15;
            const binCount = analyser.frequencyBinCount;
            if (!fftScratch.current || fftScratch.current.length !== binCount) {
              fftScratch.current = new Float32Array(binCount);
            }
            if (!timeScratch.current || timeScratch.current.length !== analyser.fftSize) {
              timeScratch.current = new Float32Array(analyser.fftSize);
            }
            analyser.getFloatFrequencyData(fftScratch.current);
            analyser.getFloatTimeDomainData(timeScratch.current);
            sr = analyser.context.sampleRate;
            freqData = fftScratch.current;
            timeData = timeScratch.current;
          }
        }

        if (active && sr !== null && freqData !== null) {
          srRef.current = sr;
          if (!colNorms.current || colNorms.current.length !== H) {
            colNorms.current = new Float32Array(H);
          }

          const data    = freqData;
          const binCount = data.length;
          const fftSize = binCount * 2;

          if (!freqLut.current || freqLut.current.H !== H || freqLut.current.sr !== sr) {
            const { low, high } = buildFreqBinLut(H, fftSize, sr);
            freqLut.current = { low, high, H, sr };
            const rowAt = (freq: number) =>
              Math.floor(H * (1 - Math.log(freq / F_MIN) / Math.log((Math.min(F_MAX, sr / 2)) / F_MIN)));
            console.log(`SpectroLUT — H:${H} fftSize:${fftSize} sr:${sr} binHz:${(sr / fftSize).toFixed(2)}`);
            console.log("2kHz bin range:", low[rowAt(2000)], high[rowAt(2000)]);
            console.log("5kHz bin range:", low[rowAt(5000)], high[rowAt(5000)]);
          }

          const lutLow  = freqLut.current.low;
          const lutHigh = freqLut.current.high;
          const norms   = colNorms.current;
          const dbRange = MAX_DB - MIN_DB;
          const colLut  = SPECTRO_COLORMAP;

          // Pass 1: dB → normalised magnitude for each canvas row
          for (let py = 0; py < H; py++) {
            // max-in-range bin mapping — fills gaps on log scale
            let maxDb = -Infinity;
            for (let b = lutLow[py]; b <= lutHigh[py]; b++) {
              if (data[b] > maxDb) maxDb = data[b];
            }
            const db   = maxDb;
            const norm   = db < -80 ? 0 : Math.max(0, Math.min(1, (db - MIN_DB) / dbRange));
            // soft gate pushes noise floor to black like VoceVista
            const gated = norm < 0.15
              ? norm * (norm / 0.15) * 0.3
              : norm;
            // gamma 0.38 — preserves fundamental peak brightness
            const curved = Math.pow(gated, 0.38);
            norms[py]  = curved;
          }

          // Scrolling (shifting existing history left + appending new columns)
          // only makes sense while audio is actually advancing. Paused/scrubbed
          // with a loaded track: leave prior history in place and just
          // overwrite a fixed-width strip at the right edge with the current
          // frame's snapshot, so scrubbing updates the view without an
          // otherwise-empty waterfall endlessly "scrolling" a frozen value.
          let shift: number;
          if (shouldScroll) {
            shiftAccum.current += rollW * 33 / (WINDOW_S * 1000);
            shift = Math.max(1, Math.floor(shiftAccum.current));
            shiftAccum.current -= shift;
            const shifted = offCtx.getImageData(shift, 0, rollW - shift, H);
            offCtx.putImageData(shifted, 0, 0);
          } else {
            shift = Math.min(6, rollW);
          }

          // Pass 2: write `shift` new columns at right (no vertical blur —
          // relies on temporal blending only)
          const colImg = offCtx.createImageData(shift, H);
          const cd     = colImg.data;
          for (let py = 0; py < H; py++) {
            const curr    = norms[py];
            const ci      = Math.min(255, Math.floor(curr * 255));
            for (let s = 0; s < shift; s++) {
              const base    = (py * shift + s) * 4;
              cd[base]      = colLut[ci * 3];
              cd[base + 1]  = colLut[ci * 3 + 1];
              cd[base + 2]  = colLut[ci * 3 + 2];
              cd[base + 3]  = 255;
            }
          }
          offCtx.putImageData(colImg, rollW - shift, 0);

          // ── formant ticks — F1/F2/F3, drawn into the same new column so
          // they scroll with the spectrogram history and leave a trail ──────
          if (timeData) {
            const formant = estimateFormants(timeData, sr, prevFormant.current);
            prevFormant.current = formant;

            const fMaxTick = Math.min(F_MAX, sr / 2);
            offCtx.fillStyle = "#e8fbff";
            for (const f of [formant.f1, formant.f2, formant.f3]) {
              if (f === null) continue;
              const y = freqToY(f, H, fMaxTick);
              if (y < 0 || y > H) continue;
              offCtx.fillRect(rollW - shift, Math.max(0, y - 1), shift, 2);
            }
          }

        } else if (active) {
          // Active but analyser not ready yet — silence columns
          shiftAccum.current += rollW * 33 / (WINDOW_S * 1000);
          const shift = Math.max(1, Math.floor(shiftAccum.current));
          shiftAccum.current -= shift;
          const shifted = offCtx.getImageData(shift, 0, rollW - shift, H);
          offCtx.putImageData(shifted, 0, 0);
          offCtx.fillStyle = "#000000";
          offCtx.fillRect(rollW - shift, 0, shift, H);
        }
        // Not active: no shift — canvas freezes at last frame
      }

      // ── composite to main canvas ────────────────────────────────────────────
      // Active: blend offscreen at 72% over previous frame (temporal smoothing).
      // Idle: clear roll area so stale spectrogram doesn't linger.
      if (active) {
        ctx.globalAlpha = 0.72;
        ctx.drawImage(offscreen, AXIS_W, 0);
        ctx.globalAlpha = 1.0;
      } else {
        ctx.fillStyle = "#0f0f1e";
        ctx.fillRect(AXIS_W, 0, rollW, H);
      }

      // Grid lines and axis always drawn at full opacity after composite
      const sr        = srRef.current;
      const nyquist   = sr / 2;
      const fMax      = Math.min(F_MAX, nyquist);
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.lineWidth   = 0.5;
      for (const f of [100, 500, 1000, 5000, 10000]) {
        if (f > fMax) continue;
        const y = freqToY(f, H, fMax);
        if (y < 0 || y > H) continue;
        ctx.beginPath();
        ctx.moveTo(AXIS_W, y);
        ctx.lineTo(W - LEGEND_WIDTH, y);
        ctx.stroke();
      }
      ctx.restore();

      drawFreqAxis(ctx, H, sr, dpr);
      drawDbLegend(ctx, W, H, dpr);

      if (!active) {
        ctx.fillStyle    = "#a0a0b040";
        ctx.font         = `${11 * dpr}px sans-serif`;
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Enable Monitor or Record to see spectrum", AXIS_W + rollW / 2, H / 2);
      }
    };
  }, [isRecording, isMonitoring, trackActive, shouldScroll]);

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
        <span className="analysis-panel__label">Spectrum</span>
        <span className="analysis-panel__hint">
          {isRecording || isMonitoring || trackActive ? "live" : "off"}
        </span>
      </div>
      <canvas ref={canvasRef} className="analysis-panel__canvas spectro-panel__canvas" />
    </div>
  );
}
