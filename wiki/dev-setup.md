# Dev Setup

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Rust | 1.94.1+ | Install via rustup |
| Node.js | 24+ | For Vite + npm |
| Python | 3.10+ | For the sidecar |
| WebView2 | — | Pre-installed on Windows 11 |

### Rust on Windows (PATH note)

When running Rust tools via bash (e.g., in a script or CI), `cargo` may not be on PATH. Add it explicitly:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

PowerShell automatically has it after a normal rustup install.

## Python Sidecar Setup

```powershell
cd sidecar
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

The sidecar is **not started by `npm run tauri dev`**. It is spawned lazily by Rust on the first command that needs it (e.g., when you drop a song file). In dev mode the sidecar runs as a raw Python process; in release mode it is a PyInstaller-bundled executable.

### Building the sidecar executable

```powershell
cd sidecar
.\.venv\Scripts\activate
python build.py
```

The output executable is written to the path Tauri expects (see `tauri.conf.json` `externalBin`).

## Running in Development

```powershell
npm install          # first time only
npm run tauri dev
```

This starts:
1. Vite dev server on `http://localhost:5173`
2. Tauri shell (Rust) pointing WebView2 at the dev server

Hot reload works for React/TypeScript changes. Rust changes require a full restart (`Ctrl+C` → `npm run tauri dev`).

## Building for Release

```powershell
npm run tauri build
```

Output installers are placed in `src-tauri/target/release/bundle/`. Ensure the sidecar executable is built first.

## CI / Release Workflow

A single workflow, `.github/workflows/release.yml`, triggers on any `v*` tag push and also supports `workflow_dispatch`. It has three jobs:

| Job | Runner | Bundle |
|-----|--------|--------|
| `build-windows` | `windows-latest` (x86_64) | NSIS `.exe` |
| `build-macos` | `macos-latest` (Apple Silicon) | `.dmg` + `.app.tar.gz` |
| `finalize` | `ubuntu-latest` | — |

Both `build-*` jobs:
1. Stamp all manifest versions from the git tag (`jq` + `sed`)
2. Build the Python sidecar with PyInstaller (CPU-only PyTorch)
3. Build the Tauri app with `tauri-action@v0`, passing `tagName`/`releaseDraft: true` and the updater signing secrets — this makes `tauri-action` create-or-reuse **the same draft GitHub Release** for both jobs and sign the artifacts (producing `.sig` files + a per-platform `latest.json` fragment)
4. Run a smoke test (see below)

`tauri-action` fetches the release's existing `latest.json` asset (if the other platform's job already uploaded one), merges in its own platform's entry, and re-uploads — so no custom merge step is needed, but both jobs must resolve to the *same* release, which is why they now live in one workflow file instead of two independent ones (GitHub Actions can't `needs:` across separate top-level workflows). The `finalize` job (`needs: [build-windows, build-macos]`) runs `gh release edit "$TAG" --draft=false` once both platforms succeed, so the release is only published — and `latest.json` only has both platform keys — after both builds are in.

**Updater signing secrets** (required for CI builds to produce valid `.sig` files): `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, set on the repo via `gh secret set`. The matching private key file (`tauri-updater-key.pem`, gitignored) is the only copy outside GitHub — losing it means future releases can no longer be signed to match the pubkey already shipped in installed apps. See [Architecture: Auto-Update](architecture.md#auto-update) for the pubkey/endpoint config and the HTTPS-only constraint.

**Testing the update flow locally without a real release:** build a signed installer with `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD` env vars set, then serve a hand-crafted `latest.json` + the installer from a local HTTPS server (Tauri rejects plain `http`, even `localhost`, so a self-signed cert imported into the Windows trust store is required — generate it with a proper openssl config file specifying Subject/Issuer, not a bare `-subj` shortcut, or `rustls-platform-verifier`'s schannel chain validation fails with a non-obvious `TRUST_E_CERT_SIGNATURE` error instead of a clear "untrusted CA" message).

### Smoke tests

**macOS:** Two checks run in sequence.
1. Mounts the `.dmg`, finds the binary inside the `.app` bundle via `find`, launches it directly (bypasses Gatekeeper — no code signing on CI), waits 15 s, checks liveness with `kill -0 $PID`. This only proves the binary itself can execute; it does not reflect what a real user experiences.
2. **Gatekeeper smoke test** (`continue-on-error: true`, informational only): copies the `.dmg`, tags it with `com.apple.quarantine` (the xattr a browser sets on download), mounts it, and runs `codesign -dv` + `spctl --assess --type execute -v` against the `.app`. Since the app is currently unsigned and not notarized, this step is expected to report a Gatekeeper rejection on every run — it exists to surface that fact in CI logs instead of only from testers. See [macOS testers: app won't open](#macos-testers-app-wont-open) below.

**Windows:** Confirms the NSIS installer file exists, launches `src-tauri/target/release/app.exe` directly, waits 15 s, checks `$proc.HasExited`.

### macOS testers: app won't open

The app is **not code-signed or notarized** (no Apple Developer ID yet). When a `.dmg` is downloaded via a browser, macOS Gatekeeper blocks the unsigned/unnotarized `.app` — usually silently, or with "Apple could not verify... is free of malware" / "app is damaged, move to Trash." This is expected, not a build bug, until we get an Apple Developer ID and wire up the `APPLE_CERTIFICATE`/`APPLE_ID`/notarization secrets already stubbed out (commented) in `release.yml`.

**Stopgap for testers — `fix-gatekeeper.command`:**

Every macOS Release now includes `fix-gatekeeper-macos.zip` alongside the `.dmg` (source: `scripts/macos/fix-gatekeeper.command`, built/zipped in `release.yml`'s "Package fix-gatekeeper.command" step). Instructions to give a tester:

1. Install the app from the `.dmg` as normal (drag to Applications).
2. Download and unzip `fix-gatekeeper-macos.zip` (Archive Utility preserves the executable bit; a raw `.command` download would not).
3. Double-click `fix-gatekeeper.command`. The first run still triggers a Gatekeeper "unidentified developer" prompt for the *script itself* — Control-click it → Open → confirm once. It then opens Terminal, locates the installed `.app` (checks Applications, Downloads, Desktop, and any mounted volume), and runs `xattr -cr` on it.
4. Vocal Practice Studio should now open normally.

Manual fallback, if the script isn't available or doesn't find the app:
```bash
xattr -cr /path/to/VPS.app    # or run on the mounted .dmg before dragging to Applications
```
or right-click (Control-click) the app in Finder → "Open" → confirm in the dialog.

If none of this works, ask the tester to run `spctl --assess --type execute -v /path/to/VPS.app` and `codesign -dv --verbose=4 /path/to/VPS.app` and share the output — that's the same diagnostic the CI Gatekeeper smoke test produces.

### Bumping the version locally

Use the PowerShell script to keep all three manifests in sync before tagging:

```powershell
.\scripts\bump-version.ps1 0.2.0
git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml
git commit -m "chore: bump version to 0.2.0"
git tag v0.2.0
git push origin master v0.2.0
```

`bump-version.ps1` writes UTF-8 without BOM (important — PowerShell 5.1's `Set-Content -Encoding utf8` adds a BOM that breaks the TOML parser).

### Asset protocol scope

`tauri.conf.json` `assetProtocol.scope` must use forward-slash globs (`$HOME/.vps/**`). Backslash variants (`$HOME\\.vps\\**`) are invalid on macOS and cause a `GlobPattern` panic at startup.

## Project Structure

```
VPS/
├── src/                   React + TypeScript frontend
│   ├── audio/             AudioEngine + VocalRecorder
│   ├── components/        UI components (see Components wiki page)
│   ├── lib/               Tauri bindings + shared types
│   └── stores/            Zustand stores (player, library, analysis, exercise)
├── src-tauri/             Rust backend
│   ├── src/
│   │   ├── main.rs        Binary entry point (calls lib.rs::run)
│   │   ├── lib.rs         Tauri builder + invoke_handler registration
│   │   ├── commands.rs    Tauri command handlers
│   │   ├── sidecar.rs     Python sidecar process manager
│   │   ├── library.rs     Song library management
│   │   └── storage.rs     Path helpers (~/.vps/)
│   └── tauri.conf.json    App config (window size, asset scope)
├── sidecar/               Python compute sidecar
│   ├── main.py            JSON-lines dispatch loop
│   ├── processor.py       Demucs separation + analysis
│   ├── analysis.py        Take analysis (pitch, onsets, dynamics)
│   └── build.py           PyInstaller build script
└── wiki/                  This documentation
```

## Audio Device Testing

To test recording with a USB audio interface (e.g., Behringer UM2):

1. Plug in the interface before starting the app.
2. In the app, open the microphone selector and choose the UM2 input (e.g., `"Line In (2-Behringer USB WDM Audio)"`).
3. Start recording — the app will automatically pin audio output to the UM2's headphone output to avoid the Windows Communications Device routing issue.

If you hear silence during recording, check the browser console for `[recording]` log lines showing which output device was selected.

## Tauri Permissions

The app uses these Tauri plugins / permissions (configured in `src-tauri/capabilities/`):

- `shell` — to spawn the Python sidecar
- `fs` — to read/write `~/.vps/`
- Asset protocol scope — to serve audio files to WebView2 via `tauri://localhost/`
