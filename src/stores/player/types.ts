import type { StateCreator } from "zustand";
import type { CountInSlice } from "@giamat90/mps-core/countIn";
import type { ExerciseTake, Song, Take } from "../../lib/types";
import type { TakePlayback } from "@giamat90/mps-core/takes";

export type TrackKey = "vocals" | "instrumental" | "take";

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

export interface SongSlice {
  song: Song | null;
  duration: number;
  transpose: number;
  isTransposing: boolean;
  loadSong: (song: Song, vocalsEl: HTMLElement, instrumentalEl: HTMLElement) => Promise<void>;
  cleanup: () => void;
  setTranspose: (semitones: number) => Promise<void>;
}

export interface TransportSlice {
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
  loopStart: number | null;
  loopEnd: number | null;
  isLooping: boolean;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  stop: () => void;
  seek: (time: number) => void;
  skipToStart: () => void;
  skipToEnd: () => void;
  setPlaybackRate: (rate: number) => void;
  setLoopPoints: (start: number, end: number) => void;
  toggleLoop: () => void;
  clearLoop: () => void;
}

export interface MixerSlice {
  vocalsVolume: number;
  instrumentalVolume: number;
  takeVolume: number;
  mutedTracks: Record<TrackKey, boolean>;
  soloedTrack: TrackKey | null;
  setVocalsVolume: (v: number) => void;
  setInstrumentalVolume: (v: number) => void;
  setTakeVolume: (v: number) => void;
  toggleMute: (track: TrackKey) => void;
  toggleSolo: (track: TrackKey) => void;
  syncTrackVolumes: () => void;
}

export interface TimelineSlice {
  // Timeline zoom/pan (ctrl+wheel / shift+wheel)
  minPxPerSec: number;
  scrollTime: number;
  // Metronome downbeat anchor — song time (s) where beat 1 lands, so the
  // click track can be aligned past any silence/pickup before the song's
  // actual downbeat. Persisted per song.
  metronomeOffset: number;
  setZoom: (minPxPerSec: number, scrollTime: number) => void;
  setScrollTime: (scrollTime: number) => void;
  setMetronomeOffset: (t: number) => void;
}

export interface PunchSlice {
  // Punch-in / punch-out region (null = not set)
  punchIn: number | null;
  punchOut: number | null;
  punchLoop: boolean;
  setPunchIn: (t: number) => void;
  setPunchOut: (t: number) => void;
  clearPunch: () => void;
  setPunchLoop: (v: boolean) => void;
  saveLoop: (name: string) => Promise<void>;
  renameLoop: (id: string, name: string) => Promise<void>;
  deleteLoop: (id: string) => Promise<void>;
  applyLoopRegion: (start: number, end: number) => void;
}

export interface DevicesSlice {
  audioDevices: MediaDeviceInfo[];
  selectedDeviceId: string | null;
  outputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string | null;
  // Per-device recording latency calibration, persisted to localStorage
  recordingOffsets: Record<string, CalibrationEntry>;
  // True when the last startRecording used the AudioContext estimate because the
  // stored calibration was missing, stale, or measured against a different output.
  usedLatencyFallback: boolean;
  fetchAudioDevices: () => Promise<void>;
  setAudioDevice: (deviceId: string | null) => void;
  fetchOutputDevices: () => Promise<void>;
  setOutputDevice: (deviceId: string | null) => Promise<void>;
  setRecordingOffset: (deviceId: string, offsetMs: number) => void;
  applyCalibration: (deviceId: string, entry: CalibrationEntry) => void;
}

export interface TakesSlice {
  takes: Take[];
  // Takes with a lane on screen (in the order they were shown), and the one that is heard.
  shownTakeIds: string[];
  activeTakeId: string | null;
  // Which of the shown takes are heard: all together, or only the selected one
  takePlayback: TakePlayback;
  // Takes the user silenced on their own lane
  mutedTakeIds: string[];
  // The take soloed on its lane (only meaningful while the take channel is soloed)
  soloedTakeId: string | null;
  // Each take's own volume (1 when absent), on top of the take channel's
  takeGains: Record<string, number>;
  // Keep the takes quiet while a new one is recorded
  muteTakesWhileRecording: boolean;
  fetchTakes: () => Promise<void>;
  deleteTake: (takeId: string) => Promise<void>;
  deleteAllTakes: () => Promise<void>;
  renameTake: (takeId: string, name: string) => Promise<void>;
  setTakeManualOffset: (takeId: string, offset: number) => void;
  setActiveTake: (takeId: string) => void;
  // A click in the takes list: show it, switch to it, or hide it when it is the active one
  toggleTake: (takeId: string) => void;
  hideTake: (takeId: string) => void;
  setTakePlayback: (mode: TakePlayback) => void;
  toggleTakeMute: (takeId: string) => void;
  toggleTakeSolo: (takeId: string) => void;
  setTakeGain: (takeId: string, gain: number) => void;
  setMuteTakesWhileRecording: (mute: boolean) => void;
}

export interface RecordingSlice {
  isRecording: boolean;
  isSavingTake: boolean;
  isMonitoring: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  startMonitoring: () => Promise<void>;
  stopMonitoring: () => Promise<void>;
}

export interface ExerciseSlice {
  // Free exercise mode (no song loaded)
  exerciseMode: boolean;
  startExercise: () => void;
  stopExercise: () => void;
  startExerciseRecording: () => Promise<void>;
  stopExerciseRecording: () => Promise<ExerciseTake>;
  playExerciseTrack: () => void;
  pauseExerciseTrack: () => void;
}

export type PlayerStore = SongSlice &
  TransportSlice &
  MixerSlice &
  TimelineSlice &
  PunchSlice &
  DevicesSlice &
  TakesSlice &
  CountInSlice &
  RecordingSlice &
  ExerciseSlice;

export type Slice<T> = StateCreator<PlayerStore, [], [], T>;

export type StoreSet = (partial: Partial<PlayerStore>) => void;
export type StoreGet = () => PlayerStore;
