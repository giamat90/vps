import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startMainBridge, type AnalysisPort, type PlayerPort, type Store } from "./mainBridge";
import { EVT_COMMAND, EVT_DOCKED, EVT_HELLO, EVT_LIVE, EVT_STATE, type StateMessage, type LiveMessage } from "./protocol";
import type { PitchPoint, Take } from "../lib/types";

function fakeStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(patch: Partial<T>) {
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    get listenerCount() {
      return listeners.size;
    },
  } satisfies Store<T> & { set(p: Partial<T>): void; listenerCount: number };
}

const pt = (time: number): PitchPoint => ({ time, frequency: 220, confidence: 1 });
const take = (id: string, extra: Partial<Take> = {}) =>
  ({ id, songId: "s1", recordedAt: "now", filepath: `/t/${id}.wav`, startPosition: 0, ...extra }) as Take;

const SONG = { id: "s1", title: "Song", kind: "vocal" } as never;

function setup() {
  const seek = vi.fn();
  const setPunchIn = vi.fn();
  const setPunchOut = vi.fn();
  const clearPunch = vi.fn();
  const player = fakeStore<PlayerPort>({
    song: SONG, isPlaying: false, currentTime: 0, duration: 200, playbackRate: 1,
    isRecording: false, isMonitoring: false, exerciseMode: false,
    punchIn: null, punchOut: null, punchLoop: false, selectedOutputDeviceId: null,
    activeTakeId: null, takes: [],
    seek, setPunchIn, setPunchOut, clearPunch,
  });
  const analysis = fakeStore<AnalysisPort>({ livePitch: [], liveCents: null });

  const emitted: { event: string; payload: unknown }[] = [];
  const handlers = new Map<string, (p: unknown) => void>();
  const unlisten = vi.fn();
  let nowMs = 1_000_000;

  const deps = {
    player,
    analysis,
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
    },
    listen: async (event: string, cb: (p: unknown) => void) => {
      handlers.set(event, cb);
      return unlisten;
    },
    now: () => nowMs,
  };

  return {
    deps, player, analysis, emitted, unlisten,
    spies: { seek, setPunchIn, setPunchOut, clearPunch },
    deliver: (event: string, payload: unknown) => handlers.get(event)?.(payload),
    advance: (ms: number) => {
      nowMs += ms;
      vi.advanceTimersByTime(ms);
    },
    states: () => emitted.filter((e) => e.event === EVT_STATE).map((e) => e.payload as StateMessage),
    lives: () => emitted.filter((e) => e.event === EVT_LIVE).map((e) => e.payload as LiveMessage),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("main bridge: nothing detached", () => {
  it("publishes nothing and runs no timers until a window says hello", async () => {
    const t = setup();
    await startMainBridge(t.deps);
    t.player.set({ isPlaying: true, currentTime: 5 });
    t.analysis.set({ livePitch: [pt(1)] });
    t.advance(5000);
    expect(t.emitted).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a hello that names no known panel", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    await startMainBridge(t.deps);
    t.deliver(EVT_HELLO, { panelId: "takes" });
    t.deliver(EVT_HELLO, null);
    expect(t.emitted).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("main bridge: a window says hello", () => {
  it("answers with the whole picture: transport, shared state and the take", async () => {
    const t = setup();
    t.player.set({
      currentTime: 12, duration: 200, punchIn: 3, punchOut: 9, activeTakeId: "t1", takes: [take("t1"), take("t2")],
    });
    await startMainBridge(t.deps);
    t.deliver(EVT_HELLO, { panelId: "pianoRoll" });
    const [msg] = t.states();
    expect(msg.transport).toMatchObject({ time: 12, playing: false, rate: 1 });
    expect(msg.shared).toMatchObject({ song: SONG, duration: 200, punchIn: 3, punchOut: 9, isRecording: false });
    expect(msg.shared.activeTake?.id).toBe("t1");
  });

  it("sends the live trace that already exists, as a fresh start", async () => {
    const t = setup();
    t.analysis.set({ livePitch: [pt(1), pt(2)], liveCents: 6 });
    await startMainBridge(t.deps);
    t.deliver(EVT_HELLO, { panelId: "pianoRoll" });
    expect(t.lives()).toEqual([{ reset: true, points: [pt(1), pt(2)], cents: 6 }]);
  });

  it("repeats the whole picture for a second window", async () => {
    const t = setup();
    await startMainBridge(t.deps);
    t.deliver(EVT_HELLO, { panelId: "pianoRoll" });
    t.deliver(EVT_HELLO, { panelId: "lyrics" });
    expect(t.states()).toHaveLength(2);
  });
});

describe("main bridge: transport", () => {
  async function ready() {
    const t = setup();
    await startMainBridge(t.deps);
    t.deliver(EVT_HELLO, { panelId: "pianoRoll" });
    t.emitted.length = 0;
    return t;
  }

  it("publishes when playback starts", async () => {
    const t = await ready();
    t.player.set({ isPlaying: true });
    expect(t.states()).toHaveLength(1);
    expect(t.states()[0].transport.playing).toBe(true);
  });

  it("does not publish every time the time ticks forward as predicted", async () => {
    const t = await ready();
    t.player.set({ isPlaying: true });
    t.emitted.length = 0;
    for (let i = 1; i <= 20; i++) {
      t.advance(33);
      t.player.set({ currentTime: (i * 33) / 1000 });
    }
    expect(t.states()).toEqual([]);
  });

  it("publishes a seek", async () => {
    const t = await ready();
    t.player.set({ currentTime: 80 });
    expect(t.states()[0].transport).toMatchObject({ time: 80, playing: false });
  });

  it("sends a heartbeat while playing", async () => {
    const t = await ready();
    t.player.set({ isPlaying: true });
    t.emitted.length = 0;
    t.advance(1100);
    t.player.set({ currentTime: 1.1 });
    t.advance(300);
    expect(t.states().length).toBeGreaterThanOrEqual(1);
  });

  it("publishes a change to the shared state, such as the punch region", async () => {
    const t = await ready();
    t.player.set({ punchIn: 4, punchOut: 8 });
    expect(t.states()).toHaveLength(1);
    expect(t.states()[0].shared).toMatchObject({ punchIn: 4, punchOut: 8 });
  });

  it("publishes when the active take changes, with the take itself", async () => {
    const t = await ready();
    const a = take("t1");
    t.player.set({ takes: [a], activeTakeId: "t1" });
    expect(t.states()[t.states().length - 1]?.shared.activeTake).toBe(a);
    const moved = take("t1", { manualOffset: 0.2 });
    t.player.set({ takes: [moved] });
    expect(t.states()[t.states().length - 1]?.shared.activeTake).toBe(moved);
  });
});

describe("main bridge: live pitch", () => {
  it("batches points that arrive between flushes into one message", async () => {
    const t = setup();
    await startMainBridge(t.deps);
    t.deliver(EVT_HELLO, { panelId: "pianoRoll" });
    t.emitted.length = 0;
    t.analysis.set({ livePitch: [pt(1)] });
    t.analysis.set({ livePitch: [pt(1), pt(2)] });
    t.analysis.set({ livePitch: [pt(1), pt(2), pt(3)] });
    expect(t.lives()).toEqual([]);
    t.advance(40);
    expect(t.lives()).toEqual([{ reset: true, points: [pt(1), pt(2), pt(3)], cents: null }]);
  });

  it("then sends only the new points", async () => {
    const t = setup();
    await startMainBridge(t.deps);
    t.deliver(EVT_HELLO, { panelId: "pianoRoll" });
    const first = pt(1);
    const second = pt(2);
    t.analysis.set({ livePitch: [first] });
    t.advance(40);
    t.emitted.length = 0;
    t.analysis.set({ livePitch: [first, second], liveCents: -3 });
    t.advance(40);
    expect(t.lives()).toEqual([{ reset: false, points: [second], cents: -3 }]);
  });

  it("sends nothing while nothing changes", async () => {
    const t = setup();
    await startMainBridge(t.deps);
    t.deliver(EVT_HELLO, { panelId: "pianoRoll" });
    t.emitted.length = 0;
    t.advance(1000);
    expect(t.lives()).toEqual([]);
  });
});

describe("main bridge: commands from a detached window", () => {
  async function ready() {
    const t = setup();
    await startMainBridge(t.deps);
    t.deliver(EVT_HELLO, { panelId: "pianoRoll" });
    return t;
  }

  it("carries out a seek", async () => {
    const t = await ready();
    t.deliver(EVT_COMMAND, { type: "seek", time: 33 });
    expect(t.spies.seek).toHaveBeenCalledWith(33);
  });

  it("carries out the punch commands", async () => {
    const t = await ready();
    t.deliver(EVT_COMMAND, { type: "setPunchIn", time: 4 });
    t.deliver(EVT_COMMAND, { type: "setPunchOut", time: 8 });
    t.deliver(EVT_COMMAND, { type: "clearPunch" });
    expect(t.spies.setPunchIn).toHaveBeenCalledWith(4);
    expect(t.spies.setPunchOut).toHaveBeenCalledWith(8);
    expect(t.spies.clearPunch).toHaveBeenCalledTimes(1);
  });

  it("refuses anything it does not understand, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await ready();
    t.deliver(EVT_COMMAND, { type: "seek", time: "soon" });
    t.deliver(EVT_COMMAND, { type: "delete_everything" });
    t.deliver(EVT_COMMAND, 42);
    expect(t.spies.seek).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe("main bridge: windows closing and shutdown", () => {
  it("stops publishing, and stops its timers, once every window has docked", async () => {
    const t = setup();
    await startMainBridge(t.deps);
    t.deliver(EVT_HELLO, { panelId: "pianoRoll" });
    t.deliver(EVT_HELLO, { panelId: "lyrics" });
    t.deliver(EVT_DOCKED, "pianoRoll");
    t.emitted.length = 0;
    t.player.set({ punchIn: 1 });
    expect(t.states()).toHaveLength(1);

    t.deliver(EVT_DOCKED, "lyrics");
    t.emitted.length = 0;
    t.player.set({ punchIn: 2 });
    t.advance(2000);
    expect(t.emitted).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts from a clean slate when a window comes back after all had docked", async () => {
    const t = setup();
    await startMainBridge(t.deps);
    t.deliver(EVT_HELLO, { panelId: "pianoRoll" });
    t.deliver(EVT_DOCKED, "pianoRoll");
    t.emitted.length = 0;
    t.deliver(EVT_HELLO, { panelId: "pianoRoll" });
    expect(t.states()).toHaveLength(1);
  });

  it("dispose unsubscribes from the stores and the event bus and clears timers", async () => {
    const t = setup();
    const bridge = await startMainBridge(t.deps);
    t.deliver(EVT_HELLO, { panelId: "pianoRoll" });
    bridge.dispose();
    expect(t.player.listenerCount).toBe(0);
    expect(t.analysis.listenerCount).toBe(0);
    expect(t.unlisten).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
