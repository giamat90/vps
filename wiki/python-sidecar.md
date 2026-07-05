# Python Sidecar

**Files:** `sidecar/main.py` · `sidecar/processor.py` · `sidecar/analysis.py` · `sidecar/yt_importer.py` · `sidecar/build.py`

## Role

The Python sidecar handles all computationally heavy audio processing that would be impractical to do in Rust or the browser:

- **Stem separation** — split a mixed audio file into vocals + instrumental
- **Pitch detection** — extract pitch curves from a recording
- **Pitch shifting** — transpose tracks by N semitones
- **Take post-processing** — WAV conversion, RMS loudness normalization, short-term spectrum
- **Mixdown rendering** — sum tracks with per-source gain over a time window (`mix_export`)

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
{"cmd": "process", "filePath": "/path/to/song.mp3", "outputDir": "/path/to/output/", "highQuality": false, "skipSeparation": false}
```

`highQuality` (optional, default `false`) — selects the Demucs model: `htdemucs_ft` (fine-tuned, ~2-3x slower, better isolation) instead of `htdemucs` (fast, standard quality). Only affects model selection in `processor.process()`; no other stage changes. Ignored when `skipSeparation` is set.

`skipSeparation` (optional, default `false`) — set when importing an instrument practice track (`kind: "instrument"` in the [data model](data-model.md#song)). The input is already an isolated monophonic recording, so Demucs is skipped entirely: `processor.process()` loads the file directly via `librosa.load()`, writes it to `vocals.wav`, and `shutil.copyfile`s it to `instrumental.wav` (an identical duplicate, so the rest of the pipeline — `AudioEngine`, `pitch_shift_song`, `Waveform` — needs no special-casing). Progress reports `"loading-track"` instead of `"stem-separation"` for this stage.

Steps (in `processor.py`):
1. Demucs `htdemucs` (or `htdemucs_ft` if `highQuality`) — produces `vocals.wav` and `instrumental.wav`; **or**, if `skipSeparation`, load the input directly and duplicate it to both paths
2. SRH pitch detection on the vocals track (see [Pitch Detection](#pitch-detection))
3. Onset detection
4. RMS dynamics
5. BPM estimation (full mix)
6. Key detection (Krumhansl-Kessler profiles)

Returns Song metadata as `data`.

### `analyze`

Analyzes a recorded take (after the singer finishes recording).

```json
{"cmd": "analyze", "recordingPath": "/path/to/take.webm", "outputDir": "/path/to/song/takes/", "audioOffset": 0.256, "referencePath": "/path/to/song/vocals.wav"}
```

`audioOffset` (optional, default `0.0`) — seconds to skip at the start of the audio file before processing. Non-zero when latency compensation shifted the take's `startPosition` below 0 and the engine skips a silent prefix on playback. Both `librosa.load()` calls in `analysis.py` pass `offset=audio_offset_s`, so all output times (pitch, onsets, dynamics) are 0-based from the audible content start and correctly align with the song.

`referencePath` (optional) — loudness reference stem, in practice always `vocals.wav`. When present, the take is **RMS-normalized** against it: gain = reference RMS / take RMS, peak-capped so nothing clips, written as a `{takeId}.wav` next to the raw recording and returned as `normalizedPath`. Rust's `save_take` then keeps the normalized WAV and deletes the raw `.webm` (falling back to the `.webm` if normalization failed). This is why recorded takes no longer sound quiet next to mastered Demucs stems.

Steps (in `analysis.py`):
1. SRH pitch detection (same `detect_pitch_srh` as song processing) — resampled to 22050 Hz
2. Onset detection
3. RMS dynamics
4. Vibrato rate/depth computation
5. Short-term spectrum envelope (for the comparison panel)
6. RMS loudness normalization against `referencePath` (when given)

Returns analysis payload (pitchData, onsets, dynamics, vibrato, `stSpectrum*` fields, `normalizedPath`) as `data`.

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
{"cmd": "import_yt", "url": "https://youtube.com/watch?v=...", "outputDir": "/path/to/output/", "highQuality": false}
```

`highQuality` (optional, default `false`) — same meaning as in `process`; threaded straight through to `processor.process()`.

Implemented in `yt_importer.py` via `yt-dlp`. Steps:

1. Download best audio → `source.wav` (via FFmpegExtractAudio post-processor). Progress maps to 0–15%.
2. Run `processor.process(source_wav, output_dir, high_quality=high_quality)` for separation + analysis. Progress maps to 15–100%.

Returns the same dict as `process`, with `"title"` added (extracted from yt-dlp metadata).

**Bot-detection fallback:** first attempt uses no cookies. If YouTube returns a "Sign in to confirm you're not a bot" error, retries with `cookiesfrombrowser` cycling through Chrome → Firefox → Edge → Brave → Opera. Any other error (private video, bad URL, network failure) raises immediately without retrying. Partial output files are cleaned up between attempts.

### `compute_st_spectrum`

Computes the log-Hz short-term spectral envelope of an audio file over time (used for the song side of the `ShortTermSpectrumComparisonPanel`). Implemented as `compute_st_spectrum_from_file` in `processor.py`; accepts an optional `audioOffset` in seconds. Returns the same base64-packed byte-matrix shape as the `stSpectrum*` fields of `analyze` (`times`, `b64`, `frames`, `bins`, `minDb`, `maxDb`).

```json
{"cmd": "compute_st_spectrum", "audioPath": "/path/to/vocals.wav"}
```

### `convert_take`

Decodes a take (webm/opus) via `librosa.load` and writes a WAV via `soundfile` — used by `export_take` so exported takes are always WAV regardless of the recorded container.

```json
{"cmd": "convert_take", "recordingPath": "/path/to/take.webm", "outputPath": "/path/to/out.wav"}
```

### `mix_export`

Renders a single mixdown WAV from a list of sources, honoring the frontend's live mute/solo/volume state and the punch/loop region (implemented in `analysis.py`).

```json
{"cmd": "mix_export", "sources": [{"path": "...", "gain": 0.8, "isTake": false}, {"path": "...", "gain": 1.0, "isTake": true, "startPosition": 12.5, "audioOffset": 0.25}], "startSec": 10.0, "endSec": 42.0, "outputPath": "/path/to/mix.wav"}
```

Each source is loaded only over the `[startSec, endSec)` window; takes are aligned via `fileTime = projectTime - startPosition + audioOffset`. Sources are resampled/upmixed to a common rate and channel count, summed with per-source gain, then peak-safe scaled before writing.

### `ping` / `quit`

```json
{"cmd": "ping"}
{"cmd": "quit"}
```

## Pitch Detection

### Song vocals — SRH (Summation of Residual Harmonics)

`processor.py` uses a custom SRH implementation (Drugman & Dutoit 2011) for pitch detection on separated vocals.

CREPE and pYIN were tried first and both failed on singers with strong upper harmonics (e.g. chest-voice tenors/baritones where the 2nd harmonic has more energy than the fundamental — CREPE tracked the 2nd formant, pYIN tracked the 2nd harmonic). HPS was tried next and gave the correct octave but was too jittery due to coarse FFT bin resolution. SRH was chosen because it sums harmonic energy and subtracts inter-harmonic energy, making it structurally immune to dominant upper harmonics. Validated against VoceVista on Chris Cornell vocals.

**Parameters are aligned with VoceVista "Singing - Narrowband" profile:**

| Parameter | Value | Rationale |
|---|---|---|
| `frame_length` | 2756 | 125 ms window at 22050 Hz — per Babacan et al. 2019, optimal analysis window for singing (this table previously said 2048/92.9ms, matching the VoceVista window instead of the actual code value — fixed 2026-07-04) |
| `hop_length` | 512 | 23.2 ms step (~43 frames/s) |
| `fmin` | 65.0 Hz | C2 — lowest practical singing fundamental |
| `fmax` | 1400.0 Hz | Above F#6 — VoceVista upper limit; no singer exceeds this; cuts candidate grid ~34% |
| `n_harmonics` | 5 | — |
| `voicing_threshold` | 0.25 | VoceVista `minimumClarity` from XML profile |
| `amplitude_threshold` | −50 dBFS | VoceVista `minimumIntensity`; silent frames skipped before SRH |
| Window function | Dolph-Chebyshev (`chebwin`, at=100 dB) | Lower inter-harmonic leakage than Hanning; VoceVista uses same |

Additional details:
- Vocals resampled to 22050 Hz before detection for consistent bin resolution (5.4 Hz/bin from zero-padding to `fft_size=4096`; parabolic interpolation on SRH score curve gives sub-Hz precision)
- Candidate F0 grid: 0.5 Hz steps from 65 → 1400 Hz — ~2670 candidates per frame
- Per-frame RMS amplitude gate (−50 dBFS) applied before windowing — silent frames leave `f0[i]=0, confidence[i]=0`
- LP residual extraction was tested and reverted: Demucs-separated vocals are already clean and Demucs distorts the spectral envelope, making LPC vocal tract modeling unreliable. The SRH noise-robustness advantage of LP residual (Drugman & Alwan 2011) only applies to raw noisy speech.
- Post-processing on voiced frames only: median filter `size=6`, Gaussian `sigma=1.5`
- Fully deterministic — no neural network, no randomness
- Runs synchronously on the main thread (no threading)

Output schema (identical to previous detectors — no TypeScript changes required):

```json
{
  "times": [0.0, 0.023, ...],
  "f0": [0.0, 370.5, ...],
  "voiced": [false, true, ...],
  "confidence": [0.0, 0.94, ...]
}
```

SRH evaluates ~2670 candidates per frame; acceptable for synchronous sidecar execution. Do not add threading to compensate.

### Recording takes — SRH

`analysis.py` uses the same `detect_pitch_srh` function as song processing. All parameters (window, thresholds, window function) are identical — consistent pitch representation between song and take ribbons in the piano roll.

## Libraries

| Library | Use |
|---------|-----|
| Demucs | Stem separation (htdemucs model, CPU or GPU) |
| librosa | SRH pitch detection, pYIN, pitch shifting, onset detection, RMS |
| soundfile | Audio file I/O |
| numpy / scipy | Numerical operations, filters |
| torch | Required by Demucs (not used for pitch detection) |
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

The binary is declared as `externalBin` in `tauri.conf.json` so Tauri includes it in the NSIS/DMG bundle. A 0-byte placeholder at `src-tauri/binaries/vps-sidecar-x86_64-pc-windows-msvc.exe` is committed to satisfy `tauri_build` at local-dev build time; CI always overwrites it with the real PyInstaller binary before `cargo build` runs.

## Python Interpreter Selection

`SidecarManager::spawn()` calls `find_python(sidecar_dir)` to pick the interpreter:

1. **Venv first** — checks `sidecar/.venv/Scripts/python.exe` (Windows) or `.venv/bin/python3` / `.venv/bin/python` (Unix). If found, uses it and logs the path.
2. **System fallback** — if no venv exists (CI PyInstaller path, or venv not set up), falls back to `python` on PATH.

This matters because the venv may carry a newer `yt-dlp` than the system Python. YouTube actively rejects old yt-dlp versions, which would cause `import_yt` to fail in the built app if the system Python is stale. Always keep `yt-dlp` up to date in the venv (`pip install --upgrade yt-dlp`).
