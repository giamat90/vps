import { describe, it, expect } from "vitest";
import { addressLabel, describePack, initialShareState, percent, shareReducer, type ShareState } from "./packShare";
import type { PackShareInfo, PackSummary } from "./tauri";

const summary: PackSummary = { path: "/tmp/x", sizeBytes: 4_900_000, variants: [], hasReference: true, hasLyrics: false, loops: 0 };
const info: PackShareInfo = {
  url: "http://192.168.1.20:49152/pack/0123456789abcdef0123456789abcdef",
  ip: "192.168.1.20",
  port: 49152,
  expiresInS: 600,
  summary,
  addresses: [{ ip: "192.168.1.20", name: "Wi-Fi", virtualAdapter: false }],
};

const run = (state: ShareState, ...actions: Parameters<typeof shareReducer>[1][]) =>
  actions.reduce(shareReducer, state);

describe("the Send to phone dialog", () => {
  it("goes from the choice to a code, through the pack being built", () => {
    const preparing = run(initialShareState, { type: "start" });
    expect(preparing).toEqual({ phase: "preparing", progress: null });
    expect(run(preparing, { type: "started", info })).toEqual({ phase: "ready", info, interrupted: false });
  });

  it("follows the pack being built, and ignores that progress once the code is up", () => {
    const building = run(
      initialShareState,
      { type: "start" },
      { type: "event", event: { kind: "building", value: 0.4, stage: "encoding instrumental" } },
    );
    expect(building).toEqual({ phase: "preparing", progress: { value: 0.4, stage: "encoding instrumental" } });
    const ready = run(building, { type: "started", info });
    expect(run(ready, { type: "event", event: { kind: "building", value: 0.9, stage: "x" } })).toBe(ready);
    expect(run(initialShareState, { type: "event", event: { kind: "building", value: 0.1, stage: "x" } })).toBe(initialShareState);
  });

  it("shows progress, then done", () => {
    const sending = run(
      initialShareState,
      { type: "start" },
      { type: "started", info },
      { type: "event", event: { kind: "sending", sent: 10, total: 100 } },
    );
    expect(sending).toEqual({ phase: "sending", info, sent: 10, total: 100 });
    expect(run(sending, { type: "event", event: { kind: "done" } })).toEqual({ phase: "done", info });
  });

  it("goes back to a usable code after an interrupted transfer", () => {
    const state = run(
      initialShareState,
      { type: "start" },
      { type: "started", info },
      { type: "event", event: { kind: "sending", sent: 10, total: 100 } },
      { type: "event", event: { kind: "interrupted" } },
    );
    expect(state).toEqual({ phase: "ready", info, interrupted: true });
  });

  it("expires only while a code is waiting, never in the middle of a transfer", () => {
    const ready = run(initialShareState, { type: "start" }, { type: "started", info });
    expect(run(ready, { type: "event", event: { kind: "expired" } })).toEqual({ phase: "expired", info });
    const sending = run(ready, { type: "event", event: { kind: "sending", sent: 1, total: 2 } });
    expect(run(sending, { type: "event", event: { kind: "expired" } })).toBe(sending);
  });

  it("ignores events that arrive when no code is on screen", () => {
    const done: ShareState = { phase: "done", info };
    for (const event of [{ kind: "sending", sent: 5, total: 5 }, { kind: "interrupted" }, { kind: "expired" }, { kind: "building", value: 0.5, stage: "x" }] as const) {
      expect(run(done, { type: "event", event })).toBe(done);
      expect(run(initialShareState, { type: "event", event })).toBe(initialShareState);
    }
  });

  it("ignores a late answer for a request the user already abandoned", () => {
    const abandoned = run(initialShareState, { type: "start" }, { type: "back" });
    expect(run(abandoned, { type: "started", info })).toBe(abandoned);
    expect(run(abandoned, { type: "failed", message: "x" })).toBe(abandoned);
  });

  it("reports a failure and can start again, but a restart cannot interrupt a transfer", () => {
    const failed = run(initialShareState, { type: "start" }, { type: "failed", message: "No local network found." });
    expect(failed).toEqual({ phase: "failed", message: "No local network found." });
    expect(run(failed, { type: "start" }).phase).toBe("preparing");
    const sending: ShareState = { phase: "sending", info, sent: 1, total: 2 };
    expect(run(sending, { type: "start" })).toBe(sending);
  });

  it("can switch network from a waiting code", () => {
    const ready = run(initialShareState, { type: "start" }, { type: "started", info });
    expect(run(ready, { type: "start" }).phase).toBe("preparing");
  });
});

describe("percent", () => {
  it("is whole, clamped and safe on an empty file", () => {
    expect(percent(0, 100)).toBe(0);
    expect(percent(49, 100)).toBe(49);
    expect(percent(999, 1000)).toBe(99);
    expect(percent(200, 100)).toBe(100);
    expect(percent(-5, 100)).toBe(0);
    expect(percent(5, 0)).toBe(0);
  });
});

describe("describePack", () => {
  it("names what the pack holds", () => {
    expect(describePack(summary)).toBe("4.7 MB");
    expect(describePack({ ...summary, variants: [-2], hasLyrics: true })).toBe("4.7 MB, 1 transposition, lyrics");
    expect(describePack({ ...summary, variants: [-2, 3], hasReference: false })).toBe("4.7 MB, 2 transpositions, no reference melody");
  });

  it("labels an address with its adapter", () => {
    expect(addressLabel({ ip: "192.168.1.20", name: "Wi-Fi" })).toBe("Wi-Fi (192.168.1.20)");
  });
});
