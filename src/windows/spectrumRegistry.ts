import { createLocalSpectrumSource, type SpectrumSource } from "../audio/spectrumSource";
import { getEngine, getMicAnalyser } from "../stores/player";

let local: SpectrumSource | null = null;
let installed: SpectrumSource | null = null;

/** The engine and microphone of this window; also what feeds a detached spectrum window. */
export function getLocalSpectrumSource(): SpectrumSource {
  local ??= createLocalSpectrumSource({
    getAnalyser: getMicAnalyser,
    getTrackSamples: (track, windowSize) => getEngine().getTrackSamples(track, windowSize),
  });
  return local;
}

/** What the spectrum panel reads: the local source, or the stream a detached window installed. */
export function getSpectrumSource(): SpectrumSource {
  return installed ?? getLocalSpectrumSource();
}

/** Returns the remover; it only acts while that source is still the installed one. */
export function installSpectrumSource(next: SpectrumSource): () => void {
  installed = next;
  return () => {
    if (installed === next) installed = null;
  };
}
