import { describe, it, expect } from "vitest";
import {
  avgCentsDeviation,
  centsDeviation,
  computeTimingDeviations,
  dynamicsAtTime,
  frequencyToNoteName,
  pitchAtTime,
} from "./analysisUtils";
import type { DynamicsPoint, PitchPoint } from "../lib/types";

const pp = (time: number, frequency = 440, confidence = 1): PitchPoint => ({ time, frequency, confidence });

describe("pitchAtTime", () => {
  const data = [pp(0), pp(1), pp(2), pp(4)];

  it("returns null for empty data", () => expect(pitchAtTime([], 1)).toBeNull());
  it("returns the exact match", () => expect(pitchAtTime(data, 2)?.time).toBe(2));
  it("returns the nearest neighbour on either side", () => {
    expect(pitchAtTime(data, 1.4)?.time).toBe(1);
    expect(pitchAtTime(data, 1.6)?.time).toBe(2);
    expect(pitchAtTime(data, 3.2)?.time).toBe(4);
    expect(pitchAtTime(data, 2.9)?.time).toBe(2);
  });
  it("clamps before the first and after the last point", () => {
    expect(pitchAtTime(data, -5)?.time).toBe(0);
    expect(pitchAtTime(data, 99)?.time).toBe(4);
  });
  it("works for a single point", () => expect(pitchAtTime([pp(3)], 100)?.time).toBe(3));
  it("agrees with a linear scan on a dense series", () => {
    const dense = Array.from({ length: 200 }, (_, i) => pp(i * 0.0232));
    for (let t = -0.1; t < 5; t += 0.0137) {
      let best = dense[0];
      for (const p of dense) if (Math.abs(p.time - t) < Math.abs(best.time - t)) best = p;
      expect(Math.abs(pitchAtTime(dense, t)!.time - t)).toBeCloseTo(Math.abs(best.time - t), 12);
    }
  });
});

describe("dynamicsAtTime", () => {
  const dyn: DynamicsPoint[] = [{ time: 0, rms: 0.1 }, { time: 1, rms: 0.2 }, { time: 2, rms: 0.3 }];

  it("returns null for empty data", () => expect(dynamicsAtTime([], 0)).toBeNull());
  it("returns the exact match", () => expect(dynamicsAtTime(dyn, 1)?.rms).toBe(0.2));
  it("clamps to the ends", () => {
    expect(dynamicsAtTime(dyn, -1)?.rms).toBe(0.1);
    expect(dynamicsAtTime(dyn, 10)?.rms).toBe(0.3);
  });
  it("returns the nearest point, not the next one, between samples (as documented)", () => {
    expect(dynamicsAtTime(dyn, 0.2)?.time).toBe(0);
    expect(dynamicsAtTime(dyn, 0.8)?.time).toBe(1);
    expect(dynamicsAtTime(dyn, 1.4)?.time).toBe(1);
  });
});

describe("centsDeviation", () => {
  it("is zero for equal frequencies", () => expect(centsDeviation(440, 440)).toBe(0));
  it("is +1200 an octave up and -1200 an octave down", () => {
    expect(centsDeviation(880, 440)).toBeCloseTo(1200, 9);
    expect(centsDeviation(220, 440)).toBeCloseTo(-1200, 9);
  });
  it("is +100 for one semitone sharp", () => {
    expect(centsDeviation(440 * Math.pow(2, 1 / 12), 440)).toBeCloseTo(100, 9);
  });
  it.each([[0, 440], [440, 0], [-1, 440], [440, -3]])("is 0 for non-positive input (%s, %s)", (f, r) => {
    expect(centsDeviation(f, r)).toBe(0);
  });
});

describe("computeTimingDeviations", () => {
  it("returns nothing when there are no song onsets", () => {
    expect(computeTimingDeviations([], [1, 2])).toEqual([]);
  });

  it("returns nothing when there are no take onsets", () => {
    expect(computeTimingDeviations([1, 2], [])).toEqual([]);
  });

  it("measures signed deltas in whole milliseconds (late positive)", () => {
    const [d] = computeTimingDeviations([1.0], [1.0234]);
    expect(d).toEqual({ noteIndex: 0, referenceTime: 1.0, userTime: 1.0234, deltaMs: 23 });
    const [early] = computeTimingDeviations([1.0], [0.9]);
    expect(early.deltaMs).toBe(-100);
  });

  it("matches each song onset to its nearest take onset", () => {
    const out = computeTimingDeviations([1, 2, 3], [1.1, 1.95, 3.2]);
    expect(out.map((d) => d.deltaMs)).toEqual([100, -50, 200]);
    expect(out.map((d) => d.noteIndex)).toEqual([0, 1, 2]);
  });

  it("skips song onsets with no take onset within 500 ms and keeps the original note index", () => {
    const out = computeTimingDeviations([1, 2, 3], [1.05, 3.01]);
    expect(out.map((d) => d.noteIndex)).toEqual([0, 2]);
  });

  it("does not match at exactly the 500 ms boundary", () => {
    expect(computeTimingDeviations([1], [1.5])).toEqual([]);
    expect(computeTimingDeviations([1], [1.499])).toHaveLength(1);
  });

  it("allows one take onset to be matched by two song onsets (no exclusivity)", () => {
    const out = computeTimingDeviations([1, 1.2], [1.1]);
    expect(out).toHaveLength(2);
  });

  it("prefers the closer of two candidates", () => {
    const [d] = computeTimingDeviations([1], [0.8, 1.05]);
    expect(d.userTime).toBe(1.05);
  });
});

describe("avgCentsDeviation", () => {
  it("is 0 when either series is empty", () => {
    expect(avgCentsDeviation([], [pp(0)])).toBe(0);
    expect(avgCentsDeviation([pp(0)], [])).toBe(0);
  });

  it("averages signed deviations against the nearest song point", () => {
    const song = [pp(0, 440), pp(1, 440)];
    const take = [pp(0, 440 * Math.pow(2, 50 / 1200)), pp(1, 440 * Math.pow(2, -10 / 1200))];
    expect(avgCentsDeviation(take, song)).toBeCloseTo(20, 6);
  });

  it("ignores low-confidence take and song frames", () => {
    const song = [pp(0, 440, 1), pp(1, 440, 0.1)];
    const take = [pp(0, 440 * Math.pow(2, 100 / 1200), 1), pp(1, 880, 1), pp(2, 880, 0.2)];
    expect(avgCentsDeviation(take, song)).toBeCloseTo(100, 6);
  });

  it("is 0 when every frame is filtered out", () => {
    expect(avgCentsDeviation([pp(0, 440, 0.1)], [pp(0, 440, 1)])).toBe(0);
  });

  it("respects a custom confidence threshold", () => {
    const song = [pp(0, 440, 0.6)];
    const take = [pp(0, 466.1637615, 0.6)];
    expect(avgCentsDeviation(take, song, 0.5)).toBeCloseTo(100, 4);
    expect(avgCentsDeviation(take, song, 0.9)).toBe(0);
  });
});

describe("frequencyToNoteName", () => {
  it("returns a dash for non-positive frequencies", () => {
    expect(frequencyToNoteName(0)).toEqual({ name: "—", cents: 0 });
    expect(frequencyToNoteName(-5)).toEqual({ name: "—", cents: 0 });
  });
  it("names A4, C4 and a flat G", () => {
    expect(frequencyToNoteName(440)).toEqual({ name: "A4", cents: 0 });
    expect(frequencyToNoteName(261.6256).name).toBe("C4");
    expect(frequencyToNoteName(392 * Math.pow(2, -30 / 1200))).toEqual({ name: "G4", cents: -30 });
  });
  it("stays well-formed below MIDI 0", () => {
    expect(frequencyToNoteName(5).name).toMatch(/^[A-G]#?-?\d+$/);
  });
});
