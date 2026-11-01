# Changelog

All notable changes to VPS are recorded here, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the git tags (`vX.Y.Z`).

Every version bump must add an entry here in the same `chore: release` commit.
Releases before 0.1.62 are not itemised; see `git log` and the tags.

## [0.0.101] - 2026-11-01

### Fixed
- **A YouTube import that cannot reach the video now says so, instead of looping.** The bar used to climb to 15%, fall to 0 and repeat for many minutes. Each attempt now names itself (for example "attempt 2 of 7: Chrome cookies"), a download of unknown size shows a moving bar instead of a stuck percentage, and attempts give up sooner so the error appears within a few minutes.
- **When nobody is signed in to YouTube, the error offers "Sign in to YouTube and retry"** instead of making you look for it in Settings.

## [0.0.100] - 2026-11-01

### Added
- **Queue of songs to analyze.** You can keep adding songs while one is being analyzed. The import box and the YouTube box stay usable, the next songs wait in a list below them, and a song can be taken out of the list before it starts. The list is kept in memory only, so it is empty again after you close the app. The song being analyzed cannot be cancelled yet.

### Fixed
- **A detached lyrics window now uses its whole height.** The lyrics used to stop after about fifteen lines of text and leave the rest of the window empty; they now fill the window and scroll inside it. The lyrics panel docked in the main window is unchanged.

## [0.0.99] - 2026-10-25

### Changed
- **A song dragged onto a closed folder moves into it.** Drop it on the folder's header; the folder stays closed and the song goes to the end of its list.
- **The folder where the song would land is highlighted while you drag** (the whole folder, header included, or the list outside folders), also when the pointer is over a song inside it. Nothing is highlighted when the song would stay where it is.
- mps-core v0.19.0.

## [0.0.98] - 2026-10-24

### Added
- **The top bar is made of cards you can move.** Transport, Loop, Tempo, Input and output, and Transpose are five cards in one list that wraps with the window. Drag a card by its ⋮⋮ grip anywhere in the bar (or focus the grip and use the arrow keys); double-click a grip to put the cards back in the usual order. This is separate from moving the panels below.
- **A Cards menu next to Panels** hides and restores the cards of the top bar.

## [0.0.97] - 2026-10-24

### Changed
- **Record moved into the transport bar**, right after Play (skip, Stop, Play, Record, skip), the order of Pro Tools, Logic, Cubase and Reaper. It is always red, whatever the theme.
- **Monitor is a labelled 🎧 button between Input and Output**, filled blue while it is on, so the input strip reads Input, Monitor, Output.
- **Transpose is one row** like Speed and the devices, instead of a label stacked over its buttons.
- A long error message in the bar is cut with an ellipsis; hover it to read the whole text.

## [0.0.96] - 2026-10-24

### Added
- **The count-in also counts in Play.** With the clock button set to 1 or 2 bars, Play clicks the bars in first and then starts the song (from the punch-in point if there is one); resuming from a pause counts in again. The Play button shows the beats left; click Play, press Space or click Stop to cancel the count. Record and Monitor count in as before, and a recording started during the count takes over.

### Changed
- The clock button moved from beside the Record button to the transport bar, since it now counts in Play as well.
- Uses mps-core v0.17.0, which holds the count-in for both apps.

## [0.0.95] - 2026-10-24

### Added
- **Every panel's name is a button that folds it**, like the Lyrics button always did. Click the name to fold the panel down to just that button, click it again to open it. It works on the Pitch Monitor, Short-Term Spectrum, Spectrum comparison, Dynamics, Vibrato, Timing, Coaching and Takes panels in the practice room, and on the spectrogram, short-term spectrum and Recordings on the Free Exercise page. A folded panel is only its button: no legend, no hints, and nothing drawing in the background. Your choice is remembered, and a panel in a window of its own follows it.

### Changed
- **The keyboard and the piano roll are one panel, called Pitch Monitor** (in the Panels menu and in its own window), with one button that folds both.
- The Coaching, Vibrato and Timing buttons sit above their card, the way the Lyrics button does.
- Panels with nothing to show yet (Vibrato and Timing before you pick a take) no longer leave a gap in the page.
- Uses mps-core v0.16.0.

## [0.0.94] - 2026-10-24

### Changed
- **The practice room and the Free Exercise page scrolls as one page.** The stems or waveforms, lyrics and takes no longer have scroll boxes of their own: the whole page scrolls, so every panel is reachable with the wheel. The title, Panels menu and export buttons stay pinned with the transport bar, which is now more compact (speed, input and output sit in rows). Ctrl+wheel still zooms the timeline and Shift+wheel still pans it.

## [0.0.93] - 2026-10-22

### Fixed
- **A long list of release notes no longer pushes the update buttons off screen.** The "Update available" window is now at most as tall as the window allows and the notes scroll inside it, so Install & Restart and Later stay visible.
- **The count-in also applies to the Monitor button.** With a count-in set, Monitor now pauses the song, plays the click and then starts the song, like Record without the capture. Before, the count-in only governed Record.

## [0.0.92] - 2026-10-18

### Fixed
- **Finding lyrics online now searches by artist as well as title.** Imports used to leave the artist empty, so the search ran on the title alone and a common title could find another band's song. The artist is now read from the file's tags or from the YouTube video, shown in the lyrics panel next to the title, and can be corrected there. If nothing is found with the artist, the search tries the title alone, and versions by the right artist are listed first. Songs imported earlier keep an empty artist until you set one.

## [0.0.91] - 2026-10-18

### Changed
- **Internal restructuring, nothing to relearn.** The player, the library, the panels and the controls now share their logic with Song Practice Studio through one common package (mps-core 0.13.0) instead of keeping two copies, and the spectrum and piano-roll drawing code was split into small, tested pieces. The screens, the buttons and the files on disk are unchanged.
- **Fewer security advisories in the build tools.** The development toolchain was updated; the installed app is not affected.

## [0.0.90] - 2026-10-16

### Added
- **Send to phone over Wi-Fi.** **Send to phone** now opens a dialog. **Send over Wi-Fi** builds the practice pack and shows a QR code: on the phone, Vocal Practice Pocket, Songs, **Receive from laptop**, scan it and the pack downloads straight into the phone's song list, with progress on both sides. The laptop serves the pack once, only on your local network address, for ten minutes at most, behind a code that only the QR carries. **Save as a file** keeps the old way. If the computer has more than one network (Wi-Fi and Ethernet, a VPN, WSL), a picker lets you choose the one the phone is on. The first time, Windows may ask to allow Vocal Practice Studio on private networks: allow it.

## [0.0.89] - 2026-10-15

### Added
- **The Short-Term Spectrum marks the fundamental (F0).** Both spectrum panels draw a solid line at the sung pitch, labelled with its frequency and note (for example `F0 173 F3`), next to the dashed formant lines. For the song, a take and a loaded Free Exercise track it is the pitch the piano roll shows; with **Show multiple lines** on, the song's second voice gets its own lighter line. For the live microphone it is measured from the sound itself.

### Changed
- **The Song and take curves in the spectrum comparison are measured from the audio at the playhead**, the same way as the live microphone curve, instead of drawn from precomputed frames. They sit on the exact playhead, show finer detail, and follow a key transpose. Above 3.6 kHz the stored curve still supplies the top of the range.

### Fixed
- **A take's F0 line no longer disappears on quieter singing.** It was dropped wherever the pitch tracker's confidence was low, which on one real take was a quarter of the voiced frames; it now covers 90% of that take instead of 71%.

## [0.0.88] - 2026-10-15

### Added
- **Lyrics search keeps the song's real name.** Renaming a song (for example to "Hallelujah (live)") no longer changes what **Find online** looks for. The lyrics panel shows **Searches as: Artist – Title** with a **Change** link to correct it.
- **Choose among the results.** When more than one lyrics result is found, they are listed under the text box with their length and whether they are timed; click one to use it. A result of a different length than your song is marked, so a live or acoustic version can still be picked.

### Changed
- The shared package moved to mps-core 0.11.0 (lyrics search results).

## [0.0.87] - 2026-10-15

### Fixed
- **Send to phone no longer fails** with "type str doesn't define __round__ method". Every pack failed in 0.0.86 because the progress report passed its arguments in the wrong order.

## [0.0.86] - 2026-10-15

### Added
- **Send to phone.** The practice room has a new button that saves a practice pack (`.vppack`) of the song for the Vocal Practice Pocket phone app: the vocals and instrumental as compact AAC, any transpositions you have already made, the reference melody, the lyrics and your saved loops. A four-minute song becomes about 5 MB. Move the file to your phone and add it there.

### Changed
- The shared package moved to mps-core 0.10.0 (the pack format).

## [0.0.85] - 2026-10-15

### Fixed
- **The recording-offset calibration no longer reads about 15 ms too high on a 44.1 kHz audio device**, and no longer reads about 4 ms early on any device. If you calibrated before, on a 44.1 kHz device, run the calibration again for the exact value.

## [0.0.84] - 2026-10-15

### Changed
- Internal: the live pitch reader now takes its autocorrelation from the shared mps-core package (v0.8.0), so a phone app can run the same algorithm. No change in what you see or hear.

## [0.0.83] - 2026-10-14

### Added
- **The Short-Term Spectrum now marks the fundamental (F0).** Both spectrum panels draw a solid line at the sung pitch, labelled with its frequency and note (for example `F0 173 F3`), next to the dashed formant lines. For the song, a take and a loaded Free Exercise track it is the same pitch the piano roll shows, so the two always agree; with **Show multiple lines** on, the song's second voice gets its own lighter line. For the live microphone it is measured from the sound itself.

### Changed
- The pitch measured live from a window of audio is more accurate (about 8 cents less flat on a real vocal, and steadier from frame to frame).

## [0.0.82] - 2026-10-14

### Added
- **Sign in again with one click when your YouTube sign-in has expired.** If a YouTube import is turned down in a way a fresh sign-in can fix, the error now has a **Sign in again and retry** button: it opens the sign-in window, saves the new session and repeats the same import. If YouTube refuses even a fresh sign-in, the message says the network or VPN is probably the cause.

### Changed
- The in-app YouTube sign-in is now shared code with the sibling app; behaviour is unchanged.

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
