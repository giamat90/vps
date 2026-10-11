import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  state: {
    loadSong: async () => {},
    syncTrackVolumes: () => {},
    takes: [] as { id: string; name?: string; filepath: string; startPosition: number; recordedAt: string; songId: string }[],
    shownTakeIds: [] as string[],
    activeTakeId: null as string | null,
    takePlayback: "all" as "all" | "selected",
    mutedTakeIds: [] as string[],
    isRecording: false,
    muteTakesWhileRecording: true,
    vocalsVolume: 1,
    instrumentalVolume: 1,
    takeVolume: 1,
    mutedTracks: { vocals: false, instrumental: false, take: false },
    soloedTrack: null as string | null,
    soloedTakeId: null as string | null,
    takeGains: {} as Record<string, number>,
    punchIn: null,
    punchOut: null,
    duration: 100,
    minPxPerSec: 1,
    scrollTime: 0,
    setVocalsVolume: () => {},
    setInstrumentalVolume: () => {},
    setTakeVolume: () => {},
    setActiveTake: () => {},
    hideTake: () => {},
    setTakePlayback: () => {},
    toggleTakeMute: () => {},
    toggleTakeSolo: () => {},
    setTakeGain: () => {},
    setMuteTakesWhileRecording: () => {},
    toggleMute: () => {},
    toggleSolo: () => {},
    setTakeManualOffset: () => {},
  },
}));

vi.mock("../../stores/player", () => ({
  usePlayerStore: Object.assign((sel: (s: unknown) => unknown) => sel(h.state), { getState: () => h.state }),
  getEngine: () => ({}),
}));
vi.mock("../../stores/analysis", () => ({
  useAnalysisStore: (sel: (s: unknown) => unknown) => sel({ previewTakeManualOffset: () => {} }),
}));
vi.mock("./TimeRuler", async () => {
  const { createElement: el } = await import("react");
  return { default: () => el("div", { "data-c": "ruler" }) };
});

import Waveform from "./Waveform";

const take = (id: string, name?: string) => ({
  id, name, songId: "s1", recordedAt: "2026-10-10T10:00:00Z", filepath: `/t/${id}.wav`, startPosition: 0,
});
const render = () =>
  renderToStaticMarkup(createElement(Waveform, { song: { id: "s1", title: "Song", kind: "song" } as never }));
const lanes = (html: string) => [...html.matchAll(/waveform__track waveform__track--take([^"]*)"/g)].map((m) => m[1].trim());

beforeEach(() => {
  h.state.takes = [take("a"), take("b", "Verse"), take("c")];
  h.state.shownTakeIds = [];
  h.state.activeTakeId = null;
  h.state.takePlayback = "all";
  h.state.mutedTakeIds = [];
  h.state.soloedTakeId = null;
  h.state.soloedTrack = null;
  h.state.takeGains = {};
  h.state.isRecording = false;
  h.state.muteTakesWhileRecording = true;
});

describe("take lanes", () => {
  it("has no takes bar and no lanes while nothing is shown", () => {
    const html = render();
    expect(html).not.toContain("waveform__takes-bar");
    expect(lanes(html)).toEqual([]);
  });

  it("shows one lane per shown take, in the order they were shown, with the name or a number", () => {
    h.state.shownTakeIds = ["b", "a"];
    h.state.activeTakeId = "a";
    const html = render();
    expect(lanes(html)).toHaveLength(2);
    expect(html.indexOf("Verse")).toBeLessThan(html.indexOf("Take 1"));
    expect(html).toContain("waveform__takes-bar");
  });

  it("offers a mute button on every lane when the takes play together", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    const html = render();
    expect(html.match(/title="Mute (Take 1|Verse)"/g)).toHaveLength(2);
  });

  it("marks a muted lane as muted and silent", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.mutedTakeIds = ["a"];
    const html = render();
    expect(html).toContain('title="Unmute Take 1"');
    expect(lanes(html)).toEqual(["waveform__track--silent", "waveform__track--active"]);
  });

  it("keeps mute, solo and volume on every lane in selected-only mode too, and only the selected lane is lit", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.takePlayback = "selected";
    const html = render();
    expect(html.match(/title="Mute (Take 1|Verse)"/g)).toHaveLength(2);
    expect(html.match(/title="Solo (Take 1|Verse)"/g)).toHaveLength(2);
    expect(lanes(html)).toEqual(["waveform__track--silent", "waveform__track--active"]);
  });

  it("gives every lane its own volume", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.takeGains = { a: 0.35 };
    const html = render();
    expect(html.match(/aria-label="(Take 1|Verse) volume"/g)).toHaveLength(2);
    expect(html).toContain('value="0.35"');
  });

  it("marks the soloed lane and dims the others", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.soloedTrack = "take";
    h.state.soloedTakeId = "a";
    const html = render();
    expect(html).toContain('title="Unsolo Take 1"');
    expect(lanes(html)).toEqual(["", "waveform__track--active waveform__track--silent"]);
  });

  it("keeps the take offset between the name and the controls", () => {
    h.state.shownTakeIds = ["a"];
    h.state.activeTakeId = "a";
    const html = render();
    const name = html.indexOf("waveform__take-name");
    const sync = html.indexOf("waveform__take-sync");
    const controls = html.indexOf('title="Mute Take 1"');
    expect(name).toBeLessThan(sync);
    expect(sync).toBeLessThan(controls);
  });

  it("shows both toggles with their state", () => {
    h.state.shownTakeIds = ["a"];
    h.state.activeTakeId = "a";
    let html = render();
    expect(html).toContain("Hear: all shown");
    expect(html).toContain("Silent while recording");
    h.state.takePlayback = "selected";
    h.state.muteTakesWhileRecording = false;
    html = render();
    expect(html).toContain("Hear: selected only");
    expect(html).toContain("Playing while recording");
  });

  it("dims every lane while recording when takes are silent then", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.isRecording = true;
    expect(lanes(render())).toEqual(["waveform__track--silent", "waveform__track--active waveform__track--silent"]);
  });

  it("has a hide button on every lane", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    expect(render().match(/aria-label="Hide /g)).toHaveLength(2);
  });
});
