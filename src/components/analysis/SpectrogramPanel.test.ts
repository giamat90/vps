import { describe, it, expect, vi } from "vitest";

vi.mock("../../stores/player", () => ({ getMicAnalyser: vi.fn(), getEngine: vi.fn(), usePlayerStore: vi.fn() }));
vi.mock("../../stores/exercise", () => ({ useExerciseStore: vi.fn() }));

import { F_MAX, F_MIN, buildFreqBinLut, dbToCurvedNorm, freqToY } from "./SpectrogramPanel";

describe("dbToCurvedNorm", () => {
  it("is black at and below the -85 dB floor", () => {
    expect(dbToCurvedNorm(-85)).toBe(0);
    expect(dbToCurvedNorm(-200)).toBe(0);
    expect(dbToCurvedNorm(-Infinity)).toBe(0);
  });

  it("saturates at and above the -20 dB ceiling", () => {
    expect(dbToCurvedNorm(-20)).toBe(1);
    expect(dbToCurvedNorm(0)).toBe(1);
  });

  it("stays within [0, 1] and rises monotonically above the -80 dB gate", () => {
    let prev = -1;
    for (let db = -80; db <= 0; db += 0.5) {
      const v = dbToCurvedNorm(db);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("gates levels below the 15 % knee harder than a plain gamma curve would", () => {
    const db = -85 + 0.1 * 65;
    expect(dbToCurvedNorm(db)).toBeLessThan(Math.pow(0.1, 0.38));
  });

  it("applies a gamma below 1 so mid-level peaks stay bright", () => {
    expect(dbToCurvedNorm(-52.5)).toBeGreaterThan(0.5);
  });
});

describe("freqToY", () => {
  it("puts the top frequency at y = 0 and F_MIN at the bottom", () => {
    expect(freqToY(F_MAX, 400, F_MAX)).toBeCloseTo(0, 9);
    expect(freqToY(F_MIN, 400, F_MAX)).toBeCloseTo(400, 9);
  });

  it("is centred on the geometric mean", () => {
    expect(freqToY(Math.sqrt(F_MIN * F_MAX), 400, F_MAX)).toBeCloseTo(200, 6);
  });

  it("decreases as frequency rises", () => {
    expect(freqToY(100, 400, F_MAX)).toBeGreaterThan(freqToY(1000, 400, F_MAX));
  });
});

describe("buildFreqBinLut", () => {
  const H = 160;
  const fft = 8192;
  const sr = 44100;
  const { low, high } = buildFreqBinLut(H, fft, sr);

  it("returns one inclusive bin range per row", () => {
    expect(low).toHaveLength(H);
    expect(high).toHaveLength(H);
  });

  it("never produces an inverted range or one past the last FFT bin", () => {
    for (let r = 0; r < H; r++) {
      expect(low[r]).toBeLessThanOrEqual(high[r]);
      expect(high[r]).toBeLessThanOrEqual(fft / 2 - 1);
    }
  });

  it("maps row 0 (top) to the highest frequencies and the last row to the lowest", () => {
    expect(low[0]).toBeGreaterThan(low[H - 1]);
    expect(low[H - 1] * (sr / fft)).toBeLessThan(40);
  });

  it("is non-increasing from top to bottom", () => {
    for (let r = 1; r < H; r++) expect(low[r]).toBeLessThanOrEqual(low[r - 1]);
  });

  it("caps the top at Nyquist for low sample rates", () => {
    const lut = buildFreqBinLut(64, 4096, 16000);
    expect(lut.high[0] * (16000 / 4096)).toBeLessThanOrEqual(8000 + 16000 / 4096);
  });

  it("some row covers the FFT bin of 1 kHz", () => {
    const bin = Math.round(1000 / (sr / fft));
    const rows = [...Array(H).keys()].filter((r) => low[r] <= bin && bin <= high[r]);
    expect(rows.length).toBeGreaterThan(0);
  });
});
