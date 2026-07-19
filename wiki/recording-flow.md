# Recording Flow

**Key files:** `src/audio/recorder.ts` · `src/stores/player.ts`

## Overview

Recording is initiated by the user clicking the record button. The flow is carefully sequenced to work around Windows WASAPI audio routing behavior.

## Punch-in / Punch-out Region

The `TimeRuler` (canvas strip above the waveforms) is the punch region selector:

| Gesture | Action |
|---------|--------|
| **Click + drag** on empty ruler | Draw a new punch region |
| **Click + drag on In handle** (±12 px) | Move only the In boundary; Out stays fixed |
| **Click + drag on Out handle** (±12 px) | Move only the Out boundary; In stays fixed |
| **Click** (drag < 0.5 s) | Clear the punch region and reset loop toggle |

The cursor changes to `ew-resize` when hovering over a handle and `crosshair` elsewhere. The ruler and track overlays are read-only during recording.

The loop toggle itself is **not** a ruler button — it's `LoopButton.tsx` (`src/components/player/`), rendered next to `TransportControls` in `PracticeRoom.tsx`'s topbar (see `wiki/components.md#loopbutton`). It used to be an in-ruler `⟳` button (duplicated once more on `PianoRoll`'s own ruler); both were removed in favor of one button beside play/stop, 2026-07-10.

Punch state in the player store (memory only, not persisted):

| Field | Type | Meaning |
|-------|------|---------|
| `punchIn` | `number \| null` | Region start (seconds) |
| `punchOut` | `number \| null` | Region end (seconds) |
| `punchLoop` | `boolean` | Loop the region during playback |

### Playback with a Punch Region

When `punchIn` is set, pressing **Play** always seeks to `punchIn` first (`togglePlay` routes through the store `play()` action so the seek always applies).

`onTimeUpdate` handles what happens when `punchOut` is reached:

```ts
if (punchOut !== null && time >= punchOut) {
  if (isRecording)       → stopRecording()           // save take
  else if (punchLoop)    → eng.seekTo(punchIn) + clearLivePitch()  // loop: jump back
  else                   → pause + seekTo(punchIn)    // stop and rewind
}
```

**Monitor trace on loop:** the `punchLoop` branch also clears `useAnalysisStore`'s `livePitch` on every jump back to `punchIn`, so a monitored pitch trace on the piano roll restarts fresh each pass through the loop instead of overlaying every previous pass into one smear. This is on top of (not a replacement for) the pause/stop clearing described in `wiki/components.md`'s [DualTuner](components.md#dualtuner) section — looping keeps `isPlaying` continuously true so those guards don't fire on their own here.

## getUserMedia Constraints

Both recording and monitoring use identical hard constraints — `{ exact: false }` rather than plain `false`, because Chrome treats plain `false` as a preference that the driver can override silently:

```ts
navigator.mediaDevices.getUserMedia({
  audio: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: { exact: false },
    noiseSuppression: { exact: false },
    autoGainControl: { exact: false },
    channelCount: 1,
    sampleRate: 44100,
  },
  video: false,
});
```

After a successful open, `stream.getAudioTracks()[0].getSettings()` is logged to confirm the browser honored all three DSP constraints. If the device cannot satisfy `exact: false` the call rejects — which is the desired behaviour (fail loudly rather than silently apply DSP that would corrupt the spectrogram).

## startRecording Sequence

```
0. if (isMonitoring) stopMonitoring()   stop monitor stream first
1. recordingStartPos = punchIn ?? currentTime  use punch-in if set
2. eng.pause()                          pause playback
3. rec.init(selectedDeviceId)           getUserMedia — mic opens here
4. Enumerate output devices             find real hardware output
5. eng.setOutputDevice(outputId)        pin audio away from Communications endpoint
6. eng.setInteract(false)              lock waveform click-to-seek
7. eng.seekTo(recordingStartPos)        rewind to start (or punch-in) position
8. eng.play()                           start playback (vocals + instrumental both audible)
9. rec.start()                          start MediaRecorder
```

`getUserMedia` must be called **before** `eng.play()`. On Windows WASAPI, opening the mic reconfigures the audio session; if playback is already running it can cause `NotReadableError`.

The singer hears **both** original vocals and instrumental during recording — volumes are individually controlled via the Vocals and Instrumental sliders. There is no mic monitoring passthrough (hardware direct-monitoring on the audio interface is recommended instead).

### Punch-out Boundary Check

`loadSong` wires an `onTimeUpdate` check at ~30 fps. `eng.stop()` inside `stopRecording` halts the rAF loop so the check cannot double-fire after a recording stop. For the playback-loop case, `eng.seekTo` is synchronous and the next `onTimeUpdate` tick fires at the new position.

## stopRecording Sequence

```
1. eng.stop()                                 stop playback, seek to 0
2. eng.setInteract(true)                     unlock waveform
3. blob = await rec.stop()                   drain MediaRecorder chunks
4. rec.releaseStream()                       stop mic tracks → Windows exits comm mode
5. eng.setOutputDevice(selectedOutput)       restore normal output routing
6. saveTake(songId, blob, startPos, offset)  write take to disk via Tauri
7. set state: isRecording=false, activeTakeId=take.id
```

During `save_take`, the sidecar `analyze` step also **RMS-normalizes the take's loudness against `vocals.wav`** (peak-capped) and the normalized `{takeId}.wav` replaces the raw `.webm` on disk — see [Python Sidecar](python-sidecar.md#analyze). This is why takes match the mastered Demucs stems' loudness without touching the take volume slider.

Setting `activeTakeId` triggers the `Waveform` component to call `eng.loadTakeTrack()`, which loads the take as a third, separate waveform track alongside vocals and instrumental.

## Windows WASAPI: Default Communications Device

Windows maintains two "default" audio endpoints:

- **Default Device** — used for music, games, normal audio
- **Default Communications Device** — used for voice calls, WebRTC

When `getUserMedia` opens a microphone, Windows silently switches the `""` sinkId alias to point to the **Communications** endpoint. In most setups this is a different physical port than regular speakers/headphones, causing silence during recording.

### Auto-detection of Real Output

After `getUserMedia`, the store enumerates output devices and picks the real hardware output:

1. **Filter out aliases** — exclude labels starting with `"Default -"` or `"Communications -"` and virtual devices (e.g., Steam Streaming Speakers)
2. **Match mic interface** — prefer the output whose label shares a token ≥4 characters with the selected microphone label (e.g., `"BEHRINGER"` in both `"Line In (2-Behringer USB WDM Audio)"` and `"Speakers (2-Behringer USB WDM Audio)"`)
3. **Fallback** — first non-alias, non-virtual output if no match found
4. **User override** — if `selectedOutputDeviceId` is set explicitly, it takes priority

### Releasing Communication Mode

After recording, `rec.releaseStream()` stops all mic tracks:

```ts
releaseStream(): void {
  this.stream?.getTracks().forEach((t) => t.stop());
  this.stream = null;
}
```

Stopping mic tracks signals Windows to exit communication mode and restore the `""` sinkId alias back to the Default Device. `setOutputDevice("")` is then called to flush any pinned sinkId from the audio elements.

## Seek Lock During Recording

DAWs (e.g., Cakewalk) prevent the user from repositioning the playhead while recording to guarantee sync. VPS does the same via two mechanisms:

1. `eng.setInteract(false)` — disables WaveSurfer waveform click-to-seek
2. `if (get().isRecording) return` guard in the Zustand `seek` action

The stop button is also rerouted during recording:

```tsx
// TransportControls.tsx
<button onClick={isRecording ? () => void stopRecording() : stop}>
```

## Latency Compensation

The singer hears the instrumental with a monitoring delay (typically 50–300 ms on USB WASAPI interfaces). To compensate, the recorded audio is shifted back in time by the measured round-trip latency.

### Compensation source (priority order)

1. **Calibrated offset** (preferred) — if the selected input device has a value stored in `recordingOffsets` (set by the click-clap calibration flow), that value is used as-is and the AudioContext measurement is skipped entirely.
2. **AudioContext estimate** (fallback) — when no calibration exists, `new AudioContext({ sinkId: outputId }).outputLatency + baseLatency` is measured against the exact output device in use, plus the mic track's `getSettings().latency`.

### startPosition vs audioOffset

The compensated start position is:

```ts
const rawCompensated = recordingStartPos - _recordingLatencyS;
const compensatedStartPos = Math.max(0, rawCompensated);
const audioOffset = rawCompensated < 0 ? -rawCompensated : 0;
```

| Situation | startPosition | audioOffset |
|-----------|---------------|-------------|
| Recording starts at 30 s, latency 256 ms | 29.744 | 0 |
| Recording starts at 0 s, latency 256 ms | 0 | 0.256 |

When `audioOffset > 0` the engine seeks 0.256 s into the audio file when the playhead is at position 0, and Python's `librosa.load(offset=audioOffset)` skips those seconds during analysis so pitch/onset times are 0-based and correctly aligned with the song.

## Per-Device Calibration

`RecordingOffsetControl` (shown in home page settings) provides automatic calibration per input device:

1. Plays 4 count-in clicks then 8 measured clicks at 60 BPM through the selected output
2. Records the mic with `MediaRecorder`
3. Detects each click's arrival in the recording via RMS envelope peak detection
4. Computes the median clap-vs-expected offset → stored in `recordingOffsets[deviceId]` (persisted to `localStorage`)

The calibrated value represents the full round-trip (output + input) latency measured through the actual signal chain. Focusrite Scarlett / Behringer UM2 typically measure 200–300 ms in WASAPI shared mode.

### Calibration entry schema

Each `recordingOffsets` entry is a `CalibrationEntry` (`player.ts`), still keyed by input `deviceId` and persisted to `localStorage`:

```ts
interface CalibrationEntry {
  offset: number;           // ms
  stale?: boolean;          // set by device-change invalidation
  madMs?: number;           // clap-spread MAD; absent for manual entries
  outputDeviceId?: string;  // output device active at calibration time
}
```

Legacy plain-number entries are migrated on load (`n → { offset: n }`). Manually typed offsets are stored bare (no `madMs`/`outputDeviceId`), which also clears a stale flag.

### Staleness and invalidation

A stored calibration measures one specific input+output hardware path, so it is invalidated — marked `stale: true`, never deleted — when that path changes:

- A `devicechange` listener (registered from `fetchAudioDevices`) re-enumerates devices and, only if the device set actually changed, marks stale any entry whose input device or recorded `outputDeviceId` is no longer present.
- At `startRecording`, an entry is only used if it is not stale **and** its `outputDeviceId` matches the output actually in use (entries without `outputDeviceId` — manual or legacy — are exempt from the output check). Otherwise the AudioContext fallback runs and `usedLatencyFallback` is set; recording is never blocked.
- When the active mic's calibration is stale or missing, `RecordingOffsetControl` shows a non-blocking "recalibrate?" banner that triggers the normal Cal flow.

### Measurement confidence

The wizard computes the MAD (median absolute deviation) of the detected clap offsets alongside the median and stores it as `madMs`. Classification (constants at the top of `RecordingOffsetControl.tsx`):

| MAD | Confidence |
|---|---|
| ≤ 5 ms | high |
| 5–15 ms | medium |
| > 15 ms | low |

A confidence chip is shown next to the calibrated value and in the result banner; low confidence adds a hint to re-run in a quieter room. Low-confidence values are never auto-discarded — applying them is the user's call.

### Sanity bounds

A measurement is rejected (error state, nothing persisted, any previous offset untouched) when the median is negative, exceeds 500 ms (`MAX_OFFSET_MS`, the manual input's range), or fewer than 5 of the 8 measurement claps produced a detected onset (`MIN_DETECTED_CLAPS`). Rejected raw values are logged via `console.debug("[calibration] rejected: …")`.

### Drift-check instrumentation

On stop, takes longer than 90 s log `[drift-check] takeDuration=…s input=… output=…` via `console.info`. This is diagnostics only — no drift is measured or corrected — so future misalignment reports can be correlated with take length before deciding whether within-take clock drift correction is warranted.

## startPosition Field

When recording begins at a non-zero position, `recordingStartPos` is saved. After latency compensation it is passed to `saveTake` as `startPosition`. The audio engine uses this offset when playing back the take to align it with the instrumental — see `_takeOffset` and `_takeAudioOffset` in [Audio Engine](audio-engine.md).

If the auto-detected alignment above is still slightly off, the user can drag the take into sync manually afterward — see [Audio Engine: Manual Take Sync](audio-engine.md#manual-take-sync) and [Components: Take Sync Controls](components.md#take-sync-controls). This is a **separate, post-recording adjustment** (`manualOffset`), layered additively on top of `startPosition`/`audioOffset` rather than part of this recording pipeline — nothing in `startRecording`/`stopRecording` reads or writes it.

## MediaRecorder Codec Fallback

WebView2 may not support `audio/webm;codecs=opus`. The recorder tries codecs in order:

```ts
const mimeType = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
```

If none are supported, `MediaRecorder` is created without an explicit `mimeType` and uses the browser default.

## Live Monitoring (no recording)

`startMonitoring()` opens the microphone and feeds real-time pitch into the piano roll, piano keyboard, and DualTuner — identical to what happens during recording but without MediaRecorder or file saving.

### startMonitoring sequence

```
1. getUserMedia(selectedDeviceId)       open mic stream (stored in module-level monitorStream ref)
2. enumerateDevices()                   refresh audioDevices with labels now that permission is granted
3. Enumerate output devices             find real hardware output (same WASAPI fix as recording)
4. eng.setOutputDevice(outputId)        pin audio away from Communications endpoint
5. if exerciseMode: eng.startExerciseTimer()   advance currentTime while monitoring
6. set isMonitoring = true
```

`monitorStream` is a module-level ref (not Zustand state) exported as `getMonitorStream()`. DualTuner reads it via `getMonitorStream()` — no second `getUserMedia` is ever opened.

Step 2 matters because `enumerateDevices()` returns empty labels before the first `getUserMedia` grant. Refreshing immediately lets `MicSelector` show human-readable device names (e.g. "Focusrite USB Audio") right after the first click.

### stopMonitoring sequence

```
1. monitorStream.getTracks().forEach(t.stop())   release mic
2. monitorStream = null
3. if exerciseMode: eng.stopExerciseTimer()       pause currentTime
4. eng.setOutputDevice(selectedOutputDeviceId)   restore routing
5. set isMonitoring = false
```

### Mutual exclusivity

- `startMonitoring` bails out if `isRecording` is true
- `startRecording` calls `stopMonitoring()` first if `isMonitoring` is true
- The `MonitorButton` is disabled while `isRecording`

## Auto-stop on Song End

When the instrumental finishes (`"finish"` event), the engine fires the `_finishCb`. The store checks `isRecording` and calls `stopRecording()` automatically, so the take is saved even if the singer doesn't click stop.
