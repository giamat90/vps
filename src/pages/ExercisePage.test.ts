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
    player: {
      currentTime: 0, isPlaying: false, isRecording: false, isSavingTake: false, isMonitoring: false,
      startExercise: () => {}, stopExercise: () => {}, startExerciseRecording: () => {}, stopExerciseRecording: () => {},
      playExerciseTrack: () => {}, pauseExerciseTrack: () => {},
    },
    exercise: {
      addExerciseTake: () => {}, fetchExerciseTakes: () => {}, loadedTrackId: null as string | null,
      isImporting: false, clearLoadedTrack: () => {}, importExerciseFile: () => {},
    },
  };
});

vi.mock("../stores/player", () => ({ usePlayerStore: (sel: (s: unknown) => unknown) => sel(h.player) }));
vi.mock("../stores/exercise", () => ({ useExerciseStore: (sel: (s: unknown) => unknown) => sel(h.exercise) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("../components/upload/DropZone", () => ({ AUDIO_EXTENSIONS: ["wav"] }));
vi.mock("../components/analysis/PianoRoll", h.stub("pianoRoll"));
vi.mock("../components/analysis/PianoKeyboard", h.stub("keyboard"));
vi.mock("../components/analysis/LivePitchFeed", h.stub("livePitchFeed"));
vi.mock("../components/analysis/SpectrogramPanel", h.stub("spectrogram"));
vi.mock("../components/analysis/ShortTermSpectrumPanel", h.stub("spectrum"));
vi.mock("../components/analysis/DynamicsCurve", h.stub("dynamics"));
vi.mock("../components/analysis/VibratoCard", h.stub("vibrato"));
vi.mock("../components/recording/MicSelector", h.stub("mic"));
vi.mock("../components/recording/MonitorButton", h.stub("monitor"));
vi.mock("../components/recording/ExerciseTakeList", h.stub("recordings"));
vi.mock("../components/panels/PanelMenu", async () => {
  const { createElement: el } = await import("react");
  return {
    default: ({ panels, movable }: { panels: { id: string }[]; movable?: boolean }) =>
      el("div", { "data-c": "panelMenu", "data-ids": panels.map((p) => p.id).join(","), "data-movable": String(movable) }),
  };
});

import { EXERCISE_PANELS } from "../stores/exercisePanels";

// zustand renders the store's initial state under react-dom/server, so the
// user's choices are seeded through storage and the page is imported again.
async function render(hidden: string[] = []) {
  localStorage.setItem(
    "vps_exercise_panels",
    JSON.stringify({ overrides: Object.fromEntries(hidden.map((id) => [id, false])) }),
  );
  vi.resetModules();
  const { default: ExercisePage } = await import("./ExercisePage");
  return renderToStaticMarkup(createElement(ExercisePage, { onBack: () => {} }));
}

const shown = (html: string) => [...html.matchAll(/data-c="(\w+)"/g)].map((m) => m[1]);
const STRIP = "exercise-page__track-strip";
const ALL = EXERCISE_PANELS.map((p) => p.id);

beforeEach(() => {
  localStorage.clear();
  h.exercise.loadedTrackId = null;
});

describe("Free Exercise panels", () => {
  it("shows everything by default, as the page always did", async () => {
    const html = await render();
    expect(shown(html)).toEqual(
      expect.arrayContaining(["keyboard", "pianoRoll", "spectrogram", "spectrum", "dynamics", "vibrato", "recordings"]),
    );
    expect(html).toContain(STRIP);
    expect(html).not.toContain("--collapsed");
  });

  it("has a panels menu with every panel, which cannot be moved", async () => {
    const html = await render();
    expect(/data-ids="([^"]*)"/.exec(html)?.[1].split(",")).toEqual(ALL);
    expect(html).toContain('data-movable="false"');
  });

  it.each([
    ["keyboard", ["keyboard"]],
    ["pianoRoll", ["pianoRoll"]],
    ["spectrogram", ["spectrogram"]],
    ["spectrum", ["spectrum"]],
    ["dynamics", ["dynamics"]],
    ["vibrato", ["vibrato"]],
    ["recordings", ["recordings"]],
  ])("hiding %s removes only %j", async (id, gone) => {
    const before = shown(await render());
    const after = shown(await render([id]));
    expect(before.filter((c) => !after.includes(c)).sort()).toEqual([...gone].sort());
  });

  it("collapses the loaded-track strip instead of removing it, so a track can still be loaded into it", async () => {
    const html = await render(["track"]);
    expect(html).toContain(`${STRIP} ${STRIP}--collapsed`);
    expect(shown(html)).toEqual(shown(await render()));
  });

  it("keeps the transport of a loaded track when its waveform is hidden", async () => {
    h.exercise.loadedTrackId = "t1";
    const html = await render(["track"]);
    expect(html).toContain("exercise-page__transport");
  });

  it("drops the analysis area once every view in it is hidden, and keeps the controls", async () => {
    const html = await render(["pianoRoll", "spectrogram", "spectrum", "dynamics", "vibrato"]);
    expect(html).not.toContain("exercise-page__analysis");
    expect(shown(html)).toEqual(expect.arrayContaining(["mic", "monitor", "keyboard", "recordings"]));
  });

  it("keeps listening to the microphone whichever panels are on screen", async () => {
    expect(shown(await render(ALL.filter((id) => id !== "track")))).toContain("livePitchFeed");
  });
});
