import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function fresh() {
  return import("./panels");
}

describe("practice-room panels", () => {
  it("lists the optional panels in the order the menu shows them", async () => {
    const { PRACTICE_PANELS } = await fresh();
    expect(PRACTICE_PANELS.map((p) => p.id)).toEqual([
      "takes", "lyrics", "pianoRoll", "spectrum", "dynamics", "vibrato", "timing", "coach",
    ]);
  });

  it("keeps the expert views out of the way until asked for", async () => {
    const { usePracticePanels } = await fresh();
    expect(usePracticePanels.getState().visible).toEqual({
      takes: true, lyrics: true, pianoRoll: true, spectrum: false, dynamics: false, vibrato: true, timing: false, coach: true,
    });
  });

  it("remembers the user's choices under vps_panels", async () => {
    const { usePracticePanels } = await fresh();
    usePracticePanels.getState().toggle("takes");
    expect(JSON.parse(localStorage.getItem("vps_panels") ?? "null")).toEqual({ overrides: { takes: false } });
    const again = (await fresh()).usePracticePanels;
    expect(again.getState().visible.takes).toBe(false);
  });

  it("does not touch the general settings key", async () => {
    const { usePracticePanels } = await fresh();
    usePracticePanels.getState().hideAll();
    expect(localStorage.getItem("vps_settings")).toBeNull();
  });
});

describe("which panels a song can have", () => {
  it("offers every panel for a vocal song", async () => {
    const { availablePracticePanels } = await fresh();
    expect(availablePracticePanels({ isInstrument: false }).map((p) => p.id)).toHaveLength(8);
  });

  it("has no lyrics for an instrument practice track", async () => {
    const { availablePracticePanels } = await fresh();
    const ids = availablePracticePanels({ isInstrument: true }).map((p) => p.id);
    expect(ids).not.toContain("lyrics");
    expect(ids).toContain("pianoRoll");
  });
});
