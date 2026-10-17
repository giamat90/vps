import { getEngine } from "./singletons";
import type { Slice, TransportSlice } from "./types";

export const createTransportSlice: Slice<TransportSlice> = (set, get) => ({
  isPlaying: false,
  currentTime: 0,
  playbackRate: 1.0,
  loopStart: null,
  loopEnd: null,
  isLooping: false,

  play: () => {
    const eng = getEngine();
    const { punchIn } = get();
    if (punchIn !== null) {
      eng.seekTo(punchIn);
      set({ currentTime: punchIn });
    }
    eng.play();
    set({ isPlaying: true });
  },

  pause: () => {
    getEngine().pause();
    set({ isPlaying: false });
  },

  togglePlay: () => {
    if (get().isPlaying) {
      get().pause();
    } else {
      get().play();
    }
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

  skipToStart: () => get().seek(0),

  skipToEnd: () => {
    // Landing exactly on `duration` would push the instrumental WaveSurfer's
    // underlying <audio> element into "ended", firing the engine's "finish"
    // handler (which reports playback as complete) even though this is a
    // seek, not actual end-of-song playback.
    const { duration } = get();
    get().seek(Math.max(0, duration - 0.05));
  },

  setPlaybackRate: (rate) => {
    getEngine().setPlaybackRate(rate);
    set({ playbackRate: rate });
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
});
