import { describe, it, expect, vi } from "vitest";

import {
  MIDI_MAX,
  MIDI_MIN,
  N_NOTES,
  N_SPECTRO_ROWS,
  SPECTRO_COLORMAP,
  buildSpectroCanvas,
  decodeSTSpectrumFrames,
  quantizeFftToRows,
  stitchAboveNyquist,
  xToFreq,
} from "./spectroUtils";

describe("constants", () => {
  it("covers A2–C6 in 40 notes", () => {
    expect(MIDI_MIN).toBe(45);
    expect(MIDI_MAX).toBe(84);
    expect(N_NOTES).toBe(40);
    expect(N_SPECTRO_ROWS).toBe(160);
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

describe("stitchAboveNyquist", () => {
  const W = 1000;
  const flat = (normalized: number) => Array.from({ length: W }, (_, px) => ({ x: px, y: 0, normalized }));

  it("keeps the measured curve below 0.9 x Nyquist and takes the stored one above", () => {
    const out = stitchAboveNyquist(flat(0.2), flat(0.8), 8000, W, 30, 20000);
    const cut = out.findIndex((p) => p.normalized === 0.8);
    expect(cut).toBeGreaterThan(0);
    expect(out.slice(0, cut).every((p) => p.normalized === 0.2)).toBe(true);
    expect(out.slice(cut).every((p) => p.normalized === 0.8)).toBe(true);
    expect(xToFreq(cut, W, 30, 20000)).toBeGreaterThanOrEqual(3600);
    expect(xToFreq(cut - 1, W, 30, 20000)).toBeLessThan(3600);
  });

  it("leaves the part above the band empty when there is no stored frame", () => {
    const out = stitchAboveNyquist(flat(0.5), null, 8000, W, 30, 20000);
    expect(out[W - 1].normalized).toBe(0);
    expect(out[0].normalized).toBe(0.5);
  });

  it("returns the measured curve untouched when its band reaches the top of the axis", () => {
    const measured = flat(0.3);
    expect(stitchAboveNyquist(measured, flat(0.9), 48000, W, 30, 20000)).toBe(measured);
  });
});
