import { create } from "zustand";
import { AudioEngine } from "../audio/engine";
import { VocalRecorder } from "../audio/recorder";
import type { Song, Take } from "../lib/types";
import { saveTake, listTakes, deleteTakeApi, pitchShiftSong } from "../lib/tauri";

// Singletons outside Zustand
let engine: AudioEngine | null = null;
let recorder: VocalRecorder | null = null;
// Captured when recording starts so stopRecording can pass it to saveTake
let recordingStartPos = 0;

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
  // Audio device state
  audioDevices: MediaDeviceInfo[];
  selectedDeviceId: string | null;
  outputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string | null;
  // Transpose state
  transpose: number;
  isTransposing: boolean;
  // Recording state
  isRecording: boolean;
  takes: Take[];
  activeTakeId: string | null;
  abMode: "original" | "take";
  vocalsLoading: boolean;
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
  // Audio device actions
  fetchAudioDevices: () => Promise<void>;
  setAudioDevice: (deviceId: string | null) => void;
  fetchOutputDevices: () => Promise<void>;
  setOutputDevice: (deviceId: string | null) => Promise<void>;
  // Transpose action
  setTranspose: (semitones: number) => Promise<void>;
  // Recording actions
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  fetchTakes: () => Promise<void>;
  deleteTake: (takeId: string) => Promise<void>;
  setActiveTake: (takeId: string) => void;
  setABMode: (mode: "original" | "take") => Promise<void>;
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
  audioDevices: [],
  selectedDeviceId: null,
  outputDevices: [],
  selectedOutputDeviceId: null,
  transpose: 0,
  isTransposing: false,
  isRecording: false,
  takes: [],
  activeTakeId: null,
  abMode: "original",
  vocalsLoading: false,

  loadSong: async (song, vocalsEl, instrumentalEl) => {
    const eng = getEngine();
    await eng.load(song.directory, vocalsEl, instrumentalEl);
    eng.onTimeUpdate((time) => {
      set({ currentTime: time, isPlaying: eng.isPlaying });
    });
    eng.onFinish(() => {
      set({ isPlaying: false });
      if (get().isRecording) {
        get().stopRecording().catch((e: unknown) =>
          console.error("[player] auto-stop recording failed:", e)
        );
      }
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
      transpose: 0,
      isTransposing: false,
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
    if (get().isRecording) return;
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
      audioDevices: [],
      outputDevices: [],
      transpose: 0,
      isTransposing: false,
      isRecording: false,
      takes: [],
      activeTakeId: null,
      abMode: "original",
    });
  },

  fetchAudioDevices: async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    set({ audioDevices: devices.filter((d) => d.kind === "audioinput") });
  },

  setAudioDevice: (deviceId) => {
    set({ selectedDeviceId: deviceId });
  },

  fetchOutputDevices: async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    set({ outputDevices: devices.filter((d) => d.kind === "audiooutput") });
  },

  setOutputDevice: async (deviceId) => {
    await getEngine().setOutputDevice(deviceId ?? "");
    set({ selectedOutputDeviceId: deviceId });
  },

  setTranspose: async (semitones) => {
    const { song } = get();
    if (!song) return;

    getEngine().pause();
    set({ isTransposing: true, isPlaying: false });

    try {
      let vocalsPath: string;
      let instrumentalPath: string;

      if (semitones === 0) {
        const dir = song.directory.replace(/\\/g, "/");
        vocalsPath = dir + "/vocals.wav";
        instrumentalPath = dir + "/instrumental.wav";
      } else {
        const result = await pitchShiftSong(song.directory, semitones);
        vocalsPath = result.vocalsPath;
        instrumentalPath = result.instrumentalPath;
      }

      const eng = getEngine();
      eng.loadVocalsFromPath(vocalsPath);
      eng.loadInstrumentalFromPath(instrumentalPath);
      set({ transpose: semitones, isTransposing: false });
    } catch (e) {
      set({ isTransposing: false });
      throw e;
    }
  },

  startRecording: async () => {
    const { song } = get();
    if (!song) return;

    const rec = getRecorder();
    try {
      await rec.init(get().selectedDeviceId);
      // Re-enumerate after getUserMedia succeeds — browser now populates device labels
      const devices = await navigator.mediaDevices.enumerateDevices();
      set({ audioDevices: devices.filter((d) => d.kind === "audioinput") });
    } catch (e) {
      throw new Error("Microphone unavailable: " + (e instanceof Error ? e.message : String(e)));
    }

    const eng = getEngine();
    eng.setVocalsVolume(0);
    eng.setInteract(false);
    recordingStartPos = eng.getCurrentTime();
    eng.play();
    rec.start();

    set({ isRecording: true, isPlaying: true });
  },

  stopRecording: async () => {
    const { song } = get();
    if (!song) return;

    const rec = getRecorder();
    const eng = getEngine();
    eng.stop();
    eng.setInteract(true);

    try {
      const blob = await rec.stop();

      // Convert blob to byte array for Tauri
      const arrayBuffer = await blob.arrayBuffer();
      const audioData = Array.from(new Uint8Array(arrayBuffer));

      const take = await saveTake(song.id, audioData, recordingStartPos);

      // Restore vocals volume
      eng.setVocalsVolume(get().vocalsVolume);

      set((state) => ({
        isRecording: false,
        isPlaying: false,
        currentTime: 0,
        takes: [...state.takes, take],
      }));
    } catch (e) {
      // Ensure UI is reset even if save fails
      eng.setVocalsVolume(get().vocalsVolume);
      set({ isRecording: false, isPlaying: false, currentTime: 0 });
      throw e;
    }
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

  setABMode: async (mode) => {
    const { activeTakeId, song } = get();
    const eng = getEngine();
    set({ abMode: mode, vocalsLoading: true });
    try {
      if (mode === "take" && activeTakeId && song) {
        const take = get().takes.find((t) => t.id === activeTakeId);
        if (take) await eng.loadVocalsFromPath(take.filepath, take.startPosition);
      } else if (mode === "original" && song) {
        await eng.loadVocalsFromPath(
          song.directory.replace(/\\/g, "/") + "/vocals.wav",
          0,
        );
      }
    } finally {
      set({ vocalsLoading: false });
    }
  },
}));
