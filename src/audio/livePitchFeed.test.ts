import { describe, it, expect, vi } from "vitest";
import { createLivePitchFeed, type FeedDeps } from "./livePitchFeed";
import type { PitchPoint } from "../lib/types";

const ref = (time: number, frequency: number): PitchPoint => ({ time, frequency, confidence: 1 });
const STREAM = {} as MediaStream;

function setup(initial: Partial<ReturnType<FeedDeps["getPlayer"]>> = {}) {
  let player = {
    isRecording: false, isMonitoring: false, isPlaying: false, currentTime: 0, exerciseMode: false,
    ...initial,
  };
  let analysis = { songPitch: [ref(0, 220), ref(10, 220)], takePitch: [ref(0, 440), ref(10, 440)] };
  let reading: { frequency: number; cents: number } | null = null;
  const detector = {
    start: vi.fn(), stop: vi.fn(),
    getCurrentPitch: vi.fn(() => reading),
  };
  const appended: PitchPoint[] = [];
  const cents: (number | null)[] = [];
  const clear = vi.fn();
  let frame: (() => void) | null = null;
  let nextId = 1;
  const cancelled: number[] = [];

  const deps: FeedDeps = {
    getPlayer: () => player,
    getAnalysis: () => analysis,
    appendLivePitch: (p) => appended.push(p),
    clearLivePitch: clear,
    setLiveCents: (c) => cents.push(c),
    getStream: vi.fn((monitoring: boolean) => (monitoring ? STREAM : STREAM)),
    makeDetector: () => detector,
    requestFrame: (cb) => {
      frame = cb;
      return nextId++;
    },
    cancelFrame: (id) => {
      cancelled.push(id);
    },
  };

  return {
    deps, detector, appended, cents, clear, cancelled,
    setPlayer: (p: Partial<typeof player>) => {
      player = { ...player, ...p };
    },
    setAnalysis: (a: Partial<typeof analysis>) => {
      analysis = { ...analysis, ...a };
    },
    setReading: (r: typeof reading) => {
      reading = r;
    },
    runFrame: () => frame?.(),
    hasFrame: () => frame !== null,
  };
}

describe("live pitch feed", () => {
  it("does nothing while neither recording nor monitoring a song that is playing", () => {
    const t = setup();
    const feed = createLivePitchFeed(t.deps);
    feed.sync();
    expect(t.detector.start).not.toHaveBeenCalled();
    expect(t.hasFrame()).toBe(false);
    expect(t.clear).toHaveBeenCalled();
    expect(t.cents).toEqual([null]);
  });

  it("monitoring alone does not start it: the playhead must be moving", () => {
    const t = setup({ isMonitoring: true, isPlaying: false });
    createLivePitchFeed(t.deps).sync();
    expect(t.detector.start).not.toHaveBeenCalled();
  });

  it("starts for a recording, on the recorder stream", () => {
    const t = setup({ isRecording: true });
    createLivePitchFeed(t.deps).sync();
    expect(t.deps.getStream).toHaveBeenCalledWith(false);
    expect(t.detector.start).toHaveBeenCalledWith(STREAM);
    expect(t.clear).toHaveBeenCalled();
  });

  it("starts for monitoring while playing, on the monitor stream", () => {
    const t = setup({ isMonitoring: true, isPlaying: true });
    createLivePitchFeed(t.deps).sync();
    expect(t.deps.getStream).toHaveBeenCalledWith(true);
    expect(t.detector.start).toHaveBeenCalled();
  });

  it("does not start, and leaves the trace alone, when there is no stream yet", () => {
    const t = setup({ isRecording: true });
    (t.deps.getStream as ReturnType<typeof vi.fn>).mockReturnValue(null);
    createLivePitchFeed(t.deps).sync();
    expect(t.detector.start).not.toHaveBeenCalled();
    expect(t.clear).not.toHaveBeenCalled();
  });

  it("appends a point per frame at the playhead, and the deviation from the song", () => {
    const t = setup({ isRecording: true, currentTime: 4 });
    createLivePitchFeed(t.deps).sync();
    t.setReading({ frequency: 233.08, cents: 99 });
    t.runFrame();
    expect(t.appended).toEqual([{ time: 4, frequency: 233.08, confidence: 1 }]);
    expect(t.cents[t.cents.length - 1]).toBeCloseTo(100, 0);
  });

  it("compares against the loaded track in Free Exercise", () => {
    const t = setup({ isRecording: true, exerciseMode: true, currentTime: 2 });
    createLivePitchFeed(t.deps).sync();
    t.setReading({ frequency: 440, cents: 7 });
    t.runFrame();
    expect(t.cents[t.cents.length - 1]).toBeCloseTo(0, 5);
  });

  it("falls back to the detector's own cents when there is no reference at that moment", () => {
    const t = setup({ isRecording: true });
    t.setAnalysis({ songPitch: [] });
    createLivePitchFeed(t.deps).sync();
    t.setReading({ frequency: 300, cents: -12 });
    t.runFrame();
    expect(t.cents[t.cents.length - 1]).toBe(-12);
  });

  it("shows the cents but adds no point when the detector has no frequency", () => {
    const t = setup({ isRecording: true });
    t.setAnalysis({ songPitch: [] });
    createLivePitchFeed(t.deps).sync();
    t.setReading({ frequency: 0, cents: 3 });
    t.runFrame();
    expect(t.appended).toEqual([]);
    expect(t.cents[t.cents.length - 1]).toBe(3);
  });

  it("keeps going frame after frame", () => {
    const t = setup({ isRecording: true });
    createLivePitchFeed(t.deps).sync();
    t.setReading({ frequency: 220, cents: 0 });
    t.runFrame();
    t.runFrame();
    t.runFrame();
    expect(t.appended).toHaveLength(3);
  });

  it("does not restart when synced again with nothing changed", () => {
    const t = setup({ isRecording: true });
    const feed = createLivePitchFeed(t.deps);
    feed.sync();
    feed.sync();
    expect(t.detector.start).toHaveBeenCalledTimes(1);
  });

  it("stops, clears the trace and the gauge when it becomes inactive", () => {
    const t = setup({ isRecording: true });
    const feed = createLivePitchFeed(t.deps);
    feed.sync();
    t.clear.mockClear();
    t.setPlayer({ isRecording: false });
    feed.sync();
    expect(t.detector.stop).toHaveBeenCalled();
    expect(t.cancelled.length).toBeGreaterThan(0);
    expect(t.clear).toHaveBeenCalled();
    expect(t.cents[t.cents.length - 1]).toBeNull();
  });

  it("restarts with a clean trace when it switches from recording to monitoring", () => {
    const t = setup({ isRecording: true });
    const feed = createLivePitchFeed(t.deps);
    feed.sync();
    t.setPlayer({ isRecording: false, isMonitoring: true, isPlaying: true });
    feed.sync();
    expect(t.detector.start).toHaveBeenCalledTimes(2);
  });

  it("dispose stops everything", () => {
    const t = setup({ isRecording: true });
    const feed = createLivePitchFeed(t.deps);
    feed.sync();
    feed.dispose();
    expect(t.detector.stop).toHaveBeenCalled();
    expect(t.cancelled.length).toBeGreaterThan(0);
  });
});
