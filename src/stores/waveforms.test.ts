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
