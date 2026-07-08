/**
 * Precomputes a whole loaded exercise track's spectrogram once (client-side
 * FFT over the already-decoded WaveSurfer buffer), so SpectrogramPanel can
 * render a centered, drag-to-seek window over it exactly like PianoRoll does
 * for pitch — instead of the live right-aligned scrolling waterfall, which
 * has no concept of "seek to an arbitrary time" since it discards spectral
 * history as it scrolls. Only viable for a loaded track (finite, fully
 * decoded in memory); live mic monitoring/recording keeps the waterfall,
 * since there's no future to precompute.
 */

import { computeMagnitudeSpectrumDb } from "./fft";
import { SPECTRO_COLORMAP } from "./spectroUtils";
import { buildFreqBinLut, dbToCurvedNorm } from "../components/analysis/SpectrogramPanel";

const FFT_SIZE = 8192;
const HOP_SIZE = 4096; // 50% overlap — ~93ms/column at 44.1kHz, smooth enough to scrub
export const TRACK_SPECTRO_ROWS = 160;
// Yield to the event loop every this many columns so a long track doesn't
// freeze the UI thread for multiple seconds during a single synchronous pass.
const YIELD_EVERY = 40;

export interface TrackSpectrogram {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  hopTime: number;   // seconds per column; times[col] = col * hopTime
  cols: number;
  rows: number;
}

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  try {
    return new OffscreenCanvas(w, h);
  } catch {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
}

function yield_(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function computeTrackSpectrogram(buffer: AudioBuffer): Promise<TrackSpectrogram> {
  const sampleRate = buffer.sampleRate;
  const channelData = buffer.getChannelData(0);
  const totalSamples = channelData.length;
  const cols = Math.max(1, Math.ceil(totalSamples / HOP_SIZE));
  const rows = TRACK_SPECTRO_ROWS;

  const { low, high } = buildFreqBinLut(rows, FFT_SIZE, sampleRate);

  const canvas = makeCanvas(cols, rows);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) return { canvas, hopTime: HOP_SIZE / sampleRate, cols, rows };
  const img = ctx.createImageData(cols, rows);

  const windowBuf = new Float32Array(FFT_SIZE);

  for (let col = 0; col < cols; col++) {
    const start = col * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = start + i;
      windowBuf[i] = idx < totalSamples ? channelData[idx] : 0;
    }
    const freqData = computeMagnitudeSpectrumDb(windowBuf, FFT_SIZE);
    const maxBin = freqData.length - 1;

    for (let row = 0; row < rows; row++) {
      let maxDb = -Infinity;
      const lo = low[row];
      const hi = Math.min(maxBin, high[row]);
      for (let b = lo; b <= hi; b++) {
        if (freqData[b] > maxDb) maxDb = freqData[b];
      }
      const idx = Math.min(255, Math.floor(dbToCurvedNorm(maxDb) * 255));
      const px = (row * cols + col) * 4;
      img.data[px]     = SPECTRO_COLORMAP[idx * 3];
      img.data[px + 1] = SPECTRO_COLORMAP[idx * 3 + 1];
      img.data[px + 2] = SPECTRO_COLORMAP[idx * 3 + 2];
      img.data[px + 3] = 255;
    }

    if (col % YIELD_EVERY === 0) await yield_();
  }

  ctx.putImageData(img, 0, 0);
  return { canvas, hopTime: HOP_SIZE / sampleRate, cols, rows };
}
