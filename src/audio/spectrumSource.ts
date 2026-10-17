import { computeMagnitudeSpectrumDb, estimateVoice, type VoiceEstimate } from "@giamat90/mps-core/spectrum";
import { decodeSpectrum } from "../windows/spectrumCodec";
import type { SpectrumMessage } from "../windows/protocol";

export const FORMANT_WINDOW = 8192;

/** The analyser's window, in seconds: 8192 samples at 44.1 kHz. */
const SPECTRUM_WINDOW_S = 0.186;

/**
 * FFT size giving the analyser's ~186 ms window at `sampleRate`. The engine's decoded buffers are not at the
 * file's rate (WaveSurfer decodes at 8 kHz), where 8192 samples would be a full second of audio.
 */
export function spectrumFftSize(sampleRate: number): number {
  const size = 2 ** Math.round(Math.log2(SPECTRUM_WINDOW_S * sampleRate));
  return Math.max(256, Math.min(FORMANT_WINDOW, size));
}
export const NO_FORMANTS: VoiceEstimate = { f0: null, f1: null, f2: null, f3: null };

export type FormantKind = "song" | "take" | "live";
export type TrackKind = "song" | "take";

export interface LiveSpectrum {
  /** Web Audio dB values, one per FFT bin. */
  data: Float32Array;
  sampleRate: number;
}

/**
 * Where the spectrum comparison gets what only the audio engine and the
 * microphone can give it. The panel draws; it does not care whether this is
 * the engine in the same window or a stream from the main one.
 */
export interface SpectrumSource {
  getLiveSpectrum(): LiveSpectrum | null;
  /**
   * `timeKey` identifies the audio window for song and take estimates so an
   * unchanged window is not estimated again; NaN means never cache.
   * Carries the window's fundamental (`f0`) alongside F1-F3.
   */
  getFormants(kind: FormantKind, timeKey: number): VoiceEstimate;
  /**
   * The song's or the take's spectrum at the playhead, FFT-ed from the decoded audio with the
   * analyser's window and scale, so it goes through exactly the path the live curve does. Null
   * when there is nothing audible there. `timeKey` as for getFormants.
   */
  getTrackSpectrum(kind: TrackKind, timeKey: number): LiveSpectrum | null;
  /** Forget cached estimates (the song or take changed). */
  reset(): void;
}

interface Tracker {
  prev: VoiceEstimate;
  key: number;
  est: VoiceEstimate;
}

const newTracker = (): Tracker => ({ prev: NO_FORMANTS, key: Number.NaN, est: NO_FORMANTS });

export interface LocalSourceDeps {
  getAnalyser: () => AnalyserNode | null;
  getTrackSamples: (
    track: "vocals" | "take",
    windowSize: number,
  ) => { samples: Float32Array; sampleRate: number } | null;
  estimate?: typeof estimateVoice;
}

/** The engine and the microphone in this window: what the panel always used. */
export function createLocalSpectrumSource(deps: LocalSourceDeps): SpectrumSource {
  const estimate = deps.estimate ?? estimateVoice;
  let trackers: Record<FormantKind, Tracker> = { song: newTracker(), take: newTracker(), live: newTracker() };
  const emptySpectra = (): Record<TrackKind, { key: number; value: LiveSpectrum | null }> => ({
    song: { key: Number.NaN, value: null },
    take: { key: Number.NaN, value: null },
  });
  let spectra = emptySpectra();
  let freqScratch: Float32Array<ArrayBuffer> | null = null;
  let timeScratch: Float32Array<ArrayBuffer> | null = null;

  const tracked = (
    kind: FormantKind,
    key: number,
    getSamples: () => { samples: Float32Array; sampleRate: number } | null,
  ): VoiceEstimate => {
    const tracker = trackers[kind];
    if (!Number.isNaN(key) && tracker.key === key) return tracker.est;
    const snapshot = getSamples();
    tracker.est = snapshot ? estimate(snapshot.samples, snapshot.sampleRate, tracker.prev) : NO_FORMANTS;
    tracker.prev = tracker.est;
    tracker.key = key;
    return tracker.est;
  };

  return {
    getLiveSpectrum() {
      const analyser = deps.getAnalyser();
      if (!analyser) return null;
      if (!freqScratch || freqScratch.length !== analyser.frequencyBinCount) {
        freqScratch = new Float32Array(analyser.frequencyBinCount);
      }
      analyser.getFloatFrequencyData(freqScratch);
      return { data: freqScratch, sampleRate: analyser.context.sampleRate };
    },

    getFormants(kind, timeKey) {
      if (kind === "live") {
        return tracked("live", Number.NaN, () => {
          const analyser = deps.getAnalyser();
          if (!analyser) return null;
          if (!timeScratch || timeScratch.length !== analyser.fftSize) timeScratch = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(timeScratch);
          return { samples: timeScratch, sampleRate: analyser.context.sampleRate };
        });
      }
      return tracked(kind, timeKey, () => deps.getTrackSamples(kind === "song" ? "vocals" : "take", FORMANT_WINDOW));
    },

    getTrackSpectrum(kind, timeKey) {
      const cached = spectra[kind];
      if (!Number.isNaN(timeKey) && cached.key === timeKey) return cached.value;
      const snapshot = deps.getTrackSamples(kind === "song" ? "vocals" : "take", FORMANT_WINDOW);
      if (snapshot) {
        // The window is centred on the playhead, so its middle `size` samples are the ones to use.
        const size = Math.min(snapshot.samples.length, spectrumFftSize(snapshot.sampleRate));
        const start = Math.floor((snapshot.samples.length - size) / 2);
        cached.value = {
          data: computeMagnitudeSpectrumDb(snapshot.samples.subarray(start, start + size), size),
          sampleRate: snapshot.sampleRate,
        };
      } else {
        cached.value = null;
      }
      cached.key = timeKey;
      return cached.value;
    },

    reset() {
      trackers = { song: newTracker(), take: newTracker(), live: newTracker() };
      spectra = emptySpectra();
    },
  };
}

/** What a detached window uses: the last thing the main window sent. */
export function createRemoteSpectrumSource(): { source: SpectrumSource; apply(message: SpectrumMessage): void } {
  let live: LiveSpectrum | null = null;
  let tracks: Record<TrackKind, LiveSpectrum | null> = { song: null, take: null };
  let formants: SpectrumMessage["formants"] | null = null;
  let scratch: Float32Array | undefined;
  const trackScratch: Partial<Record<TrackKind, Float32Array>> = {};

  return {
    apply(message) {
      let next: LiveSpectrum | null = null;
      if (message.live) {
        try {
          scratch = decodeSpectrum(message.live.bins, scratch);
          next = { data: scratch, sampleRate: message.live.sampleRate };
        } catch (e) {
          console.warn("[detached] could not decode the live spectrum:", e);
          return;
        }
      }
      const nextTracks: Record<TrackKind, LiveSpectrum | null> = { song: null, take: null };
      for (const kind of ["song", "take"] as const) {
        const encoded = message.tracks[kind];
        if (!encoded) continue;
        try {
          const data = decodeSpectrum(encoded.bins, trackScratch[kind]);
          trackScratch[kind] = data;
          nextTracks[kind] = { data, sampleRate: encoded.sampleRate };
        } catch (e) {
          console.warn(`[detached] could not decode the ${kind} spectrum:`, e);
          return;
        }
      }
      live = next;
      tracks = nextTracks;
      formants = message.formants;
    },

    source: {
      getLiveSpectrum: () => live,
      getFormants: (kind) => formants?.[kind] ?? NO_FORMANTS,
      getTrackSpectrum: (kind) => tracks[kind],
      reset: () => {},
    },
  };
}
