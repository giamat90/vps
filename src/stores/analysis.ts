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
import { buildSpectroCanvas, decodeSTSpectrumFrames } from "../lib/spectroUtils";

export interface SongSpectrogram {
  times: number[];
  canvas: OffscreenCanvas;
  frames: number;
  rows: number;
  hopTime: number;
}

/** Log-Hz spectral envelope over time — one frame of `bins` bytes per time entry. */
export interface STSpectrum {
  times: number[];
  bytes: Uint8Array;
  frames: number;
  bins: number;
  minDb: number;
  maxDb: number;
}

function decodeSTSpectrum(
  times: number[] | undefined,
  b64: string | undefined,
  frames: number | undefined,
  bins: number | undefined,
  minDb: number | undefined,
  maxDb: number | undefined,
): STSpectrum | null {
  if (!times?.length || !b64 || !frames || !bins || minDb === undefined || maxDb === undefined) return null;
  try {
    return { times, bytes: decodeSTSpectrumFrames(b64), frames, bins, minDb, maxDb };
  } catch (e) {
    console.warn("Failed to decode short-term spectrum:", e);
    return null;
  }
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
  songSTSpectrum: STSpectrum | null;
  takePitch: PitchPoint[];
  takeOnsets: number[];
  takeDynamics: DynamicsPoint[];
  takeVibrato: VibratoMetrics | null;
  takeSTSpectrum: STSpectrum | null;
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
  songSTSpectrum: null,
  takePitch: [],
  takeOnsets: [],
  takeDynamics: [],
  takeVibrato: null,
  takeSTSpectrum: null,
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
            const rows = data.spectroRows ?? 40;
            const canvas = buildSpectroCanvas(data.spectroB64, data.spectroFrames, rows);
            const hopTime = data.spectroTimes.length > 1
              ? data.spectroTimes[1] - data.spectroTimes[0]
              : 512 / 22050;
            songSpectrogram = { times: data.spectroTimes, canvas, frames: data.spectroFrames, rows, hopTime };
          } catch (e) {
            console.warn("Failed to build spectrogram canvas:", e);
          }
        }

        const songSTSpectrum = decodeSTSpectrum(
          data.stSpectrumTimes, data.stSpectrumB64, data.stSpectrumFrames, data.stSpectrumBins,
          data.stSpectrumMinDb, data.stSpectrumMaxDb,
        );

        set({
          songPitch: data.pitchData ? pitchDataToPoints(data.pitchData) : [],
          songOnsets: (data.onsets as number[]) ?? [],
          songDynamics: (data.dynamics as DynamicsPoint[]) ?? [],
          songSpectrogram,
          songSTSpectrum,
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
      const takeSTSpectrum = decodeSTSpectrum(
        take.stSpectrumTimes, take.stSpectrumB64, take.stSpectrumFrames, take.stSpectrumBins,
        take.stSpectrumMinDb, take.stSpectrumMaxDb,
      );

      set({ takePitch, takeOnsets, takeDynamics, takeVibrato, takeSTSpectrum, timingDeviations, livePitch: [] });
    },

    appendLivePitch: (point) =>
      set((s) => ({ livePitch: [...s.livePitch, point] })),

    clearLivePitch: () => set({ livePitch: [] }),

    clear: () => set(empty),
  })
);
