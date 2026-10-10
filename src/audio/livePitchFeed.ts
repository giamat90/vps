import type { PitchPoint } from "../lib/types";
import { centsDeviation, pitchAtTime } from "./analysisUtils";

export interface DetectorLike {
  start(stream: MediaStream): void;
  stop(): void;
  getCurrentPitch(): { frequency: number; cents: number } | null;
}

export interface FeedDeps {
  getPlayer: () => {
    isRecording: boolean;
    isMonitoring: boolean;
    isPlaying: boolean;
    currentTime: number;
    exerciseMode: boolean;
  };
  getAnalysis: () => { songPitch: PitchPoint[]; takePitch: PitchPoint[] };
  appendLivePitch: (point: PitchPoint) => void;
  clearLivePitch: () => void;
  setLiveCents: (cents: number | null) => void;
  getStream: (monitoring: boolean) => MediaStream | null;
  makeDetector: () => DetectorLike;
  requestFrame: (cb: () => void) => number;
  cancelFrame: (id: number) => void;
}

/**
 * Reads the microphone and writes the live pitch trace and the tuner reading
 * into the analysis store. It is not a panel: the piano roll and the tuner
 * only display what it produces, in this window or in a detached one, so it
 * has to keep running whichever of them is on screen.
 */
export function createLivePitchFeed(deps: FeedDeps): { sync(): void; dispose(): void } {
  let key: string | null = null;
  let detector: DetectorLike | null = null;
  let frameId: number | null = null;
  let running = false;

  const stop = () => {
    running = false;
    if (detector) {
      detector.stop();
      detector = null;
    }
    if (frameId !== null) {
      deps.cancelFrame(frameId);
      frameId = null;
    }
  };

  const sync = () => {
    const player = deps.getPlayer();
    const next = `${player.isRecording}|${player.isMonitoring}|${player.isPlaying}`;
    if (next === key) return;
    key = next;
    stop();

    // While paused currentTime is frozen, so a running detector would keep
    // appending at the same time and smear the ribbon. Recording always
    // implies playing, so this only affects monitor-only.
    const active = player.isRecording || (player.isMonitoring && player.isPlaying);
    if (!active) {
      deps.clearLivePitch();
      deps.setLiveCents(null);
      return;
    }

    const stream = deps.getStream(player.isMonitoring);
    if (!stream) return;

    deps.clearLivePitch();
    const det = deps.makeDetector();
    det.start(stream);
    detector = det;
    running = true;

    const tick = () => {
      const reading = det.getCurrentPitch();
      if (reading) {
        const { currentTime, exerciseMode } = deps.getPlayer();
        const analysis = deps.getAnalysis();
        // Free Exercise has no song; the loaded track (kept as takePitch) is the reference.
        const reference = pitchAtTime(exerciseMode ? analysis.takePitch : analysis.songPitch, currentTime);
        deps.setLiveCents(
          reference && reference.frequency > 0 ? centsDeviation(reading.frequency, reference.frequency) : reading.cents,
        );
        if (reading.frequency > 0) {
          deps.appendLivePitch({ time: currentTime, frequency: reading.frequency, confidence: 1.0 });
        }
      }
      if (running) frameId = deps.requestFrame(tick);
    };
    frameId = deps.requestFrame(tick);
  };

  return { sync, dispose: stop };
}
