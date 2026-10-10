import WaveSurfer from "wavesurfer.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { clamp, FOLLOW_MARGIN_RATIO, FOLLOW_RESUME_SUPPRESS_MS } from "../lib/zoomPan";

const DRIFT_TOLERANCE_S = 0.05;
const DRIFT_CHECK_INTERVAL_MS = 250;
const DRIFT_CHECK_END_GUARD_S = 0.1;

export type TimeUpdateCallback= (currentTime: number) => void;
export type FinishCallback = () => void;
export type ScrollChangeCallback = (minPxPerSec: number, scrollTime: number) => void;

export class AudioEngine {
  vocals: WaveSurfer | null = null;
  instrumental: WaveSurfer | null = null;
  take: WaveSurfer | null = null;
  private _duration = 0;
  private _isPlaying = false;
  private _loopStart: number | null = null;
  private _loopEnd: number | null = null;
  private _timeUpdateCb: TimeUpdateCallback | null = null;
  private _finishCb: FinishCallback | null = null;
  private _rafId: number | null = null;
  // Throttle store updates to ~30fps — halves React re-render rate vs 60fps rAF
  private _lastNotifyTime = 0;
  // Offset (seconds) into the song where the vocals/take file starts
  private _vocalsOffset = 0;
  // Duration of the vocals/take file (may differ from _duration for partial takes)
  private _vocalsDuration = 0;
  // Take track offset, duration, and audio-file skip offset
  private _takeOffset = 0;
  private _takeDuration = 0;
  private _takeAudioOffset = 0;
  // User drag nudge on top of _takeOffset, for manual sync correction after recording
  private _takeManualOffset = 0;
  // Whether the take WaveSurfer is currently playing (managed by window sync)
  private _takeIsPlaying = false;
  // Take rail container, retained so zoom/pan can re-resize it later
  private _takeContainer: HTMLElement | null = null;
  // Timeline zoom/pan
  private _minPxPerSec = 1;
  private _scrollTime = 0;
  private _lastManualScrollAt = 0;
  private _scrollUpdateCb: ScrollChangeCallback | null = null;
  // Exercise timer — used when no song is loaded (free exercise mode)
  private _exerciseMode = false;
  private _exerciseStartAt = 0;   // performance.now() at last resume
  private _exerciseOffset = 0;    // accumulated seconds before last pause
  // Free Exercise: a loaded past take or imported file, played back independently
  // of the vocals/instrumental/take trio (which requires a song). Ungated —
  // does not participate in play()/pause()/seekTo()'s vocals&&instrumental guard.
  exerciseTrack: WaveSurfer | null = null;
  // Output device last applied via setOutputDevice — re-applied to take/exerciseTrack
  // WaveSurfer instances, which are destroyed and recreated on each load and would
  // otherwise fall back to the system default sink.
  private _lastOutputDeviceId = "";
  // Speed last applied via setPlaybackRate — re-applied to `take` on load, same
  // reasoning as _lastOutputDeviceId: it's destroyed/recreated on every take
  // switch and would otherwise silently reset to 1x regardless of the active speed.
  private _lastPlaybackRate = 1;
  // A volume-0 <audio> element is not guaranteed to stay locked to the audio-device
  // clock like an audible one, so a muted track drifts ahead of the audible ones.
  // Tracked so _correctDrift pulls the silent track toward the audible one, never
  // the other way round (which would make the audible track skip).
  private _silent = { vocals: false, instrumental: false };
  private _lastDriftCheckAt = 0;

  async load(
    songDir: string,
    vocalsContainer: HTMLElement,
    instrumentalContainer: HTMLElement,
  ): Promise<boolean> {
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
      hideScrollbar: true,
      autoScroll: false,
      autoCenter: false,
    };

    const vocals = WaveSurfer.create({
      ...waveOptions,
      container: vocalsContainer,
      url: vocalsUrl,
    });
    const instrumental = WaveSurfer.create({
      ...waveOptions,
      container: instrumentalContainer,
      url: instrumentalUrl,
      waveColor: "#4a6fa5",
      progressColor: "#4ade80",
    });
    this.vocals = vocals;
    this.instrumental = instrumental;
    const isCurrent = () => this.vocals === vocals && this.instrumental === instrumental;

    // Wait for both to be ready; reject immediately on WaveSurfer error
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        vocals.on("ready", () => resolve());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        vocals.on("error", (err: any) => reject(new Error("Vocals failed to load: " + (err?.message ?? err))));
      }),
      new Promise<void>((resolve, reject) => {
        instrumental.on("ready", () => resolve());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        instrumental.on("error", (err: any) => reject(new Error("Instrumental failed to load: " + (err?.message ?? err))));
      }),
    ]);

    // destroy() or a newer load() may have replaced these instances during the
    // await (React StrictMode runs the load effect twice). Compare identity,
    // not null: a newer load's still-undecoded instances are non-null, and
    // carrying on with them would size the song to 0 and make zoom() throw.
    if (!isCurrent()) return false;

    if (this._lastOutputDeviceId) {
      await Promise.all([
        vocals.setSinkId(this._lastOutputDeviceId).catch((e) =>
          console.warn("[engine] setSinkId on vocals failed:", e)
        ),
        instrumental.setSinkId(this._lastOutputDeviceId).catch((e) =>
          console.warn("[engine] setSinkId on instrumental failed:", e)
        ),
      ]);
      if (!isCurrent()) return false;
    }

    // Duration is always based on the instrumental (the reference track).
    // Vocals/take may be shorter when recording starts mid-song.
    this._duration = instrumental.getDuration();
    this._vocalsDuration = vocals.getDuration();
    this._vocalsOffset = 0;

    // Sync: when user clicks on one waveform, seek the other.
    // "interaction" fires ONLY on user clicks — never on programmatic seekTo() calls.
    // Using "seeking" (the proxied HTML5 event) here caused an infinite async loop:
    // seekTo(0) → vocals fires "seeking" → instrumental.seekTo(0) → instrumental fires
    // "seeking" → vocals.seekTo(0) → … each iteration queued a new async task,
    // growing the task queue and RAM indefinitely after every stop.
    vocals.on("interaction", (newTime) => {
      // Map vocals file time → instrumental song time, then seek instrumental + take
      const instrTime = newTime + this._vocalsOffset;
      const instrProgress = Math.max(0, Math.min(1, instrTime / this._duration));
      this.instrumental?.seekTo(instrProgress);
      this._seekTake(instrTime);
    });

    instrumental.on("interaction", (newTime) => {
      // Map instrumental song time → vocals/take file time, accounting for start offset
      this._seekVocals(newTime);
      this._seekTake(newTime);
    });

    // Finish fires on the instrumental so partial takes don't prematurely end playback
    instrumental.on("finish", () => {
      this._isPlaying = false;
      this._stopTimeUpdate();
      this._finishCb?.();
    });
    return true;
  }

  play(): void {
    if (!this.vocals || !this.instrumental) return;
    this.vocals.play();
    this.instrumental.play();
    if (this.take && this._takeDuration > 0) {
      const time = this.getCurrentTime();
      const takeStart = this._takeOffset + this._takeManualOffset;
      const takeEnd = takeStart + this._takeDuration - this._takeAudioOffset;
      if (time >= takeStart && time < takeEnd) {
        this.take.play();
        this._takeIsPlaying = true;
      }
    }
    this._isPlaying = true;
    this._startTimeUpdate();
  }

  pause(): void {
    if (!this.vocals || !this.instrumental) return;
    this.vocals.pause();
    this.instrumental.pause();
    this.take?.pause();
    this._takeIsPlaying = false;
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
    // A loaded exercise track is authoritative on its own (see getCurrentTime()
    // above) — PianoRoll's drag-to-seek calls the generic seek() player-store
    // action for both PracticeRoom and Free Exercise, but this method used to
    // require vocals+instrumental (always null in Free Exercise), silently
    // no-op-ing and leaving the drag with no effect on playback.
    if (this.exerciseTrack) {
      this.seekExerciseTrack(time);
      return;
    }
    if (!this.vocals || !this.instrumental) return;
    const instrProgress = Math.max(0, Math.min(1, time / this._duration));
    this.instrumental.seekTo(instrProgress);
    this._seekVocals(time);
    this._seekTake(time);
  }

  // Seek the vocals/take to the position that corresponds to the given song time.
  private _seekVocals(instrTime: number): void {
    if (!this.vocals) return;
    const dur = this._vocalsDuration > 0 ? this._vocalsDuration : this._duration;
    const vocalsTime = Math.max(0, instrTime - this._vocalsOffset);
    this.vocals.seekTo(Math.min(1, vocalsTime / dur));
  }

  private _seekTake(instrTime: number): void {
    if (!this.take) return;
    const dur = this._takeDuration > 0 ? this._takeDuration : this._duration;
    const takeTime = this._takeAudioOffset + Math.max(0, instrTime - (this._takeOffset + this._takeManualOffset));
    this.take.seekTo(Math.min(1, takeTime / dur));
  }

  setPlaybackRate(rate: number): void {
    this._lastPlaybackRate = rate;
    this.vocals?.setPlaybackRate(rate);
    this.instrumental?.setPlaybackRate(rate);
    this.take?.setPlaybackRate(rate);
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this._lastOutputDeviceId = deviceId;
    await Promise.all([
      this.vocals?.setSinkId(deviceId),
      this.instrumental?.setSinkId(deviceId),
      this.take?.setSinkId(deviceId),
      this.exerciseTrack?.setSinkId(deviceId),
    ]);
  }

  setVocalsVolume(volume: number): void {
    this._silent.vocals = volume <= 0;
    this.vocals?.setVolume(volume);
  }

  setInstrumentalVolume(volume: number): void {
    this._silent.instrumental = volume <= 0;
    this.instrumental?.setVolume(volume);
  }

  setInteract(enabled: boolean): void {
    this.vocals?.setOptions({ interact: enabled });
    this.instrumental?.setOptions({ interact: enabled });
  }

  async loadVocalsFromPath(filePath: string, startOffset = 0): Promise<void> {
    if (!this.vocals) return;
    const wasPlaying = this._isPlaying;
    const url = convertFileSrc(filePath.replace(/\\/g, "/"));

    await new Promise<void>((resolve, reject) => {
      const unsubReady = this.vocals!.on("ready", () => {
        unsubReady();
        unsubError();
        resolve();
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unsubError = this.vocals!.on("error", (err: any) => {
        unsubReady();
        unsubError();
        reject(new Error(err?.message ?? String(err)));
      });
      this.vocals!.load(url);
    });

    this._vocalsOffset = startOffset;
    this._vocalsDuration = this.vocals!.getDuration();

    // Re-sync to instrumental's current position (with the new offset applied)
    if (this.instrumental) {
      this._seekVocals(this.instrumental.getCurrentTime());
      if (wasPlaying) this.vocals!.play();
    }
  }

  async loadTakeTrack(filePath: string, container: HTMLElement, startOffset = 0, audioOffset = 0, manualOffset = 0): Promise<void> {
    this.take?.destroy();
    this.take = null;

    const wasPlaying = this._isPlaying;
    const url = convertFileSrc(filePath.replace(/\\/g, "/"));

    this.take = WaveSurfer.create({
      height: 80,
      waveColor: "#ff8c1e",
      progressColor: "#ff8c1e",
      cursorColor: "#ff8c1e",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
      hideScrollbar: true,
      autoScroll: false,
      autoCenter: false,
      container,
      url,
    });

    await new Promise<void>((resolve, reject) => {
      const unsubReady = this.take!.on("ready", () => { unsubReady(); unsubError(); resolve(); });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unsubError = this.take!.on("error", (err: any) => {
        unsubReady(); unsubError();
        console.error("[engine] WaveSurfer take load failed — url:", url, "raw err:", err);
        reject(new Error(err?.message || err?.toString?.() || "WaveSurfer load error"));
      });
    });

    if (this._lastOutputDeviceId) {
      await this.take.setSinkId(this._lastOutputDeviceId).catch((e) =>
        console.warn("[engine] setSinkId on take failed:", e)
      );
    }
    this.take.setPlaybackRate(this._lastPlaybackRate);

    this._takeOffset       = startOffset;
    this._takeDuration     = this.take.getDuration();
    this._takeAudioOffset  = audioOffset;
    this._takeManualOffset = manualOffset;
    this._takeContainer    = container;

    // Constrain the container to the correct time window so the waveform
    // lines up visually with the other tracks (vocals, instrumental),
    // in absolute pixels derived from the current zoom/scroll — not a
    // fraction of the container, which only worked while zoom was fixed
    // at "whole song fills the container".
    this._resizeTakeTrack();

    this.take.on("interaction", (newTime) => {
      const instrTime = newTime - this._takeAudioOffset + this._takeOffset + this._takeManualOffset;
      const instrProgress = Math.max(0, Math.min(1, instrTime / this._duration));
      this.instrumental?.seekTo(instrProgress);
      this._seekVocals(instrTime);
    });

    this._takeIsPlaying = false;
    if (this.instrumental) {
      const instrTime = this.instrumental.getCurrentTime();
      this._seekTake(instrTime);
      const takeStart = this._takeOffset + this._takeManualOffset;
      const takeEnd = takeStart + this._takeDuration - this._takeAudioOffset;
      if (wasPlaying && instrTime >= takeStart && instrTime < takeEnd) {
        this.take.play();
        this._takeIsPlaying = true;
      }
    }
  }

  // Live drag preview and commit: repositions the take track visually and
  // keeps playback/seek aligned, without touching the Zustand store.
  setTakeManualOffset(offset: number): void {
    this._takeManualOffset = offset;
    this._resizeTakeTrack();
    this._seekTake(this.getCurrentTime());
  }

  setTakeVolume(volume: number): void {
    this.take?.setVolume(volume);
  }

  clearTakeTrack(): void {
    this.take?.destroy();
    this.take = null;
    this._takeOffset = 0;
    this._takeDuration = 0;
    this._takeAudioOffset = 0;
    this._takeManualOffset = 0;
    this._takeIsPlaying = false;
    this._takeContainer = null;
  }

  // ─── Timeline zoom/pan ──────────────────────────────────────────────────

  private _allInstances(): WaveSurfer[] {
    return [this.vocals, this.instrumental, this.take].filter((ws): ws is WaveSurfer => ws !== null);
  }

  // Dynamic lower zoom bound: the minPxPerSec at which the whole song
  // exactly fills the current container width (today's implicit
  // fillParent-equivalent baseline).
  getMinPxPerSec(): number {
    const ref = this.instrumental ?? this.vocals;
    if (!ref || this._duration <= 0) return 1;
    const w = ref.getWidth();
    return w > 0 ? w / this._duration : 1;
  }

  zoomAll(minPxPerSec: number, scrollTime: number): void {
    this._minPxPerSec = minPxPerSec;
    this._scrollTime = scrollTime;
    for (const ws of this._allInstances()) {
      ws.zoom(minPxPerSec);
      ws.setScrollTime(scrollTime);
    }
    this._resizeTakeTrack();
  }

  setScrollAll(scrollTime: number): void {
    this._scrollTime = scrollTime;
    for (const ws of this._allInstances()) ws.setScrollTime(scrollTime);
    this._resizeTakeTrack();
  }

  // Marks the moment of a user-driven wheel zoom/pan, so the auto-follow
  // logic in the rAF tick doesn't immediately override a deliberate
  // manual pan/zoom on the very next frame.
  noteManualScrollInteraction(): void {
    this._lastManualScrollAt = performance.now();
  }

  onScrollChange(cb: ScrollChangeCallback): void {
    this._scrollUpdateCb = cb;
  }

  private _resizeTakeTrack(): void {
    if (!this.take || !this._takeContainer || this._duration <= 0 || this._takeDuration <= 0) return;
    const playableDur = this._takeDuration - this._takeAudioOffset;
    const widthPx  = Math.round(playableDur * this._minPxPerSec);
    const marginPx = Math.round((this._takeOffset + this._takeManualOffset - this._scrollTime) * this._minPxPerSec);
    this._takeContainer.style.marginLeft = `${marginPx}px`;
    this._takeContainer.style.width      = `${widthPx}px`;
    this.take.setOptions({ width: widthPx });
  }

  // ─── Free Exercise: loaded-track playback (independent of vocals/instrumental/take) ───

  async loadExerciseTrack(filePath: string, container: HTMLElement): Promise<void> {
    this.exerciseTrack?.destroy();
    this.exerciseTrack = null;

    const url = convertFileSrc(filePath.replace(/\\/g, "/"));

    this.exerciseTrack = WaveSurfer.create({
      height: 80,
      waveColor: "#ff8c1e",
      progressColor: "#ff8c1e",
      cursorColor: "#ff8c1e",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
      container,
      url,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const unsubReady = this.exerciseTrack!.on("ready", () => { unsubReady(); unsubError(); resolve(); });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const unsubError = this.exerciseTrack!.on("error", (err: any) => {
          unsubReady(); unsubError();
          console.error("[engine] WaveSurfer exercise track load failed — url:", url, "raw err:", err);
          reject(new Error(err?.message || err?.toString?.() || "WaveSurfer load error"));
        });
      });
    } catch (e) {
      // A left-over errored instance would otherwise keep getCurrentTime()'s
      // exerciseTrack branch active (see below), silently corrupting the
      // timer for any recording started afterward without a successful load.
      this.exerciseTrack?.destroy();
      this.exerciseTrack = null;
      throw e;
    }

    // Guard: clearExerciseTrack()/destroy() may have run during the await.
    if (!this.exerciseTrack) return;

    if (this._lastOutputDeviceId) {
      await this.exerciseTrack.setSinkId(this._lastOutputDeviceId).catch((e) =>
        console.warn("[engine] setSinkId on exerciseTrack failed:", e)
      );
    }

    this.exerciseTrack.on("interaction", (newTime) => {
      this.seekExerciseTrack(newTime);
    });

    this.exerciseTrack.on("finish", () => {
      this._isPlaying = false;
      this._stopTimeUpdate();
      this._finishCb?.();
    });
  }

  playExerciseTrack(): void {
    if (!this.exerciseTrack) return;
    this.exerciseTrack.play();
    this._isPlaying = true;
    this._startTimeUpdate();
  }

  pauseExerciseTrack(): void {
    if (!this.exerciseTrack) return;
    this.exerciseTrack.pause();
    this._isPlaying = false;
    this._stopTimeUpdate();
  }

  seekExerciseTrack(time: number): void {
    if (!this.exerciseTrack) return;
    const dur = this.exerciseTrack.getDuration();
    if (dur <= 0) return;
    this.exerciseTrack.seekTo(Math.max(0, Math.min(1, time / dur)));
  }

  // Frame-accurate snapshot for the Spectrogram/Short-Term Spectrum panels:
  // reuses WaveSurfer's own already-decoded buffer (no extra fetch/decode)
  // to extract a time-domain window ending at the current playhead, whether
  // the track is playing, paused, or was just scrubbed — unlike an
  // AnalyserNode, which only ever reports something while audio is actively
  // flowing through it.
  // `matchStoredFrames` reproduces how the sidecar's stored short-term spectra
  // are framed (librosa.stft center=True on a mono mixdown): the window is
  // centered on the playhead and channels are averaged, instead of trailing
  // the playhead on channel 0 only.
  getExerciseTrackSamples(windowSize: number, matchStoredFrames = false): Float32Array | null {
    if (!this.exerciseTrack) return null;
    const buffer = this.exerciseTrack.getDecodedData();
    if (!buffer) return null;
    const channels: Float32Array[] = [];
    const channelCount = matchStoredFrames ? buffer.numberOfChannels : 1;
    for (let c = 0; c < channelCount; c++) channels.push(buffer.getChannelData(c));
    const length = channels[0].length;
    const end = Math.floor(this.exerciseTrack.getCurrentTime() * buffer.sampleRate);
    const start = matchStoredFrames ? end - Math.floor(windowSize / 2) : end - windowSize;
    const out = new Float32Array(windowSize);
    for (let i = 0; i < windowSize; i++) {
      const srcIdx = start + i;
      if (srcIdx < 0 || srcIdx >= length) continue;
      let sum = 0;
      for (const ch of channels) sum += ch[srcIdx];
      out[i] = sum / channels.length;
    }
    return out;
  }

  // Mono window centered on the current song time from the song's vocals or
  // the loaded take, using the same song-time -> file-time mapping as
  // _seekVocals/_seekTake. Reads WaveSurfer's already-decoded buffer, so it
  // works while paused or scrubbed. Null when nothing is audible there (no
  // buffer yet, or the playhead is before the take starts).
  getTrackSamples(track: "vocals" | "take", windowSize: number): { samples: Float32Array; sampleRate: number } | null {
    const ws = track === "vocals" ? this.vocals : this.take;
    const buffer = ws?.getDecodedData();
    if (!buffer) return null;
    const songTime = this.getCurrentTime();
    let fileTime: number;
    if (track === "vocals") {
      fileTime = songTime - this._vocalsOffset;
    } else {
      const takeStart = this._takeOffset + this._takeManualOffset;
      if (songTime < takeStart) return null;
      fileTime = this._takeAudioOffset + (songTime - takeStart);
    }
    if (fileTime < 0) return null;
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const length = channels[0].length;
    const start = Math.floor(fileTime * buffer.sampleRate) - Math.floor(windowSize / 2);
    const samples = new Float32Array(windowSize);
    for (let i = 0; i < windowSize; i++) {
      const srcIdx = start + i;
      if (srcIdx < 0 || srcIdx >= length) continue;
      let sum = 0;
      for (const ch of channels) sum += ch[srcIdx];
      samples[i] = sum / channels.length;
    }
    return { samples, sampleRate: buffer.sampleRate };
  }

  getExerciseTrackSampleRate(): number | null {
    return this.exerciseTrack?.getDecodedData()?.sampleRate ?? null;
  }

  clearExerciseTrack(): void {
    this.exerciseTrack?.destroy();
    this.exerciseTrack = null;
    this._isPlaying = false;
    this._stopTimeUpdate();
  }

  loadInstrumentalFromPath(filePath: string): void {
    if (!this.instrumental) return;
    const url = convertFileSrc(filePath.replace(/\\/g, "/"));
    this.instrumental.load(url);
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
    // A loaded exercise track is authoritative on its own — playing it via
    // playExerciseTrack() never touches _exerciseMode (that flag is only
    // flipped by startExerciseTimer(), called from live monitoring/recording
    // paths that have no WaveSurfer instance of their own). Checking
    // _exerciseMode first meant a loaded-and-played track fell through to
    // the instrumental branch below (always null in Free Exercise), so
    // getCurrentTime() silently returned 0 for the whole session — PianoRoll
    // and PianoKeyboard read a frozen time and never appeared to advance.
    if (this.exerciseTrack) return this.exerciseTrack.getCurrentTime();
    if (this._exerciseMode) {
      const elapsed = this._isPlaying
        ? this._exerciseOffset + (performance.now() - this._exerciseStartAt) / 1000
        : this._exerciseOffset;
      return elapsed;
    }
    // Use the instrumental as the time reference — it always plays the full song.
    return this.instrumental?.getCurrentTime() ?? 0;
  }

  startExerciseTimer(): void {
    this._exerciseMode = true;
    this._exerciseOffset = 0;
    this._exerciseStartAt = performance.now();
    this._isPlaying = true;
    this._startTimeUpdate();
  }

  pauseExerciseTimer(): void {
    if (!this._exerciseMode) return;
    this._exerciseOffset += (performance.now() - this._exerciseStartAt) / 1000;
    this._isPlaying = false;
    this._stopTimeUpdate();
  }

  stopExerciseTimer(): void {
    this._exerciseMode = false;
    this._exerciseOffset = 0;
    this._exerciseStartAt = 0;
    this._isPlaying = false;
    this._stopTimeUpdate();
    this._timeUpdateCb?.(0);
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

  onFinish(cb: FinishCallback): void {
    this._finishCb = cb;
  }

  destroy(): void {
    this._stopTimeUpdate();
    this.vocals?.destroy();
    this.instrumental?.destroy();
    this.take?.destroy();
    this.exerciseTrack?.destroy();
    this.vocals = null;
    this.instrumental = null;
    this.take = null;
    this.exerciseTrack = null;
    this._isPlaying = false;
    this._duration = 0;
    this._vocalsOffset = 0;
    this._vocalsDuration = 0;
    this._takeOffset = 0;
    this._takeDuration = 0;
    this._takeAudioOffset = 0;
    this._takeIsPlaying = false;
    this._exerciseMode = false;
    this._exerciseOffset = 0;
    this._takeContainer = null;
    this._minPxPerSec = 1;
    this._scrollTime = 0;
  }

  private _startTimeUpdate(): void {
    this._stopTimeUpdate();
    const tick = () => {
      if (!this._isPlaying) return;

      const time = this.getCurrentTime();

      // Handle loop — must run every frame for accurate looping
      if (
        this._loopStart !== null &&
        this._loopEnd !== null &&
        time >= this._loopEnd
      ) {
        this.seekTo(this._loopStart);
      }

      // Take window sync: start/stop the take as the playhead enters/exits its time window
      if (this.take && this._takeDuration > 0) {
        const takeStart = this._takeOffset + this._takeManualOffset;
        const takeEnd = takeStart + this._takeDuration - this._takeAudioOffset;
        const inWindow = time >= takeStart && time < takeEnd;
        if (inWindow && !this._takeIsPlaying) {
          this.take.play();
          this._takeIsPlaying = true;
        } else if (!inWindow && this._takeIsPlaying) {
          this.take.pause();
          this._takeIsPlaying = false;
        }
      }

      if (performance.now() - this._lastDriftCheckAt >= DRIFT_CHECK_INTERVAL_MS) {
        this._lastDriftCheckAt = performance.now();
        this._correctDrift();
      }

      // Auto-follow: while zoomed in and playing, keep the playhead from
      // scrolling out of view, without fighting a just-made manual pan/zoom.
      const baseline = this.getMinPxPerSec();
      if (
        this._minPxPerSec > baseline + 1e-6 &&
        performance.now() - this._lastManualScrollAt > FOLLOW_RESUME_SUPPRESS_MS
      ) {
        const ref = this.instrumental ?? this.vocals;
        const viewportWidthPx = ref?.getWidth() ?? 0;
        if (viewportWidthPx > 0) {
          const visibleDur = viewportWidthPx / this._minPxPerSec;
          const maxScroll = Math.max(0, this._duration - visibleDur);
          const rightMargin = this._scrollTime + visibleDur * FOLLOW_MARGIN_RATIO;
          if (time > rightMargin) {
            this.setScrollAll(clamp(this._scrollTime + (time - rightMargin), 0, maxScroll));
            this._scrollUpdateCb?.(this._minPxPerSec, this._scrollTime);
          } else if (time < this._scrollTime) {
            this.setScrollAll(clamp(time - visibleDur * (1 - FOLLOW_MARGIN_RATIO), 0, maxScroll));
            this._scrollUpdateCb?.(this._minPxPerSec, this._scrollTime);
          }
        }
      }

      // Throttle store/UI notifications to ~30fps to halve React re-render rate.
      // rAF still runs at 60fps so loop detection stays frame-accurate.
      const now = performance.now();
      if (now - this._lastNotifyTime >= 33) {
        this._lastNotifyTime = now;
        this._timeUpdateCb?.(time);
      }

      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  private _correctDrift(): void {
    if (!this.vocals || !this.instrumental) return;
    const instrTime = this.instrumental.getCurrentTime();
    const vocalsTime = this.vocals.getCurrentTime();
    const expectedVocals = Math.max(0, instrTime - this._vocalsOffset);
    const vocalsActive = expectedVocals < this._vocalsDuration - DRIFT_CHECK_END_GUARD_S;
    let refTime = instrTime;

    if (vocalsActive && Math.abs(vocalsTime - expectedVocals) > DRIFT_TOLERANCE_S) {
      if (this._silent.instrumental && !this._silent.vocals) {
        refTime = vocalsTime + this._vocalsOffset;
        this.instrumental.setTime(refTime);
      } else {
        this.vocals.setTime(expectedVocals);
      }
    }

    if (this.take && this._takeIsPlaying) {
      const expectedTake = this._takeAudioOffset + Math.max(0, refTime - (this._takeOffset + this._takeManualOffset));
      if (Math.abs(this.take.getCurrentTime() - expectedTake) > DRIFT_TOLERANCE_S) {
        this.take.setTime(expectedTake);
      }
    }
  }

  private _stopTimeUpdate(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }
}
