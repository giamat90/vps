import WaveSurfer from "wavesurfer.js";
import { convertFileSrc } from "@tauri-apps/api/core";

export type TimeUpdateCallback = (currentTime: number) => void;

export class AudioEngine {
  vocals: WaveSurfer | null = null;
  instrumental: WaveSurfer | null = null;
  private _duration = 0;
  private _isPlaying = false;
  private _loopStart: number | null = null;
  private _loopEnd: number | null = null;
  private _timeUpdateCb: TimeUpdateCallback | null = null;
  private _rafId: number | null = null;

  async load(
    songDir: string,
    vocalsContainer: HTMLElement,
    instrumentalContainer: HTMLElement,
  ): Promise<void> {
    this.destroy();

    // Normalize to forward slashes so convertFileSrc works correctly on Windows
    const dir = songDir.replace(/\\/g, "/");
    const vocalsUrl = convertFileSrc(dir + "/vocals.wav");
    const instrumentalUrl = convertFileSrc(dir + "/instrumental.wav");

    const waveOptions = {
      height: 80,
      waveColor: "#a0a0b0",
      progressColor: "#e94560",
      cursorColor: "#e94560",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
    };

    this.vocals = WaveSurfer.create({
      ...waveOptions,
      container: vocalsContainer,
      url: vocalsUrl,
    });

    this.instrumental = WaveSurfer.create({
      ...waveOptions,
      container: instrumentalContainer,
      url: instrumentalUrl,
      waveColor: "#4a6fa5",
      progressColor: "#4ade80",
    });

    // Wait for both to be ready; reject immediately on WaveSurfer error
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        this.vocals!.on("ready", () => resolve());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.vocals!.on("error", (err: any) => reject(new Error("Vocals failed to load: " + (err?.message ?? err))));
      }),
      new Promise<void>((resolve, reject) => {
        this.instrumental!.on("ready", () => resolve());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.instrumental!.on("error", (err: any) => reject(new Error("Instrumental failed to load: " + (err?.message ?? err))));
      }),
    ]);

    // Guard: destroy() may have been called (e.g. by React StrictMode cleanup) during the await.
    if (!this.vocals || !this.instrumental) return;

    this._duration = this.vocals.getDuration();

    // Sync: when user clicks on one waveform, seek the other
    this.vocals.on("seeking", (time) => {
      const progress = time / this._duration;
      this.instrumental?.seekTo(progress);
    });

    this.instrumental.on("seeking", (time) => {
      const progress = time / this._duration;
      this.vocals?.seekTo(progress);
    });

    // Handle end of playback
    this.vocals.on("finish", () => {
      this._isPlaying = false;
      this._stopTimeUpdate();
    });
  }

  play(): void {
    if (!this.vocals || !this.instrumental) return;
    this.vocals.play();
    this.instrumental.play();
    this._isPlaying = true;
    this._startTimeUpdate();
  }

  pause(): void {
    if (!this.vocals || !this.instrumental) return;
    this.vocals.pause();
    this.instrumental.pause();
    this._isPlaying = false;
    this._stopTimeUpdate();
  }

  togglePlay(): void {
    if (this._isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  stop(): void {
    this.pause();
    this.seekTo(0);
  }

  seekTo(time: number): void {
    if (!this.vocals || !this.instrumental) return;
    const progress = Math.max(0, Math.min(1, time / this._duration));
    this.vocals.seekTo(progress);
    this.instrumental.seekTo(progress);
  }

  setPlaybackRate(rate: number): void {
    this.vocals?.setPlaybackRate(rate);
    this.instrumental?.setPlaybackRate(rate);
  }

  setVocalsVolume(volume: number): void {
    this.vocals?.setVolume(volume);
  }

  setInstrumentalVolume(volume: number): void {
    this.instrumental?.setVolume(volume);
  }

  loadVocalsFromPath(filePath: string): void {
    if (!this.vocals) return;
    const url = convertFileSrc(filePath.replace(/\\/g, "/"));
    this.vocals.load(url);
  }

  setLoop(start: number, end: number): void {
    this._loopStart = start;
    this._loopEnd = end;
  }

  clearLoop(): void {
    this._loopStart = null;
    this._loopEnd = null;
  }

  getCurrentTime(): number {
    return this.vocals?.getCurrentTime() ?? 0;
  }

  getDuration(): number {
    return this._duration;
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  onTimeUpdate(cb: TimeUpdateCallback): void {
    this._timeUpdateCb = cb;
  }

  destroy(): void {
    this._stopTimeUpdate();
    this.vocals?.destroy();
    this.instrumental?.destroy();
    this.vocals = null;
    this.instrumental = null;
    this._isPlaying = false;
    this._duration = 0;
  }

  private _startTimeUpdate(): void {
    this._stopTimeUpdate();
    const tick = () => {
      if (!this._isPlaying) return;

      const time = this.getCurrentTime();

      // Handle loop
      if (
        this._loopStart !== null &&
        this._loopEnd !== null &&
        time >= this._loopEnd
      ) {
        this.seekTo(this._loopStart);
      }

      this._timeUpdateCb?.(time);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  private _stopTimeUpdate(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }
}
