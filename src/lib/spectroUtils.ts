// Spectrogram rendering helpers; the pure curve code (log-Hz axis, dB span, colour map, smoothing, FFT, formants)
// moved to mps-core/spectrum and is re-exported here so the panels keep one import.
import { SPECTRO_COLORMAP, xToFreq, type SpectrumPoint } from "@giamat90/mps-core/spectrum";

export {
  SPECTRO_COLORMAP,
  SPECTRUM_MAX_DB,
  SPECTRUM_MIN_DB,
  WEBAUDIO_TO_DBFS,
  analyserCurvePoints,
  freqToX,
  smoothSpectrumEnvelope,
  smoothSpectrumLight,
  xToFreq,
  type SpectrumPoint,
} from "@giamat90/mps-core/spectrum";

export const MIDI_MIN = 45;           // A2
export const MIDI_MAX = 84;           // C6
export const N_NOTES  = MIDI_MAX - MIDI_MIN + 1; // 40
export const N_SPECTRO_ROWS = 160;    // 4 sub-rows per semitone for live capture


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

/**
 * Decode a base64-encoded Short-Term Spectrum blob (n_frames x n_bins uint8)
 * produced by compute_short_term_spectrum in the sidecar.
 */
export function decodeSTSpectrumFrames(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Display layout shared by ShortTermSpectrumPanel (Free Exercise) and ShortTermSpectrumComparisonPanel
// (Practice Room); the curve helpers and the dB span live in mps-core/spectrum.
export const SPECTRUM_BOTTOM_AXIS_H = 16; // px (dpr-scaled) reserved under the plot for Hz labels

/** Share of the Nyquist frequency up to which a measured curve is trusted; the resampler's roll-off sits above it. */
export const MEASURED_BAND = 0.9;

/**
 * A measured curve with a stored one from the buffer's usable band upwards. The engine's decoded audio is
 * 8 kHz, so above ~3.6 kHz there is nothing measured to draw (analyserCurvePoints would repeat the last bin
 * as a flat line); the stored frame still carries the file's full range, at the same level. Without a stored
 * frame the part above the band is left empty.
 */
export function stitchAboveNyquist(
  measured: SpectrumPoint[],
  stored: SpectrumPoint[] | null,
  sampleRate: number,
  rollW: number,
  fMin: number,
  fMax: number,
): SpectrumPoint[] {
  const limit = MEASURED_BAND * (sampleRate / 2);
  if (limit >= fMax) return measured;
  return measured.map((p, px) => {
    if (xToFreq(px, rollW, fMin, fMax) < limit) return p;
    return stored ? stored[px] : { ...p, normalized: 0 };
  });
}
/**
 * Song time under a horizontal drag of a centred, fixed-width time window (PianoRoll, SpectrogramPanel):
 * dragging right moves back in time. Null when the roll has no width to measure against.
 */
export function windowDragTime(
  startTime: number,
  startX: number,
  x: number,
  rollW: number,
  windowS: number,
  duration: number,
): number | null {
  if (rollW <= 0) return null;
  const deltaT = -((x - startX) / rollW) * windowS;
  return Math.max(0, Math.min(duration, startTime + deltaT));
}
