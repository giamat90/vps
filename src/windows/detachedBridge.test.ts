import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startDetachedBridge, type DetachedBridgeDeps } from "./detachedBridge";
import {
  EVT_COMMAND, EVT_HELLO, EVT_LIVE, EVT_SPECTRUM, EVT_STATE,
  type SharedState, type SpectrumMessage, type StateMessage,
} from "./protocol";
import type { PitchPoint, Take } from "../lib/types";
import type { DetachablePanel } from "./protocol";

const pt = (time: number): PitchPoint => ({ time, frequency: 220, confidence: 1 });
const take = (id: string) => ({ id, songId: "s1", recordedAt: "now", filepath: `/t/${id}.wav`, startPosition: 0 }) as Take;
const SONG = { id: "s1", title: "Song", kind: "vocal" } as never;

const shared = (extra: Partial<SharedState> = {}): SharedState => ({
  song: SONG, duration: 200, isRecording: false, isMonitoring: false, exerciseMode: false,
  punchIn: null, punchOut: null, punchLoop: false, selectedOutputDeviceId: null, activeTake: null, shownTakeIds: [], takePlayback: "all", mutedTakeIds: [], soloedTakeId: null, takesSilenced: false, muteTakesWhileRecording: true, takes: [],
  ...extra,
});

const state = (
  transport: Partial<StateMessage["transport"]> = {},
  s: Partial<SharedState> = {},
): StateMessage => ({
  transport: { time: 0, playing: false, rate: 1, sentAt: 5000, ...transport },
  shared: shared(s),
});

function setup(panelId: DetachablePanel = "pianoRoll") {
  let playerState: Record<string, unknown> = {
    seek: () => {}, setPunchIn: () => {}, setPunchOut: () => {}, clearPunch: () => {},
    currentTime: 0, shownTakeIds: [], activeTakeId: null,
  };
  let analysisState: Record<string, unknown> = { livePitch: [], liveCents: null };
  const order: string[] = [];
  const emitted: { event: string; payload: unknown }[] = [];
  const handlers = new Map<string, (p: unknown) => void>();
  const unlisten = vi.fn();
  let nowMs = 5000;
  let timeSource: (() => number) | null = null;
  const uninstall = vi.fn(() => {
    timeSource = null;
  });

  const onSpectrum = vi.fn();
  const loadSongAnalysis = vi.fn(async () => {});
  const loadTakeAnalysis = vi.fn();
  const clearTakeAnalysis = vi.fn();

  const deps: DetachedBridgeDeps = {
    panelId,
    player: {
      getState: () => playerState as never,
      setState: (p) => {
        playerState = { ...playerState, ...p };
      },
    },
    analysis: {
      getState: () => analysisState as never,
      setState: (p) => {
        analysisState = { ...analysisState, ...p };
      },
    },
    emit: (event, payload) => {
      order.push(`emit:${event}`);
      emitted.push({ event, payload });
    },
    listen: async (event, cb) => {
      order.push(`listen:${event}`);
      handlers.set(event, cb);
      return unlisten;
    },
    now: () => nowMs,
    installTimeSource: (fn) => {
      timeSource = fn;
      return uninstall;
    },
    onSpectrum,
    loadSongAnalysis,
    loadTakeAnalysis,
    clearTakeAnalysis,
  };

  return {
    deps, emitted, order, unlisten, uninstall, onSpectrum, loadSongAnalysis, loadTakeAnalysis, clearTakeAnalysis,
    player: () => playerState,
    analysis: () => analysisState,
    timeSource: () => timeSource,
    deliver: (event: string, payload: unknown) => handlers.get(event)?.(payload),
    advance: (ms: number) => {
      nowMs += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("detached bridge: starting", () => {
  it("listens before it says hello, so the reply cannot be missed", async () => {
    const t = setup();
    await startDetachedBridge(t.deps);
    const hello = t.order.indexOf(`emit:${EVT_HELLO}`);
    expect(hello).toBeGreaterThan(-1);
    expect(t.order.indexOf(`listen:${EVT_STATE}`)).toBeLessThan(hello);
    expect(t.order.indexOf(`listen:${EVT_LIVE}`)).toBeLessThan(hello);
    expect(t.emitted.find((e) => e.event === EVT_HELLO)?.payload).toEqual({ panelId: "pianoRoll" });
  });

  it("gives the panels a playback time that is not the audio engine", async () => {
    const t = setup();
    await startDetachedBridge(t.deps);
    expect(t.timeSource()).not.toBeNull();
    t.deliver(EVT_STATE, state({ time: 10, playing: true, sentAt: 5000 }));
    t.advance(2000);
    expect(t.timeSource()?.()).toBeCloseTo(12, 6);
  });
});

describe("detached bridge: applying the main window state", () => {
  it("copies the shared fields into the player store", async () => {
    const t = setup();
    await startDetachedBridge(t.deps);
    t.deliver(EVT_STATE, state({ rate: 0.75, playing: true }, { duration: 321, punchIn: 2, punchOut: 6, isMonitoring: true, selectedOutputDeviceId: "out-1" }));
    expect(t.player()).toMatchObject({
      song: SONG, duration: 321, punchIn: 2, punchOut: 6, isMonitoring: true,
      selectedOutputDeviceId: "out-1", playbackRate: 0.75, isPlaying: true, isRecording: false,
    });
  });

  it("ignores a malformed message, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    await startDetachedBridge(t.deps);
    t.deliver(EVT_STATE, { transport: 1 });
    expect(t.player().duration).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("loads the song analysis once per song", async () => {
    const t = setup();
    await startDetachedBridge(t.deps);
    t.deliver(EVT_STATE, state());
    t.deliver(EVT_STATE, state({ time: 3 }));
    expect(t.loadSongAnalysis).toHaveBeenCalledTimes(1);
    expect(t.loadSongAnalysis).toHaveBeenCalledWith("s1");
    t.deliver(EVT_STATE, state({}, { song: { id: "s2", title: "Other" } as never }));
    expect(t.loadSongAnalysis).toHaveBeenLastCalledWith("s2");
    expect(t.loadSongAnalysis).toHaveBeenCalledTimes(2);
  });

  it("loads the active take's analysis when it appears or changes, and clears it when it goes", async () => {
    const t = setup();
    await startDetachedBridge(t.deps);
    const a = take("t1");
    t.deliver(EVT_STATE, state({}, { activeTake: a }));
    expect(t.loadTakeAnalysis).toHaveBeenCalledWith(a);
    t.deliver(EVT_STATE, state({ time: 1 }, { activeTake: a }));
    expect(t.loadTakeAnalysis).toHaveBeenCalledTimes(1);
    const moved = { ...a, manualOffset: 0.3 };
    t.deliver(EVT_STATE, state({}, { activeTake: moved }));
    expect(t.loadTakeAnalysis).toHaveBeenLastCalledWith(moved);
    t.deliver(EVT_STATE, state({}, { activeTake: null }));
    expect(t.clearTakeAnalysis).toHaveBeenCalledTimes(1);
  });

  it("does not clear a take that was never there", async () => {
    const t = setup();
    await startDetachedBridge(t.deps);
    t.deliver(EVT_STATE, state());
    expect(t.clearTakeAnalysis).not.toHaveBeenCalled();
  });
});

describe("detached bridge: takes", () => {
  const summary = (id: string) => ({ id, songId: "s1", recordedAt: "now", filepath: `/t/${id}.wav`, startPosition: 0 });

  it("mirrors the list of takes and which one is active", async () => {
    const t = setup("takes");
    await startDetachedBridge(t.deps);
    t.deliver(EVT_STATE, state({}, { takes: [summary("t1"), summary("t2")], activeTake: take("t2") }));
    expect((t.player().takes as unknown[]).length).toBe(2);
    expect(t.player().activeTakeId).toBe("t2");
  });

  it("turns select, delete and rename into commands", async () => {
    const t = setup("takes");
    await startDetachedBridge(t.deps);
    const p = t.player() as {
      toggleTake: (id: string) => void;
      deleteTake: (id: string) => Promise<void>;
      renameTake: (id: string, name: string) => Promise<void>;
    };
    p.toggleTake("t2");
    await p.deleteTake("t1");
    await p.renameTake("t2", "Verse");
    const commands = t.emitted.filter((e) => e.event === EVT_COMMAND).map((e) => e.payload);
    expect(commands).toEqual([
      { type: "toggleTake", id: "t2" },
      { type: "deleteTake", id: "t1" },
      { type: "renameTake", id: "t2", name: "Verse" },
    ]);
  });

  it("highlights a selected take at once, without waiting for the round trip", async () => {
    const t = setup("takes");
    await startDetachedBridge(t.deps);
    (t.player() as { toggleTake: (id: string) => void }).toggleTake("t2");
    expect(t.player().activeTakeId).toBe("t2");
    expect(t.player().shownTakeIds).toEqual(["t2"]);
  });

  it("shows several takes and hides the playing one on a second click, all locally first", async () => {
    const t = setup("takes");
    await startDetachedBridge(t.deps);
    const p = t.player() as { toggleTake: (id: string) => void };
    p.toggleTake("t1");
    p.toggleTake("t2");
    expect(t.player().shownTakeIds).toEqual(["t1", "t2"]);
    p.toggleTake("t2");
    expect(t.player().shownTakeIds).toEqual(["t1"]);
    expect(t.player().activeTakeId).toBe("t1");
  });

  it("mirrors which takes the main window shows", async () => {
    const t = setup("takes");
    await startDetachedBridge(t.deps);
    t.deliver(EVT_STATE, state({}, { takes: [summary("t1"), summary("t2")], activeTake: take("t2"), shownTakeIds: ["t1", "t2"] }));
    expect(t.player().shownTakeIds).toEqual(["t1", "t2"]);
  });
});

describe("detached bridge: spectrum", () => {
  it("hands each spectrum message to the spectrum source", async () => {
    const t = setup("spectrum");
    await startDetachedBridge(t.deps);
    const none = { f0: null, f1: null, f2: null, f3: null };
    const message: SpectrumMessage = { live: null, formants: { song: none, take: none, live: none } };
    t.deliver(EVT_SPECTRUM, message);
    expect(t.onSpectrum).toHaveBeenCalledWith(message);
  });

  it("ignores a malformed spectrum message, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup("spectrum");
    await startDetachedBridge(t.deps);
    t.deliver(EVT_SPECTRUM, { live: 3 });
    expect(t.onSpectrum).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe("detached bridge: the playhead", () => {
  it("advances currentTime in the store while playing, from the extrapolated clock", async () => {
    const t = setup();
    await startDetachedBridge(t.deps);
    t.deliver(EVT_STATE, state({ time: 20, playing: true }));
    t.advance(1000);
    expect(t.player().currentTime as number).toBeCloseTo(21, 1);
  });

  it("settles on the exact time when paused, then stops writing", async () => {
    const t = setup();
    await startDetachedBridge(t.deps);
    t.deliver(EVT_STATE, state({ time: 20, playing: true }));
    t.advance(500);
    t.deliver(EVT_STATE, state({ time: 20.5, playing: false, sentAt: 5500 }));
    t.advance(500);
    expect(t.player().currentTime).toBe(20.5);
  });
});

describe("detached bridge: live pitch", () => {
  it("replaces the trace on a reset and appends otherwise", async () => {
    const t = setup();
    await startDetachedBridge(t.deps);
    t.deliver(EVT_LIVE, { reset: true, points: [pt(1), pt(2)], cents: 5 });
    expect(t.analysis()).toMatchObject({ livePitch: [pt(1), pt(2)], liveCents: 5 });
    t.deliver(EVT_LIVE, { reset: false, points: [pt(3)], cents: -2 });
    expect(t.analysis()).toMatchObject({ livePitch: [pt(1), pt(2), pt(3)], liveCents: -2 });
    t.deliver(EVT_LIVE, { reset: true, points: [], cents: null });
    expect(t.analysis()).toMatchObject({ livePitch: [], liveCents: null });
  });

  it("ignores a malformed live message, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    await startDetachedBridge(t.deps);
    t.deliver(EVT_LIVE, { reset: "yes" });
    expect(t.analysis()).toMatchObject({ livePitch: [] });
    expect(warn).toHaveBeenCalled();
  });
});

describe("detached bridge: interacting", () => {
  it("turns the store actions the panels call into commands to the main window", async () => {
    const t = setup();
    await startDetachedBridge(t.deps);
    const p = t.player() as { seek: (n: number) => void; setPunchIn: (n: number) => void; setPunchOut: (n: number) => void; clearPunch: () => void };
    p.seek(42);
    p.setPunchIn(3);
    p.setPunchOut(9);
    p.clearPunch();
    const commands = t.emitted.filter((e) => e.event === EVT_COMMAND).map((e) => e.payload);
    expect(commands).toEqual([
      { type: "seek", time: 42 },
      { type: "setPunchIn", time: 3 },
      { type: "setPunchOut", time: 9 },
      { type: "clearPunch" },
    ]);
  });

  it("moves the local playhead at once on a seek, so the panel does not wait for the round trip", async () => {
    const t = setup();
    await startDetachedBridge(t.deps);
    (t.player() as { seek: (n: number) => void }).seek(42);
    expect(t.player().currentTime).toBe(42);
  });
});

describe("detached bridge: dispose", () => {
  it("stops listening and stops the clock", async () => {
    const t = setup();
    const bridge = await startDetachedBridge(t.deps);
    bridge.dispose();
    expect(t.unlisten).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.uninstall).toHaveBeenCalledTimes(1);
    expect(t.timeSource()).toBeNull();
  });
});
