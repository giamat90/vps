# Practice pack ("Send to phone")

A practice pack is one file per song, `.vppack`, that carries everything the phone companion (Vocal Practice Pocket, `MPS/VPP`) needs to practise the song: AAC tracks, the reference melody, lyrics and loops. The phone only plays, listens and records; every analysis stays on the laptop. Design record and reasons: `MPS/wiki/pocket-practice-design.md`.

**Key files:** `sidecar/pack_export.py` · `src-tauri/src/commands.rs` (`export_pack`, `pack_meta`) · `src/components/player/SendToPhoneButton.tsx` · mps-core `python/src/mps_core/pack.py` and `src/pack/`.

## What the user does

Practice room header, **Send to phone**: VPS builds the pack, a Save As dialog asks where to put it, and the button shows what it contains ("4.9 MB, 2 transpositions, lyrics"). Moving the file to the phone is the user's business (share sheet, cable, a drive); the phone app opens `.vppack` files.

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

1. `export_pack(songId, suggestedName)` (Rust) finds the song, builds the `meta` object (`pack_meta`: id, title, artist, duration, bpm, key, metronome offset, loops, creation time) and sends the sidecar `build_pack` command with the song directory and a temp output path (300 s timeout).
2. `pack_export.build_practice_pack` encodes the tracks with ffmpeg (`mps_core.pack.encode_aac`, the ffmpeg the sidecar already bundles), decimates the reference, copies the lyrics, builds and validates the manifest and writes the zip atomically (`mps_core.pack.write_pack`).
3. Rust shows the Save As dialog and copies the temp file; the temp file is removed either way.

The format, its validation and the reader on the phone are in mps-core (`@giamat90/mps-core/pack`); the manifest is pinned as a fixture there so the writer and the reader cannot drift. VPS depends on mps-core `>= 0.10.0` for this.

## Things to know

- **AAC start delay.** ffprobe on the real song: the m4a starts at 0.000 s and is 0.6 ms shorter than the WAV (the encoder delay is trimmed by the container's edit list), so `encoderDelayS` is written as 0. Whether the phone's decoder honours the edit list is checked on the device with a real pack (VPP task TASK-002).
- **Only existing transpositions.** A user who wants -2 in the pack transposes the song to -2 first; the pack then carries it.
- **Instrument tracks** (`kind: "instrument"`) are exported like any song: `vocals.m4a` holds the melody.
- **A pack is a snapshot** (`rev` 1 today). Newer packs for the same `songId` replace older ones on the phone; feedback revisions arrive in a later phase.
- **Tests:** `sidecar/tests/test_pack_export.py` (6, one with real ffmpeg, skipped when absent), the Rust `pack_meta` test, the IPC case in `src/lib/tauri.test.ts`.
