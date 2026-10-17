export const AXIS_W = 56;
export const WINDOW_S = 10;
export const F_MIN = 30;
export const F_MAX = 20000;

export const MIN_DB = -85; // floor -85dB — matches VoceVista dynamic range
export const MAX_DB = -20; // ceiling -20dB — loud bins reach top of thermal LUT

export const LEGEND_WIDTH = 52;
export const BAR_WIDTH = 10;
export const LEGEND_MARGIN = 6;
export const LEGEND_TICKS = [-20, -30, -40, -50, -60, -70, -80, -85];
export const FREQ_TICKS = [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
export const GRID_FREQS = [100, 500, 1000, 5000, 10000];

/** Wall-clock gap between two waterfall columns being captured. */
export const CAPTURE_INTERVAL_MS = 33;

// dB → normalized [0,1] curve driving the thermal colormap lookup. Shared by the live waterfall and
// exerciseSpectrogram.ts's precompute pass so a loaded track's static spectrogram looks identical.
export function dbToCurvedNorm(db: number): number {
  const norm = db < -80 ? 0 : Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
  // soft gate pushes noise floor to black like VoceVista
  const gated = norm < 0.15 ? norm * (norm / 0.15) * 0.3 : norm;
  // gamma 0.38 — preserves fundamental peak brightness
  return Math.pow(gated, 0.38);
}

export function buildFreqBinLut(
  H: number,
  fftSize: number,
  sampleRate: number,
): { low: Uint16Array; high: Uint16Array } {
  const nyquist = sampleRate / 2;
  const fMax = Math.min(F_MAX, nyquist);
  const binHz = sampleRate / fftSize;
  const maxBin = fftSize / 2 - 1;
  const logFMin = Math.log(F_MIN);
  const logFMax = Math.log(fMax);
  const low = new Uint16Array(H);
  const high = new Uint16Array(H);
  for (let py = 0; py < H; py++) {
    const tLo = Math.max(0, (py - 0.5) / (H - 1));
    const tHi = Math.min(1, (py + 0.5) / (H - 1));
    const fHigh = Math.exp(logFMax + tLo * (logFMin - logFMax));
    const fLow = Math.exp(logFMax + tHi * (logFMin - logFMax));
    const binLow = Math.max(0, Math.floor(fLow / binHz));
    let binHigh = Math.min(maxBin, Math.ceil(fHigh / binHz));
    if (binHigh < binLow + 1) binHigh = Math.min(maxBin, binLow + 1);
    low[py] = binLow;
    high[py] = binHigh;
  }
  return { low, high };
}

export function freqToY(f: number, H: number, fMax: number): number {
  const logFMin = Math.log(F_MIN);
  const logFMax = Math.log(fMax);
  return ((logFMax - Math.log(f)) / (logFMax - logFMin)) * H;
}

export function formatHz(f: number): string {
  return f >= 1000 ? `${f / 1000}k` : `${f}`;
}

export function maxFrequency(sampleRate: number): number {
  return Math.min(F_MAX, sampleRate / 2);
}

/** Pass 1: the loudest bin under each canvas row, mapped through the colour curve. */
export function computeRowNorms(
  data: ArrayLike<number>,
  lutLow: ArrayLike<number>,
  lutHigh: ArrayLike<number>,
  H: number,
  out: Float32Array,
): void {
  for (let py = 0; py < H; py++) {
    let maxDb = -Infinity;
    for (let b = lutLow[py]; b <= lutHigh[py]; b++) {
      if (data[b] > maxDb) maxDb = data[b];
    }
    out[py] = dbToCurvedNorm(maxDb);
  }
}

/** Pass 2: `shift` identical RGBA columns, one pixel per row coloured from the normalised level. */
export function writeColumnPixels(
  norms: ArrayLike<number>,
  H: number,
  shift: number,
  colormap: ArrayLike<number>,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(shift * H * 4);
  for (let py = 0; py < H; py++) {
    const ci = Math.min(255, Math.floor(norms[py] * 255));
    for (let s = 0; s < shift; s++) {
      const base = (py * shift + s) * 4;
      out[base] = colormap[ci * 3];
      out[base + 1] = colormap[ci * 3 + 1];
      out[base + 2] = colormap[ci * 3 + 2];
      out[base + 3] = 255;
    }
  }
  return out;
}

/** Columns to scroll this frame, carrying the fractional remainder to the next one. */
export function nextScrollShift(accum: number, rollW: number): { shift: number; accum: number } {
  const total = accum + (rollW * CAPTURE_INTERVAL_MS) / (WINDOW_S * 1000);
  const shift = Math.max(1, Math.floor(total));
  return { shift, accum: total - shift };
}

export interface StaticWindow {
  srcColStart: number;
  srcColEnd: number;
  destX: number;
  destW: number;
}

/** Which columns of a precomputed spectrogram are visible around `currentTime`, and where they land. */
export function staticWindowGeometry(
  currentTime: number,
  hopTime: number,
  cols: number,
  rollW: number,
): StaticWindow | null {
  const t0 = currentTime - WINDOW_S / 2;
  const t1 = currentTime + WINDOW_S / 2;
  const pxPerSec = rollW / WINDOW_S;
  const colF0 = t0 / hopTime;
  const colF1 = t1 / hopTime;
  const srcColStart = Math.max(0, colF0);
  const srcColEnd = Math.min(cols, colF1);
  if (srcColEnd <= srcColStart) return null;
  return {
    srcColStart,
    srcColEnd,
    destX: AXIS_W + (srcColStart - colF0) * hopTime * pxPerSec,
    destW: (srcColEnd - srcColStart) * hopTime * pxPerSec,
  };
}

/** Canvas rows of the detected formants that fall inside the picture. */
export function formantTickYs(
  formants: { f1: number | null; f2: number | null; f3: number | null },
  H: number,
  sampleRate: number,
): number[] {
  const fMax = maxFrequency(sampleRate);
  const ys: number[] = [];
  for (const f of [formants.f1, formants.f2, formants.f3]) {
    if (f === null) continue;
    const y = freqToY(f, H, fMax);
    if (y < 0 || y > H) continue;
    ys.push(y);
  }
  return ys;
}

export interface FreqAxisTick {
  f: number;
  y: number;
  anchor: boolean;
}

export function freqAxisTicks(H: number, fMax: number): FreqAxisTick[] {
  const ticks: FreqAxisTick[] = [];
  for (const f of FREQ_TICKS) {
    if (f > fMax || f === 20000) continue;
    const y = freqToY(f, H, fMax);
    if (y < 4 || y > H - 4) continue;
    ticks.push({ f, y, anchor: f === 1000 || f === 5000 });
  }
  return ticks;
}

export function gridLineYs(H: number, fMax: number): number[] {
  const ys: number[] = [];
  for (const f of GRID_FREQS) {
    if (f > fMax) continue;
    const y = freqToY(f, H, fMax);
    if (y < 0 || y > H) continue;
    ys.push(y);
  }
  return ys;
}

export interface LegendTick {
  db: number;
  y: number;
  isEdge: boolean;
}

export function legendTicks(barTop: number, barH: number): LegendTick[] {
  return LEGEND_TICKS.map((db) => ({
    db,
    y: barTop + (1 - (db - MIN_DB) / (MAX_DB - MIN_DB)) * barH,
    isEdge: db === MAX_DB || db === MIN_DB,
  }));
}
