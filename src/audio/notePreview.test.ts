import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface Voice { freq: number; type: string; started: number | null; stopped: number | null; gains: Array<[string, number, number?]> }

let voices: Voice[];
let contexts: FakeContext[];
let constructorBehaviour: (options: unknown) => void;

class FakeContext {
  currentTime = 1;
  state: AudioContextState = "running";
  destination = {};
  options: unknown;
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  constructor(options?: unknown) {
    constructorBehaviour(options);
    this.options = options;
    contexts.push(this);
  }
  createOscillator() {
    const voice: Voice = { freq: 0, type: "", started: null, stopped: null, gains: [] };
    voices.push(voice);
    return {
      set type(v: string) { voice.type = v; },
      frequency: { set value(v: number) { voice.freq = v; } },
      connect: vi.fn(),
      start: (t: number) => { voice.started = t; },
      stop: (t: number) => { voice.stopped = t; },
    };
  }
  createGain() {
    const voice = voices[voices.length - 1];
    return {
      gain: {
        value: 0.2,
        setValueAtTime: (v: number, t: number) => voice.gains.push(["set", v, t]),
        linearRampToValueAtTime: (v: number, t: number) => voice.gains.push(["lin", v, t]),
        exponentialRampToValueAtTime: (v: number, t: number) => voice.gains.push(["exp", v, t]),
        cancelScheduledValues: (t: number) => voice.gains.push(["cancel", t]),
      },
      connect: vi.fn(),
    };
  }
}

async function freshModule() {
  vi.resetModules();
  return import("./notePreview");
}

beforeEach(() => {
  voices = [];
  contexts = [];
  constructorBehaviour = () => {};
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("AudioContext", FakeContext);
});

afterEach(() => vi.useRealTimers());

describe("startPreviewNote", () => {
  it("plays a triangle tone at the note's frequency with a short attack", async () => {
    const { startPreviewNote } = await freshModule();
    const voice = startPreviewNote(69, null);
    expect(voice).not.toBeNull();
    expect(voices[0]).toMatchObject({ freq: 440, type: "triangle", started: 1 });
    expect(voices[0].gains[0]).toEqual(["set", 0, 1]);
    expect(voices[0].gains[1][0]).toBe("lin");
    expect(voices[0].gains[1][1]).toBeLessThan(0.5);
  });

  it("holds until released, then fades and stops the oscillator", async () => {
    const { startPreviewNote } = await freshModule();
    const voice = startPreviewNote(60, null)!;
    await vi.advanceTimersByTimeAsync(2000);
    expect(voices[0].stopped).toBeNull();
    contexts[0].currentTime = 3;
    voice.release();
    expect(voices[0].stopped).toBeGreaterThan(3);
    expect(voices[0].gains.some((g) => g[0] === "exp")).toBe(true);
  });

  it("release is idempotent", async () => {
    const { startPreviewNote } = await freshModule();
    const voice = startPreviewNote(60, null)!;
    voice.release();
    const gainEvents = voices[0].gains.length;
    voice.release();
    expect(voices[0].gains).toHaveLength(gainEvents);
  });

  it("auto-releases after the 6 s safety timeout if the mouseup was lost", async () => {
    const { startPreviewNote } = await freshModule();
    startPreviewNote(60, null);
    await vi.advanceTimersByTimeAsync(5900);
    expect(voices[0].stopped).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(voices[0].stopped).not.toBeNull();
  });

  it("does not auto-release a second time after a manual release", async () => {
    const { startPreviewNote } = await freshModule();
    const voice = startPreviewNote(60, null)!;
    voice.release();
    const events = voices[0].gains.length;
    await vi.advanceTimersByTimeAsync(7000);
    expect(voices[0].gains).toHaveLength(events);
  });

  it("reuses one context for the same output and replaces it when the output changes", async () => {
    const { startPreviewNote } = await freshModule();
    startPreviewNote(60, "a");
    startPreviewNote(62, "a");
    expect(contexts).toHaveLength(1);
    startPreviewNote(64, "b");
    expect(contexts).toHaveLength(2);
    expect(contexts[0].close).toHaveBeenCalled();
    expect(contexts[1].options).toEqual({ sinkId: "b" });
  });

  it("wakes a suspended context", async () => {
    const { startPreviewNote } = await freshModule();
    startPreviewNote(60, null);
    contexts[0].state = "suspended";
    startPreviewNote(60, null);
    expect(contexts[0].resume).toHaveBeenCalled();
  });

  it("falls back to the default output (with a warning) when the sink is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    constructorBehaviour = (options) => { if (options) throw new Error("bad sink"); };
    const { startPreviewNote } = await freshModule();
    const voice = startPreviewNote(60, "bad");
    expect(voice).not.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("returns null (with warnings) when no AudioContext can be built at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    constructorBehaviour = () => { throw new Error("no audio"); };
    const { startPreviewNote } = await freshModule();
    expect(startPreviewNote(60, null)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("shared preview state", () => {
  it("starts empty", async () => {
    const { getPreviewState } = await freshModule();
    expect(getPreviewState()).toEqual({ midi: null, startTime: 0, endTime: null });
  });

  it("tracks a held key, then freezes its end time on release", async () => {
    const { startPreview, endPreview, getPreviewState } = await freshModule();
    startPreview(60, 2);
    expect(getPreviewState()).toEqual({ midi: 60, startTime: 2, endTime: null });
    endPreview(3.5);
    expect(getPreviewState()).toEqual({ midi: 60, startTime: 2, endTime: 3.5 });
  });

  it("ignores a second release and a release with nothing pressed", async () => {
    const { startPreview, endPreview, getPreviewState } = await freshModule();
    endPreview(1);
    expect(getPreviewState().endTime).toBeNull();
    startPreview(60, 0);
    endPreview(1);
    endPreview(9);
    expect(getPreviewState().endTime).toBe(1);
  });

  it("a new press overwrites the frozen previous one", async () => {
    const { startPreview, endPreview, getPreviewState } = await freshModule();
    startPreview(60, 0);
    endPreview(1);
    startPreview(64, 5);
    expect(getPreviewState()).toEqual({ midi: 64, startTime: 5, endTime: null });
  });
});
