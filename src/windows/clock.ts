import type { TransportSnapshot } from "./protocol";

/**
 * A copy of the main window playhead that runs on its own between messages:
 * the main window only has to say when something changed, not 30 times a second.
 */
export class RemoteClock {
  private snapshot: TransportSnapshot | null = null;
  private duration = Number.POSITIVE_INFINITY;

  apply(snapshot: TransportSnapshot): void {
    this.snapshot = snapshot;
  }

  setDuration(seconds: number): void {
    this.duration = Number.isFinite(seconds) && seconds > 0 ? seconds : Number.POSITIVE_INFINITY;
  }

  now(nowMs: number): number {
    const s = this.snapshot;
    if (!s) return 0;
    const elapsed = s.playing ? (Math.max(0, nowMs - s.sentAt) / 1000) * s.rate : 0;
    return Math.min(this.duration, Math.max(0, s.time + elapsed));
  }
}

export interface PublisherOptions {
  /** How far the real playhead may stray from the prediction before we say so. */
  jumpToleranceS?: number;
  /** While playing, how often to resend so a drifting remote clock is pulled back. */
  heartbeatMs?: number;
}

const PAUSED_TOLERANCE_S = 0.001;

/** Decides when the main window has to tell a detached one about the transport. */
export class TransportPublisher {
  private last: TransportSnapshot | null = null;
  private readonly jumpToleranceS: number;
  private readonly heartbeatMs: number;

  constructor({ jumpToleranceS = 0.15, heartbeatMs = 1000 }: PublisherOptions = {}) {
    this.jumpToleranceS = jumpToleranceS;
    this.heartbeatMs = heartbeatMs;
  }

  next(current: { time: number; playing: boolean; rate: number }, nowMs: number): TransportSnapshot | null {
    const last = this.last;
    if (last && !this.mustPublish(last, current, nowMs)) return null;
    this.last = { time: current.time, playing: current.playing, rate: current.rate, sentAt: nowMs };
    return this.last;
  }

  reset(): void {
    this.last = null;
  }

  private mustPublish(
    last: TransportSnapshot,
    cur: { time: number; playing: boolean; rate: number },
    nowMs: number,
  ): boolean {
    if (cur.playing !== last.playing || cur.rate !== last.rate) return true;
    const predicted = last.playing ? last.time + (Math.max(0, nowMs - last.sentAt) / 1000) * last.rate : last.time;
    const tolerance = last.playing ? this.jumpToleranceS : PAUSED_TOLERANCE_S;
    if (Math.abs(cur.time - predicted) > tolerance) return true;
    return cur.playing && nowMs - last.sentAt >= this.heartbeatMs;
  }
}
