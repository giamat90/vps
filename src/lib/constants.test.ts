import { describe, it, expect } from "vitest";
import {
  PIANO_ABS_MAX,
  PIANO_ABS_MIN,
  PIANO_WINDOW_DEFAULT_MIN,
  PIANO_WINDOW_SIZE,
  computePianoWindowTarget,
  stepPianoWindow,
} from "./constants";

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
