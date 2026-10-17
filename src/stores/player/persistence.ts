import type { TakePlayback } from "@giamat90/mps-core/takes";
import type { CalibrationEntry } from "./types";

// The two choices about takes that outlive a session: how shown takes are heard,
// and whether they are muted while a new one is recorded.
const TAKE_PREFS_KEY = "vps_take_prefs";
export type TakePrefs = { takePlayback: TakePlayback; muteTakesWhileRecording: boolean };
const DEFAULT_TAKE_PREFS: TakePrefs = {
  takePlayback: "all",
  muteTakesWhileRecording: true,
};

export function loadTakePrefs(): TakePrefs {
  try {
    const raw = localStorage.getItem(TAKE_PREFS_KEY);
    if (raw === null) return DEFAULT_TAKE_PREFS;
    const v = JSON.parse(raw) as { takePlayback?: unknown; muteTakesWhileRecording?: unknown } | null;
    return {
      takePlayback: v?.takePlayback === "selected" ? "selected" : "all",
      muteTakesWhileRecording:
        typeof v?.muteTakesWhileRecording === "boolean" ? v.muteTakesWhileRecording : DEFAULT_TAKE_PREFS.muteTakesWhileRecording,
    };
  } catch (e) {
    console.warn("[player] could not read the take preferences:", e);
    return DEFAULT_TAKE_PREFS;
  }
}

export function persistTakePrefs(prefs: TakePrefs): void {
  try {
    localStorage.setItem(TAKE_PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.warn("[player] could not save the take preferences:", e);
  }
}

function toCalibrationEntry(deviceId: string, value: unknown): CalibrationEntry | null {
  // Legacy schema stored a plain number per device.
  if (typeof value === "number") return { offset: value };
  if (value !== null && typeof value === "object" && typeof (value as CalibrationEntry).offset === "number") {
    return value as CalibrationEntry;
  }
  console.warn("[settings] Dropping malformed recording offset entry:", deviceId, value);
  return null;
}

export function loadOffsets(): Record<string, CalibrationEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem("vps_recording_offsets") ?? "{}") as Record<string, unknown>;
    const offsets: Record<string, CalibrationEntry> = {};
    for (const [deviceId, value] of Object.entries(raw)) {
      const entry = toCalibrationEntry(deviceId, value);
      if (entry) offsets[deviceId] = entry;
    }
    return offsets;
  } catch (e) {
    console.warn("[settings] Could not load recording offsets:", e);
    return {};
  }
}

export function persistOffsets(offsets: Record<string, CalibrationEntry>): void {
  try {
    localStorage.setItem("vps_recording_offsets", JSON.stringify(offsets));
  } catch (e) {
    console.warn("[settings] Could not persist recording offsets:", e);
  }
}
