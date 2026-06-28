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
    [  0,   0,   0,   0],  // 0.00 → black
    [ 30,   0,   4,  20],  // 0.12 → near black, faint blue
    [ 64,   0,  15,  60],  // 0.25 → dark navy
    [110,   0,  60, 140],  // 0.43 → medium blue
    [148,  10, 140, 110],  // 0.58 → teal (only here)
    [185, 200, 180,  20],  // 0.72 → yellow
    [215, 220,  80,  10],  // 0.84 → orange
    [230, 255,  60,  20],  // 0.90 → bright red-orange
    [245, 255, 200, 180],  // 0.96 → hot pink/salmon
    [255, 255, 255, 255],  // 1.00 → pure white
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

