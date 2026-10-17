import { applyEffectiveVolumes } from "./volume";
import type { MixerSlice, Slice } from "./types";

export const createMixerSlice: Slice<MixerSlice> = (set, get) => ({
  vocalsVolume: 1.0,
  instrumentalVolume: 1.0,
  takeVolume: 1.0,
  mutedTracks: { vocals: false, instrumental: false, take: false },
  soloedTrack: null,

  setVocalsVolume: (v) => {
    set({ vocalsVolume: v });
    applyEffectiveVolumes(get());
  },

  setInstrumentalVolume: (v) => {
    set({ instrumentalVolume: v });
    applyEffectiveVolumes(get());
  },

  setTakeVolume: (v) => {
    set({ takeVolume: v });
    applyEffectiveVolumes(get());
  },

  toggleMute: (track) => {
    const { mutedTracks } = get();
    set({ mutedTracks: { ...mutedTracks, [track]: !mutedTracks[track] } });
    applyEffectiveVolumes(get());
  },

  toggleSolo: (track) => {
    set({ soloedTrack: get().soloedTrack === track ? null : track });
    applyEffectiveVolumes(get());
  },

  syncTrackVolumes: () => {
    applyEffectiveVolumes(get());
  },
});
