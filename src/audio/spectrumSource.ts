import { estimateFormants, type FormantEstimate } from "../lib/formants";
import { decodeSpectrum } from "../windows/spectrumCodec";
import type { SpectrumMessage } from "../windows/protocol";

export const FORMANT_WINDOW = 8192;
export const NO_FORMANTS: FormantEstimate = { f1: null, f2: null, f3: null };

export type FormantKind = "song" | "take" | "live";

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
   */
  getFormants(kind: FormantKind, timeKey: number): FormantEstimate;
  /** Forget cached estimates (the song or take changed). */
  reset(): void;
}

interface Tracker {
  prev: FormantEstimate;
  key: number;
  est: FormantEstimate;
}

const newTracker = (): Tracker => ({ prev: NO_FORMANTS, key: Number.NaN, est: NO_FORMANTS });

export interface LocalSourceDeps {
  getAnalyser: () => AnalyserNode | null;
  getTrackSamples: (
    track: "vocals" | "take",
    windowSize: number,
  ) => { samples: Float32Array; sampleRate: number } | null;
  estimate?: typeof estimateFormants;
}

/** The engine and the microphone in this window: what the panel always used. */
export function createLocalSpectrumSource(deps: LocalSourceDeps): SpectrumSource {
  const estimate = deps.estimate ?? estimateFormants;
  let trackers: Record<FormantKind, Tracker> = { song: newTracker(), take: newTracker(), live: newTracker() };
  let freqScratch: Float32Array<ArrayBuffer> | null = null;
  let timeScratch: Float32Array<ArrayBuffer> | null = null;

  const tracked = (
    kind: FormantKind,
    key: number,
    getSamples: () => { samples: Float32Array; sampleRate: number } | null,
  ): FormantEstimate => {
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

    reset() {
      trackers = { song: newTracker(), take: newTracker(), live: newTracker() };
    },
  };
}

/** What a detached window uses: the last thing the main window sent. */
export function createRemoteSpectrumSource(): { source: SpectrumSource; apply(message: SpectrumMessage): void } {
  let live: LiveSpectrum | null = null;
  let formants: SpectrumMessage["formants"] | null = null;
  let scratch: Float32Array | undefined;

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
      live = next;
      formants = message.formants;
    },

    source: {
      getLiveSpectrum: () => live,
      getFormants: (kind) => formants?.[kind] ?? NO_FORMANTS,
      reset: () => {},
    },
  };
}
