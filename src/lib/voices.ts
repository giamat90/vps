/**
 * Two singers on one stem. The sidecar stores the louder voice as the main line (`f0`) and the other
 * as `f0Alt`; which of them the app treats as *the* line is the user's choice, applied here.
 */

export type MainVoice = "loudest" | "higher" | "lower";

export const MAIN_VOICES: readonly { id: MainVoice; label: string }[] = [
  { id: "loudest", label: "Loudest" },
  { id: "higher", label: "Higher" },
  { id: "lower", label: "Lower" },
];

export const DEFAULT_MAIN_VOICE: MainVoice = "loudest";

export function isMainVoice(value: unknown): value is MainVoice {
  return MAIN_VOICES.some((v) => v.id === value);
}

export interface ArrangedVoices {
  /** The line the rest of the app follows: ribbon, tuner, coach, live feedback. */
  main: number[];
  /** The other voice, 0 where only one sings. */
  second: number[];
}

/**
 * Pick the main line per frame. Where only one voice sings it stays on the main line whatever the
 * preference says; "higher" / "lower" only decide between two simultaneous voices.
 */
export function arrangeVoices(f0: number[], f0Alt: number[] | undefined, mode: MainVoice): ArrangedVoices {
  const alt = f0Alt && f0Alt.length === f0.length ? f0Alt : null;
  if (!alt) return { main: f0, second: new Array<number>(f0.length).fill(0) };
  if (mode === "loudest") return { main: f0, second: alt };

  const main = new Array<number>(f0.length);
  const second = new Array<number>(f0.length);
  for (let i = 0; i < f0.length; i++) {
    const a = f0[i];
    const b = alt[i];
    if (a > 0 && b > 0) {
      const wantHigher = mode === "higher";
      const aWins = wantHigher ? a >= b : a <= b;
      main[i] = aWins ? a : b;
      second[i] = aWins ? b : a;
    } else {
      main[i] = a;
      second[i] = 0;
    }
  }
  return { main, second };
}
