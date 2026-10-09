import { describe, it, expect } from "vitest";
import { estimateFormants, type FormantEstimate } from "./formants";
import { VOWELS, synthVowel, whiteNoise, withinTolerance } from "./__fixtures__/synthVowel";

const SEEDS = [1, 2, 3];

function runPitch(f0: number, sampleRate = 44100) {
  const results: { vowel: string; truth: number[]; est: FormantEstimate }[] = [];
  for (const [vowel, truth] of Object.entries(VOWELS)) {
    for (const seed of SEEDS) {
      const x = synthVowel(f0, truth, { sampleRate, seed: seed * 7 + vowel.charCodeAt(0) });
      results.push({ vowel, truth, est: estimateFormants(x, sampleRate) });
    }
  }
  return results;
}

function hitRate(rs: ReturnType<typeof runPitch>, slot: 0 | 1 | 2): number {
  const key = (["f1", "f2", "f3"] as const)[slot];
  return rs.filter((r) => withinTolerance(r.est[key], r.truth[slot])).length / rs.length;
}

function meanAbsError(rs: ReturnType<typeof runPitch>, slot: 0 | 1 | 2): number {
  const key = (["f1", "f2", "f3"] as const)[slot];
  return rs.reduce((sum, r) => sum + Math.abs((r.est[key] ?? 0) - r.truth[slot]), 0) / rs.length;
}

describe("estimateFormants accuracy on synthetic vowels with known formants", () => {
  it.each([100, 150, 200, 250, 300])("F2 and F3 within 10% in >= 90% of frames at f0 = %s Hz", (f0) => {
    const rs = runPitch(f0);
    expect(hitRate(rs, 1), `F2 @ ${f0}`).toBeGreaterThanOrEqual(0.9);
    expect(hitRate(rs, 2), `F3 @ ${f0}`).toBeGreaterThanOrEqual(0.9);
  });

  it.each([100, 150, 200, 250, 300])("F1 within tolerance in >= 50% of frames at f0 = %s Hz", (f0) => {
    expect(hitRate(runPitch(f0), 0)).toBeGreaterThanOrEqual(0.5);
  });

  it("no longer loses F3 at 300 Hz (plain LPC averaged ~700 Hz error here)", () => {
    expect(meanAbsError(runPitch(300), 2)).toBeLessThan(100);
  });

  it.each([350, 400])("F1 stays usable at f0 = %s Hz (mean error <= 90 Hz)", (f0) => {
    expect(meanAbsError(runPitch(f0), 0)).toBeLessThanOrEqual(90);
  });

  it("holds the same accuracy at 48 kHz", () => {
    const rs = runPitch(200, 48000);
    expect(hitRate(rs, 1)).toBeGreaterThanOrEqual(0.9);
    expect(hitRate(rs, 2)).toBeGreaterThanOrEqual(0.9);
  });
});

describe("estimateFormants invariants", () => {
  it("always returns formants in ascending order", () => {
    for (const f0 of [110, 180, 260, 340, 450, 620]) {
      for (const { est } of runPitch(f0)) {
        const present = [est.f1, est.f2, est.f3].filter((v): v is number => v !== null);
        expect(present).toEqual([...present].sort((a, b) => a - b));
      }
    }
  });

  it("returns only null slots for silence", () => {
    expect(estimateFormants(new Float32Array(8192), 44100)).toEqual({ f1: null, f2: null, f3: null });
  });

  it("does not throw on noise, tiny buffers or odd lengths", () => {
    expect(() => estimateFormants(whiteNoise(8192), 44100)).not.toThrow();
    expect(() => estimateFormants(whiteNoise(300), 44100)).not.toThrow();
    expect(() => estimateFormants(synthVowel(200, VOWELS.a, { length: 4410 }), 44100)).not.toThrow();
    expect(() => estimateFormants(new Float32Array(0), 44100)).not.toThrow();
  });

  it("keeps formants finite and inside the allowed band", () => {
    for (const { est } of runPitch(260)) {
      for (const v of [est.f1, est.f2, est.f3]) {
        if (v !== null) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThan(80);
          expect(v).toBeLessThan(4100);
        }
      }
    }
  });

  it("is deterministic", () => {
    const x = synthVowel(220, VOWELS.e);
    expect(estimateFormants(x, 44100)).toEqual(estimateFormants(x, 44100));
  });

  it("smooths towards the previous estimate (continuity tracking still works)", () => {
    const x = synthVowel(220, VOWELS.a);
    const first = estimateFormants(x, 44100);
    const prev: FormantEstimate = { f1: first.f1! + 80, f2: first.f2! + 80, f3: first.f3! + 80 };
    const second = estimateFormants(x, 44100, prev);
    for (const k of ["f1", "f2", "f3"] as const) {
      expect(second[k]!).toBeGreaterThan(first[k]!);
      expect(second[k]!).toBeLessThan(prev[k]!);
    }
  });
});

describe("estimateFormants performance", () => {
  it("stays well inside a per-frame budget (< 8 ms average)", () => {
    const x = synthVowel(300, VOWELS.a);
    estimateFormants(x, 44100);
    const runs = 60;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) estimateFormants(x, 44100);
    expect((performance.now() - t0) / runs).toBeLessThan(8);
  });
});
