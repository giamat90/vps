import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const fresh = () => import("./topbar");

describe("top bar cards", () => {
  it("starts in the order the bar was designed in", async () => {
    const { useTopbarOrder } = await fresh();
    expect(useTopbarOrder.getState().order).toEqual(["transport", "loop", "tempo", "devices", "transpose"]);
  });

  it("has no fixed lines: any card can be put in the place of any other", async () => {
    const { useTopbarOrder } = await fresh();
    useTopbarOrder.getState().move("transpose", "transport");
    expect(useTopbarOrder.getState().order).toEqual(["transpose", "transport", "loop", "tempo", "devices"]);
    useTopbarOrder.getState().move("transport", "devices");
    expect(useTopbarOrder.getState().order).toEqual(["transpose", "loop", "tempo", "devices", "transport"]);
  });

  it("remembers the order under vps_topbar and never touches the panels' vps_panels", async () => {
    const { useTopbarOrder } = await fresh();
    useTopbarOrder.getState().move("loop", "transport");
    expect(JSON.parse(localStorage.getItem("vps_topbar") ?? "null").order[0]).toBe("loop");
    expect(localStorage.getItem("vps_panels")).toBeNull();
    const again = (await fresh()).useTopbarOrder;
    expect(again.getState().order[0]).toBe("loop");
  });

  it("is not changed by moving the panels under the stems", async () => {
    const { useTopbarOrder } = await fresh();
    const { usePracticePanels } = await import("./panels");
    usePracticePanels.getState().move("takes", "lyrics");
    expect(useTopbarOrder.getState().order).toEqual(["transport", "loop", "tempo", "devices", "transpose"]);
    expect(localStorage.getItem("vps_topbar")).toBeNull();
  });

  it("puts the cards back in their usual order", async () => {
    const { useTopbarOrder } = await fresh();
    useTopbarOrder.getState().move("transpose", "transport");
    useTopbarOrder.getState().resetOrder();
    expect(useTopbarOrder.getState().order).toEqual(["transport", "loop", "tempo", "devices", "transpose"]);
  });
});
