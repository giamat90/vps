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
{"cmd": "process", "filePath": "/path/to/song.mp3", "outputDir": "/path/to/output/", "highQuality": false, "skipSeparation": false, "algorithm": "srh"}
```

`highQuality` (optional, default `false`) — selects the Demucs model: `htdemucs_ft` (fine-tuned, ~2-3x slower, better isolation) instead of `htdemucs` (fast, standard quality). Only affects model selection in `processor.process()`; no other stage changes. Ignored when `skipSeparation` is set.

`skipSeparation` (optional, default `false`) — set when importing an instrument practice track (`kind: "instrument"` in the [data model](data-model.md#song)). The input is already an isolated monophonic recording, so Demucs is skipped entirely: `processor.process()` loads the file directly via `librosa.load()`, writes it to `vocals.wav`, and `shutil.copyfile`s it to `instrumental.wav` (an identical duplicate, so the rest of the pipeline — `AudioEngine`, `pitch_shift_song`, `Waveform` — needs no special-casing). Progress reports `"loading-track"` instead of `"stem-separation"` for this stage.

`algorithm` (optional, default `"srh"`) — one of `"srh"`, `"praat"`, `"pyin"`, `"hps"`, `"crepe"`; user-selectable in the Settings panel. See [Pitch Detection](#pitch-detection-user-selectable).

Steps (in `processor.py`):
1. Demucs `htdemucs` (or `htdemucs_ft` if `highQuality`) — produces `vocals.wav` and `instrumental.wav`; **or**, if `skipSeparation`, load the input directly and duplicate it to both paths
2. Pitch detection on the vocals track, algorithm per `algorithm` (see [Pitch Detection](#pitch-detection-user-selectable))
3. Onset detection
4. RMS dynamics
5. BPM estimation (full mix)
6. Key detection (Krumhansl-Kessler profiles)

Returns Song metadata as `data`.

### `analyze`

Analyzes a recorded take (after the singer finishes recording).

```json
{"cmd": "analyze", "recordingPath": "/path/to/take.webm", "outputDir": "/path/to/song/takes/", "audioOffset": 0.256, "referencePath": "/path/to/song/vocals.wav", "algorithm": "srh"}
```

`audioOffset` (optional, default `0.0`) — seconds to skip at the start of the audio file before processing. Non-zero when latency compensation shifted the take's `startPosition` below 0 and the engine skips a silent prefix on playback. Both `librosa.load()` calls in `analysis.py` pass `offset=audio_offset_s`, so all output times (pitch, onsets, dynamics) are 0-based from the audible content start and correctly align with the song.

`referencePath` (optional) — loudness reference stem, in practice always `vocals.wav`. When present, the take is **RMS-normalized** against it: gain = reference RMS / take RMS, peak-capped so nothing clips, written as a `{takeId}.wav` next to the raw recording and returned as `normalizedPath`. Rust's `save_take` then keeps the normalized WAV and deletes the raw `.webm` (falling back to the `.webm` if normalization failed). This is why recorded takes no longer sound quiet next to mastered Demucs stems.

`algorithm` (optional, default `"srh"`) — same selectable pitch algorithm as `process`; should match whatever was used for the song so take/song pitch curves compare meaningfully.

Steps (in `analysis.py`):
1. Pitch detection via `get_pitch_fn(algorithm)` (same dispatch as song processing) — resampled to 22050 Hz
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
{"cmd": "import_yt", "url": "https://youtube.com/watch?v=...", "outputDir": "/path/to/output/", "highQuality": false, "algorithm": "srh"}
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

## Pitch Detection (user-selectable)

Pitch extraction on separated vocals is a **user-selectable algorithm**, chosen in the app's Settings
panel (`src/components/settings/PitchAlgorithmControl.tsx`, backed by the `pitchAlgorithm` field in
`src/stores/settings.ts`, persisted to `localStorage`). The choice is global — the same algorithm is
used for song vocals (`processor.py`'s `process()`) and recorded takes (`analysis.py`'s
`analyze_recording()`), so song and take pitch ribbons stay comparable in the piano roll.

`processor.py` holds a small dispatch registry:

```python
PITCH_ALGORITHMS = {"srh": detect_pitch_srh, "pyin": detect_pitch, "hps": detect_pitch_hps, "crepe": detect_pitch_crepe, "praat": detect_pitch_praat}
def get_pitch_fn(algorithm): return PITCH_ALGORITHMS.get(algorithm or "srh", detect_pitch_srh)
```

The `algorithm` field flows: Settings UI → `useSettingsStore` → `processSong`/`saveTake`/`importYoutube`/
`saveExerciseTake` (`src/lib/tauri.ts`) → Rust `commands.rs` → JSON `"algorithm"` field on the `process`/
`analyze`/`import_yt` sidecar commands → `main.py` dispatch (defaults to `"srh"` if absent) →
`get_pitch_fn(...)`.

### SRH (Summation of Residual Harmonics) — the default

`processor.py` uses a custom SRH implementation (Drugman & Dutoit 2011) for pitch detection on separated vocals.

CREPE and pYIN were tried first and both failed on singers with strong upper harmonics (e.g. chest-voice tenors/baritones where the 2nd harmonic has more energy than the fundamental — CREPE tracked the 2nd formant, pYIN tracked the 2nd harmonic). HPS was tried next and gave the correct octave but was too jittery due to coarse FFT bin resolution. SRH was chosen as the **original default** because it sums harmonic energy and subtracts inter-harmonic energy, making it structurally immune to dominant upper harmonics. Validated against VoceVista on Chris Cornell vocals. Praat (below) briefly took the default slot after beating it in the `v0.1.37` pitch_lab A/B and an in-app listening test on two test tracks; **SRH was reinstated as the default on 2026-07-12** after the user ran their own in-app A/B across all five algorithms and rated SRH clearly best, with CREPE second. Its residual failure mode is jumping *up* to an upper harmonic on raspy chest-voice passages — the mirror image of Praat's occasional fry-region dive.

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

### pYIN — selectable alternative

`detect_pitch` in `processor.py`: `librosa.pyin` (autocorrelation-based) plus a spectral subharmonic
correction pass (`_correct_octave_errors_spectral`). Was dead code in the live pipeline for some time
(pitch_lab-only baseline) before becoming user-selectable again — see `sidecar/pitch_lab/CLAUDE.md` for
that history. Known failure mode: locks onto the 2nd harmonic on strong chest-voice singers, which is
why it has never held the default slot.

### HPS (Harmonic Product Spectrum) — selectable alternative

`detect_pitch_hps` in `processor.py`: decimates the spectrum by each harmonic index and multiplies the
results together. Simpler than SRH, no new dependency, but multiplicative combination makes it sensitive
to any single weak/missing harmonic — gives the correct octave but is noticeably more jittery than SRH,
consistent with the earlier lab finding above. Shares SRH's window/frame/hop conventions (22050 Hz,
`chebwin`, 4096-point FFT, 512 hop) so results stay visually comparable on the piano roll.

### CREPE — selectable alternative

`detect_pitch_crepe` in `processor.py`: deep-learning pitch tracker via `torchcrepe` (PyTorch-based,
reuses the `torch` dependency Demucs already needs — chosen over the original TensorFlow `crepe` package
specifically to avoid bundling a second ML framework). Uses the `"tiny"` model capacity to keep the
bundled model small and CPU inference tractable for a desktop app with no GPU assumed. Runs on 16 kHz
audio (its native/trained rate) rather than SRH/HPS's 22050 Hz. Noticeably slower than the DSP-based
algorithms on full-song audio — `torchcrepe.predict`'s own `batch_size` keeps this from being
prohibitive, but this is still the slowest of the five options. `torch`/`torchcrepe` are imported lazily
inside the function so a sidecar run that never selects CREPE doesn't pay the import cost.

### Praat — selectable alternative, former default

`detect_pitch_praat` in `processor.py`: Praat's autocorrelation method (Boersma 1993) via
`praat-parselmouth` (`Sound.to_pitch_ac`), imported lazily like torchcrepe. Added in `v0.1.37` after
concluding that VoceVista tracks Demucs-split vocals better than the existing detectors, and promoted
to **default** immediately after: it beat SRH in the pitch_lab A/B on both test tracks (fundamental
held end-to-end with near-1.0 confidence on the clean vocal; sustained passages steady and the real
glide preserved on the raspy one) and in an in-app listening test. It held the default slot only briefly:
a broader in-app A/B across all five algorithms on 2026-07-12 rated SRH clearly best (CREPE second),
and the default reverted to SRH. Still a reasonable alternative — just no longer the default. Provenance: VoceVista's algorithm is unpublished, but its documented behavior — a
fundamental-pitch detector "completely separate from the FFT" (time-domain), a "prefer harmonic
fundamental" option, configurable pitch floor/ceiling, and an averaging window — matches Praat's design
(octave-cost candidate weighting + Viterbi path finding across frames), and the singing-voice
comparative study in `Researches/1912.12609v1` found Praat best at voicing determination. Uses
`time_step=512/22050` (~23.2 ms, matching the SRH/HPS/CREPE cadence), floor/ceiling 65–1400 Hz, and
Praat's default costs; parameter sweeps go through `pitch_lab`'s `praat_variant()` (most interesting
knobs: `octave_cost`, `voicing_threshold`). Confidence is Praat's candidate `strength` (autocorrelation
peak height) clipped to [0, 1].

`_smooth_voiced()` (median filter `size=6` + Gaussian `sigma=1.5` on voiced frames only) is shared by
SRH, HPS, and CREPE. pYIN and Praat deliberately skip it: pYIN's HMM and Praat's Viterbi path finding
are already temporal-smoothing passes of their own. (This section previously claimed all algorithms
shared `_smooth_voiced` — that was never true for pYIN; fixed 2026-07-11.)

### Recording takes

`analysis.py`'s `analyze_recording()` calls the same `get_pitch_fn(pitch_algorithm)` dispatch as song
processing, so song and take pitch curves use the same algorithm and stay comparable in the piano roll.
One correctness wrinkle: `_detect_vibrato`'s frequency-domain step-size assumption previously used a
fixed `STEP_MS` constant derived from SRH's hop length — since HPS/CREPE can use different effective
hops, `step_ms` is now derived per-call from the actual returned `pitch_result["times"]` spacing instead.

## Libraries

| Library | Use |
|---------|-----|
| Demucs | Stem separation (htdemucs model, CPU or GPU) |
| librosa | SRH/HPS pitch detection, pYIN, pitch shifting, onset detection, RMS |
| torchcrepe | CREPE pitch detection (selectable alternative), `"tiny"` model capacity |
| praat-parselmouth | Praat autocorrelation pitch detection (selectable alternative) |
| soundfile | Audio file I/O |
| numpy / scipy | Numerical operations, filters |
| torch | Required by Demucs; also backs `torchcrepe` |
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
