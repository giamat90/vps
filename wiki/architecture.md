# Architecture

## Overview

VPS is a three-tier desktop application:

```
┌─────────────────────────────────────────────┐
│  React 19 + TypeScript (WebView2 / Vite)    │  UI layer
│  WaveSurfer.js · Zustand · MediaRecorder    │
└──────────────────┬──────────────────────────┘
                   │  tauri::invoke()  (async IPC)
                   │  Tauri events     (push: processing-progress)
┌──────────────────▼──────────────────────────┐
│  Tauri v2 backend (Rust)                    │  Shell / FS layer
│  commands.rs · library.rs · storage.rs      │
└──────────────────┬──────────────────────────┘
                   │  JSON lines on stdin / stdout
┌──────────────────▼──────────────────────────┐
│  Python sidecar (subprocess)                │  Heavy compute
│  Demucs · SRH · librosa · soundfile        │
└─────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Desktop shell | Tauri | 2.10.3 |
| Frontend build | Vite + TypeScript | latest |
| UI framework | React | 19 |
| Audio playback | WaveSurfer.js | 7 |
| State management | Zustand | latest |
| Backend language | Rust | 1.94.1+ |
| Compute sidecar | Python | 3.10+ |
| Stem separation | Demucs | htdemucs model |
| Pitch detection | SRH (custom, Drugman & Dutoit 2011) | — |
| Pitch shifting | librosa | — |

## IPC Layers

### Frontend ↔ Tauri (invoke)

All frontend→backend calls use `invoke()` from `@tauri-apps/api/core`. The bindings live in `src/lib/tauri.ts`. Push events from Rust to frontend use `app.emit()` / `listen()` (e.g., `"processing-progress"`).

### Tauri ↔ Python (JSON lines)

The Rust backend spawns the Python sidecar as a child process (`SidecarManager` in `src-tauri/src/sidecar.rs`). Communication is newline-delimited JSON on stdin/stdout. The sidecar runs a synchronous dispatch loop to avoid GIL/numpy deadlocks on Windows. See [Python Sidecar](python-sidecar.md) for the message format.

## Auto-Update

The app checks for updates on every startup via `tauri-plugin-updater` (Rust) / `@tauri-apps/plugin-updater` (frontend), registered in `src-tauri/src/lib.rs`. `src/stores/updater.ts` calls `check()` once from `App.tsx`'s mount effect; if a newer version is available, `src/components/updater/UpdateDialog.tsx` renders a modal with the release notes and an "Install & Restart" button that downloads, verifies, and silently installs the update, then relaunches.

Configuration lives in `tauri.conf.json`'s `plugins.updater` block:
- `pubkey` — the updater's public key. **Must be the raw base64 content of the generated `.pub` file itself**, not the human-readable key line inside it (the `.pub` file's own content is already base64 of the real minisign-format text — pasting the decoded inner value causes a double-decode failure at build time).
- `endpoints` — points at the GitHub Release's `latest.json` (`https://github.com/giamat90/vps/releases/latest/download/latest.json`).

**Hard constraint:** Tauri requires the endpoint to be `https://` — even `http://localhost` fails, and the failure is not scoped to the update check: the *entire app* panics at startup with a `PluginInitialization` error if the endpoint isn't secure. Never configure or test a plain-`http` endpoint.

Release artifacts are signed with a keypair (`tauri signer generate`); the private key + password are GitHub Actions secrets (`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) consumed by `release.yml` — see [Dev Setup](dev-setup.md#ci--release-workflow) for the CI-side signing and release flow.

## Startup Sequence

1. Tauri starts; `main.rs` registers commands and creates `SidecarState` (initially empty).
2. WebView2 renders the React app via the Vite dev server (dev) or bundled `dist/` (release).
3. The Python sidecar is spawned **lazily** on the first command that needs it (e.g., `process_song`). It sends `{"type": "ready"}` when ready.
4. The user drops an audio file → `processSong` invoke → Rust sends `process` command to Python → Python runs Demucs, saves `vocals.wav` + `instrumental.wav` into `~/.vps/library/{songId}/`, responds with song metadata.

## Asset Serving

Audio files stored in `~/.vps/` are served to the frontend via Tauri's asset protocol (`tauri://localhost/...`). The scope is configured in `tauri.conf.json`:

```json
"assetProtocol": {
  "enable": true,
  "scope": ["$HOME/.vps/**", "$HOME\\.vps\\**"]
}
```

`convertFileSrc()` from `@tauri-apps/api/core` converts an absolute path to a valid `tauri://` URL for use in WaveSurfer.
