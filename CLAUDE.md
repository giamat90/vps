# VPS — Claude Code Context

**Vocal Practice Studio** — Tauri v2 desktop app for singers to practice against separated tracks, record takes, and get feedback on pitch, timing, vibrato, and dynamics.

---

## Rules that always apply

### 1. Read the wiki first
At every session start, read `wiki/README.md` then the pages relevant to the task. The wiki is the authoritative record of architecture, components, and conventions. After every commit + push, update any wiki pages whose content was changed and commit the wiki updates as a follow-up commit.

### 2. All dimensions must be relative units
Every CSS size — width, height, font-size, padding, margin, gap — must use `%`, `rem`, `em`, `vw`, `vh`, `fr`, `clamp()`, `min()`, `max()`. **Never `px` for layout dimensions.** This is a hard project rule. If you spot a `px` value in a diff, convert or flag it.

### 3. No comments unless the WHY is non-obvious
Default to no comments. Only add one for hidden constraints, workarounds, subtle invariants. No "what the code does" narration.

### 4. Never swallow errors silently
Empty catch blocks (`catch {}`, `.catch(() => {})`) are forbidden. Always log with `console.warn` or `console.error` at minimum. If an error is expected and non-fatal, log it; if it is unexpected, rethrow or surface it to the UI.

---

## Tech stack

| Layer | Technology | Version |
|---|---|---|
| Desktop shell | Tauri | 2.10.3 |
| Frontend build | Vite + TypeScript | latest |
| UI framework | React | 19.2.4 |
| Audio playback | WaveSurfer.js | 7 |
| State management | Zustand | latest |
| Backend language | Rust | 1.94.1+ |
| Compute sidecar | Python | 3.10+ |
| Stem separation | Demucs | `htdemucs` model |
| Song pitch detection | SRH (custom, Drugman & Dutoit 2011) | — |
| Take pitch detection | pYIN (librosa) | — |
| Pitch shifting | librosa phase vocoder | — |

**Platform:** Windows 11, x86_64. WebView2 is pre-installed.

**Toolchain note:** `cargo` may not be on PATH in bash sessions. Always prepend:
```bash
export PATH="$USERPROFILE/.cargo/bin:$PATH"
```
PowerShell has it automatically after a normal rustup install. Prefer PowerShell for Rust/Tauri commands.

**User audio hardware:** Behringer UM2 USB interface, Rode NT1 condenser mic (phantom power from UM2), headphones on UM2 output. The UM2 appears as `"2-Behringer USB WDM Audio"` in Windows device lists.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  React 19 + TypeScript (WebView2 / Vite)    │  UI layer
│  WaveSurfer.js · Zustand · MediaRecorder    │
└──────────────────┬──────────────────────────┘
                   │  tauri::invoke()  (async IPC)
                   │  Tauri events     (push: "processing-progress")
┌──────────────────▼──────────────────────────┐
│  Tauri v2 backend (Rust)                    │  Shell / FS layer
│  commands.rs · library.rs · storage.rs      │
└──────────────────┬──────────────────────────┘
                   │  JSON lines on stdin / stdout
┌──────────────────▼──────────────────────────┐
│  Python sidecar (subprocess)                │  Heavy compute
│  Demucs · SRH · pYIN · librosa · soundfile │
└─────────────────────────────────────────────┘
```

### IPC
- **Frontend → Rust:** `invoke()` from `@tauri-apps/api/core`. Bindings in `src/lib/tauri.ts`.
- **Rust → Frontend:** `app.emit()` / `listen()`. Only event in use: `"processing-progress"`.
- **Rust → Python:** JSON lines on stdin/stdout. Sidecar runs a synchronous dispatch loop (avoids GIL/numpy deadlocks on Windows). Manager in `src-tauri/src/sidecar.rs`.
- **Audio files → WebView2:** Tauri asset protocol. `convertFileSrc(absolutePath)` → `tauri://localhost/...` URL used by WaveSurfer.

### Startup
1. Tauri starts → `SidecarState` created (empty, sidecar not yet spawned).
2. WebView2 renders React app.
3. Python sidecar spawned **lazily** on first command that needs it. Sends `{"type":"ready"}` when up.

---

## Project structure

```
VPS/
├── src/
│   ├── audio/
│   │   ├── engine.ts          AudioEngine class (WaveSurfer management)
│   │   └── recorder.ts        VocalRecorder (MediaRecorder wrapper)
│   ├── components/
│   │   ├── upload/
│   │   │   ├── DropZone.tsx       file drag-and-drop → processSong
│   │   │   └── YouTubeImport.tsx  URL paste → importYoutube
│   │   ├── player/
│   │   │   ├── Waveform.tsx        3-track waveform display + take loading
│   │   │   ├── TimeRuler.tsx       punch region ruler (canvas)
│   │   │   ├── TransportControls.tsx  play/pause/stop + volume sliders
│   │   │   ├── TempoControl.tsx    playback rate slider
│   │   │   ├── KeyTranspose.tsx    semitone transpose UI
│   │   │   └── OutputSelector.tsx  audio output device picker
│   │   ├── recording/
│   │   │   ├── RecordButton.tsx    start/stop recording
│   │   │   ├── MicSelector.tsx     microphone input picker
│   │   │   └── TakeList.tsx        take list with select/delete
│   │   ├── analysis/
│   │   │   ├── PianoRoll.tsx       VoceVista-style pitch ribbon (song+take+live)
│   │   │   ├── PianoKeyboard.tsx   horizontal piano with live pitch highlight
│   │   │   ├── DualTuner.tsx       real-time pitch tuner (song vs singer)
│   │   │   ├── DynamicsCurve.tsx   RMS dynamics over time
│   │   │   ├── VibratoCard.tsx     vibrato rate/depth/regularity
│   │   │   └── TimingChart.tsx     timing deviation chart
│   │   └── coaching/
│   │       └── CoachPanel.tsx      AI coaching tips
│   ├── lib/
│   │   ├── types.ts           Song, Take, PitchData, PitchPoint, DynamicsPoint, VibratoMetrics, …
│   │   ├── tauri.ts           IPC wrappers (processSong, saveTake, exportStem, …)
│   │   └── constants.ts       NOTE_NAMES, MIDI helpers, frequencyToMidi
│   ├── stores/
│   │   ├── player.ts          player + recording + punch state (Zustand)
│   │   ├── library.ts         song list + import flow (Zustand)
│   │   └── analysis.ts        pitch/onset/dynamics/live data (Zustand)
│   ├── pages/
│   │   ├── LibraryPage.tsx    song list, import, SongCard (pitch shift + export)
│   │   └── PracticeRoom.tsx   main practice UI (waveforms + analysis + recording)
│   └── styles/global.css
├── src-tauri/src/
│   ├── commands.rs    Tauri command handlers
│   ├── library.rs     Song struct + library.json CRUD
│   ├── storage.rs     Path helpers (~/.vps/)
│   ├── sidecar.rs     Python sidecar process manager
│   └── lib.rs         Tauri builder + invoke_handler registration
├── sidecar/
│   ├── main.py        JSON-lines dispatch loop (process, analyze, pitch_shift, import_yt, ping, quit)
│   ├── processor.py   Demucs + SRH pitch + onsets + dynamics + BPM + key
│   ├── analysis.py    Take analysis: pYIN + onsets + dynamics + vibrato
│   ├── yt_importer.py yt-dlp + processor pipeline
│   └── build.py       PyInstaller sidecar build
└── wiki/              Authoritative documentation (read at session start)
```

---

## Data model

### Key TypeScript types (`src/lib/types.ts`)

```ts
interface Song {
  id: string;           // UUID
  title: string;
  artist?: string;
  duration: number;     // seconds
  detectedKey?: string; // e.g. "C minor"
  detectedBpm?: number;
  processedAt: string;  // ISO timestamp
  directory: string;    // absolute path to ~/.vps/library/{id}/
}

interface Take {
  id: string;
  songId: string;
  recordedAt: string;
  filepath: string;
  startPosition: number;  // song time (s) where recording began; 0 = full-song
  pitchData?: PitchData;
  onsets?: number[];
  dynamics?: DynamicsPoint[];
  vibrato?: VibratoMetrics;
}

interface PitchData {        // raw SRH / pYIN output — parallel arrays
  times: number[];
  f0: number[];              // Hz; 0.0 for unvoiced frames
  voiced: boolean[];
  confidence: number[];
}

interface PitchPoint {       // frontend-internal representation
  time: number;
  frequency: number;
  confidence: number;
}
```

### Storage layout

```
~/.vps/library/
└── {songId}/
    ├── {original}.mp3       source file copy
    ├── vocals.wav            Demucs vocals
    ├── instrumental.wav      Demucs instrumental
    ├── analysis.json         pitchData + onsets + dynamics
    ├── takes.json            Take[] metadata
    ├── pitched/{n}/          pitch-shifted WAV cache (n = semitone steps)
    └── takes/
        └── {takeId}.webm     recorded take audio
```

### Tauri commands

| Command | Returns | Notes |
|---|---|---|
| `process_song(filePath)` | `Song` | Demucs + SRH; 10-min timeout |
| `list_songs()` | `Song[]` | reads library.json |
| `delete_song(songId)` | `void` | deletes directory |
| `save_take(songId, audioData, startPosition)` | `Take` | triggers pYIN analyze |
| `list_takes(songId)` | `Take[]` | reads takes.json |
| `delete_take(songId, takeId)` | `void` | |
| `load_analysis(songId)` | `{pitchData, onsets, dynamics}` | reads analysis.json |
| `pitch_shift_song(songDir, nSteps)` | `{vocalsPath, instrumentalPath}` | cached |
| `import_youtube(url)` | `Song` | yt-dlp + Demucs; 15-min timeout |
| `export_stem(stemPath, suggestedName)` | `void` | native Save As dialog |

---

## Audio engine (`src/audio/engine.ts`)

Three WaveSurfer instances in lockstep:

| Instance | Role |
|---|---|
| `vocals` | original vocals; always loaded |
| `instrumental` | full backing track; **master clock** — drives duration, getCurrentTime(), finish event |
| `take` | recorded take; loaded on demand, null when no take selected |

**Partial-take sync:** `_vocalsOffset`, `_vocalsDuration`, `_takeOffset`, `_takeDuration` fields map song-time ↔ file-time. `_seekVocals` / `_seekTake` do the conversion before calling WaveSurfer `seekTo()`.

**Take visual alignment:** After `loadTakeTrack` → WaveSurfer "ready", the container is resized with `setOptions({ width: widthPx })` (not just CSS). Required because WaveSurfer only respects ResizeObserver unreliably for CSS changes after creation.

**Click-to-seek sync:** Uses `"interaction"` event (user clicks only), NOT `"seeking"` (HTML5 proxy). Using `"seeking"` caused an infinite async loop: each programmatic `seekTo()` triggered another `"seeking"` event.

**rAF tick (`_startTimeUpdate`):** Runs at 60 fps. Three concerns per tick:
1. Loop detection (checked every frame for accurate punch-loop enforcement)
2. Take window sync (auto-play/pause take as playhead enters/exits `[_takeOffset, _takeOffset+_takeDuration)`)
3. UI notifications (throttled to ~30 fps, 33 ms gate, to halve React re-render rate)

---

## Recording flow (`src/stores/player.ts`, `src/audio/recorder.ts`)

### startRecording sequence
```
1. recordingStartPos = punchIn ?? currentTime
2. eng.pause()                         pause playback first
3. rec.init(selectedDeviceId)          getUserMedia — mic opens here
4. enumerate outputs                   find real hardware output (see below)
5. eng.setOutputDevice(outputId)       pin away from Windows Communications endpoint
6. eng.setInteract(false)             lock waveform click-to-seek
7. eng.seekTo(recordingStartPos)
8. eng.play()
9. rec.start()
```

**getUserMedia must be called before eng.play().** On Windows WASAPI, opening the mic reconfigures the audio session; active playback can cause `NotReadableError`.

### Windows WASAPI output routing
When `getUserMedia` opens a mic, Windows switches `""` sinkId to the **Communications Device** (different port than headphones). Auto-detection after `getUserMedia`:
1. Filter out `"Default -"` and `"Communications -"` aliases and virtual devices (Steam)
2. Match the output whose label shares a ≥4-char token with the selected mic label (e.g. `"BEHRINGER"`)
3. Fallback: first non-alias output
4. User override: `selectedOutputDeviceId` takes priority

After recording, `rec.releaseStream()` stops mic tracks → Windows exits communication mode → `setOutputDevice("")` flushes pinned sinkId.

### Punch region
State in player store: `punchIn: number|null`, `punchOut: number|null`, `punchLoop: boolean`.

- Play with `punchIn` set → seeks to `punchIn` first
- `onTimeUpdate` when `time >= punchOut`:
  - `isRecording` → `stopRecording()`
  - `punchLoop` → `seekTo(punchIn)` (loop)
  - else → pause + `seekTo(punchIn)` (stop and rewind)

Seek is locked during recording: `eng.setInteract(false)` + `if (isRecording) return` guard in `seek` action.

---

## Analysis components

### PianoRoll (`src/components/analysis/PianoRoll.tsx`)

VoceVista-inspired canvas ribbon. Draws at native frame rate via rAF reading `getEngine().getCurrentTime()` directly (no React re-renders during playback).

**Layout:**
```
┌─ piano-roll__ruler-wrap (1.25rem) ─────────────────────┐
│  time ruler: ticks · punch region · center playhead    │
└────────────────────────────────────────────────────────┘
┌─ canvas (15rem) ───────────────────────────────────────┐
│ |── 36px piano ──|──── scrolling pitch roll ───────── │
│  song ribbon (blue) · take ribbon (red) · live (orange) │
│  dashed center playhead · note label top-right          │
└────────────────────────────────────────────────────────┘
```

**Key constants:** MIDI 45–84 (A2–C6, 40 rows), `WINDOW_S = 8` (8-second visible window centred on currentTime), canvas height `15rem`.

**Time ruler interactions:**
- Drag empty area → create punch region
- Drag near In/Out handle (±`HANDLE_HIT = 8` px) → move that boundary
- Click (< 0.5 s drag) → clear punch
- `capturedT0` pattern: captures `currentTime - WINDOW_S/2` at mousedown so window coordinates stay stable during drag even while playing
- `rulerOverride` ref: live preview during drag without committing to store until mouseup

**Drag-to-seek (main canvas):** Horizontal drag seeks the playhead. `deltaT = -((deltaX / rollW) * WINDOW_S)` — drag left = forward, drag right = backward.

**Drawing passes (in order):** lane backgrounds → song ribbon (blue) → take ribbon (red) → live ribbon (orange) → center playhead → note label top-right → piano key strip.

### PianoKeyboard (`src/components/analysis/PianoKeyboard.tsx`)

Horizontal key strip. MIDI 45–84. Highlights current note in song=blue / take=red / live=orange priority. All white keys show labels: C notes include octave (`C3`, `C4`…), others show just the letter (`D`, `E`…).

### Analysis store (`src/stores/analysis.ts`)

| Field | Type | Description |
|---|---|---|
| `songPitch` | `PitchPoint[]` | song pitch (from SRH, loaded from analysis.json) |
| `takePitch` | `PitchPoint[]` | current take pitch |
| `livePitch` | `PitchPoint[]` | real-time pitch from mic (accumulates during recording) |
| `songOnsets` / `takeOnsets` | `number[]` | onset times |
| `songDynamics` / `takeDynamics` | `DynamicsPoint[]` | RMS curves |
| `vibrato` | `VibratoMetrics\|null` | computed from take pitch |
| `isLoaded` | `boolean` | true after `loadSongAnalysis` resolves |

`PitchData` (parallel arrays from sidecar) → converted to `PitchPoint[]` on load.

---

## Python sidecar

### Commands

| Command | Description | Timeout |
|---|---|---|
| `process` | Demucs htdemucs → SRH pitch → onsets → dynamics → BPM → key | 600 s |
| `analyze` | pYIN pitch → onsets → dynamics → vibrato (for recorded takes) | 300 s |
| `pitch_shift` | phase-vocoder shift vocals + instrumental; cached in `pitched/{n}/` | 300 s |
| `import_yt` | yt-dlp download → `process` pipeline; bot-detection browser cookie fallback | 900 s |
| `ping` / `quit` | health check / shutdown | — |

### Pitch detection choices
- **Song vocals → SRH** (Summation of Residual Harmonics, Drugman & Dutoit 2011). Chosen because pYIN and CREPE both tracked upper harmonics instead of the fundamental on strong chest-voice singers. SRH sums harmonic energy and subtracts inter-harmonic energy — structurally immune to dominant upper harmonics. Validated on Chris Cornell vocals vs VoceVista.
  - Resamples to 22050 Hz, `frame_length=4096`, 0.5 Hz candidate grid, `n_harmonics=5`, parabolic interpolation, median + Gaussian smoothing on voiced frames.
- **Recorded takes → pYIN** (librosa). Clean close-mic signal, no octave-dominance issue. Faster than SRH.

---

## Player store shape (`src/stores/player.ts`)

Key state fields (abbreviated):

```ts
song: Song | null
isPlaying: boolean
currentTime: number
duration: number
playbackRate: number
vocalsVolume: number
instrumentalVolume: number
takeVolume: number
isLooping: boolean        // legacy A/B loop (loopStart/loopEnd)
transpose: number         // active semitone shift
isTransposing: boolean
isRecording: boolean
takes: Take[]
activeTakeId: string | null
punchIn: number | null
punchOut: number | null
punchLoop: boolean
audioDevices: MediaDeviceInfo[]
selectedDeviceId: string | null
outputDevices: MediaDeviceInfo[]
selectedOutputDeviceId: string | null
```

`getEngine()` and `getRecorder()` are module-level singletons, not stored in Zustand.

---

## Current git state

- **Branch:** `master` (up to date with `origin/master`)
- **Open feature branch:** `feature/pitch-ribbon-consonant-gaps` — parked, do NOT merge. Consonant-gap suppression in the pitch ribbon (ring-window outlier suppression). User said: *"DON'T merge it in master. We will continue parallely from master."*
- **Phase 1 (full feature set):** Complete as of session in April 2026.

### Recent work (last session, June 2026)
- Added all-white-key note labels to PianoKeyboard
- Piano roll: note label moved to top-right, time ruler with punch region, drag-to-seek
- Song Analyzer fork created at `C:\Workspace\GiaMat90\SongAnalyzer` (separate project)

---

## Development commands

```powershell
# Run in dev mode
npm run tauri dev

# Type-check only (no emit)
npx tsc --noEmit

# Build release
npm run tauri build

# Build Python sidecar executable
cd sidecar
.\.venv\Scripts\activate
python build.py
```

**Hot reload:** React/TypeScript changes reload automatically. Rust changes require full restart.  
**Sidecar:** Not auto-started by `npm run tauri dev`. Spawned lazily on first use.

---

## Key patterns to follow

1. **Canvas components use rAF, not React state, for real-time updates.** PianoRoll, PianoKeyboard, TimeRuler all draw via `requestAnimationFrame` and read `getEngine().getCurrentTime()` directly. React re-renders only when pitch data or store slices change.

2. **`rulerOverride` ref pattern for live drag preview.** The rAF draw loop reads a ref for in-progress values and only commits to the Zustand store on mouseup. Avoids store churn during drag.

3. **`capturedT0` for stable coordinates during moving-window drag.** Capture `currentTime - WINDOW_S/2` at mousedown; use that constant throughout the drag. Otherwise the coordinate system drifts with the playhead while playing.

4. **WaveSurfer `"interaction"` not `"seeking"` for cross-sync.** The `"seeking"` HTML5 event fires on programmatic `seekTo()` too, causing infinite loops. `"interaction"` fires only on user clicks.

5. **`setOptions({ width: px })` to force WaveSurfer redraw.** CSS-only width changes are not reliably picked up by WaveSurfer's ResizeObserver. Pair with explicit `setOptions` call.

6. **PowerShell `@'...'@` here-string for multi-line git commits.** Bash `$(cat <<'EOF'...)` does not work in PowerShell (`<` operator error).
