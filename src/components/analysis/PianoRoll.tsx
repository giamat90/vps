import { useRef, useEffect } from "react";
import { useAnalysisStore } from "../../stores/analysis";
import { getEngine } from "../../stores/player";
import { frequencyToMidi, NOTE_NAMES } from "../../lib/constants";
import type { PitchPoint } from "../../lib/types";

// ─── constants ───────────────────────────────────────────────────────────────

const PIANO_W   = 36;       // px width of the piano key strip
const WINDOW_S  = 8;        // seconds visible at once
const MIDI_MIN  = 45;       // A2  — bottom of visible range
const MIDI_MAX  = 84;       // C6  — top of visible range
const N_NOTES   = MIDI_MAX - MIDI_MIN + 1;
const CONF_MIN  = 0.5;
const GAP_S     = 0.08;     // gap threshold: breaks the ribbon

const COLOR_SONG = "rgba(74, 158, 255, 0.88)";
const COLOR_TAKE = "rgba(233, 69, 96,  0.92)";

const BLACK_PC  = new Set([1, 3, 6, 8, 10]);   // pitch classes that are black keys

// ─── geometry helpers ────────────────────────────────────────────────────────

function noteH(H: number): number {
  return H / N_NOTES;
}

function midiToY(midi: number, H: number): number {
  return ((MIDI_MAX - midi) / N_NOTES) * H + noteH(H) / 2;
}

function isBlack(midi: number): boolean {
  return BLACK_PC.has(((midi % 12) + 12) % 12);
}

// ─── draw passes ─────────────────────────────────────────────────────────────

function drawLanes(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const nh = noteH(H);
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    const y  = midiToY(m, H);
    const top = y - nh / 2;
    ctx.fillStyle = isBlack(m) ? "#0c0c1e" : "#141428";
    ctx.fillRect(PIANO_W, top, W - PIANO_W, nh);

    // Subtle horizontal rule on every white-key boundary
    if (!isBlack(m)) {
      ctx.fillStyle = "#ffffff09";
      ctx.fillRect(PIANO_W, top, W - PIANO_W, 0.5);
    }

    // Stronger line at every C (octave boundary)
    if ((m % 12) === 0) {
      ctx.fillStyle = "#ffffff1a";
      ctx.fillRect(PIANO_W, top, W - PIANO_W, 1);
    }
  }
}

function drawPlayhead(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const cx = PIANO_W + (W - PIANO_W) / 2;
  ctx.save();
  ctx.strokeStyle = "#ffffff30";
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, H);
  ctx.stroke();
  ctx.restore();
}

function drawRibbon(
  ctx: CanvasRenderingContext2D,
  points: PitchPoint[],
  color: string,
  t0: number,
  t1: number,
  H: number,
  timeToX: (t: number) => number,
): void {
  const nh = noteH(H);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = Math.max(2.5, nh * 0.72);
  ctx.lineCap     = "round";
  ctx.lineJoin    = "round";

  let penDown = false;
  ctx.beginPath();

  for (let i = 0; i < points.length; i++) {
    const p = points[i];

    const outOfConf  = p.confidence < CONF_MIN || p.frequency <= 0;
    const outOfTime  = p.time < t0 - 0.1 || p.time > t1 + 0.1;
    const midi       = frequencyToMidi(p.frequency);
    const outOfRange = midi < MIDI_MIN || midi > MIDI_MAX;

    if (outOfConf || outOfTime || outOfRange) {
      penDown = false;
      continue;
    }

    // Gap detection: break line on silence/unvoiced sections
    const prev = points[i - 1];
    if (prev && p.time - prev.time > GAP_S) {
      penDown = false;
    }

    const x = timeToX(p.time);
    const y = midiToY(midi, H);

    if (!penDown) {
      ctx.moveTo(x, y);
      penDown = true;
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();
  ctx.restore();
}

function drawPianoStrip(ctx: CanvasRenderingContext2D, H: number): void {
  const nh = noteH(H);

  // Strip background
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
      ctx.fillStyle = "#c8c8c8";
      ctx.fillRect(1, top + 0.5, PIANO_W - 3, nh - 1);

      // Label every C note
      if ((m % 12) === 0) {
        const octave = Math.floor(m / 12) - 1;
        const fs = Math.max(7, Math.min(10, nh * 0.78));
        ctx.fillStyle  = "#444";
        ctx.font       = `${fs}px sans-serif`;
        ctx.textAlign  = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(`C${octave}`, PIANO_W - 4, y);
      }
    }
  }

  // Separator line
  ctx.fillStyle = "#333";
  ctx.fillRect(PIANO_W - 1, 0, 1, H);
}

function drawNoteLabel(
  ctx: CanvasRenderingContext2D,
  songPitch: PitchPoint[],
  takePitch: PitchPoint[],
  currentTime: number,
): void {
  const getNote = (pts: PitchPoint[]): string | null => {
    const near = pts.filter(
      (p) =>
        Math.abs(p.time - currentTime) < 0.06 &&
        p.confidence >= CONF_MIN &&
        p.frequency > 0,
    );
    if (near.length === 0) return null;
    const avgMidi = near.reduce((s, p) => s + frequencyToMidi(p.frequency), 0) / near.length;
    const m = Math.round(avgMidi);
    return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
  };

  const songNote = getNote(songPitch);
  const takeNote = getNote(takePitch);
  if (!songNote && !takeNote) return;

  ctx.save();
  ctx.font         = "bold 11px monospace";
  ctx.textBaseline = "top";

  let x = PIANO_W + 6;
  const y = 5;

  if (songNote) {
    ctx.fillStyle = COLOR_SONG;
    ctx.fillText(songNote, x, y);
    x += ctx.measureText(songNote).width + 10;
  }
  if (takeNote) {
    ctx.fillStyle = COLOR_TAKE;
    ctx.fillText(takeNote, x, y);
  }
  ctx.restore();
}

// ─── component ───────────────────────────────────────────────────────────────

export default function PianoRoll() {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const songPitch  = useAnalysisStore((s) => s.songPitch);
  const takePitch  = useAnalysisStore((s) => s.takePitch);
  const isLoaded   = useAnalysisStore((s) => s.isLoaded);
  const drawRef    = useRef<() => void>(() => {});

  // Rebuild draw function whenever data changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    drawRef.current = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const W = canvas.offsetWidth  || 600;
      const H = canvas.offsetHeight || 240;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width  = W;
        canvas.height = H;
      }

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#0f0f1e";
      ctx.fillRect(0, 0, W, H);

      if (!isLoaded || songPitch.length === 0) {
        ctx.fillStyle    = "#a0a0b060";
        ctx.font         = "11px sans-serif";
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No pitch data", (PIANO_W + W) / 2, H / 2);
        drawPianoStrip(ctx, H);
        return;
      }

      const currentTime = getEngine().getCurrentTime();
      const t0 = currentTime - WINDOW_S / 2;
      const t1 = currentTime + WINDOW_S / 2;
      const rollW = W - PIANO_W;
      const timeToX = (t: number) =>
        PIANO_W + ((t - currentTime + WINDOW_S / 2) / WINDOW_S) * rollW;

      drawLanes(ctx, W, H);
      drawRibbon(ctx, songPitch, COLOR_SONG, t0, t1, H, timeToX);
      if (takePitch.length > 0) {
        drawRibbon(ctx, takePitch, COLOR_TAKE, t0, t1, H, timeToX);
      }
      drawPlayhead(ctx, W, H);
      drawNoteLabel(ctx, songPitch, takePitch, currentTime);
      drawPianoStrip(ctx, H);   // last: sits on top at left edge
    };

    drawRef.current();
  }, [songPitch, takePitch, isLoaded]);

  // rAF loop — no React re-renders during playback
  useEffect(() => {
    if (!isLoaded) return;
    let rafId: number;
    const tick = () => { drawRef.current(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isLoaded]);

  // ResizeObserver — single mount
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
        <span className="analysis-panel__label">Piano Roll</span>
        <div className="analysis-panel__legend">
          <span className="legend-dot legend-dot--song" />
          <span>Song</span>
          {takePitch.length > 0 && (
            <>
              <span className="legend-dot legend-dot--take" />
              <span>Your voice</span>
            </>
          )}
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="analysis-panel__canvas analysis-panel__canvas--piano-roll"
      />
    </div>
  );
}
