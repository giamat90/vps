import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../stores/player", () => ({ getMicAnalyser: vi.fn(), getEngine: vi.fn(), usePlayerStore: vi.fn() }));
vi.mock("../stores/exercise", () => ({ useExerciseStore: vi.fn() }));

import { computeTrackSpectrogram, TRACK_SPECTRO_ROWS } from "./exerciseSpectrogram";
import { buildFreqBinLut } from "../components/analysis/SpectrogramPanel";
import { SPECTRO_COLORMAP } from "./spectroUtils";

let lastImage: ImageData | null = null;
let canvasSize = { w: 0, h: 0 };

class FakeCanvas {
  constructor(public width: number, public height: number) { canvasSize = { w: width, h: height }; }
  getContext() {
    return {
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (img: ImageData) => { lastImage = img; },
    };
  }
}

function audioBuffer(samples: Float32Array, sampleRate: number) {
  return { sampleRate, getChannelData: () => samples } as unknown as AudioBuffer;
}

function tone(freq: number, sampleRate: number, seconds: number, amplitude = 1) {
  const x = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < x.length; i++) x[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return x;
}

const pixel = (img: ImageData, row: number, col: number) => {
  const p = (row * img.width + col) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2], img.data[p + 3]];
};

const BLACK = [SPECTRO_COLORMAP[0], SPECTRO_COLORMAP[1], SPECTRO_COLORMAP[2]];

beforeEach(() => {
  lastImage = null;
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
});

describe("computeTrackSpectrogram", () => {
  it("makes one column per 4096-sample hop and TRACK_SPECTRO_ROWS rows", async () => {
    const result = await computeTrackSpectrogram(audioBuffer(tone(1000, 44100, 2), 44100));
    expect(result.cols).toBe(Math.ceil(88200 / 4096));
    expect(result.rows).toBe(TRACK_SPECTRO_ROWS);
    expect(result.hopTime).toBeCloseTo(4096 / 44100, 12);
    expect(canvasSize).toEqual({ w: result.cols, h: TRACK_SPECTRO_ROWS });
  });

  it("makes at least one column for an empty buffer", async () => {
    const result = await computeTrackSpectrogram(audioBuffer(new Float32Array(0), 44100));
    expect(result.cols).toBe(1);
  });

  it("is fully opaque", async () => {
    await computeTrackSpectrogram(audioBuffer(tone(500, 44100, 0.5), 44100));
    const img = lastImage!;
    for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(255);
  });

  it("lights up the rows covering a 1 kHz tone and leaves distant rows dark", async () => {
    const sr = 44100;
    await computeTrackSpectrogram(audioBuffer(tone(1000, sr, 2), sr));
    const img = lastImage!;
    const { low, high } = buildFreqBinLut(TRACK_SPECTRO_ROWS, 8192, sr);
    const bin = Math.round(1000 / (sr / 8192));
    const col = 4;

    const hot = [...Array(TRACK_SPECTRO_ROWS).keys()].filter((r) => low[r] <= bin && bin <= high[r]);
    expect(hot.length).toBeGreaterThan(0);
    for (const r of hot) expect(pixel(img, r, col).slice(0, 3)).toEqual([255, 255, 255]);

    for (const r of [0, 1, TRACK_SPECTRO_ROWS - 1]) expect(pixel(img, r, col).slice(0, 3)).toEqual(BLACK);
  });

  it("renders silence as the colormap's black end", async () => {
    await computeTrackSpectrogram(audioBuffer(new Float32Array(20000), 44100));
    expect(pixel(lastImage!, 80, 2).slice(0, 3)).toEqual(BLACK);
  });

  it("raises a tone's row when the pitch rises (top row = high frequency)", async () => {
    const sr = 44100;
    const brightestRow = async (f: number) => {
      await computeTrackSpectrogram(audioBuffer(tone(f, sr, 1), sr));
      const img = lastImage!;
      let best = 0;
      let bestSum = -1;
      for (let r = 0; r < TRACK_SPECTRO_ROWS; r++) {
        const [R, G, B] = pixel(img, r, 3);
        if (R + G + B > bestSum) { bestSum = R + G + B; best = r; }
      }
      return best;
    };
    expect(await brightestRow(4000)).toBeLessThan(await brightestRow(400));
  });

  it("falls back to an HTMLCanvasElement when OffscreenCanvas is unavailable", async () => {
    vi.stubGlobal("OffscreenCanvas", class { constructor() { throw new Error("unsupported"); } });
    const canvas = { width: 0, height: 0, getContext: () => null };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
    const result = await computeTrackSpectrogram(audioBuffer(tone(440, 44100, 0.3), 44100));
    expect(result.canvas).toBe(canvas);
    expect(canvas.width).toBe(result.cols);
    expect(canvas.height).toBe(TRACK_SPECTRO_ROWS);
  });

  it("returns early with its geometry when no 2D context is available", async () => {
    vi.stubGlobal("OffscreenCanvas", class { width = 0; height = 0; getContext() { return null; } });
    const result = await computeTrackSpectrogram(audioBuffer(tone(440, 44100, 0.3), 44100));
    expect(result.cols).toBeGreaterThan(0);
    expect(lastImage).toBeNull();
  });
});
