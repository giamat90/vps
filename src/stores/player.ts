import { create } from "zustand";
import { AudioEngine } from "../audio/engine";
import { VocalRecorder } from "../audio/recorder";
import type { Song, Take } from "../lib/types";
import { saveTake, listTakes, deleteTakeApi, renameTakeApi, pitchShiftSong, saveExerciseTake, setMetronomeOffsetApi } from "../lib/tauri";
import type { ExerciseTake } from "../lib/types";
import { useSettingsStore } from "./settings";
import { useAnalysisStore } from "./analysis";

// Singletons outside Zustand
let engine: AudioEngine | null = null;
let recorder: VocalRecorder | null = null;
let monitorStream: MediaStream | null = null;
// Captured when recording starts so stopRecording can pass it to saveTake
let recordingStartPos = 0;
// Round-trip latency (output + input) measured at rec.start(); applied in stopRecording.
let _recordingLatencyS = 0;
// Output device the last recording was routed to; only for [drift-check] diagnostics.
let _recordingOutputId = "";
// Takes shorter than this carry too little accumulated drift to be worth logging.
const DRIFT_CHECK_MIN_TAKE_S = 90;

export interface CalibrationEntry {
  offset: number; // ms
  // Set when a device-change event removed a device this calibration depends on.
  // Stale entries are kept (never deleted) but skipped at recording time.
  stale?: boolean;
  // Median absolute deviation of the clap measurements; absent for manual/legacy entries.
  madMs?: number;
  // Output device active during calibration; absent = unknown (manual/legacy entry),
  // which exempts the entry from the output-mismatch check at recording time.
  outputDeviceId?: string;
}

let _deviceWatcherInit = false;
let _knownDeviceIds: Set<string> | null = null;

// Mic analyser — shared by monitor and recording modes for live spectrogram
let micAnalyserCtx: AudioContext | null = null;
let micAnalyser: AnalyserNode | null = null;

function _ensureMicAnalyser(stream: MediaStream): AnalyserNode | null {
  if (micAnalyser) return micAnalyser;
  try {
    micAnalyserCtx = new AudioContext();
    const source = micAnalyserCtx.createMediaStreamSource(stream);
    micAnalyser = micAnalyserCtx.createAnalyser();
    micAnalyser.fftSize = 8192;
    // Widened from the Web Audio defaults (-100/-30) so getFloatFrequencyData
    // can report the full -100..0 dBFS range the Short-Term Spectrum
    // comparison panel now plots — the live spectrogram/live-only panels
    // still use their own tighter -85..-20 display window, which sits well
    // inside this range, so they're unaffected.
    micAnalyser.minDecibels = -100;
    micAnalyser.maxDecibels = 0;
    source.connect(micAnalyser);
    return micAnalyser;
  } catch (e) {
    console.warn("[player] Could not create mic analyser:", e);
    return null;
  }
}

function _destroyMicAnalyser(): void {
  micAnalyser = null;
  micAnalyserCtx?.close().catch((e) => console.warn("[player] AudioContext close:", e));
  micAnalyserCtx = null;
}

export function getMicAnalyser(): AnalyserNode | null {
  const stream = monitorStream ?? recorder?.getProcessedStream() ?? recorder?.getStream() ?? null;
  if (!stream) return null;
  return _ensureMicAnalyser(stream);
}

export function getMonitorStream(): MediaStream | null {
  return monitorStream;
}

// Free Exercise loaded-track playback used to tap a MediaElementAudioSourceNode
// analyser here, but that only reports data while audio is actively flowing —
// useless for a paused/scrubbed playhead. Superseded by
// AudioEngine.getExerciseTrackSamples(), which snapshots WaveSurfer's own
// decoded buffer directly at any current-time position (see SpectrogramPanel/
// ShortTermSpectrumPanel).

export function getRecorderStream(): MediaStream | null {
  return recorder?.getProcessedStream() ?? recorder?.getStream() ?? null;
}

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

// Soloing a track silences every other track; muting silences only that
// track. Neither ever overwrites the stored slider value — they only change
// what gets pushed to the engine, so unmuting/unsoloing restores the slider
// position exactly.
export function effectiveVolume(
  track: TrackKey,
  rawVolume: number,
  mutedTracks: Record<TrackKey, boolean>,
  soloedTrack: TrackKey | null,
): number {
  if (soloedTrack !== null) return track === soloedTrack ? rawVolume : 0;
  if (mutedTracks[track]) return 0;
  return rawVolume;
}

/**
 * Build the source list for an "export mix" render from the current store
 * state: one entry per track with nonzero effective volume, resolved to
 * the underlying file path (and take alignment fields, if applicable).
 * Returns null if no track is currently audible.
 */
export function buildMixSources(state: PlayerState): {
  sources: import("../lib/tauri").MixSource[];
  startSec: number;
  endSec: number;
} | null {
  const { song, mutedTracks, soloedTrack, vocalsVolume, instrumentalVolume, takeVolume } = state;
  if (!song) return null;

  const sources: import("../lib/tauri").MixSource[] = [];

  const vocalsGain = effectiveVolume("vocals", vocalsVolume, mutedTracks, soloedTrack);
  if (vocalsGain > 0) {
    sources.push({ path: `${song.directory}/vocals.wav`, gain: vocalsGain, isTake: false });
  }

  const instrumentalGain = effectiveVolume("instrumental", instrumentalVolume, mutedTracks, soloedTrack);
  if (instrumentalGain > 0) {
    sources.push({ path: `${song.directory}/instrumental.wav`, gain: instrumentalGain, isTake: false });
  }

  const takeGain = effectiveVolume("take", takeVolume, mutedTracks, soloedTrack);
  if (takeGain > 0 && state.activeTakeId) {
    const take = state.takes.find((t) => t.id === state.activeTakeId);
    if (take) {
      sources.push({
        path: take.filepath,
        gain: takeGain,
        isTake: true,
        startPosition: take.startPosition,
        audioOffset: take.audioOffset ?? 0,
      });
    }
  }

  if (sources.length === 0) return null;

  return {
    sources,
    startSec: state.punchIn ?? 0,
    endSec: state.punchOut ?? state.duration,
  };
}

function applyEffectiveVolumes(state: {
  vocalsVolume: number;
  instrumentalVolume: number;
  takeVolume: number;
  mutedTracks: Record<TrackKey, boolean>;
  soloedTrack: TrackKey | null;
}): void {
  const eng = getEngine();
  eng.setVocalsVolume(effectiveVolume("vocals", state.vocalsVolume, state.mutedTracks, state.soloedTrack));
  eng.setInstrumentalVolume(effectiveVolume("instrumental", state.instrumentalVolume, state.mutedTracks, state.soloedTrack));
  eng.setTakeVolume(effectiveVolume("take", state.takeVolume, state.mutedTracks, state.soloedTrack));
}

export type TrackKey = "vocals" | "instrumental" | "take";

interface PlayerState {
  song: Song | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  vocalsVolume: number;
  instrumentalVolume: number;
  mutedTracks: Record<TrackKey, boolean>;
  soloedTrack: TrackKey | null;
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
  // Recording / monitoring state
  isRecording: boolean;
  isSavingTake: boolean;
  isMonitoring: boolean;
  takes: Take[];
  activeTakeId: string | null;
  takeVolume: number;
  // Punch-in / punch-out region (null = not set)
  punchIn: number | null;
  punchOut: number | null;
  punchLoop: boolean;
  // Per-device recording latency calibration, persisted to localStorage
  recordingOffsets: Record<string, CalibrationEntry>;
  // True when the last startRecording used the AudioContext estimate because the
  // stored calibration was missing, stale, or measured against a different output.
  usedLatencyFallback: boolean;
  // Free exercise mode (no song loaded)
  exerciseMode: boolean;
  // Timeline zoom/pan (ctrl+wheel / shift+wheel)
  minPxPerSec: number;
  scrollTime: number;
  // Metronome downbeat anchor — song time (s) where beat 1 lands, so the
  // click track can be aligned past any silence/pickup before the song's
  // actual downbeat. Persisted per song.
  metronomeOffset: number;
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
  skipToStart: () => void;
  skipToEnd: () => void;
  setPlaybackRate: (rate: number) => void;
  setVocalsVolume: (v: number) => void;
  setInstrumentalVolume: (v: number) => void;
  toggleMute: (track: TrackKey) => void;
  toggleSolo: (track: TrackKey) => void;
  syncTrackVolumes: () => void;
  setLoopPoints: (start: number, end: number) => void;
  toggleLoop: () => void;
  clearLoop: () => void;
  cleanup: () => void;
  // Audio device actions
  fetchAudioDevices: () => Promise<void>;
  setAudioDevice: (deviceId: string | null) => void;
  fetchOutputDevices: () => Promise<void>;
  setOutputDevice: (deviceId: string | null) => Promise<void>;
  setRecordingOffset: (deviceId: string, offsetMs: number) => void;
  applyCalibration: (deviceId: string, entry: CalibrationEntry) => void;
  // Transpose action
  setTranspose: (semitones: number) => Promise<void>;
  // Recording actions
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  // Monitoring actions (live pitch without recording)
  startMonitoring: () => Promise<void>;
  stopMonitoring: () => Promise<void>;
  fetchTakes: () => Promise<void>;
  deleteTake: (takeId: string) => Promise<void>;
  renameTake: (takeId: string, name: string) => Promise<void>;
  setActiveTake: (takeId: string) => void;
  setTakeVolume: (v: number) => void;
  // Punch region actions
  setPunchIn: (t: number) => void;
  setPunchOut: (t: number) => void;
  clearPunch: () => void;
  setPunchLoop: (v: boolean) => void;
  // Exercise mode actions
  startExercise: () => void;
  stopExercise: () => void;
  startExerciseRecording: () => Promise<void>;
  stopExerciseRecording: () => Promise<ExerciseTake>;
  playExerciseTrack: () => void;
  pauseExerciseTrack: () => void;
  // Timeline zoom/pan actions
  setZoom: (minPxPerSec: number, scrollTime: number) => void;
  setScrollTime: (scrollTime: number) => void;
  // Metronome downbeat anchor action
  setMetronomeOffset: (t: number) => void;
}

function _loadOffsets(): Record<string, CalibrationEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem("vps_recording_offsets") ?? "{}") as Record<string, unknown>;
    const offsets: Record<string, CalibrationEntry> = {};
    for (const [deviceId, value] of Object.entries(raw)) {
      // Legacy schema stored a plain number per device.
      if (typeof value === "number") {
        offsets[deviceId] = { offset: value };
      } else if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as CalibrationEntry).offset === "number"
      ) {
        offsets[deviceId] = value as CalibrationEntry;
      } else {
        console.warn("[settings] Dropping malformed recording offset entry:", deviceId, value);
      }
    }
    return offsets;
  } catch (e) {
    console.warn("[settings] Could not load recording offsets:", e);
    return {};
  }
}

function _persistOffsets(offsets: Record<string, CalibrationEntry>): void {
  try {
    localStorage.setItem("vps_recording_offsets", JSON.stringify(offsets));
  } catch (e) {
    console.warn("[settings] Could not persist recording offsets:", e);
  }
}

export const usePlayerStore = create<PlayerState & PlayerActions>((set, get) => ({
  song: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1.0,
  vocalsVolume: 1.0,
  instrumentalVolume: 1.0,
  mutedTracks: { vocals: false, instrumental: false, take: false },
  soloedTrack: null,
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
  isSavingTake: false,
  isMonitoring: false,
  takes: [],
  activeTakeId: null,
  takeVolume: 1.0,
  punchIn: null,
  punchOut: null,
  punchLoop: false,
  exerciseMode: false,
  recordingOffsets: _loadOffsets(),
  usedLatencyFallback: false,
  minPxPerSec: 1,
  scrollTime: 0,
  metronomeOffset: 0,

  loadSong: async (song, vocalsEl, instrumentalEl) => {
    const eng = getEngine();
    await eng.load(song.directory, vocalsEl, instrumentalEl);
    eng.onTimeUpdate((time) => {
      set({ currentTime: time, isPlaying: eng.isPlaying });
      const s = get();
      if (s.punchOut !== null && time >= s.punchOut) {
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
    const baselinePxPerSec = eng.getMinPxPerSec();
    eng.zoomAll(baselinePxPerSec, 0);
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
      // instrument-kind songs write identical audio to vocals.wav and
      // instrumental.wav; mute the instrumental track so only the
      // relabeled "Melody" track is audible (avoids doubled playback).
      mutedTracks: { vocals: false, instrumental: song.kind === "instrument", take: false },
      soloedTrack: null,
      minPxPerSec: baselinePxPerSec,
      scrollTime: 0,
      metronomeOffset: Math.max(0, Math.min(eng.getDuration(), song.metronomeOffset ?? 0)),
    });
    applyEffectiveVolumes(get());
  },

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

  setVocalsVolume: (v) => {
    set({ vocalsVolume: v });
    applyEffectiveVolumes(get());
  },

  setInstrumentalVolume: (v) => {
    set({ instrumentalVolume: v });
    applyEffectiveVolumes(get());
  },

  toggleMute: (track) => {
    set((s) => ({ mutedTracks: { ...s.mutedTracks, [track]: !s.mutedTracks[track] } }));
    applyEffectiveVolumes(get());
  },

  toggleSolo: (track) => {
    set((s) => ({ soloedTrack: s.soloedTrack === track ? null : track }));
    applyEffectiveVolumes(get());
  },

  syncTrackVolumes: () => {
    applyEffectiveVolumes(get());
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
      isSavingTake: false,
      isMonitoring: false,
      takes: [],
      activeTakeId: null,
    });
  },

  fetchAudioDevices: async () => {
    // WebView2 on the installed tauri:// origin returns empty device labels until mic
    // permission has been granted for this session. A brief probe unlocks the full list.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      probe.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.warn("Mic permission probe failed — device list may be incomplete:", e);
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    set({ audioDevices: devices.filter((d) => d.kind === "audioinput") });
    _knownDeviceIds = new Set(devices.map((d) => d.deviceId));

    if (!_deviceWatcherInit) {
      _deviceWatcherInit = true;
      navigator.mediaDevices.addEventListener("devicechange", () => {
        void (async () => {
          const current = await navigator.mediaDevices.enumerateDevices();
          const currentIds = new Set(current.map((d) => d.deviceId));
          const prev = _knownDeviceIds;
          _knownDeviceIds = currentIds;
          // devicechange also fires for irrelevant changes (e.g. default-device
          // switches) — only act when the enumerated set actually differs.
          if (
            prev !== null &&
            prev.size === currentIds.size &&
            [...prev].every((id) => currentIds.has(id))
          ) {
            return;
          }

          set({
            audioDevices: current.filter((d) => d.kind === "audioinput"),
            outputDevices: current.filter((d) => d.kind === "audiooutput"),
          });

          const offsets = { ...get().recordingOffsets };
          let changed = false;
          for (const [inputId, entry] of Object.entries(offsets)) {
            if (entry.stale) continue;
            // "" is the default-microphone key, never present in enumerated ids.
            const inputGone = inputId !== "" && !currentIds.has(inputId);
            const outputGone = entry.outputDeviceId !== undefined && !currentIds.has(entry.outputDeviceId);
            if (inputGone || outputGone) {
              offsets[inputId] = { ...entry, stale: true };
              changed = true;
            }
          }
          if (changed) {
            set({ recordingOffsets: offsets });
            _persistOffsets(offsets);
            console.warn("[calibration] audio device set changed — affected calibrations marked stale");
          }
        })().catch((e: unknown) => console.warn("[calibration] devicechange handling failed:", e));
      });
    }
  },

  setAudioDevice: (deviceId) => {
    set({ selectedDeviceId: deviceId });
  },

  setRecordingOffset: (deviceId, offsetMs) => {
    // A hand-typed value has no measured confidence or device pairing — store it bare,
    // which also clears any stale flag from a previous calibration.
    const offsets = { ...get().recordingOffsets, [deviceId]: { offset: offsetMs } };
    set({ recordingOffsets: offsets });
    _persistOffsets(offsets);
  },

  applyCalibration: (deviceId, entry) => {
    const offsets = { ...get().recordingOffsets, [deviceId]: entry };
    set({ recordingOffsets: offsets });
    _persistOffsets(offsets);
  },

  fetchOutputDevices: async () => {
    // Same WebView2 permission issue as fetchAudioDevices — probe before enumerating.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      probe.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.warn("Mic permission probe failed — output device list may be incomplete:", e);
    }
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

  startMonitoring: async () => {
    const s = get();
    if (s.isRecording || s.isMonitoring) return;

    // Clear any live pitch trace left over from a previous monitor/recording
    // session — DualTuner's own clear runs on its effect cleanup, which is
    // skipped when it unmounts in the same render that stops monitoring.
    useAnalysisStore.getState().clearLivePitch();

    const eng = getEngine();
    try {
      monitorStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(s.selectedDeviceId ? { deviceId: { exact: s.selectedDeviceId } } : {}),
          echoCancellation: { exact: false },
          noiseSuppression: { exact: false },
          autoGainControl: { exact: false },
          channelCount: 1,
          sampleRate: 44100,
        },
        video: false,
      });
      const settings = monitorStream.getAudioTracks()[0].getSettings();
      console.log("[mic] track settings:", settings);
    } catch (e) {
      throw new Error("Microphone unavailable: " + (e instanceof Error ? e.message : String(e)));
    }

    // WASAPI: getUserMedia switches the default output to the Communications
    // Device. Pin to the real hardware output (same logic as startRecording).
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    // Update device list now that permission is granted (labels become visible)
    set({ audioDevices: allDevices.filter((d) => d.kind === "audioinput") });
    const outputs = allDevices.filter((d) => d.kind === "audiooutput");
    const inputLabel = (
      allDevices.find((d) => d.kind === "audioinput" && d.deviceId === s.selectedDeviceId)?.label ?? ""
    ).toUpperCase();
    const realOutputs = outputs.filter(
      (d) =>
        !d.label.startsWith("Default -") &&
        !d.label.startsWith("Communications -") &&
        !d.label.toLowerCase().includes("steam"),
    );
    const matched =
      realOutputs.find((d) =>
        d.label.toUpperCase().split(/\W+/).some((tok) => tok.length >= 4 && inputLabel.includes(tok))
      ) ?? realOutputs[0];
    const outputId = s.selectedOutputDeviceId ?? matched?.deviceId ?? "";
    try {
      await eng.setOutputDevice(outputId);
    } catch (e) {
      console.warn("[monitor] setOutputDevice failed:", e);
    }

    if (get().exerciseMode) eng.startExerciseTimer();
    set({ isMonitoring: true });
  },

  stopMonitoring: async () => {
    _destroyMicAnalyser();
    if (monitorStream) {
      monitorStream.getTracks().forEach((t) => t.stop());
      monitorStream = null;
    }
    const eng = getEngine();
    if (get().exerciseMode) eng.stopExerciseTimer();
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
    recordingStartPos = get().punchIn ?? eng.getCurrentTime();
    eng.pause();

    const rec = getRecorder();
    let inputLatencyS = 0;
    try {
      await rec.init(get().selectedDeviceId);
      // Re-enumerate after getUserMedia succeeds — browser now populates device labels
      const devices = await navigator.mediaDevices.enumerateDevices();
      set({ audioDevices: devices.filter((d) => d.kind === "audioinput") });
      inputLatencyS = (rec.getStream()?.getAudioTracks()[0].getSettings() as MediaTrackSettings & { latency?: number })?.latency ?? 0;
    } catch (e) {
      eng.setInteract(true);
      throw new Error("Microphone unavailable: " + (e instanceof Error ? e.message : String(e)));
    }

    // After getUserMedia, Windows may switch the "default" audio endpoint to the
    // Communications device. Explicitly pin output to a non-Communications device
    // so the singer hears the instrumental through the regular headphone output.
    // After getUserMedia Windows may switch the "Default" audio alias to the
    // Communications endpoint, so sinkId="" routes to the wrong device.
    // Identify the real hardware output by:
    //   1. excluding Default/Communications aliases and virtual (Steam) devices
    //   2. preferring the device that shares an interface token with the selected mic
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const outputs = allDevices.filter((d) => d.kind === "audiooutput");
    const selectedInputLabel = (
      allDevices.find(
        (d) => d.kind === "audioinput" && d.deviceId === get().selectedDeviceId,
      )?.label ?? ""
    ).toUpperCase();

    const realOutputs = outputs.filter(
      (d) =>
        !d.label.startsWith("Default -") &&
        !d.label.startsWith("Communications -") &&
        !d.label.toLowerCase().includes("steam"),
    );
    const matchedOutput =
      realOutputs.find((d) =>
        d.label
          .toUpperCase()
          .split(/\W+/)
          .some((token) => token.length >= 4 && selectedInputLabel.includes(token)),
      ) ?? realOutputs[0];

    const outputId = get().selectedOutputDeviceId ?? matchedOutput?.deviceId ?? "";
    try {
      await eng.setOutputDevice(outputId);
    } catch (e) {
      console.warn("[recording] setOutputDevice failed:", e);
    }

    eng.setInteract(false);
    eng.seekTo(recordingStartPos);
    eng.play();
    rec.start();

    _recordingOutputId = outputId;

    // Calibrated value takes full priority — skip AudioContext measurement when present.
    // A stored entry is only trusted if it isn't stale and was measured against the
    // output device actually in use (entries without outputDeviceId predate that
    // check and are exempt).
    const calib = get().recordingOffsets[get().selectedDeviceId ?? ""];
    const calibUsable =
      calib !== undefined &&
      calib.offset > 0 &&
      !calib.stale &&
      (calib.outputDeviceId === undefined || calib.outputDeviceId === outputId);
    if (calibUsable) {
      set({ usedLatencyFallback: false });
      _recordingLatencyS = calib.offset / 1000;
      console.log("[recording] using calibrated compensation:", calib.offset, "ms");
    } else {
      if (calib !== undefined && calib.offset > 0) {
        console.warn(
          "[recording] stored calibration not used (stale or output-device mismatch) — falling back to AudioContext estimate",
        );
      }
      set({ usedLatencyFallback: true });
      // No calibration: fall back to AudioContext round-trip estimate.
      try {
        const latencyCtx = new AudioContext({ sinkId: outputId } as AudioContextOptions);
        const outputLatencyS = (latencyCtx.outputLatency ?? 0) + (latencyCtx.baseLatency ?? 0);
        latencyCtx.close().catch((e: unknown) => console.warn("[latency] ctx close:", e));
        _recordingLatencyS = outputLatencyS + inputLatencyS;
        console.log("[recording] latency — output:", outputLatencyS, "input:", inputLatencyS, "total:", _recordingLatencyS);
      } catch (e) {
        console.warn("[recording] latency measurement failed, compensation disabled:", e);
        _recordingLatencyS = 0;
      }
    }

    set({ isRecording: true, isPlaying: true });
  },

  stopRecording: async () => {
    const { song } = get();
    if (!song) return;

    const rec = getRecorder();
    const eng = getEngine();
    const takeDurationS = eng.getCurrentTime() - recordingStartPos;
    eng.stop();
    eng.setInteract(true);

    // Immediately flip recording off so the button stops pulsing,
    // then show a saving indicator while the blob is flushed and analyzed.
    set({ isRecording: false, isPlaying: false, isSavingTake: true });

    try {
      const blob = await rec.stop();

      // Release mic tracks so Windows exits communication mode and restores
      // the default audio endpoint back to the regular speakers output.
      _destroyMicAnalyser();
      rec.releaseStream();
      // Restore output routing to the user's selection (or system default).
      await eng.setOutputDevice(get().selectedOutputDeviceId ?? "").catch((e: unknown) => console.warn("[recording] setOutputDevice on stop failed:", e));

      // Convert blob to byte array for Tauri
      const arrayBuffer = await blob.arrayBuffer();
      const audioData = Array.from(new Uint8Array(arrayBuffer));

      // Shift startPosition back by round-trip latency.
      // When that pushes startPos below 0 (recording from song start), keep startPos at 0
      // and store the remainder as audioOffset so the engine skips that many seconds into
      // the audio file, aligning take[audioOffset] with song position 0.
      const rawCompensated = recordingStartPos - _recordingLatencyS;
      const compensatedStartPos = Math.max(0, rawCompensated);
      const audioOffset = rawCompensated < 0 ? -rawCompensated : 0;
      const take = await saveTake(
        song.id,
        audioData,
        compensatedStartPos,
        audioOffset,
        useSettingsStore.getState().pitchAlgorithm,
      );

      // Instrumentation only: correlate future misalignment reports with take length
      // before deciding whether within-take clock drift is worth correcting.
      if (takeDurationS > DRIFT_CHECK_MIN_TAKE_S) {
        console.info(
          `[drift-check] takeDuration=${takeDurationS.toFixed(1)}s input=${get().selectedDeviceId ?? "default"} output=${_recordingOutputId || "default"}`,
        );
      }

      // Auto-select the new take — Waveform loads it into the take track.
      set((state) => ({
        isSavingTake: false,
        currentTime: 0,
        takes: [...state.takes, take],
        activeTakeId: take.id,
      }));
    } catch (e) {
      _destroyMicAnalyser();
      rec.releaseStream();
      await eng.setOutputDevice(get().selectedOutputDeviceId ?? "").catch((e2: unknown) => console.warn("[recording] setOutputDevice on error-stop failed:", e2));
      set({ isSavingTake: false, currentTime: 0 });
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
    }));
  },

  renameTake: async (takeId, name) => {
    const { song } = get();
    if (!song) return;
    const updated = await renameTakeApi(song.id, takeId, name);
    set((state) => ({
      takes: state.takes.map((t) => (t.id === takeId ? updated : t)),
    }));
  },

  setActiveTake: (takeId) => {
    set({ activeTakeId: takeId });
  },

  setTakeVolume: (v) => {
    set({ takeVolume: v });
    applyEffectiveVolumes(get());
  },

  setPunchIn:   (t) => set({ punchIn: t }),
  setPunchOut:  (t) => set({ punchOut: t }),
  clearPunch:   ()  => set({ punchIn: null, punchOut: null, punchLoop: false }),
  setPunchLoop: (v) => set({ punchLoop: v }),

  startExercise: () => {
    const eng = getEngine();
    eng.onTimeUpdate((time) => set({ currentTime: time, isPlaying: eng.isPlaying }));
    eng.onFinish(() => {
      if (get().isRecording) {
        get().stopExerciseRecording().catch((e: unknown) =>
          console.error("[exercise] auto-stop failed:", e)
        );
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
    try {
      await rec.init(s.selectedDeviceId);
      const devices = await navigator.mediaDevices.enumerateDevices();
      set({ audioDevices: devices.filter((d) => d.kind === "audioinput") });
    } catch (e) {
      throw new Error("Microphone unavailable: " + (e instanceof Error ? e.message : String(e)));
    }

    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const outputs = allDevices.filter((d) => d.kind === "audiooutput");
    const inputLabel = (
      allDevices.find((d) => d.kind === "audioinput" && d.deviceId === get().selectedDeviceId)?.label ?? ""
    ).toUpperCase();
    const realOutputs = outputs.filter(
      (d) =>
        !d.label.startsWith("Default -") &&
        !d.label.startsWith("Communications -") &&
        !d.label.toLowerCase().includes("steam"),
    );
    const matched =
      realOutputs.find((d) =>
        d.label.toUpperCase().split(/\W+/).some((tok) => tok.length >= 4 && inputLabel.includes(tok))
      ) ?? realOutputs[0];
    const outputId = get().selectedOutputDeviceId ?? matched?.deviceId ?? "";
    try { await eng.setOutputDevice(outputId); } catch (e) { console.warn("[exercise-rec] setOutputDevice:", e); }

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

    const blob = await rec.stop();
    rec.releaseStream();
    await eng.setOutputDevice(get().selectedOutputDeviceId ?? "").catch((e: unknown) => console.warn("[exercise-rec] setOutputDevice on stop failed:", e));

    const arrayBuffer = await blob.arrayBuffer();
    const audioData = Array.from(new Uint8Array(arrayBuffer));
    const take = await saveExerciseTake(audioData, duration, useSettingsStore.getState().pitchAlgorithm);

    set({ isRecording: false, isPlaying: false, currentTime: 0 });
    return take;
  },

  playExerciseTrack: () => {
    getEngine().playExerciseTrack();
    set({ isPlaying: true });
  },

  pauseExerciseTrack: () => {
    getEngine().pauseExerciseTrack();
    set({ isPlaying: false });
  },

  setZoom: (minPxPerSec, scrollTime) => set({ minPxPerSec, scrollTime }),
  setScrollTime: (scrollTime) => set({ scrollTime }),

  setMetronomeOffset: (t) => {
    const { song, duration } = get();
    if (!song) return;
    const clamped = Math.max(0, Math.min(duration > 0 ? duration : Math.max(0, t), t));
    set({ metronomeOffset: clamped, song: { ...song, metronomeOffset: clamped } });
    setMetronomeOffsetApi(song.id, clamped).catch((e: unknown) =>
      console.error("[player] failed to persist metronome offset:", e)
    );
  },
}));

// While monitoring (not recording), a paused playhead means currentTime is frozen —
// DualTuner's detector would otherwise keep appending points at the same time,
// painting a stale smear on the piano roll. isPlaying can flip to false via many
// call sites (pause, stop, punch-out, onFinish, pauseExerciseTrack, …), so this is
// centralized here rather than duplicated at each one; DualTuner's own effect
// mirrors this for immediate UI reactivity while it's mounted.
usePlayerStore.subscribe((state, prevState) => {
  if (prevState.isPlaying && !state.isPlaying && state.isMonitoring) {
    useAnalysisStore.getState().clearLivePitch();
  }
});
