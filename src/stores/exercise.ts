import { create } from "zustand";
import type { ExerciseTake } from "../lib/types";
import { listExerciseTakes, deleteExerciseTakeApi } from "../lib/tauri";

interface ExerciseState {
  exerciseTakes: ExerciseTake[];
  activeExerciseTakeId: string | null;
}

interface ExerciseActions {
  fetchExerciseTakes: () => Promise<void>;
  addExerciseTake: (take: ExerciseTake) => void;
  deleteExerciseTake: (id: string) => Promise<void>;
  setActiveExerciseTake: (id: string | null) => void;
}

export const useExerciseStore = create<ExerciseState & ExerciseActions>((set, get) => ({
  exerciseTakes: [],
  activeExerciseTakeId: null,

  fetchExerciseTakes: async () => {
    const takes = await listExerciseTakes();
    set({ exerciseTakes: takes });
  },

  addExerciseTake: (take) => {
    set((s) => ({ exerciseTakes: [...s.exerciseTakes, take] }));
  },

  deleteExerciseTake: async (id) => {
    await deleteExerciseTakeApi(id);
    const { activeExerciseTakeId } = get();
    set((s) => ({
      exerciseTakes: s.exerciseTakes.filter((t) => t.id !== id),
      activeExerciseTakeId: activeExerciseTakeId === id ? null : activeExerciseTakeId,
    }));
  },

  setActiveExerciseTake: (id) => set({ activeExerciseTakeId: id }),
}));
