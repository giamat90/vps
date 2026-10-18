import { describe, it, expect } from "vitest";
import {
  beginPunchDrag,
  finishPunchDrag,
  hoverCursor,
  timeToPx,
  updatePunchOverride,
  xToTime,
} from "./pianoRollPunch";
import { PIANO_W, WINDOW_S } from "./pianoRollGeometry";

const rollW = 800;
const t0 = 6;

describe("time <-> pixel", () => {
  it("round-trips", () => {
    for (const t of [6, 8.5, 13.99]) expect(xToTime(timeToPx(t, t0, rollW), t0, rollW)).toBeCloseTo(t, 9);
  });

  it("maps the window edges to the roll edges", () => {
    expect(timeToPx(t0, t0, rollW)).toBe(PIANO_W);
    expect(timeToPx(t0 + WINDOW_S, t0, rollW)).toBe(PIANO_W + rollW);
  });
});

describe("beginPunchDrag", () => {
  it("starts a new region in empty space, with a zero-width preview", () => {
    const x = timeToPx(9, t0, rollW);
    const { drag, override } = beginPunchDrag(x, rollW, t0, null, null);
    expect(drag.mode).toBe("create");
    expect(drag.anchorT).toBeCloseTo(9, 9);
    expect(drag.capturedT0).toBe(t0);
    expect(override.inT).toBeCloseTo(9, 9);
    expect(override.outT).toBeCloseTo(9, 9);
  });

  it("grabs the in handle and anchors on the out point", () => {
    const { drag, override } = beginPunchDrag(timeToPx(8, t0, rollW) + 5, rollW, t0, 8, 11);
    expect(drag.mode).toBe("drag-in");
    expect(drag.anchorT).toBe(11);
    expect(override.outT).toBe(11);
  });

  it("grabs the out handle and anchors on the in point", () => {
    const { drag, override } = beginPunchDrag(timeToPx(11, t0, rollW) - 5, rollW, t0, 8, 11);
    expect(drag.mode).toBe("drag-out");
    expect(drag.anchorT).toBe(8);
    expect(override.inT).toBe(8);
  });

  it("creates a region when a region exists but the click is away from both handles", () => {
    expect(beginPunchDrag(timeToPx(9.5, t0, rollW), rollW, t0, 8, 11).drag.mode).toBe("create");
  });

  it("creates a region when only one boundary is set", () => {
    expect(beginPunchDrag(timeToPx(8, t0, rollW), rollW, t0, 8, null).drag.mode).toBe("create");
  });
});

describe("updatePunchOverride", () => {
  it("orders the two ends while creating, in either direction", () => {
    const drag = { mode: "create" as const, anchorT: 9, capturedT0: t0 };
    expect(updatePunchOverride(drag, 12)).toEqual({ inT: 9, outT: 12 });
    expect(updatePunchOverride(drag, 7)).toEqual({ inT: 7, outT: 9 });
  });

  it("keeps the in handle 0.1 s before the out anchor", () => {
    const drag = { mode: "drag-in" as const, anchorT: 11, capturedT0: t0 };
    expect(updatePunchOverride(drag, 9)).toEqual({ inT: 9, outT: 11 });
    expect(updatePunchOverride(drag, 15)).toEqual({ inT: 10.9, outT: 11 });
  });

  it("keeps the out handle 0.1 s after the in anchor", () => {
    const drag = { mode: "drag-out" as const, anchorT: 8, capturedT0: t0 };
    expect(updatePunchOverride(drag, 12)).toEqual({ inT: 8, outT: 12 });
    expect(updatePunchOverride(drag, 3)).toEqual({ inT: 8, outT: 8.1 });
  });
});

describe("finishPunchDrag", () => {
  it("commits a created region rounded to tenths", () => {
    const drag = { mode: "create" as const, anchorT: 9.04, capturedT0: t0 };
    expect(finishPunchDrag(drag, 12.26)).toEqual({ type: "range", inT: 9, outT: 12.3 });
    expect(finishPunchDrag(drag, 6.96)).toEqual({ type: "range", inT: 7, outT: 9 });
  });

  it("clears the punch for a click or a drag under half a second", () => {
    const drag = { mode: "create" as const, anchorT: 9, capturedT0: t0 };
    expect(finishPunchDrag(drag, 9.2)).toEqual({ type: "clear" });
    expect(finishPunchDrag(drag, 9.5)).toEqual({ type: "range", inT: 9, outT: 9.5 });
  });

  it("commits a moved handle, never closer than 0.1 s to its anchor", () => {
    expect(finishPunchDrag({ mode: "drag-in", anchorT: 11, capturedT0: t0 }, 9.123)).toEqual({ type: "in", t: 9.1 });
    expect(finishPunchDrag({ mode: "drag-in", anchorT: 11, capturedT0: t0 }, 20)).toEqual({ type: "in", t: 10.9 });
    expect(finishPunchDrag({ mode: "drag-out", anchorT: 8, capturedT0: t0 }, 12.46)).toEqual({ type: "out", t: 12.5 });
    expect(finishPunchDrag({ mode: "drag-out", anchorT: 8, capturedT0: t0 }, 1)).toEqual({ type: "out", t: 8.1 });
  });
});

describe("hoverCursor", () => {
  it("shows a resize cursor near either handle of the live window", () => {
    const now = 10;
    const live0 = now - WINDOW_S / 2;
    expect(hoverCursor(timeToPx(9, live0, rollW), rollW, now, 9, 12)).toBe("ew-resize");
    expect(hoverCursor(timeToPx(12, live0, rollW) + 3, rollW, now, 9, 12)).toBe("ew-resize");
    expect(hoverCursor(timeToPx(10.5, live0, rollW), rollW, now, 9, 12)).toBe("crosshair");
  });
});
