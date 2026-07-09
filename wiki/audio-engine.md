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

`loadTakeTrack(filePath, container, startOffset, audioOffset)` positions the WaveSurfer container so it lines up visually with the other tracks. The container is retained as `_takeContainer` and re-positioned by `_resizeTakeTrack()` (private) — called after load, and again from `zoomAll`/`setScrollAll` whenever zoom or scroll changes:

```ts
private _resizeTakeTrack(): void {
  const playableDur = this._takeDuration - this._takeAudioOffset;   // exclude the silent prefix
  const widthPx  = Math.round(playableDur * this._minPxPerSec);
  const marginPx = Math.round((this._takeOffset - this._scrollTime) * this._minPxPerSec);
  this._takeContainer.style.marginLeft = `${marginPx}px`;
  this._takeContainer.style.width      = `${widthPx}px`;
  this.take.setOptions({ width: widthPx });                         // forces WaveSurfer to redraw
}
```

This used to compute `widthPx`/`marginPx` as a ratio of `container.offsetWidth` to `_duration`, which only worked because the whole song always filled the container width (no zoom existed). Once [timeline zoom/pan](#timeline-zoompan) made that untrue, the basis had to change to absolute pixels derived from `_minPxPerSec`/`_scrollTime` — the same formula naturally also handles panning, since scrolling the window is just a shift of `_scrollTime`.

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

## Timeline Zoom/Pan

Ctrl+wheel zooms the waveform timeline continuously, centered on the mouse cursor's time position; shift+wheel pans the visible window without changing zoom. Neither WaveSurfer's zoom plugin nor its `interact`/`dragToSeek` options are involved — this is a custom `wheel` listener in `Waveform.tsx` (see [Components: Waveform](components.md#waveform)) driving WaveSurfer 7's own core zoom/scroll primitives (`ws.zoom()`, `ws.setScrollTime()`, `ws.getWidth()`), applied to every mounted instance at once.

State lives in two engine fields, mirrored into the player store (`minPxPerSec`, `scrollTime`) so `TimeRuler` and `PunchOverlay` can stay aligned:

| Field | Meaning |
|-------|---------|
| `_minPxPerSec` | Current zoom level, in WaveSurfer's own pixels-per-second unit |
| `_scrollTime` | Song time (seconds) at the left edge of the visible window |

```ts
getMinPxPerSec(): number {              // dynamic lower zoom bound — "whole song fits"
  const ref = this.instrumental ?? this.vocals;
  return ref && this._duration > 0 ? ref.getWidth() / this._duration : 1;
}

zoomAll(minPxPerSec, scrollTime): void {       // ctrl+wheel
  for (const ws of this._allInstances()) { ws.zoom(minPxPerSec); ws.setScrollTime(scrollTime); }
  this._resizeTakeTrack();
}

setScrollAll(scrollTime): void {               // shift+wheel, resize reclamp, auto-follow
  for (const ws of this._allInstances()) ws.setScrollTime(scrollTime);
  this._resizeTakeTrack();
}
```

The lower zoom bound is computed on demand from live container width rather than stored, since it changes across a window resize. `loadSong` calls `zoomAll(getMinPxPerSec(), 0)` once at load — this makes the pre-existing implicit "whole song fills the container" behavior an explicit zoom-level-1 baseline, so nothing changes visually for anyone who never touches ctrl/shift+wheel.

**No new cross-instance sync event is needed** (unlike `"interaction"` for playhead sync above) — zoom/pan is driven top-down: the wheel handler computes `{minPxPerSec, scrollTime}` once and `zoomAll`/`setScrollAll` sets every instance synchronously, so there's no async race to guard against.

**Lockstep prerequisites:** every `WaveSurfer.create()` call now passes `hideScrollbar: true, autoScroll: false, autoCenter: false`. `hideScrollbar` prevents a user from dragging one instance's own internal scrollbar directly (which would fire that instance's `"scroll"` event with nothing syncing it to the others, by design — see above). `autoScroll`/`autoCenter` default `true` in WaveSurfer and would let each instance auto-follow its own playhead independently; since per-instance `<audio>` clocks aren't frame-identical, that would visibly micro-desync the rows while zoomed in and playing.

**Auto-follow while playing:** with per-instance auto-scroll disabled, something has to keep the playhead in view while zoomed in and playing — that's a block inside the existing `_startTimeUpdate()` rAF tick (see below), not a new loop. It nudges `_scrollTime` forward once the playhead crosses 85% of the visible window (`FOLLOW_MARGIN_RATIO`, in `src/lib/zoomPan.ts`), or snaps the window to include the playhead if a seek/loop jump lands it behind the window. A manual ctrl/shift+wheel action (`noteManualScrollInteraction()`, called from the wheel handler) suppresses auto-follow for 800ms (`FOLLOW_RESUME_SUPPRESS_MS`) afterward — otherwise a shift+wheel pan during playback would get overridden by auto-follow on the very next animation frame.

`onScrollChange(cb)` registers a callback the player store uses to mirror engine-initiated scroll changes (auto-follow, resize reclamp) back into Zustand — the wheel handler updates the store directly since it already has the new values, but auto-follow runs inside the engine with no store access of its own.

The zoom-to-cursor and pan math itself (exponential zoom factor, bounds clamping) is pure and lives in `src/lib/zoomPan.ts` — see [Components: Waveform](components.md#waveform) for the wheel-handler wiring and the exact formulas.

## Output Device Routing

`setOutputDevice(deviceId)` calls WaveSurfer's `setSinkId()` on all three instances (vocals, instrumental, take). On Windows with WebView2, specifying `""` routes audio to the current Windows default output device (which may change when a microphone is opened — see [Recording Flow](recording-flow.md)).

## `loadTakeTrack` / `clearTakeTrack`

`loadTakeTrack(filePath, container, startOffset, audioOffset)` creates the take WaveSurfer instance inside a given DOM container, waits for `"ready"`, then sizes and positions the container proportionally. `clearTakeTrack()` destroys the instance and resets all four take fields (`_takeOffset`, `_takeDuration`, `_takeAudioOffset`, `_takeIsPlaying`). Called from `Waveform.tsx` whenever `activeTakeId` changes.

## `loadVocalsFromPath`

Async method that reloads the vocals WaveSurfer instance with a different audio file without destroying the instrumental. Used for **transpose** only — load pitch-shifted WAV after Python processing. After loading, it re-syncs the vocals position to the instrumental's current time.

## Exercise Timer Mode

When no song is loaded (Free Exercise page) and no track is loaded for playback, the engine runs in **exercise timer mode** — no WaveSurfer instance, just a `performance.now()` clock, used while live-recording/monitoring.

Private fields:

| Field | Meaning |
|-------|---------|
| `_exerciseMode` | `true` while the exercise timer is active |
| `_exerciseStartAt` | `performance.now()` at the last `startExerciseTimer()` / resume |
| `_exerciseOffset` | Accumulated elapsed seconds before the last pause |

`getCurrentTime()` checks `_exerciseMode` first, and within it prefers a loaded `exerciseTrack` over the stopwatch:

```ts
if (this._exerciseMode) {
  if (this.exerciseTrack) return this.exerciseTrack.getCurrentTime();
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

## Free Exercise Track Playback

Loading a past `ExerciseTake` or an imported external file for post-hoc inspection uses a **fourth, independent WaveSurfer slot**, `exerciseTrack`, deliberately kept separate from the `vocals`/`instrumental`/`take` trio — those three are gated on `vocals && instrumental` being loaded (a song context), which never applies in Free Exercise.

| Method | Description |
|--------|-------------|
| `loadExerciseTrack(filePath, container)` | Creates the WaveSurfer instance, awaits `"ready"`/`"error"`. On error, destroys and nulls `exerciseTrack` before rethrowing — a left-over errored instance would otherwise keep `getCurrentTime()`'s `exerciseTrack` branch active, corrupting the timer for any recording started afterward |
| `playExerciseTrack()` / `pauseExerciseTrack()` | Ungated play/pause; sets `_isPlaying` and starts/stops the rAF tick, same as the timer methods above |
| `seekExerciseTrack(time)` | Seeks by `time / getDuration()` progress ratio |
| `clearExerciseTrack()` | Destroys and nulls the instance |
| `getExerciseTrackSamples(windowSize)` | Returns a `Float32Array` window of raw samples ending at the current playhead, read directly from WaveSurfer's own already-decoded buffer (`exerciseTrack.getDecodedData()` — no extra fetch/decode). Powers the Spectrogram/Short-Term Spectrum panels' frame-accurate snapshot: unlike a live `AnalyserNode`, this works whether the track is playing, paused, or was just scrubbed, since it reads decoded PCM directly rather than data flowing through a live audio graph |
| `getExerciseTrackSampleRate()` | The decoded buffer's sample rate, or `null` if nothing is loaded |

An earlier iteration tapped a `MediaElementAudioSourceNode` off `exerciseTrack.getMediaElement()` to get a live-playback `AnalyserNode` (mirroring `getMicAnalyser()`). That was replaced by the buffer-snapshot approach above — it avoids the Web Audio media-element tap (a nontrivial cross-browser risk, and a media element tolerates only one such tap ever) and, more importantly, actually satisfies the point of the feature: inspecting a specific paused/scrubbed frame, which a live analyser cannot do since it only reports data while audio is actively playing.
