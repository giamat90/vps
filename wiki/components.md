# Frontend Components

**Directory:** `src/components/`

## Component Tree

```
App
├── upload/
│   ├── DropZone          — drag-and-drop audio file import
│   └── YouTubeImport     — paste-and-import YouTube URL
└── player/
    ├── Waveform           — dual waveform display (vocals + instrumental)
    ├── TransportControls  — play/pause/stop + volume sliders
    ├── TempoControl       — playback rate control
    ├── KeyTranspose       — semitone transpose UI
    └── OutputSelector     — audio output device picker
recording/
    ├── RecordButton       — start/stop recording
    ├── MicSelector        — microphone input source picker
    ├── TakeList           — list of recorded takes with delete
    └── ABToggle           — A/B switch between original vocals and a take
analysis/
    ├── DualTuner          — real-time pitch tuner (reference vs. singer)
    ├── PianoRoll          — pitch curve overlaid on a piano roll grid
    ├── VibratoCard        — vibrato rate / depth / regularity summary
    ├── TimingChart        — timing deviation chart (user vs. reference onsets)
    └── DynamicsCurve      — RMS dynamics over time
coaching/
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
| `playbackRate` | `number` | Speed multiplier (0.5–2.0) |
| `vocalsVolume` | `number` | 0–1 |
| `instrumentalVolume` | `number` | 0–1 |
| `isLooping` | `boolean` | Loop mode active |
| `loopStart / loopEnd` | `number \| null` | Loop region (seconds) |
| `transpose` | `number` | Active semitone shift |
| `isTransposing` | `boolean` | Pitch-shift in progress |
| `isRecording` | `boolean` | Recording in progress |
| `takes` | `Take[]` | All takes for current song |
| `activeTakeId` | `string \| null` | Selected take for A/B comparison |
| `abMode` | `"original" \| "take"` | A/B playback mode |
| `vocalsLoading` | `boolean` | Vocals track reloading (disables play button) |
| `audioDevices` | `MediaDeviceInfo[]` | Available microphone inputs |
| `selectedDeviceId` | `string \| null` | Selected mic device ID |
| `outputDevices` | `MediaDeviceInfo[]` | Available audio outputs |
| `selectedOutputDeviceId` | `string \| null` | Selected output device ID |

## GUI Rule

**All dimensions must use relative units** — `%`, `rem`, `vw`, `vh`, `fr`. Never use fixed pixel values (`px`) for layout dimensions. This ensures the UI scales correctly across different screen sizes and DPI settings.

## Notable Component Details

### TransportControls

Stop button routes to `stopRecording()` during recording, `stop()` otherwise:

```tsx
<button onClick={isRecording ? () => void stopRecording() : stop}>
```

Play button is disabled while `vocalsLoading` is true (prevents double-start during take/transpose reload).

### RecordButton

Starts recording via `startRecording()`. If recording is already active, clicking stops via `stopRecording()`. Displays a pulsing red indicator while `isRecording` is true.

### ABToggle

Switches `abMode` between `"original"` and `"take"`. Requires `activeTakeId` to be set (done via `TakeList`). The `setABMode` action is async — it awaits `loadVocalsFromPath` before returning.

### MicSelector / OutputSelector

Call `fetchAudioDevices()` / `fetchOutputDevices()` on mount to populate device lists. After `getUserMedia` succeeds during recording, device labels become available and `fetchAudioDevices()` is called again to refresh the list with human-readable names.

### KeyTranspose

Displays the current `transpose` value in semitones with ±12 range. Triggers `setTranspose(n)` which pauses playback, calls the Python sidecar to generate shifted WAVs, then reloads the engine with the new files.

### YouTubeImport

Input + button for pasting a YouTube URL. Validates the URL client-side with a regex before calling `importYoutube(url)` on the library store. Disabled while any processing job is active. Errors from the store are shown as a dismissible red banner in `LibraryPage`.

### SongCard (inline in `LibraryPage`)

Each song in the library list is rendered by a `SongCard` component with local state:

- **Pitch control** — ±6 semitone offset (−/+ buttons + value display + × reset). At 0 the export is direct; at any other value `pitchShiftSong(song.directory, n)` is called first and the shifted WAV paths are passed to `exportStem`. The suggested filename includes the offset, e.g. `Song - Vocals (+3st).wav`.
- **Export buttons** — "↓ Vocals" and "↓ Instr." trigger `exportStem` via a native Save-As dialog. Both are disabled and show `…` while pitch-shifting is in progress.
