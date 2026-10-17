import { describe, it, expect } from "vitest";
import {
  AXIS_W,
  CAPTURE_INTERVAL_MS,
  F_MAX,
  F_MIN,
  WINDOW_S,
  buildFreqBinLut,
  computeRowNorms,
  dbToCurvedNorm,
  formantTickYs,
  formatHz,
  freqAxisTicks,
  freqToY,
  gridLineYs,
  legendTicks,
  maxFrequency,
  nextScrollShift,
  staticWindowGeometry,
  writeColumnPixels,
} from "./spectrogramMath";

describe("dbToCurvedNorm", () => {
  it("is black at and below the -85 dB floor", () => {
    expect(dbToCurvedNorm(-85)).toBe(0);
    expect(dbToCurvedNorm(-200)).toBe(0);
    expect(dbToCurvedNorm(-Infinity)).toBe(0);
  });

  it("saturates at and above the -20 dB ceiling", () => {
    expect(dbToCurvedNorm(-20)).toBe(1);
    expect(dbToCurvedNorm(0)).toBe(1);
  });

  it("stays within [0, 1] and rises monotonically above the -80 dB gate", () => {
    let prev = -1;
    for (let db = -80; db <= 0; db += 0.5) {
      const v = dbToCurvedNorm(db);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("gates levels below the 15 % knee harder than a plain gamma curve would", () => {
    const db = -85 + 0.1 * 65;
    expect(dbToCurvedNorm(db)).toBeLessThan(Math.pow(0.1, 0.38));
  });

  it("applies a gamma below 1 so mid-level peaks stay bright", () => {
    expect(dbToCurvedNorm(-52.5)).toBeGreaterThan(0.5);
  });
});

describe("freqToY", () => {
  it("puts the top frequency at y = 0 and F_MIN at the bottom", () => {
    expect(freqToY(F_MAX, 400, F_MAX)).toBeCloseTo(0, 9);
    expect(freqToY(F_MIN, 400, F_MAX)).toBeCloseTo(400, 9);
  });

  it("is centred on the geometric mean", () => {
    expect(freqToY(Math.sqrt(F_MIN * F_MAX), 400, F_MAX)).toBeCloseTo(200, 6);
  });

  it("decreases as frequency rises", () => {
    expect(freqToY(100, 400, F_MAX)).toBeGreaterThan(freqToY(1000, 400, F_MAX));
  });
});

describe("buildFreqBinLut", () => {
  const H = 160;
  const fft = 8192;
  const sr = 44100;
  const { low, high } = buildFreqBinLut(H, fft, sr);

  it("returns one inclusive bin range per row", () => {
    expect(low).toHaveLength(H);
    expect(high).toHaveLength(H);
  });

  it("never produces an inverted range or one past the last FFT bin", () => {
    for (let r = 0; r < H; r++) {
      expect(low[r]).toBeLessThanOrEqual(high[r]);
      expect(high[r]).toBeLessThanOrEqual(fft / 2 - 1);
    }
  });

  it("maps row 0 (top) to the highest frequencies and the last row to the lowest", () => {
    expect(low[0]).toBeGreaterThan(low[H - 1]);
    expect(low[H - 1] * (sr / fft)).toBeLessThan(40);
  });

  it("is non-increasing from top to bottom", () => {
    for (let r = 1; r < H; r++) expect(low[r]).toBeLessThanOrEqual(low[r - 1]);
  });

  it("caps the top at Nyquist for low sample rates", () => {
    const lut = buildFreqBinLut(64, 4096, 16000);
    expect(lut.high[0] * (16000 / 4096)).toBeLessThanOrEqual(8000 + 16000 / 4096);
  });

  it("some row covers the FFT bin of 1 kHz", () => {
    const bin = Math.round(1000 / (sr / fft));
    const rows = [...Array(H).keys()].filter((r) => low[r] <= bin && bin <= high[r]);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("formatHz / maxFrequency", () => {
  it("abbreviates kilohertz", () => {
    expect(formatHz(500)).toBe("500");
    expect(formatHz(1000)).toBe("1k");
    expect(formatHz(2500)).toBe("2.5k");
  });

  it("caps the plotted range at F_MAX and at Nyquist", () => {
    expect(maxFrequency(96000)).toBe(F_MAX);
    expect(maxFrequency(8000)).toBe(4000);
  });
});

describe("computeRowNorms", () => {
  it("takes the loudest bin under each row and maps it through the colour curve", () => {
    const data = [-120, -30, -90, -20];
    const out = new Float32Array(2);
    computeRowNorms(data, [0, 2], [1, 3], 2, out);
    expect(out[0]).toBeCloseTo(dbToCurvedNorm(-30), 6);
    expect(out[1]).toBeCloseTo(dbToCurvedNorm(-20), 6);
  });

  it("turns an all-silent range into black", () => {
    const out = new Float32Array(1);
    computeRowNorms([-Infinity, -Infinity], [0], [1], 1, out);
    expect(out[0]).toBe(0);
  });
});

describe("writeColumnPixels", () => {
  const colormap = new Uint8Array(256 * 3).map((_, i) => i % 256);

  it("writes `shift` identical opaque columns, one colour per row", () => {
    const px = writeColumnPixels([0, 1], 2, 3, colormap);
    expect(px).toHaveLength(2 * 3 * 4);
    expect([...px.slice(0, 4)]).toEqual([0, 1, 2, 255]);
    expect([...px.slice(8, 12)]).toEqual([0, 1, 2, 255]);
    const ci = 255;
    expect([...px.slice(12, 16)]).toEqual([colormap[ci * 3], colormap[ci * 3 + 1], colormap[ci * 3 + 2], 255]);
  });

  it("clamps levels above 1 to the last colour", () => {
    const px = writeColumnPixels([5], 1, 1, colormap);
    expect(px[0]).toBe(colormap[255 * 3]);
  });
});

describe("nextScrollShift", () => {
  it("scrolls at least one column and carries the shortfall as a negative remainder", () => {
    const first = nextScrollShift(0, 100);
    expect(first.shift).toBe(1);
    expect(first.accum).toBeCloseTo(0.33 - 1, 9);
    expect(nextScrollShift(first.accum, 100).shift).toBe(1);
  });

  it("covers the whole roll in WINDOW_S seconds of captures", () => {
    const rollW = 1000;
    let accum = 0;
    let total = 0;
    const frames = Math.round((WINDOW_S * 1000) / CAPTURE_INTERVAL_MS);
    for (let i = 0; i < frames; i++) {
      const n = nextScrollShift(accum, rollW);
      accum = n.accum;
      total += n.shift;
    }
    expect(total).toBeGreaterThanOrEqual(rollW - 1);
    expect(total).toBeLessThanOrEqual(rollW + frames);
  });

  it("consumes several columns on a wide roll", () => {
    expect(nextScrollShift(0, 10000).shift).toBe(33);
  });
});

describe("staticWindowGeometry", () => {
  it("centres the playhead and spans WINDOW_S seconds of columns", () => {
    const g = staticWindowGeometry(20, 0.01, 10000, 1000)!;
    expect(g.srcColStart).toBeCloseTo(1500, 6);
    expect(g.srcColEnd).toBeCloseTo(2500, 6);
    expect(g.destX).toBeCloseTo(AXIS_W, 6);
    expect(g.destW).toBeCloseTo(1000, 6);
  });

  it("starts the picture part-way across the roll before the track begins", () => {
    const g = staticWindowGeometry(1, 0.01, 10000, 1000)!;
    expect(g.srcColStart).toBe(0);
    expect(g.destX).toBeCloseTo(AXIS_W + 400, 6);
    expect(g.destW).toBeCloseTo(600, 6);
  });

  it("clips at the last column", () => {
    const g = staticWindowGeometry(9, 0.01, 1000, 1000)!;
    expect(g.srcColEnd).toBe(1000);
    expect(g.destW).toBeCloseTo(600, 6);
  });

  it("is null when the playhead is outside the track", () => {
    expect(staticWindowGeometry(-20, 0.01, 1000, 1000)).toBeNull();
    expect(staticWindowGeometry(400, 0.01, 1000, 1000)).toBeNull();
  });
});

describe("formantTickYs", () => {
  it("skips missing formants and rows outside the picture", () => {
    const ys = formantTickYs({ f1: 500, f2: null, f3: 99999 }, 400, 44100);
    expect(ys).toHaveLength(1);
    expect(ys[0]).toBeCloseTo(freqToY(500, 400, maxFrequency(44100)), 9);
  });

  it("returns nothing when no formant was found", () => {
    expect(formantTickYs({ f1: null, f2: null, f3: null }, 400, 44100)).toEqual([]);
  });
});

describe("freqAxisTicks / gridLineYs / legendTicks", () => {
  it("labels 20k separately and keeps ticks away from the edges", () => {
    const ticks = freqAxisTicks(400, F_MAX);
    expect(ticks.some((t) => t.f === 20000)).toBe(false);
    for (const t of ticks) {
      expect(t.y).toBeGreaterThanOrEqual(4);
      expect(t.y).toBeLessThanOrEqual(396);
    }
    expect(ticks.filter((t) => t.anchor).map((t) => t.f)).toEqual([1000, 5000]);
  });

  it("drops ticks above Nyquist", () => {
    expect(freqAxisTicks(400, 4000).every((t) => t.f <= 4000)).toBe(true);
    expect(gridLineYs(400, 4000)).toHaveLength(3);
    expect(gridLineYs(400, F_MAX)).toHaveLength(5);
  });

  it("puts the loudest legend tick at the top of the bar and flags both ends as edges", () => {
    const ticks = legendTicks(10, 100);
    expect(ticks[0]).toEqual({ db: -20, y: 10, isEdge: true });
    expect(ticks[ticks.length - 1].y).toBeCloseTo(110, 9);
    expect(ticks.filter((t) => t.isEdge)).toHaveLength(2);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].y).toBeGreaterThan(ticks[i - 1].y);
  });
});
