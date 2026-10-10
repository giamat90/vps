import { describe, it, expect } from "vitest";
import { RemoteClock, TransportPublisher } from "./clock";

describe("RemoteClock", () => {
  it("reads 0 before it has heard anything", () => {
    expect(new RemoteClock().now(1000)).toBe(0);
  });

  it("holds the time while paused", () => {
    const c = new RemoteClock();
    c.apply({ time: 12, playing: false, rate: 1, sentAt: 1000 });
    expect(c.now(1000)).toBe(12);
    expect(c.now(9000)).toBe(12);
  });

  it("runs forward at the playback rate while playing", () => {
    const c = new RemoteClock();
    c.apply({ time: 10, playing: true, rate: 1, sentAt: 1000 });
    expect(c.now(1000)).toBe(10);
    expect(c.now(3500)).toBeCloseTo(12.5, 9);
  });

  it("honours a slower or faster rate", () => {
    const c = new RemoteClock();
    c.apply({ time: 0, playing: true, rate: 0.5, sentAt: 0 });
    expect(c.now(4000)).toBeCloseTo(2, 9);
    c.apply({ time: 0, playing: true, rate: 2, sentAt: 0 });
    expect(c.now(4000)).toBeCloseTo(8, 9);
  });

  it("corrects itself when a newer snapshot arrives", () => {
    const c = new RemoteClock();
    c.apply({ time: 0, playing: true, rate: 1, sentAt: 0 });
    expect(c.now(5000)).toBeCloseTo(5, 9);
    c.apply({ time: 4.8, playing: true, rate: 1, sentAt: 5000 });
    expect(c.now(5000)).toBeCloseTo(4.8, 9);
  });

  it("never reads before 0 or before the time it was told, even with a slightly early clock", () => {
    const c = new RemoteClock();
    c.apply({ time: 1, playing: true, rate: 1, sentAt: 2000 });
    expect(c.now(1990)).toBe(1);
  });

  it("stops at the duration it was given", () => {
    const c = new RemoteClock();
    c.setDuration(10);
    c.apply({ time: 9, playing: true, rate: 1, sentAt: 0 });
    expect(c.now(60_000)).toBe(10);
  });

  it("ignores a non-positive or non-finite duration", () => {
    const c = new RemoteClock();
    c.setDuration(0);
    c.apply({ time: 9, playing: true, rate: 1, sentAt: 0 });
    expect(c.now(2000)).toBeCloseTo(11, 9);
    c.setDuration(Number.NaN);
    expect(c.now(2000)).toBeCloseTo(11, 9);
  });
});

describe("TransportPublisher", () => {
  const paused = (time: number) => ({ time, playing: false, rate: 1 });
  const playing = (time: number, rate = 1) => ({ time, playing: true, rate });

  it("publishes the first state it sees", () => {
    const p = new TransportPublisher();
    expect(p.next(paused(0), 0)).toEqual({ time: 0, playing: false, rate: 1, sentAt: 0 });
  });

  it("stays quiet while nothing changes", () => {
    const p = new TransportPublisher();
    p.next(paused(5), 0);
    expect(p.next(paused(5), 100)).toBeNull();
    expect(p.next(paused(5), 5000)).toBeNull();
  });

  it("publishes when playback starts, stops or changes speed", () => {
    const p = new TransportPublisher();
    p.next(paused(5), 0);
    expect(p.next(playing(5), 10)?.playing).toBe(true);
    expect(p.next(playing(5.04, 0.5), 50)?.rate).toBe(0.5);
    expect(p.next(paused(5.1), 80)?.playing).toBe(false);
  });

  it("does not republish while the playing time simply advances as predicted", () => {
    const p = new TransportPublisher();
    p.next(playing(0), 0);
    expect(p.next(playing(0.03), 33)).toBeNull();
    expect(p.next(playing(0.5), 500)).toBeNull();
  });

  it("publishes a seek while playing, and a loop jump back", () => {
    const p = new TransportPublisher();
    p.next(playing(0), 0);
    expect(p.next(playing(30), 100)).toMatchObject({ time: 30, playing: true });
    expect(p.next(playing(10.02), 200)).toMatchObject({ time: 10.02 });
  });

  it("publishes a seek while paused, even a small one", () => {
    const p = new TransportPublisher();
    p.next(paused(5), 0);
    expect(p.next(paused(5.5), 100)).toMatchObject({ time: 5.5, playing: false });
  });

  it("sends a heartbeat while playing so a drifting clock is corrected", () => {
    const p = new TransportPublisher();
    p.next(playing(0), 0);
    expect(p.next(playing(0.99), 990)).toBeNull();
    expect(p.next(playing(1.0), 1000)).toMatchObject({ time: 1.0, sentAt: 1000 });
    expect(p.next(playing(1.5), 1500)).toBeNull();
  });

  it("sends no heartbeat while paused", () => {
    const p = new TransportPublisher();
    p.next(paused(2), 0);
    expect(p.next(paused(2), 60_000)).toBeNull();
  });

  it("reset makes the next state publish again (a new window needs the whole picture)", () => {
    const p = new TransportPublisher();
    p.next(paused(2), 0);
    p.reset();
    expect(p.next(paused(2), 10)).toMatchObject({ time: 2, sentAt: 10 });
  });

  it("uses the tolerances it is given", () => {
    const p = new TransportPublisher({ jumpToleranceS: 1, heartbeatMs: 10_000 });
    p.next(playing(0), 0);
    expect(p.next(playing(0.9), 100)).toBeNull();
    expect(p.next(playing(2), 200)).not.toBeNull();
    expect(p.next(playing(6.8), 5000)).toBeNull();
  });
});
