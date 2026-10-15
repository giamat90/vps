import { describe, it, expect } from "vitest";
import {
  FIRST_CLICK_S,
  INTERVAL_S,
  MAX_OFFSET_MS,
  N_COUNTIN,
  N_MEASURED,
  confidenceOf,
  detectClapLatency,
} from "./clapLatency";

const RECORDING_S = FIRST_CLICK_S + (N_COUNTIN + N_MEASURED - 1) * INTERVAL_S + 1.5;

function claps(
  delaysMs: Array<number | null>,
  { sampleRate = 44100, amplitude = 0.6, noise = 0 }: { sampleRate?: number; amplitude?: number; noise?: number } = {},
) {
  const x = new Float32Array(Math.round(RECORDING_S * sampleRate));
  let s = 11;
  for (let i = 0; i < x.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    x[i] = noise * ((s / 4294967296) * 2 - 1);
  }
  delaysMs.forEach((delay, k) => {
    if (delay === null) return;
    const at = Math.round((((FIRST_CLICK_S + (N_COUNTIN + k) * INTERVAL_S) * 1000 + delay) * sampleRate) / 1000);
    for (let i = 0; i < 400 && at + i < x.length; i++) x[at + i] += amplitude * Math.exp(-i / 80) * Math.sin(i * 0.9);
  });
  return x;
}

describe("detectClapLatency", () => {
  it.each([44100, 48000, 16000, 96000])("recovers a steady 180 ms latency within 2 ms at %i Hz", (sr) => {
    const d = detectClapLatency(claps(Array(N_MEASURED).fill(180), { sampleRate: sr }), sr);
    expect(d).not.toBeNull();
    expect(d!.detectedCount).toBe(N_MEASURED);
    expect(Math.abs(d!.medianMs - 180)).toBeLessThanOrEqual(2);
    expect(d!.madMs).toBeLessThanOrEqual(2);
  });

  it("does not drift with the position of the clap at 44.1 kHz (the hop is 44 samples, not 1 ms)", () => {
    const d = detectClapLatency(claps(Array(N_MEASURED).fill(200)), 44100)!;
    const spread = Math.max(...d.offsets) - Math.min(...d.offsets);
    expect(spread).toBeLessThanOrEqual(2);
  });

  it("reports a wider spread as lower confidence", () => {
    const d = detectClapLatency(claps([150, 190, 140, 200, 160, 185, 145, 195]), 44100)!;
    expect(confidenceOf(d.madMs)).not.toBe("high");
  });

  it("copes with room noise", () => {
    const d = detectClapLatency(claps(Array(N_MEASURED).fill(200), { noise: 0.01 }), 44100);
    expect(d).not.toBeNull();
    expect(Math.abs(d!.medianMs - 200)).toBeLessThanOrEqual(3);
  });

  it("returns null for silence, a signal under the floor, and no samples", () => {
    expect(detectClapLatency(new Float32Array(44100 * 13), 44100)).toBeNull();
    expect(detectClapLatency(claps(Array(N_MEASURED).fill(100), { amplitude: 0.001 }), 44100)).toBeNull();
    expect(detectClapLatency(new Float32Array(0), 44100)).toBeNull();
  });

  it("counts only the claps it found", () => {
    const d = detectClapLatency(claps([150, 150, 150, 150, null, null, null, null]), 44100)!;
    expect(d.detectedCount).toBe(4);
  });

  it("confidence bands: <=5 ms high, <=15 ms medium, else low", () => {
    expect(confidenceOf(5)).toBe("high");
    expect(confidenceOf(6)).toBe("medium");
    expect(confidenceOf(15)).toBe("medium");
    expect(confidenceOf(16)).toBe("low");
    expect(MAX_OFFSET_MS).toBe(500);
  });
});
