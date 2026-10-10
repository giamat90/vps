import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExerciseTake } from "../lib/types";

const h = vi.hoisted(() => ({
  api: { listExerciseTakes: vi.fn(), deleteExerciseTakeApi: vi.fn(), importExerciseFile: vi.fn() },
  engine: {
    loadExerciseTrack: vi.fn(),
    clearExerciseTrack: vi.fn(),
    stopExerciseTimer: vi.fn(),
    startExerciseTimer: vi.fn(),
    exerciseTrack: { getDecodedData: vi.fn() } as { getDecodedData: ReturnType<typeof vi.fn> } | null,
  },
  computeTrackSpectrogram: vi.fn(),
  player: { state: { isMonitoring: false, exerciseMode: false, isPlaying: true, currentTime: 9, duration: 9 } },
}));

vi.mock("../lib/tauri", () => h.api);
vi.mock("../lib/exerciseSpectrogram", () => ({ computeTrackSpectrogram: h.computeTrackSpectrogram }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("./player", () => ({
  getEngine: () => h.engine,
  usePlayerStore: {
    getState: () => h.player.state,
    setState: (patch: object) => { Object.assign(h.player.state, patch); },
  },
}));

import { useExerciseStore } from "./exercise";
import { useAnalysisStore } from "./analysis";

const take = (id: string, extra: Partial<ExerciseTake> = {}): ExerciseTake => ({
  id, recordedAt: "2026-01-01", filepath: `/ex/${id}.webm`, duration: 4, ...extra,
});

const container = {} as HTMLElement;
const initial = useExerciseStore.getState();

beforeEach(() => {
  Object.values(h.api).forEach((fn) => fn.mockReset());
  Object.values(h.engine).forEach((v) => { if (typeof v === "function") (v as ReturnType<typeof vi.fn>).mockReset(); });
  h.engine.loadExerciseTrack.mockResolvedValue(undefined);
  h.engine.exerciseTrack = { getDecodedData: vi.fn(() => ({ tag: "buffer" })) };
  h.computeTrackSpectrogram.mockReset();
  h.computeTrackSpectrogram.mockResolvedValue({ tag: "spectrogram" });
  Object.assign(h.player.state, { isMonitoring: false, exerciseMode: false, isPlaying: true, currentTime: 9, duration: 9 });
  useExerciseStore.setState(initial, true);
  useAnalysisStore.getState().clear();
});

describe("exercise take list", () => {
  it("fetches the list from the backend", async () => {
    h.api.listExerciseTakes.mockResolvedValue([take("a"), take("b")]);
    await useExerciseStore.getState().fetchExerciseTakes();
    expect(useExerciseStore.getState().exerciseTakes.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("adds a new take at the end", () => {
    useExerciseStore.setState({ exerciseTakes: [take("a")] });
    useExerciseStore.getState().addExerciseTake(take("b"));
    expect(useExerciseStore.getState().exerciseTakes.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("deletes after the backend confirms and deselects it if it was active", async () => {
    useExerciseStore.setState({ exerciseTakes: [take("a"), take("b")], activeExerciseTakeId: "a" });
    h.api.deleteExerciseTakeApi.mockResolvedValue(undefined);
    await useExerciseStore.getState().deleteExerciseTake("a");
    expect(h.api.deleteExerciseTakeApi).toHaveBeenCalledWith("a");
    expect(useExerciseStore.getState().exerciseTakes.map((t) => t.id)).toEqual(["b"]);
    expect(useExerciseStore.getState().activeExerciseTakeId).toBeNull();
  });

  it("keeps another take selected when a different one is deleted", async () => {
    useExerciseStore.setState({ exerciseTakes: [take("a"), take("b")], activeExerciseTakeId: "b" });
    await useExerciseStore.getState().deleteExerciseTake("a");
    expect(useExerciseStore.getState().activeExerciseTakeId).toBe("b");
  });

  it("unloads the track when the loaded take is deleted", async () => {
    useExerciseStore.setState({ exerciseTakes: [take("a")], loadedTrackId: "a", loadedTrackKind: "take" });
    await useExerciseStore.getState().deleteExerciseTake("a");
    expect(h.engine.clearExerciseTrack).toHaveBeenCalled();
    expect(useExerciseStore.getState()).toMatchObject({ loadedTrackId: null, loadedTrackKind: null });
  });

  it("leaves the list untouched when the backend refuses the delete", async () => {
    useExerciseStore.setState({ exerciseTakes: [take("a")] });
    h.api.deleteExerciseTakeApi.mockRejectedValue(new Error("busy"));
    await expect(useExerciseStore.getState().deleteExerciseTake("a")).rejects.toThrow("busy");
    expect(useExerciseStore.getState().exerciseTakes).toHaveLength(1);
  });

  it("selects and deselects", () => {
    useExerciseStore.getState().setActiveExerciseTake("x");
    expect(useExerciseStore.getState().activeExerciseTakeId).toBe("x");
    useExerciseStore.getState().setActiveExerciseTake(null);
    expect(useExerciseStore.getState().activeExerciseTakeId).toBeNull();
  });
});

describe("loadExerciseTakeIntoTrack", () => {
  const pitchData = { times: [0, 1], f0: [200, 210], voiced: [true, true], confidence: [1, 1] };

  it("loads the file, feeds its analysis to the analysis store and sets the clock for seeking", async () => {
    await useExerciseStore.getState().loadExerciseTakeIntoTrack(take("a", { duration: 12, pitchData }), container);
    expect(h.engine.loadExerciseTrack).toHaveBeenCalledWith("/ex/a.webm", container);
    expect(useAnalysisStore.getState().takePitch).toHaveLength(2);
    expect(h.player.state).toMatchObject({ isPlaying: false, currentTime: 0, duration: 12 });
    expect(useExerciseStore.getState()).toMatchObject({ loadedTrackKind: "take", loadedTrackId: "a" });
  });

  it("hands the clock to the track when monitoring was already running the free timer", async () => {
    h.player.state.isMonitoring = true;
    await useExerciseStore.getState().loadExerciseTakeIntoTrack(take("a"), container);
    expect(h.engine.stopExerciseTimer).toHaveBeenCalled();
  });

  it("leaves the timer alone when nothing is monitoring", async () => {
    await useExerciseStore.getState().loadExerciseTakeIntoTrack(take("a"), container);
    expect(h.engine.stopExerciseTimer).not.toHaveBeenCalled();
  });

  it("precomputes the spectrogram from the decoded buffer and stores it", async () => {
    await useExerciseStore.getState().loadExerciseTakeIntoTrack(take("a"), container);
    expect(h.computeTrackSpectrogram).toHaveBeenCalledWith({ tag: "buffer" });
    expect(useExerciseStore.getState()).toMatchObject({
      exerciseTrackSpectrogram: { tag: "spectrogram" }, isComputingSpectrogram: false,
    });
  });

  it("shows the computing flag while the spectrogram is being built", async () => {
    let release!: (v: unknown) => void;
    h.computeTrackSpectrogram.mockReturnValue(new Promise((r) => { release = r; }));
    const pending = useExerciseStore.getState().loadExerciseTakeIntoTrack(take("a"), container);
    await vi.waitFor(() => expect(useExerciseStore.getState().isComputingSpectrogram).toBe(true));
    expect(useExerciseStore.getState().exerciseTrackSpectrogram).toBeNull();
    release({ tag: "late" });
    await pending;
    expect(useExerciseStore.getState().isComputingSpectrogram).toBe(false);
  });

  it("discards a spectrogram that finishes after another track replaced this one", async () => {
    let release!: (v: unknown) => void;
    h.computeTrackSpectrogram.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const first = useExerciseStore.getState().loadExerciseTakeIntoTrack(take("a"), container);
    await vi.waitFor(() => expect(useExerciseStore.getState().loadedTrackId).toBe("a"));
    useExerciseStore.setState({ loadedTrackId: "b", exerciseTrackSpectrogram: { tag: "b" } as never, isComputingSpectrogram: true });
    release({ tag: "stale-a" });
    await first;
    expect(useExerciseStore.getState().exerciseTrackSpectrogram).toEqual({ tag: "b" });
    expect(useExerciseStore.getState().isComputingSpectrogram).toBe(true);
  });

  it("logs and carries on without a spectrogram when the computation fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.computeTrackSpectrogram.mockRejectedValue(new Error("oom"));
    await useExerciseStore.getState().loadExerciseTakeIntoTrack(take("a"), container);
    expect(err).toHaveBeenCalled();
    expect(useExerciseStore.getState()).toMatchObject({ exerciseTrackSpectrogram: null, isComputingSpectrogram: false, loadedTrackId: "a" });
  });

  it("skips the spectrogram when the engine exposes no decoded data", async () => {
    h.engine.exerciseTrack = { getDecodedData: vi.fn(() => null) };
    await useExerciseStore.getState().loadExerciseTakeIntoTrack(take("a"), container);
    expect(h.computeTrackSpectrogram).not.toHaveBeenCalled();
    expect(useExerciseStore.getState().exerciseTrackSpectrogram).toBeNull();
  });

  it("propagates an engine load failure and leaves nothing marked as loaded", async () => {
    h.engine.loadExerciseTrack.mockRejectedValue(new Error("decode"));
    await expect(useExerciseStore.getState().loadExerciseTakeIntoTrack(take("a"), container)).rejects.toThrow("decode");
    expect(useExerciseStore.getState().loadedTrackId).toBeNull();
  });
});

describe("clearLoadedTrack", () => {
  it("restarts the free timer when monitoring continues without a track", () => {
    Object.assign(h.player.state, { isMonitoring: true, exerciseMode: true });
    useExerciseStore.getState().clearLoadedTrack();
    expect(h.engine.startExerciseTimer).toHaveBeenCalled();
  });

  it("does not start a timer when not monitoring, or outside exercise mode", () => {
    useExerciseStore.getState().clearLoadedTrack();
    Object.assign(h.player.state, { isMonitoring: true, exerciseMode: false });
    useExerciseStore.getState().clearLoadedTrack();
    expect(h.engine.startExerciseTimer).not.toHaveBeenCalled();
  });

  it("unloads the track, clears analysis and resets the clock", () => {
    useExerciseStore.setState({ loadedTrackId: "a", loadedTrackKind: "take", exerciseTrackSpectrogram: {} as never, isComputingSpectrogram: true });
    useAnalysisStore.setState({ songOnsets: [1] });
    useExerciseStore.getState().clearLoadedTrack();
    expect(h.engine.clearExerciseTrack).toHaveBeenCalled();
    expect(useAnalysisStore.getState().songOnsets).toEqual([]);
    expect(h.player.state).toMatchObject({ isPlaying: false, currentTime: 0, duration: 0 });
    expect(useExerciseStore.getState()).toMatchObject({
      loadedTrackId: null, loadedTrackKind: null, exerciseTrackSpectrogram: null, isComputingSpectrogram: false,
    });
  });
});

describe("importExerciseFile", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })));
    vi.stubGlobal("AudioContext", class {
      decodeAudioData = vi.fn(async () => ({ duration: 7.5 }));
      close = vi.fn(async () => {});
    });
  });

  it("decodes the duration, imports, adds and loads the take as 'imported'", async () => {
    h.api.importExerciseFile.mockResolvedValue(take("imp", { duration: 7.5 }));
    const pending = useExerciseStore.getState().importExerciseFile("C:\\music\\a.wav", container);
    expect(useExerciseStore.getState().isImporting).toBe(true);
    await pending;

    expect(fetch).toHaveBeenCalledWith("asset://C:/music/a.wav");
    expect(h.api.importExerciseFile).toHaveBeenCalledWith("C:\\music\\a.wav", 7.5);
    expect(useExerciseStore.getState().exerciseTakes.map((t) => t.id)).toEqual(["imp"]);
    expect(useExerciseStore.getState()).toMatchObject({ loadedTrackKind: "imported", loadedTrackId: "imp", isImporting: false });
  });

  it("clears the importing flag and rethrows when the backend fails", async () => {
    h.api.importExerciseFile.mockRejectedValue(new Error("sidecar"));
    await expect(useExerciseStore.getState().importExerciseFile("/a.wav", container)).rejects.toThrow("sidecar");
    expect(useExerciseStore.getState().isImporting).toBe(false);
    expect(useExerciseStore.getState().exerciseTakes).toEqual([]);
  });

  it("clears the importing flag when the file cannot be decoded", async () => {
    vi.stubGlobal("AudioContext", class {
      decodeAudioData = vi.fn(async () => { throw new Error("EncodingError"); });
      close = vi.fn(async () => {});
    });
    await expect(useExerciseStore.getState().importExerciseFile("/a.wav", container)).rejects.toThrow("EncodingError");
    expect(useExerciseStore.getState().isImporting).toBe(false);
    expect(h.api.importExerciseFile).not.toHaveBeenCalled();
  });
});
