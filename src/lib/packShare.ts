import type { PackShareEvent, PackShareInfo, PackSummary } from "./tauri";

export type ShareState =
  | { phase: "choose" }
  | { phase: "preparing"; progress: { value: number; stage: string } | null }
  | { phase: "ready"; info: PackShareInfo; interrupted: boolean }
  | { phase: "sending"; info: PackShareInfo; sent: number; total: number }
  | { phase: "done"; info: PackShareInfo }
  | { phase: "expired"; info: PackShareInfo }
  | { phase: "failed"; message: string };

export type ShareAction =
  | { type: "start" }
  | { type: "started"; info: PackShareInfo }
  | { type: "failed"; message: string }
  | { type: "event"; event: PackShareEvent }
  | { type: "back" };

export const initialShareState: ShareState = { phase: "choose" };

/**
 * Events come from a server thread, so one can arrive after the dialog has moved on (a late
 * progress tick after "done"): only a code that is on screen can change.
 */
export function shareReducer(state: ShareState, action: ShareAction): ShareState {
  switch (action.type) {
    case "start":
      return state.phase === "sending" ? state : { phase: "preparing", progress: null };
    case "started":
      return state.phase === "preparing" ? { phase: "ready", info: action.info, interrupted: false } : state;
    case "failed":
      return state.phase === "preparing" ? { phase: "failed", message: action.message } : state;
    case "back":
      return { phase: "choose" };
    case "event": {
      if (action.event.kind === "building") {
        return state.phase === "preparing"
          ? { phase: "preparing", progress: { value: action.event.value, stage: action.event.stage } }
          : state;
      }
      if (state.phase !== "ready" && state.phase !== "sending") return state;
      const { info } = state;
      switch (action.event.kind) {
        case "sending":
          return { phase: "sending", info, sent: action.event.sent, total: action.event.total };
        case "interrupted":
          return { phase: "ready", info, interrupted: true };
        case "done":
          return { phase: "done", info };
        case "expired":
          return state.phase === "ready" ? { phase: "expired", info } : state;
      }
    }
  }
}

export function percent(sent: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((sent / total) * 100)));
}

export function describePack(summary: PackSummary): string {
  const mb = (summary.sizeBytes / (1024 * 1024)).toFixed(1);
  const parts = [`${mb} MB`];
  if (summary.variants.length > 0) {
    parts.push(`${summary.variants.length} transposition${summary.variants.length === 1 ? "" : "s"}`);
  }
  if (summary.hasLyrics) parts.push("lyrics");
  if (!summary.hasReference) parts.push("no reference melody");
  return parts.join(", ");
}

export function addressLabel(address: { ip: string; name: string }): string {
  return `${address.name} (${address.ip})`;
}
