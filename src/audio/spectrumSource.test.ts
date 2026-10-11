import { describe, it, expect, vi } from "vitest";
import { createLocalSpectrumSource, createRemoteSpectrumSource, NO_FORMANTS, type FormantKind } from "./spectrumSource";
import { encodeSpectrum } from "../windows/spectrumCodec";
import type { SpectrumMessage } from "../windows/protocol";

function fakeAnalyser(bins = 4) {
  return {
    frequencyBinCount: bins,
    fftSize: bins * 2,
    context: { sampleRate: 44100 },
    getFloatFrequencyData: vi.fn((a: Float32Array) => a.fill(-42)),
    getFloatTimeDomainData: vi.fn((a: Float32Array) => a.fill(0.25)),
  };
}

function local(overrides: Partial<Parameters<typeof createLocalSpectrumSource>[0]> = {}) {
  const analyser = fakeAnalyser();
  const getTrackSamples = vi.fn((track: "vocals" | "take", n: number) => ({
    samples: new Float32Array(n).fill(track === "vocals" ? 0.1 : 0.2),
    sampleRate: 48000,
  }));
  const estimate = vi.fn((samples: Float32Array, _sampleRate: number, _previous: unknown) => ({ f1: samples[0] * 1000, f2: 1500, f3: 2500 }));
  const source = createLocalSpectrumSource({
    getAnalyser: () => analyser as unknown as AnalyserNode,
    getTrackSamples,
    estimate,
    ...overrides,
  });
  return { source, analyser, getTrackSamples, estimate };
}

describe("local spectrum source", () => {
  it("reads the analyser's dB spectrum and its sample rate", () => {
    const t = local();
    const live = t.source.getLiveSpectrum();
    expect(live?.sampleRate).toBe(44100);
    expect(live?.data).toHaveLength(4);
    expect(Array.from(live?.data ?? [])).toEqual([-42, -42, -42, -42]);
  });

  it("reuses one buffer rather than allocating each frame", () => {
    const t = local();
    expect(t.source.getLiveSpectrum()?.data).toBe(t.source.getLiveSpectrum()?.data);
  });

  it("has no live spectrum without an analyser", () => {
    const t = local({ getAnalyser: () => null });
    expect(t.source.getLiveSpectrum()).toBeNull();
  });

  it("estimates the song's formants from the vocals and the take's from the take", () => {
    const t = local();
    expect(t.source.getFormants("song", 1).f1).toBeCloseTo(100, 3);
    expect(t.source.getFormants("take", 1).f1).toBeCloseTo(200, 3);
    expect(t.getTrackSamples).toHaveBeenCalledWith("vocals", 8192);
    expect(t.getTrackSamples).toHaveBeenCalledWith("take", 8192);
  });

  it("estimates the live voice from the analyser's time-domain samples", () => {
    const t = local();
    const f = t.source.getFormants("live", Number.NaN);
    expect(f.f1).toBeCloseTo(250, 3);
    expect(t.analyser.getFloatTimeDomainData).toHaveBeenCalled();
  });

  it("does not re-estimate while the playhead key is unchanged", () => {
    const t = local();
    t.source.getFormants("song", 5);
    t.source.getFormants("song", 5);
    t.source.getFormants("song", 5);
    expect(t.estimate).toHaveBeenCalledTimes(1);
    t.source.getFormants("song", 6);
    expect(t.estimate).toHaveBeenCalledTimes(2);
  });

  it("never caches a key of NaN, so a live voice is estimated every frame", () => {
    const t = local();
    t.source.getFormants("live", Number.NaN);
    t.source.getFormants("live", Number.NaN);
    expect(t.estimate).toHaveBeenCalledTimes(2);
  });

  it("keeps the three kinds apart", () => {
    const t = local();
    t.source.getFormants("song", 5);
    t.source.getFormants("take", 5);
    expect(t.estimate).toHaveBeenCalledTimes(2);
  });

  it("gives no formants when there is nothing audible", () => {
    const t = local({ getTrackSamples: () => null });
    expect(t.source.getFormants("song", 1)).toEqual(NO_FORMANTS);
  });

  it("forgets what it cached when reset", () => {
    const t = local();
    t.source.getFormants("song", 5);
    t.source.reset();
    t.source.getFormants("song", 5);
    expect(t.estimate).toHaveBeenCalledTimes(2);
  });

  it("passes the previous estimate to the next one, to keep tracks continuous", () => {
    const t = local();
    t.source.getFormants("song", 1);
    t.source.getFormants("song", 2);
    expect(t.estimate.mock.calls[1][2]).toMatchObject({ f2: 1500 });
  });
});

describe("remote spectrum source", () => {
  const none = { f1: null, f2: null, f3: null };
  const message = (extra: Partial<SpectrumMessage> = {}): SpectrumMessage => ({
    live: { sampleRate: 48000, bins: encodeSpectrum(new Float32Array([-100, -50, 0])) },
    formants: { song: { f1: 500, f2: 1500, f3: 2500 }, take: none, live: { f1: 700, f2: null, f3: null } },
    ...extra,
  });

  it("knows nothing before the first message", () => {
    const { source } = createRemoteSpectrumSource();
    expect(source.getLiveSpectrum()).toBeNull();
    expect(source.getFormants("song", 0)).toEqual(NO_FORMANTS);
  });

  it("serves the live spectrum and formants it was last sent", () => {
    const remote = createRemoteSpectrumSource();
    remote.apply(message());
    const live = remote.source.getLiveSpectrum();
    expect(live?.sampleRate).toBe(48000);
    expect(live?.data[0]).toBe(-100);
    expect(live?.data[2]).toBe(0);
    for (const [kind, expected] of [["song", 500], ["live", 700]] as [FormantKind, number][]) {
      expect(remote.source.getFormants(kind, 0).f1).toBe(expected);
    }
  });

  it("stops serving a live spectrum once the main window says it is no longer live", () => {
    const remote = createRemoteSpectrumSource();
    remote.apply(message());
    remote.apply(message({ live: null }));
    expect(remote.source.getLiveSpectrum()).toBeNull();
    expect(remote.source.getFormants("song", 0).f1).toBe(500);
  });

  it("ignores a spectrum it cannot decode, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const remote = createRemoteSpectrumSource();
    remote.apply(message());
    remote.apply(message({ live: { sampleRate: 48000, bins: "***" } }));
    expect(warn).toHaveBeenCalled();
    expect(remote.source.getLiveSpectrum()?.data[0]).toBe(-100);
  });
});
