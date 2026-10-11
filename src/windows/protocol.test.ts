import { describe, it, expect } from "vitest";
import { PRACTICE_PANELS } from "../stores/panels";
import {
  DETACHABLE_PANELS,
  detachedLabel,
  isDetachablePanel,
  isLiveMessage,
  isSpectrumMessage,
  isStateMessage,
  panelFromLabel,
  parseCommand,
} from "./protocol";

describe("detachable panels", () => {
  it("are exactly the panels of the practice room", () => {
    expect([...DETACHABLE_PANELS].sort()).toEqual(PRACTICE_PANELS.map((p) => p.id).sort());
  });

  it.each(["pianoRoll", "lyrics", "takes", "spectrum", "dynamics", "vibrato", "timing", "coach"])("accepts %s", (id) => {
    expect(isDetachablePanel(id)).toBe(true);
  });

  it.each(["waveform", "transport", "", "PianoRoll", "pianoRoll ", "../main", null, 3, undefined])(
    "rejects %j",
    (id) => {
      expect(isDetachablePanel(id)).toBe(false);
    },
  );

  it("names the window after the panel, matching the Rust side", () => {
    expect(detachedLabel("pianoRoll")).toBe("detached-pianoRoll");
  });
});

describe("panelFromLabel", () => {
  it("reads the panel out of a detached window label", () => {
    expect(panelFromLabel("detached-pianoRoll")).toBe("pianoRoll");
    expect(panelFromLabel("detached-lyrics")).toBe("lyrics");
  });

  it("round-trips with detachedLabel", () => {
    for (const id of DETACHABLE_PANELS) expect(panelFromLabel(detachedLabel(id))).toBe(id);
  });

  it.each(["", "main", "detached-", "detached-waveform", "detached-pianoRoll-2", "Detached-pianoRoll", "pianoRoll"])(
    "returns null for %j",
    (label) => {
      expect(panelFromLabel(label)).toBeNull();
    },
  );
});

describe("parseCommand", () => {
  it("accepts a seek", () => {
    expect(parseCommand({ type: "seek", time: 12.5 })).toEqual({ type: "seek", time: 12.5 });
  });

  it("accepts the punch commands", () => {
    expect(parseCommand({ type: "setPunchIn", time: 3 })).toEqual({ type: "setPunchIn", time: 3 });
    expect(parseCommand({ type: "setPunchOut", time: 9 })).toEqual({ type: "setPunchOut", time: 9 });
    expect(parseCommand({ type: "clearPunch" })).toEqual({ type: "clearPunch" });
  });

  it.each([
    null,
    undefined,
    "seek",
    42,
    [],
    {},
    { type: "seek" },
    { type: "seek", time: "1" },
    { type: "seek", time: -1 },
    { type: "seek", time: Number.NaN },
    { type: "seek", time: Number.POSITIVE_INFINITY },
    { type: "setPunchIn", time: null },
    { type: "delete_take", time: 1 },
    { type: "__proto__", time: 1 },
  ])("rejects %j", (value) => {
    expect(parseCommand(value)).toBeNull();
  });

  it("accepts the take commands", () => {
    expect(parseCommand({ type: "toggleTake", id: "t1" })).toEqual({ type: "toggleTake", id: "t1" });
    expect(parseCommand({ type: "deleteTake", id: "t1" })).toEqual({ type: "deleteTake", id: "t1" });
    expect(parseCommand({ type: "renameTake", id: "t1", name: "Verse 2" })).toEqual({
      type: "renameTake", id: "t1", name: "Verse 2",
    });
  });

  it("lets a take be renamed to nothing, which clears the name", () => {
    expect(parseCommand({ type: "renameTake", id: "t1", name: "" })).toEqual({ type: "renameTake", id: "t1", name: "" });
  });

  it.each([
    { type: "toggleTake" },
    { type: "toggleTake", id: "" },
    { type: "toggleTake", id: 7 },
    { type: "deleteTake", id: "x".repeat(200) },
    { type: "renameTake", id: "t1" },
    { type: "renameTake", id: "t1", name: 5 },
    { type: "renameTake", id: "t1", name: "x".repeat(500) },
  ])("rejects the malformed take command %j", (value) => {
    expect(parseCommand(value)).toBeNull();
  });

  it("drops fields it does not know instead of passing them on", () => {
    expect(parseCommand({ type: "seek", time: 1, extra: "x" })).toEqual({ type: "seek", time: 1 });
  });
});

describe("message guards", () => {
  const transport = { time: 1, playing: false, rate: 1, sentAt: 100 };
  const shared = {
    song: null,
    duration: 10,
    isRecording: false,
    isMonitoring: false,
    exerciseMode: false,
    punchIn: null,
    punchOut: null,
    punchLoop: false,
    selectedOutputDeviceId: null,
    activeTake: null,
    shownTakeIds: [],
    takePlayback: "all",
    mutedTakeIds: [],
    muteTakesWhileRecording: true,
    takes: [],
  };

  it("accepts a well-formed state message", () => {
    expect(isStateMessage({ transport, shared })).toBe(true);
  });

  it.each([
    null,
    {},
    { transport },
    { shared },
    { transport: { ...transport, time: "1" }, shared },
    { transport: { ...transport, playing: 1 }, shared },
    { transport, shared: { ...shared, duration: "10" } },
    { transport, shared: { ...shared, punchIn: "3" } },
    { transport, shared: { ...shared, takes: "none" } },
    { transport, shared: { ...shared, takes: [{ name: "no id" }] } },
  ])("rejects a malformed state message %j", (m) => {
    expect(isStateMessage(m)).toBe(false);
  });

  it("accepts a state message that lists takes", () => {
    const takes = [{ id: "t1", songId: "s1", recordedAt: "now", filepath: "/t/1.wav", startPosition: 0 }];
    expect(isStateMessage({ transport, shared: { ...shared, takes } })).toBe(true);
  });

  it("lists which takes are shown, and rejects anything that is not a list of ids", () => {
    expect(isStateMessage({ transport, shared: { ...shared, shownTakeIds: ["t1", "t2"] } })).toBe(true);
    for (const bad of [undefined, "t1", [1], [""], [null], {}]) {
      expect(isStateMessage({ transport, shared: { ...shared, shownTakeIds: bad } }), JSON.stringify(bad)).toBe(false);
    }
  });

  it("accepts and rejects spectrum messages", () => {
    const none = { f1: null, f2: null, f3: null };
    const ok = { live: { sampleRate: 48000, bins: "AAEC" }, formants: { song: none, take: none, live: { f1: 500, f2: 1500, f3: 2500 } } };
    expect(isSpectrumMessage(ok)).toBe(true);
    expect(isSpectrumMessage({ ...ok, live: null })).toBe(true);
    expect(isSpectrumMessage({ ...ok, live: { sampleRate: "48k", bins: "AAEC" } })).toBe(false);
    expect(isSpectrumMessage({ ...ok, live: { sampleRate: 48000, bins: 3 } })).toBe(false);
    expect(isSpectrumMessage({ ...ok, formants: { song: none, take: none } })).toBe(false);
    expect(isSpectrumMessage({ ...ok, formants: { ...ok.formants, live: { f1: "x", f2: null, f3: null } } })).toBe(false);
    expect(isSpectrumMessage(null)).toBe(false);
  });

  it("accepts and rejects live messages", () => {
    expect(isLiveMessage({ reset: false, points: [{ time: 1, frequency: 220, confidence: 1 }], cents: 4 })).toBe(true);
    expect(isLiveMessage({ reset: true, points: [], cents: null })).toBe(true);
    expect(isLiveMessage({ reset: true, points: "x", cents: null })).toBe(false);
    expect(isLiveMessage({ reset: true, points: [{ time: 1 }], cents: null })).toBe(false);
    expect(isLiveMessage({ points: [], cents: null })).toBe(false);
    expect(isLiveMessage(null)).toBe(false);
  });
});
