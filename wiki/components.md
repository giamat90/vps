# Frontend Components

**Directory:** `src/components/`

## Component Tree

```
App
├── pages/
│   ├── LibraryPage        — song list, import, "Free Exercise" button
│   ├── PracticeRoom       — song practice (waveforms + analysis + recording)
│   └── ExercisePage       — free exercise (no song; piano roll + record)
├── upload/
│   ├── DropZone           — drag-and-drop audio file import
│   └── YouTubeImport      — paste-and-import YouTube URL
├── player/
│   ├── Waveform           — 3-track waveform display (vocals + instrumental + take), each row with mute/solo/volume controls
│   ├── TimeRuler          — canvas time ruler with drag-to-select punch region
│   ├── TransportControls  — play/pause/stop + elapsed/total time (no volume controls — those live per-track in Waveform)
│   ├── TempoControl       — BPM-first speed control (editable BPM value + editable x-rate)
│   ├── KeyTranspose       — semitone transpose UI
│   └── OutputSelector     — audio output device picker
├── recording/
│   ├── RecordButton       — start/stop recording (song practice)
│   ├── MonitorButton      — toggle live mic monitoring (no save)
│   ├── MicSelector        — input device picker (labelled "Input")
│   ├── TakeList           — list of song takes with delete
│   └── ExerciseTakeList   — list of exercise takes; click to expand audio player
├── analysis/
│   ├── DualTuner          — real-time pitch tuner (reference vs. singer)
│   ├── PianoKeyboard      — horizontal piano key strip with live/song/take highlight
│   ├── PianoRoll          — scrolling pitch ribbon display (song + take + live)
│   ├── SpectrogramPanel   — scrolling live mic spectrogram (Free Exercise only)
│   ├── ShortTermSpectrumPanel — real-time spectral snapshot of the live mic (Free Exercise)
│   ├── ShortTermSpectrumComparisonPanel — song vs. take vs. live spectral envelope overlay (PracticeRoom)
│   ├── VibratoCard        — vibrato rate / depth / regularity summary
│   ├── TimingChart        — timing deviation chart (user vs. reference onsets)
│   └── DynamicsCurve      — RMS dynamics over time
├── coaching/
│   └── CoachPanel         — AI coaching tips panel
└── updater/
    └── UpdateDialog       — auto-update modal (release notes, install/restart, progress)
```

## State Management

### Library Store (`src/stores/library.ts`)

Manages the song list, import/upload flow, and error state.

| Field | Type | Description |
|-------|------|-------------|
| `songs` | `Song[]` | All songs in the library |
| `processing` | `ProcessingStatus \| null` | Active processing job (null when idle) |
| `isLoading` | `boolean` | Initial fetch in progress |
| `error` | `string \| null` | Last friendly error message (cleared on next import attempt) |

`uploadSong(filePath, highQuality?)` and `importYoutube(url, highQuality?)` both accept an optional `highQuality` flag (default `false`), threaded straight through to the Rust commands → sidecar → `processor.process()`'s Demucs model choice (`htdemucs_ft` vs `htdemucs`). `LibraryPage` owns the toggle's state and passes it down to both `DropZone` and `YouTubeImport`.

Actions: `fetchSongs`, `uploadSong`, `importYoutube`, `deleteSong`, `clearError`, `initProgressListener`.

Both `uploadSong` and `importYoutube` set an initial `processing` state ("Preparing…" / "Connecting…" at 0%) before calling the Tauri command, eliminating the dead-time gap before the sidecar sends its first progress event.

Errors from `importYoutube` and `uploadSong` are parsed by `friendlyError()` into human-readable messages covering bot-detection, VPN/proxy blocks, private/geo-blocked videos, and network failures.

### Player Store

All player state lives in a single Zustand store: `src/stores/player.ts`.

```ts
import { usePlayerStore } from "../../stores/player";

const isPlaying = usePlayerStore((s) => s.isPlaying);
const togglePlay = usePlayerStore((s) => s.togglePlay);
```

Components subscribe to individual slices to avoid unnecessary re-renders. The store owns the `AudioEngine` and `VocalRecorder` singletons (accessed via module-level `getEngine()` / `getRecorder()` helpers, not stored in Zustand state).

**Mute/solo:** `effectiveVolume()` / `applyEffectiveVolumes()` (module-level helpers, not store actions) compute what actually gets pushed to `AudioEngine.set*Volume()` — soloing a track (`toggleSolo`) silences every other track, muting (`toggleMute`) silences only that one — but the raw `vocalsVolume` / `instrumentalVolume` / `takeVolume` slider values are never modified by either, so unmuting/unsoloing restores the exact prior slider position. `setVocalsVolume` / `setInstrumentalVolume` / `setTakeVolume` all funnel through `applyEffectiveVolumes` after updating their slice. `syncTrackVolumes` re-applies the current effective volumes and is called after `loadSong` and after a new take's WaveSurfer instance is created (`Waveform.tsx`), since a fresh WaveSurfer instance resets to `volume: 1` regardless of stored state.

## Key State Fields

| Field | Type | Description |
|-------|------|-------------|
| `song` | `Song \| null` | Currently loaded song |
| `isPlaying` | `boolean` | Playback state |
| `currentTime` | `number` | Playback position (seconds) |
| `duration` | `number` | Song length (seconds) |
| `playbackRate` | `number` | Speed multiplier (0.25–2.5) |
| `vocalsVolume` | `number` | 0–1 (raw slider value; never overwritten by mute/solo) |
| `instrumentalVolume` | `number` | 0–1 (raw slider value; never overwritten by mute/solo) |
| `mutedTracks` | `Record<TrackKey, boolean>` | Per-track mute state (`TrackKey = "vocals" \| "instrumental" \| "take"`) |
| `soloedTrack` | `TrackKey \| null` | At most one soloed track; solo overrides mute |
| `isLooping` | `boolean` | Loop mode active |
| `loopStart / loopEnd` | `number \| null` | Loop region (seconds) |
| `transpose` | `number` | Active semitone shift |
| `isTransposing` | `boolean` | Pitch-shift in progress |
| `isRecording` | `boolean` | Recording in progress |
| `isSavingTake` | `boolean` | Post-recording: blob flush + pYIN analysis in progress |
| `isMonitoring` | `boolean` | Live mic monitor active (no recording) |
| `takes` | `Take[]` | All takes for current song |
| `activeTakeId` | `string \| null` | Selected take (loads it as the take track) |
| `takeVolume` | `number` | 0–1 volume for the take track (raw slider value; never overwritten by mute/solo) |
| `punchIn` | `number \| null` | Region start (seconds); play always seeks here when set |
| `punchOut` | `number \| null` | Region end (seconds); playback stops or loops here |
| `punchLoop` | `boolean` | Loop the region during playback (cleared with the region) |
| `audioDevices` | `MediaDeviceInfo[]` | Available microphone inputs |
| `selectedDeviceId` | `string \| null` | Selected mic device ID |
| `outputDevices` | `MediaDeviceInfo[]` | Available audio outputs |
| `selectedOutputDeviceId` | `string \| null` | Selected output device ID |

### Exercise Store (`src/stores/exercise.ts`)

| Field | Type | Description |
|-------|------|-------------|
| `exerciseTakes` | `ExerciseTake[]` | All free-exercise recordings |
| `activeExerciseTakeId` | `string \| null` | Legacy expanded-take id (superseded by `loadedTrackId` below for the actual playback view) |
| `loadedTrackKind` | `"take" \| "imported" \| null` | UX copy only — both persist as an ordinary `ExerciseTake`, no separate data model for imports |
| `loadedTrackId` | `string \| null` | `ExerciseTake.id` currently loaded into `AudioEngine.exerciseTrack`, if any |
| `isImporting` | `boolean` | True while `importExerciseFile` is mid-flight (spinner state) |

Actions: `fetchExerciseTakes`, `addExerciseTake`, `deleteExerciseTake`, `setActiveExerciseTake`, `loadExerciseTakeIntoTrack(take, container)` (loads into `AudioEngine.exerciseTrack` + populates `useAnalysisStore`'s take-equivalent fields via `loadExerciseTakeAnalysis`), `clearLoadedTrack()`, `importExerciseFile(filePath, container)` (decodes duration client-side, calls the new `import_exercise_file` Tauri command, then loads the resulting take same as a recorded one).

### Updater Store (`src/stores/updater.ts`)

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"idle" \| "checking" \| "available" \| "downloading" \| "ready" \| "error"` | Update lifecycle state |
| `update` | `Update \| null` | Tauri `Update` object (version, release notes body, `downloadAndInstall()`) once found |
| `progress` | `number` | Download progress, 0..1, derived from `downloadAndInstall`'s chunk callback |
| `dismissed` | `boolean` | User clicked "Later" |

Actions: `checkForUpdates` (called once on app mount from `App.tsx`; failures are `console.warn`-logged and swallowed — a failed background check must never interrupt startup or surface as a user-facing error), `installAndRestart` (download → verify signature → silent install → `relaunch()`; failures set `status: "error"` so `UpdateDialog` can offer a retry), `dismiss`.

See [Architecture: Auto-Update](architecture.md#auto-update) for the endpoint/signing configuration this depends on.

## GUI Rule

**All dimensions must use relative units** — `%`, `rem`, `vw`, `vh`, `fr`. Never use fixed pixel values (`px`) for layout dimensions. This ensures the UI scales correctly across different screen sizes and DPI settings.

## Notable Component Details

### TransportControls

Stop button routes to `stopRecording()` during recording, `stop()` otherwise:

```tsx
<button onClick={isRecording ? () => void stopRecording() : stop}>
```

Slimmed down to play/pause/stop + elapsed/total time — volume sliders were moved onto each waveform track's own row (see `Waveform` below). Sits inside the sticky `practice-room__topbar` (see `PracticeRoom` layout).

### RecordButton

Starts recording via `startRecording()`. If recording is already active, clicking stops via `stopRecording()`. Displays a pulsing red indicator while `isRecording` is true.

### MonitorButton

Toggles live mic monitoring via `startMonitoring()` / `stopMonitoring()`. Displays a pulsing blue circle while `isMonitoring` is true. Disabled (grayed out) while `isRecording` is true. Starting a recording automatically stops monitoring first.

When monitoring is active:
- Microphone stream is opened (same `selectedDeviceId` as recording)
- Windows WASAPI output routing is pinned (same fix as `startRecording`)
- Live pitch flows into the piano roll orange ribbon, piano keyboard highlight, and DualTuner needle
- Nothing is saved — the mic stream and live pitch data are cleared on stop

### TempoControl

BPM-first speed control for playback — no mode toggle, no preset buttons. Two stacked, editable rows in `tempo-control__bpm-group` (same column-alignment pattern as the Input/Output stack — see below):

1. **BPM row** — shown only when the song has a detected BPM: `{Math.round(detectedBpm)} BPM` badge in the header (right of the "Speed" label) plus a number input for the target BPM; the playback rate is computed as `targetBpm / songBpm`.
2. **Rate row** — a number input for the raw `×` multiplier (0.25–2.5), always shown. Both inputs share the same width (`tempo-control__bpm-input`, `3.75rem`) so they align.

Editing either input recomputes and commits the other (`commitBpm` / `commitRate`) — both ultimately call `setPlaybackRate`. Enter or blur commits; invalid input reverts to the last good value. If a song has no detected BPM, only the rate row is usable.

### TimeRuler

Canvas strip above the waveform tracks (`2.8rem` tall). Shows time ticks at adaptive intervals (≥ 80 px target). Font size scales proportionally with canvas height. All ruler interaction is disabled during recording.

**Interactions:**
- **Click + drag** on empty space → draw a new punch region
- **Hover / drag near In or Out handle** (±12 px) → cursor becomes `ew-resize`; drag moves only that boundary, the other stays fixed
- **Click** (< 0.5 s drag) → clear punch region and reset loop toggle
- **⟳ button** (appears at right edge when region is set) → toggle `punchLoop`; red when active

The region is drawn as a red band on the canvas with I-beam caps at the handles. Each waveform track also shows a translucent `PunchOverlay` div (positioned via `left` / `width` percentages of the track).

### Waveform

Renders `TimeRuler` at the top, then up to three stacked tracks, each with a `.waveform__track-header` (label + `TrackControls`) above a `.waveform__track-body` (position: relative, wraps the WaveSurfer container so `PunchOverlay` can be absolutely positioned over it):

1. **Vocals** — always visible; original vocals track
2. **Instrumental** — always visible; backing track and time reference
3. **Take** — conditionally rendered when `activeTakeId` is set; orange waveform positioned at the correct time offset and proportional width using `eng.loadTakeTrack()`

**`TrackControls`** (local sub-component, one instance per row): mute button (`M`, amber `--on` state), solo button (`S`, green `--on` state), and a volume slider — wired to the player store's `toggleMute`, `toggleSolo`, and the relevant `set*Volume` action for that track. After a new take's WaveSurfer instance loads, the effect calls `syncTrackVolumes()` so the fresh instance picks up the stored effective volume instead of defaulting to full volume.

**Export Mix button:** renders the current audible mix to a WAV via the `export_mix` Tauri command (sidecar `mix_export`). `buildMixSources(state)` in the player store resolves one final linear gain per track from mute/solo/volume, includes the active take (with its `startPosition`/`audioOffset` alignment), and clamps the render window to the punch region when one is set. The button subscribes to every input `buildMixSources` reads so its enabled/disabled state stays correct; it shows "Exporting…" while the sidecar renders, then opens a native Save As dialog.

**Instrument practice tracks** (`song.kind === "instrument"`): the vocals row is relabeled "Melody" (its `vocals.wav` file is the actual practice-track audio for these songs — see [Data Model](data-model.md#song)). The instrumental row — an identical duplicate of the same audio — stays mounted (WaveSurfer needs a real container to measure) but is visually collapsed via `waveform__track--hidden` (absolute position + `height: 0`, not `display: none`, so it keeps a layout box to measure against). `loadSong` sets `mutedTracks.instrumental = true` by default for these songs so the duplicate isn't audible; the mute button still works normally if the user wants to double-check.

### MicSelector / OutputSelector

Call `fetchAudioDevices()` / `fetchOutputDevices()` on mount to populate device lists. Before the first `getUserMedia` call, `enumerateDevices()` returns devices with empty labels and indistinguishable `deviceId`s. As soon as `getUserMedia` grants permission — whether from clicking **Monitor** or **Record** — the store re-enumerates and pushes the labelled list so named devices (e.g. "Focusrite USB Audio") appear immediately.

`MicSelector`'s label reads **"Input"** (not "Mic"). In `PracticeRoom`'s topbar the two are stacked — `MicSelector` above `OutputSelector` — inside `practice-room__io-group`, with both labels given a shared `min-width` so the two `<select>` elements align at the same x position.

### KeyTranspose

Displays the current `transpose` value in semitones with ±12 range. Triggers `setTranspose(n)` which pauses playback, calls the Python sidecar to generate shifted WAVs, then reloads the engine with the new files.

While `isTransposing` is true, the displayed value is **not** replaced with a placeholder like `"…"`. Instead a local `pendingTranspose` state holds the target semitone value the instant a button is clicked, displayed immediately with a `key-transpose__value--pending` class that pulses (`opacity` 0.35 ↔ 0.9, 0.9s loop) until the pitch-shift resolves — so the user sees where the control is headed rather than a blank/frozen indicator. Sits in `practice-room__topbar-devices`, to the right of the Input/Output stack.

### PianoRoll

VoceVista-inspired scrolling pitch display. Renders at native frame rate via a `requestAnimationFrame` loop that reads `getEngine().getCurrentTime()` directly — no React re-renders during playback.

**Layout:**

```
┌─ piano-roll__ruler-wrap (2.4rem) ──────────────────────┐
│ [⟳] time ruler: ticks · punch region · center playhead │  ← ⟳ loop button at upper-left
└────────────────────────────────────────────────────────┘
┌─ canvas (15rem) ───────────────────────────────────────┐
│ |── 36px piano ──|──── scrolling pitch roll ───────── │
│ │  C5 key label  │  song ribbon (blue)                │ │
│ │  white/black   │  take ribbon (red)                 │ │
│ │  keys          │  live ribbon (orange)              │ │
│ │                │       ╎ playhead   [G4 D#4] ──top-right note │
└────────────────────────────────────────────────────────┘
```

**Time ruler (above canvas):**
- Shows the current 8-second window with absolute time tick marks
- Punch region overlay (same `punchIn`/`punchOut` store values as the waveform TimeRuler)
- Drag on empty area → draw new punch region; drag near handle → move that boundary; click → clear
- Loop toggle button (⟳) appears at the **upper-left** corner of the ruler (over the piano-key strip area) when a region is set; uses `.piano-roll__loop-btn` modifier to override the default right-aligned position
- Coordinates use `capturedT0` from mousedown so the window stays stable during a drag

**Drag-to-seek (main canvas):**
- Horizontal drag on the pitch roll area seeks the playhead and syncs all tracks
- Drag left → forward in time; drag right → backward (pan-content gesture)
- Delta is computed from the initial drag position so the view tracks the finger accurately

**Drawing passes (in order):**
1. Lane backgrounds — black-key rows slightly darker, C-octave boundaries marked with a brighter rule
2. Song pitch ribbon — `rgba(74,158,255,0.88)` thick polyline following SRH pitch data; line breaks on gaps > 80ms or confidence < 0.5
3. Take pitch ribbon — `rgba(233,69,96,0.92)` same style, drawn over the song ribbon
4. Live pitch ribbon — `rgba(255,140,30,0.9)` drawn during recording/monitoring from autocorrelation readings accumulated in `livePitch[]` (analysis store); disappears when mic goes inactive
5. Playhead — dashed vertical line at canvas center
6. Note label — current note name(s) shown right-aligned at top-right of the roll (e.g. "A4 G#4")
7. Piano key strip — drawn last so it sits on top of any ribbon that bleeds into the left column; key color priority: live (orange) > take (red) > song (blue)

**Constants:** 40-semitone visible window, 8-second time window, `15rem` canvas height.

**Sliding vertical window:** the visible pitch range no longer sits at a fixed MIDI span. `PIANO_WINDOW_SIZE = 40` (unchanged) semitones are always shown, but the window's lower bound (`midiMin`, a float held in a `windowMinRef`) slides to follow whichever pitch is currently active (`liveMidi ?? takeMidi ?? songMidi`), letting the same visual resolution as the old fixed A2–C6 range support the full `PIANO_ABS_MIN`–`PIANO_ABS_MAX` (C0–C7) keyboard — needed for wide-range instrument practice tracks. See [constants.ts](../src/lib/constants.ts): `computePianoWindowTarget()` only moves the window once the active note gets within `PIANO_FOLLOW_MARGIN` (6 semitones) of an edge (a "dead zone" so normal melodic movement doesn't cause drift), and `stepPianoWindow()` eases toward that target by a fixed fraction (`PIANO_FOLLOW_LERP = 0.06`) every animation frame, so the window glides rather than snaps. `midiToY`/`drawLanes`/`drawRibbon`/`drawPianoStrip` all take the float `midiMin` directly — no rounding — so the ribbon and lane backgrounds scroll continuously pixel-by-pixel rather than jumping a whole semitone at a time. When no pitch is active, the window holds its last position.

**No spectrogram:** frequency spectrogram was moved to the dedicated `SpectrogramPanel` component (Free Exercise page only).

### SpectrogramPanel

Scrolling live spectrogram rendered exclusively in the Free Exercise page. Shows the full audio spectrum in real time — not shown in song practice (`PracticeRoom`). Data source is either the live microphone (recording/monitoring) or, when a track is loaded via [Free Exercise Track Loading](#free-exercise-track-loading), a frame-accurate snapshot of that track's decoded audio (see "Mic analyser" below).

**Formant tick marks:** F1/F2/F3 estimated client-side via `estimateFormants()` (`src/lib/formants.ts` — pre-emphasis → Hamming window → autocorrelation → Levinson-Durbin LPC → Durand-Kerner polynomial root-finding → pole-to-resonance conversion → frequency/bandwidth candidate filtering → frame-to-frame continuity matching + light exponential smoothing) drawn as short horizontal tick marks at each formant's `freqToY(...)` position, written into the same new column the spectrogram writes to each capture so they scroll with the waterfall and leave a trail. A `null` estimate (unvoiced/silence) skips that tick rather than holding a stale mark. Durand-Kerner was chosen over the more commonly-cited Bairstow's method for lower implementation risk (no partial-derivative recurrence bookkeeping) at the polynomial orders (~14, after decimating to a ~12kHz-equivalent bandwidth) this needs — both validated against known-root polynomials during development.

**Frequency axis:** 30 Hz (bottom) → 20 kHz / Nyquist (top) on a **log-frequency scale**. The 30 Hz floor (not 20 Hz) keeps the 50–100 Hz region fully visible within canvas bounds. Tick marks and Hz labels at 30 · 50 · 100 · 200 · 500 · 1k · 2k · 5k · 10k · 20k Hz (20k pinned at top edge). Faint horizontal grid lines at 100 · 500 · 1k · 5k · 10k Hz are drawn on the main canvas after the offscreen composite so they remain crisp. Axis strip: `AXIS_W = 56` physical pixels.

**Resolution:** 8192-point FFT (`fftSize = 8192`, `frequencyBinCount = 4096`). `getFloatFrequencyData()` into a `Float32Array` gives full dB precision (no quantisation). Each canvas pixel row maps to an FFT **bin range** via a pre-computed per-row `[low, high]` LUT; the row's value is the **max dB across its bin range** (max-in-range mapping — fills the gaps a nearest-neighbor lookup leaves on a log-frequency axis). LUT is cached and rebuilt only on canvas resize or sample-rate change.

**Scroll rendering (left-shift pattern):**
1. Every ~33 ms tick, call `getFloatFrequencyData` into `fftScratch`.
2. Compute normalised magnitude for each row → `colNorms[]` (no vertical blur — relies on temporal blending only).
3. Shift offscreen canvas left by `shift` pixels: `getImageData(shift, 0, rollW-shift, H)` → `putImageData(…, 0, 0)`.
4. Write `shift` new columns at `rollW - shift` from norms via colormap lookup.
5. Composite offscreen onto main canvas at `globalAlpha = 0.72` for temporal smoothing (main canvas is **not** cleared between frames during active capture — old frames decay naturally).

`shift` is computed from a fractional accumulator: `shiftAccum += rollW * 33 / (WINDOW_S * 1000)`, so the full canvas width always represents exactly `WINDOW_S = 10` seconds regardless of physical canvas width or DPR.

**dB mapping:** `MIN_DB = -85`, `MAX_DB = -20` (VoceVista-matched dynamic range; exported and reused by the Short-Term Spectrum panels). Hard noise gate: `db < -80 → norm = 0`. Soft gate below `norm = 0.15` (`norm·(norm/0.15)·0.3`) pushes the noise floor to black. Gamma correction: `Math.pow(gated, 0.38)`. `smoothingTimeConstant = 0.15` (set on every capture tick — single authoritative location). A vertical dB legend bar (`LEGEND_WIDTH = 52` px, ticks −20 … −85) is drawn on the right using the same constants so it always matches the display mapping.

**Colormap:** Thermal — black → dark navy (index 64) → medium blue → teal (index 148) → yellow → orange → bright red-orange (index 230) → salmon (index 245) → pure white (index 255). Built by `buildColormap()` in `src/lib/spectroUtils.ts` using index-based linear interpolation so the noise floor is dark navy/black and only peak harmonics flash white.

**Mic analyser / track snapshot:** Live mic reads from `getMicAnalyser()` (player store singleton, `fftSize = 8192`); no second `getUserMedia` is opened. When a track is loaded (`loadedTrackId !== null`), the panel instead calls `AudioEngine.getExerciseTrackSamples(8192)` + `AudioEngine.getExerciseTrackSampleRate()` and runs its own FFT (`computeMagnitudeSpectrumDb` in `src/lib/fft.ts`, a dependency-free radix-2 Cooley-Tukey implementation, Blackman-windowed) — this works whether the track is playing, paused, or was just scrubbed, unlike an `AnalyserNode`, which only reports data while audio is actively flowing through it. **Scrolling vs. snapshot:** the waterfall only keeps shifting/scrolling while audio is actually advancing (`shouldScroll = isRecording || isMonitoring || (trackActive && isPlaying)`); paused/scrubbed with a loaded track, prior history stays in place and only a fixed 6px strip at the right edge is overwritten each capture with the current frame, so scrubbing updates the view without the waterfall endlessly "scrolling" a frozen value. Idle state (neither recording, monitoring, nor a loaded track) freezes the canvas; the roll area is cleared to `#0f0f1e` only on true idle.

**Layout in ExercisePage:** Inside `exercise-page__spectro`, below the `exercise-page__keyboard` strip and `exercise-page__roll`, inside the `exercise-page__analysis` scrollable wrapper. Canvas height: `clamp(15rem, 45vh, 35rem)`.

### ShortTermSpectrumPanel

Real-time spectral **snapshot** (not a waterfall) — a single spectrum curve fully redrawn each frame, on the Free Exercise page below the SpectrogramPanel. Horizontal **log-frequency axis** (reuses `freqToX`/`xToFreq` from `src/lib/spectroUtils.ts` and `F_MIN`/`F_MAX`/`MIN_DB`/`MAX_DB`/`AXIS_W`/`LEGEND_WIDTH` exported by `SpectrogramPanel`), vertical dB axis with 10 dB ticks. Draws the raw spectrum plus a **smoothed spectral envelope overlay** — a moving average whose window widens with frequency, since formants are proportionally wider at high frequencies on a log axis.

Data source mirrors `SpectrogramPanel`: live mic via `getMicAnalyser()` (no second `getUserMedia`), or — when a track is loaded — a snapshot via `AudioEngine.getExerciseTrackSamples()`/`getExerciseTrackSampleRate()` + `computeMagnitudeSpectrumDb()`. Since this panel has no scroll/history state at all (it's a full redraw every frame regardless of play state), it needed no paused-vs-scrolling distinction — it already shows the current frame correctly whether playing, paused, or scrubbed.

### ShortTermSpectrumComparisonPanel

Song-vs-take spectral envelope comparison in `PracticeRoom`. Overlays up to three curves at the current playhead position, using the shared song/take/live colors from `PianoKeyboard` (`COLOR_SONG`/`COLOR_TAKE`/`COLOR_LIVE`):

- **Song** — precomputed spectral envelope over time (`STSpectrum` in the analysis store, produced by the sidecar `compute_st_spectrum` command on the vocals stem).
- **Take** — per-take envelope computed during `save_take` analysis and persisted on the `Take` (`stSpectrumTimes`/`stSpectrumB64`/`stSpectrumFrames`/`stSpectrumBins`/`stSpectrumMinDb`/`stSpectrumMaxDb` — base64-packed byte matrix). The analysis store aligns take frames to **song time** (shifting by `startPosition`/`audioOffset`) so the two curves compare like-for-like at the playhead.
- **Live** — current mic spectrum while recording/monitoring.

Spectrum frames are coarse (~20 fps) relative to rAF, so the draw loop does a nearest-frame binary search per tick. Uses its **own** dB span of −100…0 dBFS — deliberately decoupled from SpectrogramPanel's −85…−20 display window — to cover the full vocal dynamic range, matching the mic `AnalyserNode`'s widened `minDecibels`/`maxDecibels` (see `stores/player.ts`).

### DualTuner

Real-time pitch gauge. Active whenever `isRecording || isMonitoring`.

**Form factor:** Thin SVG horizontal bar (`viewBox="0 0 300 8"`, `preserveAspectRatio="none"`) — stretches to full container width. No note labels, no ticks — pure color zones only. Range: ±50 cents. Zones: green ±0–15 ct, yellow ±15–30 ct, red >±30 ct. Needle is a 3 px rect; centre mark at x=150.

**Placement:**
- **ExercisePage** — rendered inside `PianoKeyboard` (not the page header). `PianoKeyboard` owns and renders `<DualTuner />` between its header strip and the canvas key row. Not present in `PracticeRoom`.

**Stream model:** DualTuner never opens its own `getUserMedia`. It reuses the already-open stream owned by the store:

| Active state | Stream source |
|---|---|
| `isMonitoring` | `getMonitorStream()` — opened by `startMonitoring()` |
| `isRecording` | `getRecorderStream()` — opened by `rec.init()` in `startRecording` / `startExerciseRecording` |

Opening a second `getUserMedia` to the same device caused silent failures on Windows WASAPI (exclusive-mode endpoints reject a second client). By reusing the existing stream there is no device conflict and no extra permission prompt.

**Pitch detection:** A `PitchDetector` (autocorrelation, 2048-sample FFT) is created on each activation, connects the stream to a Web Audio `AnalyserNode`, and runs a `requestAnimationFrame` loop calling `getCurrentPitch()`. Detected frequencies are pushed into `livePitch[]` in the analysis store and shown on the needle gauge. On deactivation, the `AudioContext` is closed and `livePitch` is cleared; the underlying media stream is **not** stopped (it is owned externally).

### PianoKeyboard

Horizontal piano key strip showing the currently playing note highlighted in the matching color (song=blue, take=red, live=orange). All white keys show a full note label with octave number at the bottom of each key: `C3`, `D3`, `E3`, `F3`, `G3`, `A3`, `B3`, `C4`, `D4` … The octave is derived as `Math.floor(midi / 12) - 1` (MIDI convention).

**Sliding window:** shares the same `PIANO_WINDOW_SIZE`/`computePianoWindowTarget`/`stepPianoWindow` helpers as `PianoRoll` (see that section and [constants.ts](../src/lib/constants.ts)) to follow the active pitch across the full C0–C7 range, via its own `windowMinRef` — the two components' windows aren't shared state and can drift slightly out of sync, which isn't visually noticeable. Unlike `PianoRoll`'s continuous pixel-level scroll, `buildLayout()` here rounds the smoothed `midiMin` to the nearest semitone before laying out keys, so the keyboard image shifts key-by-key rather than scrolling fractionally — a discrete white/black key strip reads more naturally snapping to whole keys than sliding continuously.

### PracticeRoom

Song practice page. Requires a processed song.

**Layout:**
```
┌─ practice-room__header ───────────────────────────────┐
│  ← Back   Song Title   BPM / Key                      │
├─ practice-room__topbar (sticky, top: 0) ──────────────┤
│  TransportControls · TempoControl ·                   │
│  [Input / Output (stacked)] · KeyTranspose ·           │
│  MonitorButton · RecordButton                          │
├─ practice-room__body (flex row) ──────────────────────┤
│ ┌─ practice-room__main (flex: 1) ──────────────────┐  │
│ │  Waveform (vocals + instrumental + take,          │  │
│ │            mute/solo/volume per track row)        │  │
│ │  Analysis panel (when isAnalysisLoaded):          │  │
│ │    PianoKeyboard · PianoRoll · DynamicsCurve      │  │
│ └────────────────────────────────────────────────── ┘  │
│ ┌─ practice-room__sidebar (15rem, flex col) ────────┐  │
│ │  practice-room__takes-wrap (flex: 1 1 50%, auto)  │  │
│ │    TakeList                                       │  │
│ │  practice-room__sidebar-bottom (flex: 1 1 50%, auto)│ │
│ │    VibratoCard · TimingChart · CoachPanel         │  │
│ └───────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────┘
```

**Topbar:** `practice-room__topbar` sits between the header and the body — above both `practice-room__main` and `practice-room__sidebar` — and consolidates every transport/recording control that used to be split across a controls row and a transport row inside the scrollable main column: `TransportControls` (play/stop/time), `TempoControl`, the Input/Output device pair (stacked in `practice-room__io-group`), `KeyTranspose`, `MonitorButton`, and `RecordButton`. It's `position: sticky; top: 0` so it stays visible regardless of which side (main or sidebar) is scrolled — though in practice `.practice-room` itself doesn't scroll (only `practice-room__main` and the sidebar zones do), so the sticky rule is a safety net rather than load-bearing.

**Sidebar layout:** The sidebar splits 50/50 between `practice-room__takes-wrap` (TakeList) and `practice-room__sidebar-bottom` (VibratoCard, TimingChart, CoachPanel), each independently scrollable (`overflow-y: auto`) so neither zone can crowd out the other. The full `min-height: 0` chain must be present at every ancestor (`html/body/#root → .app → .practice-room → .practice-room__body → .practice-room__sidebar`) for the `overflow-y: auto` zones to engage.

**Analysis panel:** Visible when `isAnalysisLoaded` is true and either `showAnalysis` is toggled on or `isRecording` is true. `showAnalysis` is set automatically when the user selects a take. No `DualTuner` in this page — the tuner is ExercisePage-only.

### VibratoCard

Compact widget showing vibrato Rate (Hz), Depth (cents), and Evenness (%) for the currently selected take. Located in the sidebar bottom section.

Rendered only when `takeVibrato` is non-null in the analysis store. If all values are zero, no vibrato was detected (pitch swings < 10 ct or pattern too irregular).

**Info popover (ⓘ button):** A toggle in the card header opens an inline explanation panel below the stats. The panel describes each metric's ideal range (Rate 4–7 Hz, Depth 20–100 ct, Evenness ≥ 60 %) and a note explaining zero output. CSS class: `vibrato-card__info-panel`. State is local to the component (`useState`).

**Color coding:** Each value is highlighted green (`vibrato-card__val--ok`) or amber (`vibrato-card__val--warn`) based on ideal-range thresholds.

### TakeList

List of recorded takes for the current song, in `practice-room__takes-wrap`. Each row shows the take's display name (`take.name || "Take {n}"`) and the recorded date; clicking a row calls `setActiveTake`. Three icon buttons sit on each row (`take-item__actions`):

- **✎ rename** — or double-click the name itself — swaps the name for an inline `<input>` (local `editingId`/`editValue` state). Enter or blur commits via `renameTake(takeId, name)`; Escape cancels without saving. Trimmed-empty names clear back to the default `"Take N"` label (Rust command `rename_take` stores `None` in that case).
- **↓ download** — calls `exportTake(take.filepath, "{Song Title} - {display name}.wav")`, opening a native Save-As dialog. The take is always exported as WAV: the Rust `export_take` command first sends a `convert_take` request to the Python sidecar (`analysis.py: convert_take_to_wav`, decodes the source webm/opus via `librosa.load` + writes `soundfile.write` — the same backend already used for take analysis, so no new dependency) into a temp file, copies that to the chosen destination, and deletes the temp file (`TempFile` RAII guard). The sidecar mutex guard is dropped in an inner block before the dialog `.await` so the command future stays `Send`. Mirrors the `exportStem` pattern used by `SongCard`. The download button shows `…` and disables itself while the conversion/dialog is in flight.
- **× delete** — calls `deleteTake(take.id)`.

All three buttons call `e.stopPropagation()` so clicking them doesn't also select the take. `Take.name` is persisted in `takes.json` (optional field, omitted when unset) and round-trips through `list_takes`/`save_take`/`rename_take`.

### CoachPanel

Generates coaching tips from pitch deviation, timing deviation, vibrato, and dynamics comparisons (`generateTips`). Tips are hidden by default — a header toggle button (`coach-panel__toggle`, "See Tips (N)" / "Hide Tips") reveals `coach-panel__tips`. State is local (`useState`), so it resets to hidden whenever a new take is selected and the component remounts/rerenders with fresh tips. This keeps the sidebar bottom zone compact until the user opts in.

### ExercisePage

Standalone practice page — no song required. Used for warming up, vocal exercises, or free improvisation.

**Layout:**
```
┌─ header ──────────────────────────────────────────────┐
│  ← Back   FREE EXERCISE                   00:00       │  ← timer turns red while active or a track is loaded
├─ exercise-page__keyboard (flex-shrink: 0) ────────────┤
│  PianoKeyboard  [DualTuner bar above keys]            │  ← pinned, does not scroll
├─ exercise-page__track-strip ──────────────────────────┤
│  loaded-track WaveSurfer waveform (always rendered,   │  ← real dimensions before load, so
│  so it has real dimensions before loadExerciseTrack)  │    WaveSurfer doesn't size a 0px canvas
├─ ▶/⏸ Play · Unload  (only when a track is loaded) ───┤
├─ exercise-page__analysis (flex: 1, overflow-y: auto) ─┤
│  ┌─ exercise-page__roll ──────────────────────────┐   │
│  │  PianoRoll   (live orange, or loaded-take red) │   │
│  └────────────────────────────────────────────────┘   │
│  ┌─ exercise-page__spectro ───────────────────────┐   │
│  │  SpectrogramPanel  (30 Hz – 20 kHz, + formants)│   │
│  └────────────────────────────────────────────────┘   │
│  ┌─ exercise-page__spectro ───────────────────────┐   │
│  │  ShortTermSpectrumPanel                        │   │
│  └────────────────────────────────────────────────┘   │
│  ┌─ exercise-page__dynamics ───────────────────────┐   │
│  │  DynamicsCurve                                  │   │
│  └────────────────────────────────────────────────┘   │
│  VibratoCard                                          │
├─ exercise-page__controls ─────────────────────────────┤
│  MicSelector · MonitorButton · ⏺ Record · 📂 Load track…│
├───────────────────────────────────────────────────────┤
│  Recordings (ExerciseTakeList)                        │
└───────────────────────────────────────────────────────┘
```

`exercise-page__keyboard` is `flex-shrink: 0` and sits **outside** the scrollable analysis wrapper — it is always visible regardless of scroll position. `PianoKeyboard` owns and renders the `DualTuner` bar internally (between its header and its canvas key row). The `exercise-page__analysis` wrapper is `flex: 1; overflow-y: auto` so PianoRoll and SpectrogramPanel scroll independently on small screens.

**Time source:** `AudioEngine` exercise timer (`_exerciseMode = true`). `getCurrentTime()` returns `performance.now()` elapsed seconds while live-recording/monitoring, or `exerciseTrack.getCurrentTime()` whenever a track is loaded (see [Free Exercise Track Playback](audio-engine.md#free-exercise-track-playback)) — no changes needed to PianoRoll/DualTuner, which just read through `getEngine().getCurrentTime()` either way.

**Monitor mode:** calls `startMonitoring()` / `stopMonitoring()` from the player store. In exercise mode, `startMonitoring()` also calls `eng.startExerciseTimer()` so `currentTime` advances and the piano roll scrolls while monitoring. `stopMonitoring()` stops the timer again.

**Record mode:** `startExerciseRecording()` opens the mic, applies WASAPI output routing, then calls `eng.startExerciseTimer()`. `stopExerciseRecording()` stops the timer, drains the recorder, calls `save_exercise_take` Tauri command (pitch algorithm per the Settings panel, default SRH — see [python-sidecar.md#pitch-detection-user-selectable](python-sidecar.md)), and returns the `ExerciseTake`. `ExercisePage` then calls `addExerciseTake(take)` on the exercise store.

**Mutual exclusivity:** Monitor and Record buttons follow the same rules as PracticeRoom — `startRecording` stops monitoring first. Recording and loaded-track playback are also mutually exclusive: the Record button is disabled while `loadedTrackId !== null`, and loading a take/importing a file is disabled while `isRecording` — `AudioEngine`'s exercise-mode stopwatch and the `exerciseTrack` playback clock are two different `getCurrentTime()` sources that must never both be "current" at once.

### Free Exercise Track Loading

Clicking a past take in `ExerciseTakeList`, or importing an external file via the "📂 Load track…" button (native file-open dialog filtered to audio extensions, reusing `DropZone`'s exported `AUDIO_EXTENSIONS` list), loads it into `AudioEngine.exerciseTrack` for full post-hoc inspection — synced `PianoRoll` pitch ribbon, `DynamicsCurve`, `VibratoCard`, and the Spectrogram/Short-Term Spectrum panels (including formant ticks), all driven by the loaded track's own already-stored `pitchData`/`dynamics`/`vibrato` (no re-analysis needed for a past take).

`useAnalysisStore.loadExerciseTakeAnalysis(take)` populates `takePitch`/`takeDynamics`/`takeVibrato` directly from the `ExerciseTake` object — unlike `loadTakeAnalysis(take: Take)` (used by `PracticeRoom`), it needs no `startPosition`/`songId` context and computes no `timingDeviations`, since a song-less exercise recording has no reference onsets to compare against.

An imported external file is persisted through the **same** `ExerciseTake` model as a recorded take (new `import_exercise_file` Tauri command: copies the file into `~/.vps/exercises/takes/`, runs it through the sidecar `analyze` command, appends it to `exercises.json`) — no separate data model for "imported" vs. "recorded," `loadedTrackKind` in the exercise store is UX copy only.

**`DynamicsCurve` gating fix:** this component previously gated its rAF loop and "no data" message purely on the song-only `isLoaded` flag, which Free Exercise never sets — it would never have drawn here without adding `exerciseMode` (from the player store) as an alternate gate, mirroring `PianoRoll`'s existing `!isLoaded && !exerciseMode` precedent, and checking `takeDynamics.length === 0` instead of `songDynamics` in exercise mode. `VibratoCard` needed no changes — it already gates purely on `takeVibrato` being non-null.

### ExerciseTakeList

Flat list of recorded exercise takes. Each row shows the recorded date and duration. Clicking an inactive row loads it into the main view (see [Free Exercise Track Loading](#free-exercise-track-loading) above) via `loadExerciseTakeIntoTrack(take, containerEl)`, where `containerEl` is a ref to `ExercisePage`'s shared waveform-strip container (passed down as a prop, so there's one WaveSurfer container reused across list clicks rather than one per row). Clicking the already-loaded row again unloads it via `clearLoadedTrack()`. Disabled (no-op) while recording. A `×` button deletes the take; deleting the currently-loaded one also unloads it.

### YouTubeImport

Input + button for pasting a YouTube URL. Validates the URL client-side with a regex before calling `importYoutube(url, highQuality)` on the library store (`highQuality` passed down as a prop from `LibraryPage`). Disabled while any processing job is active. Errors from the store are shown as a dismissible red banner in `LibraryPage`.

### DropZone

Click-to-browse file picker (native `open()` dialog filtered to audio extensions) that calls `uploadSong(filePath, highQuality, trackKind)` on the library store. Shows a progress bar driven by `processing.progress` while a job is active; disabled during processing. `highQuality` and `trackKind` are passed down as props from `LibraryPage`. When `trackKind === "instrument"` the idle label reads "Upload a practice track" instead of "Upload a song".

**Instrument practice track import:** `LibraryPage` renders a `library-page__track-kind-toggle` radio group above `DropZone` — "Song (separate vocals & instrumental)" vs. "Instrument practice track (piano/guitar melody)" — backed by local `trackKind` state (`"vocal" | "instrument"`, default `"vocal"`). Selecting "instrument" also disables the high-quality checkbox (Demucs quality is irrelevant when separation is skipped) and threads `trackKind` through `uploadSong` → `processSong(filePath, highQuality, trackKind)` → Tauri `process_song(track_kind: Option<String>)` → sidecar `skipSeparation`. See [Data Model: Song.kind](data-model.md#song) and [Python Sidecar: process](python-sidecar.md#process) for the rest of the pipeline.

### SongCard (inline in `LibraryPage`)

Each song in the library list is rendered by a `SongCard` component with local state:

- **Pitch control** — ±6 semitone offset (−/+ buttons + value display + × reset). At 0 the export is direct; at any other value `pitchShiftSong(song.directory, n)` is called first and the shifted WAV paths are passed to `exportStem`. The suggested filename includes the offset, e.g. `Song - Vocals (+3st).wav`.
- **Export buttons** — for `kind: "vocal"` songs (default), "↓ Vocals" and "↓ Instr." trigger `exportStem` via a native Save-As dialog, both disabled and showing `…` while pitch-shifting is in progress. For `kind: "instrument"` songs, a single "↓ Download" button exports the practice track (still via `handleExport("vocals")`, since `vocals.wav` holds the actual audio for instrument-kind songs). Instrument-kind cards also show an "Instrument" badge (`song-card__badge`) next to the title.
