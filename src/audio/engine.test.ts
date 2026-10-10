import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── fake WaveSurfer ───────────────────────────────────────────────────────

const ws = vi.hoisted(() => {
  const instances: any[] = [];
  const config = { autoReady: true, failWith: null as unknown, readyDuration: 100 };

  class FakeWS {
    handlers = new Map<string, Set<(...a: any[]) => void>>();
    duration: number;
    currentTime = 0;
    width = 1000;
    decoded: any = null;
    options: any;
    play = vi.fn();
    pause = vi.fn();
    destroy = vi.fn();
    load = vi.fn();
    seekTo = vi.fn((progress: number) => { this.currentTime = progress * this.duration; });
    setTime = vi.fn((t: number) => { this.currentTime = t; });
    setVolume = vi.fn();
    setPlaybackRate = vi.fn();
    setSinkId = vi.fn(async () => {});
    setOptions = vi.fn();
    zoom = vi.fn();
    setScrollTime = vi.fn();
    getWidth = vi.fn(() => this.width);
    getDuration = vi.fn(() => this.duration);
    getCurrentTime = vi.fn(() => this.currentTime);
    getDecodedData = vi.fn(() => this.decoded);

    constructor(options: any) {
      this.options = options;
      this.duration = config.readyDuration;
      instances.push(this);
      if (config.autoReady) {
        queueMicrotask(() => {
          if (config.failWith !== null) this.emit("error", config.failWith);
          else this.emit("ready");
        });
      }
    }

    on(event: string, cb: (...a: any[]) => void) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(cb);
      return () => { this.handlers.get(event)?.delete(cb); };
    }

    emit(event: string, ...args: any[]) {
      [...(this.handlers.get(event) ?? [])].forEach((cb) => cb(...args));
    }
  }

  return { instances, config, FakeWS };
});

vi.mock("wavesurfer.js", () => ({ default: { create: (options: unknown) => new ws.FakeWS(options) } }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));

import { AudioEngine } from "./engine";

// ─── time and animation-frame control ──────────────────────────────────────

let now = 0;
let frames: Array<() => void> = [];
let nextFrameId = 1;

function runFrame(advanceMs = 16) {
  now += advanceMs;
  const batch = frames;
  frames = [];
  batch.forEach((cb) => cb());
}

const container = () => ({ style: {} as Record<string, string> }) as unknown as HTMLElement;
const style = (el: HTMLElement) => (el as unknown as { style: Record<string, string> }).style;

async function loadedEngine() {
  const engine = new AudioEngine();
  await engine.load("C:\\lib\\song", {} as HTMLElement, {} as HTMLElement);
  const [vocals, instrumental] = ws.instances.slice(-2);
  return { engine, vocals, instrumental };
}

async function reloadVocals(engine: AudioEngine, vocals: any, offset: number, duration?: number) {
  if (duration !== undefined) vocals.duration = duration;
  const loading = engine.loadVocalsFromPath("/p/v.wav", offset);
  await Promise.resolve();
  vocals.emit("ready");
  await loading;
}

async function withTake(engine: AudioEngine, opts: { duration: number; start: number; audioOffset?: number; manual?: number }) {
  ws.config.readyDuration = opts.duration;
  const el = container();
  await engine.loadTakeTrack("/t.wav", el, opts.start, opts.audioOffset ?? 0, opts.manual ?? 0);
  return { take: ws.instances[ws.instances.length - 1], el };
}

beforeEach(() => {
  ws.instances.length = 0;
  ws.config.autoReady = true;
  ws.config.failWith = null;
  ws.config.readyDuration = 100;
  now = 1000;
  frames = [];
  nextFrameId = 1;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => { frames.push(cb); return nextFrameId++; });
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
});

afterEach(() => {
  frames = [];
});

// ─── loading ───────────────────────────────────────────────────────────────

describe("load", () => {
  it("creates one WaveSurfer per stem from forward-slashed asset URLs and takes the duration from the instrumental", async () => {
    ws.config.readyDuration = 215;
    const { engine, vocals, instrumental } = await loadedEngine();
    expect(vocals.options.url).toBe("asset://C:/lib/song/vocals.wav");
    expect(instrumental.options.url).toBe("asset://C:/lib/song/instrumental.wav");
    expect(engine.getDuration()).toBe(215);
  });

  it("rejects with a descriptive error when a stem fails to decode", async () => {
    ws.config.failWith = new Error("bad header");
    const engine = new AudioEngine();
    await expect(engine.load("/s", {} as HTMLElement, {} as HTMLElement)).rejects.toThrow(/failed to load: bad header/);
  });

  it("re-applies the remembered output device to both stems", async () => {
    const engine = new AudioEngine();
    await engine.setOutputDevice("out-1");
    await engine.load("/s", {} as HTMLElement, {} as HTMLElement);
    const [vocals, instrumental] = ws.instances;
    expect(vocals.setSinkId).toHaveBeenCalledWith("out-1");
    expect(instrumental.setSinkId).toHaveBeenCalledWith("out-1");
  });

  it("destroys previous instances when loading again", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    await engine.load("/other", {} as HTMLElement, {} as HTMLElement);
    expect(vocals.destroy).toHaveBeenCalled();
    expect(instrumental.destroy).toHaveBeenCalled();
  });

  it("resolves quietly when destroyed while still loading (React StrictMode cleanup)", async () => {
    ws.config.autoReady = false;
    const engine = new AudioEngine();
    const loading = engine.load("/s", {} as HTMLElement, {} as HTMLElement);
    const [vocals, instrumental] = ws.instances;
    engine.destroy();
    vocals.emit("ready");
    instrumental.emit("ready");
    await expect(loading).resolves.toBe(false);
    expect(engine.getDuration()).toBe(0);
  });

  it("reports that the stems are live once they have decoded", async () => {
    const engine = new AudioEngine();
    await expect(engine.load("/s", {} as HTMLElement, {} as HTMLElement)).resolves.toBe(true);
  });

  it("tells a load that a newer load replaced it, even when its own stems finish decoding late", async () => {
    ws.config.autoReady = false;
    const engine = new AudioEngine();
    const first = engine.load("/s", {} as HTMLElement, {} as HTMLElement);
    const [firstVocals, firstInstrumental] = ws.instances;
    const second = engine.load("/s", {} as HTMLElement, {} as HTMLElement);
    const [secondVocals, secondInstrumental] = ws.instances.slice(2);
    firstVocals.emit("ready");
    firstInstrumental.emit("ready");
    await expect(first).resolves.toBe(false);
    expect(engine.getDuration()).toBe(0);
    secondVocals.emit("ready");
    secondInstrumental.emit("ready");
    await expect(second).resolves.toBe(true);
    expect(engine.getDuration()).toBe(100);
  });
});

// ─── transport and seeking ─────────────────────────────────────────────────

describe("transport", () => {
  it("plays and pauses both stems and reports state", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    engine.play();
    expect(vocals.play).toHaveBeenCalled();
    expect(instrumental.play).toHaveBeenCalled();
    expect(engine.isPlaying).toBe(true);
    engine.pause();
    expect(vocals.pause).toHaveBeenCalled();
    expect(engine.isPlaying).toBe(false);
  });

  it("togglePlay flips", async () => {
    const { engine } = await loadedEngine();
    engine.togglePlay();
    expect(engine.isPlaying).toBe(true);
    engine.togglePlay();
    expect(engine.isPlaying).toBe(false);
  });

  it("does nothing before a song is loaded", () => {
    const engine = new AudioEngine();
    expect(() => { engine.play(); engine.pause(); engine.seekTo(3); engine.stop(); }).not.toThrow();
    expect(engine.isPlaying).toBe(false);
  });

  it("stop pauses and rewinds both stems", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    engine.play();
    engine.stop();
    expect(instrumental.seekTo).toHaveBeenLastCalledWith(0);
    expect(vocals.seekTo).toHaveBeenLastCalledWith(0);
    expect(engine.isPlaying).toBe(false);
  });

  it("seekTo converts seconds to a clamped 0..1 progress on every stem", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    engine.seekTo(25);
    expect(instrumental.seekTo).toHaveBeenLastCalledWith(0.25);
    expect(vocals.seekTo).toHaveBeenLastCalledWith(0.25);
    engine.seekTo(-5);
    expect(instrumental.seekTo).toHaveBeenLastCalledWith(0);
    engine.seekTo(500);
    expect(instrumental.seekTo).toHaveBeenLastCalledWith(1);
  });

  it("reads the playhead from the instrumental", async () => {
    const { engine, instrumental } = await loadedEngine();
    instrumental.currentTime = 12.5;
    expect(engine.getCurrentTime()).toBe(12.5);
  });

  it("applies and remembers playback rate", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    engine.setPlaybackRate(0.8);
    expect(vocals.setPlaybackRate).toHaveBeenCalledWith(0.8);
    expect(instrumental.setPlaybackRate).toHaveBeenCalledWith(0.8);
    const { take } = await withTake(engine, { duration: 10, start: 0 });
    expect(take.setPlaybackRate).toHaveBeenCalledWith(0.8);
  });

  it("volume setters reach the right stem", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    engine.setVocalsVolume(0.4);
    engine.setInstrumentalVolume(0.9);
    expect(vocals.setVolume).toHaveBeenCalledWith(0.4);
    expect(instrumental.setVolume).toHaveBeenCalledWith(0.9);
    const { take } = await withTake(engine, { duration: 10, start: 0 });
    engine.setTakeVolume(0.2);
    expect(take.setVolume).toHaveBeenCalledWith(0.2);
  });

  it("setInteract toggles click-to-seek on both stems", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    engine.setInteract(false);
    expect(vocals.setOptions).toHaveBeenCalledWith({ interact: false });
    expect(instrumental.setOptions).toHaveBeenCalledWith({ interact: false });
  });

  it("setOutputDevice reaches every live instance and survives having none", async () => {
    await expect(new AudioEngine().setOutputDevice("x")).resolves.toBeUndefined();
    const { engine, vocals, instrumental } = await loadedEngine();
    await engine.setOutputDevice("dev");
    expect(vocals.setSinkId).toHaveBeenLastCalledWith("dev");
    expect(instrumental.setSinkId).toHaveBeenLastCalledWith("dev");
  });
});

describe("user clicks on a waveform keep the others in sync", () => {
  it("clicking the instrumental seeks vocals (not itself)", async () => {
    const { vocals, instrumental } = await loadedEngine();
    instrumental.seekTo.mockClear();
    instrumental.emit("interaction", 40);
    expect(vocals.seekTo).toHaveBeenLastCalledWith(0.4);
    expect(instrumental.seekTo).not.toHaveBeenCalled();
  });

  it("clicking the vocals seeks the instrumental, mapping through the vocals start offset", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    await reloadVocals(engine, vocals, 10);
    vocals.seekTo.mockClear();
    vocals.emit("interaction", 20);
    expect(instrumental.seekTo).toHaveBeenLastCalledWith(0.3);
    expect(vocals.seekTo).not.toHaveBeenCalled();
  });
});

describe("loadVocalsFromPath", () => {
  it("reloads the stem, resumes if it was playing, and resyncs to the instrumental", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    instrumental.currentTime = 30;
    engine.play();
    vocals.play.mockClear();
    vocals.duration = 60;
    const loading = engine.loadVocalsFromPath("C:\\p\\v.wav", 0);
    await Promise.resolve();
    vocals.emit("ready");
    await loading;
    expect(vocals.load).toHaveBeenCalledWith("asset://C:/p/v.wav");
    expect(vocals.seekTo).toHaveBeenLastCalledWith(0.5);
    expect(vocals.play).toHaveBeenCalled();
  });

  it("rejects when the new file fails to load", async () => {
    const { engine, vocals } = await loadedEngine();
    const loading = engine.loadVocalsFromPath("/bad.wav");
    await Promise.resolve();
    vocals.emit("error", new Error("corrupt"));
    await expect(loading).rejects.toThrow("corrupt");
  });

  it("is a no-op without a loaded song", async () => {
    await expect(new AudioEngine().loadVocalsFromPath("/x")).resolves.toBeUndefined();
  });

  it("loadInstrumentalFromPath loads the asset URL", async () => {
    const { engine, instrumental } = await loadedEngine();
    engine.loadInstrumentalFromPath("C:\\p\\i.wav");
    expect(instrumental.load).toHaveBeenCalledWith("asset://C:/p/i.wav");
  });
});

// ─── take track ────────────────────────────────────────────────────────────

describe("take track", () => {
  it("sizes and positions the take rail from its start time, audio offset and the current zoom", async () => {
    const { engine } = await loadedEngine();
    engine.zoomAll(10, 5);
    const { take, el } = await withTake(engine, { duration: 30, start: 20, audioOffset: 2, manual: 1 });
    expect(style(el).width).toBe(`${(30 - 2) * 10}px`);
    expect(style(el).marginLeft).toBe(`${(20 + 1 - 5) * 10}px`);
    expect(take.setOptions).toHaveBeenCalledWith({ width: 280 });
  });

  it("seeks the take to the file position that matches the song position", async () => {
    const { engine, instrumental } = await loadedEngine();
    instrumental.currentTime = 25;
    const { take } = await withTake(engine, { duration: 40, start: 20, audioOffset: 2 });
    expect(take.seekTo).toHaveBeenLastCalledWith((2 + 5) / 40);
  });

  it("keeps the take at its first sample before the take starts", async () => {
    const { engine } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 40, start: 20, audioOffset: 2 });
    engine.seekTo(5);
    expect(take.seekTo).toHaveBeenLastCalledWith(2 / 40);
  });

  it("clamps the take position at its last sample when seeking past its end", async () => {
    const { engine } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 10, start: 20 });
    engine.seekTo(90);
    expect(take.seekTo).toHaveBeenLastCalledWith(1);
  });

  it("starts playing the take only when the playhead is inside its window", async () => {
    const { engine, instrumental } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 10, start: 20 });
    instrumental.currentTime = 5;
    engine.play();
    expect(take.play).not.toHaveBeenCalled();
    engine.pause();
    instrumental.currentTime = 22;
    engine.play();
    expect(take.play).toHaveBeenCalledTimes(1);
  });

  it("clicking the take seeks the song to the matching time (undoing audio and manual offsets)", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 40, start: 20, audioOffset: 2, manual: 1 });
    instrumental.seekTo.mockClear();
    vocals.seekTo.mockClear();
    take.emit("interaction", 12);
    const songTime = 12 - 2 + 20 + 1;
    expect(instrumental.seekTo).toHaveBeenLastCalledWith(songTime / 100);
    expect(vocals.seekTo).toHaveBeenLastCalledWith(songTime / 100);
  });

  it("setTakeManualOffset moves the rail and re-aims the take at the playhead", async () => {
    const { engine, instrumental } = await loadedEngine();
    engine.zoomAll(10, 0);
    const { take, el } = await withTake(engine, { duration: 20, start: 10 });
    instrumental.currentTime = 15;
    engine.setTakeManualOffset(2);
    expect(style(el).marginLeft).toBe(`${(10 + 2) * 10}px`);
    expect(take.seekTo).toHaveBeenLastCalledWith((15 - 12) / 20);
  });

  it("clearTakeTrack destroys it and forgets its offsets", async () => {
    const { engine } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 20, start: 10 });
    engine.clearTakeTrack();
    expect(take.destroy).toHaveBeenCalled();
    expect(engine.take).toBeNull();
    expect(() => engine.setTakeManualOffset(1)).not.toThrow();
  });

  it("replacing the take destroys the old one", async () => {
    const { engine } = await loadedEngine();
    const first = await withTake(engine, { duration: 20, start: 0 });
    await withTake(engine, { duration: 20, start: 0 });
    expect(first.take.destroy).toHaveBeenCalled();
  });

  it("rejects with the WaveSurfer message when the take cannot load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { engine } = await loadedEngine();
    ws.config.failWith = new Error("decode failure");
    await expect(engine.loadTakeTrack("/t.wav", container())).rejects.toThrow("decode failure");
  });

  it("resumes the take mid-play when loaded while the playhead is inside its window", async () => {
    const { engine, instrumental } = await loadedEngine();
    instrumental.currentTime = 12;
    engine.play();
    const { take } = await withTake(engine, { duration: 10, start: 10 });
    expect(take.play).toHaveBeenCalled();
  });
});

// ─── animation-frame tick ──────────────────────────────────────────────────

describe("playback tick", () => {
  it("notifies the UI at most every 33 ms but runs every frame", async () => {
    const { engine, instrumental } = await loadedEngine();
    const cb = vi.fn();
    engine.onTimeUpdate(cb);
    instrumental.currentTime = 1;
    engine.play();
    runFrame(16);
    runFrame(16);
    runFrame(16);
    runFrame(16);
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(cb.mock.calls.length).toBeLessThanOrEqual(3);
    expect(cb).toHaveBeenCalledWith(1);
  });

  it("stops scheduling frames after pause", async () => {
    const { engine } = await loadedEngine();
    engine.play();
    engine.pause();
    expect(frames).toHaveLength(0);
  });

  it("loops from loopEnd back to loopStart", async () => {
    const { engine, instrumental } = await loadedEngine();
    engine.setLoop(10, 20);
    engine.play();
    instrumental.currentTime = 20.01;
    runFrame();
    expect(instrumental.seekTo).toHaveBeenLastCalledWith(0.1);
    engine.clearLoop();
    instrumental.seekTo.mockClear();
    instrumental.currentTime = 25;
    runFrame();
    expect(instrumental.seekTo).not.toHaveBeenCalled();
  });

  it("starts and stops the take as the playhead enters and leaves its window", async () => {
    const { engine, instrumental } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 10, start: 20 });
    instrumental.currentTime = 5;
    engine.play();
    runFrame();
    expect(take.play).not.toHaveBeenCalled();

    instrumental.currentTime = 21;
    runFrame();
    expect(take.play).toHaveBeenCalledTimes(1);
    runFrame();
    expect(take.play).toHaveBeenCalledTimes(1);

    instrumental.currentTime = 31;
    runFrame();
    expect(take.pause).toHaveBeenCalled();
  });

  it("pulls vocals back when they drift more than 50 ms from the instrumental", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    instrumental.currentTime = 10;
    vocals.currentTime = 10.2;
    engine.play();
    runFrame(300);
    expect(vocals.setTime).toHaveBeenCalledWith(10);
  });

  it("leaves vocals alone within tolerance", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    instrumental.currentTime = 10;
    vocals.currentTime = 10.03;
    engine.play();
    runFrame(300);
    expect(vocals.setTime).not.toHaveBeenCalled();
  });

  it("pulls the muted instrumental toward the audible vocals, never the reverse", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    engine.setInstrumentalVolume(0);
    engine.setVocalsVolume(1);
    instrumental.currentTime = 11;
    vocals.currentTime = 10;
    engine.play();
    runFrame(300);
    expect(instrumental.setTime).toHaveBeenCalledWith(10);
    expect(vocals.setTime).not.toHaveBeenCalled();
  });

  it("does not chase vocals that have already ended", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    await reloadVocals(engine, vocals, 0, 50);
    vocals.setTime.mockClear();
    instrumental.currentTime = 80;
    vocals.currentTime = 50;
    engine.play();
    runFrame(300);
    expect(vocals.setTime).not.toHaveBeenCalled();
  });

  it("re-aims a drifting take", async () => {
    const { engine, instrumental } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 30, start: 10 });
    instrumental.currentTime = 15;
    engine.play();
    take.currentTime = 7;
    runFrame(300);
    expect(take.setTime).toHaveBeenCalledWith(5);
  });

  it("auto-follows the playhead when zoomed in and it passes the right margin", async () => {
    const { engine, instrumental } = await loadedEngine();
    engine.zoomAll(20, 0);
    const scroll = vi.fn();
    engine.onScrollChange(scroll);
    instrumental.currentTime = 48;
    engine.play();
    runFrame(1000);
    expect(scroll).toHaveBeenCalled();
    const [px, t] = scroll.mock.calls[0];
    expect(px).toBe(20);
    expect(t).toBeCloseTo(48 - 50 * 0.85, 9);
  });

  it("does not auto-follow right after a manual pan or zoom", async () => {
    const { engine, instrumental } = await loadedEngine();
    engine.zoomAll(20, 0);
    const scroll = vi.fn();
    engine.onScrollChange(scroll);
    instrumental.currentTime = 48;
    engine.play();
    engine.noteManualScrollInteraction();
    runFrame(100);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("does not auto-follow when fully zoomed out", async () => {
    const { engine, instrumental } = await loadedEngine();
    const scroll = vi.fn();
    engine.onScrollChange(scroll);
    engine.zoomAll(engine.getMinPxPerSec(), 0);
    instrumental.currentTime = 99;
    engine.play();
    runFrame(1000);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("scrolls back when the playhead is left of the visible window", async () => {
    const { engine, instrumental } = await loadedEngine();
    engine.zoomAll(20, 30);
    const scroll = vi.fn();
    engine.onScrollChange(scroll);
    instrumental.currentTime = 10;
    engine.play();
    runFrame(1000);
    expect(scroll).toHaveBeenCalled();
    expect(scroll.mock.calls[0][1]).toBeLessThan(30);
  });

  it("reports the end of the song and stops ticking", async () => {
    const { engine, instrumental } = await loadedEngine();
    const finish = vi.fn();
    engine.onFinish(finish);
    engine.play();
    instrumental.emit("finish");
    expect(finish).toHaveBeenCalled();
    expect(engine.isPlaying).toBe(false);
    expect(frames).toHaveLength(0);
  });
});

describe("zoom", () => {
  it("baseline zoom makes the whole song fill the viewport", async () => {
    const { engine, instrumental } = await loadedEngine();
    instrumental.width = 800;
    expect(engine.getMinPxPerSec()).toBe(8);
  });

  it("falls back to 1 px/s with no song or zero width", async () => {
    expect(new AudioEngine().getMinPxPerSec()).toBe(1);
    const { engine, instrumental } = await loadedEngine();
    instrumental.width = 0;
    expect(engine.getMinPxPerSec()).toBe(1);
  });

  it("zoomAll and setScrollAll drive every instance", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    engine.zoomAll(15, 4);
    for (const i of [vocals, instrumental]) {
      expect(i.zoom).toHaveBeenCalledWith(15);
      expect(i.setScrollTime).toHaveBeenCalledWith(4);
    }
    engine.setScrollAll(9);
    expect(vocals.setScrollTime).toHaveBeenLastCalledWith(9);
  });
});

// ─── free exercise ─────────────────────────────────────────────────────────

describe("exercise timer", () => {
  it("measures wall-clock time while running and freezes it on pause", () => {
    const engine = new AudioEngine();
    engine.startExerciseTimer();
    expect(engine.isPlaying).toBe(true);
    now += 2500;
    expect(engine.getCurrentTime()).toBeCloseTo(2.5, 9);
    engine.pauseExerciseTimer();
    now += 5000;
    expect(engine.getCurrentTime()).toBeCloseTo(2.5, 9);
    expect(engine.isPlaying).toBe(false);
  });

  it("stop resets to zero and notifies the UI of time 0", () => {
    const engine = new AudioEngine();
    const cb = vi.fn();
    engine.onTimeUpdate(cb);
    engine.startExerciseTimer();
    now += 1000;
    engine.stopExerciseTimer();
    expect(engine.getCurrentTime()).toBe(0);
    expect(cb).toHaveBeenLastCalledWith(0);
    expect(engine.isPlaying).toBe(false);
  });

  it("pause is a no-op when the timer is not running", () => {
    const engine = new AudioEngine();
    engine.pauseExerciseTimer();
    expect(engine.getCurrentTime()).toBe(0);
  });
});

describe("exercise track", () => {
  async function loaded(duration = 20) {
    ws.config.readyDuration = duration;
    const engine = new AudioEngine();
    await engine.loadExerciseTrack("C:\\ex\\a.webm", {} as HTMLElement);
    return { engine, track: ws.instances[ws.instances.length - 1] };
  }

  it("loads from an asset URL and becomes the authoritative clock", async () => {
    const { engine, track } = await loaded();
    expect(track.options.url).toBe("asset://C:/ex/a.webm");
    track.currentTime = 7;
    engine.startExerciseTimer();
    expect(engine.getCurrentTime()).toBe(7);
  });

  it("seekTo is routed to the exercise track with a clamped progress", async () => {
    const { engine, track } = await loaded(20);
    engine.seekTo(5);
    expect(track.seekTo).toHaveBeenLastCalledWith(0.25);
    engine.seekExerciseTrack(-3);
    expect(track.seekTo).toHaveBeenLastCalledWith(0);
    engine.seekExerciseTrack(999);
    expect(track.seekTo).toHaveBeenLastCalledWith(1);
  });

  it("ignores a seek on a zero-length track", async () => {
    const { engine, track } = await loaded(0);
    engine.seekExerciseTrack(3);
    expect(track.seekTo).not.toHaveBeenCalled();
  });

  it("plays, pauses and reports the end", async () => {
    const { engine, track } = await loaded();
    const finish = vi.fn();
    engine.onFinish(finish);
    engine.playExerciseTrack();
    expect(track.play).toHaveBeenCalled();
    expect(engine.isPlaying).toBe(true);
    engine.pauseExerciseTrack();
    expect(engine.isPlaying).toBe(false);
    track.emit("finish");
    expect(finish).toHaveBeenCalled();
  });

  it("a click on the waveform seeks it", async () => {
    const { track } = await loaded(20);
    track.emit("interaction", 10);
    expect(track.seekTo).toHaveBeenLastCalledWith(0.5);
  });

  it("drops the instance and rethrows when loading fails, so the clock does not stay hijacked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ws.config.failWith = new Error("EncodingError");
    const engine = new AudioEngine();
    await expect(engine.loadExerciseTrack("/x", {} as HTMLElement)).rejects.toThrow("EncodingError");
    expect(engine.exerciseTrack).toBeNull();
    expect(engine.getCurrentTime()).toBe(0);
  });

  it("clearExerciseTrack destroys it and stops playback", async () => {
    const { engine, track } = await loaded();
    engine.playExerciseTrack();
    engine.clearExerciseTrack();
    expect(track.destroy).toHaveBeenCalled();
    expect(engine.exerciseTrack).toBeNull();
    expect(engine.isPlaying).toBe(false);
  });

  it("playing and pausing without a track is harmless", () => {
    const engine = new AudioEngine();
    expect(() => { engine.playExerciseTrack(); engine.pauseExerciseTrack(); engine.seekExerciseTrack(1); }).not.toThrow();
  });
});

// ─── sample extraction for the spectrum panels ─────────────────────────────

function fakeBuffer(channels: Float32Array[], sampleRate: number) {
  return { numberOfChannels: channels.length, sampleRate, getChannelData: (c: number) => channels[c] };
}
const ramp = (n: number, f: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => f(i));

describe("getExerciseTrackSamples", () => {
  async function engineWith(buffer: unknown, time: number) {
    const engine = new AudioEngine();
    await engine.loadExerciseTrack("/x", {} as HTMLElement);
    const track = ws.instances[ws.instances.length - 1];
    track.decoded = buffer;
    track.currentTime = time;
    return engine;
  }

  it("is null without a track or decoded data", async () => {
    expect(new AudioEngine().getExerciseTrackSamples(8)).toBeNull();
    expect((await engineWith(null, 0)).getExerciseTrackSamples(8)).toBeNull();
  });

  it("returns the window ending at the playhead on channel 0 by default", async () => {
    const left = ramp(100, (i) => i);
    const right = ramp(100, (i) => -i);
    const engine = await engineWith(fakeBuffer([left, right], 10), 5);
    expect(Array.from(engine.getExerciseTrackSamples(4)!)).toEqual([46, 47, 48, 49]);
  });

  it("with matchStoredFrames centres the window on the playhead and averages channels", async () => {
    const left = ramp(100, (i) => i);
    const right = ramp(100, (i) => i + 2);
    const engine = await engineWith(fakeBuffer([left, right], 10), 5);
    expect(Array.from(engine.getExerciseTrackSamples(4, true)!)).toEqual([49, 50, 51, 52]);
  });

  it("zero-fills outside the file", async () => {
    const engine = await engineWith(fakeBuffer([ramp(10, () => 1)], 10), 0.2);
    expect(Array.from(engine.getExerciseTrackSamples(4)!)).toEqual([0, 0, 1, 1]);
    const end = await engineWith(fakeBuffer([ramp(10, () => 1)], 10), 0.9);
    expect(Array.from(end.getExerciseTrackSamples(4)!)).toEqual([1, 1, 1, 1]);
    const past = await engineWith(fakeBuffer([ramp(10, () => 1)], 10), 1.1);
    expect(Array.from(past.getExerciseTrackSamples(4)!)).toEqual([1, 1, 1, 0]);
  });

  it("exposes the sample rate", async () => {
    expect((await engineWith(fakeBuffer([ramp(4, () => 0)], 48000), 0)).getExerciseTrackSampleRate()).toBe(48000);
    expect(new AudioEngine().getExerciseTrackSampleRate()).toBeNull();
  });
});

describe("getTrackSamples", () => {
  it("is null without decoded data", async () => {
    const { engine } = await loadedEngine();
    expect(engine.getTrackSamples("vocals", 4)).toBeNull();
    expect(engine.getTrackSamples("take", 4)).toBeNull();
  });

  it("centres a mono-mixed window on the song time for vocals", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    vocals.decoded = fakeBuffer([ramp(100, (i) => i), ramp(100, (i) => i + 2)], 10);
    instrumental.currentTime = 5;
    const out = engine.getTrackSamples("vocals", 4)!;
    expect(out.sampleRate).toBe(10);
    expect(Array.from(out.samples)).toEqual([49, 50, 51, 52]);
  });

  it("maps song time through the vocals start offset", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    await reloadVocals(engine, vocals, 2);
    vocals.decoded = fakeBuffer([ramp(100, (i) => i)], 10);
    instrumental.currentTime = 5;
    expect(Array.from(engine.getTrackSamples("vocals", 2)!.samples)).toEqual([29, 30]);
  });

  it("returns null for vocals before the file starts", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    await reloadVocals(engine, vocals, 10);
    vocals.decoded = fakeBuffer([ramp(100, () => 1)], 10);
    instrumental.currentTime = 4;
    expect(engine.getTrackSamples("vocals", 4)).toBeNull();
  });

  it("returns null for the take before it starts and maps audio/manual offsets after", async () => {
    const { engine, instrumental } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 50, start: 20, audioOffset: 3, manual: 1 });
    take.decoded = fakeBuffer([ramp(1000, (i) => i)], 10);

    instrumental.currentTime = 20.5;
    expect(engine.getTrackSamples("take", 4)).toBeNull();

    instrumental.currentTime = 25;
    const fileTime = 3 + (25 - 21);
    const centre = Math.floor(fileTime * 10);
    expect(Array.from(engine.getTrackSamples("take", 4)!.samples)).toEqual([centre - 2, centre - 1, centre, centre + 1]);
  });
});

describe("destroy", () => {
  it("tears down every instance and resets state", async () => {
    const { engine, vocals, instrumental } = await loadedEngine();
    const { take } = await withTake(engine, { duration: 10, start: 0 });
    engine.play();
    engine.destroy();
    for (const i of [vocals, instrumental, take]) expect(i.destroy).toHaveBeenCalled();
    expect(engine.vocals).toBeNull();
    expect(engine.getDuration()).toBe(0);
    expect(engine.isPlaying).toBe(false);
    expect(frames).toHaveLength(0);
  });
});
