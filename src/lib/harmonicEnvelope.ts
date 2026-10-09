/**
 * Harmonic analysis for formant estimation on pitched (sung) voice.
 *
 * Plain LPC fits the signal's autocorrelation, which for a high-pitched voice
 * is dominated by the sparse harmonics, so poles lock onto harmonics instead
 * of vocal-tract resonances. Here the spectral envelope is instead defined
 * only by the harmonic peaks (the points the voice actually samples),
 * interpolated between them; LPC is then fitted to that smooth envelope.
 *
 * Pure functions, no DOM / Web Audio / formants.ts imports.
 */

import { computeMagnitudeSpectrumDb } from "./fft";

export interface HarmonicAnalysis {
  /** Refined fundamental frequency, Hz. */
  f0: number;
  /** Harmonic frequencies (k * f0), Hz, ascending. */
  freqs: number[];
  /** Peak spectral level at each harmonic, dB (fft.ts scale). */
  db: number[];
}

const MIN_SAMPLES = 1024;
const MAX_FFT_SIZE = 16384;
const MIN_F0_HZ = 70;
const MAX_F0_HZ = 1100;
// Highest harmonic used; the per-call limit is also capped below Nyquist.
const HARMONIC_CEILING_HZ = 5200;
const MIN_POINTS = 4;
const SHS_HARMONICS = 10;
const SHS_DECAY = 0.9;
// Below this peak magnitude the frame is treated as silence (about -120 dB).
const SILENCE_MAG = 1e-6;
// Peak-to-valley ratio a harmonic needs to count as a standout when deciding
// whether a frame is voiced. Clean voice measures >= ~10, white noise ~1-2.
const MIN_HARMONIC_CONTRAST = 3;
const REFINE_HARMONICS = 12;
// A harmonic more than ~50 dB below the strongest peak is indistinguishable from noise.
const REFINE_MIN_REL_LEVEL = 0.003;

function largestPowerOfTwoAtMost(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

function magnitudesFromDb(db: Float32Array): Float64Array {
  const mag = new Float64Array(db.length);
  for (let k = 0; k < db.length; k++) mag[k] = Math.pow(10, db[k] / 20);
  return mag;
}

/** Largest magnitude within +-halfBins of a (fractional) bin position. */
function localMax(mag: Float64Array, bin: number, halfBins: number): number {
  const lo = Math.max(1, Math.floor(bin - halfBins));
  const hi = Math.min(mag.length - 2, Math.ceil(bin + halfBins));
  let best = 0;
  for (let k = lo; k <= hi; k++) if (mag[k] > best) best = mag[k];
  return best;
}

function subharmonicSummationF0(mag: Float64Array, binHz: number, maxHz: number): number | null {
  const candidates = new Float64Array(MAX_F0_HZ + 1);
  let bestScore = 0;
  let bestF = 0;
  for (let f = MIN_F0_HZ; f <= MAX_F0_HZ; f++) {
    let score = 0;
    for (let h = 1; h <= SHS_HARMONICS && h * f < maxHz; h++) {
      score += Math.pow(SHS_DECAY, h - 1) * Math.sqrt(localMax(mag, (h * f) / binHz, 1));
    }
    candidates[f] = score;
    if (score > bestScore) { bestScore = score; bestF = f; }
  }
  if (bestF === 0) return null;
  // A subharmonic (f/2) scores almost as high as the true pitch f when the
  // spectrum is sparse, so score alone can't tell them apart. Take f/2 only
  // if its odd harmonics (the ones f lacks) are real peaks, not noise.
  const half = Math.round(bestF / 2);
  if (half >= MIN_F0_HZ && candidates[half] > 0.92 * bestScore && oddHarmonicsStandOut(mag, half, binHz, maxHz)) {
    return half;
  }
  return bestF;
}

function oddHarmonicsStandOut(mag: Float64Array, f: number, binHz: number, maxHz: number): boolean {
  const halfWidth = Math.max(1, (0.12 * f) / binHz);
  for (const h of [1, 3]) {
    if (h * f >= maxHz) break;
    const peak = localMax(mag, (h * f) / binHz, halfWidth);
    const valley = localMax(mag, ((h + 0.5) * f) / binHz, halfWidth);
    if (peak >= MIN_HARMONIC_CONTRAST * (valley + 1e-12)) return true;
  }
  return false;
}

/**
 * True when enough of the first harmonics clearly stand above the valley
 * halfway to the next one. Counting standouts (not a median) keeps high
 * pitches voiced: with only 2-3 harmonics above the noise floor the rest are
 * legitimately weak, yet white noise essentially never produces several
 * well-separated peak/valley ratios >= MIN_HARMONIC_CONTRAST.
 */
function looksVoiced(mag: Float64Array, f0: number, binHz: number, maxHz: number): boolean {
  const halfWidth = Math.max(1, (0.12 * f0) / binHz);
  let checked = 0;
  let standouts = 0;
  for (let h = 1; h <= 8 && (h + 0.5) * f0 < maxHz; h++) {
    const peak = localMax(mag, (h * f0) / binHz, halfWidth);
    const valley = localMax(mag, ((h + 0.5) * f0) / binHz, halfWidth);
    checked++;
    if (peak >= MIN_HARMONIC_CONTRAST * (valley + 1e-12)) standouts++;
  }
  return checked > 0 && standouts >= Math.max(2, Math.ceil(0.4 * checked));
}

/** Parabolic interpolation of a magnitude peak, returned as a fractional bin. */
function interpolatedPeakBin(mag: Float64Array, bin: number): number {
  if (bin < 1 || bin >= mag.length - 1) return bin;
  const a = Math.log(mag[bin - 1] + 1e-12);
  const b = Math.log(mag[bin] + 1e-12);
  const c = Math.log(mag[bin + 1] + 1e-12);
  const denom = a - 2 * b + c;
  return denom < 0 ? bin + (0.5 * (a - c)) / denom : bin;
}

/**
 * Least-squares f0 through the origin from measured harmonic peak frequencies.
 * Only harmonics that stand clearly above the valley after them and are not
 * buried far below the strongest peak take part: the fit weights harmonic k by
 * k^2, so a noise peak at high k would otherwise drag the whole estimate.
 */
function refineF0(mag: Float64Array, f0: number, binHz: number, strongest: number, maxHz: number): number {
  let num = 0;
  let den = 0;
  let used = 0;
  const halfWidth = Math.max(2, (0.25 * f0) / binHz);
  for (let h = 1; h <= REFINE_HARMONICS && h * f0 < maxHz; h++) {
    const centre = (h * f0) / binHz;
    const lo = Math.max(1, Math.floor(centre - halfWidth));
    const hi = Math.min(mag.length - 2, Math.ceil(centre + halfWidth));
    let bestBin = -1;
    let best = 0;
    for (let k = lo; k <= hi; k++) if (mag[k] > best) { best = mag[k]; bestBin = k; }
    if (bestBin < 0 || best < strongest * REFINE_MIN_REL_LEVEL) continue;
    const valley = localMax(mag, ((h + 0.5) * f0) / binHz, halfWidth);
    if (best < MIN_HARMONIC_CONTRAST * valley) continue;
    const freq = interpolatedPeakBin(mag, bestBin) * binHz;
    num += h * freq;
    den += h * h;
    used++;
  }
  return used >= 2 && den > 0 ? num / den : f0;
}

export function analyseHarmonics(samples: Float32Array, sampleRate: number): HarmonicAnalysis | null {
  if (samples.length < MIN_SAMPLES) return null;
  const fftSize = largestPowerOfTwoAtMost(Math.min(samples.length, MAX_FFT_SIZE));
  const offset = Math.floor((samples.length - fftSize) / 2);
  const segment = offset === 0 && samples.length === fftSize ? samples : samples.subarray(offset, offset + fftSize);

  const mag = magnitudesFromDb(computeMagnitudeSpectrumDb(segment, fftSize));
  let peak = 0;
  for (let k = 1; k < mag.length; k++) if (mag[k] > peak) peak = mag[k];
  if (peak < SILENCE_MAG) return null;

  const binHz = sampleRate / fftSize;
  const maxHz = Math.min(HARMONIC_CEILING_HZ, 0.9 * (sampleRate / 2));
  const rough = subharmonicSummationF0(mag, binHz, maxHz);
  if (rough === null) return null;
  if (!looksVoiced(mag, rough, binHz, maxHz)) return null;

  const f0 = refineF0(mag, refineF0(mag, rough, binHz, peak, maxHz), binHz, peak, maxHz);
  if (f0 < MIN_F0_HZ || f0 > MAX_F0_HZ) return null;

  const freqs: number[] = [];
  const db: number[] = [];
  const halfWidth = Math.max(2, (0.25 * f0) / binHz);
  for (let h = 1; h * f0 < maxHz; h++) {
    freqs.push(h * f0);
    db.push(20 * Math.log10(localMax(mag, (h * f0) / binHz, halfWidth) + 1e-12));
  }
  if (freqs.length < MIN_POINTS) return null;
  return { f0, freqs, db };
}

const cosineTables = new Map<string, Float64Array>();

function cosineTable(gridSize: number, order: number): Float64Array {
  const key = `${gridSize}:${order}`;
  let table = cosineTables.get(key);
  if (!table) {
    table = new Float64Array((order + 1) * gridSize);
    for (let lag = 0; lag <= order; lag++) {
      for (let g = 0; g < gridSize; g++) {
        table[lag * gridSize + g] = Math.cos((Math.PI * g * lag) / (gridSize - 1));
      }
    }
    cosineTables.set(key, table);
  }
  return table;
}

/**
 * Autocorrelation (lags 0..order) of the smooth envelope drawn through the
 * harmonic peaks, as if the signal had been decimated to 2 * nyquistHz and
 * pre-emphasised (so the result plugs straight into Levinson-Durbin in place
 * of the time-domain autocorrelation). Linear interpolation in dB between
 * harmonics, flat outside the first/last one.
 */
export function envelopeAutocorrelation(
  analysis: HarmonicAnalysis,
  order: number,
  nyquistHz: number,
  preEmphasis: number,
  gridSize = 1024,
): Float64Array {
  const { freqs, db } = analysis;
  const last = freqs.length - 1;
  const power = new Float64Array(gridSize);
  let j = 0;
  for (let g = 0; g < gridSize; g++) {
    const f = (g * nyquistHz) / (gridSize - 1);
    let level: number;
    if (f <= freqs[0]) level = db[0];
    else if (f >= freqs[last]) level = db[last];
    else {
      while (freqs[j + 1] < f) j++;
      const t = (f - freqs[j]) / (freqs[j + 1] - freqs[j]);
      level = db[j] * (1 - t) + db[j + 1] * t;
    }
    const w = (Math.PI * g) / (gridSize - 1);
    const emphasis = 1 - 2 * preEmphasis * Math.cos(w) + preEmphasis * preEmphasis;
    power[g] = Math.pow(10, level / 10) * emphasis;
  }

  const table = cosineTable(gridSize, order);
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let sum = 0;
    const base = lag * gridSize;
    for (let g = 0; g < gridSize; g++) sum += power[g] * table[base + g];
    r[lag] = sum;
  }
  return r;
}
