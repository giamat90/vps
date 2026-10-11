import {
  EVT_COMMAND,
  EVT_DOCKED,
  EVT_HELLO,
  EVT_STATE,
  definePanelWindows,
  isId,
  isNumber,
  isNumberOrNull,
  isObject,
  isObjectOrNull,
  isStateMessage as isCoreStateMessage,
  isStringOrNull,
  type StateMessage as CoreStateMessage,
  type TransportSnapshot,
} from "@giamat90/mps-core/windows";
import type { PitchPoint, Song, Take } from "../lib/types";

export { EVT_COMMAND, EVT_DOCKED, EVT_HELLO, EVT_STATE };
export type { TransportSnapshot };

export const EVT_LIVE = "mps:live";
export const EVT_SPECTRUM = "mps:spectrum";

/** Every optional panel of the practice room. Must match `plan` in src-tauri/src/windows.rs. */
export const DETACHABLE_PANELS = [
  "pianoRoll",
  "lyrics",
  "takes",
  "spectrum",
  "dynamics",
  "vibrato",
  "timing",
  "coach",
] as const;
export type DetachablePanel = (typeof DETACHABLE_PANELS)[number];

const windows = definePanelWindows<DetachablePanel>(DETACHABLE_PANELS);

export const isDetachablePanel = windows.isPanel;
export const detachedLabel = windows.label;
/** The window knows what it shows from its own label, not from anything in a URL. */
export const panelFromLabel = windows.fromLabel;

/**
 * What the takes list needs. A full Take carries pitch and spectrum arrays that
 * can run to megabytes; only the active one is sent whole.
 */
export type TakeSummary = Pick<Take, "id" | "songId" | "recordedAt" | "filepath" | "name" | "startPosition">;

export interface SharedState {
  song: Song | null;
  duration: number;
  isRecording: boolean;
  isMonitoring: boolean;
  exerciseMode: boolean;
  punchIn: number | null;
  punchOut: number | null;
  punchLoop: boolean;
  selectedOutputDeviceId: string | null;
  activeTake: Take | null;
  /** Takes with a lane on screen, in the order they were shown. */
  shownTakeIds: string[];
  /** How the shown takes are heard, the lanes muted by hand, and whether recording silences them. */
  takePlayback: "all" | "selected";
  mutedTakeIds: string[];
  /** The take soloed on its lane, if any. */
  soloedTakeId: string | null;
  /** The main take mute is on, or another track is soloed: no take is heard. */
  takesSilenced: boolean;
  muteTakesWhileRecording: boolean;
  takes: TakeSummary[];
}

export type StateMessage = CoreStateMessage<SharedState>;

export interface LiveMessage {
  /** The detached copy of the live trace starts over before `points` are applied. */
  reset: boolean;
  points: PitchPoint[];
  cents: number | null;
}

export interface FormantsPayload {
  f1: number | null;
  f2: number | null;
  f3: number | null;
}

/** The part of the spectrum comparison that needs the audio engine or the microphone. */
export interface SpectrumMessage {
  /** The live dB spectrum, quantised to one byte per bin (see spectrumCodec). */
  live: { sampleRate: number; bins: string } | null;
  formants: { song: FormantsPayload; take: FormantsPayload; live: FormantsPayload };
}

export type Command =
  | { type: "seek"; time: number }
  | { type: "setPunchIn"; time: number }
  | { type: "setPunchOut"; time: number }
  | { type: "clearPunch" }
  | { type: "toggleTake"; id: string }
  | { type: "deleteTake"; id: string }
  | { type: "renameTake"; id: string; name: string };

const NAME_MAX = 200;

const isFormants = (v: unknown): boolean =>
  isObject(v) && isNumberOrNull(v.f1) && isNumberOrNull(v.f2) && isNumberOrNull(v.f3);

/** Everything crossing the window boundary is treated as untrusted input. */
export function parseCommand(value: unknown): Command | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case "seek":
    case "setPunchIn":
    case "setPunchOut":
      return isNumber(value.time) && value.time >= 0 ? { type: value.type, time: value.time } : null;
    case "clearPunch":
      return { type: "clearPunch" };
    case "toggleTake":
    case "deleteTake":
      return isId(value.id) ? { type: value.type, id: value.id } : null;
    case "renameTake":
      return isId(value.id) && typeof value.name === "string" && value.name.length <= NAME_MAX
        ? { type: "renameTake", id: value.id, name: value.name }
        : null;
    default:
      return null;
  }
}

export function isSharedState(value: unknown): value is SharedState {
  if (!isObject(value)) return false;
  const s = value;
  return (
    isObjectOrNull(s.song) && isNumber(s.duration) &&
    typeof s.isRecording === "boolean" && typeof s.isMonitoring === "boolean" &&
    typeof s.exerciseMode === "boolean" && typeof s.punchLoop === "boolean" &&
    isNumberOrNull(s.punchIn) && isNumberOrNull(s.punchOut) &&
    isStringOrNull(s.selectedOutputDeviceId) && isObjectOrNull(s.activeTake) &&
    Array.isArray(s.shownTakeIds) && s.shownTakeIds.every(isId) &&
    (s.takePlayback === "all" || s.takePlayback === "selected") &&
    Array.isArray(s.mutedTakeIds) && s.mutedTakeIds.every(isId) &&
    isStringOrNull(s.soloedTakeId) &&
    typeof s.takesSilenced === "boolean" &&
    typeof s.muteTakesWhileRecording === "boolean" &&
    Array.isArray(s.takes) && s.takes.every((t) => isObject(t) && isId(t.id))
  );
}

export function isStateMessage(value: unknown): value is StateMessage {
  return isCoreStateMessage(value, isSharedState);
}

export function isSpectrumMessage(value: unknown): value is SpectrumMessage {
  if (!isObject(value) || !isObject(value.formants)) return false;
  const live = value.live;
  const liveOk = live === null || (isObject(live) && isNumber(live.sampleRate) && typeof live.bins === "string");
  const f = value.formants;
  return liveOk && isFormants(f.song) && isFormants(f.take) && isFormants(f.live);
}

export function isLiveMessage(value: unknown): value is LiveMessage {
  if (!isObject(value) || typeof value.reset !== "boolean" || !Array.isArray(value.points)) return false;
  if (!isNumberOrNull(value.cents)) return false;
  return value.points.every(
    (p) => isObject(p) && isNumber(p.time) && isNumber(p.frequency) && isNumber(p.confidence),
  );
}
