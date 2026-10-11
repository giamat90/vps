import { describe, it, expect, beforeEach } from "vitest";
import { useDetachedStore } from "./detached";

beforeEach(() => {
  useDetachedStore.getState().reset();
});

describe("detached panels", () => {
  it("starts with everything docked", () => {
    expect(useDetachedStore.getState().detached).toEqual({});
  });

  it("marks a panel detached and docked again", () => {
    useDetachedStore.getState().markDetached("pianoRoll");
    expect(useDetachedStore.getState().detached).toEqual({ pianoRoll: true });
    useDetachedStore.getState().markDocked("pianoRoll");
    expect(useDetachedStore.getState().detached.pianoRoll).toBeFalsy();
  });

  it("keeps panels independent", () => {
    useDetachedStore.getState().markDetached("pianoRoll");
    useDetachedStore.getState().markDetached("lyrics");
    useDetachedStore.getState().markDocked("pianoRoll");
    expect(useDetachedStore.getState().detached).toMatchObject({ lyrics: true });
    expect(useDetachedStore.getState().detached.pianoRoll).toBeFalsy();
  });

  it("ignores a docked announcement for a panel it does not know", () => {
    useDetachedStore.getState().markDetached("lyrics");
    useDetachedStore.getState().markDocked("takes");
    expect(useDetachedStore.getState().detached).toEqual({ lyrics: true });
  });

  it("reset docks everything", () => {
    useDetachedStore.getState().markDetached("lyrics");
    useDetachedStore.getState().reset();
    expect(useDetachedStore.getState().detached).toEqual({});
  });
});
