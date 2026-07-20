// Computes the wall-clock delay until the next metronome click that stays
// phase-locked to a song-time "downbeat" anchor, instead of always starting
// fresh at beat 0 whenever playback starts (which drifts out of sync with
// the song's actual downbeat whenever there's silence, or a pickup, before
// it — the motivating case for the metronome downbeat offset feature).

export interface MetronomePhase {
  /** Wall-clock seconds from "now" until the next aligned click. */
  timeUntilNextBeat: number;
  /** Which beat-in-bar (0-indexed) that next click represents, for accenting. */
  beatIndex: number;
}

export function computeMetronomePhase(args: {
  detectedBpm: number;
  playbackRate: number;
  anchorTime: number;
  currentSongTime: number;
  beatsPerBar?: number;
}): MetronomePhase {
  const { detectedBpm, playbackRate, anchorTime, currentSongTime, beatsPerBar = 4 } = args;
  if (!(detectedBpm > 0) || !(playbackRate > 0)) {
    return { timeUntilNextBeat: 0, beatIndex: 0 };
  }

  // Beat spacing in raw song-time seconds — unaffected by playback rate.
  const songBeatInterval = 60 / detectedBpm;
  const elapsed = currentSongTime - anchorTime;
  const mod = ((elapsed % songBeatInterval) + songBeatInterval) % songBeatInterval;
  const timeUntilNextBeatSong = mod === 0 ? 0 : songBeatInterval - mod;
  // Convert the song-time gap to a wall-clock delay: audio advances
  // `playbackRate` seconds of song-time per wall-clock second.
  const timeUntilNextBeat = timeUntilNextBeatSong / playbackRate;

  const beatsSinceAnchor = Math.round((elapsed + timeUntilNextBeatSong) / songBeatInterval);
  const beatIndex = ((beatsSinceAnchor % beatsPerBar) + beatsPerBar) % beatsPerBar;

  return { timeUntilNextBeat, beatIndex };
}

/** Wall-clock duration of a count-in of `bars` bars at `bpm`, in seconds. */
export function countInDurationSeconds(bpm: number, bars: number, beatsPerBar = 4): number {
  if (!(bpm > 0) || bars <= 0) return 0;
  return (bars * beatsPerBar * 60) / bpm;
}
