import { describe, it, expect, vi, beforeEach } from "vitest";

const KEY = "vps_settings";

async function freshStore() {
  vi.resetModules();
  return (await import("./settings")).useSettingsStore;
}

beforeEach(() => {
  localStorage.clear();
});

describe("loading persisted settings", () => {
  it("falls back to defaults when nothing is stored", async () => {
    const s = (await freshStore()).getState();
    expect(s.pitchAlgorithm).toBe("srh");
    expect(s.youtubeCookiesPath).toBeNull();
    expect(s.collapsedFolders).toEqual({});
  });

  it("restores valid stored values", async () => {
    localStorage.setItem(KEY, JSON.stringify({
      pitchAlgorithm: "crepe", youtubeCookiesPath: "/c.txt", collapsedFolders: { f1: true },
    }));
    const s = (await freshStore()).getState();
    expect(s.pitchAlgorithm).toBe("crepe");
    expect(s.youtubeCookiesPath).toBe("/c.txt");
    expect(s.collapsedFolders).toEqual({ f1: true });
  });

  it.each(["srh", "pyin", "hps", "crepe", "praat"])("accepts algorithm %s", async (alg) => {
    localStorage.setItem(KEY, JSON.stringify({ pitchAlgorithm: alg }));
    expect((await freshStore()).getState().pitchAlgorithm).toBe(alg);
  });

  it.each([["piano"], ["SRH"], [42], [null], [["srh"]]])("rejects unknown algorithm %j and uses the default", async (alg) => {
    localStorage.setItem(KEY, JSON.stringify({ pitchAlgorithm: alg }));
    expect((await freshStore()).getState().pitchAlgorithm).toBe("srh");
  });

  it("ignores wrongly-typed cookies path and collapsedFolders", async () => {
    localStorage.setItem(KEY, JSON.stringify({ youtubeCookiesPath: 5, collapsedFolders: ["a"] }));
    const s = (await freshStore()).getState();
    expect(s.youtubeCookiesPath).toBeNull();
    expect(s.collapsedFolders).toEqual({});
  });

  it("ignores a null collapsedFolders", async () => {
    localStorage.setItem(KEY, JSON.stringify({ collapsedFolders: null }));
    expect((await freshStore()).getState().collapsedFolders).toEqual({});
  });

  it("survives corrupt JSON, warning instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(KEY, "{not json");
    const s = (await freshStore()).getState();
    expect(s.pitchAlgorithm).toBe("srh");
    expect(warn).toHaveBeenCalled();
  });

  it("survives localStorage itself throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const s = (await freshStore()).getState();
    expect(s.pitchAlgorithm).toBe("srh");
    expect(warn).toHaveBeenCalled();
  });
});

describe("persisting changes", () => {
  const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "{}");

  it("writes the algorithm and keeps the other fields", async () => {
    const store = await freshStore();
    store.getState().setPitchAlgorithm("hps");
    expect(store.getState().pitchAlgorithm).toBe("hps");
    expect(stored()).toEqual({ pitchAlgorithm: "hps", youtubeCookiesPath: null, collapsedFolders: {} });
  });

  it("writes and clears the cookies path", async () => {
    const store = await freshStore();
    store.getState().setYoutubeCookiesPath("/c.txt");
    expect(stored().youtubeCookiesPath).toBe("/c.txt");
    store.getState().setYoutubeCookiesPath(null);
    expect(stored().youtubeCookiesPath).toBeNull();
  });

  it("merges folder collapse flags instead of replacing them", async () => {
    const store = await freshStore();
    store.getState().setFolderCollapsed("a", true);
    store.getState().setFolderCollapsed("b", true);
    store.getState().setFolderCollapsed("a", false);
    expect(store.getState().collapsedFolders).toEqual({ a: false, b: true });
    expect(stored().collapsedFolders).toEqual({ a: false, b: true });
  });

  it("round-trips through a fresh module load", async () => {
    const first = await freshStore();
    first.getState().setPitchAlgorithm("praat");
    first.getState().setFolderCollapsed("x", true);
    const second = (await freshStore()).getState();
    expect(second.pitchAlgorithm).toBe("praat");
    expect(second.collapsedFolders).toEqual({ x: true });
  });

  it("keeps the in-memory value and warns when storage rejects the write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await freshStore();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    store.getState().setPitchAlgorithm("pyin");
    expect(store.getState().pitchAlgorithm).toBe("pyin");
    expect(warn).toHaveBeenCalled();
  });
});
