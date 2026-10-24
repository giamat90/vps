import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => {
  const stub = (name: string) => async () => {
    const { createElement: el } = await import("react");
    return { default: () => el("div", { "data-c": name }) };
  };
  return {
    stub,
    detached: {} as Record<string, boolean>,
    library: { songs: [] as unknown[], renameSong: () => {} },
    player: {
      cleanup: () => {}, takes: [] as { id: string }[], activeTakeId: null as string | null,
      shownTakeIds: [] as string[], mutedTracks: {} as Record<string, boolean>, soloedTrack: null as string | null,
    },
    analysis: {
      loadSongAnalysis: () => {}, loadTakeAnalysis: () => {}, clearTakeAnalysis: () => {}, clear: () => {},
      isLoaded: true,
    },
  };
});

vi.mock("../stores/library", () => ({ useLibraryStore: (sel: (s: unknown) => unknown) => sel(h.library) }));
vi.mock("../stores/player", () => ({ usePlayerStore: (sel: (s: unknown) => unknown) => sel(h.player) }));
vi.mock("../stores/analysis", () => ({ useAnalysisStore: (sel: (s: unknown) => unknown) => sel(h.analysis) }));

vi.mock("../components/player/Waveform", h.stub("waveform"));
vi.mock("../components/player/DownloadAllButton", h.stub("downloadAll"));
vi.mock("../components/player/ExportMixButton", h.stub("exportMix"));
vi.mock("../components/player/TransportControls", h.stub("transport"));
vi.mock("../components/player/LoopButton", h.stub("loop"));
vi.mock("../components/player/TempoControl", h.stub("tempo"));
vi.mock("../components/player/KeyTranspose", h.stub("transpose"));
vi.mock("../components/player/OutputSelector", h.stub("output"));
vi.mock("../components/recording/RecordButton", h.stub("record"));
vi.mock("../components/recording/MonitorButton", h.stub("monitor"));
vi.mock("../components/recording/MicSelector", h.stub("mic"));
vi.mock("../components/recording/TakeList", h.stub("takes"));
vi.mock("../components/analysis/PianoRoll", h.stub("pianoRoll"));
vi.mock("../components/analysis/PianoKeyboard", h.stub("pianoKeyboard"));
vi.mock("../components/analysis/DynamicsCurve", h.stub("dynamics"));
vi.mock("../components/analysis/ShortTermSpectrumComparisonPanel", h.stub("spectrum"));
vi.mock("../components/analysis/VibratoCard", h.stub("vibrato"));
vi.mock("../components/analysis/TimingChart", h.stub("timing"));
vi.mock("../components/coaching/CoachPanel", h.stub("coach"));
vi.mock("../components/lyrics/LyricsPanel", h.stub("lyrics"));
vi.mock("../components/analysis/LivePitchFeed", h.stub("livePitchFeed"));
vi.mock("../components/panels/DetachHandle", async () => {
  const { createElement: el } = await import("react");
  return {
    default: ({ panel }: { panel: string }) => el("div", { "data-c": "detachHandle", "data-panel": panel }),
  };
});
vi.mock("../windows/useMainBridge", () => ({ useMainBridge: () => {} }));
vi.mock("../stores/detached", () => ({
  useDetachedStore: (sel: (s: unknown) => unknown) => sel({ detached: h.detached }),
}));
vi.mock("../components/panels/PanelMenu", async () => {
  const { createElement: el } = await import("react");
  return {
    default: ({
      panels, fixed,
    }: {
      panels: { id: string }[];
      fixed?: { items: { id: string; parts?: { id: string }[] }[]; tags?: Record<string, string> };
    }) =>
      el("div", {
        "data-c": "panelMenu",
        "data-ids": panels.map((p) => p.id).join(","),
        "data-fixed": fixed?.items.flatMap((i) => [i.id, ...(i.parts ?? []).map((p) => p.id)]).join(","),
        "data-tags": JSON.stringify(fixed?.tags ?? {}),
      }),
  };
});

import { PRACTICE_PANELS } from "../stores/panels";

// zustand renders the server snapshot (the store's initial state) under
// react-dom/server, so choices are seeded through storage and the page is
// imported fresh for every render.
async function render(overrides: Record<string, boolean> = {}, order?: string[], waveforms: Record<string, boolean> = {}) {
  localStorage.setItem("vps_panels", JSON.stringify({ overrides, order }));
  localStorage.setItem("vps_waveforms", JSON.stringify({ overrides: waveforms }));
  vi.resetModules();
  const { default: PracticeRoom } = await import("./PracticeRoom");
  return renderToStaticMarkup(createElement(PracticeRoom, { songId: "s1", onBack: () => {} }));
}

const only = (...ids: string[]) => Object.fromEntries(PRACTICE_PANELS.map((p) => [p.id, ids.includes(p.id)]));
const all = (value: boolean) => Object.fromEntries(PRACTICE_PANELS.map((p) => [p.id, value]));
const shown = (html: string) => [...html.matchAll(/data-c="(\w+)"/g)].map((m) => m[1]);

const song = (extra: object = {}) => ({ id: "s1", title: "Song", kind: "vocal", ...extra });

beforeEach(() => {
  localStorage.clear();
  h.library.songs = [song()];
  h.analysis.isLoaded = true;
  h.player.takes = [];
  h.player.activeTakeId = null;
  h.player.shownTakeIds = [];
  h.player.mutedTracks = {};
  h.player.soloedTrack = null;
  h.detached = {};
});

describe("PracticeRoom panels", () => {
  it("always shows the waveform, transport and recording controls", async () => {
    expect(shown(await render(all(false)))).toEqual(
      expect.arrayContaining(["waveform", "transport", "loop", "tempo", "mic", "output", "transpose", "monitor"]),
    );
  });

  it("leaves Record to the transport: the topbar no longer renders it", async () => {
    expect(shown(await render())).not.toContain("record");
  });

  it("puts Monitor between the Input and Output selectors, one input strip", async () => {
    const ids = shown(await render());
    expect(ids.indexOf("mic")).toBeLessThan(ids.indexOf("monitor"));
    expect(ids.indexOf("monitor")).toBeLessThan(ids.indexOf("output"));
    expect(ids.indexOf("output") - ids.indexOf("mic")).toBe(2);
  });

  it("lays the topbar out as tempo, then the input strip, then Transpose", async () => {
    const ids = shown(await render());
    expect(ids.indexOf("tempo")).toBeLessThan(ids.indexOf("mic"));
    expect(ids.indexOf("output")).toBeLessThan(ids.indexOf("transpose"));
  });

  it("starts with the default panels", async () => {
    const ids = shown(await render());
    expect(ids).toEqual(expect.arrayContaining(["takes", "lyrics", "pianoRoll", "pianoKeyboard", "vibrato", "coach"]));
    for (const c of ["spectrum", "dynamics", "timing"]) expect(ids).not.toContain(c);
  });

  it("shows nothing optional once everything is hidden, and leaves no empty slot", async () => {
    const html = await render(all(false));
    const optional = ["takes", "lyrics", "pianoRoll", "pianoKeyboard", "spectrum", "dynamics", "vibrato", "timing", "coach"];
    expect(shown(html).filter((c) => optional.includes(c))).toEqual([]);
    expect(html).not.toContain("sortable-panel");
    expect(html).not.toContain("practice-room__takes");
  });

  it("is one vertical column: there is never a side widget, whatever is on", async () => {
    for (const overrides of [{}, all(true), all(false), only("takes"), only("coach")]) {
      const html = await render(overrides);
      expect(html).not.toContain("practice-room__sidebar");
      expect(html).not.toContain("<aside");
    }
  });

  it("stacks the panels top to bottom: waveforms, lyrics, takes, pitch views, then feedback", async () => {
    const ids = shown(await render(all(true)));
    const order = ["waveform", "lyrics", "takes", "pianoKeyboard", "pianoRoll", "spectrum", "dynamics", "vibrato", "timing", "coach"];
    expect(ids.filter((c) => order.includes(c))).toEqual(order);
  });

  it.each([
    ["takes", ["takes"]],
    ["lyrics", ["lyrics"]],
    ["pianoRoll", ["pianoKeyboard", "pianoRoll"]],
    ["vibrato", ["vibrato"]],
    ["coach", ["coach"]],
  ])("hiding %s removes only %j", async (id, gone) => {
    const before = shown(await render());
    const after = shown(await render({ [id]: false }));
    expect(before.filter((c) => !after.includes(c)).sort()).toEqual([...gone].sort());
  });

  it.each(["spectrum", "dynamics", "timing"])("turning %s on shows it", async (id) => {
    expect(shown(await render({ [id]: true }))).toContain(id);
  });

  it("gives every panel on screen a slot of its own, and the takes slot keeps its sizing class", async () => {
    const html = await render(all(true));
    expect(html.match(/class="sortable-panel/g)).toHaveLength(8);
    expect(html.match(/practice-room__takes/g)).toHaveLength(1);
  });

  it("shows only the panels that are on", async () => {
    const html = await render(only("coach"));
    expect(shown(html)).toContain("coach");
    expect(shown(html)).not.toContain("takes");
    expect(html).not.toContain("practice-room__takes");
    expect(html.match(/class="sortable-panel/g)).toHaveLength(1);
  });

  describe("in the order the user chose", () => {
    const REVERSED = ["coach", "timing", "vibrato", "dynamics", "spectrum", "pianoRoll", "takes", "lyrics"];
    const inPage = (html: string) => shown(html).filter((c) => REVERSED.includes(c));

    it("draws the panels top to bottom as ordered, below the waveforms", async () => {
      const html = await render(all(true), REVERSED);
      expect(inPage(html)).toEqual(REVERSED);
      expect(shown(html).indexOf("waveform")).toBeLessThan(shown(html).indexOf("coach"));
    });

    it("lets any panel sit between any others, not only inside its old group", async () => {
      const html = await render(all(true), ["coach", "lyrics", "pianoRoll", "takes", "vibrato", "spectrum", "dynamics", "timing"]);
      expect(inPage(html)).toEqual(["coach", "lyrics", "pianoRoll", "takes", "vibrato", "spectrum", "dynamics", "timing"]);
    });

    it("keeps a panel's keyboard strip with its piano roll", async () => {
      const ids = shown(await render(only("pianoRoll", "coach"), ["coach", "pianoRoll"]));
      expect(ids.filter((c) => ["coach", "pianoKeyboard", "pianoRoll"].includes(c))).toEqual([
        "coach", "pianoKeyboard", "pianoRoll",
      ]);
    });

    it("keeps the order of what is left when a panel is hidden or detached", async () => {
      expect(inPage(await render({ ...all(true), takes: false }, REVERSED))).toEqual(REVERSED.filter((c) => c !== "takes"));
      h.detached = { vibrato: true };
      expect(inPage(await render(all(true), REVERSED))).toEqual(REVERSED.filter((c) => c !== "vibrato"));
    });

    it("puts a panel back in its place when it is docked again", async () => {
      const order = ["coach", "takes", ...REVERSED.filter((c) => c !== "coach" && c !== "takes")];
      h.detached = { takes: true };
      expect(inPage(await render(all(true), order))).toEqual(order.filter((c) => c !== "takes"));
      h.detached = {};
      expect(inPage(await render(all(true), order))).toEqual(order);
    });
  });

  it("has no analysis panels until the analysis has loaded, but still shows takes and lyrics", async () => {
    h.analysis.isLoaded = false;
    const ids = shown(await render(all(true)));
    expect(ids).toEqual(expect.arrayContaining(["takes", "lyrics"]));
    for (const c of ["pianoRoll", "pianoKeyboard", "spectrum", "dynamics"]) expect(ids).not.toContain(c);
  });

  it("has no lyrics for an instrument practice track, even when switched on", async () => {
    h.library.songs = [song({ kind: "instrument" })];
    expect(shown(await render(all(true)))).not.toContain("lyrics");
  });

  it("offers the menu only the panels this song can have", async () => {
    const menu = (html: string) => /data-ids="([^"]*)"/.exec(html)?.[1].split(",");
    expect(menu(await render())).toContain("lyrics");
    h.library.songs = [song({ kind: "instrument" })];
    expect(menu(await render())).not.toContain("lyrics");
  });

  const handles = (html: string) => [...html.matchAll(/data-panel="(\w+)"/g)].map((m) => m[1]).sort();

  it("offers a handle on every panel that is on screen", async () => {
    expect(handles(await render())).toEqual(["coach", "lyrics", "pianoRoll", "takes", "vibrato"]);
    expect(handles(await render(all(true)))).toEqual(
      ["coach", "dynamics", "lyrics", "pianoRoll", "spectrum", "takes", "timing", "vibrato"],
    );
  });

  it("offers no handle for a panel that is hidden", async () => {
    expect(handles(await render({ lyrics: false }))).not.toContain("lyrics");
  });

  it.each([
    ["takes", ["takes"]],
    ["lyrics", ["lyrics"]],
    ["pianoRoll", ["pianoKeyboard", "pianoRoll"]],
    ["spectrum", ["spectrum"]],
    ["dynamics", ["dynamics"]],
    ["vibrato", ["vibrato"]],
    ["timing", ["timing"]],
    ["coach", ["coach"]],
  ])("takes a detached %s out of the main window and nothing else", async (id, gone) => {
    const before = shown(await render(all(true)));
    h.detached = { [id]: true };
    const after = shown(await render(all(true)));
    const removed = before.filter((c) => !after.includes(c) && c !== "detachHandle");
    expect(removed.sort()).toEqual([...gone].sort());
  });

  it("frees the slot of a panel that is detached", async () => {
    h.detached = { takes: true, vibrato: true, timing: true, coach: true };
    const html = await render(all(true));
    expect(html).not.toContain("practice-room__takes");
    expect(html.match(/class="sortable-panel/g)).toHaveLength(4);
  });

  it("takes a detached piano roll out of the main window and frees its space", async () => {
    h.detached = { pianoRoll: true };
    const ids = shown(await render(only("pianoRoll")));
    for (const c of ["pianoRoll", "pianoKeyboard"]) expect(ids).not.toContain(c);
    expect(await render(only("pianoRoll"))).not.toContain("sortable-panel");
  });

  it("takes a detached lyrics panel out of the main window", async () => {
    h.detached = { lyrics: true };
    expect(shown(await render())).not.toContain("lyrics");
  });

  it("keeps everything else where it was when one panel is detached", async () => {
    const before = shown(await render());
    h.detached = { pianoRoll: true };
    const after = shown(await render());
    expect(before.filter((c) => !after.includes(c)).sort()).toEqual(["pianoKeyboard", "pianoRoll"]);
  });

  it("keeps listening to the microphone whichever panels are on screen", async () => {
    expect(shown(await render(all(false)))).toContain("livePitchFeed");
    h.detached = { pianoRoll: true, lyrics: true };
    expect(shown(await render(all(true)))).toContain("livePitchFeed");
  });

  it("no longer has the old Analysis tab: visibility is the user's, not automatic", async () => {
    h.player.activeTakeId = "t1";
    h.player.takes = [{ id: "t1" }];
    expect(await render()).not.toContain("analysis-tab");
  });
});

describe("PracticeRoom waveform area", () => {
  const COLLAPSED = "practice-room__waveforms--collapsed";

  it("shows the waveforms by default", async () => {
    const html = await render();
    expect(html).toContain('class="practice-room__waveforms"');
    expect(html).not.toContain(COLLAPSED);
  });

  it("collapses the area when it is switched off, and still mounts it so the audio keeps loading", async () => {
    const html = await render({}, undefined, { waveforms: false });
    expect(html).toContain(COLLAPSED);
    expect(shown(html)).toContain("waveform");
  });

  it("keeps the area, and so the strips, when every track is minimized", async () => {
    expect(await render({}, undefined, { vocals: false, instrumental: false })).not.toContain(COLLAPSED);
  });

  it("keeps the area for an instrument track whose melody is minimized", async () => {
    h.library.songs = [song({ kind: "instrument" })];
    expect(await render({}, undefined, { vocals: false })).not.toContain(COLLAPSED);
  });

  it("is not affected by the other panels being hidden", async () => {
    expect(await render(all(false))).not.toContain(COLLAPSED);
  });

  it("lists the waveforms first in the Panels menu, with their tracks", async () => {
    const fixed = (html: string) => /data-fixed="([^"]*)"/.exec(html)?.[1];
    expect(fixed(await render())).toBe("waveforms,vocals,instrumental");
    h.library.songs = [song({ kind: "instrument" })];
    expect(fixed(await render())).toBe("waveforms,vocals");
  });

  it("tells the menu which hidden track is muted or soloed", async () => {
    const tags = (html: string) => JSON.parse((/data-tags="([^"]*)"/.exec(html)?.[1] ?? "{}").replace(/&quot;/g, '"'));
    h.player.mutedTracks = { instrumental: true };
    expect(tags(await render({}, undefined, { instrumental: false }))).toEqual({ instrumental: "muted" });
    h.player.soloedTrack = "vocals";
    expect(tags(await render({}, undefined, { vocals: false }))).toEqual({ vocals: "solo" });
  });
});
