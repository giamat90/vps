// Shared utilities for spectrogram rendering (song pre-computed + live mic).

export const MIDI_MIN = 45;           // A2
export const MIDI_MAX = 84;           // C6
export const N_NOTES  = MIDI_MAX - MIDI_MIN + 1; // 40
export const N_SPECTRO_ROWS = 160;    // 4 sub-rows per semitone for live capture

// Thermal colormap: noise floor is near-black, signal rises through navy → blue → teal → yellow → orange → white.
// Control points are non-uniformly spaced so the first 25% of entries (quiet signal) stays very dark.
// Layout: [r0,g0,b0, r1,g1,b1, ...] — 256 entries × 3 bytes.
export const SPECTRO_COLORMAP: Uint8Array = (() => {
  // [normalised position 0-1, r, g, b]
  const stops: [number, number, number, number][] = [
    [0.00,   0,   0,   0],  // pure black — silence
    [0.10,   0,   8,  24],  // near black, hint of blue
    [0.25,  10,  26,  58],  // dark navy
    [0.50,  13,  79, 140],  // mid blue
    [0.70,  26, 158, 110],  // teal — only at this level
    [0.85, 232, 192,  32],  // yellow
    [0.95, 224,  80,  16],  // orange
    [1.00, 255, 255, 255],  // white peak
  ];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const norm = i / 255;
    let lo = 0;
    for (let s = 0; s < stops.length - 1; s++) {
      if (stops[s][0] <= norm) lo = s;
    }
    const hi    = Math.min(lo + 1, stops.length - 1);
    const range = stops[hi][0] - stops[lo][0];
    const f     = range > 0 ? (norm - stops[lo][0]) / range : 0;
    lut[i * 3]     = Math.round(stops[lo][1] * (1 - f) + stops[hi][1] * f);
    lut[i * 3 + 1] = Math.round(stops[lo][2] * (1 - f) + stops[hi][2] * f);
    lut[i * 3 + 2] = Math.round(stops[lo][3] * (1 - f) + stops[hi][3] * f);
  }
  return lut;
})();

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

