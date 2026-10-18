import { currentPitchHz, frequencyToNoteName, referenceF0 } from "../audio/analysisUtils";
import type { VoiceEstimate } from "@giamat90/mps-core/spectrum";
import {
  SPECTRUM_BOTTOM_AXIS_H,
  SPECTRUM_MAX_DB,
  SPECTRUM_MIN_DB,
  analyserCurvePoints,
  smoothSpectrumLight,
  stitchAboveNyquist,
  type SpectrumPoint,
} from "./spectroUtils";
import { AXIS_W, F_MAX, F_MIN, LEGEND_WIDTH } from "./spectrogramMath";
import { drawDbGrid, drawDecadeGrid, spectrumFreqToX } from "./spectroShortTerm";
import type { PitchPoint } from "./types";

// Song/take formants only need re-estimating when the playhead has moved, not
// every rAF frame, since the underlying audio window is identical while paused.
export const FORMANT_CACHE_STEP_S = 0.02;

/** A precomputed song or take spectrum: byte frames over `minDb..maxDb`, log-spaced bins. */
export interface StoredSpectrum {
  times: number[];
  bytes: Uint8Array;
  bins: number;
  minDb: number;
  maxDb: number;
}

export interface MeasuredSpectrum {
  data: Float32Array;
  sampleRate: number;
}

export interface ComparisonSource {
  getLiveSpectrum(): MeasuredSpectrum | null;
  getTrackSpectrum(track: "song" | "take", timeKey: number): MeasuredSpectrum | null;
  getFormants(track: "song" | "take" | "live", timeKey: number): VoiceEstimate;
}

export interface ComparisonColors {
  song: string;
  songAlt: string;
  take: string;
  live: string;
}

/** Nearest-frame lookup — spectrum frames are coarse (~20fps) relative to rAF. */
export function nearestFrame(spectrum: StoredSpectrum, t: number): Uint8Array | null {
  const { times, bytes, bins } = spectrum;
  if (times.length === 0) return null;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t)) lo -= 1;
  return bytes.subarray(lo * bins, (lo + 1) * bins);
}

/**
 * Builds normalized points from a precomputed frame (0-255 bytes encoded
 * over the spectrum's own minDb..maxDb, per compute_short_term_spectrum).
 * Decoded against its own stored range, then re-normalized to the panel's
 * display range — the two currently coincide, but this keeps rendering correct
 * even if the encode range changes again.
 */
export function storedCurvePoints(frame: Uint8Array, minDb: number, maxDb: number, rollW: number): SpectrumPoint[] {
  const bins = frame.length;
  const points: SpectrumPoint[] = [];
  for (let px = 0; px < rollW; px++) {
    // Stored bins are log-spaced from F_MIN (bin 0) to fMax, the same axis
    // xToFreq maps columns onto (low frequency at the left), so a column's
    // bin range is just its fractional position. Max-in-range, like the live
    // curve's per-column FFT bin lookup.
    const binLo = Math.max(0, Math.min(bins - 1, Math.floor((px / rollW) * bins)));
    const binHi = Math.max(binLo, Math.min(bins - 1, Math.floor(((px + 1) / rollW) * bins)));
    let peak = 0;
    for (let b = binLo; b <= binHi; b++) {
      if (frame[b] > peak) peak = frame[b];
    }
    const db = minDb + (peak / 255) * (maxDb - minDb);
    const normalized = Math.max(0, Math.min(1, (db - SPECTRUM_MIN_DB) / (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB)));
    points.push({ x: AXIS_W + px, y: 0, normalized });
  }
  return points;
}

/**
 * The curve of a song or take at the playhead: measured from the decoded audio through the same FFT and pixel
 * mapping as the live curve (so the three are directly comparable and follow a key transpose), with the stored
 * frame (a 46 ms hop, resampled to log bins) filling in above the measured band, or standing in alone when there
 * is nothing to measure.
 */
export function trackCurvePoints(
  spectrum: StoredSpectrum,
  measured: MeasuredSpectrum | null,
  time: number,
  rollW: number,
  fMax: number,
): SpectrumPoint[] | null {
  const frame = nearestFrame(spectrum, time);
  const stored = frame ? storedCurvePoints(frame, spectrum.minDb, spectrum.maxDb, rollW) : null;
  if (!measured) return stored;
  const points = analyserCurvePoints(measured.data, measured.sampleRate, rollW, F_MIN, fMax, AXIS_W);
  return stitchAboveNyquist(points, stored, measured.sampleRate, rollW, F_MIN, fMax);
}

/** Strokes a polyline through pre-normalized points, optionally smoothing
 * first — a light pass takes the edge off the singer's own live/take curve
 * (per-frame jitter is distracting when comparing your voice's shape to the
 * song) without flattening real harmonic peaks the way ShortTermSpectrumPanel's
 * much heavier formant-envelope smoothing would (that one's designed to be an
 * overlay on top of a raw curve, not a replacement for it). The Song
 * reference curve is left fully raw/precise on purpose. */
export function strokePoints(
  ctx: CanvasRenderingContext2D,
  points: SpectrumPoint[],
  color: string,
  plotH: number,
  dpr: number,
  smooth: boolean,
): void {
  const drawn = smooth ? smoothSpectrumLight(points) : points;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * dpr;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < drawn.length; i++) {
    const y = plotH * (1 - drawn[i].normalized);
    if (i === 0) ctx.moveTo(drawn[i].x, y); else ctx.lineTo(drawn[i].x, y);
  }
  ctx.stroke();
}

export interface ComparisonMarker {
  slot: number;
  x: number;
  color: string;
  solid: boolean;
  label: string;
}

/**
 * One marker per fundamental and detected formant, in the colour of the curve it belongs to. Each has a fixed
 * label slot, so a label does not jump when the one above it appears or disappears. `secondF0` is the song's
 * second voice: a solid line in `secondColor` with the label slot below F3.
 */
export function comparisonMarkers(
  voice: VoiceEstimate,
  color: string,
  rollW: number,
  fMax: number,
  secondF0: number | null,
  secondColor: string,
): ComparisonMarker[] {
  const entries: { hz: number | null; slot: number; color: string; solid: boolean }[] = [
    { hz: voice.f0, slot: 0, color, solid: true },
    { hz: voice.f1, slot: 1, color, solid: false },
    { hz: voice.f2, slot: 2, color, solid: false },
    { hz: voice.f3, slot: 3, color, solid: false },
    { hz: secondF0, slot: 4, color: secondColor, solid: true },
  ];
  const markers: ComparisonMarker[] = [];
  for (const { hz, slot, color: markerColor, solid } of entries) {
    if (hz === null || hz > fMax) continue;
    const isF0 = slot === 0 || slot === 4;
    markers.push({
      slot,
      x: AXIS_W + spectrumFreqToX(hz, rollW, fMax),
      color: markerColor,
      solid,
      label: isF0 ? `F0 ${Math.round(hz)} ${frequencyToNoteName(hz).name}` : `F${slot} ${Math.round(hz)}`,
    });
  }
  return markers;
}

/** Song labels stack down from the top and the singer's up from the bottom so the two sets don't collide. */
export function markerLabelY(slot: number, anchor: "top" | "bottom", plotH: number, dpr: number): number {
  return anchor === "top" ? 3 * dpr + slot * 12 * dpr : plotH - 3 * dpr - slot * 12 * dpr;
}

export function drawComparisonMarkers(
  ctx: CanvasRenderingContext2D,
  markers: ComparisonMarker[],
  plotH: number,
  dpr: number,
  anchor: "top" | "bottom",
): void {
  ctx.save();
  ctx.font = `${11 * dpr}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = anchor;
  for (const m of markers) {
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash(m.solid ? [] : [4 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(m.x, 0);
    ctx.lineTo(m.x, plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    const y = markerLabelY(m.slot, anchor, plotH, dpr);
    // Dark outline keeps the label readable over the curves it sits on.
    ctx.lineJoin = "round";
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = "rgba(15, 15, 30, 0.9)";
    ctx.setLineDash([]);
    ctx.strokeText(m.label, m.x, y);
    ctx.fillStyle = m.color;
    ctx.fillText(m.label, m.x, y);
  }
  ctx.restore();
}

export function drawCenteredNote(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  baseline: "middle" | "bottom",
  dpr: number,
): void {
  ctx.fillStyle = "#a0a0b060";
  ctx.font = `${11 * dpr}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = baseline;
  ctx.fillText(text, x, y);
}

export interface ComparisonFrame {
  W: number;
  H: number;
  dpr: number;
  time: number;
  song: StoredSpectrum | null;
  take: StoredSpectrum | null;
  live: MeasuredSpectrum | null;
  source: ComparisonSource;
  colors: ComparisonColors;
  songPitch: PitchPoint[];
  songPitchAlt: PitchPoint[];
  takePitch: PitchPoint[];
  showSecondVoice: boolean;
}

interface Geometry {
  rollW: number;
  plotH: number;
  fMax: number;
}

function drawSongCurve(ctx: CanvasRenderingContext2D, f: ComparisonFrame, g: Geometry, timeKey: number): void {
  if (!f.song) return;
  const points = trackCurvePoints(f.song, f.source.getTrackSpectrum("song", timeKey), f.time, g.rollW, g.fMax);
  if (points) strokePoints(ctx, points, f.colors.song, g.plotH, f.dpr, false);
}

/** Live singer takes priority over a stored take, same as Piano Roll's live > take > song ribbon order. */
function drawSingerCurve(ctx: CanvasRenderingContext2D, f: ComparisonFrame, g: Geometry, timeKey: number): void {
  if (f.live) {
    const points = analyserCurvePoints(f.live.data, f.live.sampleRate, g.rollW, F_MIN, g.fMax, AXIS_W);
    strokePoints(ctx, points, f.colors.live, g.plotH, f.dpr, true);
  } else if (f.take) {
    const points = trackCurvePoints(f.take, f.source.getTrackSpectrum("take", timeKey), f.time, g.rollW, g.fMax);
    if (points) strokePoints(ctx, points, f.colors.take, g.plotH, f.dpr, true);
  } else {
    drawCenteredNote(ctx, "No take selected", AXIS_W + g.rollW / 2, g.plotH - 6 * f.dpr, "bottom", f.dpr);
  }
}

/**
 * F0 of the song and the take is the stored SRH pitch, the line the piano roll draws, so the note names agree;
 * the window estimate in voice.f0 only stands in when a track has no pitch data.
 */
function drawFormantSets(ctx: CanvasRenderingContext2D, f: ComparisonFrame, g: Geometry, timeKey: number): void {
  const { rollW, fMax, plotH } = g;
  if (f.song) {
    const voice = f.source.getFormants("song", timeKey);
    const secondVoice = f.showSecondVoice ? currentPitchHz(f.songPitchAlt, f.time) : null;
    const withF0 = { ...voice, f0: referenceF0(f.songPitch, f.time, voice.f0) };
    drawComparisonMarkers(ctx, comparisonMarkers(withF0, f.colors.song, rollW, fMax, secondVoice, f.colors.songAlt), plotH, f.dpr, "top");
  }
  if (f.live) {
    const voice = f.source.getFormants("live", NaN);
    drawComparisonMarkers(ctx, comparisonMarkers(voice, f.colors.live, rollW, fMax, null, f.colors.songAlt), plotH, f.dpr, "bottom");
  } else if (f.take) {
    const voice = f.source.getFormants("take", timeKey);
    const withF0 = { ...voice, f0: referenceF0(f.takePitch, f.time, voice.f0) };
    drawComparisonMarkers(ctx, comparisonMarkers(withF0, f.colors.take, rollW, fMax, null, f.colors.songAlt), plotH, f.dpr, "bottom");
  }
}

/** One frame of the song-vs-singer spectrum comparison: grids, both curves and their formant markers. */
export function drawComparisonFrame(ctx: CanvasRenderingContext2D, f: ComparisonFrame): void {
  const g: Geometry = {
    rollW: f.W - AXIS_W - LEGEND_WIDTH,
    plotH: f.H - SPECTRUM_BOTTOM_AXIS_H * f.dpr,
    fMax: F_MAX,
  };

  ctx.clearRect(0, 0, f.W, f.H);
  ctx.fillStyle = "#0f0f1e";
  ctx.fillRect(0, 0, f.W, f.H);
  drawDbGrid(ctx, f.W, g.plotH, f.dpr);
  drawDecadeGrid(ctx, g.rollW, g.plotH, g.fMax, f.dpr);

  if (!f.song && !f.take && !f.live) {
    drawCenteredNote(ctx, "No spectrum data", AXIS_W + g.rollW / 2, g.plotH / 2, "middle", f.dpr);
    return;
  }

  const timeKey = Math.round(f.time / FORMANT_CACHE_STEP_S);
  drawSongCurve(ctx, f, g, timeKey);
  drawSingerCurve(ctx, f, g, timeKey);
  drawFormantSets(ctx, f, g, timeKey);
}
