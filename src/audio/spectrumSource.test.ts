import { describe, it, expect, vi } from "vitest";
import { createLocalSpectrumSource, createRemoteSpectrumSource, NO_FORMANTS, spectrumFftSize, type FormantKind } from "./spectrumSource";
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
  const estimate = vi.fn((samples: Float32Array, _sampleRate: number, _previous: unknown) => ({ f0: 220, f1: samples[0] * 1000, f2: 1500, f3: 2500 }));
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

  it("measures the song's and the take's spectrum from the same windows as the formants", () => {
    const t = local();
    const song = t.source.getTrackSpectrum("song", 1);
    expect(song?.sampleRate).toBe(48000);
    expect(song?.data).toHaveLength(4096);
    expect(t.source.getTrackSpectrum("take", 1)?.data).toHaveLength(4096);
    expect(t.getTrackSamples).toHaveBeenCalledWith("vocals", 8192);
    expect(t.getTrackSamples).toHaveBeenCalledWith("take", 8192);
  });

  it("sizes the FFT to the analyser's ~186 ms window at the buffer's own sample rate", () => {
    expect(spectrumFftSize(44100)).toBe(8192);
    expect(spectrumFftSize(48000)).toBe(8192);
    expect(spectrumFftSize(16000)).toBe(4096);
    expect(spectrumFftSize(8000)).toBe(2048);
    expect(spectrumFftSize(96000)).toBe(8192);
  });

  it("uses the middle of the window for a low-rate buffer, where 8192 samples would be a second of audio", () => {
    const seen: number[] = [];
    const samples = Float32Array.from({ length: 8192 }, (_, i) => (i >= 3072 && i < 5120 ? 0.5 : 0));
    const t = local({ getTrackSamples: () => ({ samples, sampleRate: 8000 }) });
    const spec = t.source.getTrackSpectrum("song", 1);
    seen.push(spec?.data.length ?? 0);
    expect(seen[0]).toBe(1024);
    expect(spec?.sampleRate).toBe(8000);
    // The middle 2048 samples are the constant 0.5 block: energy sits in the lowest bins only.
    const data = spec?.data as Float32Array;
    expect(data[1]).toBeGreaterThan(-30);
    expect(data[500]).toBeLessThan(-60);
  });

  it("puts a tone at its bin on the analyser's dB scale", () => {
    const sr = 44100;
    const bin = 40;
    const hz = (bin * sr) / 8192;
    const tone = Float32Array.from({ length: 8192 }, (_, i) => Math.sin((2 * Math.PI * hz * i) / sr));
    const t = local({ getTrackSamples: () => ({ samples: tone, sampleRate: sr }) });
    const data = t.source.getTrackSpectrum("song", 1)?.data as Float32Array;
    let peak = 0;
    for (let k = 1; k < data.length; k++) if (data[k] > data[peak]) peak = k;
    expect(peak).toBe(bin);
    // A full-scale tone reads about -13.6 dB through a Blackman window divided by N, like AnalyserNode.
    expect(data[bin]).toBeGreaterThan(-16);
    expect(data[bin]).toBeLessThan(-11);
  });

  it("does not measure again while the playhead key is unchanged, and does after a reset", () => {
    const t = local();
    t.source.getTrackSpectrum("song", 5);
    t.source.getTrackSpectrum("song", 5);
    expect(t.getTrackSamples).toHaveBeenCalledTimes(1);
    t.source.getTrackSpectrum("song", 6);
    expect(t.getTrackSamples).toHaveBeenCalledTimes(2);
    t.source.reset();
    t.source.getTrackSpectrum("song", 6);
    expect(t.getTrackSamples).toHaveBeenCalledTimes(3);
  });

  it("has no track spectrum when nothing is audible at the playhead", () => {
    const t = local({ getTrackSamples: () => null });
    expect(t.source.getTrackSpectrum("take", 1)).toBeNull();
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
  const none = { f0: null, f1: null, f2: null, f3: null };
  const message = (extra: Partial<SpectrumMessage> = {}): SpectrumMessage => ({
    live: { sampleRate: 48000, bins: encodeSpectrum(new Float32Array([-100, -50, 0])) },
    tracks: { song: { sampleRate: 44100, bins: encodeSpectrum(new Float32Array([-90, -60, -30])) }, take: null },
    formants: { song: { f0: 220, f1: 500, f2: 1500, f3: 2500 }, take: none, live: { f0: 330, f1: 700, f2: null, f3: null } },
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

  it("serves the fundamental of each estimate with its formants", () => {
    const remote = createRemoteSpectrumSource();
    remote.apply(message());
    expect(remote.source.getFormants("song", 0).f0).toBe(220);
    expect(remote.source.getFormants("live", 0).f0).toBe(330);
    expect(remote.source.getFormants("take", 0).f0).toBeNull();
  });

  it("serves the song's and the take's measured spectrum it was last sent", () => {
    const remote = createRemoteSpectrumSource();
    expect(remote.source.getTrackSpectrum("song", 0)).toBeNull();
    remote.apply(message());
    const song = remote.source.getTrackSpectrum("song", 0);
    expect(song?.sampleRate).toBe(44100);
    expect(song?.data[0]).toBeCloseTo(-90, 0);
    expect(song?.data[2]).toBeCloseTo(-30, 0);
    expect(remote.source.getTrackSpectrum("take", 0)).toBeNull();
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
