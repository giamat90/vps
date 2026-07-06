/**
 * Client-side formant (F1/F2/F3) estimator via LPC.
 *
 * Pipeline: decimate -> pre-emphasis -> Hamming window -> autocorrelation ->
 * Levinson-Durbin (LPC coefficients) -> Durand-Kerner (polynomial roots) ->
 * pole-to-resonance conversion -> candidate filtering -> frame-to-frame
 * continuity tracking. No DOM/Web Audio references — takes a plain
 * Float32Array + sampleRate so it works identically for a live-mic analyser
 * buffer or a loaded-track playback analyser buffer.
 */

export interface FormantEstimate {
  f1: number | null;
  f2: number | null;
  f3: number | null;
}

const NULL_ESTIMATE: FormantEstimate = { f1: null, f2: null, f3: null };

const PRE_EMPHASIS = 0.97;
// The classic LPC-order rule (sampleRate/1000 + 2) assumes ~10-11kHz-sampled
// speech. Applied directly to a 44.1/48kHz analyser buffer it gives an
// excessive order (~46), making root-finding too slow/noisy for a per-frame
// real-time budget — decimate to a lower equivalent bandwidth first so the
// polynomial degree stays tractable (~14 at 12kHz).
const DECIMATED_SR = 12000;
const MIN_FORMANT_HZ = 90;
const MAX_FORMANT_HZ = 4000;
const MAX_BANDWIDTH_HZ = 400;
// Weight given to the new raw (post-matching) estimate each frame — lower =
// smoother but slower to react to fast vowel changes.
const TRACK_SMOOTHING = 0.4;

// ─── signal prep ────────────────────────────────────────────────────────────

function hammingWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  if (n === 1) { w[0] = 1; return w; }
  for (let i = 0; i < n; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return w;
}

// Cheap box-filter low-pass + decimate — sufficient to suppress gross
// aliasing for a formant estimator that only needs content well below the
// new Nyquist, not a high-fidelity resampler.
function decimate(samples: Float32Array, sampleRate: number, targetRate: number): { data: Float64Array; sr: number } {
  if (sampleRate <= targetRate) {
    const data = new Float64Array(samples.length);
    for (let i = 0; i < samples.length; i++) data[i] = samples[i];
    return { data, sr: sampleRate };
  }
  const factor = Math.max(1, Math.round(sampleRate / targetRate));
  const n = samples.length;
  const cums = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cums[i + 1] = cums[i] + samples[i];
  const halfWin = Math.max(1, Math.floor(factor / 2));
  const smoothed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(n - 1, i + halfWin);
    smoothed[i] = (cums[hi + 1] - cums[lo]) / (hi - lo + 1);
  }
  const outLen = Math.floor(n / factor);
  const out = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = smoothed[i * factor];
  return { data: out, sr: sampleRate / factor };
}

function preEmphasize(x: Float64Array): Float64Array {
  const y = new Float64Array(x.length);
  y[0] = x[0];
  for (let i = 1; i < x.length; i++) y[i] = x[i] - PRE_EMPHASIS * x[i - 1];
  return y;
}

function autocorrelate(x: Float64Array, maxLag: number): Float64Array {
  const r = new Float64Array(maxLag + 1);
  const n = x.length;
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += x[i] * x[i + lag];
    r[lag] = sum;
  }
  return r;
}

// Levinson-Durbin recursion. Returns the prediction-error filter coefficients
// [1, a1, ..., aOrder] for the monic polynomial
// z^order + a1*z^(order-1) + ... + aOrder, or null for a degenerate frame
// (e.g. silence, where R[0] <= 0).
function levinsonDurbin(r: Float64Array, order: number): number[] | null {
  if (r[0] <= 0) return null;
  let a = new Float64Array(order + 1);
  a[0] = 1;
  let e = r[0];
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    if (e === 0) return null;
    const k = -acc / e;
    const next = new Float64Array(order + 1);
    next[0] = 1;
    for (let j = 1; j < i; j++) next[j] = a[j] + k * a[i - j];
    next[i] = k;
    a = next;
    e *= 1 - k * k;
    if (!Number.isFinite(e) || e <= 0) return null;
  }
  return Array.from(a);
}

// ─── polynomial root-finding (Durand-Kerner / Weierstrass) ─────────────────
//
// Finds all roots of a real-coefficient polynomial simultaneously via
// x_i := x_i - p(x_i) / prod_{j != i} (x_i - x_j), iterated to convergence.
// Chosen over Bairstow's method for lower implementation risk (no
// partial-derivative recurrence bookkeeping) while still numerically stable
// and cheap enough for real-time use at the polynomial orders (~14) produced
// after decimation. Validated against known-root polynomials during
// development.

interface Complex { re: number; im: number; }

function cAdd(a: Complex, b: Complex): Complex { return { re: a.re + b.re, im: a.im + b.im }; }
function cSub(a: Complex, b: Complex): Complex { return { re: a.re - b.re, im: a.im - b.im }; }
function cMul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}
function cDiv(a: Complex, b: Complex): Complex {
  const d = b.re * b.re + b.im * b.im;
  if (d === 0) return { re: 0, im: 0 };
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}
function cAbs(a: Complex): number { return Math.sqrt(a.re * a.re + a.im * a.im); }

function evalPoly(coeffs: number[], x: Complex): Complex {
  let result: Complex = { re: 0, im: 0 };
  for (const c of coeffs) {
    result = cAdd(cMul(result, x), { re: c, im: 0 });
  }
  return result;
}

function durandKerner(coeffs: number[], maxIters = 100, tol = 1e-6): Complex[] | null {
  const n = coeffs.length - 1;
  if (n < 1) return null;
  const c0 = coeffs[0];
  const normalized = c0 === 1 ? coeffs : coeffs.map((c) => c / c0);

  let roots: Complex[] = [];
  const seed: Complex = { re: 0.4, im: 0.9 };
  let cur: Complex = { re: 1, im: 0 };
  for (let i = 0; i < n; i++) {
    cur = cMul(cur, seed);
    roots.push({ ...cur });
  }

  for (let iter = 0; iter < maxIters; iter++) {
    let maxDelta = 0;
    const next: Complex[] = new Array(n);
    for (let i = 0; i < n; i++) {
      let denom: Complex = { re: 1, im: 0 };
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        denom = cMul(denom, cSub(roots[i], roots[j]));
      }
      const numer = evalPoly(normalized, roots[i]);
      const delta = cDiv(numer, denom);
      next[i] = cSub(roots[i], delta);
      maxDelta = Math.max(maxDelta, cAbs(delta));
    }
    roots = next;
    if (!Number.isFinite(maxDelta)) return null;
    if (maxDelta < tol) break;
  }
  return roots;
}

// ─── frame-to-frame continuity ─────────────────────────────────────────────

function permutationsOf(n: number): number[][] {
  if (n === 0) return [[]];
  const indices = Array.from({ length: n }, (_, i) => i);
  const results: number[][] = [];
  const permute = (remaining: number[], acc: number[]) => {
    if (remaining.length === 0) { results.push(acc); return; }
    for (let i = 0; i < remaining.length; i++) {
      const rest = remaining.slice(0, i).concat(remaining.slice(i + 1));
      permute(rest, acc.concat(remaining[i]));
    }
  };
  permute(indices, []);
  return results;
}

function assignWithContinuity(candidates: number[], prev?: FormantEstimate): FormantEstimate {
  const prevSlots: (number | null)[] = prev ? [prev.f1, prev.f2, prev.f3] : [null, null, null];
  const haveAnyPrev = prevSlots.some((v) => v !== null);

  if (!haveAnyPrev || candidates.length === 0) {
    return { f1: candidates[0] ?? null, f2: candidates[1] ?? null, f3: candidates[2] ?? null };
  }

  // At most 3 candidates/slots survive filtering, so brute-forcing all
  // permutations (<=3! = 6) to minimize total frequency jump vs. the
  // previous frame is trivial.
  const n = Math.min(candidates.length, 3);
  let bestPerm: number[] | null = null;
  let bestCost = Infinity;
  for (const perm of permutationsOf(n)) {
    let cost = 0;
    for (let slot = 0; slot < n; slot++) {
      const prevVal = prevSlots[slot];
      if (prevVal !== null) cost += Math.abs(candidates[perm[slot]] - prevVal);
    }
    if (cost < bestCost) { bestCost = cost; bestPerm = perm; }
  }

  const assigned: (number | null)[] = [null, null, null];
  if (bestPerm) {
    for (let slot = 0; slot < n; slot++) assigned[slot] = candidates[bestPerm[slot]];
  }

  const smooth = (raw: number | null, prevVal: number | null): number | null => {
    if (raw === null) return null;
    if (prevVal === null) return raw;
    return TRACK_SMOOTHING * raw + (1 - TRACK_SMOOTHING) * prevVal;
  };

  return {
    f1: smooth(assigned[0], prevSlots[0]),
    f2: smooth(assigned[1], prevSlots[1]),
    f3: smooth(assigned[2], prevSlots[2]),
  };
}

// ─── entry point ────────────────────────────────────────────────────────────

export function estimateFormants(samples: Float32Array, sampleRate: number, prevEstimate?: FormantEstimate): FormantEstimate {
  const { data: decimated, sr } = decimate(samples, sampleRate, DECIMATED_SR);
  if (decimated.length < 32) return NULL_ESTIMATE;

  const emphasized = preEmphasize(decimated);
  const window = hammingWindow(emphasized.length);
  const windowed = new Float64Array(emphasized.length);
  for (let i = 0; i < emphasized.length; i++) windowed[i] = emphasized[i] * window[i];

  const order = Math.min(Math.round(sr / 1000) + 2, Math.floor(windowed.length / 2) - 1);
  if (order < 4) return NULL_ESTIMATE;

  const r = autocorrelate(windowed, order);
  const lpc = levinsonDurbin(r, order);
  if (!lpc) return NULL_ESTIMATE;

  const roots = durandKerner(lpc);
  if (!roots) return NULL_ESTIMATE;

  const candidates: number[] = [];
  for (const root of roots) {
    if (root.im <= 0) continue; // one root per conjugate pair
    const mag = Math.sqrt(root.re * root.re + root.im * root.im);
    if (mag <= 0 || mag >= 1) continue;
    const freq = (sr / (2 * Math.PI)) * Math.atan2(root.im, root.re);
    const bandwidth = -(sr / Math.PI) * Math.log(mag);
    if (freq < MIN_FORMANT_HZ || freq > MAX_FORMANT_HZ) continue;
    if (bandwidth < 0 || bandwidth > MAX_BANDWIDTH_HZ) continue;
    candidates.push(freq);
  }
  candidates.sort((a, b) => a - b);

  return assignWithContinuity(candidates.slice(0, 3), prevEstimate);
}
