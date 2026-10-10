import { describe, it, expect, vi } from "vitest";
import { createSpectrumFeed } from "./spectrumFeed";
import { decodeSpectrum } from "./spectrumCodec";
import type { SpectrumSource } from "../audio/spectrumSource";

const NONE = { f1: null, f2: null, f3: null };
const F = (f1: number) => ({ f1, f2: f1 * 3, f3: f1 * 5 });

function setup(player: Partial<{ isRecording: boolean; isMonitoring: boolean; currentTime: number }> = {}) {
  const state = { isRecording: false, isMonitoring: false, currentTime: 1, ...player };
  const analysis = { songSTSpectrum: {} as object | null, takeSTSpectrum: null as object | null };
  const live = { data: new Float32Array([-100, -50, 0]), sampleRate: 48000 };
  let listening = false;
  const source: SpectrumSource = {
    getLiveSpectrum: vi.fn(() => (listening ? live : null)),
    getFormants: vi.fn((kind) => (kind === "song" ? F(500) : kind === "take" ? F(600) : F(700))),
    reset: vi.fn(),
  };
  const feed = createSpectrumFeed({
    source,
    getPlayer: () => state,
    getAnalysis: () => analysis as never,
  });
  return {
    feed, source, analysis, state,
    setLive: (v: boolean) => {
      listening = v;
      state.isMonitoring = v;
    },
  };
}

describe("spectrum feed", () => {
  it("sends the song's formants when only the song has a spectrum", () => {
    const t = setup();
    expect(t.feed.read()).toEqual({ live: null, formants: { song: F(500), take: NONE, live: NONE } });
  });

  it("sends the take's formants when a take has a spectrum and nobody is listening", () => {
    const t = setup();
    t.analysis.takeSTSpectrum = {};
    expect(t.feed.read()?.formants).toEqual({ song: F(500), take: F(600), live: NONE });
  });

  it("sends the live spectrum, quantised, and the live formants instead of the take's while listening", () => {
    const t = setup();
    t.analysis.takeSTSpectrum = {};
    t.setLive(true);
    const m = t.feed.read();
    expect(m?.formants).toEqual({ song: F(500), take: NONE, live: F(700) });
    expect(m?.live?.sampleRate).toBe(48000);
    expect(Array.from(decodeSpectrum(m?.live?.bins ?? ""))).toEqual([-100, -50, 0].map((v) => expect.closeTo(v, 0)));
  });

  it("keys the song and take estimates to the playhead, but never the live one", () => {
    const t = setup({ currentTime: 1.0 });
    t.analysis.takeSTSpectrum = {};
    t.feed.read();
    expect(t.source.getFormants).toHaveBeenCalledWith("song", 50);
    expect(t.source.getFormants).toHaveBeenCalledWith("take", 50);
    t.setLive(true);
    t.feed.read();
    expect(t.source.getFormants).toHaveBeenCalledWith("live", Number.NaN);
  });

  it("says nothing new while nothing has changed and nobody is listening", () => {
    const t = setup();
    expect(t.feed.read()).not.toBeNull();
    expect(t.feed.read()).toBeNull();
    expect(t.feed.read()).toBeNull();
  });

  it("speaks again when the formants move with the playhead", () => {
    const t = setup();
    t.feed.read();
    (t.source.getFormants as ReturnType<typeof vi.fn>).mockImplementation((kind: string) => (kind === "song" ? F(520) : NONE));
    expect(t.feed.read()?.formants.song).toEqual(F(520));
  });

  it("sends a frame every time while listening, since the spectrum itself moves", () => {
    const t = setup();
    t.setLive(true);
    expect(t.feed.read()).not.toBeNull();
    expect(t.feed.read()).not.toBeNull();
  });

  it("sends one last message without a live spectrum when listening stops", () => {
    const t = setup();
    t.setLive(true);
    t.feed.read();
    t.setLive(false);
    const last = t.feed.read();
    expect(last).not.toBeNull();
    expect(last?.live).toBeNull();
    expect(t.feed.read()).toBeNull();
  });

  it("has nothing at all to say with no spectrum data and no microphone", () => {
    const t = setup();
    t.analysis.songSTSpectrum = null;
    expect(t.feed.read()).toBeNull();
  });

  it("forgets the source's cached estimates when the take's spectrum is replaced", () => {
    // Switching takes at the same playhead leaves the cache key unchanged, so
    // without this the previous take's formants would keep being shown.
    const t = setup();
    const first = {};
    t.analysis.takeSTSpectrum = first;
    t.feed.read();
    const resets = (t.source.reset as ReturnType<typeof vi.fn>).mock.calls.length;
    t.analysis.takeSTSpectrum = {};
    t.feed.read();
    expect((t.source.reset as ReturnType<typeof vi.fn>).mock.calls.length).toBe(resets + 1);
  });

  it("forgets them when the song's spectrum is replaced too", () => {
    const t = setup();
    t.feed.read();
    const resets = (t.source.reset as ReturnType<typeof vi.fn>).mock.calls.length;
    t.analysis.songSTSpectrum = {};
    t.feed.read();
    expect((t.source.reset as ReturnType<typeof vi.fn>).mock.calls.length).toBe(resets + 1);
  });

  it("does not reset while the spectra are the same objects", () => {
    const t = setup();
    t.feed.read();
    const resets = (t.source.reset as ReturnType<typeof vi.fn>).mock.calls.length;
    t.feed.read();
    t.feed.read();
    expect((t.source.reset as ReturnType<typeof vi.fn>).mock.calls.length).toBe(resets);
  });

  it("starts over when asked, so a new window gets the whole picture", () => {
    const t = setup();
    t.feed.read();
    t.feed.reset();
    expect(t.feed.read()).not.toBeNull();
  });
});
