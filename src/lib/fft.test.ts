import { describe, it, expect } from "vitest";
import { fft, computeMagnitudeSpectrumDb } from "./fft";

function sine(freq: number, sampleRate: number, length: number, amplitude = 1): Float32Array {
  const x = new Float32Array(length);
  for (let i = 0; i < length; i++) x[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return x;
}

function argmax(a: Float32Array): number {
  let best = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[best]) best = i;
  return best;
}

describe("fft", () => {
  it("transforms an impulse into a flat spectrum", () => {
    const re = new Float64Array(16);
    const im = new Float64Array(16);
    re[0] = 1;
    fft(re, im);
    for (let k = 0; k < 16; k++) {
      expect(re[k]).toBeCloseTo(1, 12);
      expect(im[k]).toBeCloseTo(0, 12);
    }
  });

  it("puts a DC signal entirely in bin 0", () => {
    const re = new Float64Array(8).fill(1);
    const im = new Float64Array(8);
    fft(re, im);
    expect(re[0]).toBeCloseTo(8, 12);
    for (let k = 1; k < 8; k++) {
      expect(Math.hypot(re[k], im[k])).toBeLessThan(1e-12);
    }
  });

  it("matches a naive DFT on a random signal", () => {
    const n = 32;
    let s = 12345;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const x = Array.from({ length: n }, rnd);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    fft(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += x[t] * Math.cos(a);
        si += x[t] * Math.sin(a);
      }
      expect(re[k]).toBeCloseTo(sr, 9);
      expect(im[k]).toBeCloseTo(si, 9);
    }
  });

  it("preserves energy (Parseval)", () => {
    const n = 64;
    const re = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.37) + 0.5 * Math.cos(i * 1.9);
    const timeEnergy = re.reduce((a, v) => a + v * v, 0);
    const im = new Float64Array(n);
    fft(re, im);
    let freqEnergy = 0;
    for (let k = 0; k < n; k++) freqEnergy += re[k] * re[k] + im[k] * im[k];
    expect(freqEnergy / n).toBeCloseTo(timeEnergy, 9);
  });

  it("is a no-op size for a single sample", () => {
    const re = Float64Array.of(3);
    const im = Float64Array.of(0);
    fft(re, im);
    expect(re[0]).toBe(3);
  });
});

describe("computeMagnitudeSpectrumDb", () => {
  it("returns fftSize/2 bins", () => {
    expect(computeMagnitudeSpectrumDb(new Float32Array(1024), 1024)).toHaveLength(512);
  });

  it("peaks at the bin of a bin-centred tone", () => {
    const sr = 8192;
    const size = 4096;
    const bin = 300;
    const spectrum = computeMagnitudeSpectrumDb(sine((bin * sr) / size, sr, size), size);
    expect(argmax(spectrum)).toBe(bin);
  });

  it("reads a full-scale tone near the Web Audio level of -13.6 dB (Blackman coherent gain 0.42 / 2)", () => {
    const sr = 8192;
    const size = 4096;
    const spectrum = computeMagnitudeSpectrumDb(sine((300 * sr) / size, sr, size), size);
    expect(spectrum[300]).toBeGreaterThan(-15);
    expect(spectrum[300]).toBeLessThan(-12);
  });

  it("scales by 6 dB per amplitude halving", () => {
    const sr = 8192;
    const size = 2048;
    const f = (200 * sr) / size;
    const loud = computeMagnitudeSpectrumDb(sine(f, sr, size, 1), size)[200];
    const quiet = computeMagnitudeSpectrumDb(sine(f, sr, size, 0.5), size)[200];
    expect(loud - quiet).toBeCloseTo(6.02, 1);
  });

  it("floors silence at the 1e-12 epsilon (-240 dB) instead of -Infinity", () => {
    const spectrum = computeMagnitudeSpectrumDb(new Float32Array(512), 512);
    for (const v of spectrum) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeCloseTo(-240, 3);
    }
  });

  it("zero-pads a buffer shorter than fftSize and ignores samples beyond it", () => {
    const size = 1024;
    const short = sine(500, 8000, 300);
    const padded = new Float32Array(size);
    padded.set(short);
    expect(Array.from(computeMagnitudeSpectrumDb(short, size))).toEqual(Array.from(computeMagnitudeSpectrumDb(padded, size)));

    const long = sine(500, 8000, size * 2);
    const truncated = long.slice(0, size);
    expect(Array.from(computeMagnitudeSpectrumDb(long, size))).toEqual(Array.from(computeMagnitudeSpectrumDb(truncated, size)));
  });

  it("applies exactly the symmetric Blackman window (0.42 / 0.5 / 0.08)", () => {
    const n = 64;
    const ones = new Float32Array(n).fill(1);
    const got = computeMagnitudeSpectrumDb(ones, n);
    const window = Array.from({ length: n }, (_, i) =>
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1)));
    for (const k of [0, 1, 2, 3, 5, 9]) {
      let re = 0;
      let im = 0;
      for (let t = 0; t < n; t++) {
        re += window[t] * Math.cos((2 * Math.PI * k * t) / n);
        im -= window[t] * Math.sin((2 * Math.PI * k * t) / n);
      }
      const expected = 20 * Math.log10(Math.hypot(re, im) / n + 1e-12);
      expect(got[k]).toBeCloseTo(expected, 3);
    }
  });

  it("is deterministic across calls (cached window and bit-reversal tables)", () => {
    const x = sine(440, 44100, 2048);
    expect(Array.from(computeMagnitudeSpectrumDb(x, 2048))).toEqual(Array.from(computeMagnitudeSpectrumDb(x, 2048)));
  });
});
