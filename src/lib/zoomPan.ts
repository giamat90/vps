// Pure zoom/pan math for ctrl+wheel (zoom-to-cursor) and shift+wheel (pan)
// timeline navigation. Kept dependency-free (no store/engine imports) so the
// same logic is trivially shared, byte-identical, with SPS.

export const ZOOM_SENSITIVITY = 0.0015;
export const MAX_PX_PER_SEC = 1000;
export const PAN_SENSITIVITY_MULT = 1.0;
// How long a manual wheel zoom/pan suppresses playhead auto-follow, so a
// deliberate shift+wheel pan during playback doesn't get overridden on the
// very next animation frame.
export const FOLLOW_RESUME_SUPPRESS_MS = 800;
// Auto-follow nudges the view once the playhead crosses this fraction of the
// visible window, rather than snapping only at the hard edge.
export const FOLLOW_MARGIN_RATIO = 0.85;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// Normalizes a WheelEvent's delta to pixel-equivalent units regardless of
// deltaMode (0=pixel, 1=line, 2=page). `axis: "x-or-y"` prefers deltaX when
// present — some browsers/input devices report shift+wheel as deltaX
// natively, others keep reporting deltaY with shiftKey held.
export function wheelDeltaPixels(e: WheelEvent, axis: "y" | "x-or-y" = "y"): number {
  const raw = axis === "x-or-y" && e.deltaX !== 0 ? e.deltaX : e.deltaY;
  if (e.deltaMode === 1) return raw * 16; // line
  if (e.deltaMode === 2) return raw * 800; // page
  return raw; // pixel
}

export function computeZoomToCursor(args: {
  minPxPerSec: number;
  scrollTime: number;
  cursorOffsetPx: number;
  viewportWidthPx: number;
  duration: number;
  deltaY: number;
  minBound: number;
}): { minPxPerSec: number; scrollTime: number } {
  const { minPxPerSec, scrollTime, cursorOffsetPx, viewportWidthPx, duration, deltaY, minBound } = args;
  const cursorTime = scrollTime + cursorOffsetPx / minPxPerSec;
  const factor = Math.exp(-deltaY * ZOOM_SENSITIVITY);
  const newMinPxPerSec = clamp(minPxPerSec * factor, minBound, MAX_PX_PER_SEC);
  const maxScroll = Math.max(0, duration - viewportWidthPx / newMinPxPerSec);
  const newScrollTime = clamp(cursorTime - cursorOffsetPx / newMinPxPerSec, 0, maxScroll);
  return { minPxPerSec: newMinPxPerSec, scrollTime: newScrollTime };
}

export function computePan(args: {
  minPxPerSec: number;
  scrollTime: number;
  viewportWidthPx: number;
  duration: number;
  deltaPx: number;
}): number {
  const { minPxPerSec, scrollTime, viewportWidthPx, duration, deltaPx } = args;
  const maxScroll = Math.max(0, duration - viewportWidthPx / minPxPerSec);
  return clamp(scrollTime + deltaPx / minPxPerSec, 0, maxScroll);
}
