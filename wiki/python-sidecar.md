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
2. SRH pitch detection on the vocals track (see [Pitch Detection](#pitch-detection))
3. Onset detection
4. RMS dynamics
5. BPM estimation (full mix)
6. Key detection (Krumhansl-Kessler profiles)

Returns Song metadata as `data`.

### `analyze`

Analyzes a recorded take (after the singer finishes recording).

```json
{"cmd": "analyze", "recordingPath": "/path/to/take.webm", "outputDir": "/path/to/song/"}
```

Steps (in `analysis.py`):
1. SRH pitch detection (same `detect_pitch_srh` as song processing) — resampled to 22050 Hz
2. Onset detection
3. RMS dynamics
4. Vibrato rate/depth computation

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

## Pitch Detection

### Song vocals — SRH (Summation of Residual Harmonics)

`processor.py` uses a custom SRH implementation (Drugman & Dutoit 2011) for pitch detection on separated vocals.

CREPE and pYIN were tried first and both failed on singers with strong upper harmonics (e.g. chest-voice tenors/baritones where the 2nd harmonic has more energy than the fundamental — CREPE tracked the 2nd formant, pYIN tracked the 2nd harmonic). HPS was tried next and gave the correct octave but was too jittery due to coarse FFT bin resolution. SRH was chosen because it sums harmonic energy and subtracts inter-harmonic energy, making it structurally immune to dominant upper harmonics. Validated against VoceVista on Chris Cornell vocals.

**Parameters are aligned with VoceVista "Singing - Narrowband" profile:**

| Parameter | Value | Rationale |
|---|---|---|
| `frame_length` | 2048 | 92.9 ms window at 22050 Hz — matches VoceVista max pitch window |
| `hop_length` | 512 | 23.2 ms step (~43 frames/s) |
| `fmin` | 65.0 Hz | C2 — lowest practical singing fundamental |
| `fmax` | 1400.0 Hz | Above F#6 — VoceVista upper limit; no singer exceeds this; cuts candidate grid ~34% |
| `n_harmonics` | 5 | — |
| `voicing_threshold` | 0.25 | VoceVista `minimumClarity` from XML profile |
| `amplitude_threshold` | −50 dBFS | VoceVista `minimumIntensity`; silent frames skipped before SRH |
| Window function | Dolph-Chebyshev (`chebwin`, at=100 dB) | Lower inter-harmonic leakage than Hanning; VoceVista uses same |

Additional details:
- Vocals resampled to 22050 Hz before detection for consistent bin resolution (10.77 Hz/bin at `frame_length=2048`; parabolic interpolation on SRH score curve gives sub-Hz precision)
- Candidate F0 grid: 0.5 Hz steps from 65 → 1400 Hz — ~2670 candidates per frame
- Per-frame RMS amplitude gate (−50 dBFS) applied before LPC — silent frames leave `f0[i]=0, confidence[i]=0`
- **LP residual extraction (order 12):** each frame is LP inverse-filtered before windowing, removing vocal tract formant contributions from the spectrum. Without this step the algorithm is SSH (Summation of Speech Harmonics), the inferior baseline in Drugman & Alwan 2011. LPC order 12 is optimal per the paper (robust in range 10–18); higher orders overfit the spectral envelope in noisy conditions.
- Post-processing on voiced frames only: median filter `size=3`, Gaussian `sigma=1.0`
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
