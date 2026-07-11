import { create } from "zustand";
import type { PitchAlgorithm } from "../lib/types";

interface SettingsState {
  pitchAlgorithm: PitchAlgorithm;
  setPitchAlgorithm: (algorithm: PitchAlgorithm) => void;
}

const VALID_ALGORITHMS: PitchAlgorithm[] = ["srh", "pyin", "hps", "crepe", "praat"];
const DEFAULT_ALGORITHM: PitchAlgorithm = "srh";

function _loadSettings(): { pitchAlgorithm: PitchAlgorithm } {
  try {
    const raw = JSON.parse(localStorage.getItem("vps_settings") ?? "{}") as Record<string, unknown>;
    const algorithm = raw.pitchAlgorithm;
    if (typeof algorithm === "string" && (VALID_ALGORITHMS as string[]).includes(algorithm)) {
      return { pitchAlgorithm: algorithm as PitchAlgorithm };
    }
    return { pitchAlgorithm: DEFAULT_ALGORITHM };
  } catch (e) {
    console.warn("[settings] Could not load settings:", e);
    return { pitchAlgorithm: DEFAULT_ALGORITHM };
  }
}

function _persistSettings(settings: { pitchAlgorithm: PitchAlgorithm }): void {
  try {
    localStorage.setItem("vps_settings", JSON.stringify(settings));
  } catch (e) {
    console.warn("[settings] Could not persist settings:", e);
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ..._loadSettings(),

  setPitchAlgorithm: (algorithm) => {
    set({ pitchAlgorithm: algorithm });
    _persistSettings({ pitchAlgorithm: get().pitchAlgorithm });
  },
}));
