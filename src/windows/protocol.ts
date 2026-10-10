import type { PitchPoint, Song, Take } from "../lib/types";

export const EVT_STATE = "mps:state";
export const EVT_LIVE = "mps:live";
export const EVT_COMMAND = "mps:command";
export const EVT_HELLO = "mps:hello";
export const EVT_DOCKED = "mps:docked";

export const DETACHABLE_PANELS = ["pianoRoll", "lyrics"] as const;
export type DetachablePanel = (typeof DETACHABLE_PANELS)[number];

export function isDetachablePanel(value: unknown): value is DetachablePanel {
  return typeof value === "string" && (DETACHABLE_PANELS as readonly string[]).includes(value);
}

/** Must match `plan` in src-tauri/src/windows.rs. */
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

export type Command =
  | { type: "seek"; time: number }
  | { type: "setPunchIn"; time: number }
  | { type: "setPunchOut"; time: number }
  | { type: "clearPunch" };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumberOrNull = (v: unknown): boolean => v === null || isNumber(v);
const isStringOrNull = (v: unknown): boolean => v === null || typeof v === "string";
const isObjectOrNull = (v: unknown): boolean => v === null || isObject(v);

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
    isStringOrNull(s.selectedOutputDeviceId) && isObjectOrNull(s.activeTake)
  );
}

export function isLiveMessage(value: unknown): value is LiveMessage {
  if (!isObject(value) || typeof value.reset !== "boolean" || !Array.isArray(value.points)) return false;
  if (!isNumberOrNull(value.cents)) return false;
  return value.points.every(
    (p) => isObject(p) && isNumber(p.time) && isNumber(p.frequency) && isNumber(p.confidence),
  );
}
