import { describe, it, expect } from "vitest";
import {
  NOTE_NAMES,
  PIANO_ABS_MAX,
  PIANO_ABS_MIN,
  PIANO_WINDOW_DEFAULT_MIN,
  PIANO_WINDOW_SIZE,
  computePianoWindowTarget,
  frequencyToMidi,
  frequencyToNote,
  midiToFrequency,
  stepPianoWindow,
} from "./constants";

describe("midi <-> frequency", () => {
  it("anchors A4 = 440 Hz = MIDI 69", () => {
    expect(midiToFrequency(69)).toBe(440);
    expect(frequencyToMidi(440)).toBe(69);
  });

  it("doubles per octave", () => {
    expect(midiToFrequency(81)).toBeCloseTo(880, 9);
    expect(midiToFrequency(57)).toBeCloseTo(220, 9);
  });

  it("matches the reference value for middle C", () => {
    expect(midiToFrequency(60)).toBeCloseTo(261.6256, 3);
  });

  it("round-trips across the whole piano range", () => {
    for (let m = PIANO_ABS_MIN; m <= PIANO_ABS_MAX; m++) {
      expect(frequencyToMidi(midiToFrequency(m))).toBeCloseTo(m, 9);
    }
  });
});

describe("frequencyToNote", () => {
  it("names A4 with zero cents", () => expect(frequencyToNote(440)).toEqual({ note: "A4", cents: 0 }));
  it("names middle C as C4", () => expect(frequencyToNote(261.6256).note).toBe("C4"));
  it("rounds cents and reports the sign (sharp positive)", () => {
    const sharp = frequencyToNote(440 * Math.pow(2, 20 / 1200));
    expect(sharp).toEqual({ note: "A4", cents: 20 });
    const flat = frequencyToNote(440 * Math.pow(2, -20 / 1200));
    expect(flat).toEqual({ note: "A4", cents: -20 });
  });
  it("rolls over to the next note beyond 50 cents", () => {
    expect(frequencyToNote(440 * Math.pow(2, 60 / 1200)).note).toBe("A#4");
  });
  it("covers every note name", () => {
    const seen = new Set<string>();
    for (let m = 60; m < 72; m++) seen.add(frequencyToNote(midiToFrequency(m)).note.replace(/\d/g, ""));
    expect([...seen].sort()).toEqual([...NOTE_NAMES].sort());
  });
  it("uses a valid octave for C0 and C7", () => {
    expect(frequencyToNote(midiToFrequency(12)).note).toBe("C0");
    expect(frequencyToNote(midiToFrequency(96)).note).toBe("C7");
  });
  it("does not return 'undefined' for very low frequencies", () => {
    expect(frequencyToNote(4).note).not.toMatch(/undefined/);
  });
  it("names notes below MIDI 0 with a wrapped pitch class and a negative octave", () => {
    expect(frequencyToNote(midiToFrequency(-1)).note).toBe("B-2");
    expect(frequencyToNote(midiToFrequency(-12)).note).toBe("C-2");
    expect(frequencyToNote(midiToFrequency(-13)).note).toBe("B-3");
  });
});

describe("computePianoWindowTarget", () => {
  const defaultMin = PIANO_WINDOW_DEFAULT_MIN;

  it("holds position with no active note", () => {
    expect(computePianoWindowTarget(null, defaultMin)).toBe(defaultMin);
  });

  it("holds position while the note is inside the dead zone", () => {
    expect(computePianoWindowTarget(defaultMin + 20, defaultMin)).toBe(defaultMin);
  });

  it("shifts down when the note gets within the margin of the bottom edge", () => {
    expect(computePianoWindowTarget(defaultMin + 2, defaultMin)).toBe(defaultMin + 2 - 6);
  });

  it("shifts up when the note gets within the margin of the top edge", () => {
    const top = defaultMin + PIANO_WINDOW_SIZE - 1;
    const target = computePianoWindowTarget(top, defaultMin);
    expect(target).toBe(top - PIANO_WINDOW_SIZE + 1 + 6);
    expect(target).toBeGreaterThan(defaultMin);
  });

  it("keeps the active note inside the resulting window", () => {
    for (let midi = PIANO_ABS_MIN; midi <= PIANO_ABS_MAX; midi++) {
      const min = computePianoWindowTarget(midi, defaultMin);
      expect(midi).toBeGreaterThanOrEqual(min);
      expect(midi).toBeLessThanOrEqual(min + PIANO_WINDOW_SIZE - 1);
    }
  });

  it("clamps so the window never leaves C0–C7", () => {
    expect(computePianoWindowTarget(PIANO_ABS_MIN, PIANO_ABS_MIN)).toBe(PIANO_ABS_MIN);
    expect(computePianoWindowTarget(0, 20)).toBe(PIANO_ABS_MIN);
    expect(computePianoWindowTarget(200, 20)).toBe(PIANO_ABS_MAX - PIANO_WINDOW_SIZE + 1);
  });
});

describe("stepPianoWindow", () => {
  it("moves a fixed fraction toward the target", () => {
    expect(stepPianoWindow(50, 60)).toBeCloseTo(50.6, 9);
    expect(stepPianoWindow(50, 40)).toBeCloseTo(49.4, 9);
  });

  it("is stationary at the target", () => expect(stepPianoWindow(45, 45)).toBe(45));

  it("converges monotonically without overshooting", () => {
    let v = 45;
    for (let i = 0; i < 400; i++) {
      const next = stepPianoWindow(v, 70);
      expect(next).toBeGreaterThanOrEqual(v);
      expect(next).toBeLessThanOrEqual(70);
      v = next;
    }
    expect(v).toBeCloseTo(70, 3);
  });
});
