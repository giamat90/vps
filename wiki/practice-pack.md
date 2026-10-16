# Practice pack ("Send to phone")

A practice pack is one file per song, `.vppack`, that carries everything the phone companion (Vocal Practice Pocket, `MPS/VPP`) needs to practise the song: AAC tracks, the reference melody, lyrics and loops. The phone only plays, listens and records; every analysis stays on the laptop. Design record and reasons: `MPS/wiki/pocket-practice-design.md`.

**Key files:** `sidecar/pack_export.py` · `src-tauri/src/commands.rs` (`export_pack`, `build_pack_file`, `pack_meta`) · `src-tauri/src/pack_share.rs` (Wi-Fi server) · `src/components/player/SendToPhoneButton.tsx`, `SendToPhoneDialog.tsx`, `QrCode.tsx` · `src/lib/packShare.ts` (dialog states), `src/lib/qr.ts` · mps-core `python/src/mps_core/pack.py` and `src/pack/`.

## What the user does

Practice room header, **Send to phone** opens a dialog with two ways:

- **Send over Wi-Fi.** VPS builds the pack (with progress), then shows a QR code. On the phone: Vocal Practice Pocket, Songs, **Receive from laptop**, scan. The dialog shows the transfer's progress and "Sent to your phone". Both devices must be on the same network. See [Wi-Fi transfer](#wi-fi-transfer).
- **Save as a file.** VPS builds the pack and a Save As dialog asks where to put it; the header shows what it contains ("Saved: 4.9 MB, 2 transpositions, lyrics"). Moving the file to the phone is the user's business (share sheet, cable, a drive); the phone app adds `.vppack` files from its Songs tab.

## What is in a pack

| Entry | Source | Notes |
|---|---|---|
| `manifest.json` | built by `mps_core.pack.build_manifest` | schema 1; title, artist, duration, bpm, key, metronome offset, tracks, variants, reference, lyrics, loops |
| `vocals.m4a` | `vocals.wav` | AAC 64 kbps, mono |
| `instrumental.m4a` | `instrumental.wav` | AAC 96 kbps |
| `pitched/{n}/vocals.m4a`, `.../instrumental.m4a` | the transpositions already in the song's `pitched/{n}/` cache | only n from -12 to 12 except 0, and only when both files exist; nothing is transposed just for the pack |
| `reference_pitch.json` | `analysis.json` `pitchData` | the SRH line on a 20 ms grid, 0 where unvoiced, 0.1 Hz resolution; the 13 MB `analysis.json` itself never ships |
| `lyrics.json` | `lyrics.json` | as stored, when the song has synced lyrics |
| loops | `Song.loops` | in the manifest |

A song of 238 s (Seven Nation Army, real library data) became a **4.9 MB** pack from 84 MB of WAV stems, built in 6.4 s with ffmpeg 8; the reference line covers 23 % voiced frames there.

## How it is built

1. `build_pack_file` (Rust, shared by both ways) takes the song, builds the `meta` object (`pack_meta`: id, title, artist, duration, bpm, key, metronome offset, loops, creation time) and sends the sidecar `build_pack` command with the song directory and a temp output path `vps-pack-<uuid>.vppack` (300 s timeout). The sidecar's progress messages come back as `(0..1, stage)`.
2. `pack_export.build_practice_pack` encodes the tracks with ffmpeg (`mps_core.pack.encode_aac`, the ffmpeg the sidecar already bundles), decimates the reference, copies the lyrics, builds and validates the manifest and writes the zip atomically (`mps_core.pack.write_pack`).
3. `export_pack` shows the Save As dialog and copies the temp file; `start_pack_share` hands the temp file to the server. The temp file is removed either way (`TempFile`).

The format, its validation and the reader on the phone are in mps-core (`@giamat90/mps-core/pack`); the manifest is pinned as a fixture there so the writer and the reader cannot drift. VPS depends on mps-core `>= 0.10.0` for this.

## Wi-Fi transfer

Added after the file route was confirmed working. Design record: `MPS/wiki/pocket-practice-design.md`; phone side: `MPS/VPP/tasks/TASK-003-wifi-transfer.md`.

```
 dialog: start_pack_share(songId, address?)
    -> build the pack (events "building") -> bind <chosen private IPv4>:0 -> link
 QR code carries   http://192.168.8.104:53113/pack/714d08b425634e329ce6c0cb3b4d613c
 phone: GET link   -> 200, the .vppack (events "sending" with sent/total)
    -> phone closes the connection after the last byte -> "done", server gone
```

| Rule | Detail |
|---|---|
| Who pulls | The phone downloads from a short-lived server on the laptop (`ShareServer`, std `TcpListener`, one thread per connection, at most 8). Only `GET` and `HEAD` on `/pack/<token>`; everything else is `404` (same body for a wrong token and a wrong path) or `405` |
| Secret | `<token>` is 32 hex digits from a random v4 UUID (OS random source), in the QR code only. HTTP is plain: the secret travels on the screen, not the network |
| Single use | The link is **spent** when every byte was written *and* the phone then closed its end cleanly. A phone that walks away, a timeout or a reset leaves it valid (`interrupted` event, the dialog says "scan again") |
| Life | 10 minutes (`LIFETIME`), or until the dialog closes (`stop_pack_share`, also on unmount), or the app exits (the temp pack is swept at the next start if the app was killed) |
| Binding | Only the chosen private address, never `0.0.0.0`, port chosen by the OS. A loopback or VPN address is never offered |
| Which address | `lan_addresses`: private (RFC 1918) IPv4 of adapters that are up, ranked: the address the OS would use to reach the internet (a UDP socket is connected, nothing is sent), then real adapters, then virtual ones (WSL, Hyper-V, VMware, VirtualBox, Docker, VPN names). The dialog shows a picker when there is more than one; choosing restarts the server with a new code and **reuses the built pack** (`ShareState`) |
| Concurrency | One download at a time (`503` with `Retry-After` for a second one). `stop` bumps a generation counter so a build that finishes after the dialog was closed opens nothing |
| Browser fallback | `Content-Disposition: attachment` with an ASCII `filename` and an RFC 5987 `filename*`, so a camera app that opens the link in a browser still saves a proper `.vppack` |
| Events | `pack-share`: `building {value, stage}`, `sending {sent, total}`, `interrupted`, `done`, `expired`. A stopped server emits nothing more |

Things that can go wrong (the dialog has a "The phone cannot connect" help text): the phone is on mobile data or a guest network with client isolation; Windows Firewall asked to allow the app on private networks and was answered "cancel"; several adapters and the wrong one chosen; a VPN that takes the default route.

Not done on purpose: mDNS discovery, HTTPS with a pinned certificate, resumable downloads, an upload route for takes (phase 2 can add one on the same server). The server is app-agnostic; when SPS gets its own pack it moves to mps-core as a Rust crate rather than being copied.

## Things to know

- **AAC start delay.** ffprobe on the real song: the m4a starts at 0.000 s and is 0.6 ms shorter than the WAV (the encoder delay is trimmed by the container's edit list), so `encoderDelayS` is written as 0. Whether the phone's decoder honours the edit list is checked on the device with a real pack (VPP task TASK-002).
- **Only existing transpositions.** A user who wants -2 in the pack transposes the song to -2 first; the pack then carries it.
- **Instrument tracks** (`kind: "instrument"`) are exported like any song: `vocals.m4a` holds the melody.
- **A pack is a snapshot** (`rev` 1 today). Newer packs for the same `songId` replace older ones on the phone; feedback revisions arrive in a later phase.
- **The first pack of a session is slow to start.** The sidecar starts on first use (about 40 s from source in a dev run), so the dialog says "Starting the audio engine" until the first progress message arrives.
- **Hand-tested** in the installed app (v0.0.88, 2026-10-15) by the user: the button builds and saves a pack.
- **Tests:** `sidecar/tests/test_pack_export.py` (6, one with real ffmpeg, skipped when absent); Rust `pack_meta` and the `pack_share` module tests (server on loopback, address ranking, share state) and the integration test that builds a pack with the real sidecar and downloads it from the server; `src/lib/packShare.test.ts` (dialog states), `src/lib/qr.test.ts` (the QR code decodes back to the link), the IPC cases in `src/lib/tauri.test.ts` and the contract test.
