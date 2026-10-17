import { frequencyToMidi, NOTE_NAMES } from "@giamat90/mps-core/music";
import { PIANO_WINDOW_SIZE } from "./constants";
import type { PitchPoint } from "./types";

export const PIANO_W = 36;  // canvas px width of the piano key strip
export const WINDOW_S = 8;  // seconds visible at once
export const N_NOTES = PIANO_WINDOW_SIZE; // fixed 40-semitone visible span; slides via midiMin
export const CONF_MIN = 0.3;
export const GAP_S = 0.08;  // gap threshold: breaks the ribbon
export const HANDLE_HIT = 12;

const BLACK_PC = new Set([1, 3, 6, 8, 10]);

export interface PianoColors {
  song: string;
  songAlt: string;
  take: string;
  live: string;
}

export interface Point {
  x: number;
  y: number;
}

// midiMin is the (float, smoothly-animated) lower bound of the currently visible window.
export function noteH(H: number): number {
  return H / N_NOTES;
}

export function midiToY(midi: number, H: number, midiMin: number): number {
  const midiMax = midiMin + N_NOTES - 1;
  return ((midiMax - midi) / N_NOTES) * H + noteH(H) / 2;
}

export function isBlack(midi: number): boolean {
  return BLACK_PC.has(((midi % 12) + 12) % 12);
}

// Inverse of midiToY — rounds to the nearest semitone lane, one lane per integer MIDI note.
export function midiFromY(y: number, H: number, midiMin: number): number {
  const midiMax = midiMin + N_NOTES - 1;
  return Math.round(midiMax - ((y - noteH(H) / 2) / H) * N_NOTES);
}

/** Integer MIDI notes whose lane is at least partly visible (one lane of margin each side). */
export function visibleMidiRange(midiMin: number): { first: number; last: number } {
  return { first: Math.floor(midiMin) - 1, last: Math.ceil(midiMin + N_NOTES - 1) + 1 };
}

/**
 * Polylines of a pitch trace: a new one starts after every unvoiced, low-confidence, off-window or
 * off-range point and after every time gap longer than GAP_S.
 */
export function ribbonSegments(
  points: PitchPoint[],
  t0: number,
  t1: number,
  H: number,
  midiMin: number,
  timeToX: (t: number) => number,
): Point[][] {
  const midiMax = midiMin + N_NOTES - 1;
  const segments: Point[][] = [];
  let current: Point[] | null = null;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const midi = frequencyToMidi(p.frequency);
    const skip =
      p.confidence < CONF_MIN || p.frequency <= 0 ||
      p.time < t0 - 0.1 || p.time > t1 + 0.1 ||
      midi < midiMin || midi > midiMax;
    if (skip) {
      current = null;
      continue;
    }
    const prev = points[i - 1];
    if (prev && p.time - prev.time > GAP_S) current = null;

    const pt = { x: timeToX(p.time), y: midiToY(midi, H, midiMin) };
    if (current) {
      current.push(pt);
    } else {
      current = [pt];
      segments.push(current);
    }
  }
  return segments;
}

/** The note name sung around `currentTime` (average of the points within 60 ms), or null. */
export function noteAt(points: PitchPoint[], currentTime: number): string | null {
  const near = points.filter(
    (p) => Math.abs(p.time - currentTime) < 0.06 && p.confidence >= CONF_MIN && p.frequency > 0,
  );
  if (near.length === 0) return null;
  const avgMidi = near.reduce((s, p) => s + frequencyToMidi(p.frequency), 0) / near.length;
  const m = Math.round(avgMidi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/** Seconds between ruler ticks: the smallest of a fixed set that keeps ticks at least a minute-fraction apart. */
export function rulerInterval(rollW: number): number {
  const raw = (WINDOW_S / Math.max(1, rollW)) * 60;
  for (const n of [0.25, 0.5, 1, 2, 5]) {
    if (n >= raw) return n;
  }
  return 5;
}

export function rulerTickTimes(t0: number, interval: number): number[] {
  const times: number[] = [];
  for (let t = Math.ceil(t0 / interval) * interval; t <= t0 + WINDOW_S + 0.001; t += interval) times.push(t);
  return times;
}

export function formatClock(t: number): string {
  const secs = Math.max(0, t);
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface KeyHighlight {
  song: boolean;
  take: boolean;
  live: boolean;
  alt: boolean;
}

/** Fill of a piano-strip key: live beats take beats song beats the second voice beats the plain key. */
export function keyFill(black: boolean, hit: KeyHighlight, colors: PianoColors): string {
  if (hit.live) return colors.live;
  if (hit.take) return colors.take;
  if (hit.song) return colors.song;
  if (hit.alt) return colors.songAlt;
  return black ? "#1c1c1c" : "#c8c8c8";
}

export function keyLabelColor(hit: KeyHighlight): string {
  if (hit.song || hit.take || hit.live) return "#fff";
  return hit.alt ? "#123" : "#444";
}

/** Where the visible part of a punch region sits on the ruler, clipped to the roll. */
export function punchSpan(xL: number, xR: number, W: number): { from: number; to: number } | null {
  const from = Math.max(PIANO_W, xL);
  const to = Math.min(W, xR);
  return to > from ? { from, to } : null;
}

export function onRoll(x: number, W: number): boolean {
  return x >= PIANO_W && x <= W;
}
