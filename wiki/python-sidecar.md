# Python Sidecar

**Files:** `sidecar/main.py` · `sidecar/processor.py` · `sidecar/analysis.py` · `sidecar/yt_importer.py` · `sidecar/build.py`

## Role

The Python sidecar handles all computationally heavy audio processing that would be impractical to do in Rust or the browser:

- **Stem separation** — split a mixed audio file into vocals + instrumental
- **Pitch detection** — extract pitch curves from a recording
- **Pitch shifting** — transpose tracks by N semitones

## IPC Protocol

Communication is **JSON lines** on stdin/stdout. Each message is a single JSON object terminated by `\n`. Stderr is not used for structured communication.

### Startup

On launch the sidecar sends:

```json
{"type": "ready"}
```

Rust waits for this before considering the sidecar usable.

### Request format

Rust sends one command at a time (the sidecar processes synchronously):

```json
{"cmd": "<command>", ...args}
```

### Response types

| `type` | When sent |
|--------|-----------|
| `"result"` | Command succeeded; payload in `"data"` |
| `"progress"` | Intermediate progress update |
| `"error"` | Command failed; `"message"` and `"traceback"` fields |
| `"pong"` | Response to `ping` |
| `"bye"` | Response to `quit`, sidecar exits |

### Progress messages

```json
{"type": "progress", "cmd": "process", "stage": "separating", "value": 0.42}
```

`value` is 0–1. The Rust backend forwards these as `"processing-progress"` Tauri events to the frontend.

## Commands

### `process`

Separates a mixed audio file and extracts analysis data.

```json
{"cmd": "process", "filePath": "/path/to/song.mp3", "outputDir": "/path/to/output/"}
```

Steps (in `processor.py`):
1. Demucs `htdemucs` model — produces `vocals.wav` and `instrumental.wav`
2. CREPE pitch detection on the vocals track → `pitch.json`
3. Onset detection → `onsets.json`
4. RMS dynamics → `dynamics.json`

Returns Song metadata as `data`.

### `analyze`

Analyzes a recorded take (after the singer finishes recording).

```json
{"cmd": "analyze", "recordingPath": "/path/to/take.webm", "outputDir": "/path/to/song/"}
```

Steps (in `analysis.py`):
1. Convert take to WAV via soundfile
2. CREPE pitch detection
3. Onset detection
4. RMS dynamics
5. Vibrato rate/depth computation

Returns analysis payload (pitchData, onsets, dynamics, vibrato) as `data`.

### `pitch_shift`

Transposes vocals and instrumental by N semitones using librosa.

```json
{"cmd": "pitch_shift", "songDir": "/path/to/song/", "cacheDir": "/path/to/cache/", "nSteps": 2}
```

Results are cached: if `vocals_+2.wav` already exists it is returned immediately without reprocessing.

Returns `{"vocalsPath": "...", "instrumentalPath": "..."}` as `data`.

### `import_yt`

Downloads a YouTube video as audio and runs it through the full `process` pipeline.

```json
{"cmd": "import_yt", "url": "https://youtube.com/watch?v=...", "outputDir": "/path/to/output/"}
```

Implemented in `yt_importer.py` via `yt-dlp`. Steps:

1. Download best audio → `source.wav` (via FFmpegExtractAudio post-processor). Progress maps to 0–15%.
2. Run `processor.process(source_wav, output_dir)` for separation + analysis. Progress maps to 15–100%.

Returns the same dict as `process`, with `"title"` added (extracted from yt-dlp metadata).

**Bot-detection fallback:** first attempt uses no cookies. If YouTube returns a "Sign in to confirm you're not a bot" error, retries with `cookiesfrombrowser` cycling through Chrome → Firefox → Edge → Brave → Opera. Any other error (private video, bad URL, network failure) raises immediately without retrying. Partial output files are cleaned up between attempts.

### `ping` / `quit`

```json
{"cmd": "ping"}
{"cmd": "quit"}
```

## Libraries

| Library | Use |
|---------|-----|
| Demucs | Stem separation (htdemucs model, CPU or GPU) |
| CREPE | Neural pitch detection (more accurate than pyin for singing) |
| librosa | Pitch shifting, onset detection, RMS |
| soundfile | Audio file I/O |
| numpy | Numerical operations |
| yt-dlp | YouTube audio download with browser-cookie fallback |

## Synchronous Execution

The sidecar runs all commands on the main thread without background threads. This avoids GIL/numpy deadlocks that occur with multithreading on Windows. The Rust side holds the sidecar mutex lock for the entire duration of a command, preventing concurrent jobs.

## Building the Sidecar

`sidecar/build.py` packages the Python environment into a standalone executable using PyInstaller. The output binary is placed where Tauri expects it (configured via `externalBin` in `tauri.conf.json`).

```
cd sidecar
python build.py
```

In development you can run the sidecar directly without building, but Tauri's `beforeDevCommand` does not start it automatically — the Rust `SidecarManager` spawns it lazily on first use.
