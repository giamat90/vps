import { getEngine } from "../stores/player";

let source: (() => number) | null = null;

/**
 * Panels ask this for the playhead instead of asking the audio engine, so the
 * very same component can run in a detached window, where there is no engine
 * and the time comes from a clock mirrored from the main window.
 */
export function getPlaybackTime(): number {
  return source ? source() : getEngine().getCurrentTime();
}

export function setPlaybackTimeSource(next: (() => number) | null): void {
  source = next;
}

/**
 * Installs a source and returns the function that removes it. Removal only
 * happens if that source is still the current one, so a late cleanup cannot
 * take away a clock that replaced it.
 */
export function installPlaybackTimeSource(next: () => number): () => void {
  source = next;
  return () => {
    if (source === next) source = null;
  };
}
