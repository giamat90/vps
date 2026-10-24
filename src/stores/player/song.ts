import { pitchShiftSong } from "../../lib/tauri";
import type { AudioEngine } from "../../audio/engine";
import type { Song } from "../../lib/types";
import { useAnalysisStore } from "../analysis";
import { getEngine, getRecorder } from "./singletons";
import type { Slice, SongSlice, StoreGet, StoreSet } from "./types";
import { applyEffectiveVolumes } from "./volume";

function onPunchOut(eng: AudioEngine, set: StoreSet, get: StoreGet): void {
  const s = get();
  if (s.isRecording) {
    // Auto-stop recording at punch-out
    s.stopRecording().catch((e: unknown) =>
      console.error("[player] punch-out auto-stop failed:", e)
    );
  } else if (s.isPlaying) {
    if (s.punchLoop && s.punchIn !== null) {
      // Loop: jump back to punch-in and keep playing. Clear the monitor
      // trace so each pass through the loop starts a fresh ribbon instead
      // of overlaying every previous pass on the piano roll.
      eng.seekTo(s.punchIn);
      set({ currentTime: s.punchIn });
      useAnalysisStore.getState().clearLivePitch();
    } else {
      // Stop and rewind to punch-in
      eng.pause();
      const backTo = s.punchIn ?? 0;
      eng.seekTo(backTo);
      set({ isPlaying: false, currentTime: backTo });
    }
  }
}

function bindEngine(eng: AudioEngine, set: StoreSet, get: StoreGet): void {
  eng.onTimeUpdate((time) => {
    set({ currentTime: time, isPlaying: eng.isPlaying });
    const { punchOut } = get();
    if (punchOut !== null && time >= punchOut) onPunchOut(eng, set, get);
  });
  eng.onFinish(() => {
    set({ isPlaying: false });
    if (get().isRecording) {
      get().stopRecording().catch((e: unknown) =>
        console.error("[player] auto-stop recording failed:", e)
      );
    }
  });
  eng.onScrollChange((minPxPerSec, scrollTime) => set({ minPxPerSec, scrollTime }));
}

function songResetState(song: Song, eng: AudioEngine, baselinePxPerSec: number) {
  return {
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
    shownTakeIds: [],
    activeTakeId: null,
    mutedTakeIds: [],
    soloedTakeId: null,
    takeGains: {},
    // instrument-kind songs write identical audio to vocals.wav and
    // instrumental.wav; mute the instrumental track so only the
    // relabeled "Melody" track is audible (avoids doubled playback).
    mutedTracks: { vocals: false, instrumental: song.kind === "instrument", take: false },
    soloedTrack: null,
    punchIn: null,
    punchOut: null,
    punchLoop: false,
    minPxPerSec: baselinePxPerSec,
    scrollTime: 0,
    metronomeOffset: Math.max(0, Math.min(eng.getDuration(), song.metronomeOffset ?? 0)),
  };
}

export const createSongSlice: Slice<SongSlice> = (set, get) => ({
  song: null,
  duration: 0,
  transpose: 0,
  isTransposing: false,

  loadSong: async (song, vocalsEl, instrumentalEl) => {
    get().cancelCountIn();
    const eng = getEngine();
    if (!(await eng.load(song.directory, vocalsEl, instrumentalEl))) return;
    bindEngine(eng, set, get);
    const baselinePxPerSec = eng.getMinPxPerSec();
    eng.zoomAll(baselinePxPerSec, 0);
    set(songResetState(song, eng, baselinePxPerSec));
    applyEffectiveVolumes(get());
    // Here rather than in the Takes panel: the take track needs the list
    // whether or not that panel is on screen.
    get().fetchTakes().catch((e: unknown) => console.error("[player] could not load takes:", e));
  },

  cleanup: () => {
    get().cancelCountIn();
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
      isSavingTake: false,
      isMonitoring: false,
      takes: [],
      shownTakeIds: [],
      activeTakeId: null,
      mutedTakeIds: [],
      soloedTakeId: null,
      takeGains: {},
    });
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
});
