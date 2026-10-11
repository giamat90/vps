import { create } from "zustand";
import { DEFAULT_MAIN_VOICE, isMainVoice, type MainVoice } from "../lib/voices";

const STORAGE_KEY = "vps_voice_view";

interface VoiceViewState {
  /** Draw the second singer's line next to the main one (off by default). */
  showMultipleLines: boolean;
  /** Which of two simultaneous voices is the main line. */
  mainVoice: MainVoice;
  setShowMultipleLines: (show: boolean) => void;
  setMainVoice: (voice: MainVoice) => void;
}

type Persisted = Pick<VoiceViewState, "showMultipleLines" | "mainVoice">;

function load(): Persisted {
  const defaults: Persisted = { showMultipleLines: false, mainVoice: DEFAULT_MAIN_VOICE };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return defaults;
    const stored = JSON.parse(raw) as Record<string, unknown> | null;
    return {
      showMultipleLines: typeof stored?.showMultipleLines === "boolean" ? stored.showMultipleLines : false,
      mainVoice: isMainVoice(stored?.mainVoice) ? stored.mainVoice : DEFAULT_MAIN_VOICE,
    };
  } catch (e) {
    console.warn("[voiceView] Could not load voice view settings:", e);
    return defaults;
  }
}

function persist(state: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("[voiceView] Could not persist voice view settings:", e);
  }
}

export const useVoiceViewStore = create<VoiceViewState>((set, get) => ({
  ...load(),

  setShowMultipleLines: (show) => {
    set({ showMultipleLines: show });
    persist({ showMultipleLines: get().showMultipleLines, mainVoice: get().mainVoice });
  },

  setMainVoice: (voice) => {
    if (!isMainVoice(voice)) {
      console.warn("[voiceView] Ignoring unknown main voice:", voice);
      return;
    }
    set({ mainVoice: voice });
    persist({ showMultipleLines: get().showMultipleLines, mainVoice: get().mainVoice });
  },
}));

// A panel can live in its own window with its own copy of this store; the choice is made in either
// and has to show up in both. `storage` fires in every window of the app except the one that wrote.
export function followOtherWindows(event: { key: string | null }): void {
  if (event.key !== STORAGE_KEY) return;
  useVoiceViewStore.setState(load());
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", followOtherWindows);
}
