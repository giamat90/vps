import { audibleTakes } from "@giamat90/mps-core/takes";
import type { MixSource } from "../../lib/tauri";
import { getEngine } from "./singletons";
import type { PlayerStore, TrackKey } from "./types";

// Soloing a track silences every other track; muting silences only that
// track. Neither ever overwrites the stored slider value — they only change
// what gets pushed to the engine, so unmuting/unsoloing restores the slider
// position exactly.
export function effectiveVolume(
  track: TrackKey,
  rawVolume: number,
  mutedTracks: Record<TrackKey, boolean>,
  soloedTrack: TrackKey | null,
): number {
  if (soloedTrack !== null) return track === soloedTrack ? rawVolume : 0;
  if (mutedTracks[track]) return 0;
  return rawVolume;
}

// A take soloed on its own lane only chooses among the takes; it never touches the
// other tracks, and the take channel's own mute / solo state outranks it.
const soloedTakeOf = (s: { soloedTakeId: string | null }): string | null => s.soloedTakeId;

/** The takes as a whole are silent: the main take mute is on, or another track is soloed. */
export function takesSilenced(s: { mutedTracks: Record<TrackKey, boolean>; soloedTrack: TrackKey | null }): boolean {
  return effectiveVolume("take", 1, s.mutedTracks, s.soloedTrack) === 0;
}

type MixState = Pick<
  PlayerStore,
  | "song"
  | "mutedTracks"
  | "soloedTrack"
  | "vocalsVolume"
  | "instrumentalVolume"
  | "takeVolume"
  | "shownTakeIds"
  | "activeTakeId"
  | "takePlayback"
  | "mutedTakeIds"
  | "soloedTakeId"
  | "takes"
  | "takeGains"
  | "punchIn"
  | "punchOut"
  | "duration"
>;

function takeSources(state: MixState, takeGain: number): MixSource[] {
  // What is heard is what is mixed: every take that is audible right now.
  const audible = audibleTakes({
    shown: state.shownTakeIds,
    active: state.activeTakeId,
    playback: state.takePlayback,
    muted: state.mutedTakeIds,
    recording: false,
    muteWhileRecording: false,
    soloed: soloedTakeOf(state),
    silenced: false,
  });
  const sources: MixSource[] = [];
  for (const id of audible) {
    const take = state.takes.find((t) => t.id === id);
    if (!take) continue;
    sources.push({
      path: take.filepath,
      gain: takeGain * (state.takeGains[id] ?? 1),
      isTake: true,
      startPosition: take.startPosition,
      audioOffset: take.audioOffset ?? 0,
      manualOffset: take.manualOffset ?? 0,
    });
  }
  return sources;
}

/**
 * Build the source list for an "export mix" render from the current store
 * state: one entry per track with nonzero effective volume, resolved to
 * the underlying file path (and take alignment fields, if applicable).
 * Returns null if no track is currently audible.
 */
export function buildMixSources(state: MixState): {
  sources: MixSource[];
  startSec: number;
  endSec: number;
} | null {
  const { song, mutedTracks, soloedTrack, vocalsVolume, instrumentalVolume } = state;
  if (!song) return null;

  const sources: MixSource[] = [];

  const vocalsGain = effectiveVolume("vocals", vocalsVolume, mutedTracks, soloedTrack);
  if (vocalsGain > 0) {
    sources.push({ path: `${song.directory}/vocals.wav`, gain: vocalsGain, isTake: false });
  }

  const instrumentalGain = effectiveVolume("instrumental", instrumentalVolume, mutedTracks, soloedTrack);
  if (instrumentalGain > 0) {
    sources.push({ path: `${song.directory}/instrumental.wav`, gain: instrumentalGain, isTake: false });
  }

  const takeGain = effectiveVolume("take", state.takeVolume, mutedTracks, soloedTrack);
  if (takeGain > 0) sources.push(...takeSources(state, takeGain));

  if (sources.length === 0) return null;

  return {
    sources,
    startSec: state.punchIn ?? 0,
    endSec: state.punchOut ?? state.duration,
  };
}

export function applyEffectiveVolumes(state: {
  vocalsVolume: number;
  instrumentalVolume: number;
  takeVolume: number;
  mutedTracks: Record<TrackKey, boolean>;
  soloedTrack: TrackKey | null;
}): void {
  const eng = getEngine();
  eng.setVocalsVolume(effectiveVolume("vocals", state.vocalsVolume, state.mutedTracks, state.soloedTrack));
  eng.setInstrumentalVolume(effectiveVolume("instrumental", state.instrumentalVolume, state.mutedTracks, state.soloedTrack));
  eng.setTakeVolume(effectiveVolume("take", state.takeVolume, state.mutedTracks, state.soloedTrack));
}

export function pushTakeAudio(state: PlayerStore): void {
  const eng = getEngine();
  eng.setActiveTakeTrack(state.activeTakeId);
  eng.setTakeGains(state.takeGains);
  eng.setAudibleTakeTracks(
    audibleTakes({
      shown: state.shownTakeIds,
      active: state.activeTakeId,
      playback: state.takePlayback,
      muted: state.mutedTakeIds,
      recording: state.isRecording,
      muteWhileRecording: state.muteTakesWhileRecording,
      soloed: soloedTakeOf(state),
      silenced: takesSilenced(state),
    }),
  );
}
