import { showTake } from "@giamat90/mps-core/takes";
import { saveTake } from "../../lib/tauri";
import { useAnalysisStore } from "../analysis";
import {
  abandonAfterCountIn,
  cancelRunningCountIn,
  openRecorderMic,
  pinHardwareOutput,
  releaseRecorderMic,
  resolveRecordingLatency,
  runCountIn,
} from "./recordingFlow";
import { destroyMicAnalyser, getEngine, getMonitorStream, getRecorder, session, setMonitorStream } from "./singletons";
import { selectionOf } from "./takes";
import type { RecordingSlice, Slice } from "./types";
import { pickHardwareOutput } from "../../audio/outputDevice";
import { metronome } from "@giamat90/mps-core/metronome";
import { pushTakeAudio } from "./volume";

// Takes shorter than this carry too little accumulated drift to be worth logging.
const DRIFT_CHECK_MIN_TAKE_S = 90;

async function openMonitorStream(selectedDeviceId: string | null): Promise<MediaStream> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
        echoCancellation: { exact: false },
        noiseSuppression: { exact: false },
        autoGainControl: { exact: false },
        channelCount: 1,
        sampleRate: 44100,
      },
      video: false,
    });
    console.log("[mic] track settings:", stream.getAudioTracks()[0].getSettings());
    return stream;
  } catch (e) {
    throw new Error("Microphone unavailable: " + (e instanceof Error ? e.message : String(e)));
  }
}

export const createRecordingSlice: Slice<RecordingSlice> = (set, get) => ({
  isRecording: false,
  isSavingTake: false,
  isMonitoring: false,
  countInBars: 0,
  isCountingIn: false,
  countInBeatsRemaining: 0,

  startMonitoring: async () => {
    const s = get();
    if (s.isRecording || s.isMonitoring) return;

    // Clear any live pitch trace left over from a previous monitor/recording
    // session — DualTuner's own clear runs on its effect cleanup, which is
    // skipped when it unmounts in the same render that stops monitoring.
    useAnalysisStore.getState().clearLivePitch();

    const eng = getEngine();
    setMonitorStream(await openMonitorStream(s.selectedDeviceId));

    // WASAPI: getUserMedia switches the default output to the Communications
    // Device. Pin to the real hardware output (same logic as startRecording).
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    // Update device list now that permission is granted (labels become visible)
    set({ audioDevices: allDevices.filter((d) => d.kind === "audioinput") });
    const outputId = s.selectedOutputDeviceId ?? pickHardwareOutput(allDevices, s.selectedDeviceId) ?? "";
    try {
      await eng.setOutputDevice(outputId);
    } catch (e) {
      console.warn("[monitor] setOutputDevice failed:", e);
    }

    // A loaded track is its own clock (play/pause drive isPlaying); the
    // free-running timer would report "playing" while the track is paused.
    if (get().exerciseMode && !eng.exerciseTrack) eng.startExerciseTimer();
    set({ isMonitoring: true });
  },

  stopMonitoring: async () => {
    destroyMicAnalyser();
    const stream = getMonitorStream();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      setMonitorStream(null);
    }
    const eng = getEngine();
    if (get().exerciseMode && !eng.exerciseTrack) eng.stopExerciseTimer();
    try {
      await eng.setOutputDevice(get().selectedOutputDeviceId ?? "");
    } catch (e) {
      console.warn("[monitor] setOutputDevice on stop failed:", e);
    }
    set({ isMonitoring: false });
    useAnalysisStore.getState().clearLivePitch();
  },

  startRecording: async () => {
    const { song } = get();
    if (!song) return;

    // With "mute takes while recording" on (the default), drop the selected take
    // before recording a new one: every take stays saved (takes.json is never
    // touched) and shown, but none is heard and the analysis overlay drops it, so
    // the singer records against the backing track alone — not their last
    // attempt. With it off the takes keep playing and the selection is left alone.
    if (get().muteTakesWhileRecording && get().activeTakeId) {
      set({ activeTakeId: null });
    }

    // Stop monitoring before opening the recorder's mic stream
    if (get().isMonitoring) await get().stopMonitoring();

    // Clear any leftover live pitch trace (e.g. a monitor session that never
    // mounted DualTuner) before this recording starts accumulating its own.
    useAnalysisStore.getState().clearLivePitch();

    // Pause and capture position before getUserMedia — the audio session
    // reconfigures when the mic opens, which can stall already-playing elements.
    // Pausing first guarantees a clean seekTo+play restart after the mic is ready.
    const eng = getEngine();
    // Honour punch-in: start recording from the punch point, not the playhead
    session.recordingStartPos = get().punchIn ?? eng.getCurrentTime();
    eng.pause();
    // eng.pause() only touches the engine, not the store — flip isPlaying
    // synchronously so TempoControl's metronome effect releases the shared
    // `metronome` singleton before the count-in below claims it.
    set({ isPlaying: false });

    const rec = getRecorder();
    const inputLatencyS = await openRecorderMic(set, get, rec, () => eng.setInteract(true));
    const outputId = await pinHardwareOutput(get, eng, "[recording] setOutputDevice failed:");
    // Pin the count-in click to the same repinned output — otherwise it plays
    // through whatever Windows silently rerouted the default device to after
    // getUserMedia, sounding like the count-in never fired.
    if (outputId) metronome.setOutputDevice(outputId);

    // Count-in: the click stops the instant recording starts; a second Record
    // click during the countdown aborts it via cancelCountIn(). Counting first
    // means the take lands beat-aligned by construction.
    const countInBars = get().countInBars;
    if (countInBars > 0) {
      const bpm = (song.detectedBpm ?? 120) * get().playbackRate;
      if (!(await runCountIn(set, bpm, countInBars))) {
        await abandonAfterCountIn(get, eng, rec);
        return;
      }
    }

    eng.setInteract(false);
    // isRecording only flips below; silence the takes first so none is heard in between.
    if (get().muteTakesWhileRecording) eng.setAudibleTakeTracks([]);
    try {
      eng.seekTo(session.recordingStartPos);
      eng.play();
      rec.start();
    } catch (e) {
      // The takes were silenced above for a recording that did not start.
      pushTakeAudio(get());
      throw e;
    }

    session.recordingOutputId = outputId;
    resolveRecordingLatency(set, get, outputId, inputLatencyS);
    set({ isRecording: true, isPlaying: true });
  },

  stopRecording: async () => {
    const { song } = get();
    if (!song) return;

    const rec = getRecorder();
    const eng = getEngine();
    const takeDurationS = eng.getCurrentTime() - session.recordingStartPos;
    eng.stop();
    eng.setInteract(true);

    // Immediately flip recording off so the button stops pulsing,
    // then show a saving indicator while the blob is flushed and analyzed.
    set({ isRecording: false, isPlaying: false, isSavingTake: true });

    try {
      const blob = await rec.stop();
      await releaseRecorderMic(get, eng, rec, "[recording] setOutputDevice on stop failed:", true);

      // Convert blob to byte array for Tauri
      const arrayBuffer = await blob.arrayBuffer();
      const audioData = Array.from(new Uint8Array(arrayBuffer));

      // Shift startPosition back by round-trip latency.
      // When that pushes startPos below 0 (recording from song start), keep startPos at 0
      // and store the remainder as audioOffset so the engine skips that many seconds into
      // the audio file, aligning take[audioOffset] with song position 0.
      const rawCompensated = session.recordingStartPos - session.recordingLatencyS;
      const compensatedStartPos = Math.max(0, rawCompensated);
      const audioOffset = rawCompensated < 0 ? -rawCompensated : 0;
      const take = await saveTake(song.id, audioData, compensatedStartPos, audioOffset);

      // Instrumentation only: correlate future misalignment reports with take length
      // before deciding whether within-take clock drift is worth correcting.
      if (takeDurationS > DRIFT_CHECK_MIN_TAKE_S) {
        console.info(
          `[drift-check] takeDuration=${takeDurationS.toFixed(1)}s input=${get().selectedDeviceId ?? "default"} output=${session.recordingOutputId || "default"}`,
        );
      }

      // Show and select the new take — Waveform loads it into a lane of its
      // own; the takes already shown stay where they are.
      const next = showTake(selectionOf(get()), take.id);
      set({
        isSavingTake: false,
        currentTime: 0,
        takes: [...get().takes, take],
        shownTakeIds: [...next.shown],
        activeTakeId: next.active,
      });
    } catch (e) {
      await releaseRecorderMic(get, eng, rec, "[recording] setOutputDevice on error-stop failed:", false);
      set({ isSavingTake: false, currentTime: 0 });
      throw e;
    }
  },

  setCountInBars: (bars) => {
    if (get().isCountingIn || get().isRecording) return;
    set({ countInBars: bars });
  },

  cancelCountIn: () => cancelRunningCountIn(set),
});
