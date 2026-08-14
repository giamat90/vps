import { create } from "zustand";
import type { PitchAlgorithm } from "../lib/types";

interface SettingsState {
  pitchAlgorithm: PitchAlgorithm;
  setPitchAlgorithm: (algorithm: PitchAlgorithm) => void;
  youtubeCookiesPath: string | null;
  setYoutubeCookiesPath: (path: string | null) => void;
}

const VALID_ALGORITHMS: PitchAlgorithm[] = ["srh", "pyin", "hps", "crepe", "praat"];
const DEFAULT_ALGORITHM: PitchAlgorithm = "srh";

type PersistedSettings = { pitchAlgorithm: PitchAlgorithm; youtubeCookiesPath: string | null };

function _loadSettings(): PersistedSettings {
  try {
    const raw = JSON.parse(localStorage.getItem("vps_settings") ?? "{}") as Record<string, unknown>;
    const algorithm = raw.pitchAlgorithm;
    const cookiesPath = raw.youtubeCookiesPath;
    return {
      pitchAlgorithm:
        typeof algorithm === "string" && (VALID_ALGORITHMS as string[]).includes(algorithm)
          ? (algorithm as PitchAlgorithm)
          : DEFAULT_ALGORITHM,
      youtubeCookiesPath: typeof cookiesPath === "string" ? cookiesPath : null,
    };
  } catch (e) {
    console.warn("[settings] Could not load settings:", e);
    return { pitchAlgorithm: DEFAULT_ALGORITHM, youtubeCookiesPath: null };
  }
}

function _persistSettings(settings: PersistedSettings): void {
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
    _persistSettings({ pitchAlgorithm: get().pitchAlgorithm, youtubeCookiesPath: get().youtubeCookiesPath });
  },

  setYoutubeCookiesPath: (path) => {
    set({ youtubeCookiesPath: path });
    _persistSettings({ pitchAlgorithm: get().pitchAlgorithm, youtubeCookiesPath: get().youtubeCookiesPath });
  },
}));
