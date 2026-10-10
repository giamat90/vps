import type { PitchPoint, Song, Take } from "../lib/types";

export const EVT_STATE = "mps:state";
export const EVT_LIVE = "mps:live";
export const EVT_SPECTRUM = "mps:spectrum";
export const EVT_COMMAND = "mps:command";
export const EVT_HELLO = "mps:hello";
export const EVT_DOCKED = "mps:docked";

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

export function isDetachablePanel(value: unknown): value is DetachablePanel {
  return typeof value === "string" && (DETACHABLE_PANELS as readonly string[]).includes(value);
}

export function detachedLabel(panel: DetachablePanel): string {
  return `detached-${panel}`;
}

/** The window knows what it shows from its own label, not from anything in a URL. */
export function panelFromLabel(label: string): DetachablePanel | null {
  const match = /^detached-([A-Za-z]+)$/.exec(label);
  return match && isDetachablePanel(match[1]) ? match[1] : null;
}

export interface TransportSnapshot {
  /** Song time at `sentAt`. */
  time: number;
  playing: boolean;
  rate: number;
  /** Date.now() in the sending window; both windows share the machine clock. */
  sentAt: number;
}

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
  takes: TakeSummary[];
}

export interface StateMessage {
  transport: TransportSnapshot;
  shared: SharedState;
}

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
  | { type: "setActiveTake"; id: string }
  | { type: "deleteTake"; id: string }
  | { type: "renameTake"; id: string; name: string };

const ID_MAX = 128;
const NAME_MAX = 200;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumberOrNull = (v: unknown): boolean => v === null || isNumber(v);
const isStringOrNull = (v: unknown): boolean => v === null || typeof v === "string";
const isObjectOrNull = (v: unknown): boolean => v === null || isObject(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= ID_MAX;
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
    case "setActiveTake":
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

export function isStateMessage(value: unknown): value is StateMessage {
  if (!isObject(value) || !isObject(value.transport) || !isObject(value.shared)) return false;
  const t = value.transport;
  const s = value.shared;
  return (
    isNumber(t.time) && typeof t.playing === "boolean" && isNumber(t.rate) && isNumber(t.sentAt) &&
    isObjectOrNull(s.song) && isNumber(s.duration) &&
    typeof s.isRecording === "boolean" && typeof s.isMonitoring === "boolean" &&
    typeof s.exerciseMode === "boolean" && typeof s.punchLoop === "boolean" &&
    isNumberOrNull(s.punchIn) && isNumberOrNull(s.punchOut) &&
    isStringOrNull(s.selectedOutputDeviceId) && isObjectOrNull(s.activeTake) &&
    Array.isArray(s.takes) && s.takes.every((t) => isObject(t) && isId(t.id))
  );
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
