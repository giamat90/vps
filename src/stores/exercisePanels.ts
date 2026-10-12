import { createPanelStore } from "@giamat90/mps-core/panels";

// What the Free Exercise page shows. Not movable and not detachable (practice
// room panels are), so this is only a visibility choice. `track` is the strip a
// loaded recording is drawn into: it is collapsed, never unmounted, because the
// audio engine draws into that element.
export const EXERCISE_PANELS = [
  { id: "keyboard", label: "Piano keyboard", defaultVisible: true },
  { id: "track", label: "Loaded track", defaultVisible: true },
  { id: "pianoRoll", label: "Piano roll", defaultVisible: true },
  { id: "spectrogram", label: "Spectrogram", defaultVisible: true },
  { id: "spectrum", label: "Short-term spectrum", defaultVisible: true },
  { id: "dynamics", label: "Dynamics", defaultVisible: true },
  { id: "vibrato", label: "Vibrato", defaultVisible: true },
  { id: "recordings", label: "Recordings", defaultVisible: true },
] as const;

export type ExercisePanelId = (typeof EXERCISE_PANELS)[number]["id"];

export const useExercisePanels = createPanelStore({ storageKey: "vps_exercise_panels", panels: EXERCISE_PANELS });

/** The analysis views stacked in the scrolling area of the page, in the order the page draws them. */
export const EXERCISE_ANALYSIS_PANELS: readonly ExercisePanelId[] = [
  "pianoRoll",
  "spectrogram",
  "spectrum",
  "dynamics",
  "vibrato",
];
