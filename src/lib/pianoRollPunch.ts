import {
  finishPunchDrag as finishCoreDrag,
  grabPunchEdge,
  startPunchDrag,
  updatePunchPreview,
  type PunchCommit,
  type PunchMode,
  type PunchPreview,
} from "@giamat90/mps-core/punch";
import { HANDLE_HIT, PIANO_W, WINDOW_S } from "./pianoRollGeometry";

export type { PunchCommit, PunchMode };
export type PunchOverride = PunchPreview;

// A drag in the ruler: which edge, where the fixed end is, and the window's left edge
// captured at mousedown so the coordinate system stays put while the song plays.
export type PunchDrag =
  | { mode: null; anchorT: number; capturedT0: number }
  | { mode: PunchMode; anchorT: number; capturedT0: number };

export const NO_DRAG: PunchDrag = { mode: null, anchorT: 0, capturedT0: 0 };

export function xToTime(x: number, t0: number, rollW: number): number {
  return t0 + ((x - PIANO_W) / rollW) * WINDOW_S;
}

export function timeToPx(t: number, t0: number, rollW: number): number {
  return PIANO_W + ((t - t0) / WINDOW_S) * rollW;
}

/** Which part of the ruler was grabbed: an existing boundary handle, or empty space (a new region). */
export function beginPunchDrag(
  x: number,
  rollW: number,
  capturedT0: number,
  punchIn: number | null,
  punchOut: number | null,
): { drag: PunchDrag; override: PunchOverride } {
  const xIn = punchIn === null ? null : timeToPx(punchIn, capturedT0, rollW);
  const xOut = punchOut === null ? null : timeToPx(punchOut, capturedT0, rollW);
  const mode = grabPunchEdge(x, xIn, xOut, HANDLE_HIT);
  const { drag, preview } = startPunchDrag(mode, xToTime(x, capturedT0, rollW), punchIn, punchOut);
  return { drag: { ...drag, capturedT0 }, override: preview };
}

/** The live preview of the region while dragging; nothing reaches the store until mouseup. */
export function updatePunchOverride(drag: PunchDrag & { mode: PunchMode }, t: number): PunchOverride {
  return updatePunchPreview(drag, t);
}

export function hoverCursor(
  x: number,
  rollW: number,
  currentTime: number,
  punchIn: number,
  punchOut: number,
): "ew-resize" | "crosshair" {
  const t0 = currentTime - WINDOW_S / 2;
  const nearHandle =
    Math.abs(x - timeToPx(punchIn, t0, rollW)) <= HANDLE_HIT ||
    Math.abs(x - timeToPx(punchOut, t0, rollW)) <= HANDLE_HIT;
  return nearHandle ? "ew-resize" : "crosshair";
}

export function finishPunchDrag(drag: PunchDrag & { mode: PunchMode }, t: number): PunchCommit {
  return finishCoreDrag(drag, t);
}
