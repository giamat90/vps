import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ engineTime: 7 }));

vi.mock("../stores/player", () => ({
  getEngine: () => ({ getCurrentTime: () => h.engineTime }),
}));

import { getPlaybackTime, installPlaybackTimeSource, setPlaybackTimeSource } from "./playbackClock";

beforeEach(() => {
  setPlaybackTimeSource(null);
  h.engineTime = 7;
});

describe("playback clock", () => {
  it("is the audio engine in the main window", () => {
    expect(getPlaybackTime()).toBe(7);
    h.engineTime = 8.5;
    expect(getPlaybackTime()).toBe(8.5);
  });

  it("is whatever source a detached window installs", () => {
    setPlaybackTimeSource(() => 42);
    expect(getPlaybackTime()).toBe(42);
  });

  it("returns to the engine when the source is removed", () => {
    setPlaybackTimeSource(() => 42);
    setPlaybackTimeSource(null);
    expect(getPlaybackTime()).toBe(7);
  });
});

describe("installing a playback time source", () => {
  it("hands back an uninstaller that returns to the engine", () => {
    const uninstall = installPlaybackTimeSource(() => 42);
    expect(getPlaybackTime()).toBe(42);
    uninstall();
    expect(getPlaybackTime()).toBe(7);
  });

  it("does not take away a newer source when an older one is uninstalled late", () => {
    // React mounts an effect twice in development: the first bridge is disposed
    // after the second one has already installed its clock.
    const first = installPlaybackTimeSource(() => 1);
    installPlaybackTimeSource(() => 2);
    first();
    expect(getPlaybackTime()).toBe(2);
  });
});
