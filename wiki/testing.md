# Testing

Three suites, one per language, plus a few tests that deliberately cross the language boundary. All of them run in CI (`.github/workflows/test.yml`); `release.yml` still only builds installers.

| Suite | Command | Where | What it covers |
|---|---|---|---|
| Frontend | `npm test` (`npx vitest run`) | `src/**/*.test.ts`, `tests/**/*.test.ts` | pure libs, audio engine/recorder/metronome with fakes, all Zustand stores with the Tauri boundary mocked, the TS ↔ Rust IPC contract |
| Rust | `cargo test --lib` (in `src-tauri/`) | `#[cfg(test)]` modules + `src/integration_tests.rs` | library/take/exercise persistence, serde wire format, sidecar message parsing, and the **real** sidecar process driven through the real command bodies |
| Python sidecar | `python -m pytest` (in `sidecar/`, venv active) | `sidecar/tests/` | DSP (pitch algorithms, spectra, vibrato, loudness, mix-down), the full `process`/`analyze` pipelines, the stdio protocol of `main.py`, yt-dlp import flow, version check |

Coverage of the frontend: `npx vitest run --coverage` (v8; `src/lib`, `src/audio`, `src/stores`, ~95 % lines).

## Setup

```powershell
npm install                                   # vitest + @vitest/coverage-v8
cd sidecar
.\.venv\Scripts\python -m pip install -r requirements-test.txt   # pytest + the light audio stack (no torch/demucs)
```

`requirements-test.txt` is a subset of `requirements.txt`; tests needing `torch`/`torchcrepe` use `importorskip` and run only when the full requirements are installed. `VPS_SKIP_SLOW=1` skips tests marked `slow` (process spawning, CREPE).

## Coverage of the other two languages

The vitest config measures `lib`, `audio` and `stores` only, so its ~97 % hides the components (about 10-15 %). Measure everything with `npx vitest run --coverage --coverage.include='src/**'`.

- **Python:** `pytest-cov` is in `sidecar/requirements-test.txt`; `sidecar/.coveragerc` omits tests, the venv, vendored models and the pitch lab. `cd sidecar; python -m pytest --cov=.` (first run on a machine takes minutes: the suite drives real audio). `main.py` reads low (about 33 %) because the Rust tests exercise it in a subprocess; `build.py` and `fetch_models.py` are build scripts.
- **Rust:** `cargo install cargo-llvm-cov` and `rustup component add llvm-tools-preview` once, then `cd src-tauri; cargo llvm-cov --lib` (a full instrumented rebuild; set `CARGO_TARGET_DIR` elsewhere to keep your build cache). Inline `#[cfg(test)]` modules count as covered, so for a production-only figure export LCOV (`cargo llvm-cov report --lcov --output-path x.lcov`) and ignore lines after the `#[cfg(test)]` marker. The gaps are Tauri glue that needs a live window (`commands.rs`, the `windows.rs` wrappers).

How to read these numbers: [Code metrics: a short course](../../wiki/code-metrics-guide.md); the 2026-10-17 results are in [Code metrics snapshot](../../wiki/code-metrics-2026-10-17.md).

## Frontend conventions

- `vitest.config.ts`: node environment, `restoreMocks`/`clearMocks` on, `unstubGlobals` on. `src/test/setup.ts` installs an in-memory `localStorage`; everything else a test needs (`navigator.mediaDevices`, `AudioContext`, `MediaRecorder`, `OffscreenCanvas`, `requestAnimationFrame`, timers) it stubs itself with `vi.stubGlobal`.
- Stores are tested against mocked boundaries: `../lib/tauri` (or `@tauri-apps/api/core` when the wrappers themselves are under test), `../audio/engine`, and the shared `@giamat90/mps-core/recorder` / `@giamat90/mps-core/metronome` (mocked by their package specifier). `player.test.ts` re-imports the store with `vi.resetModules()` where module-level state matters (device watcher, persisted calibrations).
- `tests/contract/ipcContract.test.ts` asks `scripts/gen-ipc.mjs --list` for every `#[tauri::command]` and fails if `src/lib/ipc.generated.ts` is stale (`gen-ipc.mjs --check`), a command is missing from (or invented in) `generate_handler!` in `lib.rs`, or a wrapper (generated, or the lyrics/YouTube ones shipped in `@giamat90/mps-core`) calls a missing command, sends an argument Rust does not accept, or omits a required one. It lives outside `src/` because it needs Node's `fs`; `tsc` only checks `src/`.
- Canvas panels: the arithmetic and drawing passes live in `src/lib/spectrogram*`, `spectroShortTerm`, `spectroComparison`, `pianoRoll*` and are tested without React. `src/test/fakeCanvas.ts` gives a recording 2D context (`createRecordingContext()`: every call and property set as a string) and a fake canvas element; assert on the log (`fillText("1k",…)`, `strokeStyle="…"`), never on pixels. The React shells (`SpectrogramPanel.tsx`, `ShortTermSpectrumPanel.tsx`, `PianoRoll.tsx`) are not unit-tested; when you change one, keep it orchestration-only.
- `src/lib/__fixtures__/synthVowel.ts` — seeded source-filter voice with known formants (shared by the formant tests).

## Rust conventions

- `storage::test_support::TestHome` points the data directory of the **current thread** at a temp dir (a `thread_local!` read by `app_data_dir()` under `cfg(test)`), so tests never touch `~/.vps` and still run in parallel.
- The Wi-Fi transfer server (`pack_share.rs`) is tested on loopback with a plain `TcpStream` client (route, token, single use, interrupted transfers, expiry, stop); one integration test builds a real pack with the sidecar and downloads it from the server.
- Command bodies that need the sidecar are split into `*_impl(state: &SidecarState, …)` functions (`save_take_impl`, `load_analysis_impl`, `list_takes_impl`, `save_exercise_take_impl`, `import_exercise_file_impl`); the `#[tauri::command]` wrapper just forwards. Tests call the `_impl` directly — no Tauri app needed (a mock app would also need the Windows comctl32 manifest, which `cargo test` binaries do not embed).
- `integration_tests.rs` spawns `python main.py` from `sidecar/` (venv interpreter if present, else `python` on PATH) and checks, end to end: stale-spectrum backfill and caching, graceful degradation on an undecodable file, `save_take` (pitch ≈ truth, RMS-matched to the reference stem, raw file replaced), `list_takes` backfill, `save_exercise_take`, `import_exercise_file` (never deletes the only copy). It **skips with a message** when no sidecar environment exists; set `VPS_REQUIRE_SIDECAR=1` (CI does) to make that a failure.
- The tests set `USERPROFILE`/`HOME` for the sidecar to a temp dir so its yt-dlp freshness cache does not land in the real home.

## Sidecar conventions

- `tests/helpers.py` synthesises audio with a known pitch/level/spectrum; nothing depends on checked-in audio fixtures.
- `tests/test_protocol.py` drives the real `main.py` over stdio exactly like `SidecarManager` does (ready, ping, invalid JSON, unknown command, exceptions → `error` with traceback, progress ordering, non-ASCII paths, `quit`, EOF).
- Cross-language invariants asserted from the Python side: `N_BINS` == Rust `ST_SPECTRUM_MIN_BINS`; every `"cmd"` string Rust sends is handled by `main.py`; Rust's `pitch::EXPERIMENTAL` == `PITCH_ALGORITHMS` (minus the backend-only `piano`) and `pitch::DEFAULT` == the sidecar's fallback; `MIN_YT_DLP_VERSION` == the `requirements*.txt` floors.

## Lyrics sync tests

Details in [Lyrics Sync](lyrics.md#tests). In short: the alignment algorithm is tested without torch (a numpy Viterbi checked against torchaudio's when present, and a scripted fake acoustic model); the Rust and Python path runs in CI through the model-free `VPS_LYRICS_ENGINE=uniform` engine; `tests/test_lyrics_real.py` runs real separated stems against LRCLIB and the vocal energy, **locally only** (skips without `~/.vps`, the cached weights or network; fetched lyrics are cached in git-ignored `sidecar/tests/_local/` and never committed).

## Known limitations the suite documents

- `_smooth_voiced` (median 6 + Gaussian σ 1.5) keeps only ~40 % of a 5.5 Hz vibrato's depth, so the reported vibrato depth is under-stated; `test_preserves_a_vibrato_shaped_contour` is an `xfail` that will flip to XPASS if the smoothing is ever retuned.
- SRH's voicing decision is relative to the loudest frame of the file, so broadband noise above the −50 dBFS gate is reported as voiced.
- `dbToCurvedNorm` (`src/lib/spectrogramMath.ts`) jumps from 0.045 to 0.15 at its soft-gate knee (the `× 0.3` in the gate); left as tuned.

## When you change something

- New Tauri command → write the Rust fn (its `///` doc becomes the wrapper's JSDoc), register it in `generate_handler!` in `lib.rs`, run `npm run gen:ipc` (the contract test fails with the missing step otherwise), and add a case in `src/lib/tauri.test.ts`.
- Bumped the short-term-spectrum resolution → change `N_BINS` (Python) and `ST_SPECTRUM_MIN_BINS` (Rust) together; a test fails if they diverge.
- Bumped the yt-dlp floor → change `MIN_YT_DLP_VERSION` in `mps-core` (`version_check.py`), then both requirements files here and in SPS (see MPS conventions #10); `tests/test_yt_dlp_floor.py` fails if they disagree.
- Shared code (metronome, recorder, zoom/pan, updater store, lyrics engine and slice, version check) is tested in `mps-core`; see [Shared code](shared-core.md). Its tests no longer run here.
