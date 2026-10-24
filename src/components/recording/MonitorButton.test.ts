import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  player: {
    isMonitoring: false,
    isRecording: false,
    isCountingIn: false,
    countInBars: 0,
    exerciseMode: false,
    startMonitoring: async () => {},
    stopMonitoring: async () => {},
  },
  loadedTrackId: null as string | null,
}));

vi.mock("../../stores/player", () => ({ usePlayerStore: (sel: (s: unknown) => unknown) => sel(h.player) }));
vi.mock("../../stores/exercise", () => ({
  useExerciseStore: (sel: (s: unknown) => unknown) => sel({ loadedTrackId: h.loadedTrackId }),
}));

import MonitorButton from "./MonitorButton";

const render = () => renderToStaticMarkup(createElement(MonitorButton));

beforeEach(() => {
  Object.assign(h.player, { isMonitoring: false, isRecording: false, isCountingIn: false, countInBars: 0, exerciseMode: false });
  h.loadedTrackId = null;
});

describe("MonitorButton", () => {
  it("is a labelled toggle, so it can sit in the input strip beside the selectors", () => {
    const html = render();
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(">Monitor<");
    expect(html).not.toContain("monitor-btn--active");
  });

  it("hides the icon from assistive technology, leaving 'Monitor' as the name", () => {
    expect(render()).toMatch(/<span class="monitor-btn__icon" aria-hidden="true">/);
  });

  it("reads as pressed while monitoring", () => {
    h.player.isMonitoring = true;
    const html = render();
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("monitor-btn--active");
  });

  it("is disabled while recording, which owns the microphone", () => {
    h.player.isRecording = true;
    expect(render()).toMatch(/<button[^>]*disabled/);
  });

  it("stays enabled during a count-in once monitoring, so the count-in can be cancelled", () => {
    h.player.isMonitoring = true;
    h.player.isCountingIn = true;
    expect(render()).not.toMatch(/<button[^>]*disabled/);
  });

  it("is disabled during a count-in that monitoring did not start", () => {
    h.player.isCountingIn = true;
    expect(render()).toMatch(/<button[^>]*disabled/);
  });
});
