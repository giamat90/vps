import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function fresh() {
  return import("./waveforms");
}

describe("waveform visibility store", () => {
  it("shows the area and every track until the user chooses otherwise", async () => {
    const { useWaveformPanels } = await fresh();
    expect(useWaveformPanels.getState().visible).toEqual({ waveforms: true, vocals: true, instrumental: true });
  });

  it("remembers the choices under vps_waveforms, apart from the other panels", async () => {
    const { useWaveformPanels } = await fresh();
    useWaveformPanels.getState().setVisible("instrumental", false);
    expect(JSON.parse(localStorage.getItem("vps_waveforms") ?? "null")).toEqual({ overrides: { instrumental: false } });
    expect(localStorage.getItem("vps_panels")).toBeNull();
    const again = (await fresh()).useWaveformPanels;
    expect(again.getState().visible.instrumental).toBe(false);
  });

  it("keeps a track's choice when the whole area is switched off and on again", async () => {
    const { useWaveformPanels } = await fresh();
    const s = useWaveformPanels.getState();
    s.setVisible("vocals", false);
    s.setVisible("waveforms", false);
    s.setVisible("waveforms", true);
    expect(useWaveformPanels.getState().visible).toEqual({ waveforms: true, vocals: false, instrumental: true });
  });

  it("is not the panel store: nothing here can be moved or detached", async () => {
    const { WAVEFORM_PANELS } = await fresh();
    const { PRACTICE_PANELS } = await import("./panels");
    const ids = new Set<string>(PRACTICE_PANELS.map((p) => p.id));
    expect(WAVEFORM_PANELS.some((p) => ids.has(p.id))).toBe(false);
  });
});

describe("waveformMenuItems", () => {
  it("offers the vocals and the instrumental under the area", async () => {
    const { waveformMenuItems } = await fresh();
    expect(waveformMenuItems({ isInstrument: false })).toEqual([
      {
        id: "waveforms",
        label: "Waveforms",
        parts: [{ id: "vocals", label: "Vocals" }, { id: "instrumental", label: "Instrumental" }],
      },
    ]);
  });

  it("offers only the melody for an instrument track", async () => {
    const { waveformMenuItems } = await fresh();
    expect(waveformMenuItems({ isInstrument: true })[0].parts).toEqual([{ id: "vocals", label: "Melody" }]);
  });
});

describe("waveformsOnScreen", () => {
  const on = { waveforms: true, vocals: true, instrumental: true };
  const opts = { isInstrument: false, shownTakes: 0 };

  it("is on while the area is on and a track is left", async () => {
    const { waveformsOnScreen } = await fresh();
    expect(waveformsOnScreen(on, opts)).toBe(true);
    expect(waveformsOnScreen({ ...on, vocals: false }, opts)).toBe(true);
    expect(waveformsOnScreen({ ...on, instrumental: false }, opts)).toBe(true);
  });

  it("is off when the area is off, whatever else is on", async () => {
    const { waveformsOnScreen } = await fresh();
    expect(waveformsOnScreen({ ...on, waveforms: false }, { ...opts, shownTakes: 2 })).toBe(false);
  });

  it("is off when every track is hidden and no take is shown, and back on with a take", async () => {
    const { waveformsOnScreen } = await fresh();
    const none = { waveforms: true, vocals: false, instrumental: false };
    expect(waveformsOnScreen(none, opts)).toBe(false);
    expect(waveformsOnScreen(none, { ...opts, shownTakes: 1 })).toBe(true);
  });

  it("ignores the instrumental of an instrument track, which has no such lane", async () => {
    const { waveformsOnScreen } = await fresh();
    expect(waveformsOnScreen({ ...on, vocals: false }, { isInstrument: true, shownTakes: 0 })).toBe(false);
  });
});

describe("hiddenTrackTags", () => {
  const visible = { waveforms: true, vocals: false, instrumental: false };

  it("says nothing about tracks that are on screen, where M and S can be seen", async () => {
    const { hiddenTrackTags } = await fresh();
    expect(hiddenTrackTags({ ...visible, vocals: true }, { muted: { vocals: true }, soloed: "vocals" })).toEqual({});
  });

  it("says a hidden track is muted, or is the one soloed", async () => {
    const { hiddenTrackTags } = await fresh();
    expect(hiddenTrackTags(visible, { muted: { vocals: true }, soloed: null })).toEqual({ vocals: "muted" });
    expect(hiddenTrackTags(visible, { muted: { vocals: true }, soloed: "vocals" })).toEqual({ vocals: "solo" });
  });

  it("says nothing when a hidden track simply plays", async () => {
    const { hiddenTrackTags } = await fresh();
    expect(hiddenTrackTags(visible, { muted: {}, soloed: null })).toEqual({});
  });
});
