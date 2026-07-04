export const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

/** A4 = 440 Hz reference */
export const A4_FREQUENCY = 440;
export const A4_MIDI = 69;

/** Convert MIDI note number to frequency */
export function midiToFrequency(midi: number): number {
  return A4_FREQUENCY * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Convert frequency to MIDI note number (fractional) */
export function frequencyToMidi(freq: number): number {
  return A4_MIDI + 12 * Math.log2(freq / A4_FREQUENCY);
}

/** Convert frequency to note name + cents offset */
export function frequencyToNote(freq: number): { note: string; cents: number } {
  const midi = frequencyToMidi(freq);
  const rounded = Math.round(midi);
  const cents = Math.round((midi - rounded) * 100);
  const note = NOTE_NAMES[rounded % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return { note: `${note}${octave}`, cents };
}

// ─── Piano note window ────────────────────────────────────────────────────
//
// PianoRoll and PianoKeyboard both display a fixed-size 40-semitone window
// (unchanged from the legacy A2–C6 range) that slides to follow whichever
// pitch is currently active, instead of a static range — this lets both
// components support the full C0–C7 keyboard (needed for wide-range
// instrument practice tracks) without sacrificing the per-note visual
// resolution a 2–3 octave vocal or instrument line needs.

/** C0 — absolute lower bound of the supported range. */
export const PIANO_ABS_MIN = 12;
/** C7 — absolute upper bound of the supported range. */
export const PIANO_ABS_MAX = 96;
/** Fixed visible window size, in semitones (same span as the legacy A2–C6 window). */
export const PIANO_WINDOW_SIZE = 40;
/** A2 — window's starting lower bound before any note has played. */
export const PIANO_WINDOW_DEFAULT_MIN = 45;

/** Semitones of "dead zone" from each window edge before it starts moving. */
const PIANO_FOLLOW_MARGIN = 6;
/** Per-frame smoothing factor for the window's follow motion (lower = slower/smoother). */
const PIANO_FOLLOW_LERP = 0.06;

/**
 * Given the currently active note (or null if none), compute where the
 * window's lower bound should move to. Only shifts once the active note
 * gets within `PIANO_FOLLOW_MARGIN` semitones of an edge; otherwise holds
 * position. Always clamped so the window stays within [PIANO_ABS_MIN, PIANO_ABS_MAX].
 */
export function computePianoWindowTarget(activeMidi: number | null, currentMin: number): number {
  const currentMax = currentMin + PIANO_WINDOW_SIZE - 1;
  let targetMin = currentMin;
  if (activeMidi !== null) {
    if (activeMidi < currentMin + PIANO_FOLLOW_MARGIN) {
      targetMin = activeMidi - PIANO_FOLLOW_MARGIN;
    } else if (activeMidi > currentMax - PIANO_FOLLOW_MARGIN) {
      targetMin = activeMidi - PIANO_WINDOW_SIZE + 1 + PIANO_FOLLOW_MARGIN;
    }
  }
  return Math.max(PIANO_ABS_MIN, Math.min(PIANO_ABS_MAX - PIANO_WINDOW_SIZE + 1, targetMin));
}

/** Smoothly step the window's lower bound one animation frame toward `targetMin`. */
export function stepPianoWindow(currentMin: number, targetMin: number): number {
  return currentMin + (targetMin - currentMin) * PIANO_FOLLOW_LERP;
}
