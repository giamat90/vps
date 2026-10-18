import { describe, it, expect } from "vitest";
import { createRecordingContext } from "../test/fakeCanvas";
import {
  drawLanes,
  drawNoteLabel,
  drawPianoStrip,
  drawPlayhead,
  drawPreviewVoice,
  drawRibbon,
  drawRuler,
  type StripNotes,
} from "./pianoRollDraw";
import { PIANO_W, midiToY, visibleMidiRange, type PianoColors } from "./pianoRollGeometry";
import type { PitchPoint } from "./types";

const colors: PianoColors = { song: "SONG", songAlt: "ALT", take: "TAKE", live: "LIVE" };
const pt = (time: number, frequency: number): PitchPoint => ({ time, frequency, confidence: 0.9 });
const count = (log: string[], prefix: string) => log.filter((l) => l.startsWith(prefix)).length;
const fillStyles = (log: string[]) => log.filter((l) => l.startsWith("fillStyle=")).map((l) => l.slice(11, -1));
const none: StripNotes = { song: null, take: null, live: null, preview: null, alt: null };

describe("drawLanes", () => {
  it("paints one lane per visible note, alternating black/white key shades", () => {
    const { ctx, log } = createRecordingContext();
    drawLanes(ctx, 640, 400, 48);
    const { first, last } = visibleMidiRange(48);
    const lanes = last - first + 1;
    expect(count(log, "fillRect")).toBeGreaterThanOrEqual(lanes);
    expect(fillStyles(log)).toContain("#0c0c1e");
    expect(fillStyles(log)).toContain("#141428");
  });

  it("marks every C with a brighter line", () => {
    const { ctx, log } = createRecordingContext();
    drawLanes(ctx, 640, 400, 48);
    const cs = log.filter((l) => l === 'fillStyle="#ffffff1a"').length;
    expect(cs).toBeGreaterThanOrEqual(3);
  });
});

describe("drawPreviewVoice", () => {
  it("draws a flat rounded trace at the previewed note", () => {
    const { ctx, log } = createRecordingContext();
    drawPreviewVoice(ctx, 400, 48, 60, 100, 300);
    const y = midiToY(60, 400, 48);
    expect(log).toContain(`moveTo(100,${Number(y.toPrecision(12))})`);
    expect(log).toContain("lineCap=\"round\"");
    expect(log[0]).toBe("save()");
  });

  it("draws nothing when the trace has no length", () => {
    const { ctx, log } = createRecordingContext();
    drawPreviewVoice(ctx, 400, 48, 60, 300, 300);
    expect(log).toEqual([]);
  });
});

describe("drawPlayhead", () => {
  it("draws a dashed line through the middle of the roll", () => {
    const { ctx, log } = createRecordingContext();
    drawPlayhead(ctx, 636, 200);
    expect(log).toContain(`moveTo(${PIANO_W + (636 - PIANO_W) / 2},0)`);
    expect(log).toContain("setLineDash([4,4])");
  });
});

describe("drawRibbon", () => {
  const timeToX = (t: number) => t * 10;

  it("strokes each polyline once, in the given colour", () => {
    const { ctx, log } = createRecordingContext();
    drawRibbon(ctx, [pt(0, 440), pt(0.02, 440), pt(1, 440)], "RED", 0, 8, 400, 40, timeToX);
    expect(log).toContain('strokeStyle="RED"');
    expect(count(log, "moveTo")).toBe(2);
    expect(count(log, "lineTo")).toBe(1);
    expect(count(log, "stroke()")).toBe(1);
  });

  it("still strokes an empty path for no points", () => {
    const { ctx, log } = createRecordingContext();
    drawRibbon(ctx, [], "RED", 0, 8, 400, 40, timeToX);
    expect(count(log, "moveTo")).toBe(0);
    expect(count(log, "stroke()")).toBe(1);
  });
});

describe("drawPianoStrip", () => {
  it("fills the strip background and the closing border", () => {
    const { ctx, log } = createRecordingContext();
    drawPianoStrip(ctx, 400, 48, none, colors);
    expect(log[0]).toBe('fillStyle="#090914"');
    expect(log[log.length - 1]).toBe(`fillRect(${PIANO_W - 1},0,1,400)`);
  });

  it("labels each C with its octave and no other key", () => {
    const { ctx, log } = createRecordingContext();
    drawPianoStrip(ctx, 400, 48, none, colors);
    const labels = log.filter((l) => l.startsWith("fillText")).map((l) => l.match(/"(.*)"/)![1]);
    expect(labels).toEqual(["C3", "C4", "C5", "C6"]);
  });

  it("highlights the sounding notes, live over take over song", () => {
    const { ctx, log } = createRecordingContext();
    drawPianoStrip(ctx, 400, 48, { ...none, song: 60, take: 60, live: 62 }, colors);
    const fills = fillStyles(log);
    expect(fills).toContain("LIVE");
    expect(fills).toContain("TAKE");
    expect(fills).not.toContain("SONG");
  });

  it("shows the second voice and tints its octave label", () => {
    const { ctx, log } = createRecordingContext();
    drawPianoStrip(ctx, 400, 48, { ...none, alt: 60 }, colors);
    expect(fillStyles(log)).toContain("ALT");
    expect(fillStyles(log)).toContain("#123");
  });

  it("overlays a translucent white on the previewed key, black or white", () => {
    for (const note of [60, 61]) {
      const { ctx, log } = createRecordingContext();
      drawPianoStrip(ctx, 400, 48, { ...none, preview: note }, colors);
      expect(count(log, 'fillStyle="rgba(255, 255, 255, 0.5)"')).toBe(1);
    }
  });

  it("draws narrower keys for the black notes", () => {
    const { ctx, log } = createRecordingContext();
    drawPianoStrip(ctx, 400, 48, none, colors);
    const widths = new Set(log.filter((l) => l.startsWith("fillRect(1,")).map((l) => l.split(",")[2]));
    expect(widths).toEqual(new Set([String(Number((PIANO_W * 0.6).toPrecision(12))), String(PIANO_W - 3)]));
  });
});

describe("drawNoteLabel", () => {
  const sung = (f: number) => [pt(5, f)];

  it("prints nothing when no line is sounding", () => {
    const { ctx, log } = createRecordingContext();
    drawNoteLabel(ctx, 640, [], [], [], 5, colors);
    expect(log).toEqual([]);
  });

  it("lists live, then take, then song from the right edge, each in its colour", () => {
    const { ctx, log } = createRecordingContext();
    drawNoteLabel(ctx, 640, sung(220), sung(330), sung(440), 5, colors);
    expect(log.filter((l) => l.startsWith("fillText"))).toEqual([
      'fillText("A4",634,5)',
      'fillText("E4",612,5)',
      'fillText("A3",590,5)',
    ]);
    expect(fillStyles(log)).toEqual(["LIVE", "TAKE", "SONG"]);
  });

  it("skips the lines that are silent without leaving a gap", () => {
    const { ctx, log } = createRecordingContext();
    drawNoteLabel(ctx, 640, sung(220), [], [], 5, colors);
    expect(log.filter((l) => l.startsWith("fillText"))).toEqual(['fillText("A3",634,5)']);
    expect(count(log, "measureText")).toBe(0);
  });
});

describe("drawRuler", () => {
  it("draws ticks with clock labels around the playhead", () => {
    const { ctx, log } = createRecordingContext();
    drawRuler(ctx, 636, 20, 12, null, null);
    const labels = log.filter((l) => l.startsWith("fillText")).map((l) => l.match(/"(.*)"/)![1]);
    expect(labels).toEqual(["0:08", "0:09", "0:10", "0:11", "0:12", "0:13", "0:14", "0:15", "0:16"]);
    expect(log[log.length - 1]).toBe("stroke()");
  });

  it("shades a punch region and marks both handles when they are on screen", () => {
    const { ctx, log } = createRecordingContext();
    drawRuler(ctx, 636, 20, 12, 10, 14);
    expect(log).toContain('fillStyle="rgba(233,69,96,0.22)"');
    expect(count(log, 'strokeStyle="rgba(233,69,96,0.85)"')).toBe(2);
    expect(count(log, 'fillStyle="rgba(233,69,96,0.9)"')).toBe(2);
  });

  it("marks only the handle that is still on screen", () => {
    const { ctx, log } = createRecordingContext();
    drawRuler(ctx, 636, 20, 12, 10, 40);
    expect(count(log, 'strokeStyle="rgba(233,69,96,0.85)"')).toBe(1);
    expect(log).toContain('fillStyle="rgba(233,69,96,0.22)"');
  });

  it("ignores an empty or half-set punch region", () => {
    for (const [a, b] of [[null, 14], [10, null], [14, 10], [12, 12]] as const) {
      const { ctx, log } = createRecordingContext();
      drawRuler(ctx, 636, 20, 12, a, b);
      expect(log).not.toContain('fillStyle="rgba(233,69,96,0.22)"');
    }
  });

  it("draws no shading for a region wholly off screen but keeps the ticks", () => {
    const { ctx, log } = createRecordingContext();
    drawRuler(ctx, 636, 20, 12, 100, 120);
    expect(log).not.toContain('fillStyle="rgba(233,69,96,0.22)"');
    expect(count(log, "fillText")).toBeGreaterThan(0);
  });
});
