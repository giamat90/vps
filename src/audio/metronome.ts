const BEATS_PER_BAR = 4;
const SCHEDULE_AHEAD_TIME = 0.1;
const LOOKAHEAD_MS = 25;
const CLICK_DURATION = 0.03;

class Metronome {
  private ctx: AudioContext | null = null;
  private timerId: number | null = null;
  private nextNoteTime = 0;
  private beat = 0;
  private bpm = 120;

  private scheduleClick(beat: number, time: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = beat === 0 ? 1500 : 900;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(beat === 0 ? 0.9 : 0.5, time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + CLICK_DURATION);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + CLICK_DURATION + 0.01);
  }

  private tick = () => {
    const ctx = this.ctx;
    if (!ctx) return;
    while (this.nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD_TIME) {
      this.scheduleClick(this.beat, this.nextNoteTime);
      this.nextNoteTime += 60 / this.bpm;
      this.beat = (this.beat + 1) % BEATS_PER_BAR;
    }
    this.timerId = window.setTimeout(this.tick, LOOKAHEAD_MS);
  };

  /**
   * (Re)starts the click scheduler, phase-locked so the next click lands
   * `timeUntilNextBeat` seconds from now (wall-clock) at bar position
   * `startBeat` (0 = accented downbeat) — lets the caller keep the click
   * aligned to a specific song-time downbeat (see src/lib/metronomeSync.ts)
   * instead of always resetting to beat 0 at whatever moment start() is
   * called. Always resyncs, even if already running, since a stale
   * scheduled phase is exactly the bug this is meant to fix.
   */
  start(bpm: number, timeUntilNextBeat = 0, startBeat = 0) {
    this.bpm = bpm;
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch((e) => console.warn("Metronome: failed to resume AudioContext", e));
    }
    this.beat = ((startBeat % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
    this.nextNoteTime = this.ctx.currentTime + Math.max(0.05, timeUntilNextBeat);
    if (this.timerId === null) this.tick();
  }

  stop() {
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.ctx?.suspend().catch((e) => console.warn("Metronome: failed to suspend AudioContext", e));
  }
}

export const metronome = new Metronome();
