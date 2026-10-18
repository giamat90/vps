import { describe, it, expect } from "vitest";
import { createRecordingContext } from "../test/fakeCanvas";
import {
  drawCenterPlayhead,
  drawDbLegend,
  drawFreqAxis,
  drawGridLines,
  drawIdleMessage,
  drawTrackSpectrogramWindow,
  fillFormantTicks,
} from "./spectrogramDraw";
import { AXIS_W, LEGEND_WIDTH } from "./spectrogramMath";

const texts = (log: string[]) => log.filter((l) => l.startsWith("fillText")).map((l) => l.match(/"([^"]*)"/)![1]);

describe("drawFreqAxis", () => {
  it("labels the decade ticks that clear the edges and pins 20k at the top when the range reaches it", () => {
    const { ctx, log } = createRecordingContext();
    drawFreqAxis(ctx, 400, 96000, 1);
    expect(texts(log)).toEqual(["20k", "50", "100", "200", "500", "1k", "2k", "5k", "10k"]);
    expect(log[0]).toBe('fillStyle="#16213e"');
    expect(log).toContain(`fillRect(0,0,${AXIS_W},400)`);
  });

  it("omits 20k and every tick above Nyquist for a low sample rate", () => {
    const { ctx, log } = createRecordingContext();
    drawFreqAxis(ctx, 400, 8000, 1);
    expect(texts(log)).toEqual(["50", "100", "200", "500", "1k", "2k"]);
  });

  it("brightens the 1k and 5k anchors", () => {
    const { ctx, log } = createRecordingContext();
    drawFreqAxis(ctx, 400, 96000, 1);
    const i = log.findIndex((l) => l.startsWith('fillText("1k"'));
    const j = log.findIndex((l) => l.startsWith('fillText("2k"'));
    expect(log[i - 1]).toBe('fillStyle="rgba(255,255,255,0.92)"');
    expect(log[j - 1]).toBe('fillStyle="rgba(255,255,255,0.85)"');
  });

  it("scales the font with the device pixel ratio", () => {
    const { ctx, log } = createRecordingContext();
    drawFreqAxis(ctx, 400, 96000, 2);
    expect(log).toContain('font="22px monospace"');
  });
});

describe("drawDbLegend", () => {
  it("draws a gradient bar and one label per tick, bolding the range ends", () => {
    const { ctx, log } = createRecordingContext();
    drawDbLegend(ctx, 600, 300, 1);
    expect(texts(log)).toEqual(["-20", "-30", "-40", "-50", "-60", "-70", "-80", "-85"]);
    expect(log.filter((l) => l.startsWith("fillRect")).length).toBe(276);
    expect(log.filter((l) => l === 'font="bold 11px monospace"')).toHaveLength(2);
    expect(log).toContain(`strokeRect(${600 - LEGEND_WIDTH},12,10,276)`);
  });
});

describe("drawGridLines", () => {
  it("restores the context and strokes one line per visible frequency", () => {
    const { ctx, log } = createRecordingContext();
    drawGridLines(ctx, 600, 400, 22050);
    expect(log[0]).toBe("save()");
    expect(log[log.length - 1]).toBe("restore()");
    expect(log.filter((l) => l === "stroke()")).toHaveLength(5);
  });

  it("draws nothing between save and restore when the range is empty", () => {
    const { ctx, log } = createRecordingContext();
    drawGridLines(ctx, 600, 400, 50);
    expect(log.filter((l) => l === "stroke()")).toHaveLength(0);
  });
});

describe("small draw helpers", () => {
  it("drawIdleMessage prints the hint centred", () => {
    const { ctx, log } = createRecordingContext();
    drawIdleMessage(ctx, 100, 50, 1.5);
    expect(log).toContain('font="16.5px sans-serif"');
    expect(log).toContain('textAlign="center"');
    expect(log[log.length - 1]).toBe('fillText("Enable Monitor or Record to see spectrum",100,50)');
  });

  it("drawCenterPlayhead strokes a dashed vertical line", () => {
    const { ctx, log } = createRecordingContext();
    drawCenterPlayhead(ctx, 80, 200, 2);
    expect(log).toContain("setLineDash([8,6])");
    expect(log).toContain("moveTo(80,0)");
    expect(log).toContain("lineTo(80,200)");
  });

  it("fillFormantTicks draws a 2px tick per row and never above the canvas", () => {
    const { ctx, log } = createRecordingContext();
    fillFormantTicks(ctx, [0.5, 40], 10, 4);
    expect(log).toEqual(['fillStyle="#e8fbff"', "fillRect(10,0,4,2)", "fillRect(10,39,4,2)"]);
  });
});

describe("drawTrackSpectrogramWindow", () => {
  const spec = { canvas: { width: 3000, height: 200 } as unknown as CanvasImageSource, hopTime: 0.01, cols: 3000, rows: 200 };

  it("clears the roll and blits the visible columns around the playhead", () => {
    const { ctx, log } = createRecordingContext();
    drawTrackSpectrogramWindow(ctx, spec, 15, 500, 300);
    expect(log[1]).toBe(`fillRect(${AXIS_W},0,500,300)`);
    const blit = log.find((l) => l.startsWith("drawImage"))!;
    expect(blit).toBe(`drawImage([canvas 3000x200],1000,0,1000,200,${AXIS_W},0,500,300)`);
  });

  it("only clears when the playhead is outside the track", () => {
    const { ctx, log } = createRecordingContext();
    drawTrackSpectrogramWindow(ctx, spec, 500, 500, 300);
    expect(log.some((l) => l.startsWith("drawImage"))).toBe(false);
  });
});
