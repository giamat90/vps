import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getMicAnalyser: vi.fn(() => null),
  getTrackSamples: vi.fn(() => null),
}));

vi.mock("../stores/player", () => ({
  getMicAnalyser: h.getMicAnalyser,
  getEngine: () => ({ getTrackSamples: h.getTrackSamples }),
}));

import { getLocalSpectrumSource, getSpectrumSource, installSpectrumSource } from "./spectrumRegistry";
import type { SpectrumSource } from "../audio/spectrumSource";

const fake = (): SpectrumSource => ({ getLiveSpectrum: () => null, getFormants: () => ({ f1: 1, f2: null, f3: null }), reset: () => {} });

beforeEach(() => {
  h.getMicAnalyser.mockClear();
  h.getTrackSamples.mockClear();
});

describe("spectrum source registry", () => {
  it("is the engine and microphone of this window by default", () => {
    const source = getSpectrumSource();
    expect(source).toBe(getLocalSpectrumSource());
    expect(source.getLiveSpectrum()).toBeNull();
    expect(h.getMicAnalyser).toHaveBeenCalled();
    source.getFormants("song", 1);
    expect(h.getTrackSamples).toHaveBeenCalledWith("vocals", 8192);
  });

  it("is one shared local source, so its formant cache is shared too", () => {
    expect(getLocalSpectrumSource()).toBe(getLocalSpectrumSource());
  });

  it("is whatever a detached window installs, and the local one again afterwards", () => {
    const remote = fake();
    const uninstall = installSpectrumSource(remote);
    expect(getSpectrumSource()).toBe(remote);
    expect(getLocalSpectrumSource()).not.toBe(remote);
    uninstall();
    expect(getSpectrumSource()).toBe(getLocalSpectrumSource());
  });

  it("does not take away a newer source when an older one is uninstalled late", () => {
    const first = installSpectrumSource(fake());
    const second = fake();
    installSpectrumSource(second);
    first();
    expect(getSpectrumSource()).toBe(second);
  });
});
