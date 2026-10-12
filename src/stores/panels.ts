import { createPanelStore } from "@giamat90/mps-core/panels";

// Order is the default order of the page and of the Panels menu; the user can
// move panels (`order` in the store). The practice room is crowded by design,
// so the expert views start hidden; the user's choices are kept.
export const PRACTICE_PANELS = [
  { id: "lyrics", label: "Lyrics", defaultVisible: true },
  { id: "takes", label: "Takes", defaultVisible: true },
  { id: "pianoRoll", label: "Piano roll", defaultVisible: true },
  { id: "spectrum", label: "Spectrum comparison", defaultVisible: false },
  { id: "dynamics", label: "Dynamics", defaultVisible: false },
  { id: "vibrato", label: "Vibrato", defaultVisible: true },
  { id: "timing", label: "Timing", defaultVisible: false },
  { id: "coach", label: "Coach", defaultVisible: true },
] as const;

export type PracticePanelId = (typeof PRACTICE_PANELS)[number]["id"];

export const usePracticePanels = createPanelStore({ storageKey: "vps_panels", panels: PRACTICE_PANELS });

export function availablePracticePanels({ isInstrument }: { isInstrument: boolean }) {
  return PRACTICE_PANELS.filter((p) => !(isInstrument && p.id === "lyrics"));
}
