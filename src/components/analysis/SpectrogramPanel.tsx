import { useRef, useEffect } from "react";
import { getMicAnalyser, usePlayerStore } from "../../stores/player";
import { SPECTRO_COLORMAP } from "../../lib/spectroUtils";

// ─── constants ───────────────────────────────────────────────────────────────

const AXIS_W   = 56;
const WINDOW_S = 10;   // seconds visible across full roll width
const F_MIN    = 30;
const F_MAX    = 20000;

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

function freqToY(f: number, H: number, fMax: number): number {
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

// ─── component ───────────────────────────────────────────────────────────────

export default function SpectrogramPanel() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<OffscreenCanvas | HTMLCanvasElement | null>(null);
  const isRecording  = usePlayerStore((s) => s.isRecording);
  const isMonitoring = usePlayerStore((s) => s.isMonitoring);

  const lastCapture = useRef(0);
  const shiftAccum  = useRef(0);
  const fftScratch  = useRef<Float32Array<ArrayBuffer> | null>(null);
  const colNorms    = useRef<Float32Array | null>(null);
  const freqLut     = useRef<{ low: Uint16Array; high: Uint16Array; H: number; sr: number } | null>(null);
  const drawRef     = useRef<() => void>(() => {});

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
      const rollW = W - AXIS_W;

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

      const active = isRecording || isMonitoring;

      // ── capture + scroll (~30 fps) ──────────────────────────────────────────
      const now = performance.now();
      if (now - lastCapture.current >= 33) {
        lastCapture.current = now;

        const analyser = getMicAnalyser();

        if (active && analyser) {
          analyser.smoothingTimeConstant = 0.15;
          const binCount = analyser.frequencyBinCount;

          if (!fftScratch.current || fftScratch.current.length !== binCount) {
            fftScratch.current = new Float32Array(binCount);
          }
          if (!colNorms.current || colNorms.current.length !== H) {
            colNorms.current = new Float32Array(H);
          }

          analyser.getFloatFrequencyData(fftScratch.current);

          const sr      = analyser.context.sampleRate;
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
          const data    = fftScratch.current;
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
            // gamma 0.38 — preserves fundamental peak brightness
            const curved = Math.pow(norm, 0.38);
            norms[py]  = curved;
          }

          // Dynamic shift: rollW pixels spans WINDOW_S seconds at ~30 fps
          shiftAccum.current += rollW * 33 / (WINDOW_S * 1000);
          const shift = Math.max(1, Math.floor(shiftAccum.current));
          shiftAccum.current -= shift;

          const shifted = offCtx.getImageData(shift, 0, rollW - shift, H);
          offCtx.putImageData(shifted, 0, 0);

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
      const analyser  = getMicAnalyser();
      const sr        = analyser?.context.sampleRate ?? 48000;
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
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      ctx.restore();

      drawFreqAxis(ctx, H, sr, dpr);

      if (!active) {
        ctx.fillStyle    = "#a0a0b040";
        ctx.font         = `${11 * dpr}px sans-serif`;
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Enable Monitor or Record to see spectrum", AXIS_W + rollW / 2, H / 2);
      }
    };
  }, [isRecording, isMonitoring]);

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
          {isRecording || isMonitoring ? "live" : "off"}
        </span>
      </div>
      <canvas ref={canvasRef} className="analysis-panel__canvas spectro-panel__canvas" />
    </div>
  );
}
