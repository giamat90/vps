import { create } from "zustand";
import type {
  PitchData,
  PitchPoint,
  DynamicsPoint,
  TimingDeviation,
  VibratoMetrics,
  Take,
} from "../lib/types";
import { loadAnalysis } from "../lib/tauri";
import { computeTimingDeviations } from "../audio/analysisUtils";
import { buildSpectroCanvas } from "../lib/spectroUtils";

export interface SongSpectrogram {
  times: number[];
  canvas: OffscreenCanvas;
  frames: number;
  hopTime: number;
}

function pitchDataToPoints(pd: PitchData): PitchPoint[] {
  const out: PitchPoint[] = [];
  for (let i = 0; i < pd.times.length; i++) {
    if (pd.voiced[i] && pd.f0[i] > 0) {
      out.push({ time: pd.times[i], frequency: pd.f0[i], confidence: pd.confidence[i] });
    }
  }
  return out;
}

interface AnalysisState {
  songPitch: PitchPoint[];
  songOnsets: number[];
  songDynamics: DynamicsPoint[];
  songSpectrogram: SongSpectrogram | null;
  takePitch: PitchPoint[];
  takeOnsets: number[];
  takeDynamics: DynamicsPoint[];
  takeVibrato: VibratoMetrics | null;
  timingDeviations: TimingDeviation[];
  livePitch: PitchPoint[];
  isLoaded: boolean;
}

interface AnalysisActions {
  loadSongAnalysis: (songId: string) => Promise<void>;
  loadTakeAnalysis: (take: Take) => void;
  appendLivePitch: (point: PitchPoint) => void;
  clearLivePitch: () => void;
  clear: () => void;
}

const empty: AnalysisState = {
  songPitch: [],
  songOnsets: [],
  songDynamics: [],
  songSpectrogram: null,
  takePitch: [],
  takeOnsets: [],
  takeDynamics: [],
  takeVibrato: null,
  timingDeviations: [],
  livePitch: [],
  isLoaded: false,
};

export const useAnalysisStore = create<AnalysisState & AnalysisActions>(
  (set, get) => ({
    ...empty,

    loadSongAnalysis: async (songId) => {
      try {
        const data = await loadAnalysis(songId);

        let songSpectrogram: SongSpectrogram | null = null;
        if (data.spectroB64 && data.spectroFrames && data.spectroTimes?.length) {
          try {
            const canvas = buildSpectroCanvas(data.spectroB64, data.spectroFrames);
            const hopTime = data.spectroTimes.length > 1
              ? data.spectroTimes[1] - data.spectroTimes[0]
              : 512 / 22050;
            songSpectrogram = { times: data.spectroTimes, canvas, frames: data.spectroFrames, hopTime };
          } catch (e) {
            console.warn("Failed to build spectrogram canvas:", e);
          }
        }

        set({
          songPitch: data.pitchData ? pitchDataToPoints(data.pitchData) : [],
          songOnsets: (data.onsets as number[]) ?? [],
          songDynamics: (data.dynamics as DynamicsPoint[]) ?? [],
          songSpectrogram,
          isLoaded: true,
        });
      } catch (e) {
        console.error("Failed to load analysis:", e);
      }
    },

    loadTakeAnalysis: (take) => {
      const { songOnsets } = get();
      const takePitch = take.pitchData ? pitchDataToPoints(take.pitchData) : [];
      const takeOnsets = take.onsets ?? [];
      const takeDynamics = take.dynamics ?? [];
      const takeVibrato = take.vibrato ?? null;
      const timingDeviations = computeTimingDeviations(songOnsets, takeOnsets);

      set({ takePitch, takeOnsets, takeDynamics, takeVibrato, timingDeviations, livePitch: [] });
    },

    appendLivePitch: (point) =>
      set((s) => ({ livePitch: [...s.livePitch, point] })),

    clearLivePitch: () => set({ livePitch: [] }),

    clear: () => set(empty),
  })
);
