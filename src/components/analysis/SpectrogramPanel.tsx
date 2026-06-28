import { useRef, useEffect } from "react";
import { getMicAnalyser, usePlayerStore } from "../../stores/player";
import { SPECTRO_COLORMAP } from "../../lib/spectroUtils";

// ─── constants ───────────────────────────────────────────────────────────────

const AXIS_W = 56;
const F_MIN  = 20;
const F_MAX  = 20000;

export const MIN_DB = -65;
export const MAX_DB = -10;

const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

// ─── frequency ↔ canvas-row LUT (Float32 for bilinear interpolation) ─────────

function buildFreqBinLut(
  H: number,
  fftSize: number,
  sampleRate: number,
): Float32Array {
  const nyquist = sampleRate / 2;
  const fMax    = Math.min(F_MAX, nyquist);
  const binHz   = sampleRate / fftSize;
  const maxBin  = fftSize / 2 - 1;
  const logFMin = Math.log(F_MIN);
  const logFMax = Math.log(fMax);
  const lut     = new Float32Array(H);
  for (let py = 0; py < H; py++) {
    const t = py / (H - 1);
    const f = Math.exp(logFMax + t * (logFMin - logFMax));
    lut[py] = Math.max(0, Math.min(maxBin, f / binHz));
  }
  return lut;
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
  const fftScratch  = useRef<Float32Array<ArrayBuffer> | null>(null);
  const colNorms    = useRef<Float32Array | null>(null);
  const freqLut     = useRef<{ lut: Float32Array; H: number; sr: number } | null>(null);
  const drawRef     = useRef<() => void>(() => {});

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
          analyser.smoothingTimeConstant = 0;
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
            freqLut.current = { lut: buildFreqBinLut(H, fftSize, sr), H, sr };
            const lut = freqLut.current.lut;
            console.log(`SpectroLUT — H:${H} fftSize:${fftSize} sr:${sr} binHz:${(sr / fftSize).toFixed(2)}`);
            console.log("2kHz bin:", lut[Math.floor(H * (1 - Math.log(2000 / 20) / Math.log(20000 / 20)))]);
            console.log("5kHz bin:", lut[Math.floor(H * (1 - Math.log(5000 / 20) / Math.log(20000 / 20)))]);
          }

          const lut     = freqLut.current.lut;
          const data    = fftScratch.current;
          const norms   = colNorms.current;
          const dbRange = MAX_DB - MIN_DB;
          const colLut  = SPECTRO_COLORMAP;

          // Pass 1: dB → normalised magnitude for each canvas row
          for (let py = 0; py < H; py++) {
            const idx  = lut[py];
            const lo   = Math.floor(idx);
            const hi   = Math.min(lo + 1, data.length - 1);
            const frac = idx - lo;
            const db   = data[lo] * (1 - frac) + data[hi] * frac;
            let norm   = db < -72 ? 0 : Math.max(0, Math.min(1, (db - MIN_DB) / dbRange));
            norm       = Math.pow(norm, 0.55);
            norms[py]  = norm;
          }

          // Shift offscreen left by exactly 1 pixel
          const shifted = offCtx.getImageData(1, 0, rollW - 1, H);
          offCtx.putImageData(shifted, 0, 0);

          // Pass 2: 3-tap Gaussian bloom → write rightmost column
          const colImg = offCtx.createImageData(1, H);
          const cd     = colImg.data;
          for (let py = 0; py < H; py++) {
            const prev    = norms[Math.max(0, py - 1)];
            const curr    = norms[py];
            const next    = norms[Math.min(H - 1, py + 1)];
            const blurred = 0.25 * prev + 0.50 * curr + 0.25 * next;
            const ci      = Math.min(255, Math.floor(blurred * 255));
            const base    = py * 4;
            cd[base]      = colLut[ci * 3];
            cd[base + 1]  = colLut[ci * 3 + 1];
            cd[base + 2]  = colLut[ci * 3 + 2];
            cd[base + 3]  = 255;
          }
          offCtx.putImageData(colImg, rollW - 1, 0);

        } else if (active) {
          // Active but analyser not ready yet — silence column
          const shifted = offCtx.getImageData(1, 0, rollW - 1, H);
          offCtx.putImageData(shifted, 0, 0);
          offCtx.fillStyle = "#000000";
          offCtx.fillRect(rollW - 1, 0, 1, H);
        }
        // Not active: no shift — canvas freezes at last frame
      }

      // ── composite to main canvas ────────────────────────────────────────────
      ctx.fillStyle = "#0f0f1e";
      ctx.fillRect(0, 0, W, H);

      if (active) {
        ctx.drawImage(offscreen, AXIS_W, 0);
      }

      // Grid lines drawn after composite so they stay crisp
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
