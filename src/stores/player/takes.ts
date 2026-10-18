import { hideTake, reconcileTakes, showTake, toggleTake, type TakeSelection } from "@giamat90/mps-core/takes";
import { deleteTakeApi, listTakes, renameTakeApi, setTakeManualOffsetApi } from "../../lib/tauri";
import { useAnalysisStore } from "../analysis";
import { loadTakePrefs, persistTakePrefs } from "./persistence";
import { getEngine } from "./singletons";
import type { PlayerStore, Slice, StoreGet, StoreSet, TakesSlice } from "./types";

export const selectionOf = (s: { shownTakeIds: string[]; activeTakeId: string | null }): TakeSelection => ({
  shown: s.shownTakeIds,
  active: s.activeTakeId,
});

// What follows a take leaving the list: its mute, its gain and a solo on it go with it.
function pruneTakeState(state: PlayerStore, keep: (id: string) => boolean) {
  return {
    mutedTakeIds: state.mutedTakeIds.filter(keep),
    takeGains: Object.fromEntries(Object.entries(state.takeGains).filter(([id]) => keep(id))),
    ...(state.soloedTakeId !== null && !keep(state.soloedTakeId) ? { soloedTakeId: null } : {}),
  };
}

function applySelection(set: StoreSet, get: StoreGet, next: TakeSelection): void {
  const s = get();
  const stillSoloed = s.soloedTakeId !== null && next.shown.includes(s.soloedTakeId);
  set({
    shownTakeIds: [...next.shown],
    activeTakeId: next.active,
    ...(s.soloedTakeId !== null && !stillSoloed ? { soloedTakeId: null } : {}),
  });
}

async function deleteEach(songId: string, takeIds: string[]): Promise<{ deleted: Set<string>; failure: unknown }> {
  const deleted = new Set<string>();
  for (const id of takeIds) {
    try {
      await deleteTakeApi(songId, id);
      deleted.add(id);
    } catch (e) {
      return { deleted, failure: e };
    }
  }
  return { deleted, failure: null };
}

export const createTakesSlice: Slice<TakesSlice> = (set, get) => ({
  takes: [],
  shownTakeIds: [],
  activeTakeId: null,
  mutedTakeIds: [],
  soloedTakeId: null,
  takeGains: {},
  ...loadTakePrefs(),

  fetchTakes: async () => {
    const { song } = get();
    if (!song) return;
    const takes = await listTakes(song.id);
    const ids = takes.map((t) => t.id);
    const next = reconcileTakes(selectionOf(get()), ids);
    set({
      takes,
      shownTakeIds: [...next.shown],
      activeTakeId: next.active,
      ...pruneTakeState(get(), (id) => ids.includes(id)),
    });
  },

  deleteTake: async (takeId) => {
    const { song } = get();
    if (!song) return;
    await deleteTakeApi(song.id, takeId);
    const next = hideTake(selectionOf(get()), takeId);
    set({
      takes: get().takes.filter((t) => t.id !== takeId),
      shownTakeIds: [...next.shown],
      activeTakeId: next.active,
      ...pruneTakeState(get(), (id) => id !== takeId),
    });
  },

  deleteAllTakes: async () => {
    const { song, takes } = get();
    if (!song || takes.length === 0) return;
    const { deleted, failure } = await deleteEach(song.id, takes.map((t) => t.id));
    const remaining = takes.filter((t) => !deleted.has(t.id)).map((t) => t.id);
    const next = reconcileTakes(selectionOf(get()), remaining);
    set({
      takes: get().takes.filter((t) => !deleted.has(t.id)),
      shownTakeIds: [...next.shown],
      activeTakeId: next.active,
      ...pruneTakeState(get(), (id) => !deleted.has(id)),
    });
    if (failure) throw failure;
  },

  renameTake: async (takeId, name) => {
    const { song } = get();
    if (!song) return;
    const updated = await renameTakeApi(song.id, takeId, name);
    set({ takes: get().takes.map((t) => (t.id === takeId ? updated : t)) });
  },

  setTakeManualOffset: (takeId, offset) => {
    const { song, takes } = get();
    if (!song) return;
    const take = takes.find((t) => t.id === takeId);
    if (!take) return;
    // Unclamped — a take can be dragged to start before song time 0. Its
    // leading edge just becomes unreachable during playback; the recorded
    // file itself is never trimmed or otherwise modified.
    const rounded = Math.round(offset * 100) / 100;
    const updated = { ...take, manualOffset: rounded || undefined };
    set({ takes: takes.map((t) => (t.id === takeId ? updated : t)) });
    getEngine().setTakeManualOffset(takeId, rounded);
    // The analysis overlays belong to the active take only.
    if (takeId === get().activeTakeId) useAnalysisStore.getState().loadTakeAnalysis(updated);
    setTakeManualOffsetApi(song.id, takeId, rounded).catch((e: unknown) =>
      console.error("[player] failed to persist take manual offset:", e)
    );
  },

  setActiveTake: (takeId) => {
    applySelection(set, get, showTake(selectionOf(get()), takeId));
  },

  toggleTake: (takeId) => {
    applySelection(set, get, toggleTake(selectionOf(get()), takeId));
  },

  hideTake: (takeId) => {
    applySelection(set, get, hideTake(selectionOf(get()), takeId));
  },

  setTakePlayback: (mode) => {
    set({ takePlayback: mode });
    persistTakePrefs({ takePlayback: mode, muteTakesWhileRecording: get().muteTakesWhileRecording });
  },

  toggleTakeMute: (takeId) => {
    const { mutedTakeIds } = get();
    set({
      mutedTakeIds: mutedTakeIds.includes(takeId) ? mutedTakeIds.filter((id) => id !== takeId) : [...mutedTakeIds, takeId],
    });
  },

  toggleTakeSolo: (takeId) => {
    set({ soloedTakeId: get().soloedTakeId === takeId ? null : takeId });
  },

  setTakeGain: (takeId, gain) => {
    set({ takeGains: { ...get().takeGains, [takeId]: Math.max(0, Math.min(1, gain)) } });
  },

  setMuteTakesWhileRecording: (mute) => {
    set({ muteTakesWhileRecording: mute });
    persistTakePrefs({ takePlayback: get().takePlayback, muteTakesWhileRecording: mute });
  },
});
