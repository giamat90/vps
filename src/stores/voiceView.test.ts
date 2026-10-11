import { describe, it, expect, vi, beforeEach } from "vitest";

const KEY = "vps_voice_view";

async function freshModule() {
  vi.resetModules();
  return await import("./voiceView");
}

async function freshStore() {
  return (await freshModule()).useVoiceViewStore;
}

beforeEach(() => {
  localStorage.clear();
});

describe("defaults", () => {
  it("starts with the second line hidden and the loudest voice as the main line", async () => {
    const s = (await freshStore()).getState();
    expect(s.showMultipleLines).toBe(false);
    expect(s.mainVoice).toBe("loudest");
  });
});

describe("loading persisted choices", () => {
  it("restores valid stored values", async () => {
    localStorage.setItem(KEY, JSON.stringify({ showMultipleLines: true, mainVoice: "lower" }));
    const s = (await freshStore()).getState();
    expect(s.showMultipleLines).toBe(true);
    expect(s.mainVoice).toBe("lower");
  });

  it("ignores wrongly typed or unknown values", async () => {
    localStorage.setItem(KEY, JSON.stringify({ showMultipleLines: "yes", mainVoice: "upper" }));
    const s = (await freshStore()).getState();
    expect(s.showMultipleLines).toBe(false);
    expect(s.mainVoice).toBe("loudest");
  });

  it("survives corrupt JSON, warning instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(KEY, "{not json");
    const s = (await freshStore()).getState();
    expect(s.showMultipleLines).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe("saving", () => {
  it("persists the toggle and the main voice", async () => {
    const store = await freshStore();
    store.getState().setShowMultipleLines(true);
    store.getState().setMainVoice("higher");
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({ showMultipleLines: true, mainVoice: "higher" });
  });

  it("rejects an unknown main voice instead of storing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await freshStore();
    // @ts-expect-error not a MainVoice
    store.getState().setMainVoice("upper");
    expect(store.getState().mainVoice).toBe("loudest");
    expect(warn).toHaveBeenCalled();
  });

  it("warns instead of throwing when storage refuses the write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await freshStore();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    store.getState().setShowMultipleLines(true);
    expect(store.getState().showMultipleLines).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe("other windows", () => {
  it("follows a change made in another window of the app", async () => {
    const { useVoiceViewStore: store, followOtherWindows } = await freshModule();
    localStorage.setItem(KEY, JSON.stringify({ showMultipleLines: true, mainVoice: "higher" }));
    followOtherWindows({ key: KEY });
    expect(store.getState().showMultipleLines).toBe(true);
    expect(store.getState().mainVoice).toBe("higher");
  });

  it("ignores storage events for other keys", async () => {
    const { useVoiceViewStore: store, followOtherWindows } = await freshModule();
    localStorage.setItem(KEY, JSON.stringify({ showMultipleLines: true, mainVoice: "higher" }));
    followOtherWindows({ key: "vps_settings" });
    expect(store.getState().showMultipleLines).toBe(false);
  });
});
