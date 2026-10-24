import { countInPlan } from "./countIn";
import { getEngine } from "./singletons";
import type { Slice, StoreGet, TransportSlice } from "./types";

async function playAfterCountIn(get: StoreGet): Promise<void> {
  if (await get().runCountIn(countInPlan(get), "play")) get().play();
}

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

  // The transport's Play button: with a count-in set it counts in first. play() itself starts at once
  // (Monitor counts in on its own, and the recording flow starts the engine directly).
  togglePlay: () => {
    const s = get();
    if (s.isCountingIn) {
      // Only the count-in before Play is the transport's to cancel; a recording's or a monitor's belongs to its own button.
      if (s.countInFor === "play") s.cancelCountIn();
    } else if (s.isPlaying) {
      s.pause();
    } else if (s.countInBars > 0 && s.song && !s.isRecording) {
      void playAfterCountIn(get);
    } else {
      s.play();
    }
  },

  stop: () => {
    get().cancelCountIn();
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
