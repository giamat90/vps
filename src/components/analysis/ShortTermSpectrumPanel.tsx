import { useRef, useEffect } from "react";
import { getMicAnalyser, usePlayerStore } from "../../stores/player";
import { SPECTRO_COLORMAP } from "../../lib/spectroUtils";
import { AXIS_W, LEGEND_WIDTH, F_MIN, F_MAX, MIN_DB, MAX_DB, freqToY } from "./SpectrogramPanel";

// ─── constants ───────────────────────────────────────────────────────────────

const BOTTOM_AXIS_H = 16; // px (dpr-scaled) reserved at bottom for Hz labels
const DB_TICK_STEP   = 10;
const FREQ_DECADES    = [100, 1000, 10000];

// ─── frequency axis (shared log math, inverted for horizontal placement) ─────

// freqToY(f, size, fMax) maps fMax→0 / F_MIN→size (spectrogram's vertical
// convention, high freq at top). Mirroring that onto the X axis puts high
// freq on the right: x = rollW - freqToY(f, rollW, fMax).
function freqToX(f: number, rollW: number, fMax: number): number {
  return rollW - freqToY(f, rollW, fMax);
}

// Inverse of freqToX, derived algebraically from the same freqToY log
// mapping (not a separately-tuned curve) so the two stay in lockstep.
function xToFreq(x: number, rollW: number, fMax: number): number {
  const logFMin = Math.log(F_MIN);
  const logFMax = Math.log(fMax);
  const t = (rollW - x) / rollW; // matches freqToY's (logFMax - log f) / span term
  return Math.exp(logFMax - t * (logFMax - logFMin));
}

function formatHz(f: number): string {
  return f >= 1000 ? `${f / 1000}k` : `${f}`;
}

export default function ShortTermSpectrumPanel() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const isRecording  = usePlayerStore((s) => s.isRecording);
  const isMonitoring = usePlayerStore((s) => s.isMonitoring);
  const drawRef      = useRef<() => void>(() => {});
  const loggedRef    = useRef(false);

  useEffect(() => {
    if (!loggedRef.current) {
      loggedRef.current = true;
      console.log('[ShortTermSpectrum] panel active, height-colored stroke, sharing FLOOR/CEILING from spectrogram');
    }
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

      const analyser = getMicAnalyser();
      const active    = (isRecording || isMonitoring) && !!analyser;
      const sr        = analyser?.context.sampleRate ?? 48000;
      const nyquist   = sr / 2;
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

      // ── per-frame snapshot: same analyser/Float32Array feeding the spectrogram ──
      const binCount = analyser!.frequencyBinCount;
      const data = new Float32Array(binCount);
      analyser!.getFloatFrequencyData(data);
      const binHz   = sr / (binCount * 2);
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
        <span className="analysis-panel__label">Short-Term Spectrum</span>
        <span className="analysis-panel__hint">
          {isRecording || isMonitoring ? "live" : "off"}
        </span>
      </div>
      <canvas ref={canvasRef} className="analysis-panel__canvas short-term-spectrum-panel__canvas" />
    </div>
  );
}
