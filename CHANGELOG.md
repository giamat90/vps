# Changelog

All notable changes to VPS are recorded here, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the git tags (`vX.Y.Z`).

Every version bump must add an entry here in the same `chore: release` commit.
Releases before 0.1.62 are not itemised; see `git log` and the tags.

## [0.0.81] - 2026-10-14

### Added
- **Sign in to YouTube inside the app.** Settings → YouTube account → **Sign in to YouTube** opens Google's sign-in in a private window; once you are signed in the app keeps only the YouTube/Google session cookies it needs and uses them for imports, so you no longer have to export a `cookies.txt` by hand. Choosing a cookies file is still available, and **Sign out** forgets the session.

### Fixed
- **YouTube imports with a signed-in session no longer fail with "The page needs to be reloaded".** The app now bundles the JavaScript runtime (Deno) that YouTube's challenges need, which makes the installer larger.
- YouTube import error messages point at Settings → YouTube.

## [0.0.80] - 2026-10-12

### Changed
- **Waveforms shrink to a strip, as in a DAW.** The arrow at the start of the Vocals / Instrumental header shrinks that track to its strip (name, M, S, volume): **^** shrinks it, **∨** brings the waveform back. It keeps playing, and M, S and the volume still apply. This replaces the old **×**, which hid the waveform completely; the Panels menu tick for a track is the same setting. With both tracks shrunk the ruler and the strips stay.

## [0.0.79] - 2026-10-12

### Fixed
- Showing a recorded take while the timeline was zoomed or resizing could raise a "No audio loaded" error behind the scenes and skip part of the zoom update. Zoom and scroll now leave out waveforms that have not finished decoding.

## [0.0.78] - 2026-10-12

### Added
- **Hide the waveforms.** The **Waveforms** entry at the top of the Panels menu hides the whole waveform area, and each track (Vocals, Instrumental) can be hidden on its own, from the menu or with the **×** on its header. Hiding only removes the picture: the track keeps playing, and M, S and the volume still apply. A hidden track that is muted or soloed is tagged in the menu.
- **Free Exercise** has a Panels menu too: piano keyboard, loaded track, piano roll, spectrogram, spectrum, dynamics, vibrato and recordings can each be hidden.

## [0.0.77] - 2026-10-12

### Added
- **Move the panels.** Every panel in the practice room (lyrics, takes, piano roll, spectrum comparison, dynamics, vibrato, timing, coach) can be dragged above or below the others with the ↕ grip in its corner (or focus the grip, press space, move with the arrows, press space). The order is remembered, the Panels menu lists panels in that order, and **Reset** puts visibility and order back to the defaults. A panel in its own window returns to its place when docked.

### Changed
- The practice room is one ordered column: the separate analysis and feedback groups are gone, so any panel can sit between any others.

## [0.1.76] - 2026-10-12

### Changed
- **Version numbering** drops the minor: releases continue as `0.0.x` (next is `0.0.77`). This build is the bridge: the updater now installs any release whose version differs from the installed one, so 0.1.x installs move to 0.0.x despite semver ordering it lower. Existing `v0.1.x` tags and releases are left as history.

## [0.1.75] - 2026-10-12

### Added
- **Search** box in the library: title, artist, key, tempo or folder name, several words allowed. The folder view returns when it is cleared (Escape).

### Changed
- **New app icon**: waveform bars instead of the default Tauri logo, so VPS and SPS are easy to tell apart in the taskbar.

## [0.1.74] - 2026-10-12

### Added
- A **Cancel** button while lyrics are syncing. Nothing is changed; the next sidecar use starts it again.

## [0.1.73] - 2026-10-12

### Changed
- With **Show multiple lines** on, the second voice's current note is also highlighted on the piano roll's key strip and on the piano keyboard, in the same lighter blue as its ribbon. The live mic, the take and the main voice keep priority when they sound the same note.

## [0.1.72] - 2026-10-12

### Added
- Keyboard shortcuts in the practice room: **Space** play / pause, **Home** / **End** to the start / end, **←** / **→** back / forward 5 seconds (hold **Shift** for 1 second), **L** loop on / off, **[** and **]** set the start and end of the region at the playhead. They are ignored while you type, while recording and during the count-in.
- A **Loops** menu next to the loop button. Save the current region under a name (it is kept with the song), click a saved loop to loop it, rename or delete it. The same menu lists the song cut into groups of 2, 4, 8 or 16 bars from the metronome downbeat, one click each.

## [0.1.71] - 2026-10-12

### Added
- A **×** button next to the Takes bar deletes every recorded take at once, after an inline confirmation. If one take cannot be deleted, the takes that could not be are kept.

## [0.1.70] - 2026-10-11

### Added
- When two singers sing together on a song's vocal track, the piano roll can now show both. Turn on **Show multiple lines** in the piano roll header (off by default) to see the second voice as a lighter line under the main one.
- A **Main line** choice next to it decides which voice is the main line where two sing: **Loudest** (default), **Higher** or **Lower**. The tuner, coach tips and keyboard follow the same choice.

### Changed
- The song's pitch line no longer hops between two singers who hold different notes at the same time: it stays on one voice for the whole stretch.
- Songs already in the library get their second voice the first time you open them (a few seconds, once); no need to import them again. Because of this, the main line of such a song can look different in places where two sing.
- Known limits: octave doubling and double-tracked unison are not split, only held notes are detected (not glides), and recorded takes have no second voice.

## [0.1.69] - 2026-10-11

### Changed
- Pitch detection on a song's separated vocal is more accurate: notes no longer start with a slide from the previous note, breaths, consonants and noise between notes no longer get a pitch line, and wrong-octave frames are rarer. Vibrato shows closer to its real depth.
- Recorded takes get the same detector, so the take and song ribbons stay comparable.
- Songs already in the library keep the pitch they were analysed with; import a song again to get the new detection.

## [0.1.68] - 2026-10-11

### Fixed
- macOS builds were missing from the previous release: the macOS build now takes ffmpeg and ffprobe from GitHub-hosted static builds instead of a site that rate-limited the download. No other change from the previous version.

## [0.1.67] - 2026-10-11

### Added
- Several recorded takes can be shown at the same time, each on its own lane. Click a take in the Takes list to show it, click it again to hide it (a lane also has its own ×). By default every shown take is heard together; **M** on a lane silences just that take.
- A bar above the take lanes with two tick boxes, each with one fixed label: **Selected take only** (only the selected take plays, and clicking another take switches to it; off, every shown take plays together) and **Mute takes while recording** (on by default; untick it to keep hearing the shown takes while you record another one). Both choices are remembered.
- Each take lane has its own **mute, solo and volume** at the far right, next to the offset controls it already had; the shared take volume, mute and solo stay in the bar above the lanes and come first: the main mute silences every take whatever the lanes say, and a lane's solo only picks one take among the takes (it never touches the other tracks). The main buttons' tooltips say so.
- The selected take's lane header is tinted with an accent edge, heard or not, so in selected-only mode a muted selected take is still told apart from the others.
- The recorded takes (their bar and lanes) are set apart from the vocal and instrumental tracks by a divider. It is only a graphic separation: they are the same widget and scroll with it.
- The mixdown export includes every take that is heard, at each take's own level.

### Changed
- Starting a recording no longer removes the takes from the screen. By default they are silent while you record, as before; untick **Mute takes while recording** to hear them.

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
