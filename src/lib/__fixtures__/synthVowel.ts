// Source-filter synthetic voice with KNOWN formants, shared by the formant
// and harmonic-envelope tests. Deterministic (seeded) so thresholds don't flake.

export type Formants3 = [number, number, number];

export const VOWELS: Record<string, Formants3> = {
  a: [730, 1090, 2440],
  e: [530, 1840, 2480],
  i: [270, 2290, 3010],
  o: [570, 840, 2410],
  u: [300, 870, 2240],
};

const BANDWIDTHS = [80, 100, 140, 200];
const FIXED_F4 = 3600;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function synthVowel(
  f0: number,
  formants: Formants3,
  { sampleRate = 44100, length = 8192, snrDb = 40, seed = 1 } = {},
): Float32Array {
  const rnd = lcg(seed);
  const warmup = 4096;
  const x = new Float64Array(length + warmup);
  const period = sampleRate / f0;
  for (let pos = rnd() * period; pos < x.length - 1; pos += period) {
    const i = Math.floor(pos);
    const frac = pos - i;
    x[i] += 1 - frac;
    x[i + 1] += frac;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < x.length; i++) x[i] += 0.95 * x[i - 1];
  }
  let y = new Float64Array(x.length);
  for (let i = 1; i < x.length; i++) y[i] = x[i] - x[i - 1];

  [...formants, FIXED_F4].forEach((freq, k) => {
    const r = Math.exp((-Math.PI * BANDWIDTHS[k]) / sampleRate);
    const a1 = 2 * r * Math.cos((2 * Math.PI * freq) / sampleRate);
    const a2 = -r * r;
    const b0 = 1 - a1 - a2;
    const out = new Float64Array(y.length);
    for (let i = 0; i < y.length; i++) {
      out[i] = b0 * y[i] + a1 * (i > 0 ? out[i - 1] : 0) + a2 * (i > 1 ? out[i - 2] : 0);
    }
    y = out;
  });

  const seg = y.subarray(warmup, warmup + length);
  let power = 0;
  for (const v of seg) power += v * v;
  const rms = Math.sqrt(power / length);
  const noiseAmp = Math.pow(10, -snrDb / 20);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const noise = (rnd() + rnd() + rnd() - 1.5) * 2 * noiseAmp;
    out[i] = 0.3 * (seg[i] / rms + noise);
  }
  return out;
}

export function whiteNoise(length: number, seed = 5, amplitude = 0.3): Float32Array {
  const rnd = lcg(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = (rnd() * 2 - 1) * amplitude;
  return out;
}

/** Within 10% of the true value, but never tighter than 40 Hz (low formants). */
export function withinTolerance(estimate: number | null, truth: number): boolean {
  return estimate !== null && Math.abs(estimate - truth) <= Math.max(0.1 * truth, 40);
}
