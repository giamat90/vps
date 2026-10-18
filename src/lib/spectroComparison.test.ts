import { describe, it, expect } from "vitest";
import { createRecordingContext } from "../test/fakeCanvas";
import {
  FORMANT_CACHE_STEP_S,
  comparisonMarkers,
  drawCenteredNote,
  drawComparisonFrame,
  drawComparisonMarkers,
  markerLabelY,
  nearestFrame,
  storedCurvePoints,
  strokePoints,
  trackCurvePoints,
  type ComparisonFrame,
  type ComparisonSource,
  type MeasuredSpectrum,
  type StoredSpectrum,
} from "./spectroComparison";
import { AXIS_W, F_MAX } from "./spectrogramMath";
import type { SpectrumPoint } from "./spectroUtils";

const COLORS = { song: "#sng", songAlt: "#alt", take: "#tak", live: "#liv" };

function stored(frames = 4, bins = 8, level = 128): StoredSpectrum {
  const bytes = new Uint8Array(frames * bins);
  for (let f = 0; f < frames; f++) bytes.fill(level + f, f * bins, (f + 1) * bins);
  return { times: Array.from({ length: frames }, (_, i) => i * 2), bytes, bins, minDb: -100, maxDb: 0 };
}

function measured(sampleRate = 8000): MeasuredSpectrum {
  return { data: new Float32Array(512).fill(-40), sampleRate };
}

const voice = { f0: 220, f1: 520, f2: 1500, f3: 2600 };

describe("nearestFrame", () => {
  const s = stored();

  it("is null for a spectrum without frames", () => {
    expect(nearestFrame({ ...s, times: [] }, 1)).toBeNull();
  });

  it("picks the frame whose time is closest, before, between and after the recorded times", () => {
    expect(nearestFrame(s, -5)?.[0]).toBe(128);
    expect(nearestFrame(s, 1.9)?.[0]).toBe(129);
    expect(nearestFrame(s, 3.1)?.[0]).toBe(130);
    expect(nearestFrame(s, 100)?.[0]).toBe(131);
  });

  it("returns exactly one frame's worth of bins", () => {
    expect(nearestFrame(s, 2)?.length).toBe(s.bins);
  });
});

describe("storedCurvePoints", () => {
  it("makes one point per pixel column starting at the axis", () => {
    const pts = storedCurvePoints(new Uint8Array(8).fill(255), -100, 0, 40);
    expect(pts).toHaveLength(40);
    expect(pts[0].x).toBe(AXIS_W);
    expect(pts[39].x).toBe(AXIS_W + 39);
  });

  it("maps the byte range onto the display range and clamps", () => {
    expect(storedCurvePoints(new Uint8Array(4).fill(255), -100, 0, 4)[0].normalized).toBeCloseTo(1, 9);
    expect(storedCurvePoints(new Uint8Array(4).fill(0), -100, 0, 4)[0].normalized).toBe(0);
    expect(storedCurvePoints(new Uint8Array(4).fill(255), -50, 50, 4)[0].normalized).toBe(1);
    expect(storedCurvePoints(new Uint8Array(4).fill(255), -300, -200, 4)[0].normalized).toBe(0);
  });

  it("takes the loudest bin under a column", () => {
    const frame = new Uint8Array([0, 0, 0, 255]);
    const pts = storedCurvePoints(frame, -100, 0, 2);
    expect(pts[0].normalized).toBe(0);
    expect(pts[1].normalized).toBeCloseTo(1, 9);
  });
});

describe("trackCurvePoints", () => {
  const s = stored();

  it("falls back to the stored frame alone when nothing was measured", () => {
    const pts = trackCurvePoints(s, null, 2, 30, F_MAX);
    expect(pts).toHaveLength(30);
    expect(pts?.[0].normalized).toBeCloseTo(storedCurvePoints(nearestFrame(s, 2)!, -100, 0, 30)[0].normalized, 9);
  });

  it("is null with neither a measurement nor a frame", () => {
    expect(trackCurvePoints({ ...s, times: [] }, null, 2, 30, F_MAX)).toBeNull();
  });

  it("uses the measurement below its band and the stored frame above it", () => {
    const low = measured(8000);
    const pts = trackCurvePoints({ ...s, bytes: new Uint8Array(s.bytes.length).fill(255) }, { ...low, data: new Float32Array(512).fill(-100) }, 2, 200, F_MAX)!;
    expect(pts).toHaveLength(200);
    expect(pts[0].normalized).toBeLessThan(0.2);
    expect(pts[199].normalized).toBeCloseTo(1, 9);
  });

  it("keeps the measurement everywhere when it has no stored frame to add", () => {
    const pts = trackCurvePoints({ ...s, times: [] }, measured(100000), 2, 20, F_MAX)!;
    expect(pts).toHaveLength(20);
  });
});

describe("strokePoints", () => {
  const points: SpectrumPoint[] = [
    { x: 10, y: 0, normalized: 1 },
    { x: 11, y: 0, normalized: 0 },
    { x: 12, y: 0, normalized: 0.5 },
  ];

  it("draws a polyline at plot height scaled by level", () => {
    const { ctx, log } = createRecordingContext();
    strokePoints(ctx, points, "#abc", 100, 2, false);
    expect(log).toContain("strokeStyle=\"#abc\"");
    expect(log).toContain("lineWidth=4");
    expect(log).toContain("moveTo(10,0)");
    expect(log).toContain("lineTo(11,100)");
    expect(log).toContain("lineTo(12,50)");
    expect(log[log.length - 1]).toBe("stroke()");
  });

  it("smooths the curve when asked, which changes the interior points", () => {
    const raw = createRecordingContext();
    const smooth = createRecordingContext();
    strokePoints(raw.ctx, points, "#abc", 100, 1, false);
    strokePoints(smooth.ctx, points, "#abc", 100, 1, true);
    expect(smooth.log).not.toEqual(raw.log);
  });

  it("draws nothing but the stroke for an empty curve", () => {
    const { ctx, log } = createRecordingContext();
    strokePoints(ctx, [], "#abc", 100, 1, false);
    expect(log.filter((l) => l.startsWith("moveTo") || l.startsWith("lineTo"))).toEqual([]);
  });
});

describe("comparisonMarkers", () => {
  it("makes a solid F0 and dashed F1-F3, each labelled and in the curve's colour", () => {
    const m = comparisonMarkers(voice, "#c", 400, F_MAX, null, "#alt");
    expect(m.map((x) => x.slot)).toEqual([0, 1, 2, 3]);
    expect(m.map((x) => x.solid)).toEqual([true, false, false, false]);
    expect(m.every((x) => x.color === "#c")).toBe(true);
    expect(m[0].label).toMatch(/^F0 220 A3$/);
    expect(m[1].label).toBe("F1 520");
    expect(m.every((x) => x.x >= AXIS_W)).toBe(true);
  });

  it("skips missing values and anything above the plotted range", () => {
    const m = comparisonMarkers({ f0: null, f1: 520, f2: 30000, f3: null }, "#c", 400, 20000, null, "#alt");
    expect(m.map((x) => x.slot)).toEqual([1]);
  });

  it("adds the second voice as a solid line in its own colour in the last slot", () => {
    const m = comparisonMarkers(voice, "#c", 400, F_MAX, 330, "#alt");
    const second = m[m.length - 1];
    expect(second).toMatchObject({ slot: 4, color: "#alt", solid: true });
    expect(second.label).toMatch(/^F0 330 /);
  });
});

describe("markerLabelY", () => {
  it("stacks song labels down from the top and the singer's up from the bottom", () => {
    expect(markerLabelY(0, "top", 200, 1)).toBe(3);
    expect(markerLabelY(2, "top", 200, 1)).toBe(27);
    expect(markerLabelY(0, "bottom", 200, 1)).toBe(197);
    expect(markerLabelY(2, "bottom", 200, 2)).toBe(200 - 6 - 48);
  });
});

describe("drawComparisonMarkers", () => {
  it("strokes a line and an outlined label per marker, and restores the context", () => {
    const { ctx, log } = createRecordingContext();
    const markers = comparisonMarkers(voice, "#c", 400, F_MAX, null, "#alt");
    drawComparisonMarkers(ctx, markers, 180, 1, "top");
    expect(log[0]).toBe("save()");
    expect(log[log.length - 1]).toBe("restore()");
    expect(log.filter((l) => l.startsWith("strokeText"))).toHaveLength(markers.length);
    expect(log.filter((l) => l.startsWith("fillText"))).toHaveLength(markers.length);
    expect(log).toContain("setLineDash([4,3])");
    expect(log).toContain("textBaseline=\"top\"");
  });

  it("draws nothing between save and restore for no markers", () => {
    const { ctx, log } = createRecordingContext();
    drawComparisonMarkers(ctx, [], 180, 1, "bottom");
    expect(log.filter((l) => l.startsWith("stroke("))).toEqual([]);
  });
});

describe("drawCenteredNote", () => {
  it("writes the text centred with the given baseline", () => {
    const { ctx, log } = createRecordingContext();
    drawCenteredNote(ctx, "hi", 5, 6, "bottom", 2);
    expect(log).toContain("font=\"22px sans-serif\"");
    expect(log).toContain("textAlign=\"center\"");
    expect(log).toContain("textBaseline=\"bottom\"");
    expect(log).toContain("fillText(\"hi\",5,6)");
  });
});

function source(opts: { live?: boolean; measuredTracks?: boolean } = {}): ComparisonSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    getLiveSpectrum: () => (opts.live ? measured(48000) : null),
    getTrackSpectrum: (track, key) => {
      asked.push(`${track}:${key}`);
      return opts.measuredTracks ? measured(8000) : null;
    },
    getFormants: (track, key) => {
      asked.push(`formants:${track}:${Number.isNaN(key) ? "NaN" : key}`);
      return { f0: track === "live" ? null : 200, f1: 500, f2: 1500, f3: null };
    },
  };
}

function frame(over: Partial<ComparisonFrame> = {}): ComparisonFrame {
  return {
    W: 500,
    H: 220,
    dpr: 1,
    time: 3.37,
    song: null,
    take: null,
    live: null,
    source: source(),
    colors: COLORS,
    songPitch: [],
    songPitchAlt: [],
    takePitch: [],
    showSecondVoice: false,
    ...over,
  };
}

const pitch = (hz: number) => [{ time: 3.37, frequency: hz, confidence: 0.9 }];

describe("drawComparisonFrame", () => {
  it("says so when there is nothing to compare, and asks nothing of the source", () => {
    const src = source();
    const { ctx, log } = createRecordingContext();
    drawComparisonFrame(ctx, frame({ source: src }));
    expect(log.some((l) => l.startsWith("fillText(\"No spectrum data\""))).toBe(true);
    expect(src.asked).toEqual([]);
  });

  it("clears and paints the background before anything else", () => {
    const { ctx, log } = createRecordingContext();
    drawComparisonFrame(ctx, frame());
    expect(log.slice(0, 3)).toEqual(["clearRect(0,0,500,220)", "fillStyle=\"#0f0f1e\"", "fillRect(0,0,500,220)"]);
  });

  it("draws the song curve and, with no take, tells the user none is selected", () => {
    const { ctx, log } = createRecordingContext();
    drawComparisonFrame(ctx, frame({ song: stored() }));
    expect(log).toContain("strokeStyle=\"#sng\"");
    expect(log.some((l) => l.startsWith("fillText(\"No take selected\""))).toBe(true);
  });

  it("asks the source for the song and take at the same time key", () => {
    const src = source({ measuredTracks: true });
    const { ctx } = createRecordingContext();
    drawComparisonFrame(ctx, frame({ song: stored(), take: stored(), source: src }));
    const key = Math.round(3.37 / FORMANT_CACHE_STEP_S);
    expect(src.asked).toEqual([`song:${key}`, `take:${key}`, `formants:song:${key}`, `formants:take:${key}`]);
  });

  it("prefers the live singer over a stored take and marks it from the bottom", () => {
    const src = source({ live: true });
    const { ctx, log } = createRecordingContext();
    drawComparisonFrame(ctx, frame({ song: stored(), take: stored(), live: measured(48000), source: src }));
    expect(log).toContain("strokeStyle=\"#liv\"");
    expect(log).not.toContain("strokeStyle=\"#tak\"");
    expect(src.asked).toContain("formants:live:NaN");
    expect(src.asked.some((a) => a.startsWith("formants:take"))).toBe(false);
  });

  it("draws a live singer on its own without a song", () => {
    const { ctx, log } = createRecordingContext();
    drawComparisonFrame(ctx, frame({ live: measured(48000), source: source({ live: true }) }));
    expect(log).toContain("strokeStyle=\"#liv\"");
    expect(log).not.toContain("strokeStyle=\"#sng\"");
  });

  it("labels F0 from the stored pitch when the track has one, else from the window estimate", () => {
    const withPitch = createRecordingContext();
    drawComparisonFrame(withPitch.ctx, frame({ song: stored(), songPitch: pitch(440) }));
    expect(withPitch.log.some((l) => l.includes("F0 440 A4"))).toBe(true);

    const without = createRecordingContext();
    drawComparisonFrame(without.ctx, frame({ song: stored() }));
    expect(without.log.some((l) => l.includes("F0 200 "))).toBe(true);
  });

  it("shows the song's second voice only when asked", () => {
    const off = createRecordingContext();
    drawComparisonFrame(off.ctx, frame({ song: stored(), songPitchAlt: pitch(330) }));
    expect(off.log).not.toContain("strokeStyle=\"#alt\"");

    const on = createRecordingContext();
    drawComparisonFrame(on.ctx, frame({ song: stored(), songPitchAlt: pitch(330), showSecondVoice: true }));
    expect(on.log).toContain("strokeStyle=\"#alt\"");
    expect(on.log.some((l) => l.includes("F0 330 "))).toBe(true);
  });

  it("uses the take's stored pitch for the singer's F0", () => {
    const { ctx, log } = createRecordingContext();
    drawComparisonFrame(ctx, frame({ take: stored(), takePitch: pitch(523.25) }));
    expect(log.some((l) => l.includes("F0 523 C5"))).toBe(true);
  });

  it("scales layout with the device pixel ratio", () => {
    const one = createRecordingContext();
    const two = createRecordingContext();
    drawComparisonFrame(one.ctx, frame({ song: stored() }));
    drawComparisonFrame(two.ctx, frame({ song: stored(), dpr: 2, W: 1000, H: 440 }));
    expect(one.log).toContain("font=\"11px monospace\"");
    expect(two.log).toContain("font=\"22px monospace\"");
  });
});
