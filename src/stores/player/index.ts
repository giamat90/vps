import { create } from "zustand";
import { installAudioSync } from "./audioSync";
import { createDevicesSlice } from "./devices";
import { createExerciseSlice } from "./exercise";
import { createMixerSlice } from "./mixer";
import { createPunchSlice } from "./punch";
import { createRecordingSlice } from "./recording";
import { createSongSlice } from "./song";
import { createTakesSlice } from "./takes";
import { createTimelineSlice } from "./timeline";
import { createTransportSlice } from "./transport";
import type { PlayerStore } from "./types";

export const usePlayerStore = create<PlayerStore>()((...a) => ({
  ...createSongSlice(...a),
  ...createTransportSlice(...a),
  ...createMixerSlice(...a),
  ...createTimelineSlice(...a),
  ...createPunchSlice(...a),
  ...createDevicesSlice(...a),
  ...createTakesSlice(...a),
  ...createRecordingSlice(...a),
  ...createExerciseSlice(...a),
}));

installAudioSync(usePlayerStore);

export { getEngine, getMicAnalyser, getMonitorStream, getRecorderStream } from "./singletons";
export { buildMixSources, effectiveVolume, takesSilenced } from "./volume";
export type { CalibrationEntry, TrackKey } from "./types";
