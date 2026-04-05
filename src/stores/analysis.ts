import { create } from "zustand";
import type {
  PitchPoint,
  DynamicsPoint,
  TimingDeviation,
  VibratoMetrics,
  Take,
} from "../lib/types";
import { loadAnalysis } from "../lib/tauri";
import { computeTimingDeviations } from "../audio/analysisUtils";

interface AnalysisState {
  songPitch: PitchPoint[];
  songOnsets: number[];
  songDynamics: DynamicsPoint[];
  takePitch: PitchPoint[];
  takeOnsets: number[];
  takeDynamics: DynamicsPoint[];
  takeVibrato: VibratoMetrics | null;
  timingDeviations: TimingDeviation[];
  isLoaded: boolean;
}

interface AnalysisActions {
  loadSongAnalysis: (songId: string) => Promise<void>;
  loadTakeAnalysis: (take: Take) => void;
  clear: () => void;
}

const empty: AnalysisState = {
  songPitch: [],
  songOnsets: [],
  songDynamics: [],
  takePitch: [],
  takeOnsets: [],
  takeDynamics: [],
  takeVibrato: null,
  timingDeviations: [],
  isLoaded: false,
};

export const useAnalysisStore = create<AnalysisState & AnalysisActions>(
  (set, get) => ({
    ...empty,

    loadSongAnalysis: async (songId) => {
      try {
        const data = await loadAnalysis(songId);
        set({
          songPitch: (data.pitchData as PitchPoint[]) ?? [],
          songOnsets: (data.onsets as number[]) ?? [],
          songDynamics: (data.dynamics as DynamicsPoint[]) ?? [],
          isLoaded: true,
        });
      } catch (e) {
        console.error("Failed to load analysis:", e);
      }
    },

    loadTakeAnalysis: (take) => {
      const { songOnsets } = get();
      const takePitch = take.pitchData ?? [];
      const takeOnsets = take.onsets ?? [];
      const takeDynamics = take.dynamics ?? [];
      const takeVibrato = take.vibrato ?? null;
      const timingDeviations = computeTimingDeviations(songOnsets, takeOnsets);

      set({ takePitch, takeOnsets, takeDynamics, takeVibrato, timingDeviations });
    },

    clear: () => set(empty),
  })
);
