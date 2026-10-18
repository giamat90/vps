import type { PitchPoint } from "./types";
import {
  PIANO_W,
  WINDOW_S,
  formatClock,
  isBlack,
  keyFill,
  keyLabelColor,
  midiToY,
  noteAt,
  noteH,
  onRoll,
  punchSpan,
  ribbonSegments,
  rulerInterval,
  rulerTickTimes,
  visibleMidiRange,
  type KeyHighlight,
  type PianoColors,
} from "./pianoRollGeometry";

const COLOR_PREVIEW = "rgba(255, 255, 255, 0.5)";
const COLOR_PREVIEW_VOICE = "rgba(255, 255, 255, 0.9)";
const COLOR_PUNCH_LINE = "rgba(233,69,96,0.85)";
const COLOR_PUNCH_HANDLE = "rgba(233,69,96,0.9)";

export function drawLanes(ctx: CanvasRenderingContext2D, W: number, H: number, midiMin: number): void {
  const nh = noteH(H);
  const { first, last } = visibleMidiRange(midiMin);
  for (let m = first; m <= last; m++) {
    const top = midiToY(m, H, midiMin) - nh / 2;
    ctx.fillStyle = isBlack(m) ? "#0c0c1e" : "#141428";
    ctx.fillRect(PIANO_W, top, W - PIANO_W, nh);

    if (!isBlack(m)) {
      ctx.fillStyle = "#ffffff09";
      ctx.fillRect(PIANO_W, top, W - PIANO_W, 0.5);
    }

    if ((m % 12) === 0) {
      ctx.fillStyle = "#ffffff1a";
      ctx.fillRect(PIANO_W, top, W - PIANO_W, 1);
    }
  }
}

// Flat pitch trace for a held preview key — a 4th "voice" alongside the song/take/live ribbons.
export function drawPreviewVoice(
  ctx: CanvasRenderingContext2D,
  H: number,
  midiMin: number,
  midi: number,
  x0: number,
  x1: number,
): void {
  if (x1 <= x0) return;
  const y = midiToY(midi, H, midiMin);
  ctx.save();
  ctx.strokeStyle = COLOR_PREVIEW_VOICE;
  ctx.lineWidth = Math.max(2.5, noteH(H) * 0.72);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
  ctx.restore();
}

export function drawPlayhead(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const cx = PIANO_W + (W - PIANO_W) / 2;
  ctx.save();
  ctx.strokeStyle = "#ffffff30";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, H);
  ctx.stroke();
  ctx.restore();
}

export function drawRibbon(
  ctx: CanvasRenderingContext2D,
  points: PitchPoint[],
  color: string,
  t0: number,
  t1: number,
  H: number,
  midiMin: number,
  timeToX: (t: number) => number,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2.5, noteH(H) * 0.72);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (const segment of ribbonSegments(points, t0, t1, H, midiMin, timeToX)) {
    ctx.moveTo(segment[0].x, segment[0].y);
    for (let i = 1; i < segment.length; i++) ctx.lineTo(segment[i].x, segment[i].y);
  }
  ctx.stroke();
  ctx.restore();
}

function fillKey(ctx: CanvasRenderingContext2D, top: number, nh: number, w: number, fill: string, preview: boolean): void {
  ctx.fillStyle = fill;
  ctx.fillRect(1, top + 0.5, w, nh - 1);
  if (preview) {
    ctx.fillStyle = COLOR_PREVIEW;
    ctx.fillRect(1, top + 0.5, w, nh - 1);
  }
}

function drawOctaveLabel(ctx: CanvasRenderingContext2D, m: number, y: number, nh: number, hit: KeyHighlight): void {
  const octave = Math.floor(m / 12) - 1;
  ctx.fillStyle = keyLabelColor(hit);
  ctx.font = `${Math.max(7, Math.min(10, nh * 0.78))}px sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(`C${octave}`, PIANO_W - 4, y);
}

export interface StripNotes {
  song: number | null;
  take: number | null;
  live: number | null;
  preview: number | null;
  alt: number | null;
}

export function drawPianoStrip(
  ctx: CanvasRenderingContext2D,
  H: number,
  midiMin: number,
  notes: StripNotes,
  colors: PianoColors,
): void {
  const nh = noteH(H);

  ctx.fillStyle = "#090914";
  ctx.fillRect(0, 0, PIANO_W, H);

  const { first, last } = visibleMidiRange(midiMin);
  for (let m = first; m <= last; m++) {
    const y = midiToY(m, H, midiMin);
    const top = y - nh / 2;
    const black = isBlack(m);
    const hit: KeyHighlight = { song: m === notes.song, take: m === notes.take, live: m === notes.live, alt: m === notes.alt };
    const fill = keyFill(black, hit, colors);
    const preview = m === notes.preview;

    if (black) {
      fillKey(ctx, top, nh, PIANO_W * 0.60, fill, preview);
    } else {
      fillKey(ctx, top, nh, PIANO_W - 3, fill, preview);
      if ((m % 12) === 0) drawOctaveLabel(ctx, m, y, nh, hit);
    }
  }

  ctx.fillStyle = "#333";
  ctx.fillRect(PIANO_W - 1, 0, 1, H);
}

export function drawNoteLabel(
  ctx: CanvasRenderingContext2D,
  W: number,
  songPitch: PitchPoint[],
  takePitch: PitchPoint[],
  livePitch: PitchPoint[],
  currentTime: number,
  colors: PianoColors,
): void {
  const labels: [string | null, string][] = [
    [noteAt(livePitch, currentTime), colors.live],
    [noteAt(takePitch, currentTime), colors.take],
    [noteAt(songPitch, currentTime), colors.song],
  ];
  if (labels.every(([note]) => !note)) return;

  ctx.save();
  ctx.font = "bold 11px monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "right";

  let x = W - 6;
  labels.forEach(([note, color], i) => {
    if (!note) return;
    ctx.fillStyle = color;
    ctx.fillText(note, x, 5);
    // The last label (song) has nothing after it, so it is not measured.
    if (i < labels.length - 1) x -= ctx.measureText(note).width + 10;
  });
  ctx.restore();
}

function drawPunchHandle(ctx: CanvasRenderingContext2D, x: number, W: number, H: number): void {
  if (!onRoll(x, W)) return;
  ctx.strokeStyle = COLOR_PUNCH_LINE;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  ctx.fillStyle = COLOR_PUNCH_HANDLE;
  ctx.fillRect(x - 3, 0, 6, 4);
}

function drawPunchRegion(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  tX: (t: number) => number,
  punchInT: number | null,
  punchOutT: number | null,
): void {
  if (punchInT === null || punchOutT === null || punchOutT <= punchInT) return;
  const xL = tX(punchInT);
  const xR = tX(punchOutT);
  const span = punchSpan(xL, xR, W);
  if (span) {
    ctx.fillStyle = "rgba(233,69,96,0.22)";
    ctx.fillRect(span.from, 0, span.to - span.from, H);
  }
  drawPunchHandle(ctx, xL, W, H);
  drawPunchHandle(ctx, xR, W, H);
}

function drawRulerTicks(ctx: CanvasRenderingContext2D, W: number, H: number, t0: number, rollW: number, tX: (t: number) => number): void {
  ctx.font = "9px monospace";
  for (const t of rulerTickTimes(t0, rulerInterval(rollW))) {
    const x = Math.round(tX(t));
    if (!onRoll(x, W)) continue;
    ctx.strokeStyle = "#3a4a5e";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x, H * 0.4);
    ctx.stroke();
    ctx.fillStyle = "#7a8a9e";
    ctx.textAlign = "left";
    ctx.fillText(formatClock(t), x + 2, H * 0.6);
  }
}

export function drawRuler(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  currentTime: number,
  punchInT: number | null,
  punchOutT: number | null,
): void {
  const rollW = W - PIANO_W;
  const t0 = currentTime - WINDOW_S / 2;
  const tX = (t: number) => PIANO_W + ((t - t0) / WINDOW_S) * rollW;

  ctx.fillStyle = "#0d1b2e";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#090914";
  ctx.fillRect(0, 0, PIANO_W, H);

  drawPunchRegion(ctx, W, H, tX, punchInT, punchOutT);
  drawRulerTicks(ctx, W, H, t0, rollW, tX);

  const cx = PIANO_W + rollW / 2;
  ctx.save();
  ctx.strokeStyle = "#ffffff40";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = "#2a3a4e";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5); ctx.stroke();
}
