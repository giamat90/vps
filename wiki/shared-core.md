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
| `@giamat90/mps-core/updater` | `src/stores/updater.ts` |
| `@giamat90/mps-core/panels` | new in v0.2.0: `src/stores/panels.ts` builds the practice-room store with `createPanelStore`; `PanelMenu` is this app's own |
| `@giamat90/mps-core/lyrics` | lyric types in `types.ts`, the four lyrics wrappers and `onLyricsProgress` in `tauri.ts`, `src/lib/lyrics.ts`, `src/stores/lyrics.ts` |
| `mps_core.lyrics`, `mps_core.version_check`, `mps_core.app` (Python) | `sidecar/lyrics.py`, `sidecar/version_check.py` and their tests |

## Wiring that lives here

- **`package.json`**: `"@giamat90/mps-core": "git+https://github.com/giamat90/mps-core.git#vX.Y.Z"`.
- **`sidecar/requirements.txt` and `requirements-test.txt`**: `git+https://github.com/giamat90/mps-core.git@vX.Y.Z#subdirectory=python`. Keep the two tags equal to each other and to `package.json`.
- **`vitest.config.ts`**: `server.deps.inline: [/@giamat90\/mps-core/]` (the package ships TypeScript source).
- **`sidecar/main.py`**: `APP = AppIdentity(name="VPS-VocalPracticeStudio", url="https://github.com/giamat90/vps", data_dir="~/.vps", env_prefix="VPS")`, passed as `app=APP` to `check_yt_dlp_freshness`, `align_lyrics`, `find_lyrics`. This is why the models directory, the yt-dlp cache and `VPS_LYRICS_ENGINE` are where they always were.
- **`tests/contract/ipcContract.test.ts`**: reads `node_modules/@giamat90/mps-core/src/lyrics/ipc.ts` next to `src/lib/tauri.ts`, so the package's wrappers are checked against this app's Rust handlers.
- **`sidecar/tests/test_yt_dlp_floor.py`**: the requirement files must carry the floor `mps_core.version_check.MIN_YT_DLP_VERSION`.

## Working with it

| Task | Do |
|---|---|
| Change shared behaviour | Change it in `MPS/core`, test there, tag, then bump the pin here and in SPS. Never edit `node_modules/@giamat90/mps-core`. |
| Try a core change here before tagging | From `MPS/core`: `node scripts/push-to-app.mjs ../VPS --python ../VPS/sidecar/.venv/Scripts/python.exe`; `npm ci` restores the pinned copy. |
| Bump the pin | Edit the tag in `package.json` and both requirements files, `npm install`, run `npm test`, `npx tsc --noEmit`, `cd sidecar; python -m pytest`, `cd src-tauri; cargo test --lib`. |
| Bump the yt-dlp floor | In `mps-core` (`version_check.py`), then the two requirements files here and in SPS. |
| Lyrics command changed | The wrappers are the contract: the Rust handlers `load_lyrics`, `sync_lyrics`, `find_lyrics`, `delete_lyrics` and the `lyrics-progress` event must match `ipc.ts`; the contract test fails otherwise. |

## What stayed behind, and why

`KeyTranspose`, `OutputSelector`, `MicSelector`, `YouTubeCookiesControl` are
identical in both apps but read app stores and app CSS; `sidecar.rs`,
`test_util.rs` and `lyrics.rs` are largely shared but tied to each app's `Song`
model. The shared repository's `wiki/architecture.md` lists each with the reason.
