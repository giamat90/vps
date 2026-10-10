# Lyrics Sync

Place every line and word of a song's lyrics on the separated vocals stem, then show them karaoke-style in the Practice Room. Click a line to jump to it.

Shipped in `v0.1.62` (PR #3). Ported to SPS (`v0.0.40`); the engine now lives in the shared `mps-core` package, see [Shared code](shared-core.md).

## User flow

1. Open a (non-instrument) song → **Lyrics (add)** tab under the waveforms.
2. Paste the lyrics, or press **Find online** (looks the song up on [LRCLIB](https://lrclib.net), a free community lyrics database; sends only the song title/artist/duration). The found text lands in the box for review, nothing is saved yet.
3. Press **Sync lyrics**. Progress is streamed (first run also downloads a ~360 MB speech model once). Typical time on CPU: 10-25 s for a 3-5 minute song.
4. The karaoke view shows every line; the line being sung is lit and centred, the sung words inside it are highlighted. Clicking a line seeks to it (0.3 s early so the first word is not clipped). **Edit and re-sync** and **Remove** are beside it.

Instrument-kind songs (`kind: "instrument"`) have no vocals to align and do not show the panel.

## How it works

```
text ──parse──▶ words ──normalise──▶ letters ─┐
                                              ├─▶ CTC forced alignment ─▶ letter frames ─▶ words ─▶ lines
vocals.wav ─▶ 16 kHz mono ─▶ wav2vec2 ─▶ log-probs per 20 ms frame ┘
```

| Step | Where | Notes |
|---|---|---|
| Parse | `mps_core.lyrics.parse_lyrics` (shared package) | one entry per non-empty line; `[Chorus]` markers and LRC `[00:12.3]` tags dropped; `(backing vocals)` kept because they are sung |
| Normalise | `normalize_word` | lowercase, fold diacritics and `ß æ œ ø`, keep `a-z'` only; words with no letters (numbers, symbols) cannot be aligned and are parked between their neighbours |
| Acoustic model | `Wav2Vec2Aligner` | torchaudio `WAV2VEC2_ASR_BASE_960H` (English, 360 MB), fetched on first use into `~/.vps/models/` with progress and an atomic `.part` rename. Inference is windowed (20 s + 2 s context each side) because attention is quadratic in length |
| Alignment | `ctc_forced_align` | numpy Viterbi over the CTC lattice, not torchaudio's, so it runs and is tested in CI without torch; a test asserts it produces the same path as `torchaudio.functional.forced_align` |
| Timeline | `build_timeline` | letters → words → lines; word `score` is the mean letter probability; line `end` is its last word's end |
| Quality hint | `assess_alignment` | advisory `warning`, see below |

### Wire protocol

| Command | Request | Result |
|---|---|---|
| `align_lyrics` | `{vocalsPath, lyrics, modelsDir?}` + progress | `{aligner, lines[], meanScore, evidenceRatio, alignedWords, totalWords, warning}` |
| `find_lyrics` | `{title, artist?, duration?}` | `{text, synced, title, artist, duration, source}` |

Rust (`src-tauri/src/lyrics.rs`, thin wrappers in `commands.rs`): `load_lyrics`, `sync_lyrics`, `find_lyrics`, `delete_lyrics`; progress arrives on the `"lyrics-progress"` event (`{songId, progress, stage}`). The sidecar mutex is held for the duration, like `process_song`, so other sidecar work (takes, spectrum backfill) queues behind a running sync.

### Storage

`~/.vps/library/{songId}/lyrics.json` (written atomically), shape = `Lyrics` in `src/lib/types.ts`: `{version, source: "paste"|"lrclib", text, aligner, alignedAt, meanScore, warning, lines: [{text, start, end, score, words: [{text, start, end, score}]}]}`. `text` is kept verbatim so it can be edited and re-synced. Deleting the song deletes it.

`~/.vps/models/wav2vec2_fairseq_base_ls960_asr_ls960.pth` is shared by all songs. A model file that fails to load is deleted so the next attempt re-downloads it.

### Frontend

- `@giamat90/mps-core/lyrics` (`timing.ts`): pure timing logic. `activeLineIndex` (binary search; a line lights one lead-in early so it is exactly where a click seeks to, and stays lit up to 4 s after it ends), `activeWordIndex`, `lineSeekTime`.
- `@giamat90/mps-core/lyrics` (`store.ts`): load/find/sync/remove, progress subscription, and stale-result protection (a result for a song that is no longer open is dropped).
- `src/components/lyrics/LyricsPanel.tsx`: tab + editor + karaoke view. Store selectors return the *index*, not the time, so the list re-renders only when the line or word changes rather than 30 times a second.

## Accuracy: what was measured

Run on 15 Demucs-separated vocal stems from a real library (14 usable: one song's LRCLIB entry had only 7 lines) against LRCLIB's human-synced timings. LRCLIB is a noisy oracle (community timestamps are often 1-2 s late or for a different edit), so a constant offset is removed before comparing, and a second independent check is used: a line must start where the vocal stem has energy.

| Song | Lines | Within 1 s | Within 2 s | Line starts on singing |
|---|---|---|---|---|
| Let It Go (Frozen) | 40 | 72-98 %* | 95 % | 100 % |
| Rolling in the Deep | 68 | 85 % | 97 % | 100 % |
| Like a Stone | 24 | 96 % | 100 % | 100 % |
| Numb | 49 | 96 % | 98 % | 100 % |
| Start A Fire | 38 | 95 % | 97 % | 100 % |
| Hypnotize | 14 | 100 % | 100 % | 100 % |
| Black Hole Sun | 68 | 78 % | 88 % | 97 % |
| Paranoid | 22 | 91 % | 91 % | 100 % |
| Psychosocial (screamed) | 67 | 51 % | 64 % | 100 % |

\* range across two different LRCLIB entries for the same song (the 98 % was measured on plain text against the closer entry; its 2 s share was not recorded).

Also measured, within 1 s / within 2 s: What I've Done 79 / 87 %, Seven Nation Army 93 / 100 %, Them Bones 67 / 94 %, The Kill 84 / 88 %, Clint Eastwood 69 / 86 % (after removing a +17.6 s offset: the reference is for a video edit with a longer intro). Every one of these had at least 96 % of line starts on singing.

- **Speed:** model inference 11-22 s per song on CPU; the alignment itself is 0.1-0.3 s.
- **Screamed/harsh vocals** are the weak spot: lines still land on singing but the timing is looser.
- **Language:** the model is English. Other languages align on their letters and degrade gracefully, but accuracy is not measured. A multilingual model (torchaudio `MMS_FA`, 1.2 GB) is the obvious follow-up; the engine object is already the only thing that would change.

### What the warning can and cannot catch

Per-word confidence cannot tell wrong text from right: correct songs scored 0.26-0.67 and a *different song's* text scored 0.23-0.32. The usable signal is the **evidence ratio**, letters the model hears divided by letters in the text: 1.0-2.9 for complete lyrics, 3-9 when a third of the text was missing.

| Condition | Result |
|---|---|
| ratio > 3.5 | "The recording contains much more singing than these lyrics ... may be incomplete" (catches missing choruses/verses) |
| ratio < 0.5 | "These lyrics are much longer than what is sung" |
| mean score < 0.2, or fewer than half the words placeable | "The lyrics do not match the recording well" |
| text of a *different* song | **not detected** |
| half of the lines missing | only partly detected (overlaps the correct range) |

This is advisory text under the lyrics; the lyrics are still saved and shown.

**The most common real failure is collapsed choruses**: lyric sites often print a chorus once. Forced alignment cannot recover repeats that are not in the text, so lines drift. Mitigations: *Find online* prefers LRCLIB's synced version, which writes every repeat out; the editor hint says to write repeats in full; the evidence-ratio warning fires for gross cases.

Constants and their calibration comment live at the top of `mps_core/lyrics.py` in the shared package.

## Tests

| Layer | File | Covers |
|---|---|---|
| mps-core (`python/tests/`) | `test_lyrics_text.py`, `test_lyrics_ctc.py`, `test_lyrics_align.py`, `test_lyrics_model.py`, `test_lyrics_lrclib.py`, `test_lyrics_identity.py` | parsing, Viterbi (equals torchaudio's path), timeline and warnings via a scripted acoustic model, atomic download and windowed inference, LRCLIB lookup, app identity (moved out of this repository with the code) |
| sidecar | `tests/test_lyrics_protocol.py` | the commands over the real stdio protocol |
| sidecar | `tests/test_lyrics_real.py` | **local only**: real stems from `~/.vps` vs LRCLIB + vocal energy; skips itself without the library, the cached weights or network. Fetched lyrics are cached under `tests/_local/` (git-ignored) because they are copyrighted and must never be committed |
| rust | `src/lyrics.rs`, `integration_tests.rs` | wire format, atomic persistence, validation without spawning the sidecar, and a full round trip through the real sidecar |
| frontend | in mps-core: `lyrics/timing.test.ts`, `store.test.ts`, `ipc.test.ts`; here: `tests/contract/ipcContract.test.ts` | timing logic, store races, IPC wrappers; the contract test reads the package's wrappers against this app's Rust handlers |

### Test-only engine

`VPS_LYRICS_ENGINE=uniform` (the `VPS` prefix of this app's `AppIdentity` in `sidecar/main.py`) selects `UniformAligner`, which spreads the letters evenly over the non-silent part of the file. It exists only so the Rust ↔ Python wire path can run in CI without the model. It is never a fallback.

### Running the real-data tests

```powershell
cd sidecar
.\.venv\Scripts\python -m pytest tests/test_lyrics_real.py -q
```

Needs the weights in `~/.vps/models/` (or `~/.cache/torch/hub/checkpoints/`, or `VPS_LYRICS_ALLOW_DOWNLOAD=1`).

## Known limitations

- The frozen (PyInstaller) sidecar has not been built with this change; `build.py` gained `--hidden-import=torchaudio.pipelines`. Build and smoke-test a release candidate before shipping.
- The model is not bundled; the first sync needs internet.
- No cancel button: a sync runs to completion, and other sidecar commands wait for it.
- One lyric track per song; no manual per-line timing edits.
