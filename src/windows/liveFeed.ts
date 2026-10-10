import type { PitchPoint } from "../lib/types";
import type { LiveMessage } from "./protocol";

/**
 * Turns the main window live pitch trace (an append-only array that is
 * sometimes cleared) into the smallest message a detached window needs.
 */
export class LivePublisher {
  private sent = 0;
  private first: PitchPoint | undefined;
  private cents: number | null = null;

  push(points: readonly PitchPoint[], cents: number | null): LiveMessage | null {
    const restarted = this.sent > 0 && (points.length < this.sent || points[0] !== this.first);
    const fresh = this.sent === 0 && points.length > 0;

    if (restarted || fresh) {
      this.sent = points.length;
      this.first = points[0];
      this.cents = cents;
      return { reset: true, points: points.slice(), cents };
    }

    const appended = points.slice(this.sent);
    if (appended.length === 0 && cents === this.cents) return null;
    this.sent = points.length;
    this.cents = cents;
    return { reset: false, points: appended, cents };
  }

  forget(): void {
    this.sent = 0;
    this.first = undefined;
    this.cents = null;
  }
}
