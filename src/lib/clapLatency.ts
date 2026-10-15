// Click-clap latency measurement used by the recording-offset wizard, kept free
// of the DOM so it can be tested on plain samples. The clicks are scheduled
// relative to the start of the recording, so the measured offset is the whole
// loop: output delay, the air, input delay and the clapper's own timing.

export const N_COUNTIN = 4;
export const N_MEASURED = 8;
export const INTERVAL_S = 1.0;
export const FIRST_CLICK_S = 0.5; // gap before first click once recording starts

// Confidence classification of the clap-spread MAD (median absolute deviation).
export const MAD_HIGH_CONFIDENCE_MS = 5;
export const MAD_MEDIUM_CONFIDENCE_MS = 15;
// Sanity bounds — a measurement outside these is a detection failure, not a latency.
export const MIN_DETECTED_CLAPS = 5;
export const MAX_OFFSET_MS = 500; // matches the manual input's range

export type Confidence = "high" | "medium" | "low";

export function confidenceOf(madMs: number): Confidence {
  if (madMs <= MAD_HIGH_CONFIDENCE_MS) return "high";
  if (madMs <= MAD_MEDIUM_CONFIDENCE_MS) return "medium";
  return "low";
}

export interface ClapDetection {
  medianMs: number;
  madMs: number;
  detectedCount: number;
  offsets: number[]; // raw per-clap offsets, kept for rejection diagnostics
}

// Returns the measured round-trip latency plus its spread and detection count,
// or null when the samples contain no usable signal. Range/count validation
// happens at the caller so rejections can surface diagnostics.
//
// Frames are timed from their sample index, never by counting them as "1 ms":
// at 44.1 kHz a hop of 44 samples is 0.9977 ms, which stretched a 12 s
// recording by up to 27 ms. An onset is stamped at the END of the frame that
// first crosses the threshold, because that frame has just started to contain
// it (stamping its start read about one frame early).
export function detectClapLatency(samples: Float32Array, sampleRate: number): ClapDetection | null {
  // 1 ms hop, 5 ms RMS frame
  const hop = Math.max(1, Math.round(sampleRate / 1000));
  const frame = hop * 5;
  const numFrames = Math.ceil(samples.length / hop);
  if (numFrames === 0) return null;
  const msAt = (frameIndex: number) => ((frameIndex * hop + frame) * 1000) / sampleRate;

  const env = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    const s = i * hop;
    const e = Math.min(s + frame, samples.length);
    let sum = 0;
    for (let j = s; j < e; j++) sum += samples[j] * samples[j];
    env[i] = Math.sqrt(sum / (e - s));
  }

  let maxVal = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > maxVal) maxVal = env[i];
  if (maxVal < 0.005) return null;
  const threshold = maxVal * 0.15;

  // Onset (rising-edge) detection — first frame crossing above threshold,
  // minimum 300 ms between onsets. A strict local-maximum test misses
  // low-frequency/slow-attack sources (e.g. bass) whose RMS envelope plateaus
  // near its peak instead of spiking like a clap.
  const peaks: number[] = [];
  let above = false;
  for (let i = 0; i < env.length; i++) {
    if (env[i] > threshold) {
      const at = msAt(i);
      if (!above && (peaks.length === 0 || at - peaks[peaks.length - 1] > 300)) {
        peaks.push(at);
      }
      above = true;
    } else {
      above = false;
    }
  }

  // Expected click positions in the recording (ms): first click at FIRST_CLICK_S,
  // then after N_COUNTIN count-in beats, N_MEASURED beats are the measurement targets.
  const offsets: number[] = [];
  for (let i = 0; i < N_MEASURED; i++) {
    const expectedMs = Math.round((FIRST_CLICK_S + (N_COUNTIN + i) * INTERVAL_S) * 1000);
    // Search window: -100 ms to +500 ms around expected position
    const candidates = peaks.filter((p) => p >= expectedMs - 100 && p <= expectedMs + 500);
    if (candidates.length === 0) continue;
    const closest = candidates.reduce((a, b) =>
      Math.abs(a - expectedMs) < Math.abs(b - expectedMs) ? a : b,
    );
    offsets.push(Math.round(closest - expectedMs));
  }

  if (offsets.length === 0) return null;
  const sorted = [...offsets].sort((a, b) => a - b);
  const medianMs = sorted[Math.floor(sorted.length / 2)];
  const deviations = sorted.map((o) => Math.abs(o - medianMs)).sort((a, b) => a - b);
  const madMs = deviations[Math.floor(deviations.length / 2)];
  return { medianMs, madMs, detectedCount: offsets.length, offsets };
}
