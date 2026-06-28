import { useRef, useEffect } from "react";
import { getEngine, getMicAnalyser, usePlayerStore } from "../../stores/player";
import { SPECTRO_COLORMAP } from "../../lib/spectroUtils";

// ─── constants ───────────────────────────────────────────────────────────────

const AXIS_W   = 56;
const WINDOW_S = 8;
const F_MIN    = 20;
const F_MAX    = 20000;

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

    const anchor  = f === 1000 || f === 5000;
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

  const buffer      = useRef<{ time: number; data: Float32Array }[]>([]);
  const lastCapture = useRef(0);
  const fftScratch  = useRef<Float32Array<ArrayBuffer> | null>(null);
  const freqLut     = useRef<{ lut: Float32Array; H: number; sr: number } | null>(null);
  const drawRef     = useRef<() => void>(() => {});

  useEffect(() => {
    if (!isRecording && !isMonitoring) {
      buffer.current = [];
    }
  }, [isRecording, isMonitoring]);

  useEffect(() => {
    drawRef.current = () => {
      // ── capture float FFT from mic (throttled ~30 fps) ──────────────────────
      if (isRecording || isMonitoring) {
        const now = performance.now();
        if (now - lastCapture.current >= 33) {
          lastCapture.current = now;
          const analyser = getMicAnalyser();
          if (analyser) {
            analyser.smoothingTimeConstant = 0;
            const binCount = analyser.frequencyBinCount;
            if (!fftScratch.current || fftScratch.current.length !== binCount) {
              fftScratch.current = new Float32Array(binCount);
            }
            analyser.getFloatFrequencyData(fftScratch.current);
            const col = new Float32Array(fftScratch.current);
            const t   = getEngine().getCurrentTime();
            buffer.current.push({ time: t, data: col });
            const cutoff = t - WINDOW_S;
            const keep   = buffer.current.findIndex((e) => e.time >= cutoff);
            if (keep > 0) buffer.current.splice(0, keep);
          }
        }
      }

      // ── draw ────────────────────────────────────────────────────────────────
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth  || 600;
      const cssH = canvas.clientHeight || 200;
      const W = Math.round(cssW * dpr);
      const H = Math.round(cssH * dpr);

      if (canvas.width !== W || canvas.height !== H) {
        canvas.width  = W;
        canvas.height = H;
        freqLut.current = null;

        // Resize or create offscreen canvas
        if (offscreenRef.current) {
          if (offscreenRef.current instanceof OffscreenCanvas) {
            offscreenRef.current = new OffscreenCanvas(W, H);
          } else {
            offscreenRef.current.width  = W;
            offscreenRef.current.height = H;
          }
        }
      }

      // Lazily create offscreen canvas
      if (!offscreenRef.current) {
        try {
          offscreenRef.current = new OffscreenCanvas(W, H);
        } catch {
          const fb = document.createElement("canvas");
          fb.width  = W;
          fb.height = H;
          offscreenRef.current = fb;
        }
      }

      const offscreen = offscreenRef.current;
      const offCtx = offscreen instanceof OffscreenCanvas
        ? offscreen.getContext("2d")
        : (offscreen as HTMLCanvasElement).getContext("2d");
      if (!offCtx) return;

      const rollW = W - AXIS_W;
      const t     = getEngine().getCurrentTime();
      const t0    = t - WINDOW_S / 2;

      if (buffer.current.length >= 2) {
        const analyser = getMicAnalyser();
        const sr       = analyser?.context.sampleRate ?? 48000;
        const fftSize  = buffer.current[0].data.length * 2;

        if (!freqLut.current || freqLut.current.H !== H || freqLut.current.sr !== sr) {
          freqLut.current = { lut: buildFreqBinLut(H, fftSize, sr), H, sr };
        }
        const lut    = freqLut.current.lut;
        const colLut = SPECTRO_COLORMAP;
        const dbRange = MAX_DB - MIN_DB;

        const img = offCtx.createImageData(rollW, H);
        const d   = img.data;

        let bi = 0;
        for (let px = 0; px < rollW; px++) {
          const tPx = t0 + (px / rollW) * WINDOW_S;
          while (bi < buffer.current.length - 1 && buffer.current[bi + 1].time <= tPx) bi++;
          const entry = buffer.current[bi];
          if (!entry || Math.abs(entry.time - tPx) > 1.0) {
            for (let py = 0; py < H; py++) d[(py * rollW + px) * 4 + 3] = 255;
            continue;
          }
          const data = entry.data;

          for (let py = 0; py < H; py++) {
            const idx  = lut[py];
            const lo   = Math.floor(idx);
            const hi   = Math.min(lo + 1, data.length - 1);
            const frac = idx - lo;
            const db   = data[lo] * (1 - frac) + data[hi] * frac;

            let norm = db < -62 ? 0 : Math.max(0, Math.min(1, (db - MIN_DB) / dbRange));
            norm = Math.pow(norm, 0.55);
            const ci   = Math.min(255, Math.floor(norm * 255));

            const base = (py * rollW + px) * 4;
            d[base]     = colLut[ci * 3];
            d[base + 1] = colLut[ci * 3 + 1];
            d[base + 2] = colLut[ci * 3 + 2];
            d[base + 3] = 255;
          }
        }
        offCtx.putImageData(img, 0, 0);

        // Composite offscreen onto main canvas with temporal blending
        ctx.fillStyle = "#0f0f1e";
        ctx.fillRect(AXIS_W, 0, rollW, H);
        ctx.globalAlpha = 0.72;
        ctx.drawImage(offscreen, AXIS_W, 0);
        ctx.globalAlpha = 1.0;

        // Frequency grid lines on main canvas (after composite so they stay crisp)
        const nyquist = sr / 2;
        const fMax    = Math.min(F_MAX, nyquist);
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

        // Center playhead reference line
        const cx = AXIS_W + rollW / 2;
        ctx.save();
        ctx.strokeStyle = "#ffffff18";
        ctx.lineWidth   = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, H);
        ctx.stroke();
        ctx.restore();

        // Time ticks along top edge — one per whole second in the visible window
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.lineWidth   = 1;
        ctx.setLineDash([]);
        const tFirst = Math.ceil(t0);
        const tLast  = Math.floor(t0 + WINDOW_S);
        for (let s = tFirst; s <= tLast; s++) {
          const x = AXIS_W + ((s - t0) / WINDOW_S) * rollW;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, 4 * dpr);
          ctx.stroke();
        }
        ctx.restore();


        drawFreqAxis(ctx, H, sr, dpr);
      } else {
        ctx.fillStyle = "#0f0f1e";
        ctx.fillRect(0, 0, W, H);

        const analyser = getMicAnalyser();
        const sr       = analyser?.context.sampleRate ?? 48000;
        drawFreqAxis(ctx, H, sr, dpr);

        if (!isRecording && !isMonitoring) {
          ctx.fillStyle    = "#a0a0b040";
          ctx.font         = `${11 * dpr}px sans-serif`;
          ctx.textAlign    = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("Enable Monitor or Record to see spectrum", AXIS_W + rollW / 2, H / 2);
        }
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
