import { describe, it, expect } from "vitest";
import { createRecordingContext } from "../test/fakeCanvas";
import {
  F0_COLOR,
  FORMANT_COLORS,
  buildSpectrumPoints,
  dbGridTicks,
  drawCurveFill,
  drawCurveSegments,
  drawDbGrid,
  drawDecadeGrid,
  drawEnvelope,
  drawLiveOverlay,
  drawVoiceMarkers,
  envelopeWithY,
  spectrumFreqToX,
  voiceMarkers,
} from "./spectroShortTerm";
import { AXIS_W } from "./spectrogramMath";
import type { SpectrumPoint } from "./spectroUtils";

const pts = (n: number, level = 0.5): SpectrumPoint[] =>
  Array.from({ length: n }, (_, i) => ({ x: AXIS_W + i, y: 100 * (1 - level), normalized: level }));

describe("dbGridTicks", () => {
  it("runs from the floor to the ceiling in 10 dB steps", () => {
    const ticks = dbGridTicks();
    expect(ticks[0]).toBe(-100);
    expect(ticks[ticks.length - 1]).toBe(0);
    expect(ticks).toContain(-50);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
  });
});

describe("spectrumFreqToX", () => {
  it("puts the top frequency at the right edge and the bottom one at the left", () => {
    expect(spectrumFreqToX(20000, 500, 20000)).toBeCloseTo(500, 6);
    expect(spectrumFreqToX(30, 500, 20000)).toBeCloseTo(0, 6);
  });
});

describe("buildSpectrumPoints / envelopeWithY", () => {
  const data = new Float32Array(1024).fill(-50);

  it("returns one point per pixel column with heights from the normalised level", () => {
    const points = buildSpectrumPoints(data, 44100, 200, 20000, 80);
    expect(points).toHaveLength(200);
    expect(points[0].x).toBe(AXIS_W);
    for (const p of points) expect(p.y).toBeCloseTo(80 * (1 - p.normalized), 9);
  });

  it("smooths into an envelope of the same width with matching heights", () => {
    const env = envelopeWithY(buildSpectrumPoints(data, 44100, 200, 20000, 80), 80);
    expect(env).toHaveLength(200);
    for (const p of env) expect(p.y).toBeCloseTo(80 * (1 - p.normalized), 9);
  });
});

describe("voiceMarkers", () => {
  const voice = { f0: 200, f1: 500, f2: 1500, f3: 40000 };

  it("makes a solid F0 marker and dashed formant markers, dropping those above the range", () => {
    const ms = voiceMarkers(200, voice, 20000, 500);
    expect(ms.map((m) => m.slot)).toEqual([0, 1, 2]);
    expect(ms[0]).toMatchObject({ color: F0_COLOR, dashed: false, label: "F0 200Hz G3" });
    expect(ms[1]).toMatchObject({ color: FORMANT_COLORS[0], dashed: true, label: "F1 500Hz" });
    expect(ms[2].color).toBe(FORMANT_COLORS[1]);
    expect(ms[0].x).toBeCloseTo(AXIS_W + spectrumFreqToX(200, 500, 20000), 9);
  });

  it("skips missing values and uses the stored F0 over the estimate", () => {
    const ms = voiceMarkers(null, { f0: 123, f1: null, f2: null, f3: null }, 20000, 500);
    expect(ms).toEqual([]);
    expect(voiceMarkers(220, { f0: 123, f1: null, f2: null, f3: null }, 20000, 500)[0].label).toContain("220Hz");
  });
});

describe("grid and curve drawing", () => {
  it("drawDbGrid labels every tick at the left axis, clamped inside the plot", () => {
    const { ctx, log } = createRecordingContext();
    drawDbGrid(ctx, 600, 180, 1);
    const labels = log.filter((l) => l.startsWith("fillText"));
    expect(labels.length).toBe(dbGridTicks().length);
    expect(labels[0]).toBe(`fillText("-100",${AXIS_W - 6},174)`);
    expect(labels[labels.length - 1]).toBe(`fillText("0",${AXIS_W - 6},6)`);
  });

  it("drawDecadeGrid skips decades above the plotted range", () => {
    const a = createRecordingContext();
    drawDecadeGrid(a.ctx, 500, 100, 20000, 1);
    expect(a.log.filter((l) => l.startsWith("fillText")).map((l) => l.match(/"(.*)"/)![1])).toEqual(["100", "1k", "10k"]);
    const b = createRecordingContext();
    drawDecadeGrid(b.ctx, 500, 100, 4000, 1);
    expect(b.log.filter((l) => l.startsWith("fillText"))).toHaveLength(2);
  });

  it("drawCurveSegments strokes one coloured segment between each pair of points", () => {
    const { ctx, log } = createRecordingContext();
    drawCurveSegments(ctx, pts(4), 2);
    expect(log.filter((l) => l === "stroke()")).toHaveLength(3);
    expect(log).toContain("lineWidth=3");
    expect(log.some((l) => /^strokeStyle="rgb\(\d+,\d+,\d+\)"$/.test(l))).toBe(true);
  });

  it("drawCurveFill builds an 11-stop gradient and closes the area; nothing for a single point", () => {
    const { ctx, log } = createRecordingContext();
    drawCurveFill(ctx, pts(3), 100);
    expect(log.filter((l) => l.startsWith("gradient.addColorStop"))).toHaveLength(11);
    expect(log).toContain("closePath()");
    expect(log).toContain("globalAlpha=0.35");
    const one = createRecordingContext();
    drawCurveFill(one.ctx, pts(1), 100);
    expect(one.log).toEqual([]);
  });

  it("drawEnvelope strokes a white line over the curve; nothing for a single point", () => {
    const { ctx, log } = createRecordingContext();
    drawEnvelope(ctx, pts(30), 100, 1);
    expect(log).toContain('strokeStyle="rgba(255,255,255,0.85)"');
    expect(log.filter((l) => l.startsWith("lineTo"))).toHaveLength(29);
    const one = createRecordingContext();
    drawEnvelope(one.ctx, pts(1), 100, 1);
    expect(one.log).toEqual([]);
  });
});

describe("drawVoiceMarkers", () => {
  it("draws a line and an outlined label per marker, stacking labels by slot", () => {
    const { ctx, log } = createRecordingContext();
    drawVoiceMarkers(ctx, voiceMarkers(200, { f0: null, f1: 500, f2: null, f3: null }, 20000, 500), 150, 1);
    expect(log.filter((l) => l.startsWith("strokeText"))).toHaveLength(2);
    expect(log.some((l) => l.startsWith('fillText("F0 200Hz G3"') && l.endsWith(",147)"))).toBe(true);
    expect(log.some((l) => l.startsWith('fillText("F1 500Hz"') && l.endsWith(",135)"))).toBe(true);
    expect(log).toContain("setLineDash([4,3])");
  });

  it("only sets the text style when there is nothing to draw", () => {
    const { ctx, log } = createRecordingContext();
    drawVoiceMarkers(ctx, [], 150, 1);
    expect(log).toEqual(['font="11px monospace"', 'textAlign="center"', 'textBaseline="bottom"']);
  });
});

describe("drawLiveOverlay", () => {
  it("fills and strokes the mic envelope and labels both inputs in the corner", () => {
    const { ctx, log } = createRecordingContext();
    drawLiveOverlay(ctx, pts(10), 600, 100, 1);
    expect(log[0]).toBe("save()");
    expect(log[log.length - 1]).toBe("restore()");
    expect(log).toContain('fillText("● mic",542,4)');
    expect(log).toContain('fillText("○ track",542,17)');
    expect(log).toContain('fillStyle="rgba(255,140,30,0.18)"');
  });
});
