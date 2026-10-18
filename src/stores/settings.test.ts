import { describe, it, expect, vi, beforeEach } from "vitest";

const KEY = "vps_settings";

async function freshStore() {
  vi.resetModules();
  return (await import("./settings")).useSettingsStore;
}

beforeEach(() => {
  localStorage.clear();
});

describe("settings store of this app", () => {
  it("restores what was saved under vps_settings", async () => {
    localStorage.setItem(KEY, JSON.stringify({ youtubeCookiesPath: "/c.txt", collapsedFolders: { f1: true } }));
    const s = (await freshStore()).getState();
    expect(s.youtubeCookiesPath).toBe("/c.txt");
    expect(s.collapsedFolders).toEqual({ f1: true });
  });

  it("saves under vps_settings only, in the shape older versions read", async () => {
    (await freshStore()).getState().setFolderCollapsed("a", true);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({ youtubeCookiesPath: null, collapsedFolders: { a: true } });
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toBe(KEY);
  });

  // Until v0.1.63 the user picked the algorithm in Settings and it was persisted;
  // nobody may stay pinned to that old choice: the app decides it now.
  it.each(["crepe", "praat", "pyin", "hps", "srh", "garbage", 42])(
    "ignores a pitchAlgorithm of %j stored by an older version",
    async (legacy) => {
      localStorage.setItem(KEY, JSON.stringify({ pitchAlgorithm: legacy, youtubeCookiesPath: "/c.txt" }));
      const state = (await freshStore()).getState();
      expect(state).not.toHaveProperty("pitchAlgorithm");
      expect(state.youtubeCookiesPath).toBe("/c.txt");
    },
  );
});
