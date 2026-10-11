import { describe, it, expect } from "vitest";
import { LivePublisher } from "./liveFeed";
import type { PitchPoint } from "../lib/types";

const pt = (time: number, frequency = 220): PitchPoint => ({ time, frequency, confidence: 1 });

describe("LivePublisher", () => {
  it("has nothing to say before anything happens", () => {
    expect(new LivePublisher().push([], null)).toBeNull();
  });

  it("sends the first points as a fresh start", () => {
    const p = new LivePublisher();
    const a = pt(1);
    expect(p.push([a], 5)).toEqual({ reset: true, points: [a], cents: 5 });
  });

  it("then sends only what was appended", () => {
    const p = new LivePublisher();
    const a = pt(1), b = pt(2), c = pt(3);
    p.push([a], null);
    expect(p.push([a, b, c], null)).toEqual({ reset: false, points: [b, c], cents: null });
  });

  it("stays quiet when nothing changed", () => {
    const p = new LivePublisher();
    const a = pt(1);
    p.push([a], 3);
    expect(p.push([a], 3)).toBeNull();
  });

  it("reports a change in cents alone", () => {
    const p = new LivePublisher();
    const a = pt(1);
    p.push([a], 3);
    expect(p.push([a], -7)).toEqual({ reset: false, points: [], cents: -7 });
  });

  it("tells the other window to clear when the trace was cleared", () => {
    const p = new LivePublisher();
    p.push([pt(1), pt(2)], 1);
    expect(p.push([], null)).toEqual({ reset: true, points: [], cents: null });
  });

  it("notices a clear followed by new points before the next flush", () => {
    const p = new LivePublisher();
    p.push([pt(1), pt(2)], 1);
    const fresh = [pt(10), pt(11), pt(12)];
    expect(p.push(fresh, 2)).toEqual({ reset: true, points: fresh, cents: 2 });
  });

  it("does not share the caller's array with the message", () => {
    const p = new LivePublisher();
    const a = pt(1);
    const arr = [a];
    const msg = p.push(arr, null);
    arr.push(pt(2));
    expect(msg?.points).toEqual([a]);
  });

  it("forget makes the next push a full fresh start", () => {
    const p = new LivePublisher();
    const a = pt(1);
    p.push([a], 3);
    p.forget();
    expect(p.push([a], 3)).toEqual({ reset: true, points: [a], cents: 3 });
  });
});
