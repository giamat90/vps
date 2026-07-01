# Data Model

**Key files:** `src/lib/types.ts` · `src-tauri/src/commands.rs` · `src-tauri/src/library.rs` · `src-tauri/src/storage.rs`

## TypeScript Interfaces

### Song

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
```

### Take

```ts
interface Take {
  id: string;
  songId: string;
  recordedAt: string;     // ISO timestamp
  filepath: string;       // absolute path to the recording file
  startPosition: number;  // song time (seconds) where recording began; 0 for full-song takes
  audioOffset?: number;   // seconds to skip into the audio file on playback (see Latency Compensation)
  pitchData?: PitchData;  // raw pYIN output (parallel arrays)
  onsets?: number[];
  dynamics?: DynamicsPoint[];
  vibrato?: VibratoMetrics;
}
```

### PitchData

Raw pitch output from the Python sidecar (SRH for songs, pYIN for takes). Parallel arrays — index `i` represents one analysis frame.

```ts
interface PitchData {
  times: number[];       // frame timestamps (seconds)
  f0: number[];          // fundamental frequency (Hz); 0.0 for unvoiced frames
  voiced: boolean[];     // true when the frame is classified as voiced
  confidence: number[];  // 0–1 voicing confidence
}
```

Converted to `PitchPoint[]` on the frontend via `pitchDataToPoints()` in `src/stores/analysis.ts` (filters unvoiced frames, pairs time + frequency + confidence).

### PitchPoint

```ts
interface PitchPoint {
  time: number;       // seconds from start of take
  frequency: number;  // Hz
  confidence: number; // 0–1
}
```

### DynamicsPoint

```ts
interface DynamicsPoint {
  time: number; // seconds
  rms: number;  // RMS amplitude 0–1
}
```

### VibratoMetrics

```ts
interface VibratoMetrics {
  rate: number;       // Hz (typical: 4–7 Hz for healthy vibrato)
  depth: number;      // semitones peak-to-peak
  regularity: number; // 0–1
}
```

### ExerciseTake

Free-exercise take (no song reference). Stored under `~/.vps/exercises/`.

```ts
interface ExerciseTake {
  id: string;
  recordedAt: string;  // ISO timestamp
  filepath: string;    // absolute path to .webm file
  duration: number;    // seconds
  pitchData?: PitchData;
  dynamics?: DynamicsPoint[];
  vibrato?: VibratoMetrics;
}
```

### ProcessingStatus (event payload)

```ts
interface ProcessingStatus {
  songId: string;
  progress: number;  // 0–1
  stage: string;     // e.g. "separating", "detecting pitch"
  isComplete: boolean;
  error?: string;
}
```

### CoachingTip

```ts
interface CoachingTip {
  category: "pitch" | "timing" | "vibrato" | "dynamics" | "general";
  title: string;
  detail: string;
}
```

## Storage Layout

All data lives under `~/.vps/` (Windows: `C:\Users\{user}\.vps\`).

```
~/.vps/
├── library/
│   └── {songId}/              UUID directory per song
│       ├── {original}.mp3     copy of the source file
│       ├── vocals.wav         separated vocals (Demucs)
│       ├── instrumental.wav   separated instrumental (Demucs)
│       ├── analysis.json      pitchData + onsets + dynamics
│       ├── takes.json         Take[] metadata
│       ├── pitched/{n}/       pitch-shifted WAV cache (n = semitone steps)
│       └── takes/
│           └── {takeId}.webm  recorded take audio files
└── exercises/
    ├── exercises.json         ExerciseTake[] metadata
    └── takes/
        └── {takeId}.webm     free-exercise recordings
```

## Tauri Commands

| Command | Arguments | Returns |
|---------|-----------|---------|
| `process_song` | `filePath: string, highQuality?: boolean` | `Song` |
| `import_youtube` | `url: string, highQuality?: boolean` | `Song` |
| `list_songs` | — | `Song[]` |
| `delete_song` | `songId: string` | `void` |
| `save_take` | `songId, audioData: number[], startPosition: f64, audioOffset: f64` | `Take` |
| `list_takes` | `songId: string` | `Take[]` |
| `delete_take` | `songId, takeId: string` | `void` |
| `load_analysis` | `songId: string` | `{ pitchData, onsets, dynamics }` |
| `pitch_shift_song` | `songDir: string, nSteps: number` | `{ vocalsPath, instrumentalPath }` |
| `save_exercise_take` | `audioData: number[], duration: f64` | `ExerciseTake` |
| `list_exercise_takes` | — | `ExerciseTake[]` |
| `delete_exercise_take` | `takeId: string` | `void` |

All commands are async and return a `Promise`. Errors are thrown as strings.

## Tauri Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `"processing-progress"` | Rust → frontend | `ProcessingStatus` |
