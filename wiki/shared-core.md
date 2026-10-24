# Shared code: `@giamat90/mps-core`

Code that is identical in VPS and SPS is not kept here. It lives in
`github.com/giamat90/mps-core` (cloned beside this repository as `MPS/core`) and is
pinned by tag. Design, boundaries and the release procedure are documented in that
repository's `wiki/`; this page records how VPS uses it.

## What VPS takes from it

| Import | Replaced |
|---|---|
| `@giamat90/mps-core/metronome`, `/metronomeSync`, `/recorder`, `/zoomPan` | `src/audio/metronome.ts`, `src/lib/metronomeSync.ts`, `src/audio/recorder.ts`, `src/lib/zoomPan.ts` and their tests |
| `@giamat90/mps-core/music` | the note/frequency half of `src/lib/constants.ts` (the piano-window half is VPS only and stays) |
| `@giamat90/mps-core/pitch` | new in v0.8.0: the autocorrelation inside `src/audio/pitchDetector.ts` (`autocorrelatePitch`); the `PitchDetector` class stays here as the AnalyserNode wrapper, and its algorithm tests moved to core |
| `@giamat90/mps-core/spectrum` | new in v0.12.0: `src/lib/fft.ts`, `formants.ts`, `harmonicEnvelope.ts`, `pitchRefine.ts` (and the synthetic-vowel fixture) with their tests, and the pure half of `src/lib/spectroUtils.ts` (log-Hz axis, dB span, thermal colour map, curve and envelope smoothing). `spectroUtils.ts` re-exports those names so the panels keep one import, and keeps the canvas / stored-spectrogram helpers. The phone app (VPP) draws the same curve from the same code |
| `@giamat90/mps-core/updater` | `src/stores/updater.ts` |
| `@giamat90/mps-core/panels` | new in v0.2.0: `src/stores/panels.ts` builds the practice-room store with `createPanelStore`; `PanelMenu` is this app's own; `createCollapseStore` (unreleased) backs `src/stores/collapsed.ts`, the title buttons that fold a panel (hook `useCollapsiblePanel`) |
| `@giamat90/mps-core/lyrics` | lyric types in `types.ts`, the four lyrics wrappers and `onLyricsProgress` in `tauri.ts`, `src/lib/lyrics.ts`, `src/stores/lyrics.ts` |
| `mps_core.pack` (Python) | new in v0.10.0: `sidecar/pack_export.py` builds the practice pack with it (format, validation, zip writer, AAC encode); see [Practice pack](practice-pack.md) |
| `mps_core.lyrics`, `mps_core.version_check`, `mps_core.app` (Python) | `sidecar/lyrics.py`, `sidecar/version_check.py` and their tests |

## Wiring that lives here

- **`package.json`**: `"@giamat90/mps-core": "git+https://github.com/giamat90/mps-core.git#vX.Y.Z"`.
- **`sidecar/requirements.txt` and `requirements-test.txt`**: `git+https://github.com/giamat90/mps-core.git@vX.Y.Z#subdirectory=python`. Keep the two tags equal to each other and to `package.json`.
- **`vitest.config.ts`**: `server.deps.inline: [/@giamat90\/mps-core/]` (the package ships TypeScript source).
- **`sidecar/main.py`**: `APP = AppIdentity(name="VPS-VocalPracticeStudio", url="https://github.com/giamat90/vps", data_dir="~/.vps", env_prefix="VPS")`, passed as `app=APP` to `check_yt_dlp_freshness`, `align_lyrics`, `find_lyrics`. This is why the models directory, the yt-dlp cache and `VPS_LYRICS_ENGINE` are where they always were.
- **`tests/contract/ipcContract.test.ts`**: reads `node_modules/@giamat90/mps-core/src/lyrics/ipc.ts` next to `src/lib/ipc.generated.ts`, so the package's wrappers are checked against this app's Rust handlers.
- **`sidecar/tests/test_yt_dlp_floor.py`**: the requirement files must carry the floor `mps_core.version_check.MIN_YT_DLP_VERSION`.

## Working with it

| Task | Do |
|---|---|
| Change shared behaviour | Change it in `MPS/core`, test there, tag, then bump the pin here and in SPS. Never edit `node_modules/@giamat90/mps-core`. |
| Try a core change here before tagging | From `MPS/core`: `node scripts/push-to-app.mjs ../VPS --python ../VPS/sidecar/.venv/Scripts/python.exe`; `npm ci` restores the pinned copy. |
| Bump the pin | Edit the tag in `package.json` and both requirements files, `npm install`, run `npm test`, `npx tsc --noEmit`, `cd sidecar; python -m pytest`, `cd src-tauri; cargo test --lib`. |
| Bump the yt-dlp floor | In `mps-core` (`version_check.py`), then the two requirements files here and in SPS. |
| Lyrics command changed | The wrappers are the contract: the Rust handlers `load_lyrics`, `sync_lyrics`, `find_lyrics`, `search_lyrics`, `delete_lyrics` and the `lyrics-progress` event must match `ipc.ts`; the contract test fails otherwise. |

## What stayed behind, and why

`KeyTranspose`, `OutputSelector`, `MicSelector`, `YouTubeCookiesControl` are
identical in both apps but read app stores and app CSS; `test_util.rs` and
`lyrics.rs` are largely shared but tied to each app's `Song` model.

## Rust crates, `punch` and the headless hooks (mps-core v0.13.0, 2026-10-17)

`sidecar.rs` and `windows.rs` are thin wrappers over mps-core's `mps-sidecar` (the process manager and the JSON-lines protocol; this app supplies its binary name) and `mps-detached-windows` (allowlist, remembered position, docking; this app supplies its `PanelSpec` table and data directory and keeps the `#[tauri::command]` wrappers). Both, and `mps-youtube-signin`, are Cargo git dependencies pinned to `tag = "v0.13.0"`.

The logic of the components both apps carry is in `@giamat90/mps-core/hooks` (panel menu, device selectors, transpose, tempo, record and transport controls, time ruler, take list, latency calibration, lyrics panel, YouTube import and cookies, drop zone, update dialog, library page and store, settings, shortcuts, bridge host); the drag-and-drop ones are in `@giamat90/mps-core/hooks/dnd`. A component here is the markup and the CSS class names around one hook call, with the store, the IPC functions and the dialogs passed in. `TimeRuler` and the punch rules use `@giamat90/mps-core/punch`. To change behaviour that is in a hook, change it in mps-core, tag, and bump the pin in both apps.
