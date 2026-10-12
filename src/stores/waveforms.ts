import { createPanelStore } from "@giamat90/mps-core/panels";

// What the user wants to see of the waveform area. Not part of panels.ts: those
// panels are unmounted when hidden and can be moved or detached, whereas the
// waveform area owns the audio engine's containers, so hiding it only collapses
// it and the audio is never affected. `waveforms` is the whole area; the other
// ids are its tracks, where "not visible" means shrunk to the strip with the
// name, M, S and volume (the arrow on the strip, or the Panels menu). Recorded
// takes have their own show/hide in the take list.
export const WAVEFORM_PANELS = [
  { id: "waveforms", label: "Waveforms", defaultVisible: true },
  { id: "vocals", label: "Vocals", defaultVisible: true },
  { id: "instrumental", label: "Instrumental", defaultVisible: true },
] as const;

export type WaveformPanelId = (typeof WAVEFORM_PANELS)[number]["id"];

export const useWaveformPanels = createPanelStore({ storageKey: "vps_waveforms", panels: WAVEFORM_PANELS });

export interface WaveformMenuItem {
  id: WaveformPanelId;
  label: string;
  parts?: readonly { id: WaveformPanelId; label: string }[];
}

/** What the Panels menu offers: an instrument track has one lane, the melody, and no instrumental to choose. */
export function waveformMenuItems({ isInstrument }: { isInstrument: boolean }): WaveformMenuItem[] {
  const parts = isInstrument
    ? [{ id: "vocals" as const, label: "Melody" }]
    : [
        { id: "vocals" as const, label: "Vocals" },
        { id: "instrumental" as const, label: "Instrumental" },
      ];
  return [{ id: "waveforms", label: "Waveforms", parts }];
}

/** Why a minimized track may be silent or alone: its waveform is shrunk to a strip but its mute and solo still apply. */
export function hiddenTrackTags(
  visible: Readonly<Record<WaveformPanelId, boolean>>,
  { muted, soloed }: { muted: Readonly<Partial<Record<string, boolean>>>; soloed: string | null },
): Partial<Record<WaveformPanelId, string>> {
  const tags: Partial<Record<WaveformPanelId, string>> = {};
  for (const id of ["vocals", "instrumental"] as const) {
    if (visible[id]) continue;
    if (soloed === id) tags[id] = "solo";
    else if (muted[id]) tags[id] = "muted";
  }
  return tags;
}
