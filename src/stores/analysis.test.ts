import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExerciseTake, PitchData, Take } from "../lib/types";

const loadAnalysis = vi.hoisted(() => vi.fn());
const buildSpectroCanvas = vi.hoisted(() => vi.fn());

vi.mock("../lib/tauri", () => ({ loadAnalysis }));
vi.mock("../lib/spectroUtils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/spectroUtils")>()),
  buildSpectroCanvas,
}));

import { useAnalysisStore } from "./analysis";

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

const pitchData = (): PitchData => ({
  times: [0, 0.1, 0.2, 0.3],
  f0: [220, 0, 230, 240],
  voiced: [true, false, true, true],
  confidence: [0.9, 0.1, 0.8, 0.7],
});

const take = (extra: Partial<Take> = {}): Take => ({
  id: "t1", songId: "s1", recordedAt: "2026-01-01", filepath: "/t.wav", startPosition: 10, ...extra,
});

const spectrum = {
  stSpectrumTimes: [0, 0.5],
  stSpectrumB64: b64([1, 2, 3, 4]),
  stSpectrumFrames: 2,
  stSpectrumBins: 2,
  stSpectrumMinDb: -100,
  stSpectrumMaxDb: 0,
};

const initial = useAnalysisStore.getState();

beforeEach(() => {
  loadAnalysis.mockReset();
  buildSpectroCanvas.mockReset();
  useAnalysisStore.setState(initial, true);
  useAnalysisStore.getState().clear();
});

describe("loadSongAnalysis", () => {
  it("keeps only voiced frames with a positive f0 as song pitch points", async () => {
    loadAnalysis.mockResolvedValue({ pitchData: pitchData(), onsets: [1, 2], dynamics: [{ time: 0, rms: 0.1 }] });
    await useAnalysisStore.getState().loadSongAnalysis("s1");
    const s = useAnalysisStore.getState();
    expect(s.songPitch).toEqual([
      { time: 0, frequency: 220, confidence: 0.9 },
      { time: 0.2, frequency: 230, confidence: 0.8 },
      { time: 0.3, frequency: 240, confidence: 0.7 },
    ]);
    expect(s.songOnsets).toEqual([1, 2]);
    expect(s.songDynamics).toEqual([{ time: 0, rms: 0.1 }]);
    expect(s.isLoaded).toBe(true);
    expect(loadAnalysis).toHaveBeenCalledWith("s1");
  });

  it("drops a voiced frame whose f0 is 0", async () => {
    loadAnalysis.mockResolvedValue({
      pitchData: { times: [0], f0: [0], voiced: [true], confidence: [1] }, onsets: [], dynamics: [],
    });
    await useAnalysisStore.getState().loadSongAnalysis("s");
    expect(useAnalysisStore.getState().songPitch).toEqual([]);
  });

  it("decodes the short-term spectrum when every field is present", async () => {
    loadAnalysis.mockResolvedValue({ pitchData: pitchData(), onsets: [], dynamics: [], ...spectrum });
    await useAnalysisStore.getState().loadSongAnalysis("s");
    const st = useAnalysisStore.getState().songSTSpectrum;
    expect(st).not.toBeNull();
    expect(Array.from(st!.bytes)).toEqual([1, 2, 3, 4]);
    expect(st).toMatchObject({ times: [0, 0.5], frames: 2, bins: 2, minDb: -100, maxDb: 0 });
  });

  it.each([
    ["no times", { stSpectrumTimes: [] }],
    ["empty blob", { stSpectrumB64: "" }],
    ["zero frames", { stSpectrumFrames: 0 }],
    ["zero bins", { stSpectrumBins: 0 }],
    ["missing minDb", { stSpectrumMinDb: undefined }],
    ["missing maxDb", { stSpectrumMaxDb: undefined }],
  ])("treats an incomplete spectrum (%s) as absent", async (_label, override) => {
    loadAnalysis.mockResolvedValue({ pitchData: pitchData(), onsets: [], dynamics: [], ...spectrum, ...override });
    await useAnalysisStore.getState().loadSongAnalysis("s");
    expect(useAnalysisStore.getState().songSTSpectrum).toBeNull();
  });

  it("accepts a legitimate minDb/maxDb of 0 (not treated as missing)", async () => {
    loadAnalysis.mockResolvedValue({ pitchData: pitchData(), onsets: [], dynamics: [], ...spectrum, stSpectrumMinDb: 0 });
    await useAnalysisStore.getState().loadSongAnalysis("s");
    expect(useAnalysisStore.getState().songSTSpectrum?.minDb).toBe(0);
  });

  it("warns and continues when the spectrum blob is not valid base64", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadAnalysis.mockResolvedValue({ pitchData: pitchData(), onsets: [], dynamics: [], ...spectrum, stSpectrumB64: "***" });
    await useAnalysisStore.getState().loadSongAnalysis("s");
    expect(useAnalysisStore.getState().songSTSpectrum).toBeNull();
    expect(useAnalysisStore.getState().isLoaded).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("builds the spectrogram canvas with the stored row count and derives hopTime from the timestamps", async () => {
    const canvas = { tag: "canvas" };
    buildSpectroCanvas.mockReturnValue(canvas);
    loadAnalysis.mockResolvedValue({
      pitchData: pitchData(), onsets: [], dynamics: [],
      spectroB64: "AA==", spectroFrames: 3, spectroRows: 160, spectroTimes: [0, 0.25, 0.5],
    });
    await useAnalysisStore.getState().loadSongAnalysis("s");
    expect(buildSpectroCanvas).toHaveBeenCalledWith("AA==", 3, 160);
    expect(useAnalysisStore.getState().songSpectrogram).toEqual({
      times: [0, 0.25, 0.5], canvas, frames: 3, rows: 160, hopTime: 0.25,
    });
  });

  it("defaults to 40 rows and a 512/22050 hop for a single-frame legacy spectrogram", async () => {
    buildSpectroCanvas.mockReturnValue({});
    loadAnalysis.mockResolvedValue({
      pitchData: pitchData(), onsets: [], dynamics: [], spectroB64: "AA==", spectroFrames: 1, spectroTimes: [0],
    });
    await useAnalysisStore.getState().loadSongAnalysis("s");
    expect(buildSpectroCanvas).toHaveBeenCalledWith("AA==", 1, 40);
    expect(useAnalysisStore.getState().songSpectrogram?.hopTime).toBeCloseTo(512 / 22050, 12);
  });

  it("warns, skips the spectrogram, and still loads pitch when canvas creation throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildSpectroCanvas.mockImplementation(() => { throw new Error("no OffscreenCanvas"); });
    loadAnalysis.mockResolvedValue({
      pitchData: pitchData(), onsets: [], dynamics: [], spectroB64: "AA==", spectroFrames: 1, spectroTimes: [0],
    });
    await useAnalysisStore.getState().loadSongAnalysis("s");
    expect(useAnalysisStore.getState().songSpectrogram).toBeNull();
    expect(useAnalysisStore.getState().songPitch).toHaveLength(3);
    expect(warn).toHaveBeenCalled();
  });

  it("copes with the backend's empty-song shape (arrays instead of objects)", async () => {
    loadAnalysis.mockResolvedValue({ pitchData: [], onsets: [], dynamics: [] });
    await useAnalysisStore.getState().loadSongAnalysis("s");
    expect(useAnalysisStore.getState().songPitch).toEqual([]);
    expect(useAnalysisStore.getState().isLoaded).toBe(true);
  });

  it("logs and stays unloaded when the backend call fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    loadAnalysis.mockRejectedValue(new Error("bad json"));
    await useAnalysisStore.getState().loadSongAnalysis("s");
    expect(useAnalysisStore.getState().isLoaded).toBe(false);
    expect(err).toHaveBeenCalled();
  });
});

describe("loadTakeAnalysis", () => {
  it("shifts take-local times to song time by startPosition + manualOffset (audioOffset is NOT subtracted)", () => {
    useAnalysisStore.getState().loadTakeAnalysis(take({
      startPosition: 10, manualOffset: 0.5, audioOffset: 3,
      pitchData: pitchData(), onsets: [1, 2], dynamics: [{ time: 0.2, rms: 0.3 }],
    }));
    const s = useAnalysisStore.getState();
    expect(s.takePitch.map((p) => p.time)).toEqual([10.5, 10.7, 10.8]);
    expect(s.takeOnsets).toEqual([11.5, 12.5]);
    expect(s.takeDynamics).toEqual([{ time: 10.7, rms: 0.3 }]);
  });

  it("shifts the spectrum time axis too, leaving the bytes intact", () => {
    useAnalysisStore.getState().loadTakeAnalysis(take({ startPosition: 4, ...spectrum }));
    const st = useAnalysisStore.getState().takeSTSpectrum!;
    expect(st.times).toEqual([4, 4.5]);
    expect(Array.from(st.bytes)).toEqual([1, 2, 3, 4]);
  });

  it("computes timing deviations against the loaded song onsets", () => {
    useAnalysisStore.setState({ songOnsets: [11, 12] });
    useAnalysisStore.getState().loadTakeAnalysis(take({ startPosition: 10, onsets: [1.05, 2.1] }));
    expect(useAnalysisStore.getState().timingDeviations.map((d) => d.deltaMs)).toEqual([50, 100]);
  });

  it("carries vibrato through, and resets the live trace", () => {
    useAnalysisStore.getState().appendLivePitch({ time: 1, frequency: 200, confidence: 1 });
    useAnalysisStore.getState().loadTakeAnalysis(take({ vibrato: { rate: 5, depth: 40, regularity: 0.7 } }));
    expect(useAnalysisStore.getState().takeVibrato).toEqual({ rate: 5, depth: 40, regularity: 0.7 });
    expect(useAnalysisStore.getState().livePitch).toEqual([]);
  });

  it("handles a take with no analysis at all", () => {
    useAnalysisStore.getState().loadTakeAnalysis(take());
    const s = useAnalysisStore.getState();
    expect([s.takePitch, s.takeOnsets, s.takeDynamics, s.timingDeviations]).toEqual([[], [], [], []]);
    expect(s.takeVibrato).toBeNull();
    expect(s.takeSTSpectrum).toBeNull();
  });

  it("does not mutate the take it was given", () => {
    const t = take({ dynamics: [{ time: 1, rms: 1 }], onsets: [1], stSpectrumTimes: [0, 1] });
    const snapshot = JSON.stringify(t);
    useAnalysisStore.getState().loadTakeAnalysis(t);
    expect(JSON.stringify(t)).toBe(snapshot);
  });
});

describe("clearTakeAnalysis", () => {
  it("wipes every take field but leaves song data alone", () => {
    useAnalysisStore.setState({ songPitch: [{ time: 0, frequency: 100, confidence: 1 }], songOnsets: [1] });
    useAnalysisStore.getState().loadTakeAnalysis(take({ pitchData: pitchData(), onsets: [1], ...spectrum }));
    useAnalysisStore.getState().clearTakeAnalysis();
    const s = useAnalysisStore.getState();
    expect([s.takePitch, s.takeOnsets, s.takeDynamics, s.timingDeviations]).toEqual([[], [], [], []]);
    expect(s.takeVibrato).toBeNull();
    expect(s.takeSTSpectrum).toBeNull();
    expect(s.songPitch).toHaveLength(1);
    expect(s.songOnsets).toEqual([1]);
  });
});

describe("previewTakeManualOffset", () => {
  it("re-times a take for a live drag without re-decoding the spectrum bytes", () => {
    const t = take({ startPosition: 10, pitchData: pitchData(), onsets: [1], ...spectrum });
    useAnalysisStore.getState().loadTakeAnalysis(t);
    const bytesBefore = useAnalysisStore.getState().takeSTSpectrum!.bytes;

    useAnalysisStore.getState().previewTakeManualOffset(t, 2);

    const s = useAnalysisStore.getState();
    expect(s.takePitch[0].time).toBe(12);
    expect(s.takeOnsets).toEqual([13]);
    expect(s.takeSTSpectrum!.times).toEqual([12, 12.5]);
    expect(s.takeSTSpectrum!.bytes).toBe(bytesBefore);
  });

  it("applies an absolute offset, not one cumulative with the previous preview", () => {
    const t = take({ startPosition: 0, onsets: [1] });
    useAnalysisStore.getState().previewTakeManualOffset(t, 1);
    useAnalysisStore.getState().previewTakeManualOffset(t, 1);
    expect(useAnalysisStore.getState().takeOnsets).toEqual([2]);
  });

  it("leaves the spectrum null when none was loaded", () => {
    useAnalysisStore.getState().previewTakeManualOffset(take(), 1);
    expect(useAnalysisStore.getState().takeSTSpectrum).toBeNull();
  });
});

describe("loadExerciseTakeAnalysis", () => {
  const ex = (extra: Partial<ExerciseTake> = {}): ExerciseTake => ({
    id: "e", recordedAt: "now", filepath: "/e.webm", duration: 3, ...extra,
  });

  it("uses take-local times unshifted and clears song-only fields", () => {
    useAnalysisStore.setState({ takeOnsets: [9], timingDeviations: [{ noteIndex: 0, referenceTime: 1, userTime: 1, deltaMs: 0 }] });
    useAnalysisStore.getState().loadExerciseTakeAnalysis(ex({
      pitchData: pitchData(), dynamics: [{ time: 0.1, rms: 0.5 }], vibrato: { rate: 6, depth: 30, regularity: 0.5 },
    }));
    const s = useAnalysisStore.getState();
    expect(s.takePitch.map((p) => p.time)).toEqual([0, 0.2, 0.3]);
    expect(s.takeDynamics).toEqual([{ time: 0.1, rms: 0.5 }]);
    expect(s.takeVibrato).toEqual({ rate: 6, depth: 30, regularity: 0.5 });
    expect(s.takeOnsets).toEqual([]);
    expect(s.timingDeviations).toEqual([]);
    expect(s.takeSTSpectrum).toBeNull();
  });

  it("copes with a take that has no analysis", () => {
    useAnalysisStore.getState().loadExerciseTakeAnalysis(ex());
    expect(useAnalysisStore.getState().takePitch).toEqual([]);
    expect(useAnalysisStore.getState().takeVibrato).toBeNull();
  });
});

describe("live pitch", () => {
  it("accumulates points in order, and clears", () => {
    const { appendLivePitch, clearLivePitch } = useAnalysisStore.getState();
    appendLivePitch({ time: 0, frequency: 100, confidence: 1 });
    appendLivePitch({ time: 1, frequency: 110, confidence: 1 });
    expect(useAnalysisStore.getState().livePitch.map((p) => p.time)).toEqual([0, 1]);
    clearLivePitch();
    expect(useAnalysisStore.getState().livePitch).toEqual([]);
  });

  it("does not mutate the previous array (so subscribers see a new reference)", () => {
    const before = useAnalysisStore.getState().livePitch;
    useAnalysisStore.getState().appendLivePitch({ time: 0, frequency: 100, confidence: 1 });
    expect(useAnalysisStore.getState().livePitch).not.toBe(before);
    expect(before).toEqual([]);
  });
});

describe("clear", () => {
  it("returns to the pristine state", () => {
    useAnalysisStore.setState({ songOnsets: [1], isLoaded: true });
    useAnalysisStore.getState().appendLivePitch({ time: 0, frequency: 1, confidence: 1 });
    useAnalysisStore.getState().clear();
    const s = useAnalysisStore.getState();
    expect(s.songOnsets).toEqual([]);
    expect(s.isLoaded).toBe(false);
    expect(s.livePitch).toEqual([]);
    expect(s.songSpectrogram).toBeNull();
  });
});
