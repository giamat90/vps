import { describe, it, expect } from "vitest";
import { refineF0 } from "./pitchRefine";
import { VOWELS, synthVowel, whiteNoise } from "./__fixtures__/synthVowel";

const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

describe("refineF0", () => {
  it.each([
    [110, 44100],
    [173, 44100],
    [220, 48000],
    [330, 44100],
    [440, 48000],
    [660, 44100],
  ])("lands within 10 cents of a steady %s Hz voice at %s Hz sampling, from a seed 3%% off either way", (f0, sr) => {
    const x = synthVowel(f0, VOWELS.a, { sampleRate: sr, length: 8192, seed: 9 });
    for (const seed of [f0 * 0.97, f0 * 1.03]) {
      const refined = refineF0(x, sr, seed);
      expect(refined, `${f0} Hz from ${seed.toFixed(0)}`).not.toBeNull();
      expect(Math.abs(cents(refined as number, f0))).toBeLessThan(10);
    }
  });

  it("does not jitter between neighbouring windows of one steady note", () => {
    const sr = 44100;
    const long = synthVowel(173, VOWELS.o, { sampleRate: sr, length: 16384, seed: 4 });
    const found: number[] = [];
    for (let offset = 0; offset <= 8192; offset += 1024) {
      const f = refineF0(long.subarray(offset, offset + 8192), sr, 170);
      expect(f).not.toBeNull();
      found.push(f as number);
    }
    expect(Math.abs(cents(Math.max(...found), Math.min(...found)))).toBeLessThan(10);
  });

  it("keeps the octave the seed chose", () => {
    const x = synthVowel(220, VOWELS.a, { length: 8192 });
    const refined = refineF0(x, 44100, 224) as number;
    expect(Math.abs(cents(refined, 220))).toBeLessThan(10);
  });

  it("gives up on noise, on silence and on a seed no window could hold", () => {
    expect(refineF0(whiteNoise(8192), 44100, 200)).toBeNull();
    expect(refineF0(new Float32Array(8192), 44100, 200)).toBeNull();
    expect(refineF0(synthVowel(200, VOWELS.a), 44100, 10)).toBeNull();
    expect(refineF0(synthVowel(200, VOWELS.a), 44100, 0)).toBeNull();
  });

  it("does not throw on tiny or empty buffers", () => {
    expect(() => refineF0(new Float32Array(0), 44100, 200)).not.toThrow();
    expect(() => refineF0(new Float32Array(100), 44100, 200)).not.toThrow();
  });
});
