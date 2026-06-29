# Audio Engine

**File:** `src/audio/engine.ts` — `AudioEngine` class

## Design: Three WaveSurfer Instances

The engine holds up to three WaveSurfer instances running in lockstep:

| Instance | Role |
|----------|------|
| `vocals` | Original vocals track; always loaded, never replaced |
| `instrumental` | Full backing instrumental; always the full song |
| `take` | Recorded take; loaded on demand, null when no take is selected |

The **instrumental is the time reference** for everything: duration, `getCurrentTime()`, and the `finish` event. This ensures partial takes (recorded mid-song) do not prematurely end playback.

```
instrumental.getDuration()     →  _duration (song length)
instrumental.getCurrentTime()  →  current playback position
instrumental.on("finish")      →  fires _finishCb
```

## Partial-Take Sync

Both the vocals and take WaveSurfer instances may start at a non-zero point in the song. Five fields handle the mapping:

| Field | Meaning |
|-------|---------|
| `_vocalsOffset` | Song time (seconds) where the vocals file begins |
| `_vocalsDuration` | Duration of the vocals file |
| `_takeOffset` | Song time (seconds) where the take file begins |
| `_takeDuration` | Duration of the take file |
| `_takeAudioOffset` | Seconds to skip into the audio file before the audible content starts (latency compensation) |

`_seekVocals` / `_seekTake` convert a song-time to a file-time before calling `seekTo`:

```ts
private _seekTake(instrTime: number): void {
  const dur = this._takeDuration > 0 ? this._takeDuration : this._duration;
  const takeTime = this._takeAudioOffset + Math.max(0, instrTime - this._takeOffset);
  this.take.seekTo(Math.min(1, takeTime / dur));
}
```

`_takeAudioOffset` is non-zero when the singer recorded from the very start of the song (position 0) with a calibrated latency compensation that would push `startPosition` below zero. The audio file contains that many seconds of silence at the front that must be skipped on every seek.

## Take Track Visual Alignment

`loadTakeTrack(filePath, container, startOffset, audioOffset)` positions the WaveSurfer container so it lines up visually with the other tracks. After the `"ready"` event:

```ts
const railWidth   = container.offsetWidth;
const playableDur = this._takeDuration - audioOffset;    // exclude the silent prefix
const widthPx     = Math.round((playableDur / this._duration) * railWidth);
const marginPx    = Math.round((startOffset / this._duration) * railWidth);
container.style.marginLeft = `${marginPx}px`;
container.style.width      = `${widthPx}px`;
this.take.setOptions({ width: widthPx });                // forces WaveSurfer to redraw
```

`setOptions({ width })` is required because WaveSurfer renders its canvas at creation time and does not reliably redraw via ResizeObserver when the container CSS is changed after the fact.

## Click-to-Seek Sync

WaveSurfer's `"interaction"` event fires only on user clicks (not programmatic `seekTo`). The engine cross-links all three waveforms:

- Click on vocals → convert vocals-file-time to song-time, seek instrumental + take
- Click on instrumental → call `_seekVocals` + `_seekTake`
- Click on take → convert take-file-time to song-time, seek instrumental + vocals

The older `"seeking"` event (HTML5 proxied) caused an infinite async loop: each `seekTo()` triggered another `"seeking"` event on the other instance. `"interaction"` does not have this problem.

## Seek Lock (Recording)

`setInteract(enabled: boolean)` toggles WaveSurfer's `interact` option on both the vocals and instrumental instances. Called with `false` when recording starts, `true` when recording stops.

The Zustand `seek` action adds a second guard:

```ts
seek: (time) => {
  if (get().isRecording) return;
  ...
}
```

## Take Window Sync

The take WaveSurfer instance is started and stopped automatically as the playhead enters and exits its audible window. The window end accounts for `_takeAudioOffset` — the silent prefix is not part of the audible content:

```ts
const takeEnd  = this._takeOffset + this._takeDuration - this._takeAudioOffset;
const inWindow = time >= this._takeOffset && time < takeEnd;
if (inWindow && !this._takeIsPlaying)  { this.take.play();  this._takeIsPlaying = true;  }
if (!inWindow && this._takeIsPlaying)  { this.take.pause(); this._takeIsPlaying = false; }
```

`play()` applies the same check before calling `take.play()` — so pressing Play from time 0 when the take starts at e.g. 30 s will not start the take immediately; the rAF tick starts it when the playhead reaches 30 s.

`pause()` and `clearTakeTrack()` always reset `_takeIsPlaying = false`.

## Time Update Loop

`_startTimeUpdate()` runs a `requestAnimationFrame` loop at 60 fps. Three concerns are handled in each tick:

- **Loop detection** — checked every frame for accurate loop-point enforcement
- **Take window sync** — transitions `_takeIsPlaying` on every frame (see above)
- **UI notifications** — throttled to ~30 fps (33 ms gate) via `_lastNotifyTime`, halving React re-render rate

## Output Device Routing

`setOutputDevice(deviceId)` calls WaveSurfer's `setSinkId()` on all three instances (vocals, instrumental, take). On Windows with WebView2, specifying `""` routes audio to the current Windows default output device (which may change when a microphone is opened — see [Recording Flow](recording-flow.md)).

## `loadTakeTrack` / `clearTakeTrack`

`loadTakeTrack(filePath, container, startOffset, audioOffset)` creates the take WaveSurfer instance inside a given DOM container, waits for `"ready"`, then sizes and positions the container proportionally. `clearTakeTrack()` destroys the instance and resets all four take fields (`_takeOffset`, `_takeDuration`, `_takeAudioOffset`, `_takeIsPlaying`). Called from `Waveform.tsx` whenever `activeTakeId` changes.

## `loadVocalsFromPath`

Async method that reloads the vocals WaveSurfer instance with a different audio file without destroying the instrumental. Used for **transpose** only — load pitch-shifted WAV after Python processing. After loading, it re-syncs the vocals position to the instrumental's current time.

## Exercise Timer Mode

When no song is loaded (Free Exercise page), the engine runs in **exercise timer mode** — no WaveSurfer instances, just a `performance.now()` clock.

Private fields:

| Field | Meaning |
|-------|---------|
| `_exerciseMode` | `true` while the exercise timer is active |
| `_exerciseStartAt` | `performance.now()` at the last `startExerciseTimer()` / resume |
| `_exerciseOffset` | Accumulated elapsed seconds before the last pause |

`getCurrentTime()` checks `_exerciseMode` first:

```ts
if (this._exerciseMode) {
  const elapsed = this._isPlaying
    ? this._exerciseOffset + (performance.now() - this._exerciseStartAt) / 1000
    : this._exerciseOffset;
  return elapsed;
}
```

The rAF tick is **unchanged** — it still runs via `_startTimeUpdate()` and fires `_timeUpdateCb` on the same 30 fps throttle. PianoRoll, DualTuner, and the timer display in `ExercisePage` all read through `getEngine().getCurrentTime()` and need no modification.

| Method | Description |
|--------|-------------|
| `startExerciseTimer()` | Sets `_exerciseMode=true`, captures `_exerciseStartAt`, starts rAF tick |
| `pauseExerciseTimer()` | Saves offset, stops rAF tick |
| `stopExerciseTimer()` | Resets all fields, stops rAF tick, fires `_timeUpdateCb(0)` to reset display |
