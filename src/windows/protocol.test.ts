import { describe, it, expect } from "vitest";
import {
  DETACHABLE_PANELS,
  detachedLabel,
  isDetachablePanel,
  isLiveMessage,
  isStateMessage,
  panelFromLabel,
  parseCommand,
} from "./protocol";

describe("detachable panels", () => {
  it("are the two the spike supports", () => {
    expect([...DETACHABLE_PANELS]).toEqual(["pianoRoll", "lyrics"]);
  });

  it.each(["pianoRoll", "lyrics"])("accepts %s", (id) => {
    expect(isDetachablePanel(id)).toBe(true);
  });

  it.each(["takes", "waveform", "", "PianoRoll", "pianoRoll ", "../main", null, 3, undefined])(
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

  it.each(["", "main", "detached-", "detached-takes", "detached-pianoRoll-2", "Detached-pianoRoll", "pianoRoll"])(
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
  ])("rejects a malformed state message %j", (m) => {
    expect(isStateMessage(m)).toBe(false);
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
