import type { LiveSpectrum, SpectrumSource } from "../audio/spectrumSource";
import { NO_FORMANTS } from "../audio/spectrumSource";
import type { VoiceEstimate } from "@giamat90/mps-core/spectrum";
import { encodeSpectrum } from "./spectrumCodec";
import type { EncodedSpectrum, SpectrumMessage } from "./protocol";

/** Song and take estimates only need redoing when the playhead has moved this far. */
const FORMANT_CACHE_STEP_S = 0.02;

export interface SpectrumFeedDeps {
  source: SpectrumSource;
  getPlayer: () => { isRecording: boolean; isMonitoring: boolean; currentTime: number };
  getAnalysis: () => { songSTSpectrum: unknown | null; takeSTSpectrum: unknown | null };
}

const formantsKey = (m: SpectrumMessage) => JSON.stringify(m.formants);
const encode = (s: LiveSpectrum): EncodedSpectrum => ({ sampleRate: s.sampleRate, bins: encodeSpectrum(s.data) });
const isEmpty = (v: VoiceEstimate) => v.f0 === null && v.f1 === null && v.f2 === null && v.f3 === null;

/**
 * Runs in the main window for a spectrum panel that lives elsewhere: asks the
 * local engine and microphone for what the panel needs and says it again only
 * when it differs from what the other window already has.
 */
export function createSpectrumFeed(deps: SpectrumFeedDeps): { read(): SpectrumMessage | null; reset(): void } {
  let last: SpectrumMessage | null = null;
  let seenSong: unknown;
  let seenTake: unknown;

  const read = (): SpectrumMessage | null => {
    const player = deps.getPlayer();
    const analysis = deps.getAnalysis();

    // A different take at the same playhead has the same cache key, so a
    // replaced spectrum is what tells the source its estimates are stale.
    if (analysis.songSTSpectrum !== seenSong || analysis.takeSTSpectrum !== seenTake) {
      seenSong = analysis.songSTSpectrum;
      seenTake = analysis.takeSTSpectrum;
      deps.source.reset();
    }

    const listening = player.isRecording || player.isMonitoring;
    const liveSpectrum = listening ? deps.source.getLiveSpectrum() : null;
    const timeKey = Math.round(player.currentTime / FORMANT_CACHE_STEP_S);

    const song = analysis.songSTSpectrum ? deps.source.getFormants("song", timeKey) : NO_FORMANTS;
    let take = NO_FORMANTS;
    let live = NO_FORMANTS;
    if (liveSpectrum) live = deps.source.getFormants("live", Number.NaN);
    else if (analysis.takeSTSpectrum) take = deps.source.getFormants("take", timeKey);

    // The take's curve is hidden while listening (live takes its place), as are its formants.
    const songTrack = analysis.songSTSpectrum ? deps.source.getTrackSpectrum("song", timeKey) : null;
    const takeTrack = !liveSpectrum && analysis.takeSTSpectrum ? deps.source.getTrackSpectrum("take", timeKey) : null;

    const message: SpectrumMessage = {
      live: liveSpectrum ? encode(liveSpectrum) : null,
      tracks: { song: songTrack ? encode(songTrack) : null, take: takeTrack ? encode(takeTrack) : null },
      formants: { song, take, live },
    };

    const nothing = !message.live && !songTrack && !takeTrack && isEmpty(song) && isEmpty(take) && isEmpty(live);
    if (!message.live) {
      const unchanged =
        last !== null &&
        last.live === null &&
        formantsKey(last) === formantsKey(message) &&
        last.tracks.song?.bins === message.tracks.song?.bins &&
        last.tracks.take?.bins === message.tracks.take?.bins;
      if (last === null ? nothing : unchanged) return null;
    }
    last = message;
    return message;
  };

  return { read, reset: () => { last = null; } };
}
