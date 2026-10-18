import { saveExerciseTake } from "../../lib/tauri";
import { openRecorderMic, pinHardwareOutput, releaseRecorderMic } from "./recordingFlow";
import { getEngine, getRecorder } from "./singletons";
import type { ExerciseSlice, Slice } from "./types";

export const createExerciseSlice: Slice<ExerciseSlice> = (set, get) => ({
  exerciseMode: false,

  startExercise: () => {
    const eng = getEngine();
    eng.onTimeUpdate((time) => set({ currentTime: time, isPlaying: eng.isPlaying }));
    eng.onFinish(() => {
      if (get().isRecording) {
        get().stopExerciseRecording().catch((e: unknown) =>
          console.error("[exercise] auto-stop failed:", e)
        );
      } else {
        set({ isPlaying: false });
      }
    });
    set({ exerciseMode: true, currentTime: 0, isPlaying: false, isRecording: false });
  },

  stopExercise: () => {
    const eng = getEngine();
    if (get().isMonitoring) void get().stopMonitoring();
    eng.stopExerciseTimer();
    set({ exerciseMode: false, isPlaying: false, currentTime: 0, isRecording: false });
  },

  startExerciseRecording: async () => {
    const s = get();
    if (s.isRecording) return;
    if (s.isMonitoring) await get().stopMonitoring();

    const eng = getEngine();
    const rec = getRecorder();
    await openRecorderMic(set, get, rec);
    await pinHardwareOutput(get, eng, "[exercise-rec] setOutputDevice:");

    eng.startExerciseTimer();
    rec.start();
    set({ isRecording: true, isPlaying: true });
  },

  stopExerciseRecording: async () => {
    const eng = getEngine();
    const rec = getRecorder();
    const duration = eng.getCurrentTime();

    eng.stopExerciseTimer();
    eng.setInteract(true);

    // Flip isRecording off immediately (button stops reading "Stop") and gate
    // the remaining async work behind isSavingTake — same pattern as
    // stopRecording. Without this, the button stayed clickable as
    // "Stop" for the entire sidecar round-trip (up to 90s on a cold spawn,
    // see wiki/python-sidecar.md), and a second click mid-save re-entered
    // this action and called rec.stop() on an already-stopped MediaRecorder,
    // throwing "Not recording (state: inactive)" and leaving no take saved.
    set({ isRecording: false, isPlaying: false, isSavingTake: true });

    try {
      const blob = await rec.stop();
      await releaseRecorderMic(get, eng, rec, "[exercise-rec] setOutputDevice on stop failed:", false);

      const arrayBuffer = await blob.arrayBuffer();
      const audioData = Array.from(new Uint8Array(arrayBuffer));
      const take = await saveExerciseTake(audioData, duration);

      set({ isSavingTake: false, currentTime: 0 });
      return take;
    } catch (e) {
      await releaseRecorderMic(get, eng, rec, "[exercise-rec] setOutputDevice on error-stop failed:", false);
      set({ isSavingTake: false, currentTime: 0 });
      throw e;
    }
  },

  playExerciseTrack: () => {
    getEngine().playExerciseTrack();
    set({ isPlaying: true });
  },

  pauseExerciseTrack: () => {
    getEngine().pauseExerciseTrack();
    set({ isPlaying: false });
  },
});
