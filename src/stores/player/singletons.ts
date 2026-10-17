import { AudioEngine } from "../../audio/engine";
import { VocalRecorder } from "@giamat90/mps-core/recorder";

let engine: AudioEngine | null = null;
let recorder: VocalRecorder | null = null;
let monitorStream: MediaStream | null = null;

// Mic analyser — shared by monitor and recording modes for live spectrogram
let micAnalyserCtx: AudioContext | null = null;
let micAnalyser: AnalyserNode | null = null;

// Per-recording values that outlive a single action call: stopRecording reads what
// startRecording captured, and cancelCountIn reaches the promise startRecording awaits.
export const session = {
  // Captured when recording starts so stopRecording can pass it to saveTake
  recordingStartPos: 0,
  // Round-trip latency (output + input) measured at rec.start(); applied in stopRecording.
  recordingLatencyS: 0,
  // Output device the last recording was routed to; only for [drift-check] diagnostics.
  recordingOutputId: "",
  countInTimeoutId: null as number | null,
  countInIntervalId: null as number | null,
  countInResolve: null as ((completed: boolean) => void) | null,
};

function ensureMicAnalyser(stream: MediaStream): AnalyserNode | null {
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
    // One value for every consumer (Free Exercise spectrogram + spectrum,
    // Practice Room comparison) so live curves look the same on both pages;
    // SpectrogramPanel used to set this at draw time, so it only applied
    // while that panel was mounted (Web Audio default 0.8 otherwise).
    micAnalyser.smoothingTimeConstant = 0.15;
    source.connect(micAnalyser);
    return micAnalyser;
  } catch (e) {
    console.warn("[player] Could not create mic analyser:", e);
    return null;
  }
}

export function destroyMicAnalyser(): void {
  micAnalyser = null;
  micAnalyserCtx?.close().catch((e) => console.warn("[player] AudioContext close:", e));
  micAnalyserCtx = null;
}

export function getMicAnalyser(): AnalyserNode | null {
  const stream = monitorStream ?? recorder?.getProcessedStream() ?? recorder?.getStream() ?? null;
  if (!stream) return null;
  return ensureMicAnalyser(stream);
}

export function getMonitorStream(): MediaStream | null {
  return monitorStream;
}

export function setMonitorStream(stream: MediaStream | null): void {
  monitorStream = stream;
}

export function getRecorderStream(): MediaStream | null {
  return recorder?.getProcessedStream() ?? recorder?.getStream() ?? null;
}

export function getEngine(): AudioEngine {
  if (!engine) {
    engine = new AudioEngine();
  }
  return engine;
}

export function getRecorder(): VocalRecorder {
  if (!recorder) {
    recorder = new VocalRecorder();
  }
  return recorder;
}
