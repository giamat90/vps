import type { StoreApi, UseBoundStore } from "zustand";
import { useAnalysisStore } from "../analysis";
import type { PlayerStore } from "./types";
import { pushTakeAudio } from "./volume";

export function installAudioSync(store: UseBoundStore<StoreApi<PlayerStore>>): void {
  // While monitoring (not recording), a paused playhead means currentTime is frozen —
  // DualTuner's detector would otherwise keep appending points at the same time,
  // painting a stale smear on the piano roll. isPlaying can flip to false via many
  // call sites (pause, stop, punch-out, onFinish, pauseExerciseTrack, …), so this is
  // centralized here rather than duplicated at each one; DualTuner's own effect
  // mirrors this for immediate UI reactivity while it's mounted.
  store.subscribe((state, prevState) => {
    if (prevState.isPlaying && !state.isPlaying && state.isMonitoring) {
      useAnalysisStore.getState().clearLivePitch();
    }
  });

  // What is heard follows from the takes shown, the selection, the playback mode,
  // the lane mutes and whether a recording is under way. Derived here, once, so no
  // action has to remember to tell the engine.
  store.subscribe((state, prev) => {
    if (
      state.shownTakeIds === prev.shownTakeIds &&
      state.activeTakeId === prev.activeTakeId &&
      state.takePlayback === prev.takePlayback &&
      state.mutedTakeIds === prev.mutedTakeIds &&
      state.soloedTakeId === prev.soloedTakeId &&
      state.soloedTrack === prev.soloedTrack &&
      state.mutedTracks === prev.mutedTracks &&
      state.takeGains === prev.takeGains &&
      state.isRecording === prev.isRecording &&
      state.muteTakesWhileRecording === prev.muteTakesWhileRecording
    ) {
      return;
    }
    pushTakeAudio(state);
  });
}
