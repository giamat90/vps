import { SPECTRO_COLORMAP } from "./spectroUtils";
import {
  AXIS_W,
  BAR_WIDTH,
  LEGEND_MARGIN,
  LEGEND_WIDTH,
  freqAxisTicks,
  formatHz,
  gridLineYs,
  legendTicks,
  maxFrequency,
  staticWindowGeometry,
} from "./spectrogramMath";

export function drawFreqAxis(ctx: CanvasRenderingContext2D, H: number, sampleRate: number, dpr: number): void {
  const fMax = maxFrequency(sampleRate);

  ctx.fillStyle = "#16213e";
  ctx.fillRect(0, 0, AXIS_W, H);

  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(AXIS_W - 1, 0);
  ctx.lineTo(AXIS_W - 1, H);
  ctx.stroke();

  ctx.font = `${11 * dpr}px monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";

  if (fMax >= 20000) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText("20k", AXIS_W - 6, 8 * dpr);
  }

  for (const { f, y, anchor } of freqAxisTicks(H, fMax)) {
    ctx.strokeStyle = anchor ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(AXIS_W, y);
    ctx.lineTo(AXIS_W + 8, y);
    ctx.stroke();

    ctx.fillStyle = anchor ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.85)";
    ctx.fillText(formatHz(f), AXIS_W - 6, y);
  }
}

export function drawDbLegend(ctx: CanvasRenderingContext2D, W: number, H: number, dpr: number): void {
  const barX = W - LEGEND_WIDTH;

  // Inset so the min/max labels render fully instead of clipping at the canvas edge.
  const padY = 12 * dpr;
  const barTop = padY;
  const barH = H - padY * 2;

  for (let r = 0; r < barH; r++) {
    const normalized = 1 - r / barH;
    const curved = Math.pow(normalized, 0.38);
    const idx = Math.floor(curved * 255);
    ctx.fillStyle = `rgb(${SPECTRO_COLORMAP[idx * 3]},${SPECTRO_COLORMAP[idx * 3 + 1]},${SPECTRO_COLORMAP[idx * 3 + 2]})`;
    ctx.fillRect(barX, barTop + r, BAR_WIDTH, 1);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.strokeRect(barX, barTop, BAR_WIDTH, barH);

  for (const { db, y, isEdge } of legendTicks(barTop, barH)) {
    ctx.strokeStyle = isEdge ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(barX - 2, y);
    ctx.lineTo(barX + BAR_WIDTH, y);
    ctx.stroke();

    ctx.fillStyle = isEdge ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.7)";
    ctx.font = isEdge ? `bold ${11 * dpr}px monospace` : `${9.5 * dpr}px monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`${db}`, barX + BAR_WIDTH + LEGEND_MARGIN, y);
  }
}

export function drawGridLines(ctx: CanvasRenderingContext2D, W: number, H: number, fMax: number): void {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 0.5;
  for (const y of gridLineYs(H, fMax)) {
    ctx.beginPath();
    ctx.moveTo(AXIS_W, y);
    ctx.lineTo(W - LEGEND_WIDTH, y);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawIdleMessage(ctx: CanvasRenderingContext2D, x: number, y: number, dpr: number): void {
  ctx.fillStyle = "#a0a0b040";
  ctx.font = `${11 * dpr}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Enable Monitor or Record to see spectrum", x, y);
}

export function drawCenterPlayhead(ctx: CanvasRenderingContext2D, x: number, H: number, dpr: number): void {
  ctx.save();
  ctx.strokeStyle = "rgba(255, 200, 60, 0.85)";
  ctx.lineWidth = 1.5 * dpr;
  ctx.setLineDash([4 * dpr, 3 * dpr]);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, H);
  ctx.stroke();
  ctx.restore();
}

export function fillFormantTicks(ctx: CanvasRenderingContext2D, ys: number[], x: number, w: number): void {
  ctx.fillStyle = "#e8fbff";
  for (const y of ys) ctx.fillRect(x, Math.max(0, y - 1), w, 2);
}

export interface TrackSpectrogramImage {
  canvas: CanvasImageSource;
  hopTime: number;
  cols: number;
  rows: number;
}

/** The centred, drag-to-seek window over a precomputed track spectrogram. */
export function drawTrackSpectrogramWindow(
  ctx: CanvasRenderingContext2D,
  spec: TrackSpectrogramImage,
  currentTime: number,
  rollW: number,
  H: number,
): void {
  ctx.fillStyle = "#0f0f1e";
  ctx.fillRect(AXIS_W, 0, rollW, H);
  const g = staticWindowGeometry(currentTime, spec.hopTime, spec.cols, rollW);
  if (!g) return;
  ctx.drawImage(
    spec.canvas,
    g.srcColStart, 0, g.srcColEnd - g.srcColStart, spec.rows,
    g.destX, 0, g.destW, H,
  );
}
