import { addLoop, removeLoop, renameLoop as renameLoopIn } from "@giamat90/mps-core/loops";
import { setSongLoopsApi } from "../../lib/tauri";
import type { NamedLoop } from "../../lib/types";
import type { PunchSlice, Slice, StoreGet, StoreSet } from "./types";

async function persistLoops(set: StoreSet, get: StoreGet, songId: string, loops: NamedLoop[]): Promise<void> {
  const saved = await setSongLoopsApi(songId, loops);
  const current = get().song;
  if (current && current.id === songId) set({ song: { ...current, loops: saved.loops ?? [] } });
}

export const createPunchSlice: Slice<PunchSlice> = (set, get) => ({
  punchIn: null,
  punchOut: null,
  punchLoop: false,

  setPunchIn:   (t) => set({ punchIn: t }),
  setPunchOut:  (t) => set({ punchOut: t }),
  clearPunch:   ()  => set({ punchIn: null, punchOut: null, punchLoop: false }),
  setPunchLoop: (v) => set({ punchLoop: v }),

  saveLoop: async (name) => {
    const { song, punchIn, punchOut, duration } = get();
    if (!song) return;
    if (punchIn === null || punchOut === null) throw new Error("Set a punch region first");
    const next = addLoop(song.loops ?? [], { id: crypto.randomUUID(), name, start: punchIn, end: punchOut }, duration);
    await persistLoops(set, get, song.id, next);
  },

  renameLoop: async (id, name) => {
    const { song } = get();
    if (!song) return;
    await persistLoops(set, get, song.id, renameLoopIn(song.loops ?? [], id, name));
  },

  deleteLoop: async (id) => {
    const { song } = get();
    if (!song) return;
    await persistLoops(set, get, song.id, removeLoop(song.loops ?? [], id));
  },

  applyLoopRegion: (start, end) => {
    set({ punchIn: start, punchOut: end, punchLoop: true });
    get().seek(start);
  },
});
