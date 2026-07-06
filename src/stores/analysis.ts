import { create } from "zustand";
import type {
  PitchData,
  PitchPoint,
  DynamicsPoint,
  TimingDeviation,
  VibratoMetrics,
  Take,
  ExerciseTake,
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

// pd.times / onsets / spectrum times are all local to the take's audible content
// (0 = first analyzed sample, i.e. right after the sidecar's audioOffset skip — see
// wiki/python-sidecar.md). The rest of the app (PianoRoll, DynamicsCurve, timing
// charts, ShortTermSpectrum panels) compares them against getEngine().getCurrentTime(),
// which is song time. Convert local time -> song time via songTime = localTime + startPosition.
function pitchDataToPoints(pd: PitchData, toSongTime: (t: number) => number): PitchPoint[] {
  const out: PitchPoint[] = [];
  for (let i = 0; i < pd.times.length; i++) {
    if (pd.voiced[i] && pd.f0[i] > 0) {
      out.push({ time: toSongTime(pd.times[i]), frequency: pd.f0[i], confidence: pd.confidence[i] });
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
  loadExerciseTakeAnalysis: (take: ExerciseTake) => void;
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
          songPitch: data.pitchData ? pitchDataToPoints(data.pitchData, (t) => t) : [],
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
      // Python's analyze skips `audioOffset` seconds of the raw file before running
      // librosa (see sidecar analysis.py / wiki/python-sidecar.md), so pd.times is
      // already 0-based from the audible-content start — which is exactly song time
      // `startPosition`. audioOffset must NOT be subtracted again here.
      const toSongTime = (t: number) => t + take.startPosition;

      const takePitch = take.pitchData ? pitchDataToPoints(take.pitchData, toSongTime) : [];
      const takeOnsets = (take.onsets ?? []).map(toSongTime);
      const takeDynamics = (take.dynamics ?? []).map((d) => ({ ...d, time: toSongTime(d.time) }));
      const takeVibrato = take.vibrato ?? null;
      const timingDeviations = computeTimingDeviations(songOnsets, takeOnsets);
      const takeSTSpectrum = decodeSTSpectrum(
        take.stSpectrumTimes?.map(toSongTime), take.stSpectrumB64, take.stSpectrumFrames, take.stSpectrumBins,
        take.stSpectrumMinDb, take.stSpectrumMaxDb,
      );

      set({ takePitch, takeOnsets, takeDynamics, takeVibrato, takeSTSpectrum, timingDeviations, livePitch: [] });
    },

    loadExerciseTakeAnalysis: (take) => {
      // ExerciseTake has no song/startPosition context — times are already
      // exercise-local (0-based), unlike loadTakeAnalysis's toSongTime shift.
      const takePitch = take.pitchData ? pitchDataToPoints(take.pitchData, (t) => t) : [];
      set({
        takePitch,
        takeOnsets: [],
        takeDynamics: take.dynamics ?? [],
        takeVibrato: take.vibrato ?? null,
        takeSTSpectrum: null,
        timingDeviations: [],
        livePitch: [],
      });
    },

    appendLivePitch: (point) =>
      set((s) => ({ livePitch: [...s.livePitch, point] })),

    clearLivePitch: () => set({ livePitch: [] }),

    clear: () => set(empty),
  })
);
