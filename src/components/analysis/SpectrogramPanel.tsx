import { useRef, useEffect } from "react";
import { getEngine, getMicAnalyser, usePlayerStore } from "../../stores/player";
import { SPECTRO_COLORMAP, MIDI_MIN, MIDI_MAX } from "../../lib/spectroUtils";

// ─── constants ───────────────────────────────────────────────────────────────

const PIANO_W  = 36;     // canvas px — matches PianoRoll piano strip width
const WINDOW_S = 8;      // seconds visible in the scrolling window
const N_NOTES  = MIDI_MAX - MIDI_MIN + 1;
const BLACK_PC = new Set([1, 3, 6, 8, 10]);

// ─── frequency ↔ canvas-row mapping ──────────────────────────────────────────
//
// The Y-axis is linear in MIDI (= logarithmic in Hz), matching the piano strip.
// For each canvas pixel row py (0 = top = MIDI_MAX, H-1 = bottom = MIDI_MIN),
// we pre-compute the FFT bin index that holds that frequency.
// This gives pixel-exact frequency resolution — no note quantisation.

function buildFreqBinLut(H: number, fftSize: number, sampleRate: number): Uint16Array {
  const lut    = new Uint16Array(H);
  const binHz  = sampleRate / fftSize;       // Hz per bin
  const maxBin = fftSize / 2 - 1;
  for (let py = 0; py < H; py++) {
    const midi = MIDI_MAX - (py / H) * N_NOTES;
    const f    = 440 * Math.pow(2, (midi - 69) / 12);
    lut[py]    = Math.max(0, Math.min(maxBin, Math.round(f / binHz)));
  }
  return lut;
}

// ─── piano strip (frequency-axis labels) ─────────────────────────────────────
//
// Draws note lane backgrounds and C-octave labels aligned to the log-freq axis.

function drawPianoStrip(ctx: CanvasRenderingContext2D, H: number): void {
  ctx.fillStyle = "#090914";
  ctx.fillRect(0, 0, PIANO_W, H);

  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    // Y centre for this note using the same MIDI-linear formula
    const normTop = (MIDI_MAX - m) / N_NOTES;
    const normBot = (MIDI_MAX - m + 1) / N_NOTES;
    const yTop    = normTop * H;
    const yBot    = normBot * H;
    const nh      = yBot - yTop;
    const blk     = BLACK_PC.has(((m % 12) + 12) % 12);

    if (blk) {
      ctx.fillStyle = "#1c1c1c";
      ctx.fillRect(1, yTop + 0.5, PIANO_W * 0.60, nh - 1);
    } else {
      ctx.fillStyle = "#2a2a3a";
      ctx.fillRect(1, yTop + 0.5, PIANO_W - 3, nh - 1);

      if ((m % 12) === 0) {
        const octave = Math.floor(m / 12) - 1;
        const fs     = Math.max(7, Math.min(10, nh * 0.78));
        const yMid   = (yTop + yBot) / 2;
        ctx.fillStyle    = "#555";
        ctx.font         = `${fs}px sans-serif`;
        ctx.textAlign    = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(`C${octave}`, PIANO_W - 4, yMid);
      }
    }
  }

  ctx.fillStyle = "#333";
  ctx.fillRect(PIANO_W - 1, 0, 1, H);
}

// ─── component ───────────────────────────────────────────────────────────────

export default function SpectrogramPanel() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const isRecording  = usePlayerStore((s) => s.isRecording);
  const isMonitoring = usePlayerStore((s) => s.isMonitoring);

  // Buffer stores raw FFT byte arrays — full bin resolution, no note quantisation
  const buffer      = useRef<{ time: number; data: Uint8Array }[]>([]);
  const lastCapture = useRef(0);
  const fftScratch  = useRef<Uint8Array<ArrayBuffer> | null>(null);

  // Cached LUT: rebuilt only when canvas height or analyser sample-rate changes
  const freqLut     = useRef<{ lut: Uint16Array; H: number; sr: number } | null>(null);

  const drawRef = useRef<() => void>(() => {});

  // Clear buffer when mic goes fully inactive
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
            // Store a copy — raw bins, no note quantisation
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
      const H = canvas.offsetHeight || 144;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width  = W;
        canvas.height = H;
        freqLut.current = null; // invalidate when size changes
      }

      ctx.fillStyle = "#0f0f1e";
      ctx.fillRect(0, 0, W, H);

      const rollW = W - PIANO_W;
      const t     = getEngine().getCurrentTime();
      const t0    = t - WINDOW_S / 2;

      if (buffer.current.length >= 2) {
        const analyser = getMicAnalyser();
        const sr       = analyser?.context.sampleRate ?? 48000;
        const fftSize  = (buffer.current[0].data.length) * 2; // binCount = fftSize/2

        // Rebuild LUT only when canvas height or sample rate changes
        if (!freqLut.current || freqLut.current.H !== H || freqLut.current.sr !== sr) {
          freqLut.current = { lut: buildFreqBinLut(H, fftSize, sr), H, sr };
        }
        const lut    = freqLut.current.lut;
        const colLut = SPECTRO_COLORMAP;

        // Per-pixel ImageData — one pixel column per canvas X, one bin per canvas Y
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
            const val = data[lut[py]];   // lut[py] = FFT bin for this pixel row
            const idx = (py * rollW + px) * 4;
            d[idx]     = colLut[val * 3];
            d[idx + 1] = colLut[val * 3 + 1];
            d[idx + 2] = colLut[val * 3 + 2];
            d[idx + 3] = val < 8 ? 0 : 230;
          }
        }
        ctx.putImageData(img, PIANO_W, 0);
      } else if (!isRecording && !isMonitoring) {
        ctx.fillStyle    = "#a0a0b040";
        ctx.font         = "11px sans-serif";
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Enable Monitor or Record to see spectrum", (PIANO_W + W) / 2, H / 2);
      }

      // Center playhead reference line
      const cx = PIANO_W + rollW / 2;
      ctx.save();
      ctx.strokeStyle = "#ffffff18";
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, H);
      ctx.stroke();
      ctx.restore();

      drawPianoStrip(ctx, H);
    };
  }, [isRecording, isMonitoring]);

  // rAF loop — always running while mounted
  useEffect(() => {
    let rafId: number;
    const tick = () => { drawRef.current(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // ResizeObserver
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
