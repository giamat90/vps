import { useRef, useEffect } from "react";
import { getEngine, getMicAnalyser, usePlayerStore } from "../../stores/player";
import {
  SPECTRO_COLORMAP,
  quantizeFftToRows,
  N_SPECTRO_ROWS,
  MIDI_MIN,
  MIDI_MAX,
} from "../../lib/spectroUtils";

// ─── constants ───────────────────────────────────────────────────────────────

const PIANO_W  = 36;     // canvas px — matches PianoRoll piano strip width
const WINDOW_S = 8;      // seconds visible in the scrolling window
const N_NOTES  = MIDI_MAX - MIDI_MIN + 1;
const BLACK_PC = new Set([1, 3, 6, 8, 10]);

// ─── helpers ─────────────────────────────────────────────────────────────────

function noteH(H: number): number {
  return H / N_NOTES;
}

function midiToY(midi: number, H: number): number {
  return ((MIDI_MAX - midi) / N_NOTES) * H + noteH(H) / 2;
}

function isBlack(midi: number): boolean {
  return BLACK_PC.has(((midi % 12) + 12) % 12);
}

function drawPianoStrip(ctx: CanvasRenderingContext2D, H: number): void {
  const nh = noteH(H);
  ctx.fillStyle = "#090914";
  ctx.fillRect(0, 0, PIANO_W, H);

  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    const y   = midiToY(m, H);
    const top = y - nh / 2;
    const blk = isBlack(m);

    if (blk) {
      ctx.fillStyle = "#1c1c1c";
      ctx.fillRect(1, top + 0.5, PIANO_W * 0.60, nh - 1);
    } else {
      ctx.fillStyle = "#2a2a3a";
      ctx.fillRect(1, top + 0.5, PIANO_W - 3, nh - 1);

      if ((m % 12) === 0) {
        const octave = Math.floor(m / 12) - 1;
        const fs = Math.max(7, Math.min(10, nh * 0.78));
        ctx.fillStyle    = "#555";
        ctx.font         = `${fs}px sans-serif`;
        ctx.textAlign    = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(`C${octave}`, PIANO_W - 4, y);
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

  const buffer       = useRef<{ time: number; data: Uint8Array }[]>([]);
  const lastCapture  = useRef(0);
  const fftScratch   = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const drawRef      = useRef<() => void>(() => {});

  // Clear buffer when mic goes fully inactive
  useEffect(() => {
    if (!isRecording && !isMonitoring) {
      buffer.current = [];
    }
  }, [isRecording, isMonitoring]);

  useEffect(() => {
    drawRef.current = () => {
      // ── capture FFT from mic (throttled ~30 fps) ────────────────────────────
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
            const col = quantizeFftToRows(fftScratch.current, analyser.context.sampleRate);
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
      const H = canvas.offsetHeight || 120;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width  = W;
        canvas.height = H;
      }

      ctx.fillStyle = "#0f0f1e";
      ctx.fillRect(0, 0, W, H);

      const rollW = W - PIANO_W;
      const t     = getEngine().getCurrentTime();
      const t0    = t - WINDOW_S / 2;

      if (buffer.current.length >= 2) {
        // Per-pixel ImageData — no block artifacts
        const lut = SPECTRO_COLORMAP;
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
            const ri  = Math.min(N_SPECTRO_ROWS - 1, Math.floor((py / H) * N_SPECTRO_ROWS));
            const val = data[ri];
            const idx = (py * rollW + px) * 4;
            d[idx]     = lut[val * 3];
            d[idx + 1] = lut[val * 3 + 1];
            d[idx + 2] = lut[val * 3 + 2];
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

  // rAF loop — always running while mounted (free exercise page)
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
