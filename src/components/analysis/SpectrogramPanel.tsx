import { useRef, useEffect } from "react";
import { getEngine, getMicAnalyser, usePlayerStore } from "../../stores/player";
import { SPECTRO_COLORMAP } from "../../lib/spectroUtils";

// ─── constants ───────────────────────────────────────────────────────────────

const AXIS_W   = 48;     // canvas px reserved for frequency axis labels
const WINDOW_S = 8;      // seconds visible in the scrolling window
const F_MIN    = 20;     // Hz — practical log-scale floor (log(0) is undefined)
const F_MAX    = 20000;  // Hz — upper limit; clamped to Nyquist at runtime

// Frequency tick marks drawn on the Y axis
const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

// ─── frequency ↔ canvas-row LUT ──────────────────────────────────────────────
//
// Log-frequency axis: top = fMax, bottom = fMin.
// Each canvas pixel row gets the FFT bin index for its frequency.

function buildFreqBinLut(
  H: number,
  fftSize: number,
  sampleRate: number,
): Uint16Array {
  const nyquist = sampleRate / 2;
  const fMax    = Math.min(F_MAX, nyquist);
  const binHz   = sampleRate / fftSize;
  const maxBin  = fftSize / 2 - 1;
  const logFMin = Math.log(F_MIN);
  const logFMax = Math.log(fMax);
  const lut     = new Uint16Array(H);
  for (let py = 0; py < H; py++) {
    const t = py / (H - 1);                                      // 0 = top, 1 = bottom
    const f = Math.exp(logFMax + t * (logFMin - logFMax));       // log interp top→bottom
    lut[py] = Math.max(0, Math.min(maxBin, Math.round(f / binHz)));
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

function drawFreqAxis(ctx: CanvasRenderingContext2D, H: number, sampleRate: number): void {
  const nyquist = sampleRate / 2;
  const fMax    = Math.min(F_MAX, nyquist);

  ctx.fillStyle = "#090914";
  ctx.fillRect(0, 0, AXIS_W, H);

  ctx.strokeStyle = "#333";
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(AXIS_W - 1, 0);
  ctx.lineTo(AXIS_W - 1, H);
  ctx.stroke();

  ctx.font         = "9px monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign    = "right";

  for (const f of FREQ_TICKS) {
    if (f > fMax) continue;
    const y = freqToY(f, H, fMax);
    if (y < 4 || y > H - 4) continue;

    ctx.strokeStyle = "#2a3a4e";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(AXIS_W - 5, y);
    ctx.lineTo(AXIS_W, y);
    ctx.stroke();

    ctx.fillStyle = "#6a7a8e";
    ctx.fillText(formatHz(f), AXIS_W - 7, y);
  }
}

// ─── component ───────────────────────────────────────────────────────────────

export default function SpectrogramPanel() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const isRecording  = usePlayerStore((s) => s.isRecording);
  const isMonitoring = usePlayerStore((s) => s.isMonitoring);

  const buffer      = useRef<{ time: number; data: Uint8Array }[]>([]);
  const lastCapture = useRef(0);
  const fftScratch  = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const freqLut     = useRef<{ lut: Uint16Array; H: number; sr: number } | null>(null);
  const drawRef     = useRef<() => void>(() => {});

  useEffect(() => {
    if (!isRecording && !isMonitoring) {
      buffer.current = [];
    }
  }, [isRecording, isMonitoring]);

  useEffect(() => {
    drawRef.current = () => {
      // ── capture full FFT from mic (throttled ~30 fps) ───────────────────────
      if (isRecording || isMonitoring) {
        const now = performance.now();
        if (now - lastCapture.current >= 33) {
          lastCapture.current = now;
          const analyser = getMicAnalyser();
          if (analyser) {
            const binCount = analyser.frequencyBinCount;
            if (!fftScratch.current || fftScratch.current.length !== binCount) {
              fftScratch.current = new Uint8Array(binCount);
            }
            analyser.getByteFrequencyData(fftScratch.current);
            const col = new Uint8Array(fftScratch.current);
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

      const W = canvas.offsetWidth  || 600;
      const H = canvas.offsetHeight || 200;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width  = W;
        canvas.height = H;
        freqLut.current = null;
      }

      ctx.fillStyle = "#0f0f1e";
      ctx.fillRect(0, 0, W, H);

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

        const img = ctx.createImageData(rollW, H);
        const d   = img.data;

        let bi = 0;
        for (let px = 0; px < rollW; px++) {
          const tPx = t0 + (px / rollW) * WINDOW_S;
          while (bi < buffer.current.length - 1 && buffer.current[bi + 1].time <= tPx) bi++;
          const entry = buffer.current[bi];
          if (!entry || Math.abs(entry.time - tPx) > 1.0) continue;
          const data = entry.data;

          for (let py = 0; py < H; py++) {
            const val = data[lut[py]];
            const idx = (py * rollW + px) * 4;
            d[idx]     = colLut[val * 3];
            d[idx + 1] = colLut[val * 3 + 1];
            d[idx + 2] = colLut[val * 3 + 2];
            d[idx + 3] = val < 8 ? 0 : 230;
          }
        }
        ctx.putImageData(img, AXIS_W, 0);

        // Horizontal grid lines at each tick frequency
        const nyquist = sr / 2;
        const fMax    = Math.min(F_MAX, nyquist);
        ctx.save();
        ctx.strokeStyle = "#ffffff08";
        ctx.lineWidth   = 1;
        for (const f of FREQ_TICKS) {
          if (f > fMax) continue;
          const y = freqToY(f, H, fMax);
          if (y < 0 || y > H) continue;
          ctx.beginPath();
          ctx.moveTo(AXIS_W, y);
          ctx.lineTo(W, y);
          ctx.stroke();
        }
        ctx.restore();

        drawFreqAxis(ctx, H, sr);
      } else {
        const analyser = getMicAnalyser();
        const sr       = analyser?.context.sampleRate ?? 48000;
        drawFreqAxis(ctx, H, sr);

        if (!isRecording && !isMonitoring) {
          ctx.fillStyle    = "#a0a0b040";
          ctx.font         = "11px sans-serif";
          ctx.textAlign    = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("Enable Monitor or Record to see spectrum", AXIS_W + rollW / 2, H / 2);
        }
      }

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
