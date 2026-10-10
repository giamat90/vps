import type { SpectrumSource } from "../audio/spectrumSource";
import { NO_FORMANTS } from "../audio/spectrumSource";
import { encodeSpectrum } from "./spectrumCodec";
import type { SpectrumMessage } from "./protocol";

/** Song and take estimates only need redoing when the playhead has moved this far. */
const FORMANT_CACHE_STEP_S = 0.02;

export interface SpectrumFeedDeps {
  source: SpectrumSource;
  getPlayer: () => { isRecording: boolean; isMonitoring: boolean; currentTime: number };
  getAnalysis: () => { songSTSpectrum: unknown | null; takeSTSpectrum: unknown | null };
}

const formantsKey = (m: SpectrumMessage) => JSON.stringify(m.formants);

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

    const message: SpectrumMessage = {
      live: liveSpectrum ? { sampleRate: liveSpectrum.sampleRate, bins: encodeSpectrum(liveSpectrum.data) } : null,
      formants: { song, take, live },
    };

    const nothing = !message.live && !song.f1 && !take.f1 && !live.f1 && !song.f2 && !take.f2 && !live.f2 && !song.f3 && !take.f3 && !live.f3;
    if (!message.live) {
      if (last === null ? nothing : last.live === null && formantsKey(last) === formantsKey(message)) return null;
    }
    last = message;
    return message;
  };

  return { read, reset: () => { last = null; } };
}
