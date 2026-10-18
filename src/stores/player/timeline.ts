import { setMetronomeOffsetApi } from "../../lib/tauri";
import type { Slice, TimelineSlice } from "./types";

export const createTimelineSlice: Slice<TimelineSlice> = (set, get) => ({
  minPxPerSec: 1,
  scrollTime: 0,
  metronomeOffset: 0,

  setZoom: (minPxPerSec, scrollTime) => set({ minPxPerSec, scrollTime }),
  setScrollTime: (scrollTime) => set({ scrollTime }),

  setMetronomeOffset: (t) => {
    const { song, duration } = get();
    if (!song) return;
    const clamped = Math.max(0, Math.min(duration > 0 ? duration : Math.max(0, t), t));
    set({ metronomeOffset: clamped, song: { ...song, metronomeOffset: clamped } });
    setMetronomeOffsetApi(song.id, clamped).catch((e: unknown) =>
      console.error("[player] failed to persist metronome offset:", e)
    );
  },
});
