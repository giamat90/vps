import { describe, it, expect } from "vitest";
import { decideDrop } from "./dropGesture";

const base = { innerWidth: 1200, innerHeight: 800, screenX: 500, screenY: 400 };

describe("decideDrop", () => {
  it("keeps the panel docked when released inside the window", () => {
    expect(decideDrop({ ...base, clientX: 600, clientY: 300 })).toEqual({ detach: false });
    expect(decideDrop({ ...base, clientX: 0, clientY: 0 })).toEqual({ detach: false });
    expect(decideDrop({ ...base, clientX: 1199, clientY: 799 })).toEqual({ detach: false });
  });

  it("keeps it docked for a release just past the edge, within the margin", () => {
    expect(decideDrop({ ...base, clientX: -4, clientY: 100 })).toEqual({ detach: false });
    expect(decideDrop({ ...base, clientX: 1204, clientY: 100 })).toEqual({ detach: false });
  });

  it.each([
    ["left", { clientX: -40, clientY: 300 }],
    ["right", { clientX: 1300, clientY: 300 }],
    ["above", { clientX: 600, clientY: -30 }],
    ["below", { clientX: 600, clientY: 900 }],
  ])("detaches when released well past the %s edge", (_side, pos) => {
    expect(decideDrop({ ...base, ...pos })).toMatchObject({ detach: true });
  });

  it("puts the new window under the cursor, with the title bar near it", () => {
    const d = decideDrop({ ...base, clientX: 1300, clientY: 300, screenX: 2500, screenY: 600 });
    expect(d).toEqual({ detach: true, x: 2460, y: 584 });
  });

  it("never asks for a position off the top-left of the screen", () => {
    const d = decideDrop({ ...base, clientX: -100, clientY: -100, screenX: 10, screenY: 5 });
    expect(d).toEqual({ detach: true, x: 0, y: 0 });
  });

  it("treats a non-finite pointer position as a cancelled drag", () => {
    expect(decideDrop({ ...base, clientX: Number.NaN, clientY: 0 })).toEqual({ detach: false });
    expect(decideDrop({ ...base, clientX: -100, clientY: 0, screenX: Number.NaN })).toEqual({ detach: false });
  });
});
