# Changelog

All notable changes to VPS are recorded here, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the git tags (`vX.Y.Z`).

Every version bump must add an entry here in the same `chore: release` commit.
Releases before 0.1.62 are not itemised; see `git log` and the tags.

## [0.1.64] - 2026-10-10

### Changed
- Pitch detection no longer needs to be chosen: the "Pitch detection algorithm" selector is gone from Settings and the app always uses SRH, the algorithm that rated best in our A/B tests. Anyone who had picked another algorithm moves to SRH; songs already in the library keep the pitch curve they were analysed with until re-imported.

## [0.1.63] - 2026-10-10

### Changed
- Shared code (metronome, recorder, timeline zoom/pan, auto-update, lyrics engine, yt-dlp version check) now comes from the shared `mps-core` package, which both apps use. No change in behaviour is intended.

## [0.1.62] - 2026-10-10

### Added
- Synced lyrics panel in the practice room: forced alignment of lyrics to the vocals stem, LRCLIB lookup, word-level highlighting.
- Monitor button works while a Free Exercise take or file is loaded, so you can sing against the loaded track without recording.
- Automated test suites (vitest, cargo, pytest) run in CI on every push and pull request.

### Fixed
- The time readout and lyrics now follow a waveform click while playback is paused.
- The practice room no longer shows a spurious "No audio loaded" label when a song load was superseded by a newer one.
- Test-suite review fixes: double audio-offset skip, stale punch region, orphaned job directories.
