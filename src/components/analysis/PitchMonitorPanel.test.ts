import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ folded: false, rollProps: [] as unknown[] }));

vi.mock("../../stores/collapsed", () => ({
  usePanelCollapse: (id: string) => {
    h.rollProps.push(id);
    return { open: !h.folded, toggle: () => {}, buttonProps: { type: "button", onClick: () => {}, "aria-expanded": !h.folded } };
  },
}));
vi.mock("./PianoKeyboard", async () => {
  const { createElement: el } = await import("react");
  return { default: () => el("div", { "data-c": "keyboard" }) };
});
vi.mock("./PianoRoll", async () => {
  const { createElement: el } = await import("react");
  return { default: (p: { collapsible?: boolean }) => el("div", { "data-c": "roll", "data-collapsible": String(p.collapsible) }) };
});

import PitchMonitorPanel from "./PitchMonitorPanel";

const render = () => renderToStaticMarkup(createElement(PitchMonitorPanel));

beforeEach(() => {
  h.folded = false;
  h.rollProps = [];
});

describe("PitchMonitorPanel", () => {
  it("shows the keyboard with the roll under it, the roll without a button of its own", () => {
    expect(render()).toBe('<div data-c="keyboard"></div><div data-c="roll" data-collapsible="false"></div>');
  });

  it("folds the roll away with the keyboard's button, under the id of the whole panel", () => {
    h.folded = true;
    expect(render()).toBe('<div data-c="keyboard"></div>');
    expect(h.rollProps).toContain("pitchMonitor");
  });
});
