import { describe, it, expect } from "vitest";
import { frequencyToMidi } from "@giamat90/mps-core/music";
import {
  CONF_MIN,
  GAP_S,
  N_NOTES,
  PIANO_W,
  WINDOW_S,
  formatClock,
  isBlack,
  keyFill,
  keyLabelColor,
  midiFromY,
  midiToY,
  noteAt,
  noteH,
  onRoll,
  punchSpan,
  ribbonSegments,
  rulerInterval,
  rulerTickTimes,
  visibleMidiRange,
  type PianoColors,
} from "./pianoRollGeometry";
import type { PitchPoint } from "./types";

const colors: PianoColors = { song: "S", songAlt: "A", take: "T", live: "L" };
const pt = (time: number, frequency: number, confidence = 0.9): PitchPoint => ({ time, frequency, confidence });
const A4 = 440;

describe("note lanes", () => {
  it("makes N_NOTES lanes fill the height", () => {
    expect(noteH(400) * N_NOTES).toBeCloseTo(400, 9);
  });

  it("puts the top note in the first lane and the bottom one in the last", () => {
    const midiMin = 40;
    expect(midiToY(midiMin + N_NOTES - 1, 400, midiMin)).toBeCloseTo(noteH(400) / 2, 9);
    expect(midiToY(midiMin, 400, midiMin)).toBeCloseTo(400 - noteH(400) / 2, 9);
  });

  it("midiFromY inverts midiToY for every visible note, also on a fractional window", () => {
    for (const midiMin of [40, 45.37]) {
      for (let m = Math.ceil(midiMin); m < midiMin + N_NOTES - 1; m++) {
        expect(midiFromY(midiToY(m, 400, midiMin), 400, midiMin)).toBe(m);
      }
    }
  });

  it("knows the black keys, also below zero", () => {
    expect([60, 61, 62, 63, 64, 65, 66].map(isBlack)).toEqual([false, true, false, true, false, false, true]);
    expect(isBlack(-11)).toBe(true);
  });

  it("includes one lane of margin on each side", () => {
    expect(visibleMidiRange(40)).toEqual({ first: 39, last: 40 + N_NOTES });
    expect(visibleMidiRange(40.5)).toEqual({ first: 39, last: 41 + N_NOTES });
  });
});

describe("ribbonSegments", () => {
  const timeToX = (t: number) => t * 10;
  const run = (points: PitchPoint[]) => ribbonSegments(points, 0, 10, 400, 40, timeToX);

  it("joins consecutive voiced points into one polyline", () => {
    const segs = run([pt(0, A4), pt(0.02, A4), pt(0.04, A4)]);
    expect(segs).toHaveLength(1);
    expect(segs[0].map((p) => p.x)).toEqual([0, 0.2, 0.4]);
    expect(segs[0][0].y).toBeCloseTo(midiToY(69, 400, 40), 9);
  });

  it("starts a new polyline after a time gap longer than GAP_S", () => {
    expect(run([pt(0, A4), pt(GAP_S + 0.02, A4)])).toHaveLength(2);
    expect(run([pt(0, A4), pt(GAP_S - 0.01, A4)])).toHaveLength(1);
  });

  it("breaks at unvoiced, low-confidence, off-window and off-range points", () => {
    const segs = run([
      pt(0, A4), pt(0.02, 0), pt(0.04, A4),
      pt(0.06, A4, CONF_MIN - 0.01), pt(0.08, A4),
      pt(0.1, 10), pt(0.12, A4),
      pt(-1, A4), pt(0.14, A4),
      pt(20, A4),
    ]);
    expect(segs.map((s) => s.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it("keeps points slightly outside the window so the line reaches the edges", () => {
    expect(ribbonSegments([pt(-0.05, A4), pt(10.05, A4)], 0, 10, 400, 40, timeToX).flat()).toHaveLength(2);
  });

  it("returns nothing for no points", () => {
    expect(run([])).toEqual([]);
  });

  it("agrees with frequencyToMidi for the lane", () => {
    const f = 261.63;
    const segs = run([pt(0, f)]);
    expect(segs[0][0].y).toBeCloseTo(midiToY(frequencyToMidi(f), 400, 40), 9);
  });
});

describe("noteAt", () => {
  it("names the average note of the points around the time", () => {
    expect(noteAt([pt(5, 440), pt(5.02, 440)], 5.01)).toBe("A4");
    expect(noteAt([pt(5, 261.63)], 5)).toBe("C4");
  });

  it("ignores far, weak and unvoiced points", () => {
    expect(noteAt([pt(5, 440)], 5.1)).toBeNull();
    expect(noteAt([pt(5, 440, 0.1)], 5)).toBeNull();
    expect(noteAt([pt(5, 0)], 5)).toBeNull();
    expect(noteAt([], 5)).toBeNull();
  });
});

describe("ruler", () => {
  it("picks the smallest interval that keeps ticks readable", () => {
    expect(rulerInterval(100000)).toBe(0.25);
    expect(rulerInterval(600)).toBe(1);
    expect(rulerInterval(1)).toBe(5);
    expect(rulerInterval(0)).toBe(5);
  });

  it("lists tick times from the first multiple inside the window", () => {
    expect(rulerTickTimes(0.3, 1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rulerTickTimes(-4, 2)).toEqual([-4, -2, 0, 2, 4]);
    expect(rulerTickTimes(10, 5)).toEqual([10, 15]);
    expect(rulerTickTimes(0, 1)).toHaveLength(WINDOW_S + 1);
  });

  it("formats clock labels and never goes negative", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(75.9)).toBe("1:15");
    expect(formatClock(-3)).toBe("0:00");
  });

  it("clips the punch span to the roll", () => {
    expect(punchSpan(10, 100, 640)).toEqual({ from: PIANO_W, to: 100 });
    expect(punchSpan(100, 900, 640)).toEqual({ from: 100, to: 640 });
    expect(punchSpan(700, 800, 640)).toBeNull();
    expect(punchSpan(0, 20, 640)).toBeNull();
    expect(onRoll(PIANO_W, 640)).toBe(true);
    expect(onRoll(PIANO_W - 1, 640)).toBe(false);
  });
});

describe("piano strip colours", () => {
  const none = { song: false, take: false, live: false, alt: false };

  it("prefers live over take over song over the second voice", () => {
    expect(keyFill(false, { song: true, take: true, live: true, alt: true }, colors)).toBe("L");
    expect(keyFill(false, { ...none, take: true, song: true }, colors)).toBe("T");
    expect(keyFill(false, { ...none, song: true, alt: true }, colors)).toBe("S");
    expect(keyFill(false, { ...none, alt: true }, colors)).toBe("A");
  });

  it("falls back to the plain key colour", () => {
    expect(keyFill(false, none, colors)).toBe("#c8c8c8");
    expect(keyFill(true, none, colors)).toBe("#1c1c1c");
  });

  it("picks a readable label colour", () => {
    expect(keyLabelColor({ ...none, song: true })).toBe("#fff");
    expect(keyLabelColor({ ...none, alt: true })).toBe("#123");
    expect(keyLabelColor(none)).toBe("#444");
  });
});
