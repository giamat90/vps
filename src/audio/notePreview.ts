import { midiToFrequency } from "../lib/constants";

const PREVIEW_ATTACK_S = 0.012;
const PREVIEW_RELEASE_S = 0.12;
const PREVIEW_PEAK_GAIN = 0.22;
// Guards against a lost mouseup/mouseleave (e.g. focus lost mid-drag) leaving
// a voice sustaining indefinitely.
const PREVIEW_SAFETY_MAX_S = 6;

let ctx: AudioContext | null = null;
let ctxSinkId: string | null = null;

function getContext(sinkId: string | null): AudioContext | null {
  if (ctx && ctxSinkId === sinkId) {
    if (ctx.state === "suspended") {
      ctx.resume().catch((e) => console.warn("notePreview: failed to resume AudioContext", e));
    }
    return ctx;
  }
  if (ctx) {
    ctx.close().catch((e) => console.warn("notePreview: failed to close stale AudioContext", e));
  }
  try {
    ctx = new AudioContext(sinkId ? ({ sinkId } as AudioContextOptions) : undefined);
    ctxSinkId = sinkId;
  } catch (e) {
    console.warn("notePreview: failed to construct AudioContext for sinkId, falling back to default output", e);
    try {
      ctx = new AudioContext();
      ctxSinkId = null;
    } catch (e2) {
      console.warn("notePreview: failed to construct fallback AudioContext", e2);
      ctx = null;
      ctxSinkId = null;
    }
  }
  return ctx;
}

export interface PreviewVoice {
  release(): void;
}

// Starts a sustained tone at `midi` that holds until release() is called —
// press-and-hold-a-piano-key semantics, not a fixed-length beep.
export function startPreviewNote(midi: number, sinkId: string | null): PreviewVoice | null {
  const context = getContext(sinkId);
  if (!context) return null;

  const t = context.currentTime;
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = "triangle";
  osc.frequency.value = midiToFrequency(midi);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(PREVIEW_PEAK_GAIN, t + PREVIEW_ATTACK_S);
  osc.connect(gain);
  gain.connect(context.destination);
  osc.start(t);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    window.clearTimeout(safetyTimer);
    const relT = context.currentTime;
    gain.gain.cancelScheduledValues(relT);
    gain.gain.setValueAtTime(gain.gain.value, relT);
    gain.gain.exponentialRampToValueAtTime(0.0001, relT + PREVIEW_RELEASE_S);
    osc.stop(relT + PREVIEW_RELEASE_S + 0.02);
  };

  const safetyTimer = window.setTimeout(release, PREVIEW_SAFETY_MAX_S * 1000);

  return { release };
}
