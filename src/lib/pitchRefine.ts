/**
 * Fine-tunes a rough fundamental with the normalised autocorrelation (McLeod's
 * NSDF) of the same window.
 *
 * The harmonic analysis in harmonicEnvelope.ts finds f0 from FFT peaks, whose
 * resolution on an 8192-sample window is ~5 Hz: ~50 cents at 170 Hz, with a
 * visible frame-to-frame jitter once vibrato or a glide smears the harmonics.
 * Autocorrelation has sub-sample lag resolution, so seeded by that rough f0 it
 * lands within a few cents on a steady note. The seed alone chooses the octave:
 * only lags within a few percent of its period are searched.
 *
 * Pure function, no DOM / Web Audio.
 */

/** Lag search range around the seed's period, as a fraction. */
const SEARCH_TOLERANCE = 0.06;
/** Normalised peak height below which the window is not periodic enough to trust. */
const MIN_CLARITY = 0.6;
/** More samples than this only add cost and glide smear. */
const MAX_SAMPLES = 8192;

export function refineF0(samples: Float32Array, sampleRate: number, seedHz: number): number | null {
  if (!(seedHz > 0)) return null;
  const n = Math.min(samples.length, MAX_SAMPLES);
  const start = Math.floor((samples.length - n) / 2);
  const x = samples.subarray(start, start + n);

  const seedLag = sampleRate / seedHz;
  const lo = Math.max(2, Math.floor(seedLag / (1 + SEARCH_TOLERANCE)));
  const hi = Math.ceil(seedLag * (1 + SEARCH_TOLERANCE));
  // At least half the window must still overlap itself at the longest lag.
  if (hi + 1 >= n / 2) return null;

  const squares = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) squares[i + 1] = squares[i] + x[i] * x[i];

  const nsdf = (lag: number): number => {
    const len = n - lag;
    let acf = 0;
    for (let j = 0; j < len; j++) acf += x[j] * x[j + lag];
    const energy = squares[len] + (squares[n] - squares[lag]);
    return energy > 0 ? (2 * acf) / energy : 0;
  };

  // One lag of margin each side so the best lag always has both neighbours.
  const values: number[] = [];
  for (let lag = lo - 1; lag <= hi + 1; lag++) values.push(nsdf(lag));

  let bestIndex = 1;
  for (let i = 1; i < values.length - 1; i++) if (values[i] > values[bestIndex]) bestIndex = i;
  if (values[bestIndex] < MIN_CLARITY) return null;

  const y1 = values[bestIndex - 1];
  const y2 = values[bestIndex];
  const y3 = values[bestIndex + 1];
  const curvature = y1 - 2 * y2 + y3;
  const shift = curvature < 0 ? (0.5 * (y1 - y3)) / curvature : 0;
  return sampleRate / (lo - 1 + bestIndex + shift);
}
