import type { VocalRecorder } from "@giamat90/mps-core/recorder";
import { metronome } from "@giamat90/mps-core/metronome";
import { countInDurationSeconds } from "@giamat90/mps-core/metronomeSync";
import type { AudioEngine } from "../../audio/engine";
import { pickHardwareOutput } from "../../audio/outputDevice";
import { destroyMicAnalyser, session } from "./singletons";
import type { StoreGet, StoreSet } from "./types";

function micError(e: unknown): Error {
  return new Error("Microphone unavailable: " + (e instanceof Error ? e.message : String(e)));
}

// Opens the recorder's mic stream and refreshes the device list, whose labels
// only become visible once permission is granted. Returns the input latency
// the stream reports (0 when it reports none).
export async function openRecorderMic(
  set: StoreSet,
  get: StoreGet,
  rec: VocalRecorder,
  onFail?: () => void,
): Promise<number> {
  try {
    await rec.init(get().selectedDeviceId);
    const devices = await navigator.mediaDevices.enumerateDevices();
    set({ audioDevices: devices.filter((d) => d.kind === "audioinput") });
    const settings = rec.getStream()?.getAudioTracks()[0].getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    return settings?.latency ?? 0;
  } catch (e) {
    onFail?.();
    throw micError(e);
  }
}

// After getUserMedia, Windows may switch the "Default" audio alias to the
// Communications endpoint, so sinkId="" would route to the wrong device;
// pin the real hardware output so the singer hears the instrumental
// through the regular headphone output.
export async function pinHardwareOutput(get: StoreGet, eng: AudioEngine, failureMessage: string): Promise<string> {
  const allDevices = await navigator.mediaDevices.enumerateDevices();
  const outputId = get().selectedOutputDeviceId ?? pickHardwareOutput(allDevices, get().selectedDeviceId) ?? "";
  try {
    await eng.setOutputDevice(outputId);
  } catch (e) {
    console.warn(failureMessage, e);
  }
  return outputId;
}

// Plays N bars of click at the song's tempo before capture begins. Resolves
// true when the count finished, false when cancelCountIn aborted it.
export function runCountIn(set: StoreSet, bpm: number, bars: number): Promise<boolean> {
  const totalBeats = bars * 4;
  const beatIntervalMs = (60 / bpm) * 1000;
  return new Promise<boolean>((resolve) => {
    let remaining = totalBeats;
    session.countInResolve = resolve;
    set({ isCountingIn: true, countInBeatsRemaining: remaining });
    metronome.start(bpm, 0.05, 0);
    session.countInIntervalId = window.setInterval(() => {
      remaining -= 1;
      set({ countInBeatsRemaining: Math.max(0, remaining) });
    }, beatIntervalMs);
    session.countInTimeoutId = window.setTimeout(() => {
      session.countInTimeoutId = null;
      if (session.countInIntervalId !== null) {
        window.clearInterval(session.countInIntervalId);
        session.countInIntervalId = null;
      }
      metronome.stop();
      set({ isCountingIn: false, countInBeatsRemaining: 0 });
      session.countInResolve = null;
      resolve(true);
    }, countInDurationSeconds(bpm, bars) * 1000);
  });
}

export function cancelRunningCountIn(set: StoreSet): void {
  if (session.countInResolve === null) return;
  if (session.countInTimeoutId !== null) {
    window.clearTimeout(session.countInTimeoutId);
    session.countInTimeoutId = null;
  }
  if (session.countInIntervalId !== null) {
    window.clearInterval(session.countInIntervalId);
    session.countInIntervalId = null;
  }
  metronome.stop();
  set({ isCountingIn: false, countInBeatsRemaining: 0 });
  const resolve = session.countInResolve;
  session.countInResolve = null;
  resolve(false);
}

// Cancelled mid-count: abandon this recording attempt, releasing the mic
// already opened and restoring normal output routing (mirrors the restore in
// stopRecording).
export async function abandonAfterCountIn(get: StoreGet, eng: AudioEngine, rec: VocalRecorder): Promise<void> {
  rec.releaseStream();
  eng.setInteract(true);
  await eng.setOutputDevice(get().selectedOutputDeviceId ?? "").catch((e: unknown) =>
    console.warn("[recording] setOutputDevice on count-in cancel failed:", e)
  );
  metronome.setOutputDevice(get().selectedOutputDeviceId ?? "");
}

// Calibrated value takes full priority — skip AudioContext measurement when present.
// A stored entry is only trusted if it isn't stale and was measured against the
// output device actually in use (entries without outputDeviceId predate that
// check and are exempt).
export function resolveRecordingLatency(set: StoreSet, get: StoreGet, outputId: string, inputLatencyS: number): void {
  const calib = get().recordingOffsets[get().selectedDeviceId ?? ""];
  const calibUsable =
    calib !== undefined &&
    calib.offset > 0 &&
    !calib.stale &&
    (calib.outputDeviceId === undefined || calib.outputDeviceId === outputId);
  if (calibUsable) {
    set({ usedLatencyFallback: false });
    session.recordingLatencyS = calib.offset / 1000;
    console.log("[recording] using calibrated compensation:", calib.offset, "ms");
    return;
  }
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
    session.recordingLatencyS = outputLatencyS + inputLatencyS;
    console.log("[recording] latency — output:", outputLatencyS, "input:", inputLatencyS, "total:", session.recordingLatencyS);
  } catch (e) {
    console.warn("[recording] latency measurement failed, compensation disabled:", e);
    session.recordingLatencyS = 0;
  }
}

// Release mic tracks so Windows exits communication mode and restores the
// default audio endpoint, then put output routing back to the user's selection.
export async function releaseRecorderMic(
  get: StoreGet,
  eng: AudioEngine,
  rec: VocalRecorder,
  failureMessage: string,
  restoreMetronome: boolean,
): Promise<void> {
  destroyMicAnalyser();
  rec.releaseStream();
  await eng.setOutputDevice(get().selectedOutputDeviceId ?? "").catch((e: unknown) => console.warn(failureMessage, e));
  if (restoreMetronome) metronome.setOutputDevice(get().selectedOutputDeviceId ?? "");
}
