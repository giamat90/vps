import { describe, it, expect, vi } from "vitest";

import {
  MIDI_MAX,
  MIDI_MIN,
  N_NOTES,
  N_SPECTRO_ROWS,
  SPECTRO_COLORMAP,
  SPECTRUM_MAX_DB,
  SPECTRUM_MIN_DB,
  WEBAUDIO_TO_DBFS,
  analyserCurvePoints,
  buildSpectroCanvas,
  decodeSTSpectrumFrames,
  freqToX,
  quantizeFftToRows,
  smoothSpectrumEnvelope,
  smoothSpectrumLight,
  xToFreq,
  type SpectrumPoint,
} from "./spectroUtils";
import { computeMagnitudeSpectrumDb } from "./fft";

const pt = (x: number, normalized: number): SpectrumPoint => ({ x, y: 0, normalized });

describe("constants", () => {
  it("covers A2–C6 in 40 notes", () => {
    expect(MIDI_MIN).toBe(45);
    expect(MIDI_MAX).toBe(84);
    expect(N_NOTES).toBe(40);
    expect(N_SPECTRO_ROWS).toBe(160);
  });

  it("derives the Web Audio -> dBFS lift from the Blackman coherent gain", () => {
    expect(WEBAUDIO_TO_DBFS).toBeCloseTo(13.56, 2);
  });

  it("keeps the display span at the sidecar's stored -100..0 dBFS", () => {
    expect(SPECTRUM_MIN_DB).toBe(-100);
    expect(SPECTRUM_MAX_DB).toBe(0);
  });
});

describe("SPECTRO_COLORMAP", () => {
  const rgb = (i: number) => [SPECTRO_COLORMAP[i * 3], SPECTRO_COLORMAP[i * 3 + 1], SPECTRO_COLORMAP[i * 3 + 2]];

  it("has 256 RGB entries", () => expect(SPECTRO_COLORMAP).toHaveLength(256 * 3));
  it("starts near-black blue and ends white", () => {
    expect(rgb(0)).toEqual([0, 0, 16]);
    expect(rgb(255)).toEqual([255, 255, 255]);
  });
  it("hits the control points exactly", () => {
    expect(rgb(51)).toEqual([10, 10, 110]);
    expect(rgb(102)).toEqual([0, 112, 255]);
  });
  it("leaves no uninitialised (all-zero) entries past the first stop", () => {
    for (let i = 1; i < 256; i++) expect(rgb(i).some((v) => v !== 0)).toBe(true);
  });
  it("interpolates linearly between stops", () => {
    const a = rgb(51);
    const b = rgb(102);
    const mid = rgb(77);
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(mid[c] - (a[c] + b[c]) / 2)).toBeLessThanOrEqual(2);
    }
  });
});

describe("freqToX / xToFreq", () => {
  const w = 1000;
  const fMin = 50;
  const fMax = 8000;

  it("maps fMin to the left edge and fMax to the right", () => {
    expect(freqToX(fMin, w, fMin, fMax)).toBeCloseTo(0, 9);
    expect(freqToX(fMax, w, fMin, fMax)).toBeCloseTo(w, 9);
  });

  it("is monotonically increasing", () => {
    let prev = -Infinity;
    for (let f = fMin; f <= fMax; f *= 1.1) {
      const x = freqToX(f, w, fMin, fMax);
      expect(x).toBeGreaterThan(prev);
      prev = x;
    }
  });

  it("places the geometric mean at the centre (log axis)", () => {
    expect(freqToX(Math.sqrt(fMin * fMax), w, fMin, fMax)).toBeCloseTo(w / 2, 6);
  });

  it("round-trips", () => {
    for (const f of [60, 123, 440, 1000, 5000]) {
      expect(xToFreq(freqToX(f, w, fMin, fMax), w, fMin, fMax)).toBeCloseTo(f, 6);
    }
  });
});

describe("decodeSTSpectrumFrames", () => {
  it("decodes base64 to bytes", () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
    const b64 = btoa(String.fromCharCode(...bytes));
    expect(Array.from(decodeSTSpectrumFrames(b64))).toEqual(Array.from(bytes));
  });

  it("returns an empty array for an empty string", () => {
    expect(decodeSTSpectrumFrames("")).toHaveLength(0);
  });

  it("throws on invalid base64 (callers must handle it)", () => {
    expect(() => decodeSTSpectrumFrames("***not base64***")).toThrow();
  });
});

describe("quantizeFftToRows", () => {
  const sr = 44100;
  const bins = 1024;

  it("returns N_SPECTRO_ROWS rows", () => {
    expect(quantizeFftToRows(new Uint8Array(bins), sr)).toHaveLength(N_SPECTRO_ROWS);
  });

  it("is all zero for a silent spectrum", () => {
    expect(Array.from(quantizeFftToRows(new Uint8Array(bins), sr)).every((v) => v === 0)).toBe(true);
  });

  it("lights up only the row of a single tone, with row 0 as the highest pitch", () => {
    const binHz = sr / (bins * 2);
    const data = new Uint8Array(bins);
    data[Math.round(440 / binHz)] = 255;
    const rows = quantizeFftToRows(data, sr);
    const lit = Array.from(rows).map((v, i) => [v, i]).filter(([v]) => v > 0).map(([, i]) => i);
    expect(lit.length).toBeGreaterThan(0);
    const midi = (row: number) => MIDI_MAX - (row / (N_SPECTRO_ROWS - 1)) * (MIDI_MAX - MIDI_MIN);
    for (const row of lit) expect(Math.abs(midi(row) - 69)).toBeLessThan(2);
  });

  it("averages bins that fall into one row rather than summing them", () => {
    const data = new Uint8Array(bins).fill(200);
    const rows = quantizeFftToRows(data, sr);
    expect(Math.max(...rows)).toBe(200);
  });
});

describe("analyserCurvePoints", () => {
  const sr = 44100;
  const bins = 4096;
  const rollW = 400;
  const fMin = 50;
  const fMax = 8000;
  const axisW = 36;

  it("emits one point per pixel column, offset by the axis width", () => {
    const pts = analyserCurvePoints(new Float32Array(bins).fill(-60), sr, rollW, fMin, fMax, axisW);
    expect(pts).toHaveLength(rollW);
    expect(pts[0].x).toBe(axisW);
    expect(pts[rollW - 1].x).toBe(axisW + rollW - 1);
  });

  it("lifts Web Audio levels onto the dBFS scale before normalising", () => {
    const pts = analyserCurvePoints(new Float32Array(bins).fill(-60), sr, rollW, fMin, fMax, axisW);
    const expected = (-60 + WEBAUDIO_TO_DBFS - SPECTRUM_MIN_DB) / (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB);
    expect(pts[200].normalized).toBeCloseTo(expected, 9);
  });

  it("clamps normalized values to [0, 1]", () => {
    const loud = analyserCurvePoints(new Float32Array(bins).fill(10), sr, rollW, fMin, fMax, axisW);
    expect(loud.every((p) => p.normalized === 1)).toBe(true);
    const quiet = analyserCurvePoints(new Float32Array(bins).fill(-500), sr, rollW, fMin, fMax, axisW);
    expect(quiet.every((p) => p.normalized === 0)).toBe(true);
  });

  it("takes the max over bins under a column, so a narrow peak survives at the high end", () => {
    const data = new Float32Array(bins).fill(-100);
    const binHz = sr / (bins * 2);
    data[Math.round(6000 / binHz)] = -20;
    const pts = analyserCurvePoints(data, sr, rollW, fMin, fMax, axisW);
    const col = Math.round(freqToX(6000, rollW, fMin, fMax));
    const best = Math.max(...pts.slice(col - 2, col + 3).map((p) => p.normalized));
    expect(best).toBeGreaterThan(pts[0].normalized + 0.5);
  });

  it("falls back to the nearest bin where a column holds no FFT bin (no picket fence)", () => {
    const smallBins = 512;
    const data = new Float32Array(smallBins).fill(-40);
    const pts = analyserCurvePoints(data, sr, 2000, 30, 20000, 0);
    expect(pts.every((p) => Number.isFinite(p.normalized))).toBe(true);
    const expected = (-40 + WEBAUDIO_TO_DBFS - SPECTRUM_MIN_DB) / 100;
    expect(pts.every((p) => Math.abs(p.normalized - expected) < 1e-9)).toBe(true);
  });

  it("agrees with computeMagnitudeSpectrumDb on the tone frequency", () => {
    const size = 8192;
    const x = new Float32Array(size);
    for (let i = 0; i < size; i++) x[i] = Math.sin((2 * Math.PI * 1000 * i) / sr);
    const spectrum = computeMagnitudeSpectrumDb(x, size);
    const pts = analyserCurvePoints(spectrum, sr, 1000, 30, 20000, 0);
    let best = 0;
    pts.forEach((p, i) => { if (p.normalized > pts[best].normalized) best = i; });
    expect(Math.abs(xToFreq(best, 1000, 30, 20000) - 1000)).toBeLessThan(60);
    expect(pts[best].normalized).toBeGreaterThan(0.95);
  });
});

describe("smoothSpectrumLight", () => {
  it("preserves length and x, and zeroes y", () => {
    const input = [pt(10, 0), pt(11, 1), pt(12, 0)];
    const out = smoothSpectrumLight(input);
    expect(out.map((p) => p.x)).toEqual([10, 11, 12]);
    expect(out.every((p) => p.y === 0)).toBe(true);
  });

  it("averages inside a ±window, shrinking at the edges", () => {
    const input = [pt(0, 0), pt(1, 0), pt(2, 1), pt(3, 0), pt(4, 0)];
    const out = smoothSpectrumLight(input, 1);
    expect(out.map((p) => p.normalized)).toEqual([0, 1 / 3, 1 / 3, 1 / 3, 0]);
  });

  it("is the identity for a constant series", () => {
    const input = Array.from({ length: 20 }, (_, i) => pt(i, 0.42));
    expect(smoothSpectrumLight(input).every((p) => Math.abs(p.normalized - 0.42) < 1e-12)).toBe(true);
  });

  it("returns an empty array for empty input", () => expect(smoothSpectrumLight([])).toEqual([]));

  it("does not mutate its input", () => {
    const input = [pt(0, 0), pt(1, 1), pt(2, 0)];
    const snapshot = JSON.stringify(input);
    smoothSpectrumLight(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("smoothSpectrumEnvelope", () => {
  it("smooths more aggressively than the light filter", () => {
    const input = Array.from({ length: 200 }, (_, i) => pt(i, i % 2 === 0 ? 1 : 0));
    const spread = (pts: SpectrumPoint[]) => Math.max(...pts.slice(60, 140).map((p) => p.normalized)) - Math.min(...pts.slice(60, 140).map((p) => p.normalized));
    expect(spread(smoothSpectrumEnvelope(input))).toBeLessThan(spread(smoothSpectrumLight(input)));
  });

  it("widens its window with frequency (right side smoother than left)", () => {
    const input = Array.from({ length: 400 }, (_, i) => pt(i, (i * 7919) % 13 < 6 ? 1 : 0));
    const out = smoothSpectrumEnvelope(input);
    const sd = (s: SpectrumPoint[]) => {
      const m = s.reduce((a, p) => a + p.normalized, 0) / s.length;
      return Math.sqrt(s.reduce((a, p) => a + (p.normalized - m) ** 2, 0) / s.length);
    };
    expect(sd(out.slice(300, 380))).toBeLessThanOrEqual(sd(out.slice(20, 100)));
  });

  it("keeps values within the input range and preserves length", () => {
    const input = Array.from({ length: 50 }, (_, i) => pt(i, Math.abs(Math.sin(i))));
    const out = smoothSpectrumEnvelope(input);
    expect(out).toHaveLength(50);
    for (const p of out) {
      expect(p.normalized).toBeGreaterThanOrEqual(0);
      expect(p.normalized).toBeLessThanOrEqual(1);
    }
  });

  it("returns an empty array for empty input", () => expect(smoothSpectrumEnvelope([])).toEqual([]));
});

describe("buildSpectroCanvas", () => {
  class FakeCanvas {
    image: { width: number; height: number; data: Uint8ClampedArray } | null = null;
    constructor(public width: number, public height: number) {}
    getContext() {
      return {
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (img: FakeCanvas["image"]) => { this.image = img; },
      };
    }
  }

  const build = (bytes: number[], frames: number, rows: number) => {
    vi.stubGlobal("OffscreenCanvas", FakeCanvas);
    return buildSpectroCanvas(btoa(String.fromCharCode(...bytes)), frames, rows) as unknown as FakeCanvas;
  };

  it("makes a frames x rows canvas", () => {
    const c = build([0, 0, 0, 0, 0, 0], 2, 3);
    expect([c.width, c.height]).toEqual([2, 3]);
  });

  it("maps each byte through the colormap, with the data stored column-major (frame, then row)", () => {
    const c = build([0, 255, 128, 64], 2, 2);
    const px = (row: number, col: number) => {
      const p = (row * 2 + col) * 4;
      return Array.from(c.image!.data.slice(p, p + 4));
    };
    const lut = (v: number) => [SPECTRO_COLORMAP[v * 3], SPECTRO_COLORMAP[v * 3 + 1], SPECTRO_COLORMAP[v * 3 + 2], 255];
    expect(px(0, 0)).toEqual(lut(0));
    expect(px(1, 0)).toEqual(lut(255));
    expect(px(0, 1)).toEqual(lut(128));
    expect(px(1, 1)).toEqual(lut(64));
  });
});
