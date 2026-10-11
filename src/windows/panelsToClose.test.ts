import { describe, it, expect } from "vitest";
import { panelsToClose } from "./panelsToClose";

const all = (v: boolean) => ({
  pianoRoll: v, lyrics: v, takes: v, spectrum: v, dynamics: v, vibrato: v, timing: v, coach: v,
});

describe("panelsToClose", () => {
  it("is empty when nothing changed", () => {
    expect(panelsToClose(all(true), all(true), { pianoRoll: true })).toEqual([]);
  });

  it("closes the window of a detached panel that has just been hidden", () => {
    expect(panelsToClose(all(true), { ...all(true), pianoRoll: false }, { pianoRoll: true })).toEqual(["pianoRoll"]);
  });

  it("leaves a docked panel alone: there is no window to close", () => {
    expect(panelsToClose(all(true), { ...all(true), lyrics: false }, { pianoRoll: true })).toEqual([]);
  });

  it("leaves a detached panel alone while it stays visible", () => {
    expect(panelsToClose(all(true), { ...all(true), lyrics: false }, { pianoRoll: true, lyrics: false })).toEqual([]);
  });

  it("closes every detached panel that Hide all hides, and only those", () => {
    expect(panelsToClose(all(true), all(false), { vibrato: true, coach: true, takes: false }).sort()).toEqual([
      "coach",
      "vibrato",
    ]);
  });

  it("does not act on a panel that was already hidden", () => {
    expect(panelsToClose({ ...all(true), coach: false }, all(false), { coach: true })).toEqual([]);
  });

  it("ignores ids that are not detachable panels", () => {
    expect(panelsToClose({ ...all(true), waveform: true }, { ...all(true), waveform: false }, { waveform: true })).toEqual([]);
  });
});
