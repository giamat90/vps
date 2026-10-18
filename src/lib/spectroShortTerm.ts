import { frequencyToNoteName } from "../audio/analysisUtils";
import type { VoiceEstimate } from "@giamat90/mps-core/spectrum";
import {
  SPECTRO_COLORMAP,
  SPECTRUM_BOTTOM_AXIS_H,
  SPECTRUM_MAX_DB,
  SPECTRUM_MIN_DB,
  analyserCurvePoints,
  freqToX as freqToXShared,
  smoothSpectrumEnvelope,
  type SpectrumPoint,
} from "./spectroUtils";
import { AXIS_W, F_MIN, LEGEND_WIDTH, formatHz } from "./spectrogramMath";

export const BOTTOM_AXIS_H = SPECTRUM_BOTTOM_AXIS_H;
export const DB_TICK_STEP = 10;
export const FREQ_DECADES = [100, 1000, 10000];

// One color per formant slot (F1/F2/F3) so overlapping lines stay distinguishable.
export const FORMANT_COLORS = ["#ffcf5c", "#5cffe0", "#ff5ca8"];
// The fundamental is drawn solid, in a colour none of the formant slots use.
export const F0_COLOR = "#b48cff";
export const LIVE_OVERLAY_COLOR = "255,140,30";

export function spectrumFreqToX(f: number, rollW: number, fMax: number): number {
  return freqToXShared(f, rollW, F_MIN, fMax);
}

/** dB values of the horizontal grid, floor first and ceiling last. */
export function dbGridTicks(): number[] {
  const ticks: number[] = [SPECTRUM_MIN_DB];
  for (let db = Math.ceil(SPECTRUM_MIN_DB / DB_TICK_STEP) * DB_TICK_STEP; db < SPECTRUM_MAX_DB; db += DB_TICK_STEP) {
    ticks.push(db);
  }
  ticks.push(SPECTRUM_MAX_DB);
  return ticks;
}

export function buildSpectrumPoints(data: Float32Array, sr: number, rollW: number, fMax: number, plotH: number): SpectrumPoint[] {
  const points = analyserCurvePoints(data, sr, rollW, F_MIN, fMax, AXIS_W);
  points.forEach((p) => { p.y = plotH * (1 - p.normalized); });
  return points;
}

export function envelopeWithY(points: SpectrumPoint[], plotH: number): SpectrumPoint[] {
  const envelope = smoothSpectrumEnvelope(points);
  envelope.forEach((p) => { p.y = plotH * (1 - p.normalized); });
  return envelope;
}

export interface VoiceMarker {
  slot: number;
  x: number;
  color: string;
  dashed: boolean;
  label: string;
}

/** Vertical markers for the fundamental (slot 0) and each detected formant that fits the plotted range. */
export function voiceMarkers(f0: number | null, voice: VoiceEstimate, fMax: number, rollW: number): VoiceMarker[] {
  const markers: VoiceMarker[] = [];
  [f0, voice.f1, voice.f2, voice.f3].forEach((f, slot) => {
    if (f === null || f > fMax) return;
    const isF0 = slot === 0;
    markers.push({
      slot,
      x: AXIS_W + spectrumFreqToX(f, rollW, fMax),
      color: isF0 ? F0_COLOR : FORMANT_COLORS[slot - 1],
      dashed: !isF0,
      label: isF0 ? `F0 ${Math.round(f)}Hz ${frequencyToNoteName(f).name}` : `F${slot} ${Math.round(f)}Hz`,
    });
  });
  return markers;
}

export function drawDbGrid(ctx: CanvasRenderingContext2D, W: number, plotH: number, dpr: number): void {
  ctx.font = `${11 * dpr}px monospace`;
  ctx.textBaseline = "middle";
  for (const db of dbGridTicks()) {
    const isEdge = db === SPECTRUM_MIN_DB || db === SPECTRUM_MAX_DB;
    const normalized = (db - SPECTRUM_MIN_DB) / (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB);
    const y = plotH * (1 - normalized);

    ctx.strokeStyle = isEdge ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(AXIS_W, y);
    ctx.lineTo(W - LEGEND_WIDTH, y);
    ctx.stroke();

    ctx.fillStyle = isEdge ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.6)";
    ctx.textAlign = "right";
    ctx.fillText(`${db}`, AXIS_W - 6, Math.max(6 * dpr, Math.min(plotH - 6 * dpr, y)));
  }
}

export function drawDecadeGrid(ctx: CanvasRenderingContext2D, rollW: number, plotH: number, fMax: number, dpr: number): void {
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const f of FREQ_DECADES) {
    if (f > fMax) continue;
    const x = AXIS_W + spectrumFreqToX(f, rollW, fMax);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, plotH);
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillText(formatHz(f), x, plotH + 3 * dpr);
  }
}

function colormapRgb(idx: number): [number, number, number] {
  return [SPECTRO_COLORMAP[idx * 3], SPECTRO_COLORMAP[idx * 3 + 1], SPECTRO_COLORMAP[idx * 3 + 2]];
}

export function drawCurveSegments(ctx: CanvasRenderingContext2D, points: SpectrumPoint[], dpr: number): void {
  for (let i = 1; i < points.length; i++) {
    const [R, G, B] = colormapRgb(Math.floor(points[i].normalized * 255));
    ctx.strokeStyle = `rgb(${R},${G},${B})`;
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(points[i - 1].x, points[i - 1].y);
    ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }
}

export function drawCurveFill(ctx: CanvasRenderingContext2D, points: SpectrumPoint[], plotH: number): void {
  if (points.length <= 1) return;
  const gradient = ctx.createLinearGradient(0, 0, 0, plotH);
  for (let s = 0; s <= 10; s++) {
    const t = s / 10;
    const [R, G, B] = colormapRgb(Math.floor(t * 255));
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

export function drawEnvelope(ctx: CanvasRenderingContext2D, points: SpectrumPoint[], plotH: number, dpr: number): void {
  if (points.length <= 1) return;
  const envelope = envelopeWithY(points, plotH);

  ctx.beginPath();
  ctx.moveTo(envelope[0].x, envelope[0].y);
  for (let i = 1; i < envelope.length; i++) ctx.lineTo(envelope[i].x, envelope[i].y);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2 * dpr;
  ctx.setLineDash([]);
  ctx.stroke();
}

export function drawVoiceMarkers(ctx: CanvasRenderingContext2D, markers: VoiceMarker[], plotH: number, dpr: number): void {
  ctx.font = `${11 * dpr}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const m of markers) {
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash(m.dashed ? [4 * dpr, 3 * dpr] : []);
    ctx.beginPath();
    ctx.moveTo(m.x, 0);
    ctx.lineTo(m.x, plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    const labelY = plotH - 3 * dpr - m.slot * 12 * dpr;
    ctx.lineJoin = "round";
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = "rgba(15, 15, 30, 0.9)";
    ctx.strokeText(m.label, m.x, labelY);
    ctx.fillStyle = m.color;
    ctx.fillText(m.label, m.x, labelY);
  }
}

/** The live mic's envelope drawn over a loaded track's spectrum, with its two-line legend. */
export function drawLiveOverlay(ctx: CanvasRenderingContext2D, envelope: SpectrumPoint[], W: number, plotH: number, dpr: number): void {
  ctx.save();
  ctx.fillStyle = `rgba(${LIVE_OVERLAY_COLOR},0.18)`;
  ctx.beginPath();
  ctx.moveTo(envelope[0].x, plotH);
  for (const p of envelope) ctx.lineTo(p.x, p.y);
  ctx.lineTo(envelope[envelope.length - 1].x, plotH);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = `rgba(${LIVE_OVERLAY_COLOR},0.95)`;
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.moveTo(envelope[0].x, envelope[0].y);
  for (let i = 1; i < envelope.length; i++) ctx.lineTo(envelope[i].x, envelope[i].y);
  ctx.stroke();

  ctx.font = `${11 * dpr}px sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = `rgba(${LIVE_OVERLAY_COLOR},0.95)`;
  ctx.fillText("● mic", W - LEGEND_WIDTH - 6 * dpr, 4 * dpr);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText("○ track", W - LEGEND_WIDTH - 6 * dpr, 4 * dpr + 13 * dpr);
  ctx.restore();
}
