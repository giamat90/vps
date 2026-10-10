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
    library: { songs: [] as unknown[], renameSong: () => {} },
    player: { cleanup: () => {}, takes: [] as unknown[], activeTakeId: null as string | null },
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
vi.mock("../components/panels/PanelMenu", async () => {
  const { createElement: el } = await import("react");
  return {
    default: ({ panels }: { panels: { id: string }[] }) =>
      el("div", { "data-c": "panelMenu", "data-ids": panels.map((p) => p.id).join(",") }),
  };
});

import { PRACTICE_PANELS } from "../stores/panels";

// zustand renders the server snapshot (the store's initial state) under
// react-dom/server, so choices are seeded through storage and the page is
// imported fresh for every render.
async function render(overrides: Record<string, boolean> = {}) {
  localStorage.setItem("vps_panels", JSON.stringify({ overrides }));
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
});

describe("PracticeRoom panels", () => {
  it("always shows the waveform, transport and recording controls", async () => {
    expect(shown(await render(all(false)))).toEqual(
      expect.arrayContaining(["waveform", "transport", "loop", "tempo", "mic", "output", "transpose", "monitor", "record"]),
    );
  });

  it("starts with the default panels", async () => {
    const ids = shown(await render());
    expect(ids).toEqual(expect.arrayContaining(["takes", "lyrics", "pianoRoll", "pianoKeyboard", "vibrato", "coach"]));
    for (const c of ["spectrum", "dynamics", "timing"]) expect(ids).not.toContain(c);
  });

  it("shows nothing optional once everything is hidden, and drops the empty groups", async () => {
    const html = await render(all(false));
    const optional = ["takes", "lyrics", "pianoRoll", "pianoKeyboard", "spectrum", "dynamics", "vibrato", "timing", "coach"];
    expect(shown(html).filter((c) => optional.includes(c))).toEqual([]);
    for (const cls of ["practice-room__takes", "practice-room__feedback", "practice-room__analysis"]) {
      expect(html).not.toContain(cls);
    }
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

  it("keeps the feedback group while any of vibrato, timing or coach is on, and shows only those", async () => {
    const html = await render(only("coach"));
    expect(html).toContain("practice-room__feedback");
    expect(shown(html)).toContain("coach");
    expect(shown(html)).not.toContain("takes");
    expect(html).not.toContain("practice-room__takes");
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

  it("no longer has the old Analysis tab: visibility is the user's, not automatic", async () => {
    h.player.activeTakeId = "t1";
    h.player.takes = [{ id: "t1" }];
    expect(await render()).not.toContain("analysis-tab");
  });
});
