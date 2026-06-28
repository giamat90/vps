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
│   ├── Waveform           — 3-track waveform display (vocals + instrumental + take)
│   ├── TimeRuler          — canvas time ruler with drag-to-select punch region
│   ├── TransportControls  — play/pause/stop + volume sliders
│   ├── TempoControl       — playback rate/BPM control
│   ├── KeyTranspose       — semitone transpose UI
│   └── OutputSelector     — audio output device picker
├── recording/
│   ├── RecordButton       — start/stop recording (song practice)
│   ├── MonitorButton      — toggle live mic monitoring (no save)
│   ├── MicSelector        — microphone input source picker
│   ├── TakeList           — list of song takes with delete
│   └── ExerciseTakeList   — list of exercise takes; click to expand audio player
├── analysis/
│   ├── DualTuner          — real-time pitch tuner (reference vs. singer)
│   ├── PianoKeyboard      — horizontal piano key strip with live/song/take highlight
│   ├── PianoRoll          — scrolling pitch ribbon display (song + take + live)
│   ├── SpectrogramPanel   — scrolling live mic spectrogram (Free Exercise only)
│   ├── VibratoCard        — vibrato rate / depth / regularity summary
│   ├── TimingChart        — timing deviation chart (user vs. reference onsets)
│   └── DynamicsCurve      — RMS dynamics over time
└── coaching/
    └── CoachPanel         — AI coaching tips panel
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

Actions: `fetchSongs`, `uploadSong`, `importYoutube`, `deleteSong`, `clearError`, `initProgressListener`.

Errors from `importYoutube` and `uploadSong` are parsed by `friendlyError()` into human-readable messages covering bot-detection, VPN/proxy blocks, private/geo-blocked videos, and network failures.

### Player Store

All player state lives in a single Zustand store: `src/stores/player.ts`.

```ts
import { usePlayerStore } from "../../stores/player";

const isPlaying = usePlayerStore((s) => s.isPlaying);
const togglePlay = usePlayerStore((s) => s.togglePlay);
```

Components subscribe to individual slices to avoid unnecessary re-renders. The store owns the `AudioEngine` and `VocalRecorder` singletons (accessed via module-level `getEngine()` / `getRecorder()` helpers, not stored in Zustand state).

## Key State Fields

| Field | Type | Description |
|-------|------|-------------|
| `song` | `Song \| null` | Currently loaded song |
| `isPlaying` | `boolean` | Playback state |
| `currentTime` | `number` | Playback position (seconds) |
| `duration` | `number` | Song length (seconds) |
| `playbackRate` | `number` | Speed multiplier (0.25–2.5) |
| `vocalsVolume` | `number` | 0–1 |
| `instrumentalVolume` | `number` | 0–1 |
| `isLooping` | `boolean` | Loop mode active |
| `loopStart / loopEnd` | `number \| null` | Loop region (seconds) |
| `transpose` | `number` | Active semitone shift |
| `isTransposing` | `boolean` | Pitch-shift in progress |
| `isRecording` | `boolean` | Recording in progress |
| `isMonitoring` | `boolean` | Live mic monitor active (no recording) |
| `takes` | `Take[]` | All takes for current song |
| `activeTakeId` | `string \| null` | Selected take (loads it as the take track) |
| `takeVolume` | `number` | 0–1 volume for the take track |
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
| `activeExerciseTakeId` | `string \| null` | Expanded take (shows audio player) |

Actions: `fetchExerciseTakes`, `addExerciseTake`, `deleteExerciseTake`, `setActiveExerciseTake`.

## GUI Rule

**All dimensions must use relative units** — `%`, `rem`, `vw`, `vh`, `fr`. Never use fixed pixel values (`px`) for layout dimensions. This ensures the UI scales correctly across different screen sizes and DPI settings.

## Notable Component Details

### TransportControls

Stop button routes to `stopRecording()` during recording, `stop()` otherwise:

```tsx
<button onClick={isRecording ? () => void stopRecording() : stop}>
```

An orange **Take** volume slider appears when `activeTakeId` is set.

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

Speed control for playback. Has two modes selectable via a tab toggle:

**Speed mode (default):** Slider from 0.25× to 2.5×, displays current multiplier, five preset buttons (0.5×, 0.75×, 1×, 1.25×, 1.5×).

**BPM mode** (only shown when the song has a detected BPM): number input for a target BPM; the playback rate is computed as `targetBpm / songBpm`. Seven preset buttons at 50/60/75/90/100/110/125% of the song BPM. The resulting multiplier is shown as feedback. Enter or blur commits the value.

### TimeRuler

Canvas strip above the waveform tracks (`2.8rem` tall). Shows time ticks at adaptive intervals (≥ 80 px target). Font size scales proportionally with canvas height. All ruler interaction is disabled during recording.

**Interactions:**
- **Click + drag** on empty space → draw a new punch region
- **Hover / drag near In or Out handle** (±12 px) → cursor becomes `ew-resize`; drag moves only that boundary, the other stays fixed
- **Click** (< 0.5 s drag) → clear punch region and reset loop toggle
- **⟳ button** (appears at right edge when region is set) → toggle `punchLoop`; red when active

The region is drawn as a red band on the canvas with I-beam caps at the handles. Each waveform track also shows a translucent `PunchOverlay` div (positioned via `left` / `width` percentages of the track).

### Waveform

Renders `TimeRuler` at the top, then up to three stacked WaveSurfer tracks each wrapped in `.waveform__track-body` (position: relative) so `PunchOverlay` can be absolutely positioned over them:

1. **Vocals** — always visible; original vocals track
2. **Instrumental** — always visible; backing track and time reference
3. **Take** — conditionally rendered when `activeTakeId` is set; orange waveform positioned at the correct time offset and proportional width using `eng.loadTakeTrack()`

### MicSelector / OutputSelector

Call `fetchAudioDevices()` / `fetchOutputDevices()` on mount to populate device lists. Before the first `getUserMedia` call, `enumerateDevices()` returns devices with empty labels and indistinguishable `deviceId`s. As soon as `getUserMedia` grants permission — whether from clicking **Monitor** or **Record** — the store re-enumerates and pushes the labelled list so named devices (e.g. "Focusrite USB Audio") appear immediately.

### KeyTranspose

Displays the current `transpose` value in semitones with ±12 range. Triggers `setTranspose(n)` which pauses playback, calls the Python sidecar to generate shifted WAVs, then reloads the engine with the new files.

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

**Constants:** MIDI 45–84 (A2–C6, 40 semitones), 8-second window, `15rem` canvas height.

**No spectrogram:** frequency spectrogram was moved to the dedicated `SpectrogramPanel` component (Free Exercise page only).

### SpectrogramPanel

Scrolling live spectrogram rendered exclusively in the Free Exercise page. Shows the full audio spectrum of the microphone input in real time — not shown in song practice (`PracticeRoom`).

**Frequency axis:** 20 Hz (bottom) → 20 kHz / Nyquist (top) on a **log-frequency scale** (linear in MIDI = logarithmic in Hz). This gives equal visual space to each octave.

**Resolution:** Matches VoceVista — 8192-point FFT at the browser's native sample rate (44100 Hz → 5.38 Hz/bin, 48000 Hz → 5.86 Hz/bin). Each canvas pixel row maps directly to its own FFT bin via a pre-computed `Uint16Array` LUT (`buildFreqBinLut`). The LUT is cached and rebuilt only when the canvas height or sample rate changes.

**Rendering:** Per-pixel `ImageData` — no rectangular fill artifacts. Uses the VoceVista-aligned thermal colormap (black → deep blue → teal → yellow → orange → red → near-white). Pixels below amplitude threshold 8/255 are drawn transparent.

**Y-axis labels:** Tick marks and Hz labels at 20 · 50 · 100 · 200 · 500 · 1k · 2k · 5k · 10k · 20k Hz. Faint horizontal grid lines cross the spectrogram at each tick. Axis strip is 48 px wide (canvas coordinates — not a CSS layout value).

**Buffer:** Raw `Uint8Array` frames from `getByteFrequencyData()` (4096 bins at fftSize=8192) are stored in a rolling 8-second ring buffer. Capture is throttled to ~30 fps (33 ms gate). Buffer is cleared when mic goes fully inactive.

**Mic analyser:** Reads from `getMicAnalyser()` (player store singleton). The same `AnalyserNode` is shared with `DualTuner`'s pitch detector stream — no second `getUserMedia` call is made. `fftSize = 8192`, `smoothingTimeConstant = 0.6`.

**Layout in ExercisePage:** Inside `exercise-page__spectro`, which sits below `exercise-page__roll` inside the `exercise-page__analysis` scrollable wrapper. Canvas height: `12rem`.

### DualTuner

Real-time pitch gauge shown in the practice room header and the exercise page header. Active whenever `isRecording || isMonitoring`.

**Stream model:** DualTuner never opens its own `getUserMedia`. It reuses the already-open stream owned by the store:

| Active state | Stream source |
|---|---|
| `isMonitoring` | `getMonitorStream()` — opened by `startMonitoring()` |
| `isRecording` | `getRecorderStream()` — opened by `rec.init()` in `startRecording` / `startExerciseRecording` |

Opening a second `getUserMedia` to the same device caused silent failures on Windows WASAPI (exclusive-mode endpoints reject a second client). By reusing the existing stream there is no device conflict and no extra permission prompt.

**Pitch detection:** A `PitchDetector` (autocorrelation, 2048-sample FFT) is created on each activation, connects the stream to a Web Audio `AnalyserNode`, and runs a `requestAnimationFrame` loop calling `getCurrentPitch()`. Detected frequencies are pushed into `livePitch[]` in the analysis store and shown on the needle gauge. On deactivation, the `AudioContext` is closed and `livePitch` is cleared; the underlying media stream is **not** stopped (it is owned externally).

### PianoKeyboard

Horizontal piano key strip showing the currently playing note highlighted in the matching color (song=blue, take=red, live=orange). All white keys show a full note label with octave number at the bottom of each key: `C3`, `D3`, `E3`, `F3`, `G3`, `A3`, `B3`, `C4`, `D4` … The octave is derived as `Math.floor(midi / 12) - 1` (MIDI convention).

### ExercisePage

Standalone practice page — no song required. Used for warming up, vocal exercises, or free improvisation.

**Layout:**
```
┌─ header ─────────────────────────────────────────────┐
│  ← Back   FREE EXERCISE   [DualTuner]  00:00         │  ← timer turns red while active
├─ exercise-page__analysis (flex-col, overflow-y:auto) ┤
│  ┌─ exercise-page__roll ─────────────────────────┐   │
│  │  PianoKeyboard                                │   │
│  │  PianoRoll   (live orange ribbon only)        │   │
│  └───────────────────────────────────────────────┘   │
│  ┌─ exercise-page__spectro ──────────────────────┐   │
│  │  SpectrogramPanel  (20 Hz – 20 kHz, live mic) │   │
│  └───────────────────────────────────────────────┘   │
├─ exercise-page__controls ────────────────────────────┤
│  MicSelector · MonitorButton · ⏺ Record              │
├──────────────────────────────────────────────────────┤
│  Recordings (ExerciseTakeList)                       │
└──────────────────────────────────────────────────────┘
```

The `exercise-page__analysis` wrapper is `flex: 1; overflow-y: auto`, so on large screens both panels are fully visible; on small screens the user can scroll. Both inner divs are `flex-shrink: 0` to prevent clipping.

**Time source:** `AudioEngine` exercise timer (`_exerciseMode = true`). `getCurrentTime()` returns `performance.now()` elapsed seconds — no WaveSurfer involved. The rAF tick is shared, so PianoRoll and DualTuner require no changes.

**Monitor mode:** calls `startMonitoring()` / `stopMonitoring()` from the player store. In exercise mode, `startMonitoring()` also calls `eng.startExerciseTimer()` so `currentTime` advances and the piano roll scrolls while monitoring. `stopMonitoring()` stops the timer again.

**Record mode:** `startExerciseRecording()` opens the mic, applies WASAPI output routing, then calls `eng.startExerciseTimer()`. `stopExerciseRecording()` stops the timer, drains the recorder, calls `save_exercise_take` Tauri command (triggers pYIN analysis), and returns the `ExerciseTake`. `ExercisePage` then calls `addExerciseTake(take)` on the exercise store.

**Mutual exclusivity:** Monitor and Record buttons follow the same rules as PracticeRoom — `startRecording` stops monitoring first.

### ExerciseTakeList

Flat list of recorded exercise takes. Each row shows the recorded date and duration. Clicking a row expands it to show a native `<audio controls>` element using `convertFileSrc(take.filepath)`. Clicking again collapses it. A `×` button deletes the take.

### YouTubeImport

Input + button for pasting a YouTube URL. Validates the URL client-side with a regex before calling `importYoutube(url)` on the library store. Disabled while any processing job is active. Errors from the store are shown as a dismissible red banner in `LibraryPage`.

### SongCard (inline in `LibraryPage`)

Each song in the library list is rendered by a `SongCard` component with local state:

- **Pitch control** — ±6 semitone offset (−/+ buttons + value display + × reset). At 0 the export is direct; at any other value `pitchShiftSong(song.directory, n)` is called first and the shifted WAV paths are passed to `exportStem`. The suggested filename includes the offset, e.g. `Song - Vocals (+3st).wav`.
- **Export buttons** — "↓ Vocals" and "↓ Instr." trigger `exportStem` via a native Save-As dialog. Both are disabled and show `…` while pitch-shifting is in progress.
