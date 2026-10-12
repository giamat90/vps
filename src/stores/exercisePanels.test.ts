import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe("Free Exercise panels", () => {
  it("shows everything until the user chooses otherwise", async () => {
    const { EXERCISE_PANELS, useExercisePanels } = await import("./exercisePanels");
    const visible = useExercisePanels.getState().visible;
    expect(Object.keys(visible)).toEqual(EXERCISE_PANELS.map((p) => p.id));
    expect(Object.values(visible).every(Boolean)).toBe(true);
  });

  it("remembers the choices under its own key, apart from the practice room", async () => {
    const { useExercisePanels } = await import("./exercisePanels");
    useExercisePanels.getState().toggle("dynamics");
    expect(JSON.parse(localStorage.getItem("vps_exercise_panels") ?? "null")).toEqual({ overrides: { dynamics: false } });
    expect(localStorage.getItem("vps_panels")).toBeNull();
    expect((await import("./exercisePanels")).useExercisePanels.getState().visible.dynamics).toBe(false);
  });

  it("lists the analysis views in the order the page draws them, all of them registered panels", async () => {
    const { EXERCISE_ANALYSIS_PANELS, EXERCISE_PANELS } = await import("./exercisePanels");
    const ids = EXERCISE_PANELS.map((p) => p.id as string);
    expect(EXERCISE_ANALYSIS_PANELS.every((id) => ids.includes(id))).toBe(true);
    expect([...EXERCISE_ANALYSIS_PANELS].sort((a, b) => ids.indexOf(a) - ids.indexOf(b))).toEqual([...EXERCISE_ANALYSIS_PANELS]);
  });
});
