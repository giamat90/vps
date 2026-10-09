import { describe, it, expect, vi, beforeEach } from "vitest";
import { PitchDetector } from "./pitchDetector";

const SR = 44100;
let signal: Float32Array;
let created: Array<{ closed: boolean; disconnected: boolean }>;

class FakeContext {
  sampleRate = SR;
  record = { closed: false, disconnected: false };
  constructor() { created.push(this.record); }
  resume() { return Promise.resolve(); }
  close() { this.record.closed = true; return Promise.resolve(); }
  createAnalyser() {
    return {
      fftSize: 0,
      getFloatTimeDomainData: (buf: Float32Array) => buf.set(signal.subarray(0, buf.length)),
    };
  }
  createMediaStreamSource() {
    const record = this.record;
    return { connect: vi.fn(), disconnect: () => { record.disconnected = true; } };
  }
}

function sine(freq: number, amplitude = 0.5, length = 2048, phase = 0) {
  const x = new Float32Array(length);
  for (let i = 0; i < length; i++) x[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return x;
}

function harmonic(f0: number, amplitude = 0.4, length = 2048) {
  const x = new Float32Array(length);
  for (const [k, a] of [[1, 1], [2, 0.6], [3, 0.4], [4, 0.2]] as const) {
    for (let i = 0; i < length; i++) x[i] += (amplitude * a * Math.sin((2 * Math.PI * f0 * k * i) / SR)) / 1.6;
  }
  return x;
}

function startDetector() {
  const d = new PitchDetector();
  d.start({} as MediaStream);
  return d;
}

beforeEach(() => {
  created = [];
  signal = new Float32Array(2048);
  vi.stubGlobal("AudioContext", FakeContext);
});

describe("PitchDetector", () => {
  it("returns null before start()", () => {
    expect(new PitchDetector().getCurrentPitch()).toBeNull();
  });

  it.each([110, 196, 261.63, 440, 659.25])("detects a %s Hz sine within 1%%", (f) => {
    const d = startDetector();
    signal = sine(f);
    const r = d.getCurrentPitch();
    expect(r).not.toBeNull();
    expect(Math.abs(r!.frequency - f) / f).toBeLessThan(0.01);
  });

  it("detects the fundamental of a harmonic-rich voice-like tone, not an overtone", () => {
    const d = startDetector();
    signal = harmonic(220);
    const r = d.getCurrentPitch();
    expect(r).not.toBeNull();
    expect(Math.abs(r!.frequency - 220) / 220).toBeLessThan(0.02);
  });

  it("names the note and cents offset", () => {
    const d = startDetector();
    signal = sine(440);
    const r = d.getCurrentPitch()!;
    expect(r.name).toBe("A4");
    expect(Math.abs(r.cents)).toBeLessThanOrEqual(5);

    signal = sine(440 * Math.pow(2, 30 / 1200));
    const sharp = d.getCurrentPitch()!;
    expect(sharp.name).toBe("A4");
    expect(sharp.cents).toBeGreaterThan(20);
    expect(sharp.cents).toBeLessThan(40);
  });

  it("returns null for silence and for a signal below the RMS floor", () => {
    const d = startDetector();
    signal = new Float32Array(2048);
    expect(d.getCurrentPitch()).toBeNull();
    signal = sine(220, 0.005);
    expect(d.getCurrentPitch()).toBeNull();
  });

  it("returns null for broadband noise (no clear periodicity)", () => {
    const d = startDetector();
    let s = 7;
    const noise = new Float32Array(2048);
    for (let i = 0; i < noise.length; i++) noise[i] = (((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1) * 0.5;
    signal = noise;
    expect(d.getCurrentPitch()).toBeNull();
  });

  it("rejects pitches outside 65–1400 Hz", () => {
    const d = startDetector();
    signal = sine(40);
    expect(d.getCurrentPitch()).toBeNull();
    signal = sine(2000);
    expect(d.getCurrentPitch()).toBeNull();
  });

  it("stop() releases the audio graph and disables further readings", () => {
    const d = startDetector();
    signal = sine(440);
    d.stop();
    expect(created[0]).toEqual({ closed: true, disconnected: true });
    expect(d.getCurrentPitch()).toBeNull();
  });

  it("start() twice tears the previous context down first", () => {
    const d = startDetector();
    d.start({} as MediaStream);
    expect(created).toHaveLength(2);
    expect(created[0].closed).toBe(true);
    expect(created[1].closed).toBe(false);
  });

  it("stop() without start() is harmless", () => {
    expect(() => new PitchDetector().stop()).not.toThrow();
  });
});
