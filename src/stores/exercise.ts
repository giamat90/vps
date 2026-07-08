import { create } from "zustand";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ExerciseTake } from "../lib/types";
import { listExerciseTakes, deleteExerciseTakeApi, importExerciseFile as importExerciseFileApi } from "../lib/tauri";
import { getEngine, usePlayerStore } from "./player";
import { useAnalysisStore } from "./analysis";
import { useSettingsStore } from "./settings";
import { computeTrackSpectrogram, type TrackSpectrogram } from "../lib/exerciseSpectrogram";

interface ExerciseState {
  exerciseTakes: ExerciseTake[];
  activeExerciseTakeId: string | null;
  loadedTrackKind: "take" | "imported" | null;
  loadedTrackId: string | null;
  isImporting: boolean;
  // Precomputed once per loaded track so SpectrogramPanel can render a
  // centered, drag-to-seek window over it like PianoRoll's pitch ribbon,
  // instead of the live-only scrolling waterfall.
  exerciseTrackSpectrogram: TrackSpectrogram | null;
  isComputingSpectrogram: boolean;
}

interface ExerciseActions {
  fetchExerciseTakes: () => Promise<void>;
  addExerciseTake: (take: ExerciseTake) => void;
  deleteExerciseTake: (id: string) => Promise<void>;
  setActiveExerciseTake: (id: string | null) => void;
  loadExerciseTakeIntoTrack: (take: ExerciseTake, container: HTMLElement) => Promise<void>;
  clearLoadedTrack: () => void;
  importExerciseFile: (filePath: string, container: HTMLElement) => Promise<void>;
}

async function _decodeDuration(filePath: string): Promise<number> {
  const decCtx = new AudioContext();
  try {
    const resp = await fetch(convertFileSrc(filePath.replace(/\\/g, "/")));
    const arrayBuf = await resp.arrayBuffer();
    const audioBuf = await decCtx.decodeAudioData(arrayBuf);
    return audioBuf.duration;
  } finally {
    decCtx.close().catch((e: unknown) => console.warn("[exercise] duration decode ctx close:", e));
  }
}

export const useExerciseStore = create<ExerciseState & ExerciseActions>((set, get) => ({
  exerciseTakes: [],
  activeExerciseTakeId: null,
  loadedTrackKind: null,
  loadedTrackId: null,
  isImporting: false,
  exerciseTrackSpectrogram: null,
  isComputingSpectrogram: false,

  fetchExerciseTakes: async () => {
    const takes = await listExerciseTakes();
    set({ exerciseTakes: takes });
  },

  addExerciseTake: (take) => {
    set((s) => ({ exerciseTakes: [...s.exerciseTakes, take] }));
  },

  deleteExerciseTake: async (id) => {
    await deleteExerciseTakeApi(id);
    const { activeExerciseTakeId, loadedTrackId } = get();
    if (loadedTrackId === id) get().clearLoadedTrack();
    set((s) => ({
      exerciseTakes: s.exerciseTakes.filter((t) => t.id !== id),
      activeExerciseTakeId: activeExerciseTakeId === id ? null : activeExerciseTakeId,
    }));
  },

  setActiveExerciseTake: (id) => set({ activeExerciseTakeId: id }),

  loadExerciseTakeIntoTrack: async (take, container) => {
    await getEngine().loadExerciseTrack(take.filepath, container);
    useAnalysisStore.getState().loadExerciseTakeAnalysis(take);
    // duration must be set here — it defaults to 0 and nothing else in the
    // Free Exercise flow sets it, so PianoRoll's drag-to-seek clamp
    // (Math.min(duration, ...)) clamped every seek target to 0.
    usePlayerStore.setState({ isPlaying: false, currentTime: 0, duration: take.duration });
    set({
      loadedTrackKind: "take",
      loadedTrackId: take.id,
      exerciseTrackSpectrogram: null,
      isComputingSpectrogram: true,
    });

    const buffer = getEngine().exerciseTrack?.getDecodedData() ?? null;
    try {
      const spectrogram = buffer ? await computeTrackSpectrogram(buffer) : null;
      // The track may have been unloaded/replaced while this was computing.
      if (get().loadedTrackId === take.id) set({ exerciseTrackSpectrogram: spectrogram });
    } catch (e) {
      console.error("[exercise] track spectrogram computation failed:", e);
    } finally {
      if (get().loadedTrackId === take.id) set({ isComputingSpectrogram: false });
    }
  },

  clearLoadedTrack: () => {
    getEngine().clearExerciseTrack();
    useAnalysisStore.getState().clear();
    usePlayerStore.setState({ isPlaying: false, currentTime: 0, duration: 0 });
    set({
      loadedTrackKind: null,
      loadedTrackId: null,
      exerciseTrackSpectrogram: null,
      isComputingSpectrogram: false,
    });
  },

  importExerciseFile: async (filePath, container) => {
    set({ isImporting: true });
    try {
      const duration = await _decodeDuration(filePath);
      const algorithm = useSettingsStore.getState().pitchAlgorithm;
      const take = await importExerciseFileApi(filePath, duration, algorithm);
      get().addExerciseTake(take);
      await get().loadExerciseTakeIntoTrack(take, container);
      set({ loadedTrackKind: "imported", loadedTrackId: take.id });
    } finally {
      set({ isImporting: false });
    }
  },
}));
