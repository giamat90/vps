/**
 * Minimal dependency-free radix-2 FFT, for computing a one-off magnitude
 * spectrum from an arbitrary window of samples — used to snapshot the
 * Spectrogram/Short-Term Spectrum panels at a paused or scrubbed playhead
 * position in Free Exercise, where no live AnalyserNode data exists (an
 * AnalyserNode only reports something while audio is actively flowing
 * through it). `fftSize` must be a power of 2.
 */

function bitReverseIndices(n: number): Uint32Array {
  const bits = Math.log2(n);
  const result = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let rev = 0;
    let x = i;
    for (let b = 0; b < bits; b++) {
      rev = (rev << 1) | (x & 1);
      x >>= 1;
    }
    result[i] = rev;
  }
  return result;
}

const bitRevCache = new Map<number, Uint32Array>();
function getBitRev(n: number): Uint32Array {
  let cached = bitRevCache.get(n);
  if (!cached) {
    cached = bitReverseIndices(n);
    bitRevCache.set(n, cached);
  }
  return cached;
}

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of 2. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  const bitRev = getBitRev(n);
  for (let i = 0; i < n; i++) {
    const j = bitRev[i];
    if (j > i) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const angleStep = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const angle = angleStep * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const i0 = start + k;
        const i1 = i0 + half;
        const tr = re[i1] * wr - im[i1] * wi;
        const ti = re[i1] * wi + im[i1] * wr;
        re[i1] = re[i0] - tr;
        im[i1] = im[i0] - ti;
        re[i0] += tr;
        im[i0] += ti;
      }
    }
  }
}

function blackmanWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  const a0 = 0.42, a1 = 0.5, a2 = 0.08;
  for (let i = 0; i < n; i++) {
    w[i] = a0 - a1 * Math.cos((2 * Math.PI * i) / (n - 1)) + a2 * Math.cos((4 * Math.PI * i) / (n - 1));
  }
  return w;
}

const windowCache = new Map<number, Float64Array>();
function getWindow(n: number): Float64Array {
  let cached = windowCache.get(n);
  if (!cached) {
    cached = blackmanWindow(n);
    windowCache.set(n, cached);
  }
  return cached;
}

/**
 * Blackman-windowed FFT magnitude spectrum in dB, approximating (not
 * bit-exact) the scale of AnalyserNode.getFloatFrequencyData so it's
 * visually comparable to the live analyser-driven view. Returns
 * fftSize/2 bins.
 */
export function computeMagnitudeSpectrumDb(samples: Float32Array, fftSize: number): Float32Array {
  const window = getWindow(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const n = Math.min(samples.length, fftSize);
  for (let i = 0; i < n; i++) re[i] = samples[i] * window[i];
  // Remaining entries (if samples is shorter than fftSize) stay zero-padded.

  fft(re, im);

  const binCount = fftSize / 2;
  const out = new Float32Array(binCount);
  for (let k = 0; k < binCount; k++) {
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / fftSize;
    out[k] = 20 * Math.log10(mag + 1e-12);
  }
  return out;
}
