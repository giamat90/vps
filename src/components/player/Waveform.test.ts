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
    deleteAllTakes: () => {},
  },
}));

vi.mock("../../stores/player", () => ({
  usePlayerStore: Object.assign((sel: (s: unknown) => unknown) => sel(h.state), { getState: () => h.state }),
  getEngine: () => ({}),
  takesSilenced: (s: { mutedTracks: { take: boolean }; soloedTrack: string | null }) =>
    s.soloedTrack !== null ? s.soloedTrack !== "take" : s.mutedTracks.take,
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
  localStorage.clear();
  h.state.takes = [take("a"), take("b", "Verse"), take("c")];
  h.state.shownTakeIds = [];
  h.state.activeTakeId = null;
  h.state.takePlayback = "all";
  h.state.mutedTakeIds = [];
  h.state.soloedTakeId = null;
  h.state.soloedTrack = null;
  h.state.takeGains = {};
  h.state.mutedTracks = { vocals: false, instrumental: false, take: false };
  h.state.isRecording = false;
  h.state.muteTakesWhileRecording = true;
});

describe("take lanes", () => {
  it("has no takes bar and no lanes while nothing is shown", () => {
    const html = render();
    expect(html).not.toContain("waveform__takes-bar");
    expect(lanes(html)).toEqual([]);
  });

  it("puts a delete-all button on the takes bar, with no confirmation until it is pressed", () => {
    h.state.shownTakeIds = ["a"];
    const html = render();
    expect(html).toContain('aria-label="Delete all takes"');
    expect(html).not.toContain("waveform__takes-confirm");
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
    expect(html.match(/aria-label="Mute (Take 1|Verse)"/g)).toHaveLength(2);
  });

  it("marks a muted lane as muted and silent", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.mutedTakeIds = ["a"];
    const html = render();
    expect(html).toContain('aria-label="Unmute Take 1"');
    expect(lanes(html)).toEqual(["waveform__track--silent", "waveform__track--active"]);
  });

  it("keeps mute, solo and volume on every lane in selected-only mode too, and only the selected lane is lit", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.takePlayback = "selected";
    const html = render();
    expect(html.match(/aria-label="Mute (Take 1|Verse)"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Solo (Take 1|Verse)"/g)).toHaveLength(2);
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
    expect(html).toContain('aria-label="Unsolo Take 1"');
    expect(lanes(html)).toEqual(["", "waveform__track--active waveform__track--silent"]);
  });

  it("keeps the take offset between the name and the controls", () => {
    h.state.shownTakeIds = ["a"];
    h.state.activeTakeId = "a";
    const html = render();
    const name = html.indexOf("waveform__take-name");
    const sync = html.indexOf("waveform__take-sync");
    const controls = html.indexOf('aria-label="Mute Take 1"');
    expect(name).toBeLessThan(sync);
    expect(sync).toBeLessThan(controls);
  });

  it("shows the two options with one fixed label each, whatever their state", () => {
    h.state.shownTakeIds = ["a"];
    h.state.activeTakeId = "a";
    const labels = () => [...render().matchAll(/<label class="waveform__takes-option"[^>]*>(?:<input[^>]*\/>)([^<]*)</g)].map((m) => m[1]);
    expect(labels()).toEqual(["Selected take only", "Mute takes while recording"]);
    h.state.takePlayback = "selected";
    h.state.muteTakesWhileRecording = false;
    expect(labels()).toEqual(["Selected take only", "Mute takes while recording"]);
  });

  it("ticks an option when it is on", () => {
    h.state.shownTakeIds = ["a"];
    h.state.activeTakeId = "a";
    const checked = () => [...render().matchAll(/<input type="checkbox"([^>]*)\/>/g)].map((m) => m[1].includes("checked"));
    expect(checked()).toEqual([false, true]);
    h.state.takePlayback = "selected";
    h.state.muteTakesWhileRecording = false;
    expect(checked()).toEqual([true, false]);
  });

  it("dims every lane while recording when takes are silent then", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.isRecording = true;
    expect(lanes(render())).toEqual(["waveform__track--silent", "waveform__track--active waveform__track--silent"]);
  });

  it("dims every lane when the main take mute is on, whatever the lanes say", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.soloedTakeId = "a";
    h.state.mutedTracks = { vocals: false, instrumental: false, take: true };
    expect(lanes(render())).toEqual(["waveform__track--silent", "waveform__track--active waveform__track--silent"]);
  });

  it("dims the takes when another track is soloed", () => {
    h.state.shownTakeIds = ["a"];
    h.state.activeTakeId = "a";
    h.state.soloedTrack = "vocals";
    expect(lanes(render())).toEqual(["waveform__track--active waveform__track--silent"]);
  });

  it("says in the main buttons' tooltips that they come before the lanes", () => {
    h.state.shownTakeIds = ["a"];
    h.state.activeTakeId = "a";
    const html = render();
    expect(html).toContain("This main mute wins over the mute and solo on each take");
    expect(html).toContain("Solo on a take then picks one take among them");
  });

  it("says in a lane's tooltips that it does not affect the other tracks", () => {
    h.state.shownTakeIds = ["a"];
    h.state.activeTakeId = "a";
    const html = render();
    expect(html).toContain("The other tracks are not affected, and the main take mute and solo above still come first");
    expect(html).toContain("The main take mute and solo above still come first");
  });

  it("marks the selected lane, and only that lane, whatever the mode", () => {
    h.state.shownTakeIds = ["a", "b", "c"];
    h.state.activeTakeId = "b";
    expect(lanes(render()).map((l) => l.includes("waveform__track--active"))).toEqual([false, true, false]);
    h.state.takePlayback = "selected";
    expect(lanes(render()).map((l) => l.includes("waveform__track--active"))).toEqual([false, true, false]);
  });

  it("keeps the selected lane marked when it is muted in selected-only mode", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    h.state.takePlayback = "selected";
    h.state.mutedTakeIds = ["b"];
    expect(lanes(render())).toEqual(["waveform__track--silent", "waveform__track--active waveform__track--silent"]);
  });

  it("has no selection label or badge", () => {
    h.state.shownTakeIds = ["a"];
    h.state.activeTakeId = "a";
    expect(render()).not.toContain("waveform__take-state");
  });

  it("groups the takes bar and the lanes in one section of their own, after the other tracks", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    const html = render();
    expect(html.match(/waveform__takes"/g)).toHaveLength(1);
    const section = html.indexOf('class="waveform__takes"');
    expect(html.indexOf("Instrumental")).toBeLessThan(section);
    expect(html.indexOf("waveform__takes-bar")).toBeGreaterThan(section);
    expect(html.indexOf("waveform__track--take")).toBeGreaterThan(html.indexOf("waveform__takes-bar"));
  });

  it("has no takes section while no take is shown", () => {
    expect(render()).not.toContain("waveform__takes\"");
  });

  it("has a hide button on every lane", () => {
    h.state.shownTakeIds = ["a", "b"];
    h.state.activeTakeId = "b";
    expect(render().match(/aria-label="Hide (Take 1|Verse)"/g)).toHaveLength(2);
  });
});

describe("minimizing a track's waveform to a strip", () => {
  // zustand renders the store's initial state under react-dom/server, so what the
  // user chose is seeded through storage and the component is imported again.
  async function renderWith(hidden: string[] = [], kind = "song") {
    localStorage.setItem(
      "vps_waveforms",
      JSON.stringify({ overrides: Object.fromEntries(hidden.map((id) => [id, false])) }),
    );
    vi.resetModules();
    const { default: Fresh } = await import("./Waveform");
    return renderToStaticMarkup(createElement(Fresh, { song: { id: "s1", title: "Song", kind } as never }));
  }
  const tracks = (html: string) =>
    [
      ...html.matchAll(
        /<div class="(waveform__track[^"]*)"><div class="waveform__track-header"><div class="waveform__track-title"><button.*?<\/button><span class="waveform__label">([^<]*)</g,
      ),
    ].map((m) => [m[2], m[1].replace("waveform__track", "").trim()]);

  it("offers an arrow on the vocals and on the instrumental, and none on the takes bar", async () => {
    h.state.shownTakeIds = ["a"];
    h.state.activeTakeId = "a";
    const html = await renderWith();
    expect(html).toContain('aria-label="Minimize Vocals waveform"');
    expect(html).toContain('aria-label="Minimize Instrumental waveform"');
    expect(html.match(/waveform__track-toggle"/g)).toHaveLength(2);
  });

  it("turns the arrow into an expand button on a minimized track, and says which state it is in", async () => {
    const html = await renderWith(["vocals"]);
    expect(html).toContain('aria-label="Expand Vocals waveform"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("waveform__track-toggle--minimized");
    expect(html).toContain('aria-label="Minimize Instrumental waveform"');
    expect(html).toContain('aria-expanded="true"');
  });

  it("shows both tracks until the user hides one", async () => {
    expect(tracks(await renderWith())).toEqual([["Vocals", ""], ["Instrumental", ""]]);
  });

  it("minimizes only the track that was chosen", async () => {
    expect(tracks(await renderWith(["vocals"]))).toEqual([["Vocals", "waveform__track--collapsed"], ["Instrumental", ""]]);
    expect(tracks(await renderWith(["instrumental"]))).toEqual([["Vocals", ""], ["Instrumental", "waveform__track--collapsed"]]);
  });

  it("keeps a minimized track's waveform container and controls in the page, so the audio engine still has it and M, S and the volume stay on the strip", async () => {
    const html = await renderWith(["vocals", "instrumental"]);
    expect(html.match(/class="waveform__container"/g)).toHaveLength(2);
    expect(html).toContain('class="waveform__mute"');
  });

  it("keeps the take lanes when both tracks are minimized", async () => {
    h.state.shownTakeIds = ["a"];
    h.state.activeTakeId = "a";
    expect(lanes(await renderWith(["vocals", "instrumental"]))).toEqual(["waveform__track--active"]);
  });

  it("calls the vocals track the melody on an instrument track, which has no instrumental to hide", async () => {
    const html = await renderWith([], "instrument");
    expect(html).toContain('aria-label="Minimize Melody waveform"');
    expect(tracks(html)[1]).toEqual(["Instrumental", "waveform__track--hidden"]);
  });
});
