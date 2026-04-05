import { create } from "zustand";
import { AudioEngine } from "../audio/engine";
import { VocalRecorder } from "../audio/recorder";
import type { Song, Take } from "../lib/types";
import { saveTake, listTakes, deleteTakeApi } from "../lib/tauri";

// Singletons outside Zustand
let engine: AudioEngine | null = null;
let recorder: VocalRecorder | null = null;

export function getEngine(): AudioEngine {
  if (!engine) {
    engine = new AudioEngine();
  }
  return engine;
}

function getRecorder(): VocalRecorder {
  if (!recorder) {
    recorder = new VocalRecorder();
  }
  return recorder;
}

interface PlayerState {
  song: Song | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  vocalsVolume: number;
  instrumentalVolume: number;
  loopStart: number | null;
  loopEnd: number | null;
  isLooping: boolean;
  // Recording state
  isRecording: boolean;
  takes: Take[];
  activeTakeId: string | null;
  abMode: "original" | "take";
}

interface PlayerActions {
  loadSong: (
    song: Song,
    vocalsEl: HTMLElement,
    instrumentalEl: HTMLElement,
  ) => Promise<void>;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  stop: () => void;
  seek: (time: number) => void;
  setPlaybackRate: (rate: number) => void;
  setVocalsVolume: (v: number) => void;
  setInstrumentalVolume: (v: number) => void;
  setLoopPoints: (start: number, end: number) => void;
  toggleLoop: () => void;
  clearLoop: () => void;
  cleanup: () => void;
  // Recording actions
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  fetchTakes: () => Promise<void>;
  deleteTake: (takeId: string) => Promise<void>;
  setActiveTake: (takeId: string) => void;
  setABMode: (mode: "original" | "take") => void;
}

export const usePlayerStore = create<PlayerState & PlayerActions>((set, get) => ({
  song: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1.0,
  vocalsVolume: 1.0,
  instrumentalVolume: 1.0,
  loopStart: null,
  loopEnd: null,
  isLooping: false,
  isRecording: false,
  takes: [],
  activeTakeId: null,
  abMode: "original",

  loadSong: async (song, vocalsEl, instrumentalEl) => {
    const eng = getEngine();
    await eng.load(song.directory, vocalsEl, instrumentalEl);
    eng.onTimeUpdate((time) => {
      set({ currentTime: time, isPlaying: eng.isPlaying });
    });
    set({
      song,
      duration: eng.getDuration(),
      currentTime: 0,
      isPlaying: false,
      playbackRate: 1.0,
      loopStart: null,
      loopEnd: null,
      isLooping: false,
      isRecording: false,
      activeTakeId: null,
      abMode: "original",
    });
  },

  play: () => {
    getEngine().play();
    set({ isPlaying: true });
  },

  pause: () => {
    getEngine().pause();
    set({ isPlaying: false });
  },

  togglePlay: () => {
    const eng = getEngine();
    eng.togglePlay();
    set({ isPlaying: eng.isPlaying });
  },

  stop: () => {
    getEngine().stop();
    set({ isPlaying: false, currentTime: 0 });
  },

  seek: (time) => {
    getEngine().seekTo(time);
    set({ currentTime: time });
  },

  setPlaybackRate: (rate) => {
    getEngine().setPlaybackRate(rate);
    set({ playbackRate: rate });
  },

  setVocalsVolume: (v) => {
    getEngine().setVocalsVolume(v);
    set({ vocalsVolume: v });
  },

  setInstrumentalVolume: (v) => {
    getEngine().setInstrumentalVolume(v);
    set({ instrumentalVolume: v });
  },

  setLoopPoints: (start, end) => {
    const eng = getEngine();
    eng.setLoop(start, end);
    set({ loopStart: start, loopEnd: end, isLooping: true });
  },

  toggleLoop: () => {
    const { isLooping, loopStart, loopEnd } = get();
    const eng = getEngine();
    if (isLooping) {
      eng.clearLoop();
      set({ isLooping: false });
    } else if (loopStart !== null && loopEnd !== null) {
      eng.setLoop(loopStart, loopEnd);
      set({ isLooping: true });
    }
  },

  clearLoop: () => {
    getEngine().clearLoop();
    set({ loopStart: null, loopEnd: null, isLooping: false });
  },

  cleanup: () => {
    getEngine().destroy();
    getRecorder().dispose();
    set({
      song: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      isRecording: false,
      takes: [],
      activeTakeId: null,
      abMode: "original",
    });
  },

  startRecording: async () => {
    const { song } = get();
    if (!song) return;

    const rec = getRecorder();
    await rec.init();

    // Mute vocals during recording, play instrumental
    const eng = getEngine();
    eng.setVocalsVolume(0);
    eng.seekTo(0);
    eng.play();
    rec.start();

    set({ isRecording: true, isPlaying: true });
  },

  stopRecording: async () => {
    const { song } = get();
    if (!song) return;

    const rec = getRecorder();
    const eng = getEngine();
    eng.pause();

    const blob = await rec.stop();

    // Convert blob to byte array for Tauri
    const arrayBuffer = await blob.arrayBuffer();
    const audioData = Array.from(new Uint8Array(arrayBuffer));

    const take = await saveTake(song.id, audioData);

    // Restore vocals volume
    eng.setVocalsVolume(get().vocalsVolume);

    set((state) => ({
      isRecording: false,
      isPlaying: false,
      takes: [...state.takes, take],
    }));
  },

  fetchTakes: async () => {
    const { song } = get();
    if (!song) return;
    const takes = await listTakes(song.id);
    set({ takes });
  },

  deleteTake: async (takeId) => {
    const { song, activeTakeId } = get();
    if (!song) return;
    await deleteTakeApi(song.id, takeId);
    set((state) => ({
      takes: state.takes.filter((t) => t.id !== takeId),
      activeTakeId: activeTakeId === takeId ? null : activeTakeId,
      abMode: activeTakeId === takeId ? "original" : state.abMode,
    }));
  },

  setActiveTake: (takeId) => {
    set({ activeTakeId: takeId });
  },

  setABMode: (mode) => {
    const { activeTakeId, song } = get();
    const eng = getEngine();

    if (mode === "take" && activeTakeId && song) {
      // Load the take into the vocals waveform
      const take = get().takes.find((t) => t.id === activeTakeId);
      if (take) {
        eng.loadVocalsFromPath(take.filepath);
      }
    } else if (mode === "original" && song) {
      // Reload original vocals
      eng.loadVocalsFromPath(song.directory + "/vocals.wav");
    }

    set({ abMode: mode });
  },
}));
