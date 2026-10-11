# Changelog

All notable changes to VPS are recorded here, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the git tags (`vX.Y.Z`).

Every version bump must add an entry here in the same `chore: release` commit.
Releases before 0.1.62 are not itemised; see `git log` and the tags.

## [Unreleased]

### Added
- Several recorded takes can be shown at the same time, each on its own lane. Click a take in the Takes list to show it, click it again to hide it (a lane also has its own ×). By default every shown take is heard together; **M** on a lane silences just that take.
- A bar above the take lanes: **Hear: all shown / selected only** (only the selected take plays, and clicking another take switches to it) and **Silent / Playing while recording** (keep hearing the shown takes while you record another one). Both choices are remembered.
- Each take lane has its own **mute, solo and volume** at the far right, next to the offset controls it already had; the shared take volume (and its mute / solo) stays in the bar above the lanes and the two multiply. Soloing a take plays it alone, like soloing a stem.
- The mixdown export includes every take that is heard, at each take's own level.

### Changed
- Starting a recording no longer removes the takes from the screen. By default they are silent while you record, as before; switch **Playing while recording** on to hear them.

## [0.1.66] - 2026-10-11

### Added
- Any panel of the practice room (Takes, Lyrics, Piano roll, Spectrum comparison, Dynamics, Vibrato, Timing, Coach) can be dragged out of the window into a window of its own, for a second monitor, or popped out with its button. The detached window follows playback, recording and the selected take; clicking or dragging in it (seek, punch region, select / rename / delete a take) acts on the main window. Dock it with its button or by closing it.
- A detached window opens where it was last (and the same size) when that is still on a connected monitor.
- The Panels menu marks panels that are in their own window, and hiding one closes its window.
- A detached panel goes back by carrying the grip in its bar over the main window and letting go (the Dock button and closing the window still work).

### Changed
- The window plumbing (playhead clock, event bridges, drag gestures) now comes from `mps-core` v0.3.0.
- The live pitch trace and the tuner reading no longer depend on the piano keyboard being on screen: they keep running while recording or monitoring whichever panels are shown, hidden or detached.

## [0.1.65] - 2026-10-10

### Added
- A "Panels" menu in the practice-room header: tick which panels to show (Takes, Lyrics, Piano roll, Spectrum comparison, Dynamics, Vibrato, Timing, Coach), or Show all / Hide all / Reset. Your choice is remembered. The spectrum comparison, dynamics and timing views now start hidden.
- The practice room is one vertical column: the right-hand sidebar is gone. Takes sit under the waveforms and the vibrato, timing and coach cards under the pitch views, so hiding a panel gives its space back.

### Changed
- The "Analysis" tab is gone: the piano roll is a panel like the others and no longer opens or closes by itself when you select a take or record.
- Takes are loaded when a song opens, whether or not the Takes panel is shown.

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
