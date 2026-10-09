import { describe, it, expect } from "vitest";
import { analyseHarmonics } from "./harmonicEnvelope";
import { VOWELS, synthVowel, whiteNoise } from "./__fixtures__/synthVowel";

describe("analyseHarmonics: f0 detection", () => {
  const pitches = [110, 196.3, 261.6, 415.3, 523.3, 880];

  it.each(pitches)("recovers f0 = %s Hz within 1% for every vowel", (f0) => {
    for (const [name, formants] of Object.entries(VOWELS)) {
      const x = synthVowel(f0, formants, { seed: 3 + name.charCodeAt(0) });
      const result = analyseHarmonics(x, 44100);
      expect(result, `${name} @ ${f0}`).not.toBeNull();
      expect(Math.abs(result!.f0 - f0) / f0, `${name} @ ${f0}: got ${result!.f0}`).toBeLessThan(0.01);
    }
  });

  it("works at 48 kHz", () => {
    const x = synthVowel(220, VOWELS.a, { sampleRate: 48000 });
    const result = analyseHarmonics(x, 48000);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.f0 - 220) / 220).toBeLessThan(0.01);
  });

  it("tracks a non-integer pitch with many harmonics (error would accumulate otherwise)", () => {
    const x = synthVowel(123.4, VOWELS.o);
    const result = analyseHarmonics(x, 44100);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.f0 - 123.4)).toBeLessThan(0.6);
  });

  it("returns null for silence", () => {
    expect(analyseHarmonics(new Float32Array(8192), 44100)).toBeNull();
  });

  it("returns null for white noise (no harmonic structure)", () => {
    for (const seed of [1, 2, 3, 4]) {
      expect(analyseHarmonics(whiteNoise(8192, seed), 44100), `seed ${seed}`).toBeNull();
    }
  });

  it("returns null for a buffer too short to resolve harmonics", () => {
    expect(analyseHarmonics(synthVowel(200, VOWELS.a, { length: 512 }), 44100)).toBeNull();
  });
});

describe("analyseHarmonics: low sample rates", () => {
  it("never reports harmonics at or above Nyquist", () => {
    const sampleRate = 8000;
    const x = synthVowel(200, VOWELS.a, { sampleRate });
    const result = analyseHarmonics(x, sampleRate);
    expect(result).not.toBeNull();
    expect(Math.max(...result!.freqs)).toBeLessThan(sampleRate / 2);
    expect(result!.db.every(Number.isFinite)).toBe(true);
    expect(Math.min(...result!.db)).toBeGreaterThan(-200);
  });
});

describe("analyseHarmonics: envelope points", () => {
  it("returns ascending points near multiples of f0, with finite levels", () => {
    const f0 = 220;
    const result = analyseHarmonics(synthVowel(f0, VOWELS.a), 44100)!;
    expect(result.freqs.length).toBeGreaterThanOrEqual(8);
    expect(result.freqs.length).toBe(result.db.length);
    result.freqs.forEach((f, i) => {
      expect(Math.abs(f - (i + 1) * f0) / ((i + 1) * f0)).toBeLessThan(0.02);
      expect(Number.isFinite(result.db[i])).toBe(true);
      if (i > 0) expect(f).toBeGreaterThan(result.freqs[i - 1]);
    });
  });

  it("peaks near F1 for a vowel with a clear first formant", () => {
    // /a/ has F1 = 730 Hz; at f0 = 146 Hz harmonic 5 (730 Hz) sits on it.
    const result = analyseHarmonics(synthVowel(146, VOWELS.a), 44100)!;
    const low = result.db.slice(0, 12);
    const peak = low.indexOf(Math.max(...low));
    expect(result.freqs[peak]).toBeGreaterThan(550);
    expect(result.freqs[peak]).toBeLessThan(950);
  });
});
