// Shared utilities for spectrogram rendering (song pre-computed + live mic).

export const MIDI_MIN = 45;           // A2
export const MIDI_MAX = 84;           // C6
export const N_NOTES  = MIDI_MAX - MIDI_MIN + 1; // 40
export const N_SPECTRO_ROWS = 160;    // 4 sub-rows per semitone for live capture

// Thermal colormap: index-based control points, segments interpolated linearly.
// Layout: [r0,g0,b0, r1,g1,b1, ...] — 256 entries × 3 bytes.
function buildColormap(): Uint8Array {
  const map = new Uint8Array(256 * 3);
  const stops = [
    [  0,   0,   0,  16],  // 0.00
    [ 51,  10,  10, 110],  // 0.20
    [102,   0, 112, 255],  // 0.40
    [140,   0, 229, 255],  // 0.55
    [179, 170, 255,   0],  // 0.70
    [209, 255, 170,   0],  // 0.82
    [235, 255,  34,   0],  // 0.92
    [255, 255, 255, 255],  // 1.00
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [i0, r0, g0, b0] = stops[i];
    const [i1, r1, g1, b1] = stops[i + 1];
    for (let j = i0; j <= i1; j++) {
      const t = (j - i0) / (i1 - i0);
      map[j * 3]     = Math.round(r0 + t * (r1 - r0));
      map[j * 3 + 1] = Math.round(g0 + t * (g1 - g0));
      map[j * 3 + 2] = Math.round(b0 + t * (b1 - b0));
    }
  }
  return map;
}

export const SPECTRO_COLORMAP: Uint8Array = buildColormap();

// Verification log — confirms correct colors are loaded at key indices.
[0, 64, 128, 192, 255].forEach((i) => {
  console.log(
    `colormap[${i}]: rgb(${SPECTRO_COLORMAP[i * 3]}, ${SPECTRO_COLORMAP[i * 3 + 1]}, ${SPECTRO_COLORMAP[i * 3 + 2]})`,
  );
});

/**
 * Build an OffscreenCanvas from raw base64-encoded spectrogram bytes.
 * Layout: n_frames columns × nRows rows; row 0 = top (highest freq).
 */
export function buildSpectroCanvas(
  b64: string,
  frames: number,
  nRows: number,
): OffscreenCanvas {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const canvas = new OffscreenCanvas(frames, nRows);
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(frames, nRows);
  const lut = SPECTRO_COLORMAP;

  for (let f = 0; f < frames; f++) {
    for (let r = 0; r < nRows; r++) {
      const val = raw[f * nRows + r];
      const px = (r * frames + f) * 4;
      img.data[px]     = lut[val * 3];
      img.data[px + 1] = lut[val * 3 + 1];
      img.data[px + 2] = lut[val * 3 + 2];
      img.data[px + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Quantise raw FFT byte magnitudes (0–255 from AnalyserNode.getByteFrequencyData)
 * into N_SPECTRO_ROWS sub-semitone rows matching the piano roll.
 * Row 0 = top (MIDI_MAX, highest pitch), row N_SPECTRO_ROWS-1 = bottom (MIDI_MIN).
 */
export function quantizeFftToRows(fftData: Uint8Array, sampleRate: number): Uint8Array {
  const binHz = sampleRate / (fftData.length * 2);
  const result = new Uint8Array(N_SPECTRO_ROWS);
  const rowWidthSemitones = (MIDI_MAX - MIDI_MIN) / (N_SPECTRO_ROWS - 1);

  for (let ri = 0; ri < N_SPECTRO_ROWS; ri++) {
    const midiFloat = MIDI_MAX - (ri / (N_SPECTRO_ROWS - 1)) * (MIDI_MAX - MIDI_MIN);
    const fCenter = 440 * Math.pow(2, (midiFloat - 69) / 12);
    const fLo = fCenter * Math.pow(2, -rowWidthSemitones / 2 / 12);
    const fHi = fCenter * Math.pow(2, rowWidthSemitones / 2 / 12);
    const binLo = Math.max(0, Math.floor(fLo / binHz));
    const binHi = Math.min(fftData.length - 1, Math.ceil(fHi / binHz));

    let sum = 0;
    let count = 0;
    for (let b = binLo; b <= binHi; b++) {
      sum += fftData[b];
      count++;
    }
    result[ri] = count > 0 ? Math.round(sum / count) : 0;
  }

  return result;
}

// ─── log-Hz x-axis mapping (shared by ShortTermSpectrumPanel and
// ShortTermSpectrumComparisonPanel) ────────────────────────────────────────
//
// Mirrors SpectrogramPanel.tsx's freqToY (fMax→0 / fMin→size, high freq at
// top) onto the X axis so high freq lands on the right: x = w - freqToY-shaped.
// fMin/fMax are passed in rather than imported from SpectrogramPanel.tsx to
// avoid a circular module dependency (SpectrogramPanel already imports from
// this file).

export function freqToX(f: number, w: number, fMin: number, fMax: number): number {
  const logFMin = Math.log(fMin);
  const logFMax = Math.log(fMax);
  return w - ((logFMax - Math.log(f)) / (logFMax - logFMin)) * w;
}

export function xToFreq(x: number, w: number, fMin: number, fMax: number): number {
  const logFMin = Math.log(fMin);
  const logFMax = Math.log(fMax);
  const t = (w - x) / w;
  return Math.exp(logFMax - t * (logFMax - logFMin));
}

/**
 * Decode a base64-encoded Short-Term Spectrum blob (n_frames x n_bins uint8)
 * produced by compute_short_term_spectrum in the sidecar.
 */
export function decodeSTSpectrumFrames(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export interface SpectrumPoint { x: number; y: number; normalized: number }

/**
 * Moving average with a window that widens with frequency — formants are
 * proportionally wider at high frequencies on a log axis. Shared by
 * ShortTermSpectrumPanel (Free Exercise) and ShortTermSpectrumComparisonPanel
 * (PracticeRoom, applied to the singer's own live/take curve only — the Song
 * reference curve is left raw/precise on purpose).
 */
export function smoothSpectrumEnvelope(points: SpectrumPoint[]): SpectrumPoint[] {
  const result: SpectrumPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const windowSize = Math.round(15 + (i / points.length) * 25);
    const start = Math.max(0, i - windowSize);
    const end = Math.min(points.length - 1, i + windowSize);
    let sum = 0, count = 0;
    for (let j = start; j <= end; j++) {
      sum += points[j].normalized;
      count++;
    }
    result.push({ x: points[i].x, y: 0, normalized: sum / count });
  }
  return result;
}

/**
 * Light fixed-window moving average — just enough to take the edge off
 * single-frame noise/jitter without flattening real harmonic peaks, unlike
 * smoothSpectrumEnvelope's much wider window (15-40 samples), which is
 * deliberately aggressive to extract a formant-envelope shape and is meant
 * to be drawn as an overlay ON TOP of the raw curve, not as a replacement
 * for it. Used where the curve itself needs to stay recognizable as an
 * actual spectrum (e.g. ShortTermSpectrumComparisonPanel's live/take line).
 */
export function smoothSpectrumLight(points: SpectrumPoint[], windowSize = 2): SpectrumPoint[] {
  const result: SpectrumPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const start = Math.max(0, i - windowSize);
    const end = Math.min(points.length - 1, i + windowSize);
    let sum = 0, count = 0;
    for (let j = start; j <= end; j++) {
      sum += points[j].normalized;
      count++;
    }
    result.push({ x: points[i].x, y: 0, normalized: sum / count });
  }
  return result;
}

